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
            media_protocol::media_response(library.as_ref(), request.method(), request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_library,
            commands::current_library,
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
            commands::trash_asset,
            commands::trash_assets,
            commands::restore_asset,
            commands::restore_assets,
            commands::list_trash,
            commands::empty_trash,
            commands::get_trash_policy,
            commands::set_trash_policy,
            commands::set_asset_favorite,
            commands::set_assets_favorite,
            commands::set_asset_classifications,
            commands::patch_asset_classifications,
            commands::ingest_image,
            commands::start_asset_drag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
