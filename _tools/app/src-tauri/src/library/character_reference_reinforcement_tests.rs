use super::*;
use crate::library::characters::{tests::Fixture, DecisionKind, DecisionRequest};
use serde_json::json;
use sha2::{Digest, Sha256};

fn prepared() -> (Fixture, Target) {
    let f = Fixture::new();
    let target = f.ready("Reinforced");
    let c = f.library.connection().unwrap();
    c.execute("UPDATE assets SET width=100,height=100,perceptual_hash=zeroblob(32),perceptual_hash_quality=100",[]).unwrap();
    for index in 7..31 {
        let id = format!("asset-{index}");
        let path = format!("assets/{id}.png");
        std::fs::write(f.temp.path().join(&path), id.as_bytes()).unwrap();
        let hash = Sha256::digest(id.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let fp = Sha256::digest(format!("fingerprint-{id}").as_bytes()).to_vec();
        c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status,perceptual_hash,perceptual_hash_quality) VALUES(?1,?2,'image',?1,?3,?3,10,100,100,'now','normal',?4,100)",params![id,hash,path,fp]).unwrap();
        c.execute(
            "INSERT INTO asset_classifications VALUES(?1,?2)",
            params![id, f.series],
        )
        .unwrap();
    }
    c.execute(
        "UPDATE assets SET perceptual_hash=?1 WHERE id='asset-5'",
        [vec![255u8; 32]],
    )
    .unwrap();
    drop(c);
    (f, target)
}

fn reopen(f: Fixture) -> Fixture {
    let Fixture {
        library,
        temp,
        series,
        child,
        outside,
        refs,
    } = f;
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    Fixture {
        library,
        temp,
        series,
        child,
        outside,
        refs,
    }
}

fn accept(f: &Fixture, target: &Target, ids: &[&str], kind: DecisionKind) {
    let current = f.library.get_character_target(&target.id).unwrap();
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: current.id,
            expected_fingerprint: current.fingerprint,
            asset_ids: ids.iter().map(|s| s.to_string()).collect(),
            decision: kind,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
}

fn detection(f: &Fixture, target: &Target, id: &str, boxes: serde_json::Value) {
    let c = f.library.connection().unwrap();
    let (hash, path): (String, String) = c
        .query_row(
            "SELECT content_hash,relative_path FROM assets WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let evidence = format!("detection-{id}");
    c.execute("INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,cause,updated_at) VALUES(?1,1,1,?2,?3,'[]','completed','resolved','ingestion','now')",params![id,hash,path]).unwrap();
    c.execute("INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at) VALUES(?1,?2,1,1,?3,'context','runtime','{}','[]','now')",params![evidence,id,hash]).unwrap();
    c.execute("INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",params![evidence,target.id,f.series,target.fingerprint,json!({"assetId":id,"contentHash":hash,"evidence":{"queryBoxes":boxes}}).to_string()]).unwrap();
}

fn single(f: &Fixture, t: &Target, id: &str) {
    detection(f, t, id, json!([[10, 10, 90, 90]]));
}
fn view(f: &Fixture, t: &Target) -> ReferenceReinforcement {
    f.library.character_reference_reinforcement(&t.id).unwrap()
}

#[test]
fn reinforcement_safe_gates_cached_detection_and_diversity() {
    for gate in [
        "safe",
        "unknown",
        "zero",
        "multiple",
        "whole",
        "invalid",
        "outside",
        "missing_fp",
        "low_quality",
        "near_duplicate",
        "boundary_17",
        "missing_anchor_fp",
        "stale_detection",
        "superseded",
        "stale_manual_hash",
    ] {
        let (f, t) = prepared();
        accept(&f, &t, &["asset-5"], DecisionKind::Accepted);
        match gate {
            "unknown" => {}
            "zero" => detection(&f, &t, "asset-5", json!([])),
            "multiple" => detection(
                &f,
                &t,
                "asset-5",
                json!([[10, 10, 40, 90], [50, 10, 90, 90]]),
            ),
            "whole" => detection(&f, &t, "asset-5", json!([[0, 0, 100, 100]])),
            "invalid" => detection(&f, &t, "asset-5", json!([[10, 10, 5, 90]])),
            "outside" => detection(&f, &t, "asset-5", json!([[10, 10, 900, 90]])),
            _ => single(&f, &t, "asset-5"),
        }
        let c = f.library.connection().unwrap();
        match gate {
            "missing_fp" => {
                c.execute(
                    "UPDATE assets SET perceptual_hash=NULL WHERE id='asset-5'",
                    [],
                )
                .unwrap();
            }
            "low_quality" => {
                c.execute(
                    "UPDATE assets SET perceptual_hash_quality=49 WHERE id='asset-5'",
                    [],
                )
                .unwrap();
            }
            "near_duplicate" | "boundary_17" => {
                let mut fp = vec![0u8; 32];
                fp[0] = 255;
                fp[1] = 255;
                if gate == "boundary_17" {
                    fp[2] = 1;
                }
                c.execute(
                    "UPDATE assets SET perceptual_hash=?1 WHERE id='asset-5'",
                    [fp],
                )
                .unwrap();
            }
            "missing_anchor_fp" => {
                c.execute(
                    "UPDATE assets SET perceptual_hash=NULL WHERE id='asset-0'",
                    [],
                )
                .unwrap();
            }
            "stale_detection" => {
                c.execute("UPDATE character_autotag_jobs SET source_generation=2 WHERE asset_id='asset-5'",[]).unwrap();
            }
            "superseded" => {
                c.execute(
                    "UPDATE character_autotag_jobs SET state='superseded' WHERE asset_id='asset-5'",
                    [],
                )
                .unwrap();
            }
            "stale_manual_hash" => {
                c.execute("UPDATE character_decisions SET asset_hash='old' WHERE target_id=?1 AND source_asset_id='asset-5'",[&t.id]).unwrap();
            }
            _ => {}
        }
        drop(c);
        let candidates = view(&f, &t).ghosts;
        let safe = candidates.iter().any(|r| r.safe);
        assert_eq!(safe, matches!(gate, "safe" | "boundary_17"), "{gate}");
        if gate == "unknown" {
            assert_eq!(candidates[0].persons, None);
        }
        if gate == "safe" {
            assert_eq!(
                candidates[0].region.as_ref().unwrap().bounds,
                [10, 10, 90, 90]
            );
        }
    }
}

#[test]
fn reinforcement_reuses_manual_and_exclusion_gates() {
    for gate in [
        "not_manual",
        "learning_disabled",
        "other_character",
        "reference_removed",
        "excluded_folder",
        "excluded_series_asset",
        "already_reference",
        "same_hash",
    ] {
        let (f, t) = prepared();
        accept(
            &f,
            &t,
            &["asset-5"],
            if gate == "learning_disabled" {
                DecisionKind::AcceptedWrongRegion
            } else {
                DecisionKind::Accepted
            },
        );
        single(&f, &t, "asset-5");
        if gate == "other_character" {
            let other = f.target("Other");
            accept(&f, &other, &["asset-5"], DecisionKind::Accepted);
        }
        let c = f.library.connection().unwrap();
        match gate {
            "not_manual" => {
                c.execute("UPDATE character_decisions SET origin='automatic' WHERE target_id=?1 AND source_asset_id='asset-5'",[&t.id]).unwrap();
            }
            "reference_removed" => {
                c.execute(
                    "INSERT INTO character_reference_exclusions VALUES(?1,'asset-5','now')",
                    [&t.id],
                )
                .unwrap();
            }
            "excluded_folder" => {
                c.execute(
                    "INSERT INTO character_folder_exclusions(classification_id) VALUES(?1)",
                    [&f.series],
                )
                .unwrap();
            }
            "excluded_series_asset" => {
                c.execute("INSERT INTO character_series_asset_exclusions(series_id,asset_id,created_at) VALUES(?1,'asset-5','now')",[&f.series]).unwrap();
            }
            "already_reference" => {
                c.execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) SELECT ?1,id,content_hash,'now' FROM assets WHERE id='asset-5'",[&t.id]).unwrap();
            }
            "same_hash" => {
                c.execute("UPDATE character_references SET asset_hash=(SELECT content_hash FROM assets WHERE id='asset-5') WHERE target_id=?1 AND slot=0",[&t.id]).unwrap();
                assert!(f
                    .library
                    .reference_candidate_pool_in(&c, &t)
                    .unwrap()
                    .is_empty());
            }
            _ => {}
        }
        drop(c);
        assert!(view(&f, &t).ghosts.is_empty(), "{gate}");
        f.library
            .advance_character_reference_reinforcement()
            .unwrap();
        assert!(view(&f, &t).pending_run.is_none(), "{gate}");
    }
}

#[test]
fn reinforcement_adds_four_only_safe_then_undo_and_acknowledge_are_idempotent() {
    let (f, t) = prepared();
    let ids = [
        "asset-7", "asset-8", "asset-9", "asset-10", "asset-11", "asset-12", "asset-13",
    ];
    accept(&f, &t, &ids, DecisionKind::Accepted);
    for id in &ids[..5] {
        single(&f, &t, id);
    }
    detection(&f, &t, "asset-12", json!([[1, 1, 40, 90], [50, 1, 90, 90]]));
    assert!(f
        .library
        .advance_character_reference_reinforcement()
        .unwrap());
    let first = view(&f, &t);
    let run = first.pending_run.unwrap();
    assert_eq!(run.asset_ids.len(), 4);
    assert!(run
        .asset_ids
        .iter()
        .all(|id| ids[..5].contains(&id.as_str())));
    let current = f.library.get_character_target(&t.id).unwrap();
    assert_eq!(current.references.len(), 5);
    assert_eq!(current.learned_references.len(), 4);
    assert!(current
        .learned_references
        .iter()
        .all(|r| r.region.is_some()));
    assert!(!f
        .library
        .advance_character_reference_reinforcement()
        .unwrap());
    assert_eq!(view(&f, &t).pending_run.unwrap().run_id, run.run_id);
    // Add an independent learned reference; undo must preserve it and the base set.
    f.library
        .add_character_learned_references(&t.id, current.revision, &["asset-13".into()])
        .unwrap();
    let undone = f
        .library
        .undo_reference_reinforcement(&t.id, &run.run_id)
        .unwrap();
    assert_eq!(undone.references.len(), 5);
    assert_eq!(undone.learned_references.len(), 1);
    assert_eq!(
        undone.learned_references[0].asset_id.as_deref(),
        Some("asset-13")
    );
    assert!(view(&f, &t)
        .ghosts
        .iter()
        .all(|r| !run.asset_ids.contains(&r.asset_id)));
    assert!(view(&f, &t).pending_run.is_none());
    assert_eq!(
        f.library
            .undo_reference_reinforcement(&t.id, &run.run_id)
            .unwrap()
            .revision,
        undone.revision
    );
    accept(&f, &t, &["asset-14"], DecisionKind::Accepted);
    single(&f, &t, "asset-14");
    assert!(f
        .library
        .advance_character_reference_reinforcement()
        .unwrap());
    let second = view(&f, &t).pending_run.unwrap();
    assert!(second
        .asset_ids
        .iter()
        .all(|id| !run.asset_ids.contains(id)));
    f.library
        .acknowledge_reference_reinforcement(&t.id, &second.run_id)
        .unwrap();
    f.library
        .acknowledge_reference_reinforcement(&t.id, &second.run_id)
        .unwrap();
    assert!(view(&f, &t).pending_run.is_none());
    let f = reopen(f);
    assert!(f
        .library
        .character_reference_reinforcement(&t.id)
        .unwrap()
        .pending_run
        .is_none());
    assert!(f
        .library
        .undo_reference_reinforcement("wrong-target", &second.run_id)
        .is_err());
}

#[test]
fn reinforcement_respects_capacity_and_automation_switches() {
    for gate in [
        "limit_24",
        "limit_25",
        "manual_only",
        "off",
        "series_off",
        "initial_setup",
    ] {
        let (f, t) = prepared();
        accept(
            &f,
            &t,
            &["asset-7", "asset-8", "asset-9", "asset-10"],
            DecisionKind::Accepted,
        );
        for id in ["asset-7", "asset-8", "asset-9", "asset-10"] {
            single(&f, &t, id);
        }
        let c = f.library.connection().unwrap();
        match gate {
            "manual_only" => {
                c.execute(
                    "UPDATE character_targets SET manual_only=1 WHERE id=?1",
                    [&t.id],
                )
                .unwrap();
            }
            "off" => {
                c.execute(
                    "UPDATE character_targets SET enabled=0 WHERE id=?1",
                    [&t.id],
                )
                .unwrap();
            }
            "series_off" => {
                c.execute(
                    "UPDATE character_series SET auto_classify=0 WHERE classification_id=?1",
                    [&f.series],
                )
                .unwrap();
            }
            "initial_setup" => {
                c.execute(
                    "DELETE FROM character_references WHERE target_id=?1",
                    [&t.id],
                )
                .unwrap();
            }
            _ => {
                let n = if gate == "limit_24" { 19 } else { 20 };
                for i in 0..n {
                    let id = format!("asset-{}", i + 11);
                    c.execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) SELECT ?1,id,content_hash,'now' FROM assets WHERE id=?2",params![t.id,id]).unwrap();
                }
            }
        }
        drop(c);
        f.library
            .advance_character_reference_reinforcement()
            .unwrap();
        let state = view(&f, &t);
        assert_eq!(
            state
                .pending_run
                .as_ref()
                .map(|r| r.asset_ids.len())
                .unwrap_or(0),
            if gate == "limit_24" { 1 } else { 0 },
            "{gate}"
        );
        if matches!(gate, "manual_only" | "off" | "series_off" | "initial_setup") {
            assert!(state.ghosts.is_empty());
        }
    }
}

#[test]
fn reinforcement_wire_contract_keeps_unknown_null_and_omits_missing_region() {
    let (f, t) = prepared();
    accept(&f, &t, &["asset-5"], DecisionKind::Accepted);
    let wire = serde_json::to_value(view(&f, &t)).unwrap();
    assert_eq!(wire["pendingRun"], json!(null));
    assert_eq!(wire["ghosts"][0]["persons"], json!(null));
    assert_eq!(wire["ghosts"][0]["safe"], false);
    assert!(wire["ghosts"][0].get("region").is_none());
    assert!(wire["ghosts"][0]["hash"].is_string());
}

#[test]
fn reinforcement_pending_receipt_survives_reopen_and_holds_new_manual_work() {
    let (f, t) = prepared();
    accept(&f, &t, &["asset-7"], DecisionKind::Accepted);
    single(&f, &t, "asset-7");
    f.library
        .advance_character_reference_reinforcement()
        .unwrap();
    let first = view(&f, &t).pending_run.unwrap();
    let f = reopen(f);
    assert_eq!(
        f.library
            .character_reference_reinforcement(&t.id)
            .unwrap()
            .pending_run
            .unwrap()
            .run_id,
        first.run_id
    );
    accept(&f, &t, &["asset-8"], DecisionKind::Accepted);
    single(&f, &t, "asset-8");
    assert!(!f
        .library
        .advance_character_reference_reinforcement()
        .unwrap());
    assert_eq!(view(&f, &t).pending_run.unwrap().asset_ids, ["asset-7"]);
    f.library
        .acknowledge_reference_reinforcement(&t.id, &first.run_id)
        .unwrap();
    assert!(f
        .library
        .advance_character_reference_reinforcement()
        .unwrap());
    assert_eq!(view(&f, &t).pending_run.unwrap().asset_ids, ["asset-8"]);
}

#[test]
fn reinforcement_undo_preserves_a_later_manual_readdition() {
    let (f, t) = prepared();
    accept(&f, &t, &["asset-7", "asset-8"], DecisionKind::Accepted);
    single(&f, &t, "asset-7");
    single(&f, &t, "asset-8");
    f.library
        .advance_character_reference_reinforcement()
        .unwrap();
    let run = view(&f, &t).pending_run.unwrap();
    let current = f.library.get_character_target(&t.id).unwrap();
    let removed = f
        .library
        .exclude_character_reference(&t.id, current.revision, "asset-7")
        .unwrap();
    f.library
        .add_character_learned_references(&t.id, removed.revision, &["asset-7".into()])
        .unwrap();
    // A later user addition has its own creation identity, even for identical content.
    let after = f
        .library
        .undo_reference_reinforcement(&t.id, &run.run_id)
        .unwrap();
    assert_eq!(after.learned_references.len(), 1);
    assert_eq!(
        after.learned_references[0].asset_id.as_deref(),
        Some("asset-7")
    );
    assert!(view(&f, &t).ghosts.iter().all(|r| r.asset_id != "asset-8"));
}

#[test]
fn reinforcement_checks_source_hashes_before_any_reference_or_receipt_write() {
    let (f, t) = prepared();
    accept(&f, &t, &["asset-7"], DecisionKind::Accepted);
    single(&f, &t, "asset-7");
    std::fs::write(
        f.temp.path().join("assets/asset-7.png"),
        b"changed outside the catalog",
    )
    .unwrap();
    assert!(matches!(
        f.library.advance_character_reference_reinforcement(),
        Err(Error::Stale)
    ));
    assert!(view(&f, &t).pending_run.is_none());
    assert!(!f
        .library
        .advance_character_reference_reinforcement()
        .unwrap());
    assert!(f
        .library
        .get_character_target(&t.id)
        .unwrap()
        .learned_references
        .is_empty());
}

#[test]
fn reinforcement_owner_wakes_after_manual_assignment_without_a_model_process() {
    use crate::library::character_worker::RuntimeConfig;
    let (f, t) = prepared();
    single(&f, &t, "asset-7");
    let config = RuntimeConfig {
        performance: crate::performance::Profile::Laptop.budgets(),
        python: f.temp.path().join("no-python"),
        script: f.temp.path().join("no-script"),
        models: f.temp.path().into(),
        augmentation_model: None,
        s36_shadow_disabled: true,
        shadow_model: None,
    };
    struct Stop(Library);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop_character_incremental();
        }
    }
    f.library.start_character_incremental(config);
    let _stop = Stop(f.library.clone());
    let started = std::time::Instant::now();
    while f.library.character_incremental_turns().1 == 0 {
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    f.library
        .move_assets_to_character(t.id.clone(), t.fingerprint.clone(), vec!["asset-7".into()])
        .unwrap();
    let started = std::time::Instant::now();
    while view(&f, &t).pending_run.is_none() {
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(view(&f, &t).pending_run.unwrap().asset_ids, ["asset-7"]);
}

#[test]
fn reinforcement_migration_preserves_history_without_enqueuing_it() {
    let (f, t) = prepared();
    accept(&f, &t, &["asset-7"], DecisionKind::Accepted);
    let c = f.library.connection().unwrap();
    c.execute_batch("DROP TABLE character_reference_reinforcement_queue; DROP TABLE character_reference_reinforcement_runs; PRAGMA user_version=132;").unwrap();
    drop(c);
    let f = reopen(f);
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        133
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_reference_reinforcement_queue",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(c.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE target_id=?1 AND asset_id='asset-7')",[&t.id],|r|r.get::<_,bool>(0)).unwrap());
}
