use super::*;
use crate::library::{
    character_hub::Series,
    characters::{tests::Fixture, DecisionKind, DecisionRequest, TargetDraft},
};

#[test]
fn container_registration_relocates_only_selected_assets_without_recheck() {
    for folder_registration in [false, true] {
        let f = Fixture::new();
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
        f.library.set_character_container(&root, true).unwrap();
        f.library
            .save_character_series(Series {
                classification_id: f.series.clone(),
                hero_asset_id: None,
                auto_classify: true,
            })
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [&root],
            )
            .unwrap();
        let target = if folder_registration {
            let snapshot = f
                .library
                .character_folder_asset_snapshot(root.clone(), false)
                .unwrap();
            f.library
                .register_character_folder(super::super::characters::FolderRegistration {
                    folder_id: root.clone(),
                    series_id: f.series.clone(),
                    recursive: false,
                    cleanup_folder: true,
                    expected_count: snapshot.count,
                    expected_asset_fingerprint: snapshot.fingerprint,
                    target_id: None,
                    expected_fingerprint: None,
                    display_name: "Test".into(),
                    reference_ids: vec![],
                    thumbnail_id: None,
                })
                .unwrap()
                .target
        } else {
            f.library
                .create_manual_character(super::super::character_workflow::ManualCharacterRequest {
                    series_id: f.series.clone(),
                    display_name: "Test".into(),
                    asset_ids: vec!["asset-6".into()],
                })
                .unwrap()
        };
        assert!(target.manual_only);
        let c = f.library.connection().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-6'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            f.series
        );
        assert_eq!(
            c.query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-0'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            f.child
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM character_autotag_jobs WHERE cause='reconsideration'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM classification_containers WHERE classification_id=?1)",
                [root],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
}

fn preview(
    f: &Fixture,
    series: &str,
    mode: RegistrationMode,
    refs: Vec<String>,
) -> RegistrationPreview {
    f.library
        .character_registration_preview(RegistrationPreviewRequest {
            series_id: series.into(),
            mode,
            reference_ids: refs,
        })
        .unwrap()
}
#[test]
fn container_rejects_registrations_and_non_top_level_flags() {
    let f = Fixture::new();
    assert!(f.library.set_character_container(&f.series, true).is_err());
    f.library.set_character_container(&f.outside, true).unwrap();
    let entry = f
        .library
        .list_classifications()
        .unwrap()
        .into_iter()
        .find(|e| e.id == f.outside)
        .unwrap();
    assert!(entry.is_container);
    let published =
        super::super::classification::list_classifications_in(&f.library.connection().unwrap())
            .unwrap();
    let published = published
        .iter()
        .find(|entry| entry.id == f.outside)
        .unwrap();
    assert!(serde_json::to_value(published)
        .unwrap()
        .get("isContainer")
        .is_none());
    assert!(f
        .library
        .save_character_series(Series {
            classification_id: f.outside.clone(),
            hero_asset_id: None,
            auto_classify: true
        })
        .unwrap_err()
        .to_string()
        .contains("분류함"));
    assert!(f
        .library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(f.outside.clone()),
            linked_classification_id: None,
            display_name: "Test".into(),
            description: String::new(),
            thumbnail_asset_id: None,
            enabled: true
        })
        .unwrap_err()
        .to_string()
        .contains("분류함"));
    // The database invariant also covers direct insertion paths (manual, extras).
    assert!(f.library.connection().unwrap().execute("INSERT INTO character_targets(id,series_classification_id,display_name,created_at,updated_at) VALUES('blocked',?1,'Test','now','now')",[&f.outside]).is_err());
    assert!(f
        .library
        .move_classification(&f.outside, Some(&f.series))
        .is_err());
    f.library
        .set_character_container(&f.outside, false)
        .unwrap();
    assert!(
        !f.library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|e| e.id == f.outside)
            .unwrap()
            .is_container
    );
}
#[test]
fn container_remote_move_clears_local_flag_without_blocking_projection() {
    let f = Fixture::new();
    f.library.set_character_container(&f.outside, true).unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE classification_entries SET parent_id=?1,kind='tag' WHERE id=?2",
            params![f.series, f.outside],
        )
        .unwrap();
    assert!(
        !f.library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|e| e.id == f.outside)
            .unwrap()
            .is_container
    );
}

#[test]
fn container_preview_counts_indexed_scope_and_manual_has_no_recheck() {
    let f = Fixture::new();
    // No media files need to be read by preview (even references may be absent).
    let p = preview(&f, &f.series, RegistrationMode::Suggestion, f.refs.clone());
    assert_eq!(p.image_count, 1);
    assert!(!p.other_series);
    f.library
        .save_character_series(Series {
            classification_id: f.child.clone(),
            hero_asset_id: None,
            auto_classify: true,
        })
        .unwrap();
    assert!(preview(&f, &f.series, RegistrationMode::Suggestion, f.refs.clone()).other_series);
    assert_eq!(
        preview(&f, &f.series, RegistrationMode::Suggestion, vec![]).image_count,
        0
    );
    for mode in [
        RegistrationMode::Manual,
        RegistrationMode::Folder,
        RegistrationMode::Settings,
        RegistrationMode::Promotion,
    ] {
        assert_eq!(preview(&f, &f.series, mode, f.refs.clone()).image_count, 0);
    }
    let c = f.library.connection().unwrap();
    c.execute("UPDATE assets SET status='trash' WHERE id='asset-5'", [])
        .unwrap();
    drop(c);
    assert_eq!(
        preview(&f, &f.series, RegistrationMode::Suggestion, f.refs.clone()).image_count,
        0
    );
    let c = f.library.connection().unwrap();
    let plan = c
        .prepare(&format!("EXPLAIN QUERY PLAN {REGISTRATION_IMAGES}"))
        .unwrap()
        .query_map(params![f.series, "[]"], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("\n");
    assert!(plan.contains("classification_id=?"), "{plan}");
    assert!(!plan.contains("SCAN a"), "{plan}");
}
#[test]
fn container_conversion_moves_character_without_recheck() {
    let f = Fixture::new();
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
    let target = f.ready_in_series("Test", &root);
    // A top-level series with characters cannot be marked early.
    assert!(f.library.set_character_container(&root, true).is_err());
    let child = f
        .library
        .create_classification(super::super::models::CreateClassification {
            kind: super::super::models::ClassificationKind::Tag,
            name: "Child".into(),
            parent_id: Some(root.clone()),
        })
        .unwrap();
    f.library
        .save_character_series(Series {
            classification_id: child.id.clone(),
            hero_asset_id: None,
            auto_classify: true,
        })
        .unwrap();
    let before: i64 = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM character_autotag_jobs WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let plan = f
        .library
        .character_series_move_preview(&target.id, &child.id)
        .unwrap();
    f.library
        .move_character_to_series(&target.id, &child.id, &plan.token)
        .unwrap();
    f.library.set_character_container(&root, true).unwrap();
    let c = f.library.connection().unwrap();
    let after: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM character_autotag_jobs WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(after <= before);
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [&root],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}

fn conversion_fixture() -> (Fixture, String, String) {
    let f = Fixture::new();
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
    let second = f
        .library
        .create_classification(super::super::models::CreateClassification {
            kind: super::super::models::ClassificationKind::Tag,
            name: "Second series".into(),
            parent_id: Some(root.clone()),
        })
        .unwrap()
        .id;
    for id in [&root, &f.series, &second] {
        f.library
            .save_character_series(Series {
                classification_id: id.clone(),
                hero_asset_id: None,
                auto_classify: true,
            })
            .unwrap();
    }
    (f, root, second)
}

fn link_snapshot(f: &Fixture) -> String {
    f.library
        .connection()
        .unwrap()
        .query_row(
            "SELECT json_group_array(json_array(k,a,c)) FROM (
                SELECT 'rel' k,target_id a,asset_id c FROM character_relations
                UNION ALL SELECT 'ref',target_id||slot,asset_id FROM character_references
                UNION ALL SELECT 'learned',target_id,asset_id FROM character_learned_references
                UNION ALL SELECT 'class',asset_id,classification_id FROM asset_classifications
                ORDER BY 1,2,3)",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

// Two characters of the folder share reference images and go to different child series:
// no series can hold the images for both, so the images stay where they are.
#[test]
fn container_conversion_keeps_references_shared_across_destination_series() {
    let (f, root, second) = conversion_fixture();
    let a = f.ready_in_series("Aaa", &root);
    let b = f.ready_in_series("Bbb", &root);
    assert!(f
        .library
        .character_series_move_preview(&b.id, &second)
        .is_ok());
    f.library
        .move_character_to_series(
            &a.id,
            &f.series,
            &f.library
                .character_series_move_preview(&a.id, &f.series)
                .unwrap()
                .token,
        )
        .unwrap();
    // The one-by-one path still stops here, which is what the dialog used to hit.
    assert!(matches!(
        f.library.character_series_move_preview(&b.id, &second),
        Err(Error::Invalid(_))
    ));
    drop((a, b));

    let (f, root, second) = conversion_fixture();
    let a = f.ready_in_series("Aaa", &root);
    let b = f.ready_in_series("Bbb", &root);
    let before = link_snapshot(&f);
    let moves = [
        ContainerMove {
            target_id: a.id.clone(),
            destination_id: f.series.clone(),
        },
        ContainerMove {
            target_id: b.id.clone(),
            destination_id: second.clone(),
        },
    ];
    let preview = f
        .library
        .container_conversion_preview(&root, &moves)
        .unwrap();
    assert_eq!(preview.moved_count, 2);
    assert_eq!(preview.shared_count, 5);
    assert_eq!(link_snapshot(&f), before, "a preview writes nothing");
    // B keeps its links but its five references now lie outside its series.
    assert_eq!(preview.reference_losses.len(), 1);
    assert_eq!(preview.reference_losses[0].target_id, b.id);
    assert_eq!(preview.reference_losses[0].ineligible_count, 5);
    assert!(preview.reference_losses[0].loses_ready);
    let done = f.library.convert_to_container(&root, &moves).unwrap();
    assert_eq!(done.shared_count, 5);
    assert_eq!(done.reference_losses.len(), 1);
    assert_eq!(
        link_snapshot(&f),
        before,
        "links, references and folders are untouched"
    );
    let c = f.library.connection().unwrap();
    for (target, series) in [(&a.id, &f.series), (&b.id, &second)] {
        assert_eq!(
            c.query_row(
                "SELECT series_classification_id FROM character_targets WHERE id=?1",
                [target],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            *series
        );
    }
    assert!(c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_containers WHERE classification_id=?1)",
            [&root],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}

fn put_in_folder(f: &Fixture, folder: &str, assets: &[&str]) {
    let c = f.library.connection().unwrap();
    for asset in assets {
        c.execute(
            "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id=?2",
            params![folder, asset],
        )
        .unwrap();
    }
}
fn folder_of(f: &Fixture, asset: &str) -> String {
    f.library.get_asset_classifications(asset).unwrap()[0]
        .id
        .clone()
}

// Characters that share references and go to the SAME child series lose nothing: the
// images follow them into that series instead of staying in the folder.
#[test]
fn container_conversion_moves_shared_references_into_a_common_destination() {
    let (f, root, _second) = conversion_fixture();
    let a = f.ready_in_series("Aaa", &root);
    let b = f.ready_in_series("Bbb", &root);
    let refs = ["asset-0", "asset-1", "asset-2", "asset-3", "asset-4"];
    put_in_folder(&f, &root, &refs);
    let moves = [&a, &b].map(|t| ContainerMove {
        target_id: t.id.clone(),
        destination_id: f.series.clone(),
    });
    let preview = f
        .library
        .container_conversion_preview(&root, &moves)
        .unwrap();
    assert!(preview.reference_losses.is_empty());
    assert_eq!(preview.kept_in_folder_count, 0);
    let done = f.library.convert_to_container(&root, &moves).unwrap();
    assert!(done.reference_losses.is_empty());
    for asset in refs {
        assert_eq!(folder_of(&f, asset), f.series);
    }
    for target in [&a, &b] {
        let read = f.library.get_character_target(&target.id).unwrap();
        assert!(read.ready);
        assert!(read.references.iter().all(|r| r.status == "ready"));
    }
}

// Different destinations: images that a valid series can still hold are placed there; the
// ones no series can serve stay put and the affected character is reported.
#[test]
fn container_conversion_reports_references_pushed_out_of_a_series() {
    let (f, root, second) = conversion_fixture();
    let a = f.ready_in_series("Aaa", &root);
    let b = f.ready_in_series("Bbb", &root);
    let refs = ["asset-0", "asset-1", "asset-2", "asset-3", "asset-4"];
    put_in_folder(&f, &root, &refs);
    let moves = [
        ContainerMove {
            target_id: a.id.clone(),
            destination_id: f.series.clone(),
        },
        ContainerMove {
            target_id: b.id.clone(),
            destination_id: second.clone(),
        },
    ];
    let done = f.library.convert_to_container(&root, &moves).unwrap();
    // The first character's move placed the images in its series; the second cannot follow.
    for asset in refs {
        assert_eq!(folder_of(&f, asset), f.series);
    }
    assert_eq!(done.reference_losses.len(), 1);
    assert_eq!(done.reference_losses[0].target_id, b.id);
    assert_eq!(done.reference_losses[0].name, "Bbb");
    assert_eq!(done.reference_losses[0].ineligible_count, 5);
    assert!(done.reference_losses[0].loses_ready);
    assert!(f.library.get_character_target(&a.id).unwrap().ready);
    assert!(!f.library.get_character_target(&b.id).unwrap().ready);
}

// A shared ordinary image already in the folder stays there as plain folder content.
#[test]
fn container_conversion_keeps_shared_plain_images_in_the_folder() {
    let (f, root, second) = conversion_fixture();
    let a = f.ready_in_series("Aaa", &root);
    let b = f.ready_in_series("Bbb", &root);
    put_in_folder(&f, &root, &["asset-6"]);
    for target in [&a, &b] {
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-6".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
    }
    let done = f
        .library
        .convert_to_container(
            &root,
            &[
                ContainerMove {
                    target_id: a.id.clone(),
                    destination_id: f.series.clone(),
                },
                ContainerMove {
                    target_id: b.id.clone(),
                    destination_id: second.clone(),
                },
            ],
        )
        .unwrap();
    assert_eq!(done.kept_in_folder_count, 1);
    assert_eq!(folder_of(&f, "asset-6"), root);
}

#[test]
fn container_conversion_is_all_or_nothing() {
    let (f, root, second) = conversion_fixture();
    let a = f.ready_in_series("Aaa", &root);
    let b = f.ready_in_series("Bbb", &root);
    // The second character cannot go to `second`: the name is taken there.
    f.library
        .save_character_target(TargetDraft {
            id: None,
            expected_revision: None,
            series_classification_id: Some(second.clone()),
            linked_classification_id: None,
            display_name: "Bbb".into(),
            enabled: false,
            description: String::new(),
            thumbnail_asset_id: None,
        })
        .unwrap();
    let before = link_snapshot(&f);
    let moves = [
        ContainerMove {
            target_id: a.id.clone(),
            destination_id: f.series.clone(),
        },
        ContainerMove {
            target_id: b.id.clone(),
            destination_id: second.clone(),
        },
    ];
    assert!(f.library.convert_to_container(&root, &moves).is_err());
    assert!(f
        .library
        .container_conversion_preview(&root, &moves)
        .is_err());
    assert_eq!(link_snapshot(&f), before);
    let c = f.library.connection().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT series_classification_id FROM character_targets WHERE id=?1",
            [&a.id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        root
    );
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_containers)",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    // A character left out of the list keeps the folder from becoming a container.
    drop(c);
    let only_a = [ContainerMove {
        target_id: a.id.clone(),
        destination_id: f.series.clone(),
    }];
    assert!(f.library.convert_to_container(&root, &only_a).is_err());
    assert_eq!(link_snapshot(&f), before);
    assert_eq!(
        f.library
            .get_character_target(&a.id)
            .unwrap()
            .series_classification_id,
        Some(root)
    );
}
