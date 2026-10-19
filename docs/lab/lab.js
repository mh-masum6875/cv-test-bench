/* CV Lab: eight computer vision tasks running in the browser with MediaPipe Tasks (WebAssembly).
   Models, runtime and sample pictures are bundled in this folder, so the page needs no outside service. */
import { FilesetResolver, ObjectDetector, ImageClassifier, FaceDetector, FaceLandmarker, HandLandmarker, GestureRecognizer, PoseLandmarker, ImageSegmenter, DrawingUtils } from './vendor/vision_bundle.mjs';

const $ = s => document.querySelector(s);
const canvas = $('#out'), ctx = canvas.getContext('2d', { willReadFrequently: true });
const COLORS = ['#2dd4bf', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#4ade80', '#fb923c', '#f87171'];
const VOC = ['background', 'aeroplane', 'bicycle', 'bird', 'boat', 'bottle', 'bus', 'car', 'cat', 'chair', 'cow', 'dining table', 'dog', 'horse', 'motorbike', 'person', 'potted plant', 'sheep', 'sofa', 'train', 'tv'];
const pct = v => Math.round(v * 100);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const TASKS = [
  { id: 'detect', name: 'Object detection', short: 'Boxes and labels', thr: 0.4, sample: 'samples/cats_and_dogs.jpg', model: 'models/efficientdet_lite0.tflite',
    desc: 'Finds everyday objects and shows where each one is.',
    how: 'The network looks at the whole picture once and predicts a box, a label and a score for every object it finds. Raise the minimum score to keep only confident detections.',
    info: 'EfficientDet-Lite0, 7 MB, trained to recognise 80 common object types.',
    make: (fs, base, mode, thr) => ObjectDetector.createFromOptions(fs, { baseOptions: base, runningMode: mode, scoreThreshold: thr, maxResults: 15 }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.detectForVideo(el, ts) : m.detect(el),
    draw: (r, c, s) => { r.detections.forEach((d, i) => box(c, d.boundingBox, s, COLORS[i % COLORS.length], `${d.categories[0].categoryName} ${pct(d.categories[0].score)}%`)); },
    list: r => r.detections.map(d => ({ label: d.categories[0].categoryName, score: d.categories[0].score })), unit: 'objects' },
  { id: 'classify', name: 'Image classification', short: 'What is in the picture', thr: 0.0, sample: 'samples/burger.jpg', model: 'models/efficientnet_lite0.tflite',
    desc: 'Names the main subject of the whole picture.',
    how: 'Unlike detection, classification gives one answer for the entire image: a ranked list of the most likely labels from 1,000 categories.',
    info: 'EfficientNet-Lite0 (8-bit), 5 MB, trained on ImageNet categories.',
    make: (fs, base, mode) => ImageClassifier.createFromOptions(fs, { baseOptions: base, runningMode: mode, maxResults: 5 }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.classifyForVideo(el, ts) : m.classify(el),
    draw: () => { }, list: r => (r.classifications[0] ? r.classifications[0].categories : []).map(c => ({ label: c.categoryName, score: c.score })), unit: 'labels' },
  { id: 'face', name: 'Face detection', short: 'Faces and key points', thr: 0.5, sample: 'samples/portrait.jpg', model: 'models/blaze_face_short_range.tflite',
    desc: 'Finds faces and marks the eyes, nose, mouth and ears.',
    how: 'A very small network (BlazeFace) built for phones. It returns a box and six key points per face and runs fast even without a graphics card.',
    info: 'BlazeFace short range, 0.2 MB.',
    make: (fs, base, mode, thr) => FaceDetector.createFromOptions(fs, { baseOptions: base, runningMode: mode, minDetectionConfidence: thr }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.detectForVideo(el, ts) : m.detect(el),
    draw: (r, c, s) => r.detections.forEach((d, i) => {
      box(c, d.boundingBox, s, COLORS[i % COLORS.length], `face ${pct(d.categories[0].score)}%`);
      (d.keypoints || []).forEach(k => { c.beginPath(); c.arc(k.x * c.canvas.width, k.y * c.canvas.height, 4, 0, 7); c.fillStyle = '#fff'; c.fill(); });
    }),
    list: r => r.detections.map((d, i) => ({ label: 'Face ' + (i + 1), score: d.categories[0].score })), unit: 'faces' },
  { id: 'landmarks', name: 'Face landmarks', short: '468 points and expressions', thr: 0, sample: 'samples/portrait.jpg', model: 'models/face_landmarker.task',
    desc: 'Maps 468 points on the face and scores expressions such as a smile.',
    how: 'The model fits a 3D face mesh to the picture. It also outputs blendshape scores, numbers that say how much the mouth is open, the brows are raised and so on.',
    info: 'MediaPipe Face Landmarker, 4 MB.',
    make: (fs, base, mode) => FaceLandmarker.createFromOptions(fs, { baseOptions: base, runningMode: mode, numFaces: 2, outputFaceBlendshapes: true }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.detectForVideo(el, ts) : m.detect(el),
    draw: (r, c, s, du) => r.faceLandmarks.forEach(lm => {
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELLATION, { color: '#ffffff33', lineWidth: 1 });
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: '#e8eef2', lineWidth: 2 });
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: '#2dd4bf', lineWidth: 2 });
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: '#2dd4bf', lineWidth: 2 });
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LIPS, { color: '#f472b6', lineWidth: 2 });
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: '#fbbf24', lineWidth: 2 });
      du.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: '#fbbf24', lineWidth: 2 });
    }),
    list: r => (r.faceBlendshapes[0] ? r.faceBlendshapes[0].categories : []).filter(c => c.categoryName !== '_neutral').sort((a, b) => b.score - a.score).slice(0, 6).map(c => ({ label: c.categoryName.replace(/([A-Z])/g, ' $1').toLowerCase(), score: c.score })),
    count: r => r.faceLandmarks.length, unit: 'faces' },
  { id: 'hands', name: 'Hand tracking', short: '21 points per hand', thr: 0, sample: 'samples/thumb_up.jpg', model: 'models/hand_landmarker.task',
    desc: 'Tracks up to two hands and marks 21 joints on each.',
    how: 'One network finds the palm, a second finds the 21 joint positions inside it. In video the palm search is skipped on most frames, which keeps it fast.',
    info: 'MediaPipe Hand Landmarker, 8 MB.',
    make: (fs, base, mode) => HandLandmarker.createFromOptions(fs, { baseOptions: base, runningMode: mode, numHands: 2 }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.detectForVideo(el, ts) : m.detect(el),
    draw: (r, c, s, du) => r.landmarks.forEach(lm => { du.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#2dd4bf', lineWidth: 4 }); du.drawLandmarks(lm, { color: '#ffffff', lineWidth: 1, radius: 3 }); }),
    list: r => r.handedness.map((h, i) => ({ label: `${h[0].categoryName} hand`, score: h[0].score })), count: r => r.landmarks.length, unit: 'hands' },
  { id: 'gesture', name: 'Gesture recognition', short: 'Thumbs up, victory, fist...', thr: 0, sample: 'samples/victory.jpg', model: 'models/gesture_recognizer.task',
    desc: 'Recognises hand gestures such as thumbs up, victory, open palm and pointing.',
    how: 'It tracks the hand joints first, then a small classifier reads the joint layout and picks one of seven gestures.',
    info: 'MediaPipe Gesture Recognizer, 8 MB.',
    make: (fs, base, mode) => GestureRecognizer.createFromOptions(fs, { baseOptions: base, runningMode: mode, numHands: 2 }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.recognizeForVideo(el, ts) : m.recognize(el),
    draw: (r, c, s, du) => r.landmarks.forEach((lm, i) => {
      du.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#2dd4bf', lineWidth: 4 }); du.drawLandmarks(lm, { color: '#ffffff', lineWidth: 1, radius: 3 });
      const g = r.gestures[i] && r.gestures[i][0]; if (g && g.categoryName !== 'None') label(c, `${g.categoryName} ${pct(g.score)}%`, lm[0].x * c.canvas.width, lm[0].y * c.canvas.height + 26, '#fbbf24');
    }),
    list: r => r.gestures.map(g => ({ label: g[0].categoryName === 'None' ? 'no known gesture' : g[0].categoryName.replace(/_/g, ' ').toLowerCase(), score: g[0].score })), count: r => r.landmarks.length, unit: 'hands' },
  { id: 'pose', name: 'Pose estimation', short: 'Body skeleton', thr: 0, sample: 'samples/pose.jpg', model: 'models/pose_landmarker_lite.task',
    desc: 'Finds the body skeleton: 33 points from the face to the feet.',
    how: 'The network locates each person and then regresses 33 body landmarks. Joint angles from these points are how fitness apps count repetitions.',
    info: 'MediaPipe Pose Landmarker (lite), 6 MB.',
    make: (fs, base, mode) => PoseLandmarker.createFromOptions(fs, { baseOptions: base, runningMode: mode, numPoses: 3 }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.detectForVideo(el, ts) : m.detect(el),
    draw: (r, c, s, du) => r.landmarks.forEach(lm => { du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#2dd4bf', lineWidth: 4 }); du.drawLandmarks(lm, { color: '#ffffff', lineWidth: 1, radius: 3 }); }),
    list: r => r.landmarks.map((lm, i) => ({ label: `Person ${i + 1}: ${lm.filter(p => (p.visibility ?? 1) > 0.5).length} of 33 points visible`, score: lm.reduce((a, p) => a + (p.visibility ?? 1), 0) / lm.length })), count: r => r.landmarks.length, unit: 'people' },
  { id: 'segment', name: 'Segmentation', short: 'Label every pixel', thr: 0, sample: 'samples/pose.jpg', model: 'models/deeplab_v3.tflite',
    desc: 'Gives every pixel a class, such as person, cat, dog or chair.',
    how: 'DeepLab outputs a mask the size of the picture where each pixel holds a class number. The coloured overlay shows the mask, and the list shows how much of the picture each class covers.',
    info: 'DeepLab v3, 3 MB, 21 classes (PASCAL VOC).',
    make: (fs, base, mode) => ImageSegmenter.createFromOptions(fs, { baseOptions: base, runningMode: mode, outputCategoryMask: true, outputConfidenceMasks: false }),
    run: (m, el, mode, ts) => mode === 'VIDEO' ? m.segmentForVideo(el, ts) : m.segment(el),
    draw: (r, c, s, du, ctxState) => { const stats = overlayMask(c, r.categoryMask); ctxState.stats = stats; },
    list: (r, st) => (st.stats || []).filter(x => x.cls !== 0).slice(0, 6).map(x => ({ label: VOC[x.cls] || 'class ' + x.cls, score: x.frac })), count: (r, st) => (st.stats || []).filter(x => x.cls !== 0).length, unit: 'classes' }
];

/* ---------- drawing helpers ---------- */
function label(c, text, x, y, color) {
  c.font = '600 15px system-ui'; const w = c.measureText(text).width + 10;
  c.fillStyle = color; c.fillRect(x, y - 20, w, 22); c.fillStyle = '#0b1014'; c.fillText(text, x + 5, y - 4);
}
function box(c, bb, s, color, text) {
  const x = bb.originX * s, y = bb.originY * s, w = bb.width * s, h = bb.height * s;
  c.lineWidth = 3; c.strokeStyle = color; c.strokeRect(x, y, w, h); label(c, text, x, Math.max(20, y), color);
}
function overlayMask(c, mask) {
  const w = mask.width, h = mask.height, data = mask.getAsUint8Array(), counts = new Map();
  const img = new ImageData(w, h);
  for (let i = 0; i < data.length; i++) {
    const k = data[i]; counts.set(k, (counts.get(k) || 0) + 1);
    if (k) { const col = hexToRgb(COLORS[k % COLORS.length]); img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 140; }
  }
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h; tmp.getContext('2d').putImageData(img, 0, 0);
  c.drawImage(tmp, 0, 0, c.canvas.width, c.canvas.height); mask.close();
  return [...counts.entries()].map(([cls, n]) => ({ cls, frac: n / data.length })).sort((a, b) => b.frac - a.frac);
}
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

/* ---------- state ---------- */
let fileset = null, task = null, model = null, mode = 'IMAGE', media = null, source = 'sample', stream = null, raf = 0, runId = 0;
let thr = 0.4, emaMs = 0, frames = 0, tFps = performance.now(), lastTs = 0;
const du = new DrawingUtils(ctx);

function busy(text) { const b = $('#busy'); b.textContent = text || ''; b.classList.toggle('hidden', !text); }

function buildTabs() {
  $('#tasks').innerHTML = TASKS.map(t => `<button class="task" role="tab" data-id="${t.id}"><b>${t.name}</b><span>${t.short}</span></button>`).join('');
  $('#tasks').onclick = e => { const b = e.target.closest('.task'); if (b) selectTask(b.dataset.id); };
}

async function selectTask(id) {
  const t = TASKS.find(x => x.id === id) || TASKS[0];
  stopLoop(); stopStream();
  const mine = ++runId;
  document.querySelectorAll('.task').forEach(b => { b.classList.toggle('on', b.dataset.id === t.id); b.setAttribute('aria-selected', b.dataset.id === t.id); });
  history.replaceState(null, '', '#' + t.id);
  $('#t-name').textContent = t.name; $('#t-desc').textContent = t.desc; $('#t-how').textContent = t.how; $('#t-model').textContent = t.info;
  $('#st-n-l').textContent = t.unit; $('#st-ms').textContent = '-'; $('#st-fps').textContent = '-'; $('#st-n').textContent = '-';
  $('#results').innerHTML = '<li class="muted">Loading...</li>';
  thr = t.thr; $('#thr-wrap').classList.toggle('hidden', !(t.id === 'detect' || t.id === 'face')); $('#thr').value = thr || 0.4; $('#thr-v').textContent = (+$('#thr').value).toFixed(2);
  if (model) { try { model.close(); } catch (e) { } model = null; }
  task = t; source = 'sample'; mode = 'IMAGE'; buildSources();
  busy('Loading the model... (first time only)');
  try {
    if (!fileset) fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const m = await t.make(fileset, { modelAssetPath: t.model }, 'IMAGE', thr || 0.4);
    if (mine !== runId) { m.close(); return; }
    model = m; busy('');
    await useSource('sample');
  } catch (e) { busy('Could not load this model: ' + (e.message || e)); }
}

function buildSources() {
  const opts = [['sample', 'Sample picture'], ['upload', 'Upload image or video'], ['webcam', 'Webcam']];
  $('#source').innerHTML = opts.map(([k, n]) => `<button data-s="${k}" class="${k === source ? 'on' : ''}">${n}</button>`).join('');
  $('#file-wrap').classList.add('hidden');
}
$('#source').onclick = e => { const b = e.target.closest('button'); if (!b) return; useSource(b.dataset.s); };
$('#file').onchange = e => { const f = e.target.files[0]; if (f) loadFile(f); };
$('#thr').oninput = async e => {
  thr = +e.target.value; $('#thr-v').textContent = thr.toFixed(2);
  if (!model) return;
  try { await model.setOptions(task.id === 'face' ? { minDetectionConfidence: thr } : { scoreThreshold: thr }); } catch (err) { }
  if (mode === 'IMAGE' && media) runOnce();
};

async function useSource(s) {
  stopLoop(); stopStream(); source = s;
  document.querySelectorAll('#source button').forEach(b => b.classList.toggle('on', b.dataset.s === s));
  $('#file-wrap').classList.toggle('hidden', s !== 'upload');
  if (!model) return;
  if (s === 'sample') { await loadImage(task.sample); }
  else if (s === 'upload') { $('#results').innerHTML = '<li class="muted">Choose an image or a video file.</li>'; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  else if (s === 'webcam') await startWebcam();
}

function loadImage(src) {
  return new Promise(res => {
    const img = new Image(); img.onload = async () => { media = img; await setMode('IMAGE'); fit(img.naturalWidth, img.naturalHeight); runOnce(); res(); };
    img.onerror = () => { busy('Could not load the picture.'); res(); }; img.src = src;
  });
}
function loadFile(f) {
  stopLoop(); stopStream(); const url = URL.createObjectURL(f);
  if (f.type.startsWith('video/')) {
    const v = document.createElement('video'); Object.assign(v, { src: url, loop: true, muted: true, playsInline: true });
    v.onloadeddata = async () => { media = v; await setMode('VIDEO'); fit(v.videoWidth, v.videoHeight); await v.play(); startLoop(); };
  } else loadImage(url);
}
async function startWebcam() {
  try {
    busy('Waiting for camera permission...');
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960 } });
    const v = document.createElement('video'); Object.assign(v, { srcObject: stream, muted: true, playsInline: true });
    await v.play(); media = v; await setMode('VIDEO'); fit(v.videoWidth, v.videoHeight); busy(''); startLoop();
  } catch (e) { busy(''); $('#results').innerHTML = `<li class="muted">Could not open the webcam: ${e.message || e}. You can still use the sample picture or upload a file.</li>`; }
}
async function setMode(m) { if (mode !== m && model) { await model.setOptions({ runningMode: m }); mode = m; } }
function stopStream() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } if (media && media.pause) media.pause(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; }

let scale = 1;
function fit(w, h) { scale = Math.min(1, 1280 / w); canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale); }

/* ---------- running ---------- */
function show(r, t0) {
  const st = {};
  ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
  task.draw(r, ctx, scale, du, st);
  const items = task.list(r, st);
  const n = task.count ? task.count(r, st) : items.length;
  $('#st-n').textContent = n;
  $('#results').innerHTML = items.length ? items.slice(0, 8).map(i => `<li><span>${cap(i.label)}</span><b>${pct(i.score)}%</b><div class="bar2"><i style="width:${pct(i.score)}%"></i></div></li>`).join('')
    : '<li class="muted">Nothing found in this frame.</li>';
  const ms = performance.now() - t0; emaMs = emaMs ? emaMs * 0.8 + ms * 0.2 : ms; $('#st-ms').textContent = Math.round(emaMs);
}
function runOnce() {
  if (!model || !media) return;
  const t0 = performance.now();
  try { const r = task.run(model, media, 'IMAGE', 0); show(r, t0); $('#st-fps').textContent = '-'; } catch (e) { $('#results').innerHTML = `<li class="muted">${e.message}</li>`; }
}
function startLoop() {
  stopLoop();
  const step = () => {
    raf = requestAnimationFrame(step);
    if (!model || !media || media.readyState < 2) return;
    let ts = performance.now(); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
    try { const t0 = performance.now(); const r = task.run(model, media, 'VIDEO', ts); show(r, t0); } catch (e) { return; }
    frames++; const now = performance.now(); if (now - tFps >= 1000) { $('#st-fps').textContent = Math.round(frames * 1000 / (now - tFps)); frames = 0; tFps = now; }
  };
  raf = requestAnimationFrame(step);
}

buildTabs();
selectTask(location.hash.slice(1) || 'detect');
window.__lab = { TASKS, get model() { return model; } };      // handy for testing in the console
