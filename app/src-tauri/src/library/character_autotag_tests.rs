use super::*;
use crate::library::{
    characters::{tests::Fixture, DecisionKind, DecisionRequest},
    models::SetAssetClassification,
};

fn queue(f: &Fixture, id: &str) -> Job {
    enqueue(&f.library.connection().unwrap(), id, Cause::Ingestion).unwrap();
    f.library.claim_character_autotag().unwrap().unwrap()
}

fn context(f: &Fixture, job: &Job) -> Context {
    f.library
        .character_autotag_context(&f.library.connection().unwrap(), job, &"a".repeat(64))
        .unwrap()
}

fn publish(f: &Fixture, job: &Job, context: &Context, review: ReviewState) -> String {
    let rows = context
        .targets
        .iter()
        .map(|t| Prediction {
            target_id: t.id.clone(),
            result: super::super::character_scan::ScanResult {
                asset_id: job.asset_id.clone(),
                content_hash: job.content_hash.clone(),
                state: "unmatched".into(),
                error: None,
                evidence: Some(
                    json!({"passed":false,"queryBoxes":[[0,0,10,10]],"wholeFallback":false}),
                ),
            },
        })
        .collect::<Vec<_>>();
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    let id = f
        .library
        .publish_character_autotag(&tx, job, context, &rows, review, &json!([]))
        .unwrap();
    tx.commit().unwrap();
    id
}

#[test]
fn native_queue_is_atomic_coalesced_and_noop_does_not_backfill() {
    let f = Fixture::new();
    // A same-folder write on an old covered asset does not invent initial work.
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-5".into()],
            classification_id: Some(f.series.clone()),
        })
        .unwrap();
    assert!(f
        .library
        .character_autotag_job("asset-5")
        .unwrap()
        .is_none());
    {
        let mut c = f.library.connection().unwrap();
        let tx = c.transaction().unwrap();
        enqueue(&tx, "asset-5", Cause::Ingestion).unwrap();
        // Crash/rollback before asset transaction commit must roll queue back too.
    }
    assert!(f
        .library
        .character_autotag_job("asset-5")
        .unwrap()
        .is_none());
    let first = queue(&f, "asset-5");
    assert!(!enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        Cause::Ingestion
    )
    .unwrap());
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-5".into()],
            classification_id: Some(f.child.clone()),
        })
        .unwrap();
    let next = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(next.generation, first.generation + 1);
    assert!(
        Library::check_character_autotag_claim(&f.library.connection().unwrap(), &first).is_err()
    );
}

#[test]
fn recovery_fences_same_generation_late_reply() {
    let f = Fixture::new();
    let old = queue(&f, "asset-5");
    f.library.recover_character_autotag().unwrap();
    let new = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(old.generation, new.generation);
    assert_ne!(old.claim_id, new.claim_id);
    assert!(
        Library::check_character_autotag_claim(&f.library.connection().unwrap(), &old).is_err()
    );
    Library::check_character_autotag_claim(&f.library.connection().unwrap(), &new).unwrap();
}

#[test]
fn restored_image_requeues_without_classification_change() {
    let f = Fixture::new();
    let old = queue(&f, "asset-5");
    f.library.trash_assets(&["asset-5".into()]).unwrap();
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .state,
        "superseded"
    );
    f.library.restore_assets(&["asset-5".into()]).unwrap();
    let new = f.library.claim_character_autotag().unwrap().unwrap();
    assert!(new.source_generation > old.source_generation);
    assert_eq!(new.classification_ids, old.classification_ids);
    assert!(
        Library::check_character_autotag_claim(&f.library.connection().unwrap(), &old).is_err()
    );
}

#[test]
fn automatic_move_preserves_outbox_without_recursive_generation() {
    let f = Fixture::new();
    let old = queue(&f, "asset-5");
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    Library::set_asset_classification_cause_in(
        &tx,
        &SetAssetClassification {
            asset_ids: vec!["asset-5".into()],
            classification_id: Some(f.child.clone()),
        },
        Cause::AutomaticFinalization,
    )
    .unwrap();
    tx.commit().unwrap();
    drop(c);
    assert_eq!(
        f.library
            .character_autotag_job("asset-5")
            .unwrap()
            .unwrap()
            .generation,
        old.generation
    );
    assert!(f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_sync_queue WHERE entity_id='asset-5')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}

#[test]
fn empty_roster_checkpoint_is_reconsidered_when_first_target_is_ready() {
    let f = Fixture::new();
    let job = queue(&f, "asset-5");
    let ctx = context(&f, &job);
    assert!(ctx.targets.is_empty());
    publish(&f, &job, &ctx, ReviewState::AwaitingCandidates);
    f.ready("A");
    assert_eq!(
        f.library
            .reconsider_character_autotag(&f.series, None, 10)
            .unwrap(),
        vec!["asset-5"]
    );
    let retry = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(retry.source_generation, job.source_generation);
    assert_eq!(context(&f, &retry).targets.len(), 1);
}

#[test]
fn losing_predictions_do_not_requeue_a_resolved_image() {
    let f = Fixture::new();
    f.ready("A");
    f.ready("B");
    let job = queue(&f, "asset-5");
    let ctx = context(&f, &job);
    publish(&f, &job, &ctx, ReviewState::Resolved);
    assert!(f
        .library
        .reconsider_character_autotag(&f.series, None, 10)
        .unwrap()
        .is_empty());
    f.library.connection().unwrap().execute("UPDATE character_autotag_jobs SET review_state='partially_resolved' WHERE asset_id='asset-5'",[]).unwrap();
    assert_eq!(
        f.library
            .reconsider_character_autotag(&f.series, None, 10)
            .unwrap(),
        vec!["asset-5"]
    );
}

#[test]
fn changed_competitor_blocks_atomic_publication() {
    let f = Fixture::new();
    f.ready("A");
    let job = queue(&f, "asset-5");
    let ctx = context(&f, &job);
    f.ready("B");
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    assert!(matches!(
        f.library.publish_character_autotag(
            &tx,
            &job,
            &ctx,
            &[],
            ReviewState::Unresolved,
            &json!([])
        ),
        Err(Error::Stale)
    ));
    drop(tx);
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM character_autotag_evidence", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn durable_review_survives_scan_loss_and_learning_reconsideration() {
    let f = Fixture::new();
    let target = f.ready("A");
    let first = queue(&f, "asset-5");
    let ctx = context(&f, &first);
    let id = publish(&f, &first, &ctx, ReviewState::Unresolved);
    *f.library.character_scan.lock().unwrap() = Default::default();
    let page = f
        .library
        .character_review_page(super::super::character_scan::ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "unmatched".into(),
            after: None,
            limit: 60,
        })
        .unwrap();
    assert!(page
        .rows
        .iter()
        .any(|r| r.asset.id == "asset-5" && r.predictions[0].scan_id.as_deref() == Some(&id)));
    // A context-only retry must not invalidate a human's currently displayed source.
    f.library
        .reconsider_character_autotag(&f.series, None, 10)
        .unwrap();
    assert_eq!(
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint,
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: Some("a".repeat(64)),
                scan_id: Some(id.clone())
            })
            .unwrap(),
        1
    );
    f.library.trash_assets(&["asset-5".into()]).unwrap();
    f.library.restore_assets(&["asset-5".into()]).unwrap();
    assert!(
        evidence_row(&f.library.connection().unwrap(), &id, &target.id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn reopening_recovers_claims_and_preserves_published_review() {
    let f = Fixture::new();
    let target = f.ready("A");
    let first = queue(&f, "asset-5");
    let ctx = context(&f, &first);
    let id = publish(&f, &first, &ctx, ReviewState::Unresolved);
    let interrupted = queue(&f, "asset-6");
    let Fixture {
        library,
        temp,
        series,
        ..
    } = f;
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    let recovered = library
        .character_autotag_job(&interrupted.asset_id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered.state, "pending");
    assert_eq!(recovered.generation, interrupted.generation);
    assert!(recovered.claim_id.is_none());
    let page = library
        .character_review_page(super::super::character_scan::ReviewQuery {
            series_id: series,
            target_id: Some(target.id),
            filter: "unmatched".into(),
            after: None,
            limit: 60,
        })
        .unwrap();
    assert!(page
        .rows
        .iter()
        .any(|r| r.asset.id == first.asset_id && r.predictions[0].scan_id.as_deref() == Some(&id)));
}

#[test]
fn consecutive_durable_approvals_preserve_used_reference_snapshot() {
    let f = Fixture::new();
    let target = f.ready("A");
    // Fixture-only placement; production paths enqueue through classification APIs.
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
            [&f.series],
        )
        .unwrap();
    let first = queue(&f, "asset-5");
    let first_ctx = context(&f, &first);
    let first_id = publish(&f, &first, &first_ctx, ReviewState::Unresolved);
    let second = queue(&f, "asset-6");
    let second_ctx = context(&f, &second);
    let second_id = publish(&f, &second, &second_ctx, ReviewState::Unresolved);
    for (asset, id) in [("asset-5", first_id), ("asset-6", second_id)] {
        assert_eq!(
            f.library
                .record_character_decisions(DecisionRequest {
                    target_id: target.id.clone(),
                    expected_fingerprint: target.fingerprint.clone(),
                    asset_ids: vec![asset.into()],
                    decision: DecisionKind::Accepted,
                    baseline_fingerprint: Some("a".repeat(64)),
                    scan_id: Some(id)
                })
                .unwrap(),
            1
        );
    }
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .learned_references
            .len(),
        2
    );
}

#[test]
fn publication_rollback_does_not_complete_or_expose_evidence() {
    let f = Fixture::new();
    let job = queue(&f, "asset-5");
    let ctx = context(&f, &job);
    {
        let mut c = f.library.connection().unwrap();
        let tx = c.transaction().unwrap();
        f.library
            .publish_character_autotag(
                &tx,
                &job,
                &ctx,
                &[],
                ReviewState::AwaitingCandidates,
                &json!([]),
            )
            .unwrap();
        // Simulate finalization failure after publication and before commit.
    }
    assert_eq!(
        f.library
            .character_autotag_job(&job.asset_id)
            .unwrap()
            .unwrap()
            .state,
        "processing"
    );
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
fn closest_registered_series_excludes_registered_ancestors() {
    let f = Fixture::new();
    let own = f.ready("Own series");
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
    let ancestor = f
        .library
        .save_character_target(super::super::characters::TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(root),
            linked_classification_id: None,
            display_name: "Ancestor".into(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: true,
        })
        .unwrap();
    f.library
        .replace_character_references(&ancestor.id, ancestor.revision, &f.refs)
        .unwrap();
    let job = queue(&f, "asset-5");
    let ctx = context(&f, &job);
    assert_eq!(
        ctx.targets
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec![own.id.as_str()]
    );
    f.library
        .save_character_series(super::super::character_hub::Series {
            classification_id: f.series.clone(),
            hero_asset_id: None,
            auto_classify: false,
        })
        .unwrap();
    assert!(context(&f, &job).targets.is_empty());
}


#[test]
fn completed_manual_scan_enrolls_old_images_without_overwriting_work_or_decisions() {
    use std::sync::atomic::AtomicBool;
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    let cancel = AtomicBool::new(false);
    let ids = vec!["asset-5".into(), "asset-6".into()];
    f.library.save_character_series(super::super::character_hub::Series {
        classification_id: f.series.clone(), hero_asset_id: None, auto_classify: false,
    }).unwrap();
    assert_eq!(f.library.queue_analyzed_character_assets(&a, &ids, &cancel).unwrap(), 0);
    f.library.save_character_series(super::super::character_hub::Series {
        classification_id: f.series.clone(), hero_asset_id: None, auto_classify: true,
    }).unwrap();
    assert_eq!(f.library.queue_analyzed_character_assets(&a, &ids, &AtomicBool::new(true)).unwrap(), 0);
    assert!(f.library.character_autotag_job("asset-5").unwrap().is_none());
    f.library.record_character_decisions(DecisionRequest {
        target_id: a.id.clone(), expected_fingerprint: a.fingerprint.clone(), asset_ids: vec!["asset-5".into()],
        decision: DecisionKind::Rejected, baseline_fingerprint: None, scan_id: None,
    }).unwrap();
    assert_eq!(f.library.queue_analyzed_character_assets(&a, &ids, &cancel).unwrap(), 1);
    assert!(f.library.character_autotag_job("asset-6").unwrap().is_none());
    assert_eq!(f.library.queue_analyzed_character_assets(&a, &ids, &cancel).unwrap(), 0);
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(f.library.queue_analyzed_character_assets(&a, &ids, &cancel).unwrap(), 0);
    let preserved = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(preserved.generation, job.generation);
    assert_eq!(preserved.claim_id, job.claim_id);
    let ctx = context(&f, &job);
    assert!(ctx.targets.iter().any(|target| target.id == b.id));
    assert!(f.library.character_relations_for_asset("asset-5").unwrap().is_empty());
    let decision: String = f.library.connection().unwrap().query_row(
        "SELECT decision FROM character_decisions WHERE target_id=?1 AND source_asset_id='asset-5' ORDER BY sequence DESC LIMIT 1",
        [&a.id], |row| row.get(0)).unwrap();
    assert_eq!(decision, "rejected");
    let mut stale = a.clone(); stale.fingerprint = "stale".into();
    assert!(matches!(f.library.queue_analyzed_character_assets(&stale, &ids, &cancel), Err(Error::Stale)));
}

#[test]
fn failed_jobs_can_be_reconsidered_and_explicitly_retried() {
    let f=Fixture::new(); let _target=f.ready("A");
    let job=queue(&f,"asset-5");
    f.library.connection().unwrap().execute("UPDATE character_autotag_jobs SET state='failed',review_state='failed',attempts=3,claim_id=NULL WHERE asset_id=?1",[&job.asset_id]).unwrap();
    assert_eq!(f.library.reconsider_character_autotag(&f.series,None,200).unwrap(),vec!["asset-5"]);
    let retried=f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(retried.state,"pending"); assert_eq!(retried.attempts,0);
    f.library.connection().unwrap().execute("UPDATE character_autotag_jobs SET state='failed',review_state='failed' WHERE asset_id='asset-5'",[]).unwrap();
    assert_eq!(f.library.retry_failed_character_assets(f.series.clone()).unwrap(),1);
    assert_eq!(f.library.retry_failed_character_assets(f.series.clone()).unwrap(),0);
}
