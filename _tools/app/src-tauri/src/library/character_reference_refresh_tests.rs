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

fn historical_images(f: &Fixture, count: usize) {
    let mut c = f.library.connection().unwrap();
    let tx = c.transaction().unwrap();
    for index in 0..count {
        let id = format!("history-{index:04}");
        tx.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES(?1,?1,'image',?1,?2,?2,7,1,1,'2020-01-01','normal')", params![id,format!("assets/{id}.png")]).unwrap();
        tx.execute("INSERT INTO asset_classifications(asset_id,classification_id) VALUES(?1,?2)", params![id,f.series]).unwrap();
    }
    tx.commit().unwrap();
}

#[test]
fn full_refresh_snapshots_700_images_without_history_and_feeds_only_a_batch() {
    let f = Fixture::new();
    let target = f.ready("A");
    // Five registered references are not unclassified; move the remaining fixture image away.
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'", [&f.outside]).unwrap();
    historical_images(&f, 700);
    let start = std::time::Instant::now();
    let receipt = f.library.request_character_reference_refresh(&target.id, target.revision).unwrap();
    eprintln!("700-image metadata snapshot: {:?}", start.elapsed());
    assert_eq!(receipt.eligible_count, 700);
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM character_reference_refresh_items WHERE state='pending'", [], |r| r.get::<_,i64>(0)).unwrap(), 700);
    drop(c);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(), 32);
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM character_autotag_jobs WHERE cause='reconsideration' AND state='pending'", [], |r| r.get::<_,i64>(0)).unwrap(), 32);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM character_reference_refresh_items WHERE state='pending'", [], |r| r.get::<_,i64>(0)).unwrap(), 668);
    drop(c);
    let mut seen = BTreeSet::new();
    loop {
        while let Some(job) = f.library.claim_character_autotag().unwrap() {
            assert!(seen.insert(job.asset_id.clone()), "duplicate work");
            let mut c = f.library.connection().unwrap();
            let tx = c.transaction().unwrap();
            f.library.complete_reference_refresh_item(&tx, &job, &BTreeSet::new(), true, false).unwrap();
            tx.execute("UPDATE character_autotag_jobs SET state='completed',claim_id=NULL WHERE asset_id=?1", [&job.asset_id]).unwrap();
            tx.commit().unwrap();
        }
        if f.library.advance_character_reference_refresh(32).unwrap() == 0 { break; }
    }
    assert_eq!(seen.len(), 700);
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT visited_count FROM character_reference_refreshes WHERE target_id=?1", [&target.id], |r| r.get::<_,i64>(0)).unwrap(),700);
    assert_eq!(c.query_row("SELECT state FROM character_reference_refreshes WHERE target_id=?1", [&target.id], |r| r.get::<_,String>(0)).unwrap(),"completed");
}

fn history_fixture(count: usize) -> (Fixture, crate::library::characters::Target) {
    let f = Fixture::new();
    let target = f.ready("A");
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'", [&f.outside]).unwrap();
    historical_images(&f, count);
    (f, target)
}

#[test]
fn full_refresh_preserves_exclusions_references_manual_choices_and_scope() {
    let (f, target) = history_fixture(10);
    let other = f.target("B");
    for (id, who, decision) in [("history-0003", &other, DecisionKind::Accepted), ("history-0004", &target, DecisionKind::Rejected)] {
        f.library.record_character_decisions(DecisionRequest {
            target_id: who.id.clone(), expected_fingerprint: who.fingerprint.clone(),
            asset_ids: vec![id.into()], decision, baseline_fingerprint: None, scan_id: None,
        }).unwrap();
    }
    let nested = f.library.create_classification(CreateClassification { kind: ClassificationKind::Tag, name: "Nested".into(), parent_id: Some(f.series.clone()) }).unwrap().id;
    f.library.save_character_series(crate::library::character_hub::Series { classification_id: nested.clone(), auto_classify: true, hero_asset_id: None }).unwrap();
    let c = f.library.connection().unwrap();
    c.execute("INSERT INTO character_folder_exclusions VALUES(?1)", [&f.child]).unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='history-0001'", [&f.child]).unwrap();
    c.execute("INSERT INTO character_series_asset_exclusions VALUES(?1,'history-0002','now')", [&f.series]).unwrap();
    c.execute("UPDATE assets SET status='trash' WHERE id='history-0005'", []).unwrap();
    c.execute("UPDATE assets SET media_kind='video' WHERE id='history-0006'", []).unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='history-0007'", [&nested]).unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=(SELECT classification_id FROM classification_roles WHERE role='originals') WHERE asset_id='history-0008'", []).unwrap();
    c.execute("DELETE FROM asset_classifications WHERE asset_id='history-0009'", []).unwrap();
    drop(c);
    let receipt = f.library.request_character_reference_refresh(&target.id, target.revision).unwrap();
    assert_eq!(receipt.eligible_count, 1);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(),1);
    assert_eq!(f.library.claim_character_autotag().unwrap().unwrap().asset_id,"history-0000");
    assert!(f.library.claim_character_autotag().unwrap().is_none());
}

#[test]
fn full_refresh_limits_opted_in_series_to_its_own_subtree() {
    let (f, target) = history_fixture(2);
    let c = f.library.connection().unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='history-0000'", [&f.series]).unwrap();
    c.execute("INSERT INTO character_folder_exclusions VALUES(?1)", [&f.series]).unwrap();
    drop(c);
    assert_eq!(f.library.request_character_reference_refresh(&target.id, target.revision).unwrap().eligible_count, 0);
    let c = f.library.connection().unwrap();
    c.execute("DELETE FROM character_folder_exclusions WHERE classification_id=?1", [&f.series]).unwrap();
    c.execute("UPDATE character_series SET auto_classify=0 WHERE classification_id=?1", [&f.series]).unwrap();
    drop(c);
    assert_eq!(f.library.request_character_reference_refresh(&target.id, target.revision).unwrap().eligible_count, 0);
    let c = f.library.connection().unwrap();
    c.execute("UPDATE character_series SET auto_classify=1 WHERE classification_id=?1", [&f.series]).unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='history-0001'", [&f.child]).unwrap();
    drop(c);
    assert_eq!(f.library.request_character_reference_refresh(&target.id, target.revision).unwrap().eligible_count, 1);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(), 1);
    assert_eq!(f.library.claim_character_autotag().unwrap().unwrap().asset_id, "history-0001");
}

#[test]
fn snapshot_rechecks_exclusions_before_feeding_never_seen_assets() {
    let (f, target) = history_fixture(2);
    assert_eq!(f.library.request_character_reference_refresh(&target.id,target.revision).unwrap().eligible_count,2);
    let c = f.library.connection().unwrap();
    c.execute("INSERT INTO character_series_asset_exclusions VALUES(?1,'history-0000','now')", [&f.series]).unwrap();
    c.execute("UPDATE assets SET status='trash' WHERE id='history-0001'", []).unwrap();
    drop(c);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(),0);
    assert!(f.library.character_autotag_job("history-0000").unwrap().is_none());
    assert!(f.library.character_autotag_job("history-0001").unwrap().is_none());
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(),0);
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT visited_count FROM character_reference_refreshes WHERE target_id=?1",[&target.id],|r|r.get::<_,i64>(0)).unwrap(),2);
}

#[test]
fn full_refresh_snapshot_survives_restart_pause_and_later_arrivals() {
    let (f, target) = history_fixture(2);
    let first = f.library.request_character_reference_refresh(&target.id,target.revision).unwrap();
    f.library.set_character_reference_refresh_paused(true).unwrap();
    let c = f.library.connection().unwrap();
    c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
        SELECT '000-later','000-later',media_kind,original_name,'assets/later.png','thumbnails/later.webp',byte_size,width,height,collected_at,status FROM assets WHERE id='history-0000'", []).unwrap();
    c.execute("INSERT INTO asset_classifications VALUES('000-later',?1)",[&f.series]).unwrap();
    character_autotag::enqueue(&c,"000-later",Cause::Ingestion).unwrap();
    drop(c);
    let root = f.temp.path().to_path_buf();
    drop(f.library);
    let library = Library::open(&root).unwrap();
    let again = library.request_character_reference_refresh(&target.id,target.revision).unwrap();
    assert_eq!(again.request_revision,first.request_revision);
    assert_eq!(again.eligible_count,2);
    assert_eq!(library.advance_character_reference_refresh(32).unwrap(),0);
    let fresh = library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(fresh.asset_id,"000-later");
    library.set_character_reference_refresh_paused(false).unwrap();
    assert_eq!(library.advance_character_reference_refresh(32).unwrap(),2);
    assert_eq!(library.claim_character_autotag().unwrap().unwrap().asset_id,"history-0000");
    assert_eq!(library.claim_character_autotag().unwrap().unwrap().asset_id,"history-0001");
    assert!(library.claim_character_autotag().unwrap().is_none());
}

#[test]
fn legacy_refresh_keeps_its_admission_cursor_without_claiming_a_known_total() {
    let (f,target)=history_fixture(1);
    unresolved(&f,"history-0000");
    f.library.request_character_reference_refresh(&target.id,target.revision).unwrap();
    let c=f.library.connection().unwrap();
    c.execute("DELETE FROM character_reference_refresh_items WHERE target_id=?1",[&target.id]).unwrap();
    c.execute("UPDATE character_reference_refreshes SET eligible_count=0,discovery_complete=0,through_job_sequence=(SELECT MAX(sequence) FROM character_autotag_admissions) WHERE target_id=?1",[&target.id]).unwrap();
    let progress=serde_json::to_value(refresh_progress(&c).unwrap()).unwrap();
    assert!(progress[0]["total"].is_null());
    drop(c);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(),1);
}

#[test]
fn legacy_refresh_cursor_does_not_discover_parent_images() {
    let (f, target) = history_fixture(2);
    unresolved(&f, "history-0000");
    unresolved(&f, "history-0001");
    f.library.request_character_reference_refresh(&target.id, target.revision).unwrap();
    let c = f.library.connection().unwrap();
    c.execute("DELETE FROM character_reference_refresh_items WHERE target_id=?1", [&target.id]).unwrap();
    c.execute("UPDATE character_reference_refreshes SET eligible_count=0,discovery_complete=0,through_job_sequence=(SELECT MAX(sequence) FROM character_autotag_admissions) WHERE target_id=?1", [&target.id]).unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='history-0000'", [&f.series]).unwrap();
    drop(c);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(), 1);
    assert_eq!(f.library.claim_character_autotag().unwrap().unwrap().asset_id, "history-0001");
    let c = f.library.connection().unwrap();
    assert_eq!(c.query_row("SELECT eligible_count FROM character_reference_refreshes WHERE target_id=?1", [&target.id], |r| r.get::<_,i64>(0)).unwrap(), 1);
    assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM character_reference_refresh_items WHERE asset_id='history-0000')", [], |r| r.get::<_,bool>(0)).unwrap());
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
fn explicit_refresh_excludes_parent_sources_and_rechecks_before_analysis() {
    let f = Fixture::new();
    let target = f.ready("A");
    let c = f.library.connection().unwrap();
    c.execute("UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='asset-5'", [&f.series]).unwrap();
    drop(c);
    unresolved(&f, "asset-5");
    let receipt = f.library.request_character_reference_refresh(&target.id, target.revision).unwrap();
    assert_eq!(receipt.eligible_count, 0, "ordinary ancestor images belong only to fresh-ingestion inference, not this historical refresh");
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'", [&f.child]).unwrap();
    assert_eq!(f.library.request_character_reference_refresh(&target.id, target.revision).unwrap().eligible_count, 1);
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(), 1);
    let job = f.library.claim_character_autotag().unwrap().unwrap();
    assert!(!f.library.supersede_invalid_reference_refresh_job(&job).unwrap());
    // Also fences parent items already supplied by the former wider-scope implementation.
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='asset-5'", [&f.series]).unwrap();
    assert!(f.library.supersede_invalid_reference_refresh_job(&job).unwrap());
    assert_eq!(f.library.character_autotag_job("asset-5").unwrap().unwrap().state, "superseded");
}

#[test]
fn existing_parent_snapshot_items_are_skipped_before_job_creation() {
    let (f, target) = history_fixture(2);
    f.library.request_character_reference_refresh(&target.id, target.revision).unwrap();
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1) WHERE asset_id='history-0000'", [&f.series]).unwrap();
    assert_eq!(f.library.advance_character_reference_refresh(32).unwrap(), 1);
    assert!(f.library.character_autotag_job("history-0000").unwrap().is_none());
    assert_eq!(f.library.claim_character_autotag().unwrap().unwrap().asset_id, "history-0001");
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
    assert_eq!(receipt.eligible_count, 1);
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
fn refresh_request_snapshots_all_ids_but_feeds_only_one_bounded_page() {
    let (f, target) = history_fixture(3);
    for asset_id in ["history-0000", "history-0001", "history-0002"] {
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
    assert_eq!(receipt.eligible_count, 3);
    assert_eq!(initial_items, 3);

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
    assert_eq!(items, 3);
    assert!(cursor.is_none());
}

#[test]
fn refresh_snapshot_excludes_images_outside_scope_at_request_time() {
    let (f, target) = history_fixture(1);
    unresolved(&f, "history-0000");
    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.connection().unwrap().execute("UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'", [&f.series]).unwrap();
    unresolved(&f, "asset-5");

    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
    );
    let c = f.library.connection().unwrap();
    let late_item: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM character_reference_refresh_items
             WHERE target_id=?1 AND request_revision=?2 AND asset_id='asset-5')",
            params![target.id, receipt.request_revision],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!late_item);
}

#[test]
fn recovery_keeps_snapshot_open_after_an_orphaned_batch_item() {
    let (f, target) = history_fixture(3);
    for asset_id in ["history-0000", "history-0001", "history-0002"] {
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
            "DELETE FROM character_autotag_jobs WHERE asset_id='history-0000'",
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
    let (f, target) = history_fixture(2);
    unresolved(&f, "history-0000");
    unresolved(&f, "history-0001");
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
fn refresh_snapshot_survives_job_deletion_and_does_not_add_later_work() {
    let (f, target) = history_fixture(1);
    unresolved(&f, "history-0000");
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM character_autotag_jobs WHERE asset_id='history-0000'",
            [],
        )
        .unwrap();
    unresolved(&f, "asset-1");
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        1
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
    assert_eq!(receipt.eligible_count, 1);
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
    assert_eq!(second.eligible_count, 1);
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM character_reference_refresh_items WHERE target_id=?1",
            [&target.id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        1
    );
}

#[test]
fn request_with_no_eligible_history_completes_immediately() {
    let (f, target) = history_fixture(0);

    let receipt = f
        .library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();

    assert_eq!(receipt.state, ReferenceRefreshState::Completed);
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
