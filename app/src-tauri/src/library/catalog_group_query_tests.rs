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
      CREATE INDEX catalog.IdxTagsLookup ON Tags(Namespace,Value);
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

#[test]
fn catalog_group_routes_are_mandatory_and_prepared_can_be_pending() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    for (text, route) in [
        ("id:1 AND alpha", CountRoute::Id),
        ("id:1 OR alpha", CountRoute::General),
        ("artist:foo AND pages>=100", CountRoute::Tag),
        ("artist:foo OR alpha", CountRoute::General),
        ("NOT artist:foo", CountRoute::General),
    ] {
        let plan = GroupQueryPlan::new(&c, &query(text), 10000).unwrap();
        assert_eq!(plan.route, route, "{text}");
        assert_eq!(
            count_groups(&c, &plan).unwrap(),
            Some({
                let (sql, values) = plan.generic_count_statement();
                c.query_row::<i64, _, _>(&sql, params_from_iter(values.iter()), |r| r.get(0))
                    .unwrap() as u64
            })
        );
    }
    let plan = GroupQueryPlan::new(&c, &query(""), 10000).unwrap();
    assert_eq!(plan.route, CountRoute::Prepared);
    c.execute_batch("DELETE FROM online_catalog_prepared_counts")
        .unwrap();
    assert_eq!(count_groups(&c, &plan).unwrap(), None);
    assert_eq!(select_page(&c, &plan).unwrap().len(), 2);
}

#[test]
fn catalog_group_bookmark_seed_preserves_same_work_and_canonical_ids() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    c.execute_batch(
        "INSERT INTO online_catalog_bookmarks VALUES('kHentai','01','now'),('kHentai','2','now')",
    )
    .unwrap();
    let mut q = query("artist:foo");
    q.scope = CatalogScope::Bookmarked;
    let plan = GroupQueryPlan::new(&c, &q, 10000).unwrap();
    assert_eq!(plan.route, CountRoute::Bookmark);
    assert_eq!(count_groups(&c, &plan).unwrap(), Some(0));
    c.execute_batch("INSERT INTO online_catalog_bookmarks VALUES('kHentai','3','now')")
        .unwrap();
    assert_eq!(count_groups(&c, &plan).unwrap(), Some(1));
}

#[test]
fn catalog_group_hot_captures_one_eligible_cutoff() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    c.execute_batch("UPDATE catalog.Works SET Posted=200000 WHERE Id=2; INSERT INTO online_catalog_hidden_categories VALUES(2,'now')").unwrap();
    let mut q = query("");
    q.sort = CatalogSort::HotDay;
    let plan = GroupQueryPlan::new(&c, &q, 100000).unwrap();
    assert_eq!(plan.hot_cutoff, Some(1500 - 86400));
    assert_eq!(count_groups(&c, &plan).unwrap(), Some(2));
    assert_eq!(select_page(&c, &plan).unwrap().len(), 2);
    c.execute_batch("UPDATE catalog.Works SET Expunged=1")
        .unwrap();
    let empty = GroupQueryPlan::new(&c, &q, 100000).unwrap();
    assert_eq!(empty.hot_cutoff, Some(100000 - 86400));
    assert_eq!(count_groups(&c, &empty).unwrap(), Some(0));
}

#[test]
fn catalog_group_seed_threshold_and_hard_language_are_exact() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    c.execute_batch("WITH RECURSIVE n(x) AS (VALUES(100) UNION ALL SELECT x+1 FROM n WHERE x<65635) INSERT INTO catalog.Tags SELECT x,'female','glasses' FROM n").unwrap();
    let at = GroupQueryPlan::new(&c, &query("female:glasses"), 10000).unwrap();
    assert_eq!(at.route, CountRoute::Tag);
    c.execute_batch("INSERT INTO catalog.Tags VALUES(65636,'female','glasses')")
        .unwrap();
    let above = GroupQueryPlan::new(&c, &query("female:glasses"), 10000).unwrap();
    assert_eq!(above.route, CountRoute::General);
    let mut q = query("alpha OR beta");
    q.language = Some(CatalogLanguage::Japanese);
    let language = GroupQueryPlan::new(&c, &q, 10000).unwrap();
    assert_eq!(language.route, CountRoute::Tag);
    assert_eq!(count_groups(&c, &language).unwrap(), Some(1));
    assert_eq!(select_page(&c, &language).unwrap()[0].representative_id, 2);
}

#[test]
fn catalog_group_id_donor_uses_point_lookup_and_same_predicate() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    let plan = GroupQueryPlan::new(&c, &query("id:1 AND pages>100"), 10000).unwrap();
    assert_eq!(count_groups(&c, &plan).unwrap(), Some(0));
    assert!(select_page(&c, &plan).unwrap().is_empty());
    take_measurements();
    let plan = GroupQueryPlan::new(&c, &query("id:1"), 10000).unwrap();
    assert_eq!(count_groups(&c, &plan).unwrap(), Some(1));
    assert_eq!(select_page(&c, &plan).unwrap().len(), 1);
    for m in take_measurements()
        .into_iter()
        .filter(|m| m.phase == "page" || m.phase == "count")
    {
        let explain = c
            .prepare(&format!("EXPLAIN QUERY PLAN {}", m.sql))
            .unwrap()
            .query_map(params_from_iter(m.values.iter()), |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            !explain.iter().any(|line| line.contains("IdxWorksPosted")),
            "{:?}",
            explain
        );
        assert!(
            explain
                .iter()
                .any(|line| line.contains("INTEGER PRIMARY KEY")),
            "{:?}",
            explain
        );
    }
}

#[test]
fn catalog_group_bounded_bookmark_page_seeds_before_rank_traversal() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    c.execute_batch(
        "INSERT INTO online_catalog_bookmarks VALUES('kHentai','2','now'),('kHentai','01','now')",
    )
    .unwrap();
    for sort in [CatalogSort::Latest, CatalogSort::Views] {
        let mut q = query("");
        q.scope = CatalogScope::Bookmarked;
        q.language = Some(CatalogLanguage::Japanese);
        q.sort = sort;
        let plan = GroupQueryPlan::new(&c, &q, 10000).unwrap();
        assert_eq!(plan.route, CountRoute::Bookmark);
        take_measurements();
        let rows = select_page(&c, &plan).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].representative_id, 2);
        let measurement = take_measurements()
            .into_iter()
            .find(|m| m.phase == "page")
            .unwrap();
        let explain = c
            .prepare(&format!("EXPLAIN QUERY PLAN {}", measurement.sql))
            .unwrap()
            .query_map(params_from_iter(measurement.values.iter()), |r| {
                r.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            explain
                .iter()
                .any(|line| line.contains("MATERIALIZE candidate")),
            "bounded bookmark page must enumerate candidates before ranking: {explain:?}"
        );
        assert!(
            !explain
                .iter()
                .any(|line| line.contains("IdxWorksRank") || line.contains("IdxWorksPosted")),
            "{explain:?}"
        );
    }
}

#[test]
fn catalog_group_bookmark_short_page_guard_boundaries() {
    let (_root, library) = fixture();
    let c = library.connection().unwrap();
    seed(&c);
    c.execute_batch("WITH RECURSIVE n(id) AS (VALUES(4) UNION ALL SELECT id+1 FROM n WHERE id<514)
      INSERT INTO catalog.Works(Id,Token,Title,FileCount,Category,Expunged,Posted,Views)
      SELECT id,'guard-'||id,'guard',20,1,0,id,id FROM n;
      INSERT INTO catalog.Tags SELECT Id,'language','japanese' FROM catalog.Works WHERE Id BETWEEN 4 AND 50;
      INSERT INTO online_catalog_bookmarks SELECT 'kHentai',CAST(Id AS TEXT),'now' FROM catalog.Works WHERE Id=2 OR Id>=4;
      INSERT INTO catalog.CrawlState VALUES('lakomics.catalog.contentRevision','guard-fixture');").unwrap();
    super::super::catalog_groups::ensure_membership(&c).unwrap();
    let mut q = query("");
    q.scope = CatalogScope::Bookmarked;
    q.language = Some(CatalogLanguage::Japanese);
    q.sort = CatalogSort::Views;
    let uses_seed = |q: &CatalogSearchQuery| {
        let plan = GroupQueryPlan::new(&c, q, 10000).unwrap();
        take_measurements();
        select_page(&c, &plan).unwrap();
        take_measurements()
            .into_iter()
            .find(|m| m.phase == "page")
            .unwrap()
            .sql
            .contains("candidate AS MATERIALIZED")
    };
    assert!(
        uses_seed(&q),
        "512 bookmarks,48hardlanguage members fit page"
    );
    c.execute_batch("INSERT INTO catalog.Tags VALUES(51,'language','japanese')")
        .unwrap();
    assert!(
        !uses_seed(&q),
        "49hardlanguage members may benefit from rank earlyexit"
    );
    c.execute_batch("DELETE FROM catalog.Tags WHERE WorkId=51; INSERT INTO online_catalog_bookmarks VALUES('kHentai','1','now')").unwrap();
    assert!(
        !uses_seed(&q),
        "513 bookmarks exceed measured page seed bound"
    );
    c.execute_batch("DELETE FROM online_catalog_bookmarks WHERE work_id='1'")
        .unwrap();
    q.language = None;
    assert!(
        !uses_seed(&q),
        "unrestricted bookmarks retain existing rank page"
    );
}
