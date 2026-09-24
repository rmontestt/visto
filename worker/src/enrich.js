// Hourly metadata enrichment for videos we only know by id/title.
//
// With YOUTUBE_API_KEY: videos.list fills duration, category, channel id, publish date
// and topics (-> theme), 50 ids per call (1 quota unit each; the default quota is 10k
// units/day); channels.list then fills channel avatars and handles the same way.
// Without it: oEmbed fills title + channel for rows that have neither, nothing more.
// Production runs it from the cron; a local dashboard (`npm start`) triggers it itself.

import { themeFor, topicSlug } from './themes.js';

// Deleted or private videos are dropped from the dashboard entirely (user's choice).
// Only their tombstone in videos (meta_source = 'gone') is kept.
export const PURGE_TABLES = ['watches', 'likes', 'dislikes', 'saves'];
const purgeStatements = (db, id) =>
  PURGE_TABLES.map(t => db.prepare(`DELETE FROM ${t} WHERE video_id = ?1`).bind(id));

// Each enriched video costs ~2 D1 row writes (row + pending index) and the free plan
// allows 100k/day shared with other projects, so the hourly budget is small on
// purpose: ENRICH_API_CALLS (default 8) x 50 videos = 400/hour, ~19k writes/day.
const DEFAULT_API_CALLS = 8;
const DEFAULT_CHANNEL_CALLS = 2;
const OEMBED_PER_RUN = 40;

export async function enrich(env) {
  return env.YOUTUBE_API_KEY ? enrichWithApi(env) : enrichWithOembed(env);
}

async function enrichWithApi(env) {
  const videos = await enrichVideos(env);
  const channels = await enrichChannels(env);
  return { ...videos, channels };
}

async function enrichVideos(env) {
  const calls = Math.min(40, Number(env.ENRICH_API_CALLS) || DEFAULT_API_CALLS);
  const { results } = await env.DB.prepare(
    `SELECT video_id FROM videos WHERE meta_checked_at IS NULL ORDER BY rowid DESC LIMIT ?1`,
  ).bind(calls * 50).all();
  if (!results.length) return { done: 0 };

  const now = Date.now();
  const update = env.DB.prepare(`
    UPDATE videos SET
      title = ?2, channel_id = ?3, channel_title = ?4, duration_s = ?5,
      category_id = ?6, published_at = ?7, topics = ?9, theme = ?10,
      meta_source = 'api', meta_checked_at = ?8
    WHERE video_id = ?1`);
  const gone = env.DB.prepare(
    `UPDATE videos SET meta_source = 'gone', meta_checked_at = ?2 WHERE video_id = ?1`);
  // New channels get a row so enrichChannels can fetch their avatar (ignored if known).
  const channel = env.DB.prepare(`INSERT OR IGNORE INTO channels (channel_id, title) VALUES (?1, ?2)`);

  let done = 0;
  for (let i = 0; i < results.length; i += 50) {
    const ids = results.slice(i, i + 50).map(r => r.video_id);
    const api = new URL('https://www.googleapis.com/youtube/v3/videos');
    api.searchParams.set('part', 'snippet,contentDetails,topicDetails');
    api.searchParams.set('id', ids.join(','));
    api.searchParams.set('key', env.YOUTUBE_API_KEY);
    api.searchParams.set('fields', 'items(id,snippet(title,channelId,channelTitle,categoryId,publishedAt),contentDetails(duration),topicDetails(topicCategories))');
    const res = await fetch(api);
    if (!res.ok) {
      console.warn('videos.list failed', res.status, (await res.text()).slice(0, 300));
      break; // quota or key problem: retry next hour
    }
    const { items = [] } = await res.json();
    const found = new Set();
    const stmts = items.map(it => {
      found.add(it.id);
      const s = it.snippet || {};
      const topics = (it.topicDetails?.topicCategories || []).map(topicSlug);
      const cat = s.categoryId ? Number(s.categoryId) : null;
      return update.bind(it.id, s.title ?? null, s.channelId ?? null, s.channelTitle ?? null,
        isoDuration(it.contentDetails?.duration), cat, s.publishedAt ?? null, now,
        topics.length ? JSON.stringify(topics) : null, themeFor(topics, cat));
    });
    const seen = new Map(items.filter(it => it.snippet?.channelId).map(it => [it.snippet.channelId, it.snippet.channelTitle ?? null]));
    for (const [id, title] of seen) stmts.push(channel.bind(id, title));
    // Deleted or private videos simply do not come back.
    for (const id of ids) if (!found.has(id)) stmts.push(gone.bind(id, now), ...purgeStatements(env.DB, id));
    if (stmts.length) await env.DB.batch(stmts);
    done += ids.length;
  }
  return { done };
}

/** Official avatar + handle for channels we have not fetched yet, 50 per call. */
async function enrichChannels(env) {
  const calls = Math.min(40, Number(env.ENRICH_CHANNEL_CALLS) || DEFAULT_CHANNEL_CALLS);
  const { results } = await env.DB.prepare(
    `SELECT channel_id FROM channels WHERE fetched_at IS NULL LIMIT ?1`).bind(calls * 50).all();
  const now = Date.now();
  const update = env.DB.prepare(`UPDATE channels SET title = COALESCE(?2, title), handle = ?3, avatar_url = ?4, fetched_at = ?5
                                 WHERE channel_id = ?1`);
  const miss = env.DB.prepare(`UPDATE channels SET fetched_at = ?2 WHERE channel_id = ?1 AND fetched_at IS NULL`);
  let done = 0;
  for (let i = 0; i < results.length; i += 50) {
    const ids = results.slice(i, i + 50).map(r => r.channel_id);
    const api = new URL('https://www.googleapis.com/youtube/v3/channels');
    api.searchParams.set('part', 'snippet');
    api.searchParams.set('id', ids.join(','));
    api.searchParams.set('key', env.YOUTUBE_API_KEY);
    api.searchParams.set('fields', 'items(id,snippet(title,customUrl,thumbnails(default(url),medium(url))))');
    const res = await fetch(api);
    if (!res.ok) { console.warn('channels.list failed', res.status); break; }
    const { items = [] } = await res.json();
    const stmts = items.map(it => {
      const s = it.snippet || {};
      const th = s.thumbnails || {};
      return update.bind(it.id, s.title ?? null, s.customUrl ?? null, (th.medium || th.default || {}).url ?? null, now);
    });
    for (const id of ids) stmts.push(miss.bind(id, now)); // terminated channels: stop asking
    await env.DB.batch(stmts);
    done += ids.length;
  }
  return done;
}

async function enrichWithOembed(env) {
  const { results } = await env.DB.prepare(`
    SELECT video_id FROM videos
    WHERE meta_checked_at IS NULL AND meta_source IS NULL
      AND (title IS NULL OR channel_title IS NULL)
    LIMIT ?1`).bind(OEMBED_PER_RUN).all();
  const update = env.DB.prepare(`
    UPDATE videos SET title = COALESCE(?2, title), channel_title = COALESCE(?3, channel_title),
      meta_source = 'oembed' WHERE video_id = ?1`);
  const gone = env.DB.prepare(
    `UPDATE videos SET meta_source = 'gone', meta_checked_at = ?2 WHERE video_id = ?1`);
  const stmts = [];
  const now = Date.now();
  for (const { video_id } of results) {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${video_id}`)}`);
    if (res.ok) {
      const o = await res.json();
      stmts.push(update.bind(video_id, o.title ?? null, o.author_name ?? null));
    } else if (res.status === 404 || res.status === 400) {
      stmts.push(gone.bind(video_id, now), ...purgeStatements(env.DB, video_id));
    } else {
      // 401/403 = private or embedding disabled; keep what we have, stop retrying.
      stmts.push(update.bind(video_id, null, null));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { done: results.length };
}

/** "PT1H2M3S" / "P1DT2H" -> seconds; "P0D" (upcoming/live) -> null. */
export function isoDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s || '');
  if (!m) return null;
  const secs = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  return secs || null;
}
