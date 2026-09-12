use super::*;
use crate::library::{characters::tests::Fixture, models::SetAssetClassification};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn digest(path: &Path) -> String {
    Sha256::digest(fs::read(path).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn seed_prediction(f: &Fixture, target: &Target, scan_id: &str) {
    let input = f.library.current_input(target, "asset-5").unwrap();
    let mut state = f.library.character_scan.lock().unwrap();
    let status = ScanStatus {
        automatic_queued: 0,
        automatic: false,
        id: scan_id.into(),
        target_id: target.id.clone(),
        target_fingerprint: target.fingerprint.clone(),
        runtime_fingerprint: Some("a".repeat(64)),
        state: "completed".into(),
        total: 1,
        completed: 1,
        errors: 0,
        reused: 0,
        cache_hits: 0,
        extractions: 1,
        error: None,
    };
    let rows = BTreeMap::from([(
        input.id.clone(),
        ScanResult {
            asset_id: input.id,
            content_hash: input.hash,
            state: "recommended".into(),
            evidence: Some(
                json!({"passed":true,"distance":0.1,"referenceHashes":target.references.iter().map(|r| &r.asset_hash).collect::<Vec<_>>()}),
            ),
            error: None,
        },
    )]);
    state.previous.insert(target.id.clone(), (status, rows));
}

fn add_review_asset(f: &Fixture, id: &str) -> (String, String) {
    let hash = Sha256::digest(id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = format!("assets/{id}.png");
    let thumbnail = format!("thumbnails/{id}.webp");
    fs::write(f.temp.path().join(&path), id.as_bytes()).unwrap();
    fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
    let connection = f.library.connection().unwrap();
    connection.execute(
        "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status) VALUES(?1,?2,'image',?1,?3,?4,7,1,1,'2026-09-08','normal')",
        params![id, hash, path, thumbnail],
    ).unwrap();
    connection
        .execute(
            "INSERT INTO asset_classifications(asset_id,classification_id) VALUES(?1,?2)",
            params![id, f.series],
        )
        .unwrap();
    (hash, path)
}

fn seed_durable_review(f: &Fixture, target: &Target, asset_id: &str, generation: i64, state: &str) {
    let (hash, path): (String, String) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT content_hash,relative_path FROM assets WHERE id=?1",
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let evidence_id = format!("durable-{asset_id}-{generation}");
    let connection = f.library.connection().unwrap();
    connection.execute(
        "INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at) VALUES(?1,?2,1,?3,?4,?5,'completed','unresolved',1,'ingestion','now') ON CONFLICT(asset_id) DO UPDATE SET generation=excluded.generation,state='completed',review_state='unresolved'",
        params![asset_id, generation, hash, path, serde_json::to_string(&vec![&f.series]).unwrap()],
    ).unwrap();
    connection.execute(
        "INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at) VALUES(?1,?2,?3,1,?4,'context','runtime','{}','[]','now')",
        params![evidence_id, asset_id, generation, hash],
    ).unwrap();
    connection.execute(
        "INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
        params![evidence_id, target.id, f.series, target.fingerprint, serde_json::json!({
            "assetId":asset_id,"contentHash":hash,"state":state,
            "evidence": if matches!(state, "recommended" | "unmatched") { Some(serde_json::json!({"passed": state == "recommended", "distance": 0.1})) } else { None },
            "error":null
        }).to_string()],
    ).unwrap();
}

fn prediction_decision(target: &Target, scan: &str) -> characters::DecisionRequest {
    characters::DecisionRequest {
        target_id: target.id.clone(),
        expected_fingerprint: target.fingerprint.clone(),
        asset_ids: vec!["asset-5".into()],
        decision: characters::DecisionKind::Accepted,
        baseline_fingerprint: Some("a".repeat(64)),
        scan_id: Some(scan.into()),
    }
}

#[test]
fn multi_target_approval_is_atomic_revalidated_and_recoverable() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    seed_prediction(&f, &a, "a");
    seed_prediction(&f, &b, "b");
    let query = |filter: &str| ReviewQuery {
        series_id: f.series.clone(),
        target_id: None,
        filter: filter.into(),
        after: None,
        limit: 60,
    };
    assert_eq!(
        f.library
            .character_review_page(query("multiple"))
            .unwrap()
            .rows
            .len(),
        1
    );
    let mut stale = prediction_decision(&b, "b");
    stale.baseline_fingerprint = Some("bad-runtime".into());
    assert!(f
        .library
        .record_character_decision_batch(vec![prediction_decision(&a, "a"), stale])
        .is_err());
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
    assert_eq!(
        f.library
            .record_character_decision_batch(vec![
                prediction_decision(&a, "a"),
                prediction_decision(&b, "b")
            ])
            .unwrap(),
        2
    );
    assert_eq!(
        f.library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .len(),
        2
    );
    assert!(f
        .library
        .character_review_page(query("recommended"))
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        f.library
            .character_review_page(query("confirmed"))
            .unwrap()
            .rows
            .len(),
        1
    );
    let history = f.library.list_character_decisions(&a.id, None, 10).unwrap();
    let evidence: Value = serde_json::from_str(&history[0].reference_snapshot).unwrap();
    assert_eq!(evidence["scanId"], "a");
    assert_eq!(evidence["prediction"]["distance"], 0.1);
    let snapshot = f.temp.path().join("approved.sqlite");
    f.library.create_cloud_metadata_snapshot(&snapshot).unwrap();
    let mut clear = prediction_decision(&a, "a");
    clear.decision = characters::DecisionKind::Cleared;
    clear.scan_id = None;
    clear.baseline_fingerprint = None;
    f.library.record_character_decisions(clear).unwrap();
    f.library
        .restore_cloud_metadata_snapshot(&snapshot)
        .unwrap();
    assert_eq!(
        f.library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .len(),
        2
    );
    f.library.trash_assets(&["asset-5".into()]).unwrap();
    f.library.empty_trash().unwrap();
    assert!(!f.temp.path().join("assets/asset-5.png").exists());
    assert!(
        f.library.list_character_decisions(&a.id, None, 10).unwrap()[0]
            .asset_id
            .is_none()
    );
}

#[test]
fn approval_rejects_actual_bytes_changed_after_preview_without_touching_history() {
    let f = Fixture::new();
    let target = f.ready("A");
    seed_prediction(&f, &target, "scan");
    fs::write(f.temp.path().join("assets/asset-0.png"), b"changed ref").unwrap();
    assert!(f
        .library
        .record_character_decisions(prediction_decision(&target, "scan"))
        .is_err());
    fs::write(f.temp.path().join("assets/asset-0.png"), b"asset-0").unwrap();
    fs::write(f.temp.path().join("assets/asset-5.png"), b"changed query").unwrap();
    assert!(f
        .library
        .record_character_decisions(prediction_decision(&target, "scan"))
        .is_err());
    assert!(f
        .library
        .list_character_decisions(&target.id, None, 10)
        .unwrap()
        .is_empty());
}

fn wait(library: &Library) -> ScanStatus {
    let started = Instant::now();
    loop {
        let status = library.character_scan_status().unwrap();
        if !matches!(status.state.as_str(), "running" | "cancelling") {
            return status;
        }
        assert!(started.elapsed() < Duration::from_secs(180), "{status:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn config(script: PathBuf, models: PathBuf) -> RuntimeConfig {
    RuntimeConfig {
        python: std::env::var_os("LAKOMICS_CHARACTER_TEST_PYTHON")
            .expect("set test Python")
            .into(),
        script,
        models,
    }
}

fn fake(fixture: &Fixture) -> RuntimeConfig {
    let script = fixture.temp.path().join("fake.py");
    fs::write(&script, format!(r#"import json,sys,time
def emit(v): print(json.dumps(v),flush=True)
emit({{"type":"ready","baselineFingerprint":"{BASELINE}","runtimeFingerprint":"a" * 64}})
refs=[]
for line in sys.stdin:
 r=json.loads(line)
 if r['type']=='prepare':
  refs=[i['hash'] for i in r['references']]
  emit({{"type":"prepared","referenceHashes":refs}})
 else:
  time.sleep(.25)
  emit({{"type":"result","assetId":r['assetId'],"contentHash":r['hash'],"referenceHashes":refs,"baselineFingerprint":"{BASELINE}","distance":.1,"passed":True}})
"#)).unwrap();
    config(script, fixture.temp.path().into())
}

#[test]
fn stale_result_queries_recheck_scope_and_actual_reference_bytes() {
    let f = Fixture::new();
    let target = f.ready("test");
    {
        let mut state = f.library.character_scan.lock().unwrap();
        state.status = Some(ScanStatus {
            automatic_queued: 0,
            automatic: false,
            id: "scan".into(),
            target_id: target.id.clone(),
            target_fingerprint: target.fingerprint.clone(),
            runtime_fingerprint: Some("a".repeat(64)),
            state: "completed".into(),
            total: 1,
            completed: 1,
            errors: 0,
            reused: 0,
            cache_hits: 0,
            extractions: 0,
            error: None,
        });
        let input = f.library.current_input(&target, "asset-5").unwrap();
        state.results.insert(
            input.id.clone(),
            ScanResult {
                asset_id: input.id,
                content_hash: input.hash,
                state: "recommended".into(),
                evidence: Some(json!({"passed":true})),
                error: None,
            },
        );
    }
    assert_eq!(
        f.library.character_scan_results("scan", None, 10).unwrap()[0].state,
        "recommended"
    );
    fs::write(
        f.temp.path().join("assets/asset-0.png"),
        b"changed reference",
    )
    .unwrap();
    assert_eq!(
        f.library.character_scan_results("scan", None, 10).unwrap()[0].state,
        "stale"
    );
    fs::write(f.temp.path().join("assets/asset-0.png"), b"asset-0").unwrap();
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-5".into()],
            classification_id: Some(f.outside.clone()),
        })
        .unwrap();
    assert_eq!(
        f.library.character_scan_results("scan", None, 10).unwrap()[0].state,
        "stale"
    );
    assert!(f.library.character_scan_results("old", None, 10).is_err());
}

#[test]
#[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON; TEMP fake protocol worker"]
fn scan_scope_cancel_concurrency_and_target_edit_are_enforced() {
    let f = Fixture::new();
    let target = f.ready("test");
    let configuration = fake(&f);
    let scan = f
        .library
        .start_character_scan(&target.id, &target.fingerprint, configuration.clone())
        .unwrap();
    assert!(f
        .library
        .start_character_scan(&target.id, &target.fingerprint, configuration.clone())
        .is_err());
    let status = wait(&f.library);
    assert_eq!(status.state, "completed", "{status:?}");
    assert_eq!((status.total, status.completed), (1, 1));
    let rows = f
        .library
        .character_scan_results(&scan.id, None, 10)
        .unwrap();
    assert_eq!(rows[0].asset_id, "asset-5");
    assert_eq!(rows[0].state, "recommended");
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
    let other = f.ready("second character");
    f.library
        .start_character_scan(&other.id, &other.fingerprint, configuration.clone())
        .unwrap();
    assert_eq!(wait(&f.library).state, "completed");
    assert_eq!(f.library.character_scan_runs().len(), 2);
    assert_eq!(
        f.library
            .character_scan_results(&scan.id, None, 10)
            .unwrap()[0]
            .state,
        "recommended"
    );
    let scan = f
        .library
        .start_character_scan(&target.id, &target.fingerprint, configuration.clone())
        .unwrap();
    f.library.cancel_character_scan(&scan.id).unwrap();
    assert_eq!(wait(&f.library).state, "cancelled");
    f.library
        .start_character_scan(&target.id, &target.fingerprint, configuration)
        .unwrap();
    f.library
        .replace_character_references(&target.id, target.revision, &[])
        .unwrap();
    assert_eq!(wait(&f.library).state, "stale");
}

#[test]
#[ignore = "real frozen ONNX models and fixture copies; explicit Python environment required"]
fn real_native_scan_cold_warm_incremental_and_ref_replacement_parity() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let f = Fixture::new();
    let fixture = std::env::var_os("LAKOMICS_CHARACTER_TEST_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("TEST_HINA"));
    let mut refs: Vec<_> = fs::read_dir(fixture.join("refs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .collect();
    refs.sort();
    assert_eq!(refs.len(), 5);
    let report = fs::read(fixture.join("verification-fixed-report.json"))
        .ok()
        .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap());
    let frozen_fixture = report.is_some();
    let mut queries: Vec<_> = fs::read_dir(fixture.join("target"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .collect();
    queries.sort();
    let copy = |i: usize, path: &Path| {
        let dest = f.temp.path().join(format!("assets/asset-{i}.png"));
        fs::copy(path, &dest).unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash=?2 WHERE id=?1",
                params![format!("asset-{i}"), digest(&dest)],
            )
            .unwrap();
    };
    for (i, path) in refs.iter().enumerate() {
        copy(i, path);
    }
    copy(5, &queries[0]);
    copy(6, &queries[1]);
    let target = f.ready("Hina");
    let configuration = config(
        root.join("app/character-runtime/scan_worker.py"),
        std::env::var_os("LAKOMICS_CHARACTER_TEST_MODELS")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("TEST_kisaki/_experiment/models")),
    );
    // Probe and persist only in TEMP, leaving the user's runtime settings alone.
    let settings = f.temp.path().join("runtime/settings.json");
    RuntimeConfig::setup(
        configuration.python.clone(),
        configuration.models.clone(),
        configuration.script.clone(),
        &settings,
    )
    .unwrap();
    let saved: RuntimeConfig = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(saved.python, configuration.python);
    assert_eq!(saved.models, configuration.models);
    let before = fs::read(&settings).unwrap();
    assert!(RuntimeConfig::setup(
        configuration.python.clone(),
        f.temp.path().join("missing-models"),
        configuration.script.clone(),
        &settings,
    )
    .is_err());
    assert_eq!(fs::read(&settings).unwrap(), before);
    let first = f
        .library
        .start_character_scan(&target.id, &target.fingerprint, configuration.clone())
        .unwrap();
    let cold = wait(&f.library);
    assert_eq!(cold.state, "completed", "{cold:?}");
    assert_eq!(cold.total, 1);
    if frozen_fixture {
        assert_eq!((cold.extractions, cold.cache_hits), (6, 0));
    }
    let rows = f
        .library
        .character_scan_results(&first.id, None, 10)
        .unwrap();
    let evidence = rows[0].evidence.as_ref().unwrap();
    let distance = evidence["distance"].as_f64().unwrap();
    assert!(distance.is_finite());
    if let Some(ref report) = report {
        let expected = report["scores"][queries[0].file_name().unwrap().to_str().unwrap()]
            ["consensus2"]
            .as_f64()
            .unwrap();
        assert!((distance - expected).abs() <= 1e-6);
    }
    f.library
        .start_character_scan(&target.id, &target.fingerprint, configuration.clone())
        .unwrap();
    let warm = wait(&f.library);
    assert_eq!(warm.state, "completed", "{warm:?}");
    assert_eq!((warm.total, warm.extractions, warm.cache_hits), (0, 0, 0));
    // This corrupt asset sorts BETWEEN the two valid queries. Its decode failure
    // must not prevent the newly added valid query from producing evidence.
    let broken = f.temp.path().join("assets/broken.png");
    fs::write(&broken, b"not an image").unwrap();
    {
        let connection = f.library.connection().unwrap();
        connection.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES('asset-55',?1,'image','broken.png','assets/broken.png','thumbnails/broken.webp',12,1,1,'2026-09-08','normal')",[digest(&broken)]).unwrap();
        connection
            .execute(
                "INSERT INTO asset_classifications VALUES('asset-55',?1)",
                [&f.series],
            )
            .unwrap();
    }
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-6".into()],
            classification_id: Some(f.child.clone()),
        })
        .unwrap();
    let incremental_id = f
        .library
        .start_character_scan(&target.id, &target.fingerprint, configuration.clone())
        .unwrap()
        .id;
    let incremental = wait(&f.library);
    assert_eq!(incremental.state, "completed", "{incremental:?}");
    assert_eq!(incremental.total, 2);
    if frozen_fixture {
        assert_eq!((incremental.extractions, incremental.cache_hits), (1, 5));
    }
    assert_eq!((incremental.completed, incremental.errors), (2, 1));
    let rows = f
        .library
        .character_scan_results(&incremental_id, Some("asset-5"), 10)
        .unwrap();
    let distance2 = rows[1].evidence.as_ref().unwrap()["distance"]
        .as_f64()
        .unwrap();
    assert!(distance2.is_finite());
    if let Some(ref report) = report {
        let expected2 = report["scores"][queries[1].file_name().unwrap().to_str().unwrap()]
            ["consensus2"]
            .as_f64()
            .unwrap();
        assert!((distance2 - expected2).abs() <= 1e-6);
    }
    assert_eq!(rows[0].state, "error");
    assert!(rows[0].error.is_some());
    let replacement = ["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"].map(String::from);
    let target = f
        .library
        .replace_character_references(&target.id, target.revision, &replacement)
        .unwrap();
    f.library
        .start_character_scan(&target.id, &target.fingerprint, configuration)
        .unwrap();
    let changed = wait(&f.library);
    assert_eq!(changed.state, "completed", "{changed:?}");
    assert_eq!(changed.total, 3);
    if frozen_fixture {
        assert_eq!((changed.extractions, changed.cache_hits), (0, 7));
    }
    println!(
        "cold={cold:?}\nwarm={warm:?}\nincremental={incremental:?}\nrefs_replaced={changed:?}"
    );
}

#[test]
fn manual_scan_inputs_respect_series_exclusions() {
    let f = Fixture::new();
    let target = f.ready("A");
    f.library
        .save_character_series(super::super::character_hub::Series {
            classification_id: f.series.clone(),
            hero_asset_id: None,
            auto_classify: true,
        })
        .unwrap();
    f.library
        .set_character_series_asset_excluded(
            super::super::character_workflow::SeriesAssetExclusionRequest {
                series_id: f.series.clone(),
                asset_ids: vec!["asset-5".into()],
                excluded: true,
            },
        )
        .unwrap();
    let inputs = f.library.character_scan_inputs(&target).unwrap();
    assert!(inputs.iter().all(|input| input.id != "asset-5"));
}

#[test]
fn confirmed_images_remain_available_for_other_people_in_the_picture() {
    let f = Fixture::new();
    let a = f.ready("Towa");
    let b = f.ready("Other");
    seed_prediction(&f, &b, "before-confirmation");
    let contains = |target: &Target| {
        f.library
            .character_scan_inputs(target)
            .unwrap()
            .iter()
            .any(|i| i.id == "asset-5")
    };
    let review = |target: &Target| {
        f.library
            .character_review_page(ReviewQuery {
                series_id: f.series.clone(),
                target_id: Some(target.id.clone()),
                filter: "all".into(),
                after: None,
                limit: 60,
            })
            .unwrap()
            .rows
            .iter()
            .any(|r| r.asset.id == "asset-5")
    };
    assert!(contains(&b));
    for origin in ["manual", "automatic"] {
        let mut decision = prediction_decision(&a, "unused");
        decision.scan_id = None;
        decision.baseline_fingerprint = None;
        f.library.record_character_decisions(decision).unwrap();
        f.library.connection().unwrap().execute(
            "UPDATE character_decisions SET origin=?1 WHERE target_id=?2 AND decision='accepted'", params![origin, a.id]).unwrap();
        assert!(contains(&a));
        assert!(contains(&b));
        assert!(review(&a));
        assert!(review(&b)); // Another person in the picture may belong to B.
        let mut decision = prediction_decision(&a, "unused");
        decision.scan_id = None;
        decision.baseline_fingerprint = None;
        decision.decision = characters::DecisionKind::Cleared;
        f.library.record_character_decisions(decision).unwrap();
        assert!(contains(&b));
        assert!(review(&b));
    }
}

#[test]
fn series_scan_and_review_exclude_parent_images_and_reject_old_predictions() {
    let f = Fixture::new();
    let target = f.ready("Towa");
    let root: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT parent_id FROM classification_entries WHERE id=?1",
            [&f.series],
            |r| r.get(0),
        )
        .unwrap();
    seed_prediction(&f, &target, "before-move");
    for folder in [&f.series, &f.child, &root, &f.outside] {
        f.library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-5".into()],
                classification_id: Some(folder.clone()),
            })
            .unwrap();
        let expected = folder == &f.series || folder == &f.child;
        assert_eq!(
            f.library
                .character_scan_inputs(&target)
                .unwrap()
                .iter()
                .any(|i| i.id == "asset-5"),
            expected
        );
        let page = f
            .library
            .character_review_page(ReviewQuery {
                series_id: f.series.clone(),
                target_id: Some(target.id.clone()),
                filter: "all".into(),
                after: None,
                limit: 60,
            })
            .unwrap();
        assert_eq!(page.rows.iter().any(|r| r.asset.id == "asset-5"), expected);
        if !expected {
            assert!(f
                .library
                .record_character_decisions(prediction_decision(&target, "before-move"))
                .is_err());
            assert!(f
                .library
                .character_relations_for_asset("asset-5")
                .unwrap()
                .is_empty());
        }
    }
}

fn person_prediction(f: &Fixture, target: &Target, scan: &str, person: usize) {
    seed_prediction(f, target, scan);
    let mut state = f.library.character_scan.lock().unwrap();
    let row = state
        .previous
        .get_mut(&target.id)
        .unwrap()
        .1
        .get_mut("asset-5")
        .unwrap();
    let evidence = row.evidence.as_mut().unwrap();
    evidence["wholeFallback"] = json!(false);
    evidence["bestQueryCrop"] = json!(person);
    evidence["queryBoxes"] = json!([[0, 0, 40, 100], [60, 0, 100, 100]]);
    evidence["evidence"] = json!([
        {"matchedReferences": if person == 0 { vec![0,1,2] } else { vec![] }},
        {"matchedReferences": if person == 1 { vec![0,1,2] } else { vec![] }}
    ]);
}

#[test]
#[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON; TEMP fake protocol worker"]
fn completed_comparisons_survive_restart_and_only_new_images_are_compared() {
    let f = Fixture::new();
    let target = f.ready("Towa");
    let config = fake(&f);
    f.library
        .start_character_scan(&target.id, &target.fingerprint, config.clone())
        .unwrap();
    assert_eq!(wait(&f.library).total, 1);
    // Dropping all recomputable state simulates the next app session.
    *f.library.character_scan.lock().unwrap() = ScanState::default();
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-6".into()],
            classification_id: Some(f.series.clone()),
        })
        .unwrap();
    let scan = f
        .library
        .start_character_scan(&target.id, &target.fingerprint, config.clone())
        .unwrap();
    let status = wait(&f.library);
    assert_eq!(status.state, "completed", "{status:?}");
    assert_eq!((status.total, status.completed, status.reused), (1, 1, 1));
    assert_eq!(
        f.library
            .character_scan_results(&scan.id, None, 10)
            .unwrap()
            .len(),
        2
    );
    // Replacing the anchors invalidates comparisons, even though features remain reusable.
    let updated = f
        .library
        .replace_character_references(
            &target.id,
            target.revision,
            &["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"].map(String::from),
        )
        .unwrap();
    f.library
        .start_character_scan(&updated.id, &updated.fingerprint, config)
        .unwrap();
    let status = wait(&f.library);
    assert_eq!((status.total, status.reused), (2, 0));
}

#[test]
fn overlapping_detector_boxes_are_not_two_distinct_people() {
    assert!(same_person(&[0., 0., 100., 100.], &[10., 10., 90., 90.]));
    assert!(!same_person(&[0., 0., 40., 100.], &[60., 0., 100., 100.]));
}

#[test]
fn manual_snapshot_allows_successive_approvals_without_implicit_learning() {
    let f = Fixture::new();
    let a = f.ready("A");
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-6".into()],
            classification_id: Some(f.series.clone()),
        })
        .unwrap();
    person_prediction(&f, &a, "a", 0);
    let input = f.library.current_input(&a, "asset-6").unwrap();
    {
        let mut state = f.library.character_scan.lock().unwrap();
        let rows = &mut state.previous.get_mut(&a.id).unwrap().1;
        let row = rows.get_mut("asset-5").unwrap();
        row.evidence.as_mut().unwrap()["queryBoxes"] = json!([[0, 0, 40, 100]]);
        row.evidence.as_mut().unwrap()["learnedReferences"] = json!([]);
        let mut second = row.clone();
        second.asset_id = input.id.clone();
        second.content_hash = input.hash;
        rows.insert(input.id, second);
    }
    f.library
        .record_character_decisions(prediction_decision(&a, "a"))
        .unwrap();
    assert!(f
        .library
        .get_character_target(&a.id)
        .unwrap()
        .learned_references
        .is_empty());
    let mut second = prediction_decision(&a, "a");
    second.asset_ids = vec!["asset-6".into()];
    assert_eq!(f.library.record_character_decisions(second).unwrap(), 1);
}

#[test]
fn review_pending_is_advisory_and_approval_still_verifies_source() {
    let f = Fixture::new();
    let target = f.ready("A");
    seed_prediction(&f, &target, "scan");
    assert!(f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    let input = f.library.current_input(&target, "asset-5").unwrap();
    fs::write(f.temp.path().join(input.path), b"changed").unwrap();
    // The badge reads metadata only; it is never authorization to accept stale evidence.
    assert!(f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    assert!(f
        .library
        .record_character_decisions(prediction_decision(&target, "scan"))
        .is_err());
    assert!(f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id),
            filter: "recommended".into(),
            after: None,
            limit: 60,
        })
        .unwrap()
        .rows
        .is_empty());
}

#[test]
fn review_pending_fast_path_reads_durable_predictions_and_latest_decision() {
    let f = Fixture::new();
    let target = f.ready("A");
    let (hash, path): (String, String) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT content_hash,relative_path FROM assets WHERE id='asset-5'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    {
        let connection = f.library.connection().unwrap();
        connection.execute(
            "INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at) VALUES('asset-5',1,1,?1,?2,?3,'completed','unresolved',1,'ingestion','now')",
            params![hash, path, serde_json::to_string(&vec![&f.series]).unwrap()],
        ).unwrap();
        connection.execute(
            "INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at) VALUES('durable-review','asset-5',1,1,?1,'context','runtime','{}','[]','now')",
            [&hash],
        ).unwrap();
        connection.execute(
            "INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES('durable-review',?1,?2,?3,?4)",
            params![target.id, f.series, target.fingerprint, serde_json::json!({
                "assetId":"asset-5","contentHash":hash,"state":"recommended","evidence":null,"error":null
            }).to_string()],
        ).unwrap();
    }
    assert!(f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    assert!(!f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 1,
        })
        .unwrap()
        .rows
        .is_empty());
    f.library
        .record_character_decisions(characters::DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: characters::DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    assert!(!f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    assert!(f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 1,
        })
        .unwrap()
        .rows
        .is_empty());
    f.library
        .record_character_decisions(characters::DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: characters::DecisionKind::Cleared,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    assert!(f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
}

#[test]
fn review_pending_memory_fast_path_preserves_automatic_root_candidates() {
    let f = Fixture::new();
    let target = f.ready("A");
    seed_prediction(&f, &target, "memory-root");
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
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
            [&root],
        )
        .unwrap();
    assert!(!f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    assert!(f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 10,
        })
        .unwrap()
        .rows
        .is_empty());
    f.library
        .character_scan
        .lock()
        .unwrap()
        .previous
        .get_mut(&target.id)
        .unwrap()
        .0
        .automatic = true;
    assert!(f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    let page = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].asset.id, "asset-5");
}

#[test]
fn review_reaches_sparse_matches_beyond_an_input_batch() {
    let f = Fixture::new();
    let target = f.ready("A");
    seed_prediction(&f, &target, "scan");
    {
        let c = f.library.connection().unwrap();
        for index in 0..300 {
            let id = format!("a-{index:04}");
            c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                SELECT ?1,?1,media_kind,original_name,'assets/' || ?1,'thumbnails/' || ?1,byte_size,width,height,collected_at,status FROM assets WHERE id='asset-5'", [&id]).unwrap();
            c.execute(
                "INSERT INTO asset_classifications VALUES(?1,?2)",
                params![id, f.series],
            )
            .unwrap();
        }
    }
    assert!(f
        .library
        .character_review_pending(&f.series, &target.id)
        .unwrap());
    let page = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id),
            filter: "recommended".into(),
            after: None,
            limit: 1,
        })
        .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].asset.id, "asset-5");
}

#[test]
fn recommended_review_merges_memory_and_durable_in_asset_order() {
    let f = Fixture::new();
    let target = f.ready("A");
    add_review_asset(&f, "asset-40");
    add_review_asset(&f, "asset-41");
    seed_durable_review(&f, &target, "asset-40", 1, "recommended");
    seed_durable_review(&f, &target, "asset-41", 1, "recommended");
    seed_durable_review(&f, &target, "asset-5", 1, "recommended");
    seed_prediction(&f, &target, "memory");

    let first = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 2,
        })
        .unwrap();
    assert_eq!(
        first
            .rows
            .iter()
            .map(|row| row.asset.id.as_str())
            .collect::<Vec<_>>(),
        vec!["asset-40", "asset-41"]
    );
    assert!(first.next_cursor.is_some());
    let second = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: first.next_cursor,
            limit: 2,
        })
        .unwrap();
    assert_eq!(
        second
            .rows
            .iter()
            .map(|row| row.asset.id.as_str())
            .collect::<Vec<_>>(),
        vec!["asset-5"]
    );

    let mut state = f.library.character_scan.lock().unwrap();
    let row = state
        .previous
        .get_mut(&target.id)
        .unwrap()
        .1
        .get_mut("asset-5")
        .unwrap();
    row.state = "unmatched".into();
    drop(state);
    let page = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id),
            filter: "recommended".into(),
            after: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.asset.id.as_str())
            .collect::<Vec<_>>(),
        vec!["asset-40", "asset-41"]
    );
}

#[test]
fn recommended_review_uses_latest_durable_prediction_only() {
    let f = Fixture::new();
    let target = f.ready("A");
    seed_durable_review(&f, &target, "asset-5", 1, "recommended");
    seed_durable_review(&f, &target, "asset-5", 2, "unmatched");
    let page = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id),
            filter: "recommended".into(),
            after: None,
            limit: 10,
        })
        .unwrap();
    assert!(page.rows.is_empty());
}

#[test]
fn recommended_review_skips_stale_source_and_keeps_pagination() {
    let f = Fixture::new();
    let target = f.ready("A");
    for id in ["asset-40", "asset-41", "asset-42", "asset-43"] {
        add_review_asset(&f, id);
        seed_durable_review(&f, &target, id, 1, "recommended");
    }
    fs::write(
        f.temp.path().join("assets/asset-40.png"),
        b"changed after prediction",
    )
    .unwrap();
    let first = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 2,
        })
        .unwrap();
    assert_eq!(
        first
            .rows
            .iter()
            .map(|row| row.asset.id.as_str())
            .collect::<Vec<_>>(),
        vec!["asset-41", "asset-42"]
    );
    assert!(first.next_cursor.is_some());
    let second = f
        .library
        .character_review_page(ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id),
            filter: "recommended".into(),
            after: first.next_cursor,
            limit: 2,
        })
        .unwrap();
    assert_eq!(
        second
            .rows
            .iter()
            .map(|row| row.asset.id.as_str())
            .collect::<Vec<_>>(),
        vec!["asset-43"]
    );
    assert!(second.next_cursor.is_none());
}

#[test]
fn review_pending_respects_character_decisions_and_series_scope() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    seed_prediction(&f, &a, "a");
    seed_prediction(&f, &b, "b");
    assert!(!f
        .library
        .character_review_pending(&f.outside, &a.id)
        .unwrap());
    f.library
        .record_character_decisions(prediction_decision(&a, "a"))
        .unwrap();
    assert!(!f
        .library
        .character_review_pending(&f.series, &a.id)
        .unwrap());
    assert!(f
        .library
        .character_review_pending(&f.series, &b.id)
        .unwrap());
}

#[test]
fn review_pending_map_matches_per_character_badges() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    // Unready characters are never badged even when a scan row exists for them.
    let unready = f.target("C");
    seed_prediction(&f, &a, "a");
    seed_prediction(&f, &b, "b");
    seed_prediction(&f, &unready, "c");
    f.library
        .record_character_decisions(prediction_decision(&a, "a"))
        .unwrap();

    let map = f.library.character_review_pending_map().unwrap();
    assert_eq!(map.keys().cloned().collect::<Vec<_>>(), vec![b.id.clone()]);
    assert!(!map.contains_key(&a.id));
    assert!(!map.contains_key(&unready.id));
    for target in [&a, &b, &unready] {
        assert_eq!(
            map.get(&target.id).copied().unwrap_or(false),
            f.library
                .character_review_pending(&f.series, &target.id)
                .unwrap(),
            "batch and single badges must agree for {}",
            target.display_name
        );
    }
}
