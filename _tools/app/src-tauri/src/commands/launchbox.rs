use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::launchbox::{
    self, Error, Job, SpineBatchRequest, SpineBatchResult, SpineOutcome, SpineProgress,
};
use tauri::{AppHandle, Manager, State};

impl From<Error> for CommandError {
    fn from(error: Error) -> Self {
        if let Error::Library(error) = error {
            return error.into();
        }
        Self {
            code: match error {
                Error::Busy => "launchbox_busy",
                Error::InvalidRequest => "invalid_launchbox_request",
                Error::Cancelled => "launchbox_cancelled",
                _ => "launchbox_failed",
            },
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub async fn fetch_launchbox_spine(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<SpineOutcome, CommandError> {
    let library = current_required(state)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| CommandError {
            code: "launchbox_cache_unavailable",
            message: "앱 캐시 경로를 찾지 못했습니다.".into(),
        })?
        .join("launchbox");
    tauri::async_runtime::spawn_blocking(move || {
        let (mut runner, _lease) = launchbox::reserve(&cache)?;
        runner.fetch_one(
            &library,
            &cache,
            &collection_id,
            &std::sync::atomic::AtomicBool::new(false),
        )
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn fetch_launchbox_spines(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SpineBatchRequest,
    on_progress: tauri::ipc::Channel<SpineProgress>,
) -> Result<SpineBatchResult, CommandError> {
    let (job_id, limit, after, information_only) = match request {
        SpineBatchRequest::Cancel { job_id } => {
            let cancelled = launchbox::cancel_job(&job_id);
            return Ok(SpineBatchResult {
                job_id,
                cancelled,
                outcomes: Vec::new(),
                next_cursor: None,
                has_more: false,
                platforms_filled: 0,
            });
        }
        SpineBatchRequest::Run {
            job_id,
            limit,
            after_collection_id,
            information_only,
        } => (job_id, limit, after_collection_id, information_only),
    };
    if limit == 0
        || limit > launchbox::MAX_BATCH
        || after
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(Error::InvalidRequest.into());
    }
    let library = current_required(state)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| CommandError {
            code: "launchbox_cache_unavailable",
            message: "앱 캐시 경로를 찾지 못했습니다.".into(),
        })?
        .join("launchbox");
    let job = Job::register(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        launchbox::refresh(&cache, &job.cancel)?;
        let (mut runner, _lease) = launchbox::reserve(&cache)?;
        let report = |progress| {
            let _ = on_progress.send(progress);
        };
        if information_only {
            return runner.fill_information(&library, &cache, &job, limit, after, &report);
        }
        runner.fetch_batch(&library, &cache, &job, limit, after, &|progress| {
            let _ = on_progress.send(progress);
        })
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(Into::into)
}
