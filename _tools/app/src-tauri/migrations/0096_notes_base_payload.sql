-- Notes v2 (ADR-0035 amendment, 2026-09-24/25): local merge state for encrypted notes.
--
-- base_payload: the last server-acknowledged encrypted envelope of each note, the common
-- ancestor for the three-way merge. Set when a remote row applies cleanly and when a PUT
-- is acknowledged. NULL for rows never synced since this migration (legacy rows fall back
-- to keeping both copies).
-- conflict_copy: 1 for a local copy made when an unresolvable collision kept both
-- versions. Local display flag only; never synced.
ALTER TABLE notes ADD COLUMN base_payload TEXT;
ALTER TABLE notes ADD COLUMN conflict_copy INTEGER NOT NULL DEFAULT 0;
-- Local payloads a pull replaced under the editor (the last 20 local revisions per note),
-- so a queued save written against an older local revision is rebased with a three-way
-- merge instead of being refused.
CREATE TABLE notes_revisions (
 id TEXT NOT NULL,
 local_revision INTEGER NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY (id, local_revision)
);

PRAGMA user_version = 96;
