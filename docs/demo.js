/* In-browser backend. Same API as the Python server, but everything runs in this page:
   video is decoded by the browser, detectors run in JavaScript, data lives in localStorage.
   Nothing is uploaded anywhere. */
(function () {
  const KEY = 'cvtb:v1';
  const COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'];
  const DEFAULT_RULE = { condition: 'count_gte', count: 1, min_seconds: 3, cooldown_seconds: 30, severity: 'warning', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' };
  const COLORS = ['#2ebeaa', '#3c8cfa', '#faaa3c', '#c85adc', '#5ac85a', '#5050f0'];
  const MODELS = [
    { id: 1, name: 'Motion detector (in browser)', kind: 'motion', path: '', notes: 'Background subtraction in JavaScript. Needs no weights.' },
    { id: 2, name: 'COCO-SSD (in browser, 80 everyday objects)', kind: 'cocossd', path: '', notes: 'TensorFlow.js SSD MobileNet. Loads once, about 14 MB, then runs offline.' },
    { id: 3, name: 'YOLOv8n (in browser, 80 everyday classes)', kind: 'yolo', path: 'models/yolo/yolov8n-416.onnx', names: 'models/yolo/coco-names.json', notes: 'Ultralytics YOLOv8 nano, COCO classes, ONNX at 416 pixels. AGPL-3.0.' },
    { id: 4, name: 'YOLOv8n Open Images (in browser, 601 classes)', kind: 'yolo', path: 'models/yolo/yolov8n-oiv7-416.onnx', names: 'models/yolo/oiv7-names.json', notes: 'Ultralytics YOLOv8 nano trained on Open Images V7. Knows helmets, boats, hats, bottles and many more. AGPL-3.0.' }
  ];
  const FILES = {};            // uploaded videos live in memory only
  const runners = {};
  let S = load();
  if (!S.models) S.models = [];
  const allModels = () => MODELS.concat(S.models);

  /* ---------- storage ---------- */
  function seed() {
    const s = { v: 1, nid: { p: 2, c: 2, a: 3, al: 1 }, projects: [{ id: 1, name: 'Welcome project', description: 'A sample project. Add your own video, webcam or HLS stream and compare detectors on it.', created_at: Date.now() / 1000 }],
      cameras: [{ id: 1, project_id: 1, name: 'Sample footage', source_type: 'sample', source: 'samples/demo', enabled: 1, fps_limit: 8, created_at: Date.now() / 1000 }],
      analytics: [
        { id: 1, camera_id: 1, name: 'Movement in the left area', model_id: 1, conf: 0.4, classes: [], roi: [[0.04, 0.12], [0.62, 0.12], [0.62, 0.95], [0.04, 0.95]], enabled: 1, webhook_url: '', created_at: Date.now() / 1000,
          rule: { ...DEFAULT_RULE, min_seconds: 1, cooldown_seconds: 8, severity: 'critical' } },
        { id: 2, camera_id: 1, name: 'Scene empty for a while', model_id: 1, conf: 0.4, classes: [], roi: [], enabled: 1, webhook_url: '', created_at: Date.now() / 1000,
          rule: { ...DEFAULT_RULE, condition: 'absent', min_seconds: 3, cooldown_seconds: 20, severity: 'info' } }],
      alerts: [] };
    return s;
  }
  /* Ready-made examples that mirror the areas in my applied computer vision repositories.
     They use open YOLO models and CC BY 4.0 sample footage, so they show the idea, not my client models. */
  function addPresets() {
    if (S.presets === 2) return;
    const t = Date.now() / 1000, rule = (o) => ({ ...DEFAULT_RULE, ...o });
    const mk = (name, description, camName, sample, an) => {
      const p = { id: nid('p'), name, description, created_at: t }; S.projects.push(p);
      const c = { id: nid('c'), project_id: p.id, name: camName, source_type: 'sample', source: 'samples/' + sample, enabled: 0, fps_limit: 4, created_at: t }; S.cameras.push(c);
      an.forEach(a => S.analytics.push({ id: nid('a'), camera_id: c.id, enabled: 1, webhook_url: '', created_at: t, classes: [], roi: [], ...a, rule: rule(a.rule) }));
    };
    mk('Example: Workplace safety', 'Raise an alert when a person walks into a marked floor zone. Press Start on the camera. The detector is YOLOv8n from Ultralytics. Checking hard hats needs a dedicated PPE model, which the server version can load.',
      'Warehouse floor', 'safety', [{ name: 'Person in the marked zone', model_id: 3, conf: 0.35, classes: ['person'], roi: [[0.06, 0.34], [0.58, 0.2], [0.93, 0.58], [0.5, 0.98], [0.02, 0.8]], rule: { min_seconds: 1, cooldown_seconds: 8, severity: 'critical' } }]);
    mk('Example: Traffic', 'Warn when the road is busy: two or more vehicles in view for a couple of seconds. Cars, trucks, buses and motorbikes are counted.',
      'Road from above', 'traffic', [{ name: 'Busy road', model_id: 3, conf: 0.3, classes: ['car', 'truck', 'bus', 'motorcycle'], rule: { count: 2, min_seconds: 2, cooldown_seconds: 10, severity: 'warning' } }]);
    mk('Example: Retail', 'Notice a customer who stays in an aisle. An info alert fires when a person is in the aisle for several seconds.',
      'Shop aisle', 'retail', [{ name: 'Customer in the aisle', model_id: 3, conf: 0.3, classes: ['person'], rule: { min_seconds: 3, cooldown_seconds: 15, severity: 'info' } }]);
    mk('Example: Sorting and counting', 'Count items on a table. This one counts bottles, the same idea as counting recyclables or products on a line.',
      'Table', 'bottles', [{ name: 'Two or more bottles', model_id: 3, conf: 0.3, classes: ['bottle'], rule: { count: 2, min_seconds: 1, cooldown_seconds: 10, severity: 'info' } }]);
    S.presets = 2; save();
  }

  function load() { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return s; } catch (e) { } return seed(); }
  function save() {
    for (let i = 0; i < 4; i++) {
      try { localStorage.setItem(KEY, JSON.stringify(S)); return; } catch (e) { S.alerts = S.alerts.slice(-Math.max(5, 40 >> i)); }
    }
  }
  const nid = k => S.nid[k]++;
  const find = (arr, id) => arr.find(x => x.id === id);
  const err = (m, code) => Object.assign(new Error(m), { code });

  /* ---------- rules (port of app/rules.py) ---------- */
  const hm = (v, d) => { const m = /^(\d+):(\d+)$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : d; };
  function inSchedule(rule, now) {
    const day = (now.getDay() + 6) % 7;
    if (!(rule.days || [0, 1, 2, 3, 4, 5, 6]).includes(day)) return false;
    const s = hm(rule.start, 0), e = hm(rule.end, 1439), m = now.getHours() * 60 + now.getMinutes();
    return s <= e ? (m >= s && m <= e) : (m >= s || m <= e);
  }
  class RuleState {
    constructor() { this.since = null; this.last = null; }
    update(rule, count, ts, now) {
      rule = { ...DEFAULT_RULE, ...(rule || {}) };
      if (!inSchedule(rule, now)) { this.since = null; return null; }
      const holds = rule.condition === 'absent' ? count === 0 : count >= Math.max(1, +rule.count || 1);
      if (!holds) { this.since = null; return null; }
      if (this.since === null) this.since = ts;
      const held = ts - this.since;
      if (held < +rule.min_seconds) return null;
      if (this.last !== null && ts - this.last < +rule.cooldown_seconds) return null;
      this.last = ts;
      return { message: rule.condition === 'absent' ? `Nothing detected for ${Math.round(held)}s` : `${count} object(s) present for ${Math.round(held)}s`, severity: rule.severity, held: Math.round(held * 10) / 10 };
    }
  }

  /* ---------- detectors ---------- */
  class Motion {
    constructor() { this.bg = null; this.warm = 0; this.c = document.createElement('canvas'); this.g = this.c.getContext('2d', { willReadFrequently: true }); }
    detect(src, w, h, conf) {
      const sw = 160, sh = Math.max(1, Math.round(h * sw / w));
      this.c.width = sw; this.c.height = sh; this.g.drawImage(src, 0, 0, sw, sh);
      const d = this.g.getImageData(0, 0, sw, sh).data, n = sw * sh, gray = new Float32Array(n);
      for (let i = 0; i < n; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      if (!this.bg) { this.bg = gray.slice(); return []; }
      let mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) { mask[i] = Math.abs(gray[i] - this.bg[i]) > 26 ? 1 : 0; this.bg[i] = this.bg[i] * 0.9 + gray[i] * 0.1; }
      const dil = new Uint8Array(n);                              // 3x3 dilation joins the pieces of one object
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (mask[y * sw + x]) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < sh && xx >= 0 && xx < sw) dil[yy * sw + xx] = 1; }
      if (++this.warm < 8) return [];
      const seen = new Uint8Array(n), out = [], sx = w / sw, sy = h / sh;
      for (let i = 0; i < n; i++) {
        if (!dil[i] || seen[i]) continue;
        let stack = [i], area = 0, x1 = sw, y1 = sh, x2 = 0, y2 = 0; seen[i] = 1;
        while (stack.length) {
          const p = stack.pop(), px = p % sw, py = (p / sw) | 0; area++;
          if (px < x1) x1 = px; if (px > x2) x2 = px; if (py < y1) y1 = py; if (py > y2) y2 = py;
          for (const q of [p - 1, p + 1, p - sw, p + sw]) if (q >= 0 && q < n && dil[q] && !seen[q] && Math.abs((q % sw) - px) <= 1) { seen[q] = 1; stack.push(q); }
        }
        if (area < 0.004 * n) continue;
        const score = Math.min(1, 0.4 + area / (0.05 * n));
        if (score < conf) continue;
        out.push({ label: 'motion', conf: Math.round(score * 100) / 100, box: [x1 * sx, y1 * sy, (x2 + 1) * sx, (y2 + 1) * sy] });
      }
      return out;
    }
  }
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  let cocoPromise = null;
  function loadCoco() {
    if (!cocoPromise) cocoPromise = (async () => {
      await loadScript('vendor/tf.min.js'); await loadScript('vendor/coco-ssd.min.js');
      return window.cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: new URL('models/coco-ssd/model.json', location.href).href });
    })();
    return cocoPromise;
  }
  class Coco {
    constructor() { this.model = null; this.error = null; loadCoco().then(m => this.model = m).catch(e => { this.error = e.message; cocoPromise = null; }); }
    async detect(src, w, h, conf) {
      if (this.error) throw new Error(this.error);
      if (!this.model) return [];                                 // still loading
      const r = await this.model.detect(src, 20, conf);
      return r.map(o => ({ label: o.class, conf: Math.round(o.score * 100) / 100, box: [o.bbox[0], o.bbox[1], o.bbox[0] + o.bbox[2], o.bbox[1] + o.bbox[3]] }));
    }
    get loading() { return !this.model && !this.error; }
  }

  /* ---------- models uploaded by the visitor: stored in this browser only (IndexedDB) ---------- */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('cvtb-models', 1); r.onupgradeneeded = () => r.result.createObjectStore('m', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbDo = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('m', mode), req = fn(tx.objectStore('m')); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); }); };
  const idbPut = rec => idbDo('readwrite', s => s.put(rec));
  const idbGet = id => idbDo('readonly', s => s.get(id));
  const idbDel = id => idbDo('readwrite', s => s.delete(id));
  function readMeta(buf) {                                        // Ultralytics writes class names and image size into the ONNX metadata
    const u8 = new Uint8Array(buf), txt = new TextDecoder('latin1').decode(u8.subarray(Math.max(0, u8.length - 400000)));
    const out = { names: null, imgsz: null };
    const nm = /names[^{]{0,8}(\{[^}]*\})/.exec(txt);
    if (nm) { const arr = []; for (const m of nm[1].matchAll(/(\d+):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) arr[+m[1]] = m[2] ?? m[3]; if (arr.length && arr.every(x => x !== undefined)) out.names = arr; }
    const sz = /imgsz[^\[]{0,8}\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(txt);
    if (sz) out.imgsz = [+sz[1], +sz[2]];
    return out;
  }
  function layoutOf(dims, nNames) {                               // which YOLO export format is this?
    if (dims.length !== 3) return null;
    const [, a, b] = dims;
    if (b === 6 && a !== 6) return { layout: 'v10', nc: null };                       // YOLOv10: rows of x1 y1 x2 y2 score class
    if (a < b) return { layout: 'v8', nc: a - 4 };                                    // YOLOv8 and YOLO11: [1, 4 + classes, anchors]
    if (nNames && b - 5 === nNames) return { layout: 'v5', nc: b - 5 };               // YOLOv5: [1, anchors, 5 + classes]
    return { layout: 'v8t', nc: b - 4 };
  }

  /* YOLO through onnxruntime-web (WebAssembly). Supports YOLOv5u/v8/v11 and YOLOv10 exports. */
  let ortPromise = null;
  function loadOrt() {
    if (!ortPromise) ortPromise = (async () => {
      await loadScript('vendor/ort/ort.wasm.min.js');
      window.ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
      window.ort.env.wasm.numThreads = 1;                    // GitHub Pages cannot send the headers that threads need
      return window.ort;
    })();
    return ortPromise;
  }
  const sessions = {};
  class Yolo {
    constructor(model) {
      this.model = model; this.size = model.size || 416; this.error = null; this.session = null; this.names = null; this.layout = model.layout || 'v8';
      this.c = document.createElement('canvas'); this.c.width = this.c.height = this.size; this.g = this.c.getContext('2d', { willReadFrequently: true });
      const key = model.custom ? 'c' + model.id : model.path;
      if (!sessions[key]) sessions[key] = (async () => {
        const ort = await loadOrt();
        if (model.custom) {
          const rec = await idbGet(model.id);
          if (!rec) throw new Error('The model file is no longer stored in this browser. Upload it again on the Models page.');
          return { s: await ort.InferenceSession.create(new Uint8Array(rec.buf), { executionProviders: ['wasm'] }), names: model.names };
        }
        const [s, names] = await Promise.all([ort.InferenceSession.create(model.path, { executionProviders: ['wasm'] }), fetch(model.names).then(r => r.json())]);
        return { s, names };
      })();
      sessions[key].then(x => { this.session = x.s; this.names = x.names; }).catch(e => { this.error = e.message || String(e); delete sessions[key]; });
    }
    get loading() { return !this.session && !this.error; }
    async detect(src, w, h, conf) {
      if (this.error) throw new Error(this.error);
      if (!this.session) return [];
      const S = this.size, k = Math.min(S / w, S / h), nw = Math.round(w * k), nh = Math.round(h * k), dx = (S - nw) / 2, dy = (S - nh) / 2;
      this.g.fillStyle = '#727272'; this.g.fillRect(0, 0, S, S); this.g.drawImage(src, dx, dy, nw, nh);
      const px = this.g.getImageData(0, 0, S, S).data, area = S * S, input = new Float32Array(3 * area);
      for (let i = 0; i < area; i++) { input[i] = px[i * 4] / 255; input[area + i] = px[i * 4 + 1] / 255; input[2 * area + i] = px[i * 4 + 2] / 255; }
      const out = await this.session.run({ [this.session.inputNames[0]]: new window.ort.Tensor('float32', input, [1, 3, S, S]) });
      const t = out[this.session.outputNames[0]], d = t.data, cand = [], name = c => this.names[c] ?? 'class ' + c;
      const toBox = (x1, y1, x2, y2) => [(x1 - dx) / k, (y1 - dy) / k, (x2 - dx) / k, (y2 - dy) / k];
      if (this.layout === 'v10') {                              // already NMS-free
        for (let i = 0; i < t.dims[1]; i++) { const r = d.subarray(i * 6, i * 6 + 6); if (r[4] >= conf) cand.push({ label: name(r[5] | 0), cls: r[5] | 0, conf: Math.round(r[4] * 100) / 100, box: toBox(r[0], r[1], r[2], r[3]) }); }
        return cand.map(({ cls, ...rest }) => rest);
      }
      const transposed = this.layout === 'v8', N = transposed ? t.dims[2] : t.dims[1], C = transposed ? t.dims[1] : t.dims[2];
      const at = (i, c) => transposed ? d[c * N + i] : d[i * C + c], off = this.layout === 'v5' ? 5 : 4, nc = C - off;
      for (let i = 0; i < N; i++) {
        const obj = this.layout === 'v5' ? at(i, 4) : 1; if (obj < conf * 0.5) continue;
        let best = 0, bs = 0;
        for (let c = 0; c < nc; c++) { const v = at(i, off + c); if (v > bs) { bs = v; best = c; } }
        bs *= obj; if (bs < conf) continue;
        const cx = at(i, 0), cy = at(i, 1), bw = at(i, 2), bh = at(i, 3);
        cand.push({ label: name(best), cls: best, conf: Math.round(bs * 100) / 100, box: toBox(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2) });
      }
      cand.sort((a, b) => b.conf - a.conf);
      const keep = [];
      for (const c of cand) {                                 // greedy non-maximum suppression, per class
        if (keep.length >= 60) break;
        if (keep.every(o => o.cls !== c.cls || iou(o.box, c.box) < 0.45)) keep.push(c);
      }
      return keep.map(({ cls, ...rest }) => rest);
    }
  }
  function iou(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return u > 0 ? inter / u : 0;
  }

  function inside(box, poly, w, h) {
    if (!poly || poly.length < 3) return true;
    const cx = (box[0] + box[2]) / 2 / w, cy = (box[1] + box[3]) / 2 / h; let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > cy) !== (yj > cy) && cx < (xj - xi) * (cy - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  /* ---------- one runner per camera ---------- */
  class Runner {
    constructor(cam) {
      this.cam = cam; this.id = cam.id; this.status = 'connecting'; this.message = ''; this.fps_in = 0; this.fps_out = 0; this.size = null;
      this.out = document.createElement('canvas'); this.out.width = 960; this.out.height = 540;
      this.work = document.createElement('canvas'); this.wg = this.work.getContext('2d', { willReadFrequently: true });
      this.raw = null; this.analytics = []; this.reloadFlag = true; this.stopped = false; this.frames = 0; this.t0 = performance.now(); this.outN = 0;
      this.video = document.createElement('video'); Object.assign(this.video, { muted: true, playsInline: true, loop: true, crossOrigin: 'anonymous' });
      this.drawStatus('Starting...');
    }
    drawStatus(text) {
      const g = this.out.getContext('2d'); this.out.width = 960; this.out.height = 540; g.fillStyle = '#12181e'; g.fillRect(0, 0, 960, 540);
      g.fillStyle = '#b8c4cc'; g.font = '26px system-ui'; g.textAlign = 'center'; g.fillText(text, 480, 276); g.textAlign = 'left';
    }
    async start() {
      const c = this.cam, v = this.video;
      try {
        if (c.source_type === 'rtsp') throw new Error('Browsers cannot open RTSP. Run the server version, or republish the stream as HLS (for example with MediaMTX) and add the .m3u8 link here.');
        if (c.source_type === 'sample') { const base = /^samples\//.test(c.source) ? c.source : 'samples/demo'; v.src = base + (v.canPlayType('video/webm; codecs="vp9"') ? '.webm' : '.mp4'); }
        else if (c.source_type === 'file') { if (!FILES[c.id]) throw new Error('Browsers do not keep uploaded files between visits. Edit the camera and choose the file again.'); v.src = URL.createObjectURL(FILES[c.id]); }
        else if (c.source_type === 'webcam') { v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 } }); v.loop = false; }
        else if (c.source_type === 'url') {
          if (/\.m3u8(\?|$)/i.test(c.source)) {
            if (!window.Hls) await loadScript('vendor/hls.min.js');
            if (window.Hls && window.Hls.isSupported()) { this.hls = new window.Hls(); this.hls.loadSource(c.source); this.hls.attachMedia(v); v.loop = false; }
            else v.src = c.source;
          } else v.src = c.source;
        }
        await v.play();
        this.status = 'live'; this.message = '';
        if (v.requestVideoFrameCallback) { const cb = () => { this.frames++; if (!this.stopped) v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
        this.loop();
      } catch (e) { this.status = 'error'; this.message = e.message || String(e); this.drawStatus(this.message.length > 70 ? this.message.slice(0, 67) + '...' : this.message); }
    }
    stop() {
      this.stopped = true; this.status = 'stopped'; try { this.video.pause(); } catch (e) { }
      if (this.video.srcObject) this.video.srcObject.getTracks().forEach(t => t.stop());
      if (this.hls) this.hls.destroy(); this.drawStatus('Stopped. Press Start.');
    }
    loop() {
      if (this.stopped) return;
      const t = performance.now();
      this.step().catch(e => { this.message = 'Processing error: ' + e.message; }).finally(() => {
        const wait = Math.max(0, 1000 / Math.max(0.5, +this.cam.fps_limit || 5) - (performance.now() - t));
        this.timer = setTimeout(() => this.loop(), wait);
      });
    }
    loadAnalytics() {
      this.analytics = S.analytics.filter(a => a.camera_id === this.id && a.enabled).map((row, i) => {
        const model = find(allModels(), row.model_id);
        const a = { row, color: COLORS[i % COLORS.length], state: new RuleState(), rule: row.rule, classes: row.classes.map(x => x.toLowerCase()), count: 0, infer_ms: 0, total: 0, labels: {}, history: [], dets: [], error: null, det: null };
        try { if (!model) throw new Error('Model was deleted'); a.det = model.kind === 'cocossd' ? new Coco() : model.kind === 'yolo' ? new Yolo(model) : new Motion(); } catch (e) { a.error = e.message; }
        return a;
      });
      this.reloadFlag = false;
    }
    async step() {
      const v = this.video;
      if (v.readyState < 2 || !v.videoWidth) return;
      if (this.reloadFlag) this.loadAnalytics();
      const scale = Math.min(1, 640 / v.videoWidth), w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      this.work.width = w; this.work.height = h; this.wg.drawImage(v, 0, 0, w, h); this.size = [v.videoWidth, v.videoHeight];
      this.raw = this.work.toDataURL('image/jpeg', 0.7);
      const now = Date.now() / 1000, date = new Date();
      for (const a of this.analytics) {
        if (!a.det) continue;
        const t = performance.now(); let dets = [];
        try { dets = await a.det.detect(this.work, w, h, +a.row.conf); a.error = null; } catch (e) { a.error = e.message; }
        a.infer_ms = performance.now() - t;
        a.loading = a.det.loading;
        dets = dets.filter(d => (!a.classes.length || a.classes.includes(d.label.toLowerCase())) && inside(d.box, a.row.roi, w, h));
        a.dets = dets; a.count = dets.length; a.total += dets.length; a.labels = {};
        dets.forEach(d => a.labels[d.label] = (a.labels[d.label] || 0) + 1);
        a.history.push([now, a.count, a.infer_ms]); if (a.history.length > 180) a.history.shift();
      }
      this.draw(w, h);
      for (const a of this.analytics) {
        if (!a.det) continue;
        const fired = a.state.update(a.rule, a.count, now, date);
        if (fired) this.alert(a, fired);
      }
      this.outN++;
      const el = (performance.now() - this.t0) / 1000;
      if (el >= 2) { this.fps_out = this.outN / el; this.fps_in = this.frames / el; this.outN = 0; this.frames = 0; this.t0 = performance.now(); }
    }
    draw(w, h) {
      this.out.width = w; this.out.height = h; const g = this.out.getContext('2d'); g.drawImage(this.work, 0, 0);
      g.lineWidth = 2; g.font = '13px system-ui';
      for (const a of this.analytics) {
        const roi = a.row.roi;
        if (roi && roi.length >= 3) {
          g.beginPath(); roi.forEach((p, i) => i ? g.lineTo(p[0] * w, p[1] * h) : g.moveTo(p[0] * w, p[1] * h)); g.closePath();
          g.globalAlpha = 0.12; g.fillStyle = a.color; g.fill(); g.globalAlpha = 1; g.strokeStyle = a.color; g.stroke();
        }
        for (const d of a.dets) {
          const [x1, y1, x2, y2] = d.box; g.strokeStyle = a.color; g.strokeRect(x1, y1, x2 - x1, y2 - y1);
          const text = `${d.label} ${d.conf.toFixed(2)}`, tw = g.measureText(text).width;
          g.fillStyle = a.color; g.fillRect(x1, Math.max(0, y1 - 18), tw + 8, 18); g.fillStyle = '#0d1115'; g.fillText(text, x1 + 4, Math.max(13, y1 - 5));
        }
        if (a.loading) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 0, w, 24); g.fillStyle = '#fff'; g.fillText('Loading the COCO-SSD model (first time only)...', 8, 16); }
      }
      g.fillStyle = '#fff'; g.font = '12px system-ui'; g.fillText(new Date().toLocaleString(), 8, h - 8);
    }
    alert(a, fired) {
      const small = document.createElement('canvas'); small.width = 320; small.height = Math.round(320 * this.out.height / this.out.width);
      small.getContext('2d').drawImage(this.out, 0, 0, small.width, small.height);
      const detail = { analytic: a.row.name, count: a.count, labels: { ...a.labels }, held: fired.held };
      const al = { id: nid('al'), project_id: this.cam.project_id, camera_id: this.id, analytics_id: a.row.id, created_at: Date.now() / 1000, severity: fired.severity, message: `${a.row.name}: ${fired.message}`, snapshot: small.toDataURL('image/jpeg', 0.6), acked: 0, detail };
      S.alerts.push(al); if (S.alerts.length > 200) S.alerts.shift(); save();
      if ((a.row.webhook_url || '').trim()) fetch(a.row.webhook_url, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ alert_id: al.id, camera: this.cam.name, ...detail, message: fired.message, severity: fired.severity, time: new Date().toISOString() }) }).catch(() => { });
    }
    public() {
      return { id: this.id, status: this.status, message: this.message, fps_in: +this.fps_in.toFixed(1), fps_out: +this.fps_out.toFixed(1), size: this.size,
        analytics: this.analytics.map(a => ({ id: a.row.id, name: a.row.name, count: a.count, infer_ms: +a.infer_ms.toFixed(1), total: a.total, labels: a.labels, error: a.error, history: a.history.map(h => [+(h[0] % 100000).toFixed(1), h[1], +h[2].toFixed(1)]) })) };
    }
  }

  function startRunner(id) {
    const cam = find(S.cameras, id); if (!cam) return null;
    if (runners[id]) { clearTimeout(runners[id].timer); runners[id].stop(); }
    const r = runners[id] = new Runner(cam); cam.enabled = 1; save(); r.start(); return r;
  }
  function stopRunner(id) { const r = runners[id]; if (r) { clearTimeout(r.timer); r.stop(); delete runners[id]; } const c = find(S.cameras, id); if (c) { c.enabled = 0; save(); } }

  /* ---------- views ---------- */
  const cameraView = c => {
    const r = runners[c.id];
    return { ...c, runtime: r ? r.public() : { status: 'stopped', message: '', fps_in: 0, fps_out: 0, size: null, analytics: [] },
      analytics_count: S.analytics.filter(a => a.camera_id === c.id).length, alerts_open: S.alerts.filter(a => a.camera_id === c.id && !a.acked).length };
  };
  const modelList = () => allModels().map(m => ({ ...m, names: undefined, builtin: !m.custom, exists: true, in_use: S.analytics.filter(a => a.model_id === m.id).length }));
  function checkAnalytic(b) {
    if (!(b.name || '').trim()) throw err('Name is required', 400);
    if (!find(allModels(), b.model_id)) throw err('Model not found', 404);
    if (!(b.conf > 0 && b.conf <= 1)) throw err('Confidence must be between 0 and 1', 400);
    if (b.roi && b.roi.length && b.roi.length < 3) throw err('A zone needs at least 3 points', 400);
  }
  const reload = cid => { const r = runners[cid]; if (r) r.reloadFlag = true; };

  /* ---------- router ---------- */
  const routes = [];
  const R = (method, re, fn) => routes.push([method, new RegExp('^' + re + '$'), fn]);
  R('GET', '/health', () => ({ ok: true, mode: 'demo' }));
  R('GET', '/projects', () => [...S.projects].reverse().map(p => {
    const cams = S.cameras.filter(c => c.project_id === p.id);
    return { ...p, cameras: cams.length, live: cams.filter(c => runners[c.id] && runners[c.id].status === 'live').length, alerts_open: S.alerts.filter(a => a.project_id === p.id && !a.acked).length };
  }));
  R('POST', '/projects', (m, o) => { if (!(o.json.name || '').trim()) throw err('Name is required', 400); const p = { id: nid('p'), name: o.json.name.trim(), description: o.json.description || '', created_at: Date.now() / 1000 }; S.projects.push(p); save(); return p; });
  R('PUT', '/projects/(\\d+)', (m, o) => { const p = find(S.projects, +m[1]); if (!p) throw err('Project not found', 404); p.name = o.json.name.trim(); p.description = o.json.description || ''; save(); return p; });
  R('DELETE', '/projects/(\\d+)', m => { S.cameras.filter(c => c.project_id === +m[1]).forEach(c => delCamera(c.id)); S.alerts = S.alerts.filter(a => a.project_id !== +m[1]); S.projects = S.projects.filter(p => p.id !== +m[1]); save(); return { ok: true }; });
  R('GET', '/projects/(\\d+)/cameras', m => S.cameras.filter(c => c.project_id === +m[1]).map(cameraView));
  R('GET', '/cameras/(\\d+)', m => { const c = find(S.cameras, +m[1]); if (!c) throw err('Camera not found', 404); return cameraView(c); });
  R('POST', '/projects/(\\d+)/cameras', (m, o) => {
    const b = o.json; if (!find(S.projects, +m[1])) throw err('Project not found', 404);
    if (!['rtsp', 'url', 'webcam', 'sample'].includes(b.source_type)) throw err('Unsupported source type', 400);
    if (b.source_type === 'rtsp' && !/^rtsps?:\/\//i.test(b.source || '')) throw err('Use an rtsp:// URL', 400);
    if (b.source_type === 'url' && !/^https?:\/\//i.test(b.source || '')) throw err('Use an http(s) link to a video or an .m3u8 playlist', 400);
    const c = { id: nid('c'), project_id: +m[1], name: (b.name || 'Camera').trim(), source_type: b.source_type, source: b.source || (b.source_type === 'sample' ? 'samples/demo' : 'webcam'), enabled: 0, fps_limit: +b.fps_limit || 5, created_at: Date.now() / 1000 };
    S.cameras.push(c); save(); return cameraView(c);
  });
  R('POST', '/projects/(\\d+)/cameras/upload', (m, o) => {
    const f = o.form.get('file'); if (!f || !f.name) throw err('Choose a video file', 400);
    const c = { id: nid('c'), project_id: +m[1], name: (o.form.get('name') || 'Camera').trim(), source_type: 'file', source: f.name, enabled: 0, fps_limit: +o.form.get('fps_limit') || 5, created_at: Date.now() / 1000 };
    FILES[c.id] = f; S.cameras.push(c); save(); return cameraView(c);
  });
  R('PUT', '/cameras/(\\d+)', (m, o) => { const c = find(S.cameras, +m[1]); if (!c) throw err('Camera not found', 404); Object.assign(c, { name: o.json.name.trim(), fps_limit: +o.json.fps_limit || 5 }); if (o.json.file) { FILES[c.id] = o.json.file; c.source = o.json.file.name; } if (c.source_type === 'rtsp' || c.source_type === 'url') c.source = o.json.source.trim(); save(); if (runners[c.id]) startRunner(c.id); return cameraView(c); });
  function delCamera(id) { stopRunner(id); delete FILES[id]; S.analytics = S.analytics.filter(a => a.camera_id !== id); S.alerts = S.alerts.filter(a => a.camera_id !== id); S.cameras = S.cameras.filter(c => c.id !== id); }
  R('DELETE', '/cameras/(\\d+)', m => { delCamera(+m[1]); save(); return { ok: true }; });
  R('POST', '/cameras/(\\d+)/start', m => { if (!startRunner(+m[1])) throw err('Camera not found', 404); return cameraView(find(S.cameras, +m[1])); });
  R('POST', '/cameras/(\\d+)/stop', m => { stopRunner(+m[1]); return cameraView(find(S.cameras, +m[1])); });
  R('GET', '/cameras/(\\d+)/status', m => cameraView(find(S.cameras, +m[1])).runtime);
  R('POST', '/test-source', (m, o) => ({ ok: false, message: /^rtsp/i.test(o.json.url) ? 'Browsers cannot open RTSP. Use the server version, or republish the stream as HLS and add the .m3u8 link.' : 'Connection tests need the server version. Add the camera and press Start to try it.' }));
  R('GET', '/models', () => modelList());
  R('POST', '/models', () => { throw err('Your own weights need the server version. This hosted demo runs in the browser, so it can only use the built-in models.', 400); });
  R('POST', '/models/upload', async (m, o) => {
    const f = o.form.get('file'); if (!f || !f.name) throw err('Choose an .onnx file', 400);
    if (/\.(pt|pth|engine|torchscript)$/i.test(f.name)) throw err('A browser cannot run ' + f.name.split('.').pop() + ' files. Export to ONNX first: yolo export model=best.pt format=onnx imgsz=640', 400);
    if (!/\.onnx$/i.test(f.name)) throw err('Upload an .onnx file', 400);
    if (f.size > 300e6) throw err('That file is larger than 300 MB, which is too big for a browser', 400);
    const buf = await f.arrayBuffer(), meta = readMeta(buf);
    let names = meta.names; const typed = (o.form.get('names') || '').split(',').map(x => x.trim()).filter(Boolean);
    if (typed.length) names = typed;
    const size = meta.imgsz ? Math.max(meta.imgsz[0], meta.imgsz[1]) : 640;
    let info;
    try {                                                     // load it and run one blank frame to learn the output format
      const ort = await loadOrt(), s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] });
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]) });
      info = layoutOf(out[s.outputNames[0]].dims, names ? names.length : 0);
    } catch (e) { throw err('Could not run this model: ' + (e.message || e) + '. Export a fixed square size, for example imgsz=640.', 400); }
    if (!info) throw err('This does not look like a YOLO detection model (unexpected output shape).', 400);
    if (!names) names = Array.from({ length: info.nc || 80 }, (_, i) => 'class ' + i);
    S.nid.m = S.nid.m || 1; const id = 100 + S.nid.m++, md = { id, name: (o.form.get('name') || f.name.replace(/\.onnx$/i, '')).trim(), kind: 'yolo', custom: true, notes: (o.form.get('notes') || '') + (meta.names ? '' : ' (no class names found in the file)'), names, size, layout: info.layout, bytes: f.size };
    await idbPut({ id, buf }); S.models.push(md); save(); return { ...md, builtin: false };
  });
  R('DELETE', '/models/(\\d+)', async m => {
    const md = find(S.models, +m[1]); if (!md) throw err('The built-in models cannot be removed', 400);
    if (S.analytics.some(a => a.model_id === md.id)) throw err('This model is used by an analytic. Remove or change that analytic first', 400);
    await idbDel(md.id); delete sessions['c' + md.id]; S.models = S.models.filter(x => x.id !== md.id); save(); return { ok: true };
  });
  R('GET', '/models/(\\d+)/classes', m => { const md = find(allModels(), +m[1]); if (!md) throw err('Model not found', 404); if (md.kind === 'motion') return ['motion']; if (md.kind === 'yolo') return md.custom ? md.names : fetch(md.names).then(r => r.json()); return COCO; });
  R('GET', '/default-rule', () => DEFAULT_RULE);
  const av = a => ({ ...a, enabled: !!a.enabled, rule: { ...DEFAULT_RULE, ...a.rule } });
  R('GET', '/cameras/(\\d+)/analytics', m => S.analytics.filter(a => a.camera_id === +m[1]).map(av));
  R('POST', '/cameras/(\\d+)/analytics', (m, o) => { checkAnalytic(o.json); const b = o.json, a = { id: nid('a'), camera_id: +m[1], name: b.name.trim(), model_id: b.model_id, conf: b.conf, classes: b.classes || [], roi: b.roi || [], enabled: b.enabled ? 1 : 0, rule: { ...DEFAULT_RULE, ...(b.rule || {}) }, webhook_url: b.webhook_url || '', created_at: Date.now() / 1000 }; S.analytics.push(a); save(); reload(+m[1]); return av(a); });
  R('PUT', '/analytics/(\\d+)', (m, o) => { const a = find(S.analytics, +m[1]); if (!a) throw err('Analytic not found', 404); checkAnalytic(o.json); const b = o.json; Object.assign(a, { name: b.name.trim(), model_id: b.model_id, conf: b.conf, classes: b.classes || [], roi: b.roi || [], enabled: b.enabled ? 1 : 0, rule: { ...DEFAULT_RULE, ...(b.rule || {}) }, webhook_url: b.webhook_url || '' }); save(); reload(a.camera_id); return av(a); });
  R('DELETE', '/analytics/(\\d+)', m => { const a = find(S.analytics, +m[1]); if (a) { S.analytics = S.analytics.filter(x => x.id !== a.id); save(); reload(a.camera_id); } return { ok: true }; });
  R('GET', '/alerts', (m, o) => {
    const q = o.query; let rows = S.alerts.filter(a => a.id > (+q.since_id || 0));
    if (q.project_id) rows = rows.filter(a => a.project_id === +q.project_id);
    if (q.camera_id) rows = rows.filter(a => a.camera_id === +q.camera_id);
    if (q.open_only === 'true') rows = rows.filter(a => !a.acked);
    return rows.slice().reverse().slice(0, +q.limit || 100).map(({ snapshot, ...a }) => ({ ...a, camera_name: (find(S.cameras, a.camera_id) || {}).name }));
  });
  R('POST', '/alerts/(\\d+)/ack', m => { const a = find(S.alerts, +m[1]); if (a) a.acked = 1; save(); return { ok: true }; });
  R('POST', '/projects/(\\d+)/alerts/ack-all', m => { S.alerts.forEach(a => { if (a.project_id === +m[1]) a.acked = 1; }); save(); return { ok: true }; });
  R('DELETE', '/projects/(\\d+)/alerts', m => { S.alerts = S.alerts.filter(a => a.project_id !== +m[1]); save(); return { ok: true }; });

  async function call(method, path, o = {}) {
    const [p, qs] = path.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
    for (const [mt, re, fn] of routes) { const m = re.exec(p); if (mt === method && m) return JSON.parse(JSON.stringify(await fn(m, { ...o, query }))); }
    throw err('Not found: ' + method + ' ' + p, 404);
  }

  /* ---------- live canvases ---------- */
  function paint() {
    document.querySelectorAll('canvas.livecv').forEach(cv => {
      const r = runners[+cv.dataset.cam], g = cv.getContext('2d');
      if (r) { if (cv.width !== r.out.width || cv.height !== r.out.height) { cv.width = r.out.width; cv.height = r.out.height; } g.drawImage(r.out, 0, 0); }
      else { cv.width = 960; cv.height = 540; g.fillStyle = '#12181e'; g.fillRect(0, 0, 960, 540); g.fillStyle = '#b8c4cc'; g.font = '26px system-ui'; g.textAlign = 'center'; g.fillText('Stopped. Press Start.', 480, 276); }
    });
    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);

  addPresets();
  S.cameras.forEach(c => { if (c.enabled && c.source_type !== 'file' && c.source_type !== 'webcam') startRunner(c.id); });
  window.DemoBackend = {
    call,
    rawFrame: id => (runners[id] && runners[id].raw) || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#12181e"/><text x="480" y="276" fill="#b8c4cc" font-family="sans-serif" font-size="26" text-anchor="middle">Start the camera to draw a zone on a live frame</text></svg>'),
    alertImg: id => (find(S.alerts, id) || {}).snapshot || '',
    reset: () => { localStorage.removeItem(KEY); location.reload(); }
  };
})();
