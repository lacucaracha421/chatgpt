//! 발매 캘린더 and 관심 목록 (game/movie/anime wishlist) commands.

use tauri::{Emitter, State};

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::{
    release_calendar::ReleaseCalendar,
    release_wishlist::{WatchItem, WatchRunResult},
};

#[tauri::command]
pub async fn server_release_wishlist_owned(
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let library = current_required(state)?;
    library
        .server_release_wishlist_blocked()
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn server_release_calendar_enabled(
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let library = current_required(state)?;
    Ok(library.server_release_calendar_enabled())
}

#[tauri::command]
pub async fn get_server_release_calendar_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.server_release_calendar_status())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn request_server_release_calendar(
    state: State<'_, AppState>,
) -> Result<crate::library::server_release_calendar::ServerCalendarRun, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.request_server_release_calendar())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

/// The local cache or server publication for today's window; no provider requests.
#[tauri::command]
pub async fn get_release_calendar(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ReleaseCalendar, CommandError> {
    let library = current_required(state)?;
    let refresh = library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if refresh
            .refresh_server_calendar_cache(false)
            .unwrap_or(false)
        {
            let _ = app.emit("library://release-calendar-changed", ());
        }
    });
    tauri::async_runtime::spawn_blocking(move || library.release_calendar())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn refresh_server_calendar_cache(
    state: State<'_, AppState>,
) -> Result<ReleaseCalendar, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.refresh_server_calendar_cache(true)?;
        library.release_calendar()
    })
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

/// Settings' 지금 새로 받기: refetch every provider now, with no interval or back-off.
#[tauri::command]
pub async fn refresh_release_calendar_now(
    state: State<'_, AppState>,
) -> Result<ReleaseCalendar, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.refresh_release_calendar_now())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn list_release_wishlist(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<WatchItem>, CommandError> {
    let library = current_required(state)?;
    let refresh = library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let before = refresh
            .list_release_watch()
            .ok()
            .and_then(|items| serde_json::to_vec(&items).ok());
        if let Err(error) = refresh.refresh_release_wishlist() {
            let _ = app.emit(
                "library://release-wishlist-error",
                &CommandError::from(error),
            );
        }
        let after = refresh
            .list_release_watch()
            .ok()
            .and_then(|items| serde_json::to_vec(&items).ok());
        if before != after {
            let _ = app.emit("library://release-calendar-changed", ());
        }
    });
    tauri::async_runtime::spawn_blocking(move || library.list_release_watch())
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

/// `id` is `igdb:<game id>`, `tmdb:<movie id>` or `tmdb:tv:<show id>:s<season>`.
#[tauri::command]
pub async fn add_release_wishlist_item(
    id: String,
    state: State<'_, AppState>,
) -> Result<WatchItem, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let item = library.add_release_watch(&id)?;
        if library.server_release_wishlist_blocked()? {
            library.flush_release_wishlist_edits()?;
        }
        Ok::<_, crate::library::error::LibraryError>(item)
    })
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
    tauri::async_runtime::spawn_blocking(move || {
        library.remove_release_watch(&id)?;
        if library.server_release_wishlist_blocked()? {
            library.flush_release_wishlist_edits()?;
        }
        Ok::<_, crate::library::error::LibraryError>(())
    })
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
    tauri::async_runtime::spawn_blocking(move || {
        library.set_release_watch_muted(&id, muted)?;
        if library.server_release_wishlist_blocked()? {
            library.flush_release_wishlist_edits()?;
        }
        Ok::<_, crate::library::error::LibraryError>(())
    })
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
        library.acknowledge_release_watch_events(&event_ids)?;
        if library.server_release_wishlist_blocked()? {
            library.flush_release_wishlist_edits()?;
        }
        Ok::<_, crate::library::error::LibraryError>(())
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
