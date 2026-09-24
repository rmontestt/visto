-- Video topics (YouTube topicDetails, Wikipedia slugs as a JSON array) and the Visto
-- theme derived from them (worker/src/themes.json). Apply once per database:
--   wrangler d1 execute visto-db --remote --config worker/wrangler.jsonc --file worker/migrations/002_themes.sql
ALTER TABLE videos ADD COLUMN topics TEXT;
ALTER TABLE videos ADD COLUMN theme TEXT;
-- Channels: official avatar from channels.list, subscription date from Mi actividad
-- ("Te has suscrito a"), current subscription from Takeout suscripciones.csv.
CREATE TABLE IF NOT EXISTS channels (
  channel_id      TEXT PRIMARY KEY,
  title           TEXT,
  handle          TEXT,
  avatar_url      TEXT,
  subscribed_at   INTEGER,
  subscribed_day  TEXT,
  subscribed      INTEGER,          -- 1 = in the latest suscripciones.csv
  fetched_at      INTEGER           -- NULL = avatar pending
);
-- Partial: only pending channels are indexed, so filling one costs no index write.
CREATE INDEX IF NOT EXISTS idx_channels_pending ON channels(fetched_at) WHERE fetched_at IS NULL;
CREATE TABLE IF NOT EXISTS dislikes (
  video_id  TEXT PRIMARY KEY,
  ts        INTEGER,
  day       TEXT,
  source    TEXT NOT NULL
);
