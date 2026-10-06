//! Opt-in, bounded timing output. Failures must never affect the application.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_LINE: usize = 4096;
const MAX_FILE: u64 = 5 * 1024 * 1024;
struct Launch {
    enabled: bool,
    start: Instant,
    unix_ms: u128,
    id: String,
}
static LAUNCH: OnceLock<Launch> = OnceLock::new();
static WRITER: Mutex<()> = Mutex::new(());
static NATIVE_LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(crate) fn startup_enabled() -> bool {
    LAUNCH
        .get()
        .is_some_and(|launch| launch.enabled && launch.start.elapsed().as_secs() < 15)
}

/// Startup diagnostics are buffered in memory: never do log I/O under a library lock.
pub(crate) fn startup_record(name: &str, fields: serde_json::Value) {
    let Some(launch) = LAUNCH
        .get()
        .filter(|launch| launch.enabled && launch.start.elapsed().as_secs() < 15)
    else {
        return;
    };
    let line = serde_json::json!({
        "event": "native-startup", "name": name,
        "processMs": launch.start.elapsed().as_secs_f64() * 1000.0,
        "fields": fields,
    })
    .to_string();
    if let Ok(mut lines) = NATIVE_LINES.lock() {
        if lines.len() < 2048 {
            lines.push(line);
        }
    }
}

pub(crate) struct StartupSpan {
    name: &'static str,
    start: Instant,
    caller: &'static std::panic::Location<'static>,
}

impl StartupSpan {
    #[track_caller]
    pub(crate) fn start(name: &'static str) -> Option<Self> {
        let launch = LAUNCH.get()?;
        let caller = std::panic::Location::caller();
        (launch.enabled && launch.start.elapsed().as_secs() < 15).then(|| Self {
            name,
            start: Instant::now(),
            caller,
        })
    }
}

impl Drop for StartupSpan {
    fn drop(&mut self) {
        startup_record(
            self.name,
            serde_json::json!({
                "durationMs": self.start.elapsed().as_secs_f64() * 1000.0,
                "source": self.caller.file(), "line": self.caller.line(),
            }),
        );
    }
}

pub(crate) fn startup_handler(
    handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        let command = startup_enabled().then(|| invoke.message.command().to_string());
        let started = Instant::now();
        if let Some(command) = command.as_ref() {
            startup_record("ipc.received", serde_json::json!({ "command": command }));
        }
        let handled = handler(invoke);
        if let Some(command) = command {
            startup_record(
                "ipc.dispatch",
                serde_json::json!({
                    "command": command, "durationMs": started.elapsed().as_secs_f64() * 1000.0,
                }),
            );
        }
        handled
    }
}

/// Called at the first statement of main; run also supports library entry points.
pub fn init() {
    LAUNCH.get_or_init(|| {
        let start = Instant::now();
        let enabled = std::env::var_os("LAKOMICS_PERF").is_some_and(|value| value == "1");
        let unix_ms = if enabled {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|v| v.as_millis())
                .unwrap_or(0)
        } else {
            0
        };
        Launch {
            enabled,
            start,
            unix_ms,
            id: if enabled {
                uuid::Uuid::new_v4().to_string()
            } else {
                String::new()
            },
        }
    });
}
#[tauri::command]
pub fn perf_log_enabled() -> bool {
    LAUNCH.get().is_some_and(|launch| launch.enabled)
}

fn append(path: &Path, lines: &[String], launch: &Launch) {
    if !launch.enabled {
        return;
    }
    let Ok(_guard) = WRITER.lock() else {
        return;
    };
    if fs::metadata(path)
        .map(|m| m.len() >= MAX_FILE)
        .unwrap_or(false)
    {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let mut size = metadata.len();
    for line in lines.iter().take(256) {
        if line.len() > MAX_LINE {
            continue;
        }
        let Ok(serde_json::Value::Object(mut object)) = serde_json::from_str(line) else {
            continue;
        };
        object
            .entry("processMs")
            .or_insert_with(|| serde_json::json!(launch.start.elapsed().as_secs_f64() * 1000.0));
        object.insert("launchId".into(), serde_json::json!(launch.id));
        let Ok(mut bytes) = serde_json::to_vec(&object) else {
            continue;
        };
        bytes.push(b'\n');
        if size + bytes.len() as u64 > MAX_FILE {
            break;
        }
        if file.write_all(&bytes).is_err() {
            break;
        }
        size += bytes.len() as u64;
    }
}
#[tauri::command]
pub async fn perf_log_append(app: tauri::AppHandle, lines: Vec<String>) {
    let Some(launch) = LAUNCH.get().filter(|launch| launch.enabled) else {
        return;
    };
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    let path = directory.join("perf").join(format!(
        "pc-timing-{}.jsonl",
        chrono::Local::now().format("%Y%m%d")
    ));
    let _ = tauri::async_runtime::spawn_blocking(move || append(&path, &lines, launch)).await;
}
pub fn setup(app: &tauri::AppHandle) {
    if !perf_log_enabled() {
        return;
    }
    if let Some(launch) = LAUNCH.get() {
        let handle = app.clone();
        let lines = vec![serde_json::json!({"event":"native", "name":"nativeSetup", "processStartUnixMs":launch.unix_ms}).to_string()];
        tauri::async_runtime::spawn(async move {
            perf_log_append(handle, lines).await;
        });
        let Ok(directory) = app.path().app_log_dir() else {
            return;
        };
        let path = directory.join("perf").join(format!(
            "pc-timing-{}.jsonl",
            chrono::Local::now().format("%Y%m%d")
        ));
        // Independent of renderer IPC so a blocked UI cannot hide native timings.
        let _ = std::thread::Builder::new()
            .name("startup-perf-log".into())
            .spawn(move || {
                for _ in 0..16 {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let lines = NATIVE_LINES
                        .lock()
                        .map(|mut lines| std::mem::take(&mut *lines))
                        .unwrap_or_default();
                    for batch in lines.chunks(256) {
                        append(&path, batch, launch);
                    }
                }
            });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn launch(enabled: bool) -> Launch {
        Launch {
            enabled,
            start: Instant::now(),
            unix_ms: 0,
            id: "test-launch".into(),
        }
    }
    #[test]
    fn disabled_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perf/log.jsonl");
        append(&path, &["{}".into()], &launch(false));
        assert!(!path.exists());
    }
    #[test]
    fn bounds_and_enriches_json_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        append(
            &path,
            &[
                "invalid".into(),
                "[]".into(),
                "x".repeat(MAX_LINE + 1),
                "{\"event\":\"measure\",\"launchId\":\"forged\"}".into(),
            ],
            &launch(true),
        );
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 1);
        let value: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(value["launchId"], "test-launch");
        assert!(value["processMs"].as_f64().unwrap() >= 0.0);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_FILE - 2)
            .unwrap();
        append(&path, &["{}".into()], &launch(true));
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_FILE - 2);
    }
    #[test]
    fn io_errors_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &["{}".into()], &launch(true));
    }
    #[test]
    fn buffered_native_time_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        append(&path, &["{\"processMs\":123.5}".into()], &launch(true));
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(value["processMs"], 123.5);
    }
}
