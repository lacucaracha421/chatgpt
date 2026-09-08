CREATE TABLE video_similarity_fingerprints (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    profile TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    created_at TEXT NOT NULL
);
CREATE TABLE video_similarity_frames (
    asset_id TEXT NOT NULL REFERENCES video_similarity_fingerprints(asset_id) ON DELETE CASCADE,
    sample_index INTEGER NOT NULL CHECK (sample_index BETWEEN 0 AND 11),
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
    pdq BLOB NOT NULL CHECK (length(pdq) = 64),
    quality INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 100),
    PRIMARY KEY (asset_id, sample_index)
);
CREATE TABLE video_similarity_scans (
    id TEXT PRIMARY KEY NOT NULL,
    profile TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'cancelled', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reason TEXT
);
CREATE TABLE video_similarity_scan_items (
    scan_id TEXT NOT NULL REFERENCES video_similarity_scans(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    source_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'skipped', 'failed')),
    reason TEXT,
    PRIMARY KEY (scan_id, ordinal),
    UNIQUE (scan_id, asset_id)
);
CREATE TABLE video_similarity_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    scan_id TEXT REFERENCES video_similarity_scans(id) ON DELETE SET NULL,
    left_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    right_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    left_hash TEXT NOT NULL,
    right_hash TEXT NOT NULL,
    profile TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'stale')),
    decision TEXT CHECK (decision IN ('keep_left', 'keep_right', 'keep_both', 'not_similar')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (left_hash, right_hash),
    CHECK (left_hash < right_hash),
    CHECK (
        (state = 'open' AND decision IS NULL AND resolved_at IS NULL
            AND left_asset_id IS NOT NULL AND right_asset_id IS NOT NULL)
        OR (state = 'resolved' AND decision IS NOT NULL AND resolved_at IS NOT NULL)
        OR state = 'stale'
    )
);
CREATE INDEX video_similarity_reviews_pending
ON video_similarity_reviews(state, created_at, id);
CREATE TRIGGER video_similarity_reviews_before_asset_delete
BEFORE DELETE ON assets
BEGIN
    UPDATE video_similarity_reviews SET state = 'stale'
    WHERE state = 'open' AND (left_asset_id = OLD.id OR right_asset_id = OLD.id);
END;
CREATE TRIGGER video_similarity_reviews_after_asset_change
AFTER UPDATE OF status, content_hash ON assets
WHEN NEW.status != 'normal' OR NEW.content_hash != OLD.content_hash
BEGIN
    UPDATE video_similarity_reviews SET state = 'stale'
    WHERE state = 'open' AND (left_asset_id = NEW.id OR right_asset_id = NEW.id);
END;
PRAGMA user_version = 45;
