import { json, localParts, isDay, isVideoId, clampStr } from './util.js';

const MAX_ITEMS = 5000;
// Names YouTube gives the Favorites playlist in the languages Visto reads.
export const FAVORITES = /^(favorites|favourites|favoritos|favoris|preferiti|favoriten)$/i;
const CHUNK = 200; // statements per D1 batch

/**
 * POST /api/ingest - everything the Brave extension collects, in one batch.
 * {
 *   history:  [{videoId, day, title, channel, channelId, durationS, isShort}],
 *   likes:    {mode: 'recent'|'baseline', items: [{videoId, title, channel, channelId, durationS}]},
 *   saves:    {playlist: 'Favorites', items: [{videoId, title, channel, channelId, durationS}]},
 *   sessions: [{videoId, startedAt, seconds, day, hour, dow, title, channel, durationS, isShort}],
 *   events:   [{type: 'like'|'unlike', videoId, ts, day}],   // comments are ignored by design
 *   diag:     {...}   // parser shape report when a scrape came back empty
 * }
 * Every write is idempotent (dedup keys / upserts), so the extension may resend freely.
 */
/**
 * GET /api/ingest - totals for the extension popup: videos watched (distinct video-day
 * pairs, the dashboard's unit), likes, favorites and the history's first and last day.
 * Cached per isolate for a minute: the popup asks each time it opens.
 */
let totalsMemo = null;
export async function ingestTotals(env) {
  if (totalsMemo && Date.now() - totalsMemo.at < 60_000) return json(totalsMemo.body);
  const row = await env.DB.prepare(`
    SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM watches GROUP BY day, video_id)) AS videos,
           (SELECT COUNT(*) FROM likes) AS likes,
           (SELECT COUNT(DISTINCT video_id) FROM saves
             WHERE lower(playlist_title) IN ('favorites', 'favourites', 'favoritos', 'favoris', 'preferiti', 'favoriten')) AS favorites,
           (SELECT MIN(day) FROM watches) AS first_day,
           (SELECT MAX(day) FROM watches) AS last_day`).first();
  totalsMemo = { at: Date.now(), body: row };
  return json(row);
}

export async function handleIngest(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

  const now = Date.now();
  const stmts = [];
  const counts = {};
  const videoStmt = env.DB.prepare(`
    INSERT INTO videos (video_id, title, channel_id, channel_title, duration_s, is_short)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(video_id) DO UPDATE SET
      title         = COALESCE(excluded.title, videos.title),
      channel_id    = COALESCE(videos.channel_id, excluded.channel_id),
      channel_title = COALESCE(excluded.channel_title, videos.channel_title),
      duration_s    = COALESCE(videos.duration_s, excluded.duration_s),
      is_short      = COALESCE(excluded.is_short, videos.is_short)
    -- Only touch the row when something actually changes: an upsert that rewrites the
    -- same values still counts against D1's daily row-write quota (100k on free).
    WHERE (excluded.title IS NOT NULL AND videos.title IS NOT excluded.title)
       OR (videos.channel_id IS NULL AND excluded.channel_id IS NOT NULL)
       OR (excluded.channel_title IS NOT NULL AND videos.channel_title IS NOT excluded.channel_title)
       OR (videos.duration_s IS NULL AND excluded.duration_s IS NOT NULL)
       OR (excluded.is_short IS NOT NULL AND videos.is_short IS NOT excluded.is_short)`);
  const upsertVideo = it => stmts.push(videoStmt.bind(
    it.videoId,
    clampStr(it.title, 300),
    typeof it.channelId === 'string' && /^UC[\w-]{22}$/.test(it.channelId) ? it.channelId : null,
    clampStr(it.channel, 200),
    Number.isFinite(it.durationS) && it.durationS > 0 ? Math.round(it.durationS) : null,
    it.isShort === true ? 1 : it.isShort === false ? 0 : null,
  ));

  // --- history scrape: day-level watches -------------------------------------------
  const history = arr(body.history).filter(it => isVideoId(it.videoId) && isDay(it.day));
  const histStmt = env.DB.prepare(
    `INSERT OR IGNORE INTO watches (video_id, day, source, dedup_key) VALUES (?1, ?2, 'history', ?3)`);
  for (const it of history) {
    upsertVideo(it);
    stmts.push(histStmt.bind(it.videoId, it.day, `h|${it.videoId}|${it.day}`));
  }
  counts.history = history.length;

  // --- live sessions: measured playing time ------------------------------------------
  const sessions = arr(body.sessions).filter(s =>
    isVideoId(s.videoId) && Number.isFinite(s.startedAt) && Number.isFinite(s.seconds) && s.seconds >= 5);
  const sessStmt = env.DB.prepare(`
    INSERT INTO watches (video_id, day, ts, hour, dow, seconds, source, dedup_key)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'live', ?7)
    ON CONFLICT(dedup_key) DO UPDATE SET seconds = MAX(watches.seconds, excluded.seconds)
    WHERE excluded.seconds > watches.seconds`);
  for (const s of sessions) {
    const p = localParts(s.startedAt, env.TZ);
    upsertVideo(s);
    stmts.push(sessStmt.bind(s.videoId, isDay(s.day) ? s.day : p.day, Math.round(s.startedAt),
      int(s.hour, 0, 23) ?? p.hour, int(s.dow, 0, 6) ?? p.dow,
      Math.min(Math.round(s.seconds), 6 * 3600), `l|${s.videoId}|${Math.round(s.startedAt)}`));
  }
  counts.sessions = sessions.length;

  // --- liked videos playlist (LL) scrape ------------------------------------------
  const likeItems = arr(body.likes?.items).filter(it => isVideoId(it.videoId));
  if (likeItems.length) {
    // The very first scrape (or an explicit deep backfill) is a baseline: we cannot know
    // when those likes happened. Afterwards anything new at the top was liked "now".
    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM likes WHERE source = 'll'`).first();
    const baseline = body.likes.mode === 'baseline' || n === 0;
    const today = localParts(now, env.TZ).day;
    const likeStmt = env.DB.prepare(
      `INSERT OR IGNORE INTO likes (video_id, liked_at, day, source) VALUES (?1, ?2, ?3, 'll')`);
    for (const it of likeItems) {
      upsertVideo(it);
      stmts.push(likeStmt.bind(it.videoId, baseline ? null : now, baseline ? null : today));
    }
  }
  counts.likes = likeItems.length;

  // --- Favorites playlist scrape (the only playlist Visto ever stores) ---------------
  // The page does not say when a video was added, so ts/day stay NULL; a Takeout import
  // of the same list fills the date in its own row (the dashboard merges both by video).
  const favTitle = typeof body.saves?.playlist === 'string' && FAVORITES.test(body.saves.playlist.trim())
    ? body.saves.playlist.trim().slice(0, 100) : null;
  const saveItems = favTitle ? arr(body.saves.items).filter(it => isVideoId(it.videoId)) : [];
  const saveStmt = env.DB.prepare(`INSERT OR IGNORE INTO saves (playlist_title, video_id) VALUES (?1, ?2)`);
  for (const it of saveItems) {
    upsertVideo(it);
    stmts.push(saveStmt.bind(favTitle, it.videoId));
  }
  counts.saves = saveItems.length;

  // --- live events: like / unlike clicks in Brave (comment events are dropped) -------------------------
  const events = arr(body.events).filter(e => isVideoId(e.videoId) && Number.isFinite(e.ts));
  const likeLive = env.DB.prepare(`
    INSERT INTO likes (video_id, liked_at, day, source) VALUES (?1, ?2, ?3, 'live')
    ON CONFLICT(video_id) DO UPDATE SET
      liked_at = COALESCE(likes.liked_at, excluded.liked_at),
      day      = COALESCE(likes.day, excluded.day)`);
  const unlike = env.DB.prepare(`DELETE FROM likes WHERE video_id = ?1`);
  for (const e of events) {
    const day = isDay(e.day) ? e.day : localParts(e.ts, env.TZ).day;
    if (e.type === 'like') stmts.push(likeLive.bind(e.videoId, Math.round(e.ts), day));
    else if (e.type === 'unlike') stmts.push(unlike.bind(e.videoId));
  }
  counts.events = events.length;

  const total = stmts.length;
  if (total > MAX_ITEMS * 3) return json({ error: 'payload too large' }, 413);

  const log = env.DB.prepare(`INSERT INTO sync_log (at, kind, items, note) VALUES (?1, ?2, ?3, ?4)`);
  for (const [kind, items] of Object.entries(counts)) {
    if (items) stmts.push(log.bind(now, kind, items, null));
  }
  if (body.diag) stmts.push(log.bind(now, 'diag', 0, JSON.stringify(body.diag).slice(0, 8000)));
  // A heartbeat row even for empty syncs, so the dashboard can show "last contact".
  stmts.push(log.bind(now, 'ping', 0, clampStr(body.client, 100)));

  for (let i = 0; i < stmts.length; i += CHUNK) await env.DB.batch(stmts.slice(i, i + CHUNK));
  totalsMemo = null;
  return json({ ok: true, counts });
}

function arr(x) {
  return Array.isArray(x) ? x.slice(0, MAX_ITEMS) : [];
}

function int(x, lo, hi) {
  return Number.isInteger(x) && x >= lo && x <= hi ? x : null;
}
