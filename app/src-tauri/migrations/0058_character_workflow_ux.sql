-- Character workflow UX: truthful queue provenance, manual-only characters,
-- explicit series-level character-classification exclusions, and an Originals root.
ALTER TABLE character_autotag_jobs ADD COLUMN cause TEXT NOT NULL DEFAULT 'legacy'
CHECK(cause IN ('legacy','ingestion','classification','restore','similarity_resolution','reconsideration','manual_scan'));

CREATE TABLE character_manual_targets (
    target_id TEXT PRIMARY KEY REFERENCES character_targets(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE character_series_asset_exclusions (
    series_id TEXT NOT NULL REFERENCES character_series(classification_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(series_id, asset_id)
);
CREATE INDEX character_series_asset_exclusions_asset
ON character_series_asset_exclusions(asset_id, series_id);

-- Reuse an existing user-created Originals root when present; otherwise create it.
INSERT OR IGNORE INTO classification_entries(id,kind,name,parent_id,created_at,icon_key,color_key)
VALUES('lakomics-originals','root','오리지널',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'sparkles',NULL);
UPDATE classification_entries
SET icon_key=COALESCE(icon_key,'sparkles')
WHERE parent_id IS NULL AND name='오리지널' COLLATE NOCASE;

PRAGMA user_version = 58;
