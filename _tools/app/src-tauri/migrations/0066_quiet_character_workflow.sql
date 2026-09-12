-- Reference and character configuration changes affect future jobs immediately.
-- Historical work is scheduled only by an explicit character refresh request.
DROP TRIGGER IF EXISTS character_autotag_target_insert;
DROP TRIGGER IF EXISTS character_autotag_target_update;
DROP TRIGGER IF EXISTS character_autotag_series_insert;
DROP TRIGGER IF EXISTS character_autotag_series_update;
DROP TRIGGER IF EXISTS character_autotag_hierarchy;
DROP TRIGGER IF EXISTS character_autotag_reference_source;
DROP TRIGGER IF EXISTS character_base_reference_insert;
DROP TRIGGER IF EXISTS character_base_reference_update;
DROP TRIGGER IF EXISTS character_base_reference_delete;
DROP TRIGGER IF EXISTS character_learned_reference_insert;
DROP TRIGGER IF EXISTS character_learned_reference_update;
DROP TRIGGER IF EXISTS character_learned_reference_delete;

-- Rows in this table are derived scheduler state, not user decisions or evidence.
DELETE FROM character_autotag_reconsideration;

CREATE TABLE character_reference_refreshes (
    target_id TEXT PRIMARY KEY REFERENCES character_targets(id) ON DELETE CASCADE,
    series_classification_id TEXT NOT NULL REFERENCES classification_entries(id) ON DELETE CASCADE,
    target_revision INTEGER NOT NULL,
    request_revision INTEGER NOT NULL DEFAULT 1 CHECK(request_revision > 0),
    previous_reference_set_hash TEXT,
    requested_reference_set_hash TEXT NOT NULL,
    requested_reference_hashes_json TEXT NOT NULL CHECK(json_valid(requested_reference_hashes_json)),
    added_reference_hashes_json TEXT NOT NULL CHECK(json_valid(added_reference_hashes_json)),
    after_asset_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','running','failed','completed')),
    eligible_count INTEGER NOT NULL DEFAULT 0 CHECK(eligible_count >= 0),
    visited_count INTEGER NOT NULL DEFAULT 0 CHECK(visited_count >= 0),
    delta_count INTEGER NOT NULL DEFAULT 0 CHECK(delta_count >= 0),
    fallback_count INTEGER NOT NULL DEFAULT 0 CHECK(fallback_count >= 0),
    published_count INTEGER NOT NULL DEFAULT 0 CHECK(published_count >= 0),
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
    last_error TEXT,
    requested_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE INDEX character_reference_refreshes_state_idx
ON character_reference_refreshes(state, updated_at, target_id);

CREATE TABLE character_reference_refresh_items (
    target_id TEXT NOT NULL REFERENCES character_reference_refreshes(target_id) ON DELETE CASCADE,
    request_revision INTEGER NOT NULL CHECK(request_revision > 0),
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    base_evidence_id TEXT REFERENCES character_autotag_evidence(id) ON DELETE SET NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    state TEXT NOT NULL CHECK(state IN ('pending','processing','completed','failed','superseded')),
    used_delta INTEGER NOT NULL DEFAULT 0 CHECK(used_delta IN (0,1)),
    error TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(target_id, request_revision, asset_id)
);
CREATE INDEX character_reference_refresh_items_state_idx
ON character_reference_refresh_items(state, updated_at, target_id, request_revision, asset_id);

PRAGMA user_version = 66;
