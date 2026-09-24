use tauri::State;

use super::{current_required, AppState, CommandError};
use crate::library::character_reference_regions::{ReferenceInspection, RegionBindings};
use crate::library::characters::{
    CharacterSettingsDraft, Decision, DecisionRequest, Error, Target, TargetDraft,
};

#[tauri::command]
pub async fn character_series_move_preview(
    target_id: String,
    destination_id: String,
    state: State<'_, AppState>,
) -> Result<crate::library::character_series_move::SeriesMovePreview, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.character_series_move_preview(&target_id, &destination_id)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn move_character_to_series(
    target_id: String,
    destination_id: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    // Deliberately do not start the worker or request a reference refresh here.
    tauri::async_runtime::spawn_blocking(move || {
        library.move_character_to_series(&target_id, &destination_id, &token)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

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
pub async fn pause_character_automation(
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
pub async fn pause_character_reference_refresh(
    paused: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.set_character_reference_refresh_paused(paused)?;
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
pub async fn character_augmentation_settings(
    app: tauri::AppHandle,
) -> Result<crate::library::character_worker::AugmentationSettings, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::character_worker::RuntimeConfig::augmentation_settings(script, &settings)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn set_character_augmentation_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_worker::AugmentationSettings, CommandError> {
    let library = current_required(state)?;
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::library::character_worker::RuntimeConfig::update_augmentation(
            script, &settings, enabled,
        )?;
        start_incremental_if_configured(&app, &library);
        Ok(result)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn set_character_shadow_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_worker::AugmentationSettings, CommandError> {
    let library = current_required(state)?;
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::library::character_worker::RuntimeConfig::update_shadow(
            script, &settings, enabled,
        )?;
        start_incremental_if_configured(&app, &library);
        Ok(result)
    })
    .await
    .map_err(|_| super::background_task_error())?
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

#[tauri::command]
pub async fn character_review_pending_map(
    state: State<'_, AppState>,
) -> Result<std::collections::BTreeMap<String, bool>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_review_pending_map())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_shadow_backfill_start(
    state: State<'_, AppState>,
) -> Result<crate::library::character_shadow_backfill::Status, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_shadow_backfill_start())
        .await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}

#[tauri::command]
pub fn character_shadow_backfill_status(
    state: State<'_, AppState>,
) -> Result<crate::library::character_shadow_backfill::Status, CommandError> {
    Ok(current_required(state)?.character_shadow_backfill_status())
}

#[tauri::command]
pub fn character_shadow_backfill_cancel(
    state: State<'_, AppState>,
) -> Result<crate::library::character_shadow_backfill::Status, CommandError> {
    Ok(current_required(state)?.character_shadow_backfill_cancel())
}

/// Read-only feed for the S36 review screen; judgments use `record_character_decisions`.
#[tauri::command]
pub async fn character_shadow_review_page(
    query: crate::library::character_shadow_review::ShadowReviewQuery,
    state: State<'_, AppState>,
) -> Result<crate::library::character_shadow_review::ShadowReviewPage, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_shadow_review_page(query))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

/// Cheap counter of inbound mobile character decisions applied on this PC; the S36 review
/// screen reloads when it changes.
#[tauri::command]
pub async fn character_review_inbound_status(
    state: State<'_, AppState>,
) -> Result<crate::library::character_review_sync::ReviewInboundStatus, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_review_inbound_status())
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_s36_publication(
    app: tauri::AppHandle,
) -> Result<crate::library::character_worker::S36PublicationSettings, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::character_worker::RuntimeConfig::s36_publication(script, &settings)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn set_character_s36_publication(
    series: Vec<String>,
    excluded_targets: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_worker::S36PublicationSettings, CommandError> {
    let library = current_required(state)?;
    let (script, settings) = runtime_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::library::character_worker::RuntimeConfig::update_s36_publication(
            script,
            &settings,
            series.into_iter().collect(),
            excluded_targets.into_iter().collect(),
        )?;
        // The running queue picks up the new series choice with its configuration.
        start_incremental_if_configured(&app, &library);
        Ok(result)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

#[tauri::command]
pub async fn clear_character_s36_automatic(
    series_id: String,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.clear_s36_automatic(&series_id))
        .await
        .map_err(|_| super::background_task_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn character_s36_readiness(
    series_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::library::character_shadow_review::S36Readiness>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_s36_readiness(&series_id))
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
            Error::InboundTargetNotFound => "character_inbound_exclusion_target_missing",
            Error::InboundAssetChanged => "character_inbound_exclusion_asset_changed",
            Error::InboundProtectedReference => "character_inbound_exclusion_protected_reference",
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Only an explicit region choice needs the detector. An empty map keeps the
        // existing offline path and never clears the stored manual selections.
        if !request.reference_regions.is_empty() {
            crate::library::character_reference_regions::validate_region_ids(
                &request.reference_ids,
                &request.reference_regions,
            )?;
            let (script, settings) = runtime_paths(&app)?;
            let config =
                crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
            let series = match (
                request.target.series_classification_id.clone(),
                request.target.id.as_deref(),
            ) {
                (Some(series), _) => Some(series),
                (None, Some(id)) => library.get_character_target(id)?.series_classification_id,
                (None, None) => None,
            };
            library.verify_reference_region_selections(
                series.as_deref().ok_or(Error::Stale)?,
                &request.reference_regions,
                &config,
            )?;
        }
        library
            .save_character_settings(request, strict_selection.unwrap_or(false))
            .map_err(Into::into)
    })
    .await
    .map_err(|_| super::background_task_error())?
}

/// Read-only identity inspection for one to twenty-five images. Draft `regions` override the
/// target's stored choices for the requested images only; nothing is persisted here.
#[tauri::command]
pub async fn inspect_character_reference_regions(
    series_id: String,
    target_id: Option<String>,
    asset_ids: Vec<String>,
    regions: Option<RegionBindings>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ReferenceInspection>, CommandError> {
    // Reject an empty or oversized request before the runtime is even required.
    crate::library::character_reference_regions::validate_inspection_ids(&asset_ids)
        .map_err(CommandError::from)?;
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library
            .inspect_character_reference_regions_with_overrides(
                &series_id,
                target_id.as_deref(),
                &asset_ids,
                regions.as_ref(),
                &config,
            )
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
) -> Result<crate::library::characters::FolderRegistrationResult, CommandError> {
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
pub async fn reference_candidates(
    target_id: String,
    limit: usize,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_reference_candidates::ReferenceCandidateSet, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        library.semantic_reference_candidates(&target_id, limit, &config)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn confirm_reference_batch(
    request: crate::library::character_reference_candidates::ConfirmReferenceBatch,
    regions: crate::library::character_reference_regions::RegionBindings,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Target, CommandError> {
    let (script, settings) = runtime_paths(&app)?;
    let config = crate::library::character_worker::RuntimeConfig::configured(script, &settings)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target = library.get_character_target(&request.target_id)?;
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Stale)?;
        library.verify_reference_region_selections(series, &regions, &config)?;
        library.confirm_reference_batch_with_regions(request, regions)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn request_character_reference_refresh(
    target_id: String,
    expected_revision: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::character_reference_refresh::ReferenceRefreshReceipt, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let receipt = library.request_character_reference_refresh(&target_id, expected_revision)?;
        start_incremental_if_configured(&app, &library);
        Ok::<_, CommandError>(receipt)
    })
    .await
    .map_err(|_| super::background_task_error())?
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
pub async fn complete_character_review(
    request: crate::library::character_workflow::CharacterReviewCompletionRequest,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.complete_character_review(request))
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
    if resume {
        start_incremental_if_configured(&app, &library);
    }
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
    tauri::async_runtime::spawn_blocking(move || {
        library.character_series_excluded_assets(&series_id, after.as_deref(), limit)
    })
    .await
    .map_err(|_| super::background_task_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn failed_character_asset_count(
    series_id: String,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.failed_character_asset_count(&series_id))
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

#[tauri::command]
pub async fn character_folder_exclusions(state: State<'_, AppState>) -> Result<Vec<String>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_folder_exclusions())
        .await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}

#[tauri::command]
pub async fn character_series_folders(series_id: String, state: State<'_, AppState>) -> Result<Vec<crate::library::character_folders::SeriesFolder>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.character_series_folders(&series_id))
        .await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}

#[tauri::command]
pub async fn set_character_folder_excluded(request: crate::library::character_folders::FolderExclusionRequest, state: State<'_, AppState>) -> Result<(), CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.set_character_folder_excluded(request))
        .await.map_err(|_| super::background_task_error())?.map_err(Into::into)
}
