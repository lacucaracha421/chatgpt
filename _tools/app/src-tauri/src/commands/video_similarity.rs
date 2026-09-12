use super::{current_required, AppState, CommandError};
use crate::library::video_similarity::{
    Error, VideoDecisionRequest, VideoReviewPage, VideoScanProgress, VideoScanRequest,
};
use tauri::State;

impl From<Error> for CommandError {
    fn from(error: Error) -> Self {
        let code = match &error {
            Error::InvalidSelection => "video_similarity_invalid_selection",
            Error::Busy => "video_similarity_busy",
            Error::NotFound => "video_similarity_not_found",
            Error::Stale => "video_similarity_stale",
            Error::Conflict => "video_similarity_conflict",
            _ => "video_similarity_failed",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub async fn start_video_similarity_scan(
    request: VideoScanRequest,
    state: State<'_, AppState>,
) -> Result<VideoScanProgress, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.start_video_similarity_scan(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub fn get_video_similarity_scan(
    scan_id: String,
    state: State<'_, AppState>,
) -> Result<VideoScanProgress, CommandError> {
    current_required(state)?
        .get_video_similarity_scan(&scan_id)
        .map_err(Into::into)
}
#[tauri::command]
pub fn latest_video_similarity_scan(
    state: State<'_, AppState>,
) -> Result<Option<VideoScanProgress>, CommandError> {
    current_required(state)?
        .latest_video_similarity_scan()
        .map_err(Into::into)
}
#[tauri::command]
pub fn cancel_video_similarity_scan(
    scan_id: String,
    state: State<'_, AppState>,
) -> Result<VideoScanProgress, CommandError> {
    current_required(state)?
        .cancel_video_similarity_scan(&scan_id)
        .map_err(Into::into)
}
#[tauri::command]
pub fn resume_video_similarity_scan(
    scan_id: String,
    state: State<'_, AppState>,
) -> Result<VideoScanProgress, CommandError> {
    current_required(state)?
        .resume_video_similarity_scan(&scan_id)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn list_video_similarity_reviews(
    after: Option<String>,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<VideoReviewPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.list_video_similarity_reviews(after, limit)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn decide_video_similarity_review(
    request: VideoDecisionRequest,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.decide_video_similarity_review(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
