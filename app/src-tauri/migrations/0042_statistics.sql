CREATE TABLE collection_activity (
    collection_id TEXT PRIMARY KEY NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    last_opened_at TEXT NOT NULL,
    open_count INTEGER NOT NULL CHECK (open_count > 0)
);
CREATE TABLE activity_telemetry (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    started_at TEXT NOT NULL
);
INSERT INTO activity_telemetry VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE activity_daily (
    local_date TEXT NOT NULL,
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('asset', 'collection')),
    open_count INTEGER NOT NULL CHECK (open_count > 0),
    PRIMARY KEY (local_date, entity_kind)
);
-- Record only new deliberate opens. Existing counters/exposures are not history.
CREATE TRIGGER statistics_asset_insert AFTER INSERT ON asset_activity
WHEN NEW.open_count > 0 AND NEW.last_opened_at IS NOT NULL
BEGIN
    INSERT INTO activity_daily VALUES (date('now', 'localtime'), 'asset', 1)
    ON CONFLICT(local_date, entity_kind) DO UPDATE SET open_count = open_count + 1;
    DELETE FROM activity_daily WHERE local_date < date('now', 'localtime', '-89 days');
END;
CREATE TRIGGER statistics_asset_update AFTER UPDATE OF open_count ON asset_activity
WHEN NEW.open_count > OLD.open_count AND NEW.last_opened_at IS NOT NULL
BEGIN
    INSERT INTO activity_daily VALUES (date('now', 'localtime'), 'asset', 1)
    ON CONFLICT(local_date, entity_kind) DO UPDATE SET open_count = open_count + 1;
    DELETE FROM activity_daily WHERE local_date < date('now', 'localtime', '-89 days');
END;
CREATE TRIGGER statistics_collection_insert AFTER INSERT ON collection_activity
BEGIN
    INSERT INTO activity_daily VALUES (date('now', 'localtime'), 'collection', 1)
    ON CONFLICT(local_date, entity_kind) DO UPDATE SET open_count = open_count + 1;
    DELETE FROM activity_daily WHERE local_date < date('now', 'localtime', '-89 days');
END;
CREATE TRIGGER statistics_collection_update AFTER UPDATE OF open_count ON collection_activity
WHEN NEW.open_count > OLD.open_count
BEGIN
    INSERT INTO activity_daily VALUES (date('now', 'localtime'), 'collection', 1)
    ON CONFLICT(local_date, entity_kind) DO UPDATE SET open_count = open_count + 1;
    DELETE FROM activity_daily WHERE local_date < date('now', 'localtime', '-89 days');
END;
PRAGMA user_version = 42;
