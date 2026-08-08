use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    Daily,
    PreMigration,
    PreRestore,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataBackup {
    pub id: String,
    pub kind: BackupKind,
    pub created_at: String,
    pub byte_size: u64,
}

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
    #[serde(skip_serializing)]
    pub relative_path: String,
    #[serde(skip_serializing)]
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
    pub unclassified_only: bool,
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

#[cfg(test)]
mod tests {
    use super::{AssetSummary, BackupKind, MetadataBackup};

    #[test]
    fn asset_summary_serialization_omits_managed_paths() {
        let asset = AssetSummary {
            id: "asset-1".into(),
            title: None,
            original_name: "source.png".into(),
            relative_path: "assets/aa/asset.png".into(),
            thumbnail_relative_path: "thumbnails/aa/asset.webp".into(),
            byte_size: 1,
            width: 1,
            height: 1,
            collected_at: "2026-08-02T00:00:00Z".into(),
            favorite: false,
            source_url: None,
        };

        let value = serde_json::to_value(asset).unwrap();

        assert!(value.get("relativePath").is_none());
        assert!(value.get("thumbnailRelativePath").is_none());
    }

    #[test]
    fn metadata_backup_serialization_exposes_an_opaque_id_without_a_filename() {
        let backup = MetadataBackup {
            id: "550e8400-e29b-41d4-a716-446655440000".into(),
            kind: BackupKind::Daily,
            created_at: "2026-08-01T12:00:00+00:00".into(),
            byte_size: 42,
        };

        let value = serde_json::to_value(backup).unwrap();

        assert_eq!(value["id"], "550e8400-e29b-41d4-a716-446655440000");
        assert!(value.get("path").is_none());
        assert!(value.get("filename").is_none());
    }
}
