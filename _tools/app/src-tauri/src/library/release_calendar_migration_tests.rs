use rusqlite::{types::Value, Connection};
use serde_json::json;

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
    for (table, mut expected) in tables.iter().zip(before) {
        if *table == "release_watch_items" {
            for row in &mut expected {
                row.push(Value::Null);
            }
        }
        assert_eq!(
            rows(&connection, table),
            expected,
            "{table} preserves its prior fields"
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

#[test]
fn release_watch_port_migration_115_repairs_only_unreleased_cached_ports_once() {
    let mut connection = Connection::open_in_memory().unwrap();
    historical_schema(&mut connection, 114);
    let entries = json!([
        {
            "id": "igdb:185252",
            "platforms": ["Switch 2"],
            "date": "2026-10-01",
            "precision": "quarter",
            "dates": [{
                "region": "worldwide",
                "platform": "Switch 2",
                "date": "2026-10-01",
                "precision": "quarter"
            }],
            "port": true
        },
        {
            "id": "igdb:99",
            "platforms": ["Switch 2"],
            "date": "2000-01-01",
            "precision": "exact",
            "dates": [{
                "region": "worldwide",
                "platform": "Switch 2",
                "date": "2000-01-01",
                "precision": "exact"
            }],
            "port": true
        },
        {
            "id": "igdb:8",
            "platforms": ["PS5"],
            "date": "2026-12-01",
            "precision": "exact",
            "dates": [{
                "region": "worldwide",
                "platform": "PS5",
                "date": "2026-12-01",
                "precision": "exact"
            }],
            "port": false
        }
    ]);
    connection
        .execute(
            "INSERT INTO release_calendar_cache(
                provider,fetched_at,range_start,range_end,entries_json,attempted_at,error_code
             ) VALUES('igdb','2026-09-28','2026-09-28','2027-03-30',?1,'2026-09-28',NULL)",
            [entries.to_string()],
        )
        .unwrap();
    connection.execute_batch(
        "INSERT INTO release_watch_items(
            id,kind,provider,external_id,title,platforms_json,source,added_at,
            last_checked_at,next_check_at,released_at
         ) VALUES
            ('igdb:185252','game','igdb','185252','Space Marine II',
             '[\"PC\",\"PS5\",\"Switch 2\",\"Xbox Series\"]','calendar','added','checked',NULL,'released'),
            ('igdb:99','game','igdb','99','Released port',
             '[\"PC\",\"Switch 2\"]','calendar','added','checked',NULL,'released'),
            ('igdb:8','game','igdb','8','Non-port',
             '[\"PS5\"]','calendar','added','checked','unchanged-next',NULL);
         INSERT INTO release_watch_dates(item_id,region,platform,date,precision,checked_at) VALUES
            ('igdb:185252','worldwide','PC','2024-09-05','exact','checked'),
            ('igdb:185252','worldwide','Switch 2','2026-10-01','quarter','checked'),
            ('igdb:99','worldwide','PC','1999-01-01','exact','checked'),
            ('igdb:99','worldwide','Switch 2','2000-01-01','exact','checked'),
            ('igdb:8','worldwide','PS5','2026-12-01','exact','checked');
         INSERT INTO release_watch_item_events(
            id,item_id,event_kind,previous_value,current_value,detected_at,read_at
         ) VALUES
            ('space-unread','igdb:185252','released',NULL,'2024-09-05','detected',NULL),
            ('space-read','igdb:185252','released',NULL,'2024-09-05','detected','read'),
            ('space-date','igdb:185252','date_changed','2026-Q4','2024-09-05','detected',NULL),
            ('released-unread','igdb:99','released',NULL,'2000-01-01','detected',NULL);"
    ).unwrap();

    migrate_to_latest(&mut connection, 114).unwrap();

    let repaired: (String, String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT platforms_json,tracked_platforms_json,released_at,next_check_at
             FROM release_watch_items WHERE id='igdb:185252'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(repaired.0, "[\"Switch 2\"]");
    assert_eq!(repaired.1, "[\"Switch 2\"]");
    assert_eq!(repaired.2, None);
    assert!(repaired.3.is_some());
    assert_eq!(
        rows(&connection, "release_watch_dates")
            .into_iter()
            .filter(|row| row[0] == Value::Text("igdb:185252".into()))
            .collect::<Vec<_>>(),
        vec![vec![
            Value::Text("igdb:185252".into()),
            Value::Text("worldwide".into()),
            Value::Text("Switch 2".into()),
            Value::Text("2026-10-01".into()),
            Value::Text("quarter".into()),
            Value::Text("checked".into()),
        ]]
    );
    let space_events: Vec<String> = connection
        .prepare("SELECT id FROM release_watch_item_events WHERE item_id='igdb:185252' ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(space_events, vec!["space-date", "space-read"]);

    let released_port: (String, Option<String>, Option<String>, i64) = connection
        .query_row(
            "SELECT tracked_platforms_json,released_at,next_check_at,
                    (SELECT COUNT(*) FROM release_watch_item_events WHERE id='released-unread')
             FROM release_watch_items WHERE id='igdb:99'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        released_port,
        ("[\"Switch 2\"]".into(), Some("released".into()), None, 1)
    );
    let non_port: (String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT platforms_json,tracked_platforms_json,next_check_at
             FROM release_watch_items WHERE id='igdb:8'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        non_port,
        ("[\"PS5\"]".into(), None, Some("unchanged-next".into()))
    );

    let before = [
        rows(&connection, "release_watch_items"),
        rows(&connection, "release_watch_dates"),
        rows(&connection, "release_watch_item_events"),
    ];
    migrate_to_latest(&mut connection, SCHEMA_VERSION).unwrap();
    let after = [
        rows(&connection, "release_watch_items"),
        rows(&connection, "release_watch_dates"),
        rows(&connection, "release_watch_item_events"),
    ];
    assert_eq!(
        after, before,
        "opening an already migrated library is a no-op"
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert_eq!(
        connection
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
