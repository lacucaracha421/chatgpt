ALTER TABLE assets ADD COLUMN perceptual_hash BLOB;
ALTER TABLE assets ADD COLUMN perceptual_hash_error TEXT;

CREATE TABLE similarity_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    existing_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    candidate_asset_id TEXT UNIQUE REFERENCES assets(id) ON DELETE SET NULL,
    distance INTEGER NOT NULL CHECK (distance BETWEEN 0 AND 64),
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

CREATE INDEX similarity_reviews_by_status
ON similarity_reviews(status, created_at, id);

PRAGMA user_version = 3;
