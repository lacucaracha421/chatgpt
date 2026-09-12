CREATE TABLE release_watch_subscriptions_new (
    collection_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('aladin', 'kakao')),
    last_checked_at TEXT,
    PRIMARY KEY (collection_id, provider),
    FOREIGN KEY (collection_id, provider)
        REFERENCES collection_external_bindings(collection_id, provider) ON DELETE CASCADE
);
INSERT INTO release_watch_subscriptions_new SELECT * FROM release_watch_subscriptions;
DROP TABLE release_watch_subscriptions;
ALTER TABLE release_watch_subscriptions_new RENAME TO release_watch_subscriptions;
CREATE INDEX release_watch_subscriptions_by_due ON release_watch_subscriptions(last_checked_at, collection_id);
PRAGMA user_version = 40;
