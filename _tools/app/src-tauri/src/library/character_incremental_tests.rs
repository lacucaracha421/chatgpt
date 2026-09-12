use super::super::characters::tests::Fixture;
use super::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[test]
fn automation_setting_reports_the_worker_pause_independently_of_history_pause() {
    let f = Fixture::new();
    f.library.set_character_incremental_paused(true).unwrap();
    let status = serde_json::to_value(f.library.character_incremental_status().unwrap()).unwrap();
    assert_eq!(status["automationEnabled"], false);
    assert_eq!(status["paused"], false);
    f.library.set_character_reference_refresh_paused(true).unwrap();
    f.library.set_character_incremental_paused(false).unwrap();
    let status = serde_json::to_value(f.library.character_incremental_status().unwrap()).unwrap();
    assert_eq!(status["automationEnabled"], true);
    assert_eq!(status["paused"], true);
    let connection = f.library.connection().unwrap();
    let jobs: i64 = connection.query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |r| r.get(0)).unwrap();
    let refreshes: i64 = connection.query_row("SELECT COUNT(*) FROM character_reference_refreshes", [], |r| r.get(0)).unwrap();
    assert_eq!((jobs, refreshes), (0, 0));
    drop(connection);
    drop(f.library);
    let reopened = crate::library::Library::open(f.temp.path()).unwrap();
    let status = serde_json::to_value(reopened.character_incremental_status().unwrap()).unwrap();
    assert_eq!(status["automationEnabled"], true);
    assert_eq!(status["paused"], true);
}

/// Five anchors cap matched references at five, so `AUTOMATIC_REFERENCE_SUPPORT` above
/// five needs an extra reference. Register one in-series asset as a learned reference.
fn add_learned_reference(f: &Fixture, target_id: &str) {
    let id = format!("learned-{target_id}");
    let hash: String = Sha256::digest(id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let original = format!("assets/{id}.png");
    let thumbnail = format!("thumbnails/{id}.webp");
    std::fs::write(f.temp.path().join(&original), id.as_bytes()).unwrap();
    std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
    let connection = f.library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
             VALUES(?1,?2,'image',?1,?3,?4,7,1,1,'2026-09-08','normal')",
            params![id, hash, original, thumbnail],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO asset_classifications SELECT ?1,series_classification_id FROM character_targets WHERE id=?2",
            params![id, target_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES(?1,?2,?3,'2026-09-11')",
            params![target_id, id, hash],
        )
        .unwrap();
}

fn config(f: &Fixture) -> RuntimeConfig {
    let script = f.temp.path().join("worker.py");
    std::fs::write(&script,r#"
import json,sys,pathlib
log=pathlib.Path(__file__).with_suffix('.log')
def record(message):
    with log.open('a') as out: out.write(message+'\n')
def emit(value): print(json.dumps(value),flush=True)
baseline='40246ab31230e100e9592811d032e7383959ad168c1c738520003993bf357199'
record('start')
emit({'type':'ready','baselineFingerprint':baseline,'runtimeFingerprint':'a'*64})
refs=[];resident=None
for line in sys.stdin:
    r=json.loads(line);record(r['type'])
    if r['type']=='compare_query' and pathlib.Path(__file__).with_name('change-reference').exists():
        pathlib.Path(__file__).with_name('assets').joinpath('asset-0.png').write_bytes(b'changed')
    if r['type']=='prepare':
        record('prepare_paths:'+json.dumps([i['path'] for i in r['references']]))
        refs=[i['hash'] for i in r['references']]
        emit({'type':'prepared','referenceHashes':refs})
    elif r['type']=='load_query':
        resident=(r['assetId'],r['hash'])
        emit({'type':'query_loaded','assetId':r['assetId'],'contentHash':r['hash']})
    elif r['type']=='compare_delta':
        assert resident==(r['assetId'],r['hash'])
        refs=list(r['oldEvidence']['referenceHashes'])+[i['hash'] for i in r['addedReferences']]
        emit({'type':'result','assetId':r['assetId'],'contentHash':r['hash'],'baselineFingerprint':baseline,
              'referenceHashes':refs,'passed':True,'distance':0.1,'wholeFallback':False,'bestQueryCrop':0,
              'queryBoxes':[[0,0,10,10]],'referenceBoxes':[[] for _ in refs],
              'referenceWholeFallback':[False for _ in refs],
              'evidence':[{'matchedReferences':list(range(len(refs))),'referenceDistances':[0.1]*len(refs)}]})
    else:
        if r['type']=='compare_query': assert resident==(r['assetId'],r['hash'])
        emit({'type':'result','assetId':r['assetId'],'contentHash':r['hash'],'baselineFingerprint':baseline,
              'referenceHashes':refs,'passed':True,'distance':0.1,'wholeFallback':False,'bestQueryCrop':0,
              'queryBoxes':[[0,0,10,10]],'referenceBoxes':[[] for _ in refs],
              'referenceWholeFallback':[False for _ in refs],
              'evidence':[{'matchedReferences':[0,1,2,3],'referenceDistances':[0.1]*len(refs)}]})
"#).unwrap();
    RuntimeConfig {
        python: std::env::var_os("LAKOMICS_CHARACTER_TEST_PYTHON")
            .expect("explicit test Python")
            .into(),
        script,
        models: f.temp.path().into(),
    }
}
fn prepare_paths(config: &RuntimeConfig) -> Vec<Vec<String>> {
    std::fs::read_to_string(config.script.with_extension("log"))
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("prepare_paths:"))
        .map(|paths| serde_json::from_str(paths).unwrap())
        .collect()
}
fn run(f: &Fixture, config: &RuntimeConfig, id: &str) {
    run_with_cause(f, config, id, character_autotag::Cause::Ingestion);
}
fn run_with_cause(f: &Fixture, config: &RuntimeConfig, id: &str, cause: character_autotag::Cause) {
    character_autotag::enqueue(&f.library.connection().unwrap(), id, cause).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(job.asset_id, id);
    f.library
        .compare_incremental_asset(&job, config, Arc::new(AtomicBool::new(false)))
        .unwrap();
}

#[test]
#[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON"]
fn unified_reference_pool_compares_remaining_images_and_restores_six_vote_acceptance() {
    let f = Fixture::new();
    let target = f.ready("Unified");
    add_learned_reference(&f, &target.id);
    let config = config(&f);
    let worker = std::fs::read_to_string(&config.script).unwrap()
        .replace("'matchedReferences':[0,1,2,3]", "'matchedReferences':list(range(len(refs)))");
    std::fs::write(&config.script, worker).unwrap();

    f.library.trash_assets(&["asset-0".into()]).unwrap();
    run(&f, &config, "asset-5");
    assert!(f.library.character_relations_for_asset("asset-5").unwrap().is_empty());
    assert_eq!(prepare_paths(&config)[0].len(), 5);

    f.library.restore_assets(&["asset-0".into()]).unwrap();
    // Restore enrollment is independent of this query; isolate its next claim.
    f.library.connection().unwrap().execute("DELETE FROM character_autotag_jobs WHERE asset_id='asset-0'", []).unwrap();
    run_with_cause(&f, &config, "asset-5", character_autotag::Cause::ManualScanEnrollment);
    assert_eq!(prepare_paths(&config)[1].len(), 6);
    assert_eq!(f.library.character_relations_for_asset("asset-5").unwrap(), vec![target.id.clone()]);
    let current = f.library.get_character_target(&target.id).unwrap();
    assert_eq!(current.usable_references().count(), 6, "automatic acceptance never adds a reference");
}

#[test]
fn status_exposes_only_quiet_control_state_for_explicit_history_refresh() {
    let f = Fixture::new();
    let target = f.ready("A");
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE character_autotag_jobs
             SET state='completed',review_state='unresolved',claim_id=NULL
             WHERE asset_id='asset-5'",
            [],
        )
        .unwrap();
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library
        .set_character_reference_refresh_paused(true)
        .unwrap();

    let status = serde_json::to_value(f.library.character_incremental_status().unwrap()).unwrap();

    assert_eq!(status["historyRefreshActive"], true);
    assert_eq!(status["paused"], true);
    assert!(status.get("persistentError").is_some());
    for hidden in [
        "pending",
        "pendingAutomatic",
        "pendingLegacy",
        "pendingManual",
        "pendingReconsideration",
        "activeAssetId",
        "activeSeriesName",
        "activeTargetName",
        "activeTargetIndex",
        "activeReconsideration",
        "activeCause",
        "total",
        "compared",
        "error",
    ] {
        assert!(status.get(hidden).is_none(), "{hidden} leaked into status");
    }
}

#[test]
fn history_refresh_pause_does_not_pause_normal_character_work() {
    let f = Fixture::new();
    let target = f.ready("A");
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE character_autotag_jobs SET state='completed',review_state='unresolved',claim_id=NULL WHERE asset_id='asset-5'",
            [],
        )
        .unwrap();
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();

    f.library
        .set_character_reference_refresh_paused(true)
        .unwrap();

    let status = serde_json::to_value(f.library.character_incremental_status().unwrap()).unwrap();
    assert_eq!(status["historyRefreshActive"], true);
    assert_eq!(status["paused"], true);
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        0
    );
    let globally_paused: bool = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT paused FROM character_autotag_control WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!globally_paused);
}

#[test]
fn manual_request_promotes_pending_work_without_creating_a_new_generation() {
    let f = Fixture::new();
    f.ready("A");
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let before = f.library.character_autotag_job("asset-5").unwrap().unwrap();

    assert!(character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::ManualScanEnrollment,
    )
    .unwrap());
    let after = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.source_generation, before.source_generation);
    assert_eq!(after.state, "pending");
    assert_eq!(after.cause, "manual_scan");
    let claimed = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(claimed.asset_id, "asset-5");
    assert_eq!(claimed.cause, "manual_scan");
}

#[test]
fn mixed_root_work_labels_the_scope_instead_of_the_first_series() {
    let f = Fixture::new();
    let first = f.ready("A");
    let root: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT parent_id FROM classification_entries WHERE id=?1",
            [&f.series],
            |row| row.get(0),
        )
        .unwrap();
    let second_series = f
        .library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Tag,
            name: "Second series".into(),
            parent_id: Some(root.clone()),
        })
        .unwrap()
        .id;
    let second = f
        .library
        .save_character_target(crate::library::characters::TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(second_series),
            linked_classification_id: None,
            display_name: "B".into(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: true,
        })
        .unwrap();
    let job = Job {
        asset_id: "asset-5".into(),
        generation: 2,
        source_generation: 1,
        content_hash: String::new(),
        relative_path: String::new(),
        classification_ids: vec![root],
        state: "processing".into(),
        review_state: "unresolved".into(),
        claim_id: None,
        attempts: 1,
        cause: "reconsideration".into(),
        error: None,
    };
    let connection = f.library.connection().unwrap();
    let mixed = Context {
        hash: String::new(),
        runtime: String::new(),
        scope: json!({}),
        targets: vec![first.clone(), second],
    };
    assert_eq!(
        active_scope_name(&connection, &job, &mixed)
            .unwrap()
            .as_deref(),
        Some("Root · 여러 시리즈")
    );
    let single = Context {
        targets: vec![first],
        ..mixed
    };
    assert_eq!(
        active_scope_name(&connection, &job, &single)
            .unwrap()
            .as_deref(),
        Some("Series is a tag")
    );
}

#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn native_auto_and_manual_scan_share_one_worker_and_keep_review_durable() {
    let f = Fixture::new();
    let target = f.ready("A");
    let config = config(&f);
    run(&f, &config, "asset-5");
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![target.id.clone()]
    );
    assert!(f
        .library
        .get_character_target(&target.id)
        .unwrap()
        .learned_references
        .is_empty());
    let status = f
        .library
        .start_character_scan(&target.id, &target.fingerprint, config.clone())
        .unwrap();
    let start = std::time::Instant::now();
    loop {
        let state = f.library.character_scan_status().unwrap();
        assert!(start.elapsed() < Duration::from_secs(5));
        if state.state != "running" {
            assert_eq!(state.state, "completed", "{:?}", state.error);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!f
        .library
        .character_scan_results(&status.id, None, 20)
        .unwrap()
        .is_empty());
    let log = std::fs::read_to_string(config.script.with_extension("log")).unwrap();
    assert_eq!(log.lines().filter(|l| *l == "start").count(), 1);
    assert_eq!(log.lines().filter(|l| *l == "load_query").count(), 1);
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
    assert!(f.library.claim_character_autotag().unwrap().is_none());
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![target.id]
    );
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
}
#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn same_scope_history_growth_does_not_add_queries_or_worker_starts() {
    let f = Fixture::new();
    f.ready("A");
    f.ready("B");
    let config = config(&f);
    {
        let c = f.library.connection().unwrap();
        c.execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
            [&f.series],
        )
        .unwrap();
    }
    let mut previous = 0;
    for (count, id) in [(1000, "asset-5"), (8000, "asset-6")] {
        {
            let mut c = f.library.connection().unwrap();
            let tx = c.transaction().unwrap();
            for n in previous..count {
                let asset = format!("covered-{n}");
                tx.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                    VALUES(?1,?1,'image',?1,?1,?1,7,1,1,'before','normal')",[&asset]).unwrap();
                tx.execute(
                    "INSERT INTO asset_classifications VALUES(?1,?2)",
                    params![asset, f.series],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        run(&f, &config, id);
        previous = count;
        let log = std::fs::read_to_string(config.script.with_extension("log")).unwrap();
        let jobs = if count == 1000 { 1 } else { 2 };
        assert_eq!(log.lines().filter(|l| *l == "start").count(), 1);
        assert_eq!(log.lines().filter(|l| *l == "load_query").count(), jobs);
        assert_eq!(
            log.lines().filter(|l| *l == "compare_query").count(),
            jobs * 2
        );
        assert!(
            f.library
                .character_relations_for_asset(id)
                .unwrap()
                .is_empty(),
            "competing matches remain for review"
        );
        assert_eq!(
            f.library
                .character_autotag_job(id)
                .unwrap()
                .unwrap()
                .review_state,
            "unresolved"
        );
    }
    let paths = prepare_paths(&config);
    assert_eq!(paths.len(), 4);
    assert_eq!(
        paths[0], paths[2],
        "warm candidates must reuse target A snapshots"
    );
    assert_eq!(
        paths[1], paths[3],
        "warm candidates must reuse target B snapshots"
    );
    assert!(f
        .library
        .character_incremental
        .lock()
        .unwrap()
        .prepared_references
        .is_some());
    f.library.stop_character_scan();
    assert!(f
        .library
        .character_incremental
        .lock()
        .unwrap()
        .prepared_references
        .is_none());
}

#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn anchors_and_explicit_learning_invalidate_prepared_reference_snapshots() {
    let f = Fixture::new();
    let mut target = f.ready("A");
    let config = config(&f);
    run(&f, &config, "asset-5");
    let first = prepare_paths(&config).last().unwrap().clone();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
            [&f.child],
        )
        .unwrap();
    let mut anchors = f.refs[..4].to_vec();
    anchors.push("asset-6".into());
    target = f
        .library
        .replace_character_references(&target.id, target.revision, &anchors)
        .unwrap();
    run_with_cause(
        &f,
        &config,
        "asset-5",
        character_autotag::Cause::Reconsideration,
    );
    let changed_anchors = prepare_paths(&config).last().unwrap().clone();
    assert_ne!(first, changed_anchors);
    target = f
        .library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    run_with_cause(
        &f,
        &config,
        "asset-5",
        character_autotag::Cause::Reconsideration,
    );
    let with_learning = prepare_paths(&config).last().unwrap().clone();
    assert_eq!(with_learning.len(), 6);
    assert_ne!(changed_anchors, with_learning);
    f.library
        .exclude_character_reference(&target.id, target.revision, "asset-5")
        .unwrap();
    run_with_cause(
        &f,
        &config,
        "asset-5",
        character_autotag::Cause::Reconsideration,
    );
    let without_learning = prepare_paths(&config).last().unwrap().clone();
    assert_eq!(without_learning.len(), 5);
    assert_ne!(with_learning, without_learning);
}
#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn scheduler_preserves_pause_and_processes_new_work_without_renderer() {
    let f = Fixture::new();
    f.ready("A");
    let config = config(&f);
    f.library.set_character_incremental_paused(true).unwrap();
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    f.library.start_character_incremental(config);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    f.library.set_character_incremental_paused(false).unwrap();
    let start = std::time::Instant::now();
    while f
        .library
        .character_autotag_job("asset-5")
        .unwrap()
        .unwrap()
        .state
        != "completed"
    {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            f.library.character_incremental_status()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    f.library.stop_character_incremental();
}

#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn externally_changed_reference_cannot_authorize_automatic_decisions() {
    let f = Fixture::new();
    f.ready("A");
    let config = config(&f);
    std::fs::write(f.temp.path().join("change-reference"), b"test").unwrap();
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert!(f
        .library
        .compare_incremental_asset(&job, &config, Arc::new(AtomicBool::new(false)))
        .is_err());
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM character_autotag_evidence", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(f
        .library
        .character_incremental
        .lock()
        .unwrap()
        .prepared_references
        .is_none());
}

#[test]
#[ignore = "real external fixture and models; explicit environment required"]
fn real_native_incremental_queue_reuses_kisaki_references() {
    let fixture = PathBuf::from(std::env::var_os("LAKOMICS_CHARACTER_TEST_FIXTURE").unwrap());
    let mut refs = std::fs::read_dir(fixture.join("refs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    let mut queries = std::fs::read_dir(fixture.join("target"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    refs.sort();
    queries.sort();
    assert_eq!(refs.len(), 5);
    assert!(queries.len() >= 2);
    let f = Fixture::new();
    for (index, source) in refs.iter().chain(queries.iter().take(2)).enumerate() {
        let destination = f.temp.path().join(format!("assets/asset-{index}.png"));
        std::fs::copy(source, &destination).unwrap();
        let bytes = std::fs::read(&destination).unwrap();
        let hash = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash=?2,byte_size=?3 WHERE id=?1",
                params![format!("asset-{index}"), hash, bytes.len() as i64],
            )
            .unwrap();
    }
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
            [&f.series],
        )
        .unwrap();
    let target = f.ready("Kisaki");
    let config = RuntimeConfig {
        python: std::env::var_os("LAKOMICS_CHARACTER_TEST_PYTHON")
            .unwrap()
            .into(),
        script: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../character-runtime/scan_worker.py"),
        models: std::env::var_os("LAKOMICS_CHARACTER_TEST_MODELS")
            .unwrap()
            .into(),
    };
    f.library
        .start_character_scan(&target.id, &target.fingerprint, config.clone())
        .unwrap();
    let wait_started = std::time::Instant::now();
    loop {
        let status = f.library.character_scan_status().unwrap();
        assert!(
            wait_started.elapsed() < Duration::from_secs(60),
            "{status:?}"
        );
        if status.state != "running" {
            assert_eq!(status.state, "completed", "{status:?}");
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let started = std::time::Instant::now();
    run(&f, &config, "asset-5");
    let first = started.elapsed();
    let started = std::time::Instant::now();
    run(&f, &config, "asset-6");
    let second = started.elapsed();
    assert!(f
        .library
        .character_incremental
        .lock()
        .unwrap()
        .prepared_references
        .is_some());
    for id in ["asset-5", "asset-6"] {
        assert_eq!(
            f.library.character_autotag_job(id).unwrap().unwrap().state,
            "completed"
        );
    }
    println!("kisaki incremental first={first:?} warm={second:?}");
}

#[test]
fn incremental_owner_feeds_only_explicit_reference_refresh() {
    let f = Fixture::new();
    let target = f.target("A");
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    let c = f.library.connection().unwrap();
    c.execute(
        "UPDATE character_autotag_jobs SET state='completed',claim_id=NULL,review_state='awaiting_candidates' WHERE asset_id=?1",
        [&job.asset_id],
    ).unwrap();
    drop(c);
    let target = f
        .library
        .replace_character_references(&target.id, target.revision, &f.refs)
        .unwrap();
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        0
    );
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );

    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    assert_eq!(receipt.eligible_count, 1);
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let refreshed = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(refreshed.state, "pending");
    assert_eq!(refreshed.cause, "reconsideration");

    f.library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status='trash' WHERE id='asset-0'", [])
        .unwrap();
    let scheduled: i64 = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM character_autotag_reconsideration",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(scheduled, 0);
}

#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn parent_inference_reuses_one_query_per_image_across_two_dozen_characters() {
    let f = Fixture::new();
    for index in 0..24 {
        let series = if index % 2 == 0 { &f.series } else { &f.child };
        f.ready_in_series(&format!("Character {index}"), series);
    }
    f.library.connection().unwrap().execute(
        "UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id IN ('asset-5','asset-6')",
        [&f.series],
    ).unwrap();
    let config = config(&f);
    for id in ["asset-5", "asset-6"] {
        run(&f, &config, id);
        assert_eq!(f.library.character_autotag_job(id).unwrap().unwrap().state, "completed");
        assert!(f.library.character_relations_for_asset(id).unwrap().is_empty());
    }
    let log = std::fs::read_to_string(config.script.with_extension("log")).unwrap();
    assert_eq!(log.lines().filter(|line| *line == "start").count(), 1);
    assert_eq!(log.lines().filter(|line| *line == "load_query").count(), 2);
    assert_eq!(log.lines().filter(|line| *line == "compare_query").count(), 48);
    let c = f.library.connection().unwrap();
    let predictions: i64 = c.query_row("SELECT COUNT(*) FROM character_autotag_predictions", [], |r| r.get(0)).unwrap();
    assert_eq!(predictions, 48);
}

#[test]
fn parent_inference_arbitrates_across_series_and_preserves_the_saved_folder() {
    use super::super::characters::{DecisionKind, DecisionRequest};
    // An intermediate parent exercises the same policy as a top-level category.
    for (intermediate, competing_votes, expected) in [(false, 0, 1), (true, 0, 1), (true, 2, 0)] {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready_in_series("Nested B", &f.child);
        add_learned_reference(&f, &a.id);
        add_learned_reference(&f, &b.id);
        let c = f.library.connection().unwrap();
        let root: String = c.query_row("SELECT parent_id FROM classification_entries WHERE id=?1", [&f.series], |r| r.get(0)).unwrap();
        drop(c);
        let parent = if intermediate {
            f.library.create_classification(super::super::models::CreateClassification {
                kind: super::super::models::ClassificationKind::Tag,
                name: "Intermediate".into(), parent_id: Some(root),
            }).unwrap().id
        } else { root };
        let c = f.library.connection().unwrap();
        c.execute("UPDATE classification_entries SET parent_id=?1 WHERE id=?2", params![parent, f.series]).unwrap();
        c.execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'", [&parent]).unwrap();
        assert!(character_autotag::enqueue(&c, "asset-5", character_autotag::Cause::Ingestion).unwrap());
        drop(c);
        let job = f.library.claim_character_autotag().unwrap().unwrap();
        let mut c = f.library.connection().unwrap();
        let tx = c.transaction().unwrap();
        let context = f.library.character_autotag_context(&tx, &job, &"a".repeat(64)).unwrap();
        assert_eq!(context.targets.len(), 2);
        let predictions = [(&a, 6), (&b, competing_votes)].into_iter().map(|(target, votes)| Prediction {
            target_id: target.id.clone(),
            result: ScanResult {
                asset_id: job.asset_id.clone(), content_hash: job.content_hash.clone(),
                state: "recommended".into(), error: None,
                evidence: Some(json!({"passed": votes >= 2, "wholeFallback": false,
                    "queryBoxes": [[0,0,40,100]], "evidence": [{"matchedReferences": (0..votes).collect::<Vec<_>>()}]})),
            },
        }).collect::<Vec<_>>();
        f.library.finalize_incremental(&tx, &job, &context, &predictions, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        tx.commit().unwrap();
        let saved: String = c.query_row("SELECT classification_id FROM asset_classifications WHERE asset_id='asset-5'", [], |r| r.get(0)).unwrap();
        assert_eq!(saved, parent);
        drop(c);
        assert_eq!(f.library.character_relations_for_asset("asset-5").unwrap().len(), expected);
        if expected == 1 {
            let page = f.library.browse_character_assets(super::super::character_hub::BrowseQuery {
                series_id: f.series.clone(), target_id: Some(a.id.clone()), group_id: None,
                reference_target_id: None, after: None, limit: 100, all: false, series_filter: None,
            }).unwrap();
            assert!(page.items.iter().any(|asset| asset.id == "asset-5"));
            f.library.record_character_decisions(DecisionRequest {
                target_id: a.id.clone(), expected_fingerprint: a.fingerprint,
                asset_ids: vec!["asset-5".into()], decision: DecisionKind::Rejected,
                baseline_fingerprint: None, scan_id: None,
            }).unwrap();
            assert!(f.library.character_relations_for_asset("asset-5").unwrap().is_empty());
        } else {
            assert!(f.library.character_review_pending(&f.series, &a.id).unwrap());
            for target_id in [Some(a.id.clone()), None] {
                let page = f.library.character_review_page(super::super::character_scan::ReviewQuery {
                    series_id: f.series.clone(), target_id, filter: "recommended".into(), after: None, limit: 2,
                }).unwrap();
                assert_eq!(page.rows.iter().map(|row| row.asset.id.as_str()).collect::<Vec<_>>(), vec!["asset-5"]);
            }
        }
    }
}

#[test]
fn arbitration_uses_latest_judgment_and_keeps_ambiguous_people_for_review() {
    use super::super::characters::{DecisionKind, DecisionRequest};
    // strength is the matched-reference count; AUTOMATIC_REFERENCE_SUPPORT decides which
    // values auto-accept. Both people must clear it for the two-person case to confirm.
    for (a_person, b_person, strength, rejected, reaccepted, expected) in [
        (0, 0, 6, false, false, 0),
        (0, 1, 6, false, false, 2),
        (0, 1, 5, false, false, 0),
        (0, 0, 6, true, false, 1),
        (0, 0, 6, true, true, 1),
    ] {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        add_learned_reference(&f, &a.id);
        add_learned_reference(&f, &b.id);
        if rejected {
            for decision in [
                Some(DecisionKind::Rejected),
                reaccepted.then_some(DecisionKind::Accepted),
            ]
            .into_iter()
            .flatten()
            {
                f.library
                    .record_character_decisions(DecisionRequest {
                        target_id: a.id.clone(),
                        expected_fingerprint: a.fingerprint.clone(),
                        asset_ids: vec!["asset-5".into()],
                        decision,
                        baseline_fingerprint: None,
                        scan_id: None,
                    })
                    .unwrap();
            }
        }
        character_autotag::enqueue(
            &f.library.connection().unwrap(),
            "asset-5",
            character_autotag::Cause::Ingestion,
        )
        .unwrap();
        let job = f.library.claim_character_autotag().unwrap().unwrap();
        let mut c = f.library.connection().unwrap();
        let tx = c.transaction().unwrap();
        let context = f
            .library
            .character_autotag_context(&tx, &job, &"a".repeat(64))
            .unwrap();
        let predictions = [(&a, a_person), (&b, b_person)]
            .into_iter()
            .map(|(target, person)| {
                let mut evidence = vec![
                    json!({"matchedReferences":[]}),
                    json!({"matchedReferences":[]}),
                ];
                evidence[person] = json!({"matchedReferences":(0..strength).collect::<Vec<_>>()});
                Prediction {
                    target_id: target.id.clone(),
                    result: ScanResult {
                        asset_id: job.asset_id.clone(),
                        content_hash: job.content_hash.clone(),
                        state: "recommended".into(),
                        error: None,
                        evidence: Some(
                            json!({"passed":true,"wholeFallback":false,"bestQueryCrop":person,
                    "queryBoxes":[[0,0,40,100],[60,0,100,100]],"evidence":evidence}),
                        ),
                    },
                }
            })
            .collect::<Vec<_>>();
        f.library
            .finalize_incremental(
                &tx,
                &job,
                &context,
                &predictions,
                &std::collections::BTreeSet::new(),
                &std::collections::BTreeSet::new(),
            )
            .unwrap();
        tx.commit().unwrap();
        drop(c);
        let relations = f.library.character_relations_for_asset("asset-5").unwrap();
        assert_eq!(relations.len(), expected);
        if reaccepted {
            assert_eq!(relations, vec![a.id]);
        }
    }
}

#[test]
fn reference_image_blocks_only_its_own_target_and_keeps_other_people_for_review() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    add_learned_reference(&f, &a.id);
    add_learned_reference(&f, &b.id);
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    let context = f
        .library
        .character_autotag_context(&tx, &job, &"a".repeat(64))
        .unwrap();
    let predictions = [(&a, 0usize), (&b, 1usize)]
        .into_iter()
        .map(|(target, person)| {
            let mut evidence = vec![
                json!({"matchedReferences": []}),
                json!({"matchedReferences": []}),
            ];
            evidence[person] = json!({"matchedReferences": [0, 1, 2, 3, 4, 5]});
            Prediction {
                target_id: target.id.clone(),
                result: ScanResult {
                    asset_id: job.asset_id.clone(),
                    content_hash: job.content_hash.clone(),
                    state: "recommended".into(),
                    error: None,
                    evidence: Some(json!({
                        "passed": true,
                        "wholeFallback": false,
                        "bestQueryCrop": person,
                        "queryBoxes": [[0,0,40,100],[60,0,100,100]],
                        "evidence": evidence
                    })),
                },
            }
        })
        .collect::<Vec<_>>();
    let reference_targets = std::collections::BTreeSet::from([a.id.clone()]);
    f.library
        .finalize_incremental(
            &tx,
            &job,
            &context,
            &predictions,
            &reference_targets,
            &std::collections::BTreeSet::new(),
        )
        .unwrap();
    tx.commit().unwrap();
    drop(c);

    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![b.id]
    );
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .review_state,
        "partially_resolved"
    );
}

#[test]
fn arbitration_accepts_a_six_vote_region_even_when_best_crop_has_only_two_votes() {
    let f = Fixture::new();
    let a = f.ready("A");
    add_learned_reference(&f, &a.id);
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    let context = f
        .library
        .character_autotag_context(&tx, &job, &"a".repeat(64))
        .unwrap();
    let predictions = vec![Prediction {
        target_id: a.id.clone(),
        result: ScanResult {
            asset_id: job.asset_id.clone(),
            content_hash: job.content_hash.clone(),
            state: "recommended".into(),
            error: None,
            evidence: Some(json!({
                "passed": true,
                "wholeFallback": false,
                "bestQueryCrop": 0,
                "queryBoxes": [[0,0,40,100],[60,0,100,100]],
                "evidence": [
                    {"matchedReferences": [0,1]},
                    {"matchedReferences": [0,1,2,3,4,5]}
                ]
            })),
        },
    }];
    f.library
        .finalize_incremental(
            &tx,
            &job,
            &context,
            &predictions,
            &std::collections::BTreeSet::new(),
            &std::collections::BTreeSet::new(),
        )
        .unwrap();
    tx.commit().unwrap();
    drop(c);

    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![a.id]
    );
}

#[test]
fn manual_decisions_recalculate_cross_series_review_state_from_saved_regions() {
    use super::super::characters::{DecisionKind, DecisionRequest};
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready_in_series("B", &f.child);
    f.library.connection().unwrap().execute(
        "UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='asset-5'",
        [&f.series],
    ).unwrap();
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    let context = f
        .library
        .character_autotag_context(&tx, &job, &"a".repeat(64))
        .unwrap();
    let predictions = [(&a, 0usize), (&b, 1usize)]
        .into_iter()
        .map(|(target, person)| {
            let mut evidence = vec![
                json!({"matchedReferences": []}),
                json!({"matchedReferences": []}),
            ];
            evidence[person] = json!({"matchedReferences": [0, 1]});
            Prediction {
                target_id: target.id.clone(),
                result: ScanResult {
                    asset_id: job.asset_id.clone(),
                    content_hash: job.content_hash.clone(),
                    state: "recommended".into(),
                    error: None,
                    evidence: Some(json!({
                        "passed": true,
                        "wholeFallback": false,
                        "bestQueryCrop": person,
                        "queryBoxes": [[0,0,40,100],[60,0,100,100]],
                        "evidence": evidence
                    })),
                },
            }
        })
        .collect::<Vec<_>>();
    f.library
        .finalize_incremental(
            &tx,
            &job,
            &context,
            &predictions,
            &std::collections::BTreeSet::new(),
            &std::collections::BTreeSet::new(),
        )
        .unwrap();
    tx.commit().unwrap();
    let evidence_id: String = c.query_row("SELECT id FROM character_autotag_evidence WHERE asset_id='asset-5'", [], |r| r.get(0)).unwrap();
    drop(c);
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .review_state,
        "unresolved"
    );

    f.library
        .record_character_decisions(DecisionRequest {
            target_id: a.id.clone(),
            expected_fingerprint: a.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: DecisionKind::Accepted,
            baseline_fingerprint: Some("a".repeat(64)),
            scan_id: Some(evidence_id.clone()),
        })
        .unwrap();
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .review_state,
        "partially_resolved"
    );

    f.library
        .record_character_decisions(DecisionRequest {
            target_id: b.id.clone(),
            expected_fingerprint: b.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: DecisionKind::Accepted,
            baseline_fingerprint: Some("a".repeat(64)),
            scan_id: Some(evidence_id),
        })
        .unwrap();
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .review_state,
        "resolved"
    );
}

#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn explicit_reference_refresh_uses_delta_when_old_evidence_is_reusable() {
    let f = Fixture::new();
    let target = f.ready("A");
    let competitor = f.ready("B");
    let config = config(&f);
    run(&f, &config, "asset-5");
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .review_state,
        "unresolved"
    );

    add_learned_reference(&f, &target.id);
    let current = f.library.get_character_target(&target.id).unwrap();
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, current.revision)
        .unwrap();
    assert_eq!(receipt.eligible_count, 1);
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .compare_incremental_asset(&job, &config, Arc::new(AtomicBool::new(false)))
        .unwrap();

    let c = f.library.connection().unwrap();
    let state: (String,i64) = c.query_row(
        "SELECT state,used_delta FROM character_reference_refresh_items WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
        params![target.id,receipt.request_revision], |row| Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    assert_eq!(state, ("completed".into(), 1));
    let log = std::fs::read_to_string(config.script.with_extension("log")).unwrap();
    assert!(log.lines().any(|line| line == "compare_delta"));
    assert_eq!(
        log.lines().filter(|line| *line == "compare_query").count(),
        2,
        "the unchanged competitor must reuse its validated stored prediction"
    );
    assert_ne!(competitor.id, target.id);
}

#[test]
fn character_reference_refresh_retains_competitor_with_five_remaining_valid_references() {
    let f = Fixture::new();
    let refreshed = f.ready("Refreshed");
    let competitor = f.ready("Competitor");
    add_learned_reference(&f, &competitor.id);
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let original = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE character_autotag_jobs
         SET state='completed',review_state='unresolved',claim_id=NULL
         WHERE asset_id=?1",
            [&original.asset_id],
        )
        .unwrap();
    let receipt = f
        .library
        .request_character_reference_refresh(&refreshed.id, refreshed.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET content_hash='changed-after-claim' WHERE id=?1",
            [format!("learned-{}", competitor.id)],
        )
        .unwrap();
    let c = f.library.connection().unwrap();
    let context = f.library.character_autotag_context(&c, &job, &"a".repeat(64)).unwrap();
    assert_eq!(context.targets.len(), 2);
    let remaining = context.targets.iter().find(|target| target.id == competitor.id).unwrap();
    assert_eq!(remaining.usable_references().count(), 5);
    let item_state: String = c
        .query_row(
            "SELECT state FROM character_reference_refresh_items
         WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
            params![refreshed.id, receipt.request_revision],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(item_state, "processing");
    let request_state: String = c
        .query_row(
            "SELECT state FROM character_reference_refreshes WHERE target_id=?1",
            [&refreshed.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(request_state, "running");
}

#[test]
fn work_status_uses_snapshot_totals_and_the_actual_comparison_target() {
    let f = Fixture::new();
    let target = f.ready("A");
    let c = f.library.connection().unwrap();
    c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
        SELECT 'second','second',media_kind,original_name,'assets/second.png','thumbnails/second.webp',byte_size,width,height,collected_at,status FROM assets WHERE id='asset-5'", []).unwrap();
    c.execute("INSERT INTO asset_classifications VALUES('second',?1)",[&f.series]).unwrap();
    drop(c);
    f.library.request_character_reference_refresh(&target.id,target.revision).unwrap();
    f.library.advance_character_reference_refresh(1).unwrap();
    let job=f.library.claim_character_autotag().unwrap().unwrap();
    {
        let mut engine=f.library.character_incremental.lock().unwrap();
        engine.active=Some(job.asset_id.clone());
        engine.active_series_name=Some("Series".into());
        engine.active_target_name=Some("Competing character".into());
        engine.active_cause=Some("reconsideration".into());
    }
    let status=serde_json::to_value(f.library.character_incremental_status().unwrap()).unwrap();
    assert_eq!(status["activeWork"]["targetName"],"Competing character");
    assert_eq!(status["historyRefreshes"][0]["targetName"],"A");
    assert_eq!(status["historyRefreshes"][0]["total"],2);
    assert_eq!(status["historyRefreshes"][0]["remaining"],2);
    let mut c=f.library.connection().unwrap();
    let tx=c.transaction().unwrap();
    f.library.complete_reference_refresh_item(&tx,&job,&BTreeSet::new(),true,false).unwrap();
    tx.commit().unwrap();
    drop(c);
    let status=serde_json::to_value(f.library.character_incremental_status().unwrap()).unwrap();
    assert_eq!(status["historyRefreshes"][0]["processed"],1);
    assert_eq!(status["historyRefreshes"][0]["remaining"],1);
}
