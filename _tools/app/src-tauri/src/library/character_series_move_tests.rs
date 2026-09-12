use super::*;
use crate::library::{
    character_autotag::{self, Cause},
    character_groups::GroupDraft,
    character_hub::{BrowseQuery, Series},
    characters::{tests::Fixture, DecisionKind, DecisionRequest, TargetDraft},
};

fn register(f: &Fixture, id: &str) {
    f.library
        .save_character_series(Series {
            classification_id: id.into(),
            hero_asset_id: None,
            auto_classify: true,
        })
        .unwrap();
}
fn decide(f: &Fixture, target: &Target, id: &str, decision: DecisionKind) {
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec![id.into()],
            decision,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
}
fn browse(f: &Fixture, series: &str, target: &str) -> Vec<String> {
    f.library
        .browse_character_assets(BrowseQuery {
            series_id: series.into(),
            target_id: Some(target.into()),
            group_id: None,
            reference_target_id: None,
            after: None,
            limit: 100,
            all: false,
            series_filter: None,
        })
        .unwrap()
        .items
        .into_iter()
        .map(|a| a.id)
        .collect()
}
fn scalar(f: &Fixture, sql: &str) -> i64 {
    f.library
        .connection()
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

fn child_folder(f: &Fixture, parent: &str, name: &str) -> String {
    f.library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Tag,
            name: name.into(),
            parent_id: Some(parent.into()),
        })
        .unwrap()
        .id
}

fn other_in(f: &Fixture, series: &str) -> Target {
    f.library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(series.into()),
            linked_classification_id: None,
            display_name: "Hisabeth".into(),
            enabled: false,
            description: String::new(),
            thumbnail_asset_id: None,
        })
        .unwrap()
}

#[test]
fn sibling_move_keeps_shared_images_visible_in_both_characters_and_groups_without_analysis() {
    for already_at_ancestor in [false, true] {
        let f = Fixture::new();
        register(&f, &f.series);
        register(&f, &f.child);
        let destination = child_folder(&f, &f.series, "Marcus");
        register(&f, &destination);
        let target = f.ready("Marcus");
        decide(&f, &target, "asset-5", DecisionKind::Accepted);
        let other = other_in(&f, &f.child);
        let shared_folder = child_folder(&f, &f.child, "Shared images");
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&f.child],
            )
            .unwrap();
        decide(&f, &other, "asset-5", DecisionKind::Accepted);
        let c = f.library.connection().unwrap();
        if already_at_ancestor {
            c.execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&f.series],
            )
            .unwrap();
        } else {
            c.execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&shared_folder],
            )
            .unwrap();
            character_autotag::enqueue(&c, "asset-5", Cause::Ingestion).unwrap();
            c.execute(
                "INSERT INTO character_folder_exclusions(classification_id) VALUES(?1)",
                [&shared_folder],
            )
            .unwrap();
        }
        drop(c);
        f.library
            .save_character_group(GroupDraft {
                id: None,
                series_id: f.child.clone(),
                expected_revision: None,
                name: "Laplace".into(),
                target_ids: vec![other.id.clone()],
                delete: false,
            })
            .unwrap();
        let group = f.library.character_groups(&f.child).unwrap().remove(0);
        let jobs = scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs");
        let decisions = scalar(&f, "SELECT COUNT(*) FROM character_decisions");
        let preview = f
            .library
            .character_series_move_preview(&target.id, &destination)
            .unwrap();
        assert_eq!(preview.asset_count, 6);
        assert_eq!(
            preview.relocation_count,
            if already_at_ancestor { 5 } else { 6 }
        );
        assert_eq!(preview.shared_locations.len(), 1);
        assert_eq!(preview.shared_locations[0].classification_id, f.series);
        assert_eq!(preview.shared_locations[0].asset_count, 1);
        assert_eq!(
            preview.shared_locations[0].relocation_count,
            usize::from(!already_at_ancestor)
        );
        let moved = f
            .library
            .move_character_to_series(&target.id, &destination, &preview.token)
            .unwrap();
        assert!(moved.ready);
        assert_eq!(
            f.library.get_asset_classifications("asset-5").unwrap()[0].id,
            f.series
        );
        assert_eq!(
            f.library.get_asset_classifications("asset-0").unwrap()[0].id,
            destination
        );
        assert_eq!(browse(&f, &destination, &target.id).len(), 6);
        assert!(browse(&f, &f.child, &other.id).contains(&"asset-5".into()));
        let grouped = f
            .library
            .browse_character_assets(BrowseQuery {
                series_id: f.child.clone(),
                target_id: None,
                group_id: Some(group.id),
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: None,
            })
            .unwrap();
        assert!(grouped.items.iter().any(|a| a.id == "asset-5"));
        assert_eq!(
            scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs"),
            jobs
        );
        assert_eq!(
            scalar(&f, "SELECT COUNT(*) FROM character_reference_refreshes"),
            0
        );
        assert_eq!(
            scalar(&f, "SELECT COUNT(*) FROM character_decisions"),
            decisions
        );
        if !already_at_ancestor {
            let job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
            assert_eq!(job.state, "superseded");
            assert!(job.claim_id.is_none());
            let c = f.library.connection().unwrap();
            assert!(
                super::super::character_hub::series_asset_excluded(&c, &f.series, "asset-5")
                    .unwrap()
            );
            assert!(super::super::character_hub::series_asset_excluded(
                &c,
                &destination,
                "asset-5"
            )
            .unwrap());
        }
    }
}

#[test]
fn sibling_move_rejects_common_ancestor_for_either_characters_reference() {
    for own_reference in [false, true] {
        let f = Fixture::new();
        register(&f, &f.series);
        register(&f, &f.child);
        let destination = child_folder(&f, &f.series, "Marcus");
        register(&f, &destination);
        let target = f.ready("Marcus");
        let other = other_in(&f, &f.child);
        let shared = if own_reference { "asset-0" } else { "asset-5" };
        if !own_reference {
            let c = f.library.connection().unwrap();
            c.execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&f.child],
            )
            .unwrap();
            drop(c);
            f.library
                .replace_character_references(&other.id, other.revision, &[shared.into()])
                .unwrap();
            decide(&f, &target, shared, DecisionKind::Accepted);
        } else {
            decide(&f, &other, shared, DecisionKind::Accepted);
        }
        assert!(matches!(
            f.library
                .character_series_move_preview(&target.id, &destination),
            Err(Error::Invalid(_))
        ));
        assert_eq!(
            f.library.get_asset_classifications(shared).unwrap()[0].id,
            f.child
        );
        assert_eq!(
            f.library.get_character_target(&target.id).unwrap().revision,
            target.revision
        );
    }
}

#[test]
fn move_retains_existing_deeper_folder_for_another_characters_reference() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.child);
    let nested = child_folder(&f, &f.child, "Nested series");
    register(&f, &nested);
    let target = f.ready("Marcus");
    decide(&f, &target, "asset-5", DecisionKind::Accepted);
    let c = f.library.connection().unwrap();
    c.execute(
        "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
        [&nested],
    )
    .unwrap();
    drop(c);
    let other = other_in(&f, &nested);
    let other = f
        .library
        .replace_character_references(&other.id, other.revision, &["asset-5".into()])
        .unwrap();
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.child)
        .unwrap();
    assert_eq!(preview.relocation_count, 0);
    f.library
        .move_character_to_series(&target.id, &f.child, &preview.token)
        .unwrap();
    assert_eq!(
        f.library.get_asset_classifications("asset-5").unwrap()[0].id,
        nested
    );
    let after = f.library.get_character_target(&other.id).unwrap();
    assert_eq!(
        serde_json::to_value(after.references).unwrap(),
        serde_json::to_value(other.references).unwrap()
    );
}

#[test]
fn shared_move_requires_new_preview_after_another_membership_changes() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.child);
    let destination = child_folder(&f, &f.series, "Marcus");
    register(&f, &destination);
    let target = f.ready("Marcus");
    decide(&f, &target, "asset-5", DecisionKind::Accepted);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
            [&f.child],
        )
        .unwrap();
    let preview = f
        .library
        .character_series_move_preview(&target.id, &destination)
        .unwrap();
    let other = other_in(&f, &f.child);
    decide(&f, &other, "asset-5", DecisionKind::Accepted);
    assert!(matches!(
        f.library
            .move_character_to_series(&target.id, &destination, &preview.token),
        Err(Error::Stale)
    ));
    assert_eq!(
        f.library.get_asset_classifications("asset-0").unwrap()[0].id,
        f.child
    );
    let updated = f
        .library
        .character_series_move_preview(&target.id, &destination)
        .unwrap();
    assert_eq!(updated.shared_locations[0].classification_id, f.series);
}

#[test]
fn move_rolls_back_all_changes_when_final_target_update_fails() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.outside);
    let target = f.ready("Lorentz");
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.outside)
        .unwrap();
    let c = f.library.connection().unwrap();
    character_autotag::enqueue(&c, "asset-0", Cause::Ingestion).unwrap();
    c.execute_batch("CREATE TRIGGER reject_series_move BEFORE UPDATE OF series_classification_id ON character_targets BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    drop(c);
    let before = f.library.character_autotag_job("asset-0").unwrap().unwrap();
    let sync_before = scalar(&f, "SELECT COUNT(*) FROM cloud_sync_queue");
    assert!(f
        .library
        .move_character_to_series(&target.id, &f.outside, &preview.token)
        .is_err());
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .fingerprint,
        target.fingerprint
    );
    assert_eq!(
        f.library.get_asset_classifications("asset-0").unwrap()[0].id,
        f.child
    );
    assert_eq!(
        f.library.character_autotag_job("asset-0").unwrap().unwrap(),
        before
    );
    assert_eq!(
        scalar(&f, "SELECT COUNT(*) FROM cloud_sync_queue"),
        sync_before
    );
}

#[test]
fn move_manual_character_keeps_destination_automation_disabled() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.outside);
    let target = f
        .library
        .create_manual_character(crate::library::character_workflow::ManualCharacterRequest {
            series_id: f.series.clone(),
            display_name: "Extra".into(),
            asset_ids: vec!["asset-5".into()],
        })
        .unwrap();
    let c = f.library.connection().unwrap();
    c.execute(
        "UPDATE character_series SET auto_classify=0 WHERE classification_id=?1",
        [&f.outside],
    )
    .unwrap();
    drop(c);
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.outside)
        .unwrap();
    let moved = f
        .library
        .move_character_to_series(&target.id, &f.outside, &preview.token)
        .unwrap();
    assert!(moved.manual_only);
    assert_eq!(moved.enabled, target.enabled);
    assert_eq!(
        scalar(
            &f,
            "SELECT COUNT(*) FROM character_series WHERE auto_classify=0"
        ),
        1
    );
    assert_eq!(scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs"), 0);
}

#[test]
fn move_preserves_identity_references_history_shared_gallery_and_never_enqueues() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.child);
    let target = f.ready("Lorentz");
    decide(&f, &target, "asset-5", DecisionKind::Accepted);
    let target = f
        .library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    let other = f.target("Other character");
    decide(&f, &other, "asset-5", DecisionKind::Accepted);
    f.library
        .save_character_group(GroupDraft {
            id: None,
            series_id: f.series.clone(),
            expected_revision: None,
            name: "Laplace".into(),
            target_ids: vec![target.id.clone(), other.id.clone()],
            delete: false,
        })
        .unwrap();
    let history = scalar(&f, "SELECT COUNT(*) FROM character_decisions");
    let jobs = scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs");
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.child)
        .unwrap();
    assert_eq!(preview.asset_count, 6);
    assert_eq!(preview.relocation_count, 1);
    assert_eq!(preview.shared_count, 1);
    let moved = f
        .library
        .move_character_to_series(&target.id, &f.child, &preview.token)
        .unwrap();
    assert_eq!(moved.id, target.id);
    assert_eq!(
        moved.series_classification_id.as_deref(),
        Some(f.child.as_str())
    );
    assert!(moved.linked_classification_id.is_none());
    assert_eq!(moved.revision, target.revision + 1);
    assert_eq!(
        serde_json::to_value(&moved.references).unwrap(),
        serde_json::to_value(&target.references).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&moved.learned_references).unwrap(),
        serde_json::to_value(&target.learned_references).unwrap()
    );
    assert!(moved.ready);
    assert_ne!(moved.fingerprint, target.fingerprint);
    assert_eq!(
        scalar(&f, "SELECT COUNT(*) FROM character_decisions"),
        history
    );
    assert_eq!(
        scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs"),
        jobs
    );
    assert_eq!(
        scalar(&f, "SELECT COUNT(*) FROM character_reference_refreshes"),
        0
    );
    assert_eq!(browse(&f, &f.child, &target.id).len(), 6);
    assert!(browse(&f, &f.series, &other.id).contains(&"asset-5".into()));
    let groups = f.library.character_groups(&f.series).unwrap();
    assert_eq!(groups[0].target_ids, vec![other.id.clone()]);
    assert_eq!(groups[0].revision, 2);
    let preview = f
        .library
        .character_series_move_preview(&other.id, &f.child)
        .unwrap();
    f.library
        .move_character_to_series(&other.id, &f.child, &preview.token)
        .unwrap();
    assert!(f.library.character_groups(&f.series).unwrap().is_empty());
    assert_eq!(
        scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs"),
        jobs
    );
    assert_eq!(
        std::fs::read(f.temp.path().join("assets/asset-5.png")).unwrap(),
        b"asset-5"
    );
}

#[test]
fn move_rejects_stale_preview_wrong_destination_duplicates_and_incompatible_sharing() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.child);
    register(&f, &f.outside);
    let target = f.ready("Lorentz");
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.child)
        .unwrap();
    assert!(matches!(
        f.library
            .move_character_to_series(&target.id, &f.outside, &preview.token),
        Err(Error::Stale)
    ));
    decide(&f, &target, "asset-5", DecisionKind::Accepted);
    assert!(matches!(
        f.library
            .move_character_to_series(&target.id, &f.child, &preview.token),
        Err(Error::Stale)
    ));
    let other = f.target("Other");
    decide(&f, &other, "asset-5", DecisionKind::Accepted);
    assert!(f
        .library
        .character_series_move_preview(&target.id, &f.outside)
        .is_err());
    f.library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(f.child.clone()),
            linked_classification_id: None,
            display_name: "Lorentz".into(),
            enabled: false,
            description: String::new(),
            thumbnail_asset_id: None,
        })
        .unwrap();
    assert!(f
        .library
        .character_series_move_preview(&target.id, &f.child)
        .is_err());
    assert!(f
        .library
        .character_series_move_preview(&target.id, &f.series)
        .is_err());
    assert!(f
        .library
        .character_series_move_preview(&target.id, "missing")
        .is_err());
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .series_classification_id
            .as_deref(),
        Some(f.series.as_str())
    );
    assert_eq!(
        f.library.get_asset_classifications("asset-5").unwrap()[0].id,
        f.series
    );
}

#[test]
fn move_stops_old_refresh_and_claims_without_touching_unclassified_work() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.child);
    let target = f.ready("Lorentz");
    let c = f.library.connection().unwrap();
    character_autotag::enqueue(&c, "asset-5", Cause::Ingestion).unwrap();
    c.execute("UPDATE character_autotag_jobs SET state='completed',review_state='unresolved' WHERE asset_id='asset-5'", []).unwrap();
    drop(c);
    f.library
        .request_character_reference_refresh(&target.id, target.revision)
        .unwrap();
    f.library.advance_character_reference_refresh(32).unwrap();
    let claimed = f.library.claim_character_autotag().unwrap().unwrap();
    assert_eq!(claimed.asset_id, "asset-5");
    assert_eq!(claimed.cause, "reconsideration");
    let jobs_before = scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs");
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.child)
        .unwrap();
    f.library
        .move_character_to_series(&target.id, &f.child, &preview.token)
        .unwrap();
    let job = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    assert_eq!(job.state, "superseded");
    assert!(job.claim_id.is_none());
    assert!(
        Library::check_character_autotag_claim(&f.library.connection().unwrap(), &claimed).is_err()
    );
    assert_eq!(
        f.library.advance_character_reference_refresh(32).unwrap(),
        0
    );
    assert_eq!(
        scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs"),
        jobs_before
    );
    assert_eq!(scalar(&f, "SELECT COUNT(*) FROM character_reference_refreshes WHERE state IN ('pending','running')"), 0);
    // The unclassified image was not swept into the moved character.
    assert_eq!(
        f.library.get_asset_classifications("asset-5").unwrap()[0].id,
        f.series
    );
}

#[test]
fn move_preserves_trash_and_opt_outs_and_invalidates_relocated_claim_only() {
    let f = Fixture::new();
    register(&f, &f.series);
    register(&f, &f.outside);
    let target = f.ready("Lorentz");
    let c = f.library.connection().unwrap();
    c.execute("UPDATE assets SET status='trash' WHERE id='asset-0'", [])
        .unwrap();
    c.execute("INSERT INTO character_series_asset_exclusions(series_id,asset_id,created_at) VALUES(?1,'asset-1','now')", [&f.series]).unwrap();
    character_autotag::enqueue(&c, "asset-2", Cause::Ingestion).unwrap();
    drop(c);
    let claimed = f.library.claim_character_autotag().unwrap().unwrap();
    let c = f.library.connection().unwrap();
    character_autotag::enqueue(&c, "asset-5", Cause::Ingestion).unwrap();
    drop(c);
    let untouched = f.library.character_autotag_job("asset-5").unwrap().unwrap();
    let preview = f
        .library
        .character_series_move_preview(&target.id, &f.outside)
        .unwrap();
    f.library
        .move_character_to_series(&target.id, &f.outside, &preview.token)
        .unwrap();
    assert_eq!(
        scalar(
            &f,
            "SELECT COUNT(*) FROM assets WHERE id='asset-0' AND status='trash'"
        ),
        1
    );
    assert_eq!(
        f.library.get_asset_classifications("asset-0").unwrap()[0].id,
        f.outside
    );
    assert!(crate::library::character_hub::series_asset_excluded(
        &f.library.connection().unwrap(),
        &f.outside,
        "asset-1"
    )
    .unwrap());
    assert!(
        Library::check_character_autotag_claim(&f.library.connection().unwrap(), &claimed).is_err()
    );
    assert_eq!(
        f.library.character_autotag_job("asset-5").unwrap().unwrap(),
        untouched
    );
    assert_eq!(scalar(&f, "SELECT COUNT(*) FROM character_autotag_jobs"), 2);
}
