CREATE TABLE legacy_package_asset_mappings (
    source_library_id TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
    raw_metadata_json TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (source_library_id, source_item_id)
);

CREATE INDEX idx_legacy_package_asset_mappings_asset
ON legacy_package_asset_mappings(asset_id);

PRAGMA user_version = 20;
