    use super::*;

    #[test]
    fn image_text_migration_129_applies_to_fresh_and_128() {
        for version in [0, 128] {
            let temp = tempfile::tempdir().unwrap();
            let mut db = open_database(&temp.path().join("library.sqlite")).unwrap();
            if version > 0 {
                historical_schema(&mut db, version);
            }
            migrate_to_latest(&mut db, version as i64).unwrap();
            assert_eq!(
                db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                SCHEMA_VERSION
            );
            db.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES('a','a','image','a','a','a',1,1,1,'t')", []).unwrap();
            db.execute(
                "INSERT INTO asset_image_text VALUES('a','[]','digest','t')",
                [],
            )
            .unwrap();
            assert!(db
                .execute(
                    "INSERT INTO asset_image_text VALUES('missing','[]','digest','t')",
                    []
                )
                .is_err());
            assert!(db
                .execute(
                    "INSERT INTO asset_image_text VALUES('a','[]','other','t')",
                    []
                )
                .is_err());
            db.execute("DELETE FROM assets WHERE id='a'", []).unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM asset_image_text", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn artist_exclusions_v111_upgrade_and_fresh_schema() {
        for version in [0, 109, 110] {
            let temp = tempfile::tempdir().unwrap();
            let mut connection = open_database(&temp.path().join("library.sqlite")).unwrap();
            if version != 0 {
                historical_schema(&mut connection, version);
                connection.execute("INSERT INTO artists(id,created_at,updated_at) VALUES('existing','t','t')", []).unwrap();
            }
            migrate_to_latest(&mut connection, version as i64).unwrap();
            assert_eq!(connection.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),SCHEMA_VERSION);
            connection.execute("INSERT INTO artists(id,created_at,updated_at,reposter) VALUES('new','t','t',1)", []).unwrap();
            assert!(connection.execute("UPDATE artists SET reposter=2", []).is_err());
            if version != 0 {
                assert_eq!(connection.query_row("SELECT reposter FROM artists WHERE id='existing'", [], |r|r.get::<_,i64>(0)).unwrap(),0);
            }
            connection.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES('a','a','image','a','a','a',1,1,1,'t')", []).unwrap();
            connection.execute("INSERT INTO artist_style_dismissals VALUES('a','artist:new','t')", []).unwrap();
            assert!(connection.execute("INSERT INTO artist_style_dismissals VALUES('a','artist:new','t')", []).is_err());
            connection.execute("DELETE FROM assets WHERE id='a'", []).unwrap();
            assert_eq!(connection.query_row("SELECT count(*) FROM artist_style_dismissals", [], |r|r.get::<_,i64>(0)).unwrap(),0);

            connection.execute_batch("\
                INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES
                    ('excluded-root','root','기타',NULL,'t'),
                    ('excluded-child','tag','ai','excluded-root','t'),
                    ('kept-root','root','보관',NULL,'t');
                INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,creator_handle) VALUES
                    ('excluded-direct','excluded-direct','image','excluded-direct','assets/excluded-direct','thumbnails/excluded-direct',1,1,1,'t','excluded'),
                    ('excluded-child-asset','excluded-child-asset','image','excluded-child-asset','assets/excluded-child-asset','thumbnails/excluded-child-asset',1,1,1,'t','excluded-child'),
                    ('kept-asset','kept-asset','image','kept-asset','assets/kept-asset','thumbnails/kept-asset',1,1,1,'t','kept');
                INSERT INTO asset_classifications(asset_id,classification_id) VALUES
                    ('excluded-direct','excluded-root'),
                    ('excluded-child-asset','excluded-child'),
                    ('kept-asset','kept-root');
                INSERT INTO artist_excluded_classifications(classification_id,added_at) VALUES('excluded-root','t');")
                .unwrap();
            let scopes: Vec<(String, String)> = connection
                .prepare("SELECT asset_id, scope_ref FROM asset_artist_scope ORDER BY asset_id")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(scopes, vec![("kept-asset".into(), "kept".into())]);
        }
    }

    // Build the actual historical schema; downgrading user_version on today's
    // schema leaves later tables behind and cannot exercise an upgrade faithfully.
    pub(in crate::library) fn historical_schema(connection: &mut Connection, version: usize) {
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        let mut files = std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
            .collect::<Vec<_>>();
        files.sort();
        let transaction = connection.transaction().unwrap();
        for file in files.iter().take(version) {
            transaction
                .execute_batch(&std::fs::read_to_string(file).unwrap())
                .unwrap();
        }
        transaction.commit().unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            version as i64
        );
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
    }

    #[test]
    fn av_authority_limits_migration_from_123_preserves_people_children_and_outbox() {
        let mut db = Connection::open_in_memory().unwrap();
        historical_schema(&mut db, 123);
        db.execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('av','AV','av','t','t');
            INSERT INTO collection_av_details(collection_id,product_code,label,series,revision,title_ja,maker,genres_json) VALUES('av','CODE','Label','Series',7,'Title','Maker','[\"g\"]');
            INSERT INTO collection_people(id,display_name,name_ja,wikidata_id,fanza_actress_id,memo,created_at,updated_at) VALUES('p','Person','Name','Q1','F1','Memo','t','t');
            INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES('av','p','performer',0,'Alias');
            INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at) VALUES('p','commons',x'1234','image/png',1,1,'photo','https://example.test','t');
            INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,fetched_at) VALUES('p','stashdb','matched','stash-p','Profile',42);
            INSERT INTO av_favorite_performers(person_id,created_at) VALUES('p','t');
            INSERT INTO collection_authority_sync(singleton,library_id,epoch,contract_version,adopted,generation,updated_at) VALUES(1,'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',1,1,1,'g','t');
            INSERT INTO collection_authority_outbox(operation_id,library_id,epoch,contract_version,command_type,entity_key,payload,state,receipt,created_at,updated_at) VALUES('op','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',1,1,'updateWork','av','{}','accepted','{\"receipt\":true}','t','t');").unwrap();
        let before: (i64,i64,i64,i64) = db.query_row("SELECT generation,published_generation,first_dirty,last_dirty FROM mobile_publication_state WHERE kind='collections'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        migrate_to_latest(&mut db, 123).unwrap();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            db.pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!db
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        assert_eq!(db.query_row("SELECT label,series,revision,title_ja,maker,genres_json FROM collection_av_details WHERE collection_id='av'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?))).unwrap(),("Label".into(),"Series".into(),7,"Title".into(),"Maker".into(),"[\"g\"]".into()));
        assert_eq!(db.query_row("SELECT display_name,name_ja,wikidata_id,fanza_actress_id,memo FROM collection_people WHERE id='p'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).unwrap(),("Person".into(),"Name".into(),"Q1".into(),"F1".into(),"Memo".into()));
        assert_eq!(
            db.query_row(
                "SELECT credit_name FROM collection_person_relations",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "Alias"
        );
        assert_eq!(
            db.query_row(
                "SELECT hex(image_bytes) FROM collection_person_portraits",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "1234"
        );
        assert_eq!(
            db.query_row(
                "SELECT stashdb_id FROM collection_person_profiles",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "stash-p"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM av_favorite_performers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT state,receipt FROM collection_authority_outbox",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("accepted".into(), "{\"receipt\":true}".into())
        );
        let after = db.query_row("SELECT generation,published_generation,first_dirty,last_dirty FROM mobile_publication_state WHERE kind='collections'",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).unwrap();
        assert_eq!(before, after);
        db.execute(
            "UPDATE collection_av_details SET label=?1,series=?1",
            ["x".repeat(500)],
        )
        .unwrap();
        db.execute(
            "UPDATE collection_people SET display_name=?1",
            ["x".repeat(500)],
        )
        .unwrap();
        db.execute(
            "UPDATE collection_person_relations SET credit_name=?1",
            ["x".repeat(500)],
        )
        .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='collections'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            before.0 + 1
        );
    }

    #[test]
    fn av_profiles_migration_from_111_preserves_portraits_and_people() {
        let mut c = Connection::open_in_memory().unwrap();
        historical_schema(&mut c, 111);
        c.execute_batch("INSERT INTO collection_people(id,display_name,memo,created_at,updated_at) VALUES('p','Person','memo','t','t'),('q','Other',NULL,'t','t');
            INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('av','Work','av','t','t');
            INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('cover','av','local-manual','cover','cover','cover.png','image/png',10,20,1,'t','t');
            INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,author,license,source_url,updated_at) VALUES('p','commons',X'1234','image/png',1,2,'old.png','Author','License','https://commons.wikimedia.org/old','t');
            INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES('q','crop','cover',0.1,0.2,0.5,0.6,'t');").unwrap();
        migrate_to_latest(&mut c,111).unwrap();
        assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),SCHEMA_VERSION);
        assert_eq!(c.query_row("SELECT display_name,memo FROM collection_people WHERE id='p'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),("Person".into(),"memo".into()));
        assert_eq!(c.query_row("SELECT hex(image_bytes),author,license FROM collection_person_portraits WHERE person_id='p'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap(),("1234".into(),"Author".into(),"License".into()));
        assert_eq!(c.query_row("SELECT artwork_id,x,y,w,h FROM collection_person_portraits WHERE person_id='q'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?,r.get::<_,f64>(2)?,r.get::<_,f64>(3)?,r.get::<_,f64>(4)?))).unwrap(),("cover".into(),0.1,0.2,0.5,0.6));
        c.execute("UPDATE collection_person_portraits SET kind='stashdb',author=NULL,license=NULL WHERE person_id='p'",[]).unwrap();
        c.execute("INSERT INTO collection_person_profiles(person_id,source,status,fetched_at) VALUES('p','stashdb','none','t')",[]).unwrap();
        assert!(c.execute("UPDATE collection_person_profiles SET status='invalid'",[]).is_err());
        assert!(c.execute("UPDATE collection_person_profiles SET images_json='{}'",[]).is_err());
        assert!(c.execute("UPDATE collection_person_profiles SET candidates_json='[1,2,3,4,5,6]'",[]).is_err());
        c.execute("DELETE FROM collection_people WHERE id='p'",[]).unwrap();
        assert_eq!(c.query_row("SELECT count(*) FROM collection_person_profiles",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(c.query_row("SELECT count(*) FROM collection_person_portraits",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(c.query_row("PRAGMA quick_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
    }

    #[test]
    fn collection_volume_range_migration_from_112_creates_the_pc_local_table() {
        let mut c = Connection::open_in_memory().unwrap();
        historical_schema(&mut c, 112);
        migrate_to_latest(&mut c, 112).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        c.execute(
            "INSERT INTO collections(id,name,type,created_at,updated_at)
             VALUES('m','Manga','manga','t','t'),('bad','Manga 2','manga','t','t')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO collection_volume_ranges(
                collection_id,min_volume,max_volume,hide_connection_prompt,updated_at
             ) VALUES('m',1,11,1,'t')",
            [],
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT min_volume,max_volume,hide_connection_prompt
                 FROM collection_volume_ranges WHERE collection_id='m'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap(),
            (Some(1), Some(11), 1)
        );
        assert!(c
            .execute(
                "INSERT INTO collection_volume_ranges(
                collection_id,min_volume,max_volume,hide_connection_prompt,updated_at
             ) VALUES('bad',12,11,0,'t')",
                [],
            )
            .is_err());
    }

    #[test]
    fn home_data_migration_from_113_adds_constrained_local_state() {
        let mut c = Connection::open_in_memory().unwrap();
        historical_schema(&mut c, 113);
        migrate_to_latest(&mut c, 113).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        c.execute_batch("INSERT INTO manga_series(id,relative_path,title,author,page_count,thumbnail_relative_path,scanned_at) VALUES('m','m','Manga','Author',10,'m.webp','t');
            INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES('p','Performer','t','t');
            INSERT INTO manga_reading_progress(series_id,last_page,page_count,updated_at) VALUES('m',2,10,'t');
            INSERT INTO av_favorite_performers(person_id,created_at) VALUES('p','t');").unwrap();
        assert!(c
            .execute(
                "INSERT INTO manga_reading_progress(series_id,last_page,page_count,updated_at) VALUES('missing',11,10,'t')",
                [],
            )
            .is_err());
        c.execute("DELETE FROM manga_series WHERE id='m'", [])
            .unwrap();
        c.execute("DELETE FROM collection_people WHERE id='p'", [])
            .unwrap();
        for table in ["manga_reading_progress", "av_favorite_performers"] {
            assert_eq!(
                c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            c.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }

    #[test]
    fn av_portraits_migration_from_106_preserves_people() {
        let mut c = Connection::open_in_memory().unwrap();
        historical_schema(&mut c, 106);
        c.execute("INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES('p','Person','t','t')", []).unwrap();
        migrate_to_latest(&mut c, 106).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            c.query_row(
                "SELECT display_name,memo FROM collection_people WHERE id='p'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            )
            .unwrap(),
            ("Person".into(), None)
        );
        c.execute("INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at) VALUES('p','commons',X'1234','image/png',1,1,'File.png','https://commons.wikimedia.org/','t')", []).unwrap();
        c.execute("DELETE FROM collection_people WHERE id='p'", [])
            .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM collection_person_portraits",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn character_suggestions_migration_from_105_preserves_tagger_data() {
        let mut c = Connection::open_in_memory().unwrap();
        historical_schema(&mut c, 105);
        c.execute("INSERT INTO tagger_character_vocabulary VALUES('pixai','new_character')", []).unwrap();
        migrate_to_latest(&mut c, 105).unwrap();
        assert_eq!(c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        assert_eq!(c.query_row("SELECT tag FROM tagger_character_vocabulary", [], |r| r.get::<_, String>(0)).unwrap(), "new_character");
        c.execute("INSERT INTO character_suggestion_ignored_tags VALUES('new_character','now')", []).unwrap();
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
        c.execute_batch(UNDO_AFTER_102).unwrap();
        c.pragma_update(None, "user_version", 102).unwrap();
        migrate_to_latest(&mut c, 102).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM character_suggestion_ignored_tags", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn tagger_migration_from_104_preserves_previous_objects_and_edits() {
        let mut c = Connection::open_in_memory().unwrap();
        historical_schema(&mut c, 104);
        c.execute_batch("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES('a','h','image','a','assets/a','thumbnails/a',1,1,1,'now');
            INSERT INTO asset_auto_tag_edits(asset_id,tag,state,created_at) VALUES('a','hair','removed','now');").unwrap();
        migrate_to_latest(&mut c,104).unwrap();
        assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),SCHEMA_VERSION);
        assert_eq!(c.query_row("SELECT state FROM asset_auto_tag_edits WHERE asset_id='a'",[],|r|r.get::<_,String>(0)).unwrap(),"removed");
        for table in ["av_link_inbox","character_folder_order","asset_tagger_character_scores","character_tagger_candidates"] {
            c.prepare(&format!("SELECT * FROM {table}")).unwrap();
        }
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
        c.execute_batch(UNDO_AFTER_102).unwrap();
        c.pragma_update(None,"user_version",102).unwrap();
        migrate_to_latest(&mut c,102).unwrap();
    }

    #[test]
    fn av_link_migration_from_103_preserves_collection_people_and_order() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 103);
        connection.execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('av-fixture','Original','av','t','t');
            INSERT INTO collection_av_details(collection_id,product_code,label,series,revision) VALUES('av-fixture','SSIS-001','manual','series',7);
            INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES('person-fixture','Original person','t','t');
            INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES('av-fixture','person-fixture','performer',0);").unwrap();
        migrate_to_latest(&mut connection, 103).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(connection.query_row("SELECT label,revision,title_ja FROM collection_av_details WHERE collection_id='av-fixture'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?))).unwrap(),("manual".into(),7,None));
        assert_eq!(
            connection
                .query_row(
                    "SELECT display_name,name_ja FROM collection_people WHERE id='person-fixture'",
                    [],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                )
                .unwrap(),
            ("Original person".into(), None)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT sort_order FROM collection_person_relations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(connection
            .prepare("SELECT * FROM character_folder_order")
            .is_ok());
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM av_link_inbox", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
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
    }

    #[test]
    fn v100_adds_artist_link_tables_and_the_scope_view_without_touching_assets() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 99);
        connection
            .execute_batch(
                "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    creator_name, creator_handle, source_url)
                 VALUES ('a', 'ha', 'image', 'a.png', 'assets/a.png', 'thumbnails/a.webp', 1, 1, 1,
                    '2026-01-01T00:00:00Z', 'Kiri', 'kiri_draws', 'https://x.com/kiri_draws/status/1'),
                        ('b', 'hb', 'image', 'b.png', 'assets/b.png', 'thumbnails/b.webp', 1, 1, 1,
                    '2026-01-01T00:00:00Z', NULL, NULL, NULL);",
            )
            .unwrap();
        migrate_to_latest(&mut connection, 99).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let settings: (i64, i64, i64) = connection
            .query_row(
                "SELECT main_min_count, recent_min_count, recent_days FROM artist_settings",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(settings, (5, 2, 30));
        // No artist rows are created for existing creators; they stay implicit.
        let artists: i64 = connection
            .query_row("SELECT COUNT(*) FROM artists", [], |row| row.get(0))
            .unwrap();
        assert_eq!(artists, 0);
        let scopes: Vec<(String, String)> = connection
            .prepare("SELECT asset_id, scope_ref FROM asset_artist_scope ORDER BY asset_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            scopes,
            vec![
                ("a".into(), "kiri_draws".into()),
                ("b".into(), "unknown:none".into())
            ]
        );
        // A dismissal is an ordered pair, and a source-URL assignment names its handle.
        assert!(connection
            .execute(
                "INSERT INTO artist_merge_dismissals VALUES ('b', 'a', '2026-01-01T00:00:00Z')",
                []
            )
            .is_err());
        connection
            .execute_batch(
                "INSERT INTO artists (id, created_at, updated_at) VALUES ('x', 't', 't');",
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO asset_artist_assignments VALUES ('b', 'x', 'source_url', NULL, 't')",
                []
            )
            .is_err());
        connection
            .execute(
                "INSERT INTO asset_artist_assignments VALUES ('b', 'x', 'manual', NULL, 't')",
                [],
            )
            .unwrap();
        let scope: String = connection
            .query_row(
                "SELECT scope_ref FROM asset_artist_scope WHERE asset_id = 'b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scope, "artist:x");
    }

    #[test]
    fn v98_adds_the_release_calendar_and_wishlist_tables_with_their_constraints() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 97);
        migrate_to_latest(&mut connection, 97).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        connection
            .execute_batch(
                "INSERT INTO release_watch_items(id,kind,provider,external_id,title,source,added_at)
                 VALUES('igdb:7','game','igdb','7','게임','calendar','2026-09-26T00:00:00Z');
                 INSERT INTO release_watch_dates(item_id,region,platform,date,precision,checked_at)
                 VALUES('igdb:7','korea','PC','2026-10-01','month','2026-09-26T00:00:00Z'),
                       ('igdb:7','worldwide','PC',NULL,'tbd','2026-09-26T00:00:00Z');
                 INSERT INTO release_watch_item_events(id,item_id,event_kind,current_value,detected_at)
                 VALUES('e1','igdb:7','date_set','2026-10','2026-09-26T00:00:00Z');",
            )
            .unwrap();
        // The id is always provider:external_id, and a movie is never an IGDB title.
        for bad in [
            "INSERT INTO release_watch_items(id,kind,provider,external_id,title,source,added_at) VALUES('x','game','igdb','8','g','calendar','t')",
            "INSERT INTO release_watch_items(id,kind,provider,external_id,title,source,added_at) VALUES('igdb:9','movie','igdb','9','g','calendar','t')",
            "INSERT INTO release_watch_dates(item_id,region,platform,date,precision,checked_at) VALUES('igdb:7','asia','',NULL,'exact','t')",
        ] {
            assert!(connection.execute(bad, []).is_err(), "{bad}");
        }
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection
            .execute("DELETE FROM release_watch_items WHERE id='igdb:7'", [])
            .unwrap();
        for table in ["release_watch_dates", "release_watch_item_events"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} rows follow their watched title");
        }
    }

    #[test]
    fn v94_adds_empty_similarity_review_state_and_queues_only_new_materializations() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 93);
        connection
            .execute_batch(
                "INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection,materialization)
                 VALUES('done','normal',1,'{}','complete'),('later','normal',1,'{}','pending');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 93).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for table in [
            "mobile_similarity_review_sync",
            "mobile_similarity_review_receipts",
            "mobile_similarity_review_poll",
            "mobile_similarity_review_feed_state",
            "similarity_auto_compare_queue",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} starts empty");
        }
        // Existing complete Assets are not queued; a later pending -> complete transition is.
        connection
            .execute_batch("UPDATE asset_authority_state SET materialization='complete';")
            .unwrap();
        let queued: Vec<String> = connection
            .prepare("SELECT asset_id FROM similarity_auto_compare_queue")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(queued, vec!["later".to_string()]);
    }

    #[test]
    fn v93_adds_an_empty_purge_pending_table_without_touching_assets() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 92);
        let assets: i64 = connection
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .unwrap();

        migrate_to_latest(&mut connection, 92).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_purge_pending", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            assets
        );
        // Paths are recorded only once the tombstone is accepted.
        assert!(connection
            .execute(
                "INSERT INTO asset_purge_pending(asset_id,requested_at,relative_path)
                 VALUES('a','now','assets/a.png')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO asset_purge_pending(asset_id,requested_at) VALUES('a','now')",
                [],
            )
            .is_ok());
    }

    #[test]
    fn v92_adds_empty_character_review_state_without_touching_decisions() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 91);
        let decisions: i64 = connection
            .query_row("SELECT COUNT(*) FROM character_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();

        migrate_to_latest(&mut connection, 91).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for table in [
            "mobile_character_review_sync",
            "mobile_character_review_receipts",
            "mobile_character_review_poll",
            "mobile_character_review_feed_state",
        ] {
            let rows: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0, "{table}");
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM character_decisions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            decisions
        );
        let insert = |outcome: &str| {
            connection.execute(
                "INSERT INTO mobile_character_review_receipts
                 (endpoint,library_id,operation_id,sequence,target_id,asset_id,asset_sha256,decision,origin,basis,outcome,decision_sequence,created_at)
                 VALUES('e','0123456789abcdef0123456789abcdef',?1,1,'t','a','h','accepted','feed','0',?1,NULL,'now')",
                [outcome],
            )
        };
        assert!(insert("unknown").is_err());
        assert!(insert("skipped:targetMissing").is_ok());
    }

    #[test]
    fn v91_adds_empty_collection_personal_edit_state_without_touching_collections() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 90);
        connection
            .execute_batch(
                "INSERT INTO collections(id,name,type,my_score,description,created_at,updated_at)
                 VALUES('c','Work','manga',3.5,'memo','2026','2026');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 90).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for table in [
            "mobile_collection_personal_edit_sync",
            "mobile_collection_personal_edit_receipts",
            "mobile_collection_personal_edit_poll",
        ] {
            let rows: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0, "{table}");
        }
        let kept: (f64, String) = connection
            .query_row(
                "SELECT my_score, description FROM collections WHERE id='c'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept, (3.5, "memo".to_string()));
        assert!(connection
            .execute(
                "INSERT INTO mobile_collection_personal_edit_receipts
                 VALUES('e','0123456789abcdef0123456789abcdef','op',1,'c','rating','1','null','applied','now')",
                [],
            )
            .is_err());
    }

    #[test]
    fn v90_preserves_incoming_reviews_and_cloud_capture_links() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 89);
        connection.execute_batch(
            "INSERT INTO assets
             (id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,
              byte_size,width,height,collected_at,status)
             VALUES
             ('existing','hash-existing','image','existing.png','assets/existing.png','thumbnails/existing.webp',1,100,100,'now','normal'),
             ('candidate','hash-candidate','image','candidate.png','assets/candidate.png','thumbnails/candidate.webp',1,100,100,'now','review');
             INSERT INTO similarity_reviews
             (id,existing_asset_id,candidate_asset_id,distance,fingerprint_kind,status,created_at)
             VALUES('review','existing','candidate',2,'pdq-v1','open','now');
             INSERT INTO cloud_capture_reviews(endpoint,capture_id,review_id)
             VALUES('capture','capture-1','review');",
        ).unwrap();

        migrate_to_latest(&mut connection, 89).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT review_kind FROM similarity_reviews WHERE id='review'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "incoming",
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_id FROM cloud_capture_reviews WHERE capture_id='capture-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "review",
        );
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn v60_binds_legacy_originals_root_to_persistent_role() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 57);
        connection.execute(
            "INSERT INTO classification_entries(id,kind,name,parent_id,created_at,icon_key,color_key) VALUES('legacy-originals','root','오리지널',NULL,'old',NULL,NULL)",
            [],
        ).unwrap();

        migrate_to_latest(&mut connection, 57).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT classification_id FROM classification_roles WHERE role='originals'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "legacy-originals"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM classification_entries WHERE id='lakomics-originals'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v60_reopens_only_multi_person_reference_resolved_jobs() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 59);
        connection.execute_batch(r#"
            INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
            VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
            INSERT INTO character_series(classification_id,auto_classify) VALUES('series',1);
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at)
            VALUES('target','series','A',1,0,'now','now');
            INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES('affected','same-hash','image','affected.png','assets/affected.png','thumbnails/affected.webp',1,1,1,'now','normal'),
                  ('safe','safe-hash','image','safe.png','assets/safe.png','thumbnails/safe.webp',1,1,1,'now','normal');
            INSERT INTO asset_classifications VALUES('affected','series'),('safe','series');
            INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at)
            VALUES('affected',1,1,'same-hash','assets/affected.png','["series"]','completed','resolved',0,'ingestion','now'),
                  ('safe',1,1,'safe-hash','assets/safe.png','["series"]','completed','resolved',0,'ingestion','now');
            INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at)
            VALUES('e-affected','affected',1,1,'same-hash','context','runtime','{}','[]','now'),
                  ('e-safe','safe',1,1,'safe-hash','context','runtime','{}','[]','now');
            INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json)
            VALUES('e-affected','target','series','fingerprint','{"assetId":"affected","contentHash":"same-hash","state":"recommended","evidence":{"queryBoxes":[[0,0,10,10],[20,0,30,10]],"referenceHashes":["same-hash","a","b","c","d"]},"error":null}'),
                  ('e-safe','target','series','fingerprint','{"assetId":"safe","contentHash":"safe-hash","state":"recommended","evidence":{"queryBoxes":[[0,0,10,10],[20,0,30,10]],"referenceHashes":["other","a","b","c","d"]},"error":null}');
        "#).unwrap();

        connection
            .execute_batch(include_str!(
                "../../migrations/0060_character_correctness.sql"
            ))
            .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='affected'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "partially_resolved"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='safe'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "resolved"
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id='series'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

        migrate_to_latest(&mut connection, 60).unwrap();

        assert_eq!(connection.query_row("SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id='series'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v61_repairs_a_partially_recorded_v60_character_schema() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 59);
        connection.execute_batch(r#"
            INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
            VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
            INSERT INTO character_series(classification_id,auto_classify) VALUES('series',1);
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at)
            VALUES('target','series','A',1,0,'now','now');
            DELETE FROM character_autotag_reconsideration;
            INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES('affected','same-hash','image','affected.png','assets/affected.png','thumbnails/affected.webp',1,1,1,'now','normal'),
                  ('manual','manual-hash','image','manual.png','assets/manual.png','thumbnails/manual.webp',1,1,1,'now','normal');
            INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at)
            VALUES('affected',1,1,'same-hash','assets/affected.png','["series"]','completed','resolved',0,'ingestion','now'),
                  ('manual',1,1,'manual-hash','assets/manual.png','["series"]','pending','awaiting_candidates',1,'manual_scan','now');
            INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at)
            VALUES('e-affected','affected',1,1,'same-hash','context','runtime','{}','[]','now');
            INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json)
            VALUES('e-affected','target','series','fingerprint','{"assetId":"affected","contentHash":"same-hash","state":"recommended","evidence":{"queryBoxes":[[0,0,10,10],[20,0,30,10]],"referenceHashes":["same-hash","a","b","c","d"]},"error":null}');
            PRAGMA user_version=60;
        "#).unwrap();

        connection
            .execute_batch(include_str!(
                "../../migrations/0061_character_correctness_forward_repair.sql"
            ))
            .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT classification_id FROM classification_roles WHERE role='originals'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "lakomics-originals"
        );
        assert_eq!(connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'character_base_reference_%'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap(), 3);
        let target_trigger: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='character_autotag_target_update'",
            [], |row| row.get(0),
        ).unwrap();
        assert!(!target_trigger.contains("UPDATE OF revision"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT priority FROM character_autotag_jobs WHERE asset_id='manual'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT priority FROM character_autotag_jobs WHERE asset_id='affected'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='affected'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "partially_resolved"
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id='series'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

        migrate_to_latest(&mut connection, 61).unwrap();

        assert_eq!(connection.query_row("SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id='series'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v61_does_not_requeue_rows_already_repaired_by_complete_v60() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 59);
        connection.execute_batch(r#"
            INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
            VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
            INSERT INTO character_series(classification_id,auto_classify) VALUES('series',1);
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at)
            VALUES('target','series','A',1,0,'now','now');
            DELETE FROM character_autotag_reconsideration;
            INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES('affected','same-hash','image','affected.png','assets/affected.png','thumbnails/affected.webp',1,1,1,'now','normal');
            INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at)
            VALUES('affected',1,1,'same-hash','assets/affected.png','["series"]','completed','resolved',0,'ingestion','now');
            INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at)
            VALUES('e-affected','affected',1,1,'same-hash','context','runtime','{}','[]','now');
            INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json)
            VALUES('e-affected','target','series','fingerprint','{"assetId":"affected","contentHash":"same-hash","state":"recommended","evidence":{"queryBoxes":[[0,0,10,10],[20,0,30,10]],"referenceHashes":["same-hash","a","b","c","d"]},"error":null}');
        "#).unwrap();
        connection
            .execute_batch(include_str!(
                "../../migrations/0060_character_correctness.sql"
            ))
            .unwrap();
        let before: i64 = connection
            .query_row(
                "SELECT revision FROM character_autotag_reconsideration WHERE series_id='series'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        connection
            .execute_batch(include_str!(
                "../../migrations/0061_character_correctness_forward_repair.sql"
            ))
            .unwrap();

        let after_v61: i64 = connection
            .query_row(
                "SELECT revision FROM character_autotag_reconsideration WHERE series_id='series'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_v61, before);

        migrate_to_latest(&mut connection, 61).unwrap();

        assert_eq!(connection.query_row("SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id='series'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='affected'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "partially_resolved"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v62_adds_target_scoped_prediction_lookup() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 61);
        migrate_to_latest(&mut connection, 61).unwrap();
        assert_eq!(connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='character_autotag_predictions_target_scope'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v63_adds_recommended_review_partial_index() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 62);
        connection
            .execute_batch(include_str!(
                "../../migrations/0063_character_review_performance.sql"
            ))
            .unwrap();
        let sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='character_autotag_predictions_recommended'",
            [], |row| row.get(0),
        ).unwrap();
        assert!(sql.contains("target_fingerprint"));
        assert!(sql.contains("json_extract(result_json,'$.state')='recommended'"));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            63
        );
    }

    #[test]
    fn v64_adds_generation_bound_character_review_completion() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 63);
        migrate_to_latest(&mut connection, 63).unwrap();
        let sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='character_review_completions'",
            [], |row| row.get(0),
        ).unwrap();
        assert!(sql.contains("generation INTEGER NOT NULL"));
        assert!(sql.contains("source_generation INTEGER NOT NULL"));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v65_aligns_superseded_review_state_without_touching_live_work() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 64);
        connection.execute_batch(r#"
            INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES('stale','h1','image','stale.png','assets/stale.png','thumbnails/stale.webp',1,1,1,'now','normal'),
                  ('done','h2','image','done.png','assets/done.png','thumbnails/done.webp',1,1,1,'now','normal'),
                  ('open','h3','image','open.png','assets/open.png','thumbnails/open.webp',1,1,1,'now','normal');
            INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at)
            VALUES('stale',1,1,'h1','assets/stale.png','["series"]','superseded','unresolved',0,'ingestion','now'),
                  ('done',1,1,'h2','assets/done.png','["series"]','completed','resolved',0,'ingestion','now'),
                  ('open',1,1,'h3','assets/open.png','["series"]','completed','unresolved',0,'ingestion','now');
        "#).unwrap();

        migrate_to_latest(&mut connection, 64).unwrap();

        // The terminal row now agrees with its state.
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='stale'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "superseded"
        );
        // Completed work keeps its own review state; this is not a blanket rewrite.
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='done'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "resolved"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT review_state FROM character_autotag_jobs WHERE asset_id='open'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "unresolved"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v66_preserves_character_history_and_stops_implicit_reconsideration() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 65);
        connection.execute_batch(r#"
            INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
            VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
            INSERT INTO character_series(classification_id,auto_classify) VALUES('series',1);
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at)
            VALUES('target','series','A',1,0,'now','now');
            INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES('query','query-hash','image','query.png','assets/query.png','thumbnails/query.webp',1,1,1,'now','normal'),
                  ('ref','ref-hash','image','ref.png','assets/ref.png','thumbnails/ref.webp',1,1,1,'now','normal'),
                  ('ref-new','ref-new-hash','image','ref-new.png','assets/ref-new.png','thumbnails/ref-new.webp',1,1,1,'now','normal');
            INSERT INTO asset_classifications VALUES('query','series'),('ref','series'),('ref-new','series');
            INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at)
            VALUES('target','ref','ref-hash','now');
            INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
            VALUES('target','query','query','query-hash','accepted','fingerprint','{}','manual','now');
            INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at)
            VALUES('query',1,1,'query-hash','assets/query.png','["series"]','completed','resolved',1,'ingestion','now');
            INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at)
            VALUES('evidence','query',1,1,'query-hash','context','runtime','{}','[]','now');
            INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json)
            VALUES('evidence','target','series','fingerprint','{"assetId":"query","contentHash":"query-hash","state":"recommended","error":null}');
        "#).unwrap();

        migrate_to_latest(&mut connection, 65).unwrap();

        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM character_relations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM character_decisions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM character_autotag_evidence",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM character_autotag_predictions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM character_autotag_reconsideration",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='character_reference_refreshes'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

        connection.execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES('target','ref-new','ref-new-hash','later')", []).unwrap();
        connection
            .execute(
                "UPDATE character_targets SET enabled=0 WHERE id='target'",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM character_autotag_reconsideration",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn character_reference_refresh_pause_v67_clears_hidden_legacy_worker_pause() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 66);
        connection
            .execute(
                "UPDATE character_autotag_control SET paused=1 WHERE singleton=1",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 66).unwrap();

        let (worker_paused, refresh_paused): (bool, bool) = connection
            .query_row(
                "SELECT paused,reference_refresh_paused FROM character_autotag_control WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!worker_paused);
        assert!(!refresh_paused);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn v68_marks_eagerly_created_refresh_requests_as_fully_discovered() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 67);
        connection.execute_batch(
            r#"
            INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
            VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
            INSERT INTO character_series(classification_id,auto_classify) VALUES('series',1);
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at)
            VALUES('target','series','A',1,0,'now','now');
            INSERT INTO character_reference_refreshes(
                target_id,series_classification_id,target_revision,request_revision,
                requested_reference_set_hash,requested_reference_hashes_json,added_reference_hashes_json,
                state,requested_at,updated_at)
            VALUES('target','series',1,1,'hash','[]','[]','running',1,1);
            "#,
        )
        .unwrap();

        migrate_to_latest(&mut connection, 67).unwrap();

        assert!(connection
            .query_row(
                "SELECT discovery_complete FROM character_reference_refreshes WHERE target_id='target'",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
    }

    #[test]
    fn v69_repairs_early_v68_without_rewriting_complete_v68_state() {
        for early_v68 in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            std::fs::create_dir(temp.path().join("backups")).unwrap();
            let path = temp.path().join("library.sqlite");
            let mut connection = Connection::open(&path).unwrap();
            if early_v68 {
                historical_schema(&mut connection, 67);
                connection.execute_batch(
                    "ALTER TABLE character_reference_refreshes ADD COLUMN discovery_complete INTEGER NOT NULL DEFAULT 0 CHECK(discovery_complete IN (0,1)); PRAGMA user_version=68;"
                ).unwrap();
            } else {
                historical_schema(&mut connection, 68);
            }
            connection.execute_batch(r#"
                INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
                VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
                INSERT INTO character_series(classification_id,auto_classify) VALUES('series',1);
                INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at)
                VALUES('target','series','A',1,0,'now','now');
                INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                VALUES('kept','hash','image','kept.png','assets/kept.png','thumbnails/kept.webp',1,1,1,'now','normal');
                INSERT INTO character_autotag_jobs(asset_id,generation,content_hash,relative_path,classification_ids,state,review_state,cause,updated_at)
                VALUES('kept',1,'hash','assets/kept.png','["series"]','completed','resolved','ingestion','now');
                INSERT INTO character_reference_refreshes(target_id,series_classification_id,target_revision,
                    requested_reference_set_hash,requested_reference_hashes_json,added_reference_hashes_json,
                    state,requested_at,updated_at,after_asset_id,visited_count)
                VALUES('target','series',1,'refs','[]','[]','running',1,1,'before',7);
                UPDATE character_autotag_control SET paused=1,reference_refresh_paused=1,completed=12,confirmed=3;
            "#).unwrap();
            if !early_v68 {
                connection.execute_batch(
                    "UPDATE character_autotag_admissions SET sequence=42; UPDATE character_reference_refreshes SET through_job_sequence=41;"
                ).unwrap();
            }
            drop(connection);

            // Exercise the real startup path, including its pre-migration backup.
            let connection = initialize_database(&path).unwrap();
            let snapshots = std::fs::read_dir(temp.path().join("backups"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            assert_eq!(snapshots.len(), 1);
            let backup = Connection::open(&snapshots[0]).unwrap();
            assert_eq!(
                backup
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                68
            );
            assert_eq!(
                backup
                    .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            drop(backup);
            let (cursor, through, visited): (String, i64, i64) = connection.query_row(
                "SELECT after_asset_id,through_job_sequence,visited_count FROM character_reference_refreshes WHERE target_id='target'",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(
                (cursor.as_str(), through, visited),
                ("before", if early_v68 { 1 } else { 41 }, 7)
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT sequence FROM character_autotag_admissions WHERE asset_id='kept'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                if early_v68 { 1 } else { 42 }
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT state FROM character_autotag_jobs WHERE asset_id='kept'",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                "completed"
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(connection.query_row("SELECT paused,reference_refresh_paused,completed,confirmed FROM character_autotag_control", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))).unwrap(), (1,1,12,3));
            connection.execute_batch(r#"
                INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at)
                VALUES('new','new-hash','image','new.png','assets/new.png','thumbnails/new.webp',1,1,1,'later');
                INSERT INTO character_autotag_jobs(asset_id,generation,content_hash,relative_path,classification_ids,state,review_state,cause,updated_at)
                VALUES('new',1,'new-hash','assets/new.png','[]','pending','unresolved','ingestion','later');
            "#).unwrap();
            assert_eq!(
                connection
                    .query_row(
                        "SELECT sequence FROM character_autotag_admissions WHERE asset_id='new'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                if early_v68 { 2 } else { 43 }
            );
            assert!(!connection
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap());
            drop(connection);
            let reopened = initialize_database(&path).unwrap();
            assert_eq!(
                reopened
                    .query_row(
                        "SELECT COUNT(*) FROM character_autotag_admissions",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                2
            );
            assert_eq!(
                std::fs::read_dir(temp.path().join("backups"))
                    .unwrap()
                    .count(),
                1
            );
        }
    }

    #[test]
    fn classification_legacy_triggers_stop_dirtying_once_authority_is_adopted() {
        // Upgrading a pre-2E database must leave an unadopted library with the legacy
        // Classification dirty behaviour, and must stop maintaining that state once the
        // authority adoption row exists. 0084 is the last pre-2E migration, so
        // `historical_schema(.., 84)` is exactly the schema this migration upgrades.
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 84);
        migrate_to_latest(&mut connection, 84).unwrap();
        connection
            .execute_batch(
                "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,
                                    thumbnail_relative_path,byte_size,width,height,collected_at)
                 VALUES('a','h','image','a.png','assets/a.png','t/a.webp',1,1,1,'now');
                 INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
                 VALUES('root','root','루트',NULL,'now');",
            )
            .unwrap();

        let generation = |connection: &Connection| -> i64 {
            connection
                .query_row(
                    "SELECT generation FROM cloud_metadata_publication_state
                     WHERE kind = 'classifications'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };

        let before = generation(&connection);
        connection
            .execute(
                "INSERT INTO asset_classifications(asset_id,classification_id) VALUES('a','root')",
                [],
            )
            .unwrap();
        assert_eq!(
            generation(&connection),
            before + 1,
            "an unadopted library still dirties the legacy Classification generation"
        );

        // Adopt, then mutate again through the same statement.
        connection
            .execute(
                "INSERT INTO classification_authority_sync(singleton,library_id,epoch,
                    contract_version,cursor,updated_at)
                 VALUES(1,'0123456789abcdef0123456789abcdef',1,1,0,'now')",
                [],
            )
            .unwrap();
        let adopted = generation(&connection);
        connection
            .execute("DELETE FROM asset_classifications WHERE asset_id='a'", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_classifications(asset_id,classification_id) VALUES('a','root')",
                [],
            )
            .unwrap();
        assert_eq!(
            generation(&connection),
            adopted,
            "an adopted library must not maintain the retired legacy counter"
        );
        // The other legacy domains are genuinely shared and must be untouched.
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM cloud_metadata_publication_state",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn character_autotag_migration_does_not_enqueue_history() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 49);
        connection.execute_batch("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at)
            VALUES('covered','hash','image','covered.png','assets/covered.png','thumbnails/covered.webp',1,1,1,'before');").unwrap();
        migrate_to_latest(&mut connection, 49).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM assets WHERE id='covered'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn explicit_character_learning_v55_preserves_effective_examples_without_requeue() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 54);
        connection.execute_batch("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('series','tag','Series','before');
            INSERT INTO character_series(classification_id) VALUES('series');
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,created_at,updated_at) VALUES('target','series','Target',1,'before','before');").unwrap();
        for i in 0..6 {
            connection.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                VALUES(?1,?2,'image',?3,?4,?5,1,1,1,'before','normal')",
                rusqlite::params![format!("asset-{i}"),format!("hash-{i}"),format!("{i}.png"),format!("assets/{i}.png"),format!("thumbnails/{i}.webp")]).unwrap();
            connection.execute("INSERT INTO asset_classifications(asset_id,classification_id) VALUES(?1,'series')", [format!("asset-{i}")]).unwrap();
            if i < 5 {
                connection.execute("INSERT INTO character_references(target_id,slot,asset_id,asset_hash) VALUES('target',?1,?2,?3)",
                    rusqlite::params![i,format!("asset-{i}"),format!("hash-{i}")]).unwrap();
            }
        }
        connection.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
            VALUES('target','asset-5','asset-5','hash-5','accepted','fingerprint',?1,'manual','after')",
            [r#"{"prediction":{"queryBoxes":[[0,0,10,10]],"wholeFallback":false}}"#]).unwrap();
        connection
            .execute("DELETE FROM character_autotag_reconsideration", [])
            .unwrap();
        migrate_to_latest(&mut connection, 54).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM character_learned_references WHERE target_id='target' AND asset_id='asset-5' AND asset_hash='hash-5'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM character_autotag_reconsideration",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn character_series_suggestions_v57_adds_only_dismissal_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 56);
        migrate_to_latest(&mut connection, 56).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM character_series_suggestion_dismissals",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn similarity_orientation_v47_reindexes_orientation_capable_formats_only() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 46);
        for (id, path) in [
            ("jpeg", "assets/a.jpg"),
            ("webp", "assets/b.webp"),
            ("png", "assets/c.png"),
        ] {
            connection.execute(
                "INSERT INTO assets (id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,perceptual_hash,perceptual_hash_quality)
                 VALUES (?1,?2,'image',?3,?4,?5,1,10,20,'2026-01-01T00:00:00Z',zeroblob(64),100)",
                rusqlite::params![id, format!("hash-{id}"), format!("{id}.img"), path, format!("thumb-{id}.webp")],
            ).unwrap();
        }
        migrate_to_latest(&mut connection, 46).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for id in ["jpeg", "webp"] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT perceptual_hash IS NULL FROM assets WHERE id=?1",
                        [id],
                        |row| row.get::<_, bool>(0)
                    )
                    .unwrap(),
                true
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT perceptual_hash IS NULL FROM assets WHERE id='png'",
                    [],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap(),
            false
        );
    }

    #[test]
    fn roadmap_v47_preserves_v44_relations_and_upgrades_restore_copy() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("backups")).unwrap();
        let path = temp.path().join("library.sqlite");
        let mut previous = Connection::open(&path).unwrap();
        historical_schema(&mut previous, 44);
        previous.execute_batch("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at)
            VALUES('asset','source-hash','image','kept.png','assets/kept.png','thumbnails/kept.webp',5,1,1,'before');
            INSERT INTO classification_entries(id,kind,name,created_at) VALUES('series','work','Kept series','before');
            INSERT INTO asset_classifications VALUES('asset','series');
            INSERT INTO collections(id,name,type,cover_asset_id,created_at,updated_at) VALUES('work','Kept game','game','asset','before','before');
            INSERT INTO collection_assets VALUES('work','asset','before');
            INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at)
            VALUES('cover','work','manual','front','cover','work-artwork/kept.png','image/png',1,1,1,'before','before');
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,created_at,updated_at) VALUES('character','series','Kept character',1,'before','before');
            INSERT INTO character_references VALUES('character',0,'asset','source-hash');
            INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,created_at)
            VALUES('character','asset','asset','source-hash','accepted','fingerprint','[]','before');
            INSERT INTO online_catalog_bookmarks VALUES('kHentai','123','before');").unwrap();
        drop(previous);
        let upgraded = initialize_database(&path).unwrap();
        let check_preserved = |connection: &Connection| {
            assert_eq!(
                connection
                    .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                SCHEMA_VERSION
            );
            for sql in [
                "SELECT count(*) FROM asset_classifications WHERE asset_id='asset' AND classification_id='series'",
                "SELECT count(*) FROM collection_assets WHERE collection_id='work' AND asset_id='asset'",
                "SELECT count(*) FROM collections WHERE id='work' AND type='game' AND cover_asset_id='asset'",
                "SELECT count(*) FROM collection_work_artworks WHERE id='cover' AND selected=1 AND kind='cover'",
                "SELECT count(*) FROM character_relations WHERE target_id='character' AND asset_id='asset'",
                "SELECT count(*) FROM character_references WHERE target_id='character' AND asset_hash='source-hash'",
                "SELECT count(*) FROM online_catalog_bookmarks WHERE provider='kHentai' AND work_id='123'",
            ] {
                assert_eq!(connection.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{sql}");
            }
            for table in [
                "video_similarity_reviews",
                "video_similarity_scans",
                "collection_av_details",
                "collection_people",
            ] {
                assert_eq!(
                    connection
                        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                            .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
            }
            assert!(!connection
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap());
        };
        check_preserved(&upgraded);
        drop(upgraded);
        let snapshot = std::fs::read_dir(temp.path().join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let original = Connection::open(&snapshot).unwrap();
        assert_eq!(
            original
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            44
        );
        drop(original);
        let restoration = temp.path().join("restore-copy.sqlite");
        std::fs::copy(&snapshot, &restoration).unwrap();
        prepare_snapshot_for_restore(&restoration).unwrap();
        check_preserved(&Connection::open(restoration).unwrap());
        assert_eq!(
            Connection::open(snapshot)
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            44
        );
    }

    #[test]
    fn catalog_groups_v35_preserves_v34_user_state_and_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("backups")).unwrap();
        let path = temp.path().join("library.sqlite");
        let mut connection = Connection::open(&path).unwrap();
        historical_schema(&mut connection, 34);
        connection
            .execute_batch(
                "INSERT INTO online_catalog_bookmarks VALUES ('provider','work','before');
            INSERT INTO remote_reading_progress VALUES ('provider','work',2,9,'before');
            INSERT INTO online_catalog_hidden_categories VALUES (2,'before');
            INSERT INTO online_catalog_blocked_tags VALUES ('artist','blocked','before');
            UPDATE online_catalog_settings SET last_success_at='checkpoint', last_added=123;",
            )
            .unwrap();
        drop(connection);
        let connection = initialize_database(&path).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for (sql, expected) in [
            ("SELECT work_id FROM online_catalog_bookmarks", "work"),
            ("SELECT last_read_at FROM remote_reading_progress", "before"),
            (
                "SELECT created_at FROM online_catalog_hidden_categories",
                "before",
            ),
            ("SELECT value FROM online_catalog_blocked_tags", "blocked"),
            (
                "SELECT last_success_at FROM online_catalog_settings",
                "checkpoint",
            ),
        ] {
            assert_eq!(
                connection
                    .query_row(sql, [], |r| r.get::<_, String>(0))
                    .unwrap(),
                expected
            );
        }
        assert_eq!(
            connection
                .query_row("SELECT last_added FROM online_catalog_settings", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            123
        );
        let snapshot = std::fs::read_dir(temp.path().join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let snapshot_db = Connection::open(snapshot).unwrap();
        assert_eq!(
            snapshot_db
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            34
        );
        assert_eq!(
            snapshot_db
                .query_row("SELECT work_id FROM online_catalog_bookmarks", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "work"
        );
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn catalog_counts_v36_preserves_v35_user_state_and_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("backups")).unwrap();
        let path = temp.path().join("library.sqlite");
        let mut connection = Connection::open(&path).unwrap();
        historical_schema(&mut connection, 35);
        connection
            .execute_batch(
                "INSERT INTO online_catalog_group_handles(provider,anchor_work_id,group_id) VALUES('provider','work','stable-uuid');
            INSERT INTO online_catalog_group_preferences VALUES('provider','work','edition',1);
            INSERT INTO online_catalog_bookmarks VALUES ('provider','work','before');
            INSERT INTO remote_reading_progress VALUES ('provider','work',2,9,'before');
            INSERT INTO online_catalog_hidden_categories VALUES (2,'before');
            INSERT INTO online_catalog_blocked_tags VALUES ('artist','blocked','before');
            UPDATE online_catalog_settings SET last_success_at='checkpoint', last_added=123;",
            )
            .unwrap();
        drop(connection);
        let connection = initialize_database(&path).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for (sql, expected) in [
            (
                "SELECT group_id FROM online_catalog_group_handles",
                "stable-uuid",
            ),
            (
                "SELECT selected_work_id FROM online_catalog_group_preferences",
                "edition",
            ),
            ("SELECT work_id FROM online_catalog_bookmarks", "work"),
            ("SELECT last_read_at FROM remote_reading_progress", "before"),
            (
                "SELECT created_at FROM online_catalog_hidden_categories",
                "before",
            ),
            ("SELECT value FROM online_catalog_blocked_tags", "blocked"),
            (
                "SELECT last_success_at FROM online_catalog_settings",
                "checkpoint",
            ),
        ] {
            assert_eq!(
                connection
                    .query_row(sql, [], |r| r.get::<_, String>(0))
                    .unwrap(),
                expected
            );
        }
        assert_eq!(
            connection
                .query_row("SELECT last_added FROM online_catalog_settings", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            123
        );
        let snapshot = std::fs::read_dir(temp.path().join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let snapshot_db = Connection::open(snapshot).unwrap();
        assert_eq!(
            snapshot_db
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            35
        );
        assert_eq!(
            snapshot_db
                .query_row("SELECT work_id FROM online_catalog_bookmarks", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "work"
        );
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn migrates_v27_to_cloud_queue_with_disabled_defaults() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
            COLLECTED_AT_UTC_SCHEMA,
            REVISIT_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 27).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT cloud_sync_enabled FROM library_settings WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT cloud_api_base_url FROM library_settings WHERE singleton = 1",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None,
        );
        // v28 큐 migration에 이어 0029 캡처 수신함 테이블까지 적용된다.
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );

        connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-1', 'asset', 'asset-1', 'upsert', 'pending', 1,
                           '2026-08-30T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-2', 'asset', 'asset-1', 'upsert', 'pending', 1,
                           '2026-08-30T00:00:01Z')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-3', 'asset', 'asset-2', 'upsert', 'unknown', 1,
                           '2026-08-30T00:00:02Z')",
                [],
            )
            .is_err());
    }

    #[test]
    fn migrates_v25_collected_at_offsets_to_utc_milliseconds() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES
                    ('later', 'hash-later', 'image', 'later.png', 'assets/later.png',
                     'thumbnails/later.webp', 1, 1, 1, '2026-08-13T14:00:00+09:00'),
                    ('earlier', 'hash-earlier', 'image', 'earlier.png', 'assets/earlier.png',
                     'thumbnails/earlier.webp', 1, 1, 1, '2026-08-13T04:30:00Z'),
                    ('invalid', 'hash-invalid', 'image', 'invalid.png', 'assets/invalid.png',
                     'thumbnails/invalid.webp', 1, 1, 1, 'legacy-invalid');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 25).unwrap();

        let mut statement = connection
            .prepare("SELECT id, collected_at FROM assets ORDER BY collected_at ASC")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("earlier".into(), "2026-08-13T04:30:00.000Z".into()),
                ("later".into(), "2026-08-13T05:00:00.000Z".into()),
                ("invalid".into(), "legacy-invalid".into()),
            ]
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }

    #[test]
    fn migrates_v24_similarity_state_to_pdq_v25() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    status, perceptual_hash, perceptual_hash_error
                 ) VALUES
                    ('existing', 'hash-existing', 'image', 'existing.png', 'assets/existing.png',
                     'thumbnails/existing.webp', 1, 100, 100, '2026-08-01T00:00:00Z',
                     'normal', X'0102030405060708', NULL),
                    ('candidate', 'hash-candidate', 'image', 'candidate.png', 'assets/candidate.png',
                     'thumbnails/candidate.webp', 1, 100, 100, '2026-08-02T00:00:00Z',
                     'review', X'1112131415161718', 'unsupported_image'),
                    ('gif', 'hash-gif', 'gif', 'moving.gif', 'assets/moving.gif',
                     'thumbnails/moving.webp', 1, 100, 100, '2026-08-03T00:00:00Z',
                     'normal', X'2122232425262728', NULL),
                    ('video', 'hash-video', 'video', 'clip.mp4', 'assets/clip.mp4',
                     NULL, 1, 100, 100, '2026-08-04T00:00:00Z',
                     'normal', NULL, 'unsupported_image');

                 INSERT INTO similarity_reviews (
                    id, existing_asset_id, candidate_asset_id, distance,
                    status, decision, created_at, resolved_at
                 ) VALUES
                    ('open-review', 'existing', 'candidate', 2,
                     'open', NULL, '2026-08-02T00:00:00Z', NULL),
                    ('resolved-review', 'existing', 'gif', 6,
                     'resolved', 'keep_both', '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 24).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM similarity_reviews WHERE fingerprint_kind = 'dhash-v1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM assets
                     WHERE perceptual_hash IS NOT NULL
                        OR perceptual_hash_quality IS NOT NULL
                        OR perceptual_hash_error IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
        assert!(connection
            .execute(
                "INSERT INTO similarity_reviews (
                    id, existing_asset_id, candidate_asset_id, distance,
                    fingerprint_kind, status, created_at
                 ) VALUES ('duplicate', 'existing', 'candidate', 20,
                           'pdq-v1', 'open', '2026-08-05T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    #[test]
    fn opens_a_routine_connection_while_another_connection_is_writing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE").unwrap();

        let opened = open_database(&path);

        writer.execute_batch("ROLLBACK").unwrap();
        assert!(opened.is_ok(), "{opened:?}");
    }

    #[test]
    fn migrates_v20_collection_legacy_kind_without_losing_collections() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, type, created_at, updated_at)
                 VALUES ('game-1', 'Normal Game', 'game', 't', 't')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 20).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT legacy_kind FROM collections WHERE id = 'game-1'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn migrates_v21_collection_foundation_without_rewriting_ratings() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO collections
                (id, name, type, author, my_score, showcase, created_at, updated_at)
             VALUES
                ('game-a', 'Game A', 'game', 'Studio A', 5, 1, '2026-01-01', '2026-01-01'),
                ('game-b', 'Game B', 'game', 'Studio B', 4, 1, '2026-01-02', '2026-01-02'),
                ('movie-a', 'Movie A', 'movie', NULL, 3, 1, '2026-01-01', '2026-01-01');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 21).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let game: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<f64>,
            Option<i64>,
        ) = connection
            .query_row(
                "SELECT developer, production_company, release_date, my_score, showcase_order
                     FROM collections WHERE id = 'game-a'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            game,
            (Some("Studio A".into()), None, None, Some(5.0), Some(0))
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT showcase_order FROM collections WHERE id = 'game-b'",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            Some(1)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT showcase_order FROM collections WHERE id = 'movie-a'",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            Some(0)
        );
    }

    #[test]
    fn migrates_v22_to_v23_game_provider_detail() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, type, created_at, updated_at)
                 VALUES ('game-1', 'Sega Game', 'game', 't', 't')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 22).unwrap();

        let provider_detail: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT publisher, platforms FROM collections WHERE id = 'game-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(provider_detail, (None, None));
    }

    #[test]
    fn migrates_v23_to_v24_movie_provider_detail() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, type, created_at, updated_at)
                 VALUES ('movie-1', 'Movie', 'movie', 't', 't')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 23).unwrap();

        let fields: (Option<String>, Option<i64>) = connection
            .query_row(
                "SELECT original_title, runtime_minutes FROM collections WHERE id = 'movie-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(fields, (None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v8_to_asset_source_provenance() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 8).unwrap();

        let metadata = connection
            .query_row(
                "SELECT source_published_at, creator_name, creator_handle, creator_url,
                        import_source, import_batch_id, original_modified_at
                   FROM assets WHERE id = 'asset-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(metadata, (None, None, None, None, None, None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v7_to_nested_albums_without_changing_classification_links() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 7).unwrap();

        connection
            .execute(
                "INSERT INTO albums (id, name, parent_id, icon_key, color_key, created_at)
                 VALUES ('album-1', '표지', NULL, NULL, NULL, '2026-08-12T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_albums (asset_id, album_id)
                 VALUES ('asset-1', 'album-1')",
                [],
            )
            .unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_existing_classifications_to_nullable_appearance() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                 VALUES ('folder-1', 'root', 'Games', NULL, '2026-08-11T00:00:00Z')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 6).unwrap();

        let appearance = connection
            .query_row(
                "SELECT icon_key, color_key FROM classification_entries WHERE id = 'folder-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(appearance, (None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v9_to_persisted_collections_without_changing_assets() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-16T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 9).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, cover_asset_id, created_at, updated_at
                 ) VALUES (
                    'collection-1', 'Favorites', NULL, 'asset-1',
                    '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collection_assets (collection_id, asset_id, added_at)
                 VALUES ('collection-1', 'asset-1', '2026-08-16T00:00:00Z')",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn migrates_v12_external_identity_to_normalized_binding() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, external_id,
                    external_source, external_synced_at, showcase, external_metadata_json,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, ' md-1 ', ' MangaDex ',
                    '2026-08-20T01:02:03Z', 0, '{\"title\":\"Provider title\"}',
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, external_id,
                    external_source, external_synced_at, showcase, external_metadata_json,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-2', 'Work Two', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, NULL, 'legacy-only', NULL, 0, 'raw-only',
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 12).unwrap();

        let migrated: (String, String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT provider, external_id, provider_data_json, last_synced_at
                 FROM collection_external_bindings WHERE collection_id = 'work-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(migrated.0, "mangadex");
        assert_eq!(migrated.1, "md-1");
        assert_eq!(
            migrated.2.as_deref(),
            Some("{\"title\":\"Provider title\"}")
        );
        assert_eq!(migrated.3.as_deref(), Some("2026-08-20T01:02:03Z"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT external_source, external_metadata_json
                     FROM collections WHERE id = 'work-2'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap(),
            ("legacy-only".into(), "raw-only".into())
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v13_to_v14_work_artwork_constraints() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0,
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 13).unwrap();

        connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
                    'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
                    'ja', 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-2', 'work-1', 'mangadex', 'cover-2', 'cover',
                    'work-artwork/work-1/art-2.jpg', 'image/jpeg', 100, 150,
                    NULL, 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-3', 'work-1', 'mangadex', 'cover-1', 'alternate',
                    'work-artwork/work-1/art-3.jpg', 'image/jpeg', 100, 150,
                    NULL, 0, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [],
            )
            .is_err());

        connection
            .execute("DELETE FROM collections WHERE id = 'work-1'", [])
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM collection_work_artworks", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v14_to_v15_collection_volumes() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0,
                    '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
                    'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
                    'ja', 1, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 14).unwrap();

        connection
            .execute(
                "INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    cover_artwork_id, source_provider, source_cover_id, source_file_name,
                    created_at, updated_at
                 ) VALUES (
                    'volume-1', 'work-1', 1, 0, 10,
                    'art-1', 'mangadex', 'cover-1', 'cover.jpg',
                    '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    created_at, updated_at
                 ) VALUES ('duplicate', 'work-1', 1, 0, 10, 't', 't')",
                [],
            )
            .is_err());
        for (id, volume_number, edition_index) in [("zero", 0, 0), ("edition-4", 2, 4)] {
            assert!(connection
                .execute(
                    "INSERT INTO collection_volumes (
                        id, collection_id, volume_number, edition_index, sort_order,
                        created_at, updated_at
                     ) VALUES (?1, 'work-1', ?2, ?3, 20, 't', 't')",
                    rusqlite::params![id, volume_number, edition_index],
                )
                .is_err());
        }

        connection
            .execute(
                "DELETE FROM collection_work_artworks WHERE id = 'art-1'",
                [],
            )
            .unwrap();
        let cover_id: Option<String> = connection
            .query_row(
                "SELECT cover_artwork_id FROM collection_volumes WHERE id = 'volume-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cover_id, None);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v15_to_aladin_volume_sources() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0, 't', 't', NULL
                 );
                 INSERT INTO collection_external_bindings (
                    collection_id, provider, external_id, provider_data_json,
                    last_synced_at, created_at, updated_at
                 ) VALUES ('work-1', 'mangadex', 'md-1', '{}', 't', 't', 't');
                 INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
                    'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
                    'ja', 1, 't', 't'
                 );
                 INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    cover_artwork_id, source_provider, source_cover_id, source_file_name,
                    created_at, updated_at
                 ) VALUES (
                    'volume-1', 'work-1', 1, 0, 1, 'art-1',
                    'mangadex', 'cover-1', 'cover.jpg', 't', 't'
                 );",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 15).unwrap();

        let config: Option<String> = connection
            .query_row(
                "SELECT provider_config_json FROM collection_external_bindings
                 WHERE collection_id = 'work-1' AND provider = 'mangadex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(config, None);
        connection
            .execute(
                "INSERT INTO collection_volume_sources (
                    collection_id, volume_number, provider, provider_item_id,
                    title, author, publisher, isbn13, publication_date, item_url,
                    provider_data_json, created_at, updated_at
                 ) VALUES (
                    'work-1', 1, 'aladin', 'item-1', '던전밥 1',
                    '쿠이 료코', '소미미디어', '9780000000001', '2026-09-01',
                    'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1', '{}', 't', 't'
                 )",
                [],
            )
            .unwrap();
        let cover: Option<String> = connection
            .query_row(
                "SELECT cover_artwork_id FROM collection_volumes WHERE id = 'volume-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cover.as_deref(), Some("art-1"));
    }

    #[test]
    fn migrates_v16_to_release_watch_without_enabling_bindings() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0, 't', 't', NULL
                 );
                 INSERT INTO collection_external_bindings (
                    collection_id, provider, external_id, provider_data_json,
                    last_synced_at, created_at, updated_at
                 ) VALUES ('work-1', 'aladin', 'item-1', '{}', 't', 't', 't');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 16).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM release_watch_subscriptions",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            0
        );
        assert!(connection
            .execute(
                "INSERT INTO release_watch_subscriptions (
                    collection_id, provider, last_checked_at
                 ) VALUES ('work-1', 'mangadex', NULL)",
                [],
            )
            .is_err());
        connection
            .execute(
                "INSERT INTO release_watch_subscriptions (
                    collection_id, provider, last_checked_at
                 ) VALUES ('work-1', 'aladin', NULL)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO release_watch_events (
                    id, collection_id, event_kind, volume_number,
                    previous_value, current_value, detected_at, read_at
                 ) VALUES (
                    'event-1', 'work-1', 'new_volume', 1,
                    NULL, '2026-09-01', '2026-08-22T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO release_watch_events (
                    id, collection_id, event_kind, volume_number,
                    detected_at, read_at
                 ) VALUES (
                    'event-2', 'work-1', 'renamed', 1,
                    '2026-08-22T00:00:00Z', NULL
                 )",
                [],
            )
            .is_err());

        connection
            .execute("DELETE FROM collections WHERE id = 'work-1'", [])
            .unwrap();
        for table in ["release_watch_subscriptions", "release_watch_events"] {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should cascade with the Collection");
        }
    }

    #[test]
    fn migrates_v17_to_online_catalog() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 17).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT update_enabled FROM online_catalog_settings WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );
        assert!(connection
            .prepare("SELECT provider, work_id, last_page FROM remote_reading_progress")
            .is_ok());
    }

    #[test]
    fn migrates_v18_to_online_catalog_bookmarks() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 18).unwrap();
        connection
            .execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
                 VALUES ('kHentai', '42', '2026-08-22T00:00:00Z')",
                [],
            )
            .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT provider || ':' || work_id FROM online_catalog_bookmarks",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "kHentai:42",
        );
    }

    #[test]
    fn migrates_v19_to_legacy_package_mappings() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-22T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 19).unwrap();

        for item in ["item-1", "item-2"] {
            connection
                .execute(
                    "INSERT INTO legacy_package_asset_mappings (
                        source_library_id, source_item_id, asset_id, source_sha256,
                        raw_metadata_json, imported_at
                     ) VALUES (
                        'legacy-library', ?1, 'asset-1',
                        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                        '{}', '2026-08-22T00:00:00Z'
                     )",
                    [item],
                )
                .unwrap();
        }
        assert!(connection
            .execute(
                "INSERT INTO legacy_package_asset_mappings (
                    source_library_id, source_item_id, asset_id, source_sha256,
                    raw_metadata_json, imported_at
                 ) VALUES (
                    'legacy-library', 'item-1', 'asset-1',
                    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                    '{}', '2026-08-22T00:00:00Z'
                 )",
                [],
            )
            .is_err());
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }

    #[test]
    fn migrates_v26_to_revisit_schema() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
            COLLECTED_AT_UTC_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 26).unwrap();

        for table in [
            "asset_activity",
            "revisit_slates",
            "revisit_bundles",
            "revisit_bundle_assets",
            "revisit_preferences",
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        [table],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
                    > 0
            );
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }
    #[test]
    fn migrates_v32_to_manga_catalog_recovery_source_paths() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 32);
        migrate_to_latest(&mut connection, 32).unwrap();

        let source_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('manga_catalog_recovery_links')
                 WHERE name = 'source_relative_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_column_count, 1);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }

    #[test]
    fn migrates_v33_to_online_catalog_visibility_preferences() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
            COLLECTED_AT_UTC_SCHEMA,
            REVISIT_SCHEMA,
            CLOUD_SYNC_QUEUE_SCHEMA,
            CLOUD_CAPTURE_IMPORTS_SCHEMA,
            CLOUD_BACKFILL_QUEUE_SCHEMA,
            CLOUD_BACKFILL_CONTROL_SCHEMA,
            MANGA_CATALOG_RECOVERY_SCHEMA,
            MANGA_CATALOG_RECOVERY_SOURCE_PATH_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
                 VALUES ('kHentai', 'preserved-v33-work', '2026-09-05T00:00:00Z')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 33).unwrap();

        for table in [
            "online_catalog_hidden_categories",
            "online_catalog_blocked_tags",
        ] {
            let table_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(table_count, 1, "missing migrated table {table}");
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT provider || ':' || work_id FROM online_catalog_bookmarks",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "kHentai:preserved-v33-work",
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }

    #[test]
    fn private_vault_registration_columns_default_to_null() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 76);

        migrate_to_latest(&mut connection, 76).unwrap();

        let registration: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT private_vault_id, private_vault_last_root FROM library_settings WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(registration, (None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v31_to_manga_catalog_recovery_links() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 31);
        migrate_to_latest(&mut connection, 31).unwrap();

        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'manga_catalog_recovery_links'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }
    #[test]
    fn kakao_watch_migration_preserves_legacy_subscription_and_foreign_keys() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE collection_external_bindings(collection_id TEXT, provider TEXT, PRIMARY KEY(collection_id,provider));
            CREATE TABLE release_watch_subscriptions(collection_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider='aladin'), last_checked_at TEXT,
                PRIMARY KEY(collection_id,provider), FOREIGN KEY(collection_id,provider) REFERENCES collection_external_bindings(collection_id,provider) ON DELETE CASCADE);
            CREATE INDEX release_watch_subscriptions_by_due ON release_watch_subscriptions(last_checked_at,collection_id);
            INSERT INTO collection_external_bindings VALUES ('work','aladin'),('work','kakao');
            INSERT INTO release_watch_subscriptions VALUES ('work','aladin','2026-09-05');").unwrap();
        connection
            .execute_batch(include_str!(
                "../../migrations/0040_book_release_providers.sql"
            ))
            .unwrap();
        let old: String = connection
            .query_row(
                "SELECT last_checked_at FROM release_watch_subscriptions WHERE provider='aladin'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old, "2026-09-05");
        connection
            .execute(
                "INSERT INTO release_watch_subscriptions VALUES ('work','kakao',NULL)",
                [],
            )
            .unwrap();
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        assert!(connection
            .execute(
                "INSERT INTO release_watch_subscriptions VALUES ('missing','kakao',NULL)",
                []
            )
            .is_err());
    }

    #[test]
    fn v80_adds_an_empty_bookmark_reconciliation_table() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 79);

        migrate_to_latest(&mut connection, 79).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        // No authority is adopted by migrating: the table exists but is empty, so
        // every pre-B5 read path stays byte-identical.
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM catalog_bookmark_sync", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
        // The table is singleton-keyed, so a second state row cannot be inserted.
        connection
            .execute(
                "INSERT INTO catalog_bookmark_sync (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1,'a1b2c3d4e5f60718293a4b5c6d7e8f90',1,1,0,'2026-09-14T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO catalog_bookmark_sync (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (2,'a1b2c3d4e5f60718293a4b5c6d7e8f90',1,1,0,'2026-09-14T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO catalog_bookmark_sync (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1,'a1b2c3d4e5f60718293a4b5c6d7e8f90',1,1,-1,'2026-09-14T00:00:00Z')",
                [],
            )
            .is_err());
    }

    /// v86 adds the durable pre-applied delete-transition markers, additively.
    ///
    /// The table exists so a delete change can tell "this PC already applied part of this
    /// transition when it confirmed the command" from "this replica is missing lineages the
    /// server says it sent". It is keyed by `(operation_id, epoch)` so a marker cannot be
    /// matched by a different delete or by a re-activated authority.
    #[test]
    fn v86_records_preapplied_deletes_without_disturbing_existing_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 85);
        // Existing authority state that the additive migration must leave exactly as it is.
        connection
            .execute(
                "INSERT INTO classification_authority_sync
                    (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1, 'lib', 1, 1, 7, '2026-09-17T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO classification_authority_assignment_revisions
                    (asset_id, classification_id, entity_revision, updated_at)
                 VALUES ('asset-1', 'originals', 3, '2026-09-17T00:00:00Z')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 85).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        // Migrating invents no record: nothing was pre-applied before the table existed.
        let records: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(records, 0);
        // The existing identity, cursor and assignment lineage survive untouched.
        assert_eq!(
            connection
                .query_row(
                    "SELECT library_id, epoch, cursor FROM classification_authority_sync",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?
                    )),
                )
                .unwrap(),
            ("lib".to_owned(), 1, 7)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT classification_id, entity_revision
                     FROM classification_authority_assignment_revisions WHERE asset_id = 'asset-1'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            ("originals".to_owned(), 3)
        );
        // The record constrains its own content, so a zero-sequence or negative-count row
        // cannot exist.
        assert!(connection
            .execute(
                "INSERT INTO classification_authority_preapplied_deletes
                    (operation_id, epoch, change_sequence, from_classification_id,
                     to_classification_id, affects_assignments, preapplied_moved, created_at)
                 VALUES ('op', 1, 0, 'doomed', NULL, 0, 0, '2026-09-17T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO classification_authority_preapplied_deletes
                    (operation_id, epoch, change_sequence, from_classification_id,
                     to_classification_id, affects_assignments, preapplied_moved, created_at)
                 VALUES ('op', 1, 2, 'doomed', NULL, -1, 0, '2026-09-17T00:00:00Z')",
                [],
            )
            .is_err());
        // One record per (operation id, epoch), so a replay cannot accumulate duplicates.
        connection
            .execute(
                "INSERT INTO classification_authority_preapplied_deletes
                    (operation_id, epoch, change_sequence, from_classification_id,
                     to_classification_id, affects_assignments, preapplied_moved, created_at)
                 VALUES ('op', 1, 2, 'doomed', 'parent', 2, 2, '2026-09-17T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO classification_authority_preapplied_deletes
                    (operation_id, epoch, change_sequence, from_classification_id,
                     to_classification_id, affects_assignments, preapplied_moved, created_at)
                 VALUES ('op', 1, 2, 'doomed', 'parent', 3, 2, '2026-09-17T00:00:00Z')",
                [],
            )
            .is_err());
    }

    #[test]
    fn v81_adds_an_empty_bookmark_outbox_and_revision_cache() {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 80);

        migrate_to_latest(&mut connection, 80).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        // Migrating enqueues nothing: an existing library becomes B6-capable
        // without inventing an operation for bookmarks it already holds.
        for table in ["catalog_bookmark_outbox", "catalog_bookmark_revisions"] {
            let rows: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0, "{table}");
        }
        // One intent per entity, and one revision per entity.
        connection
            .execute(
                "INSERT INTO catalog_bookmark_outbox VALUES('op','kHentai','3',1,1,0,'2026-09-15T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO catalog_bookmark_outbox VALUES('op2','kHentai','3',0,1,0,'2026-09-15T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO catalog_bookmark_revisions VALUES('kHentai','3',1)",
                [],
            )
            .is_ok());
        assert!(connection
            .execute(
                "INSERT INTO catalog_bookmark_revisions VALUES('kHentai','3',2)",
                [],
            )
            .is_err());
    }
