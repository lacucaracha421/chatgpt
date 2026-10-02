-- Acknowledged per-endpoint digests for the small effective-tag publication channel.
-- No media queue, replication commit or historical Cloud Library backfill is changed.
-- Keep removed Asset ids until their empty replacement has been acknowledged.
CREATE TABLE auto_tag_publication_digests (
 endpoint TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('vocabulary', 'asset')),
 id TEXT NOT NULL,
 digest TEXT NOT NULL,
 PRIMARY KEY(endpoint, kind, id)
) WITHOUT ROWID;

CREATE TABLE auto_tag_publication_state (
 endpoint TEXT PRIMARY KEY,
 state_json TEXT NOT NULL
) WITHOUT ROWID;

PRAGMA user_version = 120;
