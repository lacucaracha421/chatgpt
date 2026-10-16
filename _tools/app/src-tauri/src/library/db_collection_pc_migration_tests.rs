    use super::*;
    #[test]
    fn collection_pc_migration_116_keeps_existing_rows() {
        let mut c = Connection::open_in_memory().unwrap();
        tests::historical_schema(&mut c, 115);
        c.execute_batch("INSERT INTO collections(id,name,type,description,my_score,created_at,updated_at) VALUES('m','Manga','manga','kept memo',3.5,'created','updated');
            INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,created_at,updated_at) VALUES('v','m',1,0,10,'created','updated');
            INSERT INTO notes_state(key,value) VALUES('kept','handshake');").unwrap();
        fn rows(c: &Connection, query: &str) -> Vec<Vec<rusqlite::types::Value>> {
            let mut s = c.prepare(query).unwrap();
            let n = s.column_count();
            let result = s
                .query_map([], |r| (0..n).map(|i| r.get(i)).collect())
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            result
        }
        let tables = [
            "collections",
            "collection_volumes",
            "notes_state",
            "library_settings",
        ];
        let before: Vec<_> = tables
            .iter()
            .map(|table| {
                let columns = c
                    .prepare(&format!("SELECT * FROM {table}"))
                    .unwrap()
                    .column_names()
                    .iter()
                    .map(|name| format!("\"{name}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                let query = format!("SELECT {columns} FROM {table} ORDER BY 1");
                let values = rows(&c, &query);
                (query, values)
            })
            .collect();
        migrate_to_latest(&mut c, 115).unwrap();
        for (query, expected) in before {
            assert_eq!(rows(&c, &query), expected, "{query}");
        }
        assert!(c
            .query_row(
                "SELECT likes_album_id IS NULL FROM library_settings",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        assert!(rows(&c, "SELECT * FROM collection_pc_records").is_empty());
        assert!(rows(&c, "SELECT * FROM collection_volume_cover_focus").is_empty());
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }
