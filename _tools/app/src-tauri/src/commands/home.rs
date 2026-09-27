//! PC Home (HOME-DASH-001): the few counts the Home dashboard needs that no other screen reads
//! cheaply. Read-only: one indexed COUNT over the local library and the in-memory server status
//! the sync watcher already keeps. Never touches the network or the credential store.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::{
    av_collection::AvHomePerformer, error::LibraryError, tagger_review::TaggerReviewCounts, Library,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeAssetCounts {
    /// Normal (not trashed) assets.
    pub total: i64,
    /// Normal assets collected at or after `todayStart`.
    pub today: i64,
    /// Normal assets collected at or after `weekStart`.
    pub week: i64,
    /// Normal still images, including GIFs, matching the Assets image filter.
    pub images: i64,
    /// Normal videos, matching the Assets video filter.
    pub videos: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeCollectionCounts {
    pub game: i64,
    pub manga: i64,
    pub movie: i64,
    pub av: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeServerStatus {
    /// Cloud sync is enabled with a server address.
    pub configured: bool,
    /// A status watcher holds long-polls to the server right now.
    pub live: bool,
    /// When a status document was last read or confirmed (RFC 3339), if ever in this run.
    pub confirmed_at: Option<String>,
    /// Captures waiting in the server inbox, from that document.
    pub captures_pending: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeOverview {
    pub assets: HomeAssetCounts,
    pub collections: HomeCollectionCounts,
    pub tagger: TaggerReviewCounts,
    pub av_performer: Option<AvHomePerformer>,
    pub server: HomeServerStatus,
}

fn boundary(value: &str) -> Result<String, CommandError> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| {
            parsed
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| CommandError {
            code: "invalid_home_range",
            message: "홈 집계 기간이 올바르지 않습니다.".into(),
        })
}

fn parse_local_date(value: &str) -> Result<NaiveDate, CommandError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| CommandError {
        code: "invalid_home_range",
        message: "홈 집계 날짜가 올바르지 않습니다.".into(),
    })
}

/// `collected_at` is stored as UTC `%Y-%m-%dT%H:%M:%fZ` (migration 0026), so a boundary in the
/// same form compares as text and the `(status, collected_at)` index answers both counts.
fn asset_counts(
    c: &Connection,
    today_start: &str,
    week_start: &str,
) -> Result<HomeAssetCounts, LibraryError> {
    Ok(c.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(collected_at >= ?1),0),
                COALESCE(SUM(collected_at >= ?2),0),
                COALESCE(SUM(media_kind IN ('image','gif')),0),
                COALESCE(SUM(media_kind='video'),0)
         FROM assets WHERE status='normal'",
        params![today_start, week_start],
        |row| {
            Ok(HomeAssetCounts {
                total: row.get(0)?,
                today: row.get(1)?,
                week: row.get(2)?,
                images: row.get(3)?,
                videos: row.get(4)?,
            })
        },
    )?)
}

fn collection_counts(c: &Connection) -> Result<HomeCollectionCounts, LibraryError> {
    Ok(c.query_row(
        "SELECT COALESCE(SUM(type='game'),0),COALESCE(SUM(type='manga'),0),
                COALESCE(SUM(type='movie'),0),COALESCE(SUM(type='av'),0)
         FROM collections",
        [],
        |row| {
            Ok(HomeCollectionCounts {
                game: row.get(0)?,
                manga: row.get(1)?,
                movie: row.get(2)?,
                av: row.get(3)?,
            })
        },
    )?)
}

fn server_status(library: &Library) -> Result<HomeServerStatus, LibraryError> {
    let config = library.cloud_sync_config()?;
    let endpoint = config.api_base_url.filter(|_| config.enabled);
    let observed = endpoint
        .as_deref()
        .and_then(crate::cloud::status_watch::observed);
    Ok(HomeServerStatus {
        configured: endpoint.is_some(),
        live: observed.is_some_and(|(live, _, _)| live),
        confirmed_at: observed
            .and_then(|(_, at, _)| DateTime::<Utc>::from_timestamp(at, 0))
            .map(|at| at.to_rfc3339_opts(SecondsFormat::Secs, true)),
        captures_pending: observed.and_then(|(_, _, pending)| pending),
    })
}

/// Asset totals for 자산 현황 and the server's last known state for 연결 / 처리 대기.
/// `todayStart` and `weekStart` are the local midnight of today and of this week's Monday,
/// as instants (the webview knows the display time zone).
#[tauri::command]
pub async fn get_home_overview(
    today_start: String,
    week_start: String,
    local_date: String,
    state: State<'_, AppState>,
) -> Result<HomeOverview, CommandError> {
    let today_start = boundary(&today_start)?;
    let week_start = boundary(&week_start)?;
    let local_date = parse_local_date(&local_date)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (assets, collections) = {
            let connection = library.connection()?;
            (
                asset_counts(&connection, &today_start, &week_start)?,
                collection_counts(&connection)?,
            )
        };
        Ok::<_, CommandError>(HomeOverview {
            assets,
            collections,
            tagger: library.tagger_review_counts()?,
            av_performer: library.home_av_performer(local_date)?,
            server: server_status(&library)?,
        })
    })
    .await
    .map_err(|_| background_task_error())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(c: &Connection, id: &str, status: &str, collected_at: &str, kind: &str) {
        c.execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status,favorite)
             VALUES (?1,?1,?4,?1,?1,?1||'.webp',1,1,1,?2,?3,0)",
            params![id, collected_at, status, kind],
        )
        .unwrap();
    }

    #[test]
    fn counts_normal_assets_since_each_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        {
            let guard = library.connection().unwrap();
            let c: &Connection = &guard;
            insert(c, "old", "normal", "2026-09-20T10:00:00.000Z", "image");
            insert(c, "monday", "normal", "2026-09-21T00:30:00.000Z", "gif");
            insert(c, "today", "normal", "2026-09-26T01:00:00.000Z", "video");
            insert(c, "trashed", "trash", "2026-09-26T02:00:00.000Z", "image");
        }
        let today = boundary("2026-09-26T00:00:00+09:00").unwrap();
        let week = boundary("2026-09-21T00:00:00+09:00").unwrap();
        assert_eq!(today, "2026-09-25T15:00:00.000Z");
        let counts = asset_counts(&*library.connection().unwrap(), &today, &week).unwrap();
        assert_eq!(
            counts,
            HomeAssetCounts {
                total: 3,
                today: 1,
                week: 2,
                images: 2,
                videos: 1,
            }
        );
    }

    #[test]
    fn rejects_a_malformed_boundary() {
        assert_eq!(
            boundary("yesterday").unwrap_err().code,
            "invalid_home_range"
        );
        assert_eq!(
            parse_local_date("09/26/2026").unwrap_err().code,
            "invalid_home_range"
        );
    }

    #[test]
    fn counts_collections_by_index_type() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute_batch(
                "INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
             ('g','Game','game','t','t'),('m','Manga','manga','t','t'),
             ('f','Movie','movie','t','t'),('a1','AV 1','av','t','t'),('a2','AV 2','av','t','t');",
            )
            .unwrap();
        assert_eq!(
            collection_counts(&connection).unwrap(),
            HomeCollectionCounts {
                game: 1,
                manga: 1,
                movie: 1,
                av: 2,
            }
        );
    }

    #[test]
    fn server_status_is_unconfigured_without_cloud_sync() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        let status = server_status(&library).unwrap();
        assert_eq!(
            status,
            HomeServerStatus {
                configured: false,
                live: false,
                confirmed_at: None,
                captures_pending: None
            }
        );
    }
}
