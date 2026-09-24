-- Two-phase purge of server-known trash (ADR-0011, ADR-0038).
--
-- Emptying the trash (or retention expiry) for an Asset the server owns first records it
-- here and queues a `tombstoned` lifecycle intent; the local row and its files stay intact.
-- Only when the server accepts the tombstone is the local row deleted and the Asset's own
-- file paths copied into this row (`accepted_at` set). The files are then deleted and this
-- row removed; a crash in between leaves the accepted row, and the next start finishes it.
CREATE TABLE asset_purge_pending (
    asset_id TEXT PRIMARY KEY NOT NULL,
    requested_at TEXT NOT NULL,
    accepted_at TEXT,
    relative_path TEXT,
    thumbnail_relative_path TEXT,
    video_directory TEXT,
    CHECK (accepted_at IS NOT NULL OR (relative_path IS NULL
        AND thumbnail_relative_path IS NULL AND video_directory IS NULL))
);

PRAGMA user_version = 93;
