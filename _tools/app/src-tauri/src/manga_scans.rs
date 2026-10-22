//! One desktop worker for all bookstore HTTP requests, including across library switches.
use crate::{
    commands::AppState,
    library::{
        manga_spine_scans::{goods_id, real_jpeg},
        Library,
    },
};
use serde::Serialize;
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub queued: usize,
    pub done: usize,
    pub real: usize,
    pub missing: usize,
    pub not_found: usize,
    pub errors: usize,
}
#[derive(Default)]
struct Control {
    stop: AtomicBool,
    wake: Mutex<bool>,
    changed: Condvar,
    progress: Mutex<(String, Progress)>,
}
static CONTROL: OnceLock<Control> = OnceLock::new();
fn control() -> &'static Control {
    CONTROL.get_or_init(Control::default)
}
pub(crate) fn wake() {
    *control()
        .wake
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    control().changed.notify_all();
}
pub(crate) fn stop() {
    control().stop.store(true, Ordering::Release);
    wake();
}
fn wait(duration: Duration) {
    let guard = control()
        .wake
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut guard, _) = control()
        .changed
        .wait_timeout_while(guard, duration, |wake| {
            !*wake && !control().stop.load(Ordering::Acquire)
        })
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *guard = false;
}
fn active(state: &AppState, library: &Library) -> bool {
    !control().stop.load(Ordering::Acquire)
        && state
            .current_library()
            .is_some_and(|current| current.same_runtime(library))
}
fn pause_until(deadline: Instant, active: impl Fn() -> bool) -> bool {
    while Instant::now() < deadline {
        if !active() {
            return false;
        }
        std::thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100)),
        );
    }
    active()
}

#[derive(Debug, PartialEq, Eq)]
enum FetchError {
    Network,
    Invalid,
    Cancelled,
}

struct RequestSchedule {
    next: Instant,
    failures: u8,
}
impl RequestSchedule {
    fn requested(&mut self, now: Instant) {
        self.next = now + Duration::from_secs(1);
    }
    fn completed(&mut self, result: &Result<Vec<u8>, FetchError>, now: Instant) -> bool {
        if *result == Err(FetchError::Network) {
            self.failures += 1;
            if self.failures >= 5 {
                self.next = now + Duration::from_secs(600);
                self.failures = 0;
                return true;
            }
        } else {
            self.failures = 0;
        }
        false
    }
}

/// HTTP is injected here so parsing, partial results and persistence run offline in tests.
fn fetch_volume(
    library: &Library,
    isbn: &str,
    mut get: impl FnMut(&str) -> Result<Vec<u8>, FetchError>,
    is_active: impl Fn() -> bool,
) -> Result<&'static str, FetchError> {
    if !is_active() {
        return Err(FetchError::Cancelled);
    }
    let mut side = library
        .spine_scan_path(isbn, "side")
        .is_some_and(|p| p.is_file());
    let mut back = library
        .spine_scan_path(isbn, "back")
        .is_some_and(|p| p.is_file());
    let result = (|| {
        let html = get(&format!(
            "https://www.yes24.com/product/search?domain=BOOK&query={isbn}"
        ))?;
        let html = String::from_utf8_lossy(&html);
        let Some(goods) = goods_id(&html) else {
            return Ok("not_found");
        };
        for (part, available) in [("side", &mut side), ("back", &mut back)] {
            if !is_active() {
                return Err(FetchError::Cancelled);
            }
            let bytes = get(&format!(
                "https://image.yes24.com/goods/{goods}/{}/XL",
                part.to_ascii_uppercase()
            ))?;
            if !is_active() {
                return Err(FetchError::Cancelled);
            }
            if real_jpeg(&bytes).map_err(|_| FetchError::Invalid)? {
                library
                    .save_spine_bytes(isbn, part, &bytes)
                    .map_err(|_| FetchError::Invalid)?;
                *available = true;
            }
        }
        Ok(if side || back { "real" } else { "missing" })
    })();
    if !is_active() || result == Err(FetchError::Cancelled) {
        return Err(FetchError::Cancelled);
    }
    let status = result.as_ref().copied().unwrap_or("error");
    library
        .save_spine_status(isbn, status, side, back, chrono::Utc::now().timestamp())
        .map_err(|_| FetchError::Invalid)?;
    result
}

pub(crate) fn start(app: tauri::AppHandle, state: AppState) {
    std::thread::Builder::new()
        .name("manga-spine-scans".into())
        .spawn(move || {
            // Never compete with initial window/library loading. New volumes are picked up by
            // the collection change signal, with a cheap 30-second due query as a safety net.
            if !pause_until(Instant::now() + Duration::from_secs(15), || {
                !control().stop.load(Ordering::Acquire)
            }) {
                return;
            }
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .https_only(true)
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(8)))
                .build()
                .into();
            let mut schedule = RequestSchedule {
                next: Instant::now(),
                failures: 0,
            };
            let mut runtime: Option<Library> = None;
            loop {
                if control().stop.load(Ordering::Acquire) {
                    break;
                }
                let Some(library) = state.current_library() else {
                    runtime = None;
                    wait(Duration::from_secs(1));
                    continue;
                };
                if !crate::workload::startup_background_ready() {
                    wait(Duration::from_secs(1));
                    continue;
                }
                if runtime
                    .as_ref()
                    .is_none_or(|old| !old.same_runtime(&library))
                {
                    *control()
                        .progress
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = (
                        library.root().to_string_lossy().into_owned(),
                        Progress::default(),
                    );
                    runtime = Some(library.clone());
                    if !pause_until(Instant::now() + Duration::from_secs(15), || {
                        active(&state, &library)
                    }) {
                        continue;
                    }
                }
                let due = match library.due_spine_isbns(chrono::Utc::now().timestamp()) {
                    Ok(due) => due,
                    Err(_) => {
                        eprintln!("[manga scans] due query failed");
                        wait(Duration::from_secs(30));
                        continue;
                    }
                };
                if due.is_empty() {
                    wait(Duration::from_secs(30));
                    continue;
                }
                {
                    let mut current = control()
                        .progress
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    current.1.queued = due.len();
                }
                for isbn in due {
                    if !active(&state, &library) {
                        break;
                    }
                    let result = fetch_volume(
                        &library,
                        &isbn,
                        |url| {
                            if !pause_until(schedule.next, || active(&state, &library)) {
                                return Err(FetchError::Cancelled);
                            }
                            schedule.requested(Instant::now());
                            let result = (|| {
                                let mut response = agent
                                    .get(url)
                                    .header("User-Agent", "Mozilla/5.0")
                                    .call()
                                    .map_err(|_| FetchError::Network)?;
                                if !response.status().is_success() {
                                    return Err(FetchError::Network);
                                }
                                let mut bytes = Vec::new();
                                response
                                    .body_mut()
                                    .as_reader()
                                    .take(12 * 1024 * 1024 + 1)
                                    .read_to_end(&mut bytes)
                                    .map_err(|_| FetchError::Network)?;
                                if bytes.len() > 12 * 1024 * 1024 {
                                    return Err(FetchError::Invalid);
                                }
                                Ok(bytes)
                            })();
                            if schedule.completed(&result, Instant::now()) {
                                eprintln!(
                                    "[manga scans] repeated HTTP failures; pausing 10 minutes"
                                );
                            }
                            result
                        },
                        || active(&state, &library),
                    );
                    if result == Err(FetchError::Cancelled) {
                        break;
                    }
                    {
                        let mut current = control()
                            .progress
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let progress = &mut current.1;
                        progress.queued = progress.queued.saturating_sub(1);
                        progress.done += 1;
                        match result {
                            Ok("real") => progress.real += 1,
                            Ok("missing") => progress.missing += 1,
                            Ok("not_found") => progress.not_found += 1,
                            _ => progress.errors += 1,
                        }
                    }
                    // Separate from collections-changed: refresh scan projections without
                    // acknowledging notifications or changing authoritative Work metadata.
                    let _ = app.emit("library://manga-scans-changed", &isbn);
                }
                let current = control()
                    .progress
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                eprintln!(
                    "[manga scans] done={} real={} missing={} not_found={} errors={} queued={}",
                    current.1.done,
                    current.1.real,
                    current.1.missing,
                    current.1.not_found,
                    current.1.errors,
                    current.1.queued
                );
                drop(current);
                wait(Duration::from_secs(30));
            }
        })
        .expect("start manga scan worker");
}

/// `start: true` wakes the worker; it never bypasses retry deadlines or rate limits.
#[tauri::command]
pub(crate) fn manga_spine_scan_progress(
    state: tauri::State<'_, AppState>,
    start: Option<bool>,
) -> Progress {
    if start == Some(true) {
        wake();
    }
    let current = control()
        .progress
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state
        .current_library()
        .is_some_and(|lib| lib.root().to_string_lossy() == current.0)
    {
        current.1.clone()
    } else {
        Progress::default()
    }
}

#[cfg(test)]
mod manga_spine_fetch_tests {
    use super::*;
    const ISBN: &str = "9780000000001";
    const SIDE: &[u8] = include_bytes!("library/fixtures/yes24-side.jpg");
    const PLACEHOLDER: &[u8] = include_bytes!("library/fixtures/yes24-placeholder.jpg");
    #[test]
    fn every_request_is_paced_and_five_network_failures_pause_for_ten_minutes() {
        let now = Instant::now();
        let mut schedule = RequestSchedule {
            next: now,
            failures: 0,
        };
        for index in 0..5 {
            let at = now + Duration::from_secs(index);
            schedule.requested(at);
            assert_eq!(schedule.next, at + Duration::from_secs(1));
            assert_eq!(
                schedule.completed(&Err(FetchError::Network), at),
                index == 4
            );
        }
        assert_eq!(schedule.next, now + Duration::from_secs(604));
        schedule.completed(&Err(FetchError::Network), now);
        schedule.completed(&Ok(vec![]), now);
        assert_eq!(schedule.failures, 0);
        assert!(!pause_until(now + Duration::from_secs(600), || false));
    }
    #[test]
    fn offline_fetch_persists_real_parts_and_status_without_placeholder_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let mut calls = Vec::new();
        let result = fetch_volume(
            &library,
            ISBN,
            |url| {
                calls.push(url.to_owned());
                Ok(if url.contains("search?") {
                    b"/goods/123".to_vec()
                } else if url.contains("/SIDE/") {
                    SIDE.to_vec()
                } else {
                    PLACEHOLDER.to_vec()
                })
            },
            || true,
        );
        assert_eq!(result, Ok("real"));
        assert_eq!(calls.len(), 3);
        assert_eq!(
            std::fs::read(library.spine_scan_path(ISBN, "side").unwrap()).unwrap(),
            SIDE
        );
        assert!(!library.spine_scan_path(ISBN, "back").unwrap().exists());
        assert!(library.spine_scan(ISBN).unwrap().unwrap().side.is_some());
        assert!(library
            .due_spine_isbns(chrono::Utc::now().timestamp())
            .unwrap()
            .is_empty());
        let stored: (String, bool, bool) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT status,side,back FROM manga_spine_scans WHERE isbn13=?1",
                [ISBN],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored, ("real".into(), true, false));
    }
    #[test]
    fn not_found_errors_and_cancellation_are_distinct() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        assert_eq!(
            fetch_volume(&library, ISBN, |_| Ok(b"no results".to_vec()), || true),
            Ok("not_found")
        );
        assert_eq!(
            fetch_volume(&library, ISBN, |_| Err(FetchError::Network), || true),
            Err(FetchError::Network)
        );
        assert_eq!(
            fetch_volume(&library, ISBN, |_| Err(FetchError::Cancelled), || false),
            Err(FetchError::Cancelled)
        );
        let status: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT status FROM manga_spine_scans WHERE isbn13=?1",
                [ISBN],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "error");
    }
    #[test]
    fn a_failed_back_keeps_the_real_side_and_cancellation_prevents_writes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let result = fetch_volume(
            &library,
            ISBN,
            |url| {
                if url.contains("search?") {
                    Ok(b"goods/123".to_vec())
                } else if url.contains("SIDE") {
                    Ok(SIDE.to_vec())
                } else {
                    Err(FetchError::Network)
                }
            },
            || true,
        );
        assert_eq!(result, Err(FetchError::Network));
        assert!(library.spine_scan(ISBN).unwrap().unwrap().side.is_some());
        let active = AtomicBool::new(true);
        let result = fetch_volume(
            &library,
            "9780000000002",
            |url| {
                if url.contains("search?") {
                    Ok(b"goods/456".to_vec())
                } else {
                    active.store(false, Ordering::Release);
                    Ok(SIDE.to_vec())
                }
            },
            || active.load(Ordering::Acquire),
        );
        assert_eq!(result, Err(FetchError::Cancelled));
        assert!(!library
            .spine_scan_path("9780000000002", "side")
            .unwrap()
            .exists());
        assert!(library.spine_scan("9780000000002").unwrap().is_none());
    }
}
