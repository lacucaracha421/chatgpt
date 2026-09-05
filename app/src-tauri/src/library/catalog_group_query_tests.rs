use super::super::{catalog_provider::CatalogProvider, models::CatalogLanguage};
use super::*;

fn fixture() -> (tempfile::TempDir, super::super::Library) {
    let root = tempfile::tempdir().unwrap();
    let library = super::super::Library::open(root.path()).unwrap();
    (root, library)
}

fn seed(connection: &Connection) {
    connection.execute_batch("ATTACH ':memory:' AS catalog;
      CREATE TABLE catalog.CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
      CREATE TABLE catalog.Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
       FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,Title TEXT,TitleJpn TEXT,
       FileCount INTEGER,Category INTEGER,Uploader TEXT,Expunged INTEGER DEFAULT 0,Posted INTEGER,Views INTEGER);
      CREATE TABLE catalog.Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
      CREATE INDEX catalog.IdxWorksPosted ON Works(Posted DESC);
      CREATE INDEX catalog.IdxWorksRank ON Works(Expunged,Views DESC,Posted);
      INSERT INTO catalog.Works(Id,Token,Title,FileCount,Category,Posted,Views) VALUES
       (1,'one','alpha',20,1,1000,90),(2,'two','beta',200,2,2000,10),(3,'three','alpha beta',120,1,1500,50);
      UPDATE catalog.Works SET ParentGid=1,ParentKey='one' WHERE Id=2;
      INSERT INTO catalog.Tags VALUES(1,'artist','foo'),(2,'artist','bar'),(3,'artist','foo'),
       (1,'language','korean'),(2,'language','japanese'),(3,'language','korean');").unwrap();
    super::super::catalog_groups::ensure_membership(connection).unwrap();
}

fn query(text: &str) -> CatalogSearchQuery {
    CatalogSearchQuery {
        provider: CatalogProvider::KHentai,
        language: None,
        reveal_blocked: false,
        text: text.into(),
        sort: CatalogSort::Latest,
        scope: CatalogScope::All,
        page: 0,
        page_size: 48,
    }
}

#[test]
fn catalog_group_expression_and_bookmark_scope_require_one_member() {
    let (_root, library) = fixture();
    let connection = library.connection().unwrap();
    seed(&connection);
    let (rows, count) = select_groups(&connection, &query("artist:foo AND pages>=100")).unwrap();
    assert_eq!(count, 1);
    assert_eq!(rows[0].representative_id, 3);
    let (rows, count) = select_groups(&connection, &query("alpha AND beta")).unwrap();
    assert_eq!(count, 1);
    assert_eq!(rows[0].representative_id, 3);
    assert_eq!(
        select_groups(&connection, &query("id:1 OR id:2"))
            .unwrap()
            .1,
        1
    );
    connection
        .execute_batch("INSERT INTO online_catalog_bookmarks VALUES('kHentai','1','now')")
        .unwrap();
    let mut q = query("id:2");
    q.scope = CatalogScope::Bookmarked;
    assert_eq!(select_groups(&connection, &q).unwrap().1, 0);
    q.text = "id:1".into();
    let (rows, count) = select_groups(&connection, &q).unwrap();
    assert_eq!(count, 1);
    assert_eq!(rows[0].representative_id, 1);
    assert!(rows[0].has_bookmarked_version);
}

#[test]
fn catalog_group_manual_fallback_visibility_language_and_sort_donor() {
    let (_root, library) = fixture();
    let connection = library.connection().unwrap();
    seed(&connection);
    let (rows, count) = select_groups(&connection, &query("")).unwrap();
    assert_eq!(count, 2);
    let group = rows[0].group_id.clone();
    assert_eq!(rows[0].representative_id, 1);
    assert_eq!(rows[0].version_count, 2);
    super::super::catalog_group_identity::set_preference(&connection, "kHentai", "1", Some("2"))
        .unwrap();
    let (rows, _) = select_groups(&connection, &query("")).unwrap();
    assert_eq!(rows[0].group_id, group);
    assert_eq!(rows[0].representative_id, 2);
    let mut q = query("");
    q.language = Some(CatalogLanguage::Korean);
    let (rows, _) = select_groups(&connection, &q).unwrap();
    assert_eq!(rows[0].representative_id, 3);
    assert_eq!(rows[1].representative_id, 1);
    assert_eq!(rows[1].version_count, 1);
    assert_eq!(
        select_groups(&connection, &query("id:1")).unwrap().0[0].representative_id,
        1
    );
    connection
        .execute_batch("INSERT INTO online_catalog_hidden_categories VALUES(2,'now')")
        .unwrap();
    let (rows, _) = select_groups(&connection, &query("")).unwrap();
    assert_eq!(rows[0].representative_id, 3);
    assert_eq!(rows[1].representative_id, 1);
    let mut q = query("");
    q.reveal_blocked = true;
    assert_eq!(
        select_groups(&connection, &q).unwrap().0[0].representative_id,
        2
    );
    connection.execute_batch("DELETE FROM online_catalog_hidden_categories; INSERT INTO online_catalog_blocked_tags VALUES('artist','bar','now')").unwrap();
    assert_eq!(select_groups(&connection, &query("id:2")).unwrap().1, 0);
    connection.execute_batch("DELETE FROM online_catalog_blocked_tags; UPDATE catalog.Works SET Expunged=1 WHERE Id=2").unwrap();
    assert_eq!(
        select_groups(&connection, &q).unwrap().0[1].representative_id,
        1
    );
    connection
        .execute_batch("UPDATE catalog.Works SET Expunged=0 WHERE Id=2")
        .unwrap();
    assert_eq!(
        select_groups(&connection, &q).unwrap().0[0].representative_id,
        2
    );
    super::super::catalog_group_identity::set_preference(&connection, "kHentai", "1", None)
        .unwrap();
    assert_eq!(
        select_groups(&connection, &q).unwrap().0[0].representative_id,
        1
    );
}

#[test]
fn catalog_group_all_sorts_pagination_and_hot_ignore_ineligible_reference() {
    let (_root, library) = fixture();
    let connection = library.connection().unwrap();
    seed(&connection);
    for sort in [
        CatalogSort::Latest,
        CatalogSort::Views,
        CatalogSort::HotDay,
        CatalogSort::HotWeek,
        CatalogSort::HotMonth,
    ] {
        let mut q = query("");
        q.sort = sort;
        q.page_size = 1;
        let (first, count) = select_groups(&connection, &q).unwrap();
        assert_eq!(count, 2);
        q.page = 1;
        let (second, count) = select_groups(&connection, &q).unwrap();
        assert_eq!(count, 2);
        assert_eq!(second.len(), 1);
        assert_ne!(first[0].group_id, second[0].group_id);
        q.page = 2;
        assert!(select_groups(&connection, &q).unwrap().0.is_empty());
    }
    connection.execute_batch("UPDATE catalog.Works SET Posted=2000000000 WHERE Id=2; INSERT INTO online_catalog_hidden_categories VALUES(2,'now')").unwrap();
    let mut q = query("");
    q.sort = CatalogSort::HotDay;
    assert_eq!(select_groups(&connection, &q).unwrap().1, 2);
}

#[test]
fn catalog_group_null_posted_ties_still_have_exactly_one_donor() {
    let (_root, library) = fixture();
    let connection = library.connection().unwrap();
    seed(&connection);
    connection
        .execute_batch("UPDATE catalog.Works SET Posted=NULL,Views=10")
        .unwrap();
    for sort in [CatalogSort::Latest, CatalogSort::Views] {
        let mut q = query("");
        q.sort = sort;
        let (rows, total) = select_groups(&connection, &q).unwrap();
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].representative_id, 3);
    }
}
