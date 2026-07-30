#![allow(linker_messages)]

mod commands;
pub mod library;
mod media_protocol;

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
            commands::list_classifications,
            commands::create_classification,
            commands::rename_classification,
            commands::move_classification,
            commands::delete_classification,
            commands::get_asset_classifications,
            commands::list_assets,
            commands::set_asset_classifications,
            commands::ingest_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
