//! Remembers the main window's size (and whether it was maximized) across launches, in
//! `window-size.json` beside the other per-machine app settings (user request 2026-09-28).

use std::{
    path::PathBuf,
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, Manager, WebviewWindow};

const FILE: &str = "window-size.json";
/// The window's configured minimum (tauri.conf.json); a stored size never goes below it.
const MIN: (f64, f64) = (960.0, 640.0);
/// Save after a resize burst settles, and flush before the window closes.
const WRITE_EVERY: Duration = Duration::from_millis(400);
/// Closing never waits longer than this for the final write.
const FLUSH_WAIT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Stored {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// The latest size, including the last normal dimensions while maximized.
static LAST: Mutex<Option<Stored>> = Mutex::new(None);
type SaveRequest = (Stored, Option<mpsc::Sender<()>>);
static WRITER: OnceLock<mpsc::Sender<SaveRequest>> = OnceLock::new();

/// Owns disk writes only: never query a Tauri window from this thread. Window getters
/// wait for the event loop, so doing that while holding LAST can deadlock a resize.
fn save_requests(
    receiver: mpsc::Receiver<SaveRequest>,
    delay: Duration,
    mut write: impl FnMut(Stored) -> bool,
) {
    let mut pending = None;
    let mut written = None;
    loop {
        let request = if pending.is_some() {
            receiver.recv_timeout(delay)
        } else {
            receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
        };
        let (flush, finished) = match request {
            Ok((next, acknowledgement)) => {
                pending = Some(next);
                if acknowledgement.is_none() {
                    continue;
                }
                (acknowledgement, false)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => (None, false),
            Err(mpsc::RecvTimeoutError::Disconnected) => (None, true),
        };
        if let Some(next) = pending.take() {
            if written != Some(next) && write(next) {
                written = Some(next);
            }
        }
        if let Some(acknowledgement) = flush {
            let _ = acknowledgement.send(());
        }
        if finished {
            return;
        }
    }
}

fn write_size(path: &std::path::Path, next: Stored) -> bool {
    let Some(dir) = path.parent() else {
        return false;
    };
    let Ok(text) = serde_json::to_string(&next) else {
        return false;
    };
    std::fs::create_dir_all(dir)
        .and_then(|_| std::fs::write(path, text))
        .is_ok()
}

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
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stored);
}

/// Capture native state before locking; resize persistence never blocks the event loop.
/// `force` waits (bounded) for the disk-only worker on close so the final size survives exit.
pub(crate) fn remember(window: &WebviewWindow, force: bool) {
    let maximized = window.is_maximized().unwrap_or(false);
    let size = window.inner_size().ok().map(|size| {
        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        (
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        )
    });
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // While maximized, keep the last normal size so un-maximizing next launch restores it.
    let (width, height) = match (maximized, *last) {
        (true, Some(previous)) => (previous.width, previous.height),
        _ => match size {
            Some(size) => size,
            None => return,
        },
    };
    if width < 1.0 || height < 1.0 {
        return; // minimized
    }
    let next = Stored {
        width: width.round(),
        height: height.round(),
        maximized,
    };
    if *last == Some(next) && !force {
        return;
    }
    *last = Some(next);
    drop(last);
    let writer = match WRITER.get() {
        Some(writer) => writer,
        None => {
            let Some(path) = path(window) else { return };
            WRITER.get_or_init(|| {
                let (sender, receiver) = mpsc::channel();
                std::thread::spawn(move || {
                    save_requests(receiver, WRITE_EVERY, |next| write_size(&path, next))
                });
                sender
            })
        }
    };
    if force {
        let (sender, receiver) = mpsc::channel();
        if writer.send((next, Some(sender))).is_ok() {
            let _ = receiver.recv_timeout(FLUSH_WAIT);
        }
    } else {
        let _ = writer.send((next, None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: f64) -> Stored {
        Stored {
            width,
            height: 900.0,
            maximized: false,
        }
    }

    #[test]
    fn resize_burst_saves_only_the_final_size_without_another_event() {
        let (sender, receiver) = mpsc::channel();
        let (saved, writes) = mpsc::channel();
        // Queue the whole burst before starting the worker; no timing-dependent producer race.
        for width in 1000..1200 {
            sender.send((size(f64::from(width)), None)).unwrap();
        }
        let worker = std::thread::spawn(move || {
            save_requests(receiver, Duration::from_millis(20), |next| {
                saved.send(next).unwrap();
                true
            })
        });
        let result = writes.recv_timeout(Duration::from_secs(2));
        drop(sender);
        worker.join().unwrap();
        assert_eq!(result.unwrap(), size(1199.0));
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn close_flushes_the_latest_size_without_waiting_for_the_event_loop_or_debounce() {
        let (sender, receiver) = mpsc::channel();
        let (saved, writes) = mpsc::channel();
        let (acknowledgement, completed) = mpsc::channel();
        sender.send((size(1000.0), None)).unwrap();
        let next = Stored {
            maximized: true,
            ..size(1400.0)
        };
        sender.send((next, Some(acknowledgement))).unwrap();
        // Simulate the event loop owning LAST while the persistence worker runs.
        let guard = LAST.lock().unwrap();
        let worker = std::thread::spawn(move || {
            save_requests(receiver, Duration::from_secs(60), |next| {
                saved.send(next).unwrap();
                true
            })
        });
        let result = completed.recv_timeout(Duration::from_secs(2));
        drop(guard);
        drop(sender);
        worker.join().unwrap();
        result.unwrap();
        assert_eq!(writes.recv().unwrap(), next);
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn resize_recording_does_not_wait_for_a_slow_write_and_close_cannot_be_overwritten() {
        let (sender, receiver) = mpsc::channel();
        let (saved, writes) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            save_requests(receiver, Duration::from_millis(20), |next| {
                saved.send(next).unwrap();
                if next == size(1000.0) {
                    blocked.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                true
            })
        });
        sender.send((size(1000.0), None)).unwrap();
        let first = writes.recv_timeout(Duration::from_secs(2));
        // A resize is queued while the previous filesystem write is still blocked.
        sender.send((size(1100.0), None)).unwrap();
        let (acknowledgement, completed) = mpsc::channel();
        sender.send((size(1200.0), Some(acknowledgement))).unwrap();
        release.send(()).unwrap();
        let result = completed.recv_timeout(Duration::from_secs(2));
        // An unchanged resize after close must not write an older or duplicate snapshot.
        sender.send((size(1200.0), None)).unwrap();
        drop(sender);
        worker.join().unwrap();
        assert_eq!(first.unwrap(), size(1000.0));
        result.unwrap();
        assert_eq!(writes.recv().unwrap(), size(1200.0));
        assert!(writes.try_recv().is_err());
    }

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
