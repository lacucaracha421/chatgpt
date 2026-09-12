-- Metadata publishing can succeed/fail independently of media replication.
ALTER TABLE cloud_activity ADD COLUMN metadata_last_attempt_at TEXT;
ALTER TABLE cloud_activity ADD COLUMN metadata_last_success_at TEXT;
ALTER TABLE cloud_activity ADD COLUMN metadata_last_error TEXT;
PRAGMA user_version = 39;
