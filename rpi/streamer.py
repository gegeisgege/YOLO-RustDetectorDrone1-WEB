#!/usr/bin/env python3
"""
rpi/streamer.py
Captures camera frames, runs YOLOv12n inference, streams MJPEG binary
frames and GPS+detection JSON to the Node relay server via WebSocket.

Usage:
    python streamer.py --server ws://192.168.1.x:3000/rpi [--model weights/best.pt]
                       [--gps /dev/ttyUSB0] [--conf 0.45] [--res 640x480]
"""

import argparse
import json
import logging
import sys
import time
import threading
from datetime import datetime, timezone

import cv2
import websocket  # websocket-client

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger('streamer')

# ── YOLO (optional — graceful fallback if ultralytics not installed) ──────────
try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    log.warning('ultralytics not installed — running without detection')

# ── GPS (optional — graceful fallback) ───────────────────────────────────────
try:
    import serial
    import pynmea2
    GPS_AVAILABLE = True
except ImportError:
    GPS_AVAILABLE = False
    log.warning('pyserial/pynmea2 not installed — GPS disabled')

# ── Class colours (BGR for cv2) ───────────────────────────────────────────────
CLASS_COLORS = {
    'corrosion': (58, 93, 232),   # #e85d3a
    'tpd':       (0, 165, 240),   # #f0a500
    'normal':    (126, 184, 46),  # #2eb87e
}
DEFAULT_COLOR = (200, 200, 200)

JPEG_QUALITY = 70   # balance between bandwidth and clarity


# ─────────────────────────────────────────────────────────────────────────────
# GPS reader (runs in its own thread)
# ─────────────────────────────────────────────────────────────────────────────
class GPSReader:
    def __init__(self, port, baud=9600):
        self.port = port
        self.baud = baud
        self.lat = None
        self.lon = None
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def position(self):
        with self._lock:
            return self.lat, self.lon

    def _run(self):
        if not GPS_AVAILABLE:
            return
        try:
            ser = serial.Serial(self.port, self.baud, timeout=1)
            log.info(f'GPS reading from {self.port}')
            while True:
                line = ser.readline().decode('ascii', errors='replace').strip()
                if line.startswith('$GPRMC') or line.startswith('$GNRMC'):
                    try:
                        msg = pynmea2.parse(line)
                        if msg.status == 'A':   # 'A' = valid fix
                            with self._lock:
                                self.lat = msg.latitude
                                self.lon = msg.longitude
                    except pynmea2.ParseError:
                        pass
        except Exception as e:
            log.error(f'GPS error: {e}')


# ─────────────────────────────────────────────────────────────────────────────
# Main streamer
# ─────────────────────────────────────────────────────────────────────────────
class Streamer:
    def __init__(self, args):
        self.server_url = args.server
        self.model_path = args.model
        self.conf_thresh = args.conf
        width, height = args.res.split('x')
        self.width = int(width)
        self.height = int(height)
        self.gps_port = args.gps
        self.gps_interval = args.gps_interval

        self.ws = None
        self.model = None
        self.gps = None
        self._last_gps_send = 0

    # ── setup ─────────────────────────────────────────────────────────────────
    def _load_model(self):
        if not YOLO_AVAILABLE:
            return
        try:
            self.model = YOLO(self.model_path)
            log.info(f'Model loaded: {self.model_path}')
        except Exception as e:
            log.error(f'Model load failed: {e}')
            self.model = None

    def _start_gps(self):
        if self.gps_port and GPS_AVAILABLE:
            self.gps = GPSReader(self.gps_port)
            self.gps.start()

    def _connect_ws(self):
        log.info(f'Connecting to {self.server_url}')
        self.ws = websocket.WebSocket()
        self.ws.connect(self.server_url)
        log.info('WebSocket connected')

    # ── inference ─────────────────────────────────────────────────────────────
    def _run_yolo(self, frame):
        """Returns (annotated_frame, detections_list)."""
        if self.model is None:
            return frame, []

        results = self.model(frame, conf=self.conf_thresh, verbose=False)[0]
        detections = []

        for box in results.boxes:
            cls_id = int(box.cls[0])
            label = self.model.names.get(cls_id, str(cls_id))
            conf = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            w, h = x2 - x1, y2 - y1

            color = CLASS_COLORS.get(label, DEFAULT_COLOR)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, f'{label} {conf:.2f}',
                        (x1, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX,
                        0.55, color, 1, cv2.LINE_AA)

            detections.append({
                'class': label,
                'confidence': round(conf, 4),
                'bbox': [x1, y1, w, h],
            })

        return frame, detections

    # ── send helpers ──────────────────────────────────────────────────────────
    def _send_frame(self, frame):
        ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if ok:
            self.ws.send_binary(buf.tobytes())

    def _send_gps(self, detections):
        now = time.time()
        if now - self._last_gps_send < self.gps_interval:
            return
        self._last_gps_send = now

        lat, lon = (self.gps.position() if self.gps else (None, None))
        payload = {
            'lat': lat,
            'lon': lon,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'detections': detections,
        }
        self.ws.send(json.dumps(payload))

    # ── main loop ─────────────────────────────────────────────────────────────
    def run(self):
        self._load_model()
        self._start_gps()

        from picamera2 import Picamera2

        picam2 = Picamera2()

        config = picam2.create_preview_configuration(
            main={"size": (self.width, self.height)}
        )

        picam2.configure(config)
        picam2.start()

        log.info(f'Camera open at {self.width}x{self.height}')

        log.info(f'Camera open at {self.width}x{self.height}')

        retry_delay = 2
        while True:
            try:
                self._connect_ws()
                retry_delay = 2

                while True:
                    frame = picam2.capture_array()

                    frame, detections = self._run_yolo(frame)
                    self._send_frame(frame)
                    self._send_gps(detections)

            except (websocket.WebSocketConnectionClosedException,
                    ConnectionRefusedError, OSError) as e:
                log.warning(f'Connection lost ({e}) — retrying in {retry_delay}s')
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30)

            except KeyboardInterrupt:
                log.info('Stopped by user')
                break

        cap.release()
        if self.ws:
            self.ws.close()


# ─────────────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description='RPi pipeline inspection streamer')
    p.add_argument('--server', default='ws://localhost:3000/rpi',
                   help='Relay server WebSocket URL')
    p.add_argument('--model', default='weights/best.pt',
                   help='YOLOv12n .pt weights path')
    p.add_argument('--conf', type=float, default=0.45,
                   help='Detection confidence threshold')
    p.add_argument('--res', default='640x480',
                   help='Camera resolution WxH')
    p.add_argument('--gps', default=None,
                   help='GPS serial port, e.g. /dev/ttyUSB0')
    p.add_argument('--gps-interval', type=float, default=1.0,
                   help='Seconds between GPS+detection JSON sends')
    args = p.parse_args()

    Streamer(args).run()


if __name__ == '__main__':
    main()