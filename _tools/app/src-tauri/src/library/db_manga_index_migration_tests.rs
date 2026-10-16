    use super::*;
    #[test]
    fn manga_index_upgrade_from_117_preserves_data_and_rejects_duplicate_identity() {
        let temp = tempfile::tempdir().unwrap();
        let mut c = open_database(&temp.path().join("library.sqlite")).unwrap();
        tests::historical_schema(&mut c, 117);
        c.execute(
            "INSERT INTO online_catalog_bookmarks VALUES('kHentai','42','now')",
            [],
        )
        .unwrap();
        migrate_to_latest(&mut c, 117).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            c.query_row("SELECT work_id FROM online_catalog_bookmarks", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "42"
        );
        c.execute(
            "INSERT INTO manga_index_pins VALUES('tag','female','same','label','now')",
            [],
        )
        .unwrap();
        assert!(c
            .execute(
                "INSERT INTO manga_index_pins VALUES('tag','female','same','other','now')",
                []
            )
            .is_err());
        assert!(c
            .execute(
                "INSERT INTO manga_index_pins VALUES('artist','female','same','label','now')",
                []
            )
            .is_err());
        assert_eq!(
            c.pragma_query_value(None, "quick_check", |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
