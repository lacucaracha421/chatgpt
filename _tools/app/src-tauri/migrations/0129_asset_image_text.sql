CREATE TABLE asset_image_text (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

PRAGMA user_version = 129;
