//! Machine-local workload policy and native owners of mobile-critical timers.
use crate::library::authority_pass::{take_local_work, AuthoritySchedule};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub(crate) fn video_prepared() {
    if let Some(app) = APP.get() {
        let _ = app.emit("library://asset-authority-changed", ());
    }
}

const RECOVERY: Duration = Duration::from_secs(180);
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    pub lightweight: bool,
    pub auto_enter_minutes: Option<u32>,
    pub close_to_tray: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            lightweight: false,
            auto_enter_minutes: None,
            close_to_tray: true,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    #[serde(flatten)]
    settings: Settings,
    restricted: bool,
    hidden: bool,
    tray_available: bool,
}
#[derive(Default)]
struct Runtime {
    settings: Settings,
    path: Option<PathBuf>,
    recovery_until: Option<Instant>,
    inactive_since: Option<Instant>,
    hidden: bool,
    tray_available: bool,
}
impl Runtime {
    fn restricted(&self, now: Instant) -> bool {
        self.settings.lightweight || self.recovery_until.is_some_and(|until| now < until)
    }
    fn profile(&self) -> Profile {
        Profile {
            settings: self.settings.clone(),
            restricted: self.restricted(Instant::now()),
            hidden: self.hidden,
            tray_available: self.tray_available,
        }
    }
    fn set(&mut self, settings: Settings, now: Instant) {
        if self.settings.lightweight && !settings.lightweight {
            self.recovery_until = Some(now + RECOVERY);
        }
        if settings.lightweight {
            self.recovery_until = None;
        }
        // Turning the mode off manually grants a new inactivity period.
        if self.inactive_since.is_some() {
            self.inactive_since = Some(now);
        }
        self.settings = settings;
    }
    fn auto_due(&self, now: Instant) -> bool {
        !self.settings.lightweight
            && self
                .settings
                .auto_enter_minutes
                .zip(self.inactive_since)
                .is_some_and(|(minutes, since)| {
                    now.duration_since(since) >= Duration::from_secs(u64::from(minutes) * 60)
                })
    }
}
fn runtime() -> &'static Mutex<Runtime> {
    static STATE: OnceLock<Mutex<Runtime>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}
pub(crate) fn is_restricted() -> bool {
    runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .restricted(Instant::now())
}
pub(crate) fn is_hidden() -> bool {
    runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .hidden
}
pub(crate) fn is_lightweight() -> bool {
    runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .settings
        .lightweight
}
fn broadcast(app: &tauri::AppHandle) {
    let profile = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .profile();
    let _ = app.emit("workload://changed", profile.clone());
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.0.set_text(if profile.settings.lightweight {
            "가벼운 모드 끄기"
        } else {
            "가벼운 모드 켜기"
        });
    }
}
fn update(app: &tauri::AppHandle, settings: Settings) -> Result<Profile, String> {
    if settings
        .auto_enter_minutes
        .is_some_and(|n| !(1..=1440).contains(&n))
    {
        return Err("자동 전환 시간은 1~1440분으로 입력해 주세요.".into());
    }
    let mut state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = state
        .path
        .as_ref()
        .ok_or("이 PC의 설정 경로를 찾지 못했습니다.")?;
    crate::library::machine_settings::set_workload(path, settings.clone())
        .map_err(|e| e.to_string())?;
    state.set(settings, Instant::now());
    let profile = state.profile();
    drop(state);
    broadcast(app);
    Ok(profile)
}
#[tauri::command]
pub(crate) fn workload_profile(
    app: tauri::AppHandle,
    settings: Option<Settings>,
) -> Result<Profile, String> {
    match settings {
        Some(settings) => update(&app, settings),
        None => Ok(runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .profile()),
    }
}
#[tauri::command]
pub(crate) fn workload_cancel_scans(state: tauri::State<'_, crate::commands::AppState>) {
    if let Some(library) = state.current_library() {
        library.stop_character_scan();
        library.stop_video_similarity_scan();
    }
}
#[tauri::command]
pub(crate) fn workload_quit(app: tauri::AppHandle) {
    if let Some(library) = app.state::<crate::commands::AppState>().current_library() {
        library.stop_character_scan();
        library.stop_video_similarity_scan();
        library.lock_encrypted_vault();
    }
    app.exit(0);
}
/// The window's close request, routed here by the webview (its close-requested
/// listener would otherwise destroy the window): hide to the tray when enabled,
/// otherwise quit as closing the window always did.
#[tauri::command]
pub(crate) fn workload_close_window(app: tauri::AppHandle) {
    if !close_to_tray(&app) {
        workload_quit(app);
    }
}
struct TrayMenu(MenuItem<tauri::Wry>);
fn open(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    activity(app, false, true);
}
pub(crate) fn activity(app: &tauri::AppHandle, hidden: bool, focused: bool) {
    let mut state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let changed = state.hidden != hidden;
    state.hidden = hidden;
    if !hidden && focused {
        state.inactive_since = None;
    } else if state.inactive_since.is_none() {
        state.inactive_since = Some(Instant::now());
    }
    drop(state);
    if changed {
        broadcast(app);
    }
}
pub(crate) fn close_to_tray(app: &tauri::AppHandle) -> bool {
    let state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let hide = state.tray_available && state.settings.close_to_tray;
    drop(state);
    if hide {
        if let Some(library) = app.state::<crate::commands::AppState>().current_library() {
            library.lock_encrypted_vault();
        }
        if let Some(window) = app.get_webview_window("main") {
            if window.hide().is_err() {
                return false;
            }
        }
        activity(app, true, false);
    }
    hide
}
pub(crate) fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let _ = APP.set(app.clone());
    let path = app.path().app_config_dir()?.join("library-machine.json");
    {
        let mut state = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.settings = crate::library::machine_settings::workload(&path)?;
        state.path = Some(path);
    }
    let open_item = MenuItem::with_id(app, "workload-open", "열기", true, None::<&str>)?;
    let light_item = MenuItem::with_id(
        app,
        "workload-light",
        if is_lightweight() {
            "가벼운 모드 끄기"
        } else {
            "가벼운 모드 켜기"
        },
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "workload-quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &light_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "workload-open" => open(app),
            "workload-light" => {
                let mut settings = runtime()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .settings
                    .clone();
                settings.lightweight = !settings.lightweight;
                if let Err(error) = update(app, settings) {
                    let _ = app.emit("workload://error", error);
                }
            }
            // The mounted note guard flushes unsaved notes, including while hidden.
            "workload-quit" => {
                let _ = app.emit("workload://quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                open(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    match builder.build(app) {
        Ok(_) => {
            runtime()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .tray_available = true;
            app.manage(TrayMenu(light_item));
        }
        Err(error) => eprintln!("system tray unavailable: {error}"),
    }
    start_timers(app.clone());
    Ok(())
}

/// Each lane has one native owner in visible AND hidden states. Slow I/O in one
/// lane cannot delay another; JS only registers navigation preferences.
fn start_timers(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_profile = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .profile();
        let mut publications = Instant::now() - Duration::from_secs(10);
        let mut replication = publications;
        static PUBLICATIONS_BUSY: AtomicBool = AtomicBool::new(false);
        static REPLICATION_BUSY: AtomicBool = AtomicBool::new(false);
        static ASSETS_BUSY: AtomicBool = AtomicBool::new(false);
        // Shared-authority lane: one conditional status read per pass for every domain,
        // with idle backoff (see `library::authority_pass`).
        let authority = std::sync::Arc::new(Mutex::new(AuthoritySchedule::new(Instant::now())));
        let mut was_focused = false;
        let mut authority_root: Option<PathBuf> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let mut focused = false;
            if let Some(window) = app.get_webview_window("main") {
                focused = window.is_focused().unwrap_or(false);
                activity(&app, !window.is_visible().unwrap_or(true), focused);
            }
            // Returning to the window or queueing a local write wants fresh state now.
            let gained_focus = focused && !was_focused;
            was_focused = focused;
            if take_local_work() || gained_focus {
                authority
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .wake(Instant::now());
            }
            let auto = {
                let state = runtime()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.auto_due(Instant::now()).then(|| {
                    let mut s = state.settings.clone();
                    s.lightweight = true;
                    s
                })
            };
            if let Some(settings) = auto {
                if let Err(error) = update(&app, settings) {
                    let _ = app.emit("workload://error", error);
                }
            }
            let profile = runtime()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .profile();
            if profile != last_profile {
                // Reopen the native one-shot maintenance owners only after recovery.
                if last_profile.restricted && !profile.restricted {
                    if let Some(library) =
                        app.state::<crate::commands::AppState>().current_library()
                    {
                        library.start_work_artwork_thumbnail_backfill();
                        library.request_catalog_preparation();
                    }
                }
                broadcast(&app);
                last_profile = profile.clone();
            }
            let Some(library) = app.state::<crate::commands::AppState>().current_library() else {
                continue;
            };
            if publications.elapsed() >= Duration::from_secs(10)
                && !PUBLICATIONS_BUSY.swap(true, Ordering::AcqRel)
            {
                publications = Instant::now();
                let lib = library.clone();
                std::thread::spawn(move || {
                    let _reset = Reset(&PUBLICATIONS_BUSY);
                    let _ = lib.run_saved_mobile_publications();
                });
            }
            let start_authority = {
                let mut schedule = authority
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                // A newly opened library converges immediately, not after the old backoff.
                if authority_root.as_deref() != Some(library.root()) {
                    authority_root = Some(library.root().to_path_buf());
                    schedule.wake(Instant::now());
                }
                let due = schedule.due(Instant::now());
                if due {
                    schedule.begin();
                }
                due
            };
            if start_authority {
                let lib = library.clone();
                let handle = app.clone();
                let schedule = authority.clone();
                let restricted = profile.restricted;
                std::thread::spawn(move || {
                    // Finishing in `Drop` keeps a panicking pass from stalling the lane.
                    let mut finish = FinishPass {
                        schedule: schedule.clone(),
                        restricted,
                        changed: false,
                    };
                    let (outcome, status) = lib.run_authority_pass().unwrap_or_default();
                    finish.changed = outcome.changed();
                    for (changed, event) in [
                        (outcome.albums, "library://album-authority-changed"),
                        (
                            outcome.classifications,
                            "library://classification-authority-changed",
                        ),
                        (outcome.bookmarks, "library://catalog-bookmarks-changed"),
                    ] {
                        if changed {
                            let _ = handle.emit(event, ());
                        }
                    }
                    // The Asset lane reuses this pass's status on its own single-flight
                    // thread: a long media materialization must not hold up the metadata
                    // lanes. A pass that finds it still busy leaves the work to it.
                    let Some(status) = status else { return };
                    if ASSETS_BUSY.swap(true, Ordering::AcqRel) {
                        return;
                    }
                    std::thread::spawn(move || {
                        let _reset = Reset(&ASSETS_BUSY);
                        if lib.run_asset_lane(&status, restricted).unwrap_or(false) {
                            let _ = handle.emit("library://asset-authority-changed", ());
                            schedule
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .changed_elsewhere(Instant::now());
                        }
                    });
                });
            }
            if replication.elapsed() >= Duration::from_secs(if profile.restricted { 10 } else { 2 })
                && !REPLICATION_BUSY.swap(true, Ordering::AcqRel)
            {
                replication = Instant::now();
                std::thread::spawn(move || {
                    let _reset = Reset(&REPLICATION_BUSY);
                    let _ = library.run_cloud_backfill_cycle();
                });
            }
        }
    });
}
struct FinishPass {
    schedule: std::sync::Arc<Mutex<AuthoritySchedule>>,
    restricted: bool,
    changed: bool,
}
impl Drop for FinishPass {
    fn drop(&mut self) {
        self.schedule
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finished(self.changed, self.restricted, Instant::now());
    }
}
struct Reset(&'static AtomicBool);
impl Drop for Reset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workload_defaults_and_recovery_are_machine_local() {
        let now = Instant::now();
        let mut state = Runtime::default();
        assert!(state.settings.close_to_tray);
        assert!(!state.auto_due(now));
        state.set(
            Settings {
                lightweight: true,
                ..Settings::default()
            },
            now,
        );
        assert!(state.restricted(now + RECOVERY));
        state.set(Settings::default(), now);
        assert!(state.restricted(now + Duration::from_secs(179)));
        assert!(!state.restricted(now + RECOVERY));
    }
    #[test]
    fn workload_auto_entry_requires_continuous_inactivity() {
        let now = Instant::now();
        let mut state = Runtime::default();
        state.settings.auto_enter_minutes = Some(2);
        state.inactive_since = Some(now);
        assert!(!state.auto_due(now + Duration::from_secs(119)));
        assert!(state.auto_due(now + Duration::from_secs(120)));
        state.inactive_since = None;
        assert!(!state.auto_due(now + RECOVERY));
    }
}
