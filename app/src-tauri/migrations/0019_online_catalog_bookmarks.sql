CREATE TABLE online_catalog_bookmarks (
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, work_id)
) WITHOUT ROWID;

PRAGMA user_version = 19;
