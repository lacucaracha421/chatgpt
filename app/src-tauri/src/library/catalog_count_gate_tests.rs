//! Explicit real-scale gate: the source is opened read-only; all derived writes
//! and lifecycle mutations happen in a disposable, freshly created library.
use super::{
    catalog_counts,
    catalog_group_query::{self as grouped, GroupQueryPlan},
    models::{CatalogLanguage, CatalogScope, CatalogSearchQuery, CatalogSort},
    Library,
};
use rusqlite::{params_from_iter, types::Value, Connection, OpenFlags};
use serde_json::{json, Value as Json};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};

fn measured<T>(mut run: impl FnMut() -> T) -> (T, Json) {
    let mut samples = Vec::new();
    let mut result = run(); // warmup
    for _ in 0..3 {
        let start = Instant::now();
        result = run();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    (result, json!({"median_ms":sorted[1],"samples_ms":samples}))
}
fn explain(c: &Connection, sql: &str, values: &[Value]) -> Vec<String> {
    c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(params_from_iter(values), |r| r.get(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
fn count_sql(c: &Connection, statement: &(String, Vec<Value>)) -> (u64, Json) {
    let (n, mut timing) = measured(|| {
        c.query_row(&statement.0, params_from_iter(&statement.1), |r| {
            r.get::<_, i64>(0)
        })
        .unwrap() as u64
    });
    timing["plan"] = json!(explain(c, &statement.0, &statement.1));
    (n, timing)
}
fn query(
    text: &str,
    language: Option<CatalogLanguage>,
    reveal: bool,
    scope: CatalogScope,
    sort: CatalogSort,
) -> CatalogSearchQuery {
    CatalogSearchQuery {
        provider: super::catalog_provider::CatalogProvider::KHentai,
        text: text.into(),
        language,
        reveal_blocked: reveal,
        scope,
        sort,
        page: 0,
        page_size: 48,
    }
}
fn run_case(c: &Connection, q: &CatalogSearchQuery) -> Json {
    let now = chrono::Utc::now().timestamp();
    let (plan, planning) = measured(|| GroupQueryPlan::new(c, q, now).unwrap());
    let (expected, generic) = count_sql(c, &plan.generic_count_statement());
    let (raw, raw_timing) = count_sql(c, &plan.raw_count_statement());
    grouped::take_measurements();
    let (actual, mut count) = measured(|| grouped::count_groups(c, &plan).unwrap());
    assert_eq!(
        actual,
        Some(expected),
        "exact oracle parity: {} {:?} {:?}",
        q.text,
        q.language,
        q.sort
    );
    if let Some((sql, values)) = plan.count_statement() {
        count["plan"] = json!(explain(c, &sql, &values));
    } else {
        count["plan"] = json!([
            explain(c,"SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'",&[]),
            explain(c,"SELECT source_revision,generation,last_error FROM online_catalog_group_state WHERE provider='kHentai'",&[]),
            explain(c,"SELECT category FROM online_catalog_hidden_categories ORDER BY category",&[]),
            explain(c,"SELECT namespace,value FROM online_catalog_blocked_tags ORDER BY namespace,value",&[]),
            explain(c,"SELECT exact_count,integrity_hash FROM online_catalog_prepared_counts WHERE provider=?1 AND language=?2 AND reveal=?3 AND source_revision=?4 AND generation=?5 AND count_rule_version=?6 AND policy_identity=?7",&["kHentai".to_owned().into(),"all".to_owned().into(),0.into(),"revision".to_owned().into(),1.into(),1.into(),"policy".to_owned().into()])
        ]);
    }
    grouped::take_measurements();
    let (rows, page_and_representatives) = measured(|| grouped::select_page(c, &plan).unwrap());
    let phases = grouped::take_measurements();
    let mut phase_samples: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut phase_plans = BTreeMap::new();
    for phase in phases {
        phase_samples
            .entry(phase.phase.to_owned())
            .or_default()
            .push(phase.duration.as_secs_f64() * 1000.0);
        phase_plans
            .entry(phase.phase.to_owned())
            .or_insert_with(|| explain(c, &phase.sql, &phase.values));
    }
    let phase_timings: BTreeMap<_, _> = phase_samples
        .into_iter()
        .map(|(name, samples)| {
            assert_eq!(samples.len(), 4, "phase {name}");
            let mut timed = samples[1..].to_vec();
            timed.sort_by(f64::total_cmp);
            let report =
                json!({"median_ms":timed[1],"samples_ms":&samples[1..],"plan":phase_plans[&name]});
            (name, report)
        })
        .collect();
    assert_eq!(
        rows.iter()
            .map(|r| &r.group_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        rows.len()
    );
    assert_eq!(rows.len(), expected.min(48) as usize);
    // Same bounded metadata/tag hydration shape as the production summary loader.
    // This separately measures SQL hydration, not native command/UI serialization.
    let ids = rows
        .iter()
        .map(|r| Value::Integer(r.representative_id))
        .collect::<Vec<_>>();
    let hydration = if ids.is_empty() {
        json!({"median_ms":0.0,"empty_page":true})
    } else {
        let marks = vec!["?"; ids.len()].join(",");
        let works=format!("SELECT Id,Title,TitleJpn,Thumb,FileCount,Category,Uploader,Posted,Views FROM catalog.Works WHERE Id IN ({marks})");
        let tags=format!("SELECT WorkId,Namespace,Value FROM catalog.Tags WHERE WorkId IN ({marks}) AND Namespace IN ('artist','series') ORDER BY WorkId,Namespace,Value");
        let (_, mut report) = measured(|| {
            for sql in [&works, &tags] {
                let mut statement = c.prepare(sql).unwrap();
                let columns = statement.column_count();
                let _: Vec<Vec<Value>> = statement
                    .query_map(params_from_iter(&ids), |r| {
                        (0..columns).map(|i| r.get(i)).collect()
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
            }
        });
        report["work_plan"] = json!(explain(c, &works, &ids));
        report["tag_plan"] = json!(explain(c, &tags, &ids));
        report
    };
    json!({"text":q.text,"language":format!("{:?}",q.language),"reveal":q.reveal_blocked,"scope":format!("{:?}",q.scope),"sort":format!("{:?}",q.sort),"route":format!("{:?}",plan.route),"hot_cutoff":plan.hot_cutoff,"exact_groups":expected,"raw_works":raw,"planning":planning,"count":count,"generic_count":generic,"raw_count":raw_timing,"page_and_representatives":page_and_representatives,"phases":phase_timings,"hydration_sql":hydration,"oracle_parity":true})
}
fn copy_source(source: &Path, destination: &Path) {
    let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut destination = Connection::open(destination).unwrap();
    rusqlite::backup::Backup::new(&source, &mut destination)
        .unwrap()
        .run_to_completion(1024, Duration::from_millis(1), None)
        .unwrap();
}
fn wait_preparation(library: &Library) {
    let started = Instant::now();
    loop {
        let (running, error) = library.catalog_preparation_status();
        assert!(error.is_none(), "preparation failed: {error:?}");
        if !running {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "preparation timed out"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn six(library: &Library) -> Vec<Option<u64>> {
    let mut c = library.catalog_read_connection().unwrap();
    let tx = c.transaction().unwrap();
    [
        None,
        Some(CatalogLanguage::Korean),
        Some(CatalogLanguage::Japanese),
    ]
    .into_iter()
    .flat_map(|l| [false, true].map(|r| catalog_counts::lookup(&tx, l, r).unwrap()))
    .collect()
}
#[test]
#[ignore = "explicit read-only source opt-in; set LAKOMICS_CATALOG_COUNT_GATE_SOURCE to library root"]
fn catalog_count_integrated_real_gate() {
    let source = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_COUNT_GATE_SOURCE")
            .expect("explicit source library root required"),
    );
    assert!(source.is_absolute());
    let temporary = tempfile::tempdir().unwrap();
    // Open BEFORE copying catalog, so startup cannot prepare an unowned source.
    let library = Library::open(temporary.path()).unwrap();
    fs::create_dir_all(temporary.path().join("catalogs")).unwrap();
    copy_source(
        &source.join("catalogs/kdata.db"),
        &temporary.path().join("catalogs/kdata.db"),
    );
    {
        let c = library.connection().unwrap();
        let mut uri = url::Url::from_file_path(source.join("library.sqlite")).unwrap();
        uri.set_query(Some("mode=ro"));
        c.execute("ATTACH DATABASE ? AS saved", [uri.as_str()])
            .unwrap();
        for table in [
            "online_catalog_hidden_categories",
            "online_catalog_blocked_tags",
            "online_catalog_bookmarks",
        ] {
            c.execute(
                &format!("INSERT INTO main.{table} SELECT * FROM saved.{table}"),
                [],
            )
            .unwrap();
        }
    }
    let mut evidence = json!({"sqlite":rusqlite::version(),"source":source,"temporary_fixture":temporary.path(),"source_access":"SQLITE_OPEN_READ_ONLY backup and mode=ro saved policy/bookmarks", "warmup_runs":1,"timed_runs":3});
    let started = Instant::now();
    assert!(library.prepare_online_catalog_counts().unwrap());
    evidence["first_generation_prepare_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    let (works, tags) = {
        let c = library.catalog_read_connection().unwrap();
        (
            c.query_row("SELECT COUNT(*) FROM catalog.Works", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            c.query_row("SELECT COUNT(*) FROM catalog.Tags", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        )
    };
    assert!(
        works >= 130_000 && tags >= 1_700_000,
        "fixture too small: {works}/{tags}"
    );
    evidence["works"] = json!(works);
    evidence["tags"] = json!(tags);
    let initial = six(&library);
    assert!(initial.iter().all(Option::is_some));
    let (_, reuse) = measured(|| assert!(!library.prepare_online_catalog_counts().unwrap()));
    evidence["unchanged_prepare_reuse"] = reuse;
    let mut held_library = Some(library);
    let (_, restart) = measured(|| {
        drop(held_library.take());
        let start = Instant::now();
        let reopened = Library::open(temporary.path()).unwrap();
        wait_preparation(&reopened);
        assert_eq!(six(&reopened), initial);
        assert!(!reopened.prepare_online_catalog_counts().unwrap());
        let elapsed = start.elapsed();
        held_library = Some(reopened);
        elapsed
    });
    let library = held_library.unwrap();
    evidence["normal_restart_reuse"] = restart;
    {
        let mut c = library.catalog_read_connection().unwrap();
        let tx = c.transaction().unwrap();
        let (_, compute) = measured(|| catalog_counts::compute(&tx).unwrap().unwrap());
        evidence["six_count_compute"] = compute;
    }
    let prepared = {
        let mut c = library.catalog_read_connection().unwrap();
        let tx = c.transaction().unwrap();
        catalog_counts::compute(&tx).unwrap().unwrap()
    };
    let (_, publish) = measured(|| {
        let mut c = library.connection().unwrap();
        super::catalog_preparation::attach_catalog_readonly(&c, temporary.path()).unwrap();
        let tx = c.transaction().unwrap();
        assert!(catalog_counts::publish(&tx, &prepared).unwrap());
        tx.commit().unwrap();
    });
    evidence["six_count_publish"] = publish;
    let mut cases = Vec::new();
    for policy in ["saved", "empty"] {
        if policy == "empty" {
            let c = library.connection().unwrap();
            c.execute_batch("DELETE FROM online_catalog_hidden_categories; DELETE FROM online_catalog_blocked_tags").unwrap();
            drop(c);
            library.prepare_online_catalog_counts().unwrap();
        }
        let mut c = library.catalog_read_connection().unwrap();
        let tx = c.transaction().unwrap();
        for reveal in [false, true] {
            for language in [
                None,
                Some(CatalogLanguage::Korean),
                Some(CatalogLanguage::Japanese),
            ] {
                let (_, timing) = measured(|| {
                    catalog_counts::lookup(&tx, language, reveal)
                        .unwrap()
                        .unwrap()
                });
                for sort in [
                    CatalogSort::Latest,
                    CatalogSort::Views,
                    CatalogSort::HotDay,
                    CatalogSort::HotWeek,
                    CatalogSort::HotMonth,
                ] {
                    for scope in [CatalogScope::All, CatalogScope::Bookmarked] {
                        let mut result = run_case(&tx, &query("", language, reveal, scope, sort));
                        result["policy"] = json!(policy);
                        result["validity_lookup"] = timing.clone();
                        eprintln!("COUNT_GATE_CASE {}", result);
                        cases.push(result);
                    }
                }
            }
            for text in [
                "love",
                "id:4169932",
                "female:glasses",
                "(love OR female:glasses) AND NOT language:english",
            ] {
                let mut result = run_case(
                    &tx,
                    &query(text, None, reveal, CatalogScope::All, CatalogSort::Latest),
                );
                result["policy"] = json!(policy);
                eprintln!("COUNT_GATE_CASE {}", result);
                cases.push(result);
            }
        }
    }
    evidence["cases"] = json!(cases);
    // Timed lifecycle invalidations mutate ONLY the disposable fixture.
    for kind in ["source", "policy", "generation"] {
        let mut ordinal = 0;
        let (_, timing) = measured(|| {
            ordinal += 1;
            if kind == "source" {
                let c = Connection::open(temporary.path().join("catalogs/kdata.db")).unwrap();
                c.execute(
                    "UPDATE CrawlState SET Value=? WHERE Key='lakomics.catalog.contentRevision'",
                    [format!("gate-source-{ordinal}")],
                )
                .unwrap();
            } else {
                let c = library.connection().unwrap();
                if kind == "policy" {
                    c.execute("INSERT OR REPLACE INTO online_catalog_hidden_categories(category,created_at) VALUES(?,'gate')",[ordinal]).unwrap();
                } else {
                    c.execute(
                        "UPDATE online_catalog_group_state SET generation=generation+1",
                        [],
                    )
                    .unwrap();
                }
            }
            assert!(library.prepare_online_catalog_counts().unwrap());
            assert!(six(&library).iter().all(Option::is_some));
        });
        evidence[format!("{kind}_invalidation_prepare")] = timing;
    }
    let output = std::env::temp_dir().join(format!(
        "lakomics-count-integrated-gate-{}.json",
        uuid::Uuid::new_v4()
    ));
    fs::write(&output, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    eprintln!("COUNT_GATE_EVIDENCE {}", output.display());
    // Keep the production gate decision reviewable: report every path before
    // asserting hard latency targets, so a regression leaves complete evidence.
    let cases = evidence["cases"].as_array().unwrap();
    for case in cases {
        if case["route"] == "Prepared" {
            assert!(
                case["count"]["median_ms"].as_f64().unwrap() < 14.0,
                "prepared lookup exceeds baseline class: {case}"
            );
        }
        if case["route"] == "Id" {
            assert!(
                case["count"]["median_ms"].as_f64().unwrap() < 1.0,
                "ID count target: {case}"
            );
            assert!(
                case["phases"]["page"]["median_ms"].as_f64().unwrap() < 1.0,
                "ID donor target: {case}"
            );
        }
    }
    // Explicitly release all fixture connections before TempDir cleanup.
    drop(library);
}

#[test]
#[ignore = "fresh-generation timing supplement; explicit LAKOMICS_CATALOG_COUNT_GATE_SOURCE required"]
fn catalog_count_fresh_generation_gate() {
    let source = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_COUNT_GATE_SOURCE")
            .expect("explicit source library root required"),
    );
    assert!(source.is_absolute());
    let mut samples = Vec::new();
    let mut metadata = json!({});
    let mut focused_cases = Vec::new();
    for run in 0..4 {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        fs::create_dir_all(temporary.path().join("catalogs")).unwrap();
        copy_source(
            &source.join("catalogs/kdata.db"),
            &temporary.path().join("catalogs/kdata.db"),
        );
        {
            let c = library.connection().unwrap();
            let mut uri = url::Url::from_file_path(source.join("library.sqlite")).unwrap();
            uri.set_query(Some("mode=ro"));
            c.execute("ATTACH DATABASE ? AS saved", [uri.as_str()])
                .unwrap();
            for table in [
                "online_catalog_hidden_categories",
                "online_catalog_blocked_tags",
                "online_catalog_bookmarks",
            ] {
                c.execute(
                    &format!("INSERT INTO main.{table} SELECT * FROM saved.{table}"),
                    [],
                )
                .unwrap();
            }
        }
        let start = Instant::now();
        assert!(library.prepare_online_catalog_counts().unwrap());
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(six(&library).iter().all(Option::is_some));
        if run > 0 {
            samples.push(ms);
        }
        let c = library.catalog_read_connection().unwrap();
        for (name,sql) in [
            ("works","SELECT COUNT(*) FROM catalog.Works"),
            ("tags","SELECT COUNT(*) FROM catalog.Tags"),
            ("bookmarks","SELECT COUNT(*) FROM online_catalog_bookmarks WHERE provider='kHentai'"),
            ("hidden_categories","SELECT COUNT(*) FROM online_catalog_hidden_categories"),
            ("blocked_tags","SELECT COUNT(*) FROM online_catalog_blocked_tags"),
            ("groups","SELECT COUNT(DISTINCT group_id) FROM online_catalog_group_members WHERE provider='kHentai'"),
            ("max_group_members","SELECT MAX(n) FROM (SELECT COUNT(*) n FROM online_catalog_group_members WHERE provider='kHentai' GROUP BY group_id)")
        ] {metadata[name]=json!(c.query_row(sql,[],|r|r.get::<_,i64>(0)).unwrap());}
        if run == 3 {
            let snapshot = c.unchecked_transaction().unwrap();
            for reveal in [false, true] {
                for text in ["love", "(love OR female:glasses) AND pages>=100"] {
                    let result = run_case(
                        &snapshot,
                        &query(text, None, reveal, CatalogScope::All, CatalogSort::Latest),
                    );
                    eprintln!("FOCUSED_BASELINE_CASE {}", result);
                    focused_cases.push(result);
                }
            }
        }
        eprintln!("FRESH_GENERATION run={run} ms={ms}");
    }
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    let evidence = json!({"source_access":"read-only backup; copied policy and bookmarks", "backup_excluded":true,"fresh_libraries":4,"warmup_runs":1,"samples_ms":samples,"median_ms":sorted[1],"metadata":metadata,"focused_baseline_cases":focused_cases});
    let output = std::env::temp_dir().join(format!(
        "lakomics-count-fresh-generation-{}.json",
        uuid::Uuid::new_v4()
    ));
    fs::write(&output, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    eprintln!("FRESH_GENERATION_EVIDENCE {}", output.display());
}

#[test]
#[ignore = "test-only seeded page SQL comparison; explicit read-only source opt-in"]
fn catalog_count_seed_page_gate() {
    let source = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_COUNT_GATE_SOURCE")
            .expect("explicit source library root required"),
    );
    assert!(source.is_absolute());
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    fs::create_dir_all(temporary.path().join("catalogs")).unwrap();
    copy_source(
        &source.join("catalogs/kdata.db"),
        &temporary.path().join("catalogs/kdata.db"),
    );
    {
        let c = library.connection().unwrap();
        let mut uri = url::Url::from_file_path(source.join("library.sqlite")).unwrap();
        uri.set_query(Some("mode=ro"));
        c.execute("ATTACH DATABASE ? AS saved", [uri.as_str()])
            .unwrap();
        for table in [
            "online_catalog_hidden_categories",
            "online_catalog_blocked_tags",
            "online_catalog_bookmarks",
        ] {
            c.execute(
                &format!("INSERT INTO main.{table} SELECT * FROM saved.{table}"),
                [],
            )
            .unwrap();
        }
    }
    assert!(library.prepare_online_catalog_counts().unwrap());
    let mut c = library.connection().unwrap();
    super::catalog_preparation::attach_catalog_readonly(&c, temporary.path()).unwrap();
    let base_candidates: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM online_catalog_bookmarks WHERE provider='kHentai'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut cases = Vec::new();
    let boundary_only = std::env::var_os("LAKOMICS_SEED_PAGE_BOUNDARIES_ONLY").is_some();
    let output = std::env::temp_dir().join(format!(
        "lakomics-count-seed-page-{}.json",
        uuid::Uuid::new_v4()
    ));
    let mut preflights = Vec::new();
    for language in [CatalogLanguage::Korean, CatalogLanguage::Japanese] {
        let sql="SELECT COUNT(*) FROM (SELECT WorkId FROM catalog.Tags INDEXED BY IdxTagsLookup WHERE Namespace='language' AND Value=? LIMIT 1025)";
        let values = vec![Value::Text(language.as_tag().into())];
        let (candidates, mut timing) = count_sql(&c, &(sql.into(), values));
        timing["language"] = json!(language.as_tag());
        timing["bounded_candidates"] = json!(candidates);
        eprintln!("SEED_PREFLIGHT {}", timing);
        preflights.push(timing);
    }
    for target in if boundary_only {
        [256, 512, 1024]
    } else {
        [base_candidates, 512, 1024]
    } {
        let tx = c.transaction().unwrap();
        if target > base_candidates {
            tx.execute("INSERT INTO online_catalog_bookmarks(provider,work_id,created_at) SELECT 'kHentai',CAST(Id AS TEXT),'gate' FROM catalog.Works work WHERE NOT EXISTS(SELECT 1 FROM online_catalog_bookmarks b WHERE b.provider='kHentai' AND b.work_id=CAST(work.Id AS TEXT)) ORDER BY (work.Id*7919)%131210,work.Id LIMIT ?",[target-base_candidates]).unwrap();
        }
        for language in [
            None,
            Some(CatalogLanguage::Korean),
            Some(CatalogLanguage::Japanese),
        ] {
            for reveal in [false, true] {
                for sort in [CatalogSort::Latest, CatalogSort::Views] {
                    if boundary_only
                        && (language != Some(CatalogLanguage::Japanese)
                            || sort != CatalogSort::Views)
                    {
                        continue;
                    }
                    if target != base_candidates
                        && (language == Some(CatalogLanguage::Korean)
                            || sort == CatalogSort::Latest)
                    {
                        continue;
                    }
                    let q = query("", language, reveal, CatalogScope::Bookmarked, sort);
                    let plan =
                        GroupQueryPlan::new(&tx, &q, chrono::Utc::now().timestamp()).unwrap();
                    grouped::take_measurements();
                    let selected = grouped::select_page(&tx, &plan).unwrap();
                    let baseline = grouped::take_measurements()
                        .into_iter()
                        .find(|m| m.phase == "page")
                        .unwrap();
                    let baseline_sql = baseline.sql.replace(
                        "SELECT member.group_id,donor.Title",
                        "SELECT member.group_id,donor.Title,donor.Id",
                    );
                    assert_ne!(baseline_sql, baseline.sql);
                    let (seed_sql, seed_values) = plan.experimental_seed_page_statement().unwrap();
                    let read = |sql: &str, values: &[Value]| {
                        let mut statement = tx.prepare(sql).unwrap();
                        assert_eq!(statement.column_count(), 3);
                        statement
                            .query_map(params_from_iter(values), |r| {
                                Ok((
                                    r.get::<_, String>(0)?,
                                    r.get::<_, String>(1)?,
                                    r.get::<_, i64>(2)?,
                                ))
                            })
                            .unwrap()
                            .collect::<Result<Vec<_>, _>>()
                            .unwrap()
                    };
                    let (expected, mut old) = measured(|| read(&baseline_sql, &baseline.values));
                    let (actual, mut candidate) = measured(|| read(&seed_sql, &seed_values));
                    assert_eq!(actual, expected, "exact donor/group/title ordering");
                    assert_eq!(
                        actual.iter().map(|r| &r.0).collect::<Vec<_>>(),
                        selected.iter().map(|r| &r.group_id).collect::<Vec<_>>()
                    );
                    old["plan"] = json!(explain(&tx, &baseline_sql, &baseline.values));
                    candidate["plan"] = json!(explain(&tx, &seed_sql, &seed_values));
                    let result = json!({"reveal":reveal,"sort":format!("{sort:?}"),"language":format!("{:?}",language),"scope":"bookmarked","bookmark_candidates":tx.query_row("SELECT COUNT(*) FROM online_catalog_bookmarks WHERE provider='kHentai'",[],|r|r.get::<_,i64>(0)).unwrap(),"route":format!("{:?}",plan.route),"donors":actual.len(),"baseline":old,"candidate":candidate,"exact_donor_parity":true});
                    eprintln!("SEED_PAGE_CASE {}", result);
                    cases.push(result);
                    fs::write(
                        &output,
                        serde_json::to_vec_pretty(&json!({"preflights":preflights,"cases":cases}))
                            .unwrap(),
                    )
                    .unwrap();
                }
            }
        }
        tx.rollback().unwrap();
    }
    eprintln!("SEED_PAGE_EVIDENCE {}", output.display());
}

#[test]
#[ignore = "bounded bookmark-language preflight timing; explicit read-only source opt-in"]
fn catalog_count_bookmark_language_probe_gate() {
    let source = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_COUNT_GATE_SOURCE")
            .expect("explicit source library root required"),
    );
    assert!(source.is_absolute());
    let c = Connection::open_in_memory().unwrap();
    for (schema, file) in [
        ("catalog", "catalogs/kdata.db"),
        ("saved", "library.sqlite"),
    ] {
        let mut uri = url::Url::from_file_path(source.join(file)).unwrap();
        uri.set_query(Some("mode=ro"));
        c.execute(&format!("ATTACH DATABASE ? AS {schema}"), [uri.as_str()])
            .unwrap();
    }
    c.execute_batch(include_str!(
        "../../migrations/0019_online_catalog_bookmarks.sql"
    ))
    .unwrap();
    c.execute(
        "INSERT INTO online_catalog_bookmarks SELECT * FROM saved.online_catalog_bookmarks",
        [],
    )
    .unwrap();
    let original: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM online_catalog_bookmarks WHERE provider='kHentai'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut cases = Vec::new();
    for target in [original, 512] {
        let tx = c.unchecked_transaction().unwrap();
        if target > original {
            tx.execute("INSERT INTO online_catalog_bookmarks(provider,work_id,created_at) SELECT 'kHentai',CAST(Id AS TEXT),'gate' FROM catalog.Works work WHERE NOT EXISTS(SELECT 1 FROM online_catalog_bookmarks b WHERE b.provider='kHentai' AND b.work_id=CAST(work.Id AS TEXT)) ORDER BY (work.Id*7919)%131210,work.Id LIMIT ?",[target-original]).unwrap();
        }
        for language in [CatalogLanguage::Korean, CatalogLanguage::Japanese] {
            let q = query(
                "",
                Some(language),
                true,
                CatalogScope::Bookmarked,
                CatalogSort::Latest,
            );
            let plan = GroupQueryPlan::new(&tx, &q, chrono::Utc::now().timestamp()).unwrap();
            let statement = plan.experimental_short_page_probe_statement().unwrap();
            let (n, mut timing) = count_sql(&tx, &statement);
            timing["bookmark_candidates"] = json!(target);
            timing["language"] = json!(language.as_tag());
            timing["bounded_language_members"] = json!(n);
            eprintln!("BOOKMARK_LANGUAGE_PROBE {}", timing);
            cases.push(timing);
        }
        tx.rollback().unwrap();
    }
    let output = std::env::temp_dir().join(format!(
        "lakomics-count-bookmark-language-probe-{}.json",
        uuid::Uuid::new_v4()
    ));
    fs::write(&output, serde_json::to_vec_pretty(&cases).unwrap()).unwrap();
    eprintln!("BOOKMARK_LANGUAGE_PROBE_EVIDENCE {}", output.display());
}

#[test]
#[ignore = "final production sparse-bookmark page gate; explicit read-only source opt-in"]
fn catalog_count_final_production_sparse_page_gate() {
    let source = std::path::PathBuf::from(
        std::env::var("LAKOMICS_CATALOG_COUNT_GATE_SOURCE")
            .expect("explicit source library root required"),
    );
    assert!(source.is_absolute());
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    fs::create_dir_all(temporary.path().join("catalogs")).unwrap();
    copy_source(
        &source.join("catalogs/kdata.db"),
        &temporary.path().join("catalogs/kdata.db"),
    );
    {
        let c = library.connection().unwrap();
        let mut uri = url::Url::from_file_path(source.join("library.sqlite")).unwrap();
        uri.set_query(Some("mode=ro"));
        c.execute("ATTACH DATABASE ? AS saved", [uri.as_str()])
            .unwrap();
        for table in [
            "online_catalog_hidden_categories",
            "online_catalog_blocked_tags",
            "online_catalog_bookmarks",
        ] {
            c.execute(
                &format!("INSERT INTO main.{table} SELECT * FROM saved.{table}"),
                [],
            )
            .unwrap();
        }
    }
    assert!(library.prepare_online_catalog_counts().unwrap());
    let mut c = library.catalog_read_connection().unwrap();
    let tx = c.transaction().unwrap();
    let mut cases = Vec::new();
    for reveal in [false, true] {
        let result = run_case(
            &tx,
            &query(
                "",
                Some(CatalogLanguage::Japanese),
                reveal,
                CatalogScope::Bookmarked,
                CatalogSort::Views,
            ),
        );
        let plan = result["phases"]["page"]["plan"].as_array().unwrap();
        assert!(
            plan.iter()
                .any(|line| line.as_str().unwrap().contains("MATERIALIZE candidate")),
            "production page must seed candidates"
        );
        assert!(
            !plan
                .iter()
                .any(|line| line.as_str().unwrap().contains("IdxWorksRank")),
            "production page must avoid global rank traversal"
        );
        eprintln!("FINAL_PRODUCTION_PAGE_CASE {}", result);
        cases.push(result);
    }
    let output = std::env::temp_dir().join(format!(
        "lakomics-count-final-production-page-{}.json",
        uuid::Uuid::new_v4()
    ));
    fs::write(&output, serde_json::to_vec_pretty(&cases).unwrap()).unwrap();
    eprintln!("FINAL_PRODUCTION_PAGE_EVIDENCE {}", output.display());
}
