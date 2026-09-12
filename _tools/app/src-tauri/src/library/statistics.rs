use super::{error::LibraryError, revisit::parse_utc_timestamp, Library};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Component, Path},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticCount {
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatistic {
    pub id: String,
    pub label: String,
    pub count: i64,
    pub last_opened_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStatistic {
    pub local_date: String,
    pub asset_opens: i64,
    pub collection_opens: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivativeStorage {
    pub measured_bytes: u64,
    pub measured_files: u64,
    pub unavailable_files: u64,
    pub scan_limit_reached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStatistics {
    pub assets: i64,
    pub collections: i64,
    pub favorites: i64,
    pub unclassified: i64,
    pub original_recorded_bytes: i64,
    pub media_kinds: Vec<StatisticCount>,
    pub collected_months: Vec<StatisticCount>,
    pub creators: Vec<StatisticCount>,
    pub classifications: Vec<StatisticCount>,
    pub collection_and_daily_started_at: String,
    pub most_opened_assets: Vec<ActivityStatistic>,
    pub most_opened_collections: Vec<ActivityStatistic>,
    pub long_unseen_assets: Vec<ActivityStatistic>,
    pub daily: Vec<DailyStatistic>,
}

fn counts(connection: &Connection, sql: &str) -> Result<Vec<StatisticCount>, LibraryError> {
    Ok(connection
        .prepare(sql)?
        .query_map([], |row| {
            Ok(StatisticCount {
                label: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}
fn activity(connection: &Connection, sql: &str) -> Result<Vec<ActivityStatistic>, LibraryError> {
    Ok(connection
        .prepare(sql)?
        .query_map([], |row| {
            Ok(ActivityStatistic {
                id: row.get(0)?,
                label: row.get(1)?,
                count: row.get(2)?,
                last_opened_at: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

// File lengths are measured only for registered Asset derivatives; do not walk the
// vault, follow arbitrary database paths outside it, or call cached sizes actual use.
const DERIVATIVE_SCAN_LIMIT: usize = 10_000;

fn derivative_paths(connection: &Connection) -> Result<(Vec<String>, bool), LibraryError> {
    let mut paths = HashSet::new();
    let mut statement = connection.prepare("SELECT thumbnail_relative_path FROM assets WHERE status = 'normal' AND thumbnail_relative_path IS NOT NULL
        UNION SELECT poster_relative_path FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE a.status='normal' AND poster_relative_path IS NOT NULL
        UNION SELECT proxy_relative_path FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE a.status='normal' AND proxy_relative_path IS NOT NULL LIMIT ?1")?;
    for path in statement.query_map([DERIVATIVE_SCAN_LIMIT as i64 + 1], |row| {
        row.get::<_, String>(0)
    })? {
        paths.insert(path?);
    }
    if paths.len() <= DERIVATIVE_SCAN_LIMIT {
        let mut statement = connection.prepare("SELECT scrub_relative_dir, scrub_frame_count FROM video_assets v JOIN assets a ON a.id=v.asset_id WHERE a.status='normal' AND scrub_relative_dir IS NOT NULL ORDER BY v.asset_id")?;
        'videos: for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })? {
            let (directory, count) = row?;
            for index in 0..count.max(0) {
                paths.insert(format!("{directory}/{index:03}.webp"));
                if paths.len() > DERIVATIVE_SCAN_LIMIT {
                    break 'videos;
                }
            }
        }
    }
    let exceeded = paths.len() > DERIVATIVE_SCAN_LIMIT;
    let mut paths: Vec<_> = paths.into_iter().collect();
    paths.sort();
    paths.truncate(DERIVATIVE_SCAN_LIMIT);
    Ok((paths, exceeded))
}

fn measure_derivatives(
    paths: Vec<String>,
    scan_limit_reached: bool,
    root: &Path,
) -> DerivativeStorage {
    let mut result = DerivativeStorage::default();
    result.scan_limit_reached = scan_limit_reached;
    let canonical_root = root.canonicalize().ok();
    for relative in paths {
        let safe = Path::new(&relative)
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
        let file = if safe {
            root.join(&relative).canonicalize().ok()
        } else {
            None
        };
        let metadata = file
            .filter(|path| {
                canonical_root
                    .as_ref()
                    .is_some_and(|base| path.starts_with(base))
            })
            .and_then(|path| std::fs::metadata(path).ok())
            .filter(|metadata| metadata.is_file());
        if let Some(metadata) = metadata {
            result.measured_bytes += metadata.len();
            result.measured_files += 1;
        } else {
            result.unavailable_files += 1;
        }
    }
    result
}

fn inventory(connection: &Connection) -> Result<LibraryStatistics, LibraryError> {
    let (assets, favorites, original_recorded_bytes) = connection.query_row(
        "SELECT COUNT(*), COALESCE(SUM(favorite),0), COALESCE(SUM(byte_size),0) FROM assets WHERE status='normal'", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(LibraryStatistics {
        assets, favorites, original_recorded_bytes,
        collections: connection.query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))?,
        unclassified: connection.query_row("SELECT COUNT(*) FROM assets a WHERE status='normal' AND NOT EXISTS (SELECT 1 FROM asset_classifications c WHERE c.asset_id=a.id)", [], |row| row.get(0))?,
        media_kinds: counts(connection, "SELECT media_kind, COUNT(*) FROM assets WHERE status='normal' GROUP BY media_kind ORDER BY COUNT(*) DESC, media_kind")?,
        collected_months: counts(connection, "SELECT strftime('%Y-%m', collected_at, 'localtime') AS month, COUNT(*) FROM assets WHERE status='normal' AND month IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 24")?,
        creators: counts(connection, "SELECT COALESCE(NULLIF(MAX(creator_name),''), NULLIF(creator_handle,''), creator_url), COUNT(*) FROM assets WHERE status='normal' AND COALESCE(NULLIF(creator_handle,''), NULLIF(creator_url,'')) IS NOT NULL GROUP BY COALESCE(NULLIF(creator_handle,''), NULLIF(creator_url,'')) ORDER BY COUNT(*) DESC, 1 LIMIT 10")?,
        classifications: counts(connection, "SELECT c.name, COUNT(*) FROM asset_classifications l JOIN classification_entries c ON c.id=l.classification_id JOIN assets a ON a.id=l.asset_id WHERE a.status='normal' GROUP BY c.id ORDER BY COUNT(*) DESC, c.name, c.id LIMIT 10")?,
        collection_and_daily_started_at: connection.query_row("SELECT started_at FROM activity_telemetry WHERE singleton=1", [], |row| row.get(0))?,
        most_opened_assets: activity(connection, "SELECT a.id, COALESCE(NULLIF(a.title,''), a.original_name), h.open_count, h.last_opened_at FROM asset_activity h JOIN assets a ON a.id=h.asset_id WHERE a.status='normal' AND h.open_count>0 AND h.last_opened_at IS NOT NULL ORDER BY h.open_count DESC, h.last_opened_at DESC, a.id LIMIT 10")?,
        most_opened_collections: activity(connection, "SELECT c.id, c.name, h.open_count, h.last_opened_at FROM collection_activity h JOIN collections c ON c.id=h.collection_id ORDER BY h.open_count DESC, h.last_opened_at DESC, c.id LIMIT 10")?,
        long_unseen_assets: activity(connection, "SELECT a.id, COALESCE(NULLIF(a.title,''), a.original_name), h.open_count, h.last_opened_at FROM asset_activity h JOIN assets a ON a.id=h.asset_id WHERE a.status='normal' AND h.open_count>0 AND julianday(h.last_opened_at) < julianday('now', '-30 days') ORDER BY julianday(h.last_opened_at), a.id LIMIT 10")?,
        daily: connection.prepare("SELECT local_date, SUM(CASE WHEN entity_kind='asset' THEN open_count ELSE 0 END), SUM(CASE WHEN entity_kind='collection' THEN open_count ELSE 0 END) FROM activity_daily WHERE local_date >= date('now','localtime','-29 days') GROUP BY local_date ORDER BY local_date DESC LIMIT 30")?
            .query_map([], |row| Ok(DailyStatistic { local_date: row.get(0)?, asset_opens: row.get(1)?, collection_opens: row.get(2)? }))?.collect::<Result<_, _>>()?,
    })
}

pub(crate) fn record_collection_opened(
    connection: &Connection,
    collection_id: &str,
    opened_at: &str,
) -> Result<(), LibraryError> {
    let timestamp = parse_utc_timestamp(opened_at)?.to_rfc3339();
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
        [collection_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(LibraryError::CollectionNotFound);
    }
    connection.execute("INSERT INTO collection_activity(collection_id,last_opened_at,open_count) VALUES (?1,?2,1)
        ON CONFLICT(collection_id) DO UPDATE SET last_opened_at=excluded.last_opened_at,open_count=open_count+1", params![collection_id, timestamp])?;
    Ok(())
}

impl Library {
    pub fn get_library_statistics(&self) -> Result<LibraryStatistics, LibraryError> {
        inventory(&*self.connection()?)
    }
    pub fn measure_library_derivative_storage(&self) -> Result<DerivativeStorage, LibraryError> {
        let (paths, exceeded) = derivative_paths(&*self.connection()?)?;
        Ok(measure_derivatives(paths, exceeded, self.root()))
    }
    pub fn record_collection_opened(
        &self,
        collection_id: &str,
        opened_at: &str,
    ) -> Result<(), LibraryError> {
        record_collection_opened(&*self.connection()?, collection_id, opened_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Library) {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        (directory, library)
    }
    fn asset(connection: &Connection, id: &str, status: &str) {
        connection.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status,favorite,creator_name,creator_handle)
            VALUES (?1,?1,'image',?1,?1,?1||'.webp',12,1,1,'2026-01-15T12:00:00Z',?2,1,'Creator','creator')", params![id,status]).unwrap();
    }

    #[test]
    fn inventory_uses_normal_assets_direct_classifications_and_actual_opens() {
        let (_directory, library) = fixture();
        {
            let guard = library.connection().unwrap();
            let connection: &Connection = &guard;
            asset(connection, "a", "normal");
            asset(connection, "b", "normal");
            asset(connection, "trash", "trash");
            connection.execute("INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES ('root','root','Parent',NULL,'2026-01-01')", []).unwrap();
            connection.execute("INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES ('child','tag','Child','root','2026-01-01')", []).unwrap();
            connection
                .execute("INSERT INTO asset_classifications VALUES ('a','child')", [])
                .unwrap();
            super::super::revisit::record_asset_opened(connection, "a", "2020-01-01T00:00:00Z")
                .unwrap();
            super::super::revisit::record_assets_exposed(
                connection,
                &["b".into()],
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            let stats = inventory(connection).unwrap();
            assert_eq!(
                (
                    stats.assets,
                    stats.favorites,
                    stats.original_recorded_bytes,
                    stats.unclassified
                ),
                (2, 2, 24, 1)
            );
            assert_eq!(
                (
                    stats.classifications[0].label.as_str(),
                    stats.classifications[0].count
                ),
                ("Child", 1)
            );
            assert_eq!(stats.classifications.len(), 1);
            assert_eq!(stats.creators[0].count, 2);
            assert_eq!(stats.most_opened_assets.len(), 1);
            assert_eq!(stats.long_unseen_assets[0].id, "a");
            assert_eq!(stats.daily[0].asset_opens, 1);
        }
    }

    #[test]
    fn collection_recording_validates_input_and_daily_rollups_ignore_exposure() {
        let (_directory, library) = fixture();
        {
            let guard = library.connection().unwrap();
            let connection: &Connection = &guard;
            asset(connection, "a", "normal");
            connection.execute("INSERT INTO collections(id,name,created_at,updated_at) VALUES ('c','Collection','2026-01-01','2026-01-01')", []).unwrap();
            assert!(
                record_collection_opened(connection, "missing", "2026-01-01T00:00:00Z").is_err()
            );
            assert!(record_collection_opened(connection, "c", "invalid").is_err());
            record_collection_opened(connection, "c", "2026-01-01T00:00:00Z").unwrap();
            record_collection_opened(connection, "c", "2026-01-02T00:00:00Z").unwrap();
            super::super::revisit::record_assets_exposed(
                connection,
                &["a".into()],
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            connection
                .execute(
                    "INSERT INTO activity_daily VALUES ('2000-01-01','asset',10)",
                    [],
                )
                .unwrap();
            super::super::revisit::record_asset_opened(connection, "a", "2026-01-01T00:00:00Z")
                .unwrap();
            let stats = inventory(connection).unwrap();
            assert_eq!(stats.most_opened_collections[0].count, 2);
            assert_eq!(
                (stats.daily[0].asset_opens, stats.daily[0].collection_opens),
                (1, 2)
            );
            assert_eq!(
                connection
                    .query_row::<i64, _, _>(
                        "SELECT COUNT(*) FROM activity_daily WHERE local_date='2000-01-01'",
                        [],
                        |row| row.get(0)
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn derivative_measurement_reports_missing_and_rejects_paths_outside_vault() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("thumb.webp"), b"12345").unwrap();
        let measured = measure_derivatives(
            vec![
                "thumb.webp".into(),
                "missing.webp".into(),
                "../outside.webp".into(),
            ],
            true,
            directory.path(),
        );
        assert_eq!(
            (
                measured.measured_bytes,
                measured.measured_files,
                measured.unavailable_files
            ),
            (5, 1, 2)
        );
        assert!(measured.scan_limit_reached);
    }

    #[test]
    fn migration_does_not_invent_daily_history_from_existing_counters() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE collections(id TEXT PRIMARY KEY);
            CREATE TABLE asset_activity(asset_id TEXT PRIMARY KEY, last_opened_at TEXT, open_count INTEGER DEFAULT 0, exposure_count INTEGER DEFAULT 0);
            INSERT INTO asset_activity VALUES ('a','2020-01-01T00:00:00Z',73,100);").unwrap();
        connection
            .execute_batch(include_str!("../../migrations/0042_statistics.sql"))
            .unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM activity_daily", [], |row| row.get(0))
                .unwrap(),
            0
        );
        connection
            .execute(
                "UPDATE asset_activity SET exposure_count=101 WHERE asset_id='a'",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM activity_daily", [], |row| row.get(0))
                .unwrap(),
            0
        );
        connection
            .execute(
                "UPDATE asset_activity SET open_count=74 WHERE asset_id='a'",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT open_count FROM activity_daily", [], |row| row
                    .get(0))
                .unwrap(),
            1
        );
    }
}
