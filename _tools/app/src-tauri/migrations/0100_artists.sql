-- Artist hub (`artists.rs`, ARTIST-001). PC-authoritative; the tablet reads it later.
--
-- A creator key is `COALESCE(creator_handle, creator_url)` of an asset, the same key the
-- creator filter and 다시보기 always used. A key without an `artists` row is an implicit
-- single-key artist; rows exist only for keys the user touched (renamed, pinned, hidden,
-- merged) and for artists that hold assignments. Asset creator fields are never rewritten:
-- names the user registers and creators filled from source URLs live here as link records.

CREATE TABLE IF NOT EXISTS artists (
 id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
 -- The user-defined name; NULL shows the source name.
 display_name TEXT CHECK(display_name IS NULL OR length(trim(display_name)) > 0),
 pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
 hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

-- Creator keys that belong to an artist. Several keys on one artist are a merge.
CREATE TABLE IF NOT EXISTS artist_members (
 creator_key TEXT PRIMARY KEY CHECK(length(creator_key) > 0),
 artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
 added_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS artist_members_by_artist ON artist_members(artist_id, creator_key);

-- Merge suggestions the user kept apart (따로 두기), as an ordered key pair.
CREATE TABLE IF NOT EXISTS artist_merge_dismissals (
 key_a TEXT NOT NULL,
 key_b TEXT NOT NULL,
 dismissed_at TEXT NOT NULL,
 PRIMARY KEY(key_a, key_b),
 CHECK(key_a < key_b)
) WITHOUT ROWID;

-- An asset linked to an artist regardless of its creator fields: 'manual' from 작가 지정,
-- 'source_url' from 출처에서 작가 채우기 (`source_handle` is the handle read from the URL).
-- An assignment takes precedence over the asset's creator key.
CREATE TABLE IF NOT EXISTS asset_artist_assignments (
 asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
 artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('manual', 'source_url')),
 source_handle TEXT,
 created_at TEXT NOT NULL,
 CHECK((source = 'source_url') = (source_handle IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS asset_artist_assignments_by_artist
ON asset_artist_assignments(artist_id, source);

-- 주요 작가: at least `main_min_count` images, or `recent_min_count` in the last `recent_days`.
CREATE TABLE IF NOT EXISTS artist_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 main_min_count INTEGER NOT NULL DEFAULT 5 CHECK(main_min_count BETWEEN 1 AND 100000),
 recent_min_count INTEGER NOT NULL DEFAULT 2 CHECK(recent_min_count BETWEEN 1 AND 100000),
 recent_days INTEGER NOT NULL DEFAULT 30 CHECK(recent_days BETWEEN 1 AND 3650)
);

INSERT OR IGNORE INTO artist_settings (singleton) VALUES (1);

-- The artist scope of every asset, shared by the asset filter and the artist hub:
-- 'artist:<id>' for an assignment or a member key, the bare creator key for an implicit
-- artist, 'unknown:none' without creator and source, 'unknown:source' with only a source.
CREATE VIEW IF NOT EXISTS asset_artist_scope AS
SELECT asset.id AS asset_id,
 CASE
  WHEN assignment.artist_id IS NOT NULL THEN 'artist:' || assignment.artist_id
  WHEN COALESCE(asset.creator_handle, asset.creator_url) IS NULL THEN
   CASE WHEN asset.source_url IS NULL OR trim(asset.source_url) = '' THEN 'unknown:none' ELSE 'unknown:source' END
  WHEN member.artist_id IS NOT NULL THEN 'artist:' || member.artist_id
  ELSE COALESCE(asset.creator_handle, asset.creator_url)
 END AS scope_ref
FROM assets AS asset
LEFT JOIN asset_artist_assignments AS assignment ON assignment.asset_id = asset.id
LEFT JOIN artist_members AS member ON member.creator_key = COALESCE(asset.creator_handle, asset.creator_url);

PRAGMA user_version = 100;
