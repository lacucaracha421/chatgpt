-- A small full-snapshot replica with durable desired-state intents.
CREATE TABLE manga_index_pin_sync (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE manga_index_pin_revisions (
 kind TEXT NOT NULL, namespace TEXT NOT NULL, value TEXT NOT NULL,
 epoch INTEGER NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY(kind,namespace,value)
) WITHOUT ROWID;
CREATE TABLE manga_index_pin_outbox (
 kind TEXT NOT NULL, namespace TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 operation_id TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, base_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(kind,namespace,value)
) WITHOUT ROWID;
-- Preserve pre-sync PC pins as pending user intent, rather than dropping them
-- when the server's first (possibly empty) snapshot arrives.
INSERT INTO manga_index_pin_outbox
 SELECT kind,namespace,value,label,1,
 lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
 0,0,created_at FROM manga_index_pins;
PRAGMA user_version = 119;
