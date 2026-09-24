-- Visto: canonical D1 schema. Every statement is idempotent so the file can be
-- re-applied with `wrangler d1 execute --file worker/schema.sql`.

-- One row per video we have ever seen. Fields fill in from whichever source knows
-- them first (extension, Takeout, oEmbed, YouTube Data API).
CREATE TABLE IF NOT EXISTS videos (
  video_id        TEXT PRIMARY KEY,
  title           TEXT,
  channel_id      TEXT,
  channel_title   TEXT,
  duration_s      INTEGER,
  category_id     INTEGER,
  published_at    TEXT,
  is_short        INTEGER,            -- 1 short, 0 regular, NULL unknown
  topics          TEXT,               -- JSON array of YouTube topic slugs (topicDetails)
  theme           TEXT,               -- Visto theme id from src/themes.json
  meta_source     TEXT,               -- 'api' | 'oembed' | 'gone' once enriched
  meta_checked_at INTEGER             -- NULL = pending enrichment
);
-- Partial: only videos pending enrichment are indexed (see migrations/004).
CREATE INDEX IF NOT EXISTS idx_videos_pending ON videos(meta_checked_at) WHERE meta_checked_at IS NULL;

-- A watch is "this video was opened on this local day". Several sources can report
-- the same (video, day); dashboards count DISTINCT (video_id, day).
--   takeout : exact ts from Google Takeout
--   history : scraped from youtube.com/feed/history by the extension (day only)
--   live    : measured by the extension while playing in Brave (ts + seconds)
CREATE TABLE IF NOT EXISTS watches (
  id         INTEGER PRIMARY KEY,
  video_id   TEXT NOT NULL,
  day        TEXT NOT NULL,            -- YYYY-MM-DD in the owner's time zone
  ts         INTEGER,                  -- epoch ms, NULL when only the day is known
  hour       INTEGER,                  -- local hour 0-23, NULL when ts unknown
  dow        INTEGER,                  -- local weekday 0=Mon..6=Sun, NULL when ts unknown
  seconds    INTEGER,                  -- measured playing seconds (live rows only)
  source     TEXT NOT NULL,
  product    TEXT NOT NULL DEFAULT 'youtube',  -- 'youtube' | 'music'
  dedup_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_watches_day ON watches(day, video_id);
CREATE INDEX IF NOT EXISTS idx_watches_video ON watches(video_id);

-- liked_at NULL means "liked before tracking started" (first scrape of the LL list).
CREATE TABLE IF NOT EXISTS likes (
  video_id  TEXT PRIMARY KEY,
  liked_at  INTEGER,
  day       TEXT,
  source    TEXT NOT NULL               -- 'll' (playlist scrape) | 'live' | 'takeout'
);


-- Channels: official avatar (channels.list), subscription date (Mi actividad
-- "Te has suscrito a") and current subscription (Takeout suscripciones.csv).
CREATE TABLE IF NOT EXISTS channels (
  channel_id      TEXT PRIMARY KEY,
  title           TEXT,
  handle          TEXT,
  avatar_url      TEXT,
  subscribed_at   INTEGER,
  subscribed_day  TEXT,
  subscribed      INTEGER,
  fetched_at      INTEGER
);
-- Partial: only pending channels are indexed, so filling one costs no index write.
CREATE INDEX IF NOT EXISTS idx_channels_pending ON channels(fetched_at) WHERE fetched_at IS NULL;

-- "No te ha gustado", dated, from Takeout Mi actividad (and live clicks later).
CREATE TABLE IF NOT EXISTS dislikes (
  video_id  TEXT PRIMARY KEY,
  ts        INTEGER,
  day       TEXT,
  source    TEXT NOT NULL
);

-- Saved-to-playlist ("favoritos"), from Takeout playlists and the extension.
CREATE TABLE IF NOT EXISTS saves (
  playlist_title TEXT NOT NULL,
  video_id       TEXT NOT NULL,
  ts             INTEGER,
  day            TEXT,
  PRIMARY KEY (playlist_title, video_id)
);

-- Sync bookkeeping, also used to show "last synced" and debug parser drift.
CREATE TABLE IF NOT EXISTS sync_log (
  id     INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  items  INTEGER NOT NULL DEFAULT 0,
  note   TEXT
);
