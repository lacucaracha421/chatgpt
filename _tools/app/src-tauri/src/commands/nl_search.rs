use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::{
    nl_search::{self, SearchResult},
    nl_search_worker::{Config, Manager, WorkerStatus},
    Library,
};
use serde::Serialize;
use tauri::{AppHandle, Manager as _, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    indexed: u64,
    qwen_indexed: u64,
    precise: bool,
    #[serde(flatten)]
    worker: WorkerStatus,
}
fn error(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "description_search_failed",
        message: message.into(),
    }
}
fn config(app: &AppHandle) -> Result<Config, String> {
    let runtime = if cfg!(debug_assertions) {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../nl-search-runtime")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("nl-search-runtime")
    };
    Config::load(
        &app.path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("nl-search-runtime.json"),
        runtime,
    )
}
fn availability(
    library: &Library,
    config: &Result<Config, String>,
    worker: WorkerStatus,
) -> Result<Status, CommandError> {
    let counts = library.nl_search_counts();
    let (indexed, qwen_indexed) = counts.as_ref().copied().unwrap_or((0, 0));
    // The active profile is fixed for the process, as in all other performance budgets.
    let main = crate::performance::budgets() == crate::performance::Profile::Main.budgets();
    let reason = nl_search::unavailable(main, config.is_ok(), indexed)
        .map(str::to_owned)
        .or_else(|| {
            counts
                .err()
                .map(|e| format!("검색 색인을 읽지 못했습니다: {e}"))
        });
    let precise = config.as_ref().is_ok_and(|config| config.precise)
        && qwen_indexed > 0
        && (worker.worker != "ready" || worker.qwen);
    Ok(Status {
        available: reason.is_none(),
        reason,
        indexed,
        qwen_indexed,
        precise,
        worker,
    })
}
fn available_config(
    library: &Library,
    config: Result<Config, String>,
    worker: WorkerStatus,
) -> Result<Config, CommandError> {
    let status = availability(library, &config, worker)?;
    if let Some(reason) = status.reason {
        return Err(error(reason));
    }
    let mut config = config.map_err(error)?;
    config.precise &= status.qwen_indexed > 0;
    Ok(config)
}

#[tauri::command]
pub(crate) async fn description_search_status(
    app: AppHandle,
    state: State<'_, AppState>,
    worker: State<'_, Manager>,
) -> Result<Status, CommandError> {
    let library = current_required(state)?;
    let config = config(&app);
    let worker = worker.status();
    tauri::async_runtime::spawn_blocking(move || availability(&library, &config, worker))
        .await
        .map_err(|_| background_task_error())?
}
#[tauri::command]
pub(crate) fn prewarm_description_search(
    app: AppHandle,
    state: State<'_, AppState>,
    worker: State<'_, Manager>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    let worker = worker.inner().clone();
    // Config/cache I/O and model startup both happen after returning to the caller.
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(config) = available_config(&library, config(&app), worker.status()) {
            worker.prewarm(config);
        }
    });
    Ok(())
}
#[tauri::command]
pub(crate) async fn search_by_description(
    query: String,
    limit: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
    worker: State<'_, Manager>,
) -> Result<SearchResult, CommandError> {
    let library = current_required(state)?;
    let worker = worker.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = available_config(&library, config(&app), worker.status())?;
        library
            .search_description(&query, limit, config.precise, || {
                worker.embed(&config, &query)
            })
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| background_task_error())?
}
