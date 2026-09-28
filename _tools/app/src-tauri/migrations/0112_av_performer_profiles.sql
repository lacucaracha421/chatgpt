-- StashDB profiles and downloaded portraits belong only to this PC library.
CREATE TABLE collection_person_profiles (
 person_id TEXT PRIMARY KEY REFERENCES collection_people(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source='stashdb'),
 status TEXT NOT NULL CHECK(status IN ('matched','none','ambiguous')),
 stashdb_id TEXT CHECK(stashdb_id IS NULL OR length(stashdb_id) BETWEEN 1 AND 128),
 name TEXT CHECK(name IS NULL OR length(name) BETWEEN 1 AND 500),
 aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(length(aliases_json)<=65536 AND json_valid(aliases_json) AND json_type(aliases_json)='array'),
 birth_date TEXT CHECK(birth_date IS NULL OR length(birth_date) IN (4,7,10)),
 height_cm INTEGER CHECK(height_cm IS NULL OR height_cm BETWEEN 1 AND 300),
 band_in INTEGER CHECK(band_in IS NULL OR band_in BETWEEN 1 AND 200),
 waist_in INTEGER CHECK(waist_in IS NULL OR waist_in BETWEEN 1 AND 200),
 hip_in INTEGER CHECK(hip_in IS NULL OR hip_in BETWEEN 1 AND 200),
 cup TEXT CHECK(cup IS NULL OR length(cup)<=20),
 breast_type TEXT CHECK(breast_type IS NULL OR breast_type IN ('NATURAL','FAKE','NA')),
 career_start INTEGER CHECK(career_start IS NULL OR career_start BETWEEN 1900 AND 2200),
 career_end INTEGER CHECK(career_end IS NULL OR career_end BETWEEN 1900 AND 2200),
 urls_json TEXT NOT NULL DEFAULT '[]' CHECK(length(urls_json)<=262144 AND json_valid(urls_json) AND json_type(urls_json)='array'),
 images_json TEXT NOT NULL DEFAULT '[]' CHECK(length(images_json)<=1048576 AND json_valid(images_json) AND json_type(images_json)='array'),
 candidates_json TEXT NOT NULL DEFAULT '[]' CHECK(length(candidates_json)<=65536 AND json_valid(candidates_json) AND json_type(candidates_json)='array' AND json_array_length(candidates_json)<=5),
 fetched_at TEXT NOT NULL CHECK(length(fetched_at) BETWEEN 1 AND 64),
 CHECK(status!='matched' OR (stashdb_id IS NOT NULL AND name IS NOT NULL)),
 CHECK(career_start IS NULL OR career_end IS NULL OR career_end>=career_start)
);
CREATE TABLE collection_person_portraits_v112 (
 person_id TEXT PRIMARY KEY REFERENCES collection_people(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('crop','commons','stashdb')),
 artwork_id TEXT REFERENCES collection_work_artworks(id) ON DELETE CASCADE,
 x REAL, y REAL, w REAL, h REAL,
 image_bytes BLOB, mime TEXT, width INTEGER, height INTEGER,
 file_name TEXT, author TEXT, license TEXT, license_url TEXT, source_url TEXT,
 updated_at TEXT NOT NULL,
 CHECK((kind='crop' AND artwork_id IS NOT NULL AND x>=0 AND y>=0 AND w>0.02 AND h>0.02 AND x+w<=1.000001 AND y+h<=1.000001 AND image_bytes IS NULL)
    OR (kind IN ('commons','stashdb') AND artwork_id IS NULL AND image_bytes IS NOT NULL AND mime IN ('image/jpeg','image/png','image/webp') AND width>0 AND height>0 AND file_name IS NOT NULL AND source_url IS NOT NULL))
);
INSERT INTO collection_person_portraits_v112 SELECT * FROM collection_person_portraits;
DROP TABLE collection_person_portraits;
ALTER TABLE collection_person_portraits_v112 RENAME TO collection_person_portraits;
PRAGMA user_version = 112;
