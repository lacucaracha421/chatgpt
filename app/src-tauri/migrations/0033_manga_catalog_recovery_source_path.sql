ALTER TABLE manga_catalog_recovery_links
  ADD COLUMN source_relative_path TEXT;

CREATE UNIQUE INDEX idx_manga_catalog_recovery_source_path
  ON manga_catalog_recovery_links(source_relative_path)
  WHERE source_relative_path IS NOT NULL;

PRAGMA user_version = 33;
