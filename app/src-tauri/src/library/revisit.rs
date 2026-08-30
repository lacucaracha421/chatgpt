use std::collections::BTreeSet;

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};

use super::error::LibraryError;
use super::models::{RevisitBundle, RevisitSlate};

pub(crate) fn parse_utc_timestamp(value: &str) -> Result<DateTime<chrono::Utc>, LibraryError> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
        .map_err(|_| LibraryError::InvalidCollectedAt)
}

pub(crate) fn parse_local_date(local_date: &str) -> Result<chrono::NaiveDate, LibraryError> {
    chrono::NaiveDate::parse_from_str(local_date, "%Y-%m-%d")
        .map_err(|_| LibraryError::InvalidCollectedAt)
}

pub(crate) fn record_asset_opened(
    connection: &Connection,
    asset_id: &str,
    opened_at: &str,
) -> Result<(), LibraryError> {
    parse_utc_timestamp(opened_at)?;
    asset_exists(connection, asset_id)?;
    connection.execute(
        "INSERT INTO asset_activity (asset_id, last_opened_at, open_count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(asset_id) DO UPDATE SET
            last_opened_at = excluded.last_opened_at,
            open_count = open_count + 1",
        params![asset_id, opened_at],
    )?;
    Ok(())
}

pub(crate) fn record_assets_exposed(
    connection: &Connection,
    asset_ids: &[String],
    exposed_at: &str,
) -> Result<(), LibraryError> {
    parse_utc_timestamp(exposed_at)?;
    let unique: BTreeSet<&str> = asset_ids.iter().map(String::as_str).collect();
    let transaction = connection.unchecked_transaction()?;
    for asset_id in &unique {
        asset_exists(&transaction, asset_id)?;
        transaction.execute(
            "INSERT INTO asset_activity (asset_id, last_exposed_at, exposure_count)
             VALUES (?1, ?2, 1)
             ON CONFLICT(asset_id) DO UPDATE SET
                last_exposed_at = excluded.last_exposed_at,
                exposure_count = exposure_count + 1",
            params![asset_id, exposed_at],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn save_daily_slate(
    connection: &Connection,
    slate: &RevisitSlate,
) -> Result<(), LibraryError> {
    let mut seen = BTreeSet::new();
    for bundle in &slate.bundles {
        for asset_id in &bundle.asset_ids {
            if !seen.insert(asset_id.as_str()) {
                return Err(LibraryError::InvalidCollectedAt);
            }
        }
    }
    let transaction = connection.unchecked_transaction()?;
    for asset_id in &seen {
        asset_exists(&transaction, asset_id)?;
    }
    transaction.execute(
        "DELETE FROM revisit_slates WHERE local_date = ?1",
        params![slate.local_date],
    )?;
    transaction.execute(
        "INSERT INTO revisit_slates (local_date, created_at, revision) VALUES (?1, ?2, ?3)",
        params![slate.local_date, slate.created_at, slate.revision],
    )?;
    for (position, bundle) in slate.bundles.iter().enumerate() {
        transaction.execute(
            "INSERT INTO revisit_bundles (id, local_date, position, kind, title, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![bundle.id, slate.local_date, position as i64, bundle.kind, bundle.title, bundle.reason],
        )?;
        for (asset_position, asset_id) in bundle.asset_ids.iter().enumerate() {
            transaction.execute(
                "INSERT INTO revisit_bundle_assets (bundle_id, asset_id, position) VALUES (?1, ?2, ?3)",
                params![bundle.id, asset_id, asset_position as i64],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn load_daily_slate(
    connection: &Connection,
    local_date: &str,
) -> Result<Option<RevisitSlate>, LibraryError> {
    parse_local_date(local_date)?;
    let head = connection
        .query_row(
            "SELECT created_at, revision FROM revisit_slates WHERE local_date = ?1",
            params![local_date],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((created_at, revision)) = head else { return Ok(None) };

    let mut bundles_statement = connection.prepare(
        "SELECT id, kind, title, reason FROM revisit_bundles WHERE local_date = ?1 ORDER BY position ASC",
    )?;
    let bundle_rows = bundles_statement.query_map(params![local_date], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    })?;
    let mut bundles = Vec::new();
    for row in bundle_rows {
        let (id, kind, title, reason) = row?;
        let mut assets_statement = connection.prepare(
            "SELECT asset_id FROM revisit_bundle_assets WHERE bundle_id = ?1 ORDER BY position ASC",
        )?;
        let asset_ids = assets_statement
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        bundles.push(RevisitBundle { id, kind, title, reason, asset_ids, revision });
    }
    Ok(Some(RevisitSlate { local_date: local_date.to_string(), created_at, revision, bundles }))
}

fn asset_exists(connection: &Connection, asset_id: &str) -> Result<(), LibraryError> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM assets WHERE id = ?1",
            params![asset_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(LibraryError::AssetNotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use rusqlite::params;

    fn fixture() -> Library {
        let temp = tempfile::tempdir().unwrap();
        Library::open(temp.path()).unwrap()
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 400, 200, ?6)",
                params![id, format!("hash-{id}"), format!("{id}.png"), format!("assets/{id}.png"), format!("thumbnails/{id}.webp"), collected_at],
            )
            .unwrap();
    }

    #[test]
    fn opening_and_exposure_update_aggregates_without_event_rows() {
        let library = fixture();
        insert_asset(&library, "asset-a", "2026-08-30T00:00:00Z");
        let connection = library.connection().unwrap();
        record_asset_opened(&connection, "asset-a", "2026-08-30T01:00:00Z").unwrap();
        record_asset_opened(&connection, "asset-a", "2026-08-30T02:00:00Z").unwrap();
        record_assets_exposed(&connection, &["asset-a".into()], "2026-08-30T03:00:00Z").unwrap();
        record_assets_exposed(&connection, &["asset-a".into()], "2026-08-30T04:00:00Z").unwrap();

        let row = connection
            .query_row(
                "SELECT open_count, exposure_count, last_opened_at, last_exposed_at FROM asset_activity WHERE asset_id = 'asset-a'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, (2, 2, "2026-08-30T02:00:00Z".to_string(), "2026-08-30T04:00:00Z".to_string()));
    }

    #[test]
    fn rejects_unknown_assets_and_unparsable_timestamps() {
        let library = fixture();
        insert_asset(&library, "asset-a", "2026-08-30T00:00:00Z");
        let connection = library.connection().unwrap();
        assert!(matches!(
            record_asset_opened(&connection, "asset-missing", "2026-08-30T01:00:00Z"),
            Err(LibraryError::AssetNotFound)
        ));
        assert!(matches!(
            record_assets_exposed(&connection, &["asset-missing".into()], "2026-08-30T01:00:00Z"),
            Err(LibraryError::AssetNotFound)
        ));
        assert!(record_asset_opened(&connection, "asset-a", "not-a-time").is_err());
 assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM asset_activity", [], |row| row.get(0))
                .unwrap(),
            0,
        );
    }

    #[test]
    fn persists_and_loads_a_daily_slate_transactionally() {
        let library = fixture();
        for id in ["asset-a", "asset-b", "asset-c", "asset-d"] {
            insert_asset(&library, id, "2026-08-30T00:00:00Z");
        }
        let connection = library.connection().unwrap();
        let slate = RevisitSlate {
            local_date: "2026-08-30".into(),
            created_at: "2026-08-30T09:00:00Z".into(),
            revision: 3,
            bundles: vec![
                RevisitBundle { id: "bundle-0".into(), kind: "rediscovery".into(), title: "다시 만난 자산".into(), reason: "8개월 동안 열지 않은 즐겨찾기".into(), asset_ids: vec!["asset-a".into(), "asset-b".into()], revision: 0 },
                RevisitBundle { id: "bundle-1".into(), kind: "creator".into(), title: "작가 집중 보기".into(), reason: "최근 열어본 자산의 작가".into(), asset_ids: vec!["asset-c".into(), "asset-d".into()], revision: 0 },
            ],
        };
        save_daily_slate(&connection, &slate).unwrap();
        save_daily_slate(&connection, &slate).unwrap();

        let loaded = load_daily_slate(&connection, "2026-08-30").unwrap().unwrap();
        assert_eq!(loaded.local_date, "2026-08-30");
        assert_eq!(loaded.revision, 3);
        assert_eq!(loaded.bundles.len(), 2);
        assert_eq!(loaded.bundles[0].asset_ids, vec!["asset-a".to_string(), "asset-b".to_string()]);
        assert_eq!(loaded.bundles[1].reason, "최근 열어본 자산의 작가");
        assert!(load_daily_slate(&connection, "2026-08-29").unwrap().is_none());


        let duplicate = RevisitSlate {
            bundles: vec![
                RevisitBundle { id: "dup-0".into(), kind: "rediscovery".into(), title: "중복".into(), reason: "이유".into(), asset_ids: vec!["asset-a".into(), "asset-b".into()], revision: 0 },
                RevisitBundle { id: "dup-1".into(), kind: "creator".into(), title: "중복".into(), reason: "이유".into(), asset_ids: vec!["asset-b".into(), "asset-c".into()], revision: 0 },
            ],
            ..slate.clone()
        };
        assert!(save_daily_slate(&connection, &duplicate).is_err());
    }
}