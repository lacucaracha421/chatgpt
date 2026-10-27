-- The Settings snapshot counts queue entries without scanning media rows.
CREATE INDEX IF NOT EXISTS auto_jobs_similarity_pending ON assets(id)
 WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL;
CREATE INDEX IF NOT EXISTS auto_jobs_similarity_failed ON assets(id)
 WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash_error IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_jobs_trash_expired ON assets(julianday(trashed_at)) WHERE status='trash';
CREATE INDEX IF NOT EXISTS auto_jobs_spine_status ON manga_spine_scans(status);
PRAGMA user_version = 141;
