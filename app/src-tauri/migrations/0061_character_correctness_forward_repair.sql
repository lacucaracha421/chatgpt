-- Repair development libraries that recorded v60 before the final v60 schema landed.
-- This migration is safe for both complete v60 databases and partially-applied v60 databases.
CREATE TABLE IF NOT EXISTS classification_roles (
 role TEXT PRIMARY KEY CHECK(role IN ('originals')),
 classification_id TEXT NOT NULL UNIQUE REFERENCES classification_entries(id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO classification_roles(role,classification_id)
SELECT 'originals',id FROM classification_entries
WHERE parent_id IS NULL AND (id='lakomics-originals' OR name='오리지널' COLLATE NOCASE)
ORDER BY CASE WHEN id='lakomics-originals' THEN 0 ELSE 1 END,created_at,id LIMIT 1;

DROP TRIGGER IF EXISTS character_autotag_target_update;
CREATE TRIGGER character_autotag_target_update
AFTER UPDATE OF enabled,series_classification_id,manual_only ON character_targets
WHEN OLD.enabled IS NOT NEW.enabled
  OR OLD.series_classification_id IS NOT NEW.series_classification_id
  OR OLD.manual_only IS NOT NEW.manual_only BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT NEW.series_classification_id
 WHERE NEW.series_classification_id IS NOT NULL AND NEW.manual_only=0
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT OLD.series_classification_id
 WHERE OLD.series_classification_id IS NOT NULL AND OLD.manual_only=0
   AND (OLD.series_classification_id IS NOT NEW.series_classification_id OR NEW.manual_only<>0)
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

DROP TRIGGER IF EXISTS character_base_reference_insert;
CREATE TRIGGER character_base_reference_insert AFTER INSERT ON character_references
WHEN EXISTS(SELECT 1 FROM character_targets WHERE id=NEW.target_id AND manual_only=0) BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets
 WHERE id=NEW.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

DROP TRIGGER IF EXISTS character_base_reference_delete;
CREATE TRIGGER character_base_reference_delete AFTER DELETE ON character_references
WHEN EXISTS(SELECT 1 FROM character_targets WHERE id=OLD.target_id AND manual_only=0) BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets
 WHERE id=OLD.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

DROP TRIGGER IF EXISTS character_base_reference_update;
CREATE TRIGGER character_base_reference_update AFTER UPDATE OF asset_id,asset_hash ON character_references
WHEN EXISTS(SELECT 1 FROM character_targets WHERE id=NEW.target_id AND manual_only=0) BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets
 WHERE id=NEW.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

UPDATE character_autotag_jobs
SET priority=CASE WHEN cause='manual_scan' THEN 0 WHEN cause='reconsideration' THEN 2 ELSE 1 END;

CREATE TEMP TABLE _v61_character_repair(asset_id TEXT NOT NULL, series_id TEXT NOT NULL, PRIMARY KEY(asset_id,series_id));
INSERT OR IGNORE INTO _v61_character_repair(asset_id,series_id)
SELECT DISTINCT j.asset_id,p.series_id
FROM character_autotag_jobs j
JOIN character_autotag_evidence e ON e.asset_id=j.asset_id
  AND e.generation=j.generation AND e.source_generation=j.source_generation
JOIN character_autotag_predictions p ON p.evidence_id=e.id
WHERE j.state='completed' AND j.review_state='resolved'
  AND json_array_length(p.result_json,'$.evidence.queryBoxes') > 1
  AND EXISTS (
    SELECT 1 FROM json_each(p.result_json,'$.evidence.referenceHashes') reference
    WHERE reference.value=e.content_hash
  );

UPDATE character_autotag_jobs
SET review_state='partially_resolved'
WHERE asset_id IN (SELECT asset_id FROM _v61_character_repair);

INSERT INTO character_autotag_reconsideration(series_id)
SELECT DISTINCT series_id FROM _v61_character_repair WHERE 1
ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;

DROP TABLE _v61_character_repair;
PRAGMA user_version = 61;
