//! PC side of the file exchange (보내기/받기): send files to another of the user's
//! devices and receive files from them into `<Downloads>/Lakomics/`.
//!
//! Separate from the Library (docs/research/file-exchange-design-20260924.md). Two
//! native threads own the network, independent of the WebView so receiving keeps
//! working while the window is hidden in the tray:
//!
//! * the receiver polls `exchange.revision` in `/v1/sync/status` (one conditional read,
//!   `304` while nothing changed) and, when it moves, refreshes devices, outbox and
//!   inbox and saves every new file: part file → size + SHA-256 check → reserved final
//!   name → rename → ack. A local ledger means a lost ack never saves a file twice;
//! * the sender hashes, creates, uploads (one presigned PUT) and completes each queued
//!   file. The transfer id is persisted first, so every step is retry-safe.
//!
//! State lives in `file-exchange.json` in the app config directory (never the library
//! database, because the library can be switched): this device's id, the received
//! ledger and unfinished sends. The UI reads [`Snapshot`] and listens for
//! `exchange://changed`.
mod client;
mod files;
mod zip;

use client::{ApiError, CreateRequest, Device, ExchangeClient, InboxItem, Transfer};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const STATE_FILE: &str = "file-exchange.json";
const EVENT: &str = "exchange://changed";
const FOLDER_NAME: &str = "Lakomics";
pub(crate) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const HISTORY_DAYS: i64 = 7;
const MAX_RECEIVED_ROWS: usize = 200;
/// Arrival target is about five seconds while the window is shown.
const POLL: Duration = Duration::from_secs(5);
/// Hidden in the tray or minimised.
const POLL_HIDDEN: Duration = Duration::from_secs(15);
/// Parked until the user acts (a token is saved), which wakes the thread early.
const WAIT_FOR_USER: Duration = Duration::from_secs(24 * 3600);
/// A send stops retrying on its own after this many stalled attempts in a row.
const MAX_TIMEOUTS: usize = 3;
const MAX_BATCH_FILES: usize = 100;
const PARTS_FOLDER: &str = "exchange-parts";
/// Temporary zips of folders being sent (app data, never Downloads or the source).
const ZIPS_FOLDER: &str = "exchange-zips";
/// Parts not touched for this long are removed at startup (undelivered files expire
/// on the server after 24 h).
const STALE_PART: Duration = Duration::from_secs(48 * 3600);
/// Without an `exchange` field the inbox is re-read at most this often.
const FALLBACK_POLL: Duration = Duration::from_secs(60);
const NETWORK_BACKOFF: [u64; 3] = [5, 15, 60];
const SEND_RETRY: [u64; 4] = [2, 10, 30, 60];
const UNAVAILABLE_RETRY: Duration = Duration::from_secs(15);
const REJECTED_RETRY: Duration = Duration::from_secs(60);
const PROGRESS_EMIT: Duration = Duration::from_millis(250);

const TOKEN_MISSING: &str =
    "이 PC 전용 보내기/받기 토큰을 입력해 주세요. 공용 클라우드 토큰으로는 쓸 수 없습니다.";
const TOKEN_REQUIRED: &str =
    "이 PC 전용 토큰이 필요합니다. 공용 클라우드 토큰으로는 보내기/받기를 쓸 수 없습니다.";

// --- persisted state ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Received {
    transfer_id: String,
    file_name: String,
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
    #[serde(default)]
    from_name: Option<String>,
    received_at: String,
    #[serde(default)]
    acked: bool,
    #[serde(default)]
    seen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredSend {
    transfer_id: String,
    batch_id: String,
    to_device: String,
    #[serde(default)]
    to_name: Option<String>,
    path: PathBuf,
    file_name: String,
    size_bytes: u64,
    #[serde(default)]
    modified: Option<i128>,
    #[serde(default)]
    sha256: Option<String>,
    created_at: String,
    /// A folder sent as one zip; `path` is then the temporary zip, rebuilt when missing.
    #[serde(default)]
    folder: Option<PathBuf>,
    /// Shown with the row, e.g. files left out of a zip.
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Stored {
    device_id: String,
    #[serde(default)]
    received: Vec<Received>,
    #[serde(default)]
    sends: Vec<StoredSend>,
}

impl Stored {
    fn load(path: &Path) -> Self {
        let mut stored = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<Stored>(&bytes).unwrap_or_else(|_| {
                // Keep the unreadable file for inspection instead of silently replacing it.
                let _ = fs::rename(path, path.with_extension("json.corrupt"));
                Stored::default()
            }),
            Err(_) => Stored::default(),
        };
        if uuid::Uuid::parse_str(&stored.device_id).is_err() {
            stored.device_id = uuid::Uuid::new_v4().hyphenated().to_string();
        }
        stored.prune(chrono::Utc::now());
        stored
    }

    fn save(&self, path: &Path) -> io::Result<()> {
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer_pretty(&mut temp, self).map_err(io::Error::other)?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|error| error.error)?;
        Ok(())
    }

    /// Received rows older than the server's 7-day history go, newest 200 stay; an
    /// unacknowledged row is kept until its ack succeeds, since it is the ledger.
    fn prune(&mut self, now: chrono::DateTime<chrono::Utc>) {
        let cutoff = now - chrono::Duration::days(HISTORY_DAYS);
        self.received.retain(|row| {
            !row.acked
                || chrono::DateTime::parse_from_rfc3339(&row.received_at)
                    .is_ok_and(|at| at >= cutoff)
        });
        self.received
            .sort_by(|a, b| b.received_at.cmp(&a.received_at));
        let mut kept = 0;
        self.received.retain(|row| {
            kept += 1;
            kept <= MAX_RECEIVED_ROWS || !row.acked
        });
    }

    fn ledger(&self, transfer_id: &str) -> Option<&Received> {
        self.received
            .iter()
            .find(|row| row.transfer_id == transfer_id)
    }

    fn unseen(&self) -> usize {
        self.received.iter().filter(|row| !row.seen).count()
    }
}

// --- runtime state ------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Queued,
    Zipping,
    Hashing,
    Uploading,
    Failed,
}

struct SendJob {
    stored: StoredSend,
    phase: Phase,
    done: u64,
    message: Option<String>,
    retryable: bool,
    retry_at: Instant,
    attempts: usize,
    /// Consecutive stalled uploads; automatic retries stop after [`MAX_TIMEOUTS`].
    timeouts: usize,
    cancel: Arc<AtomicBool>,
}

struct Incoming {
    item: InboxItem,
    done: u64,
    /// A failure that waits for the user's 재시도 instead of retrying on its own.
    failed: Option<String>,
    /// Set to decline the transfer, also mid-download.
    cancel: Arc<AtomicBool>,
}

/// A withdraw/decline the server has not confirmed yet.
struct PendingCancel {
    transfer_id: String,
    retry_at: Instant,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Availability {
    /// `starting`, `ready`, `offline` (retrying) or `unavailable` (needs the user).
    state: &'static str,
    message: Option<String>,
    needs_token: bool,
}

impl Availability {
    fn unavailable(message: &str) -> Self {
        Self {
            state: "unavailable",
            message: Some(message.to_owned()),
            needs_token: false,
        }
    }
}

/// This device's own exchange token. There is no fallback to the shared Cloud API
/// token: the server refuses it, so polling with it would only repeat a 403.
enum TokenState {
    Unknown,
    Missing,
    Present(String),
}

struct State {
    path: Option<PathBuf>,
    stored: Stored,
    availability: Availability,
    self_name: Option<String>,
    devices: Vec<Device>,
    outbox: Vec<Transfer>,
    jobs: Vec<SendJob>,
    incoming: Vec<Incoming>,
    /// Transfers declined here: never downloaded again while the decline is pending.
    declined: HashSet<String>,
    cancels: Vec<PendingCancel>,
    refresh: bool,
    token: TokenState,
    endpoint: Option<(PathBuf, Option<String>, Instant)>,
    /// Where downloads are assembled before verification (app data, never Downloads).
    parts: Option<PathBuf>,
    zips: Option<PathBuf>,
    /// Notes of finished sends, shown on their server outbox rows (this session).
    notes: std::collections::HashMap<String, String>,
    last_progress: Instant,
}

struct Runtime {
    state: Mutex<State>,
    receiver: Condvar,
    sender: Condvar,
    app: OnceLock<AppHandle>,
}

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| Runtime {
        state: Mutex::new(State {
            path: None,
            stored: Stored::default(),
            availability: Availability {
                state: "starting",
                message: None,
                needs_token: false,
            },
            self_name: None,
            devices: Vec::new(),
            outbox: Vec::new(),
            jobs: Vec::new(),
            incoming: Vec::new(),
            declined: HashSet::new(),
            cancels: Vec::new(),
            refresh: true,
            token: TokenState::Unknown,
            endpoint: None,
            parts: None,
            zips: None,
            notes: std::collections::HashMap::new(),
            last_progress: Instant::now(),
        }),
        receiver: Condvar::new(),
        sender: Condvar::new(),
        app: OnceLock::new(),
    })
}

fn lock() -> MutexGuard<'static, State> {
    runtime()
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn persist(state: &State) {
    if let Some(path) = &state.path {
        if let Err(error) = state.stored.save(path) {
            eprintln!("file exchange state not saved: {error}");
        }
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn jitter(max: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(nanos % (max.as_millis() as u64).max(1))
}

// --- UI snapshot --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceView {
    device_id: String,
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutgoingRow {
    transfer_id: String,
    file_name: String,
    size_bytes: u64,
    to_name: Option<String>,
    /// `queued`, `zipping`, `hashing`, `uploading`, `waiting`, `delivered`, `expired`,
    /// `cancelled`, `interrupted` or `failed`.
    state: &'static str,
    done: u64,
    message: Option<String>,
    /// Extra information that is not a failure (files left out of a folder zip).
    note: Option<String>,
    retryable: bool,
    cancellable: bool,
    created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IncomingRow {
    transfer_id: String,
    file_name: String,
    size_bytes: u64,
    from_name: Option<String>,
    /// `downloading` or `failed`.
    state: &'static str,
    done: u64,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceivedRow {
    transfer_id: String,
    file_name: String,
    size_bytes: u64,
    from_name: Option<String>,
    received_at: String,
    exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    availability: Availability,
    self_name: Option<String>,
    devices: Vec<DeviceView>,
    outgoing: Vec<OutgoingRow>,
    incoming: Vec<IncomingRow>,
    received: Vec<ReceivedRow>,
    unseen: usize,
    folder: Option<String>,
    token_configured: bool,
}

fn outbox_row(transfer: &Transfer, note: Option<&String>) -> OutgoingRow {
    let (state, message, cancellable) = match transfer.state.as_str() {
        "ready" => ("waiting", None, true),
        "delivered" => ("delivered", None, false),
        "expired" => ("expired", Some("만료됨 (받지 않음)".to_owned()), false),
        "cancelled" => (
            "cancelled",
            match transfer.failure.as_deref() {
                Some("deviceUnregistered") => Some("받는 기기가 등록 해제됨".to_owned()),
                Some("declined") => Some("받는 쪽에서 거절함".to_owned()),
                _ => None,
            },
            false,
        ),
        "uploading" => ("interrupted", Some("업로드가 끝나지 않음".to_owned()), true),
        _ => (
            "failed",
            Some(match transfer.failure.as_deref() {
                Some("sizeMismatch") => "업로드된 크기가 다름 — 다시 보내 주세요".to_owned(),
                _ => "보내지 못함".to_owned(),
            }),
            false,
        ),
    };
    OutgoingRow {
        transfer_id: transfer.transfer_id.clone(),
        file_name: transfer.file_name.clone(),
        size_bytes: transfer.size_bytes,
        to_name: transfer.to_name.clone(),
        state,
        done: 0,
        message,
        note: note.cloned(),
        retryable: false,
        cancellable,
        created_at: transfer.created_at.clone(),
    }
}

fn job_row(job: &SendJob) -> OutgoingRow {
    OutgoingRow {
        transfer_id: job.stored.transfer_id.clone(),
        file_name: job.stored.file_name.clone(),
        size_bytes: job.stored.size_bytes,
        to_name: job.stored.to_name.clone(),
        state: match job.phase {
            Phase::Queued => "queued",
            Phase::Zipping => "zipping",
            Phase::Hashing => "hashing",
            Phase::Uploading => "uploading",
            Phase::Failed => "failed",
        },
        done: job.done,
        message: job.message.clone(),
        note: job.stored.note.clone(),
        retryable: job.phase == Phase::Failed && job.retryable,
        cancellable: true,
        created_at: Some(job.stored.created_at.clone()),
    }
}

/// The UI snapshot. Built under the lock without filesystem calls; `exists` is filled
/// in afterwards by [`current_snapshot`].
fn snapshot(state: &State, folder: Option<String>) -> Snapshot {
    let mut outgoing: Vec<OutgoingRow> = state.jobs.iter().rev().map(job_row).collect();
    outgoing.extend(
        state
            .outbox
            .iter()
            .filter(|row| {
                !state
                    .jobs
                    .iter()
                    .any(|job| job.stored.transfer_id == row.transfer_id)
            })
            .map(|row| outbox_row(row, state.notes.get(&row.transfer_id))),
    );
    Snapshot {
        availability: state.availability.clone(),
        self_name: state.self_name.clone(),
        devices: state
            .devices
            .iter()
            .filter(|device| !device.is_self)
            .map(|device| DeviceView {
                device_id: device.device_id.clone(),
                name: device.name.clone(),
                kind: device.kind.clone(),
            })
            .collect(),
        outgoing,
        incoming: state
            .incoming
            .iter()
            .map(|row| IncomingRow {
                transfer_id: row.item.transfer_id.clone(),
                file_name: row.item.file_name.clone(),
                size_bytes: row.item.size_bytes,
                from_name: row.item.from_name.clone(),
                state: if row.failed.is_some() {
                    "failed"
                } else {
                    "downloading"
                },
                done: row.done,
                message: row.failed.clone(),
            })
            .collect(),
        received: state
            .stored
            .received
            .iter()
            .map(|row| ReceivedRow {
                transfer_id: row.transfer_id.clone(),
                file_name: row.file_name.clone(),
                size_bytes: row.size_bytes,
                from_name: row.from_name.clone(),
                received_at: row.received_at.clone(),
                exists: false,
            })
            .collect(),
        unseen: state.stored.unseen(),
        folder,
        token_configured: matches!(state.token, TokenState::Present(_)),
    }
}

/// A snapshot whose received rows are checked on disk after the lock is released.
fn current_snapshot(app: &AppHandle) -> Snapshot {
    let folder = save_dir(app).map(|dir| dir.display().to_string());
    let (mut snapshot, paths) = {
        let state = lock();
        let paths: Vec<PathBuf> = state
            .stored
            .received
            .iter()
            .map(|row| row.path.clone())
            .collect();
        (snapshot(&state, folder), paths)
    };
    for (row, path) in snapshot.received.iter_mut().zip(paths) {
        row.exists = path.is_file();
    }
    snapshot
}

fn app() -> Option<&'static AppHandle> {
    runtime().app.get()
}

fn save_dir(app: &AppHandle) -> Option<PathBuf> {
    let paths = app.path();
    paths
        .download_dir()
        .ok()
        .or_else(|| paths.home_dir().ok().map(|home| home.join("Downloads")))
        .map(|dir| dir.join(FOLDER_NAME))
}

/// Push the current state to the UI and the tray.
fn emit() {
    let Some(app) = app() else { return };
    let payload = current_snapshot(app);
    let unseen = payload.unseen;
    let _ = app.emit(EVENT, payload);
    crate::workload::set_received_indicator(app, unseen);
}

/// Progress emits are throttled; state changes always emit.
fn emit_progress() {
    let due = {
        let mut state = lock();
        let due = state.last_progress.elapsed() >= PROGRESS_EMIT;
        if due {
            state.last_progress = Instant::now();
        }
        due
    };
    if due {
        emit();
    }
}

// --- server context -----------------------------------------------------------

struct Context {
    client: ExchangeClient,
    /// Endpoint plus a digest of the credential: registration is redone when it changes.
    key: String,
}

fn endpoint(app: &AppHandle) -> Result<String, Availability> {
    let library = app
        .state::<crate::commands::AppState>()
        .current_library()
        .ok_or_else(|| {
            Availability::unavailable("라이브러리를 열면 보내기/받기를 쓸 수 있습니다.")
        })?;
    let root = library.root().to_path_buf();
    let cached = {
        let state = lock();
        state
            .endpoint
            .as_ref()
            .filter(|(at, _, read)| *at == root && read.elapsed() < Duration::from_secs(60))
            .map(|(_, url, _)| url.clone())
    };
    let url = match cached {
        Some(url) => url,
        None => {
            let url = library
                .cloud_sync_config()
                .ok()
                .and_then(|config| config.api_base_url)
                .filter(|url| !url.trim().is_empty());
            lock().endpoint = Some((root, url.clone(), Instant::now()));
            url
        }
    };
    url.ok_or_else(|| {
        Availability::unavailable("설정 › 클라우드에서 서버 주소를 먼저 입력해 주세요.")
    })
}

fn token_missing() -> Availability {
    Availability {
        state: "unavailable",
        message: Some(TOKEN_MISSING.to_owned()),
        needs_token: true,
    }
}

/// This device's own exchange token (read once, then cached until it is changed).
fn token() -> Result<String, Availability> {
    match &lock().token {
        TokenState::Present(value) => return Ok(value.clone()),
        TokenState::Missing => return Err(token_missing()),
        TokenState::Unknown => {}
    }
    let stored = crate::library::credential::read_exchange_token().map_err(|_| {
        Availability::unavailable("저장된 토큰을 읽지 못했습니다. 잠시 후 다시 시도합니다.")
    })?;
    let mut state = lock();
    match stored {
        Some(value) => {
            state.token = TokenState::Present(value.clone());
            Ok(value)
        }
        None => {
            state.token = TokenState::Missing;
            Err(token_missing())
        }
    }
}

fn context(app: &AppHandle) -> Result<Context, Availability> {
    let base = endpoint(app)?;
    let token = token()?;
    let device_id = lock().stored.device_id.clone();
    let client = ExchangeClient::new(&base, &token, &device_id)
        .map_err(|_| Availability::unavailable("서버 주소나 토큰 형식을 확인해 주세요."))?;
    use sha2::Digest;
    let digest = sha2::Sha256::digest(token.as_bytes());
    let key = format!(
        "{base}#{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    );
    Ok(Context { client, key })
}

/// A Korean message for a failed step, as the UI shows it.
fn message(error: &ApiError) -> String {
    match error {
        ApiError::Network => "서버에 연결할 수 없음 — 자동 재시도".to_owned(),
        ApiError::TimedOut => "연결이 응답하지 않음 — 자동 재시도".to_owned(),
        ApiError::Invalid => "서버 응답을 확인할 수 없음".to_owned(),
        ApiError::Corrupt => "받은 파일이 보낸 파일과 다름".to_owned(),
        ApiError::Refused(message) => message.clone(),
        ApiError::Cancelled => "취소됨".to_owned(),
        ApiError::Local(error) if files::is_disk_full(error) => "저장 공간 부족".to_owned(),
        ApiError::Local(_) => "파일을 읽거나 쓸 수 없음".to_owned(),
        ApiError::Status {
            status,
            code,
            state,
        } => match (code.as_deref(), *status) {
            (Some("fileTooLarge"), _) | (_, 413) => "파일이 너무 큼 (최대 2GB)".to_owned(),
            (Some("quotaExceeded"), _) => "보관 한도 초과".to_owned(),
            (Some("batchTooLarge"), _) => "한 번에 보낼 수 있는 파일 수(100개) 초과".to_owned(),
            (Some("targetDeviceUnknown"), _) => "받는 기기가 등록 해제됨".to_owned(),
            (Some("cannotSendToSelf"), _) => "같은 기기로는 보낼 수 없음".to_owned(),
            (Some("invalidFileName"), _) => "사용할 수 없는 파일 이름".to_owned(),
            (Some("sizeMismatch"), _) => "업로드된 크기가 다름 — 다시 보내 주세요".to_owned(),
            (Some("uploadMissing"), _) => "업로드가 끝나지 않음 — 다시 보내 주세요".to_owned(),
            (Some("transferIdReused"), _) => "전송 식별자 충돌 — 다시 보내 주세요".to_owned(),
            (Some("transferGone"), _) if state.as_deref() == Some("expired") => {
                "만료됨 (받지 않음)".to_owned()
            }
            (Some("transferGone"), _) => "더 이상 받을 수 없는 전송".to_owned(),
            (Some("exchangeDeviceTokenRequired"), _) => TOKEN_REQUIRED.to_owned(),
            (Some("exchangeDeviceForbidden"), _) => {
                "이 PC의 기기 등록이 다른 토큰에 묶여 있습니다. 처음 등록한 토큰을 입력해 주세요."
                    .to_owned()
            }
            (Some("exchangeDeviceLimit"), _) => "등록할 수 있는 기기 수를 넘었습니다.".to_owned(),
            (Some("storageUnavailable"), _) => {
                "서버 저장소에 연결할 수 없음 — 자동 재시도".to_owned()
            }
            (_, 401) => {
                "토큰이 거부되었습니다. 이 PC의 보내기/받기 토큰을 확인해 주세요.".to_owned()
            }
            (None, 404) => "서버에서 보내기/받기를 아직 쓸 수 없습니다.".to_owned(),
            (_, status) => format!("서버 오류 ({status})"),
        },
    }
}

/// What the whole feature shows after a failed server step.
fn availability_for(error: &ApiError) -> (Availability, Duration) {
    if error.transient() {
        return (
            Availability {
                state: "offline",
                message: Some(message(error)),
                needs_token: false,
            },
            Duration::ZERO,
        );
    }
    let needs_token = matches!(
        error.code(),
        Some("exchangeDeviceTokenRequired" | "exchangeDeviceForbidden")
    ) || error.status() == Some(401);
    (
        Availability {
            state: "unavailable",
            message: Some(message(error)),
            needs_token,
        },
        if needs_token {
            WAIT_FOR_USER
        } else {
            REJECTED_RETRY
        },
    )
}

/// A rejected token is re-read from the store next time (it may have been replaced).
fn forget_rejected_token(error: &ApiError) {
    if error.status() == Some(401) {
        lock().token = TokenState::Unknown;
    }
}

// --- receiver -----------------------------------------------------------------

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| fs::read_to_string("/proc/sys/kernel/hostname").ok())
        .or_else(|| fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "PC".to_owned())
}

struct Receiver {
    registered: Option<String>,
    status: Option<(String, Option<i64>)>,
    handled: Option<Option<i64>>,
    last_full: Option<Instant>,
}

impl Receiver {
    fn pass(&mut self, app: &AppHandle, context: &Context, forced: bool) -> Result<(), ApiError> {
        let mut forced = forced;
        if self.registered.as_deref() != Some(context.key.as_str()) {
            let me = context.client.register(&device_name())?;
            lock().self_name = Some(me.name);
            self.registered = Some(context.key.clone());
            self.status = None;
            forced = true;
        }
        let revision = context.client.revision(&mut self.status)?;
        let fallback_due = revision.is_none()
            && self
                .last_full
                .is_none_or(|at| at.elapsed() >= FALLBACK_POLL);
        if !forced && self.handled == Some(revision) && !fallback_due {
            return Ok(());
        }
        let devices = context.client.devices()?;
        let outbox = context.client.outbox()?;
        let inbox = context.client.inbox()?;
        let offered: HashSet<String> = inbox.iter().map(|item| item.transfer_id.clone()).collect();
        let parts = {
            let mut state = lock();
            state.devices = devices;
            state.outbox = outbox;
            // Rows the server no longer offers (withdrawn, expired) leave the list.
            state
                .incoming
                .retain(|row| offered.contains(&row.item.transfer_id));
            state.declined.retain(|id| offered.contains(id));
            state.parts.clone()
        };
        // Their part files go too. A full page may hide older offers, so it sweeps nothing.
        if let Some(parts) = parts.filter(|_| inbox.len() < client::INBOX_PAGE) {
            files::sweep_parts(&parts, Some(&offered), Duration::ZERO);
        }
        emit();
        self.handled = None;
        for item in &inbox {
            receive(app, context, item)?;
        }
        self.handled = Some(revision);
        self.last_full = Some(Instant::now());
        Ok(())
    }
}

fn wait_receiver(delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    let mut state = lock();
    loop {
        if state.refresh {
            state.refresh = false;
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        state = runtime()
            .receiver
            .wait_timeout(state, deadline - now)
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
    }
}

fn wake_receiver() {
    lock().refresh = true;
    runtime().receiver.notify_all();
}

fn set_availability(availability: Availability) {
    let changed = {
        let mut state = lock();
        let changed = state.availability != availability;
        state.availability = availability;
        changed
    };
    if changed {
        emit();
    }
}

/// 5 s while the main window is shown, 15 s while it is hidden in the tray or minimised.
fn poll_interval(app: &AppHandle) -> Duration {
    let background = app.get_webview_window("main").is_none_or(|window| {
        !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
    });
    if background {
        POLL_HIDDEN
    } else {
        POLL
    }
}

fn receiver_loop(app: AppHandle) {
    let mut receiver = Receiver {
        registered: None,
        status: None,
        handled: None,
        last_full: None,
    };
    let mut failures = 0usize;
    let mut delay = Duration::ZERO;
    loop {
        let forced = wait_receiver(delay);
        let context = match context(&app) {
            Ok(context) => context,
            Err(availability) => {
                // Without this PC's own token nothing is polled until one is saved.
                delay = if availability.needs_token {
                    WAIT_FOR_USER
                } else {
                    UNAVAILABLE_RETRY
                };
                set_availability(availability);
                receiver.registered = None;
                continue;
            }
        };
        match receiver.pass(&app, &context, forced) {
            Ok(()) => {
                failures = 0;
                set_availability(Availability {
                    state: "ready",
                    message: None,
                    needs_token: false,
                });
                delay = poll_interval(&app);
            }
            Err(error) => {
                forget_rejected_token(&error);
                if error.code() == Some("exchangeDeviceUnknown") {
                    receiver.registered = None;
                }
                let (availability, rejected) = availability_for(&error);
                set_availability(availability);
                delay = if error.transient() {
                    let step = NETWORK_BACKOFF[failures.min(NETWORK_BACKOFF.len() - 1)];
                    failures += 1;
                    Duration::from_secs(step) + jitter(Duration::from_secs(step / 2 + 1))
                } else {
                    receiver.registered = None;
                    rejected
                };
            }
        }
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Mark (or add) an inbox row; returns its cancel flag.
fn set_incoming(item: &InboxItem, failed: Option<String>) -> Arc<AtomicBool> {
    let mut state = lock();
    match state
        .incoming
        .iter_mut()
        .find(|row| row.item.transfer_id == item.transfer_id)
    {
        Some(row) => {
            row.failed = failed;
            row.done = 0;
            row.cancel.clone()
        }
        None => {
            let cancel = Arc::new(AtomicBool::new(false));
            state.incoming.push(Incoming {
                item: item.clone(),
                done: 0,
                failed,
                cancel: cancel.clone(),
            });
            cancel
        }
    }
}

fn remove_incoming(transfer_id: &str) {
    lock()
        .incoming
        .retain(|row| row.item.transfer_id != transfer_id);
}

/// Acknowledge a saved file; the ledger row is marked once the server agrees (or the
/// transfer is already final there).
fn acknowledge(context: &Context, transfer_id: &str, sha256: &str) -> Result<(), ApiError> {
    match context.client.ack(transfer_id, sha256) {
        Ok(_) => {}
        // Already final on the server (withdrawn, expired): nothing left to acknowledge.
        Err(error) if matches!(error.code(), Some("transferUnknown" | "transferGone")) => {}
        // Retried on the next pass; the ledger keeps the file from being saved twice.
        Err(error)
            if error.transient()
                || error.status() == Some(401)
                || error.code() == Some("exchangeDeviceUnknown") =>
        {
            return Err(error)
        }
        Err(_) => return Ok(()),
    }
    let mut state = lock();
    if let Some(row) = state
        .stored
        .received
        .iter_mut()
        .find(|row| row.transfer_id == transfer_id)
    {
        row.acked = true;
    }
    persist(&state);
    Ok(())
}

/// Save one inbox item. Transient failures return `Err` (the pass backs off); anything
/// else is shown on the row and waits for the user.
fn receive(app: &AppHandle, context: &Context, item: &InboxItem) -> Result<(), ApiError> {
    let (ledger, skip, parts) = {
        let state = lock();
        let ledger = state
            .stored
            .ledger(&item.transfer_id)
            .map(|row| (row.acked, row.sha256.clone()));
        let skip = state.declined.contains(&item.transfer_id)
            || state
                .incoming
                .iter()
                .any(|row| row.item.transfer_id == item.transfer_id && row.failed.is_some());
        (ledger, skip, state.parts.clone())
    };
    if let Some((acked, sha256)) = ledger {
        // Saved before: never save twice, only repeat the lost ack.
        return if acked {
            Ok(())
        } else {
            acknowledge(context, &item.transfer_id, &sha256)
        };
    }
    if skip {
        return Ok(());
    }
    let Ok(id) = uuid::Uuid::parse_str(&item.transfer_id) else {
        return Ok(());
    };
    if !valid_sha256(&item.sha256) || item.size_bytes > MAX_FILE_BYTES {
        set_incoming(item, Some("서버 응답을 확인할 수 없음".to_owned()));
        emit();
        return Ok(());
    }
    let (Some(dir), Some(parts)) = (save_dir(app), parts) else {
        set_incoming(item, Some("다운로드 폴더를 찾을 수 없음".to_owned()));
        emit();
        return Ok(());
    };
    let cancel = set_incoming(item, None);
    emit();
    let part = files::part_path(&parts, &id);
    let saved = (|| -> Result<PathBuf, ApiError> {
        fs::create_dir_all(&parts).map_err(ApiError::Local)?;
        fs::create_dir_all(&dir).map_err(ApiError::Local)?;
        let length = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        if let Some(offset) = files::resume_offset(length, item.size_bytes) {
            let ticket = context.client.ticket(&item.transfer_id)?;
            if ticket.size_bytes != item.size_bytes || ticket.sha256 != item.sha256 {
                return Err(ApiError::Invalid);
            }
            let transfer_id = item.transfer_id.clone();
            client::download(&ticket, &part, offset, item.size_bytes, &cancel, |done| {
                if let Some(row) = lock()
                    .incoming
                    .iter_mut()
                    .find(|row| row.item.transfer_id == transfer_id)
                {
                    row.done = done;
                }
                emit_progress();
            })?;
        } else if !part.exists() {
            File::create(&part).map_err(ApiError::Local)?;
        }
        match files::verify_part(&part, item.size_bytes, &item.sha256).map_err(ApiError::Local)? {
            files::Verify::Ok => {}
            _ => {
                let _ = fs::remove_file(&part);
                return Err(ApiError::Corrupt);
            }
        }
        // Declined while verifying: never let it reach Downloads.
        if cancel.load(Ordering::Acquire) {
            return Err(ApiError::Cancelled);
        }
        files::finalize(
            &part,
            &dir,
            &files::sanitize_leaf(&item.file_name, cfg!(windows)),
        )
        .map_err(ApiError::Local)
    })();
    match saved {
        Ok(path) => {
            {
                let mut state = lock();
                state
                    .incoming
                    .retain(|row| row.item.transfer_id != item.transfer_id);
                state.stored.received.insert(
                    0,
                    Received {
                        transfer_id: item.transfer_id.clone(),
                        file_name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| item.file_name.clone()),
                        path,
                        size_bytes: item.size_bytes,
                        sha256: item.sha256.clone(),
                        from_name: item.from_name.clone(),
                        received_at: now_rfc3339(),
                        acked: false,
                        seen: false,
                    },
                );
                state.stored.prune(chrono::Utc::now());
                persist(&state);
            }
            emit();
            acknowledge(context, &item.transfer_id, &item.sha256)
        }
        Err(_) if cancel.load(Ordering::Acquire) => {
            // Declined by the user: the decline itself is queued by `exchange_cancel`.
            let _ = fs::remove_file(&part);
            remove_incoming(&item.transfer_id);
            emit();
            Ok(())
        }
        Err(error)
            if matches!(
                error.code(),
                Some("transferUnknown" | "transferGone" | "transferNotReady")
            ) =>
        {
            // Withdrawn, expired or not ready yet: nothing to keep.
            if error.code() != Some("transferNotReady") {
                let _ = fs::remove_file(&part);
            }
            remove_incoming(&item.transfer_id);
            emit();
            Ok(())
        }
        Err(error) if error.transient() => Err(error),
        Err(error) => {
            set_incoming(item, Some(message(&error)));
            emit();
            Ok(())
        }
    }
}

// --- sender -------------------------------------------------------------------

enum Work {
    Cancel(String),
    Send(String),
}

/// The next due withdraw/decline or send; waits until one is due.
fn next_work() -> Work {
    let mut state = lock();
    loop {
        let now = Instant::now();
        if let Some(index) = state
            .cancels
            .iter()
            .position(|cancel| cancel.retry_at <= now)
        {
            return Work::Cancel(state.cancels.remove(index).transfer_id);
        }
        if let Some(job) = state
            .jobs
            .iter()
            .find(|job| job.phase == Phase::Queued && job.retry_at <= now)
        {
            return Work::Send(job.stored.transfer_id.clone());
        }
        let next = state
            .jobs
            .iter()
            .filter(|job| job.phase == Phase::Queued)
            .map(|job| job.retry_at)
            .chain(state.cancels.iter().map(|cancel| cancel.retry_at))
            .min();
        state = match next {
            Some(at) => {
                runtime()
                    .sender
                    .wait_timeout(state, at.saturating_duration_since(now))
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0
            }
            None => runtime()
                .sender
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        };
    }
}

fn queue_cancel(state: &mut State, transfer_id: String) {
    if !state
        .cancels
        .iter()
        .any(|cancel| cancel.transfer_id == transfer_id)
    {
        state.cancels.push(PendingCancel {
            transfer_id,
            retry_at: Instant::now(),
        });
    }
}

fn with_job<T>(transfer_id: &str, update: impl FnOnce(&mut SendJob) -> T) -> Option<T> {
    lock()
        .jobs
        .iter_mut()
        .find(|job| job.stored.transfer_id == transfer_id)
        .map(update)
}

/// Reads a file for hashing or uploading, reporting progress and stopping on cancel.
struct Tracked {
    file: File,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
    done: u64,
}

impl Read for Tracked {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        // Not `Interrupted`: readers retry that kind, and a cancel must stop the loop.
        if self.cancel.load(Ordering::Acquire) {
            return Err(io::Error::other("cancelled"));
        }
        let read = self.file.read(buffer)?;
        self.done += read as u64;
        let done = self.done;
        with_job(&self.transfer_id, |job| job.done = done);
        emit_progress();
        Ok(read)
    }
}

fn modified(meta: &fs::Metadata) -> Option<i128> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos() as i128)
}

/// Zip a folder send into its own directory under the temp-zip folder, then point the
/// send at that zip (to be hashed and sent like any file).
fn build_zip(
    transfer_id: &str,
    send: &mut StoredSend,
    cancel: &AtomicBool,
) -> Result<(), ApiError> {
    let Some(folder) = send.folder.clone() else {
        return Ok(());
    };
    let zips = lock()
        .zips
        .clone()
        .ok_or_else(|| ApiError::Local(io::Error::from(io::ErrorKind::NotFound)))?;
    discard_zip(send, Some(&zips));
    with_job(transfer_id, |job| {
        job.phase = Phase::Zipping;
        job.done = 0;
    });
    emit();
    let map = |error: zip::ZipError| match error {
        zip::ZipError::Refused(message) => ApiError::Refused(message),
        zip::ZipError::Cancelled => ApiError::Cancelled,
        zip::ZipError::Io(error) => ApiError::Local(error),
    };
    let plan = zip::plan(&folder, &zips).map_err(map)?;
    with_job(transfer_id, |job| {
        job.stored.size_bytes = plan.content_bytes
    });
    let dir = zips.join(uuid::Uuid::new_v4().hyphenated().to_string());
    fs::create_dir_all(&dir).map_err(ApiError::Local)?;
    let output = dir.join(&send.file_name);
    let mut done = 0u64;
    let written = zip::write(&plan, &output, cancel, |bytes| {
        done += bytes;
        with_job(transfer_id, |job| job.done = done);
        emit_progress();
    });
    let skipped = match written {
        Ok(skipped) => skipped + plan.skipped,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(map(error));
        }
    };
    let meta = fs::metadata(&output).map_err(ApiError::Local)?;
    send.path = output;
    send.size_bytes = meta.len();
    send.modified = modified(&meta);
    send.sha256 = None;
    send.note = (skipped > 0).then(|| format!("읽지 못한 항목 {skipped}개 제외"));
    with_job(transfer_id, |job| {
        job.stored.path = send.path.clone();
        job.stored.size_bytes = send.size_bytes;
        job.stored.note = send.note.clone();
    });
    Ok(())
}

fn run_send(context: &Context, transfer_id: &str) -> Result<(), ApiError> {
    let Some((mut send, cancel)) =
        with_job(transfer_id, |job| (job.stored.clone(), job.cancel.clone()))
    else {
        return Ok(());
    };
    if send.folder.is_some() && (send.sha256.is_none() || !send.path.is_file()) {
        build_zip(transfer_id, &mut send, &cancel)?;
    }
    let meta = fs::metadata(&send.path).map_err(ApiError::Local)?;
    if !meta.is_file() {
        return Err(ApiError::Local(io::Error::from(io::ErrorKind::NotFound)));
    }
    if meta.len() != send.size_bytes || modified(&meta) != send.modified {
        // The file changed since it was queued: its old digest and id no longer apply.
        send.size_bytes = meta.len();
        send.modified = modified(&meta);
        send.sha256 = None;
    }
    if send.size_bytes > MAX_FILE_BYTES {
        return Err(ApiError::Status {
            status: 413,
            code: Some("fileTooLarge".into()),
            state: None,
        });
    }
    let tracked = |cancel: &Arc<AtomicBool>, id: &str| -> Result<Tracked, ApiError> {
        Ok(Tracked {
            file: File::open(&send.path).map_err(ApiError::Local)?,
            transfer_id: id.to_owned(),
            cancel: cancel.clone(),
            done: 0,
        })
    };
    if send.sha256.is_none() {
        with_job(transfer_id, |job| {
            job.phase = Phase::Hashing;
            job.done = 0;
        });
        emit();
        let digest =
            files::sha256_reader(tracked(&cancel, transfer_id)?, |_| {}).map_err(|error| {
                if cancel.load(Ordering::Acquire) {
                    ApiError::Cancelled
                } else {
                    ApiError::Local(error)
                }
            })?;
        send.sha256 = Some(digest);
    }
    let sha256 = send.sha256.clone().unwrap_or_default();
    // A new id whenever the content changed, so the idempotent create never sees a
    // different body under an old id.
    let mut current = transfer_id.to_owned();
    let changed = with_job(transfer_id, |job| {
        let changed =
            job.stored.sha256.as_deref() != Some(sha256.as_str()) && job.stored.sha256.is_some();
        job.stored = send.clone();
        changed
    })
    .ok_or(ApiError::Cancelled)?;
    {
        let mut state = lock();
        if let Some(stored) = state
            .stored
            .sends
            .iter_mut()
            .find(|row| row.transfer_id == transfer_id)
        {
            *stored = send.clone();
        }
        persist(&state);
    }
    if changed {
        current = renew_id(transfer_id);
    }
    for attempt in 0..2 {
        let stored = with_job(&current, |job| job.stored.clone()).ok_or(ApiError::Cancelled)?;
        with_job(&current, |job| {
            job.phase = Phase::Uploading;
            job.done = 0;
        });
        emit();
        let created = context.client.create(&CreateRequest {
            transfer_id: &stored.transfer_id,
            batch_id: &stored.batch_id,
            to_device: &stored.to_device,
            file_name: &stored.file_name,
            size_bytes: stored.size_bytes,
            sha256: &sha256,
        })?;
        if let Some(name) = created.transfer.to_name.clone() {
            with_job(&current, |job| job.stored.to_name = Some(name));
        }
        match (created.transfer.state.as_str(), created.upload) {
            ("ready" | "delivered", _) => return finish(&current),
            ("uploading", Some(upload)) => {
                client::upload(&upload, tracked(&cancel, &current)?, stored.size_bytes)?;
                context.client.complete(&current)?;
                return finish(&current);
            }
            // Expired, failed or withdrawn under this id: send again under a new one.
            _ if attempt == 0 => current = renew_id(&current),
            _ => break,
        }
    }
    Err(ApiError::Invalid)
}

fn renew_id(transfer_id: &str) -> String {
    let fresh = uuid::Uuid::new_v4().hyphenated().to_string();
    with_job(transfer_id, |job| job.stored.transfer_id = fresh.clone());
    let mut state = lock();
    if let Some(send) = state
        .stored
        .sends
        .iter_mut()
        .find(|send| send.transfer_id == transfer_id)
    {
        send.transfer_id = fresh.clone();
    }
    persist(&state);
    fresh
}

/// Delete the temporary zip of a folder send (its own per-build directory).
fn discard_zip(send: &StoredSend, zips: Option<&Path>) {
    let (Some(_), Some(zips)) = (&send.folder, zips) else {
        return;
    };
    if let Some(dir) = send
        .path
        .parent()
        .filter(|dir| dir.starts_with(zips) && *dir != zips)
    {
        let _ = fs::remove_dir_all(dir);
    }
}

fn finish(transfer_id: &str) -> Result<(), ApiError> {
    {
        let mut state = lock();
        if let Some(job) = state
            .jobs
            .iter()
            .find(|job| job.stored.transfer_id == transfer_id)
        {
            discard_zip(&job.stored, state.zips.as_deref());
            if let Some(note) = job.stored.note.clone() {
                state.notes.insert(transfer_id.to_owned(), note);
            }
        }
        state
            .jobs
            .retain(|job| job.stored.transfer_id != transfer_id);
        state
            .stored
            .sends
            .retain(|send| send.transfer_id != transfer_id);
        persist(&state);
    }
    wake_receiver();
    emit();
    Ok(())
}

fn sender_loop(app: AppHandle) {
    loop {
        match next_work() {
            Work::Cancel(transfer_id) => {
                let result = context(&app).map(|context| context.client.cancel(&transfer_id));
                let delay = match result {
                    Ok(Ok(_)) => None,
                    Ok(Err(error)) if error.transient() => Some(UNAVAILABLE_RETRY),
                    // Unknown or already final there: nothing left to withdraw.
                    Ok(Err(_)) => None,
                    Err(availability) if availability.needs_token => Some(WAIT_FOR_USER),
                    Err(_) => Some(UNAVAILABLE_RETRY),
                };
                match delay {
                    // Retried later; meanwhile the server expires the transfer anyway.
                    Some(delay) => lock().cancels.push(PendingCancel {
                        transfer_id,
                        retry_at: Instant::now() + delay,
                    }),
                    None => wake_receiver(),
                }
            }
            Work::Send(transfer_id) => {
                let Some(cancel) = with_job(&transfer_id, |job| job.cancel.clone()) else {
                    continue;
                };
                let result = match context(&app) {
                    Ok(context) => run_send(&context, &transfer_id),
                    Err(availability) => {
                        with_job(&transfer_id, |job| {
                            job.message = availability.message.clone();
                            job.retry_at = Instant::now()
                                + if availability.needs_token {
                                    WAIT_FOR_USER
                                } else {
                                    UNAVAILABLE_RETRY
                                };
                        });
                        emit();
                        continue;
                    }
                };
                settle(&cancel, result);
            }
        }
    }
}

/// Record how a send attempt ended. The job is found by its cancel flag, because the
/// attempt may have renewed its transfer id. A cancelled job leaves (and is withdrawn on
/// the server); a transient failure is retried at 2, 10, 30 then every 60 s, except
/// that a transfer which keeps stalling stops after [`MAX_TIMEOUTS`]; anything else
/// waits for 재시도.
fn settle(cancel: &Arc<AtomicBool>, result: Result<(), ApiError>) {
    let mut state = lock();
    let Some(index) = state
        .jobs
        .iter()
        .position(|job| Arc::ptr_eq(&job.cancel, cancel))
    else {
        drop(state);
        emit();
        return;
    };
    let current = state.jobs[index].stored.transfer_id.clone();
    if cancel.load(Ordering::Acquire) {
        discard_zip(&state.jobs[index].stored, state.zips.as_deref());
        state.jobs.remove(index);
        state
            .stored
            .sends
            .retain(|send| send.transfer_id != current);
        queue_cancel(&mut state, current);
        persist(&state);
        drop(state);
        runtime().sender.notify_all();
        emit();
        return;
    }
    if let Err(error) = result {
        let zips = state.zips.clone();
        let job = &mut state.jobs[index];
        job.message = Some(message(&error));
        job.done = 0;
        job.timeouts = if matches!(error, ApiError::TimedOut) {
            job.timeouts + 1
        } else {
            0
        };
        if error.transient() && job.timeouts < MAX_TIMEOUTS {
            job.phase = Phase::Queued;
            job.retry_at = Instant::now()
                + Duration::from_secs(SEND_RETRY[job.attempts.min(SEND_RETRY.len() - 1)]);
            job.attempts += 1;
        } else {
            job.phase = Phase::Failed;
            // A folder's temporary zip goes now; 재시도 builds it again (the kept
            // digest still detects a changed folder and renews the transfer id).
            discard_zip(&job.stored, zips.as_deref());
            if job.timeouts >= MAX_TIMEOUTS {
                job.message = Some("연결이 계속 멈춰 중단됨 — 재시도해 주세요".to_owned());
            }
            job.retryable = !matches!(
                error.code(),
                Some("fileTooLarge" | "cannotSendToSelf" | "invalidFileName" | "batchTooLarge")
            ) && !matches!(error, ApiError::Refused(_));
        }
        drop(state);
        forget_rejected_token(&error);
    } else {
        drop(state);
    }
    emit();
}

// --- start --------------------------------------------------------------------

/// Load the local state and start the receiver and sender threads. Called once from
/// `setup`, after the tray exists.
pub(crate) fn start(app: AppHandle) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE));
    let parts = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(PARTS_FOLDER));
    if let Some(parts) = &parts {
        // Orphans from transfers that expired while the app was closed.
        files::sweep_parts(parts, None, STALE_PART);
    }
    let zips = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(ZIPS_FOLDER));
    if let Some(zips) = &zips {
        // Temporary zips never outlive a run; an unfinished folder send rebuilds its zip.
        let _ = fs::remove_dir_all(zips);
    }
    {
        let mut state = lock();
        if let Some(path) = &path {
            state.stored = Stored::load(path);
        }
        state.path = path;
        state.parts = parts;
        state.zips = zips;
        // Unfinished sends from the last run wait for 재시도: their files may have moved.
        let restored: Vec<SendJob> = state
            .stored
            .sends
            .iter()
            .cloned()
            .map(|stored| SendJob {
                stored,
                phase: Phase::Failed,
                done: 0,
                message: Some("앱이 종료되어 중단됨".to_owned()),
                retryable: true,
                retry_at: Instant::now(),
                attempts: 0,
                timeouts: 0,
                cancel: Arc::new(AtomicBool::new(false)),
            })
            .collect();
        state.jobs = restored;
        persist(&state);
    }
    let _ = runtime().app.set(app.clone());
    emit();
    let receiver = app.clone();
    let _ = std::thread::Builder::new()
        .name("exchange-receiver".into())
        .spawn(move || receiver_loop(receiver));
    let _ = std::thread::Builder::new()
        .name("exchange-sender".into())
        .spawn(move || sender_loop(app));
}

// --- commands -----------------------------------------------------------------
//
// Every command is `async`, so it runs on the async runtime and never on the main
// thread, which the tray and menus need to stay free.

#[tauri::command]
pub(crate) async fn exchange_snapshot(app: AppHandle) -> Snapshot {
    current_snapshot(&app)
}

/// Split files into server batches of at most [`MAX_BATCH_FILES`].
fn batches<T>(items: Vec<T>) -> Vec<Vec<T>> {
    let mut batches = Vec::new();
    let mut items = items.into_iter().peekable();
    while items.peek().is_some() {
        batches.push(items.by_ref().take(MAX_BATCH_FILES).collect());
    }
    batches
}

/// Queue files for sending. `to_device` may be omitted when exactly one other device
/// is registered. Returns how many files were queued.
#[tauri::command]
pub(crate) async fn exchange_send(
    paths: Vec<String>,
    to_device: Option<String>,
) -> Result<usize, String> {
    let (target, target_name) = {
        let state = lock();
        let others: Vec<&Device> = state
            .devices
            .iter()
            .filter(|device| !device.is_self)
            .collect();
        let device = match to_device.as_deref() {
            Some(id) => others.into_iter().find(|device| device.device_id == id),
            None if others.len() == 1 => others.into_iter().next(),
            None if others.is_empty() => None,
            None => return Err("받을 기기를 선택해 주세요.".into()),
        };
        let device =
            device.ok_or("받을 기기가 없습니다. 태블릿에서 Lakomics를 한 번 열어 주세요.")?;
        (device.device_id.clone(), device.name.clone())
    };
    // Read metadata before taking the lock. Each folder becomes one zip.
    let mut files = Vec::new();
    for raw in paths {
        let path = PathBuf::from(&raw);
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_file() || meta.is_dir() {
            files.push((path, meta));
        }
    }
    let mut queued = 0;
    {
        let mut state = lock();
        for batch in batches(files) {
            let batch_id = uuid::Uuid::new_v4().hyphenated().to_string();
            for (path, meta) in batch {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| files::FALLBACK_NAME.to_owned());
                let folder = meta.is_dir();
                let stored = StoredSend {
                    transfer_id: uuid::Uuid::new_v4().hyphenated().to_string(),
                    batch_id: batch_id.clone(),
                    to_device: target.clone(),
                    to_name: Some(target_name.clone()),
                    // A folder's zip path is set once it is built.
                    path: if folder { PathBuf::new() } else { path.clone() },
                    file_name: if folder { format!("{name}.zip") } else { name },
                    size_bytes: if folder { 0 } else { meta.len() },
                    modified: if folder { None } else { modified(&meta) },
                    sha256: None,
                    created_at: now_rfc3339(),
                    folder: folder.then_some(path),
                    note: None,
                };
                let too_large = !folder && meta.len() > MAX_FILE_BYTES;
                if !too_large {
                    state.stored.sends.push(stored.clone());
                }
                state.jobs.push(SendJob {
                    stored,
                    phase: if too_large {
                        Phase::Failed
                    } else {
                        Phase::Queued
                    },
                    done: 0,
                    message: too_large.then(|| "파일이 너무 큼 (최대 2GB)".to_owned()),
                    retryable: false,
                    retry_at: Instant::now(),
                    attempts: 0,
                    timeouts: 0,
                    cancel: Arc::new(AtomicBool::new(false)),
                });
                queued += usize::from(!too_large);
            }
        }
        persist(&state);
    }
    runtime().sender.notify_all();
    emit();
    Ok(queued)
}

/// Withdraw a send (or remove a failed one), or decline a received file, also while it
/// is downloading.
#[tauri::command]
pub(crate) async fn exchange_cancel(transfer_id: String) {
    {
        let mut state = lock();
        if let Some(index) = state
            .jobs
            .iter()
            .position(|job| job.stored.transfer_id == transfer_id)
        {
            let job = &state.jobs[index];
            job.cancel.store(true, Ordering::Release);
            if matches!(job.phase, Phase::Queued | Phase::Failed) {
                discard_zip(&state.jobs[index].stored, state.zips.as_deref());
                state.jobs.remove(index);
                state
                    .stored
                    .sends
                    .retain(|send| send.transfer_id != transfer_id);
                queue_cancel(&mut state, transfer_id.clone());
                persist(&state);
            }
        } else if let Some(index) = state
            .incoming
            .iter()
            .position(|row| row.item.transfer_id == transfer_id)
        {
            // An active download stops at its next chunk and deletes its part.
            let row = &state.incoming[index];
            row.cancel.store(true, Ordering::Release);
            if row.failed.is_some() {
                state.incoming.remove(index);
            }
            state.declined.insert(transfer_id.clone());
            queue_cancel(&mut state, transfer_id.clone());
        } else if state.outbox.iter().any(|row| {
            row.transfer_id == transfer_id && matches!(row.state.as_str(), "uploading" | "ready")
        }) {
            queue_cancel(&mut state, transfer_id.clone());
        }
    }
    runtime().sender.notify_all();
    emit();
}

#[tauri::command]
pub(crate) async fn exchange_retry(transfer_id: String) {
    {
        let mut state = lock();
        if let Some(job) = state.jobs.iter_mut().find(|job| {
            job.stored.transfer_id == transfer_id && job.phase == Phase::Failed && job.retryable
        }) {
            job.phase = Phase::Queued;
            job.message = None;
            job.retry_at = Instant::now();
            job.attempts = 0;
            job.timeouts = 0;
            let stored = job.stored.clone();
            if !state
                .stored
                .sends
                .iter()
                .any(|send| send.transfer_id == transfer_id)
            {
                state.stored.sends.push(stored);
                persist(&state);
            }
        } else {
            state
                .incoming
                .retain(|row| row.item.transfer_id != transfer_id || row.failed.is_none());
        }
    }
    runtime().sender.notify_all();
    wake_receiver();
    emit();
}

fn mark_seen() {
    {
        let mut state = lock();
        if state.stored.unseen() == 0 {
            return;
        }
        state
            .stored
            .received
            .iter_mut()
            .for_each(|row| row.seen = true);
        persist(&state);
    }
    emit();
}

/// Mark received files as seen (the panel is open) and clear the tray count.
#[tauri::command]
pub(crate) async fn exchange_mark_seen() {
    mark_seen();
}

#[tauri::command]
pub(crate) async fn exchange_refresh() {
    wake_receiver();
}

fn received_path(transfer_id: &str) -> Result<PathBuf, String> {
    let path = lock()
        .stored
        .ledger(transfer_id)
        .map(|row| row.path.clone());
    path.filter(|path| path.is_file())
        .ok_or_else(|| "파일이 옮겨졌거나 삭제되었습니다.".to_owned())
}

#[tauri::command]
pub(crate) async fn exchange_open(app: AppHandle, transfer_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = received_path(&transfer_id)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|_| "파일을 열지 못했습니다.".to_owned())
}

#[tauri::command]
pub(crate) async fn exchange_reveal(app: AppHandle, transfer_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = received_path(&transfer_id)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "폴더를 열지 못했습니다.".to_owned())
}

#[tauri::command]
pub(crate) async fn exchange_open_folder(app: AppHandle) -> Result<(), String> {
    open_folder(&app)
}

/// Open `<Downloads>/Lakomics` (creating it) and mark received files as seen; also the
/// tray entry's action (run off the main thread).
pub(crate) fn open_folder(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = save_dir(app).ok_or("다운로드 폴더를 찾을 수 없습니다.")?;
    fs::create_dir_all(&dir).map_err(|_| "다운로드 폴더를 만들지 못했습니다.".to_owned())?;
    mark_seen();
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|_| "폴더를 열지 못했습니다.".to_owned())
}

/// Save (or, with `None`, delete) this PC's own exchange token and resume at once.
#[tauri::command]
pub(crate) async fn exchange_set_token(token: Option<String>) -> Result<(), String> {
    let result = match token.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => crate::library::credential::set_exchange_token(value),
        _ => crate::library::credential::delete_exchange_token(),
    };
    {
        let mut state = lock();
        state.token = TokenState::Unknown;
        // Work parked while the token was missing runs now.
        let now = Instant::now();
        for job in state
            .jobs
            .iter_mut()
            .filter(|job| job.phase == Phase::Queued)
        {
            job.retry_at = now;
        }
        for cancel in &mut state.cancels {
            cancel.retry_at = now;
        }
    }
    runtime().sender.notify_all();
    wake_receiver();
    result.map_err(|_| "토큰을 저장하지 못했습니다.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn received(id: &str, days_ago: i64, acked: bool) -> Received {
        Received {
            transfer_id: id.into(),
            file_name: format!("{id}.txt"),
            path: PathBuf::from(format!("/tmp/{id}.txt")),
            size_bytes: 1,
            sha256: "0".repeat(64),
            from_name: None,
            received_at: (chrono::Utc::now() - chrono::Duration::days(days_ago))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            acked,
            seen: false,
        }
    }

    #[test]
    fn ledger_round_trips_and_keeps_the_device_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        let mut stored = Stored::load(&path);
        assert!(uuid::Uuid::parse_str(&stored.device_id).is_ok());
        stored.received.push(received("a", 0, false));
        stored.save(&path).unwrap();
        let loaded = Stored::load(&path);
        assert_eq!(loaded.device_id, stored.device_id);
        assert_eq!(loaded.ledger("a").map(|row| row.acked), Some(false));
        assert_eq!(loaded.unseen(), 1);
    }

    #[test]
    fn pruning_drops_old_acked_rows_but_keeps_unacked_ledger_rows() {
        let mut stored = Stored {
            device_id: uuid::Uuid::new_v4().to_string(),
            received: vec![
                received("old", 8, true),
                received("unacked", 30, false),
                received("new", 1, true),
            ],
            sends: Vec::new(),
        };
        stored.prune(chrono::Utc::now());
        let ids: Vec<_> = stored
            .received
            .iter()
            .map(|row| row.transfer_id.as_str())
            .collect();
        assert_eq!(ids, ["new", "unacked"]);
    }

    #[test]
    fn an_unreadable_state_file_is_kept_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        fs::write(&path, b"{not json").unwrap();
        let stored = Stored::load(&path);
        assert!(uuid::Uuid::parse_str(&stored.device_id).is_ok());
        assert_eq!(
            fs::read(path.with_extension("json.corrupt")).unwrap(),
            b"{not json"
        );
    }

    #[test]
    fn server_outbox_states_map_to_row_states() {
        let transfer = |state: &str, failure: Option<&str>| Transfer {
            transfer_id: "t".into(),
            to_name: Some("Tab".into()),
            file_name: "a".into(),
            size_bytes: 1,
            state: state.into(),
            created_at: None,
            failure: failure.map(str::to_owned),
        };
        assert_eq!(outbox_row(&transfer("ready", None), None).state, "waiting");
        assert!(outbox_row(&transfer("ready", None), None).cancellable);
        assert_eq!(
            outbox_row(&transfer("delivered", None), None).state,
            "delivered"
        );
        let expired = outbox_row(&transfer("expired", Some("expired")), None);
        assert_eq!(
            (expired.state, expired.message.as_deref()),
            ("expired", Some("만료됨 (받지 않음)"))
        );
        let gone = outbox_row(&transfer("cancelled", Some("deviceUnregistered")), None);
        assert_eq!(gone.message.as_deref(), Some("받는 기기가 등록 해제됨"));
    }

    #[test]
    fn messages_for_the_design_error_cases() {
        let status = |status: u16, code: &str| ApiError::Status {
            status,
            code: Some(code.into()),
            state: Some("expired".into()),
        };
        assert_eq!(
            message(&ApiError::Network),
            "서버에 연결할 수 없음 — 자동 재시도"
        );
        assert_eq!(
            message(&status(413, "fileTooLarge")),
            "파일이 너무 큼 (최대 2GB)"
        );
        assert_eq!(message(&status(409, "quotaExceeded")), "보관 한도 초과");
        assert_eq!(message(&status(410, "transferGone")), "만료됨 (받지 않음)");
        assert_eq!(
            message(&status(404, "targetDeviceUnknown")),
            "받는 기기가 등록 해제됨"
        );
        assert_eq!(
            message(&ApiError::Local(io::Error::from_raw_os_error(
                if cfg!(windows) { 112 } else { 28 }
            ))),
            "저장 공간 부족"
        );
        let (availability, _) = availability_for(&status(403, "exchangeDeviceTokenRequired"));
        assert!(availability.needs_token);
        assert_eq!(availability.message.as_deref(), Some(TOKEN_REQUIRED));
        assert_eq!(availability_for(&ApiError::Network).0.state, "offline");
    }

    #[test]
    fn sends_are_split_into_server_batches_of_one_hundred() {
        let sizes: Vec<usize> = batches((0..250).collect::<Vec<_>>())
            .iter()
            .map(Vec::len)
            .collect();
        assert_eq!(sizes, [100, 100, 50]);
        assert!(batches(Vec::<u8>::new()).is_empty());
        assert_eq!(batches(vec![1]).len(), 1);
    }

    #[test]
    fn a_missing_or_refused_token_parks_until_the_user_acts() {
        let missing = token_missing();
        assert!(missing.needs_token);
        let (availability, delay) = availability_for(&ApiError::Status {
            status: 403,
            code: Some("exchangeDeviceTokenRequired".into()),
            state: None,
        });
        assert!(availability.needs_token);
        assert_eq!(delay, WAIT_FOR_USER);
        let (_, delay) = availability_for(&ApiError::Status {
            status: 409,
            code: Some("exchangeDeviceLimit".into()),
            state: None,
        });
        assert_eq!(delay, REJECTED_RETRY);
        assert!(ApiError::TimedOut.transient());
    }
}
