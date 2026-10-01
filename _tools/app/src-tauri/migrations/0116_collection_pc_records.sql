-- PC-only presentation and record data. Deliberately separate from replica DTOs.
CREATE TABLE collection_pc_records (
    collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
    status TEXT,
    owned_platform TEXT
);
CREATE TABLE collection_volume_cover_focus (
    volume_id TEXT PRIMARY KEY REFERENCES collection_volumes(id) ON DELETE CASCADE,
    cover_artwork_id TEXT NOT NULL REFERENCES collection_work_artworks(id) ON DELETE CASCADE,
    focus_x REAL CHECK(focus_x IS NULL OR (focus_x >= 0 AND focus_x <= 1)),
    method TEXT NOT NULL CHECK(method IN ('head', 'close-up', 'body', 'none'))
);
PRAGMA user_version = 116;
