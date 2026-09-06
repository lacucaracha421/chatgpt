-- Preserve inbound enablement; an old pause must not silently resume uploads.
ALTER TABLE library_settings ADD COLUMN cloud_capture_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE library_settings SET cloud_capture_enabled = cloud_sync_enabled;
UPDATE library_settings SET cloud_sync_enabled = 0
WHERE EXISTS (SELECT 1 FROM cloud_backfill_control WHERE state = 'paused');
UPDATE cloud_backfill_control SET state = 'idle' WHERE state = 'paused';
CREATE TABLE cloud_activity (
    direction TEXT PRIMARY KEY CHECK(direction IN ('capture', 'replication')),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    problems INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cloud_activity(direction) VALUES ('capture'), ('replication');
PRAGMA user_version = 38;
