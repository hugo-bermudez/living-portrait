# 🎭 Living Portrait

Upload a portrait photo and bring it to life using your facial expressions.

## How It Works

1. Upload a front-facing portrait photo
2. Allow webcam access
3. Look at the camera and hold still for calibration
4. Move your face — the portrait mirrors your expressions in real-time

## Tech

- **ml5.js FaceMesh** — 468 facial landmark detection
- **Canvas 2D** — affine triangle mesh warping
- **MediaPipe triangulation** — 852 triangles mapping the face surface

The app detects facial landmarks on both the uploaded portrait and your webcam feed, then warps the portrait’s face mesh in real-time to match your movements.

## Run Locally

```bash
npx serve .
```

Requires HTTPS for webcam access.
