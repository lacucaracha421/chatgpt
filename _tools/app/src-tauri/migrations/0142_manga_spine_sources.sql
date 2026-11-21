-- Aladin is the preferred spine source; remember where the side came from and when Aladin was asked.
ALTER TABLE manga_spine_scans ADD COLUMN side_source TEXT CHECK(side_source IN ('aladin', 'yes24'));
ALTER TABLE manga_spine_scans ADD COLUMN aladin_checked_at INTEGER;
UPDATE manga_spine_scans SET side_source = 'yes24' WHERE side = 1;
PRAGMA user_version = 142;
