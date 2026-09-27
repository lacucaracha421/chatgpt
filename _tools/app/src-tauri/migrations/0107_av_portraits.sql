ALTER TABLE collection_people ADD COLUMN memo TEXT CHECK(memo IS NULL OR length(memo) <= 2000);
-- PC-only portraits. Cloud metadata snapshots explicitly remove these rows.
CREATE TABLE collection_person_portraits (
 person_id TEXT PRIMARY KEY REFERENCES collection_people(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('crop','commons')),
 artwork_id TEXT REFERENCES collection_work_artworks(id) ON DELETE CASCADE,
 x REAL, y REAL, w REAL, h REAL,
 image_bytes BLOB, mime TEXT, width INTEGER, height INTEGER,
 file_name TEXT, author TEXT, license TEXT, license_url TEXT, source_url TEXT,
 updated_at TEXT NOT NULL,
 CHECK((kind='crop' AND artwork_id IS NOT NULL AND x>=0 AND y>=0 AND w>0.02 AND h>0.02 AND x+w<=1.000001 AND y+h<=1.000001 AND image_bytes IS NULL)
    OR (kind='commons' AND artwork_id IS NULL AND image_bytes IS NOT NULL AND mime IN ('image/jpeg','image/png','image/webp') AND width>0 AND height>0 AND file_name IS NOT NULL AND source_url IS NOT NULL))
);
PRAGMA user_version = 107;
