mod commands;
mod extension_api;
pub mod library;
mod media_protocol;

#[cfg(not(windows))]
compile_error!("Lakomics is supported only on Windows");

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = commands::AppState::default();
    let extension_runtime = extension_api::ExtensionRuntime::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state.clone())
        .manage(extension_runtime.clone())
        .setup(move |app| {
            extension_api::start(
                app.handle().clone(),
                app_state.clone(),
                extension_runtime.clone(),
            );
            Ok(())
        })
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
            commands::get_extension_connection,
            commands::inspect_metadata_import,
            commands::ensure_daily_backup,
            commands::list_metadata_backups,
            commands::restore_metadata_backup,
            commands::purge_expired_trash,
            commands::list_classifications,
            commands::create_classification,
            commands::rename_classification,
            commands::update_classification_appearance,
            commands::move_classification,
            commands::delete_classification,
            commands::list_albums,
            commands::create_album,
            commands::rename_album,
            commands::move_album,
            commands::update_album_appearance,
            commands::delete_album,
            commands::get_asset_albums,
            commands::patch_asset_albums,
            commands::get_asset_classifications,
            commands::list_assets,
            commands::index_missing_similarity_hashes,
            commands::list_similarity_reviews,
            commands::decide_similarity_review,
            commands::get_asset,
            commands::update_asset_metadata,
            commands::trash_assets,
            commands::restore_asset,
            commands::restore_assets,
            commands::list_trash,
            commands::empty_trash,
            commands::get_trash_policy,
            commands::set_trash_policy,
            commands::set_asset_favorite,
            commands::set_assets_favorite,
            commands::set_asset_classification,
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
