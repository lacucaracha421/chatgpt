PRAGMA foreign_keys = ON;

CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'gif')),
    title TEXT,
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    thumbnail_relative_path TEXT NOT NULL UNIQUE,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    source_url TEXT,
    collected_at TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'normal'
        CHECK (status IN ('normal', 'review', 'trash'))
);

CREATE TABLE classification_entries (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('root', 'work', 'tag')),
    name TEXT NOT NULL COLLATE NOCASE,
    parent_id TEXT REFERENCES classification_entries(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX classification_unique_sibling_name
ON classification_entries(COALESCE(parent_id, ''), name COLLATE NOCASE);

CREATE TABLE asset_classifications (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    classification_id TEXT NOT NULL
        REFERENCES classification_entries(id) ON DELETE RESTRICT,
    PRIMARY KEY (asset_id, classification_id)
);

CREATE INDEX assets_by_collected_at
ON assets(status, collected_at DESC, id DESC);

CREATE INDEX classification_by_parent
ON classification_entries(parent_id, name COLLATE NOCASE);

PRAGMA user_version = 1;
