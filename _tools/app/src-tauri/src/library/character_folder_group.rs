//! Tidy one plain leaf folder into the nearest registered series' named group.
//! Preview reads a consistent snapshot; apply recomputes it under an immediate transaction.
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    character_extras::{create_extras_group_in, ensure_extras_in},
    characters::{CharacterMoveTarget, DecisionKind, Error, Result},
    models::SetAssetClassification,
    Library,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroupPreview {
    pub folder_id: String,
    pub folder_name: String,
    pub series_id: Option<String>,
    pub series_name: Option<String>,
    pub group_name: String,
    pub group_id: Option<String>,
    pub character_asset_count: usize,
    pub unassigned_asset_count: usize,
    /// Unsupported or non-normal assets follow deletion to the folder's immediate parent.
    pub other_asset_count: usize,
    pub parent_name: Option<String>,
    pub refusal: Option<String>,
    pub token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroupResult {
    pub series_id: String,
    pub group_id: String,
}

struct Plan {
    preview: FolderGroupPreview,
    character_assets: Vec<String>,
    unassigned_assets: Vec<String>,
}

/// Ordered JSON rows keep identities (not just counts) in the preview token.
fn snapshot_rows(connection: &Connection, sql: &str, id: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare(sql)?
        .query_map([id], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn plan(connection: &Connection, folder_id: &str) -> Result<Plan> {
    let (folder_name, parent_id): (String, Option<String>) = connection
        .query_row(
            "SELECT name,parent_id FROM classification_entries WHERE id=?1",
            [folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(Error::Stale)?;
    let ancestry = connection
        .prepare(
            "WITH RECURSIVE up(id,parent_id,depth) AS (
                SELECT id,parent_id,0 FROM classification_entries WHERE id=?1
                UNION ALL SELECT c.id,c.parent_id,u.depth+1 FROM classification_entries c
                JOIN up u ON c.id=u.parent_id WHERE u.depth<1000
             ) SELECT c.id,c.name,c.parent_id,u.depth,
                EXISTS(SELECT 1 FROM character_series s WHERE s.classification_id=c.id),
                EXISTS(SELECT 1 FROM character_excluded_folders e WHERE e.id=c.id)
             FROM up u JOIN classification_entries c ON c.id=u.id ORDER BY u.depth",
        )?
        .query_map([folder_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)? as usize,
                row.get::<_, bool>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let destination = ancestry.iter().find(|a| a.3 > 0 && a.4);
    let series_id = destination.map(|a| a.0.clone());
    let series_name = destination.map(|a| a.1.clone());
    let group_name = folder_name.trim().to_owned();
    let groups = match &series_id {
        Some(id) => connection
            .prepare(
                "SELECT id,name,revision FROM character_groups WHERE series_id=?1 ORDER BY id",
            )?
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    let matching = groups
        .iter()
        .filter(|g| g.1.trim() == group_name)
        .collect::<Vec<_>>();
    let group_id = matching.first().map(|g| g.0.clone());
    let children = snapshot_rows(
        connection,
        "SELECT json_array(id,name) FROM classification_entries WHERE parent_id=?1 ORDER BY id",
        folder_id,
    )?;
    let linked = snapshot_rows(connection,
        "SELECT json_array(id,revision) FROM character_targets WHERE linked_classification_id=?1 ORDER BY id", folder_id)?;
    let assets = connection
        .prepare(
            "SELECT a.id,a.status,a.media_kind,a.content_hash,
            EXISTS(SELECT 1 FROM character_relations r JOIN character_targets t ON t.id=r.target_id
                   WHERE r.asset_id=a.id AND t.role='character'),
            (SELECT COUNT(*) FROM asset_classifications x WHERE x.asset_id=a.id),
            EXISTS(SELECT 1 FROM character_series_asset_exclusions e WHERE e.asset_id=a.id),
            EXISTS(SELECT 1 FROM asset_classifications x JOIN character_excluded_folders e
                   ON e.id=x.classification_id WHERE x.asset_id=a.id)
         FROM asset_classifications ac JOIN assets a ON a.id=ac.asset_id
         WHERE ac.classification_id=?1 ORDER BY a.id",
        )?
        .query_map([folder_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, i64>(5)? as usize,
                row.get::<_, bool>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let memberships = snapshot_rows(
        connection,
        "SELECT json_array(x.asset_id,x.classification_id) FROM asset_classifications x
         WHERE x.asset_id IN (SELECT asset_id FROM asset_classifications WHERE classification_id=?1)
         ORDER BY x.asset_id,x.classification_id",
        folder_id,
    )?;
    let relations = snapshot_rows(connection,
        "SELECT json_array(r.asset_id,r.target_id,r.sequence,t.role,t.revision,t.series_classification_id)
         FROM character_relations r JOIN character_targets t ON t.id=r.target_id
         WHERE r.asset_id IN (SELECT asset_id FROM asset_classifications WHERE classification_id=?1)
         ORDER BY r.asset_id,r.target_id", folder_id)?;
    let mut character_assets = Vec::new();
    let mut unassigned_assets = Vec::new();
    let mut other_asset_count = 0;
    for asset in &assets {
        if asset.1 == "normal" && matches!(asset.2.as_str(), "image" | "video" | "gif") {
            if asset.4 {
                character_assets.push(asset.0.clone());
            } else {
                unassigned_assets.push(asset.0.clone());
            }
        } else {
            other_asset_count += 1;
        }
    }
    let refusal =
        if parent_id.is_none() || ancestry.first().is_some_and(|a| a.4) || !linked.is_empty() {
            Some("시리즈 아래의 일반 폴더를 선택해 주세요.")
        } else if super::classification::classification_in_role_scope(
            connection,
            folder_id,
            "originals",
        )? {
            Some("오리지널 보관 영역에서는 그룹으로 정리할 수 없습니다.")
        } else if series_id.is_none() {
            Some("옮겨 갈 등록된 상위 시리즈가 없습니다.")
        } else if ancestry.iter().any(|a| a.5) || assets.iter().any(|a| a.7) {
            Some("캐릭터 분류에서 제외된 폴더입니다. 먼저 제외를 해제해 주세요.")
        } else if !children.is_empty() {
            Some("하위 폴더가 있어 그룹으로 정리할 수 없습니다. 하위 폴더를 먼저 정리해 주세요.")
        } else if assets.is_empty() {
            Some("폴더가 비어 있어 그룹으로 정리할 수 없습니다.")
        } else if assets.iter().any(|a| a.5 > 1) {
            Some("여러 폴더에 들어 있는 자산이 있습니다. 폴더 정보를 먼저 확인해 주세요.")
        } else if assets.iter().any(|a| a.6) {
            Some("시리즈의 캐릭터 분류에서 제외된 자산이 있습니다. 먼저 제외를 해제해 주세요.")
        } else if group_name.is_empty() || group_name.chars().count() > 100 {
            Some("그룹 이름으로 쓸 수 있도록 폴더 이름을 1~100자로 바꿔 주세요.")
        } else if matching.len() > 1 {
            Some("같은 이름의 그룹이 여러 개 있습니다. 그룹 이름을 먼저 구분해 주세요.")
        } else {
            None
        };
    let mut preview = FolderGroupPreview {
        folder_id: folder_id.into(),
        folder_name,
        series_id,
        series_name,
        group_name,
        group_id,
        character_asset_count: character_assets.len(),
        unassigned_asset_count: unassigned_assets.len(),
        other_asset_count,
        parent_name: ancestry.get(1).map(|a| a.1.clone()),
        refusal: refusal.map(str::to_owned),
        token: String::new(),
    };
    preview.token = Sha256::digest(serde_json::to_vec(&(
        &preview,
        ancestry,
        groups,
        children,
        linked,
        assets,
        memberships,
        relations,
    ))?)
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>();
    Ok(Plan {
        preview,
        character_assets,
        unassigned_assets,
    })
}

impl Library {
    pub fn character_folder_group_preview(&self, folder_id: &str) -> Result<FolderGroupPreview> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let preview = plan(&tx, folder_id)?.preview;
        tx.commit()?;
        Ok(preview)
    }

    pub fn tidy_character_folder_into_group(
        &self,
        folder_id: &str,
        token: &str,
    ) -> Result<FolderGroupResult> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Plan {
            preview,
            character_assets,
            unassigned_assets,
        } = plan(&tx, folder_id)?;
        if preview.token != token {
            return Err(Error::Stale);
        }
        if let Some(refusal) = preview.refusal {
            return Err(Error::InvalidMessage(refusal));
        }
        let series_id = preview.series_id.ok_or(Error::Stale)?;
        let (group_id, extras_id) = match preview.group_id {
            Some(id) => {
                let extras = ensure_extras_in(&tx, &series_id, Some(&id))?;
                (id, extras)
            }
            None => create_extras_group_in(&tx, &series_id, &preview.group_name)?,
        };
        for chunk in unassigned_assets.chunks(200) {
            let target = self.read_character_target(&tx, &extras_id)?;
            self.move_assets_to_characters_in(
                &tx,
                vec![CharacterMoveTarget {
                    target_id: target.id,
                    expected_fingerprint: target.fingerprint,
                }],
                chunk.to_vec(),
                DecisionKind::Accepted,
                false,
            )?;
        }
        for chunk in character_assets.chunks(200) {
            Self::set_asset_classification_in(
                &tx,
                &SetAssetClassification {
                    asset_ids: chunk.to_vec(),
                    classification_id: Some(series_id.clone()),
                },
            )?;
        }
        Self::delete_classification_in(&tx, folder_id)?;
        tx.commit()?;
        // The existing connection update hook publishes the changed definitions and inputs.
        Ok(FolderGroupResult {
            series_id,
            group_id,
        })
    }
}

#[cfg(test)]
#[path = "character_folder_group_tests.rs"]
mod tests;
