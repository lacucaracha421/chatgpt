CREATE TABLE notes (
 id TEXT PRIMARY KEY NOT NULL,
 payload TEXT NOT NULL,
 local_revision INTEGER NOT NULL DEFAULT 1,
 remote_revision INTEGER NOT NULL DEFAULT 0,
 operation_id TEXT NOT NULL,
 dirty INTEGER NOT NULL DEFAULT 1,
 conflict TEXT
);
CREATE TABLE notes_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
PRAGMA user_version = 43;
