# YOLO Rust Detector Drone — Pipeline Inspection Dashboard

Visual monitoring interface for drone-based pipeline inspection using YOLOv12n with GPS localization.

**Project:** Bachelor Thesis — ME234804  
**Author:** Krisna Hafara Priyanto (NRP. 5019221142)  
**Co-Author:** Gerald Mahapranaja Pillian  (NRP. 5026201050)
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
YOLO-RustDetectorDrone1-WEB/
├── dashboard/                  # Web HMI
│   ├── index.html              # Main dashboard entry
│   ├── style.css               # Styles (light/dark theme)
│   └── app.js                  # Dashboard logic (WS, GPS, detection rendering)
├── rpi/                        # Raspberry Pi onboard code
│   ├── streamer.py             # Camera capture + YOLOv12n inference + WS stream
│   ├── best.pt                 # Trained YOLOv12n weights (not tracked by git)
│   └── requirements.txt
├── server/                     # Node.js relay server
│   ├── server.js               # Express + WebSocket bridge
│   ├── package.json
│   └── .env.example
└── README.md
```

> `best.pt` is not committed to git (file size). Place it manually in `rpi/` after training. See [Model Weights](#model-weights) below.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Detection model | YOLOv12n (Ultralytics) |
| Onboard compute | Raspberry Pi 3/4 |
| GPS | NEO-6M via serial |
| Stream relay | Node.js + Express + `ws` |
| Dashboard | Vanilla HTML/CSS/JS |
| Map | Leaflet.js (OpenStreetMap) |

---

## Quick Start

### 1. Server (Windows / Linux)

```bash
cd server
npm install
cp .env.example .env
node server.js
```

Dashboard is served at `http://localhost:3000`.  
RPi connects to `ws://localhost:3000/rpi`.  
Browser connects to `ws://localhost:3000`.

### 2. Dashboard

Open `http://localhost:3000` in your browser. Click the gear icon (bottom right), enter the WebSocket URL and camera stream URL, then press **Connect**.

### 3. Raspberry Pi

```bash
cd rpi
pip install -r requirements.txt
python streamer.py    # runs YOLO on camera frames and streams to server
python gps_logger.py  # reads NEO-6M GPS and POSTs to server
```

Both scripts read `SERVER_URL` from `.env` or accept it as a CLI argument.

---

## Model Weights

The `best.pt` file is the trained YOLOv12n model output from Ultralytics training. It is **not stored in this repo** due to file size.

To use it:
1. Train the model: `yolo train model=yolov12n.pt data=dataset.yaml epochs=100`
2. Copy `runs/detect/train/weights/best.pt` into `rpi/`
3. `streamer.py` loads it via `YOLO('best.pt')`

If you want to commit it anyway, use [Git LFS](https://git-lfs.com):
```bash
git lfs track "*.pt"
git add .gitattributes rpi/best.pt
```

---

## Connecting the Dashboard

1. Start `server.js` on your Windows/Linux machine
2. Make sure the RPi and the PC are on the same network (e.g. hotspot or LAN)
3. Open the dashboard in browser → click the gear icon
4. Enter:
   - **WebSocket URL**: `ws://<server-ip>:3000` (e.g. `ws://192.168.137.1:3000`)
   - **Stream URL**: `http://<rpi-ip>:8080/stream` (MJPEG from RPi camera)
5. Press **Connect**
6. The status chip top-right turns green when the WebSocket handshake succeeds

The RPi connects separately to `ws://<server-ip>:3000/rpi`. The server then relays all GPS and detection data from the RPi to the browser automatically.

---

## Confidence Threshold

The confidence threshold (0–100%) filters which detections are displayed. For example:
- Set to **50%**: only detections where the model is at least 50% confident are shown
- Set to **80%**: stricter — fewer detections, but higher reliability
- Set to **0%**: everything the model detects is shown, including uncertain guesses

A value of **50–60%** is a reasonable starting point. Raise it if you're seeing too many false positives during testing.

---

## API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Serves dashboard |
| `WS` | `/` | Browser WebSocket connection |
| `WS` | `/rpi` | Raspberry Pi WebSocket connection |
| `POST` | `/gps` | HTTP fallback: receive GPS + detections from RPi |
| `GET` | `/detections` | Last N detections as JSON |
| `GET` | `/status` | Connection status (rpi, browsers, latest GPS) |

### RPi Payload Format

```json
{
  "lat": -7.2575,
  "lon": 112.7521,
  "timestamp": "2026-06-04T10:23:00Z",
  "satellites": 8,
  "altitude": 15.4,
  "detections": [
    { "class": "corrosion", "confidence": 0.91, "bbox": [x, y, w, h] },
    { "class": "tpd",       "confidence": 0.87, "bbox": [x, y, w, h] }
  ]
}
```

---

## Detection Classes

| Class | Label | Color |
|---|---|---|
| Corrosion | `corrosion` | `#ef6a3b` |
| Third-Party Damage | `tpd` | `#f0b429` |
| Normal | `normal` | `#34d399` |

---

## Environment Variables (`.env`)

```
PORT=3000
GPS_HISTORY_LIMIT=500
STREAM_SOURCE=http://192.168.x.x:8080/stream
```

---

## Thesis Context

Detection targets: surface corrosion (rust, oxidation) and third-party mechanical damage (dents, impacts) on above-ground industrial pipelines in the Surabaya / Gresik maritime corridor.

Model: YOLOv12n trained on ~1000–2000 annotated images (field-acquired + Kaggle datasets), labeled with LabelImg in YOLO/Pascal format.  
Evaluation metrics: mAP, precision, recall, F1-score, inference latency.

---

## References

- Sari et al. (2020) — Gresik–Legundi–Cerme pipeline risk analysis
- Simanjuntak & Putro (2020) — TPD risk assessment
- Jocher et al. (2024) — YOLOv11/12 architecture
- Muhlbauer (2008) — Pipeline risk management framework