-- The user decided comments are too personal to keep: drop them and never store them
-- again (extension no longer captures them, ingest drops them, importer skips them).
DROP INDEX IF EXISTS idx_comments_video;
DROP TABLE IF EXISTS comments;
