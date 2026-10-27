//! Settings snapshots and manual intent. Workers retain their provider and data-safety gates.
use crate::library::{error::LibraryError, models::CatalogLanguage, Library};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;

pub(crate) const IDS: [&str; 13] = [
    "catalog",
    "releaseCalendar",
    "releaseWatch",
    "launchbox",
    "autoTags",
    "characters",
    "similarity",
    "videos",
    "mangaSpines",
    "cardCutouts",
    "cloudBackfill",
    "backup",
    "trash",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastRun {
    pub at: Option<String>,
    pub ok: Option<bool>,
    pub count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub done: u64,
    pub total: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoJobStatus {
    id: String,
    state: String,
    waiting_reason: Option<String>,
    unconfigured_reason: Option<String>,
    enabled: Option<bool>,
    last_run_at: Option<String>,
    #[serde(skip)]
    last_success_at: Option<String>,
    overdue_since: Option<String>,
    last_ok: Option<bool>,
    last_error: Option<String>,
    last_count: Option<u64>,
    next_run_at: Option<String>,
    interval_seconds: Option<u64>,
    progress: Option<Progress>,
    pending: Option<u64>,
    failed: Option<u64>,
    can_stop: bool,
}
impl AutoJobStatus {
    fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            state: "idle".into(),
            waiting_reason: None,
            unconfigured_reason: None,
            enabled: None,
            last_run_at: None,
            last_success_at: None,
            overdue_since: None,
            last_ok: None,
            last_error: None,
            last_count: None,
            next_run_at: None,
            interval_seconds: None,
            progress: None,
            pending: None,
            failed: None,
            can_stop: false,
        }
    }
    fn unconfigured(&mut self, reason: &str) {
        self.state = "unconfigured".into();
        self.waiting_reason = None;
        self.can_stop = false;
        self.unconfigured_reason = Some(reason.into());
    }
    fn overdue(&mut self, now: chrono::DateTime<chrono::Utc>, at: Option<&str>) {
        self.overdue_since = None;
        if self.enabled == Some(false)
            || matches!(self.state.as_str(), "off" | "unconfigured" | "running")
        {
            return;
        }
        let gap = match self.id.as_str() {
            "catalog" => self.interval_seconds.map(|seconds| seconds as i64 + 7200),
            "releaseCalendar" | "backup" | "trash" | "autoTags" => Some(26 * 3600),
            "releaseWatch" => Some(3 * 3600),
            "launchbox" => Some(8 * 24 * 3600),
            _ if self.pending.unwrap_or(0) > 0 => Some(24 * 3600),
            _ => None,
        };
        self.overdue_since = at
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .zip(gap)
            .map(|(at, gap)| at + chrono::Duration::seconds(gap))
            .filter(|due| *due < now)
            .map(|due| due.to_rfc3339());
    }
    fn last(&mut self, at: Option<String>, ok: Option<bool>, count: Option<u64>) {
        let parsed = at
            .as_deref()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
        if ok == Some(true)
            && parsed
                > self
                    .last_success_at
                    .as_deref()
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        {
            self.last_success_at = at.clone();
        }
        if self.last_run_at.is_some()
            && parsed
                < self
                    .last_run_at
                    .as_deref()
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        {
            return;
        }
        self.last_run_at = at;
        self.last_ok = ok;
        self.last_count = ok.and(count);
        self.last_error = (ok == Some(false)).then(|| {
            match self.id.as_str() {
                "catalog" => "카탈로그 갱신 실패",
                "releaseCalendar" | "releaseWatch" => "발매 정보 확인 실패",
                "launchbox" => "LaunchBox 갱신 실패",
                "autoTags" => "자동 태그 가져오기 실패",
                "characters" => "캐릭터 분석 실패",
                "similarity" => "유사 이미지 준비 실패",
                "videos" => "동영상 준비 실패",
                "mangaSpines" => "책등 스캔 받기 실패",
                "cardCutouts" => "카드 누끼 만들기 실패",
                "cloudBackfill" => "클라우드 전송 실패",
                "backup" => "백업 만들기 실패",
                "trash" => "휴지통 비우기 실패",
                _ => "작업 실패",
            }
            .into()
        });
    }
}

#[derive(Default)]
struct Runtime {
    running: bool,
    manual: bool,
    stop: bool,
    last: LastRun,
    progress: Option<Progress>,
    pending: Option<u64>,
    failed: Option<u64>,
    waiting: Option<String>,
    unconfigured: Option<String>,
}
type Key = (PathBuf, String);
static LAUNCHBOX_CACHE: OnceLock<PathBuf> = OnceLock::new();
fn configure_paths(app: &tauri::AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = LAUNCHBOX_CACHE.set(cache.join("launchbox"));
    }
}
fn runtime() -> &'static Mutex<BTreeMap<Key, Runtime>> {
    static STATE: OnceLock<Mutex<BTreeMap<Key, Runtime>>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}
thread_local! { static MANUAL: RefCell<Option<Key>> = const { RefCell::new(None) }; }
pub(crate) fn running(library: &Library, id: &str) -> bool {
    runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&(library.root().into(), id.into()))
        .is_some_and(|row| row.running)
}
pub(crate) fn manual(library: &Library, id: &str) -> bool {
    MANUAL.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|key| key.0 == library.root() && key.1 == id)
    })
}
pub(crate) struct ManualScope(Option<Key>);
impl ManualScope {
    fn enter(library: &Library, id: &str) -> Self {
        Self(MANUAL.with(|slot| slot.replace(Some((library.root().into(), id.into())))))
    }
    pub(crate) fn owner(library: &Library, id: &str) -> Self {
        let previous = MANUAL.with(|slot| {
            slot.replace(manual_active(library, id).then(|| (library.root().into(), id.into())))
        });
        Self(previous)
    }
}
impl Drop for ManualScope {
    fn drop(&mut self) {
        MANUAL.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}
pub(crate) fn owner_started(library: &Library, id: &str) {
    let mut state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let row = state.entry((library.root().into(), id.into())).or_default();
    row.running = true;
    row.waiting = None;
    row.unconfigured = None;
}
pub(crate) fn owner_wait(
    library: &Library,
    id: &str,
    reason: Option<&str>,
    unconfigured: Option<&str>,
) {
    let mut state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let row = state.entry((library.root().into(), id.into())).or_default();
    row.waiting = reason.map(str::to_owned);
    row.unconfigured = unconfigured.map(str::to_owned);
    if unconfigured.is_some() || row.stop {
        row.running = false;
        row.manual = false;
    }
}
pub(crate) fn manual_active(library: &Library, id: &str) -> bool {
    runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&(library.root().into(), id.into()))
        .is_some_and(|r| r.manual && !r.stop)
}
pub(crate) fn stopped(library: &Library, id: &str) -> bool {
    runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&(library.root().into(), id.into()))
        .is_some_and(|r| r.stop)
}
pub(crate) fn progress(
    library: &Library,
    id: &str,
    done: u64,
    total: u64,
    pending: Option<u64>,
    failed: Option<u64>,
) {
    let mut state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let row = state.entry((library.root().into(), id.into())).or_default();
    row.progress = Some(Progress { done, total });
    row.pending = pending;
    row.failed = failed;
}
pub(crate) fn character_item(library: &Library, ok: bool) {
    let mut state = runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let row = state
        .entry((library.root().into(), "characters".into()))
        .or_default();
    let progress = row.progress.get_or_insert(Progress { done: 0, total: 0 });
    progress.done += 1;
    progress.total = progress.total.max(progress.done);
    row.failed = Some(row.failed.unwrap_or(0) + u64::from(!ok));
}
pub(crate) fn finish_characters(library: &Library, ok: bool) {
    let (done, failed) = {
        let state = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .get(&(library.root().into(), "characters".into()))
            .map_or((0, 0), |row| {
                (
                    row.progress.as_ref().map_or(0, |p| p.done),
                    row.failed.unwrap_or(0),
                )
            })
    };
    finish_owner(library, "characters", ok && failed == 0, done);
}

/// Shared by native owners and manual dispatch; reservations happen before spawning.
pub(crate) struct Run {
    library: Library,
    id: String,
    owned: bool,
    finished: bool,
}
impl Run {
    pub(crate) fn begin(library: &Library, id: &str) -> Result<Self, LibraryError> {
        if manual(library, id) {
            return Ok(Self {
                library: library.clone(),
                id: id.into(),
                owned: false,
                finished: false,
            });
        }
        Self::reserve(library, id, false)
    }
    fn reserve(library: &Library, id: &str, manual: bool) -> Result<Self, LibraryError> {
        let mut state = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let row = state.entry((library.root().into(), id.into())).or_default();
        if row.running {
            return Err(LibraryError::AutoJobBusy);
        }
        row.running = true;
        row.manual = manual;
        row.stop = false;
        row.progress = None;
        row.waiting = None;
        row.unconfigured = None;
        row.pending = None;
        row.failed = None;
        Ok(Self {
            library: library.clone(),
            id: id.into(),
            owned: true,
            finished: false,
        })
    }
    pub(crate) fn finish(&mut self, ok: bool, count: Option<u64>) {
        self.finish_with_error(ok, count, None);
    }
    fn finish_with_error(&mut self, ok: bool, count: Option<u64>, error: Option<String>) {
        if !self.owned {
            return;
        }
        let last = LastRun {
            at: Some(chrono::Utc::now().to_rfc3339()),
            ok: Some(ok),
            count,
            error,
        };
        // Existing durable facts remain authoritative for these jobs.
        if let (Some(path), Ok(library_id)) = (
            self.library.machine_settings_path(),
            self.library.library_id(),
        ) {
            if let Err(error) = crate::library::machine_settings::set_auto_job_last(
                &path,
                &library_id,
                &self.id,
                (!derived_history(&self.id) || !ok).then_some(&last),
            ) {
                eprintln!("auto job history: {error}");
            }
        }
        let mut state = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let row = state
            .entry((self.library.root().into(), self.id.clone()))
            .or_default();
        row.last = last;
        row.running = false;
        row.manual = false;
        self.finished = true;
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        if self.owned && !self.finished {
            self.finish(false, None);
        }
    }
}

/// Record automatic runs too, and reuse a manual reservation on its dispatch thread.
pub(crate) fn tracked<T>(
    library: &Library,
    id: &str,
    work: impl FnOnce() -> Result<T, LibraryError>,
    measure: impl FnOnce(&T) -> (bool, Option<u64>),
) -> Result<T, LibraryError> {
    let mut run = Run::begin(library, id)?;
    if run.owned {
        let total=read_db(library).ok().and_then(|db|match id {
            "similarity" => count(&db,"SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL"),
            "videos" => count(&db,"SELECT COUNT(*) FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE v.preparation_state='pending' AND a.status='normal'"),
            "cloudBackfill" => count(&db,"SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_type='asset' AND operation='upsert' AND status IN ('pending','preparing','uploading','committing')"),
            _ => None,
        });
        if let Some(total) = total {
            progress(library, id, 0, total, Some(total), None);
        }
    }
    let result = work();
    let (ok, count) = result.as_ref().map(measure).unwrap_or((false, None));
    run.finish(ok, count);
    result
}

fn read_db(library: &Library) -> rusqlite::Result<Connection> {
    let db = Connection::open_with_flags(
        library.root().join("library.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.busy_timeout(std::time::Duration::from_millis(50))?;
    Ok(db)
}
fn number(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    row.get::<_, i64>(index).map(|n| n.max(0) as u64)
}
fn count(db: &Connection, sql: &str) -> Option<u64> {
    db.query_row(sql, [], |r| number(r, 0)).ok()
}
pub(crate) fn similarity_counts(library: &Library) -> Option<(u64, u64)> {
    let db = read_db(library).ok()?;
    Some((
        count(&db,"SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL")?,
        count(&db,"SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash_error IS NOT NULL")?,
    ))
}

fn snapshot(library: Option<&Library>) -> Vec<AutoJobStatus> {
    let mut rows: Vec<_> = IDS.iter().map(|id| AutoJobStatus::new(id)).collect();
    // While the library is still opening there is nothing to report yet; Settings keeps
    // its skeleton instead of showing every job as unconfigured.
    let Some(library) = library else {
        return Vec::new();
    };
    let db = read_db(library).ok();
    let entry = library.machine_settings_path().and_then(|path| {
        db.as_ref()
            .and_then(|db| {
                db.query_row(
                    "SELECT library_id FROM library_settings WHERE singleton=1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
            })
            .and_then(|id| {
                crate::library::machine_settings::entry(&path, &id)
                    .ok()
                    .flatten()
            })
    });
    let history = entry
        .as_ref()
        .map(|entry| entry.extra.clone())
        .unwrap_or_default();
    let server = db
        .as_ref()
        .and_then(|db| {
            db.query_row(
                "SELECT cloud_api_base_url FROM library_settings WHERE singleton=1",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        })
        .is_some_and(|s| !s.trim().is_empty());
    let now = chrono::Utc::now();
    for row in &mut rows {
        if let Some(last) = history
            .get(&format!("autoJob:{}", row.id))
            .and_then(|value| serde_json::from_value::<LastRun>(value.clone()).ok())
        {
            // A successful releaseWatch dispatch may only have observed server
            // ownership or found nothing due. Use persisted check facts instead.
            if row.id != "releaseWatch" || last.ok != Some(true) {
                row.last(last.at, last.ok, last.count);
                if last.error.is_some() {
                    row.last_error = last.error;
                }
            }
        }
        if let Some(db) = &db {
            populate(db, library, row, server, entry.as_ref());
        }
        // Inbox polling without a new file must not reset the nightly-file deadline.
        let imported_at = (row.id == "autoTags")
            .then(|| {
                entry
                    .as_ref()?
                    .auto_tag_inbox
                    .last
                    .as_ref()?
                    .values()
                    .filter(|last| last.error.is_none())
                    .filter_map(|last| chrono::DateTime::parse_from_rfc3339(&last.imported_at).ok())
                    .max()
                    .map(|at| at.to_rfc3339())
            })
            .flatten();
        let state = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.get(&(library.root().into(), row.id.clone())) {
            if (!derived_history(&row.id) || active.last.ok == Some(false))
                && active.last.at.is_some()
                && active.last.at >= row.last_run_at
            {
                row.last(active.last.at.clone(), active.last.ok, active.last.count);
                if active.last.error.is_some() {
                    row.last_error = active.last.error.clone();
                }
            }
            if active.running {
                row.state = "running".into();
                row.unconfigured_reason = None;
                row.progress = active.progress.clone();
                if let (Some(progress), Some(pending)) = (&mut row.progress, row.pending) {
                    if matches!(row.id.as_str(), "similarity" | "videos" | "cloudBackfill") {
                        progress.done = progress.total.saturating_sub(pending);
                    }
                }
                row.can_stop = matches!(
                    row.id.as_str(),
                    "characters" | "cardCutouts" | "mangaSpines"
                );
            }
            if let Some(reason) = &active.waiting {
                if !active.stop {
                    row.state = "waiting".into();
                    row.waiting_reason = Some(reason.clone());
                    row.unconfigured_reason = None;
                }
            }
            if let Some(reason) = &active.unconfigured {
                row.unconfigured(reason);
                row.can_stop = false;
            }
            if row.id == "cardCutouts" && active.pending.is_some() {
                row.pending = active.pending;
            }
            if row.id == "cardCutouts" && active.failed.is_some() {
                row.failed = active.failed;
            }
        }
        if row.state == "idle" {
            if row.enabled == Some(false) {
                row.state = "off".into();
            } else if row.last_ok == Some(false) {
                row.state = "failed".into();
            } else if crate::workload::is_restricted() && row.pending.unwrap_or(0) > 0 {
                row.state = "waiting".into();
                row.waiting_reason = Some("lightweight".into());
            }
        }
        let at = match row.id.as_str() {
            "autoTags" => imported_at,
            "catalog" | "backup" | "launchbox" | "trash" => row
                .last_success_at
                .clone()
                .or_else(|| row.last_run_at.clone()),
            _ => row.last_run_at.clone(),
        };
        row.overdue(now, at.as_deref());
    }
    rows
}

fn derived_history(id: &str) -> bool {
    matches!(
        id,
        "catalog" | "releaseCalendar" | "releaseWatch" | "autoTags" | "cloudBackfill" | "backup"
    )
}

fn populate(
    db: &Connection,
    library: &Library,
    row: &mut AutoJobStatus,
    server: bool,
    entry: Option<&crate::library::machine_settings::LibraryEntry>,
) {
    match row.id.as_str() {
        "catalog" => {
            if let Ok((enabled, interval, attempt, success, added, error)) = db.query_row("SELECT update_enabled,update_interval_seconds,last_attempt_at,last_success_at,last_added,last_error FROM online_catalog_settings WHERE singleton=1", [], |r| Ok((r.get::<_, bool>(0)?,number(r,1)?,r.get::<_, Option<String>>(2)?,r.get::<_, Option<String>>(3)?,number(r,4)?,r.get::<_, Option<String>>(5)?))) {
                row.enabled = Some(enabled); row.interval_seconds = Some(interval);
                row.next_run_at = attempt.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at| (at + chrono::Duration::seconds(interval as i64)).to_rfc3339());
                if success.is_some() { row.last(success.clone(), Some(true), Some(added)); }
                let at=if error.is_some() { attempt } else { success };
                let ok=at.as_ref().map(|_|error.is_none());
                row.last(at,ok,ok.map(|_|added));
            }
            if !library.root().join("catalogs/kdata.db").is_file() {
                row.unconfigured("noLibraryContent");
            } else if let Ok(catalog) = Connection::open_with_flags(
                library.root().join("catalogs/kdata.db"),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            ) {
                let _ = catalog.busy_timeout(std::time::Duration::from_millis(50));
                let mut at = None;
                let mut added = 0;
                let mut ok = true;
                for language in [CatalogLanguage::Korean, CatalogLanguage::Japanese] {
                    let key = format!("lakomics.catalog.kHentai.{}.status", language.as_tag());
                    if let Ok(raw) =
                        catalog.query_row("SELECT Value FROM CrawlState WHERE Key=?1", [key], |r| {
                            r.get::<_, String>(0)
                        })
                    {
                        if let Ok(status) = serde_json::from_str::<serde_json::Value>(&raw) {
                            let finished = status["last_finished_at"]
                                .as_str()
                                .or(status["last_completed_at"].as_str())
                                .map(str::to_owned);
                            at = at.max(finished);
                            added += status["last_added"].as_u64().unwrap_or(0);
                            ok &= status["last_error"].is_null();
                        }
                    }
                }
                if at.is_some() {
                    row.last(at, Some(ok), Some(added));
                }
            }
        }
        "releaseCalendar" => {
            if let Ok((at, failed)) = db.query_row("SELECT MAX(attempted_at),COALESCE(SUM(error_code IS NOT NULL),0) FROM release_calendar_cache", [], |r| Ok((r.get::<_, Option<String>>(0)?,number(r,1)?))) {
                row.last(at.clone(), at.map(|_| failed == 0), None);
                row.next_run_at=row.last_run_at.as_deref().and_then(|at|chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at|(at+chrono::Duration::hours(if failed>0 {1} else {24})).to_rfc3339());
            }
            if server {
                if let Some(status) = cached_server_calendar_status(db) {
                    let sources = status["sources"].as_array();
                    let at = sources
                        .and_then(|sources| {
                            sources
                                .iter()
                                .filter_map(|source| {
                                    source["attemptedAt"]
                                        .as_str()
                                        .or(source["fetchedAt"].as_str())
                                })
                                .max()
                        })
                        .map(str::to_owned);
                    let ok = sources
                        .map(|sources| sources.iter().all(|source| source["errorCode"].is_null()));
                    if at.is_some() {
                        row.last(at, ok, None);
                    }
                    if status["busy"] == true {
                        row.state = "running".into();
                    }
                }
            }
        }
        "releaseWatch" => {
            // retry_at is written exactly 24 h after a collection check, including
            // authority-owned bindings which cannot update last_synced_at locally.
            if let Ok((at, ok)) = db.query_row(
                "SELECT at,ok FROM (
                    SELECT last_checked_at AS at,1 AS ok FROM release_watch_items
                    UNION ALL SELECT last_synced_at,1 FROM collection_external_bindings WHERE provider IN ('mangadex','kakao')
                    UNION ALL SELECT strftime('%Y-%m-%dT%H:%M:%fZ',retry_at,'-24 hours'),NULL FROM collection_update_attempts
                    UNION ALL SELECT COALESCE(json_extract(status_json,'$.finishedAt'),json_extract(status_json,'$.startedAt')),json_extract(status_json,'$.failed')=0 FROM collection_update_status
                ) WHERE julianday(at) IS NOT NULL ORDER BY julianday(at) DESC LIMIT 1",
                [], |r| Ok((r.get::<_, String>(0)?,r.get::<_,Option<bool>>(1)?)),
            ) {
                row.last(Some(at), ok, None);
            }
            if let Ok((endpoint, library_id)) = db.query_row(
                "SELECT cloud_api_base_url,library_id FROM library_settings WHERE singleton=1",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ) {
                let endpoint = crate::cloud::status_watch::endpoint_key(&endpoint);
                let wishlist = format!(
                    "serverReleaseWishlist:{}",
                    serde_json::json!([endpoint, library_id])
                );
                for (key, path) in [
                    (wishlist, "/status"),
                    (
                        format!("serverReleaseChecksCache:{endpoint}"),
                        "/providers/kakao",
                    ),
                ] {
                    let raw = db
                        .query_row("SELECT value FROM notes_state WHERE key=?1", [key], |r| {
                            r.get::<_, String>(0)
                        })
                        .ok()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
                    if let Some(status) = raw.as_ref().and_then(|raw| raw.pointer(path)) {
                        if let Some(at) = status["finishedAt"]
                            .as_str()
                            .filter(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
                        {
                            row.last(
                                Some(at.into()),
                                status["failed"].as_u64().map(|failed| failed == 0),
                                None,
                            );
                        }
                    }
                }
            }
        }
        "launchbox" => {
            if let Some(at) = LAUNCHBOX_CACHE
                .get()
                .and_then(|cache| crate::library::launchbox::last_bulk_download(cache))
                .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64))
            {
                row.last(Some(at.to_rfc3339()), Some(true), None);
                row.next_run_at = Some((at + chrono::Duration::days(7)).to_rfc3339());
            }
            if count(db, "SELECT COUNT(*) FROM collections WHERE type='game'") == Some(0) {
                row.unconfigured("noLibraryContent");
            }
        }
        "autoTags" => {
            if let Some(settings) = entry.map(|entry| entry.auto_tag_inbox.clone()) {
                if settings.folder.is_none() {
                    row.unconfigured("noFolder");
                }
                if let Some(last) = settings.last {
                    if let Some(at) = last.values().map(|last| last.imported_at.clone()).max() {
                        let latest: Vec<_> = last
                            .values()
                            .filter(|last| last.imported_at == at)
                            .collect();
                        row.last(
                            Some(at),
                            Some(latest.iter().all(|last| last.error.is_none())),
                            Some(latest.iter().map(|last| inbox_count(last)).sum()),
                        );
                    }
                }
            } else {
                row.unconfigured("noFolder");
            }
        }
        "characters" => {
            if let Ok(at) = db.query_row(
                "SELECT MAX(created_at) FROM character_autotag_evidence",
                [],
                |r| r.get::<_, Option<String>>(0),
            ) {
                if at.is_some() {
                    row.last(at, Some(true), None);
                }
            }
            row.enabled = db
                .query_row(
                    "SELECT NOT paused FROM character_autotag_control WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            row.pending = count(
                db,
                "SELECT COUNT(*) FROM character_autotag_jobs WHERE state='pending'",
            );
            row.failed = count(
                db,
                "SELECT COUNT(*) FROM character_autotag_jobs WHERE state='failed'",
            );
        }
        "similarity" => {
            row.pending = count(db,"SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash IS NULL AND perceptual_hash_error IS NULL");
            row.failed = count(db,"SELECT COUNT(*) FROM assets WHERE status='normal' AND media_kind IN ('image','gif') AND perceptual_hash_error IS NOT NULL");
        }
        "videos" => {
            row.pending = count(db,"SELECT COUNT(*) FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE v.preparation_state='pending' AND a.status='normal'");
            row.failed = count(db,"SELECT COUNT(*) FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE v.preparation_state='failed' AND a.status='normal'");
            if count(db,"SELECT COUNT(*) FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE v.preparation_state='processing' AND a.status='normal'").is_some_and(|n|n>0) { row.state="running".into(); }
        }
        "mangaSpines" => {
            if let Ok(at) = db.query_row("SELECT MAX(checked_at) FROM manga_spine_scans", [], |r| {
                r.get::<_, Option<i64>>(0)
            }) {
                if let Some(at) = at.and_then(|at| chrono::DateTime::from_timestamp(at, 0)) {
                    row.last(Some(at.to_rfc3339()), None, None);
                }
            }
            row.pending =
                crate::manga_scans::cached_progress(library).map(|progress| progress.queued as u64);
            row.failed = count(
                db,
                "SELECT COUNT(*) FROM manga_spine_scans WHERE status='error'",
            );
        }
        "cardCutouts" => {
            if !server {
                row.unconfigured("noServer");
            }
        }
        "cloudBackfill" => {
            row.enabled = db
                .query_row(
                    "SELECT cloud_sync_enabled FROM library_settings WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            row.pending = count(db,"SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_type='asset' AND operation='upsert' AND status IN ('pending','preparing','uploading','committing')");
            row.failed = count(db,"SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_type='asset' AND operation='upsert' AND status='failed'");
            if count(db,"SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_type='asset' AND operation='upsert' AND status IN ('preparing','uploading','committing')").is_some_and(|n|n>0) { row.state="running".into(); }
            if let Ok((at, error, processed)) = db.query_row("SELECT last_success_at,last_error,processed FROM cloud_activity WHERE direction='replication'",[],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,number(r,2)?))) { row.last(at.clone(),at.map(|_|error.is_none()),Some(processed)); }
            if !server {
                row.unconfigured("noServer");
            }
        }
        "backup" => {
            if let Ok(backups) = library.list_backups() {
                if let Some(last) = backups
                    .into_iter()
                    .filter(|b| b.kind == crate::library::models::BackupKind::Daily)
                    .max_by(|a, b| a.created_at.cmp(&b.created_at))
                {
                    row.last(Some(last.created_at), Some(true), Some(last.byte_size));
                }
            }
        }
        "trash" => {
            if db
                .query_row(
                    "SELECT trash_retention_days IS NULL FROM library_settings WHERE singleton=1",
                    [],
                    |r| r.get::<_, bool>(0),
                )
                .unwrap_or(false)
            {
                row.enabled = Some(false);
            }
            row.pending = db.query_row("SELECT COUNT(*) FROM assets WHERE status='trash' AND julianday(trashed_at)<=julianday(?1)-(SELECT trash_retention_days FROM library_settings WHERE singleton=1)",[chrono::Utc::now().to_rfc3339()],|r|number(r,0)).ok();
        }
        _ => {}
    }
}

fn cached_server_calendar_status(db: &Connection) -> Option<serde_json::Value> {
    let endpoint = db
        .query_row(
            "SELECT cloud_api_base_url FROM library_settings WHERE singleton=1",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()?;
    let key = format!(
        "serverReleaseCalendarCache:{}",
        crate::cloud::status_watch::endpoint_key(&endpoint)
    );
    let raw = db
        .query_row(
            "SELECT json_extract(value,'$.status') FROM notes_state WHERE key=?1",
            [key],
            |r| r.get::<_, String>(0),
        )
        .ok()?;
    serde_json::from_str(&raw).ok()
}
fn inbox_count(last: &crate::library::auto_tag_inbox::Last) -> u64 {
    ["taggedAssets", "imported", "siglip"]
        .iter()
        .find_map(|key| last.imported.get(*key).copied())
        .unwrap_or(0)
}

#[tauri::command]
pub(crate) async fn auto_jobs_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Vec<AutoJobStatus>, String> {
    configure_paths(&app);
    let library = state.current_library();
    tauri::async_runtime::spawn_blocking(move || snapshot(library.as_ref()))
        .await
        .map_err(|_| "작업 상태를 읽지 못했습니다".into())
}

#[tauri::command]
pub(crate) async fn run_auto_job(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<AutoJobStatus, String> {
    configure_paths(&app);
    if !IDS.contains(&id.as_str()) {
        return Err("알 수 없는 작업입니다".into());
    }
    let library = state.current_library().ok_or("라이브러리를 열어 주세요")?;
    let lib = library.clone();
    let statuses = tauri::async_runtime::spawn_blocking(move || snapshot(Some(&lib)))
        .await
        .map_err(|_| "작업 상태를 읽지 못했습니다")?;
    let mut status = statuses.into_iter().find(|row| row.id == id).unwrap();
    if matches!(status.state.as_str(), "unconfigured" | "running") {
        return Ok(status);
    }
    let run = match Run::reserve(&library, &id, true) {
        Ok(run) => run,
        Err(_) => {
            status.state = "running".into();
            status.overdue_since = None;
            status.waiting_reason = None;
            return Ok(status);
        }
    };
    if let Some(total) = status.pending {
        progress(&library, &id, 0, total, Some(total), status.failed);
    }
    if matches!(id.as_str(), "characters" | "cardCutouts" | "mangaSpines") {
        // The one permanent owner consumes the reservation; never spawn another owner.
        let lib = library.clone();
        let job = id.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut run = run;
            if job == "characters" {
                if crate::commands::characters::wake_auto_characters(&handle, &lib).is_err() {
                    run.finish(false, None);
                    return;
                }
            } else if job == "cardCutouts" {
                crate::card_cutouts::wake();
            } else {
                crate::manga_scans::wake();
            }
            run.owned = false;
        });
    } else if id == "catalog" {
        let handle = app.clone();
        let lib = library.clone();
        tauri::async_runtime::spawn(async move {
            let mut run = run;
            let result = forced_catalog(&handle, &lib).await;
            run.finish(result.is_ok(), result.ok());
        });
    } else {
        let lib = library.clone();
        let job = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut run = run;
            let _manual = ManualScope::enter(&lib, &job);
            #[cfg(windows)]
            if job == "autoTags" {
                let result = manual_auto_tags(&mut WindowsTagTask, std::thread::sleep, || {
                    dispatch(&app, &lib, &job).map_err(|_| "자동 태그 가져오기 실패")
                });
                match result {
                    Ok(count) => run.finish(true, Some(count)),
                    Err(error) => run.finish_with_error(false, None, Some(error.into())),
                }
                return;
            }
            let result = dispatch(&app, &lib, &job);
            run.finish(result.is_ok(), result.ok());
        });
    }
    status.state = "running".into();
    status.overdue_since = None;
    status.waiting_reason = None;
    status.can_stop = matches!(id.as_str(), "characters" | "cardCutouts" | "mangaSpines");
    Ok(status)
}

#[cfg(any(windows, test))]
trait TagTask {
    fn exists(&mut self) -> bool;
    fn running(&mut self) -> Result<bool, ()>;
    fn start(&mut self) -> Result<(), ()>;
}

#[cfg(any(windows, test))]
fn manual_auto_tags(
    task: &mut impl TagTask,
    mut sleep: impl FnMut(std::time::Duration),
    import: impl FnOnce() -> Result<u64, &'static str>,
) -> Result<u64, &'static str> {
    if task.exists() {
        if !task
            .running()
            .map_err(|_| "태그 작업 상태를 확인하지 못했습니다")?
        {
            task.start()
                .map_err(|_| "태그 작업을 시작하지 못했습니다")?;
        }
        // Give a newly started task time to enter Running before the first poll.
        let interval = std::time::Duration::from_secs(5);
        for _ in 0..(6 * 3600 / 5) {
            sleep(interval);
            if !task
                .running()
                .map_err(|_| "태그 작업 상태를 확인하지 못했습니다")?
            {
                return import();
            }
        }
        return Err("태그 작업 대기 시간이 초과되었습니다");
    }
    import()
}

#[cfg(windows)]
const AUTO_TAGS_TASK_NAME: &str = "Lakomics auto tags";

#[cfg(windows)]
struct WindowsTagTask;

#[cfg(windows)]
impl WindowsTagTask {
    fn command(args: &[&str]) -> std::io::Result<std::process::Output> {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("schtasks")
            .args(args)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW, including queries.
            .output()
    }
}

#[cfg(windows)]
impl TagTask for WindowsTagTask {
    fn exists(&mut self) -> bool {
        Self::command(&["/Query", "/TN", AUTO_TAGS_TASK_NAME])
            .is_ok_and(|output| output.status.success())
    }
    fn start(&mut self) -> Result<(), ()> {
        Self::command(&["/Run", "/TN", AUTO_TAGS_TASK_NAME])
            .map_err(|_| ())?
            .status
            .success()
            .then_some(())
            .ok_or(())
    }
    fn running(&mut self) -> Result<bool, ()> {
        let output = Self::command(&["/Query", "/TN", AUTO_TAGS_TASK_NAME, "/FO", "CSV", "/NH"])
            .map_err(|_| ())?;
        if !output.status.success() {
            return Err(());
        }
        task_csv_running(&decode_task_output(&output.stdout))
    }
}

#[cfg(any(windows, test))]
fn task_csv_running(csv: &str) -> Result<bool, ()> {
    // schtasks' non-verbose CSV columns are TaskName, Next Run Time, Status.
    let status = csv
        .lines()
        .find(|line| line.trim_start().starts_with('"'))
        .and_then(|line| line.trim().split("\",\"").nth(2))
        .map(|status| status.trim_matches('"').trim())
        .ok_or(())?;
    Ok(status.eq_ignore_ascii_case("Running") || status == "실행 중")
}

#[cfg(windows)]
fn decode_task_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.into();
    }
    // Redirected console output uses the Windows OEM code page (949 on Korean Windows).
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            page: u32,
            flags: u32,
            input: *const u8,
            len: i32,
            output: *mut u16,
            capacity: i32,
        ) -> i32;
    }
    let mut wide = vec![0u16; bytes.len()];
    let len = unsafe {
        MultiByteToWideChar(
            1,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            wide.len() as i32,
        )
    };
    String::from_utf16_lossy(&wide[..len.max(0) as usize])
}

async fn forced_catalog(app: &tauri::AppHandle, library: &Library) -> Result<u64, LibraryError> {
    let state = app.state::<crate::library::catalog_update::CatalogUpdateState>();
    let _guard = state.begin().ok_or(LibraryError::CatalogTransportBusy)?;
    let transport = app.state::<crate::catalog_transport::CatalogTransport>();
    let base = library.cloud_sync_config()?.api_base_url;
    catalog_languages(|language| {
        crate::library::catalog_update::execute_catalog_update(
            library.clone(),
            &transport,
            app,
            base.clone(),
            language,
            crate::library::catalog_update::MAX_UPDATE_PAGES,
        )
    })
    .await
}

async fn catalog_languages<F, Fut>(mut execute: F) -> Result<u64, LibraryError>
where
    F: FnMut(CatalogLanguage) -> Fut,
    Fut: std::future::Future<
        Output = Result<crate::library::models::CatalogUpdateResult, LibraryError>,
    >,
{
    let mut added = 0;
    let mut error = None;
    for language in [CatalogLanguage::Korean, CatalogLanguage::Japanese] {
        match execute(language).await {
            Ok(result) => {
                added += result.added;
                if result.reason == crate::library::models::CatalogUpdateStopReason::RateLimited {
                    error = Some(LibraryError::CatalogTransportBusy);
                }
            }
            Err(e) => error = Some(e),
        }
    }
    error.map_or(Ok(added), Err)
}
fn dispatch(app: &tauri::AppHandle, library: &Library, id: &str) -> Result<u64, LibraryError> {
    match id {
        "releaseCalendar" => {
            if library.server_release_calendar_enabled() {
                if !matches!(
                    library.request_server_release_calendar()?,
                    crate::library::server_release_calendar::ServerCalendarRun::Queued
                ) {
                    return Err(LibraryError::CloudRequestUnavailable);
                }
                library.refresh_server_calendar_cache(true)?;
            }
            let calendar = library.refresh_release_calendar_now()?;
            if calendar
                .sources
                .iter()
                .any(|source| source.error_code.is_some())
            {
                return Err(LibraryError::CloudRequestUnavailable);
            }
            Ok(calendar.entries.len() as u64)
        }
        "releaseWatch" => {
            let mut changed = 0;
            if library.server_release_wishlist_blocked()? {
                if !matches!(
                    library.request_server_release_wishlist_now()?,
                    crate::cloud::client::CalendarRun::Queued
                ) {
                    return Err(LibraryError::CloudRequestUnavailable);
                }
            } else {
                let wishlist = library.run_due_release_watchlist()?;
                if wishlist.stop_reason.is_some() {
                    return Err(LibraryError::CloudRequestUnavailable);
                }
                changed += wishlist.changed as u64;
            }
            for provider in ["mangadex", "kakao"] {
                if library.server_release_checks_enabled(provider) {
                    if !matches!(
                        library.request_server_release_check(provider)?,
                        crate::library::server_release_checks::ServerReleaseCheck::Started { .. }
                    ) {
                        return Err(LibraryError::CloudRequestUnavailable);
                    }
                } else {
                    let result = library.run_collection_updates(
                        provider,
                        if provider == "kakao" {
                            crate::library::credential::read_kakao_key()
                        } else {
                            Ok(String::new())
                        },
                    )?;
                    if result.failed > 0 {
                        return Err(LibraryError::CloudRequestUnavailable);
                    }
                    changed += result.changed_collections;
                }
            }
            Ok(changed)
        }
        "launchbox" => {
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(|_| LibraryError::CatalogTransportUnavailable)?
                .join("launchbox");
            crate::library::launchbox::refresh_now(
                &cache,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .map_err(|_| LibraryError::CatalogTransportUnavailable)
        }
        "autoTags" => {
            let result = crate::commands::auto_tags::run_inbox_and_report(app, library)?;
            let last = result.settings.last.as_ref();
            if result.processed.iter().any(|name| {
                last.and_then(|last| last.get(name))
                    .is_some_and(|last| last.error.is_some())
            }) {
                return Err(LibraryError::CatalogTransportUnavailable);
            }
            Ok(result
                .processed
                .iter()
                .filter_map(|name| last.and_then(|last| last.get(name)))
                .map(inbox_count)
                .sum())
        }
        "similarity" => {
            let before = similarity_counts(library);
            let result = library.index_missing_similarity_hashes()?;
            if before.is_some_and(|(_, failed)| result.failed > failed) {
                return Err(LibraryError::CatalogTransportUnavailable);
            }
            Ok(before.map_or(0, |(pending, _)| pending.saturating_sub(result.remaining)))
        }
        "videos" => {
            let result = library.prepare_pending_videos(10)?;
            if result.failed > 0 {
                return Err(LibraryError::CatalogTransportUnavailable);
            }
            Ok(result.processed as u64)
        }
        "cloudBackfill" => {
            let result = library.run_cloud_backfill_cycle()?;
            if result.retry_scheduled + result.permanent_failures > 0 {
                return Err(LibraryError::CatalogTransportUnavailable);
            }
            Ok(result.committed)
        }
        "backup" => Ok(library
            .force_daily_backup(chrono::Utc::now())?
            .map_or(0, |b| b.byte_size)),
        "trash" => {
            let result = library.purge_expired_trash(chrono::Utc::now())?;
            if !result.failed_asset_ids.is_empty() {
                return Err(LibraryError::CatalogTransportUnavailable);
            }
            Ok(result.deleted_count)
        }
        _ => Err(LibraryError::CatalogTransportUnavailable),
    }
}

/// Called by a permanent worker after a requested pass, including an empty pass.
pub(crate) fn finish_owner(library: &Library, id: &str, ok: bool, count: u64) {
    let mut run = Run {
        library: library.clone(),
        id: id.into(),
        owned: true,
        finished: false,
    };
    run.finish(ok, Some(count));
}

#[tauri::command]
pub(crate) async fn stop_auto_job(
    id: String,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<AutoJobStatus, String> {
    if !matches!(id.as_str(), "characters" | "cardCutouts" | "mangaSpines") {
        return Err("중지할 수 없는 작업입니다".into());
    }
    let library = state.current_library().ok_or("라이브러리를 열어 주세요")?;
    {
        let mut state = runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let row = state
            .get_mut(&(library.root().into(), id.clone()))
            .filter(|row| row.running)
            .ok_or("실행 중인 작업이 없습니다")?;
        row.stop = true;
        row.manual = false;
    }
    tauri::async_runtime::spawn_blocking(move || {
        snapshot(Some(&library))
            .into_iter()
            .find(|s| s.id == id)
            .unwrap()
    })
    .await
    .map_err(|_| "작업 상태를 읽지 못했습니다".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FakeTagTask {
        exists: bool,
        states: std::collections::VecDeque<bool>,
        events: std::rc::Rc<RefCell<Vec<&'static str>>>,
        fail_start: bool,
    }
    impl TagTask for FakeTagTask {
        fn exists(&mut self) -> bool {
            self.exists
        }
        fn running(&mut self) -> Result<bool, ()> {
            let running = self.states.pop_front().unwrap();
            self.events
                .borrow_mut()
                .push(if running { "running" } else { "idle" });
            Ok(running)
        }
        fn start(&mut self) -> Result<(), ()> {
            self.events.borrow_mut().push("start");
            if self.fail_start {
                Err(())
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn auto_jobs_manual_tags_waits_then_imports_or_imports_only_without_task() {
        for (exists, states, expected) in [
            (
                true,
                vec![false, true, false],
                vec!["idle", "start", "running", "idle", "import"],
            ),
            (false, vec![], vec!["import"]),
            (
                true,
                vec![true, true, false],
                vec!["running", "running", "idle", "import"],
            ),
        ] {
            let events = std::rc::Rc::new(RefCell::new(Vec::new()));
            let mut task = FakeTagTask {
                exists,
                states: states.into(),
                events: events.clone(),
                fail_start: false,
            };
            assert_eq!(
                manual_auto_tags(
                    &mut task,
                    |_| {},
                    || {
                        events.borrow_mut().push("import");
                        Ok(7)
                    }
                ),
                Ok(7)
            );
            assert_eq!(*events.borrow(), expected);
        }
    }
    #[test]
    fn auto_jobs_manual_tags_records_start_failure_without_importing() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let mut run = Run::reserve(&library, "autoTags", true).unwrap();
        let row = snapshot(Some(&library)).remove(4);
        assert_eq!(row.state, "running");
        assert!(row.progress.is_none());
        let mut task = FakeTagTask {
            exists: true,
            states: [false].into(),
            events: Default::default(),
            fail_start: true,
        };
        let error = manual_auto_tags(&mut task, |_| {}, || panic!("must not import")).unwrap_err();
        run.finish_with_error(false, None, Some(error.into()));
        let row = snapshot(Some(&library)).remove(4);
        assert_eq!(row.last_ok, Some(false));
        assert_eq!(
            row.last_error.as_deref(),
            Some("태그 작업을 시작하지 못했습니다")
        );
    }
    #[test]
    fn auto_jobs_task_status_accepts_english_and_korean_running() {
        for (status, running) in [
            ("Running", true),
            ("실행 중", true),
            ("Ready", false),
            ("준비", false),
        ] {
            assert_eq!(
                task_csv_running(&format!(
                    "\"\\Lakomics auto tags\",\"N/A\",\"{status}\"\r\n"
                )),
                Ok(running)
            );
        }
    }
    #[test]
    fn auto_jobs_overdue_uses_the_allowed_gap_and_requires_pending_event_work() {
        let now = chrono::Utc::now();
        let mut daily = AutoJobStatus::new("backup");
        let old = (now - chrono::Duration::hours(27)).to_rfc3339();
        daily.overdue(now, Some(&old));
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(daily.overdue_since.as_deref().unwrap()).unwrap(),
            now - chrono::Duration::hours(1),
        );
        let recent = (now - chrono::Duration::hours(25)).to_rfc3339();
        daily.overdue(now, Some(&recent));
        assert!(daily.overdue_since.is_none());
        for id in [
            "characters",
            "similarity",
            "videos",
            "mangaSpines",
            "cardCutouts",
            "cloudBackfill",
        ] {
            let mut event = AutoJobStatus::new(id);
            event.pending = Some(0);
            event.overdue(now, Some(&old));
            assert!(event.overdue_since.is_none(), "{id}");
            event.pending = Some(1);
            event.overdue(now, Some(&old));
            assert!(event.overdue_since.is_some(), "{id}");
            event.overdue(now, None);
            assert!(event.overdue_since.is_none(), "{id}");
        }
        for state in ["off", "unconfigured", "running"] {
            daily.state = state.into();
            daily.overdue(now, Some(&old));
            assert!(daily.overdue_since.is_none(), "{state}");
        }
    }

    #[test]
    fn auto_jobs_always_lists_all_ids_and_reserves_before_spawn() {
        assert!(snapshot(None).is_empty());
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        assert_eq!(
            snapshot(Some(&library))
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            IDS
        );
        let first = Run::reserve(&library, "videos", true).unwrap();
        assert!(Run::reserve(&library, "videos", true).is_err());
        assert!(Run::begin(&library, "videos").is_err());
        drop(first);
        assert!(Run::reserve(&library, "videos", true).is_ok());
    }

    #[test]
    fn auto_jobs_snapshot_reads_counters_without_waiting_for_a_worker_connection() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let writer = library.connection().unwrap();
        writer
            .execute(
                "UPDATE online_catalog_settings SET update_enabled=0,update_interval_seconds=21600",
                [],
            )
            .unwrap();
        let rows = snapshot(Some(&library));
        assert_eq!(rows.len(), 13);
        assert_eq!(rows[0].enabled, Some(false));
        assert_eq!(rows[0].interval_seconds, Some(21600));
        assert_eq!(rows[6].pending, Some(0));
        assert_eq!(rows[7].pending, Some(0));
        assert_eq!(rows[12].pending, Some(0));
        assert!(rows[2].last_run_at.is_none());
        assert!(rows[2].overdue_since.is_none());

        let checked = (chrono::Utc::now() - chrono::Duration::hours(4)).to_rfc3339();
        writer
            .execute(
                "INSERT INTO collection_update_status(provider,status_json) VALUES('mangadex',?1)",
                [serde_json::json!({"finishedAt":checked,"failed":0}).to_string()],
            )
            .unwrap();
        let rows = snapshot(Some(&library));
        assert_eq!(rows[2].last_run_at.as_deref(), Some(checked.as_str()));
        assert!(rows[2].overdue_since.is_some());

        let endpoint = "https://cloud.test";
        writer
            .execute(
                "UPDATE library_settings SET cloud_api_base_url=?1",
                [endpoint],
            )
            .unwrap();
        let key = format!(
            "serverReleaseChecksCache:{}",
            crate::cloud::status_watch::endpoint_key(endpoint)
        );
        let checked = chrono::Utc::now().to_rfc3339();
        writer
            .execute(
                "INSERT INTO notes_state(key,value) VALUES(?1,?2)",
                rusqlite::params![
                    key,
                    serde_json::json!({"providers":{"kakao":{"finishedAt":checked,"failed":0}}})
                        .to_string()
                ],
            )
            .unwrap();
        let rows = snapshot(Some(&library));
        assert_eq!(rows[2].last_run_at.as_deref(), Some(checked.as_str()));
        assert!(rows[2].overdue_since.is_none());
    }

    #[test]
    fn auto_jobs_catalog_forces_both_languages_even_when_first_stream_fails() {
        let mut calls = Vec::new();
        let result = tauri::async_runtime::block_on(catalog_languages(|language| {
            calls.push(language);
            std::future::ready(if language == CatalogLanguage::Korean {
                Err(LibraryError::CatalogTransportUnavailable)
            } else {
                Ok(crate::library::models::CatalogUpdateResult {
                    language,
                    added: 3,
                    pages: 1,
                    reason: crate::library::models::CatalogUpdateStopReason::Completed,
                    last_success_at: None,
                })
            })
        }));
        assert!(result.is_err());
        assert_eq!(calls, [CatalogLanguage::Korean, CatalogLanguage::Japanese]);
    }

    #[test]
    fn auto_jobs_manual_calendar_refreshes_fresh_sources_but_keeps_failure_cooldown() {
        use crate::library::release_calendar::{tests::MockTransport, RefreshMode};
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let now = chrono::Utc::now();
        let today = now.date_naive();
        let transport = MockTransport::default();
        library
            .refresh_release_calendar_with(&transport, false, now, today)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE release_calendar_cache SET error_code='unavailable' WHERE provider='tmdb'",
                [],
            )
            .unwrap();
        transport.requests.borrow_mut().clear();
        let mut run = Run::reserve(&library, "releaseCalendar", true).unwrap();
        let _manual = ManualScope::enter(&library, "releaseCalendar");
        let calendar = library
            .refresh_release_calendar_mode(
                &transport,
                RefreshMode::Immediate,
                now + chrono::Duration::minutes(2),
                today,
            )
            .unwrap();
        let requests = transport.requests.borrow();
        assert!(requests.iter().any(|request| request.starts_with("igdb ")));
        assert!(!requests
            .iter()
            .any(|request| request.contains("/discover/movie")));
        assert_eq!(calendar.sources.len(), 3);
        assert!(calendar
            .sources
            .iter()
            .any(|source| source.error_code.is_some()));
        run.finish(false, None);
    }

    #[test]
    fn auto_jobs_manual_trash_keeps_items_inside_retention() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let now = chrono::Utc::now();
        for (id, age) in [("expired", 31), ("recent", 1)] {
            let at = (now - chrono::Duration::days(age)).to_rfc3339();
            library.connection().unwrap().execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status,trashed_at) VALUES(?1,?1,'image',?1,?2,?3,1,1,1,?4,'trash',?4)",rusqlite::params![id,format!("assets/{id}.png"),format!("thumbnails/{id}.webp"),at]).unwrap();
            std::fs::write(library.root().join(format!("assets/{id}.png")), b"fixture").unwrap();
            std::fs::write(
                library.root().join(format!("thumbnails/{id}.webp")),
                b"fixture",
            )
            .unwrap();
        }
        let mut run = Run::reserve(&library, "trash", true).unwrap();
        let _manual = ManualScope::enter(&library, "trash");
        let result = library.purge_expired_trash(now).unwrap();
        run.finish(
            result.failed_asset_ids.is_empty(),
            Some(result.deleted_count),
        );
        assert_eq!(result.deleted_count, 1);
        assert!(!library.root().join("assets/expired.png").exists());
        assert!(library.root().join("assets/recent.png").is_file());
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 1);
    }
}
