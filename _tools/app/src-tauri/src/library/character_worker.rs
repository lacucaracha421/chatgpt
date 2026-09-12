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
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

pub(super) const BASELINE: &str =
    "40246ab31230e100e9592811d032e7383959ad168c1c738520003993bf357199";
const MAX_MESSAGE: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RuntimeConfig {
    pub(super) python: PathBuf,
    pub(super) script: PathBuf,
    pub(super) models: PathBuf,
}

impl RuntimeConfig {
    pub(crate) fn configured(script: PathBuf, settings: &Path) -> Result<Self> {
        let path = |key| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .ok_or_else(|| Error::Worker(format!("캐릭터 런타임 설정이 필요합니다: {key}")))
        };
        let config = if std::env::var_os("LAKOMICS_CHARACTER_PYTHON").is_some()
            || std::env::var_os("LAKOMICS_CHARACTER_MODELS").is_some()
        {
            Self {
                python: path("LAKOMICS_CHARACTER_PYTHON")?,
                models: path("LAKOMICS_CHARACTER_MODELS")?,
                script,
            }
        } else if settings.is_file() {
            let mut saved: Self = serde_json::from_slice(&std::fs::read(settings)?)?;
            saved.script = script;
            saved
        } else {
            return Err(Error::Invalid(
                "초기 설정에서 Python과 모델 폴더를 지정해 주세요.",
            ));
        };
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
        let started = Instant::now();
        loop {
            self.check_cancel()?;
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
