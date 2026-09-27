use super::*;
use crate::library::character_scan::ReviewQuery;
use crate::library::characters::{
    tests::Fixture, CharacterSettingsDraft, DecisionKind, DecisionRequest, Target, TargetDraft,
};
use rusqlite::OptionalExtension;

pub(in crate::library) fn signals(f: &Fixture, t: &Target, pixai: f64, canary: f64) {
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO character_target_tagger_tags VALUES(?1,'alice')",
        [&t.id],
    )
    .unwrap();
    c.execute(
        "INSERT INTO character_target_tagger_tags VALUES(?1,'alice_costume')",
        [&t.id],
    )
    .unwrap();
    for source in ["pixai", "canary"] {
        for tag in ["alice", "alice_costume"] {
            c.execute(
                "INSERT OR IGNORE INTO tagger_character_vocabulary VALUES(?1,?2)",
                params![source, tag],
            )
            .unwrap();
        }
        for asset in ["asset-5", "asset-6"] {
            c.execute(
                "INSERT OR IGNORE INTO asset_tagger_coverage VALUES(?1,?2)",
                params![asset, source],
            )
            .unwrap();
            let score = if source == "pixai" { pixai } else { canary };
            if score > 0.0 {
                c.execute(
                    "INSERT OR REPLACE INTO asset_tagger_character_scores VALUES(?1,?2,'alice',?3)",
                    params![asset, source, score],
                )
                .unwrap();
            }
        }
    }
}

pub(in crate::library) fn automatic(f: &Fixture, t: &Target) {
    f.library.connection().unwrap().execute(
        "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
         SELECT ?1,id,id,content_hash,'accepted',?2,'{}','automatic','now' FROM assets WHERE id='asset-5'",
        params![t.id,t.fingerprint],
    ).unwrap();
}
fn manual(f: &Fixture, t: &Target, asset: &str, kind: DecisionKind) {
    let t = f.library.get_character_target(&t.id).unwrap();
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: t.id,
            expected_fingerprint: t.fingerprint,
            asset_ids: vec![asset.into()],
            decision: kind,
            scan_id: None,
            baseline_fingerprint: None,
        })
        .unwrap();
}
fn review(f: &Fixture, t: &Target, target: bool) -> serde_json::Value {
    serde_json::to_value(
        f.library
            .character_review_page(ReviewQuery {
                series_id: f.series.clone(),
                target_id: target.then(|| t.id.clone()),
                filter: "recommended".into(),
                after: None,
                limit: 80,
            })
            .unwrap(),
    )
    .unwrap()
}

fn settings(t: &Target, reference_ids: Vec<String>) -> CharacterSettingsDraft {
    CharacterSettingsDraft {
        target: TargetDraft {
            id: Some(t.id.clone()),
            expected_revision: Some(t.revision),
            series_classification_id: t.series_classification_id.clone(),
            linked_classification_id: t.linked_classification_id.clone(),
            display_name: t.display_name.clone(),
            description: t.description.clone(),
            thumbnail_asset_id: t.thumbnail_asset_id.clone(),
            enabled: t.enabled,
        },
        reference_ids,
        reference_regions: Default::default(),
    }
}

fn reference_region(f: &Fixture, t: &Target) {
    f.library.connection().unwrap().execute(
        "INSERT INTO character_reference_regions(target_id,asset_id,asset_hash,baseline_fingerprint,bounds_json)
         SELECT ?1,id,content_hash,'fixture','[0,0,1,1]' FROM assets WHERE id='asset-5'",
        [&t.id],
    ).unwrap();
}

#[test]
fn tagger_veto_clears_only_automatic_membership_and_publishes_review() {
    let f = Fixture::new();
    let t = f.ready("A");
    signals(&f, &t, 0.0, 0.2);
    automatic(&f, &t);
    // Only known automatic provenance authorizes reference removal.
    f.library.connection().unwrap().execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at,provenance) SELECT ?1,id,content_hash,'old','automatic' FROM assets WHERE id='asset-5'",[&t.id]).unwrap();
    reference_region(&f, &t);
    let editor = f.library.get_character_target(&t.id).unwrap();
    let editor_ids = editor
        .references
        .iter()
        .chain(&editor.learned_references)
        .filter_map(|r| r.asset_id.clone())
        .collect::<Vec<_>>();
    let before: i64 = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let p = f.library.preview_tagger_review().unwrap();
    assert_eq!((p.veto.count, p.recommend.count), (1, 0));
    assert_eq!(p.veto.targets[0].sample_asset_ids, vec!["asset-5"]);
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![t.id.clone()],
        "preview is read-only"
    );
    f.library.apply_tagger_review(&p.preview_token).unwrap();
    let after = f.library.get_character_target(&t.id).unwrap();
    assert_eq!(after.revision, editor.revision + 1);
    // Learned reference edits retain the anchor-derived fingerprint, just like
    // exclude_character_reference; revision protects the settings save.
    assert_eq!(after.fingerprint, editor.fingerprint);
    assert!(matches!(
        f.library
            .save_character_settings(settings(&editor, editor_ids), false),
        Err(Error::Stale)
    ));
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM character_reference_regions WHERE target_id=?1 AND asset_id='asset-5'", [&t.id], |r| r.get::<_,i64>(0)).unwrap(), 0);
    let (decision,origin,source):(String,String,String)=c.query_row("SELECT decision,origin,json_extract(reference_snapshot,'$.source') FROM character_decisions ORDER BY sequence DESC LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(
        (decision.as_str(), origin.as_str(), source.as_str()),
        ("cleared", "automatic", "tagger")
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_learned_references WHERE asset_id='asset-5'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-5'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        f.series
    );
    assert!(
        c.query_row(
            "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap()
            > before
    );
    drop(c);
    for target in [true, false] {
        let page = review(&f, &t, target);
        assert_eq!(page["rows"][0]["asset"]["id"], "asset-5");
        assert_eq!(
            page["rows"][0]["predictions"][0]["evidence"]["reason"],
            "veto"
        );
        assert!(page["rows"][0]["predictions"][0]["scanId"].is_null());
    }
    assert!(f
        .library
        .character_review_pending(&f.series, &t.id)
        .unwrap());
    assert_eq!(f.library.preview_tagger_review().unwrap().veto.count, 0);
    let mut c = f.library.connection().unwrap();
    let snapshot =
        crate::cloud::characters::snapshot_from_connection(&mut c, None, &|_| {}).unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    let scope = value["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["nodeId"] == format!("series:{}", f.series) && s["filter"] == "needs_review")
        .unwrap();
    assert!(scope["assetIds"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("asset-5")));
    let scope = value["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["nodeId"] == format!("character:{}", t.id) && s["filter"] == "all")
        .unwrap();
    assert!(!scope["assetIds"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("asset-5")));
    drop(c);
    manual(&f, &t, "asset-5", DecisionKind::Accepted);
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![t.id.clone()]
    );
    assert_eq!(f.library.preview_tagger_review().unwrap().veto.count, 0);
    assert!(!f
        .library
        .character_review_pending(&f.series, &t.id)
        .unwrap());
}

#[test]
fn tagger_veto_requires_both_known_processed_low_and_automatic() {
    for case in [
        "manual",
        "pixai_boundary",
        "canary_boundary",
        "costume",
        "unmapped",
        "unknown",
        "not_processed",
        "reference",
        "trash",
    ] {
        let f = Fixture::new();
        let t = f.ready("A");
        signals(&f, &t, 0.2, 0.2);
        if case == "manual" {
            manual(&f, &t, "asset-5", DecisionKind::Accepted);
        } else {
            automatic(&f, &t);
        }
        let c = f.library.connection().unwrap();
        match case {
            "pixai_boundary" => {
                c.execute(
                    "UPDATE asset_tagger_character_scores SET score=0.3 WHERE source='pixai'",
                    [],
                )
                .unwrap();
            }
            "canary_boundary" => {
                c.execute(
                    "UPDATE asset_tagger_character_scores SET score=0.3 WHERE source='canary'",
                    [],
                )
                .unwrap();
            }
            "costume" => {
                c.execute("INSERT INTO asset_tagger_character_scores VALUES('asset-5','canary','alice_costume',0.9)",[]).unwrap();
            }
            "unmapped" => {
                c.execute("DELETE FROM character_target_tagger_tags", [])
                    .unwrap();
            }
            "unknown" => {
                c.execute(
                    "DELETE FROM tagger_character_vocabulary WHERE source='canary'",
                    [],
                )
                .unwrap();
            }
            "not_processed" => {
                c.execute("DELETE FROM asset_tagger_coverage WHERE asset_id='asset-5' AND source='canary'",[]).unwrap();
            }
            "reference" => {
                c.execute("UPDATE character_references SET asset_id='asset-5',asset_hash=(SELECT content_hash FROM assets WHERE id='asset-5') WHERE target_id=?1 AND slot=0",[&t.id]).unwrap();
            }
            "trash" => {
                c.execute("UPDATE assets SET status='trash' WHERE id='asset-5'", [])
                    .unwrap();
            }
            _ => {}
        };
        drop(c);
        assert_eq!(
            f.library.preview_tagger_review().unwrap().veto.count,
            0,
            "{case}"
        );
    }
}

#[test]
fn tagger_recommendations_are_durable_review_without_decisions_including_outside_series() {
    let f = Fixture::new();
    let t = f.target("No CCIP references needed");
    signals(&f, &t, 0.85, 0.9);
    let p = f.library.preview_tagger_review().unwrap();
    assert_eq!(p.recommend.count, 2);
    f.library.apply_tagger_review(&p.preview_token).unwrap();
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let page = review(&f, &t, true);
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    assert_eq!(
        page["rows"][0]["predictions"][0]["evidence"]["source"],
        "tagger"
    );
    assert_eq!(
        f.library.preview_tagger_review().unwrap().recommend.count,
        0
    );
    assert!(f.library.character_review_pending_map().unwrap()[&t.id]);
    // Raw evidence replacement cannot dismiss an already applied recommendation.
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM asset_tagger_coverage", [])
        .unwrap();
    assert_eq!(review(&f, &t, true)["rows"].as_array().unwrap().len(), 2);
    manual(&f, &t, "asset-5", DecisionKind::Rejected);
    // Existing explicit move-and-accept action handles the outside-series candidate.
    let t = f.library.get_character_target(&t.id).unwrap();
    f.library
        .move_assets_to_character(t.id.clone(), t.fingerprint, vec!["asset-6".into()])
        .unwrap();
    assert_eq!(
        f.library.character_relations_for_asset("asset-6").unwrap(),
        vec![t.id.clone()]
    );
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-6'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        f.series
    );
    assert!(!f
        .library
        .character_review_pending(&f.series, &t.id)
        .unwrap());
}

#[test]
fn tagger_recommendation_never_overrides_any_decision() {
    for kind in [
        DecisionKind::Accepted,
        DecisionKind::Rejected,
        DecisionKind::Cleared,
    ] {
        let f = Fixture::new();
        let t = f.ready("A");
        signals(&f, &t, 0.9, 0.9);
        manual(&f, &t, "asset-5", kind);
        let p = f.library.preview_tagger_review().unwrap();
        assert_eq!(p.recommend.sample_asset_ids, vec!["asset-6"]);
    }
}

#[test]
fn tagger_preview_token_binds_inputs_and_apply_rolls_back_both_sets() {
    let f = Fixture::new();
    let t = f.ready("A");
    signals(&f, &t, 0.2, 0.2);
    automatic(&f, &t);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_tagger_character_scores SET score=0.9 WHERE asset_id='asset-6'",
            [],
        )
        .unwrap();
    let p = f.library.preview_tagger_review().unwrap();
    assert_eq!((p.veto.count, p.recommend.count), (1, 1));
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_tagger_character_scores SET score=0.15 WHERE asset_id='asset-5'",
            [],
        )
        .unwrap();
    assert!(matches!(
        f.library.apply_tagger_review(&p.preview_token),
        Err(Error::Stale)
    ));
    let p = f.library.preview_tagger_review().unwrap();
    // Fault after the veto write must also roll back its decision and membership change.
    f.library.connection().unwrap().execute_batch("CREATE TRIGGER fail_tagger_test BEFORE INSERT ON character_tagger_candidates WHEN NEW.reason='recommendation' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(f.library.apply_tagger_review(&p.preview_token).is_err());
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![t.id.clone()]
    );
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_tagger_candidates",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn tagger_veto_and_recommendations_block_s36_then_manual_reaccept_sticks() {
    use crate::library::{
        character_shadow::{Pending, Policy},
        character_worker::S36Publication,
    };
    for veto in [false, true] {
        let f = Fixture::new();
        let t = f.ready("A");
        signals(
            &f,
            &t,
            if veto { 0.2 } else { 0.9 },
            if veto { 0.2 } else { 0.9 },
        );
        if veto {
            automatic(&f, &t);
        }
        let p = f.library.preview_tagger_review().unwrap();
        f.library.apply_tagger_review(&p.preview_token).unwrap();
        let policy:Policy=serde_json::from_value(serde_json::json!({"version":"test","feature_id":"a".repeat(64),"scorer":"knn3","automatic_max_knn3":0.11,"recommendation_max_knn3":0.13,"automatic_min_prior_manual_rejections":100})).unwrap();
        let hash = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT content_hash FROM assets WHERE id='asset-5'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let pending = Pending {
            asset_id: "asset-5".into(),
            content_hash: hash,
            relative_path: String::new(),
            outcomes: BTreeMap::new(),
            native_at: "now".into(),
        };
        let response = serde_json::json!({"scores":{&t.id:0.01}});
        let mut s36 = S36Publication::default();
        s36.s36_series.insert(f.series.clone());
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &response, 100, &s36)
                .unwrap(),
            0
        );
        manual(&f, &t, "asset-5", DecisionKind::Accepted);
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &response, 100, &s36)
                .unwrap(),
            0
        );
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            vec![t.id.clone()]
        );
    }
}

#[test]
fn tagger_review_can_offer_another_character_on_a_reference_image() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    signals(&f, &b, 0.9, 0.9);
    f.library.connection().unwrap().execute("UPDATE character_references SET asset_id='asset-5',asset_hash=(SELECT content_hash FROM assets WHERE id='asset-5') WHERE target_id=?1 AND slot=0",[&a.id]).unwrap();
    let p = f.library.preview_tagger_review().unwrap();
    assert_eq!(p.recommend.count, 2);
    f.library.apply_tagger_review(&p.preview_token).unwrap();
    let page = review(&f, &b, false);
    assert!(page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["asset"]["id"] == "asset-5"));
}

#[test]
fn tagger_veto_parent_image_can_be_manually_reaccepted_after_broad_scope_is_disabled() {
    let f = Fixture::new();
    let t = f.ready("A");
    signals(&f, &t, 0.2, 0.2);
    let c = f.library.connection().unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='asset-5'",[&f.series]).unwrap();
    c.execute(
        "UPDATE character_autotag_control SET broad_folder_scope=0",
        [],
    )
    .unwrap();
    drop(c);
    automatic(&f, &t);
    let p = f.library.preview_tagger_review().unwrap();
    f.library.apply_tagger_review(&p.preview_token).unwrap();
    manual(&f, &t, "asset-5", DecisionKind::Accepted);
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![t.id]
    );
    assert_eq!(f.library.preview_tagger_review().unwrap().veto.count, 0);
}

#[test]
fn tagger_veto_skips_user_references_without_partial_changes() {
    for path in ["settings", "add_learned", "unknown", "anchor"] {
        let f = Fixture::new();
        let t = f.ready("A");
        signals(&f, &t, 0.2, 0.2);
        automatic(&f, &t);
        match path {
            "settings" => {
                let ids = f.refs.iter().cloned().chain(["asset-5".into()]).collect();
                f.library
                    .save_character_settings(settings(&t, ids), false)
                    .unwrap();
            }
            "add_learned" => {
                f.library
                    .add_character_learned_references(&t.id, t.revision, &["asset-5".into()])
                    .unwrap();
            }
            "unknown" => {
                f.library.connection().unwrap().execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) SELECT ?1,id,content_hash,'old' FROM assets WHERE id='asset-5'", [&t.id]).unwrap();
            }
            "anchor" => {
                let mut ids = f.refs.clone();
                ids[0] = "asset-5".into();
                f.library
                    .replace_character_references(&t.id, t.revision, &ids)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        reference_region(&f, &t);
        let before = f.library.get_character_target(&t.id).unwrap();
        let c = f.library.connection().unwrap();
        let sequence: i64 = c
            .query_row("SELECT MAX(sequence) FROM character_decisions", [], |r| {
                r.get(0)
            })
            .unwrap();
        drop(c);
        let p = f.library.preview_tagger_review().unwrap();
        assert_eq!((p.veto.count, p.skipped_references.count), (0, 1), "{path}");
        assert_eq!(p.skipped_references.targets[0].target_id, t.id);
        assert_eq!(p.skipped_references.sample_asset_ids, vec!["asset-5"]);
        let applied = f.library.apply_tagger_review(&p.preview_token).unwrap();
        assert_eq!(applied.skipped_references.count, 1);
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            vec![t.id.clone()]
        );
        let after = f.library.get_character_target(&t.id).unwrap();
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.references.len(), before.references.len());
        assert_eq!(
            after.learned_references.len(),
            before.learned_references.len()
        );
        let c = f.library.connection().unwrap();
        assert_eq!(
            c.query_row("SELECT MAX(sequence) FROM character_decisions", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            sequence
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM character_tagger_candidates",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(c.query_row("SELECT COUNT(*) FROM character_reference_regions WHERE target_id=?1 AND asset_id='asset-5'", [&t.id], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(
            c.query_row(
                "SELECT origin FROM character_decisions ORDER BY sequence DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "automatic"
        );
    }
}

#[test]
fn tagger_reference_confirmation_protects_existing_automatic_rows_and_invalidates_preview() {
    for path in ["settings", "add_learned", "provenance_only"] {
        let f = Fixture::new();
        let t = f.ready("A");
        signals(&f, &t, 0.2, 0.2);
        automatic(&f, &t);
        let c = f.library.connection().unwrap();
        c.execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at,provenance) SELECT ?1,id,content_hash,'old','automatic' FROM assets WHERE id='asset-5'", [&t.id]).unwrap();
        drop(c);
        let p = f.library.preview_tagger_review().unwrap();
        assert_eq!(p.veto.count, 1);
        match path {
            "settings" => {
                let ids = f.refs.iter().cloned().chain(["asset-5".into()]).collect();
                f.library
                    .save_character_settings(settings(&t, ids), false)
                    .unwrap();
            }
            "add_learned" => {
                f.library
                    .add_character_learned_references(&t.id, t.revision, &["asset-5".into()])
                    .unwrap();
            }
            "provenance_only" => {
                f.library
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE character_learned_references SET provenance='user'",
                        [],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(
            f.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT provenance FROM character_learned_references WHERE target_id=?1",
                    [&t.id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "user"
        );
        if path != "provenance_only" {
            assert!(f.library.get_character_target(&t.id).unwrap().revision > t.revision);
        }
        assert!(
            matches!(
                f.library.apply_tagger_review(&p.preview_token),
                Err(Error::Stale)
            ),
            "{path}"
        );
        let p = f.library.preview_tagger_review().unwrap();
        assert_eq!((p.veto.count, p.skipped_references.count), (0, 1));
    }
}

#[test]
fn tagger_migration_105_protects_all_historical_reference_origins() {
    let (temp, c) = crate::library::characters::tests::historical_character_library(104);
    // A latest automatic decision cannot distinguish the old settings writer
    // from an automatic writer. Missing decisions are likewise ambiguous.
    for (slot, origin) in [(0, Some("manual")), (1, Some("automatic")), (2, None)] {
        let asset = format!("reference-{slot}");
        c.execute("INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) SELECT 'target',id,content_hash,'old' FROM assets WHERE id=?1", [&asset]).unwrap();
        if let Some(origin) = origin {
            c.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at) SELECT 'target',id,id,content_hash,'accepted','fixture','{}',?2,'old' FROM assets WHERE id=?1", params![asset, origin]).unwrap();
        }
    }
    drop(c);
    std::fs::create_dir(temp.path().join("backups")).unwrap();
    let c = crate::library::db::initialize_database(&temp.path().join("library.sqlite")).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        105
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_learned_references WHERE provenance='user'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    assert_eq!(
        c.query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .unwrap(),
        None
    );
}
