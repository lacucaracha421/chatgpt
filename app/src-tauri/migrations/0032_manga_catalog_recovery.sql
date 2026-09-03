CREATE TABLE manga_catalog_recovery_links (
  manga_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  work_id TEXT NOT NULL,
  match_method TEXT NOT NULL,
  bookmark_created INTEGER NOT NULL CHECK (bookmark_created IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_manga_catalog_recovery_work
  ON manga_catalog_recovery_links(provider, work_id);

PRAGMA user_version = 32;
