//! Disposable image-vector cache and the whitespace/name ranking specification.
use super::{
    error::LibraryError,
    nl_search_worker::{normalize, Embedding},
    Library,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

const SIGLIP_DIM: usize = 1152;
const QWEN_DIM: usize = 4096;
const SCHEMA: &str = "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE siglip(asset_id TEXT PRIMARY KEY,vector BLOB NOT NULL);
    CREATE TABLE qwen8b(asset_id TEXT PRIMARY KEY,vector BLOB NOT NULL);";
type Result<T> = std::result::Result<T, LibraryError>;
fn invalid(message: impl Into<String>) -> LibraryError {
    LibraryError::InvalidAutoTag(message.into())
}
fn read_only(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}
fn has_table(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
fn metadata(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    let mut stmt = conn.prepare("SELECT key,value FROM meta")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if values.insert(row.get(0)?, row.get(1)?).is_some() {
            return Err(invalid("검색 색인 meta 키가 중복되었습니다."));
        }
    }
    for (key, value) in [
        ("format", "lakomics-nl-search"),
        ("version", "1"),
        ("siglip_dim", "1152"),
    ] {
        if values.get(key).map(String::as_str) != Some(value) {
            return Err(invalid(format!(
                "검색 색인 {key} 형식이 올바르지 않습니다 (expected {value})."
            )));
        }
    }
    for key in ["content_digest", "siglip_model"] {
        if values.get(key).is_none_or(|v| v.is_empty()) {
            return Err(invalid(format!("검색 색인 {key}가 없습니다.")));
        }
    }
    if has_table(conn, "qwen8b")?
        && (values.get("qwen_dim").map(String::as_str) != Some("4096")
            || values.get("qwen_model").is_none_or(|v| v.is_empty()))
    {
        return Err(invalid(
            "검색 색인 Qwen 모델/차원 형식이 올바르지 않습니다 (4096).",
        ));
    }
    Ok(values)
}
// IEEE-754 binary16, including signed subnormals; no additional dependency.
fn half(bits: u16) -> f32 {
    let sign = if bits & 0x8000 == 0 { 1.0 } else { -1.0 };
    let exponent = (bits >> 10) & 31;
    let fraction = bits & 1023;
    match exponent {
        0 => sign * fraction as f32 / 16777216.0,
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
fn decode(blob: &[u8], dim: usize) -> Result<Vec<f32>> {
    if blob.len() != dim * 2 {
        return Err(invalid(format!(
            "검색 색인 벡터 크기가 올바르지 않습니다 ({dim} f16)."
        )));
    }
    normalize(
        blob.chunks_exact(2)
            .map(|b| half(u16::from_le_bytes([b[0], b[1]])))
            .collect(),
        dim,
    )
    .map_err(invalid)
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct ImportCounts {
    pub siglip: u64,
    pub qwen8b: u64,
    pub skipped: u64,
}

fn import_cache(
    library: &Connection,
    source_path: &Path,
    destination: &Path,
) -> Result<ImportCounts> {
    if destination.exists()
        && std::fs::canonicalize(source_path).ok() == std::fs::canonicalize(destination).ok()
    {
        return Err(invalid("검색 색인 저장소 자체를 가져올 수 없습니다."));
    }
    let source = read_only(source_path)?;
    let _snapshot = source.unchecked_transaction()?;
    let mut meta = metadata(&source)?;
    let tables = [("siglip", SIGLIP_DIM), ("qwen8b", QWEN_DIM)];
    let mut counts = ImportCounts::default();
    let mut exists = library.prepare("SELECT 1 FROM assets WHERE id=?1")?;
    // Validate every row, including unknown ids, before digest skip or publication.
    for (table, dim) in tables {
        if table == "qwen8b" && !has_table(&source, table)? {
            continue;
        }
        let mut stmt = source.prepare(&format!("SELECT asset_id,vector FROM {table}"))?;
        let mut rows = stmt.query([])?;
        let mut seen = HashSet::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            if id.is_empty() || !seen.insert(id.clone()) {
                return Err(invalid("검색 색인 asset_id가 비었거나 중복되었습니다."));
            }
            decode(&blob, dim)?;
            if !exists.exists([&id])? {
                counts.skipped += 1;
            } else if table == "siglip" {
                counts.siglip += 1;
            } else {
                counts.qwen8b += 1;
            }
        }
    }
    if destination.is_file() {
        let current = read_only(destination)?;
        if metadata(&current)
            .ok()
            .and_then(|m| m.get("content_digest").cloned())
            == meta.get("content_digest").cloned()
        {
            return Ok(counts);
        }
    }
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("검색 색인 저장 경로가 없습니다."))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| invalid(format!("검색 색인 폴더를 만들지 못했습니다: {e}")))?;
    let temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| invalid(e.to_string()))?;
    let mut store = Connection::open(temporary.path())?;
    store.execute_batch(SCHEMA)?;
    let tx = store.transaction()?;
    meta.insert("imported_at".into(), chrono::Utc::now().to_rfc3339());
    // The cache always has both tables, even for a SigLIP-only export.
    if !has_table(&source, "qwen8b")? {
        meta.insert("qwen_dim".into(), "4096".into());
        if meta.get("qwen_model").is_none_or(|v| v.is_empty()) {
            meta.insert("qwen_model".into(), "Qwen/Qwen3-VL-Embedding-8B".into());
        }
    }
    for (key, value) in meta {
        tx.execute("INSERT INTO meta VALUES (?1,?2)", params![key, value])?;
    }
    for (table, _) in tables {
        if table == "qwen8b" && !has_table(&source, table)? {
            continue;
        }
        let mut stmt = source.prepare(&format!("SELECT asset_id,vector FROM {table}"))?;
        let mut rows = stmt.query([])?;
        let mut insert = tx.prepare(&format!("INSERT INTO {table} VALUES (?1,?2)"))?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if exists.exists([&id])? {
                insert.execute(params![id, row.get::<_, Vec<u8>>(1)?])?;
            }
        }
    }
    tx.commit()?;
    drop(store);
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| invalid(e.to_string()))?;
    // tempfile::persist replaces atomically on Windows and Unix, after SQLite closes.
    temporary
        .persist(destination)
        .map_err(|e| invalid(format!("검색 색인을 저장하지 못했습니다: {e}")))?;
    Ok(counts)
}

#[derive(Debug, Default)]
pub(crate) struct Runtime {
    index: Mutex<Option<Arc<Index>>>,
}
#[derive(Debug)]
struct Index {
    stamp: (Option<SystemTime>, u64),
    siglip: BTreeMap<String, Vec<f32>>,
    qwen: Option<BTreeMap<String, Vec<f32>>>,
}
fn load_vectors(conn: &Connection, table: &str, dim: usize) -> Result<BTreeMap<String, Vec<f32>>> {
    let mut vectors = BTreeMap::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT asset_id,vector FROM {table} ORDER BY asset_id"
    ))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        vectors.insert(row.get(0)?, decode(&row.get::<_, Vec<u8>>(1)?, dim)?);
    }
    Ok(vectors)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub route: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    pub asset_ids: Vec<String>,
    pub precise: bool,
}
#[derive(Debug)]
pub(crate) struct Routing {
    route: &'static str,
    corpus: HashSet<String>,
    allowed: Option<HashSet<String>>,
    tag_ids: Vec<String>,
}
fn routing(
    conn: &Connection,
    query: &str,
    indexed: &BTreeMap<String, Vec<f32>>,
    limit: usize,
) -> Result<Routing> {
    let _snapshot = conn.unchecked_transaction()?;
    let corpus: HashSet<String> = conn
        .prepare("SELECT id FROM assets WHERE status='normal' AND media_kind IN ('image','gif')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|id| indexed.contains_key(id))
        .collect();
    let mut names: HashMap<String, HashSet<String>> = HashMap::new();
    let mut series: HashMap<String, String> = HashMap::new();
    let mut tags: HashMap<String, HashSet<String>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT t.id,t.display_name,e.name FROM character_targets t LEFT JOIN classification_entries e ON e.id=t.series_classification_id")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let target: String = row.get(0)?;
        for name in row
            .get::<_, String>(1)?
            .split('/')
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            names.entry(name.into()).or_default().insert(target.clone());
        }
        if let Some(name) = row.get::<_, Option<String>>(2)? {
            series.insert(target, name.trim().into());
        }
    }
    for row in conn
        .prepare("SELECT target_id,tag FROM character_target_tagger_tags")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
    {
        let (target, tag) = row?;
        tags.entry(target).or_default().insert(tag);
    }
    let tokens: Vec<_> = query.split_whitespace().collect();
    let hits: Vec<_> = tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| names.contains_key(**token))
        .map(|(i, _)| i)
        .collect();
    let mut absorbed: HashSet<_> = hits.iter().copied().collect();
    let mut hit_tags = HashSet::new();
    for &i in &hits {
        for target in &names[tokens[i]] {
            if let Some(values) = tags.get(target) {
                hit_tags.extend(values.iter().cloned());
            }
            if let Some(name) = series.get(target) {
                for (j, token) in tokens.iter().enumerate() {
                    if *token == name {
                        absorbed.extend(i.min(j)..=i.max(j));
                    }
                }
            }
        }
    }
    let mut scores: HashMap<String, f64> = HashMap::new();
    if !hit_tags.is_empty() {
        let mut stmt = conn.prepare("SELECT asset_id,tag,score FROM asset_auto_tags")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let tag: String = row.get(1)?;
            let score: f64 = row.get(2)?;
            if corpus.contains(&id) && hit_tags.contains(&tag) {
                let current = scores.entry(id).or_insert(0.0);
                *current = current.max(score);
            }
        }
    }
    let mut tag_scores: Vec<_> = scores
        .iter()
        .filter(|(_, score)| **score > 0.0)
        .map(|(id, score)| (id.clone(), *score))
        .collect();
    sort_scores(&mut tag_scores);
    let tag_ids = tag_scores
        .into_iter()
        .take(limit)
        .map(|(id, _)| id)
        .collect();
    let allowed: Option<HashSet<_>> = (!hits.is_empty()).then(|| {
        scores
            .into_iter()
            .filter(|(_, score)| *score >= 0.35)
            .map(|(id, _)| id)
            .collect()
    });
    let route = if !hits.is_empty() && absorbed.len() == tokens.len() {
        "tags"
    } else if allowed.as_ref().is_some_and(HashSet::is_empty) {
        "mixedFallback"
    } else if !hits.is_empty() {
        "mixed"
    } else {
        "cosine"
    };
    Ok(Routing {
        route,
        corpus,
        allowed,
        tag_ids,
    })
}
fn sort_scores(scores: &mut [(String, f64)]) {
    scores.sort_by(|(a, x), (b, y)| y.total_cmp(x).then(a.cmp(b)));
}
fn cosine(
    vectors: &BTreeMap<String, Vec<f32>>,
    query: &[f32],
    routing: &Routing,
) -> Vec<(String, f64)> {
    let mut scores: Vec<_> = vectors
        .iter()
        .filter(|(id, _)| {
            routing.corpus.contains(*id)
                && routing
                    .allowed
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(*id))
        })
        .map(|(id, vector)| {
            (
                id.clone(),
                vector.iter().zip(query).map(|(a, b)| a * b).sum::<f32>() as f64,
            )
        })
        .collect();
    sort_scores(&mut scores);
    scores
}
fn rrf(siglip: &[(String, f64)], qwen: &[(String, f64)]) -> Vec<String> {
    let mut fused: HashMap<String, f64> = HashMap::new();
    for ranking in [siglip, qwen] {
        for (i, (id, _)) in ranking.iter().take(200).enumerate() {
            *fused.entry(id.clone()).or_default() += 1.0 / (60.0 + (i + 1) as f64);
        }
    }
    let mut scores: Vec<_> = fused.into_iter().collect();
    sort_scores(&mut scores);
    scores.into_iter().map(|(id, _)| id).collect()
}
pub(crate) fn unavailable(main: bool, configured: bool, indexed: u64) -> Option<&'static str> {
    if !main {
        Some("메인 PC에서만 쓸 수 있습니다.")
    } else if !configured {
        Some("검색 실행 환경이 설정되지 않았습니다.")
    } else if indexed == 0 {
        Some("검색 색인이 아직 없습니다.")
    } else {
        None
    }
}

impl Library {
    pub(crate) fn nl_search_path(&self) -> PathBuf {
        self.root().join(".cache/nl-search/vectors.sqlite")
    }
    /// Caller owns ingestion_lock, like artist-style automatic inbox dispatch.
    pub(super) fn import_nl_search(&self, path: &Path) -> Result<ImportCounts> {
        let mut index = self
            .nl_search_runtime
            .index
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let counts = import_cache(&*self.connection()?, path, &self.nl_search_path())
            .map_err(|e| invalid(format!("검색 색인을 가져오지 못했습니다: {e}")))?;
        *index = None;
        Ok(counts)
    }
    pub(crate) fn nl_search_counts(&self) -> Result<(u64, u64)> {
        if !self.nl_search_path().is_file() {
            return Ok((0, 0));
        }
        let conn = read_only(&self.nl_search_path())?;
        let _snapshot = conn.unchecked_transaction()?;
        metadata(&conn)?;
        Ok((
            conn.query_row("SELECT count(*) FROM siglip", [], |r| r.get::<_, i64>(0))? as u64,
            if has_table(&conn, "qwen8b")? {
                conn.query_row("SELECT count(*) FROM qwen8b", [], |r| r.get::<_, i64>(0))? as u64
            } else {
                0
            },
        ))
    }
    fn nl_search_index(&self, precise: bool) -> Result<Arc<Index>> {
        let mut current = self
            .nl_search_runtime
            .index
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let path = self.nl_search_path();
        let file = std::fs::metadata(&path)
            .map_err(|e| invalid(format!("검색 색인을 읽지 못했습니다: {e}")))?;
        let stamp = (file.modified().ok(), file.len());
        if let Some(index) = current
            .as_ref()
            .filter(|index| index.stamp == stamp && (!precise || index.qwen.is_some()))
        {
            return Ok(index.clone());
        }
        let conn = read_only(&path)?;
        let _snapshot = conn.unchecked_transaction()?;
        metadata(&conn)?;
        let index = Arc::new(Index {
            stamp,
            siglip: load_vectors(&conn, "siglip", SIGLIP_DIM)?,
            qwen: if precise {
                Some(if has_table(&conn, "qwen8b")? {
                    load_vectors(&conn, "qwen8b", QWEN_DIM)?
                } else {
                    BTreeMap::new()
                })
            } else {
                None
            },
        });
        *current = Some(index.clone());
        Ok(index)
    }
    pub(crate) fn search_description(
        &self,
        query: &str,
        limit: Option<u32>,
        precise: bool,
        embed: impl FnOnce() -> std::result::Result<Embedding, String>,
    ) -> Result<SearchResult> {
        if query.trim().is_empty() {
            return Err(invalid("검색어를 입력해 주세요."));
        }
        let limit = limit.unwrap_or(200).clamp(1, 500) as usize;
        let index = self.nl_search_index(precise)?;
        let routing = routing(&*self.connection()?, query, &index.siglip, limit)?;
        if matches!(routing.route, "tags" | "mixedFallback") {
            return Ok(SearchResult {
                route: routing.route,
                translation: None,
                asset_ids: routing.tag_ids,
                precise: false,
            });
        }
        let response = embed().map_err(invalid)?;
        let siglip = cosine(&index.siglip, &response.siglip, &routing);
        let qwen = precise
            .then(|| index.qwen.as_ref().zip(response.qwen.as_ref()))
            .flatten()
            .map(|(vectors, query)| cosine(vectors, query, &routing))
            .filter(|ranking| !ranking.is_empty());
        let mut asset_ids = if let Some(qwen) = &qwen {
            rrf(&siglip, qwen)
        } else {
            siglip.into_iter().map(|(id, _)| id).collect()
        };
        asset_ids.truncate(limit);
        // A trash/removal during worker inference must not leak stale corpus rows.
        let live = self
            .connection()?
            .prepare(
                "SELECT id FROM assets WHERE status='normal' AND media_kind IN ('image','gif')",
            )?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<HashSet<_>, _>>()?;
        asset_ids.retain(|id| live.contains(id));
        Ok(SearchResult {
            route: routing.route,
            translation: Some(response.translation),
            asset_ids,
            precise: qwen.is_some(),
        })
    }
}

#[cfg(test)]
#[path = "nl_search_tests.rs"]
mod tests;
