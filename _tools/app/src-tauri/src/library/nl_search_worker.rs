//! Machine-local, offline NDJSON query worker. One session and request at a time.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub(crate) const MAX_MESSAGE: usize = 256 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Config {
    pub python: PathBuf,
    pub runtime: PathBuf,
    pub hf_home: PathBuf,
    pub precise: bool,
}
impl Config {
    pub(crate) fn load(settings: &Path, default_runtime: PathBuf) -> Result<Self> {
        Self::load_with(settings, default_runtime, |key| std::env::var_os(key))
    }
    fn load_with(
        settings: &Path,
        default_runtime: PathBuf,
        environment: impl Fn(&str) -> Option<std::ffi::OsString>,
    ) -> Result<Self> {
        let mut config = if settings.is_file() {
            serde_json::from_slice::<Self>(&std::fs::read(settings).map_err(|e| e.to_string())?)
                .map_err(|e| format!("검색 실행 환경 설정을 읽지 못했습니다: {e}"))?
        } else {
            Self::default()
        };
        if config.runtime.as_os_str().is_empty() {
            config.runtime = default_runtime;
        }
        for (key, value) in [
            ("LAKOMICS_NL_SEARCH_PYTHON", &mut config.python),
            ("LAKOMICS_NL_SEARCH_RUNTIME", &mut config.runtime),
            ("LAKOMICS_NL_SEARCH_HF_HOME", &mut config.hf_home),
        ] {
            if let Some(path) = environment(key) {
                *value = path.into();
            }
        }
        if !config.python.is_file()
            || !config.runtime.join("nl_query_worker.py").is_file()
            || !config.hf_home.is_dir()
        {
            return Err("검색 실행 환경이 설정되지 않았습니다.".into());
        }
        Ok(config)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerStatus {
    pub worker: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_error: Option<String>,
    #[serde(skip)]
    pub qwen: bool,
}
impl Default for WorkerStatus {
    fn default() -> Self {
        Self {
            worker: "stopped",
            worker_error: None,
            qwen: false,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Embedding {
    pub translation: String,
    pub siglip: Vec<f32>,
    pub qwen: Option<Vec<f32>>,
}
pub(crate) fn normalize(mut vector: Vec<f32>, dim: usize) -> Result<Vec<f32>> {
    if vector.len() != dim || vector.iter().any(|v| !v.is_finite()) {
        return Err("검색 벡터의 크기 또는 값이 올바르지 않습니다.".into());
    }
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        return Err("검색 벡터가 비어 있습니다.".into());
    }
    for value in &mut vector {
        *value /= norm;
    }
    Ok(vector)
}
fn vector(value: &Value, dim: usize) -> Result<Vec<f32>> {
    let values: Vec<f32> = serde_json::from_value(value.clone())
        .map_err(|e| format!("검색 worker 벡터 응답 오류: {e}"))?;
    normalize(values, dim)
}
pub(crate) fn parse_embedding(value: Value, id: &str) -> Result<Embedding> {
    if value["id"].as_str() != Some(id) {
        return Err("검색 worker 응답 ID가 올바르지 않습니다.".into());
    }
    if value["ok"] != true {
        return Err(format!(
            "검색 worker 오류: {}",
            value["error"].as_str().unwrap_or("응답 오류")
        ));
    }
    Ok(Embedding {
        translation: value["en"]
            .as_str()
            .ok_or("검색 번역 응답이 올바르지 않습니다.")?
            .into(),
        siglip: vector(&value["siglip"], 1152)?,
        qwen: value.get("qwen8b").map(|v| vector(v, 4096)).transpose()?,
    })
}
pub(crate) fn parse_line(line: &[u8]) -> Result<Value> {
    if line.len() >= MAX_MESSAGE || line.last() != Some(&b'\n') {
        return Err("검색 worker 응답 크기/형식 오류 (256 KiB)".into());
    }
    let value: Value =
        serde_json::from_slice(line).map_err(|e| format!("검색 worker JSON 응답 오류: {e}"))?;
    if !value.is_object() {
        return Err("검색 worker 응답은 JSON 객체여야 합니다.".into());
    }
    Ok(value)
}
fn request_bytes(value: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() >= MAX_MESSAGE {
        return Err("검색 요청이 너무 깁니다 (256 KiB).".into());
    }
    Ok(bytes)
}

struct Worker {
    child: Arc<Mutex<Child>>,
    input: mpsc::SyncSender<Vec<u8>>,
    output: mpsc::Receiver<Result<Value>>,
    last_request: Instant,
}
impl Worker {
    fn start(config: &Config, qwen: bool) -> Result<Self> {
        let mut command = Command::new(&config.python);
        command
            .arg("-B")
            .arg(config.runtime.join("nl_query_worker.py"))
            .args(["--threads", "4"])
            .env("HF_HOME", &config.hf_home)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if qwen {
            command.arg("--with-qwen8b");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("검색 worker를 시작하지 못했습니다: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (input, requests) = mpsc::sync_channel::<Vec<u8>>(1);
        let (sender, output) = mpsc::sync_channel(1);
        let errors = sender.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = requests.recv() {
                if let Err(error) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
                    let _ = errors.send(Err(format!("검색 worker 입력 오류: {error}")));
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let event = match (&mut reader)
                    .take(MAX_MESSAGE as u64)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => Err("검색 worker가 종료되었습니다.".into()),
                    Ok(_) => parse_line(&line),
                    Err(e) => Err(format!("검색 worker 출력 오류: {e}")),
                };
                let failed = event.is_err();
                if sender.send(event).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            input,
            output,
            last_request: Instant::now(),
        })
    }
    fn send(&self, value: &Value) -> Result<()> {
        self.input
            .try_send(request_bytes(value)?)
            .map_err(|_| "검색 worker 입력이 종료되거나 대기 중입니다.".into())
    }
    fn receive(&self, timeout: Duration) -> Result<Value> {
        self.output.recv_timeout(timeout).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => String::from("검색 worker 응답 시간 초과"),
            _ => String::from("검색 worker가 종료되었습니다."),
        })?
    }
    fn shutdown(&self) {
        let _ = self.send(&json!({"op":"shutdown"}));
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .try_wait()
                .ok()
                .flatten()
                .is_some()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Default)]
struct Inner {
    session: Mutex<Option<(Config, Worker)>>,
    status: Mutex<WorkerStatus>,
    // Separate ownership permits app exit to kill a child even during a startup/request wait.
    child: Mutex<Option<Arc<Mutex<Child>>>>,
    closing: AtomicBool,
    prewarming: AtomicBool,
}
#[derive(Clone, Default)]
pub(crate) struct Manager(Arc<Inner>);
impl Manager {
    pub(crate) fn status(&self) -> WorkerStatus {
        if let Ok(mut session) = self.0.session.try_lock() {
            let exited = session.as_ref().is_some_and(|(_, worker)| {
                worker
                    .child
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .try_wait()
                    .map_or(true, |status| status.is_some())
            });
            if exited {
                *session = None;
                *self.0.child.lock().unwrap_or_else(|e| e.into_inner()) = None;
                self.set_status("error", Some("검색 worker가 종료되었습니다.".into()), false);
            }
        }
        self.0
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn set_status(&self, worker: &'static str, error: Option<String>, qwen: bool) {
        *self.0.status.lock().unwrap_or_else(|e| e.into_inner()) = WorkerStatus {
            worker,
            worker_error: error,
            qwen,
        };
    }
    fn start(&self, config: &Config, qwen: bool) -> Result<Worker> {
        self.set_status("starting", None, false);
        let worker = Worker::start(config, qwen)?;
        {
            let mut child = self.0.child.lock().unwrap_or_else(|e| e.into_inner());
            if self.0.closing.load(Ordering::Acquire) {
                return Err("검색 worker가 종료 중입니다.".into());
            }
            *child = Some(worker.child.clone());
        }
        let ready = worker.receive(Duration::from_secs(120))?;
        if ready["type"] == "startup_error" {
            return Err(format!(
                "검색 worker 시작 오류: {}",
                ready["error"].as_str().unwrap_or("ready 응답 오류")
            ));
        }
        if ready["type"] != "ready" {
            return Err("검색 worker 준비 응답이 올바르지 않습니다.".into());
        }
        let actual_qwen = ready["qwen8b"].as_bool().unwrap_or(false);
        self.set_status("ready", None, actual_qwen);
        Ok(worker)
    }
    fn with<T>(&self, config: &Config, work: impl FnOnce(&mut Worker) -> Result<T>) -> Result<T> {
        let mut session = self.0.session.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.closing.load(Ordering::Acquire) {
            return Err("검색 worker가 종료 중입니다.".into());
        }
        if session.as_ref().is_some_and(|(old, _)| old != config) {
            *session = None;
        }
        let result = (|| {
            if session.is_none() {
                // GPU/Qwen is optional. A failed precise startup can still serve CPU SigLIP.
                let worker = match self.start(config, config.precise) {
                    Err(error) if config.precise && error.starts_with("검색 worker 시작 오류:") => {
                        self.start(config, false)?
                    }
                    other => other?,
                };
                *session = Some((config.clone(), worker));
                self.schedule_idle();
            }
            let worker = &mut session.as_mut().unwrap().1;
            worker.last_request = Instant::now();
            let result = work(worker);
            worker.last_request = Instant::now();
            result
        })();
        if let Err(error) = &result {
            *session = None;
            *self.0.child.lock().unwrap_or_else(|e| e.into_inner()) = None;
            self.set_status("error", Some(error.clone()), false);
        }
        result
    }
    pub(crate) fn embed(&self, config: &Config, query: &str) -> Result<Embedding> {
        let id = uuid::Uuid::new_v4().to_string();
        // Reject oversized input before changing the worker state.
        request_bytes(&json!({"id":id,"op":"embed","text":query}))?;
        self.with(config, |worker| {
            worker.send(&json!({"id":id,"op":"embed","text":query}))?;
            parse_embedding(worker.receive(Duration::from_secs(30))?, &id)
        })
    }
    pub(crate) fn prewarm(&self, config: Config) {
        if self.0.prewarming.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = self.clone();
        std::thread::spawn(move || {
            let _ = manager.with(&config, |_| Ok(()));
            manager.0.prewarming.store(false, Ordering::Release);
        });
    }
    fn schedule_idle(&self) {
        let weak = Arc::downgrade(&self.0);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let Some(inner) = weak.upgrade() else {
                break;
            };
            if inner.closing.load(Ordering::Acquire) {
                break;
            }
            let Ok(mut session) = inner.session.try_lock() else {
                continue;
            };
            let Some((_, worker)) = session.as_ref() else {
                break;
            };
            if worker.last_request.elapsed() >= Duration::from_secs(30 * 60) {
                worker.shutdown();
                *session = None;
                *inner.child.lock().unwrap_or_else(|e| e.into_inner()) = None;
                *inner.status.lock().unwrap_or_else(|e| e.into_inner()) = WorkerStatus::default();
                break;
            }
        });
    }
    pub(crate) fn shutdown(&self) {
        self.0.closing.store(true, Ordering::Release);
        if let Some(child) = self
            .0
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        // Worker::drop kills the child even when no Tauri exit callback is available.
        *self.session.get_mut().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(test)]
mod nl_search_tests {
    use super::*;
    #[test]
    fn protocol_limits_and_validation() {
        assert!(parse_line(b"{\"type\":\"ready\"}\n").is_ok());
        assert!(parse_line(b"[]\n").is_err());
        assert!(parse_line(b"{} ").is_err());
        assert!(parse_line(&vec![b' '; MAX_MESSAGE]).is_err());
        assert!(request_bytes(&json!({"text":"x".repeat(MAX_MESSAGE)})).is_err());
        let response = json!({"id":"one","ok":true,"en":"smile","siglip":vec![1.;1152]});
        assert!(parse_embedding(response.clone(), "other").is_err());
        assert_eq!(parse_embedding(response, "one").unwrap().siglip.len(), 1152);
        assert!(
            parse_embedding(json!({"id":"one","ok":false,"error":"failure"}), "one")
                .unwrap_err()
                .contains("failure")
        );
        assert!(normalize(vec![0.; 1152], 1152).is_err());
        assert!(normalize(vec![f32::NAN; 1152], 1152).is_err());
        assert!(normalize(vec![1.; 2], 1152).is_err());
    }

    #[test]
    fn config_default_runtime_and_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("nl-search-runtime.json");
        let runtime = temp.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        let python = temp.path().join("python-fixture");
        std::fs::write(&python, b"fixture").unwrap();
        std::fs::write(runtime.join("nl_query_worker.py"), b"fixture").unwrap();
        std::fs::write(
            &settings,
            serde_json::to_vec(&json!({"python":python,"hfHome":temp.path()})).unwrap(),
        )
        .unwrap();
        let config = Config::load_with(&settings, runtime.clone(), |_| None).unwrap();
        assert_eq!(config.runtime, runtime);
        assert!(!config.precise);
        std::fs::remove_file(config.runtime.join("nl_query_worker.py")).unwrap();
        assert!(Config::load_with(&settings, runtime, |_| None)
            .unwrap_err()
            .contains("검색 실행 환경"));
    }

    #[test]
    #[ignore = "set LAKOMICS_NL_SEARCH_TEST_PYTHON; uses a fixture worker, never models"]
    fn fake_worker_restart_timeout_qwen_fallback_and_exit() {
        let python =
            std::env::var_os("LAKOMICS_NL_SEARCH_TEST_PYTHON").expect("explicit fixture Python");
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("nl_query_worker.py");
        std::fs::write(
            &script,
            r#"
import json, os, sys, time
assert os.environ['HF_HUB_OFFLINE'] == '1'
assert os.environ['TRANSFORMERS_OFFLINE'] == '1'
assert os.environ['PYTHONUTF8'] == '1'
assert sys.argv[1:3] == ['--threads', '4']
if os.path.isfile(os.path.join(os.path.dirname(__file__), 'startup-failure')):
    print(json.dumps({'type':'startup_error','error':'fixture startup failure'}), flush=True)
    sys.exit(1)
if '--with-qwen8b' in sys.argv:
    print(json.dumps({'type':'startup_error','error':'fixture Qwen unavailable'}), flush=True)
    sys.exit(1)
print(json.dumps({'type':'ready','qwen8b':False}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request['op'] == 'shutdown':
        break
    text = request['text']
    if text == 'crash':
        os._exit(2)
    if text == 'hang':
        time.sleep(60)
    if text == 'oversize':
        print('x' * (256 * 1024), flush=True)
        continue
    print(json.dumps({'id':request['id'],'ok':True,'en':'fixture',
        'siglip':[1.0] + [0.0] * 1151}), flush=True)
"#,
        )
        .unwrap();
        let config = Config {
            python: python.into(),
            runtime: temp.path().into(),
            hf_home: temp.path().into(),
            precise: true,
        };
        let manager = Manager::default();
        assert_eq!(manager.status().worker, "stopped");
        assert_eq!(
            manager.embed(&config, "normal").unwrap().translation,
            "fixture"
        );
        assert_eq!(manager.status().worker, "ready");
        assert!(!manager.status().qwen);
        for text in ["crash", "oversize"] {
            assert!(manager.embed(&config, text).is_err());
            assert_eq!(manager.status().worker, "error");
            assert!(manager.embed(&config, "normal").is_ok());
        }
        let child = manager.0.child.lock().unwrap().as_ref().unwrap().clone();
        let timeout: Result<()> = manager.with(&config, |worker| {
            worker.send(&json!({"id":"timeout","op":"embed","text":"hang"}))?;
            worker.receive(Duration::from_millis(50)).map(|_| ())
        });
        assert!(timeout.unwrap_err().contains("시간 초과"));
        assert_eq!(manager.status().worker, "error");
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(manager.embed(&config, "normal").is_ok());
        let child = manager.0.child.lock().unwrap().as_ref().unwrap().clone();
        manager.shutdown();
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(manager.embed(&config, "normal").is_err());
        std::fs::write(temp.path().join("startup-failure"), b"fixture").unwrap();
        let failed = Manager::default();
        assert!(failed
            .embed(&config, "normal")
            .unwrap_err()
            .contains("fixture startup failure"));
        assert_eq!(failed.status().worker, "error");
        assert!(failed.0.child.lock().unwrap().is_none());
    }
}
