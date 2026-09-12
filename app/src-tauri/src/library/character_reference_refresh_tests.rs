use super::*;
use crate::library::{
    character_autotag::{self, Cause},
    characters::tests::Fixture,
    characters::{DecisionKind, DecisionRequest, TargetDraft},
    models::{ClassificationKind, CreateClassification},
};
use rusqlite::params;
use sha2::{Digest, Sha256};

fn unresolved(f: &Fixture, asset_id: &str) {
    character_autotag::enqueue(&f.library.connection().unwrap(), asset_id, Cause::Ingestion)
        .unwrap();
    f.library.connection().unwrap().execute(
        "UPDATE character_autotag_jobs SET state='completed',review_state='unresolved',claim_id=NULL WHERE asset_id=?1",
        [asset_id],
    ).unwrap();
}

fn add_extra_reference(f: &Fixture, target: &crate::library::characters::Target) {
    let id = "refresh-reference";
    let hash = Sha256::digest(id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = format!("assets/{id}.png");
    let thumbnail = format!("thumbnails/{id}.webp");
    std::fs::write(f.temp.path().join(&path), id.as_bytes()).unwrap();
    std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
    let c = f.library.connection().unwrap();
    c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status) VALUES(?1,?2,'image',?1,?3,?4,7,1,1,'2026-09-12','normal')",
        params![id,hash,path,thumbnail]).unwrap();
    c.execute(
        "INSERT INTO asset_classifications(asset_id,classification_id) VALUES(?1,?2)",
        params![id, f.series],
    )
    .unwrap();
    drop(c);
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec![id.into()],
            decision: DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    f.library
        .add_character_learned_references(&target.id, target.revision, &[id.into()])
        .unwrap();
}

#[test]
fn references_are_future_only_until_explicit_refresh_snapshots_history() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    add_extra_reference(&f, &target);
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_reference_refreshes",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(c);

    let current = f.library.get_character_target(&target.id).unwrap();
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, current.revision)
        .unwrap();
    assert_eq!(receipt.state, ReferenceRefreshState::Pending);
    assert_eq!(receipt.eligible_count, 0);
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM character_reference_refresh_items WHERE target_id=?1 AND state='processing'", [&target.id], |r| r.get::<_, i64>(0)).unwrap(), 1);
    let generation: i64 = c
        .query_row(
            "SELECT generation FROM character_autotag_jobs WHERE asset_id='asset-5'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let planned: i64 = c.query_row("SELECT generation FROM character_reference_refresh_items WHERE target_id=?1 AND asset_id='asset-5'", [&target.id], |r| r.get(0)).unwrap();
    assert_eq!(planned, generation);
}

#[test]
fn refresh_request_persists_a_cursor_and_discovers_only_one_bounded_page() {
    let f = Fixture::new();
    let target = f.ready("A");
    for asset_id in ["asset-0", "asset-1", "asset-2"] {
        unresolved(&f, asset_id);
    }

    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    let c = f.library.connection().unwrap();
    let initial_items: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM character_reference_refresh_items WHERE target_id=?1",
            [&target.id],
            |row| row.get(0),
        )
        .unwrap();
    drop(c);
    assert_eq!(receipt.eligible_count, 0);
    assert_eq!(initial_items, 0);

    assert_eq!(f.library.advance_character_reference_refresh(2).unwrap(), 2);
    let c = f.library.connection().unwrap();
    let (items, cursor): (i64, Option<String>) = c
        .query_row(
            "SELECT (SELECT COUNT(*) FROM character_reference_refresh_items WHERE target_id=?1),after_asset_id
             FROM character_reference_refreshes WHERE target_id=?1",
            [&target.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(items, 2);
    assert!(cursor.is_some());
}

#[test]
fn refresh_cursor_excludes_jobs_created_after_the_request() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-0");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    unresolved(&f, "asset-1");

    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let c = f.library.connection().unwrap();
    let late_item: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM character_reference_refresh_items
             WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-1')",
            params![target.id, receipt.request_revision],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!late_item);
}

#[test]
fn recovery_keeps_an_incomplete_cursor_open_after_an_orphaned_page_item() {
    let f = Fixture::new();
    let target = f.ready("A");
    for asset_id in ["asset-0", "asset-1", "asset-2"] {
        unresolved(&f, asset_id);
    }
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    assert_eq!(f.library.advance_character_reference_refresh(1).unwrap(), 1);
    f.library
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM character_autotag_jobs WHERE asset_id='asset-0'",
            [],
        )
        .unwrap();

    f.library.recover_character_autotag().unwrap();

    let state: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT state FROM character_reference_refreshes
             WHERE target_id=?1 AND request_revision=?2",
            params![target.id, receipt.request_revision],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "running");
    assert_eq!(f.library.advance_character_reference_refresh(1).unwrap(), 1);
}

#[test]
fn refresh_keeps_earlier_page_failures_when_later_pages_finish() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-0");
    unresolved(&f, "asset-1");
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    assert_eq!(f.library.advance_character_reference_refresh(1).unwrap(), 1);
    let first = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .fail_reference_refresh_item(&first, "first page failed")
        .unwrap();
    assert_eq!(f.library.advance_character_reference_refresh(2).unwrap(), 1);
    let second = f.library.claim_character_autotag().unwrap().unwrap();
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    f.library
        .complete_reference_refresh_item(&tx, &second, &BTreeSet::new(), true, true)
        .unwrap();
    tx.commit().unwrap();
    let state: String = c
        .query_row(
            "SELECT state FROM character_reference_refreshes WHERE target_id=?1",
            [&target.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "failed");
}

#[test]
fn refresh_boundary_survives_deletion_of_the_last_admitted_job() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-0");
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM character_autotag_jobs WHERE asset_id='asset-0'",
            [],
        )
        .unwrap();
    unresolved(&f, "asset-1");
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        0
    );
    assert_eq!(
        f.library
            .character_autotag_job("asset-1")
            .unwrap()
            .unwrap()
            .cause,
        "ingestion"
    );
}

#[test]
fn refresh_scope_uses_nearest_registered_series_and_respects_manual_decisions() {
    let f = Fixture::new();
    let parent = f.ready("Parent");
    unresolved(&f, "asset-5");
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: parent.id.clone(),
            expected_fingerprint: parent.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: DecisionKind::Rejected,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    let current = f.library.get_character_target(&parent.id).unwrap();
    let manual = f
        .library
        .request_character_reference_refresh(&parent.id, current.revision)
        .unwrap();
    assert_eq!(manual.eligible_count, 0);

    f.library
        .record_character_decisions(DecisionRequest {
            target_id: parent.id.clone(),
            expected_fingerprint: parent.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: DecisionKind::Cleared,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    let nested = f
        .library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Tag,
            name: "Nested".into(),
            parent_id: Some(f.series.clone()),
        })
        .unwrap()
        .id;
    let _nested_target = f
        .library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(nested.clone()),
            linked_classification_id: None,
            display_name: "Nested character".into(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: true,
        })
        .unwrap();
    f.library
        .set_asset_classification(crate::library::models::SetAssetClassification {
            asset_ids: vec!["asset-5".into()],
            classification_id: Some(nested),
        })
        .unwrap();
    let current = f.library.get_character_target(&parent.id).unwrap();
    let scoped = f
        .library
        .request_character_reference_refresh(&parent.id, current.revision)
        .unwrap();
    assert_eq!(scoped.eligible_count, 0);
}

#[test]
fn explicit_refresh_feeds_low_priority_generation_without_preempting_fresh_work() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    assert_eq!(receipt.eligible_count, 0);
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-0",
        Cause::Ingestion,
    )
    .unwrap();

    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let refresh_job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(refresh_job.cause, "reconsideration");
    assert_eq!(refresh_job.state, "pending");
    let item_state: String = f.library.connection().unwrap().query_row(
        "SELECT state FROM character_reference_refresh_items WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
        params![target.id, receipt.request_revision], |row| row.get(0),
    ).unwrap();
    assert_eq!(item_state, "processing");

    let first = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(first.asset_id, "asset-0");
    assert_eq!(first.cause, "ingestion");
    let second = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(second.asset_id, "asset-5");
    assert_eq!(second.cause, "reconsideration");
}

#[test]
fn paused_refresh_does_not_claim_already_fed_history_but_keeps_fresh_work_running() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    f.library
        .set_character_reference_refresh_paused(true)
        .unwrap();

    assert!(f.library.claim_character_autotag().unwrap().is_none());

    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-0",
        Cause::Ingestion,
    )
    .unwrap();
    let fresh = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(fresh.asset_id, "asset-0");
    assert_eq!(fresh.cause, "ingestion");
}

#[test]
fn completed_refresh_item_finishes_durable_request_counters() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(job.asset_id, "asset-5");
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    f.library
        .complete_reference_refresh_item(&tx, &job, &std::collections::BTreeSet::new(), true, true)
        .unwrap();
    tx.commit().unwrap();
    drop(c);
    let c = f.library.connection().unwrap();
    let item: String = c.query_row(
        "SELECT state FROM character_reference_refresh_items WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
        params![target.id,receipt.request_revision], |row| row.get(0),
    ).unwrap();
    assert_eq!(item, "completed");
    let status: (String,i64,i64,i64) = c.query_row(
        "SELECT state,visited_count,fallback_count,published_count FROM character_reference_refreshes WHERE target_id=?1",
        [&target.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).unwrap();
    assert_eq!(status, ("completed".into(), 1, 1, 1));
}

#[test]
fn manual_decision_after_feed_supersedes_refresh_before_comparison() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision: DecisionKind::Rejected,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    assert!(f
        .library
        .supersede_invalid_reference_refresh_job(&job)
        .unwrap());
    let current = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(current.state, "superseded");
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT state FROM character_reference_refresh_items WHERE target_id=?1 AND asset_id='asset-5' ORDER BY request_revision DESC LIMIT 1", [&target.id], |row| row.get::<_,String>(0)).unwrap(), "superseded");
}

#[test]
fn terminal_failure_finishes_refresh_item_with_error() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .fail_reference_refresh_item(&job, "metric failed")
        .unwrap();

    let c = f.library.connection().unwrap();
    let item: (String,Option<String>) = c.query_row(
        "SELECT state,error FROM character_reference_refresh_items WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
        params![target.id,receipt.request_revision], |row| Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    assert_eq!(item, ("failed".into(), Some("metric failed".into())));
    let refresh: (String,i64,i64) = c.query_row(
        "SELECT state,visited_count,failure_count FROM character_reference_refreshes WHERE target_id=?1",
        [&target.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(refresh, ("failed".into(), 1, 1));
}

#[test]
fn repeated_request_for_the_same_reference_set_coalesces() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");

    let first = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    let second = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();

    assert_eq!(second.request_revision, first.request_revision);
    assert_eq!(second.eligible_count, 0);
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_reference_refresh_items WHERE target_id=?1",
            [&target.id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        0
    );
}

#[test]
fn request_with_no_eligible_history_completes_on_first_bounded_scan() {
    let f = Fixture::new();
    let target = f.ready("A");

    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();

    assert_eq!(receipt.state, ReferenceRefreshState::Pending);
    assert_eq!(receipt.eligible_count, 0);
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        0
    );
    let state: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT state FROM character_reference_refreshes WHERE target_id=?1",
            [&target.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "completed");
}

#[test]
fn recovery_preserves_the_generation_bound_to_a_processing_refresh_item() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let interrupted = f.library.claim_character_autotag().unwrap().unwrap();

    f.library.recover_character_autotag().unwrap();

    let recovered = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(recovered.asset_id, interrupted.asset_id);
    assert_eq!(recovered.generation, interrupted.generation);
    let item: (String, i64) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT state,generation FROM character_reference_refresh_items
             WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
            params![target.id, receipt.request_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(item, ("processing".into(), interrupted.generation));
}

#[test]
fn recovery_closes_a_refresh_item_if_its_job_already_failed_terminally() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE character_autotag_jobs
         SET state='failed',review_state='failed',claim_id=NULL,error='terminal failure'
         WHERE asset_id=?1 AND generation=?2",
            params![job.asset_id, job.generation],
        )
        .unwrap();

    f.library.recover_character_autotag().unwrap();

    let c = f.library.connection().unwrap();
    let item: (String, Option<String>) = c
        .query_row(
            "SELECT state,error FROM character_reference_refresh_items
         WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
            params![target.id, receipt.request_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(item, ("failed".into(), Some("terminal failure".into())));
    let request: (String, i64, i64) = c
        .query_row(
            "SELECT state,visited_count,failure_count FROM character_reference_refreshes
         WHERE target_id=?1",
            [&target.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(request, ("failed".into(), 1, 1));
}

#[test]
fn newer_request_supersedes_an_in_flight_generation_without_skipping_the_asset() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let first = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let old_job = f.library.claim_character_autotag().unwrap().unwrap();

    add_extra_reference(&f, &target);
    let current = f.library.get_character_target(&target.id).unwrap();
    let second = f
        .library
        .request_character_reference_refresh(&target.id, current.revision)
        .unwrap();

    assert!(second.request_revision > first.request_revision);
    assert!(f
        .library
        .supersede_invalid_reference_refresh_job(&old_job)
        .unwrap());
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let new_job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(new_job.generation, old_job.generation + 1);
    assert_eq!(new_job.state, "pending");
    let states = f
        .library
        .connection()
        .unwrap()
        .prepare(
            "SELECT request_revision,state,generation FROM character_reference_refresh_items
         WHERE target_id=?1 AND asset_id='asset-5' ORDER BY request_revision",
        )
        .unwrap()
        .query_map([&target.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        states,
        vec![
            (
                first.request_revision,
                "superseded".into(),
                old_job.generation
            ),
            (
                second.request_revision,
                "processing".into(),
                new_job.generation
            ),
        ]
    );
}

#[test]
fn manual_work_runs_first_without_skipping_the_pending_refresh_item() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    character_autotag::enqueue(
        &f.library.connection().unwrap(),
        "asset-5",
        Cause::ManualScanEnrollment,
    )
    .unwrap();

    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        0
    );
    let manual = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(manual.cause, "manual_scan");
    let c = f.library.connection().unwrap();
    c.execute(
        "UPDATE character_autotag_jobs
         SET state='completed',review_state='unresolved',claim_id=NULL
         WHERE asset_id=?1 AND generation=?2",
        params![manual.asset_id, manual.generation],
    )
    .unwrap();
    drop(c);

    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let refresh = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(refresh.generation, manual.generation + 1);
    assert_eq!(refresh.cause, "reconsideration");
    let item: (String, i64) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT state,generation FROM character_reference_refresh_items
             WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
            params![target.id, receipt.request_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(item, ("processing".into(), refresh.generation));
}

#[test]
fn delta_reuse_requires_a_strict_unchanged_reference_prefix() {
    let f = Fixture::new();
    let target = f.ready("A");
    unresolved(&f, "asset-5");
    let job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    let old_hashes = ["a", "b", "c", "d", "e"];
    let evidence = serde_json::json!({
        "type": "result",
        "assetId": job.asset_id,
        "baselineFingerprint": crate::library::character_worker::BASELINE,
        "contentHash": job.content_hash,
        "referenceHashes": old_hashes,
        "passed": true,
        "distance": 0.1,
    });
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO character_autotag_evidence(
            id,asset_id,generation,source_generation,content_hash,context_hash,
            runtime_fingerprint,scope_json,unresolved_regions,created_at)
         VALUES('refresh-base',?1,?2,?3,?4,'context','runtime','{}','[]','now')",
        params![
            job.asset_id,
            job.generation,
            job.source_generation,
            job.content_hash
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO character_autotag_predictions(
            evidence_id,target_id,series_id,target_fingerprint,result_json)
         VALUES('refresh-base',?1,?2,?3,?4)",
        params![
            target.id,
            f.series,
            target.fingerprint,
            serde_json::json!({"evidence": evidence}).to_string()
        ],
    )
    .unwrap();
    drop(c);
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let refresh_job = f.library.claim_character_autotag().unwrap().unwrap();
    let c = f.library.connection().unwrap();

    assert!(matches!(
        f.library
            .reference_refresh_evidence_reuse(
                &c,
                &refresh_job,
                &target,
                "runtime",
                &old_hashes.map(str::to_owned),
            )
            .unwrap(),
        Some(ReferenceRefreshEvidenceReuse::Exact(_))
    ));
    c.execute(
        "UPDATE character_autotag_predictions SET target_fingerprint='stale' WHERE evidence_id='refresh-base'",
        [],
    )
    .unwrap();
    assert!(f
        .library
        .reference_refresh_evidence_reuse(
            &c,
            &refresh_job,
            &target,
            "runtime",
            &old_hashes.map(str::to_owned),
        )
        .unwrap()
        .is_none());
    c.execute(
        "UPDATE character_autotag_predictions SET target_fingerprint=?1 WHERE evidence_id='refresh-base'",
        [&target.fingerprint],
    )
    .unwrap();
    assert!(f
        .library
        .reference_refresh_delta_evidence(
            &c,
            &refresh_job,
            &target.id,
            "runtime",
            &["a", "b", "c", "d", "e", "f"].map(str::to_owned),
        )
        .unwrap()
        .is_some());
    assert!(f
        .library
        .reference_refresh_delta_evidence(
            &c,
            &refresh_job,
            &target.id,
            "runtime",
            &["a", "b", "c", "d", "replacement", "f"].map(str::to_owned),
        )
        .unwrap()
        .is_none());
    let item_generation: i64 = c
        .query_row(
            "SELECT generation FROM character_reference_refresh_items
         WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5'",
            params![target.id, receipt.request_revision],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(item_generation, refresh_job.generation);
}
