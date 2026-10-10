-- Acknowledged per-endpoint digests for the Korean caption / character-name publication channel
-- (PUT /v1/library/captions). Captions come from the PC-only NL-search cache; no media, classification
-- or auto-tag table is touched. Ids are kept until the removal has been acknowledged.
CREATE TABLE caption_publication_digests (
 endpoint TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('caption', 'name')),
 id TEXT NOT NULL,
 digest TEXT NOT NULL,
 PRIMARY KEY(endpoint, kind, id)
) WITHOUT ROWID;

CREATE TABLE caption_publication_state (
 endpoint TEXT PRIMARY KEY,
 state_json TEXT NOT NULL
) WITHOUT ROWID;

PRAGMA user_version = 126;
