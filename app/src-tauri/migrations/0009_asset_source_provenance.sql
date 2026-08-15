ALTER TABLE assets ADD COLUMN source_published_at TEXT;
ALTER TABLE assets ADD COLUMN creator_name TEXT;
ALTER TABLE assets ADD COLUMN creator_handle TEXT;
ALTER TABLE assets ADD COLUMN creator_url TEXT;
ALTER TABLE assets ADD COLUMN import_source TEXT;
ALTER TABLE assets ADD COLUMN import_batch_id TEXT;
ALTER TABLE assets ADD COLUMN original_modified_at TEXT;
PRAGMA user_version = 9;
