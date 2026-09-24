// Service worker: periodic scrape of history, likes and Favorites (whatever the popup's
// switches allow), the Full import's phases, and a persistent outbox
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
const getOptions = async () => ({ ...P.DEFAULT_OPTIONS, ...(await get('options', {})) });

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
    await remember(payload);
  }).then(() => chrome.alarms.create('flush-soon', { delayInMinutes: 0.5 }));
}

// Ids of likes and favorites already sent: an Update stops when it reaches them.
async function remember(payload) {
  const add = { likes: payload.likes?.items, favorites: payload.saves?.items };
  if (!add.likes?.length && !add.favorites?.length) return;
  const known = await get('known', {});
  for (const k of ['likes', 'favorites']) {
    if (!add[k]?.length) continue;
    const ids = new Set(known[k] || []);
    for (const it of add[k]) ids.add(it.videoId);
    known[k] = [...ids];
  }
  await set({ known });
}

// History is known complete from the start up to `historyCompleteUntil` (set when a Full
// import or an Update finishes). A sync whose first page reaches back to that day
// extends it to today, so the next Update only reads what came after.
async function extendCoverage(history) {
  if (!history?.length) return;
  const oldest = history.reduce((m, it) => (it.day < m ? it.day : m), history[0].day);
  const { historyCompleteUntil: until } = await get('status', {});
  if (until && oldest <= until) await patchStatus({ historyCompleteUntil: P.localDay(new Date()) });
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
  const opts = await getOptions();
  const { favorites } = await get('status', {});
  const none = { items: [] };
  const hist = opts.history ? await P.scrape(P.HISTORY_URL) : none;
  const history = opts.history ? P.historyItems(hist.items) : [];
  const likes = opts.likes ? await P.scrape(P.LIKES_URL).catch(e => ({ items: [], error: e })) : none;
  // Favorites: only once a Full import has found the playlist (its id is kept in status).
  const fav = opts.favorites && favorites?.url ? await P.scrape(favorites.url).catch(() => none) : none;
  const diag = hist.diag || likes.diag ? { history: hist.diag, likes: likes.diag } : undefined;
  const payload = { diag };
  if (opts.history) payload.history = history;
  if (opts.likes) payload.likes = { mode: 'recent', items: likes.items };
  if (fav.items.length) payload.saves = { playlist: favorites.name, items: fav.items };
  await enqueue(payload);
  await extendCoverage(history);
  await patchStatus({
    lastSync: { at: Date.now(), via, history: history.length, likes: likes.items.length, favorites: fav.items.length },
    lastError: likes.error ? `likes: ${likes.error.message}` : null,
  });
  return { history: history.length, likes: likes.items.length, favorites: fav.items.length };
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

// ---------- Full import / Update: history, then likes, then Favorites --------------
// Update is the same walk, stopping at what was imported before: the history at the
// day it was known complete up to (minus a margin), the lists at videos sent before.
// YouTube's pages only load older rows while you scroll them, and pause that in hidden
// tabs. So the worker opens ONE foreground tab and walks it through the phases the
// popup's switches allow; content.js reads each page and reports progress as
// 'deepProgress' messages (kept in status.deep). A phase that ends well reports
// `phaseDone`; the tab is closed once the last one is done. A phase cut short leaves the
// tab open, and the next Full import resumes at that phase.

const ORDER = ['history', 'likes', 'favorites'];
const LABEL = { history: 'history', likes: 'liked videos', favorites: 'Favorites' };

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, 20_000);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

const OVERLAP_DAYS = 2; // an Update re-reads the last days it already had, to be safe

async function startDeep(mode = 'full') {
  const s = await get('status', {});
  if (s.deep?.running && Date.now() - (s.deep.updatedAt || 0) < 120_000) return { already: true };
  const opts = await getOptions();
  const phases = ORDER.filter(p => opts[p]);
  if (!phases.length) return { error: 'turn on at least one kind of data to import' };
  const today = P.localDay(new Date());
  if (mode === 'update') {
    // Before 1.2.0 nothing recorded this: a finished Full import that read the history counts.
    const lastFull = s.deep?.done && s.deep.mode !== 'update' && s.deep.phases?.includes('history') && s.deep.startedAt;
    const until = s.historyCompleteUntil || (lastFull ? P.localDay(new Date(s.deep.startedAt)) : null);
    const stop = until ? new Date(`${until}T12:00:00`) : null;
    stop?.setDate(stop.getDate() - OVERLAP_DAYS);
    await patchStatus({ deep: {
      mode: 'update', running: true, startedAt: Date.now(), startedDay: today, updatedAt: Date.now(), phases, phase: phases[0],
      history: 0, likes: 0, favorites: 0, oldest: null, stopDay: stop ? P.localDay(stop) : null,
      step: `checking your ${LABEL[phases[0]]} for anything new`,
    } });
    runDomPhase(phases[0]);
    return { started: true };
  }
  const d = s.deep?.mode === 'update' ? null : s.deep; // an unfinished Update just runs again
  // A list phase that was cut short: go straight back to it.
  if (d && !d.done && d.phase && d.phase !== 'history' && phases.includes(d.phase)) {
    await patchDeep({ running: true, error: null, phases, step: `resuming your ${LABEL[d.phase]}` });
    runDomPhase(d.phase);
    return { started: true };
  }
  // A run that died mid-history (tab crash, browser closed) resumes from its oldest day.
  const unfinished = d && !d.done && (!d.phase || d.phase === 'history') && phases[0] === 'history';
  const resumeFrom = unfinished ? (d.resumeFrom && d.oldest ? [d.resumeFrom, d.oldest].sort()[0] : d.oldest) : null;
  const apiResume = unfinished ? d.apiResume || null : null;
  await patchStatus({ deep: {
    mode: 'full', running: true, startedAt: Date.now(), startedDay: unfinished ? d.startedDay || today : today,
    updatedAt: Date.now(), phases, phase: phases[0],
    history: 0, likes: 0, favorites: 0, oldest: null, resumeFrom, apiResume,
    step: apiResume ? 'resuming your history where it stopped' : `opening your ${LABEL[phases[0]]}`,
  } });
  runDomPhase(phases[0]); // not awaited: pages take a while to load
  return { started: true };
}

// Point our tab at `url` (opening it if needed) and make sure content.js is there.
async function openInTab(url) {
  const { deep } = await get('status', {});
  let tab = deep?.tabId ? await chrome.tabs.get(deep.tabId).catch(() => null) : null;
  tab = tab
    ? await chrome.tabs.update(tab.id, { url, active: true })
    : await chrome.tabs.create({ url, active: true });
  await patchDeep({ tabId: tab.id });
  await waitForLoad(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'ping' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js', 'content.js'] });
  }
  return tab;
}

async function runDomPhase(name) {
  try {
    await patchDeep({ phase: name, step: `loading your ${LABEL[name]}` });
    const { deep: cur = {}, favorites: knownFav } = await get('status', {});
    const update = cur.mode === 'update';
    if (name === 'history') {
      const tab = await openInTab(P.HISTORY_URL);
      await chrome.tabs.sendMessage(tab.id, update
        ? { kind: 'deepHistory', stopDay: cur.stopDay }
        : { kind: 'deepHistory', resume: cur.apiResume, resumeFrom: cur.resumeFrom });
    } else if (name === 'likes') {
      const tab = await openInTab(P.LIKES_URL);
      await chrome.tabs.sendMessage(tab.id, { kind: 'domPlaylist', what: 'likes', update });
    } else if (name === 'favorites') {
      let tab, fav = update && knownFav?.url ? knownFav : null;
      if (!fav) {
        await patchDeep({ step: 'looking for your Favorites playlist' });
        tab = await openInTab(P.PLAYLISTS_URL);
        fav = await chrome.tabs.sendMessage(tab.id, { kind: 'findFavorites' });
      }
      if (!fav?.url) {
        await patchDeep({ favoritesMissing: true, step: 'no playlist called Favorites found; skipped' });
        return afterPhase('favorites');
      }
      await patchStatus({ favorites: fav }); // the hourly sync reads its first page too
      tab = await openInTab(fav.url);
      await chrome.tabs.sendMessage(tab.id, { kind: 'domPlaylist', what: 'favorites', name: fav.name, update });
    }
  } catch (e) {
    await patchDeep({ running: false, error: e.message, step: `could not open the page (${LABEL[name]})` });
  }
}

// A phase finished well: ship what it read, then run the next one or wrap up.
async function afterPhase(done) {
  await flush();
  const { deep } = await get('status', {});
  // The history walk reached its end (Full import) or caught up (Update): it is complete
  // up to the day the run started.
  if (done === 'history' && deep?.startedDay) await patchStatus({ historyCompleteUntil: deep.startedDay });
  const phases = deep?.phases || ORDER;
  const next = phases[phases.indexOf(done) + 1];
  if (next) return runDomPhase(next);
  const update = deep?.mode === 'update';
  const parts = phases.map(p => `${update ? '+' : ''}${deep?.[p] ?? 0} ${LABEL[p]}`).join(' · ');
  await patchDeep({ running: false, done: true, step: `${update ? 'up to date' : 'finished'}: ${parts}` });
  if (deep?.tabId) chrome.tabs.remove(deep.tabId).catch(() => {});
}

async function patchDeep(p) {
  const s = await get('status', {});
  await set({ status: { ...s, deep: { ...(s.deep || {}), ...p, updatedAt: Date.now() } } });
}

// ---------- messages from content.js / popup ------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.kind) {
      // Live data follows the switches too: watch time goes with "Watch history".
      case 'session': if ((await getOptions()).history) await upsertSession({ ...msg.session, updatedAt: Date.now() }); return { ok: true };
      case 'event': if ((await getOptions()).likes) await enqueue({ events: [msg.event] }); return { ok: true };
      case 'scraped': {
        await enqueue(msg.payload);
        if (msg.sync) await extendCoverage(msg.payload.history);
        if (msg.status) await patchStatus(msg.status);
        return { ok: true };
      }
      case 'shouldPageSync': {
        const s = await get('status', {});
        return { yes: !s.lastSync || Date.now() - s.lastSync.at > PAGE_SYNC_AFTER_MS };
      }
      case 'deepBackfill': return startDeep(msg.mode === 'update' ? 'update' : 'full');
      case 'deepProgress': {
        const { phaseDone, ...patch } = msg.patch;
        await patchDeep(patch);
        if (phaseDone) afterPhase(phaseDone); // not awaited: the next page takes a while
        // Cut short: keep what was read, leave the tab open to look at.
        else if (patch.running === false) await flush();
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
