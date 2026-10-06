//! Explicit LaunchBox spine lookup. Provider files and outcome history live in the app cache.
use super::{work_artwork::MAX_WORK_ARTWORK_BYTES, Library};
use quick_xml::{events::Event, Reader};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const BULK_URL: &str = "https://gamesdb.launchbox-app.com/Metadata.zip";
const IMAGE_BASE: &str = "https://images.launchbox-app.com/";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const WEEK_MS: u64 = 7 * DAY_MS;
const STALL_WINDOW_MS: u64 = 3 * 60 * 1000;
const MIN_BULK_BYTES_PER_SEC: u64 = 32 * 1024;
/// A failed or interrupted bulk download may be retried after this pause (user, 2026-10-01);
/// a successful download still holds for a week.
const RETRY_MS: u64 = 30 * 60 * 1000;
const IMAGE_INTERVAL_MS: u64 = 1000;
const MAX_BULK_BYTES: u64 = 256 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const INDEX_VERSION: u32 = 3;
// 4: retry old misses after IGDB names and first-release platforms are filled.
const MATCH_VERSION: u32 = 4;
pub const MAX_BATCH: usize = 250;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("LaunchBox lookup is already running")]
    Busy,
    #[error("Invalid LaunchBox request")]
    InvalidRequest,
    #[error("LaunchBox lookup cancelled")]
    Cancelled,
    #[error("Invalid LaunchBox metadata or cache")]
    InvalidMetadata,
    #[error("LaunchBox {0}")]
    Http(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Library(#[from] super::error::LibraryError),
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Library(error.into())
    }
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeStatus {
    Matched,
    NoMatch,
    Ambiguous,
    Failed,
    Skipped,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchedBy {
    Steam,
    Title,
    Alternate,
    Igdb,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpineOutcome {
    pub collection_id: String,
    pub status: OutcomeStatus,
    pub reason: String,
    pub artwork_id: Option<String>,
    pub database_id: Option<String>,
    pub platform: Option<String>,
    pub file_name: Option<String>,
    pub region: Option<String>,
    #[serde(default)]
    pub matched_by: Option<MatchedBy>,
    pub cached: bool,
    #[serde(default)]
    pub platforms_filled: usize,
    #[serde(default)]
    pub information_error: Option<String>,
    #[serde(default)]
    pub information_updated: bool,
}
impl SpineOutcome {
    fn new(id: &str, status: OutcomeStatus, reason: &str) -> Self {
        Self {
            collection_id: id.into(),
            status,
            reason: reason.into(),
            artwork_id: None,
            database_id: None,
            platform: None,
            file_name: None,
            region: None,
            matched_by: None,
            cached: false,
            platforms_filled: 0,
            information_error: None,
            information_updated: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpineProgress {
    pub job_id: String,
    pub phase: String,
    pub processed: usize,
    pub total: usize,
    pub outcome: Option<SpineOutcome>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpineBatchResult {
    pub job_id: String,
    pub cancelled: bool,
    pub outcomes: Vec<SpineOutcome>,
    /// Resume after this ID when hasMore is true. Cancelled work is not advanced past.
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub platforms_filled: usize,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SpineBatchRequest {
    #[serde(rename_all = "camelCase")]
    Run {
        job_id: String,
        limit: usize,
        after_collection_id: Option<String>,
        #[serde(default)]
        information_only: bool,
    },
    #[serde(rename_all = "camelCase")]
    Cancel { job_id: String },
}

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FETCH_STATE: Mutex<FetchState> = Mutex::new(FetchState {
    last_image_at: None,
    lookup_only: true,
});

pub struct Job {
    id: String,
    pub cancel: Arc<AtomicBool>,
}
impl Job {
    pub fn register(id: String) -> Result<Self> {
        uuid::Uuid::parse_str(&id).map_err(|_| Error::InvalidRequest)?;
        let mut jobs = JOBS.lock().map_err(|_| Error::Busy)?;
        if jobs.contains_key(&id) {
            return Err(Error::Busy);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(id.clone(), cancel.clone());
        Ok(Self { id, cancel })
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = JOBS.lock() {
            jobs.remove(&self.id);
        }
    }
}
pub fn cancel_job(id: &str) -> bool {
    if let Ok(jobs) = JOBS.lock() {
        if let Some(cancel) = jobs.get(id) {
            cancel.store(true, Ordering::Relaxed);
            return true;
        }
    }
    false
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

// Lookup leases preserve image pacing and outcome writes; refresh uses a separate lease.
#[derive(Default)]
pub struct FetchState {
    last_image_at: Option<u64>,
    lookup_only: bool,
}
pub fn reserve(
    cache: &Path,
) -> Result<(MutexGuard<'static, FetchState>, super::lock::LibraryLease)> {
    let runner = FETCH_STATE.try_lock().map_err(|_| Error::Busy)?;
    fs::create_dir_all(cache)?;
    // The existing OS lease also excludes another app process and releases on a crash.
    fs::create_dir_all(cache.join("lookup-lease"))?;
    let lease = super::lock::LibraryLease::acquire(&cache.join("lookup-lease")).map_err(
        |error| match error {
            super::error::LibraryError::LibraryInUse => Error::Busy,
            other => Error::Library(other),
        },
    )?;
    Ok((runner, lease))
}

trait Transport {
    fn now_ms(&self) -> u64;
    fn wait(&self, millis: u64, cancel: &AtomicBool) -> Result<()>;
    fn download(
        &self,
        url: &str,
        max: u64,
        output: &mut dyn Write,
        cancel: &AtomicBool,
    ) -> Result<()>;
}
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout,
    Transport as HttpTransport,
};

#[derive(Debug)]
struct StallConnector;
impl Connector<Box<dyn HttpTransport>> for StallConnector {
    type Out = Box<dyn HttpTransport>;
    fn connect(
        &self,
        _: &ConnectionDetails,
        chained: Option<Box<dyn HttpTransport>>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        Ok(chained.map(|inner| Box::new(StallTransport(inner)) as Self::Out))
    }
}
#[derive(Debug)]
struct StallTransport(Box<dyn HttpTransport>);
fn capped_read_timeout(mut timeout: NextTimeout) -> NextTimeout {
    timeout.after = timeout
        .after
        .min(ureq::unversioned::transport::time::Duration::from_millis(
            STALL_WINDOW_MS,
        ));
    timeout
}
impl HttpTransport for StallTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.0.buffers()
    }
    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        self.0.transmit_output(amount, timeout)
    }
    fn await_input(&mut self, timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        // A body with zero further bytes cannot reach the progress writer. Bound each
        // socket wait as well as checking throughput, without capping a healthy whole body.
        self.0.await_input(capped_read_timeout(timeout))
    }
    fn is_open(&mut self) -> bool {
        self.0.is_open()
    }
    fn is_tls(&self) -> bool {
        self.0.is_tls()
    }
}

pub struct Http {
    agent: ureq::Agent,
}
impl Default for Http {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::with_parts(
                ureq::Agent::config_builder()
                    .https_only(true)
                    .max_redirects(0)
                    .user_agent(concat!(
                        "Lakomics/",
                        env!("CARGO_PKG_VERSION"),
                        " (LaunchBox spine artwork lookup)"
                    ))
                    .timeout_connect(Some(Duration::from_secs(10)))
                    .timeout_recv_response(Some(Duration::from_secs(30)))
                    .timeout_recv_body(Some(Duration::from_secs(180)))
                    .timeout_global(Some(Duration::from_secs(180)))
                    .build(),
                DefaultConnector::default().chain(StallConnector),
                ureq::unversioned::resolver::DefaultResolver::default(),
            ),
        }
    }
}
impl Transport for Http {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    fn wait(&self, millis: u64, cancel: &AtomicBool) -> Result<()> {
        let mut remaining = millis;
        while remaining > 0 {
            check_cancel(cancel)?;
            let step = remaining.min(50);
            std::thread::sleep(Duration::from_millis(step));
            remaining -= step;
        }
        check_cancel(cancel)
    }
    fn download(
        &self,
        url: &str,
        max: u64,
        output: &mut dyn Write,
        cancel: &AtomicBool,
    ) -> Result<()> {
        check_cancel(cancel)?;
        let timeout = if url == BULK_URL { 30 * 60 } else { 30 };
        let mut response = self
            .agent
            .get(url)
            .config()
            .timeout_global(Some(Duration::from_secs(timeout)))
            .timeout_recv_body(Some(Duration::from_secs(timeout)))
            .build()
            .call()
            .map_err(|e| match e {
                ureq::Error::StatusCode(code) => Error::Http(format!("http_status_{code}")),
                _ => Error::Http("transport_error".into()),
            })?;
        let mut input = response.body_mut().as_reader();
        let mut total = 0;
        let mut buf = [0u8; 64 * 1024];
        loop {
            check_cancel(cancel)?;
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > max {
                return Err(Error::InvalidMetadata);
            }
            output.write_all(&buf[..n])?;
        }
        if total == 0 {
            return Err(Error::InvalidMetadata);
        }
        check_cancel(cancel)
    }
}

#[derive(Default, Serialize, Deserialize)]
struct BulkState {
    last_attempt_at: Option<u64>,
    downloaded_at: Option<u64>,
    generation: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SpineImage {
    file_name: String,
    region: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct IndexedGame {
    database_id: String,
    title: String,
    platform: String,
    #[serde(default)]
    release_date: Option<i64>,
    #[serde(default)]
    steam_app_id: Option<String>,
    #[serde(default)]
    alternate_names: Vec<String>,
    images: Vec<SpineImage>,
}
#[derive(Serialize, Deserialize)]
struct Index {
    version: u32,
    games: Vec<IndexedGame>,
}
#[derive(Serialize, Deserialize)]
struct CachedOutcome {
    fingerprint: String,
    at: u64,
    outcome: SpineOutcome,
}
#[derive(Debug)]
struct Game {
    id: String,
    title: String,
    original_title: Option<String>,
    platforms: Option<String>,
    owned: Option<String>,
    steam_app_id: Option<String>,
    igdb_name: Option<String>,
}
impl Game {
    fn fingerprint(&self) -> String {
        let bytes = serde_json::to_vec(&(
            MATCH_VERSION,
            &self.title,
            &self.original_title,
            &self.platforms,
            &self.owned,
            &self.steam_app_id,
            &self.igdb_name,
        ))
        .unwrap();
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path, max: u64) -> Result<T> {
    let file = File::open(path)?;
    if file.metadata()?.len() > max {
        return Err(Error::InvalidMetadata);
    }
    Ok(serde_json::from_reader(BufReader::new(file))?)
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().ok_or(Error::InvalidMetadata)?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temp, value)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn fresh(now: u64, then: Option<u64>) -> bool {
    within(now, then, DAY_MS)
}
fn within(now: u64, then: Option<u64>, span: u64) -> bool {
    then.is_some_and(|t| now.saturating_sub(t) < span)
}
static INDEX_CACHE: LazyLock<Mutex<Option<(PathBuf, (u64, SystemTime), Arc<Index>)>>> =
    LazyLock::new(|| Mutex::new(None));

struct DownloadProgress {
    since: u64,
    bytes: u64,
}
impl DownloadProgress {
    fn new(now: u64) -> Self {
        Self {
            since: now,
            bytes: 0,
        }
    }
    fn check(&mut self, now: u64, total: u64) -> Result<()> {
        let elapsed = now.saturating_sub(self.since);
        if elapsed >= STALL_WINDOW_MS {
            if total.saturating_sub(self.bytes) < MIN_BULK_BYTES_PER_SEC * elapsed / 1000 {
                return Err(Error::Http("bulk_download_stalled".into()));
            }
            self.since = now;
            self.bytes = total;
        }
        Ok(())
    }
}

struct BulkWriter<'a, T> {
    output: &'a mut dyn Write,
    io: &'a T,
    total: u64,
    progress: DownloadProgress,
}
impl<T: Transport> Write for BulkWriter<'_, T> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.progress
            .check(self.io.now_ms(), self.total + bytes.len() as u64)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let written = self.output.write(bytes)?;
        self.total += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.output.flush()
    }
}

fn current_index(cache: &Path, cancel: &AtomicBool) -> Result<Arc<Index>> {
    let state: BulkState = read_json(&cache.join("bulk-state.json"), 4096)?;
    cached_index(cache, &state, cancel, false)
}
fn cached_index(
    cache: &Path,
    state: &BulkState,
    cancel: &AtomicBool,
    rebuild: bool,
) -> Result<Arc<Index>> {
    check_cancel(cancel)?;
    let generation = state.generation.as_deref().ok_or(Error::InvalidMetadata)?;
    uuid::Uuid::parse_str(generation).map_err(|_| Error::InvalidMetadata)?;
    let bulk_path = cache.join(format!("Metadata-{generation}.zip"));
    let index_path = cache.join(format!("index-{generation}.json"));
    let stamp = fs::metadata(&index_path)
        .ok()
        .and_then(|m| Some((m.len(), m.modified().ok()?)));
    {
        let memory = INDEX_CACHE.lock().map_err(|_| Error::Busy)?;
        if let Some((path, cached_stamp, index)) = memory.as_ref() {
            if *path == index_path && stamp.as_ref() == Some(cached_stamp) && bulk_path.is_file() {
                return Ok(index.clone());
            }
        }
    }
    if let Ok(index) = read_json::<Index>(&index_path, MAX_INDEX_BYTES) {
        if index.version == INDEX_VERSION && bulk_path.is_file() {
            let index = Arc::new(index);
            *INDEX_CACHE.lock().map_err(|_| Error::Busy)? = Some((
                index_path.clone(),
                (
                    fs::metadata(&index_path)?.len(),
                    fs::metadata(&index_path)?.modified()?,
                ),
                index.clone(),
            ));
            return Ok(index);
        }
    }
    if !rebuild {
        return Err(Error::InvalidMetadata);
    }
    // A lost/corrupt derived index is rebuilt from the good ZIP, never redownloaded.
    let index = parse_zip(&bulk_path, cancel)?;
    write_json(&index_path, &index)?;
    let index = Arc::new(index);
    *INDEX_CACHE.lock().map_err(|_| Error::Busy)? = Some((
        index_path.clone(),
        (
            fs::metadata(&index_path)?.len(),
            fs::metadata(&index_path)?.modified()?,
        ),
        index.clone(),
    ));
    Ok(index)
}
fn ensure_index(cache: &Path, io: &impl Transport, cancel: &AtomicBool) -> Result<Arc<Index>> {
    fs::create_dir_all(cache)?;
    let lease_dir = cache.join("refresh-lease");
    fs::create_dir_all(&lease_dir)?;
    let _lease = match super::lock::LibraryLease::acquire(&lease_dir) {
        Ok(lease) => lease,
        Err(super::error::LibraryError::LibraryInUse) => return current_index(cache, cancel),
        Err(error) => return Err(error.into()),
    };
    let state_path = cache.join("bulk-state.json");
    // Invalid bookkeeping fails closed rather than bypassing the weekly limit.
    let mut state: BulkState = if state_path.exists() {
        read_json(&state_path, 4096)?
    } else {
        BulkState::default()
    };
    // An index upgrade uses the existing ZIP even when its weekly refresh is due.
    if let Some(generation) = state.generation.as_deref() {
        uuid::Uuid::parse_str(generation).map_err(|_| Error::InvalidMetadata)?;
        let index_path = cache.join(format!("index-{generation}.json"));
        if cache.join(format!("Metadata-{generation}.zip")).is_file()
            && read_json::<Index>(&index_path, MAX_INDEX_BYTES)
                .map_or(true, |index| index.version != INDEX_VERSION)
        {
            return cached_index(cache, &state, cancel, true);
        }
    }
    if within(io.now_ms(), state.downloaded_at, WEEK_MS) {
        return cached_index(cache, &state, cancel, true);
    }
    if within(io.now_ms(), state.last_attempt_at, RETRY_MS) {
        if state.generation.is_none() {
            return Err(Error::Http("bulk_download_cooldown".into()));
        }
        return cached_index(cache, &state, cancel, true);
    }
    // Leftovers of a download the app did not finish (closed mid-way) are removed before retrying.
    if let Ok(entries) = fs::read_dir(cache) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    if let Ok(entries) = fs::read_dir(cache) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let generation = name
                .strip_prefix("Metadata-")
                .and_then(|s| s.strip_suffix(".zip"))
                .or_else(|| {
                    name.strip_prefix("index-")
                        .and_then(|s| s.strip_suffix(".json"))
                });
            if generation.is_some_and(|g| {
                uuid::Uuid::parse_str(g).is_ok() && Some(g) != state.generation.as_deref()
            }) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    state.last_attempt_at = Some(io.now_ms());
    write_json(&state_path, &state)?; // A failed attempt pauses retries for RETRY_MS.
    let previous = state.generation.clone();
    let attempt = (|| {
        let mut temp = tempfile::NamedTempFile::new_in(cache)?;
        let mut output = BulkWriter {
            output: &mut temp,
            io,
            total: 0,
            progress: DownloadProgress::new(io.now_ms()),
        };
        io.download(BULK_URL, MAX_BULK_BYTES, &mut output, cancel)?;
        temp.as_file().sync_all()?;
        let index = parse_zip(temp.path(), cancel)?;
        check_cancel(cancel)?;
        let generation = uuid::Uuid::new_v4().to_string();
        let zip_path = cache.join(format!("Metadata-{generation}.zip"));
        let index_path = cache.join(format!("index-{generation}.json"));
        // Promote by switching a tiny manifest only after both files are complete.
        temp.persist(&zip_path).map_err(|e| e.error)?;
        if let Err(error) = write_json(&index_path, &index) {
            let _ = fs::remove_file(zip_path);
            return Err(error);
        }
        state.generation = Some(generation);
        state.downloaded_at = Some(io.now_ms());
        if let Err(error) = write_json(&state_path, &state) {
            let _ = fs::remove_file(zip_path);
            let _ = fs::remove_file(index_path);
            return Err(error);
        }
        let index = Arc::new(index);
        *INDEX_CACHE.lock().map_err(|_| Error::Busy)? = Some((
            index_path.clone(),
            (
                fs::metadata(&index_path)?.len(),
                fs::metadata(&index_path)?.modified()?,
            ),
            index.clone(),
        ));
        Ok(index)
    })();
    match attempt {
        Ok(index) => {
            // Readers may have captured the previous manifest. Keep that generation until
            // the next refresh; the refresh lease excludes competing cleanup/downloads.
            Ok(index)
        }
        Err(Error::Cancelled) => Err(Error::Cancelled),
        Err(error) => {
            // A failed refresh leaves the previous good cache usable, including offline.
            state.generation = previous;
            cached_index(cache, &state, cancel, true).or(Err(error))
        }
    }
}

pub fn refresh_due(cache: &Path, now: u64) -> bool {
    let state: BulkState = read_json(&cache.join("bulk-state.json"), 4096).unwrap_or_default();
    let needs_index = state.generation.as_ref().is_some_and(|g| {
        let path = cache.join(format!("index-{g}.json"));
        // Read only the current index header, not the game array, on the scheduler thread.
        File::open(path).ok().and_then(|mut file| {
            let mut header = [0; 64];
            let n = file.read(&mut header).ok()?;
            Some(
                String::from_utf8_lossy(&header[..n])
                    .contains(&format!("\"version\":{INDEX_VERSION},")),
            )
        }) != Some(true)
    });
    needs_index
        || (!within(now, state.downloaded_at, WEEK_MS)
            && !within(now, state.last_attempt_at, RETRY_MS))
}
pub fn refresh(cache: &Path, cancel: &AtomicBool) -> Result<()> {
    ensure_index(cache, &Http::default(), cancel).map(|_| ())
}

/// Stream one record at a time, keeping only the fields needed for spine lookup.
fn scan_xml(
    input: impl BufRead,
    record: &str,
    cancel: &AtomicBool,
    mut visit: impl FnMut(HashMap<String, String>) -> Result<()>,
) -> Result<()> {
    let mut reader = Reader::from_reader(input);
    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut fields = HashMap::new();
    let mut field: Option<String> = None;
    let mut in_record = false;
    let mut saw_root = false;
    let mut closed_root = false;
    let mut events = 0usize;
    loop {
        events += 1;
        if events % 1024 == 0 {
            check_cancel(cancel)?;
        }
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|_| Error::InvalidMetadata)?;
        match event {
            Event::Start(e) => {
                depth += 1;
                if depth == 1 {
                    if e.name().as_ref() != "LaunchBox" || saw_root {
                        return Err(Error::InvalidMetadata);
                    }
                    saw_root = true;
                }
                if depth == 2 && e.name().as_ref() == record {
                    in_record = true;
                    fields.clear();
                }
                if in_record && depth == 3 {
                    let name = e.name().as_ref().to_owned();
                    field = matches!(
                        name.as_str(),
                        "DatabaseID"
                            | "Name"
                            | "Platform"
                            | "ReleaseDate"
                            | "SteamAppId"
                            | "AlternateName"
                            | "Type"
                            | "FileName"
                            | "Region"
                    )
                    .then_some(name);
                }
            }
            Event::Text(e) if in_record && depth == 3 => {
                if let Some(name) = &field {
                    fields
                        .entry(name.clone())
                        .or_insert_with(String::new)
                        .push_str(&e.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Event::CData(e) if in_record && depth == 3 => {
                if let Some(name) = &field {
                    fields
                        .entry(name.clone())
                        .or_insert_with(String::new)
                        .push_str(&e.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Event::GeneralRef(e) if in_record && depth == 3 => {
                if let Some(name) = &field {
                    let value = match e.resolve_char_ref().map_err(|_| Error::InvalidMetadata)? {
                        Some(c) => c.to_string(),
                        None => match e.as_ref() {
                            "amp" => "&",
                            "lt" => "<",
                            "gt" => ">",
                            "quot" => "\"",
                            "apos" => "'",
                            _ => return Err(Error::InvalidMetadata),
                        }
                        .into(),
                    };
                    fields
                        .entry(name.clone())
                        .or_insert_with(String::new)
                        .push_str(&value);
                }
            }
            Event::End(_) => {
                if in_record && depth == 3 {
                    field = None;
                }
                if in_record && depth == 2 {
                    visit(std::mem::take(&mut fields))?;
                    in_record = false;
                }
                if depth == 1 {
                    closed_root = true;
                }
                depth = depth.checked_sub(1).ok_or(Error::InvalidMetadata)?;
            }
            Event::DocType(_) => return Err(Error::InvalidMetadata),
            Event::Eof => break,
            _ => {}
        }
        if buf.len() > 1024 * 1024 || fields.values().any(|s| s.len() > 64 * 1024) {
            return Err(Error::InvalidMetadata);
        }
        buf.clear();
    }
    check_cancel(cancel)?;
    if !saw_root || !closed_root || depth != 0 {
        return Err(Error::InvalidMetadata);
    }
    Ok(())
}
fn valid_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !name.contains("..")
        && matches!(
            name.rsplit('.')
                .next()
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("jpg" | "jpeg" | "png" | "webp")
        )
}
fn parse_zip(path: &Path, cancel: &AtomicBool) -> Result<Index> {
    let mut archive =
        zip::ZipArchive::new(File::open(path)?).map_err(|_| Error::InvalidMetadata)?;
    let mut images: HashMap<String, Vec<SpineImage>> = HashMap::new();
    {
        let xml = archive
            .by_name("Metadata.xml")
            .map_err(|_| Error::InvalidMetadata)?;
        if xml.size() > MAX_XML_BYTES {
            return Err(Error::InvalidMetadata);
        }
        scan_xml(
            BufReader::new(xml.take(MAX_XML_BYTES + 1)),
            "GameImage",
            cancel,
            |fields| {
                if fields.get("Type").map(|s| s.trim()) == Some("Box - Spine") {
                    let id = fields
                        .get("DatabaseID")
                        .ok_or(Error::InvalidMetadata)?
                        .trim();
                    let file_name = fields.get("FileName").ok_or(Error::InvalidMetadata)?.trim();
                    if !id.bytes().all(|b| b.is_ascii_digit())
                        || id.is_empty()
                        || !valid_filename(file_name)
                    {
                        return Err(Error::InvalidMetadata);
                    }
                    images.entry(id.into()).or_default().push(SpineImage {
                        file_name: file_name.into(),
                        region: fields
                            .get("Region")
                            .map(|s| s.trim().to_owned())
                            .unwrap_or_default(),
                    });
                    if images.len() > 250_000 {
                        return Err(Error::InvalidMetadata);
                    }
                }
                Ok(())
            },
        )?;
    }
    let mut alternate_names: HashMap<String, Vec<String>> = HashMap::new();
    {
        let xml = archive
            .by_name("Metadata.xml")
            .map_err(|_| Error::InvalidMetadata)?;
        scan_xml(
            BufReader::new(xml.take(MAX_XML_BYTES + 1)),
            "GameAlternateName",
            cancel,
            |fields| {
                if let (Some(id), Some(name)) =
                    (fields.get("DatabaseID"), fields.get("AlternateName"))
                {
                    let name = normalise_title(name, false);
                    if !name.is_empty() {
                        let names = alternate_names.entry(id.trim().into()).or_default();
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                    if alternate_names.len() > 250_000 {
                        return Err(Error::InvalidMetadata);
                    }
                }
                Ok(())
            },
        )?;
    }
    let mut games = Vec::new();
    {
        let xml = archive
            .by_name("Metadata.xml")
            .map_err(|_| Error::InvalidMetadata)?;
        scan_xml(
            BufReader::new(xml.take(MAX_XML_BYTES + 1)),
            "Game",
            cancel,
            |fields| {
                if let Some(id) = fields.get("DatabaseID").map(|s| s.trim()) {
                    let title = fields.get("Name").ok_or(Error::InvalidMetadata)?.trim();
                    let platform = fields.get("Platform").ok_or(Error::InvalidMetadata)?.trim();
                    if id.is_empty()
                        || !id.bytes().all(|b| b.is_ascii_digit())
                        || title.is_empty()
                        || platform.is_empty()
                    {
                        return Err(Error::InvalidMetadata);
                    }
                    // Identity sources (notably Windows Steam IDs) may have no spine.
                    games.push(IndexedGame {
                        database_id: id.into(),
                        title: title.into(),
                        platform: platform.into(),
                        release_date: fields
                            .get("ReleaseDate")
                            .and_then(|s| s.trim().get(..10))
                            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                            .map(|d| {
                                d.and_hms_opt(0, 0, 0)
                                    .unwrap()
                                    .and_utc()
                                    .timestamp()
                                    .div_euclid(86400)
                            }),
                        steam_app_id: fields
                            .get("SteamAppId")
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                            .map(Into::into),
                        alternate_names: alternate_names.remove(id).unwrap_or_default(),
                        images: images.remove(id).unwrap_or_default(),
                    });
                    if games.len() > 250_000 {
                        return Err(Error::InvalidMetadata);
                    }
                }
                Ok(())
            },
        )?;
    }
    Ok(Index {
        version: INDEX_VERSION,
        games,
    })
}

fn roman_number(word: &str) -> Option<u16> {
    static ROMAN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$").unwrap()
    });
    if word.is_empty() || !ROMAN.is_match(word) {
        return None;
    }
    let mut total = 0i32;
    let mut previous = 0;
    for c in word.chars().rev() {
        let value = match c {
            'i' => 1,
            'v' => 5,
            'x' => 10,
            'l' => 50,
            'c' => 100,
            'd' => 500,
            'm' => 1000,
            _ => return None,
        };
        total += if value < previous { -value } else { value };
        previous = value;
    }
    Some(total as u16)
}
fn normalise_title(title: &str, strip_subtitle: bool) -> String {
    let title = if strip_subtitle {
        title.split([':', '：']).next().unwrap_or(title)
    } else {
        title
    };
    let words = title
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '™' | '®' | '\'' | '’'))
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>();
    words
        .split_whitespace()
        .map(|word| {
            roman_number(word)
                .map(|n| n.to_string())
                .unwrap_or_else(|| word.into())
        })
        .collect()
}
fn platform_key(name: &str) -> String {
    let key = normalise_title(name, false);
    match key.as_str() {
        "nintendoswitch2" | "switch2" => "switch2",
        "nintendoswitch" | "switch" => "switch",
        "sonyplaystation5" | "playstation5" | "ps5" => "ps5",
        "sonyplaystation4" | "playstation4" | "ps4" => "ps4",
        "windows" | "pc" | "pcwindows" | "pcmicrosoftwindows" | "steam" | "linux" | "mac"
        | "macos" | "applemacos" => "pc",
        "sonyplaystation3" | "playstation3" | "ps3" => "ps3",
        "sonyplaystation2" | "playstation2" | "ps2" => "ps2",
        "nintendogamecube" | "gamecube" => "gamecube",
        "microsoftxboxseriesxs"
        | "xboxseriesxs"
        | "microsoftxboxseriesx"
        | "xboxseriesx"
        | "xboxseriess" => "xboxseries",
        "microsoftxboxone" | "xboxone" => "xboxone",
        _ => return key,
    }
    .into()
}
fn region_rank(region: &str) -> u8 {
    match region.to_lowercase().as_str() {
        "korea" | "south korea" => 0,
        "japan" => 1,
        "north america" => 2,
        "world" => 3,
        _ => 4,
    }
}
fn resolve_name(
    game: &Game,
    index: &Index,
) -> std::result::Result<(String, MatchedBy), (&'static str, OutcomeStatus)> {
    let titles: Vec<_> = [
        &game.title[..],
        game.original_title.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .map(|title| normalise_title(title, false))
    .filter(|title| !title.is_empty())
    .collect();
    let mut names = Vec::new();
    if let Some(steam_id) = game.steam_app_id.as_deref() {
        for candidate in &index.games {
            if candidate.steam_app_id.as_deref() == Some(steam_id) {
                names.push((normalise_title(&candidate.title, false), MatchedBy::Steam));
            }
        }
    }
    for candidate in &index.games {
        let name = normalise_title(&candidate.title, false);
        if titles.contains(&name) {
            names.push((name, MatchedBy::Title));
        }
    }
    for candidate in &index.games {
        if candidate
            .alternate_names
            .iter()
            .any(|name| titles.contains(name))
        {
            names.push((
                normalise_title(&candidate.title, false),
                MatchedBy::Alternate,
            ));
        }
    }
    if let Some(name) = game.igdb_name.as_deref() {
        let name = normalise_title(name, false);
        if !name.is_empty() {
            names.push((name, MatchedBy::Igdb));
        }
    }
    let first = names
        .first()
        .ok_or(("no_title_platform_match", OutcomeStatus::NoMatch))?;
    if names.iter().any(|(name, _)| name != &first.0) {
        return Err(("conflicting_canonical_names", OutcomeStatus::Ambiguous));
    }
    Ok(first.clone())
}
fn match_game<'a>(
    game: &Game,
    index: &'a Index,
) -> std::result::Result<(&'a IndexedGame, &'a SpineImage, MatchedBy), (&'static str, OutcomeStatus)>
{
    let mut platforms: Vec<String> = game
        .platforms
        .as_deref()
        .unwrap_or("")
        .split(['·', ',', ';', '\n'])
        .filter(|p| !p.trim().is_empty())
        .map(platform_key)
        .collect();
    let owned = game
        .owned
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(platform_key);
    if let Some(p) = &owned {
        platforms.push(p.clone());
    }
    // Most library games have no platform list (user's library, 2026-10-01: 378 of 388).
    // Then every platform is allowed and the usual order (owned, Switch 2 … PC) decides.
    let any_platform = platforms.is_empty();
    let (canonical_name, matched_by) = resolve_name(game, index)?;
    let mut candidates = Vec::new();
    for candidate in &index.games {
        let platform = platform_key(&candidate.platform);
        if (!any_platform && !platforms.contains(&platform))
            || candidate.images.is_empty()
            || normalise_title(&candidate.title, false) != canonical_name
        {
            continue;
        }
        let rank = if owned.as_ref() == Some(&platform) {
            0
        } else if let Some(position) = platforms.iter().position(|p| p == &platform) {
            position + 1
        } else {
            match platform.as_str() {
                "switch2" => 1,
                "switch" => 2,
                "ps5" => 3,
                "ps4" => 4,
                "pc" => 5,
                _ => 6,
            }
        };
        candidates.push((rank, candidate));
    }
    let best = candidates
        .iter()
        .map(|(score, _)| *score)
        .min()
        .ok_or(("no_title_platform_match", OutcomeStatus::NoMatch))?;
    let best: Vec<_> = candidates
        .into_iter()
        .filter(|(score, _)| *score == best)
        .map(|(_, c)| c)
        .collect();
    if best.len() != 1 {
        return Err(("multiple_game_matches", OutcomeStatus::Ambiguous));
    }
    let candidate = best[0];
    let image = candidate
        .images
        .iter()
        .min_by_key(|i| (region_rank(&i.region), &i.file_name))
        .ok_or(("no_spine_image", OutcomeStatus::NoMatch))?;
    Ok((candidate, image, matched_by))
}

fn load_game(library: &Library, id: &str) -> Result<Game> {
    uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidRequest)?;
    load_game_on(&*library.connection()?, id)
}
fn load_game_on(connection: &rusqlite::Connection, id: &str) -> Result<Game> {
    let mut game = connection.query_row(
        "SELECT c.id,c.name,c.original_title,c.platforms,p.owned_platform,s.external_id,i.provider_data_json FROM collections c LEFT JOIN collection_pc_records p ON p.collection_id=c.id LEFT JOIN collection_external_bindings s ON s.collection_id=c.id AND s.provider='steam' LEFT JOIN collection_external_bindings i ON i.collection_id=c.id AND i.provider='igdb' WHERE c.id=?1 AND c.type='game'",
        [id], |r| Ok(Game { id:r.get(0)?,title:r.get(1)?,original_title:r.get(2)?,platforms:r.get(3)?,owned:r.get(4)?,steam_app_id:r.get(5)?,igdb_name:r.get(6)? }))
        .optional()?.ok_or(Error::InvalidRequest)?;
    game.steam_app_id = game.steam_app_id.map(|id| id.trim().to_owned());
    game.igdb_name = game
        .igdb_name
        .as_deref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|data| {
            data.get("name")
                .and_then(|name| name.as_str())
                .map(str::to_owned)
        });
    Ok(game)
}
fn has_spine(library: &Library, id: &str) -> Result<bool> {
    Ok(library.connection()?.query_row("SELECT EXISTS(SELECT 1 FROM collection_work_artworks WHERE collection_id=?1 AND kind='spine')",[id],|r|r.get(0))?)
}
fn store_spine(
    library: &Library,
    game: &Game,
    candidate: &IndexedGame,
    image: &SpineImage,
    bytes: &[u8],
) -> Result<Option<String>> {
    super::collection_authority::fence_collection_operation(&*library.connection()?)?;
    let prepared = library.prepare_work_artwork(&game.id, bytes)?;
    let mut connection = library.connection()?;
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // Recheck inside the write transaction: a selection/import may have happened during HTTP.
    let current = load_game_on(&tx, &game.id)?;
    if current.fingerprint() != game.fingerprint() {
        return Err(Error::InvalidRequest);
    }
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_work_artworks WHERE collection_id=?1 AND kind='spine')",[&game.id],|r|r.get(0))?;
    if exists {
        return Ok(None);
    }
    let now = chrono::Utc::now().to_rfc3339();
    // Do not call the provider replacement helper: it intentionally deselects other artwork.
    tx.execute("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,language,selected,created_at,updated_at) VALUES(?1,?2,'launchbox',?3,'spine',?4,?5,?6,?7,?8,CASE WHEN EXISTS(SELECT 1 FROM collection_work_artworks WHERE collection_id=?2 AND kind='spine' AND selected=1) THEN 0 ELSE 1 END,?9,?9)",
        params![prepared.id,game.id,format!("{}/{}",candidate.database_id,image.file_name),prepared.relative_path,prepared.mime_type,prepared.width,prepared.height,Option::<&str>::None,now])?;
    tx.commit()?;
    let id = prepared.id.clone();
    prepared.commit();
    Ok(Some(id))
}
fn fill_launchbox_platforms(
    library: &Library,
    id: &str,
    index: &Index,
    cancel: &AtomicBool,
) -> Result<bool> {
    check_cancel(cancel)?;
    let mut connection = library.connection()?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    super::collection_authority::fence_collection_operation(&transaction)?;
    let game = load_game_on(&transaction, id)?;
    if game
        .platforms
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Ok(false);
    }
    let bound: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM collection_external_bindings WHERE collection_id=?1 AND provider='igdb')", [id], |r| r.get(0))?;
    if bound {
        return Ok(false);
    }
    let Ok((name, _)) = resolve_name(&game, index) else {
        return Ok(false);
    };
    let platforms = super::igdb_flow::ordered_platforms(
        index
            .games
            .iter()
            .filter(|g| normalise_title(&g.title, false) == name)
            .map(|g| (g.platform.clone(), g.release_date)),
    )
    .join(" · ");
    if platforms.is_empty() {
        return Ok(false);
    }
    check_cancel(cancel)?;
    // Identity and emptiness were checked under the same write transaction.
    let changed = transaction.execute("UPDATE collections SET platforms=?1,updated_at=?2 WHERE id=?3 AND (platforms IS NULL OR trim(platforms)='')",
        params![platforms,chrono::Utc::now().to_rfc3339(),id])?;
    transaction.commit()?;
    Ok(changed > 0)
}

impl FetchState {
    fn index(&self, cache: &Path, io: &impl Transport, cancel: &AtomicBool) -> Result<Arc<Index>> {
        if self.lookup_only {
            current_index(cache, cancel)
        } else {
            ensure_index(cache, io, cancel)
        }
    }
    pub fn fetch_one(
        &mut self,
        library: &Library,
        cache: &Path,
        id: &str,
        cancel: &AtomicBool,
    ) -> Result<SpineOutcome> {
        super::collection_authority::fence_collection_operation(&*library.connection()?)?;
        let mut information_error = None;
        let platforms_filled = std::cell::Cell::new(0);
        let information_updated = std::cell::Cell::new(false);
        if let Err(error) = library.fill_bound_igdb_games(&[id.to_owned()], cancel, &|_, result| {
            if result.is_ok() {
                information_updated.set(true);
            }
            if matches!(result, Ok(true)) {
                platforms_filled.set(platforms_filled.get() + 1);
            }
        }) {
            information_error = Some(error.to_string());
        }
        check_cancel(cancel)?;
        let mut index = None;
        if library.get_igdb_connection(id)?.is_none()
            && load_game(library, id)?
                .platforms
                .as_deref()
                .map_or(true, |s| s.trim().is_empty())
        {
            match current_index(cache, cancel) {
                Ok(loaded) => {
                    index = Some(loaded);
                    if fill_launchbox_platforms(library, id, index.as_ref().unwrap(), cancel)? {
                        platforms_filled.set(platforms_filled.get() + 1);
                    }
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(error) => information_error = Some(error.to_string()),
            }
        }
        let mut outcome = self.one_with(
            library,
            cache,
            &load_game(library, id)?,
            &Http::default(),
            cancel,
            &mut index,
            &|_| {},
        )?;
        outcome.platforms_filled = platforms_filled.get();
        outcome.information_error = information_error;
        outcome.information_updated = information_updated.get() || platforms_filled.get() > 0;
        Ok(outcome)
    }

    pub fn fill_information(
        &mut self,
        library: &Library,
        cache: &Path,
        job: &Job,
        limit: usize,
        after: Option<String>,
        report: &dyn Fn(SpineProgress),
    ) -> Result<SpineBatchResult> {
        super::collection_authority::fence_collection_operation(&*library.connection()?)?;
        self.information_with(
            library,
            cache,
            &job.id,
            limit,
            after,
            &Http::default(),
            &job.cancel,
            &mut |ids, cancel, callback| library.fill_bound_igdb_games(ids, cancel, callback),
            report,
        )
    }

    fn information_with(
        &mut self,
        library: &Library,
        cache: &Path,
        job_id: &str,
        limit: usize,
        after: Option<String>,
        io: &impl Transport,
        cancel: &AtomicBool,
        fill: &mut dyn FnMut(
            &[String],
            &AtomicBool,
            &dyn Fn(&str, std::result::Result<bool, super::error::LibraryError>),
        ) -> std::result::Result<(), super::error::LibraryError>,
        report: &dyn Fn(SpineProgress),
    ) -> Result<SpineBatchResult> {
        if limit == 0 || limit > MAX_BATCH {
            return Err(Error::InvalidRequest);
        }
        if let Some(id) = &after {
            uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidRequest)?;
        }
        let connection = library.connection()?;
        let total: i64 = connection.query_row("SELECT COUNT(*) FROM collections c LEFT JOIN collection_external_bindings i ON i.collection_id=c.id AND i.provider='igdb' WHERE c.type='game' AND (?1 IS NULL OR c.id>?1) AND ((c.platforms IS NULL OR trim(c.platforms)='') OR (i.external_id IS NOT NULL AND (i.provider_data_json IS NULL OR NOT json_valid(i.provider_data_json) OR trim(COALESCE(json_extract(CASE WHEN json_valid(i.provider_data_json) THEN i.provider_data_json ELSE '{}' END,'$.name'),''))='')))", [&after], |r| r.get(0))?;
        let mut stmt = connection.prepare("SELECT c.id FROM collections c LEFT JOIN collection_external_bindings i ON i.collection_id=c.id AND i.provider='igdb' WHERE c.type='game' AND (?1 IS NULL OR c.id>?1) AND ((c.platforms IS NULL OR trim(c.platforms)='') OR (i.external_id IS NOT NULL AND (i.provider_data_json IS NULL OR NOT json_valid(i.provider_data_json) OR trim(COALESCE(json_extract(CASE WHEN json_valid(i.provider_data_json) THEN i.provider_data_json ELSE '{}' END,'$.name'),''))=''))) ORDER BY c.id LIMIT ?2")?;
        let ids = stmt
            .query_map(params![after, limit as i64], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let total = total as usize;
        let more = total > limit;
        drop(stmt);
        drop(connection);
        let mut result = SpineBatchResult {
            job_id: job_id.into(),
            cancelled: false,
            outcomes: vec![],
            next_cursor: after,
            has_more: more,
            platforms_filled: 0,
        };
        report(SpineProgress {
            job_id: job_id.into(),
            phase: "information".into(),
            processed: 0,
            total,
            outcome: None,
        });
        let fetched = std::cell::RefCell::new(HashMap::new());
        let information_processed = std::cell::Cell::new(0);
        let error = fill(&ids, cancel, &|id, outcome| {
            fetched.borrow_mut().insert(id.to_owned(), outcome);
            information_processed.set(information_processed.get() + 1);
            report(SpineProgress {
                job_id: job_id.into(),
                phase: "information".into(),
                processed: information_processed.get(),
                total,
                outcome: None,
            });
        })
        .err()
        .map(|e| e.to_string());
        result.platforms_filled = fetched
            .borrow()
            .values()
            .filter(|v| matches!(v, Ok(true)))
            .count();
        let mut index = None;
        for id in ids {
            if cancel.load(Ordering::Relaxed) {
                result.cancelled = true;
                result.has_more = true;
                break;
            }
            let mut outcome = SpineOutcome::new(&id, OutcomeStatus::Skipped, "information_checked");
            match fetched.borrow_mut().remove(&id) {
                Some(Ok(true)) => outcome.platforms_filled = 1,
                Some(Err(e)) => outcome.information_error = Some(e.to_string()),
                _ => {
                    if library.get_igdb_connection(&id)?.is_some() {
                        outcome.information_error = error.clone();
                    }
                }
            }
            if library.get_igdb_connection(&id)?.is_none()
                && load_game(library, &id)?
                    .platforms
                    .as_deref()
                    .map_or(true, |s| s.trim().is_empty())
            {
                let attempt = (|| {
                    if index.is_none() {
                        index = Some(self.index(cache, io, cancel)?);
                    }
                    fill_launchbox_platforms(library, &id, index.as_ref().unwrap(), cancel)
                })();
                match attempt {
                    Ok(true) => {
                        outcome.platforms_filled = 1;
                        result.platforms_filled += 1;
                    }
                    Err(Error::Cancelled) => {
                        result.cancelled = true;
                        result.has_more = true;
                        break;
                    }
                    Err(e) => outcome.information_error = Some(e.to_string()),
                    _ => {}
                }
            }
            result.next_cursor = Some(id);
            result.outcomes.push(outcome.clone());
            report(SpineProgress {
                job_id: job_id.into(),
                phase: "information".into(),
                processed: result.outcomes.len().max(information_processed.get()),
                total,
                outcome: Some(outcome),
            });
        }
        Ok(result)
    }

    fn one_with(
        &mut self,
        library: &Library,
        cache: &Path,
        game: &Game,
        io: &impl Transport,
        cancel: &AtomicBool,
        index: &mut Option<Arc<Index>>,
        phase: &dyn Fn(&str),
    ) -> Result<SpineOutcome> {
        check_cancel(cancel)?;
        if has_spine(library, &game.id)? {
            return Ok(SpineOutcome::new(
                &game.id,
                OutcomeStatus::Skipped,
                "already_has_spine",
            ));
        }
        let outcome_path = cache
            .join("outcomes")
            .join(library.library_id()?)
            .join(format!("{}.json", game.id));
        let fingerprint = game.fingerprint();
        if outcome_path.exists() {
            if let Ok(cached) = read_json::<CachedOutcome>(&outcome_path, 64 * 1024) {
                if cached.fingerprint == fingerprint
                    && fresh(io.now_ms(), Some(cached.at))
                    // A failure (network, download pause) is transient; only real "no match" answers are reused.
                    && !matches!(
                        cached.outcome.status,
                        OutcomeStatus::Matched | OutcomeStatus::Failed
                    )
                {
                    let mut outcome = cached.outcome;
                    outcome.cached = true;
                    return Ok(outcome);
                }
            }
        }
        let attempt = (|| {
            if normalise_title(&game.title, false).is_empty()
                && normalise_title(game.original_title.as_deref().unwrap_or(""), false).is_empty()
                && game.steam_app_id.as_deref().unwrap_or("").is_empty()
                && normalise_title(game.igdb_name.as_deref().unwrap_or(""), false).is_empty()
            {
                return Ok(SpineOutcome::new(
                    &game.id,
                    OutcomeStatus::NoMatch,
                    "missing_title",
                ));
            }
            if index.is_none() {
                phase("loading_metadata");
                *index = Some(self.index(cache, io, cancel)?);
            }
            let (candidate, image, matched_by) = match match_game(game, index.as_ref().unwrap()) {
                Ok(found) => found,
                Err((reason, status)) => return Ok(SpineOutcome::new(&game.id, status, reason)),
            };
            if !valid_filename(&image.file_name) {
                return Err(Error::InvalidMetadata);
            }
            check_cancel(cancel)?;
            if has_spine(library, &game.id)? {
                return Ok(SpineOutcome::new(
                    &game.id,
                    OutcomeStatus::Skipped,
                    "already_has_spine",
                ));
            }
            let pacing_path = cache.join("last-image-request.json");
            let previous: Option<u64> = if pacing_path.exists() {
                Some(read_json(&pacing_path, 64)?)
            } else {
                None
            };
            if let Some(last) = previous.into_iter().chain(self.last_image_at).max() {
                io.wait(
                    IMAGE_INTERVAL_MS.saturating_sub(io.now_ms().saturating_sub(last)),
                    cancel,
                )?;
            }
            check_cancel(cancel)?;
            phase("fetching_image");
            // Persist pacing before HTTP, including failures, across app restarts/processes.
            write_json(&pacing_path, &io.now_ms())?;
            self.last_image_at = Some(io.now_ms());
            let mut bytes = Vec::new();
            io.download(
                &format!("{IMAGE_BASE}{}", image.file_name),
                MAX_WORK_ARTWORK_BYTES as u64,
                &mut bytes,
                cancel,
            )?;
            check_cancel(cancel)?;
            let Some(id) = store_spine(library, game, candidate, image, &bytes)? else {
                return Ok(SpineOutcome::new(
                    &game.id,
                    OutcomeStatus::Skipped,
                    "already_has_spine",
                ));
            };
            let mut outcome = SpineOutcome::new(&game.id, OutcomeStatus::Matched, "spine_imported");
            outcome.matched_by = Some(matched_by);
            outcome.artwork_id = Some(id);
            outcome.database_id = Some(candidate.database_id.clone());
            outcome.platform = Some(candidate.platform.clone());
            outcome.file_name = Some(image.file_name.clone());
            outcome.region = Some(image.region.clone());
            Ok(outcome)
        })();
        let outcome = match attempt {
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(error) => SpineOutcome::new(&game.id, OutcomeStatus::Failed, &error.to_string()),
            Ok(outcome) => outcome,
        };
        write_json(
            &outcome_path,
            &CachedOutcome {
                fingerprint,
                at: io.now_ms(),
                outcome: outcome.clone(),
            },
        )?;
        Ok(outcome)
    }
    pub fn fetch_batch(
        &mut self,
        library: &Library,
        cache: &Path,
        job: &Job,
        limit: usize,
        after: Option<String>,
        report: &dyn Fn(SpineProgress),
    ) -> Result<SpineBatchResult> {
        super::collection_authority::fence_collection_operation(&*library.connection()?)?;
        self.batch_with(
            library,
            cache,
            &job.id,
            limit,
            after,
            &Http::default(),
            &job.cancel,
            report,
        )
    }
    fn batch_with(
        &mut self,
        library: &Library,
        cache: &Path,
        job_id: &str,
        limit: usize,
        after: Option<String>,
        io: &impl Transport,
        cancel: &AtomicBool,
        report: &dyn Fn(SpineProgress),
    ) -> Result<SpineBatchResult> {
        if limit == 0 || limit > MAX_BATCH {
            return Err(Error::InvalidRequest);
        }
        if let Some(id) = &after {
            uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidRequest)?;
        }
        let connection = library.connection()?;
        let mut stmt = connection.prepare("SELECT c.id FROM collections c WHERE c.type='game' AND (?1 IS NULL OR c.id>?1) ORDER BY c.id LIMIT ?2")?;
        let mut ids = stmt
            .query_map(params![after, (limit + 1) as i64], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(connection);
        let more = ids.len() > limit;
        ids.truncate(limit);
        let total = ids.len();
        let mut result = SpineBatchResult {
            job_id: job_id.into(),
            cancelled: false,
            outcomes: Vec::new(),
            next_cursor: after,
            has_more: more,
            platforms_filled: 0,
        };
        let mut index = None;
        report(SpineProgress {
            job_id: job_id.into(),
            phase: "started".into(),
            processed: 0,
            total,
            outcome: None,
        });
        for id in ids {
            let processed = result.outcomes.len();
            let phase = |phase: &str| {
                report(SpineProgress {
                    job_id: job_id.into(),
                    phase: phase.into(),
                    processed,
                    total,
                    outcome: None,
                })
            };
            let outcome = if cancel.load(Ordering::Relaxed) {
                Err(Error::Cancelled)
            } else {
                load_game(library, &id).and_then(|game| {
                    self.one_with(library, cache, &game, io, cancel, &mut index, &phase)
                })
            };
            let outcome = match outcome {
                Err(Error::Cancelled) => {
                    result.cancelled = true;
                    result.has_more = true;
                    break;
                }
                Err(error) => SpineOutcome::new(&id, OutcomeStatus::Failed, &error.to_string()),
                Ok(outcome) => outcome,
            };
            result.next_cursor = Some(id);
            result.outcomes.push(outcome.clone());
            report(SpineProgress {
                job_id: job_id.into(),
                phase: "game_completed".into(),
                processed: processed + 1,
                total,
                outcome: Some(outcome),
            });
        }
        report(SpineProgress {
            job_id: job_id.into(),
            phase: if result.cancelled {
                "cancelled"
            } else {
                "completed"
            }
            .into(),
            processed: result.outcomes.len(),
            total,
            outcome: None,
        });
        Ok(result)
    }
}

#[cfg(test)]
#[path = "launchbox_tests.rs"]
mod tests;
