//! Experimental SQL gate; these queries are not the production search implementation.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    time::Instant,
};

use rusqlite::{params_from_iter, types::Value, Connection, OpenFlags, StatementStatus};

use super::{
    super::{
        catalog_lineage::{analyze, LineageLink, LineagePlan, LineageWork},
        models::CatalogSort,
        Library,
    },
    performance_tests::measured_where,
    tests::SCHEMA,
};

fn create_membership(connection: &mut Connection, plan: &LineagePlan) {
    connection
        .execute_batch(
            "CREATE TABLE experiment_member(provider TEXT NOT NULL,work_id TEXT NOT NULL,
            id INTEGER NOT NULL,group_id TEXT NOT NULL,thumbnail_valid INTEGER NOT NULL,
            completeness INTEGER NOT NULL,lineage_terminal INTEGER NOT NULL,
            PRIMARY KEY(provider,work_id),UNIQUE(provider,id)) WITHOUT ROWID;
        CREATE INDEX experiment_member_group ON experiment_member(provider,group_id,id);",
        )
        .unwrap();
    let tx = connection.transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO experiment_member VALUES ('kHentai',?1,?2,?3,0,0,?4)")
            .unwrap();
        for component in &plan.components {
            let group = uuid::Uuid::new_v4().to_string();
            for id in component {
                insert
                    .execute((id.to_string(), id, &group, plan.terminal_ids.contains(id)))
                    .unwrap();
            }
        }
    }
    tx.commit().unwrap();
}

fn predicate(
    connection: &Connection,
    text: &str,
    reveal: bool,
    sort: CatalogSort,
) -> (String, Vec<Value>) {
    let (mut filter, mut values) = measured_where(connection, text, reveal, false, sort);
    let seconds = match sort {
        CatalogSort::HotDay => Some(86_400),
        CatalogSort::HotWeek => Some(604_800),
        CatalogSort::HotMonth => Some(2_592_000),
        _ => None,
    };
    if let Some(seconds) = seconds {
        let now = chrono::Utc::now().timestamp();
        let latest: Option<i64> = connection
            .query_row(
                "SELECT MAX(Posted) FROM catalog.Works WHERE Expunged=0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        filter.push_str(" AND work.Posted >= ?");
        values.push((latest.map_or(now, |n| n.min(now)) - seconds).into());
    }
    (filter, values)
}

fn order(sort: CatalogSort, alias: &str) -> String {
    if sort == CatalogSort::Latest {
        format!("{alias}.Posted DESC, {alias}.Id DESC")
    } else {
        format!("{alias}.Views DESC, {alias}.Posted DESC, {alias}.Id DESC")
    }
}

fn donor_sql(filter: &str, sort: CatalogSort, page: usize) -> String {
    // Test-only alias adaptation. Production needs an explicit compiler alias.
    let inner = filter.replace("work.", "donor.");
    // Unary + prevents the unrelated Views rank index from driving Latest.
    // This experimentally preserves numeric Expunged semantics without requiring
    // a particular imported index name.
    let filter = if sort == CatalogSort::Latest {
        filter.replace("likely(work.Expunged = 0)", "(+work.Expunged = 0)")
    } else {
        filter.to_owned()
    };
    let greater = if sort == CatalogSort::Latest {
        "(donor.Posted, donor.Id) > (work.Posted, work.Id)"
    } else {
        "(donor.Views, donor.Posted, donor.Id) > (work.Views, work.Posted, work.Id)"
    };
    format!(
        "SELECT work.Id, member.group_id, work.Title FROM catalog.Works AS work
        CROSS JOIN experiment_member AS member ON member.provider='kHentai' AND member.id=work.Id
        WHERE {filter} AND NOT EXISTS (
          SELECT 1 FROM experiment_member AS sibling
          CROSS JOIN catalog.Works AS donor ON donor.Id=sibling.id
          WHERE sibling.provider=member.provider AND sibling.group_id=member.group_id AND {greater} AND ({inner})
        ) ORDER BY {} LIMIT 48 OFFSET {}",
        order(sort, "work"),
        page * 48
    )
}

fn explain(connection: &Connection, sql: &str, values: &[Value]) -> Vec<String> {
    connection
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(params_from_iter(values.iter()), |r| r.get(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn timed_query(
    connection: &Connection,
    sql: &str,
    values: &[Value],
) -> (Vec<Vec<Value>>, serde_json::Value) {
    let plan = explain(connection, sql, values);
    let mut stmt = connection.prepare(sql).unwrap();
    let columns = stmt.column_count();
    let mut samples = Vec::new();
    let mut rows = Vec::new();
    let mut steps = 0;
    for run in 0..4 {
        stmt.reset_status(StatementStatus::VmStep);
        let start = Instant::now();
        rows = stmt
            .query_map(params_from_iter(values.iter()), |r| {
                (0..columns).map(|i| r.get(i)).collect()
            })
            .unwrap()
            .collect::<Result<Vec<Vec<Value>>, _>>()
            .unwrap();
        if run > 0 {
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        steps = stmt.get_status(StatementStatus::VmStep);
    }
    samples.sort_by(f64::total_cmp);
    let result = serde_json::json!({"median_ms":samples[1], "samples_ms":samples, "vm_steps":steps, "plan":plan, "rows":rows.len()});
    (rows, result)
}

fn oracle(
    connection: &Connection,
    filter: &str,
    values: &[Value],
    sort: CatalogSort,
) -> Vec<(i64, String)> {
    let sql = format!(
        "SELECT work.Id, member.group_id FROM catalog.Works AS work
        CROSS JOIN experiment_member AS member ON member.provider='kHentai' AND member.id=work.Id WHERE {filter} ORDER BY {}",
        order(sort, "work")
    );
    let mut stmt = connection.prepare(&sql).unwrap();
    let mut seen = BTreeSet::new();
    stmt.query_map(params_from_iter(values.iter()), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })
    .unwrap()
    .map(Result::unwrap)
    .filter(|(_, group)| seen.insert(group.clone()))
    .collect()
}

fn run_case(
    connection: &Connection,
    plan: &LineagePlan,
    text: &str,
    reveal: bool,
    sort: CatalogSort,
    check_pages: usize,
) -> serde_json::Value {
    let (filter, values) = predicate(connection, text, reveal, sort);
    let (raw_count, raw_count_measurement) = timed_query(
        connection,
        &format!("SELECT COUNT(*) FROM catalog.Works AS work WHERE {filter}"),
        &values,
    );
    let (_, raw_page) = timed_query(
        connection,
        &format!(
            "SELECT work.Id, work.Title FROM catalog.Works AS work WHERE {filter} ORDER BY {} LIMIT 48",
            order(sort, "work")
        ),
        &values,
    );
    let (group_count, count_measurement) = timed_query(connection, &format!("SELECT COUNT(DISTINCT member.group_id) FROM catalog.Works AS work NOT INDEXED CROSS JOIN experiment_member AS member ON member.provider='kHentai' AND member.id=work.Id WHERE {filter}"), &values);
    let expected = oracle(connection, &filter, &values, sort);
    assert_eq!(group_count[0][0], Value::Integer(expected.len() as i64));
    let mut page_measurements = Vec::new();
    let mut representative_ms = 0.0;
    for page in 0..check_pages {
        let sql = donor_sql(&filter, sort, page);
        let mut bindings = values.clone();
        bindings.extend(values.iter().cloned());
        let (rows, measurement) = timed_query(connection, &sql, &bindings);
        let actual: Vec<_> = rows
            .iter()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Integer(id), Value::Text(group)) => (*id, group.clone()),
                _ => panic!("unexpected donor row"),
            })
            .collect();
        assert_eq!(
            actual,
            expected
                .iter()
                .skip(page * 48)
                .take(48)
                .cloned()
                .collect::<Vec<_>>()
        );
        assert_eq!(
            actual.iter().map(|r| &r.1).collect::<BTreeSet<_>>().len(),
            actual.len()
        );
        // Explicit N+1 experiment, bounded by the returned 48 groups. This is
        // evidence for selection cost, not a proposed product query design.
        let start = Instant::now();
        let representative_sql = format!("SELECT work.Id, COALESCE(work.Posted,0),
          EXISTS(SELECT 1 FROM catalog.Tags AS korean WHERE korean.WorkId=work.Id AND korean.Namespace='language' AND korean.Value='korean')
          FROM experiment_member AS member JOIN catalog.Works AS work ON work.Id=member.id
          WHERE member.provider='kHentai' AND member.group_id=? AND ({filter})");
        let mut representative = connection.prepare(&representative_sql).unwrap();
        for (_, group) in &actual {
            let mut bindings = vec![Value::Text(group.clone())];
            bindings.extend(values.iter().cloned());
            let choice = representative
                .query_map(params_from_iter(bindings.iter()), |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .max_by_key(|(id, posted, korean)| {
                    (*korean, plan.terminal_ids.contains(id), *posted, *id)
                });
            assert!(choice.is_some());
        }
        representative_ms += start.elapsed().as_secs_f64() * 1000.0;
        page_measurements.push(measurement);
    }
    let raw_count = match raw_count[0][0] {
        Value::Integer(n) => n,
        _ => panic!("unexpected count type"),
    };
    serde_json::json!({"text":text,"reveal":reveal,"sort":format!("{sort:?}"),"raw_count":raw_count,"groups":expected.len(),"baseline_count":raw_count_measurement,"baseline_page":raw_page,"grouped_count":count_measurement,"grouped_pages":page_measurements,"representative_experiment_ms":representative_ms})
}

#[test]
fn catalog_group_realistic_fixture_preserves_count_donors_and_early_exit() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let mut connection = library.connection().unwrap();
    connection
        .execute_batch("ATTACH ':memory:' AS catalog")
        .unwrap();
    // SCHEMA is shared with the production catalog importer tests.
    let schema = SCHEMA.replace("CREATE TABLE ", "CREATE TABLE catalog.");
    connection.execute_batch(&schema).unwrap();
    connection.execute_batch("BEGIN;
        WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<131210)
        INSERT INTO catalog.Works(Id,Title,TitleJpn,Category,Posted,Views,Expunged)
        SELECT id,'Work '||id,CASE WHEN id%31=0 THEN 'Love' END,id%11+1,1700000000+id/3,(id*7919)%131210,id%33=0 FROM ids;
        WITH RECURSIVE tags(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM tags WHERE n<13)
        INSERT INTO catalog.Tags SELECT Id,CASE WHEN n=0 THEN 'language' ELSE 'female' END,
          CASE WHEN n=0 THEN CASE WHEN Id%5=0 THEN 'korean' ELSE 'english' END
          WHEN n=1 AND Id%71=0 THEN 'glasses' ELSE 'tag-'||((Id+n)%1000) END FROM catalog.Works CROSS JOIN tags;
        CREATE INDEX catalog.IdxWorksPosted ON Works(Posted DESC);
        CREATE INDEX catalog.IdxWorksRank ON Works(Expunged,Views DESC,Posted);
        CREATE INDEX catalog.IdxTagsLookup ON Tags(Namespace,Value);
        COMMIT;").unwrap();
    let mut components = Vec::new();
    let mut terminal_ids = BTreeSet::new();
    components.push((1..=104).collect());
    terminal_ids.insert(104);
    let mut id = 105;
    while id <= 131210 {
        if id % 12 == 0 && id < 131210 {
            components.push(vec![id, id + 1]);
            terminal_ids.insert(id + 1);
            id += 2;
        } else {
            components.push(vec![id]);
            id += 1;
        }
    }
    let plan = LineagePlan {
        components,
        terminal_ids,
        diagnostics: vec![],
    };
    create_membership(&mut connection, &plan);
    connection.execute("INSERT INTO online_catalog_group_members SELECT provider,work_id,id,group_id,thumbnail_valid,completeness,lineage_terminal FROM experiment_member",[]).unwrap();
    for text in ["", "love", "id:131210", "female:glasses", "language:korean"] {
        let measured = run_case(&connection, &plan, text, false, CatalogSort::Latest, 2);
        if text.is_empty() {
            let page = &measured["grouped_pages"][0];
            assert!(page["vm_steps"].as_i64().unwrap() < 30_000, "{measured}");
            let explain = page["plan"].to_string();
            assert!(explain.contains("IdxWorksPosted"), "{explain}");
            assert!(
                !explain.contains("USE TEMP B-TREE FOR ORDER BY"),
                "{explain}"
            );
        }
    }
    // Exercise the actual backend draft too, not only experimental SQL shapes.
    for sort in [
        CatalogSort::Latest,
        CatalogSort::Views,
        CatalogSort::HotDay,
        CatalogSort::HotWeek,
        CatalogSort::HotMonth,
    ] {
        let query = super::super::models::CatalogSearchQuery {
            provider: super::super::catalog_provider::CatalogProvider::KHentai,
            language: None,
            reveal_blocked: false,
            text: String::new(),
            sort,
            scope: super::super::models::CatalogScope::All,
            page: 0,
            page_size: 48,
        };
        let (filter, values) = predicate(&connection, "", false, sort);
        let expected = oracle(&connection, &filter, &values, sort);
        let started = Instant::now();
        let (rows, count) =
            super::super::catalog_group_query::select_groups(&connection, &query).unwrap();
        assert_eq!(count, expected.len() as u64);
        assert_eq!(
            rows.iter().map(|row| &row.group_id).collect::<Vec<_>>(),
            expected
                .iter()
                .take(48)
                .map(|row| &row.1)
                .collect::<Vec<_>>()
        );
        assert!(
            started.elapsed().as_secs_f64() < 3.0,
            "{sort:?} exceeded broad runaway-scan guard"
        );
    }
}

#[test]
#[ignore = "read-only grouping benchmark; set LAKOMICS_CATALOG_BENCH_ROOT"]
fn catalog_group_real_query_measurements() {
    let root = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_BENCH_ROOT").expect("explicit benchmark root required"),
    );
    let mut connection = Connection::open_with_flags(
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
                |r| r.get(0),
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
    let works = {
        let mut stmt = connection.prepare("SELECT Id,Token,ParentGid,ParentKey,FirstGid,FirstKey,CurrentGid,CurrentKey FROM catalog.Works ORDER BY Id").unwrap();
        let rows = stmt
            .query_map([], |r| {
                let link = |offset| -> rusqlite::Result<Option<LineageLink>> {
                    Ok(r.get::<_, Option<i64>>(offset)?.map(|target| LineageLink {
                        target,
                        key: r.get(offset + 1).unwrap(),
                    }))
                };
                Ok(LineageWork {
                    id: r.get(0)?,
                    token: r.get(1)?,
                    parent: link(2)?,
                    first: link(4)?,
                    current: link(6)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    };
    let start = Instant::now();
    let plan = analyze(&works);
    create_membership(&mut connection, &plan);
    let setup_ms = start.elapsed().as_secs_f64() * 1000.0;
    if std::env::var_os("LAKOMICS_CATALOG_COUNT_ORDINAL").is_some() {
        measure_ordinal_counts(&mut connection, &plan);
        return;
    }
    if std::env::var_os("LAKOMICS_CATALOG_COUNT_ALTERNATIVES").is_some() {
        measure_count_alternatives(&connection);
        return;
    }
    let mut measurements = Vec::new();
    // One unoptimized JOIN measurement demonstrates planner sensitivity; do not
    // repeat this slow variant for the entire matrix.
    let (filter, values) = predicate(&connection, "love", false, CatalogSort::Latest);
    let (_,normal_join)=timed_query(&connection,&format!("SELECT COUNT(DISTINCT member.group_id) FROM catalog.Works AS work JOIN experiment_member AS member ON member.provider='kHentai' AND member.id=work.Id WHERE {filter}"),&values);
    for policy in ["persisted", "reveal", "empty"] {
        if policy == "empty" {
            connection.execute_batch("DELETE FROM main.online_catalog_hidden_categories; DELETE FROM main.online_catalog_blocked_tags;").unwrap();
        }
        for text in [
            "",
            "love",
            "id:4169932",
            "female:glasses",
            "language:korean",
        ] {
            let mut case = run_case(
                &connection,
                &plan,
                text,
                policy == "reveal",
                CatalogSort::Latest,
                1,
            );
            case["policy"] = policy.into();
            eprintln!("{case}");
            measurements.push(case);
        }
        for sort in [
            CatalogSort::Views,
            CatalogSort::HotDay,
            CatalogSort::HotWeek,
            CatalogSort::HotMonth,
        ] {
            let mut case = run_case(&connection, &plan, "", policy == "reveal", sort, 1);
            case["policy"] = policy.into();
            eprintln!("{case}");
            measurements.push(case);
        }
    }
    let sizes = plan
        .components
        .iter()
        .fold(BTreeMap::<usize, usize>::new(), |mut counts, c| {
            *counts.entry(c.len()).or_default() += 1;
            counts
        });
    let output = serde_json::json!({"sqlite":rusqlite::version(),"works":works.len(),"setup_ms":setup_ms,"component_sizes":sizes,"diagnostics":plan.diagnostics.len(),"normal_join_diagnostic":normal_join,"cases":measurements});
    let path = std::env::temp_dir().join("lakomics-catalog-group-performance.json");
    fs::write(&path, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
    eprintln!("measurements: {}", path.display());
}

fn measure_count_alternatives(connection: &Connection) {
    let mut cases = Vec::new();
    for covering in [false, true] {
        if covering {
            connection.execute_batch("CREATE INDEX experiment_member_cover ON experiment_member(provider,id,group_id)").unwrap();
        }
        let access = if covering {
            "INDEXED BY experiment_member_cover"
        } else {
            ""
        };
        for reveal in [false, true] {
            for text in ["", "language:korean", "love"] {
                let (filter, values) = predicate(connection, text, reveal, CatalogSort::Latest);
                let (_, baseline) = timed_query(
                    connection,
                    &format!("SELECT COUNT(*) FROM catalog.Works AS work WHERE {filter}"),
                    &values,
                );
                let (distinct_count, distinct) = timed_query(
                    connection,
                    &format!(
                        "SELECT COUNT(DISTINCT member.group_id)
                    FROM catalog.Works AS work NOT INDEXED CROSS JOIN experiment_member AS member {access}
                    ON member.provider='kHentai' AND member.id=work.Id WHERE {filter}"
                    ),
                    &values,
                );
                let inner = filter.replace("work.", "donor.");
                let mut bindings = values.clone();
                bindings.extend(values.iter().cloned());
                let (anti_count, anti) = timed_query(
                    connection,
                    &format!(
                        "SELECT COUNT(*)
                    FROM catalog.Works AS work NOT INDEXED CROSS JOIN experiment_member AS member {access}
                    ON member.provider='kHentai' AND member.id=work.Id WHERE {filter}
                    AND NOT EXISTS(SELECT 1 FROM experiment_member AS sibling
                        CROSS JOIN catalog.Works AS donor ON donor.Id=sibling.id
                        WHERE sibling.provider=member.provider AND sibling.group_id=member.group_id
                        AND sibling.id<work.Id AND ({inner}))"
                    ),
                    &bindings,
                );
                assert_eq!(anti_count, distinct_count, "text={text},reveal={reveal}");
                let case = serde_json::json!({"text":text,"reveal":reveal,"covering":covering,"baseline":baseline,"distinct":distinct,"anti_predecessor":anti});
                eprintln!("{case}");
                cases.push(case);
            }
        }
    }
    let path = std::env::temp_dir().join("lakomics-catalog-count-alternatives.json");
    fs::write(&path, serde_json::to_vec_pretty(&cases).unwrap()).unwrap();
    eprintln!("count alternative measurements: {}", path.display());
}

fn measure_ordinal_counts(connection: &mut Connection, plan: &LineagePlan) {
    connection
        .execute_batch(
            "ALTER TABLE experiment_member ADD COLUMN group_ordinal INTEGER;
        CREATE TEMP TABLE experiment_ordinal(id INTEGER PRIMARY KEY,ordinal INTEGER NOT NULL);",
        )
        .unwrap();
    let tx = connection.transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO experiment_ordinal VALUES(?1,?2)")
            .unwrap();
        for (ordinal, component) in plan.components.iter().enumerate() {
            for id in component {
                insert.execute((id, ordinal as i64)).unwrap();
            }
        }
    }
    tx.commit().unwrap();
    connection.execute_batch("UPDATE experiment_member SET group_ordinal=(SELECT ordinal FROM experiment_ordinal WHERE id=experiment_member.id);
        CREATE INDEX experiment_member_ordinal_cover ON experiment_member(provider,id,group_ordinal);").unwrap();
    let mut cases = Vec::new();
    for reveal in [false, true] {
        for text in ["", "language:korean", "love"] {
            let (filter, values) = predicate(connection, text, reveal, CatalogSort::Latest);
            let (_, baseline) = timed_query(
                connection,
                &format!("SELECT COUNT(*) FROM catalog.Works AS work WHERE {filter}"),
                &values,
            );
            let (count, ordinal) = timed_query(
                connection,
                &format!(
                    "SELECT COUNT(DISTINCT member.group_ordinal)
                FROM catalog.Works AS work NOT INDEXED CROSS JOIN experiment_member AS member INDEXED BY experiment_member_ordinal_cover
                ON member.provider='kHentai' AND member.id=work.Id WHERE {filter}"
                ),
                &values,
            );
            let expected = oracle(connection, &filter, &values, CatalogSort::Latest);
            assert_eq!(count[0][0], Value::Integer(expected.len() as i64));
            let case = serde_json::json!({"text":text,"reveal":reveal,"baseline":baseline,"ordinal":ordinal});
            eprintln!("{case}");
            cases.push(case);
        }
    }
    let path = std::env::temp_dir().join("lakomics-catalog-count-ordinal.json");
    fs::write(&path, serde_json::to_vec_pretty(&cases).unwrap()).unwrap();
    eprintln!("ordinal count measurements: {}", path.display());
}
