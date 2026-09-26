//! 발매 캘린더 and 관심 목록 (game/movie wishlist) commands.

use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::{
    release_calendar::ReleaseCalendar,
    release_wishlist::{WatchItem, WatchRunResult},
};

/// The cached calendar for today's window; never touches the network.
#[tauri::command]
pub async fn get_release_calendar(
    state: State<'_, AppState>,
) -> Result<ReleaseCalendar, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.release_calendar())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

/// Refresh the providers that are due (at most daily); `force` ignores the daily interval but
/// not the one-hour minimum or a failure back-off.
#[tauri::command]
pub async fn refresh_release_calendar(
    force: bool,
    state: State<'_, AppState>,
) -> Result<ReleaseCalendar, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.refresh_release_calendar(force))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn list_release_wishlist(
    state: State<'_, AppState>,
) -> Result<Vec<WatchItem>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.list_release_watch())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

/// `id` is `igdb:<game id>` or `tmdb:<movie id>`.
#[tauri::command]
pub async fn add_release_wishlist_item(
    id: String,
    state: State<'_, AppState>,
) -> Result<WatchItem, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.add_release_watch(&id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn remove_release_wishlist_item(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.remove_release_watch(&id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn set_release_wishlist_muted(
    id: String,
    muted: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.set_release_watch_muted(&id, muted))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn acknowledge_release_wishlist_events(
    event_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.acknowledge_release_watch_events(&event_ids)
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

/// The hourly pass: check the watched titles that are due.
#[tauri::command]
pub async fn run_due_release_wishlist(
    state: State<'_, AppState>,
) -> Result<WatchRunResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.run_due_release_watchlist())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}
