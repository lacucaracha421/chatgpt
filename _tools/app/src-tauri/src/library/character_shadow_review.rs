//! Read-only review feed over the disposable S36 shadow cache.
//!
//! The screen behind this module asks the user to judge assets the shadow
//! scorer called `automatic` or `recommended`. Judgments go through the normal
//! manual decision path (`record_character_decisions`); nothing here writes to
//! the shadow cache or the library, and shadow rows never become evidence.
use super::{
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::Read,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::SystemTime,
};

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

/// The S36 shadow cache opened read-only, or `None` when it does not exist or has no
/// `scores` table yet.
fn open_shadow_cache(root: &Path) -> Result<Option<Connection>> {
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
    let origin = if super::character_shadow::cache_has_origin(&c)? {
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

fn latest_decisions(
    connection: &Connection,
    rows: &[ShadowRow],
    manual: bool,
) -> Result<BTreeMap<(String, String), (String, String)>> {
    if rows.is_empty() {
        return Ok(BTreeMap::new());
    }
    let pairs = row_pairs_json(rows)?;
    let origin = if manual {
        "d.origin='manual'"
    } else {
        "d.origin<>'manual'"
    };
    let mut statement = connection.prepare(&format!(
        "SELECT d.target_id,d.source_asset_id,d.decision,d.created_at
         FROM character_decisions d
         JOIN json_each(?1) requested
           ON d.target_id=json_extract(requested.value,'$[0]')
          AND d.source_asset_id=json_extract(requested.value,'$[1]')
         WHERE {origin}
         ORDER BY d.target_id,d.source_asset_id,d.sequence DESC"
    ))?;
    let mut decisions = BTreeMap::new();
    for row in statement.query_map([pairs], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })? {
        let (target_id, asset_id, decision, created_at) = row?;
        decisions
            .entry((target_id, asset_id))
            .or_insert((decision, created_at));
    }
    Ok(decisions)
}

fn eligible_assets(
    connection: &Connection,
    rows: &[ShadowRow],
) -> Result<BTreeMap<(String, String), (String, i64, i64)>> {
    if rows.is_empty() {
        return Ok(BTreeMap::new());
    }
    let requested = serde_json::to_string(
        &rows
            .iter()
            .map(|row| &row.asset_id)
            .collect::<BTreeSet<_>>(),
    )?;
    let mut statement = connection.prepare(
        "SELECT id,content_hash,original_name,width,height FROM assets
         WHERE id IN (SELECT value FROM json_each(?1))
           AND status='normal' AND media_kind='image'",
    )?;
    let mut assets = BTreeMap::new();
    for row in statement.query_map([requested], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })? {
        let (asset_id, content_hash, original_name, width, height) = row?;
        assets.insert((asset_id, content_hash), (original_name, width, height));
    }
    Ok(assets)
}

fn retain_in_character_scope(connection: &Connection, rows: &mut Vec<ShadowRow>) -> Result<()> {
    if super::character_scope::broad_folder_scope_enabled(connection)? {
        return Ok(());
    }
    let covered = super::character_scope::series_covered_folders(connection)?;
    let asset_ids = serde_json::to_string(
        &rows
            .iter()
            .map(|row| row.asset_id.as_str())
            .collect::<BTreeSet<_>>(),
    )?;
    let covered = serde_json::to_string(&covered)?;
    let inside = connection
        .prepare(
            "SELECT DISTINCT asset_id FROM asset_classifications
             WHERE asset_id IN (SELECT value FROM json_each(?1))
               AND classification_id IN (SELECT value FROM json_each(?2))",
        )?
        .query_map(params![asset_ids, covered], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    rows.retain(|row| inside.contains(&row.asset_id));
    Ok(())
}

fn enabled_target_names(
    connection: &Connection,
    rows: &[ShadowRow],
) -> Result<BTreeMap<String, String>> {
    if rows.is_empty() {
        return Ok(BTreeMap::new());
    }
    let target_ids = serde_json::to_string(
        &rows
            .iter()
            .map(|row| row.target_id.as_str())
            .collect::<BTreeSet<_>>(),
    )?;
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
        Some(_) => Err(Error::Invalid("알 수 없는 S36 확인 목록입니다.")),
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

/// The database part of a review list. `rows` is the newest policy's rows (`None`: no cache).
fn prepare(
    c: &Connection,
    rows: Option<&ShadowRows>,
    doubtful: bool,
    series_id: Option<&str>,
) -> Result<Prepared> {
    let Some(rows) = rows else {
        return Ok(Prepared::default());
    };
    let (version, all) = &**rows;
    let mut rows = match series_id {
        Some(series_id) => {
            let in_series = c
                .prepare("SELECT id FROM character_targets WHERE series_classification_id=?1")?
                .query_map([series_id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<BTreeSet<_>, _>>()?;
            all.iter()
                .filter(|row| in_series.contains(&row.target_id))
                .cloned()
                .collect()
        }
        None => all.clone(),
    };
    // With the broad-folder rule off, scores of images filed outside every registered
    // series stay in the cache but are not offered (turning the rule on shows them again).
    retain_in_character_scope(c, &mut rows)?;
    // Pairs the native pass already accepted automatically come after new findings
    // and are labelled as such; each group keeps the stable pseudo-random order.
    // (Backfill rows recorded "none" as the native outcome for them.)
    let rows = {
        let native = latest_decisions(c, &rows, false)?;
        let mut keyed = Vec::with_capacity(rows.len());
        for (index, mut row) in rows.into_iter().enumerate() {
            let classified = native
                .get(&(row.target_id.clone(), row.asset_id.clone()))
                .is_some_and(|(decision, _)| decision == "accepted");
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
        target_ids.insert(row.target_id.clone());
        prepared.pending.push(PendingRow {
            original_name: original_name.clone(),
            width: u32::try_from(*width).unwrap_or(0),
            height: u32::try_from(*height).unwrap_or(0),
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

impl Library {
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
        let connection = self.connection()?;
        retain_in_character_scope(&connection, &mut rows)?;
        let manual = latest_decisions(&connection, &rows, true)?;
        let assets = eligible_assets(&connection, &rows)?;
        let targets = enabled_target_names(&connection, &rows)?;
        drop(connection);
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
        let c = self.connection()?;
        let prepared = prepare(&c, rows.as_ref(), doubtful, query.series_id.as_deref())?;
        drop(c);
        // Characters are read after releasing the database lock so their reference file
        // checks never hold it.
        let targets = self.review_targets(&prepared.target_ids)?;
        Ok(page_of(&assemble(&prepared, doubtful, &targets), &query))
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

    /// One review list, limited to the targets of one series when given; items and summary
    /// counts both follow the scope. The database part is reused while its [`ListKey`] holds;
    /// the characters are read on every call, and the assembled list is reused while they are
    /// unchanged too.
    fn shadow_review_list(
        &self,
        doubtful: bool,
        series_id: Option<&str>,
    ) -> Result<Arc<ShadowReviewItems>> {
        let cache = &self.character_changes.shadow_review;
        let slot = cache.slot(doubtful, series_id);
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        let (stamp, rows) = self.shadow_rows_cached(doubtful)?;
        let c = self.connection()?;
        let key = ListKey {
            inputs: self.character_changes.shadow_review_generation(),
            shadow: stamp,
            broad_folder_scope: super::character_scope::broad_folder_scope_enabled(&c)?,
        };
        let prepared = match slot.as_ref() {
            Some(cached) if cached.key == key => cached.prepared.clone(),
            _ => {
                *slot = None;
                #[cfg(test)]
                cache
                    .prepared_count
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Arc::new(prepare(&c, rows.as_ref(), doubtful, series_id)?)
            }
        };
        drop(c);
        let targets = self.review_targets(&prepared.target_ids)?;
        let cached = slot.get_or_insert_with(|| CachedList {
            key,
            prepared: prepared.clone(),
            assembled: None,
        });
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

/// How close one character is to being classified by S36, from reviewed S36
/// automatic candidates (newest policy) and the manual "accepted" examples.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct S36Readiness {
    pub target_id: String,
    /// Automatic candidates judged after scoring.
    pub reviewed: u32,
    pub wrong: u32,
    /// Manual acceptances for this character (S36's positive examples).
    pub examples: u32,
    /// `ready`, `collecting`, `hold` or `keep`.
    pub status: String,
}

pub const READY_REVIEWED: u32 = 30;
pub const READY_EXAMPLES: u32 = 50;

pub(super) fn readiness_status(reviewed: u32, wrong: u32, examples: u32) -> &'static str {
    if wrong >= 4 {
        "keep"
    } else if wrong >= 2 {
        "hold"
    } else if reviewed >= READY_REVIEWED && examples >= READY_EXAMPLES {
        "ready"
    } else {
        "collecting"
    }
}

impl Library {
    /// Read-only: the shadow cache and the library decisions of one series.
    pub fn character_s36_readiness(&self, series_id: &str) -> Result<Vec<S36Readiness>> {
        let rows = self.shadow_rows_cached(false)?.1;
        let c = self.connection()?;
        let targets = c
            .prepare(
                "SELECT id FROM character_targets WHERE series_classification_id=?1 ORDER BY id",
            )?
            .query_map([series_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let in_series = targets.iter().collect::<BTreeSet<_>>();
        let automatic = rows
            .iter()
            .flat_map(|rows| &rows.1)
            .filter(|r| r.verdict == "automatic" && in_series.contains(&r.target_id))
            .cloned()
            .collect::<Vec<_>>();
        let judged = latest_decisions(&c, &automatic, true)?;
        // (reviewed, wrong) per character: automatic candidates judged after scoring.
        let mut tallies = BTreeMap::<&str, (u32, u32)>::new();
        for row in &automatic {
            let Some((value, at)) = judged.get(&(row.target_id.clone(), row.asset_id.clone()))
            else {
                continue;
            };
            if at.as_str() > row.scored_at.as_str() && value != "cleared" {
                let tally = tallies.entry(row.target_id.as_str()).or_default();
                tally.0 += 1;
                tally.1 += u32::from(value == "rejected");
            }
        }
        let mut result = Vec::with_capacity(targets.len());
        for target in &targets {
            let (reviewed, wrong) = tallies.get(target.as_str()).copied().unwrap_or_default();
            let examples: u32 = c.query_row(
                "SELECT COUNT(*) FROM (SELECT d.source_asset_id,
                   (SELECT x.decision FROM character_decisions x WHERE x.target_id=d.target_id AND x.source_asset_id=d.source_asset_id ORDER BY x.sequence DESC LIMIT 1) AS latest
                 FROM character_decisions d WHERE d.target_id=?1 AND d.origin='manual' GROUP BY d.source_asset_id)
                 WHERE latest='accepted'",
                [target],
                |r| r.get(0),
            )?;
            let status = readiness_status(reviewed, wrong, examples).to_string();
            result.push(S36Readiness {
                target_id: target.clone(),
                reviewed,
                wrong,
                examples,
                status,
            });
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::super::characters::{tests::Fixture, DecisionKind, DecisionRequest, Target};
    use super::*;

    mod performance_measurement {
        use super::*;
        use rusqlite::ffi;
        use std::{
            cell::{Cell, RefCell},
            ffi::{c_char, c_int, c_uint, c_void, CStr},
            sync::Once,
            time::Instant,
        };

        static INSTALL: Once = Once::new();
        thread_local! {
            static ENABLED: Cell<bool> = const { Cell::new(false) };
            static STATEMENTS: Cell<u64> = const { Cell::new(0) };
            static SQL: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
            static PROFILE_NANOS: RefCell<BTreeMap<&'static str, u64>> = const { RefCell::new(BTreeMap::new()) };
        }

        unsafe extern "C" fn trace(
            kind: c_uint,
            _context: *mut c_void,
            statement: *mut c_void,
            detail: *mut c_void,
        ) -> c_int {
            if ENABLED.with(Cell::get) {
                if kind == ffi::SQLITE_TRACE_STMT {
                    STATEMENTS.with(|count| count.set(count.get() + 1));
                    let expanded = detail.cast::<c_char>();
                    let raw = if expanded.is_null() {
                        ffi::sqlite3_sql(statement.cast())
                    } else {
                        expanded
                    };
                    if !raw.is_null() {
                        let sql = CStr::from_ptr(raw).to_string_lossy().into_owned();
                        SQL.with(|statements| statements.borrow_mut().push(sql));
                    }
                } else if kind == ffi::SQLITE_TRACE_PROFILE {
                    let raw = ffi::sqlite3_sql(statement.cast());
                    if !raw.is_null() && !detail.is_null() {
                        let sql = CStr::from_ptr(raw).to_string_lossy();
                        let nanos = (*(detail.cast::<i64>())).max(0) as u64;
                        PROFILE_NANOS.with(|profile| {
                            *profile.borrow_mut().entry(category(&sql)).or_default() += nanos;
                        });
                    }
                }
            }
            0
        }

        unsafe extern "C" fn on_connection_open(
            database: *mut ffi::sqlite3,
            _error: *mut *mut c_char,
            _api: *const ffi::sqlite3_api_routines,
        ) -> c_int {
            ffi::sqlite3_trace_v2(
                database,
                ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_PROFILE,
                Some(trace),
                std::ptr::null_mut(),
            )
        }

        fn install_trace() {
            INSTALL.call_once(|| {
                let result = unsafe { ffi::sqlite3_auto_extension(Some(on_connection_open)) };
                assert_eq!(result, ffi::SQLITE_OK);
            });
        }

        fn copy_snapshot() -> (tempfile::TempDir, Library) {
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/perf-root");
            assert!(source.join("library.sqlite").is_file());
            assert!(source.join(".cache/characters/s36_shadow.sqlite").is_file());
            let temp = tempfile::tempdir().unwrap();
            std::fs::copy(
                source.join("library.sqlite"),
                temp.path().join("library.sqlite"),
            )
            .unwrap();
            let cache = temp.path().join(".cache/characters");
            std::fs::create_dir_all(&cache).unwrap();
            std::fs::copy(
                source.join(".cache/characters/s36_shadow.sqlite"),
                cache.join("s36_shadow.sqlite"),
            )
            .unwrap();
            let library = Library::open(temp.path()).unwrap();
            (temp, library)
        }

        fn category(sql: &str) -> &'static str {
            if sql.contains("FROM scores") || sql.contains("sqlite_master") {
                "shadow cache"
            } else if sql.contains("FROM asset_classifications WHERE asset_id") {
                "broad-folder per asset"
            } else if sql.contains("origin<>'manual'") {
                "native decision per pair"
            } else if sql.contains("origin='manual'") {
                "manual decision per pair"
            } else if sql.contains("WHERE id IN (SELECT value FROM json_each") {
                "candidate assets batch"
            } else if sql.contains("WITH RECURSIVE scope") {
                "target reference eligibility"
            } else if sql.contains("FROM assets") {
                "other asset read"
            } else if sql.contains("FROM character_targets")
                || sql.contains("FROM character_references")
            {
                "target details"
            } else {
                "other"
            }
        }

        fn statement_count<T>(call: impl FnOnce() -> T) -> (T, u64) {
            STATEMENTS.with(|count| count.set(0));
            SQL.with(|statements| statements.borrow_mut().clear());
            PROFILE_NANOS.with(|profile| profile.borrow_mut().clear());
            ENABLED.with(|enabled| enabled.set(true));
            let value = call();
            ENABLED.with(|enabled| enabled.set(false));
            (value, STATEMENTS.with(Cell::get))
        }

        fn fixture_with_rows(count: usize) -> Fixture {
            let fixture = Fixture::new();
            let target = fixture.ready("Statement gate");
            let mut rows = Vec::with_capacity(count);
            for index in 0..count {
                let id = format!("statement-{index:04}");
                series_asset(&fixture, &id);
                rows.push((
                    id,
                    target.id.clone(),
                    if index % 2 == 0 {
                        "automatic"
                    } else {
                        "recommended"
                    },
                ));
            }
            for chunk in rows.chunks(100) {
                let borrowed = chunk
                    .iter()
                    .map(|(asset, target, verdict)| {
                        (
                            asset.as_str(),
                            target.as_str(),
                            *verdict,
                            0.1,
                            "statement-v1",
                            "none",
                            "2026-09-29T00:00:00Z",
                        )
                    })
                    .collect::<Vec<_>>();
                insert(fixture.temp.path(), &borrowed);
            }
            fixture
        }

        #[test]
        fn shadow_review_page_checks_reference_files_without_the_database_lock() {
            let fixture = fixture_with_rows(10);
            let checks = &crate::library::character_sources::REFERENCE_CHECKS;
            checks.with(|count| count.set((0, 0, 0)));
            let page = fixture
                .library
                .character_shadow_review_page(ShadowReviewQuery {
                    offset: 0,
                    limit: 200,
                    mode: None,
                    series_id: None,
                })
                .unwrap();
            assert_eq!(
                page.summary.automatic.pending + page.summary.recommended.pending,
                10
            );
            let (all, locked, _) = checks.with(|count| count.get());
            assert!(all > 0);
            assert_eq!(locked, 0);
        }

        #[test]
        fn shadow_review_page_statement_count_is_independent_of_row_count() {
            const MAX_PAGE_STATEMENTS: u64 = 24;
            const MAX_SUMMARY_STATEMENTS: u64 = 14;
            install_trace();
            let small = fixture_with_rows(5);
            let large = fixture_with_rows(250);
            let query = || ShadowReviewQuery {
                offset: 0,
                limit: 200,
                mode: None,
                series_id: None,
            };
            let (_, small_count) =
                statement_count(|| small.library.character_shadow_review_page(query()).unwrap());
            let (page, large_count) =
                statement_count(|| large.library.character_shadow_review_page(query()).unwrap());
            eprintln!("statement gate: small={small_count} large={large_count}");
            assert_eq!(page.summary.automatic.pending, 125);
            assert_eq!(page.summary.recommended.pending, 125);
            assert_eq!(small_count, large_count);
            assert!(
                large_count <= MAX_PAGE_STATEMENTS,
                "{large_count} statements exceed the {MAX_PAGE_STATEMENTS} statement gate"
            );

            let (_, small_summary_count) =
                statement_count(|| small.library.character_shadow_review_summary().unwrap());
            let (summary, large_summary_count) =
                statement_count(|| large.library.character_shadow_review_summary().unwrap());
            eprintln!(
                "summary statement gate: small={small_summary_count} large={large_summary_count}"
            );
            assert_eq!(summary.automatic, 125);
            assert_eq!(summary.recommended, 125);
            assert_eq!(small_summary_count, large_summary_count);
            assert!(
                large_summary_count <= MAX_SUMMARY_STATEMENTS,
                "{large_summary_count} summary statements exceed the {MAX_SUMMARY_STATEMENTS} statement gate"
            );
        }

        #[test]
        #[ignore = "reads target/perf-root snapshot"]
        fn measure_home_shadow_review_page() {
            install_trace();
            let (_temp, library) = copy_snapshot();
            let mut elapsed = Vec::new();
            for run in 1..=3 {
                let started = Instant::now();
                let (page, statements) = statement_count(|| {
                    library
                        .character_shadow_review_page(ShadowReviewQuery {
                            offset: 0,
                            limit: 200,
                            mode: None,
                            series_id: None,
                        })
                        .unwrap()
                });
                let millis = started.elapsed().as_secs_f64() * 1000.0;
                elapsed.push(millis);
                let mut categories = BTreeMap::<&str, usize>::new();
                SQL.with(|statements| {
                    for sql in statements.borrow().iter() {
                        *categories.entry(category(sql)).or_default() += 1;
                    }
                });
                let profile = PROFILE_NANOS.with(|profile| {
                    profile
                        .borrow()
                        .iter()
                        .map(|(category, nanos)| (*category, *nanos as f64 / 1_000_000.0))
                        .collect::<BTreeMap<_, _>>()
                });
                eprintln!(
                    "run={run} ms={millis:.2} statements={statements} items={} pending={} categories={categories:?} sql_ms={profile:?}",
                    page.items.len(),
                    page.summary.automatic.pending + page.summary.recommended.pending
                );
            }
            elapsed.sort_by(f64::total_cmp);
            eprintln!("median_ms={:.2}", elapsed[1]);

            let mut summary_elapsed = Vec::new();
            for run in 1..=3 {
                let started = Instant::now();
                let (summary, statements) =
                    statement_count(|| library.character_shadow_review_summary().unwrap());
                let millis = started.elapsed().as_secs_f64() * 1000.0;
                summary_elapsed.push(millis);
                let profile = PROFILE_NANOS.with(|profile| {
                    profile
                        .borrow()
                        .iter()
                        .map(|(category, nanos)| (*category, *nanos as f64 / 1_000_000.0))
                        .collect::<BTreeMap<_, _>>()
                });
                eprintln!(
                    "summary_run={run} ms={millis:.2} statements={statements} pending={} targets={} sql_ms={profile:?}",
                    summary.automatic + summary.recommended,
                    summary.targets.len()
                );
            }
            summary_elapsed.sort_by(f64::total_cmp);
            eprintln!("summary_median_ms={:.2}", summary_elapsed[1]);
        }
    }

    fn insert(root: &Path, rows: &[(&str, &str, &str, f64, &str, &str, &str)]) {
        super::super::character_shadow::Cache::open(root).unwrap();
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        for (asset, target, verdict, knn3, version, outcome, scored_at) in rows {
            c.execute(
                "INSERT OR REPLACE INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
                 VALUES(?1,?2,?3,?4,?5,?6,'feature',?7,?8,?8,100)",
                params![asset, content_hash(asset), target, knn3, verdict, version, outcome, scored_at],
            )
            .unwrap();
        }
    }

    fn content_hash(asset: &str) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(asset.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// One more series-level image so two pending pairs can be judged manually.
    fn series_asset(f: &Fixture, id: &str) {
        let original = format!("assets/{id}.png");
        let thumbnail = format!("thumbnails/{id}.webp");
        std::fs::write(f.temp.path().join(&original), id.as_bytes()).unwrap();
        std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
        let c = f.library.connection().unwrap();
        c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES(?1,?2,'image',?1,?3,?4,7,3,2,'2026-09-08','normal')", params![id, content_hash(id), original, thumbnail]).unwrap();
        c.execute(
            "INSERT INTO asset_classifications VALUES(?1,?2)",
            params![id, f.series],
        )
        .unwrap();
    }

    fn decide(f: &Fixture, target: &Target, asset: &str, decision: DecisionKind) {
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec![asset.into()],
                decision,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
    }

    fn page(f: &Fixture, offset: u32, limit: u32) -> ShadowReviewPage {
        f.library
            .character_shadow_review_page(ShadowReviewQuery {
                offset,
                limit,
                mode: None,
                series_id: None,
            })
            .unwrap()
    }

    /// The cached list of one mode and series scope.
    fn items_in(
        library: &Library,
        mode: Option<&str>,
        series_id: Option<&str>,
    ) -> ShadowReviewItems {
        let doubtful = shadow_review_mode(mode).unwrap();
        (*library.shadow_review_list(doubtful, series_id).unwrap()).clone()
    }

    /// Pre-batching implementation retained only as an executable compatibility oracle.
    fn legacy_items(
        library: &Library,
        mode: Option<&str>,
        series_id: Option<&str>,
    ) -> ShadowReviewItems {
        let doubtful = shadow_review_mode(mode).unwrap();
        let mut page = ShadowReviewItems {
            items: Vec::new(),
            policy_version: None,
            summary: ShadowReviewSummary::default(),
        };
        let Some((version, mut rows)) = shadow_rows(&library.root, doubtful).unwrap() else {
            return page;
        };
        page.policy_version = Some(version);
        let connection = library.connection().unwrap();
        if let Some(series_id) = series_id {
            let in_series = connection
                .prepare("SELECT id FROM character_targets WHERE series_classification_id=?1")
                .unwrap()
                .query_map([series_id], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<BTreeSet<_>>>()
                .unwrap();
            rows.retain(|row| in_series.contains(&row.target_id));
        }
        if !super::super::character_scope::broad_folder_scope_enabled(&connection).unwrap() {
            let covered =
                super::super::character_scope::series_covered_folders(&connection).unwrap();
            let mut folders = connection
                .prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1")
                .unwrap();
            let mut inside = BTreeMap::new();
            rows.retain(|row| {
                *inside.entry(row.asset_id.clone()).or_insert_with(|| {
                    folders
                        .query_map([&row.asset_id], |result| result.get::<_, String>(0))
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap()
                        .iter()
                        .any(|id| covered.contains(id))
                })
            });
        }
        let rows = {
            let mut native = connection
                .prepare(
                    "SELECT decision FROM character_decisions
                     WHERE target_id=?1 AND source_asset_id=?2 AND origin<>'manual'
                     ORDER BY sequence DESC LIMIT 1",
                )
                .unwrap();
            let mut keyed = Vec::with_capacity(rows.len());
            for (index, mut row) in rows.into_iter().enumerate() {
                let classified = native
                    .query_row(params![row.target_id, row.asset_id], |result| {
                        result.get::<_, String>(0)
                    })
                    .optional()
                    .unwrap()
                    .as_deref()
                    == Some("accepted");
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
        let mut targets: BTreeMap<String, Option<TargetInfo>> = BTreeMap::new();
        let mut asset = connection
            .prepare(
                "SELECT original_name,width,height FROM assets
                 WHERE id=?1 AND content_hash=?2 AND status='normal' AND media_kind='image'",
            )
            .unwrap();
        let mut decision = connection
            .prepare(
                "SELECT decision,created_at FROM character_decisions
                 WHERE target_id=?1 AND source_asset_id=?2 AND origin='manual'
                 ORDER BY sequence DESC LIMIT 1",
            )
            .unwrap();
        for row in rows {
            let origin_tiers = page.summary.by_origin.get_mut(&row.origin).unwrap();
            let origin_counts = if row.verdict == "automatic" {
                &mut origin_tiers.automatic
            } else {
                &mut origin_tiers.recommended
            };
            let counts = match row.verdict.as_str() {
                _ if doubtful => &mut page.summary.doubtful,
                "automatic" => &mut page.summary.automatic,
                _ => &mut page.summary.recommended,
            };
            let manual: Option<(String, String)> = decision
                .query_row(params![row.target_id, row.asset_id], |result| {
                    Ok((result.get(0)?, result.get(1)?))
                })
                .optional()
                .unwrap();
            match manual
                .as_ref()
                .map(|(value, at)| (value.as_str(), at.as_str()))
            {
                Some(("cleared", _)) | None => {}
                Some((value, at)) => {
                    if at > row.scored_at.as_str() {
                        if value == "accepted" {
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
            let stored: Option<(String, i64, i64)> = asset
                .query_row(params![row.asset_id, row.content_hash], |result| {
                    Ok((result.get(0)?, result.get(1)?, result.get(2)?))
                })
                .optional()
                .unwrap();
            let Some((original_name, width, height)) = stored else {
                continue;
            };
            let target = match targets.entry(row.target_id.clone()) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let info = match library.read_character_target(&connection, &row.target_id) {
                        Ok(target) => Some(TargetInfo {
                            name: target.display_name.clone(),
                            enabled: target.enabled,
                            fingerprint: target.fingerprint.clone(),
                            reference_asset_ids: target
                                .usable_references()
                                .filter_map(|reference| reference.asset_id.clone())
                                .collect(),
                        }),
                        Err(Error::NotFound) => None,
                        Err(error) => panic!("legacy target read failed: {error}"),
                    };
                    entry.insert(info)
                }
            };
            let Some(target) = target.as_ref().filter(|target| target.enabled) else {
                continue;
            };
            counts.pending += 1;
            if !doubtful {
                origin_counts.pending += 1;
            }
            page.items.push(ShadowReviewItem {
                asset_id: row.asset_id,
                content_hash: row.content_hash,
                original_name,
                width: u32::try_from(width).unwrap_or(0),
                height: u32::try_from(height).unwrap_or(0),
                target_id: row.target_id,
                target_name: target.name.clone(),
                target_fingerprint: target.fingerprint.clone(),
                reference_asset_ids: target.reference_asset_ids.iter().take(4).cloned().collect(),
                verdict: row.verdict,
                origin: row.origin,
                knn3: row.knn3,
                native_outcome: row.native_outcome,
                scored_at: row.scored_at,
            });
        }
        page
    }

    #[test]
    fn batched_shadow_review_matches_legacy_for_mixed_scopes_and_decisions() {
        let fixture = Fixture::new();
        let here = fixture.ready("Here");
        let there = fixture.ready_in_series("There", &fixture.child);
        let disabled = fixture.ready("Disabled");
        fixture
            .library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(disabled.id.clone()),
                expected_revision: Some(disabled.revision),
                series_classification_id: disabled.series_classification_id.clone(),
                linked_classification_id: disabled.linked_classification_id.clone(),
                display_name: disabled.display_name.clone(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: false,
            })
            .unwrap();
        for id in ["mixed-a", "mixed-b", "mixed-c", "mixed-d", "mixed-broad"] {
            series_asset(&fixture, id);
        }
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1)
                 WHERE asset_id='mixed-broad'",
                [&fixture.series],
            )
            .unwrap();
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='mixed-c'",
                [&fixture.child],
            )
            .unwrap();
        let scored_at = "2020-01-01T00:00:00Z";
        insert(
            fixture.temp.path(),
            &[
                (
                    "mixed-a",
                    &here.id,
                    "automatic",
                    0.1,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "mixed-b",
                    &here.id,
                    "recommended",
                    0.2,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "mixed-c",
                    &there.id,
                    "automatic",
                    0.1,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "mixed-d", &here.id, "none", 0.3, "mixed-v1", "none", scored_at,
                ),
                (
                    "mixed-broad",
                    &here.id,
                    "recommended",
                    0.2,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "asset-5",
                    &disabled.id,
                    "automatic",
                    0.1,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
            ],
        );
        let connection = fixture.library.connection().unwrap();
        for (asset_id, target_id) in [("mixed-a", &here.id), ("mixed-d", &here.id)] {
            connection
                .execute(
                    "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                     VALUES(?1,?2,?2,?3,'accepted','native','{}','automatic','2019-01-01T00:00:00Z')",
                    params![target_id, asset_id, content_hash(asset_id)],
                )
                .unwrap();
        }
        drop(connection);
        decide(&fixture, &here, "mixed-b", DecisionKind::Rejected);
        decide(&fixture, &there, "mixed-c", DecisionKind::Accepted);

        let assert_summary_matches = || {
            let expected = legacy_items(&fixture.library, None, None);
            let actual = fixture.library.character_shadow_review_summary().unwrap();
            assert_eq!(actual.automatic, expected.summary.automatic.pending);
            assert_eq!(actual.recommended, expected.summary.recommended.pending);
            let expected_targets = expected.items.iter().fold(
                BTreeMap::<String, (String, u32, u32)>::new(),
                |mut targets, item| {
                    let tally = targets.entry(item.target_id.clone()).or_insert((
                        item.target_name.clone(),
                        0,
                        0,
                    ));
                    if item.verdict == "automatic" {
                        tally.1 += 1;
                    } else {
                        tally.2 += 1;
                    }
                    targets
                },
            );
            assert_eq!(
                actual
                    .targets
                    .into_iter()
                    .map(|target| {
                        (
                            target.target_id,
                            (target.target_name, target.automatic, target.recommended),
                        )
                    })
                    .collect::<BTreeMap<_, _>>(),
                expected_targets
            );
        };
        assert_summary_matches();

        for (mode, series) in [
            (None, None),
            (None, Some(fixture.series.as_str())),
            (None, Some(fixture.child.as_str())),
            (Some("doubtful"), None),
            (Some("doubtful"), Some(fixture.series.as_str())),
        ] {
            assert_eq!(
                items_in(&fixture.library, mode, series),
                legacy_items(&fixture.library, mode, series),
                "mode={mode:?} series={series:?}"
            );
        }
        fixture
            .library
            .set_character_broad_folder_scope(true)
            .unwrap();
        assert_summary_matches();
        assert_eq!(
            items_in(&fixture.library, None, None),
            legacy_items(&fixture.library, None, None)
        );
    }

    #[test]
    fn character_shadow_review_hides_broad_folder_scores_while_the_rule_is_off() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        series_asset(&f, "inside");
        series_asset(&f, "broad");
        // "broad" is filed directly in the series' parent folder (no registered series above).
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1)
                 WHERE asset_id='broad'",
                [&f.series],
            )
            .unwrap();
        let rows: Vec<_> = ["inside", "broad"]
            .iter()
            .map(|id| {
                (
                    *id,
                    target.id.as_str(),
                    "recommended",
                    0.2,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                )
            })
            .collect();
        insert(f.temp.path(), &rows);
        let ids = |f: &Fixture| {
            let mut ids: Vec<_> = page(f, 0, 50)
                .items
                .into_iter()
                .map(|i| i.asset_id)
                .collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(&f), vec!["inside"]);
        assert_eq!(page(&f, 0, 50).summary.recommended.pending, 1);
        f.library.set_character_broad_folder_scope(true).unwrap();
        assert_eq!(ids(&f), vec!["broad", "inside"]);
        f.library.set_character_broad_folder_scope(false).unwrap();
        assert_eq!(ids(&f), vec!["inside"]);
    }

    #[test]
    fn character_shadow_review_missing_cache_is_empty() {
        let f = Fixture::new();
        let page = page(&f, 0, 50);
        assert!(page.items.is_empty());
        assert_eq!(page.policy_version, None);
        assert_eq!(page.summary, ShadowReviewSummary::default());
        assert!(!f
            .temp
            .path()
            .join(".cache/characters/s36_shadow.sqlite")
            .exists());
        assert!(f
            .library
            .character_shadow_review_page(ShadowReviewQuery {
                offset: 0,
                limit: 0,
                mode: None,
                series_id: None,
            })
            .is_err());
    }

    #[test]
    fn character_shadow_review_puts_already_classified_pairs_after_new_findings() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        let root = f.temp.path();
        for id in ["new-1", "new-2", "done-1", "done-2"] {
            series_asset(&f, id);
        }
        let rows: Vec<_> = ["done-1", "new-1", "done-2", "new-2"]
            .iter()
            .map(|id| {
                (
                    *id,
                    target.id.as_str(),
                    "automatic",
                    0.12,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                )
            })
            .collect();
        insert(root, &rows);
        let c = f.library.connection().unwrap();
        for id in ["done-1", "done-2"] {
            c.execute(
                "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                 VALUES(?1,?2,?2,?3,'accepted',?4,'{}','automatic','2026-09-20T00:00:00Z')",
                params![target.id, id, content_hash(id), target.fingerprint],
            )
            .unwrap();
        }
        drop(c);
        let items = page(&f, 0, 50).items;
        let order: Vec<_> = items.iter().map(|i| i.asset_id.as_str()).collect();
        assert_eq!(order.len(), 4);
        assert!(
            order[..2].iter().all(|id| id.starts_with("new-")),
            "{order:?}"
        );
        assert!(
            order[2..].iter().all(|id| id.starts_with("done-")),
            "{order:?}"
        );
        assert!(items[..2].iter().all(|i| i.native_outcome == "none"));
        assert!(items[2..]
            .iter()
            .all(|i| i.native_outcome == "accepted_automatic"));
        // Pagination follows the same order.
        assert_eq!(page(&f, 2, 1).items[0].asset_id, order[2]);
    }

    #[test]
    fn character_shadow_review_filters_orders_and_counts() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        let other = f.ready("Other");
        let disabled = f.ready("Disabled");
        f.library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(disabled.id.clone()),
                expected_revision: Some(disabled.revision),
                series_classification_id: disabled.series_classification_id.clone(),
                linked_classification_id: disabled.linked_classification_id.clone(),
                display_name: disabled.display_name.clone(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: false,
            })
            .unwrap();
        let root = f.temp.path();
        series_asset(&f, "asset-8");
        insert(
            root,
            &[
                (
                    "asset-5",
                    &target.id,
                    "recommended",
                    0.14,
                    "v1",
                    "recommended",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-8",
                    &target.id,
                    "automatic",
                    0.12,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-5",
                    &other.id,
                    "automatic",
                    0.10,
                    "v1",
                    "accepted_automatic",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-6",
                    &other.id,
                    "none",
                    0.30,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-5",
                    &disabled.id,
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-6",
                    "missing-target",
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-7",
                    &target.id,
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-0",
                    &target.id,
                    "automatic",
                    0.01,
                    "v0",
                    "none",
                    "2026-09-22T00:00:00Z",
                ),
            ],
        );
        // asset-7 does not exist; the other target's asset-5 row gets a stale hash.
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        c.execute(
            "UPDATE scores SET content_hash='f' WHERE asset_id='asset-5' AND target_id=?1",
            [&other.id],
        )
        .unwrap();
        drop(c);

        let first = page(&f, 0, 50);
        assert_eq!(first.policy_version.as_deref(), Some("v1"));
        let pairs: Vec<(&str, &str, &str)> = first
            .items
            .iter()
            .map(|i| {
                (
                    i.asset_id.as_str(),
                    i.target_id.as_str(),
                    i.verdict.as_str(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("asset-8", target.id.as_str(), "automatic"),
                ("asset-5", target.id.as_str(), "recommended"),
            ]
        );
        assert_eq!(first.items[0].target_name, "Shadow");
        assert_eq!(first.items[0].target_fingerprint, target.fingerprint);
        assert_eq!(first.items[0].reference_asset_ids.len(), 4);
        assert_eq!(first.items[0].knn3, Some(0.12));
        assert_eq!(first.items[0].native_outcome, "none");
        assert_eq!(first.items[0].original_name, "asset-8");
        assert_eq!((first.items[0].width, first.items[0].height), (3, 2));
        assert_eq!(first.next_offset, None);
        assert_eq!(
            first.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );
        assert_eq!(
            first.summary.recommended,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );

        // Pagination by offset over the pending list.
        let second = page(&f, 0, 1);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].asset_id, "asset-8");
        assert_eq!(second.next_offset, Some(1));
        assert_eq!(second.summary.automatic.pending, 1);
        let third = page(&f, 1, 1);
        assert_eq!(third.items[0].asset_id, "asset-5");
        assert_eq!(third.next_offset, None);

        // A manual decision after scoring removes the pair and counts as reviewed.
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-5", DecisionKind::Rejected);
        let reviewed = page(&f, 0, 50);
        assert!(reviewed.items.is_empty());
        assert_eq!(
            reviewed.summary.automatic,
            VerdictCounts {
                pending: 0,
                accepted: 1,
                rejected: 0
            }
        );
        assert_eq!(
            reviewed.summary.recommended,
            VerdictCounts {
                pending: 0,
                accepted: 0,
                rejected: 1
            }
        );

        // Clearing the decision returns the pair to the queue.
        decide(&f, &target, "asset-5", DecisionKind::Cleared);
        let cleared = page(&f, 0, 50);
        assert_eq!(cleared.items.len(), 1);
        assert_eq!(cleared.items[0].asset_id, "asset-5");
        assert_eq!(
            cleared.summary.recommended,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );

        // A decision made before the shadow row was scored neither pends nor counts.
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        c.execute(
            "UPDATE scores SET scored_at='2099-01-01T00:00:00Z' WHERE asset_id='asset-8' AND target_id=?1",
            [&target.id],
        )
        .unwrap();
        drop(c);
        let earlier = page(&f, 0, 50);
        assert_eq!(earlier.summary.automatic, VerdictCounts::default());
    }
    #[test]
    fn character_shadow_review_stable_shuffle_pages_and_origin_counts() {
        use sha2::{Digest, Sha256};
        let f = Fixture::new();
        let target = f.ready("Shuffle");
        for i in 8..20 {
            let id = format!("asset-{i}");
            series_asset(&f, &id);
            insert(
                f.temp.path(),
                &[(
                    &id,
                    &target.id,
                    if i < 17 { "automatic" } else { "recommended" },
                    i as f64 / 100.0,
                    "v1",
                    "none",
                    "2020-01-01T00:00:00Z",
                )],
            );
        }
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute(
                "UPDATE scores SET origin='backfill' WHERE asset_id IN ('asset-8','asset-18')",
                [],
            )
            .unwrap();
        let full = page(&f, 0, 50);
        let mut expected = (8..20).map(|i| format!("asset-{i}")).collect::<Vec<_>>();
        expected.sort_by_key(|id| {
            (
                id[6..].parse::<u32>().unwrap() >= 17,
                Sha256::digest(format!("v1|{id}|{}", target.id)).to_vec(),
            )
        });
        assert_eq!(
            full.items
                .iter()
                .map(|i| i.asset_id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        let parts = (0..4)
            .flat_map(|i| page(&f, i * 3, 3).items.into_iter().map(|row| row.asset_id))
            .collect::<Vec<_>>();
        assert_eq!(parts, expected);
        // Scores changing within their tier cannot change the review order.
        cache.execute("UPDATE scores SET knn3=1-knn3", []).unwrap();
        assert_eq!(
            page(&f, 0, 50)
                .items
                .iter()
                .map(|i| i.asset_id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(full.summary.by_origin["backfill"].automatic.pending, 1);
        assert_eq!(full.summary.by_origin["live"].automatic.pending, 8);
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-18", DecisionKind::Rejected);
        let reviewed = page(&f, 0, 50);
        assert_eq!(reviewed.summary.by_origin["backfill"].automatic.accepted, 1);
        assert_eq!(
            reviewed.summary.by_origin["backfill"].recommended.rejected,
            1
        );
        assert_eq!(reviewed.summary.by_origin["live"].automatic.accepted, 0);
    }
    #[test]
    fn character_shadow_review_legacy_origin_is_live_without_migration() {
        let f = Fixture::new();
        let target = f.ready("Legacy");
        insert(
            f.temp.path(),
            &[(
                "asset-5",
                &target.id,
                "automatic",
                0.1,
                "v1",
                "none",
                "2020-01-01T00:00:00Z",
            )],
        );
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute_batch("ALTER TABLE scores DROP COLUMN origin; PRAGMA user_version=0;")
            .unwrap();
        let page = page(&f, 0, 50);
        assert_eq!(page.items[0].origin, "live");
        assert_eq!(page.summary.by_origin["live"].automatic.pending, 1);
        assert!(!super::super::character_shadow::cache_has_origin(&cache).unwrap());
    }
    #[test]
    fn character_shadow_review_series_scope_filters_items_and_counts() {
        let f = Fixture::new();
        let here = f.ready("Here");
        // `child` stands in for a second S36 series.
        let there = f.ready_in_series("There", &f.child);
        for id in ["asset-8", "asset-9", "asset-10"] {
            series_asset(&f, id);
        }
        let at = "2026-09-23T01:00:00Z";
        insert(
            f.temp.path(),
            &[
                ("asset-8", &here.id, "automatic", 0.1, "v1", "none", at),
                ("asset-9", &here.id, "recommended", 0.2, "v1", "none", at),
                ("asset-10", &there.id, "automatic", 0.1, "v1", "none", at),
                ("asset-1", &there.id, "automatic", 0.1, "v1", "none", at),
            ],
        );
        // asset-1 is inside the nested series, so it can be judged there.
        decide(&f, &there, "asset-1", DecisionKind::Rejected);
        let scoped = |series: Option<&str>, mode: Option<&str>| {
            f.library
                .character_shadow_review_page(ShadowReviewQuery {
                    offset: 0,
                    limit: 50,
                    mode: mode.map(Into::into),
                    series_id: series.map(Into::into),
                })
                .unwrap()
        };
        let pairs = |page: &ShadowReviewPage| {
            let mut pairs: Vec<_> = page
                .items
                .iter()
                .map(|i| (i.asset_id.clone(), i.target_id.clone()))
                .collect();
            pairs.sort();
            pairs
        };

        // No scope: the unchanged all-series list and counts.
        let all = scoped(None, None);
        assert_eq!(all.items.len(), 3);
        assert_eq!(all.summary.automatic.pending, 2);
        assert_eq!(all.summary.automatic.rejected, 1);
        assert_eq!(all.summary.recommended.pending, 1);
        assert_eq!(all.summary, page(&f, 0, 50).summary);

        let here_page = scoped(Some(&f.series), None);
        assert_eq!(
            pairs(&here_page),
            vec![
                ("asset-8".to_string(), here.id.clone()),
                ("asset-9".to_string(), here.id.clone()),
            ]
        );
        assert_eq!(
            here_page.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );
        assert_eq!(here_page.summary.recommended.pending, 1);
        assert_eq!(here_page.summary.by_origin["live"].automatic.pending, 1);
        assert_eq!(here_page.policy_version.as_deref(), Some("v1"));

        let there_page = scoped(Some(&f.child), None);
        assert_eq!(
            pairs(&there_page),
            vec![("asset-10".to_string(), there.id.clone())]
        );
        assert_eq!(
            there_page.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 1
            }
        );
        assert_eq!(there_page.summary.recommended, VerdictCounts::default());

        // Paging stays inside the scope.
        let first = f
            .library
            .character_shadow_review_page(ShadowReviewQuery {
                offset: 0,
                limit: 1,
                mode: None,
                series_id: Some(f.series.clone()),
            })
            .unwrap();
        assert_eq!(first.next_offset, Some(1));
        assert_eq!(first.items[0].target_id, here.id);

        // A series without characters has nothing pending; the doubtful list scopes too.
        assert!(scoped(Some(&f.outside), None).items.is_empty());
        assert_eq!(
            scoped(Some(&f.outside), None).summary,
            ShadowReviewSummary::default()
        );
        assert!(scoped(Some(&f.series), Some("doubtful")).items.is_empty());
    }
    #[test]
    fn s36_readiness_status_thresholds() {
        assert_eq!(readiness_status(30, 1, 50), "ready");
        assert_eq!(readiness_status(29, 0, 80), "collecting");
        assert_eq!(readiness_status(40, 0, 49), "collecting");
        assert_eq!(readiness_status(12, 2, 80), "hold");
        assert_eq!(readiness_status(30, 4, 80), "keep");
    }

    fn review_query(offset: u32, limit: u32, series_id: Option<&str>) -> ShadowReviewQuery {
        ShadowReviewQuery {
            offset,
            limit,
            mode: None,
            series_id: series_id.map(Into::into),
        }
    }

    fn prepared_lists(f: &Fixture) -> usize {
        f.library
            .character_changes
            .shadow_review
            .prepared_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The cached page, after checking it against the page computed from scratch.
    fn checked_page(f: &Fixture, query: impl Fn() -> ShadowReviewQuery) -> serde_json::Value {
        let cached =
            serde_json::to_value(f.library.character_shadow_review_page(query()).unwrap()).unwrap();
        let fresh = serde_json::to_value(
            f.library
                .character_shadow_review_page_uncached(query())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cached, fresh);
        cached
    }

    /// A ready character with five scored series images.
    fn cached_review_fixture() -> (Fixture, Target) {
        let f = Fixture::new();
        let target = f.ready("Cached");
        let at = "2026-09-23T01:00:00Z";
        let ids: Vec<String> = (0..5).map(|i| format!("cached-{i}")).collect();
        for id in &ids {
            series_asset(&f, id);
        }
        let rows: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let verdict = if i % 2 == 0 {
                    "automatic"
                } else {
                    "recommended"
                };
                (
                    id.as_str(),
                    target.id.as_str(),
                    verdict,
                    0.1,
                    "v1",
                    "none",
                    at,
                )
            })
            .collect();
        insert(f.temp.path(), &rows);
        (f, target)
    }

    #[test]
    fn character_shadow_review_pages_slice_one_cached_list() {
        let (f, _) = cached_review_fixture();
        let whole = checked_page(&f, || review_query(0, 50, None));
        assert_eq!(whole["items"].as_array().unwrap().len(), 5);
        assert_eq!(prepared_lists(&f), 1);
        let mut sliced = Vec::new();
        for offset in [0, 2, 4] {
            let page = checked_page(&f, || review_query(offset, 2, None));
            assert_eq!(page["summary"], whole["summary"]);
            assert_eq!(page["policyVersion"], whole["policyVersion"]);
            sliced.extend(page["items"].as_array().unwrap().iter().cloned());
        }
        assert_eq!(&sliced, whole["items"].as_array().unwrap());
        // Every page, and the same page again, came from the one computation.
        assert_eq!(prepared_lists(&f), 1);
        let series = f.series.clone();
        checked_page(&f, || review_query(0, 1, Some(&series)));
        checked_page(&f, || review_query(1, 1, Some(&series)));
        assert_eq!(prepared_lists(&f), 2, "one list per series scope");
        let doubtful = || ShadowReviewQuery {
            mode: Some("doubtful".into()),
            ..review_query(0, 50, None)
        };
        checked_page(&f, doubtful);
        checked_page(&f, doubtful);
        assert_eq!(prepared_lists(&f), 3, "one list per mode");
    }

    #[test]
    fn character_shadow_review_cache_follows_every_input() {
        let (f, target) = cached_review_fixture();
        let series = f.series.clone();
        let all = || review_query(0, 50, None);
        let scoped = || review_query(0, 50, Some(&series));
        let count = |page: &serde_json::Value| page["items"].as_array().unwrap().len();
        // Each change recomputes the list once, and the result matches a fresh computation.
        let mut expected = 0;
        let mut step = |label: &str, change: &dyn Fn()| -> serde_json::Value {
            change();
            let page = checked_page(&f, all);
            expected += 1;
            assert_eq!(prepared_lists(&f), expected, "{label}");
            // Unchanged inputs: served from the cache.
            assert_eq!(checked_page(&f, all), page, "{label}");
            assert_eq!(prepared_lists(&f), expected, "{label} (repeat)");
            page
        };
        assert_eq!(count(&step("first read", &|| ())), 5);

        let page = step("manual decision", &|| {
            decide(&f, &target, "cached-0", DecisionKind::Accepted)
        });
        assert_eq!(count(&page), 4);

        let page = step("rejection", &|| {
            decide(&f, &target, "cached-1", DecisionKind::Rejected)
        });
        assert_eq!(count(&page), 3);

        let page = step("Asset moved to the trash", &|| {
            f.library
                .connection()
                .unwrap()
                .execute("UPDATE assets SET status='trash' WHERE id='cached-2'", [])
                .unwrap();
        });
        assert_eq!(count(&page), 2);

        let page = step("Asset filed outside every series", &|| {
            f.library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='cached-3'",
                    [&f.outside],
                )
                .unwrap();
        });
        assert_eq!(count(&page), 1);

        let page = step("broad-folder rule on", &|| {
            f.library.set_character_broad_folder_scope(true).unwrap()
        });
        assert_eq!(count(&page), 2);

        let page = step("S36 shadow cache rewritten", &|| {
            series_asset(&f, "cached-5");
            insert(
                f.temp.path(),
                &[(
                    "cached-5",
                    target.id.as_str(),
                    "automatic",
                    0.1,
                    "v1",
                    "none",
                    "2026-09-23T02:00:00Z",
                )],
            );
        });
        assert_eq!(count(&page), 3);

        // Series membership: the series-scoped list follows the character out of the series.
        assert_eq!(count(&checked_page(&f, scoped)), 3);
        expected += 1;
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE character_targets SET series_classification_id=?1 WHERE id=?2",
                [&f.child, &target.id],
            )
            .unwrap();
        assert_eq!(count(&checked_page(&f, scoped)), 0);
        expected += 1;
        assert_eq!(prepared_lists(&f), expected);
    }

    #[test]
    fn character_shadow_review_cache_reads_characters_on_every_call() {
        let (f, target) = cached_review_fixture();
        let all = || review_query(0, 50, None);
        let before = checked_page(&f, all);
        let references = before["items"][0]["referenceAssetIds"].clone();
        assert!(!references.as_array().unwrap().is_empty());
        // A reference original disappears: no library table changes, yet the items follow.
        let removed = references[0].as_str().unwrap();
        std::fs::remove_file(f.temp.path().join(format!("assets/{removed}.png"))).unwrap();
        let after = checked_page(&f, all);
        assert_ne!(after["items"][0]["referenceAssetIds"], references);
        assert_eq!(prepared_lists(&f), 1);
        // Disabling the character empties the list and its pending counts.
        let current = f.library.list_character_targets().unwrap();
        let current = current.iter().find(|t| t.id == target.id).unwrap();
        f.library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(current.id.clone()),
                expected_revision: Some(current.revision),
                series_classification_id: current.series_classification_id.clone(),
                linked_classification_id: current.linked_classification_id.clone(),
                display_name: current.display_name.clone(),
                description: current.description.clone(),
                thumbnail_asset_id: current.thumbnail_asset_id.clone(),
                enabled: false,
            })
            .unwrap();
        let disabled = checked_page(&f, all);
        assert_eq!(disabled["items"].as_array().unwrap().len(), 0);
        assert_eq!(disabled["summary"]["automatic"]["pending"], 0);
    }

    #[test]
    fn character_shadow_review_concurrent_requests_compute_once() {
        let (f, _) = cached_review_fixture();
        let barrier = std::sync::Barrier::new(8);
        let pages = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let (library, barrier) = (&f.library, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        serde_json::to_value(
                            library
                                .character_shadow_review_page(review_query(i % 3, 2, None))
                                .unwrap(),
                        )
                        .unwrap()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(prepared_lists(&f), 1);
        for (i, page) in pages.iter().enumerate() {
            let fresh = f
                .library
                .character_shadow_review_page_uncached(review_query(i as u32 % 3, 2, None))
                .unwrap();
            assert_eq!(page, &serde_json::to_value(fresh).unwrap());
        }
    }

    #[test]
    fn s36_readiness_counts_judged_automatic_candidates() {
        let (f, target) = cached_review_fixture();
        decide(&f, &target, "cached-0", DecisionKind::Accepted);
        decide(&f, &target, "cached-2", DecisionKind::Rejected);
        decide(&f, &target, "cached-1", DecisionKind::Rejected); // recommended: not counted
        decide(&f, &target, "cached-4", DecisionKind::Accepted);
        decide(&f, &target, "cached-4", DecisionKind::Cleared);
        let readiness = f.library.character_s36_readiness(&f.series).unwrap();
        let row = readiness.iter().find(|r| r.target_id == target.id).unwrap();
        assert_eq!((row.reviewed, row.wrong), (2, 1));
        assert_eq!(row.examples, 1);
    }
}
