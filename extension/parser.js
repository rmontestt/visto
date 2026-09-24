// Shared by the service worker (importScripts) and the content script (manifest list).
// Turns YouTube's ytInitialData / innertube JSON into flat video items without relying
// on exact paths: a recursive walk that recognises renderer/view-model nodes, so small
// layout changes keep working. Section headers ("Hoy", "Ayer", "lunes", "15 sept")
// become local calendar days.
(function (root) {
  'use strict';

  const MONTHS = {
    jan: 0, ene: 0, feb: 1, mar: 2, apr: 3, abr: 3, may: 4, jun: 5, jul: 6,
    aug: 7, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dec: 11, dic: 11,
  };
  // JS getDay(): 0 = Sunday
  const WEEKDAYS = {
    sunday: 0, domingo: 0, monday: 1, lunes: 1, tuesday: 2, martes: 2,
    wednesday: 3, 'miércoles': 3, miercoles: 3, thursday: 4, jueves: 4,
    friday: 5, viernes: 5, saturday: 6, 'sábado': 6, sabado: 6,
  };

  const pad = n => String(n).padStart(2, '0');
  const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function sectionToDay(title, now = new Date()) {
    if (!title) return null;
    const t = title.trim().toLowerCase().replace(/\s+/g, ' ');
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    const shift = n => { const d = new Date(base); d.setDate(d.getDate() - n); return localDay(d); };
    if (t === 'today' || t === 'hoy') return shift(0);
    if (t === 'yesterday' || t === 'ayer') return shift(1);
    if (t in WEEKDAYS) {
      for (let n = 1; n <= 7; n++) {
        const d = new Date(base); d.setDate(d.getDate() - n);
        if (d.getDay() === WEEKDAYS[t]) return localDay(d);
      }
    }
    // "15 sept" | "15 de septiembre de 2025" | "Sep 15" | "Sep 15, 2025"
    let day, mon, year;
    let m = /^(\d{1,2})\.?\s*(?:de\s+)?([a-záéíóú]+)\.?(?:,?\s*(?:de\s+)?(\d{4}))?$/.exec(t);
    if (m) [, day, mon, year] = m;
    else if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(t))) [, mon, day, year] = m;
    else return null;
    const mi = MONTHS[mon.slice(0, 3)];
    if (mi === undefined) return null;
    let y = year ? Number(year) : base.getFullYear();
    let d = new Date(y, mi, Number(day), 12);
    if (!year && d > base) d = new Date(y - 1, mi, Number(day), 12);
    return localDay(d);
  }

  function text(x) {
    if (!x) return null;
    if (typeof x === 'string') return x;
    if (typeof x.simpleText === 'string') return x.simpleText;
    if (Array.isArray(x.runs)) return x.runs.map(r => r.text).join('');
    if (typeof x.content === 'string') return x.content;
    return null;
  }

  function parseClock(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec((s || '').trim());
    return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : null;
  }

  /** Depth-first search for the first value satisfying pred(key, value). */
  function deepFind(node, pred, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 14) return undefined;
    for (const [k, v] of Object.entries(node)) {
      if (pred(k, v)) return v;
      const r = deepFind(v, pred, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  const clockIn = n => parseClock(deepFind(n, (k, v) => typeof v === 'string' && /^\d{1,2}(:\d{2}){1,2}$/.test(v.trim())));
  const channelIdIn = n => deepFind(n, (k, v) => k === 'browseId' && typeof v === 'string' && v.startsWith('UC'));
  const hasReel = n => deepFind(n, k => k === 'reelWatchEndpoint') !== undefined;

  function fromVideoRenderer(v) {
    const owner = v.ownerText || v.shortBylineText || v.longBylineText;
    return {
      videoId: v.videoId,
      title: text(v.title) || text(v.headline),
      channel: text(owner),
      channelId: owner?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,
      durationS: v.lengthSeconds ? Number(v.lengthSeconds) : (parseClock(text(v.lengthText)) ?? clockIn(v.thumbnailOverlays)),
      isShort: hasReel(v.navigationEndpoint) ? true : undefined,
    };
  }

  function fromLockup(v) {
    if (v.contentType && !/VIDEO|SHORT/.test(v.contentType)) return null;
    const md = v.metadata?.lockupMetadataViewModel;
    const rows = md?.metadata?.contentMetadataViewModel?.metadataRows || [];
    return {
      videoId: v.contentId,
      title: md?.title?.content ?? null,
      channel: rows[0]?.metadataParts?.[0]?.text?.content ?? null,
      channelId: channelIdIn(md) || null,
      durationS: clockIn(v.contentImage),
      isShort: hasReel(v.rendererContext) || /SHORT/.test(v.contentType || '') ? true : undefined,
    };
  }

  function fromShortsLockup(v) {
    const id = v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
      || (v.entityId || '').replace(/^shorts-shelf-item-/, '');
    return { videoId: id, title: v.overlayMetadata?.primaryText?.content ?? null, isShort: true };
  }

  /**
   * Walk any ytInitialData / continuation payload. Returns
   * { items: [{videoId, title, channel, channelId, durationS, isShort, section}], continuation }.
   */
  function extractItems(data, initialSection = null) {
    const items = [];
    let continuation = null;
    const seen = new Set();
    const push = (it, section) => {
      if (!it || !/^[\w-]{11}$/.test(it.videoId || '')) return;
      const key = `${it.videoId}|${section}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ ...it, section });
    };

    (function walk(node, section, depth) {
      if (!node || typeof node !== 'object' || depth > 40) return;
      if (Array.isArray(node)) { for (const n of node) walk(n, section, depth + 1); return; }
      for (const [k, v] of Object.entries(node)) {
        if (!v || typeof v !== 'object') continue;
        switch (k) {
          case 'itemSectionRenderer': {
            const title = text(v.header?.itemSectionHeaderRenderer?.title)
              || text(deepFind(v.header, (kk, vv) => kk === 'title' && text(vv)));
            walk(v.contents, title || section, depth + 1);
            continue;
          }
          case 'videoRenderer': case 'playlistVideoRenderer': case 'compactVideoRenderer':
          case 'gridVideoRenderer': case 'reelItemRenderer': {
            const it = fromVideoRenderer(v);
            if (k === 'reelItemRenderer') it.isShort = true;
            push(it, section);
            continue;
          }
          case 'lockupViewModel': push(fromLockup(v), section); continue;
          case 'shortsLockupViewModel': push(fromShortsLockup(v), section); continue;
          case 'continuationItemRenderer':
          case 'continuationItemViewModel': { // 2026 layout: .continuationCommand.innertubeCommand.continuationCommand.token
            continuation = v.continuationEndpoint?.continuationCommand?.token
              || deepFind(v, (kk, vv) => kk === 'token' && typeof vv === 'string') || continuation;
            continue;
          }
          case 'nextContinuationData': case 'reloadContinuationData': {
            // Older playlist layout: playlistVideoListRenderer.continuations[].nextContinuationData
            if (typeof v.continuation === 'string') continuation = continuation || v.continuation;
            continue;
          }
        }
        walk(v, section, depth + 1);
      }
    })(data, initialSection, 0);

    return { items, continuation };
  }

  /** Renderer/view-model key counts: a privacy-free fingerprint for debugging parser drift. */
  function shape(data) {
    const counts = {};
    (function walk(n, depth) {
      if (!n || typeof n !== 'object' || depth > 40) return;
      for (const [k, v] of Object.entries(n)) {
        if (/(Renderer|ViewModel)$/.test(k)) counts[k] = (counts[k] || 0) + 1;
        walk(v, depth + 1);
      }
    })(data, 0);
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40);
  }

  function extractInitialData(html) {
    const marker = html.search(/(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*\{/);
    if (marker < 0) return null;
    const start = html.indexOf('{', marker);
    const end = html.indexOf(';</script>', start);
    if (end < 0) return null;
    try { return JSON.parse(html.slice(start, end)); } catch { return null; }
  }

  function extractCfg(html) {
    const g = re => (re.exec(html) || [])[1];
    return {
      loggedIn: g(/"LOGGED_IN":(true|false)/) === 'true',
      clientVersion: g(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/),
      apiKey: g(/"INNERTUBE_API_KEY":"([^"]+)"/),
      hl: g(/"HL":"([^"]+)"/) || 'es',
      gl: g(/"GL":"([^"]+)"/) || 'ES',
      // Which signed-in Google account / brand channel this page belongs to. Without
      // these, innertube answers for authuser 0: the FIRST account in the browser.
      sessionIndex: g(/"SESSION_INDEX":"?(\d+)"?/) ?? '0',
      delegatedSessionId: g(/"DELEGATED_SESSION_ID":"([^"]+)"/),
      visitorData: g(/"VISITOR_DATA":"([^"]+)"/),
    };
  }

  // ---- innertube continuation (page context only: needs document.cookie) --------------

  async function sapisidHash() {
    const m = /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/.exec(root.document?.cookie || '');
    if (!m) return null;
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${m[1]} https://www.youtube.com`));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  async function browseContinuation(token, cfg) {
    const auth = await sapisidHash();
    if (!auth) throw new Error('no SAPISID cookie (continuation needs a YouTube tab)');
    const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?prettyPrint=false${cfg.apiKey ? `&key=${cfg.apiKey}` : ''}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        authorization: auth,
        'x-origin': 'https://www.youtube.com',
        'x-goog-authuser': cfg.sessionIndex,
        ...(cfg.delegatedSessionId ? { 'x-goog-pageid': cfg.delegatedSessionId } : {}),
        ...(cfg.visitorData ? { 'x-goog-visitor-id': cfg.visitorData } : {}),
        'x-youtube-client-name': '1',
        'x-youtube-client-version': cfg.clientVersion || '2.20260901.00.00',
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: cfg.clientVersion || '2.20260901.00.00', hl: cfg.hl, gl: cfg.gl, visitorData: cfg.visitorData },
          ...(cfg.delegatedSessionId ? { user: { onBehalfOfUser: cfg.delegatedSessionId } } : {}),
        },
        continuation: token,
      }),
    });
    if (!res.ok) throw new Error(`continuation HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Scrape a YouTube page (history feed or a playlist) plus up to `pages - 1`
   * continuations. `onPage(items)` streams results for long backfills.
   */
  // onPage may return 'stop' to end the walk early (an Update that caught up).
  async function scrape(url, { pages = 1, onPage, start } = {}) {
    let cfg, data, items, continuation, section = null, caughtUp = false;
    if (start?.token && start.cfg) {
      // Resume an interrupted walk straight from its saved continuation token.
      cfg = start.cfg;
      continuation = start.token;
      section = start.section ?? null;
      items = [];
    } else {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http' });
      const html = await res.text();
      cfg = extractCfg(html);
      if (!cfg.loggedIn) throw Object.assign(new Error('not logged in to YouTube'), { code: 'logged_out' });
      data = extractInitialData(html);
      if (!data) throw Object.assign(new Error('ytInitialData not found'), { code: 'parse' });
      ({ items, continuation } = extractItems(data));
      section = items[items.length - 1]?.section ?? null;
      caughtUp = (await onPage?.(items, 1, { continuation, cfg, section })) === 'stop';
    }
    // Streaming callers get every page through onPage; only keep items for the rest.
    const all = onPage ? null : [...items];
    let total = items.length;
    let diag = data && !items.length ? { url: url.replace(/\?.*/, ''), shape: shape(data) } : null;
    // Why paging stopped, as key paths only (no values): lets us fix drift remotely.
    let stop = caughtUp ? { reason: 'caught-up', pages: 1 } : { reason: continuation ? 'page-limit' : 'no-continuation', pages: 1 };
    if (!continuation && pages > 1 && data) stop.paths = continuationPaths(data);
    let lastJson = data;
    for (let p = 2; p <= pages && continuation && !caughtUp; p++) {
      let json;
      try {
        json = await browseContinuation(continuation, cfg);
      } catch (e) {
        stop = { reason: `error: ${e.message}`, pages: p - 1, token: continuation };
        break;
      }
      // A day can straddle two pages; headerless items inherit the previous section.
      const next = extractItems(json, section);
      continuation = next.continuation;
      lastJson = json;
      stop = { reason: continuation ? 'page-limit' : 'no-continuation', pages: p };
      if (!next.items.length) {
        stop = { reason: 'empty-page', pages: p, shape: shape(json), paths: continuationPaths(json) };
        break;
      }
      section = next.items[next.items.length - 1].section ?? section;
      total += next.items.length;
      all?.push(...next.items);
      if ((await onPage?.(next.items, p, { continuation, cfg, section })) === 'stop') {
        caughtUp = true;
        stop = { reason: 'caught-up', pages: p };
      }
    }
    // Stopped for lack of a token on a later page too: record where tokens-ish keys sit.
    if (stop.reason === 'no-continuation' && !stop.paths && pages > 1 && lastJson) stop.paths = continuationPaths(lastJson);
    if (pages > 1) diag = { ...(diag || {}), url: url.replace(/\?.*/, ''), items: total, stop };
    return { items: all || [], total, diag };
  }

  function continuationPaths(data) {
    const out = [];
    (function walk(n, path, depth) {
      if (!n || typeof n !== 'object' || depth > 30 || out.length >= 20) return;
      for (const [k, v] of Object.entries(n)) {
        const p = Array.isArray(n) ? `${path}[${k}]` : `${path}.${k}`;
        if (/continuation|^token$/i.test(k)) out.push(p.replace(/\[\d{2,}\]/g, '[n]'));
        walk(v, p, depth + 1);
      }
    })(data, '', 0);
    return out;
  }

  function historyItems(items, now = new Date()) {
    return items
      .map(it => ({ ...it, day: sectionToDay(it.section, now) }))
      .filter(it => it.day);
  }

  root.VistoParser = {
    sectionToDay, parseClock, extractItems, extractInitialData, extractCfg, shape,
    scrape, historyItems, localDay,
    HISTORY_URL: 'https://www.youtube.com/feed/history',
    LIKES_URL: 'https://www.youtube.com/playlist?list=LL',
    PLAYLISTS_URL: 'https://www.youtube.com/feed/playlists',
    // What the user lets Visto collect (popup switches); every kind is on by default.
    DEFAULT_OPTIONS: { history: true, likes: true, favorites: true },
    // Names YouTube gives the Favorites playlist (same list as the Worker's FAVORITES).
    FAVORITES: /^(favorites|favourites|favoritos|favoris|preferiti|favoriten)$/i,
  };
})(typeof self !== 'undefined' ? self : globalThis);
