CREATE TABLE albums (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    parent_id TEXT REFERENCES albums(id) ON DELETE RESTRICT,
    icon_key TEXT,
    color_key TEXT,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX album_unique_sibling_name
ON albums(COALESCE(parent_id, ''), name COLLATE NOCASE);

CREATE INDEX albums_by_parent
ON albums(parent_id, name COLLATE NOCASE, id);

CREATE TABLE asset_albums (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    PRIMARY KEY (asset_id, album_id)
);

CREATE INDEX asset_albums_by_album
ON asset_albums(album_id, asset_id);

PRAGMA user_version = 8;
