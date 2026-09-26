-- Automatic image tags (자동 태그, `auto_tags.rs`). PC-only; never published to the server.
--
-- An external tagger's output is imported as a file (`character-runtime/auto_tags_export.py`).
-- Tags are stored by their Danbooru name, so another model with the same naming can replace
-- the output later. Only one tagger output is active: an import replaces every machine row
-- and the vocabulary, while the user's per-asset edits stay.
--
-- The effective tags of an asset are its machine tags, minus edits in state 'removed', plus
-- edits in state 'added'. An edit row therefore decides the tag for that asset whatever the
-- machine output says, now or after a later import.

CREATE TABLE IF NOT EXISTS asset_auto_tags (
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 tag TEXT NOT NULL CHECK(length(tag) > 0),
 score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
 PRIMARY KEY (asset_id, tag)
) WITHOUT ROWID;

-- Tag filters and library counts read by tag.
CREATE INDEX IF NOT EXISTS asset_auto_tags_by_tag ON asset_auto_tags(tag, asset_id);

-- Every tag the active tagger can emit, with its Danbooru category, for autocomplete and for
-- grouping tags an asset received.
CREATE TABLE IF NOT EXISTS auto_tag_vocabulary (
 tag TEXT PRIMARY KEY CHECK(length(tag) > 0),
 category TEXT NOT NULL CHECK(category IN ('general', 'character', 'copyright', 'artist', 'meta', 'rating'))
) WITHOUT ROWID;

-- The user's per-asset corrections; one row per asset and tag.
CREATE TABLE IF NOT EXISTS asset_auto_tag_edits (
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 tag TEXT NOT NULL CHECK(length(tag) > 0),
 state TEXT NOT NULL CHECK(state IN ('removed', 'added')),
 created_at TEXT NOT NULL,
 PRIMARY KEY (asset_id, tag)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS asset_auto_tag_edits_by_tag ON asset_auto_tag_edits(tag, asset_id);

-- The last import, shown in Settings.
CREATE TABLE IF NOT EXISTS auto_tag_import (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 model TEXT NOT NULL,
 imported_at TEXT NOT NULL,
 source_name TEXT NOT NULL,
 tagged_assets INTEGER NOT NULL,
 tag_rows INTEGER NOT NULL,
 skipped_assets INTEGER NOT NULL
);

PRAGMA user_version = 102;
