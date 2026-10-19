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
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (parts[0] === 'models' ? 'models' : (!parts[0] ? 'projects' : ''))));
  if (!parts.length) return pageProjects();
  if (parts[0] === 'p') return pageProject(+parts[1], q.get('tab') || 'live');
  if (parts[0] === 'c') return pageCamera(+parts[1]);
  if (parts[0] === 'models') return pageModels();
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
    ${ps.length ? `<div class="grid">${ps.map(p => `<a class="card pcard" href="#/p/${p.id}">
      <h3>${esc(p.name)}</h3><div class="muted small">${esc(p.description) || 'No description'}</div>
      <div class="nums"><div><b>${p.cameras}</b><span class="muted small">cameras</span></div>
      <div><b style="color:${p.live ? 'var(--ok)' : 'inherit'}">${p.live}</b><span class="muted small">live</span></div>
      <div><b style="color:${p.alerts_open ? 'var(--crit)' : 'inherit'}">${p.alerts_open}</b><span class="muted small">open alerts</span></div></div></a>`).join('')}</div>`
      : `<div class="empty"><h3>No projects yet</h3><p>A project holds the cameras and analytics for one test, for example "Helmet model v3".</p>
        <button class="btn primary" data-act="new-project">Create your first project</button></div>`}`;
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
    <div class="tabs">${[['live', 'Live wall'], ['cameras', 'Cameras'], ['alerts', 'Alerts']].map(([k, t]) => `<a href="#/p/${pid}?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div id="tab"></div>`;
  view.dataset.pid = pid; view.dataset.pname = p.name; view.dataset.pdesc = p.description || '';
  if (tab === 'alerts') { await stats(); await renderAlerts({ project_id: pid }, true); timer = setInterval(() => { stats(); renderAlerts({ project_id: pid }, true); }, 4000); }
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
    <div id="src-file" class="field ${type === 'file' ? '' : 'hidden'}"><label>Video file (mp4, webm, avi, mkv...)</label><input type="file" id="f-file" accept="video/*"></div>
    <div id="src-url" class="field hidden"><label id="url-label">Stream URL</label><input id="f-url" placeholder="rtsp://user:password@192.168.1.20:554/stream1">
      <div class="row" style="margin-top:8px ${demo ? ';display:none' : ''}"><button class="btn small" id="test">Test connection</button><span id="test-out" class="small muted"></span></div></div>
    <div class="muted small" id="type-hint" style="margin:-4px 0 14px">${esc(hint[type])}</div>
    <div class="field"><label>Process at most (frames per second)</label><input id="f-fps" type="number" min="0.5" max="30" step="0.5" value="5"><div class="muted small" style="margin-top:6px">Lower this if your model is slow. The stream keeps playing, extra frames are skipped.</div></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Add camera</button>`);
  const sync = () => {
    $('#src-file').classList.toggle('hidden', type !== 'file');
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
        c = await api(`/projects/${pid}/cameras`, { method: 'POST', json: { name, source_type: type, source: type === 'rtsp' || type === 'url' ? $('#f-url').value : '', fps_limit: +fps } });
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
    <a ${MODE === 'demo' ? '' : `href="${alertImg(a.id)}" target="_blank"`}><img loading="lazy" src="${alertImg(a.id)}" alt="Snapshot"></a>
    <div><span class="sev ${a.severity}">${a.severity}</span> <b>${esc(a.message)}</b>
    <div class="muted small">${esc(a.camera_name || 'Camera removed')} | ${ago(a.created_at)} | ${new Date(a.created_at * 1000).toLocaleTimeString()}</div></div>
    <div class="acts">${a.acked ? '<span class="muted small">Acknowledged</span>' : `<button class="btn small" data-act="ack" data-id="${a.id}">Acknowledge</button>`}</div></div>`).join('')}</div>`
    : `<div class="empty"><h3>No alerts</h3><p>Alerts appear here when an analytic's rule holds for long enough.</p></div>`);
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

function ruleText(r) {
  const cond = r.condition === 'absent' ? 'nothing detected' : `${r.count}+ object${r.count > 1 ? 's' : ''}`;
  return `<span>Alert when <b>${cond}</b> for <b>${r.min_seconds}s</b></span><span>Cooldown <b>${r.cooldown_seconds}s</b></span>
    <span>Severity <b>${r.severity}</b></span><span><b>${r.start} to ${r.end}</b>, ${r.days.length === 7 ? 'every day' : r.days.map(d => DAYS[d]).join(' ')}</span>`;
}
function analyticCard(a, rt) {
  const m = models.find(x => x.id === a.model_id);
  return `<div class="an ${a.enabled ? '' : 'off'}"><div class="head"><div><h3>${esc(a.name)}</h3><div class="muted small">${esc(m ? m.name : 'Missing model')} | conf ${a.conf}</div></div>
    <div class="row"><button class="btn small" data-act="edit-an" data-id="${a.id}">Edit</button><button class="btn small danger" data-act="del-an" data-id="${a.id}">Delete</button></div></div>
    <div class="kv">${a.classes.length ? `<span>Classes <b>${esc(a.classes.join(', '))}</b></span>` : '<span>All classes</span>'}${a.roi.length >= 3 ? '<span>Zone <b>on</b></span>' : '<span>Whole frame</span>'}${a.webhook_url ? '<span>Webhook <b>on</b></span>' : ''}</div>
    <div class="kv">${ruleText(a.rule)}</div>
    ${rt ? (rt.error ? `<div style="color:var(--crit)" class="small">Model error: ${esc(rt.error)}</div>` : `<div class="row small"><span>Now: <b style="font-size:1.1rem">${rt.count}</b> object${rt.count === 1 ? '' : 's'}</span>
      <span class="muted">${rt.infer_ms} ms / frame</span><span class="muted">${Object.entries(rt.labels).map(([k, v]) => k + ' ' + v).join(', ')}</span></div>
      <canvas class="spark" id="sp${a.id}" width="600" height="112"></canvas>`) : '<div class="muted small">Start the camera to see live numbers.</div>'}</div>`;
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
  const r = a.rule; let roi = (a.roi || []).map(p => [...p]);
  openModal(isNew ? 'Add analytic' : 'Edit analytic', `
    <div class="two"><div class="field"><label>Name</label><input id="a-name" value="${esc(a.name)}" placeholder="Person in restricted zone"></div>
    <div class="field"><label>Model</label><select id="a-model">${models.map(m => `<option value="${m.id}" ${m.id === a.model_id ? 'selected' : ''}>${esc(m.name)}${m.exists ? '' : ' (file missing)'}</option>`).join('')}</select></div></div>
    <div class="field"><label>Confidence threshold: <b id="a-conf-v">${a.conf}</b></label><input type="range" id="a-conf" min="0.05" max="0.95" step="0.05" value="${a.conf}"></div>
    <div class="field"><label>Only count these classes (comma separated, empty means all)</label>
      <div class="row"><input id="a-classes" class="grow" value="${esc(a.classes.join(', '))}" placeholder="person, helmet"><button class="btn small" id="a-load">Load from model</button></div><div id="a-cls-hint" class="muted small" style="margin-top:6px"></div></div>
    <div class="field"><label>Detection zone (optional). Click the picture to add corners, an object counts when its centre is inside.</label>
      <div class="zone" id="zone"><img id="zone-img" src="${MODE === 'demo' ? window.DemoBackend.rawFrame(cid) : `api/cameras/${cid}/snapshot.jpg?raw=true&t=${Date.now()}`}"><canvas id="zone-cv"></canvas></div>
      <div class="row" style="margin-top:8px"><button class="btn small" id="z-undo">Undo point</button><button class="btn small" id="z-clear">Clear zone</button><span class="muted small" id="z-info"></span></div></div>
    <h3 style="margin:18px 0 10px">Alert rule</h3>
    <div class="three"><div class="field"><label>Alert when</label><select id="r-cond"><option value="count_gte" ${r.condition === 'count_gte' ? 'selected' : ''}>objects are present</option><option value="absent" ${r.condition === 'absent' ? 'selected' : ''}>nothing is detected</option></select></div>
    <div class="field"><label>Number of objects (or more)</label><input id="r-count" type="number" min="1" value="${r.count}"></div>
    <div class="field"><label>Severity</label><select id="r-sev">${['info', 'warning', 'critical'].map(s => `<option ${r.severity === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
    <div class="two"><div class="field"><label>Must hold for (seconds)</label><input id="r-min" type="number" min="0" value="${r.min_seconds}"></div>
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
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    $('#z-info').textContent = roi.length ? `${roi.length} point${roi.length === 1 ? '' : 's'}${roi.length < 3 ? ' (need at least 3)' : ''}` : 'No zone, the whole frame is used';
    if (!roi.length) return;
    g.beginPath(); roi.forEach((p, i) => i ? g.lineTo(p[0] * cv.width, p[1] * cv.height) : g.moveTo(p[0] * cv.width, p[1] * cv.height));
    if (roi.length >= 3) { g.closePath(); g.fillStyle = 'rgba(45,212,191,.2)'; g.fill(); }
    g.strokeStyle = '#2dd4bf'; g.lineWidth = 2.5; g.stroke();
    roi.forEach(p => { g.beginPath(); g.arc(p[0] * cv.width, p[1] * cv.height, 5, 0, 7); g.fillStyle = '#fff'; g.fill(); });
  };
  img.onload = draw; if (img.complete) draw(); window.addEventListener('resize', draw, { once: true });
  cv.onclick = e => { const b = cv.getBoundingClientRect(); roi.push([+((e.clientX - b.left) / b.width).toFixed(4), +((e.clientY - b.top) / b.height).toFixed(4)]); draw(); };
  $('#z-undo').onclick = () => { roi.pop(); draw(); }; $('#z-clear').onclick = () => { roi = []; draw(); };
  $('#a-conf').oninput = e => $('#a-conf-v').textContent = e.target.value;
  $('#a-load').onclick = async () => {
    try { const c = await api(`/models/${$('#a-model').value}/classes`); $('#a-cls-hint').textContent = 'Model classes: ' + c.join(', '); }
    catch (e) { $('#a-cls-hint').textContent = e.message; }
  };
  $('#save').onclick = async () => {
    const body = {
      name: $('#a-name').value, model_id: +$('#a-model').value, conf: +$('#a-conf').value,
      classes: $('#a-classes').value.split(',').map(s => s.trim()).filter(Boolean), roi, enabled: $('#a-on').checked, webhook_url: $('#a-hook').value,
      rule: { condition: $('#r-cond').value, count: +$('#r-count').value, min_seconds: +$('#r-min').value, cooldown_seconds: +$('#r-cool').value, severity: $('#r-sev').value,
        days: [...document.querySelectorAll('.r-day:checked')].map(x => +x.value), start: $('#r-start').value || '00:00', end: $('#r-end').value || '23:59' }
    };
    try {
      if (isNew) await api(`/cameras/${cid}/analytics`, { method: 'POST', json: body }); else await api('/analytics/' + a.id, { method: 'PUT', json: body });
      closeModal(); toast('Saved', 'The analytic reloads on the next frame.'); route();
    } catch (e) { fail(e); }
  };
}

/* ---------------------------------------------------------- models */
async function pageModels() {
  models = await api('/models');
  view.innerHTML = `<div class="top"><div><h1>Models</h1><p>Register the weights you want to test. Any Ultralytics YOLO file works (.pt, .onnx, .engine).</p></div>
    <button class="btn primary" data-act="add-model">Add model</button></div>
    <div class="card tablewrap"><table><tr><th>Name</th><th>Type</th><th>File</th><th>Used by</th><th></th></tr>
    ${models.map(m => `<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.notes)}</div></td><td>${m.kind === 'motion' || m.kind === 'cocossd' ? 'Built in' : 'Ultralytics'}</td>
      <td class="mono small">${m.kind === 'motion' || m.kind === 'cocossd' ? '-' : esc(m.path) + (m.exists ? '' : ' (missing)')}</td><td>${m.in_use} analytic${m.in_use === 1 ? '' : 's'}</td>
      <td style="text-align:right">${m.kind === 'motion' || m.kind === 'cocossd' ? '' : `<button class="btn small danger" data-act="del-model" data-id="${m.id}">Remove</button>`}</td></tr>`).join('')}</table></div>
    <p class="muted small" style="margin-top:14px">To add your own detector type, subclass <span class="mono">Detector</span> in <span class="mono">app/detectors.py</span> and register it in <span class="mono">build_detector</span>.</p>`;
  refreshSide();
}
function modelForm() {
  if (MODE === 'demo') {
    openModal('Your own models need the server', `<p>This hosted demo runs entirely in your browser, so it can use the built-in detectors only.</p>
      <p>To test your own YOLO weights (.pt, .onnx, .engine) on RTSP streams, download the server version. It is the same interface and takes a minute to start.</p>
      <p><a class="btn primary" href="${REPO}" target="_blank" rel="noopener">Get the server version on GitHub</a></p>`);
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
  $('#demo-bar').innerHTML = `<b>Browser demo.</b> Everything runs in this page and nothing is uploaded. For RTSP streams and your own YOLO weights,
    <a href="${REPO}" target="_blank" rel="noopener">get the server version</a>. <a href="#" id="demo-reset">Reset demo data</a>`;
  $('#demo-bar').classList.remove('hidden');
  $('#demo-reset').onclick = e => { e.preventDefault(); if (confirm('Delete everything you added in this demo?')) window.DemoBackend.reset(); };
}
initMode().then(() => { watchAlerts(); route(); });
