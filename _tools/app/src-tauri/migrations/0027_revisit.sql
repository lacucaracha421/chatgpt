CREATE TABLE asset_activity (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    last_opened_at TEXT,
    open_count INTEGER NOT NULL DEFAULT 0,
    last_exposed_at TEXT,
    exposure_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE revisit_slates (
    local_date TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE revisit_bundles (
    id TEXT PRIMARY KEY,
    local_date TEXT NOT NULL REFERENCES revisit_slates(local_date) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    UNIQUE(local_date, position)
);
CREATE TABLE revisit_bundle_assets (
    bundle_id TEXT NOT NULL REFERENCES revisit_bundles(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY(bundle_id, asset_id),
    UNIQUE(bundle_id, position)
);
CREATE TABLE revisit_preferences (
    dimension TEXT NOT NULL,
    value TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT -1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(dimension, value)
);
PRAGMA user_version = 27;