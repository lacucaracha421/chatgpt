//! Machine-local workload policy and native owners of mobile-critical timers.
use crate::cloud::failure::CloudFailureReason;
use crate::library::authority_pass::{
    take_local_work, AuthorityPassOutcome, AuthoritySchedule, LaneFailure,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
static REPLICATION_WORK: AtomicBool = AtomicBool::new(false);
static LAUNCH_STARTED: OnceLock<Instant> = OnceLock::new();
static LAUNCH_SETTLED: AtomicBool = AtomicBool::new(false);
static LAUNCH_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
const LAUNCH_FALLBACK: Duration = Duration::from_secs(12);

fn launch_ready(settled: bool, elapsed: Option<Duration>) -> bool {
    settled || elapsed.is_none_or(|elapsed| elapsed >= LAUNCH_FALLBACK)
}

pub(crate) fn launch_maintenance_ready() -> bool {
    launch_ready(
        LAUNCH_SETTLED.load(Ordering::Acquire),
        LAUNCH_STARTED.get().map(Instant::elapsed),
    )
}

/// Wait without holding a library lock or occupying a blocking worker. Unit-test
/// libraries have no window/setup and do not wait. A missing renderer has a cap.
pub(crate) async fn after_launch_settled() {
    let wake = LAUNCH_WAKE.notified();
    tokio::pin!(wake);
    wake.as_mut().enable();
    if !launch_maintenance_ready() {
        wake.await;
    }
}

#[tauri::command]
pub(crate) fn workload_launch_settled() {
    if !LAUNCH_SETTLED.swap(true, Ordering::AcqRel) {
        crate::perf_log::startup_record("launch.maintenance.ready", serde_json::json!({}));
    }
    LAUNCH_WAKE.notify_waiters();
}

/// Events and explicit tray actions own this state. The timer only reconciles it
/// every 30 s for platforms that omit a visibility/minimize event.
struct WindowActivity {
    focused: AtomicBool,
    hidden: AtomicBool,
}
impl WindowActivity {
    const fn new(focused: bool, hidden: bool) -> Self {
        Self {
            focused: AtomicBool::new(focused),
            hidden: AtomicBool::new(hidden),
        }
    }
    fn record(&self, hidden: bool, focused: bool) {
        self.focused.store(focused && !hidden, Ordering::Release);
        self.hidden.store(hidden, Ordering::Release);
    }
    fn snapshot(&self) -> (bool, bool) {
        let hidden = self.hidden.load(Ordering::Acquire);
        (hidden, self.focused.load(Ordering::Acquire) && !hidden)
    }
}
static WINDOW_ACTIVITY: WindowActivity = WindowActivity::new(false, false);
const WINDOW_RECONCILE: Duration = Duration::from_secs(30);

pub(crate) fn window_visibility(app: &tauri::AppHandle, hidden: bool) {
    activity(app, hidden, WINDOW_ACTIVITY.snapshot().1);
}

fn reconcile_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        activity(
            app,
            !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false),
            window.is_focused().unwrap_or(false),
        );
    }
}

pub(crate) fn note_replication_work() {
    REPLICATION_WORK.store(true, Ordering::Release);
}

pub(crate) fn video_prepared() {
    if let Some(app) = APP.get() {
        let _ = app.emit("library://asset-authority-changed", ());
    }
}

/// Latest outcome of the background authority lanes for one library, in memory only.
/// A lane that fails every pass would otherwise be invisible; only closed codes are kept.
#[derive(Default)]
struct LaneHealth {
    root: Option<PathBuf>,
    authority: Option<LaneFailure>,
    assets: Option<LaneFailure>,
    asset_stopped: bool,
    authority_held: bool,
    asset_held: bool,
}
static LANE_HEALTH: Mutex<LaneHealth> = Mutex::new(LaneHealth {
    root: None,
    authority: None,
    assets: None,
    asset_stopped: false,
    authority_held: false,
    asset_held: false,
});

/// Record one lane run; a success clears that lane's failure. Emits
/// `library://authority-health-changed` only when the visible state changes.
fn record_lane(
    app: &tauri::AppHandle,
    root: &Path,
    assets: bool,
    failure: Option<&'static str>,
    stopped: bool,
    held: bool,
) {
    let changed = {
        let mut guard = LANE_HEALTH
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let health = &mut *guard;
        if health.root.as_deref() != Some(root) {
            *health = LaneHealth {
                root: Some(root.to_path_buf()),
                ..LaneHealth::default()
            };
        }
        let visible = |h: &LaneHealth| {
            (
                h.authority.as_ref().map(|f| f.code),
                h.assets.as_ref().map(|f| f.code),
                h.asset_stopped,
                h.authority_held,
                h.asset_held,
            )
        };
        let before = visible(health);
        let slot = if assets {
            &mut health.assets
        } else {
            &mut health.authority
        };
        match failure {
            // Keep the time the failure began while the same cause repeats.
            Some(code) if slot.as_ref().is_some_and(|f| f.code == code) => {}
            Some(code) => {
                *slot = Some(LaneFailure {
                    code,
                    at: chrono::Utc::now().to_rfc3339(),
                })
            }
            None => *slot = None,
        }
        if assets {
            health.asset_stopped = stopped;
            health.asset_held = held;
        } else {
            health.authority_held = held;
        }
        before != visible(health)
    };
    if changed {
        let _ = app.emit("library://authority-health-changed", ());
    }
}

/// Recorded failures, Asset stop, and the authority/Asset hold states for `root`.
pub(crate) fn lane_health(
    root: &Path,
) -> (Option<LaneFailure>, Option<LaneFailure>, bool, bool, bool) {
    let health = LANE_HEALTH
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if health.root.as_deref() != Some(root) {
        return (None, None, false, false, false);
    }
    (
        health.authority.clone(),
        health.assets.clone(),
        health.asset_stopped,
        health.authority_held,
        health.asset_held,
    )
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
    /// 절약 모드 was switched on by inactivity, not by the user: it is never written to the
    /// machine settings, so the next app start is back in 일반 모드.
    auto_entered: bool,
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
            "절약 모드 끄기"
        } else {
            "절약 모드 켜기"
        });
    }
}
fn update(app: &tauri::AppHandle, settings: Settings) -> Result<Profile, String> {
    apply(app, settings, false)
}
/// Applies settings; `automatic` marks the inactivity switch, which changes only the running
/// state. A saved copy never records an automatic 절약 모드 as on.
fn apply(app: &tauri::AppHandle, settings: Settings, automatic: bool) -> Result<Profile, String> {
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
    let (saved, auto_entered) = saved_settings(&settings, state.auto_entered, automatic);
    if let Some(saved) = saved {
        crate::library::machine_settings::set_workload(path, saved).map_err(|e| e.to_string())?;
    }
    state.set(settings, Instant::now());
    state.auto_entered = auto_entered;
    let profile = state.profile();
    drop(state);
    broadcast(app);
    Ok(profile)
}
/// What to write to the machine settings for a change, and whether 절약 모드 is then an
/// automatic one. The inactivity switch writes nothing; while an automatic 절약 모드 lasts,
/// saving other settings keeps the stored switch off.
fn saved_settings(
    settings: &Settings,
    was_auto: bool,
    automatic: bool,
) -> (Option<Settings>, bool) {
    let auto_entered = automatic || (was_auto && settings.lightweight);
    if automatic {
        return (None, auto_entered);
    }
    let mut saved = settings.clone();
    if auto_entered {
        saved.lightweight = false;
    }
    (Some(saved), auto_entered)
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
/// Async so the stop, which waits up to 2 s for a video scan item, runs off the UI thread.
#[tauri::command]
pub(crate) async fn workload_cancel_scans(app: tauri::AppHandle) {
    let Some(library) = app.state::<crate::commands::AppState>().current_library() else {
        return;
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        library.stop_character_scan();
        library.stop_video_similarity_scan();
    })
    .await;
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
/// The tray's "받은 파일 N개 — 폴더 열기" entry, inserted only while N > 0. Only
/// touched on the main thread, so `shown` needs no lock.
struct ReceivedEntry {
    menu: Menu<tauri::Wry>,
    item: MenuItem<tauri::Wry>,
    shown: AtomicBool,
}
/// Show unseen received files (file exchange) in the tray menu and tooltip.
///
/// Callable from any thread without blocking: nothing happens unless the count
/// changed, and the menu/tooltip calls are queued to the main thread with no lock
/// held (menu calls block until the main thread runs them).
pub(crate) fn set_received_indicator(app: &tauri::AppHandle, count: usize) {
    static LAST: AtomicUsize = AtomicUsize::new(usize::MAX);
    if LAST.swap(count, Ordering::AcqRel) == count {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(entry) = handle.try_state::<ReceivedEntry>() {
            if count > 0 {
                let _ = entry
                    .item
                    .set_text(format!("받은 파일 {count}개 — 폴더 열기"));
                if !entry.shown.load(Ordering::Acquire) && entry.menu.insert(&entry.item, 0).is_ok()
                {
                    entry.shown.store(true, Ordering::Release);
                }
            } else if entry.shown.load(Ordering::Acquire) && entry.menu.remove(&entry.item).is_ok()
            {
                entry.shown.store(false, Ordering::Release);
            }
        }
        if let Some(tray) = handle.tray_by_id("main-tray") {
            let tooltip = if count > 0 {
                format!("Lakomics · 받은 파일 {count}개")
            } else {
                "Lakomics".to_owned()
            };
            let _ = tray.set_tooltip(Some(tooltip));
        }
    });
}
fn open(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.show().is_ok() && window.unminimize().is_ok() {
            let focused = window.set_focus().is_ok();
            activity(app, false, focused);
        }
    }
}
pub(crate) fn activity(app: &tauri::AppHandle, hidden: bool, focused: bool) {
    WINDOW_ACTIVITY.record(hidden, focused);
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
    let _ = LAUNCH_STARTED.set(Instant::now());
    std::thread::spawn(|| {
        std::thread::sleep(LAUNCH_FALLBACK);
        workload_launch_settled();
    });
    let _ = APP.set(app.clone());
    let path = app.path().app_config_dir()?.join("library-machine.json");
    crate::performance::setup(&path)?;
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
            "절약 모드 끄기"
        } else {
            "절약 모드 켜기"
        },
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "workload-quit", "종료", true, None::<&str>)?;
    let received_item =
        MenuItem::with_id(app, "exchange-received", "받은 파일", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &light_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "workload-open" => open(app),
            // Off the main thread: it takes the exchange state lock.
            "exchange-received" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = crate::exchange::open_folder(&app);
                });
            }
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
            app.manage(ReceivedEntry {
                menu,
                item: received_item,
                shown: AtomicBool::new(false),
            });
        }
        Err(error) => eprintln!("system tray unavailable: {error}"),
    }
    reconcile_window(app);
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
        let replication = std::sync::Arc::new(Mutex::new(AuthoritySchedule::new(Instant::now())));
        let mut replication_root = None;
        let mut replication_restricted = None;
        let mut launchbox_check = publications;
        static LAUNCHBOX_BUSY: AtomicBool = AtomicBool::new(false);
        static ASSETS_BUSY: AtomicBool = AtomicBool::new(false);
        // Shared-authority lane: one conditional status read per pass for every domain,
        // with idle backoff (see `library::authority_pass`).
        let authority = std::sync::Arc::new(Mutex::new(AuthoritySchedule::new(Instant::now())));
        // The `/v1/sync/status` long-poll watcher for the open library's endpoint.
        let mut watcher = crate::cloud::status_watch::Supervisor::default();
        let mut inbox = crate::library::auto_tag_inbox::Schedule::default();
        let mut was_focused = false;
        let mut window_checked = Instant::now();
        let mut authority_root: Option<PathBuf> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if window_checked.elapsed() >= WINDOW_RECONCILE {
                reconcile_window(&app);
                window_checked = Instant::now();
            }
            let (_, focused) = WINDOW_ACTIVITY.snapshot();
            // Returning to the window or queueing a local write wants fresh state now.
            let gained_focus = focused && !was_focused;
            was_focused = focused;
            // Every flag is consumed each tick (no short-circuit), so none lingers.
            let watched = crate::cloud::status_watch::take_authority_wake();
            if take_local_work() | gained_focus | watched {
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
                if let Err(error) = apply(&app, settings, true) {
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
            if crate::cloud::status_watch::take_captures_signal() {
                let _ = app.emit("cloud://captures-pending", ());
            }
            let current = app.state::<crate::commands::AppState>().current_library();
            watcher.tick(current.as_ref(), Instant::now());
            if inbox.tick(current.as_ref(), profile.restricted, Instant::now()) {
                if let Some(library) = current.clone() {
                    let handle = app.clone();
                    let (finished, completion) = std::sync::mpsc::channel();
                    inbox.running(completion);
                    std::thread::spawn(move || {
                        let result = crate::commands::auto_tags::run_inbox_and_report(&handle, &library);
                        let success = result.is_ok_and(|result| {
                            !result.processed.iter().any(|name| result.settings.last.as_ref()
                                .and_then(|last| last.get(name)).is_some_and(|last| last.error.is_some()))
                        });
                        let _ = finished.send(success);
                    });
                }
            }
            let Some(library) = current else {
                continue;
            };
            crate::library::av_link::tick(library.clone(), profile.restricted || !focused);
            // Bulk metadata is maintenance: never start it just because a work was opened.
            let idle = runtime()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .inactive_since
                .is_some_and(|since| since.elapsed() >= Duration::from_secs(120));
            if idle && !profile.restricted && launchbox_check.elapsed() >= Duration::from_secs(60) {
                launchbox_check = Instant::now();
                let has_games = library
                    .connection()
                    .and_then(|db| {
                        db.query_row(
                            "SELECT EXISTS(SELECT 1 FROM collections WHERE type='game')",
                            [],
                            |row| row.get::<_, bool>(0),
                        )
                        .map_err(Into::into)
                    })
                    .unwrap_or(false);
                if let (true, Ok(cache)) = (has_games, app.path().app_cache_dir()) {
                    let cache = cache.join("launchbox");
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if crate::library::launchbox::refresh_due(&cache, now)
                        && !LAUNCHBOX_BUSY.swap(true, Ordering::AcqRel)
                    {
                        std::thread::spawn(move || {
                            let _reset = Reset(&LAUNCHBOX_BUSY);
                            let _ =
                                crate::library::launchbox::refresh(&cache, &AtomicBool::new(false));
                        });
                    }
                }
            }
            // A moved publisher log head (seen by the watcher or a pass) runs the lanes now.
            let publication_wake = crate::cloud::status_watch::take_publication_wake();
            if launch_maintenance_ready()
                && (publication_wake || publications.elapsed() >= Duration::from_secs(10))
            {
                publications = Instant::now();
                // Read-only readiness runs here; only a ready lane wakes its isolated worker.
                let _ = library.run_saved_mobile_publications();
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
                        live: false,
                    };
                    let (outcome, status) = lib.run_authority_pass().unwrap_or_else(|error| {
                        let failure = Some(CloudFailureReason::from_error(&error).code());
                        let outcome = AuthorityPassOutcome {
                            failure,
                            ..AuthorityPassOutcome::default()
                        };
                        (outcome, None)
                    });
                    record_lane(
                        &handle,
                        lib.root(),
                        false,
                        outcome.failure,
                        false,
                        outcome.held,
                    );
                    finish.changed = outcome.changed();
                    finish.live = outcome.live && outcome.failure.is_none();
                    for (changed, event) in [
                        (outcome.albums, "library://album-authority-changed"),
                        (
                            outcome.classifications,
                            "library://classification-authority-changed",
                        ),
                        (outcome.bookmarks, "library://catalog-bookmarks-changed"),
                        (outcome.assets, "library://asset-authority-changed"),
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
                        let (changed, failure, stopped, held) =
                            match lib.run_asset_lane(&status, restricted) {
                                Ok(lane) => (lane.changed, None, lane.stopped, lane.held),
                                Err(error) => (
                                    false,
                                    Some(CloudFailureReason::from_error(&error).code()),
                                    false,
                                    false,
                                ),
                            };
                        record_lane(&handle, lib.root(), true, failure, stopped, held);
                        if changed {
                            let _ = handle.emit("library://asset-authority-changed", ());
                            schedule
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .changed_elsewhere(Instant::now());
                        }
                    });
                });
            }
            let replication_wake = REPLICATION_WORK.swap(false, Ordering::AcqRel);
            let replication_due = {
                let mut schedule = replication
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if replication_root.as_deref() != Some(library.root())
                    || replication_restricted != Some(profile.restricted)
                    || replication_wake
                {
                    replication_restricted = Some(profile.restricted);
                    replication_root = Some(library.root().to_path_buf());
                    schedule.wake(Instant::now());
                }
                let due = schedule.due(Instant::now());
                if due {
                    schedule.begin();
                }
                due
            };
            if replication_due {
                let schedule = replication.clone();
                let restricted = profile.restricted;
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        library.run_cloud_backfill_cycle()
                    }));
                    let active = result.as_ref().is_ok_and(|result| {
                        result.as_ref().is_ok_and(|summary| {
                            summary.committed + summary.retry_scheduled + summary.permanent_failures
                                > 0
                        })
                    });
                    let failed = !matches!(result, Ok(Ok(_)));
                    let mut schedule = schedule
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    finish_replication(&mut schedule, active, failed, restricted, Instant::now());
                });
            }
        }
    });
}
fn finish_replication(
    schedule: &mut AuthoritySchedule,
    active: bool,
    failed: bool,
    restricted: bool,
    now: Instant,
) {
    let delay = schedule.finished(active, false, false, now);
    // Keep the existing cadence for real work and failures. An idle
    // queue backs off to 15/30/60 s; queue writes wake it next tick.
    if delay != Duration::ZERO && (active || failed) {
        schedule.wake(now + Duration::from_secs(if restricted { 10 } else { 2 }));
    }
}

struct FinishPass {
    schedule: std::sync::Arc<Mutex<AuthoritySchedule>>,
    restricted: bool,
    changed: bool,
    live: bool,
}
impl Drop for FinishPass {
    fn drop(&mut self) {
        self.schedule
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finished(self.changed, self.restricted, self.live, Instant::now());
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
    fn launch_maintenance_waits_for_renderer_or_bounded_fallback() {
        assert!(launch_ready(false, None));
        assert!(!launch_ready(false, Some(Duration::ZERO)));
        assert!(!launch_ready(
            false,
            Some(LAUNCH_FALLBACK - Duration::from_millis(1))
        ));
        assert!(launch_ready(false, Some(LAUNCH_FALLBACK)));
        assert!(launch_ready(true, Some(Duration::ZERO)));
    }
    #[test]
    fn window_activity_records_initial_focus_hide_and_restore() {
        for (focused, hidden, expected) in [
            (false, false, (false, false)),
            (true, false, (false, true)),
            (false, true, (true, false)),
            (true, true, (true, false)),
        ] {
            let state = WindowActivity::new(false, false);
            state.record(hidden, focused);
            assert_eq!(state.snapshot(), expected);
        }
        let state = WindowActivity::new(false, false);
        assert_eq!(state.snapshot(), (false, false));
        state.record(false, true);
        assert_eq!(state.snapshot(), (false, true));
        state.record(false, false);
        assert_eq!(state.snapshot(), (false, false));
        state.record(true, false);
        assert_eq!(state.snapshot(), (true, false));
        state.record(false, false);
        assert_eq!(state.snapshot(), (false, false));
        state.record(false, true);
        assert_eq!(state.snapshot(), (false, true));
    }
    #[test]
    fn replication_backs_off_only_when_idle_and_keeps_new_work_wakes() {
        let now = Instant::now();
        let mut schedule = AuthoritySchedule::new(now);
        for delay in [15, 30, 60, 60] {
            schedule.begin();
            finish_replication(&mut schedule, false, false, false, now);
            assert!(!schedule.due(now + Duration::from_secs(delay - 1)));
            assert!(schedule.due(now + Duration::from_secs(delay)));
        }
        for (restricted, delay) in [(false, 2), (true, 10)] {
            schedule.begin();
            finish_replication(&mut schedule, true, false, restricted, now);
            assert!(!schedule.due(now + Duration::from_secs(delay - 1)));
            assert!(schedule.due(now + Duration::from_secs(delay)));
        }
        schedule.begin();
        schedule.wake(now);
        finish_replication(&mut schedule, false, false, false, now);
        assert!(
            schedule.due(now),
            "a wake during an empty pass must survive finishing"
        );
    }

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
    fn automatic_saving_mode_is_never_stored() {
        let on = Settings {
            lightweight: true,
            auto_enter_minutes: Some(30),
            close_to_tray: true,
        };
        // The inactivity switch writes nothing and is marked automatic.
        assert_eq!(saved_settings(&on, false, true), (None, true));
        // Saving another setting while it lasts keeps the stored switch off.
        let (saved, auto) = saved_settings(&on, true, false);
        assert_eq!(saved.map(|s| s.lightweight), Some(false));
        assert!(auto);
        // Turning it off ends the automatic state; turning it on by hand is stored.
        let off = Settings {
            lightweight: false,
            ..on.clone()
        };
        assert_eq!(
            saved_settings(&off, true, false),
            (Some(off.clone()), false)
        );
        assert_eq!(saved_settings(&on, false, false), (Some(on.clone()), false));
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
