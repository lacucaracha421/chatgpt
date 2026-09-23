-- Historical pairs share the review surface, not incoming-candidate deletion semantics.
CREATE TABLE similarity_reviews_v90 (
    id TEXT PRIMARY KEY NOT NULL,
    existing_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    candidate_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    distance INTEGER NOT NULL CHECK (distance BETWEEN 0 AND 256),
    fingerprint_kind TEXT NOT NULL,
    review_kind TEXT NOT NULL DEFAULT 'incoming' CHECK (review_kind IN ('incoming', 'historical')),
    status TEXT NOT NULL CHECK (status IN ('open', 'resolving', 'resolved', 'stale')),
    decision TEXT CHECK (decision IN ('keep_existing', 'replace_existing', 'keep_both')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (
        (status = 'open' AND decision IS NULL AND resolved_at IS NULL AND existing_asset_id IS NOT NULL AND candidate_asset_id IS NOT NULL)
        OR (status = 'resolving' AND review_kind = 'incoming' AND decision = 'keep_existing' AND resolved_at IS NULL AND existing_asset_id IS NOT NULL AND candidate_asset_id IS NOT NULL)
        OR (status = 'resolved' AND decision IS NOT NULL AND resolved_at IS NOT NULL)
        OR (status = 'stale' AND review_kind = 'historical')
    )
);
INSERT INTO similarity_reviews_v90 (id, existing_asset_id, candidate_asset_id, distance, fingerprint_kind, status, decision, created_at, resolved_at)
SELECT id, existing_asset_id, candidate_asset_id, distance, fingerprint_kind, status, decision, created_at, resolved_at FROM similarity_reviews;
DROP TABLE similarity_reviews;
ALTER TABLE similarity_reviews_v90 RENAME TO similarity_reviews;
CREATE INDEX similarity_reviews_by_status ON similarity_reviews(status, created_at, id);
CREATE UNIQUE INDEX similarity_incoming_candidate ON similarity_reviews(candidate_asset_id) WHERE review_kind = 'incoming';
CREATE INDEX similarity_review_pairs ON similarity_reviews(min(existing_asset_id, candidate_asset_id), max(existing_asset_id, candidate_asset_id));
CREATE UNIQUE INDEX similarity_historical_pair ON similarity_reviews(min(existing_asset_id, candidate_asset_id), max(existing_asset_id, candidate_asset_id)) WHERE review_kind = 'historical' AND status != 'stale';

CREATE TRIGGER historical_similarity_before_asset_delete BEFORE DELETE ON assets BEGIN
    UPDATE similarity_reviews SET status = 'stale'
    WHERE review_kind = 'historical' AND status = 'open'
      AND (existing_asset_id = OLD.id OR candidate_asset_id = OLD.id);
END;
CREATE TRIGGER historical_similarity_after_asset_change AFTER UPDATE OF status, content_hash ON assets
WHEN NEW.status != 'normal' OR NEW.content_hash != OLD.content_hash BEGIN
    UPDATE similarity_reviews SET status = 'stale'
    WHERE review_kind = 'historical' AND status = 'open'
      AND (existing_asset_id = NEW.id OR candidate_asset_id = NEW.id);
END;

-- One durable explicit scan per library. Leaving the screen pauses after its bounded batch.
CREATE TABLE image_similarity_scan (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    total_assets INTEGER NOT NULL,
    skipped_assets INTEGER NOT NULL,
    left_position INTEGER NOT NULL DEFAULT 0,
    right_position INTEGER NOT NULL DEFAULT 1,
    compared_pairs INTEGER NOT NULL DEFAULT 0,
    reviews_created INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
);
CREATE TABLE image_similarity_scan_assets (
    position INTEGER PRIMARY KEY,
    asset_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    fingerprint BLOB NOT NULL,
    quality INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL
);
PRAGMA user_version = 90;
