# YOLO Rust Detector Drone — Pipeline Inspection Dashboard

Visual monitoring interface for drone-based pipeline inspection using YOLOv12n with GPS localization.

**Project:** Bachelor Thesis — ME234804  
**Author:** Krisna Hafara Priyanto (NRP. 5019221142)  
**Co-Author:** Gerald Mahapranaja Pillian
**Dept:** Marine Engineering, ITS Surabaya
**Dept 2:** Information Systems, ITS Surabaya

---

## Overview

A web-based HMI (Human-Machine Interface) that displays:
- Live drone video feed (MJPEG stream or WebSocket)
- Real-time YOLO defect detection overlays (corrosion, TPD)
- GPS satellite map with geotagged defect markers
- Detection log and confidence scores

---

## Repository Structure

```
YOLO-RustDetectorDrone1/
├── dashboard/                  # Web HMI (this repo section)
│   ├── index.html              # Main dashboard entry
│   ├── style.css               # Styles
│   ├── app.js                  # Dashboard logic
│   └── assets/                 # Icons, fonts
├── model/                      # YOLOv12n training
│   ├── train.py                # Training script
│   ├── detect.py               # Inference script
│   ├── requirements.txt
│   └── weights/                # .pt model weights
├── rpi/                        # Raspberry Pi onboard code
│   ├── streamer.py             # Camera + YOLO stream server
│   ├── gps_logger.py           # GPS NEO-6M read & POST
│   └── requirements.txt
├── server/                     # Node.js relay server
│   ├── server.js               # Express + WebSocket bridge
│   ├── package.json
│   └── .env.example
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Detection model | YOLOv12n (Ultralytics) + TensorFlow |
| Onboard compute | Raspberry Pi 3/4 |
| GPS | NEO-6M via serial + SIM800 for LTE |
| Stream relay | Node.js + Express + `ws` (WebSocket) |
| Dashboard | Vanilla HTML/CSS/JS (no framework) |
| Map | Leaflet.js (OpenStreetMap) |

---

## Quick Start

### 1. Server (Windows / Linux)

```bash
cd server
npm install
cp .env.example .env   # set PORT, STREAM_SOURCE
node server.js
```

### 2. Dashboard

Open `dashboard/index.html` directly in browser, or serve via:

```bash
npx serve dashboard
```

Point your browser to `http://localhost:3000`.

### 3. Raspberry Pi (onboard drone)

```bash
pip install -r rpi/requirements.txt
python rpi/streamer.py --server ws://<YOUR_SERVER_IP>:3000
python rpi/gps_logger.py --server http://<YOUR_SERVER_IP>:3000
```

---

## API Endpoints (server.js)

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Dashboard |
| `WS` | `/stream` | MJPEG/binary video frames |
| `POST` | `/gps` | Receive GPS + detection payload from RPi |
| `GET` | `/detections` | Last N detections as JSON |

### GPS POST Payload

```json
{
  "lat": -7.2575,
  "lon": 112.7521,
  "timestamp": "2026-06-04T10:23:00Z",
  "detections": [
    { "class": "corrosion", "confidence": 0.91, "bbox": [x, y, w, h] },
    { "class": "tpd", "confidence": 0.87, "bbox": [x, y, w, h] }
  ]
}
```

---

## Detection Classes

| Class | Label | Color |
|---|---|---|
| Corrosion | `corrosion` | `#e85d3a` |
| Third-Party Damage | `tpd` | `#f0a500` |
| Normal | `normal` | `#2eb87e` |

---

## Environment Variables (`.env`)

```
PORT=3000
STREAM_SOURCE=http://192.168.1.x:8080/stream  # RPi camera IP
GPS_HISTORY_LIMIT=500
```

---

## Thesis Context

Detection targets: surface corrosion (rust, oxidation) and third-party mechanical damage (dents, impacts) on above-ground industrial pipelines in Surabaya / Gresik maritime corridor.

Model: YOLOv12n trained on ~1000–2000 annotated images (field + Kaggle datasets).  
Evaluation metrics: mAP, precision, recall, F1, inference latency.

---

## References

- Sari et al. (2020) — Gresik–Legundi–Cerme pipeline risk
- Simanjuntak & Putro (2020) — TPD risk assessment
- Jocher et al. (2024) — YOLOv11/12 architecture
- Muhlbauer (2008) — Pipeline risk framework