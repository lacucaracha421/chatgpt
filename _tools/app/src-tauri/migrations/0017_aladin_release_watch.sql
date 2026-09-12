CREATE TABLE release_watch_subscriptions (
    collection_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'aladin'),
    last_checked_at TEXT,
    PRIMARY KEY (collection_id, provider),
    FOREIGN KEY (collection_id, provider)
        REFERENCES collection_external_bindings(collection_id, provider)
        ON DELETE CASCADE
);

CREATE TABLE release_watch_events (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN ('new_volume', 'release_date_changed', 'release_status_changed')
    ),
    volume_number INTEGER NOT NULL CHECK (volume_number BETWEEN 1 AND 999),
    previous_value TEXT,
    current_value TEXT,
    detected_at TEXT NOT NULL,
    read_at TEXT
);

CREATE INDEX release_watch_subscriptions_by_due
ON release_watch_subscriptions(last_checked_at, collection_id);

CREATE INDEX release_watch_events_by_collection_unread
ON release_watch_events(collection_id, read_at, detected_at, id);

PRAGMA user_version = 17;
