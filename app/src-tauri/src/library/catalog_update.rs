use std::{
    collections::BTreeSet,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::AppHandle;

use crate::catalog_transport::{search_page_path, CatalogTransport};

use super::{
    error::LibraryError,
    models::{CatalogUpdateResult, CatalogUpdateStopReason},
    Library,
};

const REMOTE_PAGE_SIZE: usize = 50;
const MAX_REMOTE_TEXT_BYTES: usize = 1_000_000;
const MAX_UPDATE_PAGES: u32 = 40;
const WATERMARK_KEY: &str = "lakomics_update_watermark";
const CURSOR_KEY: &str = "lakomics_update_cursor";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UpdateCheckpoint {
    watermark: u64,
    cursor: u64,
}

#[derive(Default)]
pub(crate) struct CatalogUpdateState {
    running: AtomicBool,
}

pub(crate) struct CatalogUpdateGuard<'a>(&'a AtomicBool);

impl Drop for CatalogUpdateGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl CatalogUpdateState {
    pub(crate) fn begin(&self) -> Option<CatalogUpdateGuard<'_>> {
        self.running
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| CatalogUpdateGuard(&self.running))
    }
}

#[derive(Debug)]
pub(crate) struct RemoteCatalogPage {
    pub(crate) works: Vec<RemoteWork>,
    pub(crate) lowest_id: Option<u64>,
    pub(crate) is_last_page: bool,
}

#[derive(Debug)]
pub(crate) struct RemoteWork {
    id: u64,
    token: Option<String>,
    title: String,
    title_jpn: Option<String>,
    category: Option<i64>,
    uploader: Option<String>,
    posted: Option<i64>,
    updated: Option<i64>,
    file_count: i64,
    file_size: Option<i64>,
    rating: Option<f64>,
    views: i64,
    thumb: Option<String>,
    thumb_extension: Option<String>,
    expunged: bool,
    blocked: bool,
    archived: bool,
    torrent_count: i64,
    parent_gid: Option<i64>,
    parent_key: Option<String>,
    current_gid: Option<i64>,
    current_key: Option<String>,
    first_gid: Option<i64>,
    first_key: Option<String>,
    tags: Vec<(String, String)>,
    raw_json: String,
}

impl RemoteCatalogPage {
    pub(crate) fn parse(body: &str) -> Result<Self, LibraryError> {
        let values: Vec<Value> =
            serde_json::from_str(body).map_err(|_| LibraryError::InvalidOnlineCatalog)?;
        let mut works = Vec::with_capacity(values.len());
        for value in &values {
            if let Some(work) = RemoteWork::parse(value)? {
                works.push(work);
            }
        }
        Ok(Self {
            lowest_id: works.iter().map(|work| work.id).min(),
            is_last_page: values.len() < REMOTE_PAGE_SIZE,
            works,
        })
    }
}

pub(crate) fn next_page_cursor(page: &RemoteCatalogPage, known_max_id: u64) -> Option<u64> {
    page.lowest_id
        .filter(|lowest_id| !page.is_last_page && *lowest_id > known_max_id)
}

pub(crate) fn is_update_due(
    enabled: bool,
    interval_seconds: u64,
    last_attempt_at: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    if !enabled {
        return false;
    }
    last_attempt_at
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_none_or(|last| now.signed_duration_since(last).num_seconds() >= interval_seconds as i64)
}

pub(crate) async fn execute_catalog_update(
    library: Library,
    transport: &CatalogTransport,
    app: &AppHandle,
    vps_base_url: Option<String>,
) -> Result<CatalogUpdateResult, LibraryError> {
    let attempted_at = chrono::Utc::now().to_rfc3339();
    library.record_catalog_update_attempt(&attempted_at)?;
    match run_catalog_update(&library, transport, app, vps_base_url).await {
        Ok(mut result) if result.reason == CatalogUpdateStopReason::RateLimited => {
            library.rebuild_catalog_suggestions()?;
            library.record_catalog_update_error("온라인 카탈로그 요청 한도를 초과했습니다")?;
            result.last_success_at = library.catalog_status()?.last_success_at;
            Ok(result)
        }
        Ok(mut result) => {
            library.rebuild_catalog_suggestions()?;
            let completed_at = chrono::Utc::now().to_rfc3339();
            library.record_catalog_update_success(&completed_at, result.added)?;
            result.last_success_at = Some(completed_at);
            Ok(result)
        }
        Err(error) => {
            let _ = library.record_catalog_update_error(&error.to_string());
            Err(error)
        }
    }
}

async fn run_catalog_update(
    library: &Library,
    transport: &CatalogTransport,
    app: &AppHandle,
    vps_base_url: Option<String>,
) -> Result<CatalogUpdateResult, LibraryError> {
    let catalog_path = library.root().join("catalogs/kdata.db");
    if !catalog_path.exists() {
        return Err(LibraryError::OnlineCatalogNotInstalled);
    }
    let lookup_path = catalog_path.clone();
    let checkpoint = tauri::async_runtime::spawn_blocking(move || load_checkpoint(&lookup_path))
        .await
        .map_err(|_| LibraryError::CatalogTransportUnavailable)??;
    let lookup_path = catalog_path.clone();
    let known_max_id = if let Some(checkpoint) = checkpoint {
        checkpoint.watermark
    } else {
        tauri::async_runtime::spawn_blocking(move || highest_stored_id(&lookup_path))
            .await
            .map_err(|_| LibraryError::CatalogTransportUnavailable)??
    };
    let mut cursor = checkpoint.map(|checkpoint| checkpoint.cursor);
    let resuming = checkpoint.is_some();
    let mut added = 0;
    let mut pages = 0;
    // VPS base url이 있으면 PC가 k-hentai에 직접 닿지 않는다. 없으면 기존
    // WebView2 전송을 그대로 쓴다(Phase 1: 전송만 교체, 데이터 모델 무변경).
    // VPS 인증은 기존 Cloud Capture와 같은 Bearer 토큰을 재사용한다.
    let vps_source = match vps_base_url.as_deref() {
        Some(base_url) => {
            let cloud_token = crate::library::credential::read_cloud_api_token_os()?;
            Some((
                crate::catalog_source::VpsCatalogSource::new(base_url)?,
                cloud_token,
            ))
        }
        None => None,
    };

    while pages < MAX_UPDATE_PAGES {
        let body = if let Some((vps, token)) = &vps_source {
            // VPS 전송은 Lakomics VPS API 경로(/v1/catalog/search-page)만 안다.
            // k-hentai 업스트림 경로는 WebView2 직접 전송 전용이다.
            crate::catalog_source::retry_transient(|| vps.fetch_search_page_bearer(cursor, token))
                .await?
        } else {
            let Some(body) = fetch_with_retry(transport, app, &search_page_path(cursor)).await?
            else {
                return Ok(CatalogUpdateResult {
                    added,
                    pages,
                    reason: CatalogUpdateStopReason::RateLimited,
                    last_success_at: None,
                });
            };
            body
        };
        let page = RemoteCatalogPage::parse(&body)?;
        pages += 1;
        if !resuming
            && pages == 1
            && page
                .works
                .iter()
                .map(|work| work.id)
                .max()
                .is_none_or(|site_max_id| site_max_id <= known_max_id)
        {
            return Ok(CatalogUpdateResult {
                added: 0,
                pages,
                reason: CatalogUpdateStopReason::UpToDate,
                last_success_at: None,
            });
        }

        let next_cursor = next_page_cursor(&page, known_max_id);
        let fresh = page
            .works
            .into_iter()
            .filter(|work| work.id > known_max_id)
            .collect::<Vec<_>>();
        if !fresh.is_empty() || next_cursor.is_some() {
            let write_path = catalog_path.clone();
            let crawled_at = chrono::Utc::now().timestamp();
            added += tauri::async_runtime::spawn_blocking(move || {
                write_catalog_page_with_checkpoint(
                    &write_path,
                    &fresh,
                    crawled_at,
                    next_cursor.map(|cursor| UpdateCheckpoint {
                        watermark: known_max_id,
                        cursor,
                    }),
                )
            })
            .await
            .map_err(|_| LibraryError::CatalogTransportUnavailable)??;
        }
        let Some(next_cursor) = next_cursor else {
            let clear_path = catalog_path.clone();
            tauri::async_runtime::spawn_blocking(move || clear_checkpoint(&clear_path))
                .await
                .map_err(|_| LibraryError::CatalogTransportUnavailable)??;
            return Ok(CatalogUpdateResult {
                added,
                pages,
                reason: CatalogUpdateStopReason::Completed,
                last_success_at: None,
            });
        };
        cursor = Some(next_cursor);
        delay(std::time::Duration::from_millis(400)).await?;
    }

    Ok(CatalogUpdateResult {
        added,
        pages,
        reason: CatalogUpdateStopReason::PageLimit,
        last_success_at: None,
    })
}

async fn fetch_with_retry(
    transport: &CatalogTransport,
    app: &AppHandle,
    path: &str,
) -> Result<Option<String>, LibraryError> {
    for attempt in 0..3 {
        match transport.fetch_text(app, path).await {
            Ok(body) => return Ok(Some(body)),
            Err(LibraryError::CatalogTransportRejected(429)) if attempt == 2 => return Ok(None),
            Err(error) if attempt == 2 => return Err(error),
            Err(_) => {
                delay(std::time::Duration::from_millis(750 * (1 << attempt))).await?;
            }
        }
    }
    unreachable!()
}

async fn delay(duration: std::time::Duration) -> Result<(), LibraryError> {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .map_err(|_| LibraryError::CatalogTransportUnavailable)
}

impl RemoteWork {
    fn parse(value: &Value) -> Result<Option<Self>, LibraryError> {
        let Some(object) = value.as_object() else {
            return Ok(None);
        };
        let Some(id) = object
            .get("id")
            .and_then(number)
            .and_then(|id| u64::try_from(id).ok())
        else {
            return Ok(None);
        };
        if id == 0 {
            return Ok(None);
        }
        let raw_json =
            serde_json::to_string(value).map_err(|_| LibraryError::InvalidOnlineCatalog)?;
        let tags = parse_tags(object.get("tags"))?;
        Ok(Some(Self {
            id,
            token: text(object.get("token"))?,
            title: text(object.get("title"))?.unwrap_or_default(),
            title_jpn: text(object.get("title_jpn"))?,
            category: object.get("category").and_then(number),
            uploader: text(object.get("uploader"))?,
            posted: object.get("posted").and_then(number),
            updated: object.get("updated").and_then(number),
            file_count: object.get("filecount").and_then(number).unwrap_or(0),
            file_size: object.get("filesize").and_then(number),
            rating: object.get("rating").and_then(decimal),
            views: object.get("views").and_then(number).unwrap_or(0),
            thumb: text(object.get("thumb"))?,
            thumb_extension: text(object.get("thumb_extension"))?,
            expunged: boolean(object.get("expunged")),
            blocked: boolean(object.get("blocked")),
            archived: boolean(object.get("archived")),
            torrent_count: object.get("torrentcount").and_then(number).unwrap_or(0),
            parent_gid: object.get("parent_gid").and_then(number),
            parent_key: text(object.get("parent_key"))?,
            current_gid: object.get("current_gid").and_then(number),
            current_key: text(object.get("current_key"))?,
            first_gid: object.get("first_gid").and_then(number),
            first_key: text(object.get("first_key"))?,
            tags,
            raw_json,
        }))
    }
}

fn text(value: Option<&Value>) -> Result<Option<String>, LibraryError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let value = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return Err(LibraryError::InvalidOnlineCatalog),
    };
    if value.len() > MAX_REMOTE_TEXT_BYTES {
        return Err(LibraryError::InvalidOnlineCatalog);
    }
    Ok((!value.is_empty()).then_some(value))
}

fn number(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.parse().ok())
}

fn decimal(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
}

fn boolean(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
        || value.and_then(number) == Some(1)
        || value.and_then(Value::as_str) == Some("1")
}

fn parse_tags(value: Option<&Value>) -> Result<Vec<(String, String)>, LibraryError> {
    let mut tags = BTreeSet::new();
    let Some(entries) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    for entry in entries {
        let Some(pair) = entry.get("tag").and_then(Value::as_array) else {
            continue;
        };
        let Some(namespace) = text(pair.first())? else {
            continue;
        };
        let Some(value) = text(pair.get(1))? else {
            continue;
        };
        tags.insert((namespace.trim().to_owned(), value.trim().to_owned()));
    }
    Ok(tags
        .into_iter()
        .filter(|(namespace, value)| !namespace.is_empty() && !value.is_empty())
        .collect())
}

pub(crate) fn highest_stored_id(path: &Path) -> Result<u64, LibraryError> {
    Ok(
        Connection::open(path)?.query_row("SELECT COALESCE(MAX(Id), 0) FROM Works", [], |row| {
            row.get::<_, i64>(0)
        })? as u64,
    )
}

#[cfg(test)]
pub(crate) fn write_catalog_page(
    path: &Path,
    works: &[RemoteWork],
    crawled_at: i64,
) -> Result<u64, LibraryError> {
    write_catalog_page_with_checkpoint(path, works, crawled_at, None)
}

fn write_catalog_page_with_checkpoint(
    path: &Path,
    works: &[RemoteWork],
    crawled_at: i64,
    checkpoint: Option<UpdateCheckpoint>,
) -> Result<u64, LibraryError> {
    let mut connection = Connection::open(path)?;
    let transaction = connection.transaction()?;
    for work in works {
        let work_id = work.id as i64;
        transaction.execute(
            "INSERT INTO Works (
                Id, Token, Title, TitleJpn, Category, Uploader, Posted, Updated,
                FileCount, FileSize, Rating, Views, Thumb, ThumbExtension,
                Expunged, Blocked, Archived, TorrentCount, ParentGid, ParentKey,
                CurrentGid, CurrentKey, FirstGid, FirstKey, RawJson, CrawledAt
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26
             ) ON CONFLICT(Id) DO UPDATE SET
                Token=excluded.Token, Title=excluded.Title, TitleJpn=excluded.TitleJpn,
                Category=excluded.Category, Uploader=excluded.Uploader, Posted=excluded.Posted,
                Updated=excluded.Updated, FileCount=excluded.FileCount, FileSize=excluded.FileSize,
                Rating=excluded.Rating, Views=excluded.Views, Thumb=excluded.Thumb,
                ThumbExtension=excluded.ThumbExtension, Expunged=excluded.Expunged,
                Blocked=excluded.Blocked, Archived=excluded.Archived,
                TorrentCount=excluded.TorrentCount, ParentGid=excluded.ParentGid,
                ParentKey=excluded.ParentKey, CurrentGid=excluded.CurrentGid,
                CurrentKey=excluded.CurrentKey, FirstGid=excluded.FirstGid,
                FirstKey=excluded.FirstKey, RawJson=excluded.RawJson, CrawledAt=excluded.CrawledAt",
            params![
                work_id,
                work.token,
                work.title,
                work.title_jpn,
                work.category,
                work.uploader,
                work.posted,
                work.updated,
                work.file_count,
                work.file_size,
                work.rating,
                work.views,
                work.thumb,
                work.thumb_extension,
                work.expunged,
                work.blocked,
                work.archived,
                work.torrent_count,
                work.parent_gid,
                work.parent_key,
                work.current_gid,
                work.current_key,
                work.first_gid,
                work.first_key,
                work.raw_json,
                crawled_at,
            ],
        )?;
        transaction.execute("DELETE FROM Tags WHERE WorkId = ?1", [work_id])?;
        for (namespace, value) in &work.tags {
            transaction.execute(
                "INSERT OR IGNORE INTO Tags (WorkId, Namespace, Value) VALUES (?1, ?2, ?3)",
                params![work_id, namespace, value],
            )?;
        }
    }
    if let Some(checkpoint) = checkpoint {
        for (key, value) in [
            (WATERMARK_KEY, checkpoint.watermark),
            (CURSOR_KEY, checkpoint.cursor),
        ] {
            transaction.execute(
                "INSERT INTO CrawlState (Key, Value) VALUES (?1, ?2)
                 ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value",
                params![key, value.to_string()],
            )?;
        }
    } else {
        transaction.execute(
            "DELETE FROM CrawlState WHERE Key IN (?1, ?2)",
            params![WATERMARK_KEY, CURSOR_KEY],
        )?;
    }
    transaction.commit()?;
    Ok(works.len() as u64)
}

fn load_checkpoint(path: &Path) -> Result<Option<UpdateCheckpoint>, LibraryError> {
    let connection = Connection::open(path)?;
    let value = |key| -> Result<Option<u64>, LibraryError> {
        Ok(connection
            .query_row(
                "SELECT Value FROM CrawlState WHERE Key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse().ok()))
    };
    Ok(match (value(WATERMARK_KEY)?, value(CURSOR_KEY)?) {
        (Some(watermark), Some(cursor)) => Some(UpdateCheckpoint { watermark, cursor }),
        _ => None,
    })
}

fn clear_checkpoint(path: &Path) -> Result<(), LibraryError> {
    Connection::open(path)?.execute(
        "DELETE FROM CrawlState WHERE Key IN (?1, ?2)",
        params![WATERMARK_KEY, CURSOR_KEY],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::Library;
    use super::{
        highest_stored_id, is_update_due, load_checkpoint, next_page_cursor, write_catalog_page,
        write_catalog_page_with_checkpoint, CatalogUpdateState, RemoteCatalogPage,
        UpdateCheckpoint,
    };
    use rusqlite::Connection;

    const SCHEMA: &str = r#"
        CREATE TABLE Works (
          Id INTEGER PRIMARY KEY, Token TEXT, Title TEXT NOT NULL DEFAULT '', TitleJpn TEXT,
          Category INTEGER, Uploader TEXT, Posted INTEGER, Updated INTEGER,
          FileCount INTEGER NOT NULL DEFAULT 0, FileSize INTEGER, Rating INTEGER,
          Views INTEGER NOT NULL DEFAULT 0, Thumb TEXT, ThumbExtension TEXT,
          Expunged INTEGER NOT NULL DEFAULT 0, Blocked INTEGER NOT NULL DEFAULT 0,
          Archived INTEGER NOT NULL DEFAULT 0, TorrentCount INTEGER NOT NULL DEFAULT 0,
          ParentGid INTEGER, ParentKey TEXT, CurrentGid INTEGER, CurrentKey TEXT,
          FirstGid INTEGER, FirstKey TEXT, RawJson TEXT NOT NULL, CrawledAt INTEGER NOT NULL
        );
        CREATE TABLE Tags (
          WorkId INTEGER NOT NULL, Namespace TEXT NOT NULL, Value TEXT NOT NULL,
          PRIMARY KEY (WorkId, Namespace, Value)
        ) WITHOUT ROWID;
        CREATE TABLE CrawlState (Key TEXT PRIMARY KEY, Value TEXT);
    "#;

    fn catalog() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("kdata.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch(SCHEMA)
            .unwrap();
        (directory, path)
    }

    fn page(ids: &[u64]) -> String {
        serde_json::to_string(
            &ids.iter()
                .map(|id| {
                    serde_json::json!({
                        "id": id,
                        "token": format!("token-{id}"),
                        "title": format!("work-{id}"),
                        "title_jpn": format!("작품-{id}"),
                        "category": 2,
                        "posted": 1_700_000_000,
                        "filecount": 12,
                        "views": 34,
                        "tags": [
                            { "tag": ["language", "korean"] },
                            { "tag": ["artist", format!("artist-{id}")] }
                        ]
                    })
                })
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }

    #[test]
    fn parses_remote_page_and_preserves_raw_work_json() {
        let parsed = RemoteCatalogPage::parse(&page(&[120, 110])).unwrap();

        assert_eq!(parsed.lowest_id, Some(110));
        assert!(parsed.is_last_page);
        assert_eq!(parsed.works[0].id, 120);
        assert_eq!(parsed.works[0].title_jpn.as_deref(), Some("작품-120"));
        assert_eq!(parsed.works[0].tags.len(), 2);
        assert!(parsed.works[0].raw_json.contains("\"token\":\"token-120\""));
    }

    #[test]
    fn rejects_non_array_and_oversized_text_responses() {
        assert!(RemoteCatalogPage::parse(r#"{"id":1}"#).is_err());
        let oversized = "x".repeat(1_000_001);
        let body = serde_json::json!([{ "id": 1, "title": oversized }]).to_string();
        assert!(RemoteCatalogPage::parse(&body).is_err());
    }

    #[test]
    fn commits_a_complete_page_and_replaces_tags_on_upsert() {
        let (_directory, path) = catalog();
        let first = RemoteCatalogPage::parse(&page(&[120, 110])).unwrap();
        assert_eq!(
            write_catalog_page(&path, &first.works, 1_800_000_000).unwrap(),
            2
        );

        let replacement = serde_json::json!([{
            "id": 120,
            "title": "revised",
            "tags": [{ "tag": ["group", "new-group"] }]
        }])
        .to_string();
        let replacement = RemoteCatalogPage::parse(&replacement).unwrap();
        assert_eq!(
            write_catalog_page(&path, &replacement.works, 1_800_000_001).unwrap(),
            1
        );

        let connection = Connection::open(&path).unwrap();
        assert_eq!(highest_stored_id(&path).unwrap(), 120);
        assert_eq!(
            connection
                .query_row("SELECT Title FROM Works WHERE Id = 120", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "revised"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM Tags WHERE WorkId = 120", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT Value FROM Tags WHERE WorkId = 120", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "new-group"
        );
    }

    #[test]
    fn committed_page_keeps_the_original_watermark_and_next_cursor_for_resume() {
        let (_directory, path) = catalog();
        let parsed = RemoteCatalogPage::parse(&page(&[150, 140])).unwrap();

        write_catalog_page_with_checkpoint(
            &path,
            &parsed.works,
            1_800_000_000,
            Some(UpdateCheckpoint {
                watermark: 100,
                cursor: 140,
            }),
        )
        .unwrap();

        assert_eq!(highest_stored_id(&path).unwrap(), 150);
        assert_eq!(
            load_checkpoint(&path).unwrap(),
            Some(UpdateCheckpoint {
                watermark: 100,
                cursor: 140,
            })
        );
    }

    #[test]
    fn duplicate_pages_do_not_create_duplicate_rows() {
        let (_directory, path) = catalog();
        let parsed = RemoteCatalogPage::parse(&page(&[120, 110])).unwrap();
        write_catalog_page(&path, &parsed.works, 1_800_000_000).unwrap();
        write_catalog_page(&path, &parsed.works, 1_800_000_001).unwrap();

        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn rejects_an_overlapping_catalog_update() {
        let state = CatalogUpdateState::default();
        let first = state.begin().unwrap();
        assert!(state.begin().is_none());
        drop(first);
        assert!(state.begin().is_some());
    }

    #[test]
    fn due_check_skips_disabled_and_fresh_catalogs() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-22T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(!is_update_due(false, 3_600, None, now));
        assert!(!is_update_due(
            true,
            3_600,
            Some("2026-08-22T11:30:01Z"),
            now
        ));
        assert!(is_update_due(
            true,
            3_600,
            Some("2026-08-22T10:59:59Z"),
            now
        ));
    }

    #[test]
    fn cursor_advances_until_a_page_reaches_the_watermark() {
        let first =
            RemoteCatalogPage::parse(&page(&(101..=150).rev().collect::<Vec<_>>())).unwrap();
        assert_eq!(next_page_cursor(&first, 100), Some(101));
        let second = RemoteCatalogPage::parse(&page(&[100, 99])).unwrap();
        assert_eq!(next_page_cursor(&second, 100), None);
    }

    #[test]
    fn update_settings_enforce_the_minimum_interval() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();

        assert!(library.set_catalog_update_settings(true, 59).is_err());
        let status = library.set_catalog_update_settings(false, 21_600).unwrap();
        assert!(!status.update_enabled);
        assert_eq!(status.update_interval_seconds, 21_600);
    }
}
