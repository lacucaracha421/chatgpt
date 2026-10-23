-- Resumable derived scan publication, scoped to the configured cloud endpoint.
CREATE TABLE manga_scan_publications (
 endpoint TEXT NOT NULL,
 isbn13 TEXT NOT NULL,
 part TEXT NOT NULL CHECK(part IN ('side','back')),
 source_checked_at INTEGER NOT NULL DEFAULT -1,
 sha256 TEXT,
 retry_after INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(endpoint,isbn13,part)
);
PRAGMA user_version = 140;
