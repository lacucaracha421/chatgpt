ALTER TABLE collections ADD COLUMN type TEXT NOT NULL DEFAULT 'manga';
ALTER TABLE collections ADD COLUMN year INTEGER;
ALTER TABLE collections ADD COLUMN author TEXT;
ALTER TABLE collections ADD COLUMN director TEXT;
ALTER TABLE collections ADD COLUMN external_score INTEGER;
ALTER TABLE collections ADD COLUMN my_score INTEGER;
ALTER TABLE collections ADD COLUMN genres TEXT;
ALTER TABLE collections ADD COLUMN overview TEXT;
ALTER TABLE collections ADD COLUMN external_id TEXT;
ALTER TABLE collections ADD COLUMN external_source TEXT;
ALTER TABLE collections ADD COLUMN external_synced_at TEXT;
ALTER TABLE collections ADD COLUMN showcase INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN external_metadata_json TEXT;

CREATE INDEX collections_by_type ON collections(type);
CREATE INDEX collections_by_showcase ON collections(showcase) WHERE showcase = 1;

PRAGMA user_version = 11;
