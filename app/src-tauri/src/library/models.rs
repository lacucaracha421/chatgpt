use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbCredentials {
    pub client_id: String,
    pub client_secret: String,
}

impl fmt::Debug for IgdbCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IgdbCredentials")
            .field("client_id", &"[redacted]")
            .field("client_secret", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbImageRef {
    pub image_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbRemoteGame {
    pub id: i64,
    pub name: String,
    pub summary: Option<String>,
    pub release_date: Option<String>,
    pub genres: Vec<String>,
    pub platforms: Vec<String>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub cover: Option<IgdbImageRef>,
    pub artworks: Vec<IgdbImageRef>,
    pub screenshots: Vec<IgdbImageRef>,
    pub snapshot_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbImageCandidate {
    pub image_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbSearchResult {
    pub game_id: i64,
    pub title: String,
    pub developer: Option<String>,
    pub release_date: Option<String>,
    pub cover: Option<IgdbImageCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbGamePreview {
    pub game_id: i64,
    pub proposed_title: String,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub release_date: Option<String>,
    pub platforms: Vec<String>,
    pub genres: Vec<String>,
    pub overview: Option<String>,
    pub covers: Vec<IgdbImageCandidate>,
    pub artworks: Vec<IgdbImageCandidate>,
    pub screenshots: Vec<IgdbImageCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbConnection {
    pub game_id: i64,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbApplyRequest {
    pub game_id: i64,
    pub cover_image_id: Option<String>,
    pub hero_image_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum IgdbArtworkDecision {
    Keep,
    Clear,
    Select { image_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgdbArtworkReplaceRequest {
    pub collection_id: String,
    pub cover: IgdbArtworkDecision,
    pub hero: IgdbArtworkDecision,
}

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
    pub collected_at: Option<String>,
    #[serde(default)]
    pub replace_duplicate_metadata: bool,
    pub source_published_at: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub creator_url: Option<String>,
    pub import_source: ImportSource,
    pub import_batch_id: String,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportSource {
    Direct,
    BrowserExtension,
    MetadataImport,
    LegacyLakomics,
}

impl ImportSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::BrowserExtension => "browser_extension",
            Self::MetadataImport => "metadata_import",
            Self::LegacyLakomics => "legacy_lakomics",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "direct" => Some(Self::Direct),
            "browser_extension" => Some(Self::BrowserExtension),
            "metadata_import" => Some(Self::MetadataImport),
            "legacy_lakomics" => Some(Self::LegacyLakomics),
            _ => None,
        }
    }
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
    pub source_published_at: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub creator_url: Option<String>,
    pub import_source: Option<ImportSource>,
    pub import_batch_id: Option<String>,
    pub original_modified_at: Option<String>,
    pub media: MediaSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadataPatch {
    pub asset_id: String,
    pub source_published_at: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub creator_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AssetSort {
    #[default]
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

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetQuery {
    pub classification_id: Option<String>,
    pub album_id: Option<String>,
    pub collection_id: Option<String>,
    pub direct_only: bool,
    pub favorite_only: bool,
    pub unclassified_only: bool,
    pub sort: AssetSort,
    pub random_pivot: Option<String>,
    pub after: Option<AssetCursor>,
    pub before: Option<AssetCursor>,
    pub around_date: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_cursor: Option<AssetCursor>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetDateBucket {
    pub date: String,
    pub count: u64,
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
#[allow(clippy::large_enum_variant)] // Command results are returned once, never stored in a collection.
pub enum IngestOutcome {
    Added {
        asset: AssetSummary,
    },
    ExactDuplicate {
        existing_asset_id: String,
        classification_changed: bool,
        metadata_changed: bool,
    },
    ReviewPending {
        review_id: String,
    },
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
pub struct SetAssetClassification {
    pub asset_ids: Vec<String>,
    pub classification_id: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAlbumPatch {
    pub asset_ids: Vec<String>,
    pub add_album_ids: Vec<String>,
    pub remove_album_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollectionType {
    Game,
    Manga,
    Movie,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
    pub cover_asset_id: Option<String>,
    pub selected_work_artwork_id: Option<String>,
    pub selected_hero_artwork_id: Option<String>,
    pub selected_backdrop_artwork_id: Option<String>,
    pub asset_count: u64,
    pub unread_release_count: u64,
    pub year: Option<i64>,
    pub original_title: Option<String>,
    pub runtime_minutes: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub platforms: Option<String>,
    pub production_company: Option<String>,
    pub release_date: Option<String>,
    pub external_score: Option<i64>,
    pub my_score: Option<f64>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub showcase: bool,
    pub showcase_order: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCollection {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBindingInput {
    pub provider: String,
    pub external_id: String,
    pub provider_config_json: Option<String>,
    pub provider_data_json: Option<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBinding {
    pub provider: String,
    pub external_id: String,
    pub provider_config_json: Option<String>,
    pub provider_data_json: Option<String>,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWatchStatus {
    pub enabled: bool,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseWatchEventKind {
    NewVolume,
    ReleaseDateChanged,
    ReleaseStatusChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWatchEvent {
    pub id: String,
    pub kind: ReleaseWatchEventKind,
    pub volume_number: i64,
    pub previous_value: Option<String>,
    pub current_value: Option<String>,
    pub detected_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseWatchRunStopReason {
    CredentialNotConfigured,
    InvalidCredential,
    RateLimited,
    TimedOut,
    Unavailable,
    InvalidResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWatchRunResult {
    pub checked: u64,
    pub changed_collections: u64,
    pub skipped: u64,
    pub stop_reason: Option<ReleaseWatchRunStopReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexSearchResult {
    pub manga_id: String,
    pub title: String,
    pub alternate_titles: Vec<String>,
    pub author: Option<String>,
    pub year: Option<i64>,
    pub status: Option<String>,
    pub primary_cover_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexCoverCandidate {
    pub cover_id: String,
    pub file_name: String,
    pub volume: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexWorkPreview {
    pub manga_id: String,
    pub proposed_title: String,
    pub alternate_titles: Vec<String>,
    pub author: Option<String>,
    pub year: Option<i64>,
    pub status: Option<String>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub covers: Vec<MangaDexCoverCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MangaDexApplyTarget {
    New { name: String },
    Existing { collection_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexApplyRequest {
    pub target: MangaDexApplyTarget,
    pub manga_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexConnection {
    pub manga_id: String,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionVolume {
    pub id: String,
    pub volume_number: i64,
    pub edition_index: u8,
    pub display_label: String,
    pub cover_artwork_id: Option<String>,
    pub local_release_date: Option<String>,
    pub isbn13: Option<String>,
    pub release_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AladinVolumeCandidate {
    pub volume_number: i64,
    pub provider_item_id: String,
    pub title: String,
    pub publication_date: Option<String>,
    pub isbn13: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AladinSeriesCandidate {
    pub anchor_item_id: String,
    pub group_fingerprint: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub volumes: Vec<AladinVolumeCandidate>,
    pub ignored_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AladinApplyRequest {
    pub collection_id: String,
    pub query: String,
    pub anchor_item_id: String,
    pub group_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AladinConnection {
    pub anchor_item_id: String,
    pub query: String,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AladinSyncResult {
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub ignored: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexVolumeSyncResult {
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCollection {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
    pub year: Option<i64>,
    pub original_title: Option<String>,
    pub runtime_minutes: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub platforms: Option<String>,
    pub production_company: Option<String>,
    pub release_date: Option<String>,
    pub external_score: Option<i64>,
    pub my_score: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCollectionPatch {
    pub asset_ids: Vec<String>,
    pub add_collection_ids: Vec<String>,
    pub remove_collection_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCover {
    pub file_name: String,
    pub shelf: u8,
    pub volume_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub installed: bool,
    pub work_count: u64,
    pub update_enabled: bool,
    pub update_interval_seconds: u64,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_added: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatalogUpdateStopReason {
    Completed,
    UpToDate,
    PageLimit,
    RateLimited,
    AlreadyRunning,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogUpdateResult {
    pub added: u64,
    pub pages: u32,
    pub reason: CatalogUpdateStopReason,
    pub last_success_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteProvider {
    KHentai,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedGallery {
    pub provider: RemoteProvider,
    pub work_id: String,
    pub page_count: u32,
    pub page_urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReadingProgress {
    pub provider: String,
    pub work_id: String,
    pub last_page: u32,
    pub page_count: u32,
    pub last_read_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSort {
    Latest,
    Views,
    HotDay,
    HotWeek,
    HotMonth,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatalogScope {
    All,
    Bookmarked,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchQuery {
    pub text: String,
    pub sort: CatalogSort,
    pub scope: CatalogScope,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSuggestion {
    pub value: String,
    pub label: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWork {
    pub id: u64,
    pub title: String,
    pub title_jpn: Option<String>,
    pub artists: Vec<String>,
    pub series: Vec<String>,
    pub thumbnail_url: Option<String>,
    pub bookmarked: bool,
    pub file_count: u32,
    pub views: u64,
    pub posted: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTagGroup {
    pub namespace: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWorkDetail {
    pub id: u64,
    pub title: String,
    pub title_jpn: Option<String>,
    pub thumbnail_url: Option<String>,
    pub uploader: Option<String>,
    pub category: Option<i64>,
    pub posted: Option<i64>,
    pub updated: Option<i64>,
    pub file_count: u32,
    pub file_size: Option<u64>,
    pub rating: Option<i64>,
    pub views: u64,
    pub bookmarked: bool,
    pub tag_groups: Vec<CatalogTagGroup>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchPage {
    pub works: Vec<CatalogWork>,
    pub total_count: u64,
    pub page: u32,
    pub page_size: u32,
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
        AssetSummary, BackupKind, ClassificationEntry, ClassificationKind, CollectionSummary,
        CollectionType, MangaDexApplyRequest, MangaDexApplyTarget, MediaSummary, MetadataBackup,
        SimilarityReviewAsset, SimilarityReviewSummary, VideoPreparationState,
    };

    #[test]
    fn serializes_mangadex_apply_targets_for_the_typescript_gateway() {
        let value = serde_json::to_value(MangaDexApplyRequest {
            target: MangaDexApplyTarget::Existing {
                collection_id: "work-1".into(),
            },
            manga_id: "manga-1".into(),
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "target": { "kind": "existing", "collectionId": "work-1" },
                "mangaId": "manga-1"
            })
        );
    }

    #[test]
    fn collection_summary_omits_legacy_provider_identity() {
        let value = serde_json::to_value(CollectionSummary {
            id: "work-1".into(),
            name: "Dungeon Meshi".into(),
            description: None,
            collection_type: CollectionType::Manga,
            cover_asset_id: None,
            selected_work_artwork_id: None,
            selected_hero_artwork_id: None,
            selected_backdrop_artwork_id: None,
            asset_count: 0,
            unread_release_count: 0,
            year: Some(2014),
            original_title: None,
            runtime_minutes: None,
            author: Some("Ryoko Kui".into()),
            director: None,
            developer: None,
            publisher: None,
            platforms: None,
            production_company: None,
            release_date: None,
            external_score: None,
            my_score: None,
            genres: Some("Fantasy".into()),
            overview: None,
            showcase: false,
            showcase_order: None,
            created_at: "2026-08-20T00:00:00Z".into(),
            updated_at: "2026-08-20T00:00:00Z".into(),
            source_path: None,
        })
        .unwrap();

        for field in ["externalId", "externalSource", "externalSyncedAt"] {
            assert!(value.get(field).is_none());
        }
    }

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
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: None,
            import_batch_id: None,
            original_modified_at: None,
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
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: None,
            import_batch_id: None,
            original_modified_at: None,
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
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: None,
            import_batch_id: None,
            original_modified_at: None,
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
