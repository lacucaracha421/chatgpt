mod catalog_transport;
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
        .manage(catalog_transport::CatalogTransport::default())
        .manage(library::catalog_update::CatalogUpdateState::default())
        .setup(move |app| {
            extension_api::start(
                app.handle().clone(),
                app_state.clone(),
                extension_runtime.clone(),
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
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
            commands::list_collections,
            commands::search_mangadex,
            commands::preview_mangadex,
            commands::apply_mangadex,
            commands::refresh_mangadex,
            commands::get_mangadex_connection,
            commands::get_aladin_credential_status,
            commands::set_aladin_ttb_key,
            commands::delete_aladin_ttb_key,
            commands::search_aladin,
            commands::apply_aladin,
            commands::refresh_aladin,
            commands::get_aladin_connection,
            commands::get_release_watch_status,
            commands::set_release_watch_enabled,
            commands::take_unread_release_changes,
            commands::run_due_release_watch,
            commands::create_collection,
            commands::update_collection,
            commands::delete_collection,
            commands::set_collection_cover,
            commands::get_asset_collections,
            commands::patch_asset_collections,
            commands::set_collection_showcase,
            commands::get_asset_classifications,
            commands::list_assets,
            commands::list_asset_date_buckets,
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
            commands::import_vck_catalog,
            commands::get_online_catalog_status,
            commands::search_online_catalog,
            commands::suggest_online_catalog,
            commands::get_online_catalog_work_detail,
            commands::set_online_catalog_bookmark,
            commands::update_online_catalog,
            commands::run_due_online_catalog_update,
            commands::set_online_catalog_update_settings,
            commands::resolve_online_catalog_work,
            commands::get_remote_reading_progress,
            commands::save_remote_reading_progress,
            commands::clear_remote_manga_cache,
            commands::inspect_book_import,
            commands::import_book_collections,
            commands::inspect_legacy_package_migration,
            commands::execute_legacy_package_migration,
            commands::get_collection_source_root,
            commands::set_collection_source_root,
            commands::list_collection_covers,
            commands::list_collection_volumes,
            commands::sync_mangadex_volume_covers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
