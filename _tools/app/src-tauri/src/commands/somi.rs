use crate::somi::{FilledCover, OpenedPost, SearchPage, SomiState, Status};
use tauri::{AppHandle, State};
#[tauri::command]
pub(crate) fn somi_sync_now(app: AppHandle, state: State<'_, SomiState>) -> Result<(), String> {
    state.sync_now(&app)
}
#[tauri::command]
pub(crate) async fn somi_status(
    app: AppHandle,
    state: State<'_, SomiState>,
    collect: bool,
) -> Result<Status, String> {
    state.status(&app, collect).await
}
#[tauri::command]
pub(crate) async fn somi_open_login(
    app: AppHandle,
    state: State<'_, SomiState>,
) -> Result<(), String> {
    state.login(&app).await
}
#[tauri::command]
pub(crate) async fn somi_logout(app: AppHandle, state: State<'_, SomiState>) -> Result<(), String> {
    state.logout(&app).await
}
#[tauri::command]
pub(crate) async fn somi_search(
    app: AppHandle,
    state: State<'_, SomiState>,
    query: String,
    sort: String,
    page: u32,
    days: Option<u32>,
    bookmarked: Option<bool>,
) -> Result<SearchPage, String> {
    state
        .search(&app, &query, &sort, page, days, bookmarked.unwrap_or(false))
        .await
}
#[tauri::command]
pub(crate) fn somi_toggle_bookmark(
    app: AppHandle,
    state: State<'_, SomiState>,
    id: String,
) -> Result<bool, String> {
    state.toggle_bookmark(&app, &id)
}
#[tauri::command]
pub(crate) async fn somi_sync_state(
    app: AppHandle,
    state: State<'_, SomiState>,
    flush: Option<bool>,
) -> Result<(), String> {
    if flush.unwrap_or(false) {
        state.flush_state(&app);
    } else if let Some(task) = state.sync_state(&app, false) {
        let _ = task.await;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn somi_fill_covers(
    app: AppHandle,
    state: State<'_, SomiState>,
    ids: Vec<String>,
) -> Result<Vec<FilledCover>, String> {
    state.fill_covers(&app, ids).await
}
#[tauri::command]
pub(crate) async fn somi_open_post(
    app: AppHandle,
    state: State<'_, SomiState>,
    id: String,
) -> Result<OpenedPost, String> {
    state.open_post(&app, &id).await
}
#[tauri::command]
pub(crate) fn somi_save_page(
    app: AppHandle,
    state: State<'_, SomiState>,
    id: String,
    page: u32,
) -> Result<(), String> {
    state.save_page(&app, &id, page)
}
