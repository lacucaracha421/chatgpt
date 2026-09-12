ALTER TABLE assets ADD COLUMN trashed_at TEXT;

CREATE TABLE library_settings (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    trash_retention_days INTEGER
        CHECK (trash_retention_days IS NULL OR trash_retention_days BETWEEN 1 AND 3650)
);

INSERT INTO library_settings (singleton, trash_retention_days)
VALUES (1, 30);

CREATE INDEX assets_by_trash_age
ON assets(status, trashed_at, id);

PRAGMA user_version = 2;
