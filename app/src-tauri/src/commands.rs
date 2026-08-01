use std::sync::RwLock;

use serde::Serialize;
use tauri::State;

use crate::library::{
    error::LibraryError,
    models::{
        AssetPage, AssetQuery, ClassificationEntry, CreateClassification, IngestImageRequest,
        IngestOutcome, LibrarySummary,
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
        let code = match error {
            LibraryError::LibraryInUse => "library_in_use",
            LibraryError::LibraryLock { .. } => "library_lock_failed",
            LibraryError::Backup { .. } => "backup_failed",
            LibraryError::InvalidBackup => "invalid_backup",
            LibraryError::CreateDirectory { .. } => "create_directory_failed",
            LibraryError::Database(_) => "database_failed",
            LibraryError::UnsupportedSchema(_) => "unsupported_schema",
            LibraryError::EmptyClassificationName => "empty_classification_name",
            LibraryError::ClassificationNotFound => "classification_not_found",
            LibraryError::DuplicateClassificationName => "duplicate_classification_name",
            LibraryError::InvalidClassificationParent => "invalid_classification_parent",
            LibraryError::ClassificationCycle => "classification_cycle",
            LibraryError::ClassificationNotEmpty => "classification_not_empty",
            LibraryError::AssetNotFound => "asset_not_found",
            LibraryError::InvalidAssetPageLimit => "invalid_asset_page_limit",
            LibraryError::InvalidAssetCursor => "invalid_asset_cursor",
            LibraryError::MediaNotFound => "media_not_found",
            LibraryError::UnsafeMediaPath => "unsafe_media_path",
            LibraryError::ReadMedia { .. } => "read_media_failed",
            LibraryError::ReadSource { .. } => "read_source_failed",
            LibraryError::UnsupportedImage => "unsupported_image",
            LibraryError::WriteAsset { .. } => "write_asset_failed",
        };
        Self {
            code,
            message: error.to_string(),
        }
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
    let library = open_library_at(path)?;
    let summary = library.summary().map_err(CommandError::from)?;
    *state
        .library
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(library);
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
pub async fn ingest_image(
    request: IngestImageRequest,
    state: State<'_, AppState>,
) -> Result<IngestOutcome, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.ingest_image(request))
        .await
        .map_err(|error| CommandError {
            code: "ingest_failed",
            message: error.to_string(),
        })?
        .map_err(CommandError::from)
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

    use super::{open_library_at, CommandError};

    #[test]
    fn command_error_has_stable_json_fields() {
        let error = CommandError::from(LibraryError::ClassificationNotFound);
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(value["code"], "classification_not_found");
        assert_eq!(value["message"], "요청한 분류 항목을 찾을 수 없습니다.");
    }

    #[test]
    fn library_safety_errors_have_stable_codes() {
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
        ];

        for (error, code) in cases {
            let value = serde_json::to_value(CommandError::from(error)).unwrap();
            assert_eq!(value["code"], code);
        }
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
}
