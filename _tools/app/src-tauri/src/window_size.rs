//! Remembers the main window's size (and whether it was maximized) across launches, in
//! `window-size.json` beside the other per-machine app settings (user request 2026-09-28).

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, Manager, WebviewWindow};

const FILE: &str = "window-size.json";
/// The window's configured minimum (tauri.conf.json); a stored size never goes below it.
const MIN: (f64, f64) = (960.0, 640.0);
/// Resize events arrive continuously while dragging; the size is written at most this often,
/// and once more when the window closes.
const WRITE_EVERY: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Stored {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// A trailing write is pending after a burst of resize events.
static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);
/// The latest size, the size last written to disk, and when that write happened.
static LAST: Mutex<Option<(Stored, Option<Stored>, Instant)>> = Mutex::new(None);

fn path(window: &WebviewWindow) -> Option<PathBuf> {
    window
        .app_handle()
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FILE))
}

/// A stored size within sane bounds, or none for a missing or broken file.
pub(crate) fn parse(text: &str) -> Option<Stored> {
    let stored: Stored = serde_json::from_str(text).ok()?;
    if !(stored.width.is_finite() && stored.height.is_finite())
        || stored.width > 20_000.0
        || stored.height > 20_000.0
    {
        return None;
    }
    Some(Stored {
        width: stored.width.max(MIN.0),
        height: stored.height.max(MIN.1),
        ..stored
    })
}

/// Applies the remembered size at startup; the configured default stays when there is none.
pub(crate) fn restore(window: &WebviewWindow) {
    let Some(stored) = path(window)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse(&text))
    else {
        return;
    };
    let _ = window.set_size(LogicalSize::new(stored.width, stored.height));
    if stored.maximized {
        let _ = window.maximize();
    }
    *LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((stored, Some(stored), Instant::now()));
}

/// Records the current size; `force` writes even inside the throttle window (on close).
pub(crate) fn remember(window: &WebviewWindow, force: bool) {
    let maximized = window.is_maximized().unwrap_or(false);
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // While maximized, keep the last normal size so un-maximizing next launch restores it.
    let (width, height) = match (maximized, *last) {
        (true, Some((previous, _, _))) => (previous.width, previous.height),
        _ => {
            let Ok(size) = window.inner_size() else {
                return;
            };
            let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
            (
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        }
    };
    if width < 1.0 || height < 1.0 {
        return; // minimized
    }
    let next = Stored {
        width: width.round(),
        height: height.round(),
        maximized,
    };
    if let Some((_, written, at)) = *last {
        // Nothing new on disk to write, or a write happened moments ago: keep the latest size
        // in memory; a trailing write (or closing the window) puts it on disk.
        if written == Some(next) || (!force && at.elapsed() < WRITE_EVERY) {
            *last = Some((next, written, at));
            // The last resize of a drag must still reach the disk even if no event follows.
            if written != Some(next) && !FLUSH_SCHEDULED.swap(true, Ordering::SeqCst) {
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(WRITE_EVERY);
                    FLUSH_SCHEDULED.store(false, Ordering::SeqCst);
                    remember(&window, true);
                });
            }
            return;
        }
    }
    *last = Some((next, Some(next), Instant::now()));
    drop(last);
    if let Some(path) = path(window) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(&next) {
            let _ = std::fs::write(path, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_sizes_are_read_leniently_and_clamped_to_the_minimum() {
        assert_eq!(
            parse(r#"{"width":1600,"height":900}"#),
            Some(Stored {
                width: 1600.0,
                height: 900.0,
                maximized: false
            })
        );
        assert_eq!(
            parse(r#"{"width":500,"height":300,"maximized":true}"#),
            Some(Stored {
                width: 960.0,
                height: 640.0,
                maximized: true
            })
        );
        assert_eq!(parse("not json"), None);
        assert_eq!(parse(r#"{"width":1e9,"height":900}"#), None);
    }
}
