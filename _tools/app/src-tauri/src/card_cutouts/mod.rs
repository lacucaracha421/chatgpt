//! "카드 누끼 만들기" (CARD-GACHA-001 slice 4): the PC cuts the characters out of the art that
//! can become SSR/UR/LR cards, keeps a local copy, and uploads it so every device gets the
//! pop-out layer.
//!
//! One native thread owns the job. Each pass asks the server which art still needs a cutout
//! (publisher token), cuts the images this library has with the ToonOut model in a Python
//! child (`character-runtime/card_cutout.py`, same interpreter as character recognition),
//! stores each result in the app data cache keyed by asset id and model, and uploads it.
//! Heavy work follows the workload rules: never in 절약 모드, never while character
//! recognition is working, one image at a time, stopped between images when the gate closes.
//! The model (~490 MB) is downloaded into the app data folder on the first run.
mod cache;
mod job;
mod model;
mod worker;

use crate::{
    activities,
    cloud::client::{card_cutouts::UploadSpec, CloudClient},
    commands::AppState,
    library::{credential, error::LibraryError, Library, MediaVariant},
};
use cache::Cache;
use job::{Env, Gate, GateInputs, JobError, Made, Report};
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub(crate) use cache::{local_url, protocol_file};

/// An original larger than this is not copied for cutting.
const MAX_ORIGINAL_BYTES: u64 = 96 * 1024 * 1024;

struct Signal {
    woken: Mutex<bool>,
    condvar: Condvar,
    stop: AtomicBool,
}

fn signal() -> &'static Signal {
    static SIGNAL: OnceLock<Signal> = OnceLock::new();
    SIGNAL.get_or_init(|| Signal {
        woken: Mutex::new(false),
        condvar: Condvar::new(),
        stop: AtomicBool::new(false),
    })
}

/// Something may have changed (a pack was granted or opened): look again soon.
pub(crate) fn wake() {
    let signal = signal();
    *signal
        .woken
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    signal.condvar.notify_all();
}

/// The app is quitting: end the loop and the model process.
pub(crate) fn stop() {
    signal().stop.store(true, Ordering::Release);
    wake();
}

fn sleep(duration: Duration) {
    let signal = signal();
    let mut woken = signal
        .woken
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !*woken {
        woken = signal
            .condvar
            .wait_timeout(woken, duration)
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
    }
    *woken = false;
}

fn stopped() -> bool {
    signal().stop.load(Ordering::Acquire)
}

/// Starts the job thread. Called once from `setup`.
pub(crate) fn start(app: tauri::AppHandle, state: AppState) {
    let Ok(base) = app.path().app_local_data_dir() else {
        return;
    };
    let root = base.join("card-cutout");
    cache::set_root(root.join("cache"));
    let _ = std::fs::remove_dir_all(root.join("work"));
    let dirs = Dirs {
        cache: Cache::new(root.join("cache")),
        work: root.join("work"),
        models: root.join("models"),
    };
    let spawned = std::thread::Builder::new()
        .name("card-cutouts".into())
        .spawn(move || {
            let mut env = RealEnv::new(app, state, dirs);
            let mut job = job::State::default();
            // Let the window settle before the first heavy decision.
            while !crate::workload::launch_maintenance_ready() && !stopped() {
                sleep(Duration::from_secs(1));
            }
            while !stopped() {
                let library=env.state.current_library();
                let _manual_scope=library.as_ref().map(|library| crate::auto_jobs::ManualScope::owner(library,"cardCutouts"));
                let pass = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    job::run_pass(&mut env, &mut job)
                }))
                .unwrap_or_else(|_| {
                    env.report(Report::Failed("카드 누끼 작업이 중단되었습니다.".into()));
                    job::Pass::Failed
                });
                if matches!(
                    pass,
                    job::Pass::Idle | job::Pass::Closed | job::Pass::Failed
                ) {
                    // Idle: the model process is not kept around (it holds several GB).
                    env.worker = None;
                }
                if let Some(library)=&library {
                    let done=if let job::Pass::Worked {done,..}=pass { done } else { 0 };
                    crate::auto_jobs::progress(library,"cardCutouts",done,done+job.pending,Some(job.pending),Some(job.failed_count()));
                    match pass {
                        job::Pass::Worked { done, failed, .. } => crate::auto_jobs::finish_owner(library,"cardCutouts",failed==0,done),
                        job::Pass::Idle => { if crate::auto_jobs::manual_active(library,"cardCutouts") { crate::auto_jobs::finish_owner(library,"cardCutouts",true,0); } },
                        job::Pass::Failed => crate::auto_jobs::finish_owner(library,"cardCutouts",false,0),
                        job::Pass::Closed if crate::auto_jobs::stopped(library,"cardCutouts") => crate::auto_jobs::finish_owner(library,"cardCutouts",true,0),
                        _ => {}
                    }
                }
                let delay = job.delay(&pass, Instant::now());
                sleep(delay);
            }
        });
    if let Err(error) = spawned {
        eprintln!("card cutouts: thread did not start: {error}");
    }
}

struct Dirs {
    cache: Cache,
    work: PathBuf,
    models: PathBuf,
}

struct Session {
    library: Library,
    client: CloudClient,
    token: credential::CloudCredential,
}

struct RealEnv {
    app: tauri::AppHandle,
    state: AppState,
    dirs: Dirs,
    session: Option<Session>,
    worker: Option<worker::Worker>,
    runtime: Option<(PathBuf, PathBuf)>,
    model: Option<PathBuf>,
}

impl RealEnv {
    fn new(app: tauri::AppHandle, state: AppState, dirs: Dirs) -> Self {
        Self {
            app,
            state,
            dirs,
            session: None,
            worker: None,
            runtime: None,
            model: None,
        }
    }

    /// The Python interpreter and `card_cutout.py` of the configured character runtime.
    fn runtime(&mut self) -> Option<(PathBuf, PathBuf)> {
        let (script, settings) = crate::commands::characters::runtime_paths(&self.app).ok()?;
        let config =
            crate::library::character_worker::RuntimeConfig::configured(script, &settings).ok()?;
        let found = (
            config.python_path().to_path_buf(),
            config.sibling_script("card_cutout.py"),
        );
        found.1.is_file().then(|| {
            self.runtime = Some(found.clone());
            found
        })
    }

    fn session(&mut self, library: &Library) -> Result<(), String> {
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.library.root() == library.root())
        {
            return Ok(());
        }
        self.session = None;
        let config = library.cloud_sync_config().map_err(|e| e.to_string())?;
        let endpoint = config
            .api_base_url
            .filter(|endpoint| !endpoint.trim().is_empty())
            .ok_or("no server")?;
        let client = library.cloud_client(&endpoint).map_err(|e| e.to_string())?;
        let token = credential::read_cloud_publisher_token_os().map_err(|e| e.to_string())?;
        self.session = Some(Session {
            library: library.clone(),
            client,
            token,
        });
        Ok(())
    }

    fn abort(&self) -> impl Fn() -> bool {
        let state=self.state.clone();
        move || stopped() || state.current_library().is_none_or(|library| crate::auto_jobs::stopped(&library,"cardCutouts") || crate::workload::is_restricted() && !crate::auto_jobs::manual(&library,"cardCutouts"))
    }

    fn model_path(&mut self) -> Result<PathBuf, JobError> {
        if let Some(path) = &self.model {
            if path.is_file() {
                return Ok(path.clone());
            }
        }
        let cancel = AtomicBool::new(false);
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut progress = |done: u64, total: u64| {
            // The 작업 row shows the download; at most a few updates per second.
            if stopped() || self.state.current_library().is_none_or(|library| crate::auto_jobs::stopped(&library,"cardCutouts") || crate::workload::is_restricted() && !crate::auto_jobs::manual(&library,"cardCutouts")) {
                cancel.store(true, Ordering::Release);
            }
            if last.elapsed() >= Duration::from_millis(500) || done == total {
                last = Instant::now();
                activities::report(
                    job::KEY,
                    job::KIND,
                    job::LABEL,
                    "running",
                    done,
                    Some(total),
                    Some(format!(
                        "모델 내려받는 중 · {} / {} MB",
                        done >> 20,
                        total >> 20
                    )),
                    None,
                    None,
                    None,
                );
            }
        };
        let result = model::ensure(
            &model::HttpFetch,
            &model::PINNED,
            &self.dirs.models,
            model::override_from_env(),
            &cancel,
            &mut progress,
        );
        match result {
            Ok(path) => {
                self.model = Some(path.clone());
                Ok(path)
            }
            Err(model::ModelError::Cancelled) => Err(JobError::interrupted()),
            Err(error) => Err(JobError::fatal(error.to_string())),
        }
    }

    /// Copies the library original of `id` into the work folder; `None` when this library
    /// does not have it.
    fn original(&self, library: &Library, id: &str) -> Result<Option<PathBuf>, JobError> {
        let media = match library.resolve_media(id, MediaVariant::Asset) {
            Ok(media) => media,
            Err(LibraryError::MediaNotFound | LibraryError::AssetNotFound) => return Ok(None),
            Err(error) => return Err(JobError::asset(error.to_string())),
        };
        if media.length == 0 || media.length > MAX_ORIGINAL_BYTES {
            return Ok(None);
        }
        std::fs::create_dir_all(&self.dirs.work).map_err(|e| JobError::asset(e.to_string()))?;
        let target = self.dirs.work.join(format!("{id}.src"));
        let mut bytes = Vec::with_capacity(media.length as usize);
        media
            .file
            .take(MAX_ORIGINAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| JobError::asset(e.to_string()))?;
        std::fs::write(&target, bytes).map_err(|e| JobError::asset(e.to_string()))?;
        Ok(Some(target))
    }
}

fn gate_inputs(env: &mut RealEnv) -> GateInputs {
    let library = env.state.current_library();
    let session_ok = library
        .as_ref()
        .is_some_and(|library| env.session(library).is_ok());
    if library.is_none() {
        env.session = None;
    }
    GateInputs {
        restricted: crate::workload::is_restricted() && !library.as_ref().is_some_and(|library|crate::auto_jobs::manual(library,"cardCutouts")),
        has_library: library.is_some(),
        cloud_ready: session_ok
            || library.as_ref().is_some_and(|l| {
                l.cloud_sync_config()
                    .is_ok_and(|c| c.api_base_url.is_some_and(|url| !url.trim().is_empty()))
            }),
        has_token: session_ok,
        runtime_ready: env.runtime.is_some() || env.runtime().is_some(),
        character_busy: library.as_ref().is_some_and(Library::character_work_active),
    }
}

impl Env for RealEnv {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn gate(&mut self) -> Gate {
        if stopped() {
            return Gate::Closed {
                reason: "앱을 닫는 중",
                visible: false,
            };
        }
        if self.state.current_library().is_some_and(|library|crate::auto_jobs::stopped(&library,"cardCutouts")) {
            return Gate::Closed { reason: "일시 정지됨", visible: true };
        }
        let inputs = gate_inputs(self);
        if let Some(library)=self.state.current_library() {
            let unconfigured=if !inputs.cloud_ready { Some("noServer") } else if !inputs.has_token || !inputs.runtime_ready { Some("noProviderKey") } else { None };
            crate::auto_jobs::owner_wait(&library,"cardCutouts",if inputs.restricted {Some("lightweight")} else if inputs.character_busy {Some("busy")} else {None},unconfigured);
        }
        let gate = job::decide(inputs);
        if gate == Gate::Open
            && self.state.current_library().is_some_and(|library| {
                !crate::auto_jobs::manual(&library, "cardCutouts")
                    && !library
                        .cloud_sync_config()
                        .is_ok_and(|config| config.enabled)
            })
        {
            Gate::Closed {
                reason: "서버 복제가 꺼져 있음",
                visible: false,
            }
        } else {
            gate
        }
    }

    fn candidates(&mut self) -> Result<Vec<String>, JobError> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| JobError::fatal("서버 연결을 확인해 주세요."))?;
        session
            .client
            .card_cutout_candidates(&session.token.expose())
            .map_err(|e| JobError::fatal(format!("누끼 대상을 불러오지 못했습니다: {e}")))
    }

    fn is_cached(&mut self, id: &str) -> bool {
        self.dirs.cache.find(id).is_some()
    }

    fn make(&mut self, id: &str) -> Result<Made, JobError> {
        let library = self
            .session
            .as_ref()
            .map(|s| s.library.clone())
            .ok_or_else(|| JobError::fatal("라이브러리가 닫혔습니다."))?;
        let Some(source) = self.original(&library, id)? else {
            return Ok(Made::NotLocal);
        };
        let result = (|| {
            let model = self.model_path()?;
            if self.worker.is_none() {
                let (python, script) = self
                    .runtime
                    .clone()
                    .ok_or_else(|| JobError::fatal("분석 환경을 찾을 수 없습니다."))?;
                let abort = self.abort();
                match worker::Worker::start(&python, &script, &model, &abort) {
                    Ok(worker) => self.worker = Some(worker),
                    Err(worker::WorkerError::Interrupted) => return Err(JobError::interrupted()),
                    Err(error) => return Err(JobError::fatal(error.to_string())),
                }
            }
            let abort = self.abort();
            let stem = self.dirs.cache.stem(id);
            let outcome = self
                .worker
                .as_mut()
                .expect("started above")
                .cut(id, &source, &stem, &abort);
            match outcome {
                Ok(cut) => self
                    .dirs
                    .cache
                    .adopt(id, &cut.file)
                    .map(|_| Made::Cached)
                    .map_err(|e| JobError::asset(e.to_string())),
                Err(worker::WorkerError::Image(why)) => Err(JobError::asset(why)),
                Err(worker::WorkerError::Interrupted) => {
                    self.worker = None;
                    Err(JobError::interrupted())
                }
                Err(worker::WorkerError::Broken(why)) => {
                    // Restart the child for the next image; this one is retried later.
                    self.worker = None;
                    Err(JobError::asset(why))
                }
            }
        })();
        let _ = std::fs::remove_file(&source);
        result
    }

    fn upload(&mut self, id: &str) -> Result<(), JobError> {
        let cached = self
            .dirs
            .cache
            .find(id)
            .ok_or_else(|| JobError::asset("누끼 파일이 없습니다."))?;
        let (spec, bytes): (UploadSpec, Vec<u8>) = self
            .dirs
            .cache
            .read(id, &cached)
            .map_err(|e| JobError::asset(e.to_string()))?;
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| JobError::fatal("서버 연결을 확인해 주세요."))?;
        match session
            .client
            .upload_card_cutout(&spec, &bytes, &session.token.expose())
        {
            Ok(()) => Ok(()),
            Err(LibraryError::CloudUnauthorized) => {
                Err(JobError::fatal("서버 게시 토큰을 확인해 주세요."))
            }
            Err(error) => {
                eprintln!("card cutouts: upload failed: {error}");
                Err(JobError::asset(error.to_string()))
            }
        }
    }

    fn report(&mut self, report: Report) {
        if let Some(library)=self.state.current_library() {
            match &report {
                Report::Running { done,total } => { crate::auto_jobs::owner_started(&library,"cardCutouts"); crate::auto_jobs::progress(&library,"cardCutouts",*done,*total,Some(total.saturating_sub(*done)),None); },
                Report::Queued { remaining } | Report::Paused { remaining,.. } => crate::auto_jobs::progress(&library,"cardCutouts",0,*remaining,Some(*remaining),None),
                _ => {}
            }
        }
        match report {
            Report::Running { done, total } => activities::report(
                job::KEY,
                job::KIND,
                job::LABEL,
                "running",
                done,
                Some(total),
                Some(format!("{}개 남음", total.saturating_sub(done))),
                None,
                None,
                None,
            ),
            Report::Queued { remaining } => activities::report(
                job::KEY,
                job::KIND,
                job::LABEL,
                "queued",
                0,
                None,
                Some(format!("{remaining}개 남음")),
                None,
                None,
                None,
            ),
            Report::Paused { reason, remaining } => activities::report(
                job::KEY,
                job::KIND,
                job::LABEL,
                "paused",
                0,
                None,
                Some(format!("{remaining}개 남음")),
                None,
                Some(reason.to_owned()),
                None,
            ),
            Report::Failed(message) => {
                eprintln!("card cutouts: {message}");
                activities::report(
                    job::KEY,
                    job::KIND,
                    job::LABEL,
                    "failed",
                    0,
                    None,
                    None,
                    None,
                    None,
                    Some(message),
                )
            }
            Report::Done => activities::finish(job::KEY, None),
        }
    }
}
