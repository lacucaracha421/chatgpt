//! Explicit series relocation. Never enroll historical or newly moved assets for analysis.
use super::{
    characters::{Error, Result, Target},
    models::SetAssetClassification,
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedLocation {
    pub classification_id: String,
    pub asset_count: usize,
    pub relocation_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMovePreview {
    pub target_id: String,
    pub destination_id: String,
    pub asset_count: usize,
    pub relocation_count: usize,
    pub shared_count: usize,
    pub shared_locations: Vec<SharedLocation>,
    pub group_name: Option<String>,
    pub token: String,
    #[serde(skip)]
    relocations: BTreeMap<String, Vec<String>>,
    #[serde(skip)]
    excluded_ids: Vec<String>,
}

fn in_subtree(c: &Connection, root: &str, folder: &str) -> Result<bool> {
    Ok(c.query_row(
        "WITH RECURSIVE scope(id) AS (
        SELECT id FROM classification_entries WHERE id=?1
        UNION SELECT e.id FROM classification_entries e JOIN scope s ON e.parent_id=s.id
    ) SELECT EXISTS(SELECT 1 FROM scope WHERE id=?2)",
        params![root, folder],
        |r| r.get(0),
    )?)
}

fn supports_membership(
    c: &Connection,
    series: &str,
    folder: &str,
    reference: bool,
) -> Result<bool> {
    Ok(in_subtree(c, series, folder)? || (!reference && in_subtree(c, folder, series)?))
}

// Prefer the destination; ascend only when shared memberships require it. References
// must stay within their owning series, even when ordinary accepted images can ascend.
fn shared_destination(
    c: &Connection,
    destination: &str,
    own_reference: bool,
    others: &[(String, Option<String>, bool)],
) -> Result<String> {
    let ancestors = c.prepare("WITH RECURSIVE lineage(id,parent_id,depth) AS (
        SELECT id,parent_id,0 FROM classification_entries WHERE id=?1
        UNION ALL SELECT e.id,e.parent_id,l.depth+1 FROM classification_entries e JOIN lineage l ON e.id=l.parent_id
    ) SELECT id FROM lineage ORDER BY depth")?.query_map([destination], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for folder in ancestors {
        if !supports_membership(c, destination, &folder, own_reference)? {
            continue;
        }
        let mut compatible = true;
        for (_, series, reference) in others {
            if !match series {
                Some(series) => supports_membership(c, series, &folder, *reference)?,
                None => false,
            } {
                compatible = false;
                break;
            }
        }
        if compatible
            && !super::classification::classification_in_role_scope(c, &folder, "originals")?
        {
            return Ok(folder);
        }
    }
    Err(Error::Invalid("공유 자료의 레퍼런스와 캐릭터 연결을 함께 보존할 공통 상위 폴더가 없습니다. 레퍼런스 또는 시리즈 구조를 먼저 확인해 주세요."))
}

impl Library {
    fn character_series_move_in(
        &self,
        c: &Connection,
        target_id: &str,
        destination_id: &str,
    ) -> Result<SeriesMovePreview> {
        let target = self.read_character_target(c, target_id)?;
        if target.series_classification_id.as_deref() == Some(destination_id) {
            return Err(Error::Invalid("이미 이 시리즈에 속한 캐릭터입니다."));
        }
        let registered: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [destination_id],
            |r| r.get(0),
        )?;
        if !registered
            || super::classification::classification_in_role_scope(c, destination_id, "originals")?
        {
            return Err(Error::Invalid(
                "이동할 수 있는 등록 시리즈를 선택해 주세요.",
            ));
        }
        let duplicate: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM character_targets WHERE series_classification_id=?1 AND display_name=?2 COLLATE NOCASE AND id<>?3)", params![destination_id,target.display_name,target_id], |r| r.get(0))?;
        if duplicate {
            return Err(Error::Invalid(
                "대상 시리즈에 같은 이름의 캐릭터가 있습니다. 이름을 구분한 뒤 이동해 주세요.",
            ));
        }
        let group: Option<(String, String, i64)> = c.query_row("SELECT g.id,g.name,g.revision FROM character_groups g JOIN character_group_members m ON m.group_id=g.id WHERE m.target_id=?1", [target_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        // Include unavailable references and portraits so restore keeps their destination.
        let ids = c.prepare("SELECT asset_id FROM character_relations WHERE target_id=?1
            UNION SELECT asset_id FROM character_references WHERE target_id=?1 AND asset_id IS NOT NULL
            UNION SELECT asset_id FROM character_learned_references WHERE target_id=?1
            UNION SELECT thumbnail_asset_id FROM character_targets WHERE id=?1 AND thumbnail_asset_id IS NOT NULL
            ORDER BY 1")?.query_map([target_id], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut relocations: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut shared_locations: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        let mut excluded_ids = Vec::new();
        let mut shared_count = 0;
        let mut snapshot = Vec::new();
        for id in &ids {
            let asset: (String, String) = c.query_row(
                "SELECT status,content_hash FROM assets WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let folders = c.prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id")?.query_map([id], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            let others = c.prepare("SELECT t.id,t.series_classification_id,
                EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=t.id AND r.asset_id=?2)
                OR EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=t.id AND r.asset_id=?2)
                FROM character_targets t WHERE t.id<>?1 AND (
                    EXISTS(SELECT 1 FROM character_relations r WHERE r.target_id=t.id AND r.asset_id=?2)
                    OR EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=t.id AND r.asset_id=?2)
                    OR EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=t.id AND r.asset_id=?2)
                ) ORDER BY t.id")?.query_map(params![target_id,id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,bool>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            if !others.is_empty() {
                shared_count += 1;
            }
            let own_reference = target
                .references
                .iter()
                .chain(&target.learned_references)
                .any(|r| r.asset_id.as_ref() == Some(id));
            // Keep an existing theme folder or shared common ancestor when every
            // participant, including any reference owner, can still use that location.
            let mut keep_folder = folders.len() == 1
                && supports_membership(c, destination_id, &folders[0], own_reference)?
                && (!others.is_empty() || in_subtree(c, destination_id, &folders[0])?);
            if keep_folder {
                for (_, series, reference) in &others {
                    if !match series {
                        Some(series) => supports_membership(c, series, &folders[0], *reference)?,
                        None => false,
                    } {
                        keep_folder = false;
                        break;
                    }
                }
            }
            let placement = if keep_folder {
                folders[0].clone()
            } else {
                shared_destination(c, destination_id, own_reference, &others)?
            };
            if !in_subtree(c, destination_id, &placement)? {
                let counts = shared_locations.entry(placement.clone()).or_default();
                counts.0 += 1;
                counts.1 += usize::from(!keep_folder);
            }
            let excluded = super::character_folders::asset_excluded(c, id)?
                || match target.series_classification_id.as_deref() {
                    Some(series) => super::character_hub::series_asset_excluded(c, series, id)?,
                    None => false,
                };
            if excluded {
                excluded_ids.push(id.clone());
            }
            if !keep_folder {
                for folder in &folders {
                    if super::classification::classification_in_role_scope(c, folder, "originals")?
                    {
                        return Err(Error::Invalid("오리지널 영역의 연결 이미지가 있습니다. 해당 이미지의 연결을 먼저 확인해 주세요."));
                    }
                }
                relocations.entry(placement).or_default().push(id.clone());
            }
            snapshot.push((id, asset, folders, others, excluded));
        }
        // A preview is bound to hierarchy, settings, groups and memberships, not just a target revision.
        let hierarchy: String = c.query_row("SELECT json_group_array(json_array(id,parent_id)) FROM (SELECT id,parent_id FROM classification_entries ORDER BY id)", [], |r| r.get(0))?;
        let last_decision: i64 = c.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM character_decisions WHERE target_id=?1",
            [target_id],
            |r| r.get(0),
        )?;
        let token = Sha256::digest(serde_json::to_vec(&(
            &target,
            destination_id,
            &group,
            &snapshot,
            hierarchy,
            last_decision,
            &relocations,
        ))?)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect();
        Ok(SeriesMovePreview {
            target_id: target_id.into(),
            destination_id: destination_id.into(),
            asset_count: ids.len(),
            relocation_count: relocations.values().map(Vec::len).sum(),
            shared_count,
            shared_locations: shared_locations
                .into_iter()
                .map(
                    |(classification_id, (asset_count, relocation_count))| SharedLocation {
                        classification_id,
                        asset_count,
                        relocation_count,
                    },
                )
                .collect(),
            group_name: group.map(|g| g.1),
            token,
            relocations,
            excluded_ids,
        })
    }

    pub fn character_series_move_preview(
        &self,
        target_id: &str,
        destination_id: &str,
    ) -> Result<SeriesMovePreview> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        self.character_series_move_in(&tx, target_id, destination_id)
    }

    pub fn move_character_to_series(
        &self,
        target_id: &str,
        destination_id: &str,
        token: &str,
    ) -> Result<Target> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let preview = self.character_series_move_in(&tx, target_id, destination_id)?;
        if preview.token != token {
            return Err(Error::Stale);
        }
        let now = chrono::Utc::now().timestamp();
        // Carry explicit opt-outs across the move instead of silently re-enabling these assets.
        tx.execute("INSERT OR IGNORE INTO character_series_asset_exclusions(series_id,asset_id,created_at)
            SELECT ?2,a.id,?3 FROM assets a WHERE a.id IN (
                SELECT asset_id FROM character_relations WHERE target_id=?1
                UNION SELECT asset_id FROM character_references WHERE target_id=?1
                UNION SELECT asset_id FROM character_learned_references WHERE target_id=?1
                UNION SELECT thumbnail_asset_id FROM character_targets WHERE id=?1
            ) AND (EXISTS(SELECT 1 FROM character_series_asset_exclusions e JOIN character_targets t ON t.series_classification_id=e.series_id WHERE t.id=?1 AND e.asset_id=a.id)
                OR EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_excluded_folders e ON e.id=ac.classification_id WHERE ac.asset_id=a.id))", params![target_id,destination_id,chrono::Utc::now().to_rfc3339()])?;
        // Fence only jobs still owned by this target's refresh, before closing the refresh.
        tx.execute("UPDATE character_autotag_jobs SET state='superseded',review_state='superseded',claim_id=NULL,error=NULL
            WHERE cause='reconsideration' AND EXISTS(SELECT 1 FROM character_reference_refresh_items i
                WHERE i.target_id=?1 AND i.asset_id=character_autotag_jobs.asset_id AND i.generation=character_autotag_jobs.generation AND i.state IN ('pending','processing'))", [target_id])?;
        tx.execute("UPDATE character_reference_refresh_items SET state='superseded',updated_at=?2 WHERE target_id=?1 AND state IN ('pending','processing')", params![target_id,now])?;
        tx.execute("UPDATE character_reference_refreshes SET state='completed',discovery_complete=1,completed_at=?2,updated_at=?2,last_error=NULL WHERE target_id=?1", params![target_id,now])?;
        for (folder_id, asset_ids) in preview.relocations {
            let ids_json = serde_json::to_string(&asset_ids)?;
            // In-flight comparisons of these assets may no longer publish or retry on their old claim.
            tx.execute("UPDATE character_autotag_jobs SET state='superseded',review_state='superseded',claim_id=NULL,error=NULL WHERE asset_id IN (SELECT value FROM json_each(?1))", [&ids_json])?;
            tx.execute("UPDATE character_reference_refresh_items SET state='superseded',updated_at=?2 WHERE asset_id IN (SELECT value FROM json_each(?1)) AND state IN ('pending','processing')", params![ids_json,now])?;
            Self::set_asset_classification_cause_in(
                &tx,
                &SetAssetClassification {
                    asset_ids,
                    classification_id: Some(folder_id),
                },
                super::character_autotag::Cause::AutomaticFinalization,
            )?;
        }
        // An excluded image relocated to a common ancestor must not become eligible
        // for that ancestor's automatic scope on a later restore or ingestion.
        for asset_id in &preview.excluded_ids {
            if let Some(scope) = super::character_scope::resolve_character_scope(&tx, asset_id)? {
                for series_id in scope.series_classification_ids {
                    tx.execute("INSERT OR IGNORE INTO character_series_asset_exclusions(series_id,asset_id,created_at) VALUES(?1,?2,?3)", params![series_id,asset_id,chrono::Utc::now().to_rfc3339()])?;
                }
            }
        }
        // The existing trigger removes old group membership and increments its revision.
        // An ordinary linked folder stays in place and becomes visible as an ordinary folder again.
        tx.execute("UPDATE character_targets SET series_classification_id=?2,linked_classification_id=NULL,revision=revision+1,updated_at=?3 WHERE id=?1", params![target_id,destination_id,chrono::Utc::now().to_rfc3339()])?;
        let result = self.read_character_target(&tx, target_id)?;
        tx.commit()?;
        // Stop only an obsolete explicit scan of this character, not the native queue.
        drop(c);
        if let Some(scan) = self.character_scan_status() {
            if scan.target_id == target_id
                && scan.target_fingerprint != result.fingerprint
                && matches!(scan.state.as_str(), "running" | "cancelling")
            {
                let _ = self.cancel_character_scan(&scan.id);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "character_series_move_tests.rs"]
mod tests;
