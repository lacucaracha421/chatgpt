ALTER TABLE collection_external_bindings ADD COLUMN provider_config_json TEXT;

CREATE TABLE collection_volume_sources (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    volume_number INTEGER NOT NULL CHECK (volume_number BETWEEN 1 AND 999),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    provider_item_id TEXT NOT NULL CHECK (length(trim(provider_item_id)) > 0),
    title TEXT NOT NULL,
    author TEXT,
    publisher TEXT,
    isbn13 TEXT,
    publication_date TEXT,
    item_url TEXT,
    provider_data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, volume_number, provider)
);

CREATE UNIQUE INDEX collection_volume_sources_by_provider_item
ON collection_volume_sources(provider, provider_item_id);

PRAGMA user_version = 16;
