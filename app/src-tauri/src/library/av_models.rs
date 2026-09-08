use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum AvError {
    #[error("AV 입력을 확인해 주세요.")]
    Invalid,
    #[error("정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.")]
    Stale,
    #[error("선택한 이미지가 변경되었거나 읽을 수 없습니다. 다시 선택해 주세요.")]
    Image,
    #[error(transparent)]
    Library(#[from] super::error::LibraryError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum AvPersonRole { Performer, Director }
impl AvPersonRole {
    pub fn as_str(&self) -> &'static str { match self { Self::Performer => "performer", Self::Director => "director" } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerson { pub id: String, pub display_name: String }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPersonCredit {
    pub id: String, pub display_name: String, pub role: AvPersonRole,
    pub order: i64, pub credit_name: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvDetails {
    pub collection_id: String, pub revision: i64,
    pub product_code: Option<String>, pub label: Option<String>, pub series: Option<String>,
    pub people: Vec<AvPersonCredit>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AvPersonChoice { Existing { id: String }, New { display_name: String } }
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPersonInput { pub person: AvPersonChoice, pub role: AvPersonRole, pub credit_name: Option<String> }
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAvDetails {
    pub expected_revision: i64,
    pub product_code: Option<String>, pub label: Option<String>, pub series: Option<String>,
    pub people: Vec<AvPersonInput>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoverSurface { Front, Spine, Back }
impl CoverSurface {
    pub fn kind(self) -> super::work_artwork::WorkArtworkKind {
        match self { Self::Front => super::work_artwork::WorkArtworkKind::Cover, Self::Spine => super::work_artwork::WorkArtworkKind::Spine, Self::Back => super::work_artwork::WorkArtworkKind::Back }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvCoverSet {
    pub front_id: Option<String>, pub spine_id: Option<String>, pub back_id: Option<String>, pub revision: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArtworkPreview {
    pub path: String, pub surface: CoverSurface, pub sha256: String,
    pub width: u32, pub height: u32, pub mime_type: String, pub thumbnail_bytes: Vec<u8>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtworkDecision { Keep, Clear, Local { path: String, sha256: String } }
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAvArtwork {
    pub expected_revision: String,
    pub front: ArtworkDecision, pub spine: ArtworkDecision, pub back: ArtworkDecision,
}
