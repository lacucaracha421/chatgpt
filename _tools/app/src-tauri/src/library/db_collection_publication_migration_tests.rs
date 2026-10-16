    use super::*;

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

    fn state(c: &Connection, kind: &str) -> (i64, i64, i64, i64) {
        c.query_row(
            "SELECT generation,published_generation,first_dirty,last_dirty FROM mobile_publication_state WHERE kind=?1",
            [kind],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    /// Runs `write` from a clean and from an already-dirty state (rolled back each time)
    /// and returns both resulting Collections states.
    fn effect(c: &Connection, write: &str) -> [(i64, i64, i64, i64); 2] {
        let characters = state(c, "characters");
        let mut out = [(0, 0, 0, 0); 2];
        for (index, setup) in [
            "UPDATE mobile_publication_state SET generation=5,published_generation=5,first_dirty=0,last_dirty=0 WHERE kind='collections'",
            "UPDATE mobile_publication_state SET generation=7,published_generation=5,first_dirty=1,last_dirty=1 WHERE kind='collections'",
        ]
        .into_iter()
        .enumerate()
        {
            // Every write starts from the same rows; only the captured state survives.
            c.execute_batch("SAVEPOINT effect").unwrap();
            c.execute_batch(setup).unwrap();
            assert_eq!(c.execute(write, []).unwrap(), 1, "{write}");
            out[index] = state(c, "collections");
            c.execute_batch("ROLLBACK TO effect; RELEASE effect").unwrap();
        }
        assert_eq!(state(c, "characters"), characters, "{write}");
        out
    }

    fn assert_marked(result: [(i64, i64, i64, i64); 2], write: &str) {
        let [(g, p, first, last), (g2, p2, first2, last2)] = result;
        assert_eq!((g, p), (6, 5), "{write}");
        assert!(first > 1 && last > 1, "{write}");
        assert_eq!((g2, p2, first2), (8, 5, 1), "{write}");
        assert!(last2 > 1, "{write}");
    }

    #[test]
    fn collection_publication_migration_117_keeps_rows_and_marks_collections_changed() {
        let mut c = Connection::open_in_memory().unwrap();
        tests::historical_schema(&mut c, 116);
        c.execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('g','Game','game','c','u'),('m','Manga','manga','c','u'),('av','AV','av','c','u');
            INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('art','m','local','art','volume_cover','a.png','image/png',4,6,0,'c','u'),('front','av','local','front','cover','f.png','image/png',4,6,1,'c','u');
            INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,created_at,updated_at) VALUES('v','m',1,0,1,'art','c','u'),('w','m',2,0,2,'art','c','u');
            INSERT INTO collection_pc_records(collection_id,status,owned_platform) VALUES('g','playing','PS5');
            INSERT INTO collection_volume_cover_focus(volume_id,cover_artwork_id,focus_x,method) VALUES('v','art',0.25,'head');
            INSERT INTO collection_people(id,display_name,memo,created_at,updated_at) VALUES('p','Person','memo','c','u'),('q','Other',NULL,'c','u');
            INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,fetched_at) VALUES('p','stashdb','matched','s','Person','t');
            INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES('p','crop','front',0.1,0.1,0.5,0.5,'t');
            INSERT INTO av_favorite_performers(person_id,created_at) VALUES('p','t');
            UPDATE mobile_publication_state SET published_generation=generation WHERE kind='collections';").unwrap();
        let tables = [
            "collections",
            "collection_volumes",
            "collection_pc_records",
            "collection_volume_cover_focus",
            "collection_people",
            "collection_person_profiles",
            "collection_person_portraits",
            "av_favorite_performers",
            "mobile_publication_state",
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
        migrate_to_latest(&mut c, 116).unwrap();
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

        // The 0074 trigger on `collections` is the reference behaviour.
        let reference = effect(&c, "UPDATE collections SET name='Game 2' WHERE id='g'");
        assert_marked(reference, "collections");
        for write in [
            "INSERT INTO collection_pc_records(collection_id,status) VALUES('m','collecting')",
            "UPDATE collection_pc_records SET owned_platform='Switch' WHERE collection_id='g'",
            "DELETE FROM collection_pc_records WHERE collection_id='g'",
            "INSERT INTO collection_volume_cover_focus(volume_id,cover_artwork_id,focus_x,method) VALUES('w','art',NULL,'none')",
            "UPDATE collection_volume_cover_focus SET focus_x=0.5 WHERE volume_id='v'",
            "DELETE FROM collection_volume_cover_focus WHERE volume_id='v'",
            "INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES('r','New','c','u')",
            "UPDATE collection_people SET memo='changed' WHERE id='q'",
            "INSERT INTO collection_person_profiles(person_id,source,status,fetched_at) VALUES('q','stashdb','none','t')",
            "UPDATE collection_person_profiles SET height_cm=160 WHERE person_id='p'",
            "DELETE FROM collection_person_profiles WHERE person_id='p'",
            "INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES('q','crop','front',0.2,0.2,0.3,0.3,'t')",
            "UPDATE collection_person_portraits SET x=0.15 WHERE person_id='p'",
            "DELETE FROM collection_person_portraits WHERE person_id='p'",
            "INSERT INTO av_favorite_performers(person_id,created_at) VALUES('q','t')",
            "UPDATE av_favorite_performers SET created_at='t2' WHERE person_id='p'",
            "DELETE FROM av_favorite_performers WHERE person_id='p'",
            "DELETE FROM collection_people WHERE id='q'",
        ] {
            let result = effect(&c, write);
            assert_marked(result, write);
            assert_eq!(
                (result[0].0, result[0].1, result[1].0, result[1].1, result[1].2),
                (reference[0].0, reference[0].1, reference[1].0, reference[1].1, reference[1].2),
                "{write}"
            );
        }
    }
