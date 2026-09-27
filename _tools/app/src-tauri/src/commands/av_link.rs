use super::{current_required, AppState, CommandError};
use crate::library::av_link::models::*;
use tauri::State;

#[tauri::command]
pub async fn list_av_link_inbox(
    state: State<'_, AppState>,
) -> Result<Vec<InboxItem>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.list_av_link_inbox())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn av_link_pending_count(state: State<'_, AppState>) -> Result<i64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.av_link_pending_count())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn get_av_link_candidate(
    inbox_id: String,
    collection_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Candidate, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.get_av_link_candidate(&inbox_id, collection_id.as_deref())
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn retry_av_link(
    inbox_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.retry_av_link(&inbox_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn fix_av_link_code(
    inbox_id: String,
    code: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.fix_av_link_code(&inbox_id, &code))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn dismiss_av_link(
    inbox_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.dismiss_av_link(&inbox_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn apply_av_link(
    inbox_id: String,
    request: ApplyRequest,
    state: State<'_, AppState>,
) -> Result<ApplyResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_av_link(&inbox_id, request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
