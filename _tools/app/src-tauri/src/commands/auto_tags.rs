//! 자동 태그 commands (`library/auto_tags.rs`). PC-only; nothing is published.

use std::path::PathBuf;

use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::auto_tags::{
    AssetAutoTags, AutoTagEdit, AutoTagImportSummary, AutoTagVocabularyEntry,
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
pub async fn get_asset_auto_tags(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<AssetAutoTags, CommandError> {
    run(state, move |library| library.asset_auto_tags(&asset_id)).await
}

#[tauri::command]
pub async fn list_auto_tag_vocabulary(
    state: State<'_, AppState>,
) -> Result<Vec<AutoTagVocabularyEntry>, CommandError> {
    run(state, |library| library.auto_tag_vocabulary()).await
}

#[tauri::command]
pub async fn edit_asset_auto_tag(
    asset_id: String,
    tag: String,
    edit: AutoTagEdit,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    run(state, move |library| {
        library.edit_asset_auto_tag(&asset_id, &tag, edit)
    })
    .await
}

#[tauri::command]
pub async fn get_auto_tag_import_summary(
    state: State<'_, AppState>,
) -> Result<Option<AutoTagImportSummary>, CommandError> {
    run(state, |library| library.auto_tag_import_summary()).await
}

/// `path` is the file the user picked in the native dialog.
#[tauri::command]
pub async fn import_auto_tags(
    path: String,
    state: State<'_, AppState>,
) -> Result<AutoTagImportSummary, CommandError> {
    run(state, move |library| {
        library.import_auto_tags(&PathBuf::from(path))
    })
    .await
}

#[tauri::command]
pub async fn get_auto_tag_inbox(
    state: State<'_, AppState>,
) -> Result<crate::library::auto_tag_inbox::Settings, CommandError> {
    run(state, |library| library.auto_tag_inbox()).await
}

#[tauri::command]
pub async fn set_auto_tag_inbox(
    folder: Option<String>,
    apply_tagger_review: bool,
    state: State<'_, AppState>,
) -> Result<crate::library::auto_tag_inbox::Settings, CommandError> {
    run(state, move |library| {
        library.set_auto_tag_inbox(folder, apply_tagger_review)
    })
    .await
}

#[tauri::command]
pub async fn run_auto_tag_inbox_now(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::library::auto_tag_inbox::RunResult, CommandError> {
    run(state, move |library| run_inbox_and_report(&app, &library)).await
}

/// Native timer and manual trigger report through the same status event.
pub(crate) fn run_inbox_and_report(
    app: &tauri::AppHandle,
    library: &Library,
) -> Result<crate::library::auto_tag_inbox::RunResult, crate::library::error::LibraryError> {
    use tauri::Emitter;
    let result = library.run_auto_tag_inbox();
    let report = match &result {
        Ok(result) if !result.processed.is_empty() => {
            let last = result
                .settings
                .last
                .as_ref()
                .expect("processed inbox has a result");
            let mut parts = Vec::new();
            let mut failed = false;
            for name in &result.processed {
                let entry = &last[name];
                let label = if name == crate::library::auto_tag_inbox::FILES[0] {
                    "자동 태그"
                } else {
                    "그림체"
                };
                if let Some(error) = &entry.error {
                    failed = true;
                    parts.push(format!("{label} 가져오기 실패: {error}"));
                } else if label == "자동 태그" {
                    parts.push("자동 태그 가져옴".into());
                    if let Some(tagger) = &entry.tagger {
                        parts.push(format!(
                            "태거 판정 {}건 반영",
                            tagger.veto + tagger.recommend
                        ));
                    }
                } else {
                    parts.push(format!(
                        "그림체 {}장",
                        entry.imported.get("imported").copied().unwrap_or(0)
                    ));
                }
            }
            Some((parts.join(" · "), failed))
        }
        Err(error) => Some((format!("매일 자동 가져오기 실패: {error}"), true)),
        _ => None,
    };
    if let Some((message, error)) = report {
        let _ = app.emit(
            "library://auto-tag-inbox",
            serde_json::json!({ "message": message, "error": error }),
        );
    }
    result
}
