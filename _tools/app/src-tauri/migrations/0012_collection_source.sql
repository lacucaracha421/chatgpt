ALTER TABLE library_settings ADD COLUMN collection_source_root TEXT;
ALTER TABLE collections ADD COLUMN source_path TEXT;

PRAGMA user_version = 12;
