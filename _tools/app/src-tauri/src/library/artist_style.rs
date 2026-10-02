//! PC artist-style feature import and disposable suggestion cache. Never assigns assets.
use super::{
    artists::{self, ArtistSummary},
    error::LibraryError,
    image_fingerprint::{minimum_distance, ImageFingerprint},
    similarity::{PDQ_DISTANCE_MAX, PDQ_QUALITY_MIN},
    Library,
};
use artist_style_math::{Vector, DIM};
#[cfg(test)]
use artist_style_math as math;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
const MODEL: &str = "kaloscope2";
const CACHE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value);
CREATE TABLE IF NOT EXISTS features(asset_id TEXT PRIMARY KEY, vector BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS suggestions(asset_id TEXT PRIMARY KEY, artist_id TEXT NOT NULL, score REAL NOT NULL, lead REAL NOT NULL, runner_up_artist TEXT, runner_up_score REAL);
CREATE TABLE IF NOT EXISTS suggestion_references(asset_id TEXT NOT NULL, reference_asset_id TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY(asset_id, reference_asset_id));";

#[derive(Debug, Default)]
pub(super) struct Runtime {
    gate: Mutex<()>,
    computing: AtomicBool,
    /// A background refresh is queued or running (see `schedule_artist_style_refresh`).
    scheduled: AtomicBool,
}
struct Computing<'a>(&'a AtomicBool);
impl Drop for Computing<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub features: u32,
    pub model: Option<String>,
    pub suggestions: u32,
    pub computing: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub asset_id: String,
    pub score: f32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub artist: ArtistSummary,
    pub candidates: Vec<Candidate>,
    pub reference_asset_ids: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub total_images: u32,
    pub total_artists: u32,
    pub groups: Vec<Group>,
    /// False while the shown suggestions come from a ranking older than the library.
    pub up_to_date: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerUp {
    pub artist: ArtistSummary,
    pub score: f32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub artist: ArtistSummary,
    pub score: f32,
    pub reference_asset_ids: Vec<String>,
    pub runner_up: Option<RunnerUp>,
}

fn invalid(message: &str) -> LibraryError {
    LibraryError::InvalidArtist(message.into())
}
fn read_only(path: &Path) -> Result<Connection, LibraryError> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}
fn meta(conn: &Connection, key: &str) -> Result<Option<String>, LibraryError> {
    Ok(conn
        .query_row(
            "SELECT CAST(value AS TEXT) FROM meta WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?)
}
fn validate_meta(conn: &Connection) -> Result<Vec<f32>, LibraryError> {
    if meta(conn, "model")?.as_deref() != Some(MODEL)
        || meta(conn, "dim")?.as_deref() != Some("2048")
    {
        return Err(invalid(
            "작가 특징 모델 또는 차원이 다릅니다. kaloscope2 / 2048 파일이 필요합니다.",
        ));
    }
    let bytes: Vec<u8> =
        conn.query_row("SELECT value FROM meta WHERE key='mean'", [], |r| r.get(0))?;
    if bytes.len() != DIM * 4 {
        return Err(invalid("작가 특징 평균 벡터는 2048개의 f32여야 합니다."));
    }
    let mean: Vec<_> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    if mean.iter().any(|x| !x.is_finite()) {
        return Err(invalid("작가 특징 평균에 유효하지 않은 값이 있습니다."));
    }
    Ok(mean)
}
// IEEE-754 binary16 decoding, including subnormals. Imports reject infinities and NaNs.
fn f16(bits: u16) -> f32 {
    let sign = if bits & 0x8000 == 0 { 1.0 } else { -1.0 };
    let exponent = (bits >> 10) & 31;
    let fraction = bits & 1023;
    match exponent {
        0 => sign * fraction as f32 * (1.0 / 16777216.0),
        31 => {
            if fraction == 0 {
                sign * f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => f32::from_bits(
            ((bits as u32 & 0x8000) << 16)
                | ((exponent as u32 + 112) << 23)
                | ((fraction as u32) << 13),
        ),
    }
}
fn decode(bytes: &[u8]) -> Result<Vec<f32>, LibraryError> {
    if bytes.len() != DIM * 2 {
        return Err(invalid("작가 특징 벡터는 2048개의 f16이어야 합니다."));
    }
    let result: Vec<_> = bytes
        .chunks_exact(2)
        .map(|b| f16(u16::from_le_bytes([b[0], b[1]])))
        .collect();
    if result.iter().any(|x| !x.is_finite()) {
        return Err(invalid("작가 특징 벡터에 유효하지 않은 값이 있습니다."));
    }
    Ok(result)
}
fn normalized(bytes: &[u8], mean: &[f32]) -> Result<Option<Vec<f32>>, LibraryError> {
    let mut result = decode(bytes)?;
    for (x, m) in result.iter_mut().zip(mean) {
        *x -= m;
    }
    let norm = result
        .iter()
        .map(|x| (*x as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Ok(None);
    }
    for x in &mut result {
        *x = (*x as f64 / norm) as f32;
    }
    Ok(Some(result))
}

#[derive(Serialize)]
struct Asset {
    id: String,
    scope: String,
    source: Option<String>,
    hash: Option<Vec<u8>>,
    quality: Option<u8>,
}
struct Inputs {
    assets: Vec<Asset>,
    artists: BTreeMap<String, ArtistSummary>,
    dismissals: Vec<(String, String)>,
    #[cfg(test)]
    excluded_classifications: Vec<String>,
    stamp: String,
}
fn inputs(conn: &Connection) -> Result<Inputs, LibraryError> {
    let assets = conn.prepare("SELECT a.id, s.scope_ref, a.source_url, a.perceptual_hash, a.perceptual_hash_quality FROM assets a JOIN asset_artist_scope s ON s.asset_id=a.id WHERE a.status='normal' AND a.media_kind IN ('image','gif') ORDER BY a.id")?
        .query_map([], |r| Ok(Asset { id:r.get(0)?, scope:r.get(1)?, source:r.get(2)?, hash:r.get(3)?, quality:r.get(4)? }))?.collect::<Result<Vec<_>, _>>()?;
    let artists: BTreeMap<_, _> = artists::style_summaries(conn)?
        .into_iter()
        .filter(|a| !a.hidden && !a.reposter)
        .map(|a| (a.id.clone(), a))
        .collect();
    // Also resolve legacy/bare keys on read, matching the hub's member identity.
    let dismissals = conn.prepare("SELECT d.asset_id, COALESCE('artist:' || m.artist_id, d.artist_id) FROM artist_style_dismissals d LEFT JOIN artist_members m ON m.creator_key=d.artist_id ORDER BY 1,2")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<(String,String)>, _>>()?;
    let excluded_classifications = conn
        .prepare("SELECT classification_id FROM artist_excluded_classifications ORDER BY classification_id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    // O(asset count), cheap compared with O(candidates * known * 2048). Unlike count/max-time
    // stamps this catches equal-count edits, same-timestamp writes, trash, PDQ and source changes.
    // Feature imports clear this stamp atomically. The version covers changes to ranking rules.
    let serialized = serde_json::to_vec(&(
        "artist-style-v1",
        &assets,
        artists.keys().collect::<Vec<_>>(),
        &dismissals,
        &excluded_classifications,
    ))
    .map_err(|_| invalid("작가 추천 입력을 읽지 못했습니다."))?;
    let stamp = Sha256::digest(serialized)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(Inputs {
        assets,
        artists,
        dismissals,
        #[cfg(test)]
        excluded_classifications,
        stamp,
    })
}

fn post_key(source: &str) -> Option<String> {
    let mut url = url::Url::parse(source.trim()).ok()?;
    let host = url.host_str()?.trim_start_matches("www.");
    let segments: Vec<_> = url.path_segments()?.collect();
    let marker = if matches!(
        host,
        "x.com" | "twitter.com" | "mobile.x.com" | "mobile.twitter.com"
    ) {
        Some(("status", "x"))
    } else if host == "pixiv.net" || host.ends_with(".pixiv.net") {
        Some(("artworks", "pixiv"))
    } else {
        None
    };
    if let Some((marker, platform)) = marker {
        if let Some(id) = segments
            .windows(2)
            .find(|s| s[0] == marker)
            .map(|s| s[1])
            .filter(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
        {
            return Some(format!("{platform}:{id}"));
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}
fn root(parents: &mut [usize], mut i: usize) -> usize {
    while parents[i] != i {
        parents[i] = parents[parents[i]];
        i = parents[i];
    }
    i
}
fn duplicate_groups(assets: &[Asset]) -> Vec<usize> {
    let mut parents: Vec<_> = (0..assets.len()).collect();
    let mut posts = HashMap::new();
    let mut fingerprints: Vec<(usize, ImageFingerprint)> = Vec::new();
    // Include every retained style image as a bridge in the duplicate graph.
    for (i, asset) in assets.iter().enumerate() {
        if let Some(key) = asset.source.as_deref().and_then(post_key) {
            if let Some(&previous) = posts.get(&key) {
                let a = root(&mut parents, i);
                let b = root(&mut parents, previous);
                parents[a] = b;
            } else {
                posts.insert(key, i);
            }
        }
        if let (Some(bytes), Some(q)) = (&asset.hash, asset.quality) {
            if q >= PDQ_QUALITY_MIN {
                if let Ok(fp) = ImageFingerprint::from_stored_bytes(bytes, q) {
                    fingerprints.push((i, fp));
                }
            }
        }
    }
    for (position, (i, a)) in fingerprints.iter().enumerate() {
        for (j, b) in &fingerprints[..position] {
            if minimum_distance(a, b) <= PDQ_DISTANCE_MAX {
                let a = root(&mut parents, *i);
                let b = root(&mut parents, *j);
                parents[a] = b;
            }
        }
    }
    (0..assets.len()).map(|i| root(&mut parents, i)).collect()
}

impl Library {
    fn artist_style_path(&self) -> PathBuf {
        self.root().join(".cache/artist-style/features.sqlite")
    }

    pub fn import_artist_style_features(&self, path: &Path) -> Result<ImportResult, LibraryError> {
        let _gate = self
            .artist_style_runtime
            .gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let source = read_only(path)?;
        let _snapshot = source.unchecked_transaction()?;
        validate_meta(&source)?;
        let destination = self.artist_style_path();
        if destination.exists()
            && std::fs::canonicalize(path).ok() == std::fs::canonicalize(&destination).ok()
        {
            return Err(invalid(
                "특징 저장소 자체를 가져올 수 없습니다. 내보낸 파일을 선택해 주세요.",
            ));
        }
        let parent = destination.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|source| LibraryError::CreateDirectory {
            path: parent.into(),
            source,
        })?;
        // First import is published only after commit, so status readers cannot observe
        // an empty/partial schema. Closing before persist also supports Windows.
        let temporary = if destination.exists() {
            None
        } else {
            Some(
                tempfile::NamedTempFile::new_in(parent)
                    .map_err(|_| invalid("작가 특징 임시 파일을 만들지 못했습니다."))?,
            )
        };
        let mut store = Connection::open(
            temporary
                .as_ref()
                .map_or(destination.as_path(), |file| file.path()),
        )?;
        store.execute_batch(CACHE_SCHEMA)?;
        if meta(&store, "model")?.is_some() {
            validate_meta(&store)?;
        }
        let conn = self.connection()?;
        let tx = store.transaction()?;
        let mut counts = ImportResult {
            imported: 0,
            skipped: 0,
        };
        let mut exists = conn.prepare("SELECT 1 FROM assets WHERE id=?1")?;
        let mut insert = tx.prepare("INSERT INTO features VALUES (?1,?2) ON CONFLICT(asset_id) DO UPDATE SET vector=excluded.vector")?;
        let mut statement =
            source.prepare("SELECT asset_id, vector FROM features ORDER BY asset_id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if !exists.exists([&id])? {
                counts.skipped += 1;
                continue;
            }
            let bytes: Vec<u8> = row.get(1)?;
            decode(&bytes)?;
            insert.execute(params![id, bytes])?;
            counts.imported += 1;
        }
        drop(insert);
        // Only model metadata is accepted; an import cannot inject a computed-cache stamp.
        tx.execute("DELETE FROM meta", [])?;
        for key in ["model", "dim", "mean"] {
            let value: rusqlite::types::Value =
                source.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))?;
            tx.execute("INSERT INTO meta VALUES (?1,?2)", params![key, value])?;
        }
        tx.execute("DELETE FROM suggestions", [])?;
        tx.execute("DELETE FROM suggestion_references", [])?;
        tx.commit()?;
        drop(store);
        if let Some(file) = temporary {
            file.persist(&destination)
                .map_err(|_| invalid("작가 특징 저장소를 저장하지 못했습니다."))?;
        }
        Ok(counts)
    }

    // Called under the runtime gate. The library connection is released before heavy math.
    fn ensure_artist_style(&self) -> Result<Option<Inputs>, LibraryError> {
        let path = self.artist_style_path();
        if !path.exists() {
            return Ok(None);
        }
        let input = inputs(&*self.connection()?)?;
        let store = read_only(&path)?;
        if meta(&store, "inputs")?.as_deref() == Some(&input.stamp) {
            return Ok(Some(input));
        }
        self.artist_style_runtime
            .computing
            .store(true, Ordering::Relaxed);
        let _computing = Computing(&self.artist_style_runtime.computing);
        let mean = validate_meta(&store)?;
        let groups = duplicate_groups(&input.assets);
        let artist_ids: Vec<_> = input.artists.keys().cloned().collect();
        let artist_index: HashMap<_, _> = artist_ids
            .iter()
            .enumerate()
            .map(|(i, a)| (a.as_str(), i))
            .collect();
        let asset_index: HashMap<_, _> = input
            .assets
            .iter()
            .enumerate()
            .map(|(i, a)| (a.id.as_str(), i))
            .collect();
        let dismissals: HashSet<_> = input
            .dismissals
            .iter()
            .filter_map(|(asset, artist)| {
                Some((
                    *asset_index.get(asset.as_str())?,
                    *artist_index.get(artist.as_str())?,
                ))
            })
            .collect();
        let mut known = Vec::new();
        let mut candidates = Vec::new();
        let mut statement =
            store.prepare("SELECT asset_id, vector FROM features ORDER BY asset_id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let Some(&index) = asset_index.get(id.as_str()) else {
                continue;
            };
            let asset = &input.assets[index];
            let unknown = matches!(
                asset.scope.as_str(),
                artists::UNKNOWN_NONE | artists::UNKNOWN_SOURCE
            );
            let artist = artist_index.get(asset.scope.as_str()).copied();
            if !unknown && artist.is_none() {
                continue;
            }
            let bytes: Vec<u8> = row.get(1)?;
            let Some(values) = normalized(&bytes, &mean)? else {
                continue;
            };
            let vector = Vector {
                asset: index,
                artist: artist.unwrap_or(0),
                group: groups[index],
                values,
            };
            if unknown {
                candidates.push(vector);
            } else {
                known.push(vector);
            }
        }
        drop(rows);
        drop(statement);
        drop(store);
        let ranked = artist_style_math::rank(&known, &candidates, artist_ids.len(), &dismissals);
        // Derived cache writes are the only writes outside import; feature/meta model rows
        // never change here. A later read detects any concurrent library edit via its stamp.
        let mut store = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let tx = store.transaction()?;
        tx.execute("DELETE FROM suggestions", [])?;
        tx.execute("DELETE FROM suggestion_references", [])?;
        for r in ranked {
            let id = &input.assets[r.asset].id;
            tx.execute(
                "INSERT INTO suggestions VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    id,
                    artist_ids[r.artist],
                    r.score,
                    r.lead,
                    r.runner.map(|(a, _)| &artist_ids[a]),
                    r.runner.map(|(_, s)| s)
                ],
            )?;
            for (reference, score) in r.references {
                tx.execute(
                    "INSERT INTO suggestion_references VALUES (?1,?2,?3)",
                    params![id, input.assets[reference].id, score],
                )?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta VALUES ('inputs',?1)",
            [&input.stamp],
        )?;
        tx.commit()?;
        Ok(Some(input))
    }

    pub fn artist_style_status(&self) -> Result<Status, LibraryError> {
        let computing = self.artist_style_runtime.computing.load(Ordering::Relaxed);
        let path = self.artist_style_path();
        if !path.exists() {
            return Ok(Status {
                features: 0,
                model: None,
                suggestions: 0,
                computing,
            });
        }
        // Keep the library-before-store lock order shared with import.
        let stamp = inputs(&*self.connection()?)?.stamp;
        let store = read_only(&path)?;
        let _snapshot = store.unchecked_transaction()?;
        // A status poll never starts or waits on ranking, and never reports a stale count.
        let fresh = meta(&store, "inputs")?.as_deref() == Some(&stamp);
        Ok(Status {
            features: store.query_row("SELECT count(*) FROM features", [], |r| r.get(0))?,
            model: meta(&store, "model")?,
            suggestions: if fresh {
                store.query_row("SELECT count(*) FROM suggestions", [], |r| r.get(0))?
            } else {
                0
            },
            computing,
        })
    }

    /// Ranks again on a background thread when the cached suggestions are stale. Reads that
    /// back quick UI (the index badge, the inspector) never wait for the ~7 s ranking.
    fn schedule_artist_style_refresh(&self) {
        if self
            .artist_style_runtime
            .scheduled
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        let library = self.clone();
        std::thread::spawn(move || {
            {
                let _gate = library
                    .artist_style_runtime
                    .gate
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let _ = library.ensure_artist_style();
            }
            library
                .artist_style_runtime
                .scheduled
                .store(false, Ordering::SeqCst);
        });
    }

    /// The cached inputs and whether the cached suggestions match them; `None` without a store.
    fn artist_style_cached(&self) -> Result<Option<(Inputs, bool)>, LibraryError> {
        let path = self.artist_style_path();
        if !path.exists() {
            return Ok(None);
        }
        let input = inputs(&*self.connection()?)?;
        let fresh = meta(&read_only(&path)?, "inputs")?.as_deref() == Some(&input.stamp);
        if !fresh {
            self.schedule_artist_style_refresh();
        }
        Ok(Some((input, fresh)))
    }

    /// Tests: rank synchronously, then answer like the inspector.
    #[cfg(test)]
    pub(super) fn artist_style_suggestion_now(
        &self,
        asset_id: &str,
    ) -> Result<Option<Suggestion>, LibraryError> {
        {
            let _gate = self
                .artist_style_runtime
                .gate
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            self.ensure_artist_style()?;
        }
        self.artist_style_suggestion(asset_id)
    }

    /// The index badge: the last ranked count, possibly one refresh behind; never waits.
    pub(super) fn artist_style_suggestion_count(&self) -> Result<u32, LibraryError> {
        if self.artist_style_cached()?.is_none() {
            return Ok(0);
        }
        Ok(read_only(&self.artist_style_path())?.query_row(
            "SELECT count(*) FROM suggestions",
            [],
            |r| r.get(0),
        )?)
    }

    /// Tests: rank synchronously, then list like the artist page.
    #[cfg(test)]
    pub(super) fn list_artist_style_suggestions_now(
        &self,
        offset: u32,
        limit: u32,
    ) -> Result<Page, LibraryError> {
        {
            let _gate = self
                .artist_style_runtime
                .gate
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            self.ensure_artist_style()?;
        }
        self.list_artist_style_suggestions(offset, limit)
    }

    /// Offset and limit paginate artists, never candidates within a group. Answers from the last
    /// ranking and never waits for a new one (assigning images makes the ranking stale; waiting
    /// here made every assignment take seconds). Images that have an artist by now, dismissed
    /// pairs and hidden/reposter artists are dropped; `up_to_date` tells the page to poll.
    pub fn list_artist_style_suggestions(
        &self,
        offset: u32,
        limit: u32,
    ) -> Result<Page, LibraryError> {
        let Some((input, fresh)) = self.artist_style_cached()? else {
            return Ok(Page {
                total_images: 0,
                total_artists: 0,
                groups: Vec::new(),
                up_to_date: true,
            });
        };
        let unknown: HashSet<&str> = input
            .assets
            .iter()
            .filter(|asset| {
                matches!(
                    asset.scope.as_str(),
                    artists::UNKNOWN_NONE | artists::UNKNOWN_SOURCE
                )
            })
            .map(|asset| asset.id.as_str())
            .collect();
        let dismissed: HashSet<(&str, &str)> = input
            .dismissals
            .iter()
            .map(|(asset, artist)| (asset.as_str(), artist.as_str()))
            .collect();
        let store = read_only(&self.artist_style_path())?;
        let rows = store.prepare("SELECT asset_id, artist_id, score FROM suggestions ORDER BY score DESC, asset_id")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f32>(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut by_artist: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
        for (asset_id, artist_id, score) in rows {
            if !unknown.contains(asset_id.as_str())
                || dismissed.contains(&(asset_id.as_str(), artist_id.as_str()))
                || !input.artists.contains_key(&artist_id)
            {
                continue;
            }
            by_artist
                .entry(artist_id)
                .or_default()
                .push(Candidate { asset_id, score });
        }
        let total_images = by_artist.values().map(Vec::len).sum::<usize>() as u32;
        let total_artists = by_artist.len() as u32;
        let mut ordered: Vec<(String, Vec<Candidate>)> = by_artist.into_iter().collect();
        // Candidates are already score-descending, so the first is each artist's best.
        ordered.sort_by(|(left_id, left), (right_id, right)| {
            right
                .len()
                .cmp(&left.len())
                .then(right[0].score.total_cmp(&left[0].score))
                .then(left_id.cmp(right_id))
        });
        let mut groups = Vec::new();
        for (id, candidates) in ordered
            .into_iter()
            .skip(offset as usize)
            .take(limit.clamp(1, 100) as usize)
        {
            let artist = input.artists[&id].clone();
            let reference_asset_ids = store.prepare("SELECT r.reference_asset_id FROM suggestion_references r JOIN suggestions s ON s.asset_id=r.asset_id WHERE s.artist_id=?1 GROUP BY r.reference_asset_id ORDER BY max(r.score) DESC,r.reference_asset_id LIMIT 4")?
                .query_map([&id], |r| r.get(0))?.collect::<Result<Vec<_>,_>>()?;
            groups.push(Group {
                artist,
                candidates,
                reference_asset_ids,
            });
        }
        Ok(Page {
            total_images,
            total_artists,
            groups,
            up_to_date: fresh,
        })
    }

    /// The inspector box; answers from the last ranking and never waits for a new one. An image
    /// that has an artist by now gets no suggestion even when the cache is one refresh behind.
    pub fn artist_style_suggestion(
        &self,
        asset_id: &str,
    ) -> Result<Option<Suggestion>, LibraryError> {
        let Some((input, _fresh)) = self.artist_style_cached()? else {
            return Ok(None);
        };
        let still_unknown = input.assets.iter().any(|asset| {
            asset.id == asset_id
                && matches!(
                    asset.scope.as_str(),
                    artists::UNKNOWN_NONE | artists::UNKNOWN_SOURCE
                )
        });
        if !still_unknown {
            return Ok(None);
        }
        let store = read_only(&self.artist_style_path())?;
        let row = store.query_row("SELECT artist_id,score,runner_up_artist,runner_up_score FROM suggestions WHERE asset_id=?1", [asset_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,f32>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<f32>>(3)?))).optional()?;
        let Some((id, score, runner, runner_score)) = row else {
            return Ok(None);
        };
        let Some(artist) = input.artists.get(&id).cloned() else {
            return Ok(None);
        };
        let reference_asset_ids = store.prepare("SELECT reference_asset_id FROM suggestion_references WHERE asset_id=?1 ORDER BY score DESC,reference_asset_id LIMIT 3")?
            .query_map([asset_id], |r| r.get(0))?.collect::<Result<Vec<_>,_>>()?;
        let runner_up = runner.zip(runner_score).and_then(|(id, score)| {
            input
                .artists
                .get(&id)
                .cloned()
                .map(|artist| RunnerUp { artist, score })
        });
        Ok(Some(Suggestion {
            artist,
            score,
            reference_asset_ids,
            runner_up,
        }))
    }

    pub fn dismiss_artist_style_suggestion(
        &self,
        asset_ids: &[String],
        artist_id: &str,
    ) -> Result<(), LibraryError> {
        if asset_ids.is_empty() || asset_ids.len() > 5000 {
            return Err(invalid("1~5000개의 이미지를 선택해 주세요."));
        }
        let conn = self.connection()?;
        let tx = conn.unchecked_transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        let id = artists::materialize(&tx, artist_id, &now)?;
        for asset in asset_ids {
            tx.execute(
                "INSERT OR IGNORE INTO artist_style_dismissals VALUES (?1,?2,?3)",
                params![asset, format!("artist:{id}"), now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "artist_style_tests.rs"]
mod tests;
