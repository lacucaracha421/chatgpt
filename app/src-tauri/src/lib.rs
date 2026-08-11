mod commands;
pub mod library;
mod media_protocol;

#[cfg(not(windows))]
compile_error!("Lakomics is supported only on Windows");

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .register_uri_scheme_protocol("lakomics", |context, request| {
            let state = context.app_handle().state::<commands::AppState>();
            let library = state.current_library();
            let range = request
                .headers()
                .get(tauri::http::header::RANGE)
                .and_then(|value| value.to_str().ok());
            media_protocol::media_response_with_range(
                library.as_ref(),
                request.method(),
                request.uri().path(),
                range,
            )
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_library,
            commands::ensure_daily_backup,
            commands::list_metadata_backups,
            commands::restore_metadata_backup,
            commands::purge_expired_trash,
            commands::list_classifications,
            commands::create_classification,
            commands::rename_classification,
            commands::move_classification,
            commands::delete_classification,
            commands::get_asset_classifications,
            commands::list_assets,
            commands::index_missing_similarity_hashes,
            commands::list_similarity_reviews,
            commands::decide_similarity_review,
            commands::get_asset,
            commands::trash_assets,
            commands::restore_asset,
            commands::restore_assets,
            commands::list_trash,
            commands::empty_trash,
            commands::get_trash_policy,
            commands::set_trash_policy,
            commands::set_asset_favorite,
            commands::set_assets_favorite,
            commands::patch_asset_classifications,
            commands::ingest_media,
            commands::prepare_pending_videos,
            commands::retry_video_preparation,
            commands::start_asset_drag,
            commands::get_manga_root,
            commands::set_manga_root,
            commands::scan_manga,
            commands::list_manga_series,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
