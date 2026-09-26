//! 작가 hub commands (ARTIST-001). PC-authoritative; asset creator fields are never written.

use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::artists::{
    ArtistCaptionLabels, ArtistDetail, ArtistListPage, ArtistListQuery, ArtistMergeSuggestion,
    ArtistOverview, ArtistSettings, ArtistTodayRow, SourceFillPreview, SourceFillResult,
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
pub async fn get_artist_overview(
    state: State<'_, AppState>,
) -> Result<ArtistOverview, CommandError> {
    run(state, |library| library.artist_overview()).await
}

#[tauri::command]
pub async fn list_artists(
    query: ArtistListQuery,
    state: State<'_, AppState>,
) -> Result<ArtistListPage, CommandError> {
    run(state, move |library| library.list_artists(&query)).await
}

/// `local_date` is the viewer's `YYYY-MM-DD`; `offset_minutes` its UTC offset (N년 전 오늘).
#[tauri::command]
pub async fn get_artist(
    artist_id: String,
    local_date: String,
    offset_minutes: i32,
    state: State<'_, AppState>,
) -> Result<ArtistDetail, CommandError> {
    run(state, move |library| {
        library.artist_detail(&artist_id, &local_date, offset_minutes)
    })
    .await
}

#[tauri::command]
pub async fn get_artist_today(
    local_date: String,
    offset_minutes: i32,
    seed: u32,
    excluded: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ArtistTodayRow>, CommandError> {
    run(state, move |library| {
        library.artist_today(&local_date, offset_minutes, seed, &excluded)
    })
    .await
}

#[tauri::command]
pub async fn list_artist_merge_suggestions(
    state: State<'_, AppState>,
) -> Result<Vec<ArtistMergeSuggestion>, CommandError> {
    run(state, |library| library.artist_merge_suggestions()).await
}

#[tauri::command]
pub async fn preview_artist_source_fill(
    state: State<'_, AppState>,
) -> Result<SourceFillPreview, CommandError> {
    run(state, |library| library.artist_source_fill_preview()).await
}

#[tauri::command]
pub async fn apply_artist_source_fill(
    state: State<'_, AppState>,
) -> Result<SourceFillResult, CommandError> {
    run(state, |library| library.apply_artist_source_fill()).await
}

#[tauri::command]
pub async fn get_artist_caption_labels(
    state: State<'_, AppState>,
) -> Result<ArtistCaptionLabels, CommandError> {
    run(state, |library| library.artist_caption_labels()).await
}

/// Returns the artist id to show next (an implicit artist may gain or lose its row).
#[tauri::command]
pub async fn set_artist_display_name(
    artist_id: String,
    display_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    run(state, move |library| {
        library.set_artist_display_name(&artist_id, display_name.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn set_artist_flags(
    artist_id: String,
    pinned: Option<bool>,
    hidden: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    run(state, move |library| {
        library.set_artist_flags(&artist_id, pinned, hidden)
    })
    .await
}

#[tauri::command]
pub async fn merge_artists(
    target_id: String,
    source_ids: Vec<String>,
    display_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    run(state, move |library| {
        library.merge_artists(&target_id, &source_ids, display_name.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn detach_artist_member(
    artist_id: String,
    creator_key: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    run(state, move |library| {
        library.detach_artist_member(&artist_id, &creator_key)
    })
    .await
}

/// `source` is `manual` (직접 지정) or `source_url` (출처에서 채움).
#[tauri::command]
pub async fn detach_artist_assignments(
    artist_id: String,
    source: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    run(state, move |library| {
        library.detach_artist_assignments(&artist_id, &source)
    })
    .await
}

#[tauri::command]
pub async fn dismiss_artist_merge_suggestion(
    key_a: String,
    key_b: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    run(state, move |library| {
        library.dismiss_artist_merge(&key_a, &key_b)
    })
    .await
}

/// 작가 지정: `artist_id` for an existing artist, or `new_name` to create one.
#[tauri::command]
pub async fn assign_assets_to_artist(
    asset_ids: Vec<String>,
    artist_id: Option<String>,
    new_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    run(state, move |library| {
        library.assign_assets_to_artist(&asset_ids, artist_id.as_deref(), new_name.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn set_artist_settings(
    settings: ArtistSettings,
    state: State<'_, AppState>,
) -> Result<ArtistSettings, CommandError> {
    run(state, move |library| library.set_artist_settings(settings)).await
}
