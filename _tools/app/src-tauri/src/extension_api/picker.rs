//! Read-only image picker routes for the Arca Live panel (`COLLECTOR-PICKER-001`).
//!
//! Four routes behind the same bearer token and extension-origin checks as the rest of the
//! service: the folder tree with eligible image counts, a random batch of thumbnails from
//! one folder, one thumbnail, and (only after the user presses "본문에 넣기") one original.
//!
//! Besides folders the panel can draw from a character or a character group (a group is its
//! characters plus its own 기타 bucket). `/folders` lists them under `characters`, and a batch
//! takes `{"scope": {"kind": "character"|"group", "id": ...}}` instead of `folderId`; their
//! membership is the PC's own (`unit_members`).
//!
//! Eligibility is decided here and nowhere else (`eligibility_sql`): a normal-status image or
//! GIF row of the main library. The Private Vault (plain folder index and encrypted store) is
//! a separate store whose items are never rows of `assets`, so the picker cannot reach them.
//! Privacy mode and the NSFW filter live only in the PC window's saved UI preferences; the
//! backend asks the window for them (`PrivacyGate`) and refuses (423) when it cannot know.
//!
//! Reads go through `Library::read_without_lock`, so a long picker query never holds the
//! app's `database_lock`. Filesystem paths never leave this module.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    sync::{Condvar, Mutex, PoisonError},
    time::{Duration, Instant},
};

use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::{cors_headers, ApiError, ApiRequest, ApiResponse};
use crate::library::{auto_tags::CONTENT_RATING_SQL, error::LibraryError, Library};

/// 2000 ids of up to 64 characters plus JSON punctuation.
pub(super) const MAX_BATCH_JSON_BYTES: usize = 256 * 1024;
const DEFAULT_BATCH: u32 = 18;
const MAX_BATCH: u32 = 24;
const MAX_EXCLUDED: usize = 2000;
pub(super) const MAX_ORIGINAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 8 * 1024 * 1024;
const THUMBNAIL_PREFIX: &str = "/v1/picker/thumbnail/";
const ORIGINAL_PREFIX: &str = "/v1/picker/original/";
/// SQLite variables per statement stay far below the library's limit.
const SQL_CHUNK: usize = 500;
const THUMBNAIL_CACHE: &str = "private, max-age=300";

/// The PC window's current privacy settings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Privacy {
    /// Everything is masked in the app; the picker serves nothing.
    pub(crate) privacy_mode: bool,
    /// Only media rated `g` is shown; unknown ratings stay hidden (same rule as the app).
    pub(crate) nsfw_filter: bool,
}

/// Fresh enough for one panel interaction (a batch plus its 18 thumbnails).
const PRIVACY_FRESH: Duration = Duration::from_millis(1000);
const PRIVACY_WAIT: Duration = Duration::from_millis(1500);

/// Presentation preferences reported with the privacy answer by the PC window.
#[derive(Debug, Clone, Default)]
pub(super) struct PickerContext {
    pub(super) privacy: Privacy,
    pub(super) order_ids: Vec<String>,
    pub(super) pinned_ids: Vec<String>,
}

impl From<Privacy> for PickerContext {
    fn from(privacy: Privacy) -> Self {
        Self { privacy, ..Self::default() }
    }
}

#[derive(Default)]
struct GateState {
    latest: Option<(PickerContext, Instant)>,
    pending: Option<String>,
}

/// Brings the PC window's saved privacy settings to the extension service thread. The page
/// answers a one-time nonce through the `report_picker_privacy` command; any other report is
/// ignored. No answer in time means "unknown", which the routes treat as locked.
#[derive(Default)]
pub(crate) struct PrivacyGate {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl PrivacyGate {
    /// Accepts the page's answer to the pending request only.
    #[cfg(test)]
    pub(crate) fn report(&self, nonce: &str, privacy: Privacy) -> bool {
        self.report_context(nonce, privacy.into())
    }

    pub(super) fn report_context(&self, nonce: &str, context: PickerContext) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.pending.as_deref() != Some(nonce) {
            return false;
        }
        state.pending = None;
        state.latest = Some((context, Instant::now()));
        self.changed.notify_all();
        true
    }

    /// The last answer when it is fresh, otherwise a new one: `ask` receives the nonce and
    /// must hand it to the page (returning false when it could not). Concurrent callers share
    /// one question.
    #[cfg(test)]
    fn read(
        &self,
        ask: impl Fn(&str) -> bool,
        fresh_for: Duration,
        wait: Duration,
    ) -> Result<Privacy, ApiError> {
        self.read_context(ask, fresh_for, wait).map(|context| context.privacy)
    }

    fn read_context(
        &self,
        ask: impl Fn(&str) -> bool,
        fresh_for: Duration,
        wait: Duration,
    ) -> Result<PickerContext, ApiError> {
        let started = Instant::now();
        let deadline = started + wait;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some((context, at)) = &state.latest {
                if at.elapsed() < fresh_for || *at >= started {
                    return Ok(context.clone());
                }
            }
            if state.pending.is_none() {
                let nonce = Uuid::new_v4().simple().to_string();
                state.pending = Some(nonce.clone());
                drop(state);
                let sent = ask(&nonce);
                state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                if !sent {
                    if state.pending.as_deref() == Some(nonce.as_str()) {
                        state.pending = None;
                    }
                    return Err(ApiError::PickerPrivacyUnavailable);
                }
                continue;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.pending = None;
                return Err(ApiError::PickerPrivacyUnavailable);
            }
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

/// Reads the saved UI preferences in the main window (`lakomics.uiPreferences.v1`). A missing
/// window, a page that does not answer, or unreadable storage is "unknown".
pub(super) fn read_context(
    app: &AppHandle,
    gate: &PrivacyGate,
    library: Option<&Library>,
    folders_requested: bool,
) -> Result<PickerContext, ApiError> {
    // buildTree uses localeCompare("ko") for unranked folders. Resolve that fallback
    // in the same PC WebView instead of approximating its collation in SQLite.
    gate.read_context(
        |nonce| {
            let folders = if !folders_requested {
                Some(Vec::new())
            } else {
                library.and_then(|library| {
                    library
                        .read_without_lock(|connection| {
                            let mut statement =
                                connection.prepare("SELECT id,name FROM classification_entries")?;
                            let rows = statement
                                .query_map([], |row| {
                                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                                })?
                                .collect::<Result<Vec<_>, _>>()?;
                            Ok(rows)
                        })
                        .ok()
                })
            };
            let Some(folders) = folders else {
                return false;
            };
            app.get_webview_window("main")
                .is_some_and(|window| window.eval(privacy_probe_script(nonce, &folders)).is_ok())
        },
        if folders_requested {
            Duration::ZERO
        } else {
            PRIVACY_FRESH
        },
        PRIVACY_WAIT,
    )
}

fn privacy_probe_script(nonce: &str, folders: &[(String, String)]) -> String {
    let folders = serde_json::to_string(folders).expect("folder names serialize");
    format!(
        "(function(){{var p=false,n=false,v={{}},o=[],pins=[];try{{v=JSON.parse(window.localStorage.getItem('lakomics.uiPreferences.v1')||'{{}}');if(v&&typeof v==='object'){{p=v.privacyMode===true;n=v.nsfwFilter===true;}}}}catch(e){{return;}}try{{v=v&&typeof v==='object'?v:{{}};var ids=Array.isArray(v.classificationOrderIds)?v.classificationOrderIds:[],rank=new Map(ids.map((id,i)=>[id,i]));o={folders}.sort((a,b)=>(rank.get(a[0])??Number.MAX_SAFE_INTEGER)-(rank.get(b[0])??Number.MAX_SAFE_INTEGER)||a[1].localeCompare(b[1],'ko')).map(a=>a[0]);pins=Array.isArray(v.pinnedClassificationIds)?v.pinnedClassificationIds.filter(id=>typeof id==='string'):[];}}catch(e){{o=[];pins=[];}}try{{window.__TAURI_INTERNALS__.invoke('report_picker_privacy',{{nonce:'{nonce}',privacyMode:p,nsfwFilter:n,orderIds:o,pinnedIds:pins}});}}catch(e){{}}}})();"
    )
}

/// Errors of picker routes are never cached.
pub(super) fn cache_headers(response: &mut ApiResponse) {
    response.headers.push(("Cache-Control", "no-store".into()));
}

pub(super) fn dispatch(
    request: &ApiRequest,
    library: &Library,
    context: PickerContext,
) -> Result<ApiResponse, ApiError> {
    let privacy = context.privacy;
    if privacy.privacy_mode {
        return Err(ApiError::PickerLibraryLocked);
    }
    let path = request.path.as_str();
    match request.method.as_str() {
        "GET" if path == "/v1/picker/folders" => folders(library, privacy, &context),
        "GET" if path.starts_with(THUMBNAIL_PREFIX) => {
            thumbnail(library, privacy, &path[THUMBNAIL_PREFIX.len()..])
        }
        "GET" if path.starts_with(ORIGINAL_PREFIX) => {
            original(library, privacy, &path[ORIGINAL_PREFIX.len()..])
        }
        "POST" if path == "/v1/picker/batch" => {
            batch(library, privacy, &request.body, random_seed())
        }
        _ => Err(ApiError::NotFound),
    }
}

/// The only eligibility rule: a normal-status image or GIF of the main library, and under the
/// NSFW filter one rated `g`. Files are checked when an item is served.
fn eligibility_sql(privacy: Privacy) -> String {
    let mut sql = "asset.status = 'normal' AND asset.media_kind IN ('image', 'gif')".to_owned();
    if privacy.nsfw_filter {
        sql.push_str(&format!(" AND ({CONTENT_RATING_SQL}) = 'g'"));
    }
    sql
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(",")
}

fn internal(_: LibraryError) -> ApiError {
    ApiError::Internal
}

fn json_response<T: Serialize>(value: &T) -> ApiResponse {
    let mut response = ApiResponse::json(200, value);
    cache_headers(&mut response);
    response
}

// ---------------------------------------------------------------- folders

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    id: String,
    parent_id: Option<String>,
    name: String,
    path: Vec<String>,
    image_count: u64,
    image_count_with_descendants: u64,
    order: usize,
    pinned: bool,
    pin_order: Option<usize>,
}

/// A character or a character group the panel can pick from, next to the folders.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CharacterEntry {
    kind: &'static str,
    order: usize,
    id: String,
    name: String,
    series_id: String,
    series_path: Vec<String>,
    group_id: Option<String>,
    image_count: u64,
}

#[derive(Serialize)]
struct FoldersResponse {
    entries: Vec<FolderEntry>,
    characters: Vec<CharacterEntry>,
}

// ------------------------------------------------------- character membership

/// Every enabled character and every group, as `(kind, unit id, target id, series id)`. A
/// group is its enabled characters plus its own 기타 bucket (a target with role `extras`
/// and `extras_group_id` = the group); a series-level 기타 belongs to no unit.
const ALL_UNITS_SQL: &str = "
    SELECT 'character' AS unit_kind, t.id AS unit_id, t.id AS target_id,
           t.series_classification_id AS series_id
    FROM character_targets AS t
    WHERE t.role='character' AND t.enabled=1 AND t.series_classification_id IS NOT NULL
    UNION ALL
    SELECT 'group', g.id, gm.target_id, g.series_id
    FROM character_groups AS g
    CROSS JOIN character_group_members AS gm ON gm.group_id=g.id
    CROSS JOIN character_targets AS t ON t.id=gm.target_id
    WHERE (t.role='character' AND t.enabled=1) OR (t.role='extras' AND t.extras_group_id=g.id)";

/// One character (`?1`).
const CHARACTER_UNIT_SQL: &str = "
    SELECT 'character' AS unit_kind, t.id AS unit_id, t.id AS target_id,
           t.series_classification_id AS series_id
    FROM character_targets AS t
    WHERE t.id=?1 AND t.role='character' AND t.enabled=1
      AND t.series_classification_id IS NOT NULL";

/// One group (`?1`).
const GROUP_UNIT_SQL: &str = "
    SELECT 'group' AS unit_kind, g.id AS unit_id, gm.target_id AS target_id,
           g.series_id AS series_id
    FROM character_groups AS g
    CROSS JOIN character_group_members AS gm ON gm.group_id=g.id
    CROSS JOIN character_targets AS t ON t.id=gm.target_id
    WHERE g.id=?1
      AND ((t.role='character' AND t.enabled=1) OR (t.role='extras' AND t.extras_group_id=g.id))";

/// The classification folders of a library, to decide which folders lie inside a series.
struct FolderGraph {
    parent: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
}

/// A series folder's subtree and the folders above it (the series itself is in both).
struct SeriesScope {
    inside: HashSet<String>,
    above: HashSet<String>,
}

impl FolderGraph {
    fn new(rows: impl IntoIterator<Item = (String, Option<String>)>) -> Self {
        let mut graph = FolderGraph {
            parent: HashMap::new(),
            children: HashMap::new(),
        };
        for (id, parent) in rows {
            if let Some(parent) = parent {
                graph
                    .children
                    .entry(parent.clone())
                    .or_default()
                    .push(id.clone());
                graph.parent.insert(id, parent);
            }
        }
        graph
    }

    fn scope(&self, series: &str) -> SeriesScope {
        let mut inside = HashSet::from([series.to_owned()]);
        let mut queue = vec![series.to_owned()];
        while let Some(folder) = queue.pop() {
            for child in self.children.get(&folder).into_iter().flatten() {
                if inside.insert(child.clone()) {
                    queue.push(child.clone());
                }
            }
        }
        let mut above = HashSet::from([series.to_owned()]);
        let mut current = series;
        while let Some(parent) = self.parent.get(current) {
            if !above.insert(parent.clone()) {
                break;
            }
            current = parent;
        }
        SeriesScope { inside, above }
    }
}

/// Eligible images of the chosen units, once per unit: `members` holds `(index into units,
/// asset rowid)`.
struct UnitMembers {
    /// `(unit kind, unit id)`.
    units: Vec<(String, String)>,
    members: HashSet<(usize, i64)>,
}

fn text<'a>(row: &'a rusqlite::Row<'_>, column: usize) -> rusqlite::Result<&'a str> {
    row.get_ref(column)?.as_str().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// Membership is what the PC's character folders show (`SIDEBAR_COUNTS_SQL` and
/// `TARGET_GALLERY_SQL` in `library/character_hub.rs`): the current acceptances of
/// `character_relations` (manual and automatic; the last decision per image wins, so a later
/// rejection or removal drops it) plus the character's own references and learned
/// references, restricted to normal images that sit in the series folder's subtree, or that
/// were accepted from a folder above the series. The SQL joins the memberships, the asset
/// and its folder links (`CROSS JOIN` keeps the chosen units as the driver); the folder test
/// is done here against [`FolderGraph`] because a recursive folder scope inside a correlated
/// subquery is rebuilt per image by SQLite (about 100 us each).
fn unit_members(
    connection: &Connection,
    graph: &FolderGraph,
    units: &str,
    eligible: &str,
    unit_id: Option<&str>,
) -> Result<UnitMembers, LibraryError> {
    let mut statement = connection.prepare(&format!(
        "WITH chosen(unit_kind, unit_id, target_id, series_id) AS ({units}),
         members(unit_kind, unit_id, series_id, asset_id, accepted) AS (
             SELECT c.unit_kind, c.unit_id, c.series_id, r.asset_id, 1
             FROM chosen c CROSS JOIN character_relations r ON r.target_id=c.target_id
             UNION ALL
             SELECT c.unit_kind, c.unit_id, c.series_id, r.asset_id, 0
             FROM chosen c CROSS JOIN character_references r ON r.target_id=c.target_id
             WHERE r.asset_id IS NOT NULL
             UNION ALL
             SELECT c.unit_kind, c.unit_id, c.series_id, r.asset_id, 0
             FROM chosen c CROSS JOIN character_learned_references r ON r.target_id=c.target_id
         ),
         unit_assets(unit_kind, unit_id, series_id, asset_id, accepted) AS (
             SELECT unit_kind, unit_id, series_id, asset_id, MAX(accepted)
             FROM members GROUP BY unit_kind, unit_id, series_id, asset_id
         )
         SELECT u.unit_kind, u.unit_id, u.series_id, u.accepted, asset.rowid, link.classification_id
         FROM unit_assets AS u
         CROSS JOIN assets AS asset ON asset.id=u.asset_id
         CROSS JOIN asset_classifications AS link ON link.asset_id=asset.id
         WHERE {eligible}"
    ))?;
    // Rows of one unit and one series arrive together, so the lookups below run on changes only.
    let mut result = UnitMembers {
        units: Vec::new(),
        members: HashSet::new(),
    };
    let mut unit_slots = HashMap::<(String, String), usize>::new();
    let mut scopes = Vec::<SeriesScope>::new();
    let mut scope_slots = HashMap::<String, usize>::new();
    let (mut unit, mut unit_slot) = ((String::new(), String::new()), usize::MAX);
    let (mut series, mut scope_slot) = (String::new(), usize::MAX);
    let mut rows = statement.query(params_from_iter(unit_id.iter()))?;
    while let Some(row) = rows.next()? {
        let (kind, id) = (text(row, 0)?, text(row, 1)?);
        if unit_slot == usize::MAX || kind != unit.0 || id != unit.1 {
            unit = (kind.to_owned(), id.to_owned());
            unit_slot = *unit_slots.entry(unit.clone()).or_insert_with(|| {
                result.units.push(unit.clone());
                result.units.len() - 1
            });
        }
        let row_series = text(row, 2)?;
        if scope_slot == usize::MAX || row_series != series {
            series = row_series.to_owned();
            scope_slot = *scope_slots.entry(series.clone()).or_insert_with(|| {
                scopes.push(graph.scope(&series));
                scopes.len() - 1
            });
        }
        let scope = &scopes[scope_slot];
        let folder = text(row, 5)?;
        if scope.inside.contains(folder)
            || (row.get::<_, i64>(3)? == 1 && scope.above.contains(folder))
        {
            result.members.insert((unit_slot, row.get(4)?));
        }
    }
    Ok(result)
}

fn folders(library: &Library, privacy: Privacy, context: &PickerContext) -> Result<ApiResponse, ApiError> {
    let eligible = eligibility_sql(privacy);
    let (mut entries, direct, multi_linked, units, unit_counts) = library
        .read_without_lock(|connection| {
            let snapshot = connection.unchecked_transaction()?;
            let mut statement = snapshot.prepare(
                "SELECT id, parent_id, name FROM classification_entries
                 ORDER BY parent_id, name COLLATE NOCASE, id",
            )?;
            let entries = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);

            let mut direct = HashMap::<String, u64>::new();
            let mut statement = snapshot.prepare(&format!(
                "SELECT link.classification_id, COUNT(*)
                 FROM asset_classifications AS link
                 CROSS JOIN assets AS asset ON asset.id = link.asset_id
                 WHERE {eligible}
                 GROUP BY link.classification_id"
            ))?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                direct.insert(row.get(0)?, row.get::<_, i64>(1)?.max(0) as u64);
            }
            drop(rows);
            drop(statement);

            // Eligible images that sit in several folders, to count each once per ancestor.
            let mut statement = snapshot.prepare(&format!(
                "SELECT link.asset_id, link.classification_id
                 FROM (
                     SELECT asset_id FROM asset_classifications
                     GROUP BY asset_id HAVING COUNT(*) > 1
                 ) AS multi
                 CROSS JOIN asset_classifications AS link ON link.asset_id = multi.asset_id
                 CROSS JOIN assets AS asset ON asset.id = link.asset_id
                 WHERE {eligible}
                 ORDER BY link.asset_id"
            ))?;
            let multi_linked = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);

            // Enabled characters and groups with their eligible image counts: one query for
            // the names, one grouped query for the counts.
            let mut statement = snapshot.prepare(
                "SELECT kind,id,name,series_id,group_id FROM (
                 SELECT 'group' AS kind, g.id, g.name, g.series_id, NULL AS group_id,
                        g.position, 0 AS kind_rank
                 FROM character_groups AS g
                 UNION ALL
                 SELECT 'character', t.id, t.display_name, t.series_classification_id, gm.group_id,
                        o.position, 1
                 FROM character_targets AS t
                 JOIN character_folder_order AS o ON o.target_id=t.id
                 LEFT JOIN character_group_members AS gm ON gm.target_id=t.id
                 WHERE t.role='character' AND t.enabled=1
                   AND t.series_classification_id IS NOT NULL)
                 ORDER BY kind_rank,series_id,position IS NULL,position,
                          CASE WHEN kind='group' THEN name END,id",
            )?;
            let units = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let graph = FolderGraph::new(
                entries
                    .iter()
                    .map(|(id, parent, _)| (id.clone(), parent.clone())),
            );
            let mut unit_counts = HashMap::<(String, String), u64>::new();
            let found = unit_members(&snapshot, &graph, ALL_UNITS_SQL, &eligible, None)?;
            for (slot, _) in &found.members {
                *unit_counts.entry(found.units[*slot].clone()).or_default() += 1;
            }
            Ok((entries, direct, multi_linked, units, unit_counts))
        })
        .map_err(internal)?;

    let ranks: HashMap<&str, usize> = context.order_ids.iter().enumerate()
        .map(|(rank, id)| (id.as_str(), rank)).collect();
    // Stable fallback for folders created after the window's snapshot.
    entries.sort_by_key(|(id, _, _)| ranks.get(id.as_str()).copied().unwrap_or(usize::MAX));
    let pins: HashMap<&str, usize> = context.pinned_ids.iter().enumerate().rev()
        .map(|(rank, id)| (id.as_str(), rank)).collect();
    let index: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(position, (id, _, _))| (id.as_str(), position))
        .collect();
    let parents: Vec<Option<usize>> = entries
        .iter()
        .map(|(_, parent, _)| parent.as_deref().and_then(|id| index.get(id).copied()))
        .collect();
    // Self first, then each ancestor once; a corrupt parent cycle stops at a repeat.
    let lineage = |position: usize| {
        let mut chain = vec![position];
        let mut current = parents[position];
        while let Some(parent) = current {
            if chain.contains(&parent) {
                break;
            }
            chain.push(parent);
            current = parents[parent];
        }
        chain
    };
    let direct_counts: Vec<u64> = entries
        .iter()
        .map(|(id, _, _)| direct.get(id).copied().unwrap_or(0))
        .collect();
    let mut totals = vec![0u64; entries.len()];
    for (position, count) in direct_counts.iter().enumerate() {
        if *count > 0 {
            for ancestor in lineage(position) {
                totals[ancestor] += count;
            }
        }
    }
    let mut hits = HashMap::<usize, u64>::new();
    let mut current_asset: Option<&str> = None;
    let settle = |hits: &mut HashMap<usize, u64>, totals: &mut Vec<u64>| {
        for (ancestor, count) in hits.drain() {
            if count > 1 {
                totals[ancestor] = totals[ancestor].saturating_sub(count - 1);
            }
        }
    };
    for (asset_id, classification_id) in &multi_linked {
        if current_asset != Some(asset_id.as_str()) {
            settle(&mut hits, &mut totals);
            current_asset = Some(asset_id.as_str());
        }
        if let Some(&position) = index.get(classification_id.as_str()) {
            for ancestor in lineage(position) {
                *hits.entry(ancestor).or_default() += 1;
            }
        }
    }
    settle(&mut hits, &mut totals);

    let mut characters = Vec::<CharacterEntry>::new();
    for (kind, id, name, series_id, group_id) in units {
        // A series folder that is gone (corrupt link) leaves nothing to nest the entry under.
        let Some(&series) = index.get(series_id.as_str()) else {
            continue;
        };
        let mut series_path: Vec<String> = lineage(series)
            .into_iter()
            .map(|ancestor| entries[ancestor].2.clone())
            .collect();
        series_path.reverse();
        let kind = if kind == "group" {
            "group"
        } else {
            "character"
        };
        let image_count = unit_counts
            .get(&(kind.to_owned(), id.clone()))
            .copied()
            .unwrap_or(0);
        characters.push(CharacterEntry {
            order: characters.len(),
            kind,
            id,
            name,
            series_id,
            series_path,
            group_id,
            image_count,
        });
    }
    let response = FoldersResponse {
        characters,
        entries: entries
            .iter()
            .enumerate()
            .map(|(position, (id, parent_id, name))| {
                let mut path: Vec<String> = lineage(position)
                    .into_iter()
                    .map(|ancestor| entries[ancestor].2.clone())
                    .collect();
                path.reverse();
                FolderEntry {
                    order: position,
                    pinned: pins.contains_key(id.as_str()),
                    pin_order: pins.get(id.as_str()).copied(),
                    id: id.clone(),
                    parent_id: parent_id.clone(),
                    name: name.clone(),
                    path,
                    image_count: direct_counts[position],
                    image_count_with_descendants: totals[position],
                }
            })
            .collect(),
    };
    Ok(json_response(&response))
}

// ---------------------------------------------------------------- batch

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchRequest {
    folder_id: Option<String>,
    #[serde(default)]
    include_descendants: bool,
    scope: Option<ScopeRequest>,
    limit: Option<u32>,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    order: BatchOrder,
    #[serde(default)]
    offset: u64,
}

#[derive(Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum BatchOrder {
    #[default]
    Random,
    Newest,
}

/// A character or character group to draw from instead of a folder.
#[derive(Deserialize)]
struct ScopeRequest {
    kind: String,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchItem {
    asset_id: String,
    width: u32,
    height: u32,
    byte_size: u64,
    mime: &'static str,
    thumbnail_url: String,
    thumbnail_mime: &'static str,
    thumbnail_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchResponse {
    items: Vec<BatchItem>,
    remaining: u64,
    next_offset: Option<u64>,
}

/// splitmix64: a small, well-mixed generator seeded per request.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^ (value >> 31)
    }

    /// Uniform in `0..bound` (rejection sampling, no modulo bias).
    fn below(&mut self, bound: usize) -> usize {
        let bound = bound as u64;
        let zone = u64::MAX - (u64::MAX % bound);
        loop {
            let value = self.next();
            if value < zone {
                return (value % bound) as usize;
            }
        }
    }
}

fn random_seed() -> u64 {
    let value = Uuid::new_v4().as_u128();
    (value >> 64) as u64 ^ value as u64
}

fn batch(
    library: &Library,
    privacy: Privacy,
    body: &[u8],
    seed: u64,
) -> Result<ApiResponse, ApiError> {
    let request: BatchRequest =
        serde_json::from_slice(body).map_err(|_| ApiError::PickerInvalidRequest)?;
    let limit = request.limit.unwrap_or(DEFAULT_BATCH);
    // Exactly one of a folder and a character/group scope.
    let scope_is_valid = match (&request.folder_id, &request.scope) {
        (Some(folder_id), None) => valid_id(folder_id),
        (None, Some(scope)) => {
            matches!(scope.kind.as_str(), "character" | "group") && valid_id(&scope.id)
        }
        _ => false,
    };
    if !scope_is_valid
        || !(1..=MAX_BATCH).contains(&limit)
        || request.exclude.len() > MAX_EXCLUDED
        || !request.exclude.iter().all(|id| valid_id(id))
    {
        return Err(ApiError::PickerInvalidRequest);
    }
    let eligible = eligibility_sql(privacy);
    let selection = library
        .read_without_lock(|connection| {
            select_batch(
                library,
                connection,
                &eligible,
                &request,
                limit as usize,
                &mut Rng(seed),
            )
        })
        .map_err(internal)?;
    let (items, remaining, next_offset) = selection.ok_or(if request.scope.is_some() {
        ApiError::PickerScopeNotFound
    } else {
        ApiError::ClassificationNotFound
    })?;
    Ok(json_response(&BatchResponse {
        items,
        remaining,
        next_offset,
    }))
}

/// `None` when the folder or the character/group does not exist. Otherwise up to `limit`
/// random eligible images and the eligible count minus the excluded ones.
fn select_batch(
    library: &Library,
    connection: &Connection,
    eligible: &str,
    request: &BatchRequest,
    limit: usize,
    rng: &mut Rng,
) -> Result<Option<(Vec<BatchItem>, u64, Option<u64>)>, LibraryError> {
    let candidates = match (&request.folder_id, &request.scope) {
        (Some(folder_id), _) => {
            folder_candidates(connection, eligible, folder_id, request.include_descendants)?
        }
        (None, Some(scope)) => scope_candidates(connection, eligible, scope)?,
        (None, None) => None,
    };
    let Some(mut candidates) = candidates else {
        return Ok(None);
    };

    let newest = request.order == BatchOrder::Newest;
    if newest {
        let membership: HashSet<i64> = candidates.into_iter().collect();
        let mut statement = connection
            .prepare("SELECT rowid FROM assets ORDER BY collected_at DESC, rowid DESC")?;
        candidates = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        candidates.retain(|rowid| membership.contains(rowid));
    }
    if !newest && !request.exclude.is_empty() {
        let mut excluded = HashSet::<i64>::new();
        for chunk in request.exclude.chunks(SQL_CHUNK) {
            let mut statement = connection.prepare_cached(&format!(
                "SELECT rowid FROM assets WHERE id IN ({})",
                placeholders(chunk.len())
            ))?;
            let rows =
                statement.query_map(params_from_iter(chunk.iter()), |row| row.get::<_, i64>(0))?;
            for row in rows {
                excluded.insert(row?);
            }
        }
        candidates.retain(|rowid| !excluded.contains(rowid));
    }
    let total = candidates.len() as u64;
    let offset = if newest {
        request.offset.min(total) as usize
    } else {
        0
    };
    let remaining = total - offset as u64;
    let candidates = &mut candidates[offset..];

    // Partial Fisher-Yates: each round draws only as many as the batch still needs. Rows
    // whose files are gone are skipped and replaced by the next draw.
    let mut items = Vec::<BatchItem>::new();
    let mut cursor = 0;
    // A library with many missing files returns a short batch rather than scanning it all.
    let draw_limit = limit * 10 + 100;
    while items.len() < limit && cursor < candidates.len().min(draw_limit) {
        let end = (cursor + limit - items.len())
            .min(candidates.len())
            .min(draw_limit);
        for position in cursor..end {
            if newest {
                break;
            }
            let pick = position + rng.below(candidates.len() - position);
            candidates.swap(position, pick);
        }
        let drawn = &candidates[cursor..end];
        cursor = end;
        let mut statement = connection.prepare(&format!(
            "SELECT asset.rowid, asset.id, asset.width, asset.height, asset.byte_size,
                    asset.relative_path, asset.thumbnail_relative_path
             FROM assets AS asset
             WHERE asset.rowid IN ({}) AND {eligible}",
            placeholders(drawn.len())
        ))?;
        let mut details = HashMap::new();
        let mut rows = statement.query(params_from_iter(drawn.iter()))?;
        while let Some(row) = rows.next()? {
            details.insert(
                row.get::<_, i64>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ),
            );
        }
        drop(rows);
        drop(statement);
        for rowid in drawn {
            let Some((id, width, height, byte_size, original, thumbnail)) = details.remove(rowid)
            else {
                continue;
            };
            let (Some(mime), Some(thumbnail)) = (image_mime(&original), thumbnail) else {
                continue;
            };
            if image_mime(&thumbnail).is_none()
                || library.library_media_path(&original).is_err()
                || library.library_media_path(&thumbnail).is_err()
            {
                continue;
            }
            let Some(thumbnail_mime) = image_mime(&thumbnail) else {
                continue;
            };
            let Ok(bytes) = read_file(
                library,
                &thumbnail,
                MAX_THUMBNAIL_BYTES,
                ApiError::PickerAssetNotFound,
            ) else {
                continue;
            };
            items.push(BatchItem {
                thumbnail_mime,
                thumbnail_base64: encode_base64(&bytes),
                thumbnail_url: format!("{THUMBNAIL_PREFIX}{id}"),
                asset_id: id,
                width: width.clamp(0, u32::MAX as i64) as u32,
                height: height.clamp(0, u32::MAX as i64) as u32,
                byte_size: byte_size.max(0) as u64,
                mime,
            });
        }
    }
    let next_offset = (newest && offset as u64 + (cursor as u64) < total)
        .then_some(offset as u64 + cursor as u64);
    Ok(Some((items, remaining, next_offset)))
}

/// Standard base64 with padding; no additional dependency is needed for batch thumbnails.
fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        output.push(ALPHABET[(value >> 18) as usize & 63] as char);
        output.push(ALPHABET[(value >> 12) as usize & 63] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[value as usize & 63] as char
        } else {
            '='
        });
    }
    output
}

/// Eligible row ids of a folder (and optionally its descendants); `None` for an unknown folder.
fn folder_candidates(
    connection: &Connection,
    eligible: &str,
    folder_id: &str,
    include_descendants: bool,
) -> Result<Option<Vec<i64>>, LibraryError> {
    // The folder and, optionally, its descendants.
    let mut statement = connection.prepare("SELECT id, parent_id FROM classification_entries")?;
    let mut children = HashMap::<String, Vec<String>>::new();
    let mut found = false;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        found |= id == folder_id;
        if let Some(parent) = row.get::<_, Option<String>>(1)? {
            children.entry(parent).or_default().push(id);
        }
    }
    drop(rows);
    drop(statement);
    if !found {
        return Ok(None);
    }
    let mut scope = vec![folder_id.to_owned()];
    if include_descendants {
        let mut seen = HashSet::from([folder_id.to_owned()]);
        let mut next = 0;
        while next < scope.len() {
            for child in children.get(&scope[next]).into_iter().flatten() {
                if seen.insert(child.clone()) {
                    scope.push(child.clone());
                }
            }
            next += 1;
        }
    }

    // One indexed read of the eligible row ids in scope (integers, not 36-character ids).
    let mut candidates = Vec::<i64>::new();
    for chunk in scope.chunks(SQL_CHUNK) {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT asset.rowid
             FROM asset_classifications AS link
             CROSS JOIN assets AS asset ON asset.id = link.asset_id
             WHERE link.classification_id IN ({}) AND {eligible}",
            placeholders(chunk.len())
        ))?;
        let rows =
            statement.query_map(params_from_iter(chunk.iter()), |row| row.get::<_, i64>(0))?;
        for row in rows {
            candidates.push(row?);
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    Ok(Some(candidates))
}

/// Eligible row ids of one character or group; `None` for an unknown or disabled one.
fn scope_candidates(
    connection: &Connection,
    eligible: &str,
    scope: &ScopeRequest,
) -> Result<Option<Vec<i64>>, LibraryError> {
    let (exists, units) = if scope.kind == "group" {
        ("SELECT 1 FROM character_groups WHERE id=?1", GROUP_UNIT_SQL)
    } else {
        (
            "SELECT 1 FROM character_targets
             WHERE id=?1 AND role='character' AND enabled=1
               AND series_classification_id IS NOT NULL",
            CHARACTER_UNIT_SQL,
        )
    };
    if connection
        .query_row(exists, [&scope.id], |_| Ok(()))
        .optional()?
        .is_none()
    {
        return Ok(None);
    }
    let mut statement = connection.prepare("SELECT id, parent_id FROM classification_entries")?;
    let graph = FolderGraph::new(
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?,
    );
    drop(statement);
    let mut candidates: Vec<i64> =
        unit_members(connection, &graph, units, eligible, Some(&scope.id))?
            .members
            .into_iter()
            .map(|(_, rowid)| rowid)
            .collect();
    candidates.sort_unstable();
    candidates.dedup();
    Ok(Some(candidates))
}

// ---------------------------------------------------------------- files

fn image_mime(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// `(original, thumbnail)` relative paths of one eligible asset whose two files are present.
fn eligible_paths(
    library: &Library,
    privacy: Privacy,
    id: &str,
) -> Result<(String, String), ApiError> {
    if !valid_id(id) {
        return Err(ApiError::PickerAssetNotFound);
    }
    let eligible = eligibility_sql(privacy);
    library
        .read_without_lock(|connection| {
            Ok(connection
                .prepare_cached(&format!(
                    "SELECT asset.relative_path, asset.thumbnail_relative_path
                     FROM assets AS asset WHERE asset.id = ?1 AND {eligible}"
                ))?
                .query_row([id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .optional()?)
        })
        .map_err(internal)?
        // A row whose original is not a known image type is not a picker image.
        .filter(|(original, _)| image_mime(original).is_some())
        .and_then(|(original, thumbnail)| Some((original, thumbnail?)))
        .filter(|(original, thumbnail)| {
            library.library_media_path(original).is_ok()
                && library.library_media_path(thumbnail).is_ok()
        })
        .ok_or(ApiError::PickerAssetNotFound)
}

/// The file bytes, never more than `maximum`; a missing file is "not found".
fn read_file(
    library: &Library,
    relative_path: &str,
    maximum: u64,
    too_large: ApiError,
) -> Result<Vec<u8>, ApiError> {
    let path = library
        .library_media_path(relative_path)
        .map_err(|error| match error {
            LibraryError::MediaNotFound => ApiError::PickerAssetNotFound,
            _ => ApiError::Internal,
        })?;
    let file = fs::File::open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::PickerAssetNotFound
        } else {
            ApiError::Internal
        }
    })?;
    let length = file.metadata().map_err(|_| ApiError::Internal)?.len();
    if length > maximum {
        return Err(too_large);
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::Internal)?;
    if bytes.len() as u64 > maximum {
        return Err(too_large);
    }
    Ok(bytes)
}

fn file_response(mime: &'static str, cache_control: &'static str, body: Vec<u8>) -> ApiResponse {
    let mut headers = cors_headers();
    headers.push(("Content-Type", mime.into()));
    headers.push(("Cache-Control", cache_control.into()));
    headers.push(("X-Content-Type-Options", "nosniff".into()));
    ApiResponse {
        status: 200,
        headers,
        body,
    }
}

fn thumbnail(library: &Library, privacy: Privacy, id: &str) -> Result<ApiResponse, ApiError> {
    let (_, thumbnail) = eligible_paths(library, privacy, id)?;
    let mime = image_mime(&thumbnail).ok_or(ApiError::PickerAssetNotFound)?;
    let bytes = read_file(library, &thumbnail, MAX_THUMBNAIL_BYTES, ApiError::Internal)?;
    Ok(file_response(mime, THUMBNAIL_CACHE, bytes))
}

fn original(library: &Library, privacy: Privacy, id: &str) -> Result<ApiResponse, ApiError> {
    let (original, _) = eligible_paths(library, privacy, id)?;
    let mime = image_mime(&original).ok_or(ApiError::PickerAssetNotFound)?;
    let bytes = read_file(
        library,
        &original,
        MAX_ORIGINAL_BYTES,
        ApiError::PickerOriginalTooLarge,
    )?;
    Ok(file_response(mime, "no-store", bytes))
}

#[cfg(test)]
mod tests;
