ALTER TABLE manga_series ADD COLUMN modified_at TEXT NOT NULL DEFAULT '';

PRAGMA user_version = 6;
