//! Review feed and agreement publication over the disposable S36 shadow cache.
//!
//! The screen behind this module asks the user to judge assets the shadow
//! scorer called `automatic` or `recommended`. Judgments go through the normal
//! manual decision path (`record_character_decisions`). The write-side reconciliation
//! publishes agreed pairs through ordinary automatic acceptance; review reads stay read-only
//! and shadow rows never become learning examples.
use super::auto_tags::CHARACTER_MIN_SCORE;
use super::{
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::Read,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::SystemTime,
};

// Read commands borrow the library only for owned query results. The connection-based
// implementation remains available to callers already inside a write transaction.
trait ReviewRead {
    fn read<T>(&self, query: impl FnOnce(&Connection) -> Result<T>) -> Result<T>;
}
impl ReviewRead for Connection {
    fn read<T>(&self, query: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        query(self)
    }
}
impl ReviewRead for Library {
    fn read<T>(&self, query: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let connection = self.connection()?;
        let started = SUMMARY_HOLD.with(|hold| hold.get().map(|_| std::time::Instant::now()));
        let result = query(&connection);
        if let Some(started) = started {
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            SUMMARY_HOLD.with(|hold| {
                if let Some((total, longest)) = hold.get() {
                    hold.set(Some((total + elapsed, longest.max(elapsed))));
                }
            });
        }
        result
    }
}

thread_local! {
    static SUMMARY_HOLD: std::cell::Cell<Option<(f64, f64)>> = const { std::cell::Cell::new(None) };
}

struct SummaryHoldScope(Option<(f64, f64)>);
impl Drop for SummaryHoldScope {
    fn drop(&mut self) {
        SUMMARY_HOLD.with(|hold| hold.set(self.0));
    }
}

const MAX_PAGE: u32 = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewQuery {
    #[serde(default)]
    pub offset: u32,
    pub limit: u32,
    /// `doubtful`: existing automatic acceptances that S36 does not support.
    #[serde(default)]
    pub mode: Option<String>,
    /// Only candidates whose target character belongs to this series; `None` is the
    /// all-series list.
    #[serde(default)]
    pub series_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewItem {
    pub asset_id: String,
    pub content_hash: String,
    pub original_name: String,
    pub width: u32,
    pub height: u32,
    pub target_id: String,
    pub target_name: String,
    pub target_fingerprint: String,
    pub reference_asset_ids: Vec<String>,
    pub verdict: String,
    pub origin: String,
    pub knn3: Option<f64>,
    pub native_outcome: String,
    pub scored_at: String,
    /// An 인식 추천 of a character still far from 학습 인식 (see [`is_close_to_switching`]): the
    /// 확인 overview folds it, the counts and the tablet feed leave it out. Always false in the
    /// `doubtful` list.
    pub folded: bool,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerdictCounts {
    pub pending: u32,
    pub accepted: u32,
    pub rejected: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewSummary {
    pub automatic: VerdictCounts,
    pub recommended: VerdictCounts,
    pub by_origin: BTreeMap<String, TierCounts>,
    /// Only filled in `doubtful` mode.
    pub doubtful: VerdictCounts,
}

impl Default for ShadowReviewSummary {
    fn default() -> Self {
        Self {
            automatic: VerdictCounts::default(),
            recommended: VerdictCounts::default(),
            doubtful: VerdictCounts::default(),
            by_origin: BTreeMap::from([
                ("live".into(), TierCounts::default()),
                ("backfill".into(), TierCounts::default()),
            ]),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TierCounts {
    pub automatic: VerdictCounts,
    pub recommended: VerdictCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewPage {
    pub items: Vec<ShadowReviewItem>,
    pub next_offset: Option<u32>,
    pub policy_version: Option<String>,
    pub summary: ShadowReviewSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewPendingTarget {
    pub target_id: String,
    pub target_name: String,
    pub automatic: u32,
    pub recommended: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewPendingSummary {
    pub automatic: u32,
    pub recommended: u32,
    pub targets: Vec<ShadowReviewPendingTarget>,
}

/// Pending counts of the one 확인 list, each (character, image) pair once. A pair more than one list
/// brings up is a 다시 확인 when the tags or 학습 인식 doubt its placement, else an 인식 추천 when the
/// recognition suggests it, else a 태그 추천.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmCounts {
    pub recognition: u32,
    pub tag: u32,
    pub recheck: u32,
}

#[derive(Debug, Clone)]
struct ShadowRow {
    asset_id: String,
    content_hash: String,
    target_id: String,
    knn3: Option<f64>,
    verdict: String,
    native_outcome: String,
    scored_at: String,
    origin: String,
}

#[cfg(test)]
thread_local! {
    static SHADOW_READ_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}
fn shadow_read_phase() {
    #[cfg(test)]
    SHADOW_READ_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
}

/// The S36 shadow cache opened read-only, or `None` when it does not exist or has no
/// `scores` table yet.
fn open_shadow_cache(root: &Path) -> Result<Option<Connection>> {
    shadow_read_phase();
    let mut path = root.to_path_buf();
    for part in [".cache", "characters", "s36_shadow.sqlite"] {
        path.push(part);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::Invalid("Shadow cache must not contain symlinks"));
        }
    }
    if !path.is_file() {
        return Ok(None);
    }
    let open = || -> rusqlite::Result<(Connection, bool)> {
        let c = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        c.busy_timeout(std::time::Duration::from_millis(100))?;
        let has_table = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scores')",
            [],
            |r| r.get(0),
        )?;
        Ok((c, has_table))
    };
    let (c, has_table) = match open() {
        // A writer stopped mid-transaction (e.g. the app restarted during history
        // scoring) leaves a hot journal that only a writable connection can roll back.
        // The cache owner opens it once to recover, then this read stays read-only.
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ReadOnly => {
            drop(super::character_shadow::Cache::open(root)?);
            open()?
        }
        result => result?,
    };
    Ok(has_table.then_some(c))
}

/// The newest `scored_at` in the S36 shadow cache: a cheap change marker for the mobile
/// candidate feed. `None` when there is no cache.
pub(crate) fn shadow_cache_scored_marker(root: &Path) -> Result<Option<String>> {
    let Some(c) = open_shadow_cache(root)? else {
        return Ok(None);
    };
    Ok(c.query_row("SELECT MAX(scored_at) FROM scores", [], |r| r.get(0))?)
}

/// Rows of the newest policy version with a reviewable verdict, or `None`
/// when the cache does not exist. The cache is opened read-only.
fn shadow_rows(root: &Path, doubtful: bool) -> Result<Option<(String, Vec<ShadowRow>)>> {
    let Some(c) = open_shadow_cache(root)? else {
        return Ok(None);
    };
    rows_of_cache(&c, doubtful)
}

/// [`shadow_rows`] over an already open cache connection.
fn rows_of_cache(c: &Connection, doubtful: bool) -> Result<Option<(String, Vec<ShadowRow>)>> {
    shadow_read_phase();
    let origin = if super::character_shadow::cache_has_origin(c)? {
        "origin"
    } else {
        "'live'"
    };
    let Some(version) = c
        .query_row(
            "SELECT policy_version FROM scores GROUP BY policy_version ORDER BY MAX(scored_at) DESC, policy_version DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut rows = c
        .prepare(&format!(
            "SELECT asset_id,content_hash,target_id,knn3,verdict,native_outcome,scored_at,{origin} FROM scores
             WHERE policy_version=?1 AND verdict IN {}",
            if doubtful { "('recommended','none')" } else { "('automatic','recommended')" }
        ))?
        .query_map([&version], |r| {
            Ok(ShadowRow {
                asset_id: r.get(0)?,
                content_hash: r.get(1)?,
                target_id: r.get(2)?,
                knn3: r.get(3)?,
                verdict: r.get(4)?,
                native_outcome: r.get(5)?,
                scored_at: r.get(6)?,
                origin: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows
        .iter()
        .any(|row| !matches!(row.origin.as_str(), "live" | "backfill"))
    {
        return Err(Error::Invalid("Unknown S36 shadow origin"));
    }
    use sha2::{Digest, Sha256};
    rows.sort_by_cached_key(|row| {
        (
            row.verdict != "automatic",
            Sha256::digest(format!("{}|{}|{}", version, row.asset_id, row.target_id)).to_vec(),
            row.asset_id.clone(),
            row.target_id.clone(),
        )
    });
    Ok(Some((version, rows)))
}

fn row_pairs_json(rows: &[ShadowRow]) -> Result<String> {
    Ok(serde_json::to_string(
        &rows
            .iter()
            .map(|row| (&row.target_id, &row.asset_id))
            .collect::<Vec<_>>(),
    )?)
}

/// Rows per library borrow in the row-dependent reads. A review list covers tens of
/// thousands of scored pairs; one borrow per batch keeps every hold short so other readers
/// (Home at startup) are not queued behind the whole list. Each batch answers its own
/// pairs/assets, so the merged result equals one big query.
const READ_BATCH_ROWS: usize = 2000;
/// Characters per library borrow in the per-character reads (their decisions, the taggers'
/// readings). Each is an indexed read of a few rows per character, so a batch stays short.
const READ_BATCH_TARGETS: usize = 64;

fn latest_decisions(
    reader: &impl ReviewRead,
    rows: &[ShadowRow],
    manual: bool,
) -> Result<BTreeMap<(String, String), (String, String)>> {
    let origin = if manual {
        "d.origin='manual'"
    } else {
        "d.origin<>'manual'"
    };
    let mut decisions = BTreeMap::new();
    if rows.len() > READ_BATCH_ROWS {
        // A list this long (the doubtful list covers every scored pair) asks about far more pairs
        // than the table holds decisions of one kind: read those once, newest first, and keep the
        // first of each wanted pair, instead of probing thousands of pairs batch after batch.
        let wanted = rows
            .iter()
            .map(|row| (row.target_id.as_str(), row.asset_id.as_str()))
            .collect::<HashSet<_>>();
        return reader.read(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT d.target_id,d.source_asset_id,d.decision,d.created_at
                 FROM character_decisions d
                 WHERE {origin}
                 ORDER BY d.sequence DESC"
            ))?;
            let mut newest = BTreeMap::new();
            for found in statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })? {
                let (target_id, asset_id, decision, created_at) = found?;
                if wanted.contains(&(target_id.as_str(), asset_id.as_str())) {
                    newest
                        .entry((target_id, asset_id))
                        .or_insert((decision, created_at));
                }
            }
            Ok(newest)
        });
    }
    for batch in rows.chunks(READ_BATCH_ROWS) {
        let pairs = row_pairs_json(batch)?;
        let found = reader.read(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT d.target_id,d.source_asset_id,d.decision,d.created_at
                 FROM character_decisions d
                 JOIN json_each(?1) requested
                   ON d.target_id=json_extract(requested.value,'$[0]')
                  AND d.source_asset_id=json_extract(requested.value,'$[1]')
                 WHERE {origin}
                 ORDER BY d.target_id,d.source_asset_id,d.sequence DESC"
            ))?;
            let found = statement
                .query_map([pairs], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(found)
        })?;
        for (target_id, asset_id, decision, created_at) in found {
            decisions
                .entry((target_id, asset_id))
                .or_insert((decision, created_at));
        }
    }
    Ok(decisions)
}

/// Distinct asset ids of the rows, in batches of [`READ_BATCH_ROWS`].
fn asset_id_batches(rows: &[ShadowRow]) -> Vec<Vec<&str>> {
    let ids = rows
        .iter()
        .map(|row| row.asset_id.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    ids.chunks(READ_BATCH_ROWS).map(<[&str]>::to_vec).collect()
}

fn eligible_assets(
    reader: &impl ReviewRead,
    rows: &[ShadowRow],
) -> Result<BTreeMap<(String, String), (String, i64, i64)>> {
    let mut assets = BTreeMap::new();
    for batch in asset_id_batches(rows) {
        let requested = serde_json::to_string(&batch)?;
        let found = reader.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,content_hash,original_name,width,height FROM assets
                 WHERE id IN (SELECT value FROM json_each(?1))
                   AND status='normal' AND media_kind='image'",
            )?;
            let found = statement
                .query_map([requested], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(found)
        })?;
        for (asset_id, content_hash, original_name, width, height) in found {
            assets.insert((asset_id, content_hash), (original_name, width, height));
        }
    }
    Ok(assets)
}

fn retain_in_character_scope(reader: &impl ReviewRead, rows: &mut Vec<ShadowRow>) -> Result<()> {
    let covered = reader.read(|connection| {
        if super::character_scope::broad_folder_scope_enabled(connection)? {
            return Ok(None);
        }
        Ok(Some(super::character_scope::series_covered_folders(
            connection,
        )?))
    })?;
    let Some(covered) = covered else {
        return Ok(());
    };
    let covered = serde_json::to_string(&covered)?;
    let mut inside = BTreeSet::new();
    for batch in asset_id_batches(rows) {
        let asset_ids = serde_json::to_string(&batch)?;
        inside.extend(reader.read(|connection| {
            Ok(connection
                .prepare(
                    "SELECT DISTINCT asset_id FROM asset_classifications
                     WHERE asset_id IN (SELECT value FROM json_each(?1))
                       AND classification_id IN (SELECT value FROM json_each(?2))",
                )?
                .query_map(params![asset_ids, covered], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })?);
    }
    rows.retain(|row| inside.contains(&row.asset_id));
    Ok(())
}

/// [`super::character_claude::settled_pairs`] in batches of rows.
fn settled_pairs(
    reader: &impl ReviewRead,
    rows: &[ShadowRow],
) -> Result<BTreeSet<(String, String)>> {
    let mut settled = BTreeSet::new();
    for batch in rows.chunks(READ_BATCH_ROWS) {
        let pairs = row_pairs_json(batch)?;
        settled.extend(reader.read(|c| super::character_claude::settled_pairs(c, &pairs))?);
    }
    Ok(settled)
}

fn enabled_target_names<'a>(
    connection: &Connection,
    target_ids: impl Iterator<Item = &'a str>,
) -> Result<BTreeMap<String, String>> {
    let target_ids = target_ids.collect::<BTreeSet<_>>();
    if target_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let target_ids = serde_json::to_string(&target_ids)?;
    Ok(connection
        .prepare(
            "SELECT id,display_name FROM character_targets
             WHERE enabled=1 AND id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([target_ids], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?)
}

/// Every pending item of one review list, in review order, with its summary.
///
/// The page command slices this list; the mobile candidate feed exports it whole. Library
/// eligibility and latest decisions are loaded in batches so the statement count does not grow
/// with the number of scored pairs, and the list is cached (see [`ReviewCache`]).
#[derive(Debug, Clone, PartialEq)]
pub struct ShadowReviewItems {
    pub items: Vec<ShadowReviewItem>,
    pub policy_version: Option<String>,
    pub summary: ShadowReviewSummary,
}

fn shadow_review_mode(mode: Option<&str>) -> Result<bool> {
    match mode {
        None | Some("candidates") => Ok(false),
        Some("doubtful") => Ok(true),
        Some(_) => Err(Error::Invalid("알 수 없는 확인 목록입니다.")),
    }
}

/// Newest-policy rows of the S36 shadow cache, shared while the cache is unchanged.
type ShadowRows = Arc<(String, Vec<ShadowRow>)>;

/// Change marker of the S36 shadow cache file: its size, modification time and SQLite file
/// change counter, which every commit increments (the cache uses a rollback journal, never
/// WAL). Writers in and outside this process all move it. `None` while there is no file.
#[derive(Debug, Clone, PartialEq)]
struct ShadowStamp(Option<(u64, Option<SystemTime>, [u8; 4])>);

fn shadow_cache_stamp(root: &Path) -> ShadowStamp {
    let path = root
        .join(".cache")
        .join("characters")
        .join("s36_shadow.sqlite");
    let file = std::fs::File::open(path).ok().and_then(|mut file| {
        let metadata = file.metadata().ok()?;
        // Header bytes 24..28: the change counter every rollback-journal commit increments.
        let mut header = [0u8; 28];
        let counter = match file.read_exact(&mut header) {
            Ok(()) => [header[24], header[25], header[26], header[27]],
            Err(_) => [0; 4],
        };
        Some((metadata.len(), metadata.modified().ok(), counter))
    });
    ShadowStamp(file)
}

/// What a cached review list was computed from, besides its mode and series scope. Target
/// names, references and fingerprints are not part of it: they are read on every call.
#[derive(Debug, Clone, PartialEq)]
struct ListKey {
    /// [`super::character_changes::CharacterChanges::shadow_review_generation`].
    inputs: u64,
    shadow: ShadowStamp,
    broad_folder_scope: bool,
}

/// A pair still waiting for a judgment, with its Asset already checked eligible. It becomes an
/// item when its character exists and is enabled.
#[derive(Debug)]
struct PendingRow {
    row: ShadowRow,
    original_name: String,
    width: u32,
    height: u32,
    /// See [`ShadowReviewItem::folded`].
    folded: bool,
}

/// The part of a review list computed from the database rows under one [`ListKey`]: the
/// judged counts and the pending pairs in review order.
#[derive(Debug, Default)]
struct Prepared {
    policy_version: Option<String>,
    judged: ShadowReviewSummary,
    pending: Vec<PendingRow>,
    target_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct TargetInfo {
    name: String,
    enabled: bool,
    fingerprint: String,
    reference_asset_ids: Vec<String>,
}

#[derive(Debug)]
struct CachedList {
    key: ListKey,
    prepared: Arc<Prepared>,
    /// The last list assembled from `prepared` and the characters it was assembled with.
    assembled: Option<(BTreeMap<String, TargetInfo>, Arc<ShadowReviewItems>)>,
}

#[derive(Debug, Clone, PartialEq)]
struct SummaryKey {
    definitions: u64,
    publication: i64,
    list: ListKey,
}
type SummarySlot<T> = Arc<Mutex<Option<(SummaryKey, T)>>>;

fn summary_slot<T>(
    slots: &Mutex<HashMap<Option<String>, SummarySlot<T>>>,
    series: Option<&str>,
) -> SummarySlot<T> {
    let mut slots = slots.lock().unwrap_or_else(PoisonError::into_inner);
    let key = series.map(str::to_owned);
    if !slots.contains_key(&key) && slots.len() >= MAX_CACHED_LISTS {
        slots.clear();
    }
    slots.entry(key).or_default().clone()
}

type ListSlot = Arc<Mutex<Option<CachedList>>>;

/// Lists kept at most; past it the slots start over (a slot in use stays valid).
const MAX_CACHED_LISTS: usize = 64;

/// Cache of the S36 review lists, one per (mode, series scope).
///
/// A list is recomputed only when its [`ListKey`] moves: a write to one of the library input
/// tables, an S36 shadow cache commit, or the broad-folder rule. Pages slice the cached list.
/// Each list's slot lock is its single flight: concurrent identical requests wait for the one
/// computing. Lock order: list slot, then shadow rows, then the library connection.
#[derive(Debug, Default)]
pub(crate) struct ReviewCache {
    /// Indexed by mode: candidates, doubtful.
    rows: [Mutex<Option<(ShadowStamp, Option<ShadowRows>)>>; 2],
    lists: Mutex<HashMap<(bool, Option<String>), ListSlot>>,
    totals: Mutex<HashMap<Option<String>, SummarySlot<ConfirmTotals>>>,
    readiness: Mutex<HashMap<Option<String>, SummarySlot<Vec<S36Readiness>>>>,
    #[cfg(test)]
    summary_count: std::sync::atomic::AtomicUsize,
    /// Times a list's database part was computed.
    #[cfg(test)]
    prepared_count: std::sync::atomic::AtomicUsize,
}

impl ReviewCache {
    fn slot(&self, doubtful: bool, series_id: Option<&str>) -> ListSlot {
        let mut lists = self.lists.lock().unwrap_or_else(PoisonError::into_inner);
        let key = (doubtful, series_id.map(str::to_owned));
        if !lists.contains_key(&key) && lists.len() >= MAX_CACHED_LISTS {
            lists.clear();
        }
        lists.entry(key).or_default().clone()
    }
}

/// The database part of a review list. `rows` is the newest policy's rows (`None`: no cache) and
/// `cache` the open score cache they came from (the judgments behind [`ListPolicy`] read it).
fn prepare(
    c: &Connection,
    cache: Option<&Connection>,
    rows: Option<&ShadowRows>,
    doubtful: bool,
    series_id: Option<&str>,
) -> Result<Prepared> {
    prepare_read(c, cache, rows, doubtful, series_id)
}

fn prepare_read(
    c: &impl ReviewRead,
    cache: Option<&Connection>,
    rows: Option<&ShadowRows>,
    doubtful: bool,
    series_id: Option<&str>,
) -> Result<Prepared> {
    let Some(rows) = rows else {
        return Ok(Prepared::default());
    };
    let (version, all) = &**rows;
    let in_series = match series_id {
        Some(series_id) => Some(c.read(|c| Ok(c
            .prepare("SELECT id FROM character_targets WHERE role='character' AND series_classification_id=?1")?
            .query_map([series_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?))?),
        None => None,
    };
    let scoped = in_series.as_ref().map(|in_series| {
        all.iter()
            .filter(|row| in_series.contains(&row.target_id))
            .cloned()
            .collect::<Vec<_>>()
    });
    let source = scoped.as_deref().unwrap_or(all.as_slice());
    // The doubtful list keeps only pairs the native pass accepted, a few thousand among tens of
    // thousands of scored ones. Whether a pair is one does not depend on the filters below, so
    // apply it first and run those on the few rows left; the result is the same.
    let accepted_natively = |native: &BTreeMap<(String, String), (String, String)>,
                             row: &ShadowRow| {
        native
            .get(&(row.target_id.clone(), row.asset_id.clone()))
            .is_some_and(|(decision, _)| decision == "accepted")
    };
    let (mut rows, early_native) = if doubtful {
        let native = latest_decisions(c, source, false)?;
        let rows = source
            .iter()
            .filter(|row| accepted_natively(&native, row))
            .cloned()
            .collect::<Vec<_>>();
        (rows, Some(native))
    } else {
        (source.to_vec(), None)
    };
    // With the broad-folder rule off, scores of images filed outside every registered
    // series stay in the cache but are not offered (turning the rule on shows them again).
    retain_in_character_scope(c, &mut rows)?;
    // A pair Claude already decided automatically needs no person (a later manual decision
    // replaces it as the newest decision, and the pair is judged like any other).
    let settled = settled_pairs(c, &rows)?;
    rows.retain(|row| !settled.contains(&(row.target_id.clone(), row.asset_id.clone())));
    // Pairs the native pass already accepted automatically come after new findings
    // and are labelled as such; each group keeps the stable pseudo-random order.
    // (Backfill rows recorded "none" as the native outcome for them.)
    let rows = {
        let native = match early_native {
            Some(native) => native,
            None => latest_decisions(c, &rows, false)?,
        };
        let mut keyed = Vec::with_capacity(rows.len());
        for (index, mut row) in rows.into_iter().enumerate() {
            let classified = accepted_natively(&native, &row);
            if classified && row.native_outcome == "none" {
                row.native_outcome = "accepted_automatic".into();
            }
            if doubtful && !classified {
                continue;
            }
            keyed.push(((row.verdict != "automatic", classified, index), row));
        }
        keyed.sort_by_key(|(key, _)| *key);
        keyed.into_iter().map(|(_, row)| row).collect::<Vec<_>>()
    };
    let manual = latest_decisions(c, &rows, true)?;
    let assets = eligible_assets(c, &rows)?;
    let policy = if doubtful {
        ListPolicy::default()
    } else {
        ListPolicy::build(
            c,
            cache,
            rows.iter().map(|row| row.target_id.clone()).collect(),
        )?
    };
    let mut prepared = Prepared {
        policy_version: Some(version.clone()),
        ..Prepared::default()
    };
    let summary = &mut prepared.judged;
    let mut target_ids = BTreeSet::new();
    for row in rows {
        let origin_tiers = summary.by_origin.get_mut(&row.origin).ok_or(Error::Stale)?;
        let origin_counts = if row.verdict == "automatic" {
            &mut origin_tiers.automatic
        } else {
            &mut origin_tiers.recommended
        };
        let counts = match row.verdict.as_str() {
            _ if doubtful => &mut summary.doubtful,
            "automatic" => &mut summary.automatic,
            _ => &mut summary.recommended,
        };
        let decision = manual.get(&(row.target_id.clone(), row.asset_id.clone()));
        match decision.as_ref().map(|(d, at)| (d.as_str(), at.as_str())) {
            Some(("cleared", _)) | None => {}
            Some((decision, at)) => {
                if at > row.scored_at.as_str() {
                    if decision == "accepted" {
                        counts.accepted += 1;
                        if !doubtful {
                            origin_counts.accepted += 1;
                        }
                    } else {
                        counts.rejected += 1;
                        if !doubtful {
                            origin_counts.rejected += 1;
                        }
                    }
                }
                continue;
            }
        }
        let Some((original_name, width, height)) =
            assets.get(&(row.asset_id.clone(), row.content_hash.clone()))
        else {
            continue;
        };
        // A person needs to look at neither a pair the taggers settled by agreement nor an
        // image 학습 인식 has already placed for a character it owns.
        if !doubtful && policy.settles(&row) {
            continue;
        }
        target_ids.insert(row.target_id.clone());
        prepared.pending.push(PendingRow {
            original_name: original_name.clone(),
            width: u32::try_from(*width).unwrap_or(0),
            height: u32::try_from(*height).unwrap_or(0),
            folded: !doubtful && policy.far.contains(&row.target_id),
            row,
        });
    }
    prepared.target_ids = target_ids.into_iter().collect();
    Ok(prepared)
}

/// The list from its database part and the current characters: pending pairs of a missing or
/// disabled character are left out of items and counts alike.
fn assemble(
    prepared: &Prepared,
    doubtful: bool,
    targets: &BTreeMap<String, TargetInfo>,
) -> ShadowReviewItems {
    let mut summary = prepared.judged.clone();
    let mut items = Vec::new();
    for pending in &prepared.pending {
        let row = &pending.row;
        let Some(target) = targets.get(&row.target_id).filter(|t| t.enabled) else {
            continue;
        };
        let origin = summary.by_origin.get_mut(&row.origin);
        if doubtful {
            summary.doubtful.pending += 1;
        } else if row.verdict == "automatic" {
            summary.automatic.pending += 1;
            if let Some(origin) = origin {
                origin.automatic.pending += 1;
            }
        } else {
            summary.recommended.pending += 1;
            if let Some(origin) = origin {
                origin.recommended.pending += 1;
            }
        }
        items.push(ShadowReviewItem {
            asset_id: row.asset_id.clone(),
            content_hash: row.content_hash.clone(),
            original_name: pending.original_name.clone(),
            width: pending.width,
            height: pending.height,
            target_id: row.target_id.clone(),
            target_name: target.name.clone(),
            target_fingerprint: target.fingerprint.clone(),
            reference_asset_ids: target.reference_asset_ids.iter().take(4).cloned().collect(),
            verdict: row.verdict.clone(),
            origin: row.origin.clone(),
            knn3: row.knn3,
            native_outcome: row.native_outcome.clone(),
            scored_at: row.scored_at.clone(),
            folded: pending.folded,
        });
    }
    ShadowReviewItems {
        items,
        policy_version: prepared.policy_version.clone(),
        summary,
    }
}

fn page_of(all: &ShadowReviewItems, query: &ShadowReviewQuery) -> ShadowReviewPage {
    let start = (query.offset as usize).min(all.items.len());
    let end = start
        .saturating_add(query.limit as usize)
        .min(all.items.len());
    ShadowReviewPage {
        next_offset: (end < all.items.len()).then(|| query.offset + query.limit),
        items: all.items[start..end].to_vec(),
        policy_version: all.policy_version.clone(),
        summary: all.summary.clone(),
    }
}

fn validate_page_query(query: &ShadowReviewQuery) -> Result<bool> {
    let doubtful = shadow_review_mode(query.mode.as_deref())?;
    if query.limit == 0 || query.limit > MAX_PAGE {
        return Err(Error::Invalid("한 번에 1~200개 항목을 불러올 수 있습니다."));
    }
    Ok(doubtful)
}

/// The 확인 counts, and what the overview folds away (인식 추천 of characters far from
/// switching that nothing else brings up).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ConfirmTotals {
    pub counts: ConfirmCounts,
    pub folded_items: u32,
    pub folded_characters: u32,
}

/// Pairs among the given ones that the taggers judged correct by agreement, see
/// [`Library::agreed_pairs`].
pub(super) fn agreed_pairs_of(
    c: &Connection,
    cache: Option<&Connection>,
    pairs: &[(&str, &str)],
) -> Result<BTreeSet<(String, String)>> {
    agreed_pairs_read(c, cache, pairs)
}

fn agreed_pairs_read(
    c: &impl ReviewRead,
    cache: Option<&Connection>,
    pairs: &[(&str, &str)],
) -> Result<BTreeSet<(String, String)>> {
    let targets = pairs
        .iter()
        .map(|(target, _)| (*target).to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if targets.is_empty() || cache.is_none() {
        return Ok(BTreeSet::new());
    }
    let judged = judgments_of_read(c, cache, &targets, Auto::Full)?;
    Ok(pairs
        .iter()
        .filter(|(target, asset)| {
            judged
                .agreed
                .get(*target)
                .is_some_and(|assets| assets.contains(*asset))
        })
        .map(|(target, asset)| ((*target).to_owned(), (*asset).to_owned()))
        .collect())
}

/// The pending tag pairs (target, asset, reason) of the whole library or one series.
fn pending_tag_rows(
    c: &Connection,
    series_id: Option<&str>,
) -> Result<Vec<(String, String, String)>> {
    Ok(c.prepare(
        "SELECT target_id,asset_id,reason FROM character_tagger_pending
         WHERE ?1 IS NULL OR series_id=?1",
    )?
    .query_map([series_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?
    .collect::<std::result::Result<Vec<_>, _>>()?)
}

/// [`Library::confirm_totals`] over open connections to a library and its score cache, for the
/// recognition-plan preview.
pub(super) fn confirm_totals_in(
    c: &Connection,
    cache: Option<&Connection>,
) -> Result<ConfirmTotals> {
    let rows = |doubtful: bool| -> Result<Option<ShadowRows>> {
        Ok(match cache {
            Some(cache) => rows_of_cache(cache, doubtful)?.map(Arc::new),
            None => None,
        })
    };
    confirm_totals_of(
        c,
        cache,
        rows(false)?.as_ref(),
        rows(true)?.as_ref(),
        pending_tag_rows(c, None)?,
        None,
    )
}

/// Exact 확인 counts from the rows of both shadow lists and the pending tag pairs
/// (target, asset, reason), each pair once under its highest kind. `series_id` limits the
/// shadow lists; the caller limits the tag pairs the same way.
fn confirm_totals_of(
    c: &Connection,
    cache: Option<&Connection>,
    candidates: Option<&ShadowRows>,
    doubtful: Option<&ShadowRows>,
    tags: Vec<(String, String, String)>,
    series_id: Option<&str>,
) -> Result<ConfirmTotals> {
    confirm_totals_of_read(c, cache, candidates, doubtful, tags, series_id)
}

fn confirm_totals_of_read(
    connection: &impl ReviewRead,
    cache: Option<&Connection>,
    candidates: Option<&ShadowRows>,
    doubtful: Option<&ShadowRows>,
    tags: Vec<(String, String, String)>,
    series_id: Option<&str>,
) -> Result<ConfirmTotals> {
    let recognition = prepare_read(connection, cache, candidates, false, series_id)?;
    let recheck = prepare_read(connection, cache, doubtful, true, series_id)?;
    confirm_totals_from(connection, cache, &recognition, &recheck, tags, Vec::new())
}

/// Pairs still waiting in one prepared list whose character exists and is enabled, with whether
/// the overview folds them.
fn pending_pairs(
    connection: &impl ReviewRead,
    prepared: &Prepared,
) -> Result<Vec<(String, String, bool)>> {
    let enabled = connection.read(|c| {
        enabled_target_names(
            c,
            prepared
                .pending
                .iter()
                .map(|pending| pending.row.target_id.as_str()),
        )
    })?;
    Ok(prepared
        .pending
        .iter()
        .filter(|pending| enabled.contains_key(&pending.row.target_id))
        .map(|pending| {
            (
                pending.row.target_id.clone(),
                pending.row.asset_id.clone(),
                pending.folded,
            )
        })
        .collect())
}

/// [`confirm_totals_of`] from the prepared lists, so a caller that keeps them can reuse them.
fn confirm_totals_from(
    connection: &impl ReviewRead,
    cache: Option<&Connection>,
    recognition: &Prepared,
    recheck: &Prepared,
    tags: Vec<(String, String, String)>,
    members: Vec<(String,String)>,
) -> Result<ConfirmTotals> {
    let recognition = pending_pairs(connection, recognition)?;
    let recheck_by_recognition = pending_pairs(connection, recheck)?;
    // 0 tag, 1 recognition, 2 recheck: a pair takes the highest kind any list gives it.
    let mut kinds = BTreeMap::<(String, String), u8>::new();
    let agreed = agreed_pairs_read(
        connection,
        cache,
        &tags
            .iter()
            .map(|(target, asset, _)| (target.as_str(), asset.as_str()))
            .collect::<Vec<_>>(),
    )?;
    for (target_id, asset_id, reason) in tags {
        if agreed.contains(&(target_id.clone(), asset_id.clone())) {
            continue;
        }
        kinds.insert((target_id, asset_id), if reason == "veto" { 2 } else { 0 });
    }
    let mut folded = BTreeSet::new();
    for (target_id, asset_id, is_folded) in recognition {
        if is_folded {
            folded.insert((target_id, asset_id));
            continue;
        }
        let kind = kinds.entry((target_id, asset_id)).or_insert(1);
        *kind = (*kind).max(1);
    }
    for (target_id, asset_id, _) in recheck_by_recognition {
        kinds.insert((target_id, asset_id), 2);
    }
    for pair in members { let kind=kinds.entry(pair).or_insert(1); *kind=(*kind).max(1); }
    folded.retain(|key| !kinds.contains_key(key));
    let mut counts = ConfirmCounts::default();
    for kind in kinds.into_values() {
        match kind {
            2 => counts.recheck += 1,
            1 => counts.recognition += 1,
            _ => counts.tag += 1,
        }
    }
    Ok(ConfirmTotals {
        counts,
        folded_items: folded.len() as u32,
        folded_characters: folded
            .iter()
            .map(|(target, _)| target)
            .collect::<BTreeSet<_>>()
            .len() as u32,
    })
}

impl Library {
    /// Opt-in diagnostics for summary query scopes: total and longest library borrow in ms.
    /// Connection acquisition/opening and shadow work are excluded from this measurement.
    #[doc(hidden)]
    pub fn measure_character_summary_hold<T>(read: impl FnOnce() -> T) -> (T, f64, f64) {
        let _scope = SummaryHoldScope(SUMMARY_HOLD.with(|hold| hold.replace(Some((0.0, 0.0)))));
        let result = read();
        let (total, longest) = SUMMARY_HOLD.with(|hold| hold.get().unwrap());
        (result, total, longest)
    }

    /// Pending counts for PC Home. Unlike the review page, this does not validate reference
    /// files or construct item fingerprints; all row-dependent database reads stay batched.
    pub fn character_shadow_review_summary(&self) -> Result<ShadowReviewPendingSummary> {
        let Some(shared) = self.shadow_rows_cached(false)?.1 else {
            return Ok(ShadowReviewPendingSummary {
                automatic: 0,
                recommended: 0,
                targets: Vec::new(),
            });
        };
        let mut rows = shared.1.clone();
        // Each read borrows the library only for one batch of rows.
        retain_in_character_scope(self, &mut rows)?;
        let manual = latest_decisions(self, &rows, true)?;
        let settled = settled_pairs(self, &rows)?;
        rows.retain(|row| !settled.contains(&(row.target_id.clone(), row.asset_id.clone())));
        let assets = eligible_assets(self, &rows)?;
        let targets = self.read(|c| {
            enabled_target_names(c, rows.iter().map(|row| row.target_id.as_str()))
        })?;
        let mut automatic = 0;
        let mut recommended = 0;
        let mut tallies = BTreeMap::<String, ShadowReviewPendingTarget>::new();
        for row in rows {
            if manual
                .get(&(row.target_id.clone(), row.asset_id.clone()))
                .is_some_and(|(decision, _)| decision != "cleared")
                || !assets.contains_key(&(row.asset_id.clone(), row.content_hash))
            {
                continue;
            }
            let Some(target_name) = targets.get(&row.target_id) else {
                continue;
            };
            let tally =
                tallies
                    .entry(row.target_id.clone())
                    .or_insert_with(|| ShadowReviewPendingTarget {
                        target_id: row.target_id,
                        target_name: target_name.clone(),
                        automatic: 0,
                        recommended: 0,
                    });
            if row.verdict == "automatic" {
                automatic += 1;
                tally.automatic += 1;
            } else {
                recommended += 1;
                tally.recommended += 1;
            }
        }
        Ok(ShadowReviewPendingSummary {
            automatic,
            recommended,
            targets: tallies.into_values().collect(),
        })
    }

    /// Exact pending counts of the 확인 list for the whole library or one series. Like the summary it
    /// validates no reference files and builds no fingerprints, so Home and a series header can
    /// afford it; the tag pairs are read from the same pending view the tag list uses.
    pub fn character_confirm_counts(&self, series_id: Option<&str>) -> Result<ConfirmCounts> {
        Ok(self.confirm_totals(series_id)?.counts)
    }

    /// [`Self::character_confirm_counts`] with what the 확인 overview folds away.
    pub(crate) fn confirm_totals(&self, series_id: Option<&str>) -> Result<ConfirmTotals> {
        let slot = summary_slot(&self.character_changes.shadow_review.totals, series_id);
        self.cached_summary(&slot, || {
            // The database part of both lists is shared with the review pages and the feed: the
            // first of them to need it computes it, the others reuse it while its key holds.
            let recognition = self.prepared_list(false, series_id)?;
            let recheck = self.prepared_list(true, series_id)?;
            let cache = open_shadow_cache(&self.root)?;
            let tags = self.read(|c| pending_tag_rows(c, series_id))?;
            let members=self.read(|c| Ok(c.prepare("SELECT target_id,asset_id FROM character_member_pending WHERE ?1 IS NULL OR series_id=?1")?.query_map([series_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?))?;
            confirm_totals_from(self, cache.as_ref(), &recognition, &recheck, tags, members)
        })
    }

    /// Moves when anything a review list is computed from moves; the Claude run compares it to
    /// know its queue of open pairs is out of date.
    pub(super) fn review_marker(&self) -> Result<String> {
        Ok(format!("{:?}", self.summary_key()?))
    }

    fn summary_key(&self) -> Result<SummaryKey> {
        // Never read the filesystem while holding the library connection.
        let shadow = shadow_cache_stamp(&self.root);
        self.read(|c| {
            Ok(SummaryKey {
                definitions: self.character_changes.definition_revision(),
                // Candidate rows are WITHOUT ROWID: their existing publication triggers
                // provide a committed revision even when SQLite's update hook skips them.
                publication: c.query_row(
                    "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                    [],
                    |r| r.get(0),
                )?,
                list: ListKey {
                    inputs: self.character_changes.shadow_review_generation(),
                    shadow,
                    broad_folder_scope: super::character_scope::broad_folder_scope_enabled(c)?,
                },
            })
        })
    }

    fn cached_summary<T: Clone>(
        &self,
        slot: &SummarySlot<T>,
        compute: impl Fn() -> Result<T>,
    ) -> Result<T> {
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            let key = self.summary_key()?;
            if let Some((seen, value)) = slot.as_ref() {
                if *seen == key {
                    return Ok(value.clone());
                }
            }
            #[cfg(test)]
            self.character_changes
                .shadow_review
                .summary_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let value = compute()?;
            // Scoped queries can interleave with writes. Retry rather than publish a mixed
            // result or label it with a newer revision than the inputs actually read.
            if self.summary_key()? == key {
                *slot = Some((key, value.clone()));
                return Ok(value);
            }
        }
    }

    /// The pairs the taggers judged correct by agreement and nobody judged by hand: a pair among
    /// the given (character, image) ones is one of them when 학습 인식 scored it automatic.
    /// The tag list drops these exactly as the recognition list does.
    pub(super) fn agreed_pairs(
        &self,
        c: &Connection,
        pairs: &[(&str, &str)],
    ) -> Result<BTreeSet<(String, String)>> {
        let cache = open_shadow_cache(&self.root)?;
        agreed_pairs_of(c, cache.as_ref(), pairs)
    }

    pub fn character_shadow_review_page(
        &self,
        query: ShadowReviewQuery,
    ) -> Result<ShadowReviewPage> {
        let doubtful = validate_page_query(&query)?;
        let all = self.shadow_review_list(doubtful, query.series_id.as_deref())?;
        Ok(page_of(&all, &query))
    }

    /// The page computed from scratch, bypassing every review cache; for `perf_probe`
    /// measurements and tests only.
    #[doc(hidden)]
    pub fn character_shadow_review_page_uncached(
        &self,
        query: ShadowReviewQuery,
    ) -> Result<ShadowReviewPage> {
        let doubtful = validate_page_query(&query)?;
        let rows = shadow_rows(&self.root, doubtful)?.map(Arc::new);
        let cache = open_shadow_cache(&self.root)?;
        let c = self.connection()?;
        let prepared = prepare(
            &c,
            cache.as_ref(),
            rows.as_ref(),
            doubtful,
            query.series_id.as_deref(),
        )?;
        drop(c);
        // Characters are read after releasing the database lock so their reference file
        // checks never hold it.
        let targets = self.review_targets(&prepared.target_ids)?;
        Ok(page_of(&assemble(&prepared, doubtful, &targets), &query))
    }

    /// The pending tag pairs (target, asset, reason) of the 확인 list, sorted: every pair of the
    /// pending view except those the taggers judged correct by agreement, which
    /// [`Self::character_confirm_counts`] leaves out in the same way. `reason` is
    /// `recommendation` (태그 추천) or `veto` (다시 확인).
    pub(crate) fn confirm_tag_pairs(&self) -> Result<Vec<(String, String, String)>> {
        let cache = open_shadow_cache(&self.root)?;
        // The judgments read the library in short borrows, never the whole pass.
        let mut tags = self.read(|c| pending_tag_rows(c, None))?;
        let agreed = agreed_pairs_read(
            self,
            cache.as_ref(),
            &tags
                .iter()
                .map(|(target, asset, _)| (target.as_str(), asset.as_str()))
                .collect::<Vec<_>>(),
        )?;
        tags.retain(|(target, asset, _)| !agreed.contains(&(target.clone(), asset.clone())));
        tags.sort();
        tags.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
        Ok(tags)
    }

    /// All pending items of the `candidates` (default) or `doubtful` list.
    pub(crate) fn shadow_review_items(&self, mode: Option<&str>) -> Result<ShadowReviewItems> {
        let doubtful = shadow_review_mode(mode)?;
        Ok((*self.shadow_review_list(doubtful, None)?).clone())
    }

    /// The newest policy's rows of one list kind, read again only when the shadow cache's
    /// stamp moved. Read without the library connection.
    fn shadow_rows_cached(&self, doubtful: bool) -> Result<(ShadowStamp, Option<ShadowRows>)> {
        let mut cached = self.character_changes.shadow_review.rows[usize::from(doubtful)]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Stamp before reading: a write landing meanwhile moves the stamp past this key.
        let stamp = shadow_cache_stamp(&self.root);
        if let Some((seen, rows)) = cached.as_ref() {
            if *seen == stamp {
                return Ok((stamp, rows.clone()));
            }
        }
        let rows = shadow_rows(&self.root, doubtful)?.map(Arc::new);
        *cached = Some((stamp.clone(), rows.clone()));
        Ok((stamp, rows))
    }

    /// The characters a list's pending pairs point at (missing ids are left out).
    fn review_targets(&self, ids: &[String]) -> Result<BTreeMap<String, TargetInfo>> {
        Ok(self
            .character_targets_unlocked(ids)?
            .into_iter()
            .map(|target| {
                let info = TargetInfo {
                    name: target.display_name.clone(),
                    enabled: target.enabled,
                    fingerprint: target.fingerprint.clone(),
                    reference_asset_ids: target
                        .usable_references()
                        .filter_map(|r| r.asset_id.clone())
                        .collect(),
                };
                (target.id, info)
            })
            .collect())
    }

    /// The database part of one review list (see [`Prepared`]), computed on first need and
    /// reused while its [`ListKey`] holds. The characters are not part of it.
    fn prepared_list(&self, doubtful: bool, series_id: Option<&str>) -> Result<Arc<Prepared>> {
        let slot = self
            .character_changes
            .shadow_review
            .slot(doubtful, series_id);
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        self.prepared_in(&mut slot, doubtful, series_id)
    }

    /// [`Self::prepared_list`] with the list's slot already locked by the caller.
    fn prepared_in(
        &self,
        slot: &mut Option<CachedList>,
        doubtful: bool,
        series_id: Option<&str>,
    ) -> Result<Arc<Prepared>> {
        let (stamp, rows) = self.shadow_rows_cached(doubtful)?;
        // The library is borrowed only for short reads: a cold list takes seconds, and
        // holding the connection that long queued every other reader behind it.
        let key = ListKey {
            inputs: self.character_changes.shadow_review_generation(),
            shadow: stamp,
            broad_folder_scope: self
                .read(|c| Ok(super::character_scope::broad_folder_scope_enabled(c)?))?,
        };
        if let Some(cached) = slot.as_ref().filter(|cached| cached.key == key) {
            return Ok(cached.prepared.clone());
        }
        *slot = None;
        #[cfg(test)]
        self.character_changes
            .shadow_review
            .prepared_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cache = open_shadow_cache(&self.root)?;
        // A write between two reads leaves the list under the older key above, so the next
        // call (whose key has moved) computes it again.
        let prepared = Arc::new(prepare_read(
            self,
            cache.as_ref(),
            rows.as_ref(),
            doubtful,
            series_id,
        )?);
        *slot = Some(CachedList {
            key,
            prepared: prepared.clone(),
            assembled: None,
        });
        Ok(prepared)
    }

    /// One review list, limited to the targets of one series when given; items and summary
    /// counts both follow the scope. The database part is reused while its [`ListKey`] holds;
    /// the characters are read on every call, and the assembled list is reused while they are
    /// unchanged too.
    fn shadow_review_list(
        &self,
        doubtful: bool,
        series_id: Option<&str>,
    ) -> Result<Arc<ShadowReviewItems>> {
        let slot = self
            .character_changes
            .shadow_review
            .slot(doubtful, series_id);
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        let prepared = self.prepared_in(&mut slot, doubtful, series_id)?;
        let targets = self.review_targets(&prepared.target_ids)?;
        let Some(cached) = slot.as_mut() else {
            return Ok(Arc::new(assemble(&prepared, doubtful, &targets)));
        };
        if let Some((seen, items)) = &cached.assembled {
            if *seen == targets {
                return Ok(items.clone());
            }
        }
        let items = Arc::new(assemble(&prepared, doubtful, &targets));
        cached.assembled = Some((targets, items.clone()));
        Ok(items)
    }
}

/// How close one character is to being placed by 학습 인식 (S36), from reviewed S36
/// automatic candidates (newest policy) and the manual "accepted" examples.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct S36Readiness {
    pub target_id: String,
    /// Automatic candidates judged: by people after scoring, plus the ones the taggers judged
    /// by independent agreement ([`TaggerSignals`]); `reviewed_auto` of them are the latter.
    pub reviewed: u32,
    pub reviewed_auto: u32,
    /// Judged candidates that were wrong (a rejection, or a confident disagreement of the
    /// taggers); `wrong_auto` of them are the latter.
    pub wrong: u32,
    pub wrong_auto: u32,
    /// Wrong answers allowed for `reviewed`, see [`allowed_wrong`].
    pub allowed: u32,
    /// Manual acceptances for this character (S36's positive examples).
    pub examples: u32,
    /// `learning` (학습 인식 places new images), `hold` (enough judged and examples, but too
    /// many wrong: 기본 인식 again) or `collecting`.
    pub status: String,
}

pub const READY_REVIEWED: u32 = 30;
pub const READY_EXAMPLES: u32 = 50;

/// Wrong answers a character may collect before 학습 인식 steps back: 5% of its judgments,
/// rounded down, at least one.
pub const fn allowed_wrong(reviewed: u32) -> u32 {
    let share = reviewed / 20;
    if share > 1 {
        share
    } else {
        1
    }
}

/// The one rule that decides, per character, between 기본 인식 (B36) and 학습 인식 (S36):
/// at least [`READY_REVIEWED`] judged, at least [`READY_EXAMPLES`] examples and no more
/// wrong than [`allowed_wrong`]. It is evaluated from the current numbers every time, so a
/// character steps back when the allowance is exceeded and returns once within it again.
pub(super) fn readiness_status(reviewed: u32, wrong: u32, examples: u32) -> &'static str {
    if reviewed < READY_REVIEWED || examples < READY_EXAMPLES {
        "collecting"
    } else if wrong <= allowed_wrong(reviewed) {
        "learning"
    } else {
        "hold"
    }
}

/// The characters whose new images 학습 인식 places automatically right now (and so 기본 인식
/// leaves alone). Computed from the library's decisions and the shadow cache; never stored.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct LearningTargets(BTreeSet<String>);
impl LearningTargets {
    pub(super) fn owns(&self, target_id: &str) -> bool {
        self.0.contains(target_id)
    }
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    #[cfg(test)]
    pub(super) fn of<I: IntoIterator<Item = String>>(ids: I) -> Self {
        Self(ids.into_iter().collect())
    }
}

/// Newest policy version of an open S36 shadow cache (the one every review list reads): the
/// version of the latest score. The cache owner indexes `(scored_at, policy_version)`, so
/// this is a lookup, not a scan; a copy without the index is only slower.
fn newest_policy(cache: &Connection) -> Result<Option<String>> {
    shadow_read_phase();
    Ok(cache
        .query_row(
            "SELECT policy_version FROM scores ORDER BY scored_at DESC, policy_version DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

#[cfg(test)]
pub(super) fn newest_policy_for_tests(cache: &Connection) -> Option<String> {
    newest_policy(cache).unwrap()
}

/// Characters closer than this to 학습 인식 are worth a person's time on 인식 추천: at least
/// [`NEAR_JUDGED`] judged candidates or [`NEAR_EXAMPLES`] manual examples. The rest are folded in
/// the 확인 overview and left out of the counts and the tablet feed. The only place these
/// numbers live.
pub const NEAR_JUDGED: u32 = 15;
pub const NEAR_EXAMPLES: u32 = 30;

pub const fn is_close_to_switching(reviewed: u32, examples: u32) -> bool {
    reviewed >= NEAR_JUDGED || examples >= NEAR_EXAMPLES
}

/// How much of the automatic judgment [`judgments_of`] computes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Auto {
    /// People's judgments only (the rule before the taggers' agreement counted).
    Off,
    /// Only for characters that already have [`READY_EXAMPLES`] examples: the others cannot be
    /// placed by 학습 인식 whatever the taggers say, so classification skips the tagger reads.
    ReadyOnly,
    /// Every character.
    Full,
}

/// What the two automatic taggers (PixAI and canary) say about the images of one character.
/// "Sure" is [`CHARACTER_MIN_SCORE`] (the app's 확실 line); a tagger reads a character when
/// its best score over the tags linked to that character is sure. Only characters that have
/// linked tags in both taggers' vocabularies get signals.
#[derive(Debug, Default)]
struct TaggerSignals {
    /// Both taggers read this character: an independent 맞음.
    agree: BTreeSet<String>,
    /// Both taggers read one other character of the same series, and neither reads this one:
    /// an independent 아님. An image this character is also read on is never in here.
    disagree: BTreeSet<String>,
}

fn tagger_signals(
    reader: &impl ReviewRead,
    targets: &[String],
) -> Result<HashMap<String, TaggerSignals>> {
    let ids = serde_json::to_string(targets)?;
    let known = reader.read(|c| {
        Ok(c.prepare(
            "SELECT t.id,t.series_classification_id FROM character_targets t
             WHERE t.id IN (SELECT value FROM json_each(?1))
               AND t.role='character' AND t.series_classification_id IS NOT NULL
               AND EXISTS(SELECT 1 FROM character_target_tagger_tags m
                          JOIN tagger_character_vocabulary v ON v.tag=m.tag
                          WHERE m.target_id=t.id AND v.source='pixai')
               AND EXISTS(SELECT 1 FROM character_target_tagger_tags m
                          JOIN tagger_character_vocabulary v ON v.tag=m.tag
                          WHERE m.target_id=t.id AND v.source='canary')",
        )?
        .query_map([&ids], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<BTreeMap<_, _>, _>>()?)
    })?;
    if known.is_empty() {
        return Ok(HashMap::new());
    }
    let series = serde_json::to_string(&known.values().collect::<BTreeSet<_>>())?;
    let peers = reader.read(|c| {
        Ok(c.prepare(
            "SELECT id,series_classification_id FROM character_targets
             WHERE role='character'
               AND series_classification_id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([&series], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
    })?;
    // How many taggers read each (character, image): 2 is both. The grouping is per
    // character, so a few characters per borrow give the same rows as one big query.
    let mut reads = HashMap::<String, HashMap<String, u32>>::new();
    let peer_list = peers.iter().map(|(id, _)| id).collect::<Vec<_>>();
    for batch in peer_list.chunks(READ_BATCH_TARGETS) {
        let peer_ids = serde_json::to_string(batch)?;
        let readings = reader.read(|c| {
            Ok(c.prepare(
                // CROSS JOIN fixes the order: from the characters' few tags to the readings of
                // each tag. Left to itself the planner starts at every Asset and took ~100 ms
                // per batch on a 10k-Asset library.
                "SELECT m.target_id,s.asset_id,COUNT(DISTINCT s.source)
                 FROM character_target_tagger_tags m
                 CROSS JOIN asset_tagger_character_scores s ON s.tag=m.tag AND s.score>=?2
                 CROSS JOIN assets a ON a.id=s.asset_id AND a.status='normal' AND a.media_kind='image'
                 WHERE m.target_id IN (SELECT value FROM json_each(?1))
                 GROUP BY m.target_id,s.asset_id",
            )?
            .query_map(params![peer_ids, CHARACTER_MIN_SCORE], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u32>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
        })?;
        for (target, asset, sources) in readings {
            reads.entry(target).or_default().insert(asset, sources);
        }
    }
    // Per series: the images some character is read on by both taggers, and which characters.
    let mut sure = HashMap::<&str, HashMap<&str, Vec<&str>>>::new();
    for (peer, series) in &peers {
        for (asset, sources) in reads.get(peer).into_iter().flatten() {
            if *sources >= 2 {
                sure.entry(series)
                    .or_default()
                    .entry(asset)
                    .or_default()
                    .push(peer);
            }
        }
    }
    let mut result = HashMap::new();
    for (target, series) in &known {
        let own = reads.get(target);
        let mut signals = TaggerSignals::default();
        for (asset, sources) in own.into_iter().flatten() {
            if *sources >= 2 {
                signals.agree.insert(asset.clone());
            }
        }
        for (asset, owners) in sure.get(series.as_str()).into_iter().flatten() {
            if owners.iter().any(|owner| *owner != target.as_str())
                && !own.is_some_and(|own| own.contains_key(*asset))
            {
                signals.disagree.insert((*asset).to_owned());
            }
        }
        result.insert(target.clone(), signals);
    }
    Ok(result)
}

/// The numbers of the learning rule per character, and the pairs the taggers judged correct.
pub(super) struct Judgments {
    pub readiness: Vec<S36Readiness>,
    /// Per character: images whose pair the taggers judged correct by agreement and nobody
    /// has judged by hand. The 확인 list leaves these out.
    agreed: HashMap<String, BTreeSet<String>>,
}

/// Readiness of the given characters, with the taggers' agreement counted. Read-only.
pub(super) fn readiness_of(
    c: &Connection,
    cache: Option<&Connection>,
    targets: &[String],
) -> Result<Vec<S36Readiness>> {
    Ok(judgments_of(c, cache, targets, Auto::Full)?.readiness)
}

/// One character's numbers from its people's judgments `(judged, wrong)`, the taggers'
/// `(judged, wrong)` and its manual examples; the one place the totals and the status are made.
fn readiness_row(
    target_id: &str,
    (manual, manual_wrong): (u32, u32),
    (auto, auto_wrong): (u32, u32),
    examples: u32,
) -> S36Readiness {
    let reviewed = manual + auto;
    let wrong = manual_wrong + auto_wrong;
    S36Readiness {
        target_id: target_id.to_owned(),
        reviewed,
        reviewed_auto: auto,
        wrong,
        wrong_auto: auto_wrong,
        allowed: allowed_wrong(reviewed),
        examples,
        status: readiness_status(reviewed, wrong, examples).to_string(),
    }
}

/// Judged candidates of the characters, the one rule behind [`readiness_status`].
///
/// A candidate is a pair (character, image) the newest policy scored `automatic`. It is judged
/// - by a person when the newest manual decision (not `cleared`) came after that scoring; wrong
///   when the decision is a rejection;
/// - otherwise by the taggers ([`TaggerSignals`]): correct when both read the character, wrong
///   when both read another character of its series and neither reads this one. A newest manual
///   rejection blocks an agreement, and a manual acceptance blocks a disagreement.
///
/// A pair is judged once, a person's judgment first. Examples are manual acceptances only. Pairs
/// are looked up by key in the cache, so the cost follows the characters' decisions and tagger
/// readings, not the size of the cache.
pub(super) fn judgments_of(
    c: &Connection,
    cache: Option<&Connection>,
    targets: &[String],
    auto: Auto,
) -> Result<Judgments> {
    judgments_of_read(c, cache, targets, auto)
}

/// What the decisions say about one (character, image) pair.
struct PairDecisions {
    /// The newest decision of any origin.
    newest: String,
    /// The newest manual decision `(decision, created_at)`.
    manual: Option<(String, String)>,
}

/// The decisions of the given characters by character and image, read a few characters per
/// library borrow in one pass each (not one query per character).
fn pair_decisions(
    reader: &impl ReviewRead,
    targets: &[String],
) -> Result<HashMap<String, HashMap<String, PairDecisions>>> {
    let mut by_target = HashMap::<String, HashMap<String, PairDecisions>>::new();
    for batch in targets.chunks(READ_BATCH_TARGETS) {
        let ids = serde_json::to_string(batch)?;
        let found = reader.read(|c| {
            Ok(c.prepare(
                "SELECT d.target_id,d.source_asset_id,d.origin,d.decision,d.created_at
                 FROM character_decisions d
                 WHERE d.target_id IN (SELECT value FROM json_each(?1))
                 ORDER BY d.sequence DESC",
            )?
            .query_map([ids], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
        })?;
        // Newest first: the first row of a pair is its newest decision, the first manual one
        // its newest manual decision.
        for (target, asset, origin, decision, at) in found {
            let pair = by_target
                .entry(target)
                .or_default()
                .entry(asset)
                .or_insert_with(|| PairDecisions {
                    newest: decision.clone(),
                    manual: None,
                });
            if origin == "manual" && pair.manual.is_none() {
                pair.manual = Some((decision, at));
            }
        }
    }
    Ok(by_target)
}

/// `scored_at` of the newest policy's `automatic` scores, by character and image. Read from the
/// cache in one pass: the judgments look up tens of thousands of pairs.
fn automatic_scored_at(
    cache: &Connection,
    version: &str,
) -> Result<HashMap<String, HashMap<String, String>>> {
    shadow_read_phase();
    let mut scored = HashMap::<String, HashMap<String, String>>::new();
    for row in cache
        .prepare(
            "SELECT target_id,asset_id,scored_at FROM scores
             WHERE policy_version=?1 AND verdict='automatic'",
        )?
        .query_map([version], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
    {
        let (target, asset, at) = row?;
        scored.entry(target).or_default().insert(asset, at);
    }
    Ok(scored)
}

fn judgments_of_read(
    c: &impl ReviewRead,
    cache: Option<&Connection>,
    targets: &[String],
    auto: Auto,
) -> Result<Judgments> {
    let version = cache.map(newest_policy).transpose()?.flatten();
    let scored = match (&version, cache) {
        (Some(version), Some(cache)) => Some(automatic_scored_at(cache, version)?),
        _ => None,
    };
    let decisions = pair_decisions(c, targets)?;
    let no_decisions = HashMap::new();
    // Manual examples: images with a manual decision whose newest decision is an acceptance.
    let example_counts = targets
        .iter()
        .map(|target| {
            decisions
                .get(target)
                .unwrap_or(&no_decisions)
                .values()
                .filter(|pair| pair.manual.is_some() && pair.newest == "accepted")
                .count() as u32
        })
        .collect::<Vec<_>>();
    let signals = if version.is_none() {
        HashMap::new()
    } else {
        let wanted = targets
            .iter()
            .zip(&example_counts)
            .filter(|(_, count)| match auto {
                Auto::Off => false,
                Auto::ReadyOnly => **count >= READY_EXAMPLES,
                Auto::Full => true,
            })
            .map(|(target, _)| target.clone())
            .collect::<Vec<_>>();
        if wanted.is_empty() {
            HashMap::new()
        } else {
            tagger_signals(c, &wanted)?
        }
    };
    let mut agreed = HashMap::new();
    let mut result = Vec::with_capacity(targets.len());
    for (target, examples) in targets.iter().zip(example_counts) {
        let (mut manual, mut manual_wrong) = (0u32, 0u32);
        let (mut judged_auto, mut wrong_auto) = (0u32, 0u32);
        if let Some(scored) = &scored {
            let scored = scored.get(target);
            let scored_at = |asset: &String| scored.and_then(|scored| scored.get(asset));
            // Only the latest manual decision of a pair counts, and a `cleared` one leaves the
            // pair without any.
            let latest = decisions
                .get(target)
                .unwrap_or(&no_decisions)
                .iter()
                .filter_map(|(asset, pair)| {
                    let (decision, at) = pair.manual.as_ref()?;
                    (decision != "cleared").then_some((asset, (decision, at)))
                })
                .collect::<HashMap<_, _>>();
            for (asset, (decision, at)) in &latest {
                if scored_at(asset).is_some_and(|scored| *at > scored) {
                    manual += 1;
                    manual_wrong += u32::from(*decision == "rejected");
                }
            }
            if let Some(signals) = signals.get(target) {
                let mut settled = BTreeSet::new();
                for (assets, correct) in [(&signals.agree, true), (&signals.disagree, false)] {
                    for asset in assets {
                        let Some(scored) = scored_at(asset) else {
                            continue;
                        };
                        match latest.get(asset) {
                            Some((_, at)) if *at > scored => continue,
                            Some((decision, _)) if *decision == "rejected" => continue,
                            Some(_) if !correct => continue,
                            _ => {}
                        }
                        judged_auto += 1;
                        if correct {
                            settled.insert(asset.clone());
                        } else {
                            wrong_auto += 1;
                        }
                    }
                }
                agreed.insert(target.clone(), settled);
            }
        }
        result.push(readiness_row(
            target,
            (manual, manual_wrong),
            (judged_auto, wrong_auto),
            examples,
        ));
    }
    Ok(Judgments {
        readiness: result,
        agreed,
    })
}

/// How the 확인 list treats the pairs of one list, from the judgments of its characters.
#[derive(Debug, Default)]
struct ListPolicy {
    /// Characters 학습 인식 places right now.
    learning: BTreeSet<String>,
    /// Characters still far from switching ([`is_close_to_switching`]).
    far: BTreeSet<String>,
    agreed: HashMap<String, BTreeSet<String>>,
}

impl ListPolicy {
    fn build(
        c: &impl ReviewRead,
        cache: Option<&Connection>,
        targets: BTreeSet<String>,
    ) -> Result<Self> {
        if targets.is_empty() {
            return Ok(Self::default());
        }
        let ids = targets.into_iter().collect::<Vec<_>>();
        let judged = judgments_of_read(c, cache, &ids, Auto::Full)?;
        let automatic = c
            .read(|c| automatic_targets(c, &ids))?
            .into_iter()
            .collect::<BTreeSet<_>>();
        let mut policy = Self {
            agreed: judged.agreed,
            ..Self::default()
        };
        for r in judged.readiness {
            if !is_close_to_switching(r.reviewed, r.examples) {
                policy.far.insert(r.target_id.clone());
            }
            if r.status == "learning" && automatic.contains(&r.target_id) {
                policy.learning.insert(r.target_id);
            }
        }
        Ok(policy)
    }

    /// Whether a person has nothing to do with this candidate: the taggers judged it correct, or
    /// 학습 인식 already placed it for a character it owns.
    fn settles(&self, row: &ShadowRow) -> bool {
        (row.native_outcome == "accepted_automatic" && self.learning.contains(&row.target_id))
            || (row.verdict == "automatic"
                && self
                    .agreed
                    .get(&row.target_id)
                    .is_some_and(|assets| assets.contains(&row.asset_id)))
    }
}

/// The given characters 학습 인식 may place: enabled and not manual-only.
fn automatic_targets(c: &Connection, target_ids: &[String]) -> Result<Vec<String>> {
    let ids = serde_json::to_string(target_ids)?;
    Ok(c.prepare(
        "SELECT id FROM character_targets
         WHERE id IN (SELECT value FROM json_each(?1))
           AND role='character' AND enabled=1 AND manual_only=0",
    )?
    .query_map([ids], |r| r.get::<_, String>(0))?
    .collect::<std::result::Result<Vec<_>, _>>()?)
}

impl Library {
    /// Write-side reconciliation using the exact judgments that remove agreed pairs from
    /// 확인 and its PC/tablet projections. Call only inside a library write transaction.
    /// Scan all targets so the next publication/apply also places pre-existing agreements.
    pub(super) fn publish_agreed_pairs_in(&self, c: &Connection) -> Result<usize> {
        let Some(cache) = open_shadow_cache(&self.root)? else {
            return Ok(0);
        };
        let cache = cache.unchecked_transaction()?;
        let targets = c.prepare(
            "SELECT id FROM character_targets WHERE role='character' AND enabled=1 AND manual_only=0 ORDER BY id",
        )?.query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let judged = judgments_of(c, Some(&cache), &targets, Auto::Full)?;
        let Some(version) = newest_policy(&cache)? else {
            return Ok(0);
        };
        let mut published = 0;
        for (target_id, assets) in judged.agreed {
            for asset_id in assets {
                // An earlier decision, including 빼기 or an automatic veto, always wins.
                let blocked: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2)
                     OR EXISTS(SELECT 1 FROM character_tagger_pending WHERE target_id=?1 AND asset_id=?2 AND reason='veto')",
                    params![target_id, asset_id], |r| r.get(0),
                )?;
                if blocked {
                    continue;
                }
                // Reuse ordinary automatic scope/reference checks; cached scores cannot
                // classify a changed, excluded, unavailable or out-of-scope image.
                let Some(target) = self
                    .character_autotag_targets(c, &asset_id)?
                    .into_iter()
                    .find(|t| t.id == target_id)
                else {
                    continue;
                };
                let (hash, score, feature, rejections): (String, Option<f64>, String, i64) = cache.query_row(
                    "SELECT content_hash,knn3,feature_id,prior_manual_rejections FROM scores
                     WHERE asset_id=?1 AND target_id=?2 AND policy_version=?3 AND verdict='automatic'",
                    params![asset_id, target_id, version], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
                let current: Option<String> = c.query_row(
                    "SELECT content_hash FROM assets WHERE id=?1 AND status='normal' AND media_kind='image'",
                    [&asset_id], |r| r.get(0),
                ).optional()?;
                if current.as_deref() != Some(hash.as_str()) {
                    continue;
                }
                let snapshot = serde_json::json!({
                    "scanId": null,
                    "prediction": {"engine": "s36", "policyVersion": version,
                        "featureId": feature, "knn3": score, "priorManualRejections": rejections,
                        "automaticScope": true, "taggerAgreement": true},
                    "references": target.usable_references().collect::<Vec<_>>(),
                });
                self.accept_s36_in(c, &target, &asset_id, &hash, &snapshot)?;
                published += 1;
            }
        }
        Ok(published)
    }

    /// Read-only: the shadow cache and the library decisions of one series.
    pub fn character_s36_readiness(&self, series_id: &str) -> Result<Vec<S36Readiness>> {
        let slot = summary_slot(
            &self.character_changes.shadow_review.readiness,
            Some(series_id),
        );
        self.cached_summary(&slot, || {
            let cache = open_shadow_cache(&self.root)?;
            let targets = self.read(|c| Ok(c
                .prepare("SELECT id FROM character_targets WHERE role='character' AND series_classification_id=?1 ORDER BY id")?
                .query_map([series_id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?))?;
            Ok(judgments_of_read(self, cache.as_ref(), &targets, Auto::Full)?.readiness)
        })
    }

    /// Every character 학습 인식 places right now, and the series they belong to.
    ///
    /// Borrows the library only for short reads (the judgments take seconds on a cold start),
    /// so callers must not hold a connection.
    pub(super) fn learning_overview(&self) -> Result<(LearningTargets, BTreeSet<String>)> {
        let targets = self.read(|c| {
            Ok(c.prepare(
                "SELECT id,series_classification_id FROM character_targets
                 WHERE role='character' AND enabled=1 AND manual_only=0",
            )?
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
        })?;
        let ids = targets.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let learning = self.learning_targets_read(self, &ids);
        let series = targets
            .into_iter()
            .filter(|(id, _)| learning.owns(id))
            .filter_map(|(_, series)| series)
            .collect();
        Ok((learning, series))
    }

    /// Which of the given characters 학습 인식 places automatically right now. A character
    /// that is disabled or manual-only never is. When the shadow cache cannot be read, none
    /// is, so 기본 인식 keeps classifying.
    pub(super) fn learning_targets(
        &self,
        c: &Connection,
        target_ids: &[String],
    ) -> LearningTargets {
        self.learning_targets_read(c, target_ids)
    }

    fn learning_targets_read(
        &self,
        c: &impl ReviewRead,
        target_ids: &[String],
    ) -> LearningTargets {
        let read = || -> Result<LearningTargets> {
            let Some(cache) = open_shadow_cache(&self.root)? else {
                return Ok(LearningTargets::default());
            };
            let automatic = c.read(|c| automatic_targets(c, target_ids))?;
            Ok(LearningTargets(
                judgments_of_read(c, Some(&cache), &automatic, Auto::ReadyOnly)?
                    .readiness
                    .into_iter()
                    .filter(|r| r.status == "learning")
                    .map(|r| r.target_id)
                    .collect(),
            ))
        };
        read().unwrap_or_else(|error| {
            eprintln!("학습 인식 판단을 읽지 못해 기본 인식으로 계속합니다: {error}");
            LearningTargets::default()
        })
    }
}

/// Test support: gives `target_id` raw rows the readiness rule counts, without assets or
/// reference files. `accepted` and `rejected` are judged S36 automatic candidates (scored
/// in `policy`, judged later by hand), `examples` more manual acceptances nobody scored.
/// `tag` keeps the invented asset ids of separate calls apart.
#[cfg(test)]
pub(super) fn seed_readiness(
    root: &Path,
    c: &Connection,
    target_id: &str,
    policy: &str,
    tag: &str,
    (accepted, rejected, examples): (u32, u32, u32),
) {
    super::character_shadow::Cache::open(root).unwrap();
    let cache = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
    let decide = |asset: &str, decision: &str| {
        c.execute(
            "INSERT INTO character_decisions(target_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
             VALUES(?1,?2,'hash',?3,'fingerprint','{}','manual','2026-02-01T00:00:00Z')",
            params![target_id, asset, decision],
        )
        .unwrap();
    };
    for (kind, count) in [("accepted", accepted), ("rejected", rejected)] {
        for i in 0..count {
            let asset = format!("seed-{tag}-{kind}-{i}");
            cache
                .execute(
                    "INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections,origin)
                     VALUES(?1,'hash',?2,0.05,'automatic',?3,'feature','none','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',100,'live')",
                    params![asset, target_id, policy],
                )
                .unwrap();
            decide(&asset, kind);
        }
    }
    for i in 0..examples {
        decide(&format!("seed-{tag}-example-{i}"), "accepted");
    }
}

#[cfg(test)]
#[path = "character_shadow_review_tests.rs"]
mod tests;
