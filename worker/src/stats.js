import { json, todayLocal, addDays, isDay } from './util.js';
import { THEME_LIST, THEME_IDS } from './themes.js';

// ?theme=<id> narrows every watches scan to that theme. Ids are whitelisted from
// themes.json, so inlining them is safe (and keeps the ?1/?2 binds uniform).
function themeFilter(url) {
  const t = url.searchParams.get('theme');
  return THEME_IDS.has(t) ? `AND video_id IN (SELECT video_id FROM videos WHERE theme = '${t}')` : '';
}

// One row per (video, local day): the unit every dashboard number is counted in.
// Several sources may report the same pair; this collapses them.
const WD = (tf = '') => `
  wd AS (
    SELECT video_id, day,
           MIN(ts) AS ts,
           MIN(id) AS first_id,
           SUM(CASE WHEN source = 'live' THEN seconds END) AS secs,
           MAX(product = 'music') AS music,
           group_concat(DISTINCT source) AS sources
    FROM watches
    WHERE day BETWEEN ?1 AND ?2 ${tf}
    GROUP BY video_id, day
  )`;

// Shorts: explicit flag when a source knew it, otherwise the 60-second heuristic for
// uploads from the Shorts era. Nothing watched before Shorts existed (launch
// 2020-09-14) is a Short, even if YouTube flags that video as one today.
const SHORTS_SINCE = '2020-09-14';
const FORMAT = `
  CASE WHEN wd.music THEN 'music'
       WHEN wd.day >= '${SHORTS_SINCE}' AND (v.is_short = 1 OR (v.is_short IS NULL AND v.duration_s <= 60
            AND v.published_at >= '${SHORTS_SINCE}')) THEN 'short'
       WHEN v.is_short IS NOT NULL OR v.duration_s IS NOT NULL THEN 'video'
       ELSE 'unknown' END`;

const MAX_EST_S = 3 * 3600; // cap long streams so one 10h live does not dominate the estimate

// Estimated time per (video, day) from timed views: the gap until the next view,
// never more than the video's length (30 min if unknown) nor MAX_EST_S; a view with
// no next one within 6 h is assumed watched to the end. Live rows (measured in
// Brave) are kept apart in `live` and win over the estimate for their pair.
// Binds ?1..?2 = day range; the window looks one day past each edge.
const GAP_EST = (tf = '') => `
  tv AS (
    SELECT video_id, day, ts, LEAD(ts) OVER (ORDER BY ts) AS next_ts
    FROM watches
    WHERE ts IS NOT NULL AND source <> 'live' AND day BETWEEN date(?1, '-1 day') AND date(?2, '+1 day') ${tf}
  ),
  gap AS (
    SELECT tv.video_id, tv.day,
           SUM(MIN(COALESCE(v.duration_s, 1800), ${MAX_EST_S},
                   CASE WHEN tv.next_ts IS NULL OR tv.next_ts - tv.ts > 21600000
                        THEN COALESCE(v.duration_s, 0)
                        ELSE (tv.next_ts - tv.ts) / 1000 END)) AS s
    FROM tv LEFT JOIN videos v ON v.video_id = tv.video_id
    WHERE tv.day BETWEEN ?1 AND ?2
    GROUP BY tv.video_id, tv.day
  ),
  live AS (
    SELECT video_id, day, SUM(seconds) AS s FROM watches
    WHERE source = 'live' AND day BETWEEN ?1 AND ?2 ${tf} GROUP BY video_id, day
  )`;

function resolveRange(url, tz) {
  const today = todayLocal(tz);
  let to = url.searchParams.get('to');
  let from = url.searchParams.get('from');
  if (!isDay(to)) to = today;
  if (!isDay(from)) from = addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  return { from, to, today };
}

const minusYear = d => (d.slice(5) === '02-29' ? `${+d.slice(0, 4) - 1}-02-28` : `${+d.slice(0, 4) - 1}${d.slice(4)}`);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

/** GET /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function summary(url, env) {
  const { from, to, today } = resolveRange(url, env.TZ);
  const span = daysBetween(from, to);
  // A year (or its elapsed part) compares with the same dates one year earlier;
  // any other window with the equally long window right before it.
  const yearly = from.endsWith('-01-01') && from.slice(0, 4) === to.slice(0, 4);
  const prevTo = yearly ? minusYear(to) : addDays(from, -1);
  const prevFrom = yearly ? minusYear(from) : addDays(prevTo, -(span - 1));
  const db = env.DB;
  const q = (sql, ...extra) => db.prepare(sql).bind(from, to, ...extra);
  const tf = themeFilter(url);

  const [kpi, time, series, hourWeek, formats, likes, prev, meta, themeDist] =
    await db.batch([
      q(`WITH ${WD(tf)}
         SELECT COUNT(*) AS views,
                COUNT(DISTINCT wd.video_id) AS uniq,
                COUNT(DISTINCT COALESCE(v.channel_id, v.channel_title)) AS channels,
                COUNT(DISTINCT wd.day) AS active_days,
                COALESCE(SUM(wd.secs), 0) AS measured_s,
                COALESCE(SUM(CASE WHEN wd.secs IS NOT NULL THEN 1 END), 0) AS measured_n,
                COALESCE(SUM(MIN(v.duration_s, ${MAX_EST_S})), 0) AS est_s,
                COALESCE(SUM(v.duration_s IS NOT NULL), 0) AS with_duration,
                -- pairs with no time at all can only fall back to the video's length
                COALESCE(SUM(CASE WHEN wd.ts IS NULL THEN MIN(v.duration_s, ${MAX_EST_S}) END), 0) AS untimed_dur_s,
                COALESCE(SUM(wd.ts IS NULL), 0) AS untimed_n
         FROM wd LEFT JOIN videos v ON v.video_id = wd.video_id`),
      // Watch time per day. Per (video, day): seconds measured in Brave, else the gap
      // to the next view (GAP_EST), else the video's length for views with no time.
      q(`WITH ${GAP_EST(tf)}, ${WD(tf)}
         SELECT wd.day AS d,
                SUM(COALESCE(l.s, g.s, CASE WHEN wd.ts IS NULL THEN MIN(v.duration_s, ${MAX_EST_S}) END, 0)) AS s,
                COALESCE(SUM(l.s), 0) AS m
         FROM wd LEFT JOIN live l ON l.video_id = wd.video_id AND l.day = wd.day
         LEFT JOIN gap g ON g.video_id = wd.video_id AND g.day = wd.day
         LEFT JOIN videos v ON v.video_id = wd.video_id
         GROUP BY wd.day`),
      q(`WITH ${WD(tf)}
         SELECT wd.day AS d, COUNT(*) AS n,
                SUM(${FORMAT} = 'short') AS shorts
         FROM wd LEFT JOIN videos v ON v.video_id = wd.video_id
         GROUP BY wd.day ORDER BY wd.day`),
      q(`SELECT dow, hour, COUNT(*) AS n FROM (
           SELECT MIN(dow) AS dow, MIN(hour) AS hour FROM watches
           WHERE day BETWEEN ?1 AND ?2 AND hour IS NOT NULL ${tf}
           GROUP BY video_id, day)
         GROUP BY dow, hour`),
      q(`WITH ${WD(tf)}
         SELECT ${FORMAT} AS f, COUNT(*) AS n
         FROM wd LEFT JOIN videos v ON v.video_id = wd.video_id GROUP BY f`),
      q(`WITH ${WD(tf)}
         SELECT (SELECT COUNT(*) FROM likes WHERE day BETWEEN ?1 AND ?2) AS in_range,
                (SELECT COUNT(*) FROM likes) AS total,
                (SELECT COUNT(DISTINCT wd.video_id) FROM wd JOIN likes l ON l.video_id = wd.video_id) AS watched_liked`),
      db.prepare(`SELECT COUNT(*) AS views FROM (
                    SELECT 1 FROM watches WHERE day BETWEEN ?1 AND ?2 ${tf} GROUP BY video_id, day)`)
        .bind(prevFrom, prevTo),
      db.prepare(`SELECT (SELECT MIN(day) FROM watches) AS first_day,
                         (SELECT MAX(day) FROM watches) AS last_day,
                         (SELECT MAX(at) FROM sync_log WHERE kind = 'ping') AS last_ping,
                         (SELECT MAX(at) FROM sync_log WHERE kind = 'history') AS last_history,
                         (SELECT COUNT(*) FROM videos WHERE meta_checked_at IS NULL) AS pending_meta`),
      // Theme mix of the range, always unfiltered so it doubles as the filter menu.
      q(`WITH ${WD()}
         SELECT COALESCE(v.theme, 'pending') AS id, COUNT(*) AS n
         FROM wd LEFT JOIN videos v ON v.video_id = wd.video_id GROUP BY id ORDER BY n DESC`),
    ]);

  const secsByDay = new Map(time.results.map(r => [r.d, r.s]));
  return json({
    range: { from, to, today, days: span, prevFrom, prevTo },
    kpi: { ...kpi.results[0], prev_views: prev.results[0].views },
    // Estimated watch time = measured (Brave) + gap-to-next-view (timed views)
    // + video length for views with no time at all. See GAP_EST.
    time: {
      measured_s: time.results.reduce((a, r) => a + r.m, 0),
      untimed_dur_s: kpi.results[0].untimed_dur_s,
      untimed_n: kpi.results[0].untimed_n,
      total_s: time.results.reduce((a, r) => a + r.s, 0),
    },
    // n = videos (distinct pairs), shorts, s = estimated seconds watched that day.
    series: series.results.map(r => ({ ...r, s: secsByDay.get(r.d) || 0 })),
    hourWeek: hourWeek.results,
    formats: formats.results,
    themes: { list: THEME_LIST, active: THEME_IDS.has(url.searchParams.get('theme')) ? url.searchParams.get('theme') : null, dist: themeDist.results },
    likes: likes.results[0],
    // Streaks inside the active period (and theme): the record is the period's record.
    streak: streaks(series.results.map(r => r.d), today),
    meta: meta.results[0],
  });
}

function streaks(days, today) {
  let longest = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  // The current streak is still alive if the last active day is today or yesterday.
  const alive = prev === today || prev === addDays(today, -1);
  return { current: alive ? run : 0, longest, lastActive: prev };
}

/** GET /api/calendar?year=YYYY  (default: the 53 weeks ending today) */
export async function calendar(url, env) {
  const tf = themeFilter(url);
  const today = todayLocal(env.TZ);
  const year = url.searchParams.get('year');
  let from, to;
  if (/^\d{4}$/.test(year || '')) { from = `${year}-01-01`; to = `${year}-12-31`; }
  else { to = today; from = addDays(today, -370); }
  const [days, years] = await env.DB.batch([
    env.DB.prepare(`SELECT day AS d, COUNT(*) AS n FROM (
                      SELECT day FROM watches WHERE day BETWEEN ?1 AND ?2 ${tf} GROUP BY video_id, day)
                    GROUP BY day`).bind(from, to),
    env.DB.prepare(`SELECT DISTINCT substr(day, 1, 4) AS y FROM watches ORDER BY y DESC`),
  ]);
  return json({ from, to, today, days: days.results, years: years.results.map(r => r.y) });
}

// Per-video flags shown as icons on every list row. Only the Favorites playlist is
// ever exposed (other playlists and comments stay private even on a public dashboard).
const FAV = `('favorites', 'favoritos')`;
const ROW = `
  wd.video_id, wd.day, wd.ts, wd.secs, wd.music,
  v.title, v.channel_title, v.channel_id, v.duration_s, v.is_short, v.theme,
  ${FORMAT} AS format,
  (l.video_id IS NOT NULL) AS liked,
  (dl.video_id IS NOT NULL) AS disliked,
  EXISTS (SELECT 1 FROM saves s WHERE s.video_id = wd.video_id AND lower(s.playlist_title) IN ${FAV}) AS favorite,
  (SELECT COUNT(DISTINCT day) FROM watches w2 WHERE w2.video_id = wd.video_id) AS total_days,
  (SELECT MIN(day) FROM watches w3 WHERE w3.video_id = wd.video_id) AS first_day`;
const ROW_JOINS = `
  LEFT JOIN videos v ON v.video_id = wd.video_id
  LEFT JOIN likes l ON l.video_id = wd.video_id
  LEFT JOIN dislikes dl ON dl.video_id = wd.video_id`;

/** GET /api/day?d=YYYY-MM-DD - the diary page: every video opened that day. */
export async function day(url, env) {
  const tf = themeFilter(url);
  const d = isDay(url.searchParams.get('d')) ? url.searchParams.get('d') : todayLocal(env.TZ);
  const db = env.DB;
  const [videos, likedToday, nav, gaps] = await db.batch([
    db.prepare(`WITH ${WD(tf)}
      SELECT ${ROW} FROM wd ${ROW_JOINS}
      ORDER BY wd.ts IS NULL, wd.ts DESC, wd.first_id ASC`).bind(d, d),
    db.prepare(`SELECT l.video_id, l.liked_at, v.title, v.channel_title FROM likes l
                LEFT JOIN videos v ON v.video_id = l.video_id
                WHERE l.day = ?1 ORDER BY l.liked_at DESC`).bind(d),
    db.prepare(`SELECT (SELECT MAX(day) FROM watches WHERE day < ?1 ${tf}) AS prev,
                       (SELECT MIN(day) FROM watches WHERE day > ?1 ${tf}) AS next`).bind(d),
    db.prepare(`WITH ${GAP_EST(tf)} SELECT video_id, s FROM gap`).bind(d, d),
  ]);
  const est = new Map(gaps.results.map(r => [r.video_id, r.s]));
  return json({
    day: d,
    videos: videos.results.map(v => ({ ...v, est_s: est.get(v.video_id) ?? null })),
    likes: likedToday.results,
    prev: nav.results[0].prev,
    next: nav.results[0].next,
  });
}

/**
 * GET /api/videos?from&to[&theme][&dow&hour][&channel][&page]
 * Every (video, day) in a selection, newest first: what a click on a chart shows.
 */
/** ?from&to when given (both valid days), otherwise no bound: '' / '9999-12-31'. */
function optionalRange(url) {
  const f = url.searchParams.get('from'), t = url.searchParams.get('to');
  return isDay(f) && isDay(t) ? { from: f, to: t } : { from: '', to: '9999-12-31' };
}

function selectionFilters(url) {
  const dow = Number(url.searchParams.get('dow'));
  const hour = Number(url.searchParams.get('hour'));
  // Whitelisted integers only, so they can be inlined next to the theme filter.
  const slot = url.searchParams.has('dow') && Number.isInteger(dow) && dow >= 0 && dow <= 6
    && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? `AND dow = ${dow} AND hour = ${hour}` : '';
  const channel = (url.searchParams.get('channel') || '').slice(0, 200);
  return { slot, channel };
}

export async function videos(url, env) {
  const { from, to } = resolveRange(url, env.TZ);
  const tf = themeFilter(url);
  const { slot, channel } = selectionFilters(url);
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const size = Math.min(40, Math.max(1, Number(url.searchParams.get('size')) || 40));
  const wd = `wd AS (
    SELECT video_id, day, MIN(ts) AS ts, MIN(id) AS first_id,
           SUM(CASE WHEN source = 'live' THEN seconds END) AS secs, MAX(product = 'music') AS music
    FROM watches WHERE day BETWEEN ?1 AND ?2 ${tf} ${slot}
    GROUP BY video_id, day)`;
  const byChannel = `(?3 = '' OR v.channel_id = ?3 OR (v.channel_id IS NULL AND v.channel_title = ?3))`;
  const db = env.DB;
  // ?total=N: the caller already knows the count (the summary's views), skip it.
  const known = url.searchParams.has('total') ? Number(url.searchParams.get('total')) : NaN;
  const [rows, count] = await db.batch([
    // Pick the page first, then decorate only those rows: ROW's per-row subqueries
    // over the whole period would cost seconds under "Todo".
    db.prepare(`WITH ${wd}, pg AS (
                  SELECT wd.* FROM wd LEFT JOIN videos v ON v.video_id = wd.video_id WHERE ${byChannel}
                  ORDER BY wd.day DESC, wd.ts IS NULL, wd.ts DESC, wd.first_id ASC
                  LIMIT ${size} OFFSET ?4)
                SELECT ${ROW} FROM pg AS wd ${ROW_JOINS}
                ORDER BY wd.day DESC, wd.ts IS NULL, wd.ts DESC, wd.first_id ASC`).bind(from, to, channel, page * size),
    ...(Number.isInteger(known) && known >= 0 && !slot && !channel ? [] : [
      db.prepare(`WITH ${wd} SELECT COUNT(*) AS n FROM wd LEFT JOIN videos v ON v.video_id = wd.video_id
                  WHERE ${byChannel}`).bind(from, to, channel)]),
  ]);
  const total = count ? count.results[0].n : known;
  return json({ from, to, items: rows.results, total, page, pages: Math.ceil(total / size) });
}

/** GET /api/channels?from&to[&theme][&page] - most watched channels, 5 per page. */
export async function channels(url, env) {
  const { from, to } = resolveRange(url, env.TZ);
  const tf = themeFilter(url);
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const size = 5;
  const db = env.DB;
  const [rows, count] = await db.batch([
    db.prepare(`WITH ${WD(tf)}
      SELECT v.channel_title AS channel, MAX(v.channel_id) AS channel_id,
             MAX(c.avatar_url) AS avatar,
             COUNT(*) AS n, COUNT(DISTINCT wd.video_id) AS uniq, MAX(wd.day) AS last_day
      FROM wd JOIN videos v ON v.video_id = wd.video_id
      LEFT JOIN channels c ON c.channel_id = v.channel_id
      WHERE v.channel_title IS NOT NULL
      GROUP BY COALESCE(v.channel_id, v.channel_title)
      ORDER BY n DESC, channel LIMIT ?3 OFFSET ?4`).bind(from, to, size, page * size),
    db.prepare(`WITH ${WD(tf)}
      SELECT COUNT(DISTINCT COALESCE(v.channel_id, v.channel_title)) AS n
      FROM wd JOIN videos v ON v.video_id = wd.video_id WHERE v.channel_title IS NOT NULL`).bind(from, to),
  ]);
  const total = count.results[0].n;
  return json({ items: rows.results, total, page, pages: Math.ceil(total / size) });
}

/**
 * GET /api/rewatched?from&to[&theme][&dow&hour][&channel]
 * Videos you watched more than once inside the current selection. Views per
 * (video, day) = distinct start times, taking the larger of the Takeout/history
 * count and the live (Brave) count so one viewing seen by both is not doubled.
 */
export async function rewatched(url, env) {
  const { from, to } = resolveRange(url, env.TZ);
  const tf = themeFilter(url);
  const { slot, channel } = selectionFilters(url);
  const { results } = await env.DB.prepare(`
    WITH pv AS (
      SELECT video_id, day,
             MAX(1, COUNT(DISTINCT CASE WHEN source <> 'live' THEN ts END),
                    COUNT(DISTINCT CASE WHEN source = 'live' THEN ts END)) AS views
      FROM watches WHERE day BETWEEN ?1 AND ?2 ${tf} ${slot}
      GROUP BY video_id, day)
    SELECT pv.video_id, v.title, v.channel_title,
           SUM(pv.views) AS views, COUNT(*) AS days, MAX(pv.day) AS last_day
    FROM pv LEFT JOIN videos v ON v.video_id = pv.video_id
    WHERE (?3 = '' OR v.channel_id = ?3 OR (v.channel_id IS NULL AND v.channel_title = ?3))
    GROUP BY pv.video_id
    -- spelled out: a bare "views" alias here would resolve to pv.views of one row
    HAVING SUM(pv.views) > 1
    ORDER BY SUM(pv.views) DESC, MAX(pv.day) DESC LIMIT 8`).bind(from, to, channel).all();
  return json({ from, to, items: results });
}

/** GET /api/saves?page=0&sort=recent|watched - the Favorites playlist only. */
export async function saves(url, env) {
  const db = env.DB;
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const size = 5;
  // sort = recent (date saved) | watched (days you watched it); dir = desc | asc
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const order = url.searchParams.get('sort') === 'watched'
    ? `days_watched ${dir}, s.ts DESC`
    : `s.ts IS NULL, s.ts ${dir}, s.rowid ${dir}`;
  const { from, to } = optionalRange(url);
  // Same theme whitelist as everywhere; here it applies to the saved video itself.
  const tf = themeFilter(url).replace('AND video_id IN', 'AND s.video_id IN');
  const where = `lower(s.playlist_title) IN ${FAV} AND COALESCE(s.day, '') BETWEEN ?1 AND ?2 ${tf}`;
  const [items, count] = await db.batch([
    db.prepare(`
      SELECT s.video_id, s.day, v.title, v.channel_title, v.duration_s,
             (SELECT COUNT(DISTINCT day) FROM watches w WHERE w.video_id = s.video_id) AS days_watched,
             (l.video_id IS NOT NULL) AS liked
      FROM saves s LEFT JOIN videos v ON v.video_id = s.video_id LEFT JOIN likes l ON l.video_id = s.video_id
      WHERE ${where}
      ORDER BY ${order} LIMIT ?3 OFFSET ?4`).bind(from, to, size, page * size),
    db.prepare(`SELECT COUNT(*) AS n FROM saves s WHERE ${where}`).bind(from, to),
  ]);
  const total = count.results[0].n;
  return json({ items: items.results, total, page, pages: Math.ceil(total / size) });
}

/** GET /api/themes - theme mix per year over the whole history (range-independent). */
export async function themesByYear(url, env) {
  const { results } = await env.DB.prepare(`
    SELECT substr(p.day, 1, 4) AS y, COALESCE(v.theme, 'pending') AS id, COUNT(*) AS n
    FROM (SELECT video_id, day FROM watches GROUP BY video_id, day) p
    LEFT JOIN videos v ON v.video_id = p.video_id
    GROUP BY y, id ORDER BY y`).all();
  return json({ list: THEME_LIST, rows: results });
}

/** GET /api/subs?page=0&sort=recent|watched - subscriptions with official avatars. */
export async function subs(url, env) {
  const db = env.DB;
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const size = 5;
  const byWatched = url.searchParams.get('sort') === 'watched';
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  // Watched = (video, day) pairs of that channel, all time. One pass over watches,
  // cached with the rest of the API.
  const { from, to } = optionalRange(url);
  const bounded = from !== '';
  // Unbounded: every subscription (dated or not). Bounded: those made in the period.
  const where = bounded
    ? `c.subscribed_day BETWEEN ?1 AND ?2`
    : `(c.subscribed = 1 OR c.subscribed_at IS NOT NULL) AND ?1 = ?1 AND ?2 = ?2`;
  const [items, totals] = await db.batch([
    db.prepare(`
      WITH seen AS (
        SELECT v.channel_id, COUNT(*) AS n
        FROM (SELECT video_id, day FROM watches WHERE day BETWEEN ?1 AND ?2 GROUP BY video_id, day) p
        JOIN videos v ON v.video_id = p.video_id
        WHERE v.channel_id IS NOT NULL GROUP BY v.channel_id)
      SELECT c.channel_id, c.title, c.handle, c.avatar_url, c.subscribed_day, c.subscribed,
             COALESCE(seen.n, 0) AS watched
      FROM channels c LEFT JOIN seen ON seen.channel_id = c.channel_id
      WHERE ${where}
      ORDER BY ${byWatched ? `watched ${dir}, c.subscribed_at DESC` : `c.subscribed_at IS NULL, c.subscribed_at ${dir}`}
      LIMIT ?3 OFFSET ?4`).bind(from, to, size, page * size),
    db.prepare(`SELECT COUNT(*) AS n, SUM(subscribed = 1) AS current FROM channels c WHERE ${where}`).bind(from, to),
  ]);
  const total = totals.results[0].n;
  return json({ items: items.results, total, current: totals.results[0].current,
                page, pages: Math.ceil(total / size) });
}

/** GET /api/search?q=text */
export async function search(url, env) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return json({ results: [] });
  const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;
  const { results } = await env.DB.prepare(`
    SELECT v.video_id, v.title, v.channel_title, v.duration_s,
           COUNT(DISTINCT w.day) AS days, MAX(w.day) AS last_day, MIN(w.day) AS first_day
    FROM videos v JOIN watches w ON w.video_id = v.video_id
    WHERE v.title LIKE ?1 ESCAPE '\\' OR v.channel_title LIKE ?1 ESCAPE '\\'
    GROUP BY v.video_id ORDER BY last_day DESC LIMIT 40`).bind(like).all();
  return json({ q, results });
}
