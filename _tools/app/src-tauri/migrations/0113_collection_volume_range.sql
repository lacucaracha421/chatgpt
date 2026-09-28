CREATE TABLE collection_volume_ranges (
 collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
 min_volume INTEGER NULL CHECK(min_volume IS NULL OR min_volume BETWEEN 0 AND 9999),
 max_volume INTEGER NULL CHECK(max_volume IS NULL OR max_volume BETWEEN 0 AND 9999 AND (min_volume IS NULL OR max_volume >= min_volume)),
 hide_connection_prompt INTEGER NOT NULL DEFAULT 0 CHECK(hide_connection_prompt IN (0,1)),
 updated_at TEXT NOT NULL
);
PRAGMA user_version = 113;
