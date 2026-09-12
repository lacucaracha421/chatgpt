-- Retain whether the user explicitly entered a count, including zero.
CREATE TABLE collection_ownership_tracking (
 collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
 edition_index INTEGER NOT NULL CHECK(edition_index BETWEEN 0 AND 3),
 PRIMARY KEY(collection_id, edition_index)
);
INSERT INTO collection_ownership_tracking SELECT DISTINCT collection_id, edition_index FROM collection_volume_ownership;
ALTER TABLE release_watch_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'kakao' CHECK(provider IN ('mangadex','kakao','aladin'));
UPDATE release_watch_events SET provider='aladin' WHERE NOT EXISTS (
 SELECT 1 FROM collection_external_bindings b WHERE b.collection_id=release_watch_events.collection_id AND b.provider='kakao'
) AND EXISTS (SELECT 1 FROM collection_external_bindings b WHERE b.collection_id=release_watch_events.collection_id AND b.provider='aladin');
CREATE TABLE collection_mangadex_baselines (
 collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
 manga_id TEXT NOT NULL
);
CREATE TABLE collection_mangadex_seen_volumes (
 collection_id TEXT NOT NULL REFERENCES collection_mangadex_baselines(collection_id) ON DELETE CASCADE,
 volume_number INTEGER NOT NULL,
 edition_index INTEGER NOT NULL,
 PRIMARY KEY(collection_id,volume_number,edition_index)
);
CREATE TABLE collection_update_attempts (
 collection_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 retry_at TEXT NOT NULL,
 PRIMARY KEY(collection_id,provider),
 FOREIGN KEY(collection_id,provider) REFERENCES collection_external_bindings(collection_id,provider) ON DELETE CASCADE
);
CREATE TABLE collection_update_status (
 provider TEXT PRIMARY KEY CHECK(provider IN ('mangadex','kakao')),
 status_json TEXT NOT NULL
);
PRAGMA user_version = 73;
