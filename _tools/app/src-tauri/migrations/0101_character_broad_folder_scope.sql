-- Library setting for the broad-folder character recognition rule (2026-09-12): an
-- image filed directly in a folder without a registered series ancestor is compared
-- with every registered series below that folder. Off by default (user decision
-- 2026-09-27); while off, such images get no new character jobs and their existing
-- candidates are hidden from review and automatic application, not deleted.
ALTER TABLE character_autotag_control
ADD COLUMN broad_folder_scope INTEGER NOT NULL DEFAULT 0
    CHECK(broad_folder_scope IN (0,1));

PRAGMA user_version = 101;
