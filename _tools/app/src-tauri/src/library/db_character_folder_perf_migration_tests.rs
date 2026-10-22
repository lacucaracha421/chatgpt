    #[test]
    fn char_folder_perf_migrates_129_to_130_with_lookup_indexes() {
        let temp = tempfile::tempdir().unwrap();
        let library = crate::library::Library::open(temp.path()).unwrap();
        let mut connection = library.connection().unwrap();
        connection
            .execute_batch("DROP TABLE manga_spine_scans; ALTER TABLE collection_volume_ranges DROP COLUMN restart_numbering; ALTER TABLE character_member_items DROP COLUMN plan_id; ALTER TABLE character_member_control DROP COLUMN recommendations_backfilled;  DROP TABLE character_claude_settings;
                DROP TABLE character_claude_opinions;
                DROP INDEX tagger_scores_suggestion_threshold;
                DROP INDEX character_target_tagger_tags_by_tag;
                DROP INDEX character_targets_by_linked_classification;
                PRAGMA user_version=129;")
            .unwrap();
        super::migrate_to_latest(&mut connection, 129).unwrap();
        assert_eq!(
            connection.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(),
            super::SCHEMA_VERSION
        );
        for name in [
            "tagger_scores_suggestion_threshold",
            "character_target_tagger_tags_by_tag",
            "character_targets_by_linked_classification",
        ] {
            assert!(connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?1)",
                [name], |r| r.get::<_, bool>(0)
            ).unwrap(), "missing {name}");
        }
        let plan = connection.prepare("EXPLAIN QUERY PLAN SELECT c.id FROM classification_entries c WHERE c.parent_id=?1 AND NOT EXISTS(SELECT 1 FROM character_targets t WHERE t.linked_classification_id=c.id)").unwrap()
            .query_map(["fixture-series"], |r| r.get::<_, String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert!(plan.iter().any(|line| line.contains("SEARCH t USING COVERING INDEX character_targets_by_linked_classification")), "{plan:?}");
        eprintln!("series folders lookup plan: {}", plan.join("\n"));
    }
