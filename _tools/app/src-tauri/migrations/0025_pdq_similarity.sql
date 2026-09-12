ALTER TABLE assets ADD COLUMN perceptual_hash_quality INTEGER
    CHECK (perceptual_hash_quality IS NULL OR perceptual_hash_quality BETWEEN 0 AND 100);

CREATE TABLE similarity_reviews_v25 (
    id TEXT PRIMARY KEY NOT NULL,
    existing_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    candidate_asset_id TEXT UNIQUE REFERENCES assets(id) ON DELETE SET NULL,
    distance INTEGER NOT NULL CHECK (distance BETWEEN 0 AND 256),
    fingerprint_kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolving', 'resolved')),
    decision TEXT CHECK (decision IN ('keep_existing', 'replace_existing', 'keep_both')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (
        (status = 'open' AND decision IS NULL AND resolved_at IS NULL AND existing_asset_id IS NOT NULL AND candidate_asset_id IS NOT NULL)
        OR (status = 'resolving' AND decision = 'keep_existing' AND resolved_at IS NULL AND existing_asset_id IS NOT NULL AND candidate_asset_id IS NOT NULL)
        OR (status = 'resolved' AND decision IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

INSERT INTO similarity_reviews_v25 (
    id, existing_asset_id, candidate_asset_id, distance, fingerprint_kind,
    status, decision, created_at, resolved_at
)
SELECT
    id, existing_asset_id, candidate_asset_id, distance, 'dhash-v1',
    status, decision, created_at, resolved_at
FROM similarity_reviews;

DROP TABLE similarity_reviews;
ALTER TABLE similarity_reviews_v25 RENAME TO similarity_reviews;

CREATE INDEX similarity_reviews_by_status
ON similarity_reviews(status, created_at, id);

UPDATE assets
SET perceptual_hash = NULL,
    perceptual_hash_quality = NULL,
    perceptual_hash_error = NULL;

PRAGMA user_version = 25;
