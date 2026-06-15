// PipeWatch — app.js

// ─── Clock ────────────────────────────────────────────────────────────────────
(function tickClock() {
  const el = document.getElementById('clock');
  const update = () => { el.textContent = new Date().toTimeString().slice(0, 8); };
  update();
  setInterval(update, 1000);
})();

// ─── State ────────────────────────────────────────────────────────────────────
const DEFAULT_WS = `ws://${location.host}`;

const state = {
  ws: null,
  connected: false,
  recording: false,
  mediaRecorder: null,
  recordedChunks: [],
  detections: [],
  stats: { total: 0, corrosion: 0, tpd: 0, confSum: 0 },
  config: {
    wsUrl:     localStorage.getItem('pw_ws')        || DEFAULT_WS,
    streamUrl: localStorage.getItem('pw_stream')    || '',
    threshold: parseFloat(localStorage.getItem('pw_threshold') || '0.5'),
    lat:       parseFloat(localStorage.getItem('pw_lat')       || '-7.2575'),
    lon:       parseFloat(localStorage.getItem('pw_lon')       || '112.7521'),
  },
  drone: { lat: null, lon: null },
  frameCount: 0,
};

// ─── Map ──────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true, attributionControl: false })
  .setView([state.config.lat, state.config.lon], 15);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

const droneIcon = L.divIcon({ className: 'drone-marker', iconSize: [14, 14], iconAnchor: [7, 7] });
const droneMarker = L.marker([state.config.lat, state.config.lon], { icon: droneIcon }).addTo(map);
const dronePath = L.polyline([], { color: '#3b82f6', weight: 1.5, opacity: 0.6 }).addTo(map);

function defectIcon(cls) {
  const color = cls === 'corrosion' ? '#ef6a3b' : cls === 'tpd' ? '#f0b429' : '#34d399';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
    <circle cx="9" cy="9" r="7" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="1.5"/>
    <circle cx="9" cy="9" r="3" fill="${color}"/></svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [18, 18], iconAnchor: [9, 9] });
}

// ─── Connection Status ────────────────────────────────────────────────────────
function setConnected(val) {
  state.connected = val;
  const chip  = document.getElementById('conn-status');
  const label = document.getElementById('conn-label');
  chip.classList.toggle('connected', val);
  label.textContent = val ? 'Connected' : 'Disconnected';
}

// ─── Feed elements ────────────────────────────────────────────────────────────
const feedImg     = document.getElementById('drone-feed');
const placeholder = document.getElementById('feed-placeholder');
const fpsEl       = document.getElementById('feed-fps');
const resEl       = document.getElementById('feed-res');

setInterval(() => {
  fpsEl.textContent = `${state.frameCount} fps`;
  state.frameCount = 0;
}, 1000);

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS(url) {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  if (!url) return;

  try { state.ws = new WebSocket(url); }
  catch (e) { console.warn('WS connect failed:', e); return; }

  state.ws.binaryType = 'arraybuffer';
  state.ws.onopen  = () => setConnected(true);
  state.ws.onclose = () => {
    setConnected(false);
    setTimeout(() => {
      if (state.config.wsUrl && !state.connected) connectWS(state.config.wsUrl);
    }, 5000);
  };
  state.ws.onerror = () => { if (state.ws) state.ws.close(); };
  state.ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const blob = new Blob([ev.data], { type: 'image/jpeg' });
      const url  = URL.createObjectURL(blob);
      const prev = feedImg.src;
      feedImg.src = url;
      feedImg.style.display = 'block';
      placeholder.style.display = 'none';
      feedImg.onload = () => { resEl.textContent = `${feedImg.naturalWidth} × ${feedImg.naturalHeight}`; };
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      state.frameCount++;
      return;
    }
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'gps')        handleGPS(msg);
      if (msg.type === 'detections') handleDetections(msg.detections, msg.lat, msg.lon, msg.timestamp);
    } catch (_) {}
  };
}

// ─── GPS handler ──────────────────────────────────────────────────────────────
function handleGPS(data) {
  const { lat, lon, satellites, altitude } = data;
  if (lat == null || lon == null) return;

  state.drone.lat = lat;
  state.drone.lon = lon;

  document.getElementById('gps-lat').textContent = lat.toFixed(6);
  document.getElementById('gps-lon').textContent = lon.toFixed(6);
  if (satellites != null) document.getElementById('gps-sat').textContent = satellites;
  if (altitude   != null) document.getElementById('gps-alt').textContent = `${altitude.toFixed(1)} m`;

  droneMarker.setLatLng([lat, lon]);
  dronePath.addLatLng([lat, lon]);

  if (data.detections && data.detections.length) {
    handleDetections(data.detections, lat, lon, data.timestamp || new Date().toISOString());
  }
}

// ─── Detection handler ────────────────────────────────────────────────────────
const canvas = document.getElementById('overlay-canvas');
const ctx    = canvas.getContext('2d');
const COLORS = { corrosion: '#ef6a3b', tpd: '#f0b429', normal: '#34d399' };

function handleDetections(detections, lat, lon, timestamp) {
  if (!detections || !detections.length) return;
  const timeStr = new Date(timestamp || Date.now()).toTimeString().slice(0, 8);

  detections.forEach(d => {
    if (d.confidence < state.config.threshold) return;
    state.stats.total++;
    state.stats.confSum += d.confidence;
    if (d.class === 'corrosion') state.stats.corrosion++;
    if (d.class === 'tpd')       state.stats.tpd++;

    state.detections.unshift({ time: timeStr, cls: d.class, conf: d.confidence, lat, lon, bbox: d.bbox });

    if (lat && lon) {
      L.marker([lat, lon], { icon: defectIcon(d.class) })
        .bindPopup(`<b>${d.class}</b><br>Conf: ${(d.confidence * 100).toFixed(1)}%<br>${timeStr}`)
        .addTo(map);
    }
  });

  renderStats();
  renderLog();
  renderOverlay(detections);
}

// ─── Canvas overlay ───────────────────────────────────────────────────────────
function renderOverlay(detections) {
  const w = feedImg.clientWidth  || 640;
  const h = feedImg.clientHeight || 480;
  canvas.width  = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);

  const sx = w / (feedImg.naturalWidth  || 640);
  const sy = h / (feedImg.naturalHeight || 480);

  detections.forEach(d => {
    if (!d.bbox || d.confidence < state.config.threshold) return;
    const [bx, by, bw, bh] = d.bbox;
    const color = COLORS[d.class] || '#fff';

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(bx * sx, by * sy, bw * sx, bh * sy);

    const label = `${d.class} ${(d.confidence * 100).toFixed(0)}%`;
    ctx.font      = '11px "DM Mono", monospace';
    const tw      = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(bx * sx, by * sy - 16, tw + 10, 16);
    ctx.globalAlpha = 1;
    ctx.fillStyle   = '#000';
    ctx.fillText(label, bx * sx + 5, by * sy - 4);
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const { total, corrosion, tpd, confSum } = state.stats;
  document.getElementById('stat-total').textContent     = total;
  document.getElementById('stat-corrosion').textContent = corrosion;
  document.getElementById('stat-tpd').textContent       = tpd;
  document.getElementById('stat-conf').textContent      = total ? `${(confSum / total * 100).toFixed(0)}%` : '--%';

  const normal = Math.max(0, total - corrosion - tpd);
  const denom  = total || 1;
  const pc = v => `${Math.round(v / denom * 100)}%`;

  document.getElementById('bar-corr').style.width  = pc(corrosion);
  document.getElementById('pct-corr').textContent  = pc(corrosion);
  document.getElementById('bar-tpd').style.width   = pc(tpd);
  document.getElementById('pct-tpd').textContent   = pc(tpd);
  document.getElementById('bar-norm').style.width  = pc(normal);
  document.getElementById('pct-norm').textContent  = pc(normal);
}

// ─── Log ──────────────────────────────────────────────────────────────────────
function renderLog() {
  const tbody = document.getElementById('log-body');
  const rows  = state.detections.slice(0, 200).map(d => {
    const badgeClass = d.cls === 'corrosion' ? 'badge-corr' : d.cls === 'tpd' ? 'badge-tpd' : 'badge-ok';
    const confClass  = d.conf >= 0.8 ? 'conf-high' : d.conf >= 0.6 ? 'conf-mid' : 'conf-low';
    return `<tr>
      <td>${d.time}</td>
      <td><span class="badge ${badgeClass}">${d.cls}</span></td>
      <td class="${confClass}">${(d.conf * 100).toFixed(1)}%</td>
      <td>${d.lat != null ? d.lat.toFixed(6) : '--'}</td>
      <td>${d.lon != null ? d.lon.toFixed(6) : '--'}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows || '<tr class="log-empty"><td colspan="5">No detections yet</td></tr>';
}

// ─── Settings drawer ──────────────────────────────────────────────────────────
const drawer = document.getElementById('settings-drawer');

document.getElementById('btn-settings').addEventListener('click', () => {
  drawer.classList.toggle('open');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  drawer.classList.remove('open');
});

document.getElementById('cfg-ws').value        = state.config.wsUrl;
document.getElementById('cfg-stream').value    = state.config.streamUrl;
document.getElementById('cfg-threshold').value = state.config.threshold * 100;
document.getElementById('cfg-threshold-val').textContent = `${Math.round(state.config.threshold * 100)}%`;
document.getElementById('cfg-lat').value       = state.config.lat;
document.getElementById('cfg-lon').value       = state.config.lon;

document.getElementById('cfg-threshold').addEventListener('input', e => {
  document.getElementById('cfg-threshold-val').textContent = `${e.target.value}%`;
});

document.getElementById('btn-connect').addEventListener('click', () => {
  const ws        = document.getElementById('cfg-ws').value.trim()     || DEFAULT_WS;
  const stream    = document.getElementById('cfg-stream').value.trim();
  const threshold = parseInt(document.getElementById('cfg-threshold').value) / 100;
  const lat       = parseFloat(document.getElementById('cfg-lat').value) || -7.2575;
  const lon       = parseFloat(document.getElementById('cfg-lon').value) || 112.7521;

  state.config = { wsUrl: ws, streamUrl: stream, threshold, lat, lon };
  localStorage.setItem('pw_ws',        ws);
  localStorage.setItem('pw_stream',    stream);
  localStorage.setItem('pw_threshold', threshold);
  localStorage.setItem('pw_lat',       lat);
  localStorage.setItem('pw_lon',       lon);

  map.setView([lat, lon], 15);
  connectWS(ws);
  drawer.classList.remove('open');
});

// ─── Demo data ────────────────────────────────────────────────────────────────
document.getElementById('btn-demo').addEventListener('click', () => {
  drawer.classList.remove('open');
  setConnected(true);

  const base    = { lat: -7.2575, lon: 112.7521 };
  const classes = ['corrosion', 'tpd', 'corrosion', 'normal', 'tpd'];
  const confs   = [0.91, 0.87, 0.76, 0.95, 0.82];

  classes.forEach((cls, i) => {
    setTimeout(() => {
      const lat  = base.lat + (Math.random() - 0.5) * 0.005;
      const lon  = base.lon + (Math.random() - 0.5) * 0.005;
      const bbox = [80 + i * 40, 60 + i * 20, 120, 90];
      handleGPS({ lat, lon, satellites: 8, altitude: 15.4 });
      handleDetections([{ class: cls, confidence: confs[i], bbox }], lat, lon, new Date().toISOString());
    }, i * 1200);
  });
});

// ─── Map controls ─────────────────────────────────────────────────────────────
document.getElementById('btn-center').addEventListener('click', () => {
  if (state.drone.lat) map.setView([state.drone.lat, state.drone.lon], 16);
});

document.getElementById('btn-clear-markers').addEventListener('click', () => {
  map.eachLayer(layer => {
    if (layer instanceof L.Marker && layer !== droneMarker) map.removeLayer(layer);
  });
  dronePath.setLatLngs([]);
});

// ─── Reset stats ──────────────────────────────────────────────────────────────
document.getElementById('btn-reset-stats').addEventListener('click', () => {
  state.stats = { total: 0, corrosion: 0, tpd: 0, confSum: 0 };
  state.detections = [];
  renderStats();
  renderLog();
});

// ─── Snapshot ────────────────────────────────────────────────────────────────
document.getElementById('btn-snapshot').addEventListener('click', () => {
  const snap = document.createElement('canvas');
  snap.width  = feedImg.naturalWidth  || feedImg.clientWidth;
  snap.height = feedImg.naturalHeight || feedImg.clientHeight;
  const sc = snap.getContext('2d');
  sc.drawImage(feedImg, 0, 0, snap.width, snap.height);
  sc.drawImage(canvas,  0, 0, snap.width, snap.height);
  snap.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pipewatch_${Date.now()}.png`;
    a.click();
  });
});

// ─── Export CSV ───────────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', () => {
  if (!state.detections.length) return;
  const header = 'time,class,confidence,lat,lon\n';
  const rows   = state.detections.map(d =>
    `${d.time},${d.cls},${d.conf.toFixed(4)},${d.lat ?? ''},${d.lon ?? ''}`
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pipewatch_log_${Date.now()}.csv`;
  a.click();
});

// ─── Record ───────────────────────────────────────────────────────────────────
const btnRecord = document.getElementById('btn-record');
btnRecord.addEventListener('click', () => {
  if (!state.recording) {
    const stream = canvas.captureStream(30);
    state.recordedChunks = [];
    state.mediaRecorder   = new MediaRecorder(stream, { mimeType: 'video/webm' });
    state.mediaRecorder.ondataavailable = e => { if (e.data.size) state.recordedChunks.push(e.data); };
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pipewatch_rec_${Date.now()}.webm`;
      a.click();
    };
    state.mediaRecorder.start();
    state.recording = true;
    btnRecord.classList.add('active');
  } else {
    state.mediaRecorder.stop();
    state.recording = false;
    btnRecord.classList.remove('active');
  }
});

// ─── HTTP polling fallback ────────────────────────────────────────────────────
let pollInterval = null;

function startPolling(baseUrl) {
  clearInterval(pollInterval);
  if (!baseUrl) return;
  pollInterval = setInterval(async () => {
    try {
      const res  = await fetch(`${baseUrl}/detections`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        data.forEach(item => handleGPS({ type: 'gps', ...item }));
        setConnected(true);
      }
    } catch (_) {}
  }, 2000);
}

// ─── Theme toggle ─────────────────────────────────────────────────────────────
(function initTheme() {
  const btn  = document.getElementById('btn-theme');
  const icon = document.getElementById('theme-icon');
  const SUN  = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
  const MOON = `<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>`;

  let night = localStorage.getItem('pw_theme') === 'night';

  function apply() {
    document.documentElement.setAttribute('data-theme', night ? 'night' : '');
    icon.innerHTML = night ? SUN : MOON;
    localStorage.setItem('pw_theme', night ? 'night' : 'day');
  }

  btn.addEventListener('click', () => { night = !night; apply(); });
  apply();
})();

// ─── Auto-connect on load ─────────────────────────────────────────────────────
connectWS(state.config.wsUrl);