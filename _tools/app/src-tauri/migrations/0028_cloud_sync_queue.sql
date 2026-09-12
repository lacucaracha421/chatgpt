ALTER TABLE library_settings
ADD COLUMN cloud_sync_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (cloud_sync_enabled IN (0, 1));

ALTER TABLE library_settings ADD COLUMN cloud_api_base_url TEXT;

CREATE TABLE cloud_sync_queue (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    entity_type TEXT NOT NULL CHECK (entity_type = 'asset'),
    entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
    operation TEXT NOT NULL CHECK (operation = 'upsert'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'synced', 'failed')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    updated_at TEXT NOT NULL,
    synced_at TEXT,
    last_error TEXT,
    UNIQUE (entity_type, entity_id, operation, revision)
);

CREATE INDEX cloud_sync_queue_by_status
ON cloud_sync_queue(status, updated_at, id);

PRAGMA user_version = 28;
