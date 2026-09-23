//! One owned child, one in-flight query, bounded output and cancellable deadlines.
use super::characters::{Error, Result};
use serde_json::Value;
use std::collections::BTreeSet;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

pub(super) const BASELINE: &str =
    "40246ab31230e100e9592811d032e7383959ad168c1c738520003993bf357199";
const MAX_MESSAGE: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RuntimeConfig {
    pub(super) python: PathBuf,
    pub(super) script: PathBuf,
    pub(super) models: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) augmentation_model: Option<PathBuf>,
    #[serde(default)]
    pub(super) s36_shadow_disabled: bool,
    #[serde(skip)]
    pub(super) shadow_model: Option<PathBuf>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedRuntime {
    #[serde(flatten)]
    runtime: RuntimeConfig,
    #[serde(default)]
    augmentation_disabled: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AugmentationSettings {
    pub enabled: bool,
    pub shadow_enabled: bool,
    pub model_name: Option<String>,
    pub model_ready: bool,
    pub runtime_configured: bool,
    pub managed_by_environment: bool,
}

impl SavedRuntime {
    fn effective(&self) -> RuntimeConfig {
        let mut config = self.runtime.clone();
        config.shadow_model = if config.s36_shadow_disabled {
            None
        } else {
            config.augmentation_model.clone()
        };
        if self.augmentation_disabled {
            config.augmentation_model = None;
        }
        config
    }
}

impl RuntimeConfig {
    fn load(script: PathBuf, settings: &Path) -> Result<SavedRuntime> {
        let baseline_override = std::env::var_os("LAKOMICS_CHARACTER_PYTHON").is_some()
            || std::env::var_os("LAKOMICS_CHARACTER_MODELS").is_some();
        let saved = if settings.is_file() {
            let loaded = std::fs::read(settings)
                .map_err(Error::from)
                .and_then(|bytes| {
                    serde_json::from_slice::<SavedRuntime>(&bytes).map_err(Error::from)
                });
            match loaded {
                Ok(saved) => Some(saved),
                Err(_) if baseline_override => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let path = |key| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .ok_or_else(|| Error::Worker(format!("캐릭터 런타임 설정이 필요합니다: {key}")))
        };
        let mut config = if std::env::var_os("LAKOMICS_CHARACTER_PYTHON").is_some()
            || std::env::var_os("LAKOMICS_CHARACTER_MODELS").is_some()
        {
            Self {
                python: path("LAKOMICS_CHARACTER_PYTHON")?,
                models: path("LAKOMICS_CHARACTER_MODELS")?,
                script,
                s36_shadow_disabled: saved
                    .as_ref()
                    .is_some_and(|s| s.runtime.s36_shadow_disabled),
                shadow_model: None,
                augmentation_model: saved
                    .as_ref()
                    .and_then(|saved| saved.runtime.augmentation_model.clone()),
            }
        } else if let Some(saved) = &saved {
            let mut runtime = saved.runtime.clone();
            runtime.script = script;
            runtime
        } else {
            return Err(Error::Invalid(
                "초기 설정에서 Python과 모델 폴더를 지정해 주세요.",
            ));
        };
        let mut disabled = saved
            .as_ref()
            .is_some_and(|saved| saved.augmentation_disabled);
        if config.augmentation_model.is_none() {
            config.augmentation_model =
                Some(config.models.join("augmentation").join("model_feat.onnx"));
            // Installing weights must not opt existing runtimes into classification.
            disabled = true;
        }
        if let Some(path) = std::env::var_os("LAKOMICS_CHARACTER_AUGMENTATION_MODEL") {
            config.augmentation_model = (!path.is_empty()).then(|| PathBuf::from(path));
            disabled = false;
        }
        Ok(SavedRuntime {
            runtime: config,
            augmentation_disabled: disabled,
        })
    }

    pub(crate) fn configured(script: PathBuf, settings: &Path) -> Result<Self> {
        let mut config = Self::load(script, settings)?.effective();
        // Optional failures must never invalidate an otherwise working native runtime.
        if config
            .augmentation_model
            .as_ref()
            .is_some_and(|path| !path.is_absolute() || !path.is_file())
        {
            config.augmentation_model = None;
        }
        if config
            .shadow_model
            .as_ref()
            .is_some_and(|path| !path.is_absolute() || !path.is_file())
        {
            config.shadow_model = None;
        }
        if !config.python.is_absolute()
            || !config.python.is_file()
            || !config.script.is_file()
            || !config.models.is_absolute()
            || !config.models.is_dir()
        {
            return Err(Error::Invalid("캐릭터 런타임 파일을 찾을 수 없습니다."));
        }
        Ok(config)
    }

    pub(crate) fn augmentation_settings(
        script: PathBuf,
        settings: &Path,
    ) -> Result<AugmentationSettings> {
        let managed = std::env::var_os("LAKOMICS_CHARACTER_AUGMENTATION_MODEL").is_some();
        if !settings.is_file()
            && std::env::var_os("LAKOMICS_CHARACTER_PYTHON").is_none()
            && std::env::var_os("LAKOMICS_CHARACTER_MODELS").is_none()
        {
            return Ok(AugmentationSettings {
                enabled: false,
                shadow_enabled: false,
                model_name: None,
                model_ready: false,
                runtime_configured: false,
                managed_by_environment: managed,
            });
        }
        let saved = Self::load(script.clone(), settings)?;
        let model = saved.runtime.augmentation_model.as_deref();
        Ok(AugmentationSettings {
            enabled: !saved.augmentation_disabled && model.is_some(),
            shadow_enabled: !saved.runtime.s36_shadow_disabled
                && model.is_some_and(|path| check_augmentation_model(path).is_ok()),
            model_name: model
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().into_owned()),
            model_ready: model.is_some_and(|path| check_augmentation_model(path).is_ok()),
            runtime_configured: Self::configured(script, settings).is_ok(),
            managed_by_environment: managed,
        })
    }

    pub(crate) fn update_augmentation(
        script: PathBuf,
        settings: &Path,
        enabled: bool,
    ) -> Result<AugmentationSettings> {
        if std::env::var_os("LAKOMICS_CHARACTER_AUGMENTATION_MODEL").is_some() {
            return Err(Error::Invalid(
                "환경 변수로 지정된 보완 설정입니다. 환경 변수를 해제하고 앱을 다시 시작해 주세요.",
            ));
        }
        let before = if settings.exists() {
            Some(std::fs::read(settings)?)
        } else {
            None
        };
        let mut saved = Self::load(script.clone(), settings)?;

        saved.augmentation_disabled = !enabled;
        if enabled {
            let model = saved
                .runtime
                .augmentation_model
                .as_deref()
                .ok_or(Error::Invalid("설치된 경량 보완 모델을 찾을 수 없습니다."))?;
            check_augmentation_model(model)?;
            let temp = tempfile::tempdir()?;
            let mut worker = Worker::start(
                &saved.effective(),
                temp.path(),
                Arc::new(AtomicBool::new(false)),
            )?;
            let ready = worker.receive()?;
            if ready["type"] != "ready"
                || ready["baselineFingerprint"] != BASELINE
                || ready["augmentationAvailable"] != true
            {
                return Err(Error::Invalid(
                    "보완 모델을 사용할 수 없습니다. 분석 환경과 모델 파일을 확인해 주세요.",
                ));
            }
        }
        let current = if settings.exists() {
            Some(std::fs::read(settings)?)
        } else {
            None
        };
        if before != current {
            return Err(Error::Stale);
        }
        let parent = settings
            .parent()
            .ok_or(Error::Invalid("설정 경로가 없습니다."))?;
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&serde_json::to_vec(&saved)?)?;
        temporary
            .persist(settings)
            .map_err(|e| Error::Io(e.error))?;
        Self::augmentation_settings(script, settings)
    }

    pub(crate) fn update_shadow(
        script: PathBuf,
        settings: &Path,
        enabled: bool,
    ) -> Result<AugmentationSettings> {
        let before = std::fs::read(settings).ok();
        let saved = Self::load(script.clone(), settings)?;
        if enabled {
            check_augmentation_model(
                saved
                    .runtime
                    .augmentation_model
                    .as_deref()
                    .ok_or(Error::Invalid("설치된 S36 모델을 찾을 수 없습니다."))?,
            )?;
        }
        // Persist only the switch. Environment overrides must never turn into
        // saved augmentation activation as a side effect of changing shadow.
        let mut document: Value = match &before {
            Some(bytes) => serde_json::from_slice(bytes)?,
            None => {
                let mut value = serde_json::to_value(&saved)?;
                value["augmentation_disabled"] = Value::Bool(true);
                value
            }
        };
        document
            .as_object_mut()
            .ok_or(Error::Invalid("Invalid runtime settings"))?
            .insert("s36_shadow_disabled".into(), Value::Bool(!enabled));
        if std::fs::read(settings).ok() != before {
            return Err(Error::Stale);
        }
        let parent = settings
            .parent()
            .ok_or(Error::Invalid("설정 경로가 없습니다."))?;
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&serde_json::to_vec(&document)?)?;
        temporary
            .persist(settings)
            .map_err(|e| Error::Io(e.error))?;
        Self::augmentation_settings(script, settings)
    }

    pub(crate) fn setup(
        python: PathBuf,
        models: PathBuf,
        script: PathBuf,
        settings: &Path,
    ) -> Result<()> {
        let config = Self {
            python,
            models,
            script,
            augmentation_model: None,
            s36_shadow_disabled: false,
            shadow_model: None,
        };
        let temp = tempfile::tempdir()?;
        let mut worker = Worker::start(&config, temp.path(), Arc::new(AtomicBool::new(false)))?;
        let ready = worker.receive()?;
        if ready["type"] != "ready" || ready["baselineFingerprint"] != BASELINE {
            return Err(Error::Worker(
                ready["error"]
                    .as_str()
                    .unwrap_or("런타임 검증에 실패했습니다.")
                    .into(),
            ));
        }
        let parent = settings
            .parent()
            .ok_or(Error::Invalid("설정 경로가 없습니다."))?;
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&serde_json::to_vec(&config)?)?;
        temporary
            .persist(settings)
            .map_err(|e| Error::Io(e.error))?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VerifiedModelKey {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
}

fn check_augmentation_model(path: &Path) -> Result<()> {
    use sha2::{Digest, Sha256};
    static VERIFIED_MODEL: OnceLock<Mutex<Option<VerifiedModelKey>>> = OnceLock::new();

    if !path.is_absolute() || !path.is_file() {
        return Err(Error::Invalid("경량 보완 모델 파일을 찾을 수 없습니다."));
    }
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > 512 * 1024 * 1024 {
        return Err(Error::Invalid("지원하는 경량 보완 모델이 아닙니다."));
    }
    let key = VerifiedModelKey {
        path: path.canonicalize()?,
        len: metadata.len(),
        modified: metadata.modified()?,
    };
    let mut verified = VERIFIED_MODEL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if verified.as_ref() == Some(&key) {
        return Ok(());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let hash = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if hash != "484ad463f569ab95308cf47e91ba358b01c40bc53289b90b950b94fcde7f2628" {
        return Err(Error::Invalid(
            "설치된 보완 모델이 지원하는 S36 파일과 다릅니다. 보완 모델 설치를 확인해 주세요.",
        ));
    }
    let current = std::fs::metadata(path)?;
    if current.len() == key.len && current.modified()? == key.modified {
        *verified = Some(key);
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaCompareWire<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    asset_id: &'a str,
    #[serde(rename = "hash")]
    content_hash: &'a str,
    old_evidence: &'a Value,
    added_references: &'a [Value],
}

pub(super) fn delta_compare_request(
    asset_id: &str,
    content_hash: &str,
    old_evidence: &Value,
    added_references: &[Value],
) -> Result<Value> {
    if !(1..=20).contains(&added_references.len()) || !old_evidence.is_object() {
        return Err(Error::Invalid("추가 레퍼런스 요청을 확인해 주세요."));
    }
    let old_hashes = old_evidence["referenceHashes"]
        .as_array()
        .ok_or(Error::Invalid("기존 레퍼런스 증거가 없습니다."))?
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let mut added_hashes = BTreeSet::new();
    for reference in added_references {
        let hash = reference["hash"]
            .as_str()
            .ok_or(Error::Invalid("추가 레퍼런스 hash가 없습니다."))?;
        if reference["path"].as_str().is_none()
            || old_hashes.contains(hash)
            || !added_hashes.insert(hash)
        {
            return Err(Error::Invalid(
                "추가 레퍼런스는 기존과 겹치지 않는 이미지여야 합니다.",
            ));
        }
    }
    Ok(serde_json::to_value(DeltaCompareWire {
        kind: "compare_delta",
        asset_id,
        content_hash,
        old_evidence,
        added_references,
    })?)
}

pub(super) struct Worker {
    child: Child,
    input: mpsc::SyncSender<Vec<u8>>,
    output: mpsc::Receiver<Result<Value>>,
    cancel: Arc<AtomicBool>,
}

/// One Python owner for both manual scans and the incremental queue. Ownership
/// is borrowed for one query/asset, not for an entire historical inventory.
#[derive(Default)]
pub(super) struct Pool {
    session: std::sync::Mutex<Option<(RuntimeConfig, Worker, Value)>>,
    manual_waiters: std::sync::atomic::AtomicUsize,
}
impl std::fmt::Debug for Pool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CharacterWorkerPool")
    }
}
impl Pool {
    pub(super) fn with<T>(
        &self,
        config: &RuntimeConfig,
        cache: &Path,
        cancel: Arc<AtomicBool>,
        manual: bool,
        work: impl FnOnce(&mut Worker, &Value) -> Result<T>,
    ) -> Result<T> {
        if manual {
            self.manual_waiters.fetch_add(1, Ordering::AcqRel);
        }
        let mut guard = loop {
            if cancel.load(Ordering::Acquire) {
                if manual {
                    self.manual_waiters.fetch_sub(1, Ordering::AcqRel);
                }
                return Err(Error::Worker("취소됨".into()));
            }
            if manual || self.manual_waiters.load(Ordering::Acquire) == 0 {
                match self.session.try_lock() {
                    Ok(guard) => break guard,
                    Err(std::sync::TryLockError::Poisoned(error)) => {
                        let mut guard = error.into_inner();
                        *guard = None;
                        self.session.clear_poison();
                        break guard;
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {}
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if manual {
            self.manual_waiters.fetch_sub(1, Ordering::AcqRel);
        }
        if guard
            .as_ref()
            .is_some_and(|(previous, _, _)| previous != config)
        {
            *guard = None;
        }
        if guard.is_none() {
            let mut worker = Worker::start(config, cache, cancel.clone())?;
            let ready = worker.receive()?;
            if ready["type"] != "ready" || ready["baselineFingerprint"] != BASELINE {
                return Err(Error::Worker("캐릭터 런타임 검증 실패".into()));
            }
            *guard = Some((config.clone(), worker, ready));
        }
        let (_, worker, ready) = guard.as_mut().unwrap();
        worker.cancel = cancel;
        let result = work(worker, ready);
        if result.is_err() {
            *guard = None;
        }
        result
    }
}

impl Worker {
    pub(super) fn start(
        config: &RuntimeConfig,
        cache: &Path,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self> {
        let mut command = Command::new(&config.python);
        command
            .arg("-B")
            .arg(&config.script)
            .arg("--models")
            .arg(&config.models)
            .arg("--cache")
            .arg(cache)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(
                if std::env::var_os("LAKOMICS_CHARACTER_PROFILE").as_deref()
                    == Some(std::ffi::OsStr::new("1"))
                {
                    Stdio::inherit()
                } else {
                    Stdio::null()
                },
            );
        if let Some(model) = config
            .augmentation_model
            .as_ref()
            .or(config.shadow_model.as_ref())
        {
            command.arg("--augmentation-model").arg(model);
        }
        command
            .env("OPENBLAS_NUM_THREADS", "2")
            .env("OMP_NUM_THREADS", "2")
            .env("MKL_NUM_THREADS", "2")
            .env("ORT_DISABLE_TELEMETRY", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::sync_channel(1);
        let (input, requests) = mpsc::sync_channel::<Vec<u8>>(1);
        let errors = sender.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = requests.recv() {
                if let Err(error) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
                    let _ = errors.send(Err(error.into()));
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let result = (&mut reader)
                    .take(MAX_MESSAGE + 1)
                    .read_until(b'\n', &mut line);
                let event = match result {
                    Ok(0) => {
                        let _ = sender.send(Err(Error::Worker(
                            "캐릭터 worker 출력이 종료되었습니다.".into(),
                        )));
                        break;
                    }
                    Ok(_) if line.len() as u64 > MAX_MESSAGE || line.last() != Some(&b'\n') => {
                        Err(Error::Worker("캐릭터 worker 응답 크기/형식 오류".into()))
                    }
                    Ok(_) => serde_json::from_slice(&line).map_err(Error::from),
                    Err(error) => Err(error.into()),
                };
                let failed = event.is_err();
                if sender.send(event).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            output,
            cancel,
        })
    }

    pub(super) fn compare_delta(
        &mut self,
        asset_id: &str,
        content_hash: &str,
        old_evidence: &Value,
        added_references: &[Value],
    ) -> Result<Value> {
        let request =
            delta_compare_request(asset_id, content_hash, old_evidence, added_references)?;
        self.send(&request)?;
        let event = self.receive()?;
        if event["type"] != "result" || event["assetId"] != asset_id {
            return Err(Error::Worker(
                event["error"]
                    .as_str()
                    .unwrap_or("캐릭터 delta 비교 응답이 올바르지 않습니다.")
                    .into(),
            ));
        }
        Ok(event)
    }

    pub(super) fn send(&mut self, request: &Value) -> Result<()> {
        self.check_cancel()?;
        let mut bytes = serde_json::to_vec(request)?;
        if bytes.len() > 128 * 1024 - 1 {
            return Err(Error::Invalid("캐릭터 worker 요청이 너무 큽니다."));
        }
        bytes.push(b'\n');
        self.input.try_send(bytes).map_err(|_| {
            Error::Worker("캐릭터 worker 입력이 대기 중이거나 종료되었습니다.".into())
        })?;
        Ok(())
    }

    pub(super) fn receive(&mut self) -> Result<Value> {
        self.receive_until(Duration::from_secs(120))
    }

    fn receive_until(&mut self, timeout: Duration) -> Result<Value> {
        self.receive_while(timeout, || Ok(true))
    }

    pub(super) fn receive_while(
        &mut self,
        timeout: Duration,
        mut allowed: impl FnMut() -> Result<bool>,
    ) -> Result<Value> {
        let started = Instant::now();
        let mut preempted = false;
        loop {
            self.check_cancel()?;
            if !preempted && !allowed()? {
                self.send(&serde_json::json!({"type":"s36_shadow_cancel"}))?;
                preempted = true;
            }
            if started.elapsed() >= timeout {
                return Err(Error::Worker("캐릭터 worker 응답 시간 초과".into()));
            }
            match self.output.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => return event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => {
                    return Err(Error::Worker(format!(
                        "캐릭터 worker가 종료되었습니다: {:?}",
                        self.child.try_wait()?
                    )))
                }
            }
        }
    }

    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(Error::Worker("취소됨".into()));
        }
        Ok(())
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
#[path = "character_worker_tests.rs"]
mod tests;
