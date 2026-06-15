#!/usr/bin/env python3
"""
rpi/streamer.py
Captures frames from Pi Camera, runs YOLOv12n inference, streams annotated
MJPEG frames and GPS+detection JSON to the Node relay server via WebSocket.

Usage:
    python streamer.py --server ws://192.168.1.x:3000/rpi
                       [--model best.pt]
                       [--gps /dev/ttyUSB0]
                       [--conf 0.45]
                       [--res 640x480]
                       [--gps-interval 1.0]
"""

import argparse
import json
import logging
import time
import threading
from datetime import datetime, timezone

import cv2
import websocket

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger('streamer')

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    log.warning('ultralytics not installed — running without detection')

try:
    import serial
    import pynmea2
    GPS_AVAILABLE = True
except ImportError:
    GPS_AVAILABLE = False
    log.warning('pyserial/pynmea2 not installed — GPS disabled')

CLASS_COLORS = {
    'corrosion': (58,  106, 239),
    'tpd':       (41,  180, 240),
    'normal':    (153, 211,  52),
}
DEFAULT_COLOR = (200, 200, 200)
JPEG_QUALITY  = 70


# ─── GPS reader ───────────────────────────────────────────────────────────────
class GPSReader:
    def __init__(self, port, baud=9600):
        self.port = port
        self.baud = baud
        self.lat        = None
        self.lon        = None
        self.altitude   = None
        self.satellites = None
        self._lock   = threading.Lock()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def position(self):
        with self._lock:
            return self.lat, self.lon, self.altitude, self.satellites

    def _run(self):
        try:
            ser = serial.Serial(self.port, self.baud, timeout=1)
            log.info(f'GPS reading from {self.port}')
            while True:
                line = ser.readline().decode('ascii', errors='replace').strip()
                if line.startswith(('$GPRMC', '$GNRMC')):
                    try:
                        msg = pynmea2.parse(line)
                        if msg.status == 'A':
                            with self._lock:
                                self.lat = msg.latitude
                                self.lon = msg.longitude
                    except pynmea2.ParseError:
                        pass
                elif line.startswith(('$GPGGA', '$GNGGA')):
                    try:
                        msg = pynmea2.parse(line)
                        with self._lock:
                            if msg.altitude is not None:
                                self.altitude = float(msg.altitude)
                            if msg.num_sats is not None:
                                self.satellites = int(msg.num_sats)
                    except (pynmea2.ParseError, ValueError):
                        pass
        except Exception as e:
            log.error(f'GPS thread error: {e}')


# ─── Streamer ─────────────────────────────────────────────────────────────────
class Streamer:
    def __init__(self, args):
        self.server_url   = args.server
        self.model_path   = args.model
        self.conf_thresh  = args.conf
        self.gps_port     = args.gps
        self.gps_interval = args.gps_interval
        w, h = args.res.split('x')
        self.width  = int(w)
        self.height = int(h)

        self.ws            = None
        self.model         = None
        self.gps           = None
        self._last_gps_send = 0

    def _load_model(self):
        if not YOLO_AVAILABLE:
            return
        try:
            self.model = YOLO(self.model_path)
            log.info(f'Model loaded: {self.model_path}')
        except Exception as e:
            log.error(f'Model load failed: {e}')

    def _start_gps(self):
        if self.gps_port and GPS_AVAILABLE:
            self.gps = GPSReader(self.gps_port)
            self.gps.start()

    def _connect_ws(self):
        log.info(f'Connecting to {self.server_url}')
        self.ws = websocket.WebSocket()
        self.ws.connect(self.server_url)
        log.info('WebSocket connected')

    def _run_yolo(self, frame):
        if self.model is None:
            return frame, []

        results    = self.model(frame, conf=self.conf_thresh, imgsz=320, verbose=False)[0]
        detections = []

        for box in results.boxes:
            cls_id = int(box.cls[0])
            label  = self.model.names.get(cls_id, str(cls_id))
            conf   = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])

            color = CLASS_COLORS.get(label, DEFAULT_COLOR)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, f'{label} {conf:.2f}',
                        (x1, max(y1 - 6, 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)

            detections.append({
                'class':      label,
                'confidence': round(conf, 4),
                'bbox':       [x1, y1, x2 - x1, y2 - y1],
            })

        return frame, detections

    def _send_frame(self, frame):
        ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if ok:
            self.ws.send_binary(buf.tobytes())

    def _send_gps(self, detections):
        now = time.time()
        if now - self._last_gps_send < self.gps_interval:
            return
        self._last_gps_send = now

        if self.gps:
            lat, lon, altitude, satellites = self.gps.position()
        else:
            lat, lon, altitude, satellites = None, None, None, None

        payload = {
            'lat':        lat,
            'lon':        lon,
            'altitude':   altitude,
            'satellites': satellites,
            'timestamp':  datetime.now(timezone.utc).isoformat(),
            'detections': detections,
        }
        self.ws.send(json.dumps(payload))
        log.info(f'GPS sent: lat={lat}, lon={lon}, alt={altitude}, sats={satellites}, detections={len(detections)}')

    def run(self):
        self._load_model()
        self._start_gps()

        try:
            from picamera2 import Picamera2
            picam2 = Picamera2()
            picam2.configure(picam2.create_preview_configuration(
                main={'size': (self.width, self.height), 'format': 'RGB888'}
            ))
            picam2.start()
            use_picamera = True
            log.info(f'Pi Camera started at {self.width}x{self.height}')
        except Exception as e:
            log.warning(f'picamera2 not available ({e}), falling back to cv2.VideoCapture')
            cap = cv2.VideoCapture(0)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  self.width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            use_picamera = False

        retry_delay = 2
        try:
            while True:
                try:
                    self._connect_ws()
                    retry_delay = 2

                    while True:
                        if use_picamera:
                            frame = picam2.capture_array()
                            # 'RGB888' format above is already BGR byte order for cv2/YOLO — no conversion needed
                        else:
                            ret, frame = cap.read()
                            if not ret:
                                log.warning('Camera read failed')
                                time.sleep(0.1)
                                continue

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
        finally:
            if use_picamera:
                picam2.stop()
            else:
                cap.release()
            if self.ws:
                self.ws.close()


# ─────────────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--server',       default='ws://localhost:3000/rpi')
    p.add_argument('--model',        default='best.pt')
    p.add_argument('--conf',         type=float, default=0.45)
    p.add_argument('--res',          default='640x480')
    p.add_argument('--gps',          default=None,
                   help='GPS serial port e.g. /dev/ttyUSB0')
    p.add_argument('--gps-interval', type=float, default=1.0,
                   help='Seconds between GPS+detection JSON sends')
    args = p.parse_args()
    Streamer(args).run()


if __name__ == '__main__':
    main()