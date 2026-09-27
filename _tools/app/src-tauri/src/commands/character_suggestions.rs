use super::{current_required, AppState, CommandError};
use crate::library::character_suggestions::{
    IgnoredTag, MergeSuggestion, RegisterSuggestion, Suggestion, SuggestionDetail, SuggestionResult,
};
use tauri::State;

#[tauri::command]
pub async fn character_suggestions(
    minimum: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<Suggestion>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_suggestions(minimum))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_suggestion_detail(
    tag: String,
    series_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SuggestionDetail, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_suggestion_detail(&tag, series_id.as_deref())
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn ignored_character_suggestions(
    state: State<'_, AppState>,
) -> Result<Vec<IgnoredTag>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.ignored_character_suggestions())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn set_character_suggestion_ignored(
    tag: String,
    ignored: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.set_character_suggestion_ignored(&tag, ignored)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn register_character_suggestion(
    request: RegisterSuggestion,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SuggestionResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = library.register_character_suggestion(request)?;
        if result.target.ready && !result.target.manual_only {
            super::characters::start_incremental_if_configured(&app, &library);
        }
        Ok::<_, crate::library::characters::Error>(result)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn merge_character_suggestion(
    request: MergeSuggestion,
    state: State<'_, AppState>,
) -> Result<SuggestionResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.merge_character_suggestion(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
