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

// Forgiving on purpose: with or without "visto:", and whatever a terminal copy adds
// (spaces, line breaks, quotes, backticks, a trailing dot).
function parseCode(raw) {
  const s = raw.replace(/[\s"'`]/g, '').replace(/^.*visto:/i, '').replace(/[.,;]+$/, '');
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
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
  $('update').disabled = $('deep').disabled;
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

// Totals come from the dashboard itself: asked when the popup opens, every 20 s while an
// import runs, and after a sync or an import ends.
const nf = new Intl.NumberFormat('en-US');
let totalsAt = 0, lastRunning = false;
async function loadTotals() {
  totalsAt = Date.now();
  const r = await chrome.runtime.sendMessage({ kind: 'totals' });
  const t = r?.totals;
  $('totals').textContent = t
    ? `${nf.format(t.videos)} videos · ${nf.format(t.likes)} likes · ${nf.format(t.favorites)} favorites`
    : `— (${r?.error || 'unavailable'})`;
  $('totals').title = t?.first_day ? `History from ${t.first_day} to ${t.last_day}` : '';
}

async function refresh() {
  const r = await chrome.runtime.sendMessage({ kind: 'status' });
  if (!r.endpoint) { if ($('connect').hidden) showConnect(false); return; }
  if ($('main').hidden && $('connect').hidden) $('main').hidden = false;
  const s = r.status || {};
  $('where').textContent = new URL(r.endpoint).host;
  $('last').textContent = s.lastSync ? `${ago(s.lastSync.at)} · ${s.lastSync.via}` : 'never';
  $('queued').textContent = r.queued;
  $('bg').textContent = s.bgWorks === undefined ? '—' : s.bgWorks ? 'working' : 'no (uses YouTube tabs)';
  $('err').hidden = !s.lastError;
  $('err').textContent = s.lastError || '';
  $('dash').href = r.endpoint;
  showDeep(s.deep);
  const running = !!s.deep?.running && Date.now() - (s.deep.updatedAt || 0) <= 120_000;
  if (!totalsAt || (running && Date.now() - totalsAt > 20_000) || (lastRunning && !running)) loadTotals();
  lastRunning = running;
}

$('sync').onclick = async () => {
  $('sync').disabled = true;
  msg('Reading the latest videos…');
  const r = await chrome.runtime.sendMessage({ kind: 'syncNow' });
  msg(r.error ? `Error: ${r.error}` : 'Synced: checked the latest videos, likes and favorites.');
  $('sync').disabled = false;
  setTimeout(loadTotals, 1500); // the sync's batch reaches the dashboard first
  refresh();
};

function showDeep(d) {
  if (!d) return;
  const msg = t => { $('deepmsg').textContent = t; };
  const counts = (d.phases || ['history', 'likes']).map(p => `${d[p] ?? 0} ${LABEL[p]}`).join(' · ');
  const oldest = d.oldest ? ` · back to ${d.oldest}` : '';
  const running = d.running && Date.now() - (d.updatedAt || 0) <= 120_000;
  $('deep').dataset.running = running ? '1' : '';
  const what = d.mode === 'update' ? 'Update' : 'Full import';
  if (d.running && !running) {
    msg(`The ${what.toLowerCase()} stopped (no progress since ${ago(d.updatedAt)}, ${counts}${oldest}). Click “${what}” to carry on.`);
  } else if (running) {
    msg(`${d.mode === 'update' ? 'Updating' : 'Importing'}… ${d.step || ''}. ${counts}${oldest}. You can close this popup; keep the YouTube tab it opened.`);
  } else {
    msg(d.error ? `${what}: ${d.step}. Error: ${d.error}` : `${what} ${ago(d.updatedAt)}: ${d.step || counts}.`);
  }
  paintButtons(currentOpts);
}

async function startImport(mode) {
  $('deep').disabled = $('update').disabled = true;
  msg(mode === 'update'
    ? 'A YouTube tab opens briefly to read what is new since your last import; it closes on its own.'
    : 'A YouTube tab will open and scroll through what you chose by itself. Keep it visible until it finishes; it closes on its own.');
  const r = await chrome.runtime.sendMessage({ kind: 'deepBackfill', mode });
  if (r?.error) { msg(`Could not start: ${r.error}`); paintButtons(currentOpts); }
}
$('deep').onclick = () => startImport('full');
$('update').onclick = () => startImport('update');

loadOptions();
refresh();
setInterval(refresh, 1500);
