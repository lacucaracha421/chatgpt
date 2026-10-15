//! Desktop-local container configuration and metadata-only registration scope.
use super::{
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(super) fn reject_container(c: &Connection, id: &str) -> Result<()> {
    if c.query_row(
        "SELECT EXISTS(SELECT 1 FROM classification_containers WHERE classification_id=?1)",
        [id],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(Error::Invalid(
            "분류함에는 캐릭터를 등록할 수 없습니다. 하위 시리즈를 골라 주세요.",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMove {
    pub target_id: String,
    pub destination_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerConversion {
    pub moved_count: usize,
    /// Images used by a moved character and at least one other character.
    pub shared_count: usize,
    /// Of those, how many sit in the folder itself and stay there as plain content.
    pub kept_in_folder_count: usize,
    /// Characters whose references end up outside their series (they stop counting as
    /// references) because a shared image cannot be inside two child series at once.
    pub reference_losses: Vec<ReferenceLoss>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceLoss {
    pub target_id: String,
    pub name: String,
    pub ineligible_count: usize,
    pub loses_ready: bool,
}

fn ineligible_references(target: &super::characters::Target) -> usize {
    target
        .references
        .iter()
        .chain(&target.learned_references)
        .filter(|reference| reference.status == "ineligible")
        .count()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationPreviewRequest {
    pub series_id: String,
    pub mode: RegistrationMode,
    #[serde(default)]
    pub reference_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    Manual,
    Settings,
    Folder,
    Promotion,
    Suggestion,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationPreview {
    pub image_count: usize,
    pub other_series: bool,
}

// The same indexed, metadata-only scope drives preview and suggestion enrollment.
// Carry the nearest registered series down the tree, including its opt-out. No
// Asset scan, reference file checks, or thumbnail decoding belongs in this query.
pub(super) const REGISTRATION_IMAGES: &str = "WITH RECURSIVE scope(id,series_id,auto) AS (
 SELECT e.id,e.id,COALESCE(s.auto_classify,1) FROM classification_entries e
 LEFT JOIN character_series s ON s.classification_id=e.id WHERE e.id=?1
 UNION ALL SELECT e.id,COALESCE(s.classification_id,p.series_id),COALESCE(s.auto_classify,p.auto)
 FROM scope p JOIN classification_entries e ON e.parent_id=p.id
 LEFT JOIN character_series s ON s.classification_id=e.id
)
SELECT DISTINCT a.id FROM scope s
CROSS JOIN asset_classifications ac ON ac.classification_id=s.id
CROSS JOIN assets a ON a.id=ac.asset_id
WHERE a.status='normal' AND a.media_kind='image' AND s.auto=1
AND a.id NOT IN (SELECT value FROM json_each(?2))
AND NOT EXISTS(SELECT 1 FROM character_excluded_folders x WHERE x.id=s.id)
AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions x WHERE x.series_id=s.series_id AND x.asset_id=a.id)
AND (SELECT COUNT(*) FROM asset_classifications links WHERE links.asset_id=a.id)=1";

impl Library {
    pub fn set_character_container(&self, folder_id: &str, enabled: bool) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        Self::set_container_in(&tx, folder_id, enabled)?;
        tx.commit()?;
        Ok(())
    }

    fn set_container_in(tx: &Connection, folder_id: &str, enabled: bool) -> Result<()> {
        let eligible: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id=?1 AND parent_id IS NULL AND kind='root')", [folder_id], |r| r.get(0))?;
        if !eligible {
            return Err(Error::Invalid("맨 위 폴더만 분류함으로 쓸 수 있습니다."));
        }
        if enabled {
            if super::classification::classification_in_role_scope(tx, folder_id, "originals")? {
                return Err(Error::Invalid(
                    "오리지널 보관 영역은 분류함으로 쓸 수 없습니다.",
                ));
            }
            let has_characters: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM character_targets WHERE series_classification_id=?1 AND role='character')", [folder_id], |r| r.get(0))?;
            if has_characters {
                return Err(Error::Invalid(
                    "캐릭터를 하위 시리즈로 옮긴 뒤 분류함으로 바꿔 주세요.",
                ));
            }
            let registered: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
                [folder_id],
                |r| r.get(0),
            )?;
            if registered {
                Self::unregister_in(tx, folder_id)?;
            }
            tx.execute(
                "INSERT OR IGNORE INTO classification_containers(classification_id) VALUES(?1)",
                [folder_id],
            )?;
        } else {
            tx.execute(
                "DELETE FROM classification_containers WHERE classification_id=?1",
                [folder_id],
            )?;
        }
        Ok(())
    }

    /// Moves every listed character to its child series and then marks the folder as a
    /// 분류함, in one transaction. A failure at any step leaves the library unchanged.
    /// Shared images are never re-parented to a series that cannot serve the other
    /// characters: when only the folder itself could hold them, they stay where they are.
    fn convert_to_container_in(
        &self,
        tx: &Connection,
        folder_id: &str,
        moves: &[ContainerMove],
    ) -> Result<(ContainerConversion, Vec<(String, String)>)> {
        let mut seen = std::collections::BTreeSet::new();
        let mut fingerprints = Vec::new();
        let mut before = std::collections::BTreeMap::new();
        for item in moves {
            let target = self.read_character_target(tx, &item.target_id)?;
            before.insert(
                item.target_id.clone(),
                (ineligible_references(&target), target.ready),
            );
        }
        for item in moves {
            if !seen.insert(item.target_id.as_str()) {
                return Err(Error::Invalid("같은 캐릭터가 두 번 선택되었습니다."));
            }
            if item.destination_id == folder_id {
                return Err(Error::Invalid(
                    "분류함 자신에게는 캐릭터를 옮길 수 없습니다. 하위 시리즈를 골라 주세요.",
                ));
            }
            let preview = self.character_series_move_in(
                tx,
                &item.target_id,
                &item.destination_id,
                Some(folder_id),
            )?;
            let moved =
                self.apply_series_move_in(tx, &item.target_id, &item.destination_id, preview)?;
            fingerprints.push((moved.id, moved.fingerprint));
        }
        // Read after every move: a later move can push an earlier character's shared image out.
        let mut reference_losses = Vec::new();
        for item in moves {
            let target = self.read_character_target(tx, &item.target_id)?;
            let (ineligible_before, ready_before) = before[&item.target_id];
            let ineligible_count = ineligible_references(&target).saturating_sub(ineligible_before);
            let loses_ready = ready_before && !target.ready;
            if ineligible_count > 0 || loses_ready {
                reference_losses.push(ReferenceLoss {
                    target_id: item.target_id.clone(),
                    name: target.display_name,
                    ineligible_count,
                    loses_ready,
                });
            }
        }
        let moved_json =
            serde_json::to_string(&moves.iter().map(|m| &m.target_id).collect::<Vec<_>>())?;
        // Distinct images linked to one of the moved characters and to at least one other.
        let (shared_count, kept_in_folder_count): (i64, i64) = tx.query_row(
            "WITH links(target_id,asset_id) AS (
                SELECT target_id,asset_id FROM character_relations
                UNION SELECT target_id,asset_id FROM character_references WHERE asset_id IS NOT NULL
                UNION SELECT target_id,asset_id FROM character_learned_references
            ), shared(asset_id) AS (
                SELECT asset_id FROM links WHERE asset_id IN (SELECT asset_id FROM links WHERE target_id IN (SELECT value FROM json_each(?1)))
                GROUP BY asset_id HAVING COUNT(DISTINCT target_id)>1
            ) SELECT COUNT(*),COALESCE(SUM(EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=shared.asset_id AND ac.classification_id=?2)),0) FROM shared",
            params![moved_json, folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Self::set_container_in(tx, folder_id, true)?;
        Ok((
            ContainerConversion {
                moved_count: moves.len(),
                shared_count: shared_count as usize,
                kept_in_folder_count: kept_in_folder_count as usize,
                reference_losses,
            },
            fingerprints,
        ))
    }

    /// Dry run of the whole conversion: reports the outcome or the error, writes nothing.
    pub fn container_conversion_preview(
        &self,
        folder_id: &str,
        moves: &[ContainerMove],
    ) -> Result<ContainerConversion> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let (summary, _) = self.convert_to_container_in(&tx, folder_id, moves)?;
        drop(tx); // rolled back
        Ok(summary)
    }

    pub fn convert_to_container(
        &self,
        folder_id: &str,
        moves: &[ContainerMove],
    ) -> Result<ContainerConversion> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let (summary, fingerprints) = self.convert_to_container_in(&tx, folder_id, moves)?;
        tx.commit()?;
        drop(c);
        for (target_id, fingerprint) in fingerprints {
            self.cancel_obsolete_character_scan(&target_id, &fingerprint);
        }
        Ok(summary)
    }

    pub fn character_registration_preview(
        &self,
        request: RegistrationPreviewRequest,
    ) -> Result<RegistrationPreview> {
        let c = self.connection()?;
        reject_container(&c, &request.series_id)?;
        let exists: Option<String> = c
            .query_row(
                "SELECT id FROM classification_entries WHERE id=?1",
                [&request.series_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(Error::Invalid("시리즈 폴더를 찾을 수 없습니다."));
        }
        // Quiet workflow: only suggestion registration enrolls historical inference.
        // Other creation paths (including promotion with references) start with new images.
        if !matches!(request.mode, RegistrationMode::Suggestion)
            || request
                .reference_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                < 5
        {
            return Ok(RegistrationPreview {
                image_count: 0,
                other_series: false,
            });
        }
        if super::classification::classification_in_role_scope(&c, &request.series_id, "originals")?
        {
            return Ok(RegistrationPreview {
                image_count: 0,
                other_series: false,
            });
        }
        let image_count: i64 = c.query_row(
            &format!("SELECT COUNT(*) FROM ({REGISTRATION_IMAGES})"),
            params![
                request.series_id,
                serde_json::to_string(&request.reference_ids)?
            ],
            |r| r.get(0),
        )?;
        let other_series=c.query_row("WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE parent_id=?1 UNION ALL SELECT e.id FROM classification_entries e JOIN scope s ON e.parent_id=s.id) SELECT EXISTS(SELECT 1 FROM scope JOIN character_series cs ON cs.classification_id=scope.id)", [&request.series_id], |r|r.get(0))?;
        Ok(RegistrationPreview {
            image_count: image_count as usize,
            other_series,
        })
    }
}

#[cfg(test)]
#[path = "character_containers_tests.rs"]
mod tests;
