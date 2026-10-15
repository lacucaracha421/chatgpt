use super::*;
use crate::library::{
    character_hub::Series,
    characters::{tests::Fixture, TargetDraft},
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
