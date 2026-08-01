use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashPolicy {
    pub retention_days: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestImageRequest {
    pub source_path: std::path::PathBuf,
    pub classification_id: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub title: Option<String>,
    pub original_name: String,
    pub relative_path: String,
    pub thumbnail_relative_path: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub collected_at: String,
    pub favorite: bool,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetSort {
    Newest,
    Oldest,
    Favorites,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetCursor {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetQuery {
    pub classification_id: Option<String>,
    pub direct_only: bool,
    pub favorite_only: bool,
    pub sort: AssetSort,
    pub random_pivot: Option<String>,
    pub after: Option<AssetCursor>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetPage {
    pub items: Vec<AssetSummary>,
    pub next_cursor: Option<AssetCursor>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashAssetSummary {
    pub asset: AssetSummary,
    pub trashed_at: String,
    pub purge_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashPage {
    pub items: Vec<TrashAssetSummary>,
    pub next_cursor: Option<AssetCursor>,
    pub total_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSummary {
    pub deleted_count: u64,
    pub failed_asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum IngestOutcome {
    Added { asset: AssetSummary },
    ExactDuplicate { existing_asset_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationKind {
    Root,
    Work,
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationEntry {
    pub id: String,
    pub kind: ClassificationKind,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClassification {
    pub kind: ClassificationKind,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub root: String,
    pub asset_count: u64,
}
