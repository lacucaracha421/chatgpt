ALTER TABLE library_settings ADD COLUMN manga_root TEXT;

CREATE TABLE manga_series (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  gallery_id TEXT,
  page_count INTEGER NOT NULL,
  thumbnail_relative_path TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);

PRAGMA user_version = 5;
