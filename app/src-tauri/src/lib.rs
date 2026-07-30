mod commands;
pub mod library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_library,
            commands::current_library,
            commands::list_classifications,
            commands::create_classification,
            commands::rename_classification,
            commands::move_classification,
            commands::delete_classification,
            commands::get_asset_classifications,
            commands::set_asset_classifications,
            commands::ingest_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
