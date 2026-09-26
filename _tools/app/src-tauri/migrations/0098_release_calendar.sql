-- Game and movie release calendar and wishlist (`release_calendar.rs`, `release_wishlist.rs`).
--
-- The calendar is a cache of upcoming releases (IGDB games, TMDB movies with a Korean
-- theatrical release) for roughly the next six months. The user picks titles from it into
-- the wishlist, which is then tracked like manga releases. Watched titles are not
-- Collections and never become one on their own.
--
-- Ids are `provider:external_id` (for example `igdb:1942`, `tmdb:12345`) so the wishlist can
-- later move to server authority without renumbering.

-- One row per provider: the last fetched upcoming list for [range_start, range_end).
-- TMDB content may be cached for at most six months; the calendar is refreshed daily and a
-- cache older than that is discarded on read.
CREATE TABLE IF NOT EXISTS release_calendar_cache (
 provider TEXT PRIMARY KEY CHECK(provider IN ('igdb', 'tmdb')),
 fetched_at TEXT,
 range_start TEXT,
 range_end TEXT,
 entries_json TEXT NOT NULL DEFAULT '[]',
 -- The last attempt, successful or not; a failed attempt is retried after a short delay.
 attempted_at TEXT,
 error_code TEXT
);

CREATE TABLE IF NOT EXISTS release_watch_items (
 id TEXT PRIMARY KEY CHECK(id = provider || ':' || external_id),
 kind TEXT NOT NULL CHECK(kind IN ('game', 'movie')),
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

CREATE INDEX IF NOT EXISTS release_watch_items_by_due
ON release_watch_items(next_check_at, id) WHERE next_check_at IS NOT NULL AND muted = 0;

-- Every known release date of a watched title: one row per region and platform ('' when the
-- provider has no platform, as for movies). `date` is the first day of the stated period
-- (NULL when the provider says TBD); `precision` says how much of it is known.
CREATE TABLE IF NOT EXISTS release_watch_dates (
 item_id TEXT NOT NULL REFERENCES release_watch_items(id) ON DELETE CASCADE,
 region TEXT NOT NULL,
 platform TEXT NOT NULL DEFAULT '',
 date TEXT,
 precision TEXT NOT NULL CHECK(precision IN ('exact', 'month', 'quarter', 'year', 'tbd')),
 checked_at TEXT NOT NULL,
 PRIMARY KEY(item_id, region, platform),
 CHECK((precision = 'tbd') = (date IS NULL))
) WITHOUT ROWID;

-- Changes of a watched title's headline date, read and acknowledged like manga release events
-- (exact event ids; `read_at` NULL = unread). Kept apart from `release_watch_events`, whose rows
-- belong to manga Collections and volumes and are published to mobile devices.
CREATE TABLE IF NOT EXISTS release_watch_item_events (
 id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
 item_id TEXT NOT NULL REFERENCES release_watch_items(id) ON DELETE CASCADE,
 event_kind TEXT NOT NULL CHECK(event_kind IN ('date_set', 'date_changed', 'released')),
 previous_value TEXT,
 current_value TEXT,
 detected_at TEXT NOT NULL,
 read_at TEXT
);

CREATE INDEX IF NOT EXISTS release_watch_item_events_unread
ON release_watch_item_events(read_at, detected_at, id);

PRAGMA user_version = 98;
