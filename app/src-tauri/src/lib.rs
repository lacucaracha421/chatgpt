mod collectible_cors;
mod catalog_source;
mod catalog_transport;
mod cloud;
mod commands;
mod extension_api;
pub mod library;
pub use cloud::backfill::BackfillControlState;
pub use cloud::thumbnail_refresh::{
    refresh_cloud_thumbnails, CloudThumbnailRefreshOptions, CloudThumbnailRefreshReport,
};
#[cfg(test)]
mod catalog_source_tests;
mod media_protocol;

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("Lakomics desktop supports Windows and Linux only");

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
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{InputMethodContextExt, WebViewExt};
                    // Wry disables inline preedit for candidate-window positioning.
                    // Keep Korean composition visible inside the focused input instead.
                    if let Some(context) = webview.inner().input_method_context() {
                        context.set_enable_preedit(true);
                        use gtk::prelude::WidgetExt;
                        use std::{cell::Cell, rc::Rc};

                        let composing = Rc::new(Cell::new(false));
                        let active = composing.clone();
                        context.connect_preedit_started(move |_| active.set(true));
                        let active = composing.clone();
                        context.connect_preedit_finished(move |_| active.set(false));
                        let active = composing.clone();
                        context.connect_committed(move |_, _| active.set(false));

                        // WebKit cancels its composition before resetting IBus.
                        // With synchronous IBus that reset commits the same text
                        // again. Drain it before WebKit handles focus-moving input.
                        let active = composing.clone();
                        let input = context.clone();
                        webview.inner().connect_button_press_event(move |_, _| {
                            if active.replace(false) { input.reset(); }
                            gtk::glib::Propagation::Proceed
                        });
                        let active = composing.clone();
                        let input = context.clone();
                        webview.inner().connect_key_press_event(move |_, event| {
                            if matches!(event.keyval(), gtk::gdk::keys::constants::Tab | gtk::gdk::keys::constants::ISO_Left_Tab)
                                && active.replace(false) { input.reset(); }
                            gtk::glib::Propagation::Proceed
                        });
                        webview.inner().connect_focus_out_event(move |_, _| {
                            if composing.replace(false) { context.reset(); }
                            gtk::glib::Propagation::Proceed
                        });
                    }
                })?;
            }
            extension_api::start(
                app.handle().clone(),
                app_state.clone(),
                extension_runtime.clone(),
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            // Let the frontend flush pending note edits before destroying the window.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                if let Some(library) = window.app_handle().state::<commands::AppState>().current_library() {
                    library.stop_character_scan();
                    library.stop_video_similarity_scan();
                }
                window.app_handle().exit(0);
            }
        })
        .register_asynchronous_uri_scheme_protocol("lakomics", |context, request, responder| {
            // Windows의 WebView2는 프로토콜 핸들러를 UI 스레드에서 호출한다.
            // 썸네일 생성처럼 오래 걸리는 응답이 화면을 막지 않도록 워커 스레드로 돌린다.
            let state = context.app_handle().state::<commands::AppState>();
            let library = state.current_library();
            let range = request
                .headers()
                .get(tauri::http::header::RANGE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let origin = request.headers().get(tauri::http::header::ORIGIN).and_then(|value| value.to_str().ok()).map(str::to_owned);
            let method = request.method().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let mut response = media_protocol::media_response_gated(
                    library.as_ref(),
                    &method,
                    &path,
                    range.as_deref(),
                );
                collectible_cors::allow_cover_canvas(&mut response, origin.as_deref(), &path);
                responder.respond(response);
            });
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
            commands::get_igdb_credential_status,
            commands::set_igdb_credentials,
            commands::delete_igdb_credentials,
            commands::search_igdb_games,
            commands::preview_igdb_game,
            commands::apply_igdb_game,
            commands::refresh_igdb_game,
            commands::get_igdb_connection,
            commands::replace_igdb_game_artwork,
            commands::get_tmdb_credential_status,
            commands::set_tmdb_token,
            commands::delete_tmdb_token,
            commands::search_tmdb_movies,
            commands::preview_tmdb_movie,
            commands::apply_tmdb_movie,
            commands::refresh_tmdb_movie,
            commands::get_tmdb_connection,
            commands::replace_tmdb_movie_artwork,
            commands::get_aladin_credential_status,
            commands::set_aladin_ttb_key,
            commands::delete_aladin_ttb_key,
            commands::search_aladin,
            commands::apply_aladin,
            commands::refresh_aladin,
            commands::get_aladin_connection,
            commands::get_kakao_credential_status,
            commands::set_kakao_api_key,
            commands::delete_kakao_api_key,
            commands::search_kakao,
            commands::apply_kakao,
            commands::refresh_kakao,
            commands::get_kakao_connection,
            commands::get_book_connection,
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
            commands::refresh_assets,
            commands::list_source_group_assets,
            commands::list_asset_creators,
            commands::get_revisit_slate,
            commands::reshuffle_revisit_bundle,
            commands::reshuffle_revisit_slate,
            commands::record_asset_opened,
            commands::record_assets_exposed,
            commands::set_revisit_preference,
            commands::list_asset_date_buckets,
            commands::index_missing_similarity_hashes,
            commands::list_similarity_reviews,
            commands::decide_similarity_review,
            commands::video_similarity::start_video_similarity_scan,
            commands::video_similarity::get_video_similarity_scan,
            commands::video_similarity::latest_video_similarity_scan,
            commands::video_similarity::cancel_video_similarity_scan,
            commands::video_similarity::resume_video_similarity_scan,
            commands::video_similarity::list_video_similarity_reviews,
            commands::video_similarity::decide_video_similarity_review,
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
            commands::characters::list_character_targets,
            commands::characters::apply_automatic_characters,
            commands::characters::character_series,
            commands::characters::save_character_series,
            commands::characters::browse_character_assets,
            commands::characters::character_series_suggestions,
            commands::characters::queue_character_series_discovery,
            commands::characters::dismiss_character_series_suggestion,
            commands::characters::accept_character_series_suggestion,
            commands::characters::save_character_target,
            commands::characters::save_character_settings,
            commands::characters::replace_character_references,
            commands::characters::add_character_learned_references,
            commands::characters::exclude_character_reference,
            commands::characters::mixed_character_folder_preview,
            commands::characters::queue_mixed_character_folder,
            commands::characters::finalize_mixed_character_folder,
            commands::characters::create_manual_character,
            commands::characters::complete_character_review,
            commands::characters::set_character_series_asset_excluded,
            commands::characters::character_series_excluded_assets,
            commands::characters::character_groups,
            commands::characters::save_character_group,
            commands::characters::character_conversion_preview,
            commands::characters::convert_character_to_folder,
            commands::characters::record_character_decisions,
            commands::characters::move_assets_to_character,
            commands::characters::record_character_decision_batch,
            commands::characters::register_character_folder,
            commands::characters::character_folder_image_count,
            commands::characters::character_folder_asset_snapshot,
            commands::characters::character_folder_asset_count,
            commands::characters::list_character_decisions,
            commands::characters::character_relations_for_asset,
            commands::characters::start_character_scan,
            commands::characters::character_scan_status,
            commands::characters::character_autotag_job,
            commands::characters::retry_failed_character_assets,
            commands::characters::failed_character_asset_count,
            commands::characters::character_incremental_status,
            commands::characters::pause_character_incremental,
            commands::characters::cancel_character_scan,
            commands::characters::character_scan_results,
            commands::characters::character_scan_runs,
            commands::characters::character_review_page,
            commands::characters::character_review_pending,
            commands::characters::character_runtime_status,
            commands::characters::setup_character_runtime,
            commands::av::get_av_details,
            commands::av::save_av_details,
            commands::av::search_av_people,
            commands::av::preview_av_artwork,
            commands::av::apply_av_artwork,
            commands::av::get_av_cover_set,
            commands::ingest_media,
            commands::prepare_pending_videos,
            commands::retry_video_preparation,
            commands::start_asset_drag,
            commands::get_manga_root,
            commands::set_manga_root,
            commands::scan_manga,
            commands::list_manga_series,
            commands::preview_manga_catalog_recovery,
            commands::refresh_manga_catalog_recovery_remote,
            commands::apply_manga_catalog_recovery,
            commands::apply_manga_catalog_recovery_selection,
            commands::import_vck_catalog,
            commands::get_online_catalog_status,
            commands::get_catalog_visibility_policy,
            commands::set_catalog_category_hidden,
            commands::set_catalog_tag_blocked,
            commands::search_online_catalog,
            commands::search_catalog_groups,
            commands::cancel_catalog_search,
            commands::get_catalog_group_editions,
            commands::set_catalog_group_representative,
            commands::list_catalog_review,
            commands::generate_catalog_review,
            commands::decide_catalog_review,
            commands::suggest_online_catalog,
            commands::get_online_catalog_work_detail,
            commands::set_online_catalog_bookmark,
            commands::update_online_catalog,
            commands::reset_japanese_catalog_checkpoint,
            commands::run_due_online_catalog_update,
            commands::get_cloud_capture_settings,
            commands::set_cloud_capture_settings,
            commands::set_cloud_api_token,
            commands::delete_cloud_api_token,
            commands::test_cloud_capture_connection,
            commands::create_extension_pairing,
            commands::push_cloud_metadata_backup,
            commands::push_cloud_collections,
            commands::push_cloud_catalog,
            commands::restore_cloud_metadata_backup,
            commands::run_due_cloud_capture_sync,
            commands::cloud_backfill_preflight,
            commands::cloud_backfill_seed,
            commands::cloud_backfill_run_cycle,
            commands::cloud_backfill_progress,
            commands::cloud_backfill_retry_failed,
            commands::cloud_backfill_set_control_state,
            commands::cloud_backfill_reconcile,
            commands::set_online_catalog_update_settings,
            commands::resolve_online_catalog_work,
            commands::list_unread_release_changes,
            commands::list_volume_ownership,
            commands::get_library_statistics,
            commands::notes_request,
            commands::measure_library_derivative_storage,
            commands::record_collection_opened,
            commands::set_owned_volume_count,
            commands::set_volume_ownership,
            commands::list_release_inbox,
            commands::acknowledge_release_events,
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
            commands::import_collection_artworks,
            commands::list_collection_work_artworks,
            commands::list_collection_volumes,
            commands::sync_mangadex_volume_covers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
