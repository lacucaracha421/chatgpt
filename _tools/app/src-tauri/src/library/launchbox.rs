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
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const BULK_URL: &str = "https://gamesdb.launchbox-app.com/Metadata.zip";
const IMAGE_BASE: &str = "https://images.launchbox-app.com/";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// A failed or interrupted bulk download may be retried after this pause (user, 2026-10-01);
/// a successful download still holds for a day.
const RETRY_MS: u64 = 30 * 60 * 1000;
const IMAGE_INTERVAL_MS: u64 = 1000;
const MAX_BULK_BYTES: u64 = 256 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const INDEX_VERSION: u32 = 2;
// 3: games without a platform list match on any platform (2026-10-01).
const MATCH_VERSION: u32 = 3;
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
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SpineBatchRequest {
    #[serde(rename_all = "camelCase")]
    Run {
        job_id: String,
        limit: usize,
        after_collection_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Cancel { job_id: String },
}

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FETCH_STATE: Mutex<FetchState> = Mutex::new(FetchState {
    last_image_at: None,
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

// One shared lock covers bulk downloads, image pacing and cache updates across both commands.
#[derive(Default)]
pub struct FetchState {
    last_image_at: Option<u64>,
}
pub fn reserve(
    cache: &Path,
) -> Result<(MutexGuard<'static, FetchState>, super::lock::LibraryLease)> {
    let runner = FETCH_STATE.try_lock().map_err(|_| Error::Busy)?;
    fs::create_dir_all(cache)?;
    // The existing OS lease also excludes another app process and releases on a crash.
    let lease = super::lock::LibraryLease::acquire(cache).map_err(|error| match error {
        super::error::LibraryError::LibraryInUse => Error::Busy,
        other => Error::Library(other),
    })?;
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
pub struct Http {
    agent: ureq::Agent,
}
impl Default for Http {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
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
                .build()
                .into(),
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
        let timeout = if url == BULK_URL { 180 } else { 30 };
        let mut response = self
            .agent
            .get(url)
            .config()
            .timeout_global(Some(Duration::from_secs(timeout)))
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
fn cached_index(cache: &Path, state: &BulkState, cancel: &AtomicBool) -> Result<Index> {
    check_cancel(cancel)?;
    let generation = state.generation.as_deref().ok_or(Error::InvalidMetadata)?;
    uuid::Uuid::parse_str(generation).map_err(|_| Error::InvalidMetadata)?;
    let bulk_path = cache.join(format!("Metadata-{generation}.zip"));
    let index_path = cache.join(format!("index-{generation}.json"));
    if let Ok(index) = read_json::<Index>(&index_path, MAX_INDEX_BYTES) {
        if index.version == INDEX_VERSION && bulk_path.is_file() {
            return Ok(index);
        }
    }
    // A lost/corrupt derived index is rebuilt from the good ZIP, never redownloaded.
    let index = parse_zip(&bulk_path, cancel)?;
    write_json(&index_path, &index)?;
    Ok(index)
}
fn ensure_index(cache: &Path, io: &impl Transport, cancel: &AtomicBool) -> Result<Index> {
    fs::create_dir_all(cache)?;
    let state_path = cache.join("bulk-state.json");
    // Invalid bookkeeping fails closed rather than bypassing the daily limit.
    let mut state: BulkState = if state_path.exists() {
        read_json(&state_path, 4096)?
    } else {
        BulkState::default()
    };
    // An index upgrade uses the existing ZIP even when its daily refresh is due.
    if let Some(generation) = state.generation.as_deref() {
        uuid::Uuid::parse_str(generation).map_err(|_| Error::InvalidMetadata)?;
        let index_path = cache.join(format!("index-{generation}.json"));
        if cache.join(format!("Metadata-{generation}.zip")).is_file()
            && read_json::<Index>(&index_path, MAX_INDEX_BYTES)
                .map_or(true, |index| index.version != INDEX_VERSION)
        {
            return cached_index(cache, &state, cancel);
        }
    }
    if fresh(io.now_ms(), state.downloaded_at) {
        return cached_index(cache, &state, cancel);
    }
    if within(io.now_ms(), state.last_attempt_at, RETRY_MS) {
        if state.generation.is_none() {
            return Err(Error::Http("bulk_download_cooldown".into()));
        }
        return cached_index(cache, &state, cancel);
    }
    // Leftovers of a download the app did not finish (closed mid-way) are removed before retrying.
    if let Ok(entries) = fs::read_dir(cache) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    state.last_attempt_at = Some(io.now_ms());
    write_json(&state_path, &state)?; // A failed attempt pauses retries for RETRY_MS.
    let previous = state.generation.clone();
    let attempt = (|| {
        let mut temp = tempfile::NamedTempFile::new_in(cache)?;
        io.download(BULK_URL, MAX_BULK_BYTES, &mut temp, cancel)?;
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
        Ok(index)
    })();
    match attempt {
        Ok(index) => {
            if let Some(old) = previous.filter(|s| uuid::Uuid::parse_str(s).is_ok()) {
                let _ = fs::remove_file(cache.join(format!("Metadata-{old}.zip")));
                let _ = fs::remove_file(cache.join(format!("index-{old}.json")));
            }
            Ok(index)
        }
        Err(Error::Cancelled) => Err(Error::Cancelled),
        Err(error) => {
            // A failed refresh leaves the previous good cache usable, including offline.
            state.generation = previous;
            cached_index(cache, &state, cancel).or(Err(error))
        }
    }
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
        .split(['·', ',', ';', '|', '\n'])
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
impl FetchState {
    pub fn fetch_one(
        &mut self,
        library: &Library,
        cache: &Path,
        id: &str,
        cancel: &AtomicBool,
    ) -> Result<SpineOutcome> {
        self.one_with(
            library,
            cache,
            &load_game(library, id)?,
            &Http::default(),
            cancel,
            &mut None,
            &|_| {},
        )
    }
    fn one_with(
        &mut self,
        library: &Library,
        cache: &Path,
        game: &Game,
        io: &impl Transport,
        cancel: &AtomicBool,
        index: &mut Option<Index>,
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
                    && cached.outcome.status != OutcomeStatus::Matched
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
                *index = Some(ensure_index(cache, io, cancel)?);
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
        let mut stmt = connection.prepare("SELECT c.id FROM collections c WHERE c.type='game' AND (?1 IS NULL OR c.id>?1) AND NOT EXISTS(SELECT 1 FROM collection_work_artworks a WHERE a.collection_id=c.id AND a.kind='spine') ORDER BY c.id LIMIT ?2")?;
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
