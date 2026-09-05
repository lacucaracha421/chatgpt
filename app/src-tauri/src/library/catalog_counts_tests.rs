use super::*;
fn fixture() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(include_str!(
        "../../migrations/0034_online_catalog_visibility.sql"
    ))
    .unwrap();
    c.execute_batch(include_str!(
        "../../migrations/0035_online_catalog_groups.sql"
    ))
    .unwrap();
    c.execute_batch("ATTACH ':memory:' AS catalog; CREATE TABLE catalog.CrawlState(Key TEXT PRIMARY KEY,Value TEXT); INSERT INTO catalog.CrawlState VALUES('lakomics.catalog.contentRevision','source-a'); CREATE TABLE catalog.Works(Id INTEGER PRIMARY KEY,Expunged INTEGER,Category INTEGER); CREATE TABLE catalog.Tags(WorkId INTEGER,Namespace TEXT,Value TEXT); CREATE INDEX catalog.IdxTagsWork ON Tags(WorkId,Namespace,Value); INSERT INTO catalog.Works VALUES(1,0,2),(2,0,1),(3,0,1),(4,1,1); INSERT INTO catalog.Tags VALUES(1,'language','korean'),(2,'language','japanese'),(3,'language','korean'),(3,'artist','blocked'),(4,'language','japanese'); INSERT INTO online_catalog_hidden_categories VALUES(2,'x'); INSERT INTO online_catalog_blocked_tags VALUES('artist','blocked','x'); INSERT INTO online_catalog_group_members VALUES('kHentai','1',1,'a',0,0,0),('kHentai','2',2,'a',0,0,0),('kHentai','3',3,'b',0,0,0),('kHentai','4',4,'c',0,0,0); INSERT INTO online_catalog_group_state VALUES('kHentai','strong-lineage-v1:source-a',1,'x',NULL);").unwrap();
    c.execute_batch(include_str!(
        "../../migrations/0036_online_catalog_counts.sql"
    ))
    .unwrap();
    c
}
fn prepare(c: &Connection) -> PreparedCounts {
    c.execute_batch("BEGIN").unwrap();
    let p = compute(c).unwrap().unwrap();
    c.execute_batch("COMMIT").unwrap();
    p
}
fn save(c: &Connection, p: &PreparedCounts) -> bool {
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    let ok = publish(c, p).unwrap();
    c.execute_batch("COMMIT").unwrap();
    ok
}
#[test]
fn six_counts_preserve_same_member_language_visibility() {
    let c = fixture();
    let p = prepare(&c);
    assert!(save(&c, &p));
    for (l, r, n) in [
        (None, false, 1),
        (Some(CatalogLanguage::Korean), false, 0),
        (Some(CatalogLanguage::Japanese), false, 1),
        (None, true, 2),
        (Some(CatalogLanguage::Korean), true, 2),
        (Some(CatalogLanguage::Japanese), true, 1),
    ] {
        assert_eq!(lookup(&c, l, r).unwrap(), Some(n));
    }
}
#[test]
fn context_races_and_reveal_policy_independence() {
    for mutation in [
        "DELETE FROM online_catalog_hidden_categories",
        "UPDATE catalog.CrawlState SET Value='source-b'",
        "UPDATE online_catalog_group_state SET generation=generation+1",
        "UPDATE online_catalog_group_state SET source_revision='new-algorithm:source-a'",
    ] {
        let c = fixture();
        let p = prepare(&c);
        assert!(save(&c, &p));
        c.execute_batch(mutation).unwrap();
        assert!(!save(&c, &p));
        assert_eq!(lookup(&c, None, false).unwrap(), None);
        if mutation.starts_with("DELETE") {
            assert_eq!(lookup(&c, None, true).unwrap(), Some(2));
        }
    }
}
#[test]
fn missing_corrupt_and_legacy_are_pending() {
    let c = fixture();
    assert_eq!(lookup(&c, None, false).unwrap(), None);
    let p = prepare(&c);
    assert!(save(&c, &p));
    c.execute_batch("UPDATE online_catalog_prepared_counts SET exact_count=exact_count+1")
        .unwrap();
    assert_eq!(lookup(&c, None, false).unwrap(), None);
    c.execute_batch("UPDATE catalog.CrawlState SET Value='legacy'")
        .unwrap();
    assert_eq!(compute(&c).unwrap(), None);
}
#[test]
fn publication_fault_is_atomic_and_outer_rollback_safe() {
    let c = fixture();
    let p = prepare(&c);
    c.execute_batch("CREATE TRIGGER fail_counts BEFORE INSERT ON online_catalog_prepared_counts WHEN NEW.language='korean' BEGIN SELECT RAISE(ABORT,'fault'); END; BEGIN IMMEDIATE").unwrap();
    assert!(publish(&c, &p).is_err());
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM online_catalog_prepared_counts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    c.execute_batch("ROLLBACK; DROP TRIGGER fail_counts; BEGIN IMMEDIATE")
        .unwrap();
    assert!(publish(&c, &p).unwrap());
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(lookup(&c, None, false).unwrap(), None);
}
#[test]
fn restart_reuses_scalars_and_unrelated_choices_do_not_invalidate() {
    let c = fixture();
    let p = prepare(&c);
    assert!(save(&c, &p));
    c.execute_batch("INSERT INTO online_catalog_group_preferences VALUES('kHentai','1','2',1); CREATE TABLE online_catalog_bookmarks(provider TEXT,work_id TEXT); INSERT INTO online_catalog_bookmarks VALUES('kHentai','3');").unwrap();
    assert_eq!(lookup(&c, None, false).unwrap(), Some(1));
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("derived.sqlite");
    c.execute("VACUUM main INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let reopened = Connection::open(path).unwrap();
    reopened.execute_batch("ATTACH ':memory:' AS catalog; CREATE TABLE catalog.CrawlState(Key TEXT PRIMARY KEY,Value TEXT); INSERT INTO catalog.CrawlState VALUES('lakomics.catalog.contentRevision','source-a');").unwrap();
    assert_eq!(lookup(&reopened, None, false).unwrap(), Some(1));
}
#[test]
fn changed_language_and_split_merge_require_new_generation() {
    let c = fixture();
    let p = prepare(&c);
    assert!(save(&c, &p));
    c.execute_batch("UPDATE catalog.Tags SET Value='japanese' WHERE Namespace='language' AND WorkId=3; UPDATE catalog.CrawlState SET Value='source-b'").unwrap();
    assert_eq!(
        lookup(&c, Some(CatalogLanguage::Korean), true).unwrap(),
        None
    );
    c.execute_batch("UPDATE online_catalog_group_state SET source_revision='strong-lineage-v1:source-b',generation=2; UPDATE online_catalog_group_members SET group_id='a' WHERE catalog_work_id=3").unwrap();
    let p = prepare(&c);
    assert!(save(&c, &p));
    assert_eq!(lookup(&c, None, true).unwrap(), Some(1));
    c.execute_batch("UPDATE online_catalog_group_members SET group_id='b' WHERE catalog_work_id=2; UPDATE online_catalog_group_state SET generation=3").unwrap();
    assert_eq!(lookup(&c, None, true).unwrap(), None);
    let p = prepare(&c);
    assert!(save(&c, &p));
    assert_eq!(lookup(&c, None, true).unwrap(), Some(2));
}
#[test]
fn canonical_policy_and_disposable_state_validation() {
    let c = fixture();
    let p = prepare(&c);
    assert!(save(&c, &p));
    c.execute_batch("UPDATE online_catalog_hidden_categories SET created_at='later'; UPDATE online_catalog_blocked_tags SET created_at='later'").unwrap();
    assert_eq!(lookup(&c, None, false).unwrap(), Some(1));
    c.execute_batch(
        "UPDATE online_catalog_prepared_counts SET count_rule_version=999 WHERE reveal=0",
    )
    .unwrap();
    assert_eq!(lookup(&c, None, false).unwrap(), None);
    assert_eq!(lookup(&c, None, true).unwrap(), Some(2));
    c.execute_batch("DELETE FROM online_catalog_prepared_counts WHERE reveal=1 AND language='all'")
        .unwrap();
    assert_eq!(lookup(&c, None, true).unwrap(), None);
    c.execute_batch("DELETE FROM online_catalog_group_state")
        .unwrap();
    assert_eq!(
        lookup(&c, Some(CatalogLanguage::Japanese), true).unwrap(),
        None
    );
    assert_eq!(compute(&c).unwrap(), None);
}
#[test]
fn incomplete_membership_and_failed_preparation_never_publish() {
    let c = fixture();
    c.execute_batch("DELETE FROM online_catalog_group_members WHERE catalog_work_id=2; BEGIN")
        .unwrap();
    assert_eq!(compute(&c).unwrap(), None);
    c.execute_batch("ROLLBACK; DROP TABLE catalog.Tags; BEGIN")
        .unwrap();
    assert!(compute(&c).is_err());
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(lookup(&c, None, false).unwrap(), None);
}
#[test]
fn lookup_owns_readonly_snapshot_and_reuses_caller_snapshot() {
    let source = fixture();
    let prepared = prepare(&source);
    assert!(save(&source, &prepared));
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("derived.sqlite");
    source
        .execute("VACUUM main INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let writer = Connection::open(&path).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    let catalog_path = temp.path().join("catalog.sqlite");
    let catalog = Connection::open(&catalog_path).unwrap();
    catalog.execute_batch("CREATE TABLE CrawlState(Key TEXT PRIMARY KEY,Value TEXT); INSERT INTO CrawlState VALUES('lakomics.catalog.contentRevision','source-a');").unwrap();
    drop(catalog);
    let mut catalog_uri = url::Url::from_file_path(&catalog_path).unwrap();
    catalog_uri.set_query(Some("mode=ro"));
    let reader =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    reader
        .execute("ATTACH ?1 AS catalog", [catalog_uri.as_str()])
        .unwrap();
    reader.pragma_update(None, "query_only", "ON").unwrap();
    assert!(reader.is_autocommit());
    assert_eq!(lookup(&reader, None, false).unwrap(), Some(1));
    assert!(reader.is_autocommit());
    assert_eq!(reader.total_changes(), 0);

    let snapshot = reader.unchecked_transaction().unwrap();
    assert_eq!(lookup(&snapshot, None, false).unwrap(), Some(1));
    writer
        .execute("DELETE FROM online_catalog_hidden_categories", [])
        .unwrap();
    assert_eq!(lookup(&snapshot, None, false).unwrap(), Some(1));
    assert!(!reader.is_autocommit());
    snapshot.rollback().unwrap();
    assert_eq!(lookup(&reader, None, false).unwrap(), None);
    assert!(reader.is_autocommit());
    assert_eq!(lookup(&reader, None, true).unwrap(), Some(2));
    assert_eq!(reader.total_changes(), 0);
}
