use super::*;

fn queue_decide(
    c: &Connection,
    cache: &QueueCache,
    row: &ReviewRow,
    decision: &str,
) -> Result<(), LibraryError> {
    let query = ReviewDecision {
        review_token: row.review_token.clone(),
        left_anchor: row.left_anchor.clone(),
        right_anchor: row.right_anchor.clone(),
        decision: decision.into(),
    };
    let tx = c.unchecked_transaction()?;
    let current = queue_decision_row(&tx, cache, &query)?;
    decide_row(&tx, &query, current)?;
    tx.commit()?;
    Ok(())
}

#[test]
fn catalog_review_whole_queue_public_commands_share_cache_and_save_without_canary() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("catalogs")).unwrap();
    let c = fixture(&dir.path().join("library.sqlite"));
    c.execute_batch(
        "ALTER TABLE catalog.Works ADD COLUMN Views INTEGER DEFAULT 0;
        ALTER TABLE catalog.Works ADD COLUMN Posted INTEGER DEFAULT 0;",
    )
    .unwrap();
    catalog_groups::ensure_membership(&c).unwrap();
    c.execute(
        "VACUUM catalog INTO ?1",
        [dir.path().join("catalogs/kdata.db").to_str().unwrap()],
    )
    .unwrap();
    drop(c);
    let library = Library::open(dir.path()).unwrap();
    QUEUE_SCANS.with(|scans| scans.set(0));
    assert_eq!(library.catalog_review_count().unwrap(), 1);
    assert_eq!(library.catalog_review_count().unwrap(), 1);
    QUEUE_SCANS.with(|scans| assert_eq!(scans.get(), 1));
    // A fresh process starts with an empty in-memory cache. Keep the fixture's
    // single-open lease while exercising that same disk-load path.
    *library.catalog_review_cache.lock().unwrap() = QueueCache::default();
    assert_eq!(library.catalog_review_count().unwrap(), 1);
    QUEUE_SCANS.with(|scans| assert_eq!(scans.get(), 1, "second start must not scan"));
    let first = library.list_catalog_review().unwrap();
    let row = first.rows.iter().find(|r| r.state == "pending").unwrap();
    assert!(row.actionable);
    let dialog = library.clone().generate_catalog_review().unwrap();
    assert_eq!(dialog.rows[0].review_token, row.review_token);
    library
        .decide_catalog_review(ReviewDecision {
            review_token: row.review_token.clone(),
            left_anchor: row.left_anchor.clone(),
            right_anchor: row.right_anchor.clone(),
            decision: "falsePositive".into(),
        })
        .unwrap();
    let page = library.list_catalog_review().unwrap();
    assert!(page.rows.iter().all(|r| r.state != "pending"));
    assert_eq!(library.catalog_review_count().unwrap(), 0);
    QUEUE_SCANS.with(|scans| assert_eq!(scans.get(), 2, "decision invalidates discovery"));
    assert_eq!(page.rows[0].state, "falsePositive");
    let reader = library.catalog_read_connection().unwrap();
    assert_eq!(
        super::super::mobile_catalog::user_snapshot(&reader).unwrap()["decisions"][0][2],
        "falsePositive"
    );
    assert_eq!(
        reader
            .query_row(
                "SELECT COUNT(*) FROM online_catalog_review_candidates",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn catalog_review_persisted_cache_invalidates_on_catalog_change_and_recovers_from_corruption() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("catalogs")).unwrap();
    let c = fixture(&dir.path().join("library.sqlite"));
    c.execute_batch("ALTER TABLE catalog.Works ADD COLUMN Views INTEGER DEFAULT 0;
        ALTER TABLE catalog.Works ADD COLUMN Posted INTEGER DEFAULT 0;").unwrap();
    catalog_groups::ensure_membership(&c).unwrap();
    c.execute("VACUUM catalog INTO ?1", [dir.path().join("catalogs/kdata.db").to_str().unwrap()]).unwrap();
    drop(c);
    let library = Library::open(dir.path()).unwrap();
    QUEUE_SCANS.with(|scans| scans.set(0));
    assert_eq!(library.catalog_review_count().unwrap(), 1);
    let path = library.catalog_review_cache_path();
    let catalog = Connection::open(dir.path().join("catalogs/kdata.db")).unwrap();
    catalog.execute_batch("UPDATE Works SET Title='No longer matching',TitleJpn=NULL WHERE Id=2;
        UPDATE CrawlState SET Value='new-content';").unwrap();
    drop(catalog);
    library.prepare_online_catalog_counts().unwrap();
    *library.catalog_review_cache.lock().unwrap() = QueueCache::default();
    assert_eq!(library.catalog_review_count().unwrap(), 0);
    QUEUE_SCANS.with(|scans| assert_eq!(scans.get(), 2));
    std::fs::write(path, b"interrupted cache").unwrap();
    *library.catalog_review_cache.lock().unwrap() = QueueCache::default();
    assert_eq!(library.catalog_review_count().unwrap(), 0);
    QUEUE_SCANS.with(|scans| assert_eq!(scans.get(), 3));
}

#[test]
fn catalog_review_whole_queue_includes_old_pairs_and_preserves_decisions_in_publication() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    // Push the matching works outside the old latest-500 window.
    for id in 1000..1501 {
        c.execute("INSERT INTO catalog.Works(Id,Title,FileCount,Category) VALUES(?1,'Unrelated filler',20,2)", [id]).unwrap();
    }
    assert!(generate(&c).unwrap().rows.is_empty());
    let mut cache = QueueCache::default();
    let row = whole_catalog_page(&c, &mut cache).unwrap().rows.remove(0);
    assert_eq!(
        (row.left_anchor.as_str(), row.right_anchor.as_str()),
        ("1", "2")
    );
    assert!(row.actionable);
    // No canary candidate is persisted to enable the action.
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM online_catalog_review_candidates",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    queue_decide(&c, &cache, &row, "confirm").unwrap();
    let page = whole_catalog_page(&c, &mut cache).unwrap();
    assert!(page.rows.iter().all(|r| r.state != "pending"));
    let saved = page
        .rows
        .into_iter()
        .find(|r| r.state == "confirm")
        .unwrap();
    assert_eq!(saved.evidence.left.group_id, saved.evidence.right.group_id);
    let snapshot = super::super::mobile_catalog::user_snapshot(&c).unwrap();
    assert_eq!(snapshot["decisions"][0][2], "confirm");
    queue_decide(&c, &cache, &saved, "split").unwrap();
    let page = whole_catalog_page(&c, &mut cache).unwrap();
    assert!(page.rows.iter().all(|r| r.state != "pending"));
    assert_eq!(page.rows[0].state, "split");
    // Reopening/rebuilding must keep the veto; it is not a cache-only decision.
    catalog_groups::rebuild(&c, &catalog_groups::ensure_membership(&c).unwrap()).unwrap();
    let page = whole_catalog_page(&c, &mut QueueCache::default()).unwrap();
    assert!(page.rows.iter().all(|r| r.state != "pending"));
    assert_eq!(
        super::super::mobile_catalog::user_snapshot(&c).unwrap()["decisions"][0][2],
        "split"
    );
}

#[test]
fn catalog_review_whole_queue_deduplicates_groups_and_invalidates_displayed_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    // The actual matching work is 4, but its lineage anchor is 1. Decisions must use
    // matching work IDs so the existing publication/sync path carries that exact pair.
    c.execute_batch(
        "UPDATE catalog.Works SET Title='Unrelated anchor',TitleJpn=NULL WHERE Id=1;
        UPDATE catalog.Works SET Title='Same title 01',TitleJpn=NULL WHERE Id=4;
        INSERT INTO catalog.Tags VALUES(4,'artist','alice'),(4,'language','korean');
        INSERT INTO catalog.Works(Id,Token,ParentGid,ParentKey,Title,FileCount,Category)
            VALUES(5,'five',2,'two','Same title 01',20,2);
        INSERT INTO catalog.Tags VALUES(5,'artist','alice'),(5,'language','korean');",
    )
    .unwrap();
    catalog_groups::ensure_membership(&c).unwrap();
    let mut cache = QueueCache::default();
    let page = whole_catalog_page(&c, &mut cache).unwrap();
    assert_eq!(page.rows.len(), 1);
    let row = &page.rows[0];
    assert_eq!(
        (row.left_anchor.as_str(), row.right_anchor.as_str()),
        ("2", "4")
    );
    let cached = cache.found.as_ptr();
    let again = whole_catalog_page(&c, &mut cache).unwrap();
    assert_eq!(
        cache.found.as_ptr(),
        cached,
        "unchanged Home/dialog input must reuse comparison"
    );
    assert_eq!(row.review_token, again.rows[0].review_token);
    c.execute("UPDATE catalog.CrawlState SET Value='changed'", [])
        .unwrap();
    assert!(queue_decide(&c, &cache, row, "confirm").is_err());
    catalog_groups::ensure_membership(&c).unwrap();
    let page = whole_catalog_page(&c, &mut cache).unwrap();
    assert!(queue_decide(&c, &cache, row, "confirm").is_err());
    queue_decide(&c, &cache, &page.rows[0], "falsePositive").unwrap();
    let page = whole_catalog_page(&c, &mut cache).unwrap();
    assert!(
        page.rows.iter().all(|r| r.state != "pending"),
        "veto must exclude other work pairs of the same groups"
    );
}

#[test]
fn catalog_review_whole_queue_has_no_canary_or_list_candidate_limit() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    for pair in 0..560 {
        for side in 0..2 {
            let id = 1000 + pair * 2 + side;
            c.execute(
                "INSERT INTO catalog.Works(Id,Title,FileCount,Category) VALUES(?1,?2,20,2)",
                params![id, format!("Unique matching title {pair:04}")],
            )
            .unwrap();
            c.execute("INSERT INTO catalog.Tags VALUES(?1,'artist','alice')", [id])
                .unwrap();
            c.execute(
                "INSERT INTO catalog.Tags VALUES(?1,'language','korean')",
                [id],
            )
            .unwrap();
        }
    }
    catalog_groups::ensure_membership(&c).unwrap();
    let page = whole_catalog_page(&c, &mut QueueCache::default()).unwrap();
    assert_eq!(
        page.rows
            .iter()
            .filter(|r| r.state == "pending" && r.actionable)
            .count(),
        561
    );
}

#[test]
fn catalog_review_whole_queue_does_not_count_saves_blocked_by_the_existing_ledger_bound() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    catalog_groups::ensure_membership(&c).unwrap();
    let mut cache = QueueCache::default();
    let row = whole_catalog_page(&c, &mut cache).unwrap().rows.remove(0);
    let evidence = serde_json::to_string(&row.evidence).unwrap();
    for id in 0..HUMAN_DECISIONS {
        c.execute(
            "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,'falsePositive',?3,'now')",
            params![format!("absent-a-{id}"), format!("absent-b-{id}"), evidence],
        )
        .unwrap();
    }
    let page = whole_catalog_page(&c, &mut cache).unwrap();
    let row = page.rows.iter().find(|r| r.state == "pending").unwrap();
    assert!(!row.actionable);
    assert_eq!(
        page.rows
            .iter()
            .filter(|r| r.state == "pending" && r.actionable)
            .count(),
        0
    );
    assert!(queue_decide(&c, &cache, row, "falsePositive").is_err());
}

/// Opt-in measurement on operator-provided COPIES only. No Library::open, migration,
/// production path, network client, decision or publication is invoked.
#[test]
#[ignore = "requires CATALOG_REVIEW_BENCH_COPY_ROOT containing disposable copied SQLite files"]
fn catalog_review_copied_database_queue_measurement() {
    use std::time::Instant;
    let root = std::path::PathBuf::from(
        std::env::var_os("CATALOG_REVIEW_BENCH_COPY_ROOT").expect("copied fixture root"),
    );
    let c = Connection::open_with_flags(
        root.join("library.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut uri = url::Url::from_file_path(root.join("kdata.db")).unwrap();
    uri.set_query(Some("mode=ro"));
    c.execute("ATTACH ?1 AS catalog", [uri.as_str()]).unwrap();
    let tx = c.unchecked_transaction().unwrap();
    let start = Instant::now();
    let baseline = super::super::catalog_duplicate_sync::scan(&tx).unwrap();
    let scan_ms = start.elapsed().as_millis();
    let mut cache = QueueCache::default();
    let start = Instant::now();
    let first = whole_catalog_page(&tx, &mut cache).unwrap();
    let first_ms = start.elapsed().as_millis();
    let start = Instant::now();
    let second = whole_catalog_page(&tx, &mut cache).unwrap();
    let warm_ms = start.elapsed().as_millis();
    let count = |page: &ReviewPage| {
        page.rows
            .iter()
            .filter(|r| r.state == "pending" && r.actionable)
            .count()
    };
    assert_eq!(count(&first), baseline.len());
    assert_eq!(count(&first), count(&second));
    let legacy_pending = list(&tx)
        .unwrap()
        .iter()
        .filter(|r| r.state == "pending" && r.actionable)
        .count();
    let uncertain = baseline
        .iter()
        .filter(|p| {
            super::super::catalog_duplicate_sync::duplicate_tier(&p.left, &p.right)
                == super::super::catalog_duplicate_sync::Tier::Uncertain
        })
        .count();
    eprintln!("copied DB: legacy_pending={legacy_pending}, whole_pending={}, uncertain={uncertain}; baseline_scan_ms={scan_ms}, cold_queue_ms={first_ms}, warm_queue_ms={warm_ms}", count(&first));
}

#[test]
#[ignore = "requires HOME_PERF_SNAPSHOT pointing to a disposable complete library snapshot"]
fn catalog_review_home_count_snapshot_measurement() {
    use std::time::Instant;
    let root = std::path::PathBuf::from(std::env::var_os("HOME_PERF_SNAPSHOT").expect("copied fixture root"));
    let library = Library::open(&root).unwrap();
    library.prepare_online_catalog_counts().unwrap();
    let persisted_before = library.catalog_review_cache_path().exists();
    QUEUE_SCANS.with(|scans| scans.set(0));
    let started = Instant::now();
    let count = library.catalog_review_count().unwrap();
    let first_ms = started.elapsed().as_secs_f64() * 1000.0;
    let first_scans = QUEUE_SCANS.with(|scans| scans.get());
    // Clear only process memory: a second launch must use the saved fingerprint.
    *library.catalog_review_cache.lock().unwrap() = QueueCache::default();
    let started = Instant::now();
    assert_eq!(library.catalog_review_count().unwrap(), count);
    let fresh_cache_ms = started.elapsed().as_secs_f64() * 1000.0;
    QUEUE_SCANS.with(|scans| assert_eq!(scans.get(), first_scans));
    eprintln!("Home count snapshot: count={count} persisted_before={persisted_before} first_ms={first_ms:.2} first_scans={first_scans} fresh_process_cache_ms={fresh_cache_ms:.2} fresh_process_scans=0");
}

#[test]
fn catalog_review_appended_translation_with_small_page_difference() {
    let original = "(C108) [Nobutorakai (Nidaime)] Natsu no Majo ni wa Ki o Tsukero! (Genshin Impact) [Korean]";
    let translated = "(C108) [Nobutorakai (Nidaime)] Natsu no Majo ni wa Ki o Tsukero! | 여름의 마녀는 조심하도록! (Genshin Impact) [Korean]";
    for (title, pages, expected) in [
        (translated.to_string(), 34, true),
        (translated.to_string(), 32, true),
        (translated.to_string(), 35, false),
        (translated.replace("(C108)", "(C109)"), 34, false),
        (translated.replace("(Genshin Impact)", "(Other Series)"), 34, false),
        (translated.replace("[Korean]", "[Korean] [Digital]"), 34, false),
        (translated.replace("Tsukero! |", "Tsukero! 2 |"), 34, false),
        (original.to_string(), 34, false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let c = fixture(&dir.path().join("test.sqlite"));
        c.execute("UPDATE catalog.Works SET Title=?1,TitleJpn=NULL,FileCount=32 WHERE Id=1", [original]).unwrap();
        c.execute("UPDATE catalog.Works SET Title=?1,TitleJpn=NULL,FileCount=?2 WHERE Id=2", params![title, pages]).unwrap();
        let page = generate(&c).unwrap();
        assert_eq!(!page.rows.is_empty(), expected, "{title}, {pages}");
        assert_eq!(groups(&c), 3, "candidate generation must not merge");
        if expected {
            assert!(page.rows[0].evidence.reason.contains("덧붙인 한국어 제목"));
            assert!(page.rows[0].evidence.reason.contains(&format!("페이지 수 차이 {}쪽", pages - 32)));
            let mut counts = [page.rows[0].evidence.left.pages, page.rows[0].evidence.right.pages];
            counts.sort();
            assert_eq!(counts, [32, pages]);
            c.execute("UPDATE catalog.Tags SET Value='japanese' WHERE WorkId=2 AND Namespace='language'", []).unwrap();
            assert!(generate(&c).unwrap().rows.is_empty());
        }
    }
    // A two-page difference on a short work is not a small proportional change.
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    c.execute("UPDATE catalog.Works SET Title=?1,TitleJpn=NULL,FileCount=10 WHERE Id=1", [original]).unwrap();
    c.execute("UPDATE catalog.Works SET Title=?1,TitleJpn=NULL,FileCount=12 WHERE Id=2", [translated]).unwrap();
    assert!(generate(&c).unwrap().rows.is_empty());
}

fn attach_catalog_fixture(c: &Connection) {
    c.execute_batch("ATTACH ':memory:' AS catalog;
        CREATE TABLE catalog.CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
        INSERT INTO catalog.CrawlState VALUES('lakomics.catalog.contentRevision','fixture-v1');
        CREATE TABLE catalog.Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
        FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,
        Title TEXT,TitleJpn TEXT,FileCount INTEGER,Category INTEGER,Uploader TEXT,Expunged INTEGER DEFAULT 0);
        CREATE TABLE catalog.Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
        INSERT INTO catalog.Works(Id,Token,Title,TitleJpn,FileCount,Category) VALUES
        (1,'one','Same title 01','同じ作品のタイトル',20,2),(2,'two','Same title 01','同じ作品のタイトル',20,2),
        (3,'three','Same title 01','同じ作品のタイトル',20,2),(4,'four','Different lineage title',NULL,20,2);
        INSERT INTO catalog.Tags VALUES(1,'artist','alice'),(2,'artist','alice'),(3,'artist','bob'),
        (1,'language','korean'),(2,'language','korean'),(3,'language','korean');
        UPDATE catalog.Works SET ParentGid=1,ParentKey='one' WHERE Id=4;").unwrap();
}
fn fixture(path: &std::path::Path) -> Connection {
    std::fs::create_dir_all(path.parent().unwrap().join("backups")).unwrap();
    let c = super::super::db::initialize_database(path).unwrap();
    attach_catalog_fixture(&c);
    c
}
fn historical_fixture(path: &std::path::Path, version: usize) -> Connection {
    let mut c = Connection::open(path).unwrap();
    c.pragma_update(None, "foreign_keys", "OFF").unwrap();
    let mut files = std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
        .unwrap().map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .collect::<Vec<_>>();
    files.sort();
    let transaction = c.transaction().unwrap();
    for file in files.iter().take(version) {
        transaction.execute_batch(&std::fs::read_to_string(file).unwrap()).unwrap();
    }
    transaction.commit().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    attach_catalog_fixture(&c);
    c
}
fn groups(c: &Connection) -> i64 {
    c.query_row(
        "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members",
        [],
        |r| r.get(0),
    )
    .unwrap()
}
fn decision(c: &Connection, r: &ReviewRow, d: &str) -> Result<(), LibraryError> {
    let tx = c.unchecked_transaction()?;
    decide(
        &tx,
        &ReviewDecision {
            review_token: r.review_token.clone(),
            left_anchor: r.left_anchor.clone(),
            right_anchor: r.right_anchor.clone(),
            decision: d.into(),
        },
    )?;
    tx.commit()?;
    Ok(())
}
#[test]
fn catalog_review_multisignal_no_automatic_merge_and_durable_confirm_split() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite");
    let c = fixture(&path);
    c.execute_batch(
        "INSERT INTO online_catalog_bookmarks VALUES('kHentai','2','saved');
        INSERT INTO remote_reading_progress VALUES('kHentai','2',7,20,'read');",
    )
    .unwrap();
    let page = generate(&c).unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(groups(&c), 3);
    let row = &page.rows[0];
    let original = row.evidence.left.group_id.clone();
    decision(&c, row, "confirm").unwrap();
    assert_eq!(groups(&c), 2);
    assert_eq!(work(&c, "1").unwrap().group_id, original);
    c.execute_batch("UPDATE catalog.CrawlState SET Value='source-v2'; DELETE FROM online_catalog_review_candidates;").unwrap();
    catalog_groups::ensure_membership(&c).unwrap();
    assert_eq!(groups(&c), 2);
    // Algorithm changes replace candidates only; decisions are algorithm independent.
    c.execute(
        "UPDATE online_catalog_review_decisions SET evidence=replace(evidence,?1,'retired-v0')",
        [ALGORITHM],
    )
    .unwrap();
    drop(c);
    let c = fixture(&path);
    catalog_groups::ensure_membership(&c).unwrap();
    assert_eq!(groups(&c), 2);
    let row = list(&c).unwrap().remove(0);
    assert_eq!(row.state, "confirm");
    decision(&c, &row, "split").unwrap();
    assert_eq!(groups(&c), 3);
    assert_eq!(
        work(&c, "1").unwrap().group_id,
        work(&c, "4").unwrap().group_id
    );
    assert_eq!(work(&c, "1").unwrap().group_id, original);
    assert!(decision(&c, &row, "confirm").is_err());
    let page = generate(&c).unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].state, "split");
    assert_eq!(groups(&c), 3);
    assert_eq!(
        c.query_row("SELECT work_id FROM online_catalog_bookmarks", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "2"
    );
    assert_eq!(
        c.query_row(
            "SELECT last_read_at FROM remote_reading_progress WHERE work_id='2'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "read"
    );
    assert_eq!(
        c.query_row("SELECT Token FROM catalog.Works WHERE Id=2", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "two"
    );
}
#[test]
fn catalog_review_false_positive_and_stale_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    let row = generate(&c).unwrap().rows.remove(0);
    c.execute_batch("UPDATE catalog.CrawlState SET Value='changed'")
        .unwrap();
    assert!(decision(&c, &row, "confirm").is_err());
    generate(&c).unwrap();
    // Regeneration must not make a previously displayed candidate valid again.
    assert!(decision(&c, &row, "confirm").is_err());
    let row = generate(&c).unwrap().rows.remove(0);
    decision(&c, &row, "falsePositive").unwrap();
    c.execute_batch("UPDATE catalog.CrawlState SET Value='changed-again'; DELETE FROM online_catalog_review_candidates;").unwrap();
    let page = generate(&c).unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].state, "falsePositive");
    assert_eq!(groups(&c), 3);
}
#[test]
fn catalog_review_indirect_veto_preserves_lineage_and_dormant_anchors() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    for (a, b, d) in [
        ("1", "2", "confirm"),
        ("2", "3", "confirm"),
        ("1", "3", "split"),
    ] {
        c.execute(
            "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,?3,'{}','now')",
            params![a, b, d],
        )
        .unwrap();
    }
    catalog_groups::ensure_membership(&c).unwrap();
    assert_eq!(groups(&c), 3);
    assert_eq!(
        work(&c, "1").unwrap().group_id,
        work(&c, "4").unwrap().group_id
    );
    c.execute_batch(
        "DELETE FROM catalog.Works WHERE Id=3; UPDATE catalog.CrawlState SET Value='missing'",
    )
    .unwrap();
    catalog_groups::ensure_membership(&c).unwrap();
    assert_eq!(groups(&c), 1);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM online_catalog_review_decisions",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
}
#[test]
fn catalog_review_window_bucket_bounds_and_primary_key_plans() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    for id in 10..1010 {
        c.execute("INSERT INTO catalog.Works(Id,Title,FileCount,Category) VALUES(?1,'Same enormous bucket',20,2)",[id]).unwrap();
    }
    let page = generate(&c).unwrap();
    assert_eq!(page.inspected_works, WINDOW);
    assert_eq!(page.comparisons, 0);
    assert_eq!(page.skipped_buckets, 1);
    assert!(page.rows.is_empty());
    let mut s=c.prepare("EXPLAIN QUERY PLAN SELECT Namespace,Value FROM catalog.Tags WHERE WorkId=1 AND Namespace IN ('artist','group','language') ORDER BY Namespace,Value LIMIT 65").unwrap();
    let plans = s
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join(" ");
    assert!(
        plans.contains("SEARCH") && plans.contains("PRIMARY KEY"),
        "{plans}"
    );
}
#[test]
fn catalog_review_migration_preserves_v36_handles_and_provider_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite");
    let c = historical_fixture(&path, 36);
    c.execute_batch("INSERT INTO online_catalog_group_handles(provider,anchor_work_id,group_id) VALUES
        ('kHentai','1','stable-group-1'),('kHentai','2','stable-group-2'),('kHentai','3','stable-group-3');
        INSERT INTO online_catalog_group_members(provider,work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal) VALUES
        ('kHentai','1',1,'stable-group-1',1,1,1),('kHentai','4',4,'stable-group-1',1,1,0),
        ('kHentai','2',2,'stable-group-2',1,1,1),('kHentai','3',3,'stable-group-3',1,1,1);").unwrap();
    let before = work(&c, "1").unwrap().group_id;
    let handles: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM online_catalog_group_handles",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute_batch("INSERT INTO online_catalog_group_preferences VALUES('kHentai','1','4',1);
        INSERT INTO online_catalog_prepared_counts VALUES('kHentai','all',0,'old-revision',1,1,'policy',3,'hash');").unwrap();
    drop(c);
    let c = fixture(&path);
    assert_eq!(work(&c, "1").unwrap().group_id, before);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM online_catalog_group_handles",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        handles
    );
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        super::super::db::SCHEMA_VERSION
    );
    assert_eq!(
        c.query_row(
            "SELECT selected_work_id FROM online_catalog_group_preferences",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "4"
    );
    assert_eq!(
        c.query_row(
            "SELECT exact_count FROM online_catalog_prepared_counts",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
}

#[test]
fn catalog_review_confirmation_cannot_bypass_indirect_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let c = fixture(&dir.path().join("test.sqlite"));
    c.execute(
        "UPDATE catalog.Tags SET Value='alice' WHERE WorkId=3 AND Namespace='artist'",
        [],
    )
    .unwrap();
    let rows = generate(&c).unwrap().rows;
    let rejected = rows
        .iter()
        .find(|r| r.left_anchor == "1" && r.right_anchor == "3")
        .unwrap();
    decision(&c, rejected, "falsePositive").unwrap();
    let rows = generate(&c).unwrap().rows;
    let confirmed = rows
        .iter()
        .find(|r| r.left_anchor == "1" && r.right_anchor == "2")
        .unwrap();
    decision(&c, confirmed, "confirm").unwrap();
    let page = generate(&c).unwrap();
    assert!(page.rows.iter().all(|r| r.state != "pending"));
    assert_eq!(groups(&c), 2);
    // Even a persisted stale candidate cannot override the rejection indirectly.
    assert!(decision(&c, confirmed, "confirm").is_err());
    let row = page.rows.iter().find(|r| r.state == "confirm").unwrap();
    decision(&c, row, "split").unwrap();
    assert_eq!(groups(&c), 3);
    let page = generate(&c).unwrap();
    let alternate = page
        .rows
        .iter()
        .find(|r| r.left_anchor == "2" && r.right_anchor == "3")
        .unwrap();
    decision(&c, alternate, "confirm").unwrap();
    assert_ne!(
        work(&c, "1").unwrap().group_id,
        work(&c, "3").unwrap().group_id
    );
}
