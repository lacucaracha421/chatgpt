use super::{current_required, AppState, CommandError};
use crate::library::tagger_review::{Preview, TaggerReviewItem};
use tauri::State;

#[tauri::command]
pub async fn tagger_review_items(
    state: State<'_, AppState>,
) -> Result<Vec<TaggerReviewItem>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.tagger_review_items())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn preview_tagger_review(state: State<'_, AppState>) -> Result<Preview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.preview_tagger_review())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn apply_tagger_review(
    expected_preview_token: String,
    state: State<'_, AppState>,
) -> Result<Preview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.apply_tagger_review(&expected_preview_token)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
