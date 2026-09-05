//! Large-fixture regression and opt-in, read-only real-catalog measurements.
use std::{fs, time::Instant};

use rusqlite::{params_from_iter, Connection, OpenFlags};

use super::{
    super::{
        models::{CatalogBlockedTag, CatalogSort},
        Library,
    },
    active_work_predicate, append_visibility_predicates, compile_catalog_query,
    parse_catalog_query,
    tests::{khentai, query, SCHEMA},
};

fn measured_where(
    connection: &Connection,
    text: &str,
    reveal: bool,
    before: bool,
    sort: CatalogSort,
) -> (String, Vec<rusqlite::types::Value>) {
    let mut clauses = vec![if before && !reveal {
        LEGACY_WHERE.to_owned()
    } else if before {
        "work.Expunged = 0".to_owned()
    } else {
        active_work_predicate(sort).to_owned()
    }];
    if !before && !reveal {
        append_visibility_predicates(connection, &mut clauses).unwrap();
    }
    let mut values = Vec::new();
    if let Some(expression) = parse_catalog_query(text).unwrap() {
        let compiled = compile_catalog_query(&expression);
        clauses.push(compiled.sql);
        values = compiled.params;
    }
    (clauses.join(" AND "), values)
}

#[test]
fn catalog_empty_policy_sets_independently_avoid_correlated_probes() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let connection = library.connection().unwrap();
    connection.execute_batch("ATTACH ':memory:' AS catalog;
        CREATE TABLE catalog.Works(Id INTEGER PRIMARY KEY, Category INTEGER, Expunged INTEGER);
        CREATE TABLE catalog.Tags(WorkId INTEGER, Namespace TEXT, Value TEXT, PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;").unwrap();
    for hidden in [false, true] {
        for blocked in [false, true] {
            connection.execute_batch("DELETE FROM online_catalog_hidden_categories; DELETE FROM online_catalog_blocked_tags;").unwrap();
            if hidden {
                connection
                    .execute(
                        "INSERT INTO online_catalog_hidden_categories VALUES (4, '')",
                        [],
                    )
                    .unwrap();
            }
            if blocked {
                connection
                    .execute(
                        "INSERT INTO online_catalog_blocked_tags VALUES ('female', 'tag', '')",
                        [],
                    )
                    .unwrap();
            }
            let (filter, _) = measured_where(&connection, "", false, false, CatalogSort::Latest);
            let plan = connection
                .prepare(&format!(
                    "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM catalog.Works AS work WHERE {filter}"
                ))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n");
            assert_eq!(plan.contains("hidden_category"), hidden, "{plan}");
            assert_eq!(plan.contains("blocked_work_tag"), blocked, "{plan}");
        }
    }
}

#[test]
#[ignore = "read-only real catalog benchmark; set LAKOMICS_CATALOG_BENCH_ROOT"]
fn catalog_real_query_measurements() {
    let root = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_BENCH_ROOT").expect("explicit benchmark root required"),
    );
    let connection = Connection::open_with_flags(
        ":memory:",
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    for (schema, file) in [
        ("saved", "library.sqlite"),
        ("catalog", "catalogs/kdata.db"),
    ] {
        let mut uri = url::Url::from_file_path(root.join(file)).unwrap();
        uri.set_query(Some("mode=ro"));
        connection
            .execute(&format!("ATTACH DATABASE ?1 AS {schema}"), [uri.as_str()])
            .unwrap();
    }
    for table in [
        "online_catalog_hidden_categories",
        "online_catalog_blocked_tags",
        "online_catalog_bookmarks",
    ] {
        let sql: String = connection
            .query_row(
                "SELECT sql FROM saved.sqlite_master WHERE name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        connection.execute_batch(&sql).unwrap();
        connection
            .execute(
                &format!("INSERT INTO main.{table} SELECT * FROM saved.{table}"),
                [],
            )
            .unwrap();
    }
    eprintln!("SQLite {}", rusqlite::version());
    for table in ["Works", "Tags"] {
        let count: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM catalog.{table}"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        eprintln!("{table}: {count}");
    }
    for policy in ["persisted", "reveal", "empty"] {
        if policy == "empty" {
            connection.execute_batch("DELETE FROM main.online_catalog_hidden_categories; DELETE FROM main.online_catalog_blocked_tags;").unwrap();
        }
        for text in ["", "love", "id:4169932", "female:glasses"] {
            for part in ["count", "page"] {
                let mut baseline = None;
                for before in [true, false] {
                    let (filter, values) = measured_where(
                        &connection,
                        text,
                        policy == "reveal",
                        before,
                        CatalogSort::Latest,
                    );
                    let sql = if part == "count" {
                        format!("SELECT COUNT(*) FROM catalog.Works AS work WHERE {filter}")
                    } else {
                        format!("SELECT work.Id, work.Title, work.TitleJpn, work.FileCount, work.Views, work.Posted, work.Thumb,
                            EXISTS (SELECT 1 FROM online_catalog_bookmarks AS bookmark WHERE bookmark.provider='kHentai' AND bookmark.work_id=CAST(work.Id AS TEXT))
                            FROM catalog.Works AS work WHERE {filter} ORDER BY work.Posted DESC, work.Id DESC LIMIT 48 OFFSET 0")
                    };
                    let plan = connection
                        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                        .unwrap()
                        .query_map(params_from_iter(values.iter()), |row| {
                            row.get::<_, String>(3)
                        })
                        .unwrap()
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap();
                    let mut statement = connection.prepare(&sql).unwrap();
                    let columns = statement.column_count();
                    let mut samples = Vec::new();
                    let mut result = Vec::new();
                    // One warm-up then three measured runs, identical connection,
                    // SQL, bindings and catalog. Compare every selected column.
                    for run in 0..4 {
                        let start = Instant::now();
                        result = statement
                            .query_map(params_from_iter(values.iter()), |row| {
                                (0..columns)
                                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                                    .collect::<Result<Vec<_>, _>>()
                            })
                            .unwrap()
                            .collect::<Result<Vec<_>, _>>()
                            .unwrap();
                        if run != 0 {
                            samples.push(start.elapsed().as_secs_f64() * 1000.0);
                        }
                    }
                    if before {
                        baseline = Some(result.clone());
                    } else {
                        assert_eq!(baseline.as_ref().unwrap(), &result);
                    }
                    let mut sorted = samples.clone();
                    sorted.sort_by(f64::total_cmp);
                    eprintln!(
                        "{}",
                        serde_json::json!({"policy":policy,"query":text,"part":part,"version":if before {"before"} else {"after"},"median_ms":sorted[1],"samples_ms":samples,"plan":plan,"rows":result.len()})
                    );
                }
            }
        }
    }
}

const LEGACY_WHERE: &str = "work.Expunged = 0 AND NOT EXISTS (
            SELECT 1 FROM main.online_catalog_hidden_categories AS hidden_category
            WHERE hidden_category.category = work.Category
        ) AND NOT EXISTS (
            SELECT 1 FROM catalog.Tags AS blocked_work_tag
            JOIN main.online_catalog_blocked_tags AS blocked_tag
              ON blocked_tag.namespace = blocked_work_tag.Namespace
             AND blocked_tag.value = blocked_work_tag.Value
            WHERE blocked_work_tag.WorkId = work.Id
        )";

#[test]
fn catalog_large_fixture_empty_policy_does_not_repeat_full_tag_walks() {
    // Reverting the planner/empty-policy fix makes the real search take
    // approximately as long as the old two full visibility scans below.
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    fs::create_dir_all(root.path().join("catalogs")).unwrap();
    let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
    catalog.execute_batch(SCHEMA).unwrap();
    catalog.execute_batch(
            "BEGIN;
             ALTER TABLE Works ADD COLUMN RawJson TEXT;
             WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<131210)
             INSERT INTO Works (Id, Title, TitleJpn, Category, Posted, Views, Expunged, RawJson)
             SELECT id, 'Work ' || id, CASE WHEN id%31=0 THEN 'Love' END,
                    id%11+1, id/3, (id*7919)%131210, id%33=0, hex(zeroblob(512)) FROM ids;
             WITH RECURSIVE tags(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM tags WHERE n<13)
             INSERT INTO Tags SELECT Id, 'female', 'tag-' || ((Id+n)%1000) FROM Works CROSS JOIN tags;
             CREATE INDEX IdxWorksPosted ON Works(Posted DESC);
             CREATE INDEX IdxWorksRank ON Works(Expunged, Views DESC, Posted);
             CREATE INDEX IdxTagsLookup ON Tags(Namespace, Value);
             COMMIT;",
        ).unwrap();
    drop(catalog);
    let connection = library.connection().unwrap();
    connection
        .execute(
            "ATTACH DATABASE ?1 AS catalog",
            [root
                .path()
                .join("catalogs/kdata.db")
                .to_string_lossy()
                .as_ref()],
        )
        .unwrap();
    let baseline_where = LEGACY_WHERE;
    let start = std::time::Instant::now();
    let count: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM catalog.Works AS work WHERE {baseline_where}"),
            [],
            |row| row.get(0),
        )
        .unwrap();
    let ids = connection.prepare(&format!("SELECT work.Id FROM catalog.Works AS work WHERE {baseline_where} ORDER BY work.Posted DESC, work.Id DESC LIMIT 48")).unwrap().query_map([], |row| row.get::<_, i64>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    let baseline = start.elapsed();
    let (filter, values) = measured_where(&connection, "", false, false, CatalogSort::Latest);
    let mut statement = connection.prepare(&format!("SELECT work.Id, work.Title FROM catalog.Works AS work WHERE {filter} ORDER BY work.Posted DESC, work.Id DESC LIMIT 48")).unwrap();
    statement
        .query_map(params_from_iter(values.iter()), |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    // Deterministic work budget, independent of wall clock/CI load: a latest
    // page must stop near its 48 results rather than visit 131k works.
    assert!(statement.get_status(rusqlite::StatementStatus::VmStep) < 10_000);
    drop(statement);
    let mut statement = connection
        .prepare(&format!(
            "SELECT COUNT(*) FROM catalog.Works AS work WHERE {filter}"
        ))
        .unwrap();
    let optimized_count: i64 = statement.query_row([], |row| row.get(0)).unwrap();
    assert_eq!(optimized_count, count);
    // Empty policies must not turn COUNT into millions of tag/policy probes.
    assert!(statement.get_status(rusqlite::StatementStatus::VmStep) < 1_000_000);
    drop(statement);
    let (views_filter, _) = measured_where(&connection, "", false, false, CatalogSort::Views);
    let mut statement = connection
        .prepare(&format!(
            "SELECT work.Id, work.Title FROM catalog.Works AS work WHERE {views_filter}
         ORDER BY work.Views DESC, work.Posted DESC, work.Id DESC LIMIT 48"
        ))
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        statement.get_status(rusqlite::StatementStatus::VmStep) < 10_000,
        "views page lost its rank-index early exit"
    );
    drop(statement);
    drop(connection);
    let start = std::time::Instant::now();
    let page = library
        .search_online_catalog(query("", CatalogSort::Latest, 0, 48))
        .unwrap();
    let elapsed = start.elapsed();
    assert_eq!(page.total_count, count as u64);
    assert_eq!(
        page.works
            .iter()
            .map(|work| work.identity.clone())
            .collect::<Vec<_>>(),
        ids.into_iter()
            .map(|id| khentai(id as u64))
            .collect::<Vec<_>>()
    );
    eprintln!("large fixture: old COUNT+page={baseline:?}, real search={elapsed:?}");

    // Independent fixture oracle: nullable Japanese titles, tag equality,
    // hidden categories, blocked tags, expunged rows, ties and later pages.
    library.set_catalog_category_hidden(4, true).unwrap();
    library.set_catalog_category_hidden(5, true).unwrap();
    for value in ["tag-1", "tag-2", "tag-3"] {
        library
            .set_catalog_tag_blocked(
                CatalogBlockedTag {
                    namespace: "female".into(),
                    value: value.into(),
                },
                true,
            )
            .unwrap();
    }
    for reveal in [false, true] {
        for text in ["", "Love", "id:131210", "female:tag-1"] {
            let mut expected: Vec<u64> = (1..=131210)
                .filter(|id| {
                    id % 33 != 0
                        && (reveal
                            || (!(4..=5).contains(&(id % 11 + 1))
                                && !(0..14).any(|n| (1..=3).contains(&((id + n) % 1000)))))
                        && match text {
                            "Love" => id % 31 == 0,
                            "id:131210" => *id == 131210,
                            "female:tag-1" => (0..14).any(|n| (id + n) % 1000 == 1),
                            _ => true,
                        }
                })
                .collect();
            expected.reverse();
            for page_number in [0, 1] {
                let mut request = query(text, CatalogSort::Latest, page_number, 48);
                request.reveal_blocked = reveal;
                let page = library.search_online_catalog(request).unwrap();
                assert_eq!(
                    page.total_count,
                    expected.len() as u64,
                    "{text}, reveal={reveal}"
                );
                assert_eq!(
                    page.works
                        .iter()
                        .map(|work| work.identity.clone())
                        .collect::<Vec<_>>(),
                    expected
                        .iter()
                        .skip(page_number as usize * 48)
                        .take(48)
                        .map(|id| khentai(*id))
                        .collect::<Vec<_>>(),
                    "{text}, reveal={reveal}, page={page_number}"
                );
            }
        }
    }
}
