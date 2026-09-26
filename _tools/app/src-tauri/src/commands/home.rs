//! PC Home (HOME-DASH-001): the few counts the Home dashboard needs that no other screen reads
//! cheaply. Read-only: one indexed COUNT over the local library and the in-memory server status
//! the sync watcher already keeps. Never touches the network or the credential store.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use super::{background_task_error, current_required, AppState, CommandError};
use crate::library::{error::LibraryError, Library};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeAssetCounts {
    /// Normal (not trashed) assets.
    pub total: i64,
    /// Normal assets collected at or after `todayStart`.
    pub today: i64,
    /// Normal assets collected at or after `weekStart`.
    pub week: i64,
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

/// `collected_at` is stored as UTC `%Y-%m-%dT%H:%M:%fZ` (migration 0026), so a boundary in the
/// same form compares as text and the `(status, collected_at)` index answers both counts.
fn asset_counts(
    c: &Connection,
    today_start: &str,
    week_start: &str,
) -> Result<HomeAssetCounts, LibraryError> {
    let count = |since: Option<&str>| -> Result<i64, LibraryError> {
        Ok(match since {
            Some(since) => c.query_row(
                "SELECT COUNT(*) FROM assets WHERE status='normal' AND collected_at >= ?1",
                params![since],
                |row| row.get(0),
            )?,
            None => c.query_row(
                "SELECT COUNT(*) FROM assets WHERE status='normal'",
                [],
                |row| row.get(0),
            )?,
        })
    };
    Ok(HomeAssetCounts {
        total: count(None)?,
        today: count(Some(today_start))?,
        week: count(Some(week_start))?,
    })
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
    state: State<'_, AppState>,
) -> Result<HomeOverview, CommandError> {
    let today_start = boundary(&today_start)?;
    let week_start = boundary(&week_start)?;
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let assets = asset_counts(&*library.connection()?, &today_start, &week_start)?;
        Ok::<_, LibraryError>(HomeOverview {
            assets,
            server: server_status(&library)?,
        })
    })
    .await
    .map_err(|_| background_task_error())?
    .map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(c: &Connection, id: &str, status: &str, collected_at: &str) {
        c.execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status,favorite)
             VALUES (?1,?1,'image',?1,?1,?1||'.webp',1,1,1,?2,?3,0)",
            params![id, collected_at, status],
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
            insert(c, "old", "normal", "2026-09-20T10:00:00.000Z");
            insert(c, "monday", "normal", "2026-09-21T00:30:00.000Z");
            insert(c, "today", "normal", "2026-09-26T01:00:00.000Z");
            insert(c, "trashed", "trash", "2026-09-26T02:00:00.000Z");
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
                week: 2
            }
        );
    }

    #[test]
    fn rejects_a_malformed_boundary() {
        assert_eq!(
            boundary("yesterday").unwrap_err().code,
            "invalid_home_range"
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
