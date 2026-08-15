CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE
        CHECK (length(name) BETWEEN 1 AND 120),
    description TEXT
        CHECK (description IS NULL OR length(description) <= 2000),
    cover_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX collection_unique_name
ON collections(name COLLATE NOCASE);

CREATE INDEX collections_by_updated_at
ON collections(updated_at DESC, id DESC);

CREATE TABLE collection_assets (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, asset_id)
);

CREATE INDEX collection_assets_by_asset
ON collection_assets(asset_id, collection_id);

PRAGMA user_version = 10;
