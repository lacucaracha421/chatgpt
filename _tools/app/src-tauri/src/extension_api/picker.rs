//! Read-only image picker routes for the Arca Live panel (`COLLECTOR-PICKER-001`).
//!
//! Four routes behind the same bearer token and extension-origin checks as the rest of the
//! service: the folder tree with eligible image counts, a random batch of thumbnails from
//! one folder, one thumbnail, and (only after the user presses "본문에 넣기") one original.
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

#[derive(Default)]
struct GateState {
    latest: Option<(Privacy, Instant)>,
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
    pub(crate) fn report(&self, nonce: &str, privacy: Privacy) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.pending.as_deref() != Some(nonce) {
            return false;
        }
        state.pending = None;
        state.latest = Some((privacy, Instant::now()));
        self.changed.notify_all();
        true
    }

    /// The last answer when it is fresh, otherwise a new one: `ask` receives the nonce and
    /// must hand it to the page (returning false when it could not). Concurrent callers share
    /// one question.
    fn read(
        &self,
        ask: impl Fn(&str) -> bool,
        fresh_for: Duration,
        wait: Duration,
    ) -> Result<Privacy, ApiError> {
        let started = Instant::now();
        let deadline = started + wait;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some((privacy, at)) = state.latest {
                if at.elapsed() < fresh_for || at >= started {
                    return Ok(privacy);
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
pub(super) fn read_privacy(app: &AppHandle, gate: &PrivacyGate) -> Result<Privacy, ApiError> {
    gate.read(
        |nonce| {
            app.get_webview_window("main")
                .is_some_and(|window| window.eval(privacy_probe_script(nonce)).is_ok())
        },
        PRIVACY_FRESH,
        PRIVACY_WAIT,
    )
}

fn privacy_probe_script(nonce: &str) -> String {
    format!(
        "(function(){{var p=false,n=false;try{{var v=JSON.parse(window.localStorage.getItem('lakomics.uiPreferences.v1')||'{{}}');if(v&&typeof v==='object'){{p=v.privacyMode===true;n=v.nsfwFilter===true;}}}}catch(e){{return;}}try{{window.__TAURI_INTERNALS__.invoke('report_picker_privacy',{{nonce:'{nonce}',privacyMode:p,nsfwFilter:n}});}}catch(e){{}}}})();"
    )
}

/// Errors of picker routes are never cached.
pub(super) fn cache_headers(response: &mut ApiResponse) {
    response.headers.push(("Cache-Control", "no-store".into()));
}

pub(super) fn dispatch(
    request: &ApiRequest,
    library: &Library,
    privacy: Privacy,
) -> Result<ApiResponse, ApiError> {
    if privacy.privacy_mode {
        return Err(ApiError::PickerLibraryLocked);
    }
    let path = request.path.as_str();
    match request.method.as_str() {
        "GET" if path == "/v1/picker/folders" => folders(library, privacy),
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
}

#[derive(Serialize)]
struct FoldersResponse {
    entries: Vec<FolderEntry>,
}

fn folders(library: &Library, privacy: Privacy) -> Result<ApiResponse, ApiError> {
    let eligible = eligibility_sql(privacy);
    let (entries, direct, multi_linked) = library
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
            Ok((entries, direct, multi_linked))
        })
        .map_err(internal)?;

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
    let mut settle = |hits: &mut HashMap<usize, u64>, totals: &mut Vec<u64>| {
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

    let response = FoldersResponse {
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
    folder_id: String,
    #[serde(default)]
    include_descendants: bool,
    limit: Option<u32>,
    #[serde(default)]
    exclude: Vec<String>,
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
}

#[derive(Serialize)]
struct BatchResponse {
    items: Vec<BatchItem>,
    remaining: u64,
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
    if !valid_id(&request.folder_id)
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
    let (items, remaining) = selection.ok_or(ApiError::ClassificationNotFound)?;
    Ok(json_response(&BatchResponse { items, remaining }))
}

/// `None` when the folder does not exist. Otherwise up to `limit` random eligible images and
/// the eligible count minus the excluded ones.
fn select_batch(
    library: &Library,
    connection: &Connection,
    eligible: &str,
    request: &BatchRequest,
    limit: usize,
    rng: &mut Rng,
) -> Result<Option<(Vec<BatchItem>, u64)>, LibraryError> {
    // The folder and, optionally, its descendants.
    let mut statement = connection.prepare("SELECT id, parent_id FROM classification_entries")?;
    let mut children = HashMap::<String, Vec<String>>::new();
    let mut found = false;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        found |= id == request.folder_id;
        if let Some(parent) = row.get::<_, Option<String>>(1)? {
            children.entry(parent).or_default().push(id);
        }
    }
    drop(rows);
    drop(statement);
    if !found {
        return Ok(None);
    }
    let mut scope = vec![request.folder_id.clone()];
    if request.include_descendants {
        let mut seen = HashSet::from([request.folder_id.clone()]);
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

    if !request.exclude.is_empty() {
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
    let remaining = candidates.len() as u64;

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
            items.push(BatchItem {
                thumbnail_url: format!("{THUMBNAIL_PREFIX}{id}"),
                asset_id: id,
                width: width.clamp(0, u32::MAX as i64) as u32,
                height: height.clamp(0, u32::MAX as i64) as u32,
                byte_size: byte_size.max(0) as u64,
                mime,
            });
        }
    }
    Ok(Some((items, remaining)))
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
