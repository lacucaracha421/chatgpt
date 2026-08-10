use std::sync::RwLock;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::library::{
    error::LibraryError,
    models::{
        AssetClassificationPatch, AssetCursor, AssetPage, AssetQuery, AssetSummary,
        ClassificationEntry, CreateClassification, IngestMediaRequest, IngestOutcome,
        LibrarySummary, MetadataBackup, PurgeSummary, SimilarityDecisionOutcome,
        SimilarityDecisionRequest, SimilarityIndexProgress, SimilarityReviewPage, TrashPage,
        TrashPolicy, VideoPreparationProgress, VideoPreparationState,
    },
    Library,
};

#[derive(Default)]
pub struct AppState {
    library: RwLock<Option<Library>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<LibraryError> for CommandError {
    fn from(error: LibraryError) -> Self {
        let message = match &error {
            LibraryError::Backup { .. } => "SQLite 백업 작업에 실패했습니다.".into(),
            LibraryError::WriteAsset { .. } => {
                "이미지 파일을 정리하지 못했습니다. 다시 시도해 주세요.".into()
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
            LibraryError::UnsupportedSchema(_) => "unsupported_schema",
            LibraryError::InvalidTrashRetention => "invalid_trash_retention",
            LibraryError::UnsupportedManagedFileDeletion => "unsupported_managed_file_deletion",
            LibraryError::EmptyClassificationName => "empty_classification_name",
            LibraryError::ClassificationNotFound => "classification_not_found",
            LibraryError::DuplicateClassificationName => "duplicate_classification_name",
            LibraryError::InvalidClassificationParent => "invalid_classification_parent",
            LibraryError::ClassificationCycle => "classification_cycle",
            LibraryError::ClassificationNotEmpty => "classification_not_empty",
            LibraryError::AssetNotFound => "asset_not_found",
            LibraryError::EmptyAssetSelection => "empty_asset_selection",
            LibraryError::InvalidAssetSelection => "invalid_asset_selection",
            LibraryError::AssetDragFailed { .. } => "asset_drag_failed",
            LibraryError::InvalidAssetPageLimit => "invalid_asset_page_limit",
            LibraryError::InvalidAssetCursor => "invalid_asset_cursor",
            LibraryError::InvalidPerceptualHash => "invalid_perceptual_hash",
            LibraryError::SimilarityReviewNotFound => "similarity_review_not_found",
            LibraryError::SimilarityReviewConflict => "similarity_review_conflict",
            LibraryError::InvalidTrashTimestamp => "invalid_trash_timestamp",
            LibraryError::MediaNotFound => "media_not_found",
            LibraryError::UnsafeMediaPath => "unsafe_media_path",
            LibraryError::ReadMedia { .. } => "read_media_failed",
            LibraryError::ReadSource { .. } => "read_source_failed",
            LibraryError::UnsupportedImage => "unsupported_image",
            LibraryError::UnsupportedVideo => "unsupported_video",
            LibraryError::VideoPreparationFailed => "video_preparation_failed",
            LibraryError::VideoToolUnavailable => "video_tool_unavailable",
            LibraryError::WriteAsset { .. } => "write_asset_failed",
            LibraryError::MangaRootNotSet => "manga_root_not_set",
            LibraryError::MangaSeriesNotFound => "manga_series_not_found",
            LibraryError::InvalidMangaFolder { .. } => "invalid_manga_folder",
            LibraryError::MangaThumbnail { .. } => "manga_thumbnail_failed",
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
pub fn open_library(
    path: String,
    state: State<'_, AppState>,
) -> Result<LibrarySummary, CommandError> {
    open_library_in_state(path, &state)
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
pub fn current_library(state: State<'_, AppState>) -> Result<Option<LibrarySummary>, CommandError> {
    current(state)
        .map(|library| library.summary().map_err(CommandError::from))
        .transpose()
}

#[tauri::command]
pub fn ensure_daily_backup(
    state: State<'_, AppState>,
) -> Result<Option<MetadataBackup>, CommandError> {
    current_required(state)?
        .ensure_daily_backup(chrono::Utc::now())
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
pub fn restore_metadata_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .restore_backup(&backup_id)
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
) -> Result<SimilarityDecisionOutcome, CommandError> {
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
pub fn trash_asset(asset_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    current_required(state)?
        .trash_asset(&asset_id)
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
pub fn empty_trash(state: State<'_, AppState>) -> Result<PurgeSummary, CommandError> {
    current_required(state)?
        .empty_trash()
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
pub fn purge_expired_trash(state: State<'_, AppState>) -> Result<PurgeSummary, CommandError> {
    current_required(state)?
        .purge_expired_trash(chrono::Utc::now())
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
pub fn set_asset_classifications(
    asset_id: String,
    classification_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_asset_classifications(&asset_id, &classification_ids)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn patch_asset_classifications(
    patch: AssetClassificationPatch,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .patch_asset_classifications(patch)
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
) -> Result<VideoPreparationState, CommandError> {
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
    let result = drag::start_drag(
        &window,
        drag::DragItem::Files(files),
        drag::Image::File(preview),
        move |_result, _cursor| {
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

    use crate::library::error::LibraryError;

    use super::{open_library_at, open_library_in_state, AppState, CommandError};

    #[test]
    fn command_error_has_stable_json_fields() {
        let error = CommandError::from(LibraryError::ClassificationNotFound);
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(value["code"], "classification_not_found");
        assert_eq!(value["message"], "요청한 분류 항목을 찾을 수 없습니다.");
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
