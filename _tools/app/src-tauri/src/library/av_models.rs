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
pub enum AvPersonRole {
    Performer,
    Director,
}
impl AvPersonRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Performer => "performer",
            Self::Director => "director",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerson {
    pub id: String,
    pub display_name: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPersonCredit {
    pub id: String,
    pub display_name: String,
    pub role: AvPersonRole,
    pub order: i64,
    pub credit_name: Option<String>,
    pub name_ja: Option<String>,
    pub work_count: i64,
    pub portrait: Option<AvPortrait>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvDetails {
    pub collection_id: String,
    pub revision: i64,
    pub product_code: Option<String>,
    pub label: Option<String>,
    pub series: Option<String>,
    pub people: Vec<AvPersonCredit>,
    pub title_ja: Option<String>,
    pub release_date: Option<String>,
    pub maker: Option<String>,
    pub genres: Vec<String>,
    pub maker_count: i64,
    pub label_count: i64,
    pub series_count: i64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AvPersonChoice {
    Existing { id: String },
    New { display_name: String },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPersonInput {
    pub person: AvPersonChoice,
    pub role: AvPersonRole,
    pub credit_name: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAvDetails {
    pub expected_revision: i64,
    pub product_code: Option<String>,
    pub label: Option<String>,
    pub series: Option<String>,
    pub people: Vec<AvPersonInput>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoverSurface {
    Front,
    Spine,
    Back,
}
impl CoverSurface {
    pub fn kind(self) -> super::work_artwork::WorkArtworkKind {
        match self {
            Self::Front => super::work_artwork::WorkArtworkKind::Cover,
            Self::Spine => super::work_artwork::WorkArtworkKind::Spine,
            Self::Back => super::work_artwork::WorkArtworkKind::Back,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvCoverSet {
    pub front_id: Option<String>,
    pub spine_id: Option<String>,
    pub back_id: Option<String>,
    pub revision: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArtworkPreview {
    pub path: String,
    pub surface: CoverSurface,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    pub thumbnail_bytes: Vec<u8>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtworkDecision {
    Keep,
    Clear,
    Local { path: String, sha256: String },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAvArtwork {
    pub expected_revision: String,
    pub front: ArtworkDecision,
    pub spine: ArtworkDecision,
    pub back: ArtworkDecision,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvPortraitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AvPortrait {
    Crop {
        artwork_id: String,
        revision: String,
        rect: AvPortraitRect,
    },
    Commons {
        #[serde(flatten)]
        preview: AvCommonsPreview,
    },
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvCommonsPreview {
    pub data_url: String,
    pub file_name: String,
    pub author: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub source_url: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvWorkCard {
    pub collection_id: String,
    pub name: String,
    pub product_code: Option<String>,
    pub release_date: Option<String>,
    pub front_artwork_id: Option<String>,
    pub spine_artwork_id: Option<String>,
    pub back_artwork_id: Option<String>,
    pub cover_revision: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvRelated {
    pub performers: Vec<AvPerformerShelf>,
    pub series: Option<AvSeriesShelf>,
    pub label: Option<AvLabelShelf>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerformerShelf {
    pub person_id: String,
    pub display_name: String,
    pub total: usize,
    pub items: Vec<AvWorkCard>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvSeriesShelf {
    pub name: String,
    pub total: usize,
    pub items: Vec<AvSeriesWork>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvSeriesWork {
    #[serde(flatten)]
    pub work: AvWorkCard,
    pub current: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvLabelShelf {
    pub name: String,
    pub total: usize,
    pub items: Vec<AvWorkCard>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerformerPage {
    pub person: AvPerformerPerson,
    pub stats: AvPerformerStats,
    pub works: Vec<AvPerformerWork>,
    pub co_performers: Vec<AvCoPerformer>,
    pub labels: Vec<AvLabelCount>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerformerPerson {
    pub id: String,
    pub display_name: String,
    pub name_ja: Option<String>,
    pub wikidata_id: Option<String>,
    pub fanza_actress_id: Option<String>,
    pub memo: Option<String>,
    pub portrait: Option<AvPortrait>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerformerStats {
    pub work_count: i64,
    pub first_release: Option<String>,
    pub last_release: Option<String>,
    pub average_score: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPerformerWork {
    #[serde(flatten)]
    pub work: AvWorkCard,
    pub role: AvPersonRole,
    pub solo: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvCoPerformer {
    pub id: String,
    pub display_name: String,
    pub count: i64,
    pub portrait: Option<AvPortrait>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvLabelCount {
    pub name: String,
    pub count: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvPortraitSource {
    pub collection_id: String,
    pub name: String,
    pub product_code: Option<String>,
    pub artwork_id: String,
    pub revision: String,
    pub solo: bool,
    pub width: u32,
    pub height: u32,
}
