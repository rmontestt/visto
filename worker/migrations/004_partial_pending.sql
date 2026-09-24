-- Index only the rows still pending enrichment. With the full index every enriched
-- video or channel cost extra D1 row writes (index delete + insert); a partial index
-- costs one delete and nothing afterwards. ingest/push_prod.py drops the old index
-- before a bulk video sync and applies this file once the sync is complete, so the
-- new index is built over a handful of pending rows instead of all of them.
DROP INDEX IF EXISTS idx_videos_pending;
CREATE INDEX IF NOT EXISTS idx_videos_pending ON videos(meta_checked_at) WHERE meta_checked_at IS NULL;
DROP INDEX IF EXISTS idx_channels_pending;
CREATE INDEX IF NOT EXISTS idx_channels_pending ON channels(fetched_at) WHERE fetched_at IS NULL;
