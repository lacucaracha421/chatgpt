-- Intentional manual characters are valid identities without recognition references.
ALTER TABLE character_targets ADD COLUMN manual_only INTEGER NOT NULL DEFAULT 0
CHECK(manual_only IN (0,1));
UPDATE character_targets SET manual_only=1
WHERE id IN (SELECT target_id FROM character_manual_targets);

-- Manual-only targets must not trigger or participate in background reconsideration.
DROP TRIGGER IF EXISTS character_autotag_target_insert;
CREATE TRIGGER character_autotag_target_insert AFTER INSERT ON character_targets
WHEN NEW.manual_only=0 BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT NEW.series_classification_id WHERE NEW.series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

DROP TRIGGER IF EXISTS character_autotag_target_update;
CREATE TRIGGER character_autotag_target_update
AFTER UPDATE OF revision,enabled,series_classification_id,manual_only ON character_targets BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT NEW.series_classification_id WHERE NEW.series_classification_id IS NOT NULL AND NEW.manual_only=0
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT OLD.series_classification_id
 WHERE OLD.series_classification_id IS NOT NULL AND OLD.manual_only=0
   AND (OLD.series_classification_id IS NOT NEW.series_classification_id OR NEW.manual_only<>0)
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

PRAGMA user_version = 59;
