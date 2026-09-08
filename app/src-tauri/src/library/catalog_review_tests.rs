use super::*;

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
