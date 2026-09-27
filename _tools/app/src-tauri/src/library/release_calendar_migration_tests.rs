use rusqlite::{types::Value, Connection};

use super::{migrate_to_latest, tests::historical_schema, SCHEMA_VERSION};

fn rows(connection: &Connection, table: &str) -> Vec<Vec<Value>> {
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
        .unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns).map(|column| row.get(column)).collect()
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn release_calendar_migration_108_preserves_v107_watches_dates_events_and_cache() {
    let mut connection = Connection::open_in_memory().unwrap();
    historical_schema(&mut connection, 107);
    connection.execute_batch("INSERT INTO release_calendar_cache VALUES
        ('igdb','2026-09-27','2026-09-27','2027-03-29','[{\"id\":\"igdb:7\"}]','2026-09-27',NULL),
        ('tmdb','2026-09-26','2026-09-26','2027-03-28','[{\"id\":\"tmdb:7\"}]','2026-09-27','timed_out');
        INSERT INTO release_watch_items VALUES
        ('igdb:7','game','igdb','7','Game','Original game','cover','[\"PC\"]','calendar','added',0,'checked','next',NULL),
        ('tmdb:7','movie','tmdb','7','Movie','Original movie','/poster.jpg','[]','manual','added',1,'checked',NULL,'released');
        INSERT INTO release_watch_dates VALUES
        ('igdb:7','korea','PC','2026-10-01','month','checked'),
        ('igdb:7','worldwide','PS5',NULL,'tbd','checked'),
        ('tmdb:7','korea','','2026-09-25','exact','checked');
        INSERT INTO release_watch_item_events VALUES
        ('e1','igdb:7','date_set','tbd','2026-10','detected',NULL),
        ('e2','tmdb:7','date_changed','2026-09-24','2026-09-25','detected','read'),
        ('e3','tmdb:7','released',NULL,'2026-09-25','detected',NULL);").unwrap();
    let tables = [
        "release_calendar_cache",
        "release_watch_items",
        "release_watch_dates",
        "release_watch_item_events",
    ];
    let before: Vec<_> = tables
        .iter()
        .map(|table| rows(&connection, table))
        .collect();
    migrate_to_latest(&mut connection, 107).unwrap();
    for (table, expected) in tables.iter().zip(before) {
        assert_eq!(
            rows(&connection, table),
            expected,
            "{table} survives unchanged"
        );
    }
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert_eq!(
        connection
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    for index in [
        "release_watch_items_by_due",
        "release_watch_item_events_unread",
    ] {
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                [index],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
    connection
        .execute_batch(
            "INSERT INTO release_calendar_cache(provider) VALUES('tmdb_tv');
        INSERT INTO release_watch_items(id,kind,provider,external_id,title,source,added_at)
        VALUES('tmdb:tv:7:s2','anime','tmdb','tv:7:s2','Anime','calendar','added');",
        )
        .unwrap();
    assert!(connection.execute("INSERT INTO release_watch_dates VALUES('missing','JP','','2026-10-01','exact','checked')", []).is_err());
    connection
        .execute("DELETE FROM release_watch_items WHERE id='tmdb:7'", [])
        .unwrap();
    assert_eq!(rows(&connection, "release_watch_dates").len(), 2);
    assert_eq!(rows(&connection, "release_watch_item_events").len(), 1);
    assert!(!connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}

#[test]
fn release_calendar_migration_108_rolls_back_and_restores_foreign_keys_on_failure() {
    let mut connection = Connection::open_in_memory().unwrap();
    historical_schema(&mut connection, 107);
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
        INSERT INTO release_watch_dates VALUES('missing','JP','','2026-10-01','exact','checked');
        PRAGMA foreign_keys=ON;",
        )
        .unwrap();
    assert!(migrate_to_latest(&mut connection, 107).is_err());
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        107
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(connection
        .execute(
            "INSERT INTO release_calendar_cache(provider) VALUES('tmdb_tv')",
            []
        )
        .is_err());
    assert_eq!(rows(&connection, "release_watch_dates").len(), 1);
}
