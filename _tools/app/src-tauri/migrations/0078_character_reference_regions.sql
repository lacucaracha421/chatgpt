-- Explicit reference choices belong to immutable image content and detector policy.
CREATE TABLE character_reference_regions (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 asset_hash TEXT NOT NULL,
 baseline_fingerprint TEXT NOT NULL,
 bounds_json TEXT NOT NULL CHECK(json_valid(bounds_json) AND json_array_length(bounds_json)=4),
 PRIMARY KEY(target_id, asset_id)
);
PRAGMA user_version = 78;
