CREATE TABLE online_catalog_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    installed_at TEXT,
    update_enabled INTEGER NOT NULL DEFAULT 1 CHECK (update_enabled IN (0, 1)),
    update_interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (update_interval_seconds >= 60),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_added INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

INSERT INTO online_catalog_settings (singleton) VALUES (1);

CREATE TABLE remote_reading_progress (
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    last_page INTEGER NOT NULL CHECK (last_page >= 1),
    page_count INTEGER NOT NULL CHECK (page_count >= 1),
    last_read_at TEXT NOT NULL,
    PRIMARY KEY (provider, work_id)
);

PRAGMA user_version = 18;
