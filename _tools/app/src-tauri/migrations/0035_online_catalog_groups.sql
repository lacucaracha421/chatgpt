-- Durable identities and user choices belong to library.sqlite. External
-- canonical catalog rows may be replaced, so none of these tables references them.
CREATE TABLE online_catalog_group_handles (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    anchor_work_id TEXT NOT NULL,
    group_id TEXT NOT NULL UNIQUE,
    UNIQUE(provider, anchor_work_id)
);

CREATE TABLE online_catalog_group_preferences (
    provider TEXT NOT NULL,
    anchor_work_id TEXT NOT NULL,
    selected_work_id TEXT,
    edit_revision INTEGER NOT NULL CHECK(edit_revision > 0),
    PRIMARY KEY(provider, anchor_work_id)
) WITHOUT ROWID;

CREATE TABLE online_catalog_group_members (
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    catalog_work_id INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    thumbnail_valid INTEGER NOT NULL CHECK(thumbnail_valid IN (0,1)),
    completeness INTEGER NOT NULL,
    lineage_terminal INTEGER NOT NULL CHECK(lineage_terminal IN (0,1)),
    PRIMARY KEY(provider, work_id),
    UNIQUE(provider, catalog_work_id)
) WITHOUT ROWID;
CREATE INDEX online_catalog_group_members_reverse
    ON online_catalog_group_members(provider, group_id, catalog_work_id);

CREATE TABLE online_catalog_group_state (
    provider TEXT PRIMARY KEY,
    source_revision TEXT NOT NULL,
    generation INTEGER NOT NULL,
    built_at TEXT NOT NULL,
    last_error TEXT
) WITHOUT ROWID;

CREATE TABLE online_catalog_group_diagnostics (
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY(provider, work_id, reason)
) WITHOUT ROWID;

PRAGMA user_version = 35;
