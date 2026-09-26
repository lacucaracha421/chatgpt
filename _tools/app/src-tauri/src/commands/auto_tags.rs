//! 자동 태그 commands (`library/auto_tags.rs`). PC-only; nothing is published.

use std::path::PathBuf;

use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::auto_tags::{
    AssetAutoTags, AutoTagEdit, AutoTagImportSummary, AutoTagVocabularyEntry,
};
use crate::library::Library;

async fn run<T: Send + 'static>(
    state: State<'_, AppState>,
    work: impl FnOnce(Library) -> Result<T, crate::library::error::LibraryError> + Send + 'static,
) -> Result<T, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || work(library))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_asset_auto_tags(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<AssetAutoTags, CommandError> {
    run(state, move |library| library.asset_auto_tags(&asset_id)).await
}

#[tauri::command]
pub async fn list_auto_tag_vocabulary(
    state: State<'_, AppState>,
) -> Result<Vec<AutoTagVocabularyEntry>, CommandError> {
    run(state, |library| library.auto_tag_vocabulary()).await
}

#[tauri::command]
pub async fn edit_asset_auto_tag(
    asset_id: String,
    tag: String,
    edit: AutoTagEdit,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    run(state, move |library| {
        library.edit_asset_auto_tag(&asset_id, &tag, edit)
    })
    .await
}

#[tauri::command]
pub async fn get_auto_tag_import_summary(
    state: State<'_, AppState>,
) -> Result<Option<AutoTagImportSummary>, CommandError> {
    run(state, |library| library.auto_tag_import_summary()).await
}

/// `path` is the file the user picked in the native dialog.
#[tauri::command]
pub async fn import_auto_tags(
    path: String,
    state: State<'_, AppState>,
) -> Result<AutoTagImportSummary, CommandError> {
    run(state, move |library| {
        library.import_auto_tags(&PathBuf::from(path))
    })
    .await
}
