const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const P = self.VistoParser;
const LABEL = { history: 'history videos', likes: 'likes', favorites: 'favorites' };
let currentOpts = { ...P.DEFAULT_OPTIONS };

function ago(ms) {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// ---------- connection -----------------------------------------------------------
// The code is "visto:" + base64url(JSON {u: dashboard URL, t: ingest token}). It is
// printed by `npm start` (local dashboard) and `npm run cloud` (Cloudflare).

function parseCode(raw) {
  const s = raw.trim().replace(/^visto:/i, '');
  try {
    const json = JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    const url = new URL(json.u);
    if (!/^https?:$/.test(url.protocol) || !json.t) throw new Error();
    return { endpoint: url.origin, token: json.t };
  } catch {
    throw new Error('That does not look like a Visto connection code.');
  }
}

// Host permission for the dashboard only, asked at connect time (needs this click).
function permissionFor(endpoint) {
  const u = new URL(endpoint);
  return { origins: [`${u.protocol}//${u.hostname}/*`] };
}

function showConnect(canCancel) {
  $('main').hidden = true;
  $('connect').hidden = false;
  $('cancel').hidden = !canCancel;
  $('code').focus();
}

$('save').onclick = async () => {
  const err = $('connect-err');
  err.hidden = true;
  $('save').disabled = true;
  try {
    const cfg = parseCode($('code').value);
    if (!(await chrome.permissions.request(permissionFor(cfg.endpoint)))) throw new Error('Permission to reach the dashboard was not granted.');
    const r = await chrome.runtime.sendMessage({ kind: 'connect', settings: cfg });
    if (r?.error) throw new Error(r.error);
    $('code').value = '';
    $('connect').hidden = true;
    $('main').hidden = false;
    msg('Connected. Run a full import to bring in your whole history.');
    refresh();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $('save').disabled = false;
  }
};
$('cancel').onclick = () => { $('connect').hidden = true; $('main').hidden = false; };
$('reconnect').onclick = () => showConnect(true);

// ---------- what to collect -------------------------------------------------------
// Stored as chrome.storage.local.options; content.js and the service worker follow it.
// Turning a kind off stops collecting it; what was already imported stays.

async function loadOptions() {
  const { options } = await chrome.storage.local.get('options');
  const opts = currentOpts = { ...P.DEFAULT_OPTIONS, ...(options || {}) };
  document.querySelectorAll('[data-opt]').forEach(x => { x.checked = !!opts[x.dataset.opt]; });
  paintButtons(opts);
}

function paintButtons(opts) {
  const any = Object.values(opts).some(Boolean);
  $('deep').disabled = $('deep').dataset.running === '1' || !any;
  $('sync').disabled = !any;
  const on = ['history', 'likes', 'favorites'].filter(k => opts[k]).map(k => ({ history: 'history', likes: 'likes', favorites: 'Favorites' })[k]);
  $('deep').textContent = any ? `Full import (${on.join(', ')})` : 'Full import (nothing selected)';
}

document.querySelectorAll('[data-opt]').forEach(x => x.addEventListener('change', async () => {
  const opts = Object.fromEntries([...document.querySelectorAll('[data-opt]')].map(i => [i.dataset.opt, i.checked]));
  await chrome.storage.local.set({ options: opts });
  currentOpts = opts;
  paintButtons(opts);
}));

// ---------- status ---------------------------------------------------------------

async function refresh() {
  const r = await chrome.runtime.sendMessage({ kind: 'status' });
  if (!r.endpoint) { if ($('connect').hidden) showConnect(false); return; }
  if ($('main').hidden && $('connect').hidden) $('main').hidden = false;
  const s = r.status || {};
  $('where').textContent = new URL(r.endpoint).host;
  $('last').textContent = s.lastSync ? `${ago(s.lastSync.at)} · ${s.lastSync.via}` : 'never';
  const ls = s.lastSync || {};
  $('read').textContent = s.lastSync ? `${ls.history ?? 0} history · ${ls.likes ?? 0} likes · ${ls.favorites ?? 0} fav.` : '—';
  $('queued').textContent = r.queued;
  $('bg').textContent = s.bgWorks === undefined ? '—' : s.bgWorks ? 'working' : 'no (uses YouTube tabs)';
  $('err').hidden = !s.lastError;
  $('err').textContent = s.lastError || '';
  $('dash').href = r.endpoint;
  showDeep(s.deep);
}

$('sync').onclick = async () => {
  $('sync').disabled = true;
  msg('Reading the latest videos…');
  const r = await chrome.runtime.sendMessage({ kind: 'syncNow' });
  msg(r.error ? `Error: ${r.error}` : `Done: ${r.history} videos, ${r.likes} likes, ${r.favorites} favorites.`);
  $('sync').disabled = false;
  refresh();
};

function showDeep(d) {
  if (!d) return;
  const msg = t => { $('deepmsg').textContent = t; };
  const counts = (d.phases || ['history', 'likes']).map(p => `${d[p] ?? 0} ${LABEL[p]}`).join(' · ');
  const oldest = d.oldest ? ` · back to ${d.oldest}` : '';
  const running = d.running && Date.now() - (d.updatedAt || 0) <= 120_000;
  $('deep').dataset.running = running ? '1' : '';
  if (d.running && !running) {
    msg(`The import stopped (no progress since ${ago(d.updatedAt)}, ${counts}${oldest}). Click “Full import” to carry on from there.`);
  } else if (running) {
    msg(`Importing… ${d.step || ''}. ${counts}${oldest}. You can close this popup; keep the YouTube tab it opened.`);
  } else {
    msg(d.error ? `Import: ${d.step}. Error: ${d.error}` : `Full import ${ago(d.updatedAt)}: ${d.step || counts}.`);
  }
  paintButtons(currentOpts);
}

$('deep').onclick = async () => {
  $('deep').disabled = true;
  msg('A YouTube tab will open and scroll through what you chose by itself. Keep it visible until it finishes; it closes on its own.');
  const r = await chrome.runtime.sendMessage({ kind: 'deepBackfill' });
  if (r?.error) { msg(`Could not start: ${r.error}`); $('deep').disabled = false; }
};

loadOptions();
refresh();
setInterval(refresh, 1500);
