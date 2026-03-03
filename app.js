// ─────────────────────────────────────────────
//  Face Swap – Living Portrait
//  ml5.js FaceMesh + canvas triangle warping
//  with edge feathering & color matching
// ─────────────────────────────────────────────

const LERP_SPEED  = 0.4;
const FEATHER_PX  = 8;

// MediaPipe face oval indices (traces face outline)
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
];

// Inner lip keypoints — triangles fully inside this set are mouth interior
const MOUTH_INTERIOR = new Set([
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308,
  324, 318, 402, 317, 14, 87, 178, 88, 95
]);

// ── DOM ─────────────────────────────────────
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d');
const webcamEl    = document.getElementById('webcam');
const fileInput   = document.getElementById('file-input');
const dropZone    = document.getElementById('drop-zone');
const uploadScreen    = document.getElementById('upload-screen');
const calibrateScreen = document.getElementById('calibrate-screen');
const camPreview  = document.getElementById('cam-preview');
const controls    = document.getElementById('controls');
const btnReset    = document.getElementById('btn-reset');
const loader      = document.getElementById('loader');

// ── Offscreen canvases (created once, resized with window) ──
let faceCanvas, faceCtx;
let maskCanvas, maskCtx;

// ── State ───────────────────────────────────
let faceMesh;
let portraitFaceMesh;
let portraitImg       = null;
let portraitKeypoints = null;
let currentKeypoints  = null;
let smoothedCanvasKps = null;
let state             = 'loading';

// Color correction multipliers
let colorCorrection = { r: 1, g: 1, b: 1 };
let colorCorrectionReady = false;
let portraitIsGrayscale = false;

// ── Init ────────────────────────────────────
async function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const [webcamFM, portraitFM] = await Promise.all([
    new Promise(resolve => {
      const fm = ml5.faceMesh({ maxFaces: 1, refineLandmarks: true, flipped: true }, () => resolve(fm));
    }),
    new Promise(resolve => {
      const fm = ml5.faceMesh({ maxFaces: 1, refineLandmarks: true, flipped: false }, () => resolve(fm));
    }),
  ]);
  faceMesh = webcamFM;
  portraitFaceMesh = portraitFM;

  try {
    await startWebcam();
  } catch (err) {
    console.error('Webcam error:', err);
    loader.querySelector('p').textContent = 'Webcam access is required. Please allow camera access and reload.';
    return;
  }

  faceMesh.detectStart(webcamEl, onWebcamFace);

  loader.classList.add('hidden');
  state = 'upload';

  setupUploadHandlers();
  btnReset.addEventListener('click', resetToUpload);
  requestAnimationFrame(draw);
}

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  faceCanvas = document.createElement('canvas');
  faceCanvas.width = canvas.width;
  faceCanvas.height = canvas.height;
  faceCtx = faceCanvas.getContext('2d');

  maskCanvas = document.createElement('canvas');
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  maskCtx = maskCanvas.getContext('2d');
}

// ── Webcam ──────────────────────────────────
async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' }
  });
  webcamEl.srcObject = stream;
  webcamEl.setAttribute('width', 640);
  webcamEl.setAttribute('height', 480);
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
      uploadScreen.classList.add('hidden');
      state = 'detecting';
      detectPortraitFace();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ── Face detection on portrait ──────────────
function detectPortraitFace() {
  const offscreen = document.createElement('canvas');
  offscreen.width  = portraitImg.width;
  offscreen.height = portraitImg.height;
  const octx = offscreen.getContext('2d');
  octx.drawImage(portraitImg, 0, 0);

  portraitFaceMesh.detect(offscreen, (results) => {
    if (!results || results.length === 0) {
      alert('No face detected in the portrait. Please try a clearer front-facing photo.');
      state = 'upload';
      uploadScreen.classList.remove('hidden');
      return;
    }
    portraitKeypoints = results[0].keypoints.map(kp => ({ x: kp.x, y: kp.y }));
    smoothedCanvasKps = null;
    colorCorrectionReady = false;
    computePortraitSkinColor();
    controls.classList.remove('hidden');
    state = 'playing';
  });
}

// ── Webcam face tracking ────────────────────
function onWebcamFace(results) {
  if (!results || results.length === 0) return;
  currentKeypoints = results[0].keypoints.map(kp => ({ x: kp.x, y: kp.y }));
}

// ── Map webcam keypoint to canvas coordinates ─
function webcamToCanvas(kp) {
  const cw = canvas.width, ch = canvas.height;
  const vw = webcamEl.videoWidth || 640, vh = webcamEl.videoHeight || 480;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2;
  const oy = (ch - vh * s) / 2;
  return { x: ox + kp.x * s, y: oy + kp.y * s };
}

// ── Color matching ──────────────────────────
function computePortraitSkinColor() {
  if (!portraitKeypoints || !portraitImg) return;

  const tmpC = document.createElement('canvas');
  tmpC.width = portraitImg.width;
  tmpC.height = portraitImg.height;
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.drawImage(portraitImg, 0, 0);

  const sampleIndices = [1, 2, 4, 5, 6, 45, 51, 275, 281, 195, 197];
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  let maxChromaDiff = 0;

  for (const idx of sampleIndices) {
    if (idx >= portraitKeypoints.length) continue;
    const px = Math.round(portraitKeypoints[idx].x);
    const py = Math.round(portraitKeypoints[idx].y);
    if (px < 0 || py < 0 || px >= tmpC.width || py >= tmpC.height) continue;
    const data = tmpCtx.getImageData(px, py, 1, 1).data;
    rSum += data[0]; gSum += data[1]; bSum += data[2]; count++;
    const diff = Math.max(Math.abs(data[0] - data[1]), Math.abs(data[1] - data[2]), Math.abs(data[0] - data[2]));
    if (diff > maxChromaDiff) maxChromaDiff = diff;
  }

  if (count > 0) {
    colorCorrection._pr = rSum / count;
    colorCorrection._pg = gSum / count;
    colorCorrection._pb = bSum / count;
    colorCorrectionReady = true;
    // If max channel difference across all samples is tiny, portrait is grayscale
    portraitIsGrayscale = maxChromaDiff < 20;
  }
}

function updateColorCorrection() {
  if (!colorCorrectionReady || !currentKeypoints) return;

  // Sample webcam skin color from same facial landmarks
  const tmpC = document.createElement('canvas');
  const vw = webcamEl.videoWidth || 640, vh = webcamEl.videoHeight || 480;
  tmpC.width = vw; tmpC.height = vh;
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.drawImage(webcamEl, 0, 0);

  const sampleIndices = [1, 2, 4, 5, 6, 45, 51, 275, 281, 195, 197];
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (const idx of sampleIndices) {
    if (idx >= currentKeypoints.length) continue;
    const px = Math.round(currentKeypoints[idx].x);
    const py = Math.round(currentKeypoints[idx].y);
    if (px < 0 || py < 0 || px >= vw || py >= vh) continue;
    const data = tmpCtx.getImageData(px, py, 1, 1).data;
    rSum += data[0]; gSum += data[1]; bSum += data[2]; count++;
  }

  if (count > 0) {
    const wr = rSum / count, wg = gSum / count, wb = bSum / count;
    const pr = colorCorrection._pr, pg = colorCorrection._pg, pb = colorCorrection._pb;

    // Blend ratio (don't over-correct)
    const blend = 0.5;
    const targetR = pr + (wr - pr) * blend;
    const targetG = pg + (wg - pg) * blend;
    const targetB = pb + (wb - pb) * blend;

    colorCorrection.r += ((targetR / Math.max(pr, 1)) - colorCorrection.r) * 0.08;
    colorCorrection.g += ((targetG / Math.max(pg, 1)) - colorCorrection.g) * 0.08;
    colorCorrection.b += ((targetB / Math.max(pb, 1)) - colorCorrection.b) * 0.08;
  }
}

// ── Triangle rendering with blending ────────
let colorUpdateTimer = 0;

function drawWarpedPortrait() {
  if (!currentKeypoints || !portraitKeypoints) return;

  const src = portraitKeypoints;
  const n = Math.min(src.length, currentKeypoints.length);

  const destKps = new Array(n);
  for (let i = 0; i < n; i++) {
    destKps[i] = webcamToCanvas(currentKeypoints[i]);
  }

  if (!smoothedCanvasKps) {
    smoothedCanvasKps = destKps.map(p => ({ x: p.x, y: p.y }));
  } else {
    for (let i = 0; i < n; i++) {
      smoothedCanvasKps[i].x += (destKps[i].x - smoothedCanvasKps[i].x) * LERP_SPEED;
      smoothedCanvasKps[i].y += (destKps[i].y - smoothedCanvasKps[i].y) * LERP_SPEED;
    }
  }

  // Update color correction periodically (expensive operation)
  colorUpdateTimer++;
  if (colorUpdateTimer % 30 === 0) updateColorCorrection();

  // 1. Draw warped face triangles to offscreen canvas
  faceCtx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);

  for (let i = 0; i < TRIANGULATION.length; i += 3) {
    const i0 = TRIANGULATION[i];
    const i1 = TRIANGULATION[i + 1];
    const i2 = TRIANGULATION[i + 2];
    if (i0 >= n || i1 >= n || i2 >= n) continue;

    // Skip mouth interior triangles so webcam shows through
    if (MOUTH_INTERIOR.has(i0) && MOUTH_INTERIOR.has(i1) && MOUTH_INTERIOR.has(i2)) continue;

    const d0 = smoothedCanvasKps[i0];
    const d1 = smoothedCanvasKps[i1];
    const d2 = smoothedCanvasKps[i2];

    drawTexturedTriangle(
      faceCtx,
      src[i0].x, src[i0].y, src[i1].x, src[i1].y, src[i2].x, src[i2].y,
      d0.x, d0.y, d1.x, d1.y, d2.x, d2.y
    );
  }

  // 2. Apply color correction overlay (skip for B&W portraits)
  if (colorCorrectionReady && !portraitIsGrayscale) {
    const cr = colorCorrection.r, cg = colorCorrection.g, cb = colorCorrection.b;
    if (Math.abs(cr - 1) > 0.02 || Math.abs(cg - 1) > 0.02 || Math.abs(cb - 1) > 0.02) {
      faceCtx.globalCompositeOperation = 'multiply';
      const r = Math.round(Math.min(255, cr * 255));
      const g = Math.round(Math.min(255, cg * 255));
      const b = Math.round(Math.min(255, cb * 255));
      faceCtx.fillStyle = `rgb(${r},${g},${b})`;
      faceCtx.fillRect(0, 0, faceCanvas.width, faceCanvas.height);
      faceCtx.globalCompositeOperation = 'source-over';
    }
  }

  // 3. Create soft feathered mask from face silhouette (shrunk inward)
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  // Compute face center from oval points
  let cx = 0, cy = 0, ovalCount = 0;
  for (const idx of FACE_OVAL) {
    if (idx >= n) continue;
    cx += smoothedCanvasKps[idx].x;
    cy += smoothedCanvasKps[idx].y;
    ovalCount++;
  }
  cx /= ovalCount; cy /= ovalCount;

  // Draw the polygon shrunk 6% inward toward center to prevent outward glow
  const shrink = 0.94;
  maskCtx.save();
  maskCtx.filter = `blur(${FEATHER_PX}px)`;
  maskCtx.fillStyle = '#fff';
  maskCtx.beginPath();

  let first = true;
  for (const idx of FACE_OVAL) {
    if (idx >= n) continue;
    const p = smoothedCanvasKps[idx];
    const sx = cx + (p.x - cx) * shrink;
    const sy = cy + (p.y - cy) * shrink;
    if (first) { maskCtx.moveTo(sx, sy); first = false; }
    else maskCtx.lineTo(sx, sy);
  }
  maskCtx.closePath();
  maskCtx.fill();
  maskCtx.restore();

  // 4. Apply mask to face canvas
  faceCtx.globalCompositeOperation = 'destination-in';
  faceCtx.drawImage(maskCanvas, 0, 0);
  faceCtx.globalCompositeOperation = 'source-over';

  // 5. Composite masked face onto main canvas
  ctx.drawImage(faceCanvas, 0, 0);
}

function drawTexturedTriangle(c, u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2) {
  const denom = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
  if (Math.abs(denom) < 0.01) return;

  c.save();
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.lineTo(x2, y2);
  c.closePath();
  c.clip();

  const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / denom;
  const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / denom;
  const cc = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / denom;
  const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / denom;
  const e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / denom;
  const f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / denom;

  c.setTransform(a, b, cc, d, e, f);
  c.drawImage(portraitImg, 0, 0);
  c.restore();
}

// ── Draw webcam background (mirrored, cover) ─
function drawWebcam() {
  const cw = canvas.width, ch = canvas.height;
  const vw = webcamEl.videoWidth || 640, vh = webcamEl.videoHeight || 480;
  const scale = Math.max(cw / vw, ch / vh);
  const sw = vw * scale, sh = vh * scale;

  ctx.save();
  if (portraitIsGrayscale) ctx.filter = 'grayscale(1)';
  ctx.translate(cw, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(webcamEl, (cw - sw) / 2, (ch - sh) / 2, sw, sh);
  ctx.restore();
}

// ── Main draw loop ──────────────────────────
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#1a0a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state === 'playing' && portraitImg) {
    drawWebcam();
    drawWarpedPortrait();
  } else if (state === 'detecting') {
    drawWebcam();
    ctx.fillStyle = 'rgba(26,10,46,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6bfff0';
    ctx.font = '800 20px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🔍 Finding face…', canvas.width / 2, canvas.height / 2);
  }

  requestAnimationFrame(draw);
}

// ── Reset ───────────────────────────────────
function resetToUpload() {
  portraitImg       = null;
  portraitKeypoints = null;
  currentKeypoints  = null;
  smoothedCanvasKps = null;
  colorCorrectionReady = false;
  colorCorrection = { r: 1, g: 1, b: 1 };
  portraitIsGrayscale = false;

  controls.classList.add('hidden');
  calibrateScreen.classList.add('hidden');
  uploadScreen.classList.remove('hidden');
  fileInput.value = '';
  state = 'upload';
}

// ── Start ───────────────────────────────────
init();
