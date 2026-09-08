//! Character identity is separate from the asset's single direct folder.
use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Library;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Library(#[from] super::error::LibraryError),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Worker(String),
    #[error("캐릭터를 찾을 수 없습니다.")]
    NotFound,
    #[error("캐릭터 설정이 바뀌었습니다. 새로고침 후 다시 시도해 주세요.")]
    Stale,
    #[error("{0}")]
    Invalid(&'static str),
}

const REFERENCE_COUNT: usize = 5;
const SCOPED_IMAGE: &str = "WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id = ?1
    UNION SELECT child.id FROM classification_entries child JOIN scope ON child.parent_id = scope.id
)
SELECT content_hash, relative_path FROM assets a
WHERE a.id = ?2 AND a.status = 'normal' AND a.media_kind = 'image'
AND EXISTS (SELECT 1 FROM asset_classifications ac
            WHERE ac.asset_id = a.id AND ac.classification_id IN (SELECT id FROM scope))";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDraft {
    pub id: Option<String>,
    pub expected_revision: Option<i64>,
    pub series_classification_id: Option<String>,
    pub linked_classification_id: Option<String>,
    pub display_name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub slot: u32,
    pub asset_id: Option<String>,
    pub asset_hash: String,
    // ready / missing_asset / ineligible / changed_content / missing_file
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub series_classification_id: Option<String>,
    pub linked_classification_id: Option<String>,
    pub display_name: String,
    pub enabled: bool,
    pub revision: i64,
    pub references: Vec<Reference>,
    pub ready: bool,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    Accepted,
    Rejected,
    Cleared,
}
impl DecisionKind {
    fn stored(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Cleared => "cleared",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRequest {
    pub target_id: String,
    pub expected_fingerprint: String,
    pub asset_ids: Vec<String>,
    pub decision: DecisionKind,
    // None means a manual decision. Predictions are not implemented in Batch 2.
    pub baseline_fingerprint: Option<String>,
    pub scan_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub sequence: i64,
    pub asset_id: Option<String>,
    pub source_asset_id: String,
    pub asset_hash: String,
    pub decision: String,
    pub target_fingerprint: String,
    pub baseline_fingerprint: Option<String>,
    pub reference_snapshot: String,
    pub created_at: String,
}

impl Library {
    pub fn list_character_targets(&self) -> Result<Vec<Target>> {
        let connection = self.connection()?;
        let ids = connection
            .prepare("SELECT id FROM character_targets ORDER BY display_name COLLATE NOCASE, id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| self.read_character_target(&connection, id))
            .collect()
    }

    pub fn get_character_target(&self, id: &str) -> Result<Target> {
        let connection = self.connection()?;
        self.read_character_target(&connection, id)
    }

    pub fn save_character_target(&self, draft: TargetDraft) -> Result<Target> {
        let name = draft.display_name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("캐릭터 이름을 입력해 주세요."));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if draft.id.is_none() && draft.series_classification_id.is_none() {
            return Err(Error::Invalid("시리즈 폴더를 선택해 주세요."));
        }
        for id in draft
            .series_classification_id
            .iter()
            .chain(draft.linked_classification_id.iter())
        {
            if !transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(Error::Invalid("연결할 폴더를 찾을 수 없습니다."));
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
        let id = if let Some(id) = draft.id {
            let previous = self.read_character_target(&transaction, &id)?;
            if draft.expected_revision != Some(previous.revision) {
                return Err(Error::Stale);
            }
            if previous.display_name != name
                || previous.series_classification_id != draft.series_classification_id
                || previous.linked_classification_id != draft.linked_classification_id
                || previous.enabled != draft.enabled
            {
                transaction.execute("UPDATE character_targets SET series_classification_id=?2, linked_classification_id=?3,
                    display_name=?4, enabled=?5, revision=revision+1, updated_at=?6 WHERE id=?1",
                    params![id, draft.series_classification_id, draft.linked_classification_id, name, draft.enabled, now])?;
            }
            id
        } else {
            if draft.expected_revision.is_some() {
                return Err(Error::Stale);
            }
            let id = uuid::Uuid::new_v4().to_string();
            transaction.execute("INSERT INTO character_targets
                (id,series_classification_id,linked_classification_id,display_name,enabled,created_at,updated_at)
                VALUES(?1,?2,?3,?4,?5,?6,?6)", params![id,draft.series_classification_id,draft.linked_classification_id,name,draft.enabled,now])?;
            id
        };
        let result = self.read_character_target(&transaction, &id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn replace_character_references(
        &self,
        id: &str,
        expected_revision: i64,
        asset_ids: &[String],
    ) -> Result<Target> {
        if asset_ids.len() > REFERENCE_COUNT
            || asset_ids.iter().collect::<BTreeSet<_>>().len() != asset_ids.len()
        {
            return Err(Error::Invalid(
                "기준 이미지는 중복 없이 최대 5장까지 지정할 수 있습니다.",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let previous = self.read_character_target(&transaction, id)?;
        if previous.revision != expected_revision {
            return Err(Error::Stale);
        }
        let series = previous
            .series_classification_id
            .as_deref()
            .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
        let mut hashes = BTreeSet::new();
        let mut values = Vec::new();
        for asset_id in asset_ids {
            let (hash, path) = scoped_image(&transaction, series, asset_id)?;
            self.open_library_media(&path)?;
            if !hashes.insert(hash.clone()) {
                return Err(Error::Invalid(
                    "내용이 같은 기준 이미지를 중복 지정할 수 없습니다.",
                ));
            }
            values.push((asset_id, hash));
        }
        let unchanged = previous.references.len() == values.len()
            && previous
                .references
                .iter()
                .zip(&values)
                .all(|(r, (id, hash))| r.asset_id.as_ref() == Some(*id) && r.asset_hash == *hash);
        if !unchanged {
            transaction.execute("DELETE FROM character_references WHERE target_id=?1", [id])?;
            for (slot, (asset_id, hash)) in values.iter().enumerate() {
                transaction.execute("INSERT INTO character_references(target_id,slot,asset_id,asset_hash) VALUES(?1,?2,?3,?4)", params![id,slot as i64,asset_id,hash])?;
            }
            transaction.execute(
                "UPDATE character_targets SET revision=revision+1,updated_at=?2 WHERE id=?1",
                params![id, chrono::Utc::now().to_rfc3339()],
            )?;
        }
        let result = self.read_character_target(&transaction, id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_character_decisions(&self, request: DecisionRequest) -> Result<u64> {
        self.record_character_decision_batch(vec![request])
    }

    pub fn record_character_decision_batch(&self, requests: Vec<DecisionRequest>) -> Result<u64> {
        let mut pairs = BTreeSet::new();
        for request in &requests {
            for id in request.asset_ids.iter().collect::<BTreeSet<_>>() {
                if !pairs.insert((&request.target_id, id)) {
                    return Err(Error::Invalid(
                        "같은 캐릭터와 이미지의 판단이 중복되었습니다.",
                    ));
                }
            }
        }
        if requests.is_empty() || pairs.len() > 200 {
            return Err(Error::Invalid(
                "한 번에 최대 200개 캐릭터 판단을 저장할 수 있습니다.",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut changed = 0;
        for request in requests {
            changed += self.write_character_decisions(&transaction, request)?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    fn write_character_decisions(
        &self,
        transaction: &Connection,
        request: DecisionRequest,
    ) -> Result<u64> {
        let ids: BTreeSet<_> = request.asset_ids.iter().collect();
        if ids.is_empty() || ids.len() > 200 {
            return Err(Error::Invalid("한 번에 1~200개 자산을 선택해 주세요."));
        }
        if request
            .baseline_fingerprint
            .as_ref()
            .is_some_and(|s| s.trim().is_empty())
        {
            return Err(Error::Invalid("분석 식별자가 비어 있습니다."));
        }
        let target = self.read_character_target(&transaction, &request.target_id)?;
        if target.fingerprint != request.expected_fingerprint {
            return Err(Error::Stale);
        }
        if request.decision != DecisionKind::Cleared && !target.enabled {
            return Err(Error::Invalid("비활성화된 캐릭터입니다."));
        }
        if request.baseline_fingerprint.is_some() && !target.ready {
            return Err(Error::Invalid("기준 이미지 설정을 확인해 주세요."));
        }
        if request.scan_id.is_some() != request.baseline_fingerprint.is_some() {
            return Err(Error::Stale);
        }
        let evidence = if request.scan_id.is_some() {
            self.checked_character_evidence(&transaction, &target, &request)?
        } else {
            std::collections::BTreeMap::new()
        };
        let references = serde_json::to_string(&target.references)?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut changed = 0;
        for asset_id in ids {
            let hash = if request.decision == DecisionKind::Cleared {
                transaction.query_row(
                    "SELECT content_hash FROM assets WHERE id=?1 AND status='normal'",
                    [asset_id],
                    |r| r.get::<_, String>(0),
                )?
            } else {
                let series = target
                    .series_classification_id
                    .as_deref()
                    .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
                scoped_image(&transaction, series, asset_id)?.0
            };
            let previous: Option<String> = transaction
                .query_row(
                    "SELECT decision FROM character_decisions
                WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
                    params![target.id, asset_id],
                    |r| r.get(0),
                )
                .optional()?;
            if previous.as_deref() == Some(request.decision.stored()) {
                continue;
            }
            let snapshot = evidence
                .get(asset_id)
                .map(serde_json::to_string)
                .transpose()?
                .unwrap_or_else(|| references.clone());
            transaction.execute("INSERT INTO character_decisions
                (target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,baseline_fingerprint,reference_snapshot,created_at)
                VALUES(?1,?2,?2,?3,?4,?5,?6,?7,?8)", params![target.id,asset_id,hash,request.decision.stored(),target.fingerprint,request.baseline_fingerprint,snapshot,now])?;
            changed += 1;
        }
        Ok(changed)
    }

    pub fn list_character_decisions(
        &self,
        target_id: &str,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Decision>> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("조회 개수가 올바르지 않습니다."));
        }
        let connection = self.connection()?;
        self.read_character_target(&connection, target_id)?;
        let mut statement = connection.prepare("SELECT sequence,asset_id,source_asset_id,asset_hash,decision,
            target_fingerprint,baseline_fingerprint,reference_snapshot,created_at FROM character_decisions
            WHERE target_id=?1 AND (?2 IS NULL OR sequence<?2) ORDER BY sequence DESC LIMIT ?3")?;
        let rows = statement
            .query_map(params![target_id, before, limit], |r| {
                Ok(Decision {
                    sequence: r.get(0)?,
                    asset_id: r.get(1)?,
                    source_asset_id: r.get(2)?,
                    asset_hash: r.get(3)?,
                    decision: r.get(4)?,
                    target_fingerprint: r.get(5)?,
                    baseline_fingerprint: r.get(6)?,
                    reference_snapshot: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn character_relations_for_asset(&self, asset_id: &str) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let ids = connection
            .prepare(
                "SELECT r.target_id FROM character_relations r JOIN assets a ON a.id=r.asset_id
            WHERE r.asset_id=?1 AND a.status='normal' ORDER BY r.target_id",
            )?
            .query_map([asset_id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub(super) fn read_character_target(
        &self,
        connection: &Connection,
        id: &str,
    ) -> Result<Target> {
        let mut target = connection.query_row("SELECT id,series_classification_id,linked_classification_id,display_name,enabled,revision
            FROM character_targets WHERE id=?1", [id], |r| Ok(Target {
                id:r.get(0)?,series_classification_id:r.get(1)?,linked_classification_id:r.get(2)?,display_name:r.get(3)?,
                enabled:r.get(4)?,revision:r.get(5)?,references:Vec::new(),ready:false,fingerprint:String::new()
            })).optional()?.ok_or(Error::NotFound)?;
        let mut statement = connection.prepare("SELECT slot,asset_id,asset_hash FROM character_references WHERE target_id=?1 ORDER BY slot")?;
        let rows = statement.query_map([id], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (slot, asset_id, asset_hash) = row?;
            let status = match (
                asset_id.as_deref(),
                target.series_classification_id.as_deref(),
            ) {
                (None, _) => "missing_asset",
                (Some(id), Some(series)) => {
                    let eligible = connection
                        .query_row(SCOPED_IMAGE, params![series, id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                        })
                        .optional()?;
                    match eligible {
                        None => "ineligible",
                        Some((hash, _)) if hash != asset_hash => "changed_content",
                        Some((_, path)) if self.open_library_media(&path).is_err() => {
                            "missing_file"
                        }
                        Some(_) => "ready",
                    }
                }
                _ => "ineligible",
            };
            target.references.push(Reference {
                slot,
                asset_id,
                asset_hash,
                status,
            });
        }
        target.ready = target.enabled
            && target.series_classification_id.is_some()
            && target.references.len() == REFERENCE_COUNT
            && target.references.iter().all(|r| r.status == "ready");
        target.fingerprint = Sha256::digest(serde_json::to_vec(&(
            &target.id,
            target.revision,
            &target.series_classification_id,
            &target.references,
        ))?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
        Ok(target)
    }
}

pub(super) fn scoped_image(
    connection: &Connection,
    series: &str,
    id: &str,
) -> Result<(String, String)> {
    connection
        .query_row(SCOPED_IMAGE, params![series, id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
        .ok_or(Error::Invalid(
            "시리즈 범위 안의 정상 이미지를 선택해 주세요.",
        ))
}

#[cfg(test)]
#[path = "characters_tests.rs"]
pub(super) mod tests;
