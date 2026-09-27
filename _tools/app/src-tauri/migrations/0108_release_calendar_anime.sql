-- Add Japanese TV anime seasons without changing existing game/movie identities.
-- Anime title provider remains tmdb, external_id is tv:<showId>:s<season>,
-- and id is tmdb:tv:<showId>:s<season>. tmdb_tv is only the separate TV cache key.
-- The migration runner disables foreign_keys BEFORE its transaction, validates with
-- foreign_key_check before commit, and restores foreign_keys afterward (as for 0040).
-- Create/copy/drop/rename preserves child references to release_watch_items, including
-- dates and events; renaming the old parent first would rewrite those references.

CREATE TABLE release_calendar_cache_new (
 provider TEXT PRIMARY KEY CHECK(provider IN ('igdb', 'tmdb', 'tmdb_tv')),
 fetched_at TEXT,
 range_start TEXT,
 range_end TEXT,
 entries_json TEXT NOT NULL DEFAULT '[]',
 -- The last attempt, successful or not; a failed attempt is retried after a short delay.
 attempted_at TEXT,
 error_code TEXT
);

INSERT INTO release_calendar_cache_new
SELECT * FROM release_calendar_cache;
DROP TABLE release_calendar_cache;
ALTER TABLE release_calendar_cache_new RENAME TO release_calendar_cache;

CREATE TABLE release_watch_items_new (
 id TEXT PRIMARY KEY CHECK(id = provider || ':' || external_id),
 kind TEXT NOT NULL CHECK(kind IN ('game', 'movie', 'anime')),
 provider TEXT NOT NULL CHECK(provider IN ('igdb', 'tmdb')),
 external_id TEXT NOT NULL CHECK(length(trim(external_id)) > 0),
 -- Korean title where the provider has one, else the provider's title.
 title TEXT NOT NULL CHECK(length(trim(title)) > 0),
 original_title TEXT,
 -- Provider image reference: an IGDB image id or a TMDB poster path.
 cover TEXT,
 platforms_json TEXT NOT NULL DEFAULT '[]',
 source TEXT NOT NULL CHECK(source IN ('calendar', 'manual')),
 added_at TEXT NOT NULL,
 muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0, 1)),
 last_checked_at TEXT,
 -- NULL once tracking has stopped (30 days after release).
 next_check_at TEXT,
 released_at TEXT,
 UNIQUE(provider, external_id),
 CHECK((kind = 'game') = (provider = 'igdb'))
);

INSERT INTO release_watch_items_new
SELECT * FROM release_watch_items;
DROP TABLE release_watch_items;
ALTER TABLE release_watch_items_new RENAME TO release_watch_items;

CREATE INDEX release_watch_items_by_due
ON release_watch_items(next_check_at, id) WHERE next_check_at IS NOT NULL AND muted = 0;

PRAGMA user_version = 108;
