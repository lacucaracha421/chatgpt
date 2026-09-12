-- A folder policy follows its identity and applies to current and future descendants.
CREATE TABLE character_folder_exclusions (
    classification_id TEXT PRIMARY KEY REFERENCES classification_entries(id) ON DELETE CASCADE
);
CREATE VIEW character_excluded_folders AS
WITH RECURSIVE excluded(id) AS (
    SELECT classification_id FROM character_folder_exclusions
    UNION
    SELECT c.id FROM classification_entries c JOIN excluded e ON c.parent_id=e.id
)
SELECT id FROM excluded;

PRAGMA user_version = 71;
