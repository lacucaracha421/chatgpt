use super::*;

fn library() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE assets(id TEXT PRIMARY KEY,status TEXT,media_kind TEXT);
        INSERT INTO assets VALUES ('a','normal','image'),('b','normal','gif'),('c','normal','image'),
        ('gone','trash','image'),('video','normal','video');
        CREATE TABLE character_targets(id TEXT,display_name TEXT,series_classification_id TEXT);
        INSERT INTO character_targets VALUES ('target','레제/Reze','csm'),('empty','없는',NULL);
        CREATE TABLE classification_entries(id TEXT,name TEXT);
        INSERT INTO classification_entries VALUES ('csm','체인소맨'),('zzz','젠레스');
        CREATE TABLE character_target_tagger_tags(target_id TEXT,tag TEXT);
        INSERT INTO character_target_tagger_tags VALUES ('target','reze'),('target','reze_alt');
        CREATE TABLE asset_auto_tags(asset_id TEXT,tag TEXT,score REAL);
        INSERT INTO asset_auto_tags VALUES ('a','reze',0.35),('b','reze',0.7),('a','reze_alt',0.7),
        ('c','reze',0),('gone','reze',1),('video','reze',1);") .unwrap();
    conn
}
fn blob(dim: usize, first: u16) -> Vec<u8> {
    let mut bytes = vec![0; dim * 2];
    bytes[..2].copy_from_slice(&first.to_le_bytes());
    bytes
}
fn source(path: &Path, qwen: bool) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO meta VALUES ('format','lakomics-nl-search'),('version','1'),('siglip_dim','1152'),
        ('siglip_model','siglip'),('content_digest','first');
        CREATE TABLE siglip(asset_id TEXT PRIMARY KEY,vector BLOB);") .unwrap();
    for id in ["a", "b", "gone", "unknown"] {
        conn.execute(
            "INSERT INTO siglip VALUES (?1,?2)",
            params![id, blob(SIGLIP_DIM, 0x3c00)],
        )
        .unwrap();
    }
    if qwen {
        conn.execute_batch("INSERT INTO meta VALUES ('qwen_dim','4096'),('qwen_model','qwen'); CREATE TABLE qwen8b(asset_id TEXT PRIMARY KEY,vector BLOB);").unwrap();
        conn.execute(
            "INSERT INTO qwen8b VALUES ('a',?1)",
            [blob(QWEN_DIM, 0x3c00)],
        )
        .unwrap();
    }
    conn
}

#[test]
fn nl_search_import_filters_unknown_preserves_meta_and_skips_digest() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("inbox.sqlite");
    let output = temp.path().join("cache/vectors.sqlite");
    let _source = source(&input, true);
    let library = library();
    assert_eq!(
        import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap(),
        ImportCounts {
            siglip: 3,
            qwen8b: 1,
            skipped: 1
        }
    );
    let old = std::fs::read(&output).unwrap();
    let modified = std::fs::metadata(&output).unwrap().modified().unwrap();
    let store = read_only(&output).unwrap();
    let meta = metadata(&store).unwrap();
    assert_eq!(meta["siglip_model"], "siglip");
    assert_eq!(meta["qwen_model"], "qwen");
    assert!(meta.contains_key("imported_at"));
    drop(store);
    import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap();
    assert_eq!(old, std::fs::read(&output).unwrap());
    assert_eq!(
        modified,
        std::fs::metadata(&output).unwrap().modified().unwrap()
    );
    assert!(import_cache(&known_assets(&library).unwrap(), &output, &output).is_err());
}

#[test]
fn nl_search_invalid_import_never_replaces_existing_cache() {
    for defect in [
        "format",
        "version",
        "siglip_dim",
        "qwen_dim",
        "nan",
        "zero",
        "size",
        "qwen_size",
        "unknown_nan",
        "missing_table",
        "missing_column",
        "duplicate",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("inbox.sqlite");
        let output = temp.path().join("vectors.sqlite");
        let conn = source(&input, true);
        let library = library();
        import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap();
        let old = std::fs::read(&output).unwrap();
        // Keep the digest unchanged: validation must still reject corrupted exports.
        match defect {
            "format" | "version" | "siglip_dim" | "qwen_dim" => {
                conn.execute("UPDATE meta SET value='bad' WHERE key=?1", [defect])
                    .unwrap();
            }
            "nan" | "zero" | "unknown_nan" => {
                conn.execute(
                    "UPDATE siglip SET vector=?1 WHERE asset_id=?2",
                    params![
                        blob(SIGLIP_DIM, if defect == "zero" { 0 } else { 0x7e00 }),
                        if defect == "unknown_nan" {
                            "unknown"
                        } else {
                            "a"
                        }
                    ],
                )
                .unwrap();
            }
            "size" => {
                conn.execute(
                    "UPDATE siglip SET vector=?1 WHERE asset_id='a'",
                    [vec![0u8; 2]],
                )
                .unwrap();
            }
            "qwen_size" => {
                conn.execute("UPDATE qwen8b SET vector=?1", [vec![0u8; 2]])
                    .unwrap();
            }
            "missing_table" => {
                conn.execute("DROP TABLE siglip", []).unwrap();
            }
            "missing_column" => {
                conn.execute("ALTER TABLE siglip RENAME COLUMN vector TO invalid", [])
                    .unwrap();
            }
            "duplicate" => {
                conn.execute_batch("ALTER TABLE siglip RENAME TO previous; CREATE TABLE siglip(asset_id TEXT,vector BLOB); INSERT INTO siglip SELECT * FROM previous; INSERT INTO siglip SELECT * FROM previous;").unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            import_cache(&known_assets(&library).unwrap(), &input, &output).is_err(),
            "{defect}"
        );
        assert_eq!(old, std::fs::read(&output).unwrap(), "{defect}");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }
}

#[test]
fn nl_search_atomic_replace_and_optional_qwen() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("inbox.sqlite");
    let output = temp.path().join("vectors.sqlite");
    let conn = source(&input, false);
    let library = library();
    import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap();
    let old = std::fs::read(&output).unwrap();
    conn.execute(
        "UPDATE meta SET value='second' WHERE key='content_digest'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE siglip SET vector=?1 WHERE asset_id='a'",
        [blob(SIGLIP_DIM, 0xbc00)],
    )
    .unwrap();
    import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap();
    assert_ne!(old, std::fs::read(&output).unwrap());
    let cache = read_only(&output).unwrap();
    assert_eq!(metadata(&cache).unwrap()["content_digest"], "second");
    assert_eq!(
        cache
            .query_row("SELECT count(*) FROM qwen8b", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        load_vectors(&cache, "siglip", SIGLIP_DIM).unwrap()["a"][0],
        -1.0
    );
}

#[cfg(windows)]
#[test]
fn nl_search_failed_atomic_publish_preserves_old_cache() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("inbox.sqlite");
    let output = temp.path().join("vectors.sqlite");
    let conn = source(&input, false);
    let library = library();
    import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap();
    let old = std::fs::read(&output).unwrap();
    conn.execute(
        "UPDATE meta SET value='second' WHERE key='content_digest'",
        [],
    )
    .unwrap();
    // A reader denying FILE_SHARE_DELETE makes atomic publication fail on Windows.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&output)
        .unwrap();
    assert!(import_cache(&known_assets(&library).unwrap(), &input, &output).is_err());
    assert_eq!(old, std::fs::read(&output).unwrap());
    drop(held);
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    import_cache(&known_assets(&library).unwrap(), &input, &output).unwrap();
    assert_eq!(
        metadata(&read_only(&output).unwrap()).unwrap()["content_digest"],
        "second"
    );
}

fn vectors() -> BTreeMap<String, Vec<f32>> {
    BTreeMap::from([
        ("a".into(), vec![1., 0.]),
        ("b".into(), vec![0., 1.]),
        ("c".into(), vec![-1., 0.]),
        ("gone".into(), vec![0., 1.]),
        ("video".into(), vec![0., 1.]),
    ])
}
#[test]
fn nl_search_routing_matches_reference_series_aliases_boundary_and_fallback() {
    let conn = library();
    let vectors = vectors();
    for query in [
        "레제",
        "Reze",
        "레제 Reze",
        "체인소맨 레제",
        "레제 체인소맨",
        "체인소맨 톱 맨 레제",
    ] {
        let result = routing(&conn, query, &vectors, 200).unwrap();
        assert_eq!(result.route, "tags", "{query}");
        assert_eq!(result.tag_ids, vec!["a", "b"]);
    }
    for query in ["레제 웃는", "체인소맨 레제 웃는", "젠레스 레제"] {
        let result = routing(&conn, query, &vectors, 200).unwrap();
        assert_eq!(result.route, "mixed", "{query}");
        assert_eq!(
            cosine(&vectors, &[0., 1.], &result)
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
    }
    assert_eq!(
        routing(&conn, "없는 웃는", &vectors, 200).unwrap().route,
        "mixedFallback"
    );
    assert_eq!(
        routing(&conn, "레제는", &vectors, 200).unwrap().route,
        "cosine"
    );
    conn.execute_batch("DELETE FROM asset_auto_tags; INSERT INTO asset_auto_tags VALUES ('a','reze',0.35),('b','reze',0.349);").unwrap();
    assert_eq!(
        routing(&conn, "레제 웃는", &vectors, 200)
            .unwrap()
            .allowed
            .unwrap(),
        HashSet::from(["a".into()])
    );
    conn.execute("UPDATE asset_auto_tags SET score=0.1", [])
        .unwrap();
    let fallback = routing(&conn, "레제 웃는", &vectors, 200).unwrap();
    assert_eq!(fallback.route, "mixedFallback");
    assert_eq!(fallback.tag_ids, vec!["a", "b"]);
}

#[test]
fn nl_search_cosine_ties_rrf_and_live_corpus_filter() {
    let conn = library();
    let mut vectors = vectors();
    vectors.insert("b".into(), vec![1., 0.]);
    let route = routing(&conn, "풍경", &vectors, 200).unwrap();
    let scores = cosine(&vectors, &[1., 0.], &route);
    assert_eq!(
        scores.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    let qwen = vec![("b".into(), 1.), ("a".into(), 0.), ("c".into(), -1.)];
    assert_eq!(rrf(&scores, &qwen), vec!["a", "b", "c"]);
    let many: Vec<_> = (0..250).map(|i| (format!("{i:03}"), 1.0)).collect();
    assert_eq!(rrf(&many, &[]).len(), 200);
    conn.execute("UPDATE assets SET status='trash' WHERE id='a'", [])
        .unwrap();
    assert!(!routing(&conn, "레제", &vectors, 200)
        .unwrap()
        .tag_ids
        .contains(&"a".into()));
    vectors.remove("b");
    assert!(routing(&conn, "레제", &vectors, 200)
        .unwrap()
        .tag_ids
        .is_empty());
}

#[test]
fn nl_search_gates_and_half_validation() {
    assert_eq!(
        unavailable(false, true, 1),
        Some("메인 PC에서만 쓸 수 있습니다.")
    );
    assert_eq!(
        unavailable(true, false, 1),
        Some("검색 실행 환경이 설정되지 않았습니다.")
    );
    assert_eq!(
        unavailable(true, true, 0),
        Some("검색 색인이 아직 없습니다.")
    );
    assert_eq!(unavailable(true, true, 1), None);
    assert_eq!(half(1), 1.0 / 16777216.0);
    assert!(decode(&blob(SIGLIP_DIM, 0x7c00), SIGLIP_DIM).is_err());
    assert_eq!(decode(&blob(SIGLIP_DIM, 1), SIGLIP_DIM).unwrap()[0], 1.0);
}

#[test]
fn nl_search_lazy_index_invalidation_precise_fallback_limits_and_name_only() {
    use crate::library::characters::tests::Fixture;
    let fixture = Fixture::new();
    let target = fixture.ready("A");
    let input = fixture.temp.path().join("inbox.sqlite");
    let source = source(&input, true);
    source.execute("DELETE FROM siglip", []).unwrap();
    source.execute("DELETE FROM qwen8b", []).unwrap();
    let ids = fixture.library.connection().unwrap().prepare("SELECT id FROM assets WHERE status='normal' AND media_kind IN ('image','gif') ORDER BY id")
        .unwrap().query_map([], |r| r.get::<_,String>(0)).unwrap().collect::<std::result::Result<Vec<_>,_>>().unwrap();
    assert!(ids.len() >= 2);
    for id in &ids {
        source
            .execute(
                "INSERT INTO siglip VALUES (?1,?2)",
                params![id, blob(SIGLIP_DIM, 0x3c00)],
            )
            .unwrap();
    }
    source
        .execute(
            "INSERT INTO qwen8b VALUES (?1,?2)",
            params![ids[0], blob(QWEN_DIM, 0x3c00)],
        )
        .unwrap();
    fixture.library.import_nl_search(&input).unwrap();
    assert!(fixture
        .library
        .nl_search_runtime
        .index
        .lock()
        .unwrap()
        .is_none());
    let first = fixture.library.nl_search_index(false).unwrap();
    assert!(first.qwen.is_none());
    assert!(Arc::ptr_eq(
        &first,
        &fixture.library.nl_search_index(false).unwrap()
    ));
    let precise_index = fixture.library.nl_search_index(true).unwrap();
    assert!(precise_index.qwen.is_some());
    let name_result = fixture
        .library
        .search_description(&target.display_name, None, true, || {
            panic!("name query must not invoke worker")
        })
        .unwrap();
    assert_eq!(name_result.route, "tags");
    assert!(!name_result.precise);
    let embed = || {
        Ok(Embedding {
            translation: "landscape".into(),
            siglip: decode(&blob(SIGLIP_DIM, 0x3c00), SIGLIP_DIM).unwrap(),
            qwen: None,
        })
    };
    let result = fixture
        .library
        .search_description("풍경", Some(0), true, embed)
        .unwrap();
    assert_eq!(result.asset_ids.len(), 1);
    assert!(!result.precise);
    let result = fixture
        .library
        .search_description("풍경", Some(999), true, || {
            Ok(Embedding {
                translation: "landscape".into(),
                siglip: decode(&blob(SIGLIP_DIM, 0x3c00), SIGLIP_DIM).unwrap(),
                qwen: Some(decode(&blob(QWEN_DIM, 0x3c00), QWEN_DIM).unwrap()),
            })
        })
        .unwrap();
    assert!(result.precise);
    assert_eq!(result.asset_ids[0], ids[0]);
    // Import clears a loaded index and changes subsequent cosine ordering.
    source
        .execute(
            "UPDATE meta SET value='second' WHERE key='content_digest'",
            [],
        )
        .unwrap();
    source
        .execute(
            "UPDATE siglip SET vector=?1 WHERE asset_id=?2",
            params![blob(SIGLIP_DIM, 0xbc00), ids[0]],
        )
        .unwrap();
    fixture.library.import_nl_search(&input).unwrap();
    assert!(fixture
        .library
        .nl_search_runtime
        .index
        .lock()
        .unwrap()
        .is_none());
    let result = fixture
        .library
        .search_description("풍경", None, false, embed)
        .unwrap();
    assert_eq!(result.asset_ids.last(), Some(&ids[0]));
    // External cache changes are detected without an import invalidation.
    let prior = fixture.library.nl_search_index(false).unwrap();
    let cache = Connection::open(fixture.library.nl_search_path()).unwrap();
    cache
        .execute(
            "INSERT INTO meta VALUES ('padding',?1)",
            ["x".repeat(10000)],
        )
        .unwrap();
    drop(cache);
    assert!(!Arc::ptr_eq(
        &prior,
        &fixture.library.nl_search_index(false).unwrap()
    ));
}

#[test]
fn nl_search_inbox_dispatch_counts_and_unchanged_skip() {
    use crate::library::characters::tests::Fixture;
    let fixture = Fixture::new();
    fixture
        .library
        .use_machine_settings(fixture.temp.path().join("machine.json"));
    fixture
        .library
        .set_auto_tag_inbox(Some(fixture.temp.path().to_string_lossy().into()), false)
        .unwrap();
    let path = fixture
        .temp
        .path()
        .join(super::super::auto_tag_inbox::FILES[2]);
    let conn = source(&path, true);
    conn.execute("DELETE FROM siglip", []).unwrap();
    conn.execute("DELETE FROM qwen8b", []).unwrap();
    conn.execute(
        "INSERT INTO siglip VALUES ('asset-5',?1),('unknown',?1)",
        [blob(SIGLIP_DIM, 0x3c00)],
    )
    .unwrap();
    let result = fixture.library.run_auto_tag_inbox().unwrap();
    assert_eq!(result.processed, vec!["nl-search-latest.sqlite"]);
    let last = &result.settings.last.as_ref().unwrap()["nl-search-latest.sqlite"];
    assert_eq!(last.error, None);
    assert_eq!(
        last.imported,
        BTreeMap::from([
            ("siglip".into(), 1),
            ("qwen8b".into(), 0),
            ("skipped".into(), 1)
        ])
    );
    assert_eq!(fixture.library.nl_search_counts().unwrap(), (1, 0));
    assert!(fixture
        .library
        .run_auto_tag_inbox()
        .unwrap()
        .processed
        .is_empty());
}
