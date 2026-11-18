/* CV Test Bench front end. Plain JavaScript, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view'), modal = $('#modal');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let timer = null, lastAlertId = 0, models = [];
let MODE = 'server';                      // 'server' (Python backend) or 'demo' (everything in the browser)
const REPO = 'https://github.com/mh-masum6875/cv-test-bench';
const loadScript = src => new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(el); });
const TYPE_LABEL = { rtsp: 'RTSP', file: 'Video', sample: 'Sample', webcam: 'Webcam', url: 'Link' };
const srcText = c => c.source_type === 'rtsp' || c.source_type === 'url' ? c.source.replace(/\/\/[^@/]*@/, '//***@') : c.source_type === 'webcam' ? 'This computer\'s webcam' : c.source.split('/').pop();
const liveTag = (id, running, name = 'Live view') => MODE === 'demo'
  ? `<canvas class="livecv" id="live" data-cam="${id}" width="960" height="540" aria-label="${esc(name)}"></canvas>`
  : `<img id="live" alt="${esc(name)}" src="api/cameras/${id}/${running ? 'stream' : 'snapshot.jpg'}">`;
const alertImg = id => MODE === 'demo' ? window.DemoBackend.alertImg(id) : `api/alerts/${id}/snapshot.jpg`;

async function api(path, opts = {}) {
  if (MODE === 'demo') {
    try { return await window.DemoBackend.call(opts.method || 'GET', path, { json: opts.json, form: opts.form }); }
    catch (e) { throw e; }
  }
  const o = { method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.json); }
  if (opts.form) o.body = opts.form;
  const r = await fetch('api' + path, o);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (e) { }
    throw new Error(msg);
  }
  return r.json();
}
const ago = t => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(t * 1000).toLocaleDateString();
};
const chip = st => `<span class="chip ${st}">${st}</span>`;
function toast(title, body = '', kind = 'ok', ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b><span class="muted small">${esc(body)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const fail = e => toast('Something went wrong', e.message, 'critical', 7000);

/* ---------------------------------------------------------- modal */
function openModal(title, body, footer) {
  modal.innerHTML = `<div class="mhead"><h2>${esc(title)}</h2><button class="btn small" data-close>Close</button></div>
    <div class="mbody">${body}</div>${footer ? `<div class="mfoot">${footer}</div>` : ''}`;
  if (!modal.open) modal.showModal();
}
const closeModal = () => modal.open && modal.close();
modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });

/* ---------------------------------------------------------- router */
function route() {
  clearInterval(timer); timer = null;
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (parts[0] === 'models' || parts[0] === 'work' ? parts[0] : (!parts[0] ? 'projects' : ''))));
  if (!parts.length) return pageProjects();
  if (parts[0] === 'p') return pageProject(+parts[1], q.get('tab') || 'live');
  if (parts[0] === 'c') return pageCamera(+parts[1]);
  if (parts[0] === 'models') return pageModels();
  if (parts[0] === 'work') return pageWork();
  view.innerHTML = '<div class="empty"><h3>Page not found</h3><a href="#/">Back to projects</a></div>';
}
window.addEventListener('hashchange', route);

async function refreshSide() {
  try {
    const ps = await api('/projects');
    const cur = (location.hash.match(/#\/p\/(\d+)/) || [])[1];
    $('#side-projects').innerHTML = ps.map(p => `<a href="#/p/${p.id}" class="${cur == p.id ? 'on' : ''}">${esc(p.name)}${p.alerts_open ? ` <span class="badge" style="float:right">${p.alerts_open}</span>` : ''}</a>`).join('')
      || '<span class="muted small" style="padding:6px 10px">No projects yet</span>';
  } catch (e) { }
}

/* ---------------------------------------------------------- projects */
async function pageProjects() {
  const ps = await api('/projects');
  view.innerHTML = `<div class="top"><div><h1>Projects</h1><p>Group cameras, models and alerts by the thing you are testing.</p></div>
    <button class="btn primary" data-act="new-project">New project</button></div>
    ${MODE === 'demo' ? `<div class="starts">
      <div class="card start"><h3>Use my webcam</h3><p class="muted small">Runs an object detector on this computer's camera. Your browser asks for permission first, and no video leaves your computer.</p>
        <button class="btn primary" data-act="quick-webcam">Start webcam</button></div>
      <div class="card start"><h3>Test my own model</h3><p class="muted small">Add a YOLO detection model as an ONNX file and run it on a webcam, a video file or a stream link. The file stays in your browser.</p>
        <button class="btn primary" data-act="quick-model">Add my model</button></div>
      ${ps.some(p => p.cameras) ? `<div class="card start"><h3>Run the example</h3><p class="muted small">Starts an example camera with live detection, tracking, zones and alerts on sample footage.</p>
        <button class="btn primary" data-act="quick-demo">Start live demo</button></div>` : ''}</div>`
      : ps.some(p => p.cameras) ? `<div class="card quick"><div><h3>See it working in one click</h3><p class="muted small">Starts an example camera with live detection, zones and alerts.</p></div>
      <div class="row"><button class="btn" data-act="add-examples">Add example projects</button><button class="btn primary" data-act="quick-demo">Start live demo</button></div></div>`
      : `<div class="card quick"><div><h3>Start from the examples</h3><p class="muted small">Adds the stray dog, traffic, safety and counting projects with their sample clips.</p></div>
      <button class="btn primary" data-act="add-examples">Add example projects</button></div>`}
    ${ps.length ? `<div class="grid">${ps.map(p => `<a class="card pcard" href="#/p/${p.id}">
      <h3>${esc(p.name)}</h3><div class="muted small">${esc(p.description) || 'No description'}</div>
      <div class="nums"><div><b>${p.cameras}</b><span class="muted small">cameras</span></div>
      <div><b style="color:${p.live ? 'var(--ok)' : 'inherit'}">${p.live}</b><span class="muted small">live</span></div>
      <div><b style="color:${p.alerts_open ? 'var(--crit)' : 'inherit'}">${p.alerts_open}</b><span class="muted small">open alerts</span></div></div></a>`).join('')}</div>`
      : `<div class="empty"><h3>No projects yet</h3><p>A project holds the cameras and analytics for one test, for example "Helmet model v3".</p>
        <button class="btn primary" data-act="new-project">Create your first project</button></div>`}
    <p class="hire">Need a detection model trained, made faster or checked on your own cameras? <a href="#/work">Work with me</a>.</p>`;
  refreshSide();
}

function projectForm(p = {}) {
  openModal(p.id ? 'Edit project' : 'New project', `
    <div class="field"><label>Name</label><input id="f-name" value="${esc(p.name)}" placeholder="Helmet model v3"></div>
    <div class="field"><label>Description</label><textarea id="f-desc" rows="3" placeholder="What are you testing?">${esc(p.description)}</textarea></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save</button>`);
  $('#save').onclick = async () => {
    try {
      const body = { name: $('#f-name').value, description: $('#f-desc').value };
      const r = p.id ? await api('/projects/' + p.id, { method: 'PUT', json: body }) : await api('/projects', { method: 'POST', json: body });
      closeModal(); location.hash = '#/p/' + r.id; route();
    } catch (e) { fail(e); }
  };
}

/* ---------------------------------------------------------- project page */
async function pageProject(pid, tab) {
  const ps = await api('/projects'); const p = ps.find(x => x.id === pid);
  if (!p) { view.innerHTML = '<div class="empty"><h3>Project not found</h3><a href="#/">Back</a></div>'; return; }
  const stats = async cams => {
    cams = cams || await api(`/projects/${pid}/cameras`);
    const live = cams.filter(c => c.runtime.status === 'live').length;
    const open = (await api(`/alerts?project_id=${pid}&open_only=true&limit=500`)).length;
    if (!$('#ph-stats')) return cams;
    $('#ph-stats').innerHTML = `<div class="stat"><b>${cams.length}</b><span>cameras</span></div><div class="stat"><b style="color:var(--ok)">${live}</b><span>live now</span></div>
      <div class="stat"><b>${cams.reduce((n, c) => n + c.analytics_count, 0)}</b><span>analytics</span></div><div class="stat"><b style="color:${open ? 'var(--crit)' : 'inherit'}">${open}</b><span>open alerts</span></div>`;
    return cams;
  };
  const render = async () => {
    const cams = await stats();
    if (!$('#tab')) return;
    if (tab === 'live') renderWall(cams);
    else if (tab === 'cameras') renderCameraTable(cams);
  };
  view.innerHTML = `<div class="crumbs"><a href="#/">Projects</a> / ${esc(p.name)}</div>
    <div class="top"><div><h1>${esc(p.name)}</h1><p>${esc(p.description)}</p></div>
    <div class="row"><button class="btn" data-act="edit-project">Edit</button><button class="btn danger" data-act="del-project">Delete</button>
    <button class="btn primary" data-act="add-camera">Add camera</button></div></div>
    <div class="stats" id="ph-stats"></div>
    <div class="tabs">${[['live', 'Live wall'], ['cameras', 'Cameras'], ['alerts', 'Alerts'], ['insights', 'Insights']].map(([k, t]) => `<a href="#/p/${pid}?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div id="tab"></div>`;
  view.dataset.pid = pid; view.dataset.pname = p.name; view.dataset.pdesc = p.description || '';
  if (tab === 'alerts') { await stats(); await renderAlerts({ project_id: pid }, true); timer = setInterval(() => { stats(); renderAlerts({ project_id: pid }, true); }, 4000); }
  else if (tab === 'insights') { await stats(); await renderInsights(pid); timer = setInterval(() => { if (!document.hidden) renderInsights(pid, true); }, 10000); }
  else { await render(); timer = setInterval(() => { if (tab === 'cameras' || !document.hidden) render(); }, tab === 'live' ? 4000 : 2500); }
  refreshSide();
}

function renderWall(cams) {
  const el = $('#tab');
  if (!cams.length) { el.innerHTML = `<div class="empty"><h3>No cameras yet</h3><p>Add an RTSP stream or upload a test video to start.</p><button class="btn primary" data-act="add-camera">Add camera</button></div>`; return; }
  // keep running <img> streams alive between refreshes
  const have = new Set([...el.querySelectorAll('[data-cam]')].map(n => +n.dataset.cam));
  if (have.size === cams.length && cams.every(c => have.has(c.id))) {
    cams.forEach(c => {
      const t = el.querySelector(`[data-cam="${c.id}"]`);
      t.querySelector('.st').innerHTML = chip(c.runtime.status);
      t.querySelector('.meta').textContent = `${c.runtime.fps_out} fps${c.alerts_open ? ' | ' + c.alerts_open + ' alerts' : ''}`;
      const running = c.runtime.status !== 'stopped';
      t.querySelector('[data-act="toggle-cam"]').textContent = running ? 'Stop' : 'Start';
      const img = t.querySelector('img');
      if (img) {
        const want = running ? `api/cameras/${c.id}/stream` : `api/cameras/${c.id}/snapshot.jpg?t=${Date.now()}`;
        if (running && !img.src.includes('/stream')) img.src = want;
        if (!running && img.src.includes('/stream')) img.src = want;
      }
    });
    return;
  }
  el.innerHTML = `<div class="wall">${cams.map(c => {
    const running = c.runtime.status !== 'stopped';
    return `<div class="tile" data-cam="${c.id}"><a class="vid" href="#/c/${c.id}">${liveTag(c.id, running, c.name).replace(' id="live"', '')}</a>
      <div class="bar"><div><a href="#/c/${c.id}">${esc(c.name)}</a><div class="muted small meta">${c.runtime.fps_out} fps${c.alerts_open ? ' | ' + c.alerts_open + ' alerts' : ''}</div></div>
      <div class="row"><span class="st">${chip(c.runtime.status)}</span><button class="btn small" data-act="toggle-cam" data-id="${c.id}">${running ? 'Stop' : 'Start'}</button></div></div></div>`;
  }).join('')}</div>`;
}

function renderCameraTable(cams) {
  $('#tab').innerHTML = cams.length ? `<div class="card tablewrap"><table><tr><th>Camera</th><th>Source</th><th>Status</th><th>Analytics</th><th>Processing</th><th></th></tr>
    ${cams.map(c => `<tr><td><a href="#/c/${c.id}"><b>${esc(c.name)}</b></a></td>
      <td class="small"><span class="chip" style="margin-right:6px">${TYPE_LABEL[c.source_type] || c.source_type}</span><span class="muted mono">${esc(srcText(c))}</span></td>
      <td>${chip(c.runtime.status)}${c.runtime.message ? `<div class="muted small">${esc(c.runtime.message)}</div>` : ''}</td>
      <td>${c.analytics_count}</td><td class="small">${c.runtime.fps_in} in / ${c.runtime.fps_out} out fps</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn small" data-act="toggle-cam" data-id="${c.id}">${c.runtime.status !== 'stopped' ? 'Stop' : 'Start'}</button>
      <a class="btn small" href="#/c/${c.id}">Open</a> <button class="btn small danger" data-act="del-cam" data-id="${c.id}">Delete</button></td></tr>`).join('')}</table></div>`
    : `<div class="empty"><h3>No cameras yet</h3><button class="btn primary" data-act="add-camera">Add camera</button></div>`;
}

function cameraForm(pid) {
  const demo = MODE === 'demo';
  const types = demo ? [['sample', 'Sample footage'], ['file', 'Upload a video'], ['webcam', 'Webcam'], ['url', 'Stream link'], ['rtsp', 'RTSP']]
    : [['file', 'Upload a video'], ['rtsp', 'RTSP stream']];
  let type = types[0][0];
  const hint = {
    sample: 'A short test video with people-shaped objects walking through. Good for trying rules and zones.',
    file: 'The video loops, so you can test a model on the same footage again and again.' + (demo ? ' It stays in your browser and is not uploaded anywhere.' : ''),
    webcam: 'Uses this computer\'s camera. Your browser will ask for permission. Nothing leaves your computer.',
    url: 'An HLS playlist (.m3u8) or a direct link to a video file. The server hosting it must allow cross-origin access (CORS).',
    rtsp: demo ? 'Browsers cannot open RTSP. Download the server version for RTSP, or republish your camera as HLS (for example with MediaMTX) and use Stream link.' : ''
  };
  openModal('Add camera', `
    <div class="field"><label>Source</label><div class="seg" id="seg" style="flex-wrap:wrap">${types.map(([k, t], i) => `<button data-t="${k}" class="${i ? '' : 'on'}">${t}</button>`).join('')}</div></div>
    <div class="field"><label>Name</label><input id="f-name" placeholder="Gate camera"></div>
    <div id="src-sample" class="field ${type === 'sample' ? '' : 'hidden'}"><label>Sample clip</label><select id="f-sample">
      <option value="demo">Walking objects (simple test scene)</option><option value="safety">Warehouse floor with a marked zone</option><option value="traffic">Road seen from above</option>
      <option value="retail">Shop aisle</option><option value="stray">Street with stray dogs (AI-generated)</option><option value="stray2">Street from a higher pole, stray dogs (AI-generated)</option><option value="bottles">Bottles on a table</option><option value="people">People walking</option></select>
      <div class="muted small" style="margin-top:6px">Clips from the Intel IoT DevKit sample videos, licensed CC BY 4.0.</div></div>
    <div id="src-file" class="field ${type === 'file' ? '' : 'hidden'}"><label>Video file (mp4, webm, avi, mkv...)</label><input type="file" id="f-file" accept="video/*"></div>
    <div id="src-url" class="field hidden"><label id="url-label">Stream URL</label><input id="f-url" placeholder="rtsp://user:password@192.168.1.20:554/stream1">
      <div class="row" style="margin-top:8px ${demo ? ';display:none' : ''}"><button class="btn small" id="test">Test connection</button><span id="test-out" class="small muted"></span></div></div>
    <div class="muted small" id="type-hint" style="margin:-4px 0 14px">${esc(hint[type])}</div>
    <div class="field"><label>Process at most (frames per second)</label><input id="f-fps" type="number" min="0.5" max="30" step="0.5" value="5"><div class="muted small" style="margin-top:6px">Lower this if your model is slow. The stream keeps playing, extra frames are skipped.</div></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Add camera</button>`);
  const sync = () => {
    $('#src-file').classList.toggle('hidden', type !== 'file');
    $('#src-sample').classList.toggle('hidden', type !== 'sample');
    $('#src-url').classList.toggle('hidden', !(type === 'rtsp' || type === 'url'));
    $('#f-url').placeholder = type === 'url' ? 'https://example.com/live/stream.m3u8' : 'rtsp://user:password@192.168.1.20:554/stream1';
    $('#url-label').textContent = type === 'url' ? 'Link to the stream or video' : 'Stream URL';
    $('#type-hint').textContent = hint[type];
  };
  $('#seg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; type = b.dataset.t;
    document.querySelectorAll('#seg button').forEach(x => x.classList.toggle('on', x === b)); sync();
  };
  $('#test').onclick = async () => {
    $('#test-out').textContent = 'Connecting...';
    try { const r = await api('/test-source', { method: 'POST', json: { url: $('#f-url').value } }); $('#test-out').textContent = r.message; $('#test-out').style.color = r.ok ? 'var(--ok)' : 'var(--crit)'; }
    catch (e) { $('#test-out').textContent = e.message; }
  };
  $('#save').onclick = async () => {
    const name = $('#f-name').value.trim() || (type === 'sample' ? 'Sample footage' : type === 'webcam' ? 'Webcam' : 'Camera'), fps = $('#f-fps').value;
    $('#save').disabled = true; $('#save').textContent = 'Adding...';
    try {
      let c;
      if (type === 'file') {
        const file = $('#f-file').files[0]; if (!file) throw new Error('Choose a video file');
        const fd = new FormData(); fd.append('name', name); fd.append('fps_limit', fps); fd.append('file', file);
        c = await api(`/projects/${pid}/cameras/upload`, { method: 'POST', form: fd });
      } else {
        c = await api(`/projects/${pid}/cameras`, { method: 'POST', json: { name, source_type: type, source: type === 'rtsp' || type === 'url' ? $('#f-url').value : type === 'sample' ? 'samples/' + $('#f-sample').value : '', fps_limit: +fps } });
      }
      closeModal(); location.hash = '#/c/' + c.id;
    } catch (e) { fail(e); $('#save').disabled = false; $('#save').textContent = 'Add camera'; }
  };
}

/* ---------------------------------------------------------- alerts */
async function renderAlerts(filter, full) {
  const qs = new URLSearchParams({ limit: 100, ...filter }).toString();
  const list = await api('/alerts?' + qs);
  const el = full ? $('#tab') : $('#alerts-box');
  const head = full ? `<div class="row" style="margin-bottom:14px"><span class="muted">${list.length} alert${list.length === 1 ? '' : 's'}</span><span class="grow"></span>
    <button class="btn small" data-act="ack-all">Acknowledge all</button><button class="btn small danger" data-act="clear-alerts">Clear all</button></div>` : '';
  el.innerHTML = head + (list.length ? `<div class="${full ? 'card' : ''}">${list.map(a => `<div class="alert ${a.acked ? 'acked' : ''}">
    <a href="#" data-act="zoom-alert" data-id="${a.id}" title="Click to enlarge"><img loading="lazy" src="${alertImg(a.id)}" alt="Snapshot"></a>
    <div><span class="sev ${a.severity}">${a.severity}</span> <b>${esc(a.message)}</b>
    <div class="muted small">${esc(a.camera_name || 'Camera removed')} | ${ago(a.created_at)} | ${new Date(a.created_at * 1000).toLocaleTimeString()}</div></div>
    <div class="acts">${a.acked ? '<span class="muted small">Acknowledged</span>' : `<button class="btn small" data-act="ack" data-id="${a.id}">Acknowledge</button>`}</div></div>`).join('')}</div>`
    : `<div class="empty"><h3>No alerts</h3><p>Alerts appear here when an analytic's rule holds for long enough.</p></div>`);
}

/* ---------------------------------------------------------- insights (sightings, hotspots, trends) */
let insightsDays = 7, insightsLabel = '';
const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const hourLabel = h => h === null || h === undefined ? '-' : `${String(h).padStart(2, '0')}:00`;

async function renderInsights(pid, refresh = false) {
  const el = $('#tab'); if (!el) return;
  const lq = insightsLabel ? `&label=${encodeURIComponent(insightsLabel)}` : '';
  const [ins, rows, cams] = await Promise.all([api(`/projects/${pid}/insights?days=${insightsDays}${lq}`), api(`/projects/${pid}/sightings?days=${insightsDays}&limit=100${lq}`), api(`/projects/${pid}/cameras`)]);
  if (!$('#tab')) return;
  const t = ins.totals, crossed = (t.crossed_in || 0) + (t.crossed_out || 0);
  const labels = [...new Set([...(ins.labels || []), ...(insightsLabel ? [insightsLabel] : [])])];
  const ranges = [[1, 'Last 24 hours'], [7, 'Last 7 days'], [30, 'Last 30 days']];
  const scroll = window.scrollY;
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px;flex-wrap:wrap"><div class="seg">${ranges.map(([d, l]) => `<button data-act="ins-range" data-days="${d}" class="${insightsDays === d ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label class="small muted" style="display:flex;gap:6px;align-items:center">Class <select id="ins-label"><option value="">All classes</option>${labels.map(l => `<option ${l === insightsLabel ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <span class="grow"></span><a class="btn small" ${MODE === 'demo' ? `href="${window.DemoBackend.csv(pid, insightsDays, insightsLabel)}" download="sightings_project${pid}.csv"` : `href="api/projects/${pid}/sightings.csv?days=${insightsDays}${lq}"`}>Download CSV</a>
      ${crossed ? `<a class="btn small" ${MODE === 'demo' ? `href="${window.DemoBackend.csvCross(pid, insightsDays, insightsLabel)}" download="crossings_project${pid}.csv"` : `href="api/projects/${pid}/crossings.csv?days=${insightsDays}${lq}"`}>Crossings CSV</a>` : ''}
      <button class="btn small danger" data-act="ins-clear">Clear data</button></div>
    <div class="stats">
      <div class="stat"><b>${t.sightings}</b><span>sightings (tracked visits)</span></div>
      <div class="stat"><b style="color:${t.unaccompanied ? 'var(--crit)' : 'inherit'}">${t.unaccompanied}</b><span>unaccompanied</span></div>
      <div class="stat"><b>${fmtDur(t.avg_dwell)}</b><span>average time in view</span></div>
      <div class="stat"><b>${t.group_max}</b><span>largest group seen together</span></div>
      ${t.still_max >= 5 ? `<div class="stat"><b>${fmtDur(t.still_max)}</b><span>longest time not moving</span></div>` : ''}
      ${crossed ? `<div class="stat"><b>${t.crossed_in} / ${t.crossed_out}</b><span>line crossings in / out</span></div>` : ''}
      <div class="stat"><b>${hourLabel(t.busiest_hour)}</b><span>busiest hour</span></div></div>
    ${MODE === 'demo' ? `<div class="muted small" style="margin:-8px 0 14px">This data is kept in your browser only. The sample videos loop, so every loop adds new sightings.</div>` : ''}
    ${t.sightings ? '' : `<div class="card muted small" style="margin-bottom:16px">No sightings in this period yet. A sighting is saved when a tracked object leaves the view or the camera stops.
      Add an analytic with the rule <b>an object is alone</b> and the class <b>dog</b>, then start the camera.</div>`}
    <div class="two">
      <div class="card"><h3 style="margin-top:0">By hour of day</h3><canvas id="ins-hour" width="640" height="220" class="chart"></canvas></div>
      <div class="card"><h3 style="margin-top:0">By day</h3><canvas id="ins-day" width="640" height="220" class="chart"></canvas>
        <div class="muted small"><span class="key" style="background:#5b6b78"></span>all sightings <span class="key" style="background:var(--crit);margin-left:10px"></span>unaccompanied</div></div>
    </div>
    ${crossed ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Line crossings by hour of day</h3><canvas id="ins-cross" width="640" height="220" class="chart"></canvas>
      <div class="muted small"><span class="key" style="background:#5b6b78"></span>in <span class="key" style="background:#fbbf24;margin-left:10px"></span>out</div></div>` : ''}
    <h2 style="margin:22px 0 10px">Hotspots by camera</h2>
    <div class="muted small" style="margin:-4px 0 12px">Brighter areas are where ${insightsLabel ? `a ${esc(insightsLabel)}` : 'tracked objects'} spent the most time (foot position), over the selected period.</div>
    <div class="grid heatgrid">${cams.map(c => {
      const s = ins.cameras.find(x => x.camera_id === c.id) || { sightings: 0, unaccompanied: 0, avg_dwell: 0, group_max: 0 };
      return `<div class="card heatcard"><div class="heatwrap"><img src="${MODE === 'demo' ? window.DemoBackend.still(c.id) : `api/cameras/${c.id}/still.jpg?t=${refresh ? Date.now() : 0}`}" alt="${esc(c.name)}"><canvas data-heat="${c.id}"></canvas></div>
        <div class="row" style="margin-top:10px"><a href="#/c/${c.id}"><b>${esc(c.name)}</b></a><span class="grow"></span>${chip(c.runtime.status)}</div>
        <div class="kv"><span>Sightings <b>${s.sightings}</b></span><span>Unaccompanied <b>${s.unaccompanied}</b></span><span>Avg time <b>${fmtDur(s.avg_dwell)}</b></span><span>Largest group <b>${s.group_max}</b></span>${s.crossed_in || s.crossed_out ? `<span>Crossed in / out <b>${s.crossed_in} / ${s.crossed_out}</b></span>` : ''}</div></div>`;
    }).join('') || '<div class="muted">No cameras in this project.</div>'}</div>
    <h2 style="margin:22px 0 10px">Recent sightings</h2>
    ${rows.length ? `<div class="card tablewrap"><table><tr><th>Seen</th><th>Camera</th><th>Object</th><th>Time in view</th><th>Time alone</th><th>Group</th><th>Status</th></tr>
      ${rows.map(r => `<tr><td class="small">${new Date(r.first_ts * 1000).toLocaleString()}</td><td>${esc(r.camera_name || 'Camera removed')}</td><td>${esc(r.label)} #${r.track_id}</td>
        <td>${fmtDur(r.duration)}</td><td>${fmtDur(r.alone_seconds || 0)}</td><td>${r.group_max}</td>
        <td>${r.unaccompanied ? '<span class="sev warning">unaccompanied</span>' : '<span class="muted small">with a person</span>'}</td></tr>`).join('')}</table></div>`
      : '<div class="muted small">Nothing recorded yet.</div>'}`;
  window.scrollTo(0, scroll);
  bars($('#ins-hour'), ins.by_hour.map((v, h) => ({ label: h % 3 === 0 ? String(h).padStart(2, '0') : '', a: v })));
  bars($('#ins-day'), ins.by_day.map(d => ({ label: d.date.slice(5), a: d.sightings, b: d.unaccompanied })));
  if (crossed) bars($('#ins-cross'), ins.crossings_by_hour.in.map((v, h) => ({ label: h % 2 === 0 ? String(h).padStart(2, '0') : '', a: v, b: ins.crossings_by_hour.out[h], side: true })));
  $('#ins-label').onchange = e => { insightsLabel = e.target.value; renderInsights(pid); };
  for (const c of cams) {
    const cv = el.querySelector(`canvas[data-heat="${c.id}"]`); if (!cv) continue;
    api(`/cameras/${c.id}/heatmap?days=${insightsDays}${lq}`).then(h => drawHeat(cv, h)).catch(() => { });
  }
}

function bars(cv, data) {
  if (!cv) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, padB = 26, padT = 24;
  g.clearRect(0, 0, W, H);
  if (!data.length) { g.fillStyle = '#8fa1ae'; g.font = '16px system-ui'; g.fillText('No data yet', 10, H / 2); return; }
  const max = Math.max(1, ...data.map(d => d.side ? Math.max(d.a, d.b || 0) : d.a)), bw = W / data.length;
  g.strokeStyle = '#243340'; g.beginPath(); g.moveTo(0, H - padB + .5); g.lineTo(W, H - padB + .5); g.stroke();
  g.font = '13px system-ui'; g.textAlign = 'center';
  data.forEach((d, i) => {
    const w = Math.min(bw * 0.7, 56), x = i * bw + (bw - w) / 2, hA = (d.a / max) * (H - padB - padT);
    if (d.side) {                                       // two bars next to each other, for example in and out
      const half = w / 2, hB = ((d.b || 0) / max) * (H - padB - padT);
      g.fillStyle = '#5b6b78'; g.fillRect(x, H - padB - hA, half - 1, hA);
      g.fillStyle = '#fbbf24'; g.fillRect(x + half, H - padB - hB, half - 1, hB);
      if (d.label) { g.fillStyle = '#8fa1ae'; g.fillText(d.label, x + w / 2, H - 8); }
      return;
    }
    g.fillStyle = '#5b6b78'; g.fillRect(x, H - padB - hA, w, hA);
    if (d.b) { const hB = (d.b / max) * (H - padB - padT); g.fillStyle = '#f87171'; g.fillRect(x, H - padB - hB, w, hB); }
    if (d.a && bw > 18) { g.fillStyle = '#e8eef2'; g.fillText(d.a, x + w / 2, H - padB - hA - 6); }
    if (d.label) { g.fillStyle = '#8fa1ae'; g.fillText(d.label, x + w / 2, H - 8); }
  });
}

function drawHeat(cv, h) {
  const img = cv.previousElementSibling;
  const paint = () => {
    cv.width = img.clientWidth || 480; cv.height = img.clientHeight || 270;
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    if (!h.max) return;
    const off = document.createElement('canvas'); off.width = h.w; off.height = h.h;
    const og = off.getContext('2d'), px = og.createImageData(h.w, h.h);
    h.grid.forEach((v, i) => {
      if (!v) return;
      const t = Math.sqrt(v / h.max);                      // square root so quieter spots still show
      const r = 255, gr = Math.round(220 * (1 - t)), a = Math.round(120 + 135 * t);
      px.data.set([r, gr, 40, a], i * 4);
    });
    og.putImageData(px, 0, 0);
    g.imageSmoothingEnabled = true; g.filter = 'blur(4px)';
    g.drawImage(off, 0, 0, cv.width, cv.height);
  };
  if (img.complete && img.naturalWidth) paint(); else img.onload = paint;
}

/* ---------------------------------------------------------- camera page */
async function pageCamera(cid) {
  const cam = await api('/cameras/' + cid);
  const proj = (await api('/projects')).find(p => p.id === cam.project_id);
  models = await api('/models');
  view.innerHTML = `<div class="crumbs"><a href="#/">Projects</a> / <a href="#/p/${cam.project_id}">${esc(proj ? proj.name : '')}</a> / ${esc(cam.name)}</div>
    <div class="top"><div><h1>${esc(cam.name)}</h1><p class="mono small">${esc(srcText(cam))}</p></div>
    <div class="row"><span id="cst"></span><button class="btn" data-act="cam-toggle" id="cam-toggle"></button><button class="btn" data-act="edit-cam">Edit</button>
    <button class="btn danger" data-act="del-cam-page">Delete</button></div></div>
    <div class="split"><div>
      <div class="player">${liveTag(cid, false)}</div>
      <div class="stats" style="margin-top:14px" id="cstats"></div>
      <div class="card" style="margin-top:6px"><div class="row" style="margin-bottom:8px"><h2>Alerts</h2><span class="grow"></span><a href="#/p/${cam.project_id}?tab=alerts" class="small">All project alerts</a></div><div id="alerts-box"></div></div>
    </div><div>
      <div class="row" style="margin-bottom:12px"><h2>Analytics</h2><span class="grow"></span><button class="btn primary small" data-act="add-an">Add analytic</button></div>
      <div id="an-list"></div></div></div>`;
  view.dataset.cid = cid; view.dataset.pid = cam.project_id;
  view.dataset.cname = cam.name; view.dataset.csource = cam.source; view.dataset.cfps = cam.fps_limit; view.dataset.ctype = cam.source_type;
  let anCache = [], lastKey = '';
  const live = $('#live');
  const tick = async () => {
    const [c, ans] = await Promise.all([api('/cameras/' + cid), api(`/cameras/${cid}/analytics`)]);
    if (!$('#cst')) return;                      // the page changed while we were waiting
    anCache = ans; view.__ans = ans;
    const r = c.runtime, running = r.status !== 'stopped';
    $('#cst').innerHTML = chip(r.status);
    $('#cam-toggle').textContent = running ? 'Stop' : 'Start'; $('#cam-toggle').className = 'btn ' + (running ? '' : 'primary');
    if (MODE === 'server') {
      const want = running ? `api/cameras/${cid}/stream` : `api/cameras/${cid}/snapshot.jpg?t=1`;
      if (!live.src.includes(running ? '/stream' : 'snapshot')) live.src = want;
    }
    $('#cstats').innerHTML = `<div class="stat"><b>${r.fps_in}</b><span>stream fps</span></div><div class="stat"><b>${r.fps_out}</b><span>processed fps</span></div>
      <div class="stat"><b>${r.size ? r.size.join('x') : '-'}</b><span>resolution</span></div><div class="stat"><b style="font-size:1.1rem">${esc(r.message) || 'OK'}</b><span>status</span></div>`;
    const key = JSON.stringify(ans);
    const rt = Object.fromEntries(r.analytics.map(a => [a.id, a]));
    $('#an-list').innerHTML = ans.length ? ans.map(a => analyticCard(a, rt[a.id])).join('') : `<div class="empty"><h3>No analytics yet</h3><p>An analytic runs one model on this camera and decides when to raise an alert.</p><button class="btn primary" data-act="add-an">Add analytic</button></div>`;
    ans.forEach(a => { const cv = document.getElementById('sp' + a.id); if (cv && rt[a.id]) spark(cv, rt[a.id].history); });
    renderAlerts({ camera_id: cid }, false);
  };
  await tick(); timer = setInterval(() => tick().catch(() => { }), 2000);
}

const WAY = { both: 'either way', in: 'going in', out: 'going out' };
function ruleText(r) {
  const c = r.condition;
  const cond = c === 'absent' ? 'nothing detected'
    : c === 'unaccompanied' ? `${r.count}+ unaccompanied (no ${(r.companions || ['person']).join('/')} within ${r.companion_radius}x its height)`
    : c === 'group' ? `${r.count}+ together (within ${r.group_radius ?? 2}x their height)`
    : c === 'still' ? `an object has not moved`
    : c === 'crossing' ? `an object crosses the line ${WAY[r.line_direction] || WAY.both}`
    : `${r.count}+ object${r.count > 1 ? 's' : ''}`;
  const hold = c === 'crossing' ? '' : ` for <b>${r.min_seconds}s</b>`;
  return `<span>Alert when <b>${cond}</b>${hold}</span><span>Cooldown <b>${r.cooldown_seconds}s</b></span>
    <span>Severity <b>${r.severity}</b></span><span><b>${r.start} to ${r.end}</b>, ${r.days.length === 7 ? 'every day' : r.days.map(d => DAYS[d]).join(' ')}</span>`;
}
const TRACKED = ['unaccompanied', 'group', 'still', 'crossing'];   // rules about tracked objects, not a plain count
function analyticCard(a, rt) {
  const m = models.find(x => x.id === a.model_id);
  return `<div class="an ${a.enabled ? '' : 'off'}"><div class="head"><div><h3>${esc(a.name)}</h3><div class="muted small">${esc(m ? m.name : 'Missing model')} | conf ${a.conf}</div></div>
    <div class="row"><button class="btn small" data-act="edit-an" data-id="${a.id}">Edit</button><button class="btn small danger" data-act="del-an" data-id="${a.id}">Delete</button></div></div>
    <div class="kv">${a.classes.length ? `<span>Classes <b>${esc(a.classes.join(', '))}</b></span>` : '<span>All classes</span>'}${a.roi.length >= 3 ? '<span>Zone <b>on</b></span>' : '<span>Whole frame</span>'}${(a.rule.line || []).length === 2 ? '<span>Counting line <b>on</b></span>' : ''}${a.webhook_url ? '<span>Webhook <b>on</b></span>' : ''}</div>
    <div class="kv">${ruleText(a.rule)}${a.rule.blur_people ? '<span>Faces <b>blurred</b></span>' : ''}</div>
    ${rt ? (rt.error ? `<div style="color:var(--crit)" class="small">Model error: ${esc(rt.error)}</div>` : `<div class="row small"><span>${TRACKED.includes(a.rule.condition) ? `In view now: <b style="font-size:1.1rem">${rt.tracks_now ?? 0}</b>` : `Now: <b style="font-size:1.1rem">${rt.count}</b> object${rt.count === 1 ? '' : 's'}`}</span>
      <span class="muted">${rt.infer_ms} ms / frame</span><span class="muted">${Object.entries(rt.labels).map(([k, v]) => k + ' ' + v).join(', ')}</span></div>
      ${rt.tracks_now !== undefined ? `<div class="row small">${TRACKED.includes(a.rule.condition) ? '' : `<span>Tracked now <b>${rt.tracks_now}</b></span>`}${a.rule.condition === 'unaccompanied' ? `<span>Unaccompanied <b style="color:${rt.alone_now ? 'var(--crit)' : 'inherit'}">${rt.alone_now}</b></span>` : ''}<span class="muted" title="A dog that is hidden for a few seconds can come back with a new ID, so this can be higher than the number of different dogs">Tracked IDs since start <b>${rt.unique}</b></span></div>` : ''}
      ${liveExtra(a, rt)}
      <canvas class="spark" id="sp${a.id}" width="600" height="112"></canvas>`) : '<div class="muted small">Start the camera to see live numbers.</div>'}</div>`;
}
function liveExtra(a, rt) {                       // numbers for the group, still and line analytics
  const c = a.rule.condition, out = [];
  if (c === 'group') out.push(`<span>Largest group now <b style="color:${rt.group_now >= a.rule.count ? 'var(--crit)' : 'inherit'}">${rt.group_now ?? 0}</b></span>`);
  if (c === 'still') out.push(`<span>Not moving for ${a.rule.min_seconds}s or more <b style="color:${rt.still_now ? 'var(--crit)' : 'inherit'}">${rt.still_now ?? 0}</b></span><span>Longest still now <b>${fmtDur(rt.still_longest || 0)}</b></span>`);
  if ((a.rule.line || []).length === 2) out.push(`<span>Crossed in <b>${rt.n_in ?? 0}</b></span><span>Crossed out <b>${rt.n_out ?? 0}</b></span>`);
  return out.length ? `<div class="row small">${out.join('')}</div>` : '';
}
function spark(cv, hist) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
  if (!hist.length) return;
  const top = 30, maxc = Math.max(1, ...hist.map(h => h[1])), n = hist.length;
  g.fillStyle = '#8fa1ae'; g.font = '17px system-ui'; g.fillText('objects over the last minute (peak ' + maxc + ')', 4, 18);
  g.strokeStyle = '#243340'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, H - 1); g.lineTo(W, H - 1); g.stroke();
  const pt = (h, i) => [i / Math.max(1, n - 1) * W, H - 6 - (h[1] / maxc) * (H - top - 8)];
  g.beginPath(); hist.forEach((h, i) => { const [x, y] = pt(h, i); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = '#2dd4bf'; g.lineWidth = 2.5; g.stroke();
  g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = 'rgba(45,212,191,.12)'; g.fill();
}

function cameraEditForm(cid) {
  const d = view.dataset;
  openModal('Edit camera', `<div class="field"><label>Name</label><input id="f-name" value="${esc(d.cname)}"></div>
    ${d.ctype === 'rtsp' || d.ctype === 'url' ? `<div class="field"><label>Stream URL</label><input id="f-src" value="${esc(d.csource)}"></div>` : ''}
    ${MODE === 'demo' && d.ctype === 'file' ? `<div class="field"><label>Video file (browsers do not keep files between visits, choose it again if needed)</label><input type="file" id="f-file" accept="video/*"></div>` : ''}
    <div class="field"><label>Process at most (frames per second)</label><input id="f-fps" type="number" min="0.5" max="30" step="0.5" value="${esc(d.cfps)}"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save</button>`);
  $('#save').onclick = async () => {
    try {
      await api('/cameras/' + cid, { method: 'PUT', json: { name: $('#f-name').value, source_type: d.ctype, source: $('#f-src') ? $('#f-src').value : d.csource, fps_limit: +$('#f-fps').value, file: $('#f-file') ? $('#f-file').files[0] : null } });
      closeModal(); route();
    } catch (e) { fail(e); }
  };
}

/* ---------------------------------------------------------- analytic editor */
async function analyticForm(cid, a) {
  const isNew = !a;
  a = a || { name: '', model_id: models[0] ? models[0].id : 1, conf: 0.4, classes: [], roi: [], enabled: true, webhook_url: '', rule: await api('/default-rule') };
  const r = a.rule; let roi = (a.roi || []).map(p => [...p]), line = (r.line || []).map(p => [...p]), mode = 'zone';
  openModal(isNew ? 'Add analytic' : 'Edit analytic', `
    <div class="two"><div class="field"><label>Name</label><input id="a-name" value="${esc(a.name)}" placeholder="Person in restricted zone"></div>
    <div class="field"><label>Model</label><select id="a-model">${models.map(m => `<option value="${m.id}" ${m.id === a.model_id ? 'selected' : ''}>${esc(m.name)}${m.exists ? '' : ' (file missing)'}</option>`).join('')}</select></div></div>
    <div class="field"><label>Confidence threshold: <b id="a-conf-v">${a.conf}</b></label><input type="range" id="a-conf" min="0.05" max="0.95" step="0.05" value="${a.conf}"></div>
    <div class="field"><label>Only count these classes (comma separated, empty means all)</label>
      <div class="row"><input id="a-classes" class="grow" value="${esc(a.classes.join(', '))}" placeholder="person, helmet"><button class="btn small" id="a-load">Load from model</button></div><div id="a-cls-hint" class="muted small" style="margin-top:6px"></div></div>
    <div class="field"><label>Zone and counting line (both optional). Click the picture to add points.</label>
      <div class="seg" id="z-mode" style="margin-bottom:8px"><button data-m="zone" class="on">Zone</button><button data-m="line">Counting line</button></div>
      <div class="muted small" id="z-help" style="margin-bottom:8px"></div>
      <div class="zone" id="zone"><img id="zone-img" src="${MODE === 'demo' ? window.DemoBackend.rawFrame(cid) : `api/cameras/${cid}/snapshot.jpg?raw=true&t=${Date.now()}`}"><canvas id="zone-cv"></canvas></div>
      <div class="row" style="margin-top:8px"><button class="btn small" id="z-undo">Undo point</button><button class="btn small" id="z-clear">Clear</button><span class="muted small" id="z-info"></span></div></div>
    <h3 style="margin:18px 0 10px">Alert rule</h3>
    <div class="three"><div class="field"><label>Alert when</label><select id="r-cond">${[['count_gte', 'objects are present'], ['absent', 'nothing is detected'], ['unaccompanied', 'an object is alone'], ['group', 'objects are in a group'], ['still', 'an object stays still'], ['crossing', 'an object crosses the line']]
      .map(([v, t]) => `<option value="${v}" ${r.condition === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="field" id="r-count-f"><label id="r-count-l">Number of objects (or more)</label><input id="r-count" type="number" min="1" value="${r.count}"></div>
    <div class="field"><label>Severity</label><select id="r-sev">${['info', 'warning', 'critical'].map(s => `<option ${r.severity === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
    <div id="r-unacc" class="${r.condition === 'unaccompanied' ? '' : 'hidden'}">
      <div class="muted small" style="margin:-4px 0 10px">Use this for stray dogs: a dog counts only when no companion (a person) is near it. Put <b>dog</b> in the classes above.</div>
      <div class="two"><div class="field"><label>Companion classes (comma separated)</label><input id="r-comp" value="${esc((r.companions || ['person']).join(', '))}"></div>
      <div class="field"><label>Near means within this many dog-heights</label><input id="r-rad" type="number" min="0.5" max="20" step="0.5" value="${r.companion_radius ?? 3}"></div></div>
    </div>
    <div id="r-group" class="${r.condition === 'group' ? '' : 'hidden'}">
      <div class="muted small" style="margin:-4px 0 10px">Alerts when that many objects stand close together, for example a pack of dogs.</div>
      <div class="field"><label>Close means within this many object-heights of each other</label><input id="r-grad" type="number" min="0.5" max="20" step="0.5" value="${r.group_radius ?? 2}"></div>
    </div>
    <div id="r-still" class="${r.condition === 'still' ? '' : 'hidden'}">
      <div class="muted small" style="margin:-4px 0 10px">Alerts when a tracked object has not moved for the time below, for example a dog lying in the road.</div>
      <div class="field"><label>Not moving means within this percent of the frame width</label><input id="r-stol" type="number" min="0.5" max="20" step="0.5" value="${r.still_tolerance ?? 3}"></div>
    </div>
    <div id="r-line" class="${r.condition === 'crossing' ? '' : 'hidden'}">
      <div class="muted small" style="margin:-4px 0 10px">Draw the counting line on the picture above. In is the side the arrow points to.</div>
      <div class="field"><label>Alert on crossings</label><select id="r-dir">${Object.entries(WAY).map(([k, t]) => `<option value="${k}" ${(r.line_direction || 'both') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink);margin:-4px 0 14px"><input type="checkbox" id="r-blur" ${r.blur_people ? 'checked' : ''}> Blur the faces of detected people in the live view and alert pictures (privacy)</label>
    <div class="two"><div class="field" id="r-min-f"><label id="r-min-l">Must hold for (seconds)</label><input id="r-min" type="number" min="0" value="${r.min_seconds}"></div>
    <div class="field"><label>Wait between alerts (seconds)</label><input id="r-cool" type="number" min="0" value="${r.cooldown_seconds}"></div></div>
    <div class="field"><label>Active on</label><div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" class="r-day" value="${i}" ${r.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
    <div class="two"><div class="field"><label>From</label><input id="r-start" type="time" value="${r.start}"></div><div class="field"><label>Until</label><input id="r-end" type="time" value="${r.end}"></div></div>
    <div class="field"><label>Webhook URL (optional, receives a JSON POST on every alert)</label><input id="a-hook" value="${esc(a.webhook_url)}" placeholder="https://example.com/hook"></div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" id="a-on" ${a.enabled ? 'checked' : ''}> Enabled</label>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">${isNew ? 'Add analytic' : 'Save'}</button>`);
  const cv = $('#zone-cv'), img = $('#zone-img');
  const draw = () => {
    if (!document.body.contains(cv)) return;     // the dialog was closed
    cv.width = img.clientWidth || 640; cv.height = img.clientHeight || 360;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
    $('#z-help').textContent = mode === 'zone' ? 'Click to add corners. An object counts when its centre is inside the zone.'
      : 'Click two points. Each tracked object is counted when its feet cross the line.';
    $('#z-info').textContent = mode === 'zone'
      ? (roi.length ? `${roi.length} point${roi.length === 1 ? '' : 's'}${roi.length < 3 ? ' (need at least 3)' : ''}` : 'No zone, the whole frame is used')
      : (line.length === 2 ? 'Line set' : line.length ? 'Click the second point' : 'No counting line');
    if (roi.length) {
      g.beginPath(); roi.forEach((p, i) => i ? g.lineTo(p[0] * W, p[1] * H) : g.moveTo(p[0] * W, p[1] * H));
      if (roi.length >= 3) { g.closePath(); g.fillStyle = 'rgba(45,212,191,.2)'; g.fill(); }
      g.strokeStyle = '#2dd4bf'; g.lineWidth = 2.5; g.stroke();
      roi.forEach(p => { g.beginPath(); g.arc(p[0] * W, p[1] * H, 5, 0, 7); g.fillStyle = '#fff'; g.fill(); });
    }
    if (line.length) {
      const [ax, ay] = [line[0][0] * W, line[0][1] * H];
      g.strokeStyle = '#fbbf24'; g.lineWidth = 3;
      if (line.length === 2) {
        const bx = line[1][0] * W, by = line[1][1] * H, mx = (ax + bx) / 2, my = (ay + by) / 2, n = Math.max(1, Math.hypot(bx - ax, by - ay));
        const tx = mx - (by - ay) / n * 30, ty = my + (bx - ax) / n * 30;
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.moveTo(mx, my); g.lineTo(tx, ty); g.stroke();
        g.font = 'bold 14px system-ui'; g.fillStyle = '#fbbf24'; g.fillText('in', tx + 4, ty + 4);
      }
      line.forEach(p => { g.beginPath(); g.arc(p[0] * W, p[1] * H, 5, 0, 7); g.fillStyle = '#fff'; g.fill(); });
    }
  };
  img.onload = draw; if (img.complete) draw(); window.addEventListener('resize', draw, { once: true });
  cv.onclick = e => {
    const b = cv.getBoundingClientRect(), p = [+((e.clientX - b.left) / b.width).toFixed(4), +((e.clientY - b.top) / b.height).toFixed(4)];
    if (mode === 'zone') roi.push(p); else { if (line.length >= 2) line = []; line.push(p); }
    draw();
  };
  const setMode = m => { mode = m; document.querySelectorAll('#z-mode button').forEach(x => x.classList.toggle('on', x.dataset.m === m)); draw(); };
  $('#z-mode').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); };
  $('#z-undo').onclick = () => { (mode === 'zone' ? roi : line).pop(); draw(); };
  $('#z-clear').onclick = () => { if (mode === 'zone') roi = []; else line = []; draw(); };
  $('#a-conf').oninput = e => $('#a-conf-v').textContent = e.target.value;
  const fields = () => {                           // show the settings the chosen condition uses
    const c = $('#r-cond').value;
    $('#r-unacc').classList.toggle('hidden', c !== 'unaccompanied');
    $('#r-group').classList.toggle('hidden', c !== 'group');
    $('#r-still').classList.toggle('hidden', c !== 'still');
    $('#r-line').classList.toggle('hidden', c !== 'crossing');
    $('#r-count-f').classList.toggle('hidden', c === 'absent' || c === 'still' || c === 'crossing');
    $('#r-min-f').classList.toggle('hidden', c === 'crossing');
    $('#r-count-l').textContent = c === 'group' ? 'Objects in the group (or more)' : 'Number of objects (or more)';
    $('#r-min-l').textContent = c === 'still' ? 'Not moving for (seconds)' : 'Must hold for (seconds)';
  };
  fields();
  $('#r-cond').onchange = e => {
    const c = e.target.value, u = c === 'unaccompanied';
    if (['unaccompanied', 'group', 'still', 'crossing'].includes(c) && !$('#a-classes').value.trim()) $('#a-classes').value = 'dog';
    if (u) $('#r-blur').checked = true;
    if (c === 'group' && +$('#r-count').value < 2) $('#r-count').value = 3;
    if (c === 'still' && +$('#r-min').value < 10) $('#r-min').value = 30;
    if (c === 'crossing') setMode('line');
    fields();
  };
  $('#a-load').onclick = async () => {
    try { const c = await api(`/models/${$('#a-model').value}/classes`); $('#a-cls-hint').textContent = 'Model classes: ' + c.join(', '); }
    catch (e) { $('#a-cls-hint').textContent = e.message; }
  };
  $('#save').onclick = async () => {
    const body = {
      name: $('#a-name').value, model_id: +$('#a-model').value, conf: +$('#a-conf').value,
      classes: $('#a-classes').value.split(',').map(s => s.trim()).filter(Boolean), roi, enabled: $('#a-on').checked, webhook_url: $('#a-hook').value,
      rule: { condition: $('#r-cond').value, count: +$('#r-count').value, min_seconds: +$('#r-min').value, cooldown_seconds: +$('#r-cool').value, severity: $('#r-sev').value,
        days: [...document.querySelectorAll('.r-day:checked')].map(x => +x.value), start: $('#r-start').value || '00:00', end: $('#r-end').value || '23:59',
        companions: $('#r-comp').value.split(',').map(s => s.trim()).filter(Boolean), companion_radius: +$('#r-rad').value || 3, blur_people: $('#r-blur').checked,
        group_radius: +$('#r-grad').value || 2, still_tolerance: +$('#r-stol').value || 3, line: line.length === 2 ? line : [], line_direction: $('#r-dir').value }
    };
    try {
      if (body.rule.condition === 'crossing' && line.length !== 2) throw new Error('Draw the counting line first: choose Counting line and click two points on the picture.');
      if (isNew) await api(`/cameras/${cid}/analytics`, { method: 'POST', json: body }); else await api('/analytics/' + a.id, { method: 'PUT', json: body });
      closeModal(); toast('Saved', 'The analytic reloads on the next frame.'); route();
    } catch (e) { fail(e); }
  };
}

/* ---------------------------------------------------------- work with me */
const OFFERS = [
  ['YOLO fine-tune and TensorRT export', 'About 5 working days',
    'A detector trained for your objects and exported to run fast on your GPU or edge device. You get the weights, the ONNX and TensorRT files, an accuracy report and measured latency.'],
  ['Latency and accuracy audit', 'About 3 working days',
    'I go through your detection pipeline and find where the time and the accuracy are lost. You get a written report with a ranked list of fixes.'],
  ['Dataset and evaluation check', 'About 2 working days',
    'I check your labels, format conversions and metric code for the errors that make accuracy numbers wrong. You get a report with a fix for each one.'],
  ['Custom model or full pipeline', 'Scoped after a call',
    'Need a custom model, data labelling, or a full camera pipeline with alerts? Tell me the problem and I will come back with a scope and a timeline. For larger jobs I can put together and manage a small team.']
];
function pageWork() {
  view.innerHTML = `<div class="top"><div><h1>Work with me</h1><p>Computer vision projects for small teams and agencies.</p></div>
    <a class="btn primary" href="mailto:mhmasum6875@gmail.com">Get in touch</a></div>
    <p class="worklede">I'm Maidul Hasan Masum. I built this test bench, and I train, measure and deploy detection models.
      These are the jobs I take most often. Prices are on request.</p>
    <div class="grid">${OFFERS.map(([t, days, text]) => `<div class="card offer"><h3>${t}</h3><div class="days">${days}</div><p>${text}</p></div>`).join('')}</div>
    <h2 style="margin:26px 0 10px">How I work</h2>
    <ul class="worklist">
      <li>It starts with an email or a short call about the problem. I send back a fixed scope, timeline and price before any work begins.</li>
      <li>Every speed or accuracy figure comes from a run you can repeat on your own hardware.</li>
      <li>You own the code, the weights and the report.</li>
      <li>I work in English from Kuala Lumpur (UTC+8), with a few hours of overlap with Europe and Australia each day.</li>
    </ul>
    <h2 style="margin:26px 0 10px">See my work first</h2>
    <p class="worklede">You can check how I build things before you write. <a href="#/">Run a detector on your webcam or add your own model</a> on this site,
      read the <a href="${REPO}" target="_blank" rel="noopener">source code</a>, or see my <a href="https://mh-masum6875.github.io" target="_blank" rel="noopener">background and publications</a>.</p>
    <p class="worklede">To start, email <a href="mailto:mhmasum6875@gmail.com">mhmasum6875@gmail.com</a> and tell me what you are trying to do.</p>`;
  refreshSide();
}

/* ---------------------------------------------------------- models */
async function pageModels() {
  models = await api('/models');
  view.innerHTML = `<div class="top"><div><h1>Models</h1><p>${MODE === 'demo' ? 'Add your own detection model as an ONNX file. It runs in your browser and stays on your computer.' : 'Register the model files you want to test (.onnx, .pt or .engine).'}</p></div>
    <button class="btn primary" data-act="add-model">Add model</button></div>
    <div class="card tablewrap"><table><tr><th>Name</th><th>Type</th><th>File</th><th>Used by</th><th></th></tr>
    ${models.map(m => `<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.notes)}</div></td><td>${m.builtin === false ? 'Yours (ONNX)' : m.kind === 'motion' || m.kind === 'cocossd' || m.builtin ? 'Built in' : 'Your model'}</td>
      <td class="mono small">${m.builtin === false ? esc(Math.round(m.bytes / 1e5) / 10 + ' MB, kept in this browser') : m.kind === 'motion' || m.kind === 'cocossd' || m.builtin ? '-' : esc(m.path) + (m.exists ? '' : ' (missing)')}</td><td>${m.in_use} analytic${m.in_use === 1 ? '' : 's'}</td>
      <td style="text-align:right">${m.builtin === true || m.kind === 'motion' || m.kind === 'cocossd' ? '' : `<button class="btn small danger" data-act="del-model" data-id="${m.id}">Remove</button>`}</td></tr>`).join('')}</table></div>
    <p class="muted small" style="margin-top:14px">To add your own detector type, subclass <span class="mono">Detector</span> in <span class="mono">app/detectors.py</span> and register it in <span class="mono">build_detector</span>.</p>`;
  refreshSide();
}
function modelForm() {
  if (MODE === 'demo') {
    openModal('Add your model', `
      <p class="muted small" style="margin-top:0">Your model runs inside this page. The file is stored in your own browser and is never uploaded.
      Export your detection model to ONNX with a fixed square input size, for example 640 by 640.
      A .pt file cannot run in a browser, and models with filtering built into the graph are not supported yet.</p>
      <div class="field"><label>ONNX file (up to 300 MB)</label><input type="file" id="m-file" accept=".onnx"></div>
      <div class="field"><label>Name</label><input id="m-name" placeholder="helmet-v3"></div>
      <div class="field"><label>Class names, only if the file does not contain them (comma separated)</label><input id="m-names" placeholder="helmet, vest, person"></div>
      <div class="field"><label>Notes</label><input id="m-notes" placeholder="Trained 12 Oct, 3 classes"></div>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Add model</button>`);
    $('#save').onclick = async () => {
      const f = $('#m-file').files[0]; if (!f) { fail(new Error('Choose an .onnx file')); return; }
      $('#save').disabled = true; $('#save').textContent = 'Checking the model...';
      try {
        const fd = new FormData(); fd.append('file', f); fd.append('name', $('#m-name').value); fd.append('names', $('#m-names').value); fd.append('notes', $('#m-notes').value);
        const m = await api('/models/upload', { method: 'POST', form: fd });
        closeModal(); toast('Model added', `${m.name}: ${m.names.length} classes. Pick it when you add an analytic.`); route();
      } catch (e) { fail(e); $('#save').disabled = false; $('#save').textContent = 'Add model'; }
    };
    return;
  }
  let mode = 'path';
  openModal('Add model', `<div class="field"><div class="seg" id="seg"><button data-t="path" class="on">Path on this machine</button><button data-t="up">Upload file</button></div></div>
    <div class="field"><label>Name</label><input id="m-name" placeholder="helmet-v3"></div>
    <div class="field" id="m-path-w"><label>Path to the weights</label><input id="m-path" placeholder="/models/helmet_v3.pt"></div>
    <div class="field hidden" id="m-file-w"><label>Weights file</label><input type="file" id="m-file" accept=".pt,.onnx,.engine,.torchscript"></div>
    <div class="field"><label>Notes</label><input id="m-notes" placeholder="Trained 12 Oct, 4 classes"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Add model</button>`);
  $('#seg').onclick = e => { const b = e.target.closest('button'); if (!b) return; mode = b.dataset.t; document.querySelectorAll('#seg button').forEach(x => x.classList.toggle('on', x === b)); $('#m-path-w').classList.toggle('hidden', mode !== 'path'); $('#m-file-w').classList.toggle('hidden', mode !== 'up'); };
  $('#save').onclick = async () => {
    try {
      if (mode === 'path') await api('/models', { method: 'POST', json: { name: $('#m-name').value, path: $('#m-path').value, notes: $('#m-notes').value } });
      else { const f = $('#m-file').files[0]; if (!f) throw new Error('Choose a file'); const fd = new FormData(); fd.append('name', $('#m-name').value || f.name); fd.append('notes', $('#m-notes').value); fd.append('file', f); await api('/models/upload', { method: 'POST', form: fd }); }
      closeModal(); route();
    } catch (e) { fail(e); }
  };
}

/* ---------------------------------------------------------- actions */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = +b.dataset.id, pid = +view.dataset.pid, cid = +view.dataset.cid;
  try {
    if (act === 'new-project') projectForm();
    else if (act === 'quick-demo') {
      const ps = await api('/projects'), withCams = ps.filter(p => p.cameras);
      const p = withCams.find(p => /stray/i.test(p.name)) || withCams.find(p => /safety/i.test(p.name)) || withCams[0]; if (!p) return;
      const c = (await api(`/projects/${p.id}/cameras`))[0];
      await api(`/cameras/${c.id}/start`, { method: 'POST' }); location.hash = '#/c/' + c.id;
    }
    else if (act === 'add-examples') {
      const r = await api('/examples', { method: 'POST' });
      toast(r.added.length ? 'Examples added' : 'Nothing to add', r.added.length ? r.added.join(', ') : 'The example projects are already here.'); route();
    }
    else if (act === 'quick-model') { location.hash = '#/models'; await pageModels(); modelForm(); }
    else if (act === 'quick-webcam') {
      b.disabled = true; b.textContent = 'Starting...';
      const ps = await api('/projects');
      const p = ps.find(x => x.name === 'My tests') || await api('/projects', { method: 'POST', json: { name: 'My tests', description: 'Your own webcam, videos and models.' } });
      const cams = await api(`/projects/${p.id}/cameras`);
      let c = cams.find(x => x.source_type === 'webcam');
      if (!c) {
        c = await api(`/projects/${p.id}/cameras`, { method: 'POST', json: { name: 'Webcam', source_type: 'webcam', source: '', fps_limit: 5 } });
        const all = await api('/models'), m = all.find(x => x.kind === 'yolo' && x.builtin !== false) || all.find(x => x.kind === 'cocossd') || all[0];
        await api(`/cameras/${c.id}/analytics`, { method: 'POST', json: { name: 'Everyday objects', model_id: m.id, conf: 0.4, classes: [], roi: [], enabled: true, webhook_url: '', rule: await api('/default-rule') } });
      }
      await api(`/cameras/${c.id}/start`, { method: 'POST' }); location.hash = '#/c/' + c.id;
    }
    else if (act === 'edit-project') projectForm({ id: pid, name: view.dataset.pname, description: view.dataset.pdesc });
    else if (act === 'del-project') { if (confirm('Delete this project with all its cameras and alerts?')) { await api('/projects/' + pid, { method: 'DELETE' }); location.hash = '#/'; } }
    else if (act === 'add-camera') cameraForm(pid);
    else if (act === 'toggle-cam') { const running = b.textContent.trim() === 'Stop'; await api(`/cameras/${id}/${running ? 'stop' : 'start'}`, { method: 'POST' }); route(); }
    else if (act === 'cam-toggle') { const running = b.textContent.trim() === 'Stop'; await api(`/cameras/${cid}/${running ? 'stop' : 'start'}`, { method: 'POST' }); }
    else if (act === 'del-cam') { if (confirm('Delete this camera, its analytics and alerts?')) { await api('/cameras/' + id, { method: 'DELETE' }); route(); } }
    else if (act === 'del-cam-page') { if (confirm('Delete this camera, its analytics and alerts?')) { await api('/cameras/' + cid, { method: 'DELETE' }); location.hash = '#/p/' + pid; } }
    else if (act === 'edit-cam') cameraEditForm(cid);
    else if (act === 'add-an') analyticForm(cid);
    else if (act === 'edit-an') analyticForm(cid, (view.__ans || []).find(x => x.id === id));
    else if (act === 'del-an') { if (confirm('Delete this analytic?')) { await api('/analytics/' + id, { method: 'DELETE' }); route(); } }
    else if (act === 'ack') { await api(`/alerts/${id}/ack`, { method: 'POST' }); route(); }
    else if (act === 'ack-all') { await api(`/projects/${pid}/alerts/ack-all`, { method: 'POST' }); route(); }
    else if (act === 'clear-alerts') { if (confirm('Delete every alert in this project?')) { await api(`/projects/${pid}/alerts`, { method: 'DELETE' }); route(); } }
    else if (act === 'add-model') modelForm();
    else if (act === 'zoom-alert') {
      e.preventDefault();
      const row = b.closest('.alert'), msg = row ? row.querySelector('b') : null, meta = row ? row.querySelector('.muted') : null;
      openModal(msg ? msg.textContent : 'Alert', `<img class="zoomimg" src="${alertImg(id)}" alt="Alert picture"><div class="muted small" style="margin-top:8px">${meta ? esc(meta.textContent) : ''}</div>`,
        MODE === 'demo' ? '' : `<a class="btn" href="${alertImg(id)}" target="_blank" rel="noopener">Open full size</a>`);
      modal.classList.add('wide');
      modal.addEventListener('close', () => modal.classList.remove('wide'), { once: true });
    }
    else if (act === 'ins-range') { insightsDays = +b.dataset.days; renderInsights(pid); }
    else if (act === 'ins-clear') { if (confirm('Delete all sightings and heatmaps for this project?')) { await api(`/projects/${pid}/insights`, { method: 'DELETE' }); renderInsights(pid); } }
    else if (act === 'del-model') { if (confirm('Remove this model from the list? The file is not deleted.')) { await api('/models/' + id, { method: 'DELETE' }); route(); } }
  } catch (err) { fail(err); }
});

/* ---------------------------------------------------------- global alert watcher */
let watching = false;
async function watchAlerts() {
  try {
    const open = await api('/alerts?open_only=true&limit=500');
    const badge = $('#alert-badge'); badge.textContent = open.length + ' open'; badge.classList.toggle('hidden', !open.length);
    if (!watching) {                         // first call: remember where we are, do not toast old alerts
      const latest = await api('/alerts?limit=1');
      lastAlertId = latest.length ? latest[0].id : 0; watching = true; return;
    }
    const fresh = await api('/alerts?since_id=' + lastAlertId + '&limit=20');
    fresh.reverse().forEach(a => toast(a.camera_name || 'Alert', a.message, a.severity === 'critical' ? 'critical' : 'warning'));
    if (fresh.length) lastAlertId = Math.max(...fresh.map(a => a.id));
  } catch (e) { }
}
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);
setInterval(watchAlerts, 3000); setInterval(refreshSide, 8000);
async function initMode() {
  try { const r = await fetch('api/health'); if (r.ok && (await r.json()).ok) return; } catch (e) { }
  MODE = 'demo';
  try { await loadScript('demo.js'); } catch (e) { toast('Could not start', e.message, 'critical'); return; }
  $('#demo-bar').innerHTML = `<b>Browser demo.</b> Everything runs in this page and nothing is uploaded. Add your own ONNX model on the Models page. For RTSP streams,
    <a href="${REPO}" target="_blank" rel="noopener">get the server version</a>. <a href="#" id="demo-reset">Reset demo data</a>`;
  $('#demo-bar').classList.remove('hidden');
  $('#demo-reset').onclick = e => { e.preventDefault(); if (confirm('Delete everything you added in this demo?')) window.DemoBackend.reset(); };
}
initMode().then(() => { watchAlerts(); route(); });
