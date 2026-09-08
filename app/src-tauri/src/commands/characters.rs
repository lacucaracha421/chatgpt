use tauri::State;

use super::{current_required, AppState, CommandError};
use crate::library::characters::{Decision, DecisionRequest, Error, Target, TargetDraft};

#[tauri::command]
pub async fn record_character_decision_batch(
    requests: Vec<DecisionRequest>,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.record_character_decision_batch(requests))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

fn runtime_paths(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf), CommandError> {
    use tauri::Manager;
    let error = |e: tauri::Error| CommandError {
        code: "character_runtime_failed",
        message: e.to_string(),
    };
    let script = if cfg!(debug_assertions) {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../character-runtime/scan_worker.py")
    } else {
        app.path()
            .resource_dir()
            .map_err(error)?
            .join("character-runtime/scan_worker.py")
    };
    Ok((
        script,
        app.path()
            .app_config_dir()
            .map_err(error)?
            .join("character-runtime.json"),
    ))
}

#[tauri::command]
pub fn character_runtime_status(app: tauri::AppHandle) -> Result<bool, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    Ok(crate::library::character_worker::RuntimeConfig::configured(script, &settings).is_ok())
}

#[tauri::command]
pub async fn setup_character_runtime(app: tauri::AppHandle) -> Result<bool, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, CommandError> {
        let picker = app.dialog().file().set_title("캐릭터 분석용 Python 실행 파일 선택");
        #[cfg(target_os = "windows")]
        let picker = picker.add_filter("Python", &["exe"]);
        let Some(python) = picker.blocking_pick_file()
        else {
            return Ok(false);
        };
        let Some(models) = app
            .dialog()
            .file()
            .set_title("CCIP·detector 모델 폴더 선택")
            .blocking_pick_folder()
        else {
            return Ok(false);
        };
        let error = |e| CommandError {
            code: "character_runtime_failed",
            message: format!("{e}"),
        };
        crate::library::character_worker::RuntimeConfig::setup(
            python.into_path().map_err(error)?,
            models.into_path().map_err(error)?,
            script,
            &settings,
        )?;
        Ok(true)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub fn character_scan_runs(
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::character_scan::ScanStatus>, CommandError> {
    Ok(current_required(state)?.character_scan_runs())
}

#[tauri::command]
pub async fn character_review_page(
    query: crate::library::character_scan::ReviewQuery,
    state: State<'_, AppState>,
) -> Result<crate::library::character_scan::ReviewPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_review_page(query))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

impl From<Error> for CommandError {
    fn from(error: Error) -> Self {
        let code = match &error {
            Error::Stale => "character_stale",
            Error::NotFound => "character_not_found",
            Error::Invalid(_) => "invalid_character_request",
            Error::Worker(_) => "character_runtime_failed",
            Error::Library(_) | Error::Db(_) | Error::Json(_) | Error::Io(_) => {
                "character_storage_failed"
            }
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub async fn start_character_scan(
    target_id: String,
    expected_fingerprint: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_scan::ScanStatus, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.start_character_scan(&target_id, &expected_fingerprint, config)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub fn character_scan_status(
    state: State<'_, AppState>,
) -> Result<Option<crate::library::character_scan::ScanStatus>, CommandError> {
    Ok(current_required(state)?.character_scan_status())
}

#[tauri::command]
pub fn cancel_character_scan(
    scan_id: String,
    state: State<'_, AppState>,
) -> Result<crate::library::character_scan::ScanStatus, CommandError> {
    current_required(state)?
        .cancel_character_scan(&scan_id)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_scan_results(
    scan_id: String,
    after: Option<String>,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::character_scan::ScanResult>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_scan_results(&scan_id, after.as_deref(), limit)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub fn list_character_targets(state: State<'_, AppState>) -> Result<Vec<Target>, CommandError> {
    current_required(state)?
        .list_character_targets()
        .map_err(Into::into)
}

#[tauri::command]
pub fn save_character_target(
    request: TargetDraft,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    current_required(state)?
        .save_character_target(request)
        .map_err(Into::into)
}

#[tauri::command]
pub fn replace_character_references(
    target_id: String,
    expected_revision: i64,
    asset_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    current_required(state)?
        .replace_character_references(&target_id, expected_revision, &asset_ids)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn record_character_decisions(
    request: DecisionRequest,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.record_character_decisions(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub fn list_character_decisions(
    target_id: String,
    before: Option<i64>,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<Decision>, CommandError> {
    current_required(state)?
        .list_character_decisions(&target_id, before, limit)
        .map_err(Into::into)
}

#[tauri::command]
pub fn character_relations_for_asset(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    current_required(state)?
        .character_relations_for_asset(&asset_id)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_series(state: State<'_, AppState>) -> Result<Vec<crate::library::character_hub::Series>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_series()).await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn save_character_series(request: crate::library::character_hub::Series, state: State<'_, AppState>) -> Result<crate::library::character_hub::Series, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.save_character_series(request)).await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn browse_character_assets(query: crate::library::character_hub::BrowseQuery, state: State<'_, AppState>) -> Result<crate::library::character_hub::BrowsePage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.browse_character_assets(query)).await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}
#[tauri::command]
pub async fn apply_automatic_characters(scan_ids: Vec<String>, state: State<'_, AppState>) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.apply_automatic_characters(scan_ids)).await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}
