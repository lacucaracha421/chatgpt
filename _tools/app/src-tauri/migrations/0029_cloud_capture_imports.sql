CREATE TABLE cloud_capture_imports (
    capture_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(capture_id)) > 0),
    status TEXT NOT NULL CHECK (status IN ('imported', 'acknowledged')),
    asset_id TEXT,
    imported_at TEXT NOT NULL,
    last_error TEXT
);

PRAGMA user_version = 29;