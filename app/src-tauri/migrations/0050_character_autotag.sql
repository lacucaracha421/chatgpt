-- No historical backfill: only subsequent native mutations create jobs.
CREATE TABLE character_autotag_jobs (
 asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL CHECK(generation > 0),
 source_generation INTEGER NOT NULL DEFAULT 1 CHECK(source_generation > 0),
 content_hash TEXT NOT NULL,
 relative_path TEXT NOT NULL,
 classification_ids TEXT NOT NULL CHECK(json_valid(classification_ids)),
 state TEXT NOT NULL CHECK(state IN ('pending','processing','completed','failed','superseded')),
 review_state TEXT NOT NULL CHECK(review_state IN ('unresolved','awaiting_candidates','partially_resolved','resolved','failed','superseded')),
 claim_id TEXT,
 priority INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 updated_at TEXT NOT NULL,
 CHECK((state = 'processing') = (claim_id IS NOT NULL))
);
CREATE INDEX character_autotag_pending ON character_autotag_jobs(priority, retry_at, updated_at, asset_id) WHERE state='pending';
CREATE INDEX character_autotag_unresolved ON character_autotag_jobs(review_state,asset_id) WHERE review_state IN ('unresolved','awaiting_candidates','partially_resolved');

-- One immutable publication per completed claim, independent of queue ownership.
CREATE TABLE character_autotag_evidence (
 id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL,
 source_generation INTEGER NOT NULL,
 content_hash TEXT NOT NULL,
 context_hash TEXT NOT NULL,
 runtime_fingerprint TEXT NOT NULL,
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 unresolved_regions TEXT NOT NULL CHECK(json_valid(unresolved_regions)),
 created_at TEXT NOT NULL,
 UNIQUE(asset_id,generation)
);
CREATE TABLE character_autotag_predictions (
 evidence_id TEXT NOT NULL REFERENCES character_autotag_evidence(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 series_id TEXT NOT NULL,
 target_fingerprint TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 PRIMARY KEY(evidence_id,target_id)
);
CREATE INDEX character_autotag_predictions_scope ON character_autotag_predictions(series_id,evidence_id);
CREATE INDEX character_autotag_evidence_asset ON character_autotag_evidence(asset_id,generation);

-- Invalidation must also cover direct native status writes (similarity, trash,
-- deletion recovery). Restoration is explicitly enqueued after its final scope.
CREATE TRIGGER character_autotag_invalidate_asset AFTER UPDATE OF status, content_hash, relative_path ON assets
WHEN OLD.status IS NOT NEW.status OR OLD.content_hash IS NOT NEW.content_hash OR OLD.relative_path IS NOT NEW.relative_path
BEGIN
 UPDATE character_autotag_jobs SET generation=generation+1, source_generation=source_generation+1, state='superseded',
 review_state='superseded', claim_id=NULL, error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE asset_id=NEW.id;
END;
PRAGMA user_version = 50;
