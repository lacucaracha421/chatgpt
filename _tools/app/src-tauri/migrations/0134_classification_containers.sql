-- Recognition configuration is desktop-local, like character_folder_exclusions.
-- Do not extend the published Classification authority contract.
CREATE TABLE classification_containers (
 classification_id TEXT PRIMARY KEY REFERENCES classification_entries(id) ON DELETE CASCADE
);
CREATE TRIGGER classification_container_top_level BEFORE INSERT ON classification_containers
WHEN NOT EXISTS(SELECT 1 FROM classification_entries WHERE id=NEW.classification_id AND parent_id IS NULL AND kind='root')
BEGIN SELECT RAISE(ABORT, '맨 위 폴더만 분류함으로 쓸 수 있습니다.'); END;
-- Remote authoritative folder moves can still be projected by this desktop.
-- A folder that ceases to be top-level loses only its local recognition flag.
CREATE TRIGGER classification_container_move AFTER UPDATE OF parent_id,kind ON classification_entries
WHEN NEW.parent_id IS NOT NULL OR NEW.kind<>'root'
BEGIN DELETE FROM classification_containers WHERE classification_id=NEW.id; END;
CREATE TRIGGER classification_container_empty BEFORE INSERT ON classification_containers
WHEN EXISTS(SELECT 1 FROM character_series WHERE classification_id=NEW.classification_id)
 OR EXISTS(SELECT 1 FROM character_targets WHERE series_classification_id=NEW.classification_id)
BEGIN SELECT RAISE(ABORT, '캐릭터를 하위 시리즈로 옮긴 뒤 분류함으로 바꿔 주세요.'); END;
CREATE TRIGGER classification_container_series BEFORE INSERT ON character_series
WHEN EXISTS(SELECT 1 FROM classification_containers WHERE classification_id=NEW.classification_id)
BEGIN SELECT RAISE(ABORT, '분류함에는 캐릭터를 등록할 수 없습니다. 하위 시리즈를 골라 주세요.'); END;
CREATE TRIGGER classification_container_target BEFORE INSERT ON character_targets
WHEN EXISTS(SELECT 1 FROM classification_containers WHERE classification_id=NEW.series_classification_id)
BEGIN SELECT RAISE(ABORT, '분류함에는 캐릭터를 등록할 수 없습니다. 하위 시리즈를 골라 주세요.'); END;
CREATE TRIGGER classification_container_target_move BEFORE UPDATE OF series_classification_id ON character_targets
WHEN EXISTS(SELECT 1 FROM classification_containers WHERE classification_id=NEW.series_classification_id)
BEGIN SELECT RAISE(ABORT, '분류함에는 캐릭터를 등록할 수 없습니다. 하위 시리즈를 골라 주세요.'); END;
PRAGMA user_version = 134;
