    #[test]
    fn character_claude_migrates_131_to_132_with_cache_token_defaults() {
        let fixture = crate::library::characters::tests::Fixture::new();
        let target = fixture.ready("Alice");
        let mut connection = fixture.library.connection().unwrap();
        connection
            .execute_batch(
                "ALTER TABLE collection_volume_ranges DROP COLUMN restart_numbering; ALTER TABLE character_member_items DROP COLUMN plan_id;
                 ALTER TABLE character_member_control DROP COLUMN recommendations_backfilled;
                 DROP TABLE character_claude_opinions;
                 DROP TABLE character_claude_settings;",
            )
            .unwrap();
        connection
            .execute_batch(include_str!("../../migrations/0131_character_claude.sql"))
            .unwrap();
        connection.execute(
                "INSERT INTO character_claude_opinions(target_id,asset_hash,reference_key,model,verdict,input_tokens,output_tokens,created_at)
                 VALUES(?1,'h','k','m','yes',123,45,'now')",
                [&target.id],
            ).unwrap();
        super::migrate_to_latest(&mut connection, 131).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            super::SCHEMA_VERSION
        );
        let usage: (i64, i64, i64, i64) = connection.query_row(
                "SELECT input_tokens,output_tokens,cache_write_tokens,cache_read_tokens FROM character_claude_opinions",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ).unwrap();
        assert_eq!(usage, (123, 45, 0, 0));
        connection
            .execute(
                "UPDATE character_claude_opinions SET cache_write_tokens=100,cache_read_tokens=200",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE character_claude_opinions SET cache_read_tokens=NULL",
                []
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE character_claude_opinions SET cache_write_tokens=NULL",
                []
            )
            .is_err());
    }

    #[test]
    fn character_claude_migrates_130_to_131_with_off_by_default_settings() {
        let temp = tempfile::tempdir().unwrap();
        let library = crate::library::Library::open(temp.path()).unwrap();
        let mut connection = library.connection().unwrap();
        connection
            .execute_batch(
                "ALTER TABLE collection_volume_ranges DROP COLUMN restart_numbering; ALTER TABLE character_member_items DROP COLUMN plan_id;
                 ALTER TABLE character_member_control DROP COLUMN recommendations_backfilled;
                 DROP TABLE character_claude_settings;
                 DROP TABLE character_claude_opinions;
                 PRAGMA user_version=130;",
            )
            .unwrap();
        super::migrate_to_latest(&mut connection, 130).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            super::SCHEMA_VERSION
        );
        let settings: (bool, f64) = connection
            .query_row(
                "SELECT enabled,monthly_cap_usd FROM character_claude_settings WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(settings, (false, 10.0));
        connection
            .execute(
                "INSERT INTO character_claude_opinions(target_id,asset_hash,reference_key,model,verdict,created_at)
                 VALUES('missing','h','k','m','yes','now')",
                [],
            )
            .expect_err("an opinion needs its character");
    }

#[test]
fn member_run_migrates_134_without_changing_pairwise_settings() {
    let temp = tempfile::tempdir().unwrap();
    let library = crate::library::Library::open(temp.path()).unwrap();
    library.set_claude_settings(true, 20.0).unwrap();
    let mut connection = library.connection().unwrap();
    connection.execute_batch("ALTER TABLE collection_volume_ranges DROP COLUMN restart_numbering; DROP VIEW character_member_pending;
        DROP TABLE character_member_recommendations;
        DROP TABLE character_member_requests;
        DROP TABLE character_member_items;
        DROP TABLE character_member_control;
        PRAGMA user_version=134;").unwrap();
    super::migrate_to_latest(&mut connection, 134).unwrap();
    let settings: (String,f64) = connection.query_row("SELECT ongoing_mode,cap_usd FROM character_member_control",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(settings,("until".into(),45.0));
    let pairwise: (bool,f64) = connection.query_row("SELECT enabled,monthly_cap_usd FROM character_claude_settings",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(pairwise,(true,20.0));
    assert_eq!(connection.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),super::SCHEMA_VERSION);
}

#[test]
fn member_run_migrates_136_so_a_running_plan_keeps_its_items() {
    let temp = tempfile::tempdir().unwrap();
    let library = crate::library::Library::open(temp.path()).unwrap();
    let mut connection = library.connection().unwrap();
    connection.execute_batch("INSERT INTO character_member_items(mode,asset_id,sample_json) VALUES('backlog','a','{}'),('ongoing','b','{}');
        UPDATE character_member_control SET state='running',plan_id='plan-1';
        ALTER TABLE collection_volume_ranges DROP COLUMN restart_numbering; ALTER TABLE character_member_items DROP COLUMN plan_id;
        ALTER TABLE character_member_control DROP COLUMN recommendations_backfilled;
        PRAGMA user_version=136;").unwrap();
    super::migrate_to_latest(&mut connection, 136).unwrap();
    let plans: Vec<(String, Option<String>)> = connection.prepare("SELECT mode,plan_id FROM character_member_items ORDER BY mode").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(plans,[("backlog".into(),Some("plan-1".into())),("ongoing".into(),None)]);
    assert_eq!(connection.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),super::SCHEMA_VERSION);
}
