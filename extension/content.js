// Runs on www.youtube.com. Three jobs, each only if its switch is on in the popup:
//  1. measure real playing time of the current video (live sessions; "Watch history"),
//  2. notice like / unlike clicks ("Likes"; comments are never captured),
//  3. scrape history, likes and Favorites from page context when the service worker
//     cannot (and run the Full import phases the service worker asks for).
(() => {
  'use strict';
  // The service worker may inject this file into a tab that already has it.
  if (self.__vistoContent) return;
  self.__vistoContent = true;
  const P = self.VistoParser;
  const pad = n => String(n).padStart(2, '0');

  // What the user lets Visto collect, kept in sync with the popup's switches.
  let options = { ...P.DEFAULT_OPTIONS };
  chrome.storage.local.get('options').then(r => { options = { ...P.DEFAULT_OPTIONS, ...(r.options || {}) }; }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.options) options = { ...P.DEFAULT_OPTIONS, ...(ch.options.newValue || {}) };
  });

  const send = msg => {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); } // extension reloaded
  };

  function localStamp(ms) {
    const d = new Date(ms);
    return {
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hour: d.getHours(),
      dow: (d.getDay() + 6) % 7, // 0 = Monday
    };
  }

  function currentVideoId() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    const m = /^\/shorts\/([\w-]{11})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function playingVideo() {
    const vids = [...document.querySelectorAll('video')];
    return vids.find(v => !v.paused && !v.ended && v.readyState > 2) || null;
  }

  function isAdShowing() {
    return !!document.querySelector('.html5-video-player.ad-showing, .ytp-ad-player-overlay');
  }

  function pageMeta(isShort) {
    if (isShort) return {};
    const q = s => document.querySelector(s)?.textContent?.trim() || undefined;
    return {
      title: q('ytd-watch-metadata h1'),
      channel: q('ytd-watch-metadata ytd-channel-name a') || q('#owner ytd-channel-name a'),
    };
  }

  // ---- 1. live session tracking --------------------------------------------------
  let cur = null;
  let ticks = 0;

  function report(final) {
    if (!options.history || !cur || !cur.startedAt || cur.seconds < 5) return;
    const v = playingVideo() || document.querySelector('video');
    const meta = pageMeta(cur.isShort);
    if (meta.title) cur.title = meta.title;
    if (meta.channel) cur.channel = meta.channel;
    if (v && Number.isFinite(v.duration) && v.duration > 0 && !isAdShowing()) cur.durationS = Math.round(v.duration);
    send({ kind: 'session', session: { ...cur, ...localStamp(cur.startedAt), final: !!final } });
  }

  setInterval(() => {
    const vid = currentVideoId();
    if (!cur || cur.videoId !== vid) {
      report(true);
      cur = vid ? { videoId: vid, startedAt: null, seconds: 0, isShort: location.pathname.startsWith('/shorts/') } : null;
      ticks = 0;
    }
    if (!cur) return;
    if (playingVideo() && !isAdShowing()) {
      if (!cur.startedAt) cur.startedAt = Date.now();
      cur.seconds += 1;
    }
    if (++ticks % 20 === 0) report(false);
  }, 1000);

  addEventListener('pagehide', () => report(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) report(false); });

  // ---- 2. like clicks ---------------------------------------------------
  document.addEventListener('click', e => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const likeHost = t.closest('like-button-view-model, #like-button, ytd-toggle-button-renderer#like-button');
    if (likeHost && options.likes && !t.closest('dislike-button-view-model, #dislike-button')) {
      const vid = currentVideoId();
      if (!vid) return;
      // Read the new state once YouTube has toggled it.
      setTimeout(() => {
        const btn = likeHost.matches('button') ? likeHost : likeHost.querySelector('button[aria-pressed]');
        const pressed = btn?.getAttribute('aria-pressed');
        if (pressed === 'true' || pressed === 'false') {
          send({ kind: 'event', event: { type: pressed === 'true' ? 'like' : 'unlike', videoId: vid, ts: Date.now(), ...localStamp(Date.now()) } });
        }
      }, 600);
      return;
    }

  }, true);

  // ---- 3. page-context scraping ---------------------------------------------------
  // The first page of each list the user collects (the service worker does the same
  // when its own requests carry the YouTube session).
  async function pageSync() {
    const { status } = await chrome.storage.local.get('status');
    const none = { items: [] };
    const hist = options.history ? await P.scrape(P.HISTORY_URL) : none;
    const history = options.history ? P.historyItems(hist.items) : [];
    const likes = options.likes ? await P.scrape(P.LIKES_URL).catch(() => none) : none;
    const fav = status?.favorites?.url && options.favorites ? await P.scrape(status.favorites.url).catch(() => none) : none;
    const diag = hist.diag || likes.diag ? { history: hist.diag, likes: likes.diag } : undefined;
    const payload = { diag };
    if (options.history) payload.history = history;
    if (options.likes) payload.likes = { mode: 'recent', items: likes.items };
    if (fav.items.length) payload.saves = { playlist: status.favorites.name, items: fav.items };
    await send({
      kind: 'scraped',
      payload,
      status: { lastSync: { at: Date.now(), via: 'tab', history: history.length, likes: likes.items.length, favorites: fav.items.length }, lastError: null },
    });
  }

  // Deep import = let YouTube's own pages do the paging: scroll, wait, read the DOM.
  // Hand-built innertube continuations stop early on both history and playlists in
  // 2026, while the real page keeps loading as long as you scroll.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CARD = 'ytd-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer, '
    + 'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer';

  function videoIdOf(a) {
    const href = a.getAttribute('href') || '';
    const m = /[?&]v=([\w-]{11})/.exec(href) || /^\/shorts\/([\w-]{11})/.exec(href);
    return m ? m[1] : null;
  }

  function cardInfo(card, id, isShort) {
    const title = (card.querySelector('#video-title, h3 a, h3, [class*="Title"]')?.textContent
      || card.querySelector('a[title]')?.title || '').trim();
    const channel = (card.querySelector('ytd-channel-name a, a[href^="/@"], a[href*="/channel/"]')?.textContent
      || card.querySelector('[class*="metadata-row"] span, [class*="metadata-text"]')?.textContent || '').trim();
    const channelHref = card.querySelector('a[href*="/channel/UC"]')?.getAttribute('href') || '';
    const clock = [...card.querySelectorAll('badge-shape, #time-status, span')]
      .map(e => e.textContent.trim()).find(t => /^\d{1,2}(:\d{2}){1,2}$/.test(t));
    return {
      videoId: id, title: title || null, channel: isShort ? null : channel || null,
      channelId: /\/channel\/(UC[\w-]{22})/.exec(channelHref)?.[1] || null,
      durationS: P.parseClock(clock), isShort: isShort || undefined,
    };
  }

  function cardsIn(root) {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href*="/watch?v="], a[href^="/shorts/"]')) {
      const id = videoIdOf(a);
      if (!id || seen.has(id)) continue;
      const card = a.closest(CARD);
      if (!card) continue; // header "play all" buttons etc.
      seen.add(id);
      out.push(cardInfo(card, id, (a.getAttribute('href') || '').startsWith('/shorts/') || /shorts/i.test(card.tagName)));
    }
    return out;
  }

  function domPlaylistItems() {
    const root = document.querySelector('ytd-browse:not([hidden])') || document;
    return cardsIn(root);
  }

  /** History page: one section per day, headed "Hoy" / "lunes" / "12 jul". */
  const historyRoot = () => document.querySelector('ytd-browse[page-subtype="history"]') || document;
  let carryDay = null; // day of the last section pruned away, for a headerless successor

  function domHistoryItems() {
    const out = [];
    let lastDay = carryDay;
    for (const sec of historyRoot().querySelectorAll('ytd-item-section-renderer')) {
      // Only the section header: a card title like "Monday" must never be read as a day.
      const header = sec.querySelector('ytd-item-section-header-renderer') || sec.querySelector(':scope > #header');
      const head = (header?.querySelector('#title') || header)?.textContent?.trim();
      const day = P.sectionToDay(head) || lastDay; // a day split across loads keeps its header
      if (!day) continue;
      sec.dataset.vistoDay = day;
      lastDay = day;
      for (const it of cardsIn(sec)) out.push({ ...it, day });
    }
    return out;
  }

  // Tens of thousands of rendered cards crash the tab. Once a day section has been read,
  // drop it from the page; keep the last few because YouTube may still append to them.
  function pruneHistory() {
    const secs = [...historyRoot().querySelectorAll('ytd-item-section-renderer[data-visto-day]')];
    for (const sec of secs.slice(0, -3)) {
      carryDay = sec.dataset.vistoDay;
      sec.remove();
    }
  }

  /**
   * Scroll until nothing new loads; stream new items as they appear.
   * `skip(item)` = already imported by an earlier, interrupted run: counted, not resent,
   * and scrolled past faster.
   */
  async function scrollCollect({ collect, keyOf, onFresh, onRound, done, prune, skip, maxRounds = 6000 }) {
    const sent = new Set();
    let stable = 0, rounds = 0;
    while (rounds++ < maxRounds) {
      const fresh = collect().filter(it => !sent.has(keyOf(it)));
      fresh.forEach(it => sent.add(keyOf(it)));
      const toSend = skip ? fresh.filter(it => !skip(it)) : fresh;
      for (let i = 0; i < toSend.length; i += 200) await onFresh(toSend.slice(i, i + 200));
      stable = fresh.length ? 0 : stable + 1;
      await onRound(sent.size, fresh, fresh.length && !toSend.length);
      if (done?.(sent.size)) break;
      prune?.();
      // YouTube shows a continuation spinner while it is fetching the next chunk.
      const loading = !!document.querySelector('ytd-continuation-item-renderer, yt-continuation-item-view-model, tp-yt-paper-spinner[active]');
      if (stable >= (loading ? 12 : 5)) break;
      window.scrollTo(0, document.documentElement.scrollHeight);
      const skipping = fresh.length && !toSend.length;
      await sleep(stable ? 1800 : skipping ? 700 : 1100);
    }
    return { count: sent.size, rounds };
  }

  // History, step 1: innertube walk with the page's own account (see parser.extractCfg).
  // Costs no memory and saves its continuation token after every page, so a crash or a
  // closed tab resumes exactly where it stopped. Only if YouTube stops handing out pages
  // early do we fall back to scrolling the real page (domHistory).
  let apiHistoryRunning = false;
  async function deepHistory({ resume, resumeFrom }) {
    if (apiHistoryRunning) return;
    apiHistoryRunning = true;
    const progress = patch => send({ kind: 'deepProgress', patch });
    let h = 0, oldest = null, stop;
    try {
      const r = await P.scrape(P.HISTORY_URL, {
        pages: 50_000,
        start: resume,
        onPage: async (items, p, ctx) => {
          const history = P.historyItems(items);
          h += history.length;
          for (const it of history) if (!oldest || it.day < oldest) oldest = it.day;
          if (history.length) await send({ kind: 'scraped', payload: { history } });
          await progress({
            history: h, oldest,
            apiResume: ctx.continuation ? { token: ctx.continuation, cfg: ctx.cfg, section: ctx.section } : null,
            step: `reading history: page ${p}, ${h} videos, back to ${oldest || '…'}`,
          });
          // Be gentle between requests, but never through a timer in a hidden tab: Brave
          // throttles those to one per minute, which stalls the walk. The request and
          // message round trips already space pages out.
          if (!document.hidden) await sleep(250);
        },
      });
      stop = r.diag?.stop;
      await send({ kind: 'scraped', payload: { diag: { deep: true, historyApi: r.diag, resumed: !!resume?.token } } });
    } catch (e) {
      stop = { reason: `error: ${e.message}` };
    } finally {
      apiHistoryRunning = false;
    }
    if (stop?.reason === 'no-continuation') {
      await progress({ phaseDone: 'history', apiResume: null, history: h, oldest, step: 'history complete' });
      return;
    }
    // Paging broke (error, empty page...): scroll the page from the oldest day reached.
    await progress({ step: `the direct read stopped (${stop?.reason}); scrolling the page instead` });
    domHistory([oldest, resumeFrom].filter(Boolean).sort()[0] || null);
  }

  let domHistoryRunning = false;
  async function domHistory(resumeFrom) {
    if (domHistoryRunning) return;
    domHistoryRunning = true;
    const progress = patch => send({ kind: 'deepProgress', patch });
    let oldest = null;
    try {
      await sleep(2500);
      const r = await scrollCollect({
        collect: domHistoryItems,
        keyOf: it => `${it.videoId}|${it.day}`,
        // Days strictly newer than where the last run died are already in the database.
        skip: resumeFrom ? it => it.day > resumeFrom : null,
        prune: pruneHistory,
        onFresh: history => send({ kind: 'scraped', payload: { history } }),
        onRound: (n, fresh, skipping) => {
          for (const it of fresh) if (!oldest || it.day < oldest) oldest = it.day;
          const step = skipping
            ? `skipping what was already imported: ${oldest} (resumes at ${resumeFrom})`
            : `reading history: ${n} videos, back to ${oldest || '…'}`;
          return progress({ history: n, oldest, step });
        },
      });
      await send({ kind: 'scraped', payload: { diag: { deep: true, historyDom: { items: r.count, rounds: r.rounds, oldest } } } });
      await progress({ phaseDone: 'history', history: r.count, oldest, step: 'history complete' });
    } catch (e) {
      await progress({ running: false, error: e.message, step: 'reading the history failed' });
    } finally {
      domHistoryRunning = false;
    }
  }

  function declaredTotal() {
    // "3,354 videos" / "3354 vídeos" in the playlist header (older and newer layouts).
    for (const el of document.querySelectorAll('yt-page-header-renderer, ytd-playlist-header-renderer, ytd-browse:not([hidden])')) {
      const m = /(\d[\d.,\s]{0,8})\s*(?:vídeos|videos)\b/i.exec(el.innerText || '');
      if (m) return Number(m[1].replace(/[^\d]/g, '')) || null;
    }
    return null;
  }

  // The liked list loads 100 videos per batch while you scroll. It is finished when
  // YouTube shows no continuation spinner any more (videos YouTube hides as unavailable
  // never load, so the count can end below the declared total). A batch that never
  // arrives despite nudges for STALL_MS means YouTube stopped serving: that run is
  // reported as stopped, not finished, so the tab stays open and the next "Full import"
  // resumes at the likes.
  const STALL_MS = 90_000;
  const LOADING = 'ytd-continuation-item-renderer, yt-continuation-item-view-model, tp-yt-paper-spinner[active]';

  const LISTS = {
    likes: { label: 'liked videos', payload: items => ({ likes: { mode: 'baseline', items } }) },
    favorites: { label: 'Favorites', payload: (items, name) => ({ saves: { playlist: name, items } }) },
  };

  let domRunning = false;
  async function domPlaylist({ what, name }) {
    if (domRunning) return;
    domRunning = true;
    const list = LISTS[what];
    const sent = new Set();
    const progress = patch => send({ kind: 'deepProgress', patch });
    let total = null, rounds = 0, finished = false;
    try {
      await sleep(2500);
      let lastNew = Date.now(), nudges = 0;
      while (rounds++ < 3000) {
        total = total || declaredTotal();
        const fresh = domPlaylistItems().filter(it => !sent.has(it.videoId));
        if (fresh.length) {
          fresh.forEach(it => sent.add(it.videoId));
          for (let i = 0; i < fresh.length; i += 200) {
            await send({ kind: 'scraped', payload: list.payload(fresh.slice(i, i + 200), name) });
          }
          lastNew = Date.now();
          nudges = 0;
        }
        await progress({ [what]: sent.size, [`${what}Total`]: total, step: `reading ${list.label}: ${sent.size}${total ? ` of ${total}` : ''}` });
        if (total && sent.size >= total) { finished = true; break; }
        if (document.hidden) {
          // Browsers pause hidden tabs: waiting there is not YouTube being stuck.
          await sleep(1500);
          lastNew += 1500;
          continue;
        }
        const idle = Date.now() - lastNew;
        if (!document.querySelector(LOADING) && idle > 8000) { finished = true; break; }
        if (idle > STALL_MS) break;
        // Nudge: YouTube loads the next batch when its spinner scrolls into view, so after
        // a quiet spell scroll up a little and back down to make it fire again.
        if (idle > 10_000 * (nudges + 1)) {
          window.scrollBy(0, -1500);
          await sleep(400);
          nudges++;
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(fresh.length ? 1100 : 1800);
      }
      await send({ kind: 'scraped', payload: { diag: { deep: true, [`${what}Dom`]: { items: sent.size, total, rounds, finished } } } });
      if (finished) {
        await progress({ phaseDone: what, [what]: sent.size, step: `${list.label}: ${sent.size}${total ? ` of ${total}` : ''}` });
      } else {
        await progress({ running: false, error: `YouTube stopped loading more ${list.label}`,
          [what]: sent.size, step: `stopped at ${sent.size}${total ? ` of ${total}` : ''} ${list.label}; click Full import to resume them` });
      }
    } catch (e) {
      await progress({ running: false, error: e.message, [what]: sent.size, step: `reading ${list.label} failed after ${sent.size}` });
    } finally {
      domRunning = false;
    }
  }

  // On youtube.com/feed/playlists: the user's Favorites playlist, found by its name.
  async function findFavorites() {
    await sleep(2000);
    for (let i = 0; i < 10; i++) {
      for (const a of document.querySelectorAll('a[href*="list="]')) {
        const list = /[?&]list=([\w-]+)/.exec(a.getAttribute('href') || '')?.[1];
        const label = (a.textContent || a.getAttribute('title') || '').trim();
        if (list && P.FAVORITES.test(label)) return { url: `https://www.youtube.com/playlist?list=${list}`, name: label };
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1000);
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.kind === 'ping') { reply({ ok: true, url: location.href }); return; }
    if (msg.kind === 'deepHistory') { deepHistory(msg); reply({ started: true }); return; }
    if (msg.kind === 'domPlaylist') { domPlaylist(msg); reply({ started: true }); return; }
    if (msg.kind === 'findFavorites') { findFavorites().then(reply, () => reply(null)); return true; }
  });

  // Only the top frame, and only once per page load.
  if (window.top === window) {
    setTimeout(async () => {
      const r = await send({ kind: 'shouldPageSync' });
      if (r?.yes) pageSync().catch(e => send({ kind: 'scraped', payload: {}, status: { lastError: `tab: ${e.message}` } }));
    }, 8000);
  }
})();
