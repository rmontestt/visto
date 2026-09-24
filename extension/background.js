// Service worker: periodic scrape of history + liked videos, and a persistent outbox
// that ships everything (including live sessions/events from content.js) to your Visto
// dashboard. Where that dashboard lives (local `npm start` or your Cloudflare Worker)
// and its ingest token come from the connection code pasted in the popup.
importScripts('parser.js');

const P = self.VistoParser;
const SYNC_EVERY_MIN = 60;
const PAGE_SYNC_AFTER_MS = 45 * 60_000; // let a YouTube tab sync if we have not for this long
const OUTBOX_MAX = 300;

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

function setup() {
  chrome.alarms.create('sync', { periodInMinutes: SYNC_EVERY_MIN, delayInMinutes: 0.5 });
  chrome.alarms.create('flush', { periodInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'sync') syncFromBackground();
  if (a.name === 'flush' || a.name === 'flush-soon') flush();
});

// ---------- storage helpers --------------------------------------------------------

const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const set = obj => chrome.storage.local.set(obj);

async function patchStatus(p) {
  const s = await get('status', {});
  await set({ status: { ...s, ...p } });
}

// Serialise outbox mutations: messages can arrive concurrently.
let lock = Promise.resolve();
const withLock = fn => (lock = lock.then(fn, fn));

function enqueue(payload) {
  return withLock(async () => {
    const box = await get('outbox', []);
    box.push({ ...payload, client: CLIENT });
    await set({ outbox: box.slice(-OUTBOX_MAX) });
  }).then(() => chrome.alarms.create('flush-soon', { delayInMinutes: 0.5 }));
}

// Live sessions are merged by (video, start) so heartbeats never pile up.
function upsertSession(s) {
  return withLock(async () => {
    const pending = await get('sessions', {});
    const key = `${s.videoId}|${s.startedAt}`;
    pending[key] = { ...(pending[key] || {}), ...s, seconds: Math.max(pending[key]?.seconds || 0, s.seconds) };
    await set({ sessions: pending });
  }).then(() => chrome.alarms.create('flush-soon', { delayInMinutes: 0.5 }));
}

const CLIENT = `visto-ext/${chrome.runtime.getManifest().version}`;

async function post(payload, cfg) {
  cfg = cfg || await get('settings', null);
  if (!cfg?.endpoint || !cfg?.token) throw new Error('not connected: paste your connection code in the Visto popup');
  let res;
  try {
    res = await fetch(`${cfg.endpoint}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // A local dashboard that is not running: keep everything queued for later.
    throw new Error(`dashboard unreachable (${cfg.endpoint}); is it running?`);
  }
  if (res.status === 401) throw new Error('the dashboard rejected the token: paste a fresh connection code');
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
  return res.json();
}

async function flush() {
  return withLock(async () => {
    const sessions = Object.values(await get('sessions', {}));
    const box = await get('outbox', []);
    if (!sessions.length && !box.length) return;
    try {
      if (sessions.length) {
        await post({ sessions, client: CLIENT });
        // Keep sessions that may still be growing (heartbeat in the last 2 min) so a
        // later, longer value can still be sent; the Worker keeps MAX(seconds).
        const fresh = Object.fromEntries(Object.entries(await get('sessions', {}))
          .filter(([, s]) => Date.now() - (s.updatedAt || 0) < 120_000));
        await set({ sessions: fresh });
      }
      while (box.length) {
        await post(box[0]);
        box.shift();
        await set({ outbox: box });
      }
      await patchStatus({ lastFlush: Date.now(), lastError: null, queued: 0 });
    } catch (e) {
      await patchStatus({ lastError: `send: ${e.message}`, queued: box.length });
    }
  });
}

// ---------- scraping --------------------------------------------------------------

async function scrapeAll(via) {
  const hist = await P.scrape(P.HISTORY_URL);
  const history = P.historyItems(hist.items);
  const likes = await P.scrape(P.LIKES_URL).catch(e => ({ items: [], error: e }));
  const diag = hist.diag || likes.diag ? { history: hist.diag, likes: likes.diag } : undefined;
  await enqueue({ history, likes: { mode: 'recent', items: likes.items }, diag });
  await patchStatus({
    lastSync: { at: Date.now(), via, history: history.length, likes: likes.items.length },
    lastError: likes.error ? `likes: ${likes.error.message}` : null,
  });
  return { history: history.length, likes: likes.items.length };
}

async function syncFromBackground() {
  try {
    const r = await scrapeAll('background');
    await patchStatus({ bgWorks: true });
    return r;
  } catch (e) {
    // Most likely the service-worker fetch did not carry the YouTube session. The
    // content script will sync from the next YouTube tab instead.
    await patchStatus({ bgWorks: false, lastError: `background: ${e.message}` });
    return { error: e.message };
  }
}

// ---------- deep backfill (full history + all likes) -----------------------------
// YouTube's pages only load older rows while you scroll them, and pause that in hidden
// tabs. So the worker opens ONE foreground tab, points it at the history page and then
// at the liked list, and content.js scrolls each one. Progress comes back as
// 'deepProgress' messages and lives in status.deep; the tab is closed at the end.

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, 20_000);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function startDeep() {
  const s = await get('status', {});
  if (s.deep?.running && Date.now() - (s.deep.updatedAt || 0) < 120_000) return { already: true };
  // History complete but the liked list was cut short: go straight back to the likes.
  if (s.deep && !s.deep.done && s.deep.phase === 'likes') {
    await patchDeep({ running: true, error: null, step: 'resuming your liked videos' });
    runDomPhase('likes');
    return { started: true };
  }
  // A run that died mid-history (tab crash, browser closed) resumes from its oldest day.
  const unfinished = s.deep && !s.deep.done && !s.deep.phase;
  const resumeFrom = unfinished ? (s.deep.resumeFrom && s.deep.oldest ? [s.deep.resumeFrom, s.deep.oldest].sort()[0] : s.deep.oldest) : null;
  const apiResume = unfinished ? s.deep.apiResume || null : null;
  await patchStatus({ deep: { running: true, startedAt: Date.now(), updatedAt: Date.now(), history: 0, likes: 0, oldest: null, resumeFrom, apiResume, step: apiResume ? 'resuming your history where it stopped' : 'opening your history' } });
  runDomPhase('history'); // not awaited: pages take a while to load
  return { started: true };
}

const PHASES = {
  history: { url: P.HISTORY_URL, message: 'deepHistory', step: 'loading your history' },
  likes: { url: P.LIKES_URL, message: 'domLikes', step: 'loading your liked videos' },
};

async function runDomPhase(name) {
  const phase = PHASES[name];
  try {
    const { deep } = await get('status', {});
    let tab = deep?.tabId ? await chrome.tabs.get(deep.tabId).catch(() => null) : null;
    tab = tab
      ? await chrome.tabs.update(tab.id, { url: phase.url, active: true })
      : await chrome.tabs.create({ url: phase.url, active: true });
    await patchDeep({ tabId: tab.id, step: phase.step });
    await waitForLoad(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: 'ping' });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js', 'content.js'] });
    }
    const fresh = (await get('status', {})).deep || {};
    await chrome.tabs.sendMessage(tab.id, name === 'history'
      ? { kind: phase.message, resume: fresh.apiResume, resumeFrom: fresh.resumeFrom }
      : { kind: phase.message });
  } catch (e) {
    await patchDeep({ running: false, error: e.message, step: `could not open the page (${name})` });
  }
}

async function patchDeep(p) {
  const s = await get('status', {});
  await set({ status: { ...s, deep: { ...(s.deep || {}), ...p, updatedAt: Date.now() } } });
}

// ---------- messages from content.js / popup ------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.kind) {
      case 'session': await upsertSession({ ...msg.session, updatedAt: Date.now() }); return { ok: true };
      case 'event': await enqueue({ events: [msg.event] }); return { ok: true };
      case 'scraped': {
        await enqueue(msg.payload);
        if (msg.status) await patchStatus(msg.status);
        return { ok: true };
      }
      case 'shouldPageSync': {
        const s = await get('status', {});
        return { yes: !s.lastSync || Date.now() - s.lastSync.at > PAGE_SYNC_AFTER_MS };
      }
      case 'deepBackfill': return startDeep();
      case 'deepProgress': {
        await patchDeep(msg.patch);
        if (msg.patch.phase === 'likes') {
          await flush(); // ship the history before the tab navigates away
          runDomPhase('likes');
        }
        if (msg.patch.running === false) {
          await flush();
          // Close our tab only on success; after an error leave it open to look at.
          const s = await get('status', {});
          if (msg.patch.done && s.deep?.tabId) chrome.tabs.remove(s.deep.tabId).catch(() => {});
        }
        return { ok: true };
      }
      case 'syncNow': {
        const r = await syncFromBackground();
        await flush();
        return r;
      }
      case 'status': {
        const [status, box, sessions, cfg] = await Promise.all([get('status', {}), get('outbox', []), get('sessions', {}), get('settings', null)]);
        return { status, queued: box.length + Object.keys(sessions).length, endpoint: cfg?.endpoint || null };
      }
      case 'connect': {
        // Check the code against the dashboard before keeping it (an empty ingest is a ping).
        await post({ client: CLIENT }, msg.settings);
        await set({ settings: msg.settings });
        await patchStatus({ lastError: null });
        flush();
        return { ok: true };
      }
    }
    return { error: 'unknown message' };
  })().then(reply, e => reply({ error: e.message }));
  return true; // async reply
});
