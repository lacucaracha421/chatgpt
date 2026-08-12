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
pub struct IngestMediaRequest {
    pub source_path: std::path::PathBuf,
    pub classification_id: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VideoPreparationState {
    Pending,
    Processing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoPreparationProgress {
    pub processed: u32,
    pub remaining: u32,
    pub failed: u32,
    pub changed_asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MediaSummary {
    Image,
    Gif,
    Video {
        duration_ms: u64,
        preparation_state: VideoPreparationState,
        scrub_frame_count: u32,
    },
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
    pub thumbnail_relative_path: Option<String>,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub collected_at: String,
    pub favorite: bool,
    pub source_url: Option<String>,
    pub media: MediaSummary,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SimilarityDecision {
    KeepExisting,
    ReplaceExisting,
    KeepBoth,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityDecisionRequest {
    pub review_id: String,
    pub decision: SimilarityDecision,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityReviewAsset {
    pub asset: AssetSummary,
    pub format: String,
    pub classifications: Vec<ClassificationEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityReviewSummary {
    pub id: String,
    pub distance: u32,
    pub existing: SimilarityReviewAsset,
    pub candidate: SimilarityReviewAsset,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityReviewPage {
    pub items: Vec<SimilarityReviewSummary>,
    pub next_cursor: Option<AssetCursor>,
    pub total_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityIndexProgress {
    pub remaining: u64,
    pub failed: u64,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetClassificationPatch {
    pub asset_ids: Vec<String>,
    pub add_classification_ids: Vec<String>,
    pub remove_classification_ids: Vec<String>,
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
    ReviewPending { review_id: String },
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
    pub icon_key: Option<String>,
    pub color_key: Option<String>,
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
pub struct AlbumEntry {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon_key: Option<String>,
    pub color_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlbum {
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaSeries {
    pub id: String,
    pub title: String,
    pub author: String,
    pub page_count: u64,
}

#[cfg(test)]
mod tests {
    use super::{
        AssetSummary, BackupKind, ClassificationEntry, ClassificationKind, MediaSummary,
        MetadataBackup, SimilarityReviewAsset, SimilarityReviewSummary, VideoPreparationState,
    };

    #[test]
    fn asset_summary_serialization_omits_managed_paths() {
        let asset = AssetSummary {
            id: "asset-1".into(),
            title: None,
            original_name: "source.png".into(),
            relative_path: "assets/aa/asset.png".into(),
            thumbnail_relative_path: Some("thumbnails/aa/asset.webp".into()),
            byte_size: 1,
            width: 1,
            height: 1,
            collected_at: "2026-08-02T00:00:00Z".into(),
            favorite: false,
            source_url: None,
            media: MediaSummary::Image,
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

    #[test]
    fn video_asset_summary_serialization_hides_internal_media_details() {
        let asset = AssetSummary {
            id: "video-1".into(),
            title: None,
            original_name: "clip.webm".into(),
            relative_path: "assets/aa/clip.webm".into(),
            thumbnail_relative_path: None,
            byte_size: 42,
            width: 1920,
            height: 1080,
            collected_at: "2026-08-09T00:00:00Z".into(),
            favorite: false,
            source_url: None,
            media: MediaSummary::Video {
                duration_ms: 12_345,
                preparation_state: VideoPreparationState::Pending,
                scrub_frame_count: 0,
            },
        };

        let value = serde_json::to_value(asset).unwrap();

        assert_eq!(value["media"]["kind"], "video");
        assert_eq!(value["media"]["durationMs"], 12_345);
        assert_eq!(value["media"]["preparationState"], "pending");
        assert_eq!(value["media"]["scrubFrameCount"], 0);
        let serialized = value.to_string();
        for forbidden in [
            "relativePath",
            "thumbnailRelativePath",
            "videoCodec",
            "audioCodec",
            "assets/aa/clip.webm",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn similarity_review_serialization_omits_internal_hashes_and_paths() {
        let asset = AssetSummary {
            id: "asset-1".into(),
            title: None,
            original_name: "source.png".into(),
            relative_path: "assets/aa/asset.png".into(),
            thumbnail_relative_path: Some("thumbnails/aa/asset.webp".into()),
            byte_size: 42,
            width: 8,
            height: 6,
            collected_at: "2026-08-09T00:00:00Z".into(),
            favorite: false,
            source_url: Some("https://example.test/source".into()),
            media: MediaSummary::Image,
        };
        let review_asset = SimilarityReviewAsset {
            asset,
            format: "PNG".into(),
            classifications: vec![ClassificationEntry {
                id: "tag-1".into(),
                kind: ClassificationKind::Tag,
                name: "아로나".into(),
                parent_id: Some("work-1".into()),
                icon_key: None,
                color_key: None,
            }],
        };
        let value = serde_json::to_value(SimilarityReviewSummary {
            id: "review-1".into(),
            distance: 2,
            existing: review_asset.clone(),
            candidate: review_asset,
        })
        .unwrap();

        let serialized = value.to_string();
        assert_eq!(value["existing"]["asset"]["id"], "asset-1");
        for forbidden in [
            "relativePath",
            "thumbnailRelativePath",
            "contentHash",
            "perceptualHash",
            "assets/aa/asset.png",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}
