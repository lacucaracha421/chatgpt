CREATE TABLE collection_work_artworks (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    provider_image_id TEXT NOT NULL CHECK (length(trim(provider_image_id)) > 0),
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    relative_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    language TEXT,
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(collection_id, provider, provider_image_id)
);

CREATE UNIQUE INDEX collection_work_artworks_selected_kind
ON collection_work_artworks(collection_id, kind)
WHERE selected = 1;

PRAGMA user_version = 14;
