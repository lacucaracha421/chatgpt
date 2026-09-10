use tauri::State;

use super::{current_required, AppState, CommandError};
use crate::library::characters::{CharacterSettingsDraft, Decision, DecisionRequest, Error, Target, TargetDraft};

#[tauri::command]
pub async fn character_autotag_job(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::library::character_autotag::Job>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_autotag_job(&asset_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

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

pub(super) fn start_incremental_if_configured(
    app: &tauri::AppHandle,
    library: &crate::library::Library,
) {
    if let Ok((script, settings)) = runtime_paths(app) {
        if let Ok(config) =
            crate::library::character_worker::RuntimeConfig::configured(script, &settings)
        {
            library.start_character_incremental(config);
        }
    }
}

#[tauri::command]
pub async fn character_incremental_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_incremental::Status, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        start_incremental_if_configured(&app, &library);
        library.character_incremental_status().map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn pause_character_incremental(
    paused: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.set_character_incremental_paused(paused)?;
        if !paused {
            start_incremental_if_configured(&app, &library);
        }
        Ok(())
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub fn character_runtime_status(app: tauri::AppHandle) -> Result<bool, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    Ok(crate::library::character_worker::RuntimeConfig::configured(script, &settings).is_ok())
}

#[tauri::command]
pub async fn setup_character_runtime(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let library = current_required(state)?;
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, CommandError> {
        let picker = app
            .dialog()
            .file()
            .set_title("캐릭터 분석용 Python 실행 파일 선택");
        #[cfg(target_os = "windows")]
        let picker = picker.add_filter("Python", &["exe"]);
        let Some(python) = picker.blocking_pick_file() else {
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
            script.clone(),
            &settings,
        )?;
        library.start_character_incremental(
            crate::library::character_worker::RuntimeConfig::configured(script, &settings)?,
        );
        Ok(true)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn character_scan_runs(
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::character_scan::ScanStatus>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || Ok(library.character_scan_runs()))
        .await
        .map_err(|_| super::background_task_error())?
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

#[tauri::command]
pub async fn character_review_pending(
    series_id: String,
    target_id: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_review_pending(&series_id, &target_id)
    })
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
    automatic: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_scan::ScanStatus, CommandError> {
    if automatic.unwrap_or(false) {
        return Err(Error::Invalid("자동 분류는 이미지 작업 큐에서 실행됩니다.").into());
    }
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let status = library.start_character_scan_mode(
            &target_id,
            &expected_fingerprint,
            config.clone(),
            false,
        )?;
        library.start_character_incremental(config);
        Ok::<_, Error>(status)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn character_scan_status(
    state: State<'_, AppState>,
) -> Result<Option<crate::library::character_scan::ScanStatus>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || Ok(library.character_scan_status()))
        .await
        .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn cancel_character_scan(
    scan_id: String,
    state: State<'_, AppState>,
) -> Result<crate::library::character_scan::ScanStatus, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.cancel_character_scan(&scan_id).map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
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
pub async fn list_character_targets(
    state: State<'_, AppState>,
) -> Result<Vec<Target>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.list_character_targets().map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn save_character_target(
    request: TargetDraft,
    strict_selection: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
        .save_character_target_selection(request, strict_selection.unwrap_or(false))
        .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn save_character_settings(
    request: CharacterSettingsDraft,
    strict_selection: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .save_character_settings(request, strict_selection.unwrap_or(false))
            .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn replace_character_references(
    target_id: String,
    expected_revision: i64,
    asset_ids: Vec<String>,
    strict_selection: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .replace_character_references_selection(
                &target_id,
                expected_revision,
                &asset_ids,
                strict_selection.unwrap_or(false),
            )
            .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn move_assets_to_character(
    target_id: String,
    expected_fingerprint: String,
    asset_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.move_assets_to_character(target_id, expected_fingerprint, asset_ids)
    })
    .await
    .map_err(|_| super::background_task_error())?
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
pub async fn list_character_decisions(
    target_id: String,
    before: Option<i64>,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<Decision>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
        .list_character_decisions(&target_id, before, limit)
        .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn character_relations_for_asset(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
        .character_relations_for_asset(&asset_id)
        .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn character_series(
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::character_hub::Series>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_series())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn save_character_series(
    request: crate::library::character_hub::Series,
    state: State<'_, AppState>,
) -> Result<crate::library::character_hub::Series, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.save_character_series(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn browse_character_assets(
    query: crate::library::character_hub::BrowseQuery,
    state: State<'_, AppState>,
) -> Result<crate::library::character_hub::BrowsePage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.browse_character_assets(query))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn character_series_suggestions(
    root_id: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<crate::library::character_series_suggestions::SeriesSuggestionPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_series_suggestions(&root_id, limit))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn queue_character_series_discovery(
    root_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let queued = library.queue_character_series_discovery(&root_id)?;
        library.start_character_incremental(config);
        Ok::<_, CommandError>(queued)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn dismiss_character_series_suggestion(
    root_id: String, asset_id: String, series_id: String, state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.dismiss_character_series_suggestion(&root_id, &asset_id, &series_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn accept_character_series_suggestion(
    root_id: String, asset_id: String, series_id: String, app: tauri::AppHandle, state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.accept_character_series_suggestion(&root_id, &asset_id, &series_id)?;
        start_incremental_if_configured(&app, &library);
        Ok::<_, CommandError>(())
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn apply_automatic_characters(
    scan_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let _ = (scan_ids, state);
    Err(Error::Invalid("자동 확정은 이미지 작업 큐에서 실행됩니다.").into())
}

#[tauri::command]
pub async fn register_character_folder(
    request: crate::library::characters::FolderRegistration,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.register_character_folder(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_folder_image_count(
    folder_id: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_folder_image_count(folder_id, recursive)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn character_folder_asset_snapshot(
    folder_id: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<crate::library::characters::FolderAssetSnapshot, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_folder_asset_snapshot(folder_id, recursive)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn character_folder_asset_count(
    folder_id: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_folder_asset_count(folder_id, recursive)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn add_character_learned_references(
    target_id: String,
    expected_revision: i64,
    asset_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.add_character_learned_references(&target_id, expected_revision, &asset_ids)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn exclude_character_reference(
    target_id: String,
    expected_revision: i64,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.exclude_character_reference(&target_id, expected_revision, &asset_id)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn mixed_character_folder_preview(
    folder_id: String,
    state: State<'_, AppState>,
) -> Result<crate::library::character_folder_migration::MixedFolderPreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.mixed_character_folder_preview(&folder_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn queue_mixed_character_folder(
    request: crate::library::character_folder_migration::QueueMixedFolderRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let queued = library.queue_mixed_character_folder(request)?;
        library.start_character_incremental(config);
        Ok::<_, CommandError>(queued)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn finalize_mixed_character_folder(
    request: crate::library::character_folder_migration::FinalizeMixedFolderRequest,
    state: State<'_, AppState>,
) -> Result<crate::library::character_folder_migration::FinalizeMixedFolderResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.finalize_mixed_character_folder(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_groups(
    series_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::character_groups::Group>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_groups(&series_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn save_character_group(
    request: crate::library::character_groups::GroupDraft,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.save_character_group(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_conversion_preview(
    target_id: String,
    state: State<'_, AppState>,
) -> Result<crate::library::character_conversion::ConversionPreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_conversion_preview(&target_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn convert_character_to_folder(
    target_id: String,
    token: String,
    confirmation: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.convert_character_to_folder(&target_id, &token, &confirmation)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn create_manual_character(
    request: crate::library::character_workflow::ManualCharacterRequest,
    state: State<'_, AppState>,
) -> Result<crate::library::characters::Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.create_manual_character(request))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn set_character_series_asset_excluded(
    request: crate::library::character_workflow::SeriesAssetExclusionRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let resume = !request.excluded;
    let library = current_required(state)?;
    let result = tauri::async_runtime::spawn_blocking({
        let library = library.clone();
        move || library.set_character_series_asset_excluded(request)
    })
    .await
    .map_err(|_| super::background_task_error())??;
    if resume { start_incremental_if_configured(&app, &library); }
    Ok(result)
}

#[tauri::command]
pub async fn character_series_excluded_assets(
    series_id: String,
    after: Option<String>,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<crate::library::character_hub::BrowsePage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_series_excluded_assets(&series_id, after.as_deref(), limit))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn retry_failed_character_assets(
    series_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let count = library.retry_failed_character_assets(series_id)?;
        start_incremental_if_configured(&app, &library);
        Ok::<_, CommandError>(count)
    })
    .await
    .map_err(|_| super::background_task_error())?
}
