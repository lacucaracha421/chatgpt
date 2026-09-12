-- Empty groups have no independent contents. Keep characters and assets untouched.
DELETE FROM character_groups
WHERE NOT EXISTS (
    SELECT 1 FROM character_group_members WHERE group_id = character_groups.id
);

CREATE TRIGGER character_group_remove_empty
AFTER DELETE ON character_group_members
BEGIN
    DELETE FROM character_groups
    WHERE id = OLD.group_id
      AND NOT EXISTS (SELECT 1 FROM character_group_members WHERE group_id = OLD.group_id);
END;

PRAGMA user_version = 72;
