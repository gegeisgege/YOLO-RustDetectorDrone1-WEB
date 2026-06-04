require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const GPS_HISTORY_LIMIT = parseInt(process.env.GPS_HISTORY_LIMIT || '500');
const STREAM_SOURCE = process.env.STREAM_SOURCE || '';

// ─── In-memory store ──────────────────────────────────────────────────────────
const store = {
  detections: [],       // last N detection payloads
  latestGPS: null,      // most recent GPS frame
  clients: new Set(),   // browser WS clients
  rpi: null,            // Raspberry Pi WS connection
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../dashboard')));

// ─── REST endpoints ───────────────────────────────────────────────────────────

// Receive GPS + detections from RPi (HTTP fallback)
app.post('/gps', (req, res) => {
  const payload = req.body;
  if (!payload || payload.lat == null || payload.lon == null) {
    return res.status(400).json({ error: 'lat/lon required' });
  }
  handleIncoming(payload);
  res.json({ ok: true });
});

// Dashboard polling fallback
app.get('/detections', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), GPS_HISTORY_LIMIT);
  res.json(store.detections.slice(0, limit));
});

app.get('/status', (req, res) => {
  res.json({
    rpi_connected: store.rpi !== null,
    browser_clients: store.clients.size,
    detection_count: store.detections.length,
    latest_gps: store.latestGPS,
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  const isRPi = req.url === '/rpi';

  if (isRPi) {
    store.rpi = ws;
    console.log(`[rpi] connected from ${ip}`);
    broadcastToBrowsers({ type: 'status', rpi: true });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        handleIncoming(msg);
      } catch (_) {
        // binary frame (raw MJPEG chunk) — forward directly to browsers
        broadcastRaw(data);
      }
    });

    ws.on('close', () => {
      store.rpi = null;
      console.log('[rpi] disconnected');
      broadcastToBrowsers({ type: 'status', rpi: false });
    });

  } else {
    store.clients.add(ws);
    console.log(`[browser] connected (${store.clients.size} total)`);

    // Send last known GPS on connect
    if (store.latestGPS) ws.send(JSON.stringify(store.latestGPS));

    ws.on('close', () => {
      store.clients.delete(ws);
    });
  }

  ws.on('error', (err) => console.error('[ws error]', err.message));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function handleIncoming(payload) {
  // Attach server-side timestamp if missing
  if (!payload.timestamp) payload.timestamp = new Date().toISOString();

  // Store GPS
  store.latestGPS = { type: 'gps', ...payload };

  // Store detections
  if (Array.isArray(payload.detections) && payload.detections.length) {
    store.detections.unshift(payload);
    if (store.detections.length > GPS_HISTORY_LIMIT) {
      store.detections.length = GPS_HISTORY_LIMIT;
    }
  }

  // Forward to all browser clients
  broadcastToBrowsers({ type: 'gps', ...payload });

  if (Array.isArray(payload.detections) && payload.detections.length) {
    broadcastToBrowsers({
      type: 'detections',
      detections: payload.detections,
      lat: payload.lat,
      lon: payload.lon,
      timestamp: payload.timestamp,
    });
  }
}

function broadcastToBrowsers(obj) {
  const msg = JSON.stringify(obj);
  for (const client of store.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastRaw(data) {
  for (const client of store.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`PipeWatch server running on http://localhost:${PORT}`);
  console.log(`  Dashboard : http://localhost:${PORT}`);
  console.log(`  RPi WS    : ws://localhost:${PORT}/rpi`);
  console.log(`  Browser WS: ws://localhost:${PORT}`);
  if (STREAM_SOURCE) console.log(`  Stream src: ${STREAM_SOURCE}`);
});