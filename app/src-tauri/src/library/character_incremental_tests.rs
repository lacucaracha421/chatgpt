use super::super::characters::tests::Fixture;
use super::*;

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
fn run(f: &Fixture, config: &RuntimeConfig, id: &str) {
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        id,
        character_autotag::Cause::Ingestion,
    )
    .unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(job.asset_id, id);
    f.library
        .compare_incremental_asset(&job, config, Arc::new(AtomicBool::new(false)))
        .unwrap();
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
