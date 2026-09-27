-- PC presentation state only; never part of classification/character publication.
CREATE TABLE character_folder_order (
    target_id TEXT PRIMARY KEY REFERENCES character_targets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    legacy_sidebar INTEGER NOT NULL DEFAULT 0 CHECK(legacy_sidebar IN (0,1))
);
-- Preserve the existing desktop target list exactly on upgrade. The sidebar used
-- Korean locale sorting; keep that until the first explicit move in its series.
INSERT INTO character_folder_order(target_id, position, legacy_sidebar)
SELECT id, ROW_NUMBER() OVER (ORDER BY display_name COLLATE NOCASE, id), 1
FROM character_targets;
CREATE TRIGGER character_folder_order_insert AFTER INSERT ON character_targets BEGIN
    INSERT INTO character_folder_order(target_id, position)
    VALUES(NEW.id, (SELECT COALESCE(MAX(position),0)+1 FROM character_folder_order));
END;
CREATE TRIGGER character_folder_order_series_changed
AFTER UPDATE OF series_classification_id ON character_targets
WHEN OLD.series_classification_id IS NOT NEW.series_classification_id BEGIN
    UPDATE character_folder_order
    SET position=(SELECT COALESCE(MAX(position),0)+1 FROM character_folder_order), legacy_sidebar=0
    WHERE target_id=NEW.id;
END;
PRAGMA user_version = 103;
