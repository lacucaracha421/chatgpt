CREATE TABLE collection_volumes (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    volume_number INTEGER NOT NULL CHECK (volume_number > 0),
    edition_index INTEGER NOT NULL CHECK (edition_index BETWEEN 0 AND 3),
    sort_order INTEGER NOT NULL,
    cover_artwork_id TEXT REFERENCES collection_work_artworks(id) ON DELETE SET NULL,
    source_provider TEXT,
    source_cover_id TEXT,
    source_file_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (collection_id, volume_number, edition_index)
);

CREATE INDEX collection_volumes_order
ON collection_volumes(collection_id, edition_index, sort_order, volume_number);

PRAGMA user_version = 15;
