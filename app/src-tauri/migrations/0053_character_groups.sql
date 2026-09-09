CREATE TABLE character_groups (
 id TEXT PRIMARY KEY,
 series_id TEXT NOT NULL REFERENCES character_series(classification_id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE character_group_members (
 target_id TEXT PRIMARY KEY REFERENCES character_targets(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL REFERENCES character_groups(id) ON DELETE CASCADE
);
CREATE INDEX character_group_members_group ON character_group_members(group_id);
CREATE TRIGGER character_group_series_changed AFTER UPDATE OF series_classification_id ON character_targets
WHEN OLD.series_classification_id IS NOT NEW.series_classification_id BEGIN
 UPDATE character_groups SET revision=revision+1 WHERE id IN (SELECT group_id FROM character_group_members WHERE target_id=NEW.id);
 DELETE FROM character_group_members WHERE target_id=NEW.id;
END;
PRAGMA user_version = 53;
