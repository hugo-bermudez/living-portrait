// ─────────────────────────────────────────────
//  Living Portrait – Bring Photos to Life
//  ml5.js FaceMesh + canvas triangle warping
// ─────────────────────────────────────────────

const LERP_SPEED = 0.4;

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

// ── State ───────────────────────────────────
let faceMesh;
let portraitFaceMesh;
let portraitImg       = null;
let portraitKeypoints = null;
let currentKeypoints  = null;
let smoothedCanvasKps = null;
let state             = 'loading'; // loading, upload, detecting, playing

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

// ── Triangle rendering ──────────────────────
function drawWarpedPortrait() {
  if (!currentKeypoints || !portraitKeypoints) return;

  const src = portraitKeypoints;
  const n = Math.min(src.length, currentKeypoints.length);

  // Compute destination points from webcam keypoints mapped to canvas
  const destKps = new Array(n);
  for (let i = 0; i < n; i++) {
    destKps[i] = webcamToCanvas(currentKeypoints[i]);
  }

  // Smooth the destination points to reduce jitter
  if (!smoothedCanvasKps) {
    smoothedCanvasKps = destKps.map(p => ({ x: p.x, y: p.y }));
  } else {
    for (let i = 0; i < n; i++) {
      smoothedCanvasKps[i].x += (destKps[i].x - smoothedCanvasKps[i].x) * LERP_SPEED;
      smoothedCanvasKps[i].y += (destKps[i].y - smoothedCanvasKps[i].y) * LERP_SPEED;
    }
  }

  for (let i = 0; i < TRIANGULATION.length; i += 3) {
    const i0 = TRIANGULATION[i];
    const i1 = TRIANGULATION[i + 1];
    const i2 = TRIANGULATION[i + 2];

    if (i0 >= n || i1 >= n || i2 >= n) continue;

    const d0 = smoothedCanvasKps[i0];
    const d1 = smoothedCanvasKps[i1];
    const d2 = smoothedCanvasKps[i2];

    drawTexturedTriangle(
      src[i0].x, src[i0].y, src[i1].x, src[i1].y, src[i2].x, src[i2].y,
      d0.x, d0.y, d1.x, d1.y, d2.x, d2.y
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

// ── Draw webcam background (mirrored, cover) ─
function drawWebcam() {
  const cw = canvas.width, ch = canvas.height;
  const vw = webcamEl.videoWidth || 640, vh = webcamEl.videoHeight || 480;
  const scale = Math.max(cw / vw, ch / vh);
  const sw = vw * scale, sh = vh * scale;

  ctx.save();
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

  controls.classList.add('hidden');
  calibrateScreen.classList.add('hidden');
  uploadScreen.classList.remove('hidden');
  fileInput.value = '';
  state = 'upload';
}

// ── Start ───────────────────────────────────
init();
