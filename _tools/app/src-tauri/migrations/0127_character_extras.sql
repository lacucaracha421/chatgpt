-- 기타 (extras): an unnamed bucket per character group and per series, stored like a manual
-- character so membership, counts, publication and "remove from character" keep one path.
-- A 기타 is never a recognition target and never a learning source. Rows are created lazily
-- (no data is added here), so an upgraded library shows no new characters until a person
-- opens or fills a 기타.
ALTER TABLE character_targets ADD COLUMN role TEXT NOT NULL DEFAULT 'character'
 CHECK(role IN ('character','extras'));
-- NULL for a series-level 기타; the group's id for a group's 기타 (no foreign key: a group's
-- deletion removes its 기타 through character_extras_group_deleted below).
ALTER TABLE character_targets ADD COLUMN extras_group_id TEXT;

-- One 기타 per series and one per group, enforced by the database.
CREATE UNIQUE INDEX character_extras_one_per_series
ON character_targets(series_classification_id)
WHERE role='extras' AND extras_group_id IS NULL;
CREATE UNIQUE INDEX character_extras_one_per_group
ON character_targets(extras_group_id)
WHERE role='extras' AND extras_group_id IS NOT NULL;

-- A 기타 is manual-only, belongs to a series, and never changes kind.
CREATE TRIGGER character_extras_insert_valid BEFORE INSERT ON character_targets
WHEN (NEW.role='extras' AND (NEW.manual_only<>1 OR NEW.series_classification_id IS NULL))
  OR (NEW.role='character' AND NEW.extras_group_id IS NOT NULL) BEGIN
 SELECT RAISE(ABORT, '기타는 수동 보관함으로만 만들 수 있습니다.');
END;
CREATE TRIGGER character_extras_update_valid
BEFORE UPDATE OF role,manual_only,extras_group_id ON character_targets
WHEN (NEW.role='extras' AND NEW.manual_only<>1)
  OR NEW.role IS NOT OLD.role
  OR NEW.extras_group_id IS NOT OLD.extras_group_id BEGIN
 SELECT RAISE(ABORT, '기타는 자동 인식을 켜거나 바꿀 수 없습니다.');
END;

-- Never a recognition target or learning source: no references, no tagger-tag mapping.
CREATE TRIGGER character_extras_no_reference BEFORE INSERT ON character_references
WHEN EXISTS(SELECT 1 FROM character_targets WHERE id=NEW.target_id AND role='extras') BEGIN
 SELECT RAISE(ABORT, '기타에는 레퍼런스를 둘 수 없습니다.');
END;
CREATE TRIGGER character_extras_no_learned_reference BEFORE INSERT ON character_learned_references
WHEN EXISTS(SELECT 1 FROM character_targets WHERE id=NEW.target_id AND role='extras') BEGIN
 SELECT RAISE(ABORT, '기타에는 레퍼런스를 둘 수 없습니다.');
END;
CREATE TRIGGER character_extras_no_tagger_tag BEFORE INSERT ON character_target_tagger_tags
WHEN EXISTS(SELECT 1 FROM character_targets WHERE id=NEW.target_id AND role='extras') BEGIN
 SELECT RAISE(IGNORE);
END;

-- A group's 기타 may only be a member of its own group.
CREATE TRIGGER character_extras_member_guard BEFORE INSERT ON character_group_members
WHEN EXISTS(SELECT 1 FROM character_targets t WHERE t.id=NEW.target_id AND t.role='extras'
            AND t.extras_group_id IS NOT NEW.group_id) BEGIN
 SELECT RAISE(ABORT, '기타는 자기 그룹에만 넣을 수 있습니다.');
END;

-- 기타 = people without a character yet. Whoever puts an image into a real character of the
-- same series (a person, B36, S36, a tagger confirmation) takes it out of that series' 기타
-- buckets. The departure is a removal ('cleared'), never a rejection, so it cannot count as
-- wrong in any readiness statistic.
CREATE TRIGGER character_extras_leave_on_accept AFTER INSERT ON character_decisions
WHEN NEW.decision='accepted' AND NEW.asset_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM character_targets t WHERE t.id=NEW.target_id AND t.role='character'
            AND t.series_classification_id IS NOT NULL) BEGIN
 INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,
  target_fingerprint,baseline_fingerprint,reference_snapshot,origin,created_at)
 SELECT x.id,NEW.asset_id,NEW.source_asset_id,NEW.asset_hash,'cleared','extras-left',NULL,
  '{"reason":"joined_character"}','automatic',NEW.created_at
 FROM character_targets me JOIN character_targets x
  ON x.series_classification_id=me.series_classification_id AND x.role='extras'
 WHERE me.id=NEW.target_id
  AND EXISTS(SELECT 1 FROM character_relations r WHERE r.target_id=x.id AND r.asset_id=NEW.asset_id);
END;

-- A group is empty when it has no real member and its 기타 holds no image. A group that has
-- only a 기타 is allowed; the last real member leaving keeps a group whose 기타 has images.
DROP TRIGGER character_group_remove_empty;
CREATE TRIGGER character_group_remove_empty
AFTER DELETE ON character_group_members
BEGIN
    DELETE FROM character_groups
    WHERE id = OLD.group_id
      AND NOT EXISTS (
          SELECT 1 FROM character_group_members m
          JOIN character_targets t ON t.id = m.target_id
          WHERE m.group_id = OLD.group_id AND t.role = 'character')
      AND NOT EXISTS (
          SELECT 1 FROM character_targets t
          JOIN character_relations r ON r.target_id = t.id
          WHERE t.role = 'extras' AND t.extras_group_id = OLD.group_id);
END;

-- A deleted group takes its (empty or force-deleted) 기타 with it.
CREATE TRIGGER character_extras_group_deleted AFTER DELETE ON character_groups BEGIN
 DELETE FROM character_decisions
 WHERE target_id IN (SELECT id FROM character_targets WHERE role='extras' AND extras_group_id=OLD.id);
 DELETE FROM character_targets WHERE role='extras' AND extras_group_id=OLD.id;
END;

-- Moving a character's series keeps its group when the group already moved there first
-- (series unregistration moves the group, then its members). Any other series change still
-- removes the membership, as before.
DROP TRIGGER character_group_series_changed;
CREATE TRIGGER character_group_series_changed AFTER UPDATE OF series_classification_id ON character_targets
WHEN OLD.series_classification_id IS NOT NEW.series_classification_id
 AND NOT EXISTS(SELECT 1 FROM character_group_members m JOIN character_groups g ON g.id=m.group_id
                WHERE m.target_id=NEW.id AND g.series_id IS NEW.series_classification_id) BEGIN
 UPDATE character_groups SET revision=revision+1 WHERE id IN (SELECT group_id FROM character_group_members WHERE target_id=NEW.id);
 DELETE FROM character_group_members WHERE target_id=NEW.id;
END;

PRAGMA user_version = 127;
