use std::sync::RwLock;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{
    catalog_transport::CatalogTransport,
    cloud::models::CloudSyncConfig,
    library::{
        book_migration::{BookImportPlan, BookMigrationReport},
        catalog_update::{self, CatalogUpdateState},
        credential,
        error::LibraryError,
        legacy_package_migration::{
            self, LegacyPackageMigrationPlan, LegacyPackageMigrationReport, LegacyPackagePaths,
        },
        metadata_import::{self, MetadataImportPlan},
        models::{
            AladinApplyRequest, AladinConnection, AladinSeriesCandidate, AladinSyncResult,
            AlbumEntry, AssetAlbumPatch, AssetCollectionPatch, AssetCursor, AssetDateBucket,
            AssetDateBucketQuery, AssetMetadataPatch, AssetPage, AssetQuery, AssetSummary,
            CatalogSearchPage, CatalogSearchQuery,
            CatalogStatus, CatalogSuggestion, CatalogUpdateResult, CatalogUpdateStopReason,
            CatalogWorkDetail, ClassificationEntry, CollectionCover, CollectionSummary,
            CollectionVolume, CreateAlbum, CreateClassification, CreateCollection,
            IngestMediaRequest, IngestOutcome, LibrarySummary, MangaDexApplyRequest,
            MangaCatalogRecoveryApplyResult, MangaCatalogRecoveryPreview, MangaDexConnection,
            MangaDexSearchResult, MangaDexVolumeSyncResult, MangaDexWorkPreview, MangaSeries,
            MetadataBackup, PurgeSummary, ReleaseWatchEvent,
            ReleaseWatchRunResult, ReleaseWatchRunStopReason, ReleaseWatchStatus, RemoteProvider,
            RemoteReadingProgress, ResolvedGallery, SetAssetClassification,
            SimilarityDecisionRequest, SimilarityIndexProgress, SimilarityReviewPage, TrashPage,
            TrashPolicy, UpdateCollection, VideoPreparationProgress, VolumeImportProgress,
            WorkArtworkSummary,
        },
        Library,
    },
};

use crate::library::models::{
    IgdbApplyRequest, IgdbArtworkReplaceRequest, IgdbConnection, IgdbCredentialStatus,
    IgdbGamePreview, IgdbSearchResult, TmdbApplyRequest, TmdbArtworkReplaceRequest,
    TmdbConnection, TmdbCredentialStatus, TmdbMoviePreview, TmdbSearchResult,
};

#[tauri::command]
pub async fn inspect_metadata_import(folder: String) -> Result<MetadataImportPlan, CommandError> {
    tauri::async_runtime::spawn_blocking(move || metadata_import::inspect(folder.as_ref()))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[derive(Clone, Default)]
pub struct AppState {
    library: Arc<RwLock<Option<Library>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AladinCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCaptureSettings {
    pub enabled: bool,
    pub api_base_url: Option<String>,
    pub token_configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCaptureConnectionStatus {
    pub pending_count: u32,
}

impl From<LibraryError> for CommandError {
    fn from(error: LibraryError) -> Self {
        let message = match &error {
            LibraryError::Backup { .. } => "SQLite 백업 작업에 실패했습니다.".into(),
            // 데이터베이스 오류는 원인을 그대로 드러낸다. 잠금·경합과 제약 위반을
            // 구별할 수 있어야 사용자가 재시도할지 신고할지 판단한다.
            LibraryError::Database(source) => match source {
                rusqlite::Error::SqliteFailure(code, _)
                    if matches!(
                        code.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
                {
                    "데이터베이스가 다른 작업으로 바쁩니다. 잠시 후 다시 시도해 주세요.".into()
                }
                _ => format!("SQLite 작업이 실패했습니다: {source}"),
            },
            LibraryError::WriteAsset { .. } => {
                "이미지 파일을 정리하지 못했습니다. 다시 시도해 주세요.".into()
            }
            LibraryError::WriteWorkArtwork { .. } => {
                "Work 표지 파일을 저장하지 못했습니다. 다시 시도해 주세요.".into()
            }
            LibraryError::WriteCollectionThumbnail { .. } => {
                "컬렉션 썸네일을 저장하지 못했습니다. 다시 시도해 주세요.".into()
            }
            _ => error.to_string(),
        };
        let code = match error {
            LibraryError::LibraryInUse => "library_in_use",
            LibraryError::LibraryLock { .. } => "library_lock_failed",
            LibraryError::Backup { .. } => "backup_failed",
            LibraryError::InvalidBackup => "invalid_backup",
            LibraryError::RestoreFailed { .. } => "restore_failed",
            LibraryError::CreateDirectory { .. } => "create_directory_failed",
            LibraryError::Database(_) => "database_failed",
            LibraryError::InvalidCloudSyncConfig => "invalid_cloud_sync_config",
            LibraryError::InvalidCloudSyncQueueItem => "invalid_cloud_sync_queue_item",
            LibraryError::CloudCredentialNotConfigured => "cloud_credential_not_configured",
            LibraryError::InvalidCloudCredentialValue => "invalid_cloud_credential_value",
            LibraryError::CloudUnauthorized => "cloud_unauthorized",
            LibraryError::CloudRequestTimedOut => "cloud_request_timed_out",
            LibraryError::CloudRequestUnavailable => "cloud_request_unavailable",
            LibraryError::InvalidCloudResponse => "invalid_cloud_response",
            LibraryError::CloudPresignRejected(_) => "cloud_presign_rejected",
            LibraryError::CloudUploadRejected(_) => "cloud_upload_rejected",
            LibraryError::CloudAssetRegistrationRejected(_) => "cloud_asset_registration_rejected",
            LibraryError::CloudObjectKeyConflict => "cloud_object_key_conflict",
            LibraryError::CloudSourceUnavailable => "cloud_source_unavailable",
            LibraryError::CloudSourceChanged => "cloud_source_changed",
            LibraryError::CloudThumbnailUnavailable => "cloud_thumbnail_unavailable",
            LibraryError::CloudReplicationPrepareRejected(_) => "cloud_replication_prepare_rejected",
            LibraryError::CloudReplicationCommitRejected(_) => "cloud_replication_commit_rejected",
            LibraryError::CloudCaptureListRejected(_) => "cloud_capture_list_rejected",
            LibraryError::CloudCaptureTicketRejected(_) => "cloud_capture_ticket_rejected",
            LibraryError::CloudCaptureDownloadRejected(_) => "cloud_capture_download_rejected",
            LibraryError::CloudCaptureTooLarge => "cloud_capture_too_large",
            LibraryError::CloudCaptureStagingFailed => "cloud_capture_staging_failed",
            LibraryError::CloudCaptureAcknowledgementRejected(_) => "cloud_capture_ack_rejected",
            LibraryError::InvalidCloudCaptureRecord => "invalid_cloud_capture_record",
            LibraryError::CloudCaptureReviewPending => "cloud_capture_review_pending",
            LibraryError::CloudClassificationsPublishRejected(_) => "cloud_classifications_publish_rejected",
            LibraryError::CloudSavedXMediaPublishRejected(_) => "cloud_saved_x_media_publish_rejected",
            LibraryError::InvalidClassificationSnapshot => "invalid_classification_snapshot",
            LibraryError::OnlineCatalogNotInstalled => "online_catalog_not_installed",
            LibraryError::OnlineCatalogWorkNotFound => "online_catalog_work_not_found",
            LibraryError::InvalidOnlineCatalog => "invalid_online_catalog",
            LibraryError::InvalidCatalogTransportPath => "invalid_catalog_transport_path",
            LibraryError::CatalogTransportRejected(_) => "catalog_transport_rejected",
            LibraryError::InvalidCatalogTransportResponse => "invalid_catalog_transport_response",
            LibraryError::CatalogTransportTimedOut => "catalog_transport_timed_out",
            LibraryError::CatalogTransportBusy => "catalog_transport_busy",
            LibraryError::CatalogTransportUnavailable => "catalog_transport_unavailable",
            LibraryError::InvalidCatalogUpdateInterval => "invalid_catalog_update_interval",
            LibraryError::InvalidRemoteGallery => "invalid_remote_gallery",
            LibraryError::RemoteGalleryUnavailable => "remote_gallery_unavailable",
            LibraryError::InvalidRemoteReadingProgress => "invalid_remote_reading_progress",
            LibraryError::OnlineCatalogImport { .. } => "online_catalog_import_failed",
            LibraryError::UnsupportedSchema(_) => "unsupported_schema",
            LibraryError::MetadataImportManifestCount => "metadata_import_manifest_count",
            LibraryError::UnsupportedMetadataImport => "unsupported_metadata_import",
            LibraryError::InvalidMetadataImport => "invalid_metadata_import",
            LibraryError::MetadataImportTooLarge => "metadata_import_too_large",
            LibraryError::UnsafeMetadataImportPath => "unsafe_metadata_import_path",
            LibraryError::ReadMetadataImport { .. } => "read_metadata_import_failed",
            LibraryError::InvalidTrashRetention => "invalid_trash_retention",
            LibraryError::UnsupportedManagedFileDeletion => "unsupported_managed_file_deletion",
            LibraryError::EmptyClassificationName => "empty_classification_name",
            LibraryError::ClassificationNotFound => "classification_not_found",
            LibraryError::DuplicateClassificationName => "duplicate_classification_name",
            LibraryError::InvalidClassificationParent => "invalid_classification_parent",
            LibraryError::ClassificationCycle => "classification_cycle",
            LibraryError::InvalidClassificationAppearance => "invalid_classification_appearance",
            LibraryError::ClassificationHasChildren => "classification_has_children",
            LibraryError::EmptyAlbumName => "empty_album_name",
            LibraryError::AlbumNotFound => "album_not_found",
            LibraryError::DuplicateAlbumName => "duplicate_album_name",
            LibraryError::AlbumCycle => "album_cycle",
            LibraryError::AlbumHasChildren => "album_has_children",
            LibraryError::InvalidAlbumAppearance => "invalid_album_appearance",
            LibraryError::EmptyCollectionName => "empty_collection_name",
            LibraryError::CollectionNameTooLong => "collection_name_too_long",
            LibraryError::CollectionDescriptionTooLong => "collection_description_too_long",
            LibraryError::CollectionNotFound => "collection_not_found",
            LibraryError::InvalidExternalBinding => "invalid_external_binding",
            LibraryError::DuplicateCollectionName => "duplicate_collection_name",
            LibraryError::CollectionCoverNotMember => "collection_cover_not_member",
            LibraryError::InvalidCollectionType => "invalid_collection_type",
            LibraryError::InvalidCollectionReleaseDate => "invalid_collection_release_date",
            LibraryError::InvalidPersonalRating => "invalid_personal_rating",
            LibraryError::InvalidMovieRuntime => "invalid_movie_runtime",
            LibraryError::AssetNotFound => "asset_not_found",
            LibraryError::EmptyAssetSelection => "empty_asset_selection",
            LibraryError::InvalidAssetSelection => "invalid_asset_selection",
            LibraryError::AssetDragFailed { .. } => "asset_drag_failed",
            LibraryError::InvalidAssetPageLimit => "invalid_asset_page_limit",
            LibraryError::InvalidAssetScope => "invalid_asset_scope",
            LibraryError::InvalidAssetCursor => "invalid_asset_cursor",
            LibraryError::InvalidAssetDateRange => "invalid_asset_date_range",
            LibraryError::InvalidPerceptualHash => "invalid_perceptual_hash",
            LibraryError::SimilarityReviewNotFound => "similarity_review_not_found",
            LibraryError::SimilarityReviewConflict => "similarity_review_conflict",
            LibraryError::InvalidTrashTimestamp => "invalid_trash_timestamp",
            LibraryError::InvalidCollectedAt => "invalid_collected_at",
            LibraryError::InvalidSourcePublishedAt => "invalid_source_published_at",
            LibraryError::InvalidCreatorUrl => "invalid_creator_url",
            LibraryError::InvalidImportBatchId => "invalid_import_batch_id",
            LibraryError::ReadLegacySnapshot { .. } => "read_legacy_snapshot_failed",
            LibraryError::InvalidLegacySnapshot { .. } => "invalid_legacy_snapshot",
            LibraryError::DuplicateLegacyMetadata(_) => "duplicate_legacy_metadata",
            LibraryError::ReadLegacyRoot { .. } => "read_legacy_root_failed",
            LibraryError::LegacyLibraryMismatch => "legacy_library_mismatch",
            LibraryError::ReadLegacyPackage { .. } => "read_legacy_package_failed",
            LibraryError::InvalidLegacyPackage(_) => "invalid_legacy_package",
            LibraryError::MediaNotFound => "media_not_found",
            LibraryError::UnsafeMediaPath => "unsafe_media_path",
            LibraryError::ReadMedia { .. } => "read_media_failed",
            LibraryError::ReadSource { .. } => "read_source_failed",
            LibraryError::UnsupportedImage => "unsupported_image",
            LibraryError::InvalidWorkArtwork => "invalid_work_artwork",
            LibraryError::WriteWorkArtwork { .. } => "write_work_artwork_failed",
            LibraryError::WriteCollectionThumbnail { .. } => "write_collection_thumbnail_failed",
            LibraryError::InvalidMangaDexQuery => "invalid_mangadex_query",
            LibraryError::InvalidMangaDexIdentity => "invalid_mangadex_identity",
            LibraryError::MangaDexUnavailable => "mangadex_unavailable",
            LibraryError::MangaDexTimedOut => "mangadex_timed_out",
            LibraryError::MangaDexRateLimited => "mangadex_rate_limited",
            LibraryError::MangaDexNotFound => "mangadex_not_found",
            LibraryError::InvalidMangaDexResponse => "invalid_mangadex_response",
            LibraryError::DuplicateProviderBinding => "duplicate_provider_binding",
            LibraryError::InvalidAladinQuery => "invalid_aladin_query",
            LibraryError::InvalidAladinCredential => "invalid_aladin_credential",
            LibraryError::AladinCredentialNotConfigured => "aladin_credential_not_configured",
            LibraryError::InvalidAladinCredentialValue => "invalid_aladin_credential_value",
            LibraryError::CredentialStoreUnavailable => "credential_store_unavailable",
            LibraryError::CredentialStoreFailed => "credential_store_failed",
            LibraryError::InvalidIgdbCredential => "invalid_igdb_credential",
            LibraryError::IgdbCredentialNotConfigured => "igdb_credential_not_configured",
            LibraryError::InvalidIgdbCredentialValue => "invalid_igdb_credential_value",
            LibraryError::IgdbInvalidRequest => "igdb_invalid_request",
            LibraryError::IgdbUnauthorized => "igdb_unauthorized",
            LibraryError::IgdbNotFound => "igdb_not_found",
            LibraryError::IgdbRateLimited => "igdb_rate_limited",
            LibraryError::IgdbTimedOut => "igdb_timed_out",
            LibraryError::IgdbUnavailable => "igdb_unavailable",
            LibraryError::IgdbInvalidResponse => "igdb_invalid_response",
            LibraryError::IgdbInvalidImageId => "igdb_invalid_image_id",
            LibraryError::InvalidIgdbIdentity => "invalid_igdb_identity",
            LibraryError::TmdbCredentialNotConfigured => "tmdb_credential_not_configured",
            LibraryError::InvalidTmdbCredentialValue => "invalid_tmdb_credential_value",
            LibraryError::TmdbUnauthorized => "tmdb_unauthorized",
            LibraryError::TmdbRateLimited => "tmdb_rate_limited",
            LibraryError::TmdbTimedOut => "tmdb_timed_out",
            LibraryError::TmdbUnavailable => "tmdb_unavailable",
            LibraryError::TmdbNotFound => "tmdb_not_found",
            LibraryError::TmdbInvalidResponse => "tmdb_invalid_response",
            LibraryError::TmdbInvalidImagePath => "tmdb_invalid_image_path",
            LibraryError::InvalidTmdbIdentity => "invalid_tmdb_identity",
            LibraryError::AladinUnavailable => "aladin_unavailable",
            LibraryError::AladinTimedOut => "aladin_timed_out",
            LibraryError::AladinRateLimited => "aladin_rate_limited",
            LibraryError::InvalidAladinResponse => "invalid_aladin_response",
            LibraryError::AmbiguousAladinBinding => "ambiguous_aladin_binding",
            LibraryError::ReleaseWatchRequiresAladinBinding => {
                "release_watch_requires_aladin_binding"
            }
            LibraryError::DuplicateAladinProviderItem => "duplicate_aladin_provider_item",
            LibraryError::UnsupportedVideo => "unsupported_video",
            LibraryError::VideoPreparationFailed => "video_preparation_failed",
            LibraryError::VideoToolUnavailable => "video_tool_unavailable",
            LibraryError::WriteAsset { .. } => "write_asset_failed",
            LibraryError::MangaRootNotSet => "manga_root_not_set",
            LibraryError::CollectionSourceRootNotSet => "collection_source_root_not_set",
            LibraryError::CollectionSourcePathNotSet => "collection_source_path_not_set",
            LibraryError::MangaSeriesNotFound => "manga_series_not_found",
        };
        Self { code, message }
    }
}

impl AppState {
    pub(crate) fn current_library(&self) -> Option<Library> {
        self.library
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[tauri::command]
pub fn get_extension_connection(
    runtime: State<'_, crate::extension_api::ExtensionRuntime>,
) -> crate::extension_api::ExtensionConnection {
    runtime.connection()
}

#[tauri::command]
pub async fn open_library(
    path: String,
    state: State<'_, AppState>,
) -> Result<LibrarySummary, CommandError> {
    // 폴더 스캔·스키마 확인이 포함되어 수 초 걸릴 수 있으므로 메인 스레드를 막지 않는다.
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || open_library_in_state(path, &state))
        .await
        .map_err(|_| background_task_error())?
}

fn open_library_in_state(path: String, state: &AppState) -> Result<LibrarySummary, CommandError> {
    let mut current = state
        .library
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(library) = current
        .as_ref()
        .filter(|library| library.root() == std::path::Path::new(&path))
    {
        return library.summary().map_err(CommandError::from);
    }

    let library = open_library_at(path)?;
    let summary = library.summary().map_err(CommandError::from)?;
    *current = Some(library);
    Ok(summary)
}

fn open_library_at(path: String) -> Result<Library, CommandError> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(CommandError {
            code: "library_root_unavailable",
            message: "선택한 라이브러리 폴더를 찾을 수 없습니다.".into(),
        });
    }
    Library::open(path).map_err(CommandError::from)
}

#[tauri::command]
pub async fn ensure_daily_backup(
    state: State<'_, AppState>,
) -> Result<Option<MetadataBackup>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.ensure_daily_backup(chrono::Utc::now())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn restore_metadata_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.restore_backup(&backup_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_metadata_backups(
    state: State<'_, AppState>,
) -> Result<Vec<MetadataBackup>, CommandError> {
    current_required(state)?
        .list_backups()
        .map_err(CommandError::from)
}
#[tauri::command]
pub fn list_classifications(
    state: State<'_, AppState>,
) -> Result<Vec<ClassificationEntry>, CommandError> {
    current_required(state)?
        .list_classifications()
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn create_classification(
    request: CreateClassification,
    state: State<'_, AppState>,
) -> Result<ClassificationEntry, CommandError> {
    current_required(state)?
        .create_classification(request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn rename_classification(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .rename_classification(&id, &name)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn update_classification_appearance(
    id: String,
    icon_key: Option<String>,
    color_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .update_classification_appearance(&id, icon_key.as_deref(), color_key.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn move_classification(
    id: String,
    parent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .move_classification(&id, parent_id.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn delete_classification(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    current_required(state)?
        .delete_classification(&id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_asset_classifications(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    current_required(state)?
        .get_asset_classifications(&asset_id)
        .map(|entries| entries.into_iter().map(|entry| entry.id).collect())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_assets(
    query: AssetQuery,
    state: State<'_, AppState>,
) -> Result<AssetPage, CommandError> {
    current_required(state)?
        .list_assets(query)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_asset_date_buckets(
    query: AssetDateBucketQuery,
    state: State<'_, AppState>,
) -> Result<Vec<AssetDateBucket>, CommandError> {
    current_required(state)?
        .list_asset_date_buckets(query)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn list_asset_creators(
    query: AssetQuery,
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::models::AssetCreatorSummary>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .list_asset_creators(query)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}

#[tauri::command]
pub async fn get_revisit_slate(
    local_date: String,
    now_utc: String,
    state: State<'_, AppState>,
) -> Result<crate::library::models::RevisitSlate, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .get_or_create_revisit_slate(&local_date, &now_utc)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}

#[tauri::command]
pub async fn reshuffle_revisit_bundle(
    local_date: String,
    bundle_id: String,
    now_utc: String,
    state: State<'_, AppState>,
) -> Result<crate::library::models::RevisitSlate, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .reshuffle_revisit_bundle(&local_date, &bundle_id, &now_utc)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}

#[tauri::command]
pub async fn reshuffle_revisit_slate(
    local_date: String,
    now_utc: String,
    state: State<'_, AppState>,
) -> Result<crate::library::models::RevisitSlate, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .reshuffle_revisit_slate(&local_date, &now_utc)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}

#[tauri::command]
pub fn record_asset_opened(
    asset_id: String,
    opened_at: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .record_asset_opened(&asset_id, &opened_at)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn record_assets_exposed(
    asset_ids: Vec<String>,
    exposed_at: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .record_assets_exposed(&asset_ids, &exposed_at)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_revisit_preference(
    feedback: crate::library::models::RevisitFeedback,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_revisit_preference(feedback.dimension(), &feedback.value(), &feedback.recorded_at())
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn index_missing_similarity_hashes(
    state: State<'_, AppState>,
) -> Result<SimilarityIndexProgress, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.index_missing_similarity_hashes())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_similarity_reviews(
    after: Option<AssetCursor>,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<SimilarityReviewPage, CommandError> {
    current_required(state)?
        .list_similarity_reviews(after, limit)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn decide_similarity_review(
    request: SimilarityDecisionRequest,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.decide_similarity_review(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_asset(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<AssetSummary, CommandError> {
    current_required(state)?
        .get_asset(&asset_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn update_asset_metadata(
    request: AssetMetadataPatch,
    state: State<'_, AppState>,
) -> Result<AssetSummary, CommandError> {
    current_required(state)?
        .update_asset_metadata(request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn trash_assets(
    asset_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .trash_assets(&asset_ids)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn restore_asset(asset_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    current_required(state)?
        .restore_asset(&asset_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn restore_assets(
    asset_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .restore_assets(&asset_ids)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_trash(
    after: Option<crate::library::models::AssetCursor>,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<TrashPage, CommandError> {
    current_required(state)?
        .list_trash(after, limit)
        .map_err(CommandError::from)
}


#[tauri::command]
pub async fn empty_trash(state: State<'_, AppState>) -> Result<PurgeSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.empty_trash())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_trash_policy(state: State<'_, AppState>) -> Result<TrashPolicy, CommandError> {
    current_required(state)?
        .trash_policy()
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_trash_policy(
    policy: TrashPolicy,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_trash_policy(policy)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn purge_expired_trash(state: State<'_, AppState>) -> Result<PurgeSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.purge_expired_trash(chrono::Utc::now()))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_asset_favorite(
    asset_id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_asset_favorite(&asset_id, favorite)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_assets_favorite(
    asset_ids: Vec<String>,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_assets_favorite(&asset_ids, favorite)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_albums(state: State<'_, AppState>) -> Result<Vec<AlbumEntry>, CommandError> {
    current_required(state)?
        .list_albums()
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn create_album(
    request: CreateAlbum,
    state: State<'_, AppState>,
) -> Result<AlbumEntry, CommandError> {
    current_required(state)?
        .create_album(request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn rename_album(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .rename_album(&id, &name)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn move_album(
    id: String,
    parent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .move_album(&id, parent_id.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn update_album_appearance(
    id: String,
    icon_key: Option<String>,
    color_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .update_album_appearance(&id, icon_key.as_deref(), color_key.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn delete_album(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    current_required(state)?
        .delete_album(&id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_asset_albums(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    current_required(state)?
        .get_asset_albums(&asset_id)
        .map(|entries| entries.into_iter().map(|entry| entry.id).collect())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn patch_asset_albums(
    patch: AssetAlbumPatch,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .patch_asset_albums(patch)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_collections(
    state: State<'_, AppState>,
) -> Result<Vec<CollectionSummary>, CommandError> {
    current_required(state)?
        .list_collections()
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_mangadex(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<MangaDexSearchResult>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.search_mangadex(&query))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn preview_mangadex(
    manga_id: String,
    state: State<'_, AppState>,
) -> Result<MangaDexWorkPreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preview_mangadex(&manga_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn apply_mangadex(
    request: MangaDexApplyRequest,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_mangadex(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn refresh_mangadex(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.refresh_mangadex(&collection_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_igdb_credential_status() -> Result<IgdbCredentialStatus, CommandError> {
    credential::igdb_credential_status().map_err(CommandError::from)
}

#[tauri::command]
pub fn set_igdb_credentials(
    client_id: String,
    client_secret: String,
) -> Result<IgdbCredentialStatus, CommandError> {
    credential::set_igdb_credentials_os(&client_id, &client_secret).map_err(CommandError::from)
}

#[tauri::command]
pub fn delete_igdb_credentials() -> Result<IgdbCredentialStatus, CommandError> {
    credential::delete_igdb_credentials_os().map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_igdb_games(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<IgdbSearchResult>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.search_igdb_games(&query))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn preview_igdb_game(
    game_id: i64,
    state: State<'_, AppState>,
) -> Result<IgdbGamePreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preview_igdb_game(game_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn apply_igdb_game(
    request: IgdbApplyRequest,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_igdb_game(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn refresh_igdb_game(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.refresh_igdb_game(&collection_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_igdb_connection(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Option<IgdbConnection>, CommandError> {
    current_required(state)?
        .get_igdb_connection(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn replace_igdb_game_artwork(
    request: IgdbArtworkReplaceRequest,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.replace_igdb_game_artwork(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_tmdb_credential_status() -> Result<TmdbCredentialStatus, CommandError> {
    credential::tmdb_credential_status().map_err(CommandError::from)
}

#[tauri::command]
pub fn set_tmdb_token(token: String) -> Result<TmdbCredentialStatus, CommandError> {
    credential::set_tmdb_token_os(&token).map_err(CommandError::from)
}

#[tauri::command]
pub fn delete_tmdb_token() -> Result<TmdbCredentialStatus, CommandError> {
    credential::delete_tmdb_token_os().map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_tmdb_movies(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<TmdbSearchResult>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.search_tmdb_movies(&query))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn preview_tmdb_movie(
    movie_id: i64,
    state: State<'_, AppState>,
) -> Result<TmdbMoviePreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preview_tmdb_movie(movie_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn apply_tmdb_movie(
    request: TmdbApplyRequest,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_tmdb_movie(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn refresh_tmdb_movie(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.refresh_tmdb_movie(&collection_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_tmdb_connection(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Option<TmdbConnection>, CommandError> {
    current_required(state)?
        .get_tmdb_connection(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn replace_tmdb_movie_artwork(
    request: TmdbArtworkReplaceRequest,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.replace_tmdb_movie_artwork(request))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_mangadex_connection(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Option<MangaDexConnection>, CommandError> {
    current_required(state)?
        .get_mangadex_connection(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_aladin_credential_status() -> Result<AladinCredentialStatus, CommandError> {
    credential::aladin_key_status()
        .map(|configured| AladinCredentialStatus { configured })
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_aladin_ttb_key(ttb_key: String) -> Result<AladinCredentialStatus, CommandError> {
    credential::set_aladin_key(&ttb_key).map_err(CommandError::from)?;
    Ok(AladinCredentialStatus { configured: true })
}

#[tauri::command]
pub fn delete_aladin_ttb_key() -> Result<AladinCredentialStatus, CommandError> {
    credential::delete_aladin_key().map_err(CommandError::from)?;
    Ok(AladinCredentialStatus { configured: false })
}

#[tauri::command]
pub async fn search_aladin(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<AladinSeriesCandidate>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = credential::read_aladin_key()?;
        library.search_aladin(&key, &query)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn apply_aladin(
    request: AladinApplyRequest,
    state: State<'_, AppState>,
) -> Result<AladinSyncResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = credential::read_aladin_key()?;
        library.apply_aladin(&key, request)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn refresh_aladin(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<AladinSyncResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = credential::read_aladin_key()?;
        library.refresh_aladin(&key, &collection_id)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_aladin_connection(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AladinConnection>, CommandError> {
    current_required(state)?
        .get_aladin_connection(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_release_watch_status(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<ReleaseWatchStatus, CommandError> {
    current_required(state)?
        .get_release_watch_status(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_release_watch_enabled(
    collection_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ReleaseWatchStatus, CommandError> {
    current_required(state)?
        .set_release_watch_enabled(&collection_id, enabled)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn take_unread_release_changes(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ReleaseWatchEvent>, CommandError> {
    current_required(state)?
        .take_unread_release_changes(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_unread_release_changes(
    state: State<'_, AppState>,
) -> Result<Vec<ReleaseWatchEvent>, CommandError> {
    current_required(state)?
        .list_unread_release_changes()
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn run_due_release_watch(
    state: State<'_, AppState>,
) -> Result<ReleaseWatchRunResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_release_watch_with_key(&library, credential::read_aladin_key())
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

fn run_release_watch_with_key(
    library: &Library,
    key: Result<String, LibraryError>,
) -> Result<ReleaseWatchRunResult, LibraryError> {
    match key {
        Ok(key) => library.run_due_release_watch(&key),
        Err(LibraryError::AladinCredentialNotConfigured) => Ok(ReleaseWatchRunResult {
            checked: 0,
            changed_collections: 0,
            skipped: 0,
            stop_reason: Some(ReleaseWatchRunStopReason::CredentialNotConfigured),
        }),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn create_collection(
    request: CreateCollection,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    current_required(state)?
        .create_collection(request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn update_collection(
    id: String,
    request: UpdateCollection,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    current_required(state)?
        .update_collection(&id, request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn delete_collection(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    current_required(state)?
        .delete_collection(&id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_collection_cover(
    collection_id: String,
    asset_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    current_required(state)?
        .set_collection_cover(&collection_id, asset_id.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_asset_collections(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    current_required(state)?
        .get_asset_collections(&asset_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn patch_asset_collections(
    patch: AssetCollectionPatch,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .patch_asset_collections(patch)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_collection_showcase(
    collection_id: String,
    showcase: bool,
    state: State<'_, AppState>,
) -> Result<CollectionSummary, CommandError> {
    current_required(state)?
        .set_collection_showcase(&collection_id, showcase)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_asset_classification(
    request: SetAssetClassification,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_asset_classification(request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn ingest_media(
    request: IngestMediaRequest,
    state: State<'_, AppState>,
) -> Result<IngestOutcome, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.ingest_media(request))
        .await
        .map_err(|error| CommandError {
            code: "ingest_failed",
            message: error.to_string(),
        })?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn prepare_pending_videos(
    limit: u32,
    state: State<'_, AppState>,
) -> Result<VideoPreparationProgress, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.prepare_pending_videos(limit))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn retry_video_preparation(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .retry_video_preparation(&asset_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn start_asset_drag(
    asset_ids: Vec<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let prepared = current_required(state)?
        .prepare_asset_drag(&asset_ids)
        .map_err(CommandError::from)?;
    let files = prepared.files.clone();
    let preview = prepared.preview.clone();
    let cleanup = Arc::new(Mutex::new(Some(prepared)));
    let callback_cleanup = Arc::clone(&cleanup);
    let callback_window = window.clone();
    let ended_asset_ids = asset_ids.clone();
    let result = drag::start_drag(
        &window,
        drag::DragItem::Files(files),
        drag::Image::File(preview),
        move |_result, _cursor| {
            let _ = callback_window.emit("asset-drag://ended", ended_asset_ids.clone());
            drop(
                callback_cleanup
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take(),
            );
        },
        drag::Options {
            mode: drag::DragMode::Copy,
            ..Default::default()
        },
    );
    if result.is_err() {
        drop(
            cleanup
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take(),
        );
        return Err(CommandError {
            code: "asset_drag_failed",
            message: "자산 드래그를 시작하지 못했습니다.".into(),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn get_manga_root(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    let library = current_required(state)?;
    library.manga_root().map_err(CommandError::from)
}

#[tauri::command]
pub fn set_manga_root(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    library
        .set_manga_root(path.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn scan_manga(state: State<'_, AppState>) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.scan_manga())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn list_manga_series(state: State<'_, AppState>) -> Result<Vec<MangaSeries>, CommandError> {
    let library = current_required(state)?;
    library.list_manga_series().map_err(CommandError::from)
}

#[tauri::command]
pub async fn preview_manga_catalog_recovery(
    state: State<'_, AppState>,
) -> Result<MangaCatalogRecoveryPreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preview_manga_catalog_recovery())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn apply_manga_catalog_recovery(
    state: State<'_, AppState>,
) -> Result<MangaCatalogRecoveryApplyResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_manga_catalog_recovery())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn import_vck_catalog(
    vck_root: String,
    state: State<'_, AppState>,
) -> Result<CatalogStatus, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.import_vck_catalog(vck_root.as_ref()))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_online_catalog_status(
    state: State<'_, AppState>,
) -> Result<CatalogStatus, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.catalog_status())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_online_catalog(
    query: CatalogSearchQuery,
    state: State<'_, AppState>,
) -> Result<CatalogSearchPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.search_online_catalog(query))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn suggest_online_catalog(
    text: String,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<CatalogSuggestion>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.suggest_online_catalog(&text, limit))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_online_catalog_work_detail(
    work_id: u64,
    state: State<'_, AppState>,
) -> Result<CatalogWorkDetail, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.online_catalog_work_detail(work_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_online_catalog_bookmark(
    work_id: u64,
    bookmarked: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_online_catalog_bookmark(work_id, bookmarked)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn update_online_catalog(
    app: AppHandle,
    state: State<'_, AppState>,
    transport: State<'_, CatalogTransport>,
    update_state: State<'_, CatalogUpdateState>,
) -> Result<CatalogUpdateResult, CommandError> {
    run_online_catalog_update(app, state, transport, update_state).await
}

#[tauri::command]
pub async fn run_due_online_catalog_update(
    app: AppHandle,
    state: State<'_, AppState>,
    transport: State<'_, CatalogTransport>,
    update_state: State<'_, CatalogUpdateState>,
) -> Result<Option<CatalogUpdateResult>, CommandError> {
    let library = current_required(state.clone())?;
    let status = library.catalog_status().map_err(CommandError::from)?;
    if !status.installed
        || !catalog_update::is_update_due(
            status.update_enabled,
            status.update_interval_seconds,
            status.last_attempt_at.as_deref(),
            chrono::Utc::now(),
        )
    {
        return Ok(None);
    }
    run_online_catalog_update(app, state, transport, update_state)
        .await
        .map(Some)
}

async fn run_online_catalog_update(
    app: AppHandle,
    state: State<'_, AppState>,
    transport: State<'_, CatalogTransport>,
    update_state: State<'_, CatalogUpdateState>,
) -> Result<CatalogUpdateResult, CommandError> {
    let library = current_required(state)?;
    let Some(_guard) = update_state.begin() else {
        return Ok(CatalogUpdateResult {
            added: 0,
            pages: 0,
            reason: CatalogUpdateStopReason::AlreadyRunning,
            last_success_at: library
                .catalog_status()
                .map_err(CommandError::from)?
                .last_success_at,
        });
    };
    let vps_base_url = library
        .cloud_sync_config()
        .ok()
        .and_then(|config| config.api_base_url);
    // VPS base url이 설정된 경우 PC는 k-hentai 직접 연결 없이 VPS를 경유한다.
    catalog_update::execute_catalog_update(library, &transport, &app, vps_base_url)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn set_online_catalog_update_settings(
    enabled: bool,
    interval_seconds: u64,
    state: State<'_, AppState>,
) -> Result<CatalogStatus, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.set_catalog_update_settings(enabled, interval_seconds)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_cloud_capture_settings(
    state: State<'_, AppState>,
) -> Result<CloudCaptureSettings, CommandError> {
    let library = current_required(state)?;
    let config = library.cloud_sync_config().map_err(CommandError::from)?;
    let token_configured = credential::cloud_api_token_status().map_err(CommandError::from)?;
    Ok(CloudCaptureSettings {
        enabled: config.enabled,
        api_base_url: config.api_base_url,
        token_configured,
    })
}

#[tauri::command]
pub fn set_cloud_capture_settings(
    enabled: bool,
    api_base_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<CloudCaptureSettings, CommandError> {
    let library = current_required(state)?;
    let config = library
        .set_cloud_sync_config(CloudSyncConfig { enabled, api_base_url })
        .map_err(CommandError::from)?;
    let token_configured = credential::cloud_api_token_status().map_err(CommandError::from)?;
    Ok(CloudCaptureSettings {
        enabled: config.enabled,
        api_base_url: config.api_base_url,
        token_configured,
    })
}

#[tauri::command]
pub fn set_cloud_api_token(token: String) -> Result<CloudCredentialStatus, CommandError> {
    credential::set_cloud_api_token_os(&token).map_err(CommandError::from)?;
    Ok(CloudCredentialStatus { configured: true })
}

#[tauri::command]
pub fn delete_cloud_api_token() -> Result<CloudCredentialStatus, CommandError> {
    credential::delete_cloud_api_token_os().map_err(CommandError::from)?;
    Ok(CloudCredentialStatus { configured: false })
}

#[tauri::command]
pub async fn test_cloud_capture_connection(
    state: State<'_, AppState>,
) -> Result<CloudCaptureConnectionStatus, CommandError> {
    let library = current_required(state)?;
    let pending_count = tauri::async_runtime::spawn_blocking(move || library.test_cloud_capture_connection())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)?;
    Ok(CloudCaptureConnectionStatus { pending_count })
}

// --- CLOUD-006 배치 3.5: 백필 수동 제어 커맨드 ------------------------------
// 설정 UI 없이 제어된 수동 호출과 향후 UI 재사용을 위한 최소 표면.
// 비즈니스 로직은 cloud/backfill.rs 구현을 그대로 위임한다.
// 자동 시작은 없다: 앱 시작 시 백필을 임의로 구동하지 않는다.

#[tauri::command]
pub async fn cloud_backfill_preflight(
    state: State<'_, AppState>,
) -> Result<crate::library::cloud_preflight::PreflightReport, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preflight_full_library())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn cloud_backfill_seed(
    state: State<'_, AppState>,
) -> Result<crate::cloud::backfill::BackfillSeedReport, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.seed_cloud_backfill_queue())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn cloud_backfill_run_cycle(
    state: State<'_, AppState>,
) -> Result<crate::cloud::backfill::BackfillRunSummary, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.run_cloud_backfill_cycle())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn cloud_backfill_progress(
    state: State<'_, AppState>,
) -> Result<crate::cloud::backfill::BackfillProgress, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.cloud_backfill_progress())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn cloud_backfill_retry_failed(
    state: State<'_, AppState>,
) -> Result<crate::cloud::backfill::BackfillRetryReport, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.retry_failed_cloud_backfill())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn cloud_backfill_set_control_state(
    state: crate::cloud::backfill::BackfillControlState,
    app_state: State<'_, AppState>,
) -> Result<crate::cloud::backfill::BackfillControlState, CommandError> {
    let library = current_required(app_state)?;
    tauri::async_runtime::spawn_blocking(move || library.set_cloud_backfill_control_state(state))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn cloud_backfill_reconcile(
    state: State<'_, AppState>,
) -> Result<crate::cloud::backfill::BackfillReconcileReport, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.reconcile_cloud_backfill())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn run_due_cloud_capture_sync(
    state: State<'_, AppState>,
) -> Result<crate::cloud::captures::CloudCaptureSyncResult, CommandError> {
    // 수집 파일 해시·썸네일 작업이 포함되므로 블로킹 스레드에서 실행한다.
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.sync_next_cloud_capture())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

/// 가장 최근 저장된 갤러리 HTML을 VPS에서 받아 페이지 목록으로 만든다.
/// 직렬 resolver: 유효한 manifest 캐시가 있으면 네트워크 없이 즉시 돌아간다.
fn resolved_gallery_from_cache_or_source(
    root: &std::path::Path,
    work_id: u64,
    source: &dyn crate::catalog_source::CatalogSource,
) -> Result<ResolvedGallery, LibraryError> {
    if let Some(manifest) = crate::library::remote_gallery::load_valid_manifest(root, work_id)?
    {
        return Ok(ResolvedGallery {
            provider: RemoteProvider::KHentai,
            work_id: work_id.to_string(),
            page_count: manifest.pages.len() as u32,
            page_urls: manifest.pages.into_iter().map(|page| page.url).collect(),
        });
    }
    let pages = crate::library::remote_gallery::fetch_khentai_gallery(work_id, source)?;
    let page_count = pages.len() as u32;
    let page_urls = pages.iter().map(|page| page.url.clone()).collect();
    crate::library::remote_gallery::write_manifest(
        root,
        &crate::library::remote_gallery::RemoteGalleryManifest::khentai(work_id, pages),
    )?;
    Ok(ResolvedGallery {
        provider: RemoteProvider::KHentai,
        work_id: work_id.to_string(),
        page_count,
        page_urls,
    })
}

#[tauri::command]
pub async fn resolve_online_catalog_work(
    work_id: u64,
    state: State<'_, AppState>,
) -> Result<ResolvedGallery, CommandError> {
    let library = current_required(state)?;
    let root = library.root().to_path_buf();
    let vps_base_url = library
        .cloud_sync_config()
        .ok()
        .and_then(|config| config.api_base_url);
    tauri::async_runtime::spawn_blocking(move || -> Result<ResolvedGallery, LibraryError> {
        match vps_base_url.as_deref() {
            Some(base_url) => {
                let client = crate::catalog_source::VpsCatalogSource::new(base_url)?;
                resolved_gallery_from_cache_or_source(&root, work_id, &client)
            }
            None => {
                // VPS 미설정 시 기존 동작: PC가 k-hentai에 직접 닿는다(레거시).
                let html = crate::library::remote_gallery::fetch_gallery_html_direct(work_id)?;
                let pages = crate::library::remote_gallery::parse_khentai_gallery(&html)?;
                let page_count = pages.len() as u32;
                let page_urls = pages.iter().map(|page| page.url.clone()).collect();
                crate::library::remote_gallery::write_manifest(
                    &root,
                    &crate::library::remote_gallery::RemoteGalleryManifest::khentai(work_id, pages),
                )?;
                Ok(ResolvedGallery {
                    provider: RemoteProvider::KHentai,
                    work_id: work_id.to_string(),
                    page_count,
                    page_urls,
                })
            }
        }
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_remote_reading_progress(
    provider: String,
    work_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RemoteReadingProgress>, CommandError> {
    crate::library::remote_progress::get_progress(&current_required(state)?, &provider, &work_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn save_remote_reading_progress(
    progress: RemoteReadingProgress,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    crate::library::remote_progress::save_progress(&current_required(state)?, &progress)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn clear_remote_manga_cache(state: State<'_, AppState>) -> Result<(), CommandError> {
    let root = current_required(state)?.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::remote_media::clear_remote_cache(&root)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn inspect_book_import(
    root: String,
    state: State<'_, AppState>,
) -> Result<BookImportPlan, CommandError> {
    let library = current_required(state)?;
    library
        .inspect_book_import(&root)
        .map_err(CommandError::from)
}


#[tauri::command]
pub async fn inspect_legacy_package_migration(
    package_root: String,
    metadata_snapshot: String,
    book_root: String,
    state: State<'_, AppState>,
) -> Result<LegacyPackageMigrationPlan, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let paths = LegacyPackagePaths {
            library_root: library.root().to_path_buf(),
            package_root: package_root.into(),
            metadata_snapshot: metadata_snapshot.into(),
            book_root: book_root.into(),
        };
        legacy_package_migration::inspect_legacy_package_migration(&paths)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn import_book_collections(
    root: String,
    state: State<'_, AppState>,
) -> Result<BookMigrationReport, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.import_book_collections(&root))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn execute_legacy_package_migration(
    package_root: String,
    metadata_snapshot: String,
    book_root: String,
    expected_fingerprint: String,
    state: State<'_, AppState>,
) -> Result<LegacyPackageMigrationReport, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let paths = LegacyPackagePaths {
            library_root: library.root().to_path_buf(),
            package_root: package_root.into(),
            metadata_snapshot: metadata_snapshot.into(),
            book_root: book_root.into(),
        };
        let plan = legacy_package_migration::inspect_legacy_package_migration(&paths)?;
        if plan.source.fingerprint != expected_fingerprint {
            return Err(LibraryError::InvalidLegacyPackage(
                "source changed after the migration preview".into(),
            ));
        }
        library.execute_legacy_package_migration(&plan, |_| {})
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_collection_source_root(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    let library = current_required(state)?;
    library.collection_source_root().map_err(CommandError::from)
}

#[tauri::command]
pub async fn set_collection_source_root(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .set_collection_source_root(path.as_deref())
            .map_err(CommandError::from)?;
        library.backfill_legacy_collection_kinds().map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}

#[tauri::command]
pub fn list_collection_covers(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CollectionCover>, CommandError> {
    let library = current_required(state)?;
    library
        .list_collection_covers(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn list_collection_volumes(
    collection_id: String,
    on_progress: tauri::ipc::Channel<VolumeImportProgress>,
    state: State<'_, AppState>,
) -> Result<Vec<CollectionVolume>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut reporter: Box<dyn FnMut(u32, u32) + Send> = Box::new(move |imported, total| {
            let _ = on_progress.send(VolumeImportProgress { imported, total });
        });
        library.list_collection_volumes_with(
            &collection_id,
            Some(reporter.as_mut() as &mut dyn FnMut(u32, u32)),
        )
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn import_collection_artworks(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.import_local_collection_artworks(&collection_id)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn list_collection_work_artworks(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<WorkArtworkSummary>, CommandError> {
    let library = current_required(state)?;
    library
        .list_collection_work_artworks(&collection_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_mangadex_volume_covers(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<MangaDexVolumeSyncResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.sync_mangadex_volume_covers(&collection_id)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

fn background_task_error() -> CommandError {
    CommandError {
        code: "background_task_failed",
        message: "백그라운드 작업을 완료하지 못했습니다. 다시 시도해 주세요.".into(),
    }
}

fn current(state: State<'_, AppState>) -> Option<Library> {
    state.current_library()
}

fn current_required(state: State<'_, AppState>) -> Result<Library, CommandError> {
    current(state).ok_or_else(|| CommandError {
        code: "library_not_open",
        message: "먼저 라이브러리를 선택해 주세요.".into(),
    })
}

#[cfg(test)]
mod tests {
    use std::{io, path::PathBuf};

    use crate::library::{
        error::LibraryError,
        models::{
            ReleaseWatchEvent, ReleaseWatchEventKind, ReleaseWatchRunResult,
            ReleaseWatchRunStopReason,
        },
    };

    use super::{
        open_library_at, open_library_in_state, run_release_watch_with_key, AppState, CommandError,
    };

    #[test]
    fn command_error_has_stable_json_fields() {
        let error = CommandError::from(LibraryError::ClassificationNotFound);
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(value["code"], "classification_not_found");
        assert_eq!(value["message"], "요청한 분류 항목을 찾을 수 없습니다.");
    }

    #[test]
    fn release_watch_commands_serialize_public_fields_only() {
        let value = serde_json::json!({
            "run": ReleaseWatchRunResult {
                checked: 2,
                changed_collections: 1,
                skipped: 0,
                stop_reason: Some(ReleaseWatchRunStopReason::RateLimited),
            },
            "events": [ReleaseWatchEvent {
                id: "event-1".into(),
                kind: ReleaseWatchEventKind::ReleaseDateChanged,
                volume_number: 12,
                previous_value: Some("2026-08-21".into()),
                current_value: Some("2026-08-23".into()),
                detected_at: "2026-08-22T00:00:00Z".into(),
            }],
        });

        assert_eq!(value["run"]["changedCollections"], 1);
        assert_eq!(value["run"]["stopReason"], "rate_limited");
        assert_eq!(value["events"][0]["kind"], "release_date_changed");
        assert_eq!(value["events"][0]["volumeNumber"], 12);
        let serialized = value.to_string();
        for forbidden in ["ttbKey", "providerUrl", "providerDataJson", "relativePath"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn missing_aladin_credential_returns_a_public_release_watch_stop() {
        let temp = tempfile::tempdir().unwrap();
        let library = crate::library::Library::open(temp.path()).unwrap();

        let result =
            run_release_watch_with_key(&library, Err(LibraryError::AladinCredentialNotConfigured))
                .unwrap();

        assert_eq!(result.checked, 0);
        assert_eq!(result.changed_collections, 0);
        assert_eq!(result.skipped, 0);
        assert_eq!(
            result.stop_reason,
            Some(ReleaseWatchRunStopReason::CredentialNotConfigured)
        );
        assert!(matches!(
            run_release_watch_with_key(&library, Err(LibraryError::CredentialStoreFailed)),
            Err(LibraryError::CredentialStoreFailed)
        ));
    }

    #[test]
    fn invalid_classification_appearance_has_a_stable_public_error() {
        let error = CommandError::from(LibraryError::InvalidClassificationAppearance);

        assert_eq!(error.code, "invalid_classification_appearance");
        assert_eq!(error.message, "지원하지 않는 폴더 아이콘 또는 색상입니다.");
    }

    #[test]
    fn asset_source_metadata_errors_have_stable_codes() {
        assert_eq!(
            CommandError::from(LibraryError::InvalidSourcePublishedAt).code,
            "invalid_source_published_at"
        );
        assert_eq!(
            CommandError::from(LibraryError::InvalidCreatorUrl).code,
            "invalid_creator_url"
        );
    }

    #[test]
    fn mangadex_errors_have_stable_codes() {
        assert_eq!(
            CommandError::from(LibraryError::MangaDexRateLimited).code,
            "mangadex_rate_limited"
        );
        assert_eq!(
            CommandError::from(LibraryError::InvalidWorkArtwork).code,
            "invalid_work_artwork"
        );
        assert_eq!(
            CommandError::from(LibraryError::DuplicateProviderBinding).code,
            "duplicate_provider_binding"
        );
    }

    #[test]
    fn aladin_errors_have_stable_codes() {
        let cases = [
            (
                LibraryError::AladinCredentialNotConfigured,
                "aladin_credential_not_configured",
            ),
            (
                LibraryError::InvalidAladinCredential,
                "invalid_aladin_credential",
            ),
            (LibraryError::InvalidAladinQuery, "invalid_aladin_query"),
            (LibraryError::AladinTimedOut, "aladin_timed_out"),
            (LibraryError::AladinRateLimited, "aladin_rate_limited"),
            (
                LibraryError::InvalidAladinResponse,
                "invalid_aladin_response",
            ),
            (
                LibraryError::AmbiguousAladinBinding,
                "ambiguous_aladin_binding",
            ),
            (
                LibraryError::DuplicateAladinProviderItem,
                "duplicate_aladin_provider_item",
            ),
            (
                LibraryError::CredentialStoreUnavailable,
                "credential_store_unavailable",
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(CommandError::from(error).code, expected);
        }
    }

    #[test]
    fn maps_igdb_errors_without_secret_details() {
        let cases = [
            (LibraryError::IgdbUnauthorized, "igdb_unauthorized"),
            (LibraryError::IgdbRateLimited, "igdb_rate_limited"),
            (LibraryError::IgdbTimedOut, "igdb_timed_out"),
            (LibraryError::IgdbUnavailable, "igdb_unavailable"),
            (LibraryError::IgdbNotFound, "igdb_not_found"),
            (LibraryError::IgdbInvalidImageId, "igdb_invalid_image_id"),
            (LibraryError::IgdbInvalidResponse, "igdb_invalid_response"),
        ];
        for (error, code) in cases {
            let public = CommandError::from(error);
            assert_eq!(public.code, code);
            assert!(!public.message.contains("client-secret"));
            assert!(!public.message.contains("access_token"));
            assert!(!public.message.contains("images.igdb.com"));
        }
    }

    #[test]
    fn maps_tmdb_errors_without_secret_details() {
        let cases = [
            (
                LibraryError::TmdbCredentialNotConfigured,
                "tmdb_credential_not_configured",
            ),
            (
                LibraryError::InvalidTmdbCredentialValue,
                "invalid_tmdb_credential_value",
            ),
            (LibraryError::TmdbUnauthorized, "tmdb_unauthorized"),
            (LibraryError::TmdbRateLimited, "tmdb_rate_limited"),
            (LibraryError::TmdbTimedOut, "tmdb_timed_out"),
            (LibraryError::TmdbUnavailable, "tmdb_unavailable"),
            (LibraryError::TmdbNotFound, "tmdb_not_found"),
            (LibraryError::TmdbInvalidResponse, "tmdb_invalid_response"),
            (
                LibraryError::TmdbInvalidImagePath,
                "tmdb_invalid_image_path",
            ),
            (LibraryError::InvalidTmdbIdentity, "invalid_tmdb_identity"),
        ];
        for (error, code) in cases {
            let public = CommandError::from(error);
            assert_eq!(public.code, code);
            assert!(!public.message.contains("api.themoviedb.org"));
            assert!(!public.message.contains("eyJhbGciOiJIUzI1NiIs"));
        }
    }

    #[test]
    fn library_safety_errors_have_stable_codes() {
        let in_use = serde_json::to_value(CommandError::from(LibraryError::LibraryInUse)).unwrap();
        assert_eq!(
            in_use["message"],
            "다른 Lakomics에서 사용 중인 라이브러리입니다."
        );

        let cases = [
            (LibraryError::LibraryInUse, "library_in_use"),
            (
                LibraryError::LibraryLock {
                    path: PathBuf::from(".lakomics.lock"),
                    source: io::Error::other("lock failed"),
                },
                "library_lock_failed",
            ),
            (
                LibraryError::Backup {
                    path: PathBuf::from("snapshot.sqlite"),
                    source: io::Error::other("backup failed"),
                },
                "backup_failed",
            ),
            (LibraryError::InvalidBackup, "invalid_backup"),
            (
                LibraryError::RestoreFailed {
                    recovery_path: PathBuf::from("library.sqlite.restore-old.sqlite"),
                },
                "restore_failed",
            ),
        ];

        for (error, code) in cases {
            let value = serde_json::to_value(CommandError::from(error)).unwrap();
            assert_eq!(value["code"], code);
        }
    }

    #[test]
    fn unsupported_video_has_a_stable_public_error() {
        let error = CommandError::from(LibraryError::UnsupportedVideo);

        assert_eq!(error.code, "unsupported_video");
        assert_eq!(
            error.message,
            "영상 형식을 지원하지 않거나 파일이 손상됐습니다"
        );
    }

    #[test]
    fn similarity_errors_have_stable_codes_without_internal_details() {
        for (error, code) in [
            (
                LibraryError::InvalidPerceptualHash,
                "invalid_perceptual_hash",
            ),
            (
                LibraryError::SimilarityReviewNotFound,
                "similarity_review_not_found",
            ),
            (
                LibraryError::SimilarityReviewConflict,
                "similarity_review_conflict",
            ),
        ] {
            let error = CommandError::from(error);
            assert_eq!(error.code, code);
            assert!(!error.message.contains("review-1"));
            assert!(!error.message.contains("C:\\library"));
        }
    }

    #[test]
    fn backup_command_errors_do_not_expose_internal_backup_paths() {
        let error = CommandError::from(LibraryError::Backup {
            path: PathBuf::from(r"C:\\library\\backups\\daily-secret.sqlite"),
            source: io::Error::other("backup failed"),
        });

        assert!(!error.message.contains("daily-secret.sqlite"));
        assert!(!error.message.contains("C:\\library"));
    }

    #[test]
    fn drag_command_errors_have_stable_codes_without_internal_paths() {
        let invalid = CommandError::from(LibraryError::InvalidAssetSelection);
        assert_eq!(invalid.code, "invalid_asset_selection");

        let failed = CommandError::from(LibraryError::AssetDragFailed {
            source: io::Error::other(r"C:\library\.drag-out\secret.png"),
        });
        assert_eq!(failed.code, "asset_drag_failed");
        assert!(!failed.message.contains("secret.png"));
        assert!(!failed.message.contains("C:\\library"));
    }

    #[test]
    fn opening_a_missing_library_root_returns_an_error_without_creating_it() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing-library");

        let error = open_library_at(missing.to_string_lossy().into_owned()).unwrap_err();

        assert_eq!(error.code, "library_root_unavailable");
        assert_eq!(error.message, "선택한 라이브러리 폴더를 찾을 수 없습니다.");
        assert!(!missing.exists());
    }

    #[test]
    fn reopening_the_current_library_reuses_its_existing_lease() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        std::fs::create_dir(&root).unwrap();
        let state = AppState::default();

        let first = open_library_in_state(root.to_string_lossy().into_owned(), &state).unwrap();
        let second = open_library_in_state(root.to_string_lossy().into_owned(), &state).unwrap();

        assert_eq!(second, first);
        assert_eq!(second.root, root.to_string_lossy());
    }
}
