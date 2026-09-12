//! Production hybrid COUNT regression at catalog scale, using disposable data only.
use super::{
    catalog_counts,
    catalog_group_query::{self, CountRoute, GroupQueryPlan},
    catalog_groups,
    catalog_provider::CatalogProvider,
    catalog_revision,
    models::{CatalogLanguage, CatalogScope, CatalogSearchQuery, CatalogSort},
    Library,
};
use rusqlite::{params_from_iter, types::Value, Connection};

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
fn scalar(c: &Connection, statement: (String, Vec<Value>)) -> u64 {
    c.query_row::<i64, _, _>(&statement.0, params_from_iter(statement.1.iter()), |r| {
        r.get(0)
    })
    .unwrap() as u64
}
fn explain(c: &Connection, statement: (String, Vec<Value>)) -> Vec<String> {
    c.prepare(&format!("EXPLAIN QUERY PLAN {}", statement.0))
        .unwrap()
        .query_map(params_from_iter(statement.1.iter()), |r| r.get(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
fn exact(c: &Connection, q: &CatalogSearchQuery, route: CountRoute) -> u64 {
    let plan = GroupQueryPlan::new(c, q, 1_800_000_000).unwrap();
    assert_eq!(plan.route, route, "{}", q.text);
    let expected = scalar(c, plan.generic_count_statement());
    assert_eq!(
        catalog_group_query::count_groups(c, &plan).unwrap(),
        Some(expected),
        "{}",
        q.text
    );
    expected
}

#[test]
fn catalog_count_realistic_fixture_production_routes_and_six_scalars() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let c = library.connection().unwrap();
    // Same canonical columns and lookup indexes consumed by production grouping
    // and predicate compilation. No experimental member table or SQL router.
    c.execute_batch("ATTACH ':memory:' AS catalog; BEGIN;
      CREATE TABLE catalog.CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
      CREATE TABLE catalog.Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
        FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,Title TEXT NOT NULL,
        TitleJpn TEXT,FileCount INTEGER NOT NULL,Category INTEGER,Uploader TEXT,Expunged INTEGER,
        Posted INTEGER,Views INTEGER);
      CREATE TABLE catalog.Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,
        PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
      WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<131210)
      INSERT INTO catalog.Works(Id,Token,Title,TitleJpn,FileCount,Category,Uploader,Expunged,Posted,Views)
      SELECT id,'token-'||id,CASE id WHEN 105 THEN 'alpha' WHEN 106 THEN 'beta'
        WHEN 107 THEN 'alpha beta' ELSE 'Work '||id END,
        CASE WHEN id%31=0 THEN 'Love' END,20+id%200,id%11+1,'uploader-'||(id%100),id%33=0,
        1700000000+id/3,(id*7919)%131210 FROM ids;
      -- One 104-member chain, 20,616 pairs, and singletons: 110,491 components.
      UPDATE catalog.Works SET ParentGid=Id-1,ParentKey='token-'||(Id-1)
        WHERE Id BETWEEN 2 AND 104 OR (Id BETWEEN 106 AND 41336 AND Id%2=0);
      WITH RECURSIVE slots(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slots WHERE n<13)
      INSERT INTO catalog.Tags
      SELECT Id,CASE n WHEN 0 THEN 'language' WHEN 1 THEN 'artist'
        WHEN 2 THEN 'group' WHEN 3 THEN 'parody' ELSE 'female' END,
        CASE WHEN n=0 THEN CASE WHEN Id%5=0 THEN 'korean' WHEN Id%7=0 THEN 'japanese' ELSE 'english' END
          WHEN n=1 AND Id<=65535 THEN 'seed' WHEN n=2 AND Id<=65536 THEN 'seed'
          WHEN n=3 AND Id<=65537 THEN 'seed' WHEN n=4 AND Id%71=0 THEN 'glasses'
          ELSE 'tag-'||n||'-'||(Id%1000) END FROM catalog.Works CROSS JOIN slots;
      CREATE INDEX catalog.IdxTagsLookup ON Tags(Namespace,Value);
      CREATE INDEX catalog.IdxWorksPosted ON Works(Posted DESC);
      CREATE INDEX catalog.IdxWorksRank ON Works(Expunged,Views DESC,Posted);
      INSERT INTO online_catalog_hidden_categories VALUES(11,'fixture');
      WITH RECURSIVE blocked(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM blocked WHERE n<9)
      INSERT INTO online_catalog_blocked_tags SELECT 'female','tag-5-'||n,'fixture' FROM blocked;
      INSERT INTO online_catalog_bookmarks VALUES('kHentai','105','fixture'),('kHentai','0106','fixture');
    ").unwrap();
    let revision = catalog_revision::initialize_content_revision(&c).unwrap();
    assert_ne!(revision, "legacy");
    catalog_groups::ensure_membership(&c).unwrap();
    let prepared = catalog_counts::compute(&c).unwrap().unwrap();
    assert!(catalog_counts::publish(&c, &prepared).unwrap());
    c.execute_batch("COMMIT; BEGIN").unwrap();
    assert_eq!(
        scalar(&c, ("SELECT COUNT(*) FROM catalog.Works".into(), vec![])),
        131210
    );
    assert_eq!(
        scalar(&c, ("SELECT COUNT(*) FROM catalog.Tags".into(), vec![])),
        1836940
    );
    assert_eq!(
        scalar(
            &c,
            (
                "SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members".into(),
                vec![]
            )
        ),
        110491
    );
    for language in [
        None,
        Some(CatalogLanguage::Korean),
        Some(CatalogLanguage::Japanese),
    ] {
        for reveal in [false, true] {
            let mut q = query("");
            q.language = language;
            q.reveal_blocked = reveal;
            let total = exact(&c, &q, CountRoute::Prepared);
            q.sort = CatalogSort::Views;
            let plan = GroupQueryPlan::new(&c, &q, 1_800_000_000).unwrap();
            assert!(
                plan.count_statement().is_none(),
                "prepared route must not execute DISTINCT membership"
            );
            assert_eq!(
                catalog_group_query::count_groups(&c, &plan).unwrap(),
                Some(total)
            );
        }
    }
    let id = GroupQueryPlan::new(&c, &query("id:131210"), 1_800_000_000).unwrap();
    assert_eq!(exact(&c, &query("id:131210"), CountRoute::Id), 1);
    let id_plan = explain(&c, id.count_statement().unwrap());
    assert!(
        id_plan.iter().any(|s| s.contains("INTEGER PRIMARY KEY")),
        "{id_plan:?}"
    );
    assert!(
        !id_plan.iter().any(|s| s.contains("IdxWorksPosted")),
        "{id_plan:?}"
    );
    let tag = GroupQueryPlan::new(&c, &query("female:glasses"), 1_800_000_000).unwrap();
    assert!(exact(&c, &query("female:glasses"), CountRoute::Tag) > 0);
    let tag_plan = explain(&c, tag.count_statement().unwrap());
    assert!(
        tag_plan.iter().any(|s| s.contains("IdxTagsLookup")),
        "{tag_plan:?}"
    );
    assert!(exact(&c, &query("love"), CountRoute::General) > 0);
    assert_eq!(exact(&c, &query("alpha AND beta"), CountRoute::General), 1);
    let mut q = query("beta");
    q.scope = CatalogScope::Bookmarked;
    assert_eq!(
        exact(&c, &q, CountRoute::Bookmark),
        0,
        "bookmarked alpha sibling and noncanonical alias cannot supply beta"
    );
    q.text = "alpha".into();
    assert_eq!(exact(&c, &q, CountRoute::Bookmark), 1);
    let mut q = query("alpha OR beta");
    q.language = Some(CatalogLanguage::Korean);
    assert_eq!(exact(&c, &q, CountRoute::Tag), 1);
    for (namespace, route) in [
        ("artist", CountRoute::Tag),
        ("group", CountRoute::Tag),
        ("parody", CountRoute::General),
    ] {
        exact(&c, &query(&format!("{namespace}:seed")), route);
    }
    let plan = GroupQueryPlan::new(&c, &query("id:105"), 1_800_000_000).unwrap();
    assert_eq!(
        catalog_group_query::select_page(&c, &plan).unwrap()[0].representative_id,
        105
    );
    c.execute_batch("ROLLBACK").unwrap();
}
