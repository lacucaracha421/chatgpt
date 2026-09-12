CREATE TABLE character_targets (
    id TEXT PRIMARY KEY NOT NULL,
    series_classification_id TEXT REFERENCES classification_entries(id) ON DELETE SET NULL,
    linked_classification_id TEXT REFERENCES classification_entries(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(display_name)) > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(series_classification_id, display_name)
);

CREATE TABLE character_references (
    target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 4),
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    asset_hash TEXT NOT NULL,
    PRIMARY KEY(target_id, slot),
    UNIQUE(target_id, asset_id),
    UNIQUE(target_id, asset_hash)
);
CREATE INDEX character_references_by_asset ON character_references(asset_id);

CREATE TABLE character_decisions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE RESTRICT,
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    source_asset_id TEXT NOT NULL,
    asset_hash TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected', 'cleared')),
    target_fingerprint TEXT NOT NULL,
    baseline_fingerprint TEXT,
    reference_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX character_decisions_by_pair
ON character_decisions(target_id, source_asset_id, sequence DESC);
CREATE INDEX character_decisions_by_asset ON character_decisions(asset_id);
CREATE INDEX character_decisions_by_target ON character_decisions(target_id, sequence DESC);

-- Current relation is derived from the last human decision, not model predictions.
CREATE VIEW character_relations AS
SELECT current.target_id, current.asset_id, current.sequence
FROM character_decisions current
WHERE current.asset_id IS NOT NULL AND current.decision = 'accepted'
AND NOT EXISTS (
    SELECT 1 FROM character_decisions newer
    WHERE newer.target_id = current.target_id
      AND newer.source_asset_id = current.source_asset_id
      AND newer.sequence > current.sequence
);

PRAGMA user_version = 44;
