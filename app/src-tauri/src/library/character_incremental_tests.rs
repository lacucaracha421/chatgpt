use super::super::characters::tests::Fixture;
use super::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

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
    else:
        if r['type']=='compare_query': assert resident==(r['assetId'],r['hash'])
        emit({'type':'result','assetId':r['assetId'],'contentHash':r['hash'],'baselineFingerprint':baseline,
              'referenceHashes':refs,'passed':True,'distance':0.1,'wholeFallback':False,'bestQueryCrop':0,
              'queryBoxes':[[0,0,10,10]],'evidence':[{'matchedReferences':[0,1,2],'referenceDistances':[0.1]*len(refs)}]})
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
    std::fs::read_to_string(config.script.with_extension("log")).unwrap().lines()
        .filter_map(|line| line.strip_prefix("prepare_paths:"))
        .map(|paths| serde_json::from_str(paths).unwrap()).collect()
}
fn run(f: &Fixture, config: &RuntimeConfig, id: &str) {
    run_with_cause(f, config, id, character_autotag::Cause::Ingestion);
}
fn run_with_cause(f: &Fixture, config: &RuntimeConfig, id: &str, cause: character_autotag::Cause) {
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        id,
        cause,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(job.asset_id, id);
    f.library
        .compare_incremental_asset(&job, config, Arc::new(AtomicBool::new(false)))
        .unwrap();
}

#[test]
fn status_splits_automatic_manual_and_reconsideration_queue_causes() {
    let f = Fixture::new();
    character_autotag::enqueue(&f.library.connection().unwrap(), "asset-0", character_autotag::Cause::Ingestion).unwrap();
    character_autotag::enqueue(&f.library.connection().unwrap(), "asset-5", character_autotag::Cause::ManualScanEnrollment).unwrap();
    character_autotag::enqueue(&f.library.connection().unwrap(), "asset-6", character_autotag::Cause::Reconsideration).unwrap();
    let status = f.library.character_incremental_status().unwrap();
    assert_eq!(status.pending, 3);
    assert_eq!(status.pending_automatic, 1);
    assert_eq!(status.pending_legacy, 0);
    assert_eq!(status.pending_manual, 1);
    assert_eq!(status.pending_reconsideration, 1);
    let automatic = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(automatic.asset_id, "asset-0");
    assert_eq!(automatic.cause, "ingestion");
    let manual = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(manual.cause, "manual_scan");
    let reconsideration = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(reconsideration.cause, "reconsideration");
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
        active_scope_name(&connection, &job, &mixed).unwrap().as_deref(),
        Some("Root · 여러 시리즈")
    );
    let single = Context {
        targets: vec![first],
        ..mixed
    };
    assert_eq!(
        active_scope_name(&connection, &job, &single).unwrap().as_deref(),
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
    assert_eq!(f.library.character_relations_for_asset("asset-5").unwrap(), vec![target.id]);
    assert_eq!(f.library.character_autotag_job("asset-5").unwrap().unwrap().state, "completed");
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
    let paths=prepare_paths(&config);
    assert_eq!(paths.len(),4);
    assert_eq!(paths[0],paths[2],"warm candidates must reuse target A snapshots");
    assert_eq!(paths[1],paths[3],"warm candidates must reuse target B snapshots");
    assert!(f.library.character_incremental.lock().unwrap().prepared_references.is_some());
    f.library.stop_character_scan();
    assert!(f.library.character_incremental.lock().unwrap().prepared_references.is_none());
}

#[test]
#[ignore = "requires explicit test Python; fake protocol worker in TEMP"]
fn anchors_and_explicit_learning_invalidate_prepared_reference_snapshots() {
    let f=Fixture::new(); let mut target=f.ready("A"); let config=config(&f);
    run(&f,&config,"asset-5"); let first=prepare_paths(&config).last().unwrap().clone();
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",[&f.child]).unwrap();
    let mut anchors=f.refs[..4].to_vec(); anchors.push("asset-6".into());
    target=f.library.replace_character_references(&target.id,target.revision,&anchors).unwrap();
    run_with_cause(&f,&config,"asset-5",character_autotag::Cause::Reconsideration);
    let changed_anchors=prepare_paths(&config).last().unwrap().clone(); assert_ne!(first,changed_anchors);
    target=f.library.add_character_learned_references(&target.id,target.revision,&["asset-5".into()]).unwrap();
    run_with_cause(&f,&config,"asset-5",character_autotag::Cause::Reconsideration);
    let with_learning=prepare_paths(&config).last().unwrap().clone(); assert_eq!(with_learning.len(),6); assert_ne!(changed_anchors,with_learning);
    f.library.exclude_character_reference(&target.id,target.revision,"asset-5").unwrap();
    run_with_cause(&f,&config,"asset-5",character_autotag::Cause::Reconsideration);
    let without_learning=prepare_paths(&config).last().unwrap().clone(); assert_eq!(without_learning.len(),5); assert_ne!(with_learning,without_learning);
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
    assert!(f.library.character_incremental.lock().unwrap().prepared_references.is_none());
}

#[test]
#[ignore = "real external fixture and models; explicit environment required"]
fn real_native_incremental_queue_reuses_kisaki_references() {
    let fixture = PathBuf::from(std::env::var_os("LAKOMICS_CHARACTER_TEST_FIXTURE").unwrap());
    let mut refs = std::fs::read_dir(fixture.join("refs")).unwrap()
        .map(|entry| entry.unwrap().path()).filter(|path| path.is_file()).collect::<Vec<_>>();
    let mut queries = std::fs::read_dir(fixture.join("target")).unwrap()
        .map(|entry| entry.unwrap().path()).filter(|path| path.is_file()).collect::<Vec<_>>();
    refs.sort(); queries.sort();
    assert_eq!(refs.len(), 5); assert!(queries.len() >= 2);
    let f = Fixture::new();
    for (index, source) in refs.iter().chain(queries.iter().take(2)).enumerate() {
        let destination = f.temp.path().join(format!("assets/asset-{index}.png"));
        std::fs::copy(source, &destination).unwrap();
        let bytes = std::fs::read(&destination).unwrap();
        let hash = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        f.library.connection().unwrap().execute(
            "UPDATE assets SET content_hash=?2,byte_size=?3 WHERE id=?1",
            params![format!("asset-{index}"), hash, bytes.len() as i64],
        ).unwrap();
    }
    f.library.connection().unwrap().execute(
        "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
        [&f.series],
    ).unwrap();
    let target = f.ready("Kisaki");
    let config = RuntimeConfig {
        python: std::env::var_os("LAKOMICS_CHARACTER_TEST_PYTHON").unwrap().into(),
        script: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../character-runtime/scan_worker.py"),
        models: std::env::var_os("LAKOMICS_CHARACTER_TEST_MODELS").unwrap().into(),
    };
    f.library.start_character_scan(&target.id, &target.fingerprint, config.clone()).unwrap();
    let wait_started = std::time::Instant::now();
    loop {
        let status = f.library.character_scan_status().unwrap();
        assert!(wait_started.elapsed() < Duration::from_secs(60), "{status:?}");
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
    assert!(f.library.character_incremental.lock().unwrap().prepared_references.is_some());
    for id in ["asset-5", "asset-6"] {
        assert_eq!(f.library.character_autotag_job(id).unwrap().unwrap().state, "completed");
    }
    println!("kisaki incremental first={first:?} warm={second:?}");
}

#[test]
fn native_context_events_reconsider_only_recorded_unresolved_assets() {
    let f = Fixture::new();
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    let c = f.library.connection().unwrap();
    c.execute("UPDATE character_autotag_jobs SET state='completed',claim_id=NULL,review_state='awaiting_candidates' WHERE asset_id=?1", [&job.asset_id]).unwrap();
    c.execute("DELETE FROM character_autotag_reconsideration", [])
        .unwrap();
    drop(c);
    f.ready("A");
    f.library.advance_character_reconsideration().unwrap();
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    assert!(f
        .library
        .character_autotag_job("asset-6")
        .unwrap()
        .is_none());
    let c = f.library.connection().unwrap();
    c.execute("DELETE FROM character_autotag_reconsideration", [])
        .unwrap();
    c.execute("UPDATE assets SET status='trash' WHERE id='asset-0'", [])
        .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id=?1",
            [&f.series],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn arbitration_uses_latest_judgment_and_keeps_ambiguous_people_for_review() {
    use super::super::characters::{DecisionKind, DecisionRequest};
    for (a_person, b_person, strength, rejected, reaccepted, expected) in [
        (0,0,3,false,false,0), (0,1,3,false,false,2),
        (0,1,2,false,false,0), (0,0,3,true,false,1),
        (0,0,3,true,true,1),
    ] {
        let f = Fixture::new();
        let a = f.ready("A"); let b = f.ready("B");
        if rejected {
            for decision in [Some(DecisionKind::Rejected), reaccepted.then_some(DecisionKind::Accepted)].into_iter().flatten() {
                f.library.record_character_decisions(DecisionRequest {
                    target_id:a.id.clone(),expected_fingerprint:a.fingerprint.clone(),asset_ids:vec!["asset-5".into()],
                    decision,baseline_fingerprint:None,scan_id:None,
                }).unwrap();
            }
        }
        character_autotag::enqueue(&f.library.connection().unwrap(), "asset-5", character_autotag::Cause::Ingestion).unwrap();
        let job=f.library.claim_character_autotag().unwrap().unwrap();
        let mut c=f.library.connection().unwrap();
        let tx=c.transaction().unwrap();
        let context=f.library.character_autotag_context(&tx,&job,&"a".repeat(64)).unwrap();
        let predictions=[(&a,a_person),(&b,b_person)].into_iter().map(|(target,person)| {
            let mut evidence=vec![json!({"matchedReferences":[]}),json!({"matchedReferences":[]})];
            evidence[person]=json!({"matchedReferences":(0..strength).collect::<Vec<_>>()});
            Prediction {target_id:target.id.clone(),result:ScanResult {
                asset_id:job.asset_id.clone(),content_hash:job.content_hash.clone(),state:"recommended".into(),error:None,
                evidence:Some(json!({"passed":true,"wholeFallback":false,"bestQueryCrop":person,
                    "queryBoxes":[[0,0,40,100],[60,0,100,100]],"evidence":evidence})),
            }}
        }).collect::<Vec<_>>();
        f.library.finalize_incremental(&tx,&job,&context,&predictions,false).unwrap();
        tx.commit().unwrap(); drop(c);
        let relations=f.library.character_relations_for_asset("asset-5").unwrap();
        assert_eq!(relations.len(),expected);
        if reaccepted {assert_eq!(relations,vec![a.id]);}
    }
}
