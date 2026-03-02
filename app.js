// ─────────────────────────────────────────────
//  Living Portrait – Bring Photos to Life
//  ml5.js FaceMesh + canvas triangle warping
// ─────────────────────────────────────────────

const CALIBRATE_FRAMES = 40;
const MOTION_SCALE     = 1.4;
const LERP_SPEED       = 0.35;

// ── DOM ─────────────────────────────────────
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d');
const webcamEl    = document.getElementById('webcam');
const fileInput   = document.getElementById('file-input');
const dropZone    = document.getElementById('drop-zone');
const uploadScreen    = document.getElementById('upload-screen');
const calibrateScreen = document.getElementById('calibrate-screen');
const calibrateBar    = document.getElementById('calibrate-bar');
const camPreview  = document.getElementById('cam-preview');
const controls    = document.getElementById('controls');
const btnReset    = document.getElementById('btn-reset');
const loader      = document.getElementById('loader');

// ── State ───────────────────────────────────
let faceMesh;
let portraitImg       = null;
let portraitKeypoints = null;
let neutralKeypoints  = null;
let currentKeypoints  = null;
let warpedKeypoints   = null;
let calibrateCount    = 0;
let calibrateSamples  = [];
let state             = 'loading'; // loading, upload, detecting, calibrating, playing

// Display rect for portrait (centered, fitted)
let pr = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

// ── Init ────────────────────────────────────
async function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Wait for FaceMesh model to actually finish loading
  faceMesh = await new Promise(resolve => {
    const fm = ml5.faceMesh({ maxFaces: 1, refineLandmarks: true, flipped: true }, () => resolve(fm));
  });

  try {
    await startWebcam();
  } catch (err) {
    console.error('Webcam error:', err);
    loader.querySelector('p').textContent = 'Webcam access is required. Please allow camera access and reload.';
    return;
  }

  loader.classList.add('hidden');
  state = 'upload';

  setupUploadHandlers();
  btnReset.addEventListener('click', resetToUpload);
  requestAnimationFrame(draw);
}

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  if (portraitImg) computePortraitRect();
}

// ── Webcam ──────────────────────────────────
async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' }
  });
  webcamEl.srcObject = stream;
  await webcamEl.play();
}

// ── File upload ─────────────────────────────
function setupUploadHandlers() {
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadPortrait(e.target.files[0]);
  });

  dropZone.addEventListener('dragover', e => {
    e.preventDefault(); dropZone.classList.add('over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('over');
    if (e.dataTransfer.files[0]) loadPortrait(e.dataTransfer.files[0]);
  });
}

function loadPortrait(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      portraitImg = img;
      computePortraitRect();

      // Show portrait immediately with detecting state
      uploadScreen.classList.add('hidden');
      state = 'detecting';
      detectPortraitFace();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function computePortraitRect() {
  const cw = canvas.width, ch = canvas.height;
  const iw = portraitImg.width, ih = portraitImg.height;
  const scale = Math.min(cw / iw, ch / ih) * 0.85;
  pr.w = iw * scale;
  pr.h = ih * scale;
  pr.x = (cw - pr.w) / 2;
  pr.y = (ch - pr.h) / 2;
  pr.scale = scale;
}

// ── Face detection on portrait ──────────────
function detectPortraitFace() {
  const offscreen = document.createElement('canvas');
  offscreen.width  = portraitImg.width;
  offscreen.height = portraitImg.height;
  const octx = offscreen.getContext('2d');
  octx.drawImage(portraitImg, 0, 0);

  // Reuse the already-loaded FaceMesh model (has flipped:true, so we un-flip x)
  faceMesh.detect(offscreen, (results) => {
    if (!results || results.length === 0) {
      alert('No face detected in the portrait. Please try a clearer front-facing photo.');
      state = 'upload';
      uploadScreen.classList.remove('hidden');
      return;
    }
    const imgW = portraitImg.width;
    portraitKeypoints = results[0].keypoints.map(kp => ({
      x: imgW - kp.x,
      y: kp.y,
    }));
    startCalibration();
  });
}

// ── Calibration ─────────────────────────────
function startCalibration() {
  uploadScreen.classList.add('hidden');
  calibrateScreen.classList.remove('hidden');
  state = 'calibrating';
  calibrateCount   = 0;
  calibrateSamples = [];

  faceMesh.detectStart(webcamEl, onWebcamFace);
}

function onWebcamFace(results) {
  if (!results || results.length === 0) return;
  currentKeypoints = results[0].keypoints.map(kp => ({ x: kp.x, y: kp.y }));

  if (state === 'calibrating') {
    calibrateSamples.push(currentKeypoints);
    calibrateCount++;
    calibrateBar.style.width = Math.min(100, (calibrateCount / CALIBRATE_FRAMES) * 100) + '%';

    if (calibrateCount >= CALIBRATE_FRAMES) finishCalibration();
  }
}

function finishCalibration() {
  // Average all samples for a stable neutral pose
  const n = calibrateSamples.length;
  neutralKeypoints = calibrateSamples[0].map((_, i) => ({
    x: calibrateSamples.reduce((s, f) => s + f[i].x, 0) / n,
    y: calibrateSamples.reduce((s, f) => s + f[i].y, 0) / n,
  }));

  // Initialize warped keypoints
  warpedKeypoints = portraitKeypoints.map(kp => ({ x: kp.x, y: kp.y }));

  calibrateScreen.classList.add('hidden');
  camPreview.classList.remove('hidden');
  controls.classList.remove('hidden');
  state = 'playing';
}

// ── Motion mapping ──────────────────────────
function updateWarp() {
  if (!currentKeypoints || !neutralKeypoints || !portraitKeypoints) return;

  // Compute bounding boxes for normalization
  const nBox = boundingBox(neutralKeypoints);
  const pBox = boundingBox(portraitKeypoints);

  const scaleX = pBox.w / nBox.w;
  const scaleY = pBox.h / nBox.h;

  for (let i = 0; i < portraitKeypoints.length && i < currentKeypoints.length; i++) {
    const dx = (currentKeypoints[i].x - neutralKeypoints[i].x) * scaleX * MOTION_SCALE;
    const dy = (currentKeypoints[i].y - neutralKeypoints[i].y) * scaleY * MOTION_SCALE;

    const targetX = portraitKeypoints[i].x + dx;
    const targetY = portraitKeypoints[i].y + dy;

    warpedKeypoints[i].x += (targetX - warpedKeypoints[i].x) * LERP_SPEED;
    warpedKeypoints[i].y += (targetY - warpedKeypoints[i].y) * LERP_SPEED;
  }
}

function boundingBox(kps) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const kp of kps) {
    if (kp.x < minX) minX = kp.x;
    if (kp.y < minY) minY = kp.y;
    if (kp.x > maxX) maxX = kp.x;
    if (kp.y > maxY) maxY = kp.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── Triangle rendering ──────────────────────
function drawWarpedPortrait() {
  // Draw original image as background
  ctx.drawImage(portraitImg, pr.x, pr.y, pr.w, pr.h);

  const src = portraitKeypoints;
  const dst = warpedKeypoints;
  const s   = pr.scale;

  for (let i = 0; i < TRIANGULATION.length; i += 3) {
    const i0 = TRIANGULATION[i];
    const i1 = TRIANGULATION[i + 1];
    const i2 = TRIANGULATION[i + 2];

    if (i0 >= src.length || i1 >= src.length || i2 >= src.length) continue;

    drawTexturedTriangle(
      src[i0].x, src[i0].y, src[i1].x, src[i1].y, src[i2].x, src[i2].y,
      pr.x + dst[i0].x * s, pr.y + dst[i0].y * s,
      pr.x + dst[i1].x * s, pr.y + dst[i1].y * s,
      pr.x + dst[i2].x * s, pr.y + dst[i2].y * s
    );
  }
}

function drawTexturedTriangle(u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2) {
  const denom = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
  if (Math.abs(denom) < 0.01) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();

  const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / denom;
  const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / denom;
  const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / denom;
  const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / denom;
  const e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / denom;
  const f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / denom;

  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(portraitImg, 0, 0);
  ctx.restore();
}

// ── Main draw loop ──────────────────────────
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Dark background
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state === 'playing' && portraitImg && warpedKeypoints) {
    updateWarp();
    drawWarpedPortrait();
    drawFrame();
  } else if ((state === 'detecting' || state === 'calibrating') && portraitImg) {
    ctx.globalAlpha = state === 'detecting' ? 0.6 : 0.5;
    ctx.drawImage(portraitImg, pr.x, pr.y, pr.w, pr.h);
    ctx.globalAlpha = 1;
    drawFrame();

    if (state === 'detecting') {
      ctx.fillStyle = 'rgba(10,10,26,0.55)';
      ctx.fillRect(pr.x, pr.y, pr.w, pr.h);
      ctx.fillStyle = '#d4a574';
      ctx.font = '500 18px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Detecting face…', canvas.width / 2, canvas.height / 2);
    }
  }

  requestAnimationFrame(draw);
}

// ── Decorative frame ────────────────────────
function drawFrame() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pad = 8;
  ctx.strokeStyle = 'rgba(212,165,116,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(pr.x - pad, pr.y - pad, pr.w + pad * 2, pr.h + pad * 2);

  ctx.strokeStyle = 'rgba(212,165,116,0.1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pr.x - pad - 5, pr.y - pad - 5, pr.w + pad * 2 + 10, pr.h + pad * 2 + 10);
}

// ── Reset ───────────────────────────────────
function resetToUpload() {
  try { faceMesh.detectStop(); } catch (_) {}
  portraitImg       = null;
  portraitKeypoints = null;
  neutralKeypoints  = null;
  currentKeypoints  = null;
  warpedKeypoints   = null;
  calibrateCount    = 0;
  calibrateSamples  = [];

  camPreview.classList.add('hidden');
  controls.classList.add('hidden');
  calibrateScreen.classList.add('hidden');
  uploadScreen.classList.remove('hidden');
  uploadScreen.querySelector('.drop-label').textContent = 'Drop a portrait here or click to upload';
  fileInput.value = '';
  state = 'upload';
}

// ── Start ───────────────────────────────────
init();
