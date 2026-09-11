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
    #[serde(default)]
    pub description: String,
    pub thumbnail_asset_id: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSettingsDraft {
    #[serde(flatten)]
    pub target: TargetDraft,
    pub reference_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRegistration {
    pub folder_id: String,
    pub series_id: String,
    pub recursive: bool,
    #[serde(default)]
    pub cleanup_folder: bool,
    pub expected_count: usize,
    pub expected_asset_fingerprint: String,
    pub target_id: Option<String>,
    pub expected_fingerprint: Option<String>,
    pub display_name: String,
    pub reference_ids: Vec<String>,
    pub thumbnail_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAssetSnapshot {
    pub count: usize,
    pub fingerprint: String,
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
    #[serde(default)]
    pub description: String,
    pub thumbnail_asset_id: Option<String>,
    pub enabled: bool,
    pub manual_only: bool,
    pub revision: i64,
    pub references: Vec<Reference>,
    pub learned_references: Vec<Reference>,
    pub ready: bool,
    pub fingerprint: String,
}

impl Target {
    pub(super) fn usable_learned_references(&self) -> impl Iterator<Item = &Reference> {
        self.learned_references.iter().filter(|reference| reference.status == "ready")
    }

    pub(super) fn has_invalid_learned_references(&self) -> bool {
        self.learned_references.iter().any(|reference| reference.status != "ready")
    }
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
    pub origin: String,
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

    pub fn character_folder_image_count(
        &self,
        folder_id: String,
        recursive: bool,
    ) -> Result<usize> {
        let connection = self.connection()?;
        let ids = connection.prepare("WITH RECURSIVE scope(id) AS (SELECT ?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id WHERE ?2) SELECT a.id FROM assets a WHERE a.status='normal' AND a.media_kind='image' AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope)) ORDER BY a.id")?
            .query_map(params![folder_id,recursive], |r| r.get::<_,String>(0))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(ids.len())
    }

    pub fn character_folder_asset_count(
        &self,
        folder_id: String,
        recursive: bool,
    ) -> Result<usize> {
        Ok(self.character_folder_asset_snapshot(folder_id, recursive)?.count)
    }

    pub fn character_folder_asset_snapshot(
        &self,
        folder_id: String,
        recursive: bool,
    ) -> Result<FolderAssetSnapshot> {
        let connection = self.connection()?;
        let ids = connection.prepare("WITH RECURSIVE scope(id) AS (SELECT ?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id WHERE ?2) SELECT a.id FROM assets a WHERE a.status='normal' AND a.media_kind IN ('image','gif','video') AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope)) ORDER BY a.id")?
            .query_map(params![folder_id,recursive], |r| r.get::<_,String>(0))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(FolderAssetSnapshot {
            count: ids.len(),
            fingerprint: asset_set_fingerprint(&connection, &ids)?,
        })
    }

    /// Register existing image, GIF and video memberships; references remain still images.
    pub fn register_character_folder(&self, request: FolderRegistration) -> Result<Target> {
        if request.reference_ids.len() > REFERENCE_COUNT {
            return Err(Error::Invalid("기준 이미지는 최대 5장입니다."));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        if super::classification::classification_in_role_scope(&tx, &request.series_id, "originals")? {
            return Err(Error::Invalid("오리지널 보관 영역은 캐릭터로 정리할 수 없습니다."));
        }
        let inside: bool = tx.query_row("WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id) SELECT EXISTS(SELECT 1 FROM scope WHERE id=?2)", params![request.series_id,request.folder_id], |r| r.get(0))?;
        if !inside {
            return Err(Error::Invalid(
                "원본 폴더를 포함하는 시리즈를 선택해 주세요.",
            ));
        }
        let ids = tx.prepare("WITH RECURSIVE scope(id) AS (SELECT ?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id WHERE ?2) SELECT a.id FROM assets a WHERE a.status='normal' AND a.media_kind IN ('image','gif','video') AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope)) ORDER BY a.id")?
            .query_map(params![request.folder_id,request.recursive], |r| r.get::<_,String>(0))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        if ids.is_empty()
            || ids.len() != request.expected_count
            || asset_set_fingerprint(&tx, &ids)? != request.expected_asset_fingerprint
        {
            return Err(Error::Invalid(
                "폴더의 자산 구성이 바뀌었습니다. 목록을 다시 확인해 주세요.",
            ));
        }
        let target = if let Some(id) = request.target_id {
            let target = self.read_character_target(&tx, &id)?;
            if target.series_classification_id.as_deref() != Some(&request.series_id)
                || request.expected_fingerprint.as_deref() != Some(&target.fingerprint)
            {
                return Err(Error::Stale);
            }
            target
        } else {
            let name = request.display_name.trim();
            if name.is_empty() {
                return Err(Error::Invalid("캐릭터 이름을 입력해 주세요."));
            }
            let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_targets WHERE series_classification_id=?1 AND (display_name=?2 OR linked_classification_id=?3))", params![request.series_id,name,request.folder_id], |r| r.get(0))?;
            if duplicate {
                return Err(Error::Invalid(
                    "이미 등록된 캐릭터를 연결 대상으로 선택해 주세요.",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            tx.execute(
                "INSERT OR IGNORE INTO character_series(classification_id) VALUES(?1)",
                [&request.series_id],
            )?;
            if let Some(image) = &request.thumbnail_id {
                if !ids.contains(image) {
                    return Err(Error::Invalid("대표 이미지는 대상 폴더에서 선택해 주세요."));
                }
                super::character_hub::validate_art(&tx, image)?;
            }
            tx.execute("INSERT INTO character_targets(id,series_classification_id,linked_classification_id,display_name,enabled,thumbnail_asset_id,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?6)", params![id,request.series_id,request.folder_id,name,request.thumbnail_id,now])?;
            let mut hashes = BTreeSet::new();
            for (slot, image) in request.reference_ids.iter().enumerate() {
                if !ids.contains(image) {
                    return Err(Error::Invalid("기준 이미지는 대상 폴더에서 선택해 주세요."));
                }
                super::character_hub::validate_character_selection(
                    &tx,
                    &request.series_id,
                    Some(&id),
                    image,
                )?;
                let (hash, path) = scoped_image(&tx, &request.series_id, image)?;
                self.open_library_media(&path)?;
                if !hashes.insert(hash.clone()) {
                    return Err(Error::Invalid("기준 이미지가 중복되었습니다."));
                }
                tx.execute("INSERT INTO character_references(target_id,slot,asset_id,asset_hash) VALUES(?1,?2,?3,?4)", params![id,slot as i64,image,hash])?;
            }
            self.read_character_target(&tx, &id)?
        };
        for chunk in ids.chunks(200) {
            self.write_character_decisions(
                &tx,
                DecisionRequest {
                    target_id: target.id.clone(),
                    expected_fingerprint: target.fingerprint.clone(),
                    asset_ids: chunk.to_vec(),
                    decision: DecisionKind::Accepted,
                    baseline_fingerprint: None,
                    scan_id: None,
                },
            )?;
        }
        if request.cleanup_folder && request.folder_id != request.series_id {
            // Descendant folders and assets not included in registration keep their structure.
            let direct = tx.prepare("SELECT asset_id FROM asset_classifications WHERE classification_id=?1 ORDER BY asset_id")?.query_map([&request.folder_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            let moving = direct
                .into_iter()
                .filter(|id| ids.contains(id))
                .collect::<Vec<_>>();
            if !moving.is_empty() {
                Self::set_asset_classification_in(
                    &tx,
                    &super::models::SetAssetClassification {
                        asset_ids: moving,
                        classification_id: Some(request.series_id.clone()),
                    },
                )?;
            }
            let retained: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM classification_entries WHERE parent_id=?1) OR EXISTS(SELECT 1 FROM asset_classifications WHERE classification_id=?1) OR EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1) OR EXISTS(SELECT 1 FROM character_targets WHERE linked_classification_id=?1 AND id<>?2)",params![request.folder_id,target.id],|r|r.get(0))?;
            if !retained {
                tx.execute(
                    "DELETE FROM classification_entries WHERE id=?1",
                    [&request.folder_id],
                )?;
            }
        }
        let result = self.read_character_target(&tx, &target.id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn save_character_target(&self, draft: TargetDraft) -> Result<Target> {
        self.save_character_target_selection(draft, false)
    }

    pub fn save_character_target_selection(
        &self,
        draft: TargetDraft,
        strict: bool,
    ) -> Result<Target> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let result = self.save_character_target_selection_in(&transaction, draft, strict, false)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn save_character_settings(
        &self,
        request: CharacterSettingsDraft,
        strict: bool,
    ) -> Result<Target> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let manual_on_create =
            request.target.id.is_none() && request.reference_ids.len() < REFERENCE_COUNT;
        let saved = self.save_character_target_selection_in(
            &transaction,
            request.target,
            strict,
            manual_on_create,
        )?;
        let result = self.replace_character_references_selection_in(
            &transaction,
            &saved.id,
            saved.revision,
            &request.reference_ids,
            strict,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    fn save_character_target_selection_in(
        &self,
        transaction: &Connection,
        draft: TargetDraft,
        strict: bool,
        manual_on_create: bool,
    ) -> Result<Target> {
        let name = draft.display_name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("캐릭터 이름을 입력해 주세요."));
        }
        if draft.id.is_none() && draft.series_classification_id.is_none() {
            return Err(Error::Invalid("시리즈 폴더를 선택해 주세요."));
        }
        if let Some(series) = draft.series_classification_id.as_deref() {
            if super::classification::classification_in_role_scope(transaction, series, "originals")? {
                return Err(Error::Invalid("오리지널 보관 영역에서는 캐릭터를 등록할 수 없습니다."));
            }
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
        if let Some(image) = &draft.thumbnail_asset_id {
            super::character_hub::validate_art(transaction, image)?;
            let unchanged = draft
                .id
                .as_deref()
                .map(|id| self.read_character_target(transaction, id))
                .transpose()?
                .is_some_and(|t| t.thumbnail_asset_id.as_ref() == Some(image));
            if strict && !unchanged {
                super::character_hub::validate_character_selection(
                    transaction,
                    draft
                        .series_classification_id
                        .as_deref()
                        .ok_or(Error::Stale)?,
                    draft.id.as_deref(),
                    image,
                )?;
            }
        }
        if let Some(series) = &draft.series_classification_id {
            transaction.execute(
                "INSERT OR IGNORE INTO character_series(classification_id) VALUES(?1)",
                [series],
            )?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let id = if let Some(id) = draft.id {
            let previous = self.read_character_target(transaction, &id)?;
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
                (id,series_classification_id,linked_classification_id,display_name,enabled,manual_only,created_at,updated_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?7)", params![id,draft.series_classification_id,draft.linked_classification_id,name,draft.enabled,manual_on_create,now])?;
            if manual_on_create {
                transaction.execute(
                    "INSERT INTO character_manual_targets(target_id,created_at) VALUES(?1,?2)",
                    params![id, now],
                )?;
            }
            id
        };
        transaction.execute(
            "UPDATE character_targets SET description=?2, thumbnail_asset_id=?3 WHERE id=?1",
            params![id, draft.description, draft.thumbnail_asset_id],
        )?;
        self.read_character_target(transaction, &id)
    }

    pub fn add_character_learned_references(
        &self,
        id: &str,
        expected_revision: i64,
        asset_ids: &[String],
    ) -> Result<Target> {
        let ids = asset_ids.iter().collect::<BTreeSet<_>>();
        if ids.is_empty() || ids.len() > 20 {
            return Err(Error::Invalid(
                "학습 이미지는 한 번에 1~20장까지 선택해 주세요.",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let target = self.read_character_target(&transaction, id)?;
        if target.revision != expected_revision {
            return Err(Error::Stale);
        }
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
        let mut hashes = transaction
            .prepare("SELECT asset_hash FROM character_learned_references WHERE target_id=?1")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        for reference in &target.references {
            hashes.insert(reference.asset_hash.clone());
        }
        let existing: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM character_learned_references WHERE target_id=?1",
            [id],
            |row| row.get(0),
        )?;
        let mut additions = Vec::new();
        for asset_id in ids {
            let assigned: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE target_id=?1 AND asset_id=?2)", params![id,asset_id], |row| row.get(0))?;
            if !assigned {
                return Err(Error::Invalid(
                    "먼저 이 캐릭터로 승인한 이미지만 학습에 추가할 수 있습니다.",
                ));
            }
            let shared: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE asset_id=?1 AND target_id<>?2)", params![asset_id,id], |row| row.get(0))?;
            if shared {
                return Err(Error::Invalid(
                    "여러 캐릭터에 연결된 이미지는 학습에 추가할 수 없습니다.",
                ));
            }
            let (hash, path) = scoped_image(&transaction, series, asset_id)?;
            self.open_library_media(&path)?;
            let current: Option<String> = transaction.query_row("SELECT asset_hash FROM character_learned_references WHERE target_id=?1 AND asset_id=?2", params![id,asset_id], |row| row.get(0)).optional()?;
            if current.as_deref() == Some(&hash) {
                continue;
            }
            if !hashes.insert(hash.clone()) {
                return Err(Error::Invalid(
                    "내용이 같은 학습 이미지는 중복해서 추가할 수 없습니다.",
                ));
            }
            additions.push((asset_id.clone(), hash));
        }
        if existing as usize + additions.len() > 20 {
            return Err(Error::Invalid("추가 학습 이미지는 최대 20장입니다."));
        }
        let now = chrono::Utc::now().to_rfc3339();
        for (asset_id, hash) in additions {
            transaction.execute(
                "DELETE FROM character_reference_exclusions WHERE target_id=?1 AND asset_id=?2",
                params![id, asset_id],
            )?;
            transaction.execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(target_id,asset_id) DO UPDATE SET asset_hash=excluded.asset_hash,created_at=excluded.created_at", params![id,asset_id,hash,now])?;
        }
        let result = self.read_character_target(&transaction, id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn exclude_character_reference(
        &self,
        id: &str,
        expected_revision: i64,
        asset_id: &str,
    ) -> Result<Target> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let target = self.read_character_target(&transaction, id)?;
        if target.revision != expected_revision {
            return Err(Error::Stale);
        }
        let removed = transaction.execute(
            "DELETE FROM character_learned_references WHERE target_id=?1 AND asset_id=?2",
            params![id, asset_id],
        )?;
        if removed > 0 {
            transaction.execute("INSERT OR IGNORE INTO character_reference_exclusions(target_id,asset_id,created_at) VALUES(?1,?2,?3)", params![id,asset_id,chrono::Utc::now().to_rfc3339()])?;
        } else {
            let known: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM character_reference_exclusions WHERE target_id=?1 AND asset_id=?2)", params![id,asset_id], |row| row.get(0))?;
            if !known {
                return Err(Error::Invalid(
                    "현재 추가 참조가 아닙니다. 새로고침 후 확인해 주세요.",
                ));
            }
        }
        let result = self.read_character_target(&transaction, id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn replace_character_references(
        &self,
        id: &str,
        expected_revision: i64,
        asset_ids: &[String],
    ) -> Result<Target> {
        self.replace_character_references_selection(id, expected_revision, asset_ids, false)
    }

    pub fn replace_character_references_selection(
        &self,
        id: &str,
        expected_revision: i64,
        asset_ids: &[String],
        strict: bool,
    ) -> Result<Target> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let result = self.replace_character_references_selection_in(
            &transaction,
            id,
            expected_revision,
            asset_ids,
            strict,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    fn replace_character_references_selection_in(
        &self,
        transaction: &Connection,
        id: &str,
        expected_revision: i64,
        asset_ids: &[String],
        strict: bool,
    ) -> Result<Target> {
        if asset_ids.len() > REFERENCE_COUNT
            || asset_ids.iter().collect::<BTreeSet<_>>().len() != asset_ids.len()
        {
            return Err(Error::Invalid(
                "기준 이미지는 중복 없이 최대 5장까지 지정할 수 있습니다.",
            ));
        }
        let previous = self.read_character_target(transaction, id)?;
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
            if strict {
                super::character_hub::validate_character_selection(
                    transaction,
                    series,
                    Some(id),
                    asset_id,
                )?;
            }
            let (hash, path) = scoped_image(transaction, series, asset_id)?;
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
        let promote_manual = previous.manual_only && values.len() == REFERENCE_COUNT;
        if !unchanged {
            transaction.execute("DELETE FROM character_references WHERE target_id=?1", [id])?;
            for (slot, (asset_id, hash)) in values.iter().enumerate() {
                transaction.execute("INSERT INTO character_references(target_id,slot,asset_id,asset_hash) VALUES(?1,?2,?3,?4)", params![id,slot as i64,asset_id,hash])?;
            }
            transaction.execute(
                "UPDATE character_targets SET manual_only=CASE WHEN ?3 THEN 0 ELSE manual_only END,revision=revision+1,updated_at=?2 WHERE id=?1",
                params![id, chrono::Utc::now().to_rfc3339(), promote_manual],
            )?;
        } else if promote_manual {
            transaction.execute(
                "UPDATE character_targets SET manual_only=0,revision=revision+1,updated_at=?2 WHERE id=?1",
                params![id, chrono::Utc::now().to_rfc3339()],
            )?;
        }
        if promote_manual {
            transaction.execute("DELETE FROM character_manual_targets WHERE target_id=?1", [id])?;
        }
        self.read_character_target(transaction, id)
    }

    /// Move within a series and assign the character as one atomic operation.
    pub fn move_assets_to_character(
        &self,
        target_id: String,
        expected_fingerprint: String,
        asset_ids: Vec<String>,
    ) -> Result<u64> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let target = self.read_character_target(&transaction, &target_id)?;
        let series_id = target
            .series_classification_id
            .clone()
            .ok_or(Error::Invalid("시리즈 폴더를 다시 연결해 주세요."))?;
        // Validate the original scope before moving; unrelated series cannot be pulled in.
        self.write_character_decisions(
            &transaction,
            DecisionRequest {
                target_id,
                expected_fingerprint,
                asset_ids: asset_ids.clone(),
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            },
        )?;
        Self::set_asset_classification_in(
            &transaction,
            &super::models::SetAssetClassification {
                asset_ids: asset_ids.clone(),
                classification_id: Some(series_id),
            },
        )?;
        transaction.commit()?;
        Ok(asset_ids.into_iter().collect::<BTreeSet<_>>().len() as u64)
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

    pub(super) fn write_character_decisions(
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
                super::character_hub::candidate_media_mode(
                    &transaction,
                    series,
                    asset_id,
                    evidence
                        .get(asset_id)
                        .is_some_and(|e| e["prediction"]["automaticScope"] == true),
                    request.scan_id.is_none(),
                )?
                .0
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
                super::character_autotag::refresh_character_review_state(transaction, asset_id)?;
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
            transaction.execute("DELETE FROM character_review_completions WHERE asset_id=?1", [asset_id])?;
            super::character_autotag::refresh_character_review_state(transaction, asset_id)?;
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
            target_fingerprint,baseline_fingerprint,reference_snapshot,created_at,origin FROM character_decisions
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
                    origin: r.get(9)?,
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
        let mut target = connection.query_row("SELECT id,series_classification_id,linked_classification_id,display_name,enabled,revision,description,
            (SELECT a.id FROM assets a WHERE a.id=thumbnail_asset_id AND a.status='normal'),manual_only
            FROM character_targets WHERE id=?1", [id], |r| Ok(Target {
                id:r.get(0)?,series_classification_id:r.get(1)?,linked_classification_id:r.get(2)?,display_name:r.get(3)?,
                enabled:r.get(4)?,revision:r.get(5)?,description:r.get(6)?,thumbnail_asset_id:r.get(7)?,manual_only:r.get(8)?,references:Vec::new(),learned_references:Vec::new(),ready:false,fingerprint:String::new()
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
        // Learned references are explicit, stable user choices. Keep invalid rows visible
        // so the UI and automatic roster use the same scope/content/file eligibility.
        let mut seen = target
            .references
            .iter()
            .map(|r| r.asset_hash.clone())
            .collect::<BTreeSet<_>>();
        let mut learned = connection.prepare("SELECT l.asset_id,l.asset_hash,a.content_hash,a.relative_path,a.status,a.media_kind FROM character_learned_references l JOIN assets a ON a.id=l.asset_id WHERE l.target_id=?1 ORDER BY l.created_at,l.asset_id LIMIT 20")?;
        let rows = learned.query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (asset_id, asset_hash, current_hash, path, asset_status, media_kind) = row?;
            let duplicate = !seen.insert(asset_hash.clone());
            let status = if duplicate {
                "duplicate_content"
            } else if asset_status != "normal" || media_kind != "image" {
                "ineligible"
            } else if asset_hash != current_hash {
                "changed_content"
            } else {
                match target.series_classification_id.as_deref() {
                    Some(series) => {
                        let eligible = connection
                            .query_row(SCOPED_IMAGE, params![series, asset_id], |r| {
                                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                            })
                            .optional()?;
                        match eligible {
                            None => "ineligible",
                            Some((hash, _)) if hash != asset_hash => "changed_content",
                            Some((_, scoped_path))
                                if self.open_library_media(&scoped_path).is_err() =>
                            {
                                "missing_file"
                            }
                            Some(_) if self.open_library_media(&path).is_err() => "missing_file",
                            Some(_) => "ready",
                        }
                    }
                    None => "ineligible",
                }
            };
            target.learned_references.push(Reference {
                slot: target.learned_references.len() as u32,
                asset_id: Some(asset_id),
                asset_hash,
                status,
            });
        }
        target.ready = target.enabled
            && !target.manual_only
            && target.series_classification_id.is_some()
            && target.references.len() == REFERENCE_COUNT
            && target.references.iter().all(|r| r.status == "ready")
            && !target.has_invalid_learned_references();
        target.fingerprint = Sha256::digest(serde_json::to_vec(&(
            &target.id,
            &target.series_classification_id,
            target.enabled,
            target.manual_only,
            &target.references,
        ))?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
        Ok(target)
    }
}

pub(super) fn asset_set_fingerprint(connection: &Connection, ids: &[String]) -> Result<String> {
    let mut sorted = ids.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut rows = Vec::with_capacity(sorted.len());
    for id in sorted {
        let hash: String = connection.query_row(
            "SELECT content_hash FROM assets WHERE id=?1 AND status='normal'",
            [&id],
            |row| row.get(0),
        )?;
        let classifications = connection
            .prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id")?
            .query_map([&id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.push((id, hash, classifications));
    }
    Ok(Sha256::digest(serde_json::to_vec(&rows)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
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
