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
        object.insert(
            "processMs".into(),
            serde_json::json!(launch.start.elapsed().as_secs_f64() * 1000.0),
        );
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
}
