use std::collections::BTreeSet;
use std::fs;

use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::library::{
    character_groups::GroupDraft,
    characters::{tests::Fixture, DecisionKind, DecisionRequest, Target},
};

fn add_asset(f: &Fixture, id: &str, folder: &str) {
    let original = format!("assets/{id}.png");
    let thumbnail = format!("thumbnails/{id}.webp");
    fs::write(f.temp.path().join(&original), id.as_bytes()).unwrap();
    fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
    let connection = f.library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,
              byte_size,width,height,collected_at,status)
             VALUES(?1,?2,'image',?1,?3,?4,7,1,1,'2026-09-08','normal')",
            params![
                id,
                Sha256::digest(id.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
                original,
                thumbnail
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO asset_classifications VALUES(?1,?2)",
            params![id, folder],
        )
        .unwrap();
}

fn put(f: &Fixture, target: &Target, ids: &[&str]) {
    let fresh = f.library.get_character_target(&target.id).unwrap();
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: fresh.id.clone(),
            expected_fingerprint: fresh.fingerprint.clone(),
            asset_ids: ids.iter().map(|id| id.to_string()).collect(),
            decision: DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
}

fn members(f: &Fixture, target_id: &str) -> BTreeSet<String> {
    f.library
        .connection()
        .unwrap()
        .prepare("SELECT asset_id FROM character_relations WHERE target_id=?1")
        .unwrap()
        .query_map([target_id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}

fn registered(f: &Fixture, series: &str) -> bool {
    f.library
        .connection()
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1)",
            [series],
            |row| row.get(0),
        )
        .unwrap()
}

/// `f.child` registered as a nested series under `f.series` with a character, a group, a
/// series 기타 and a group 기타, each holding images that live in the child folder.
struct Nested {
    hero: Target,
    group: String,
    series_extras: Target,
    group_extras: Target,
}

fn nested(f: &Fixture) -> Nested {
    let hero = f.ready_in_series("Hero", &f.child);
    f.library
        .save_character_group(GroupDraft {
            id: None,
            series_id: f.child.clone(),
            expected_revision: None,
            name: "Crew".into(),
            target_ids: vec![hero.id.clone()],
            delete: false,
        })
        .unwrap();
    let group = f.library.character_groups(&f.child).unwrap().remove(0).id;
    let series_extras = f.library.ensure_character_extras(&f.child, None).unwrap();
    let group_extras = f
        .library
        .ensure_character_extras(&f.child, Some(&group))
        .unwrap();
    for id in ["x-1", "x-2", "x-3"] {
        add_asset(f, id, &f.child);
    }
    put(f, &series_extras, &["x-1", "x-2"]);
    put(f, &group_extras, &["x-3"]);
    Nested {
        hero,
        group,
        series_extras,
        group_extras,
    }
}

#[test]
fn unregistering_moves_characters_groups_and_extras_to_the_nearest_registered_ancestor() {
    let f = Fixture::new();
    // The parent series exists because it has its own character.
    let parent = f.ready("Parent hero");
    let n = nested(&f);
    let preview = f
        .library
        .character_series_unregister_preview(&f.child)
        .unwrap();
    assert_eq!(preview.destination_id.as_deref(), Some(f.series.as_str()));
    assert_eq!((preview.character_count, preview.group_count), (1, 1));
    assert_eq!(preview.extras_image_count, 3);
    assert!(preview.collisions.is_empty() && preview.refusal.is_none());
    let before_folders = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT json_group_array(json_array(asset_id,classification_id)) FROM (SELECT * FROM asset_classifications ORDER BY asset_id)", [], |r| r.get::<_, String>(0))
        .unwrap();

    let result = f.library.unregister_character_series(&f.child).unwrap();
    assert_eq!(result.destination_id.as_deref(), Some(f.series.as_str()));
    assert_eq!(
        (result.moved_character_count, result.moved_group_count),
        (1, 1)
    );

    assert!(!registered(&f, &f.child));
    assert!(registered(&f, &f.series));
    // The character is now in the parent series, still ready (its references are inside it).
    let hero = f.library.get_character_target(&n.hero.id).unwrap();
    assert_eq!(
        hero.series_classification_id.as_deref(),
        Some(f.series.as_str())
    );
    assert!(hero.ready && hero.revision > n.hero.revision);
    // The group moved with its member and its 기타; the series 기타 became the parent's.
    let groups = f.library.character_groups(&f.series).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].id, n.group);
    assert_eq!(groups[0].target_ids, vec![n.hero.id.clone()]);
    assert_eq!(
        groups[0].extras_target_id.as_deref(),
        Some(n.group_extras.id.as_str())
    );
    assert!(f.library.character_groups(&f.child).unwrap().is_empty());
    let extras = f.library.character_extras().unwrap();
    assert_eq!(extras.len(), 2);
    assert!(extras.iter().all(|e| e.series_id == f.series));
    let own = f.library.get_character_target(&n.series_extras.id).unwrap();
    assert_eq!(
        own.series_classification_id.as_deref(),
        Some(f.series.as_str())
    );
    assert!(own.display_name.starts_with("Series is a tag"));
    assert_eq!(
        members(&f, &n.series_extras.id),
        BTreeSet::from(["x-1".to_owned(), "x-2".to_owned()])
    );
    assert_eq!(
        members(&f, &n.group_extras.id),
        BTreeSet::from(["x-3".to_owned()])
    );
    // Images and folders never move.
    let after_folders = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT json_group_array(json_array(asset_id,classification_id)) FROM (SELECT * FROM asset_classifications ORDER BY asset_id)", [], |r| r.get::<_, String>(0))
        .unwrap();
    assert_eq!(before_folders, after_folders);
    assert!(!f
        .library
        .connection()
        .unwrap()
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    let _ = parent;
}

#[test]
fn the_series_extras_merges_into_an_existing_parent_extras() {
    let f = Fixture::new();
    f.ready("Parent hero");
    let n = nested(&f);
    let parent_extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    put(&f, &parent_extras, &["asset-5"]);
    f.library.unregister_character_series(&f.child).unwrap();
    assert_eq!(
        members(&f, &parent_extras.id),
        BTreeSet::from(["asset-5".to_owned(), "x-1".to_owned(), "x-2".to_owned()])
    );
    // The child's own 기타 is gone; nothing else was left behind.
    assert!(f.library.get_character_target(&n.series_extras.id).is_err());
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_targets WHERE role='extras' AND extras_group_id IS NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn a_name_the_parent_already_uses_refuses_with_a_clear_message_and_changes_nothing() {
    let f = Fixture::new();
    f.ready("Hero");
    let n = nested(&f);
    let preview = f
        .library
        .character_series_unregister_preview(&f.child)
        .unwrap();
    assert_eq!(preview.collisions, vec!["Hero".to_owned()]);
    let message = preview.refusal.clone().unwrap();
    assert!(
        message.contains("Hero") && message.contains("이름"),
        "{message}"
    );
    let error = f.library.unregister_character_series(&f.child).unwrap_err();
    assert!(error.to_string().contains("Hero"), "{error}");
    assert!(registered(&f, &f.child));
    let hero = f.library.get_character_target(&n.hero.id).unwrap();
    assert_eq!(
        hero.series_classification_id.as_deref(),
        Some(f.child.as_str())
    );
    assert_eq!(f.library.character_groups(&f.child).unwrap().len(), 1);
}

#[test]
fn a_group_name_collision_also_refuses() {
    let f = Fixture::new();
    let parent = f.ready("Parent hero");
    f.library
        .save_character_group(GroupDraft {
            id: None,
            series_id: f.series.clone(),
            expected_revision: None,
            name: "crew".into(),
            target_ids: vec![parent.id.clone()],
            delete: false,
        })
        .unwrap();
    nested(&f);
    let preview = f
        .library
        .character_series_unregister_preview(&f.child)
        .unwrap();
    assert_eq!(preview.collisions, vec!["그룹 Crew".to_owned()]);
    assert!(f.library.unregister_character_series(&f.child).is_err());
    assert!(registered(&f, &f.child));
}

#[test]
fn without_a_registered_ancestor_the_series_is_refused_while_it_has_characters() {
    let f = Fixture::new();
    let hero = f.ready("Hero");
    // "Series is a tag" sits under an unregistered root: nowhere to move the characters.
    let preview = f
        .library
        .character_series_unregister_preview(&f.series)
        .unwrap();
    assert_eq!(preview.destination_id, None);
    assert_eq!(preview.character_count, 1);
    let error = f
        .library
        .unregister_character_series(&f.series)
        .unwrap_err();
    assert!(
        error.to_string().contains("상위 시리즈가 없습니다"),
        "{error}"
    );
    assert!(registered(&f, &f.series));
    assert_eq!(
        f.library
            .get_character_target(&hero.id)
            .unwrap()
            .series_classification_id
            .as_deref(),
        Some(f.series.as_str())
    );
}

#[test]
fn without_a_registered_ancestor_an_empty_series_unregisters() {
    let f = Fixture::new();
    let hero = f.ready("Hero");
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    {
        let c = f.library.connection().unwrap();
        c.execute(
            "DELETE FROM character_decisions WHERE target_id=?1",
            [&hero.id],
        )
        .unwrap();
        c.execute("DELETE FROM character_targets WHERE id=?1", [&hero.id])
            .unwrap();
    }
    // A 기타 with images still keeps the series registered.
    put(&f, &extras, &["asset-5"]);
    let error = f
        .library
        .unregister_character_series(&f.series)
        .unwrap_err();
    assert!(error.to_string().contains("기타"), "{error}");
    let extras = f.library.get_character_target(&extras.id).unwrap();
    let c = f.library.connection().unwrap();
    c.execute(
        "DELETE FROM character_decisions WHERE target_id=?1",
        [&extras.id],
    )
    .unwrap();
    drop(c);
    let result = f.library.unregister_character_series(&f.series).unwrap();
    assert_eq!(result.destination_id, None);
    assert!(!registered(&f, &f.series));
    assert!(f.library.character_extras().unwrap().is_empty());
    // Not a registered series any more.
    assert!(f.library.unregister_character_series(&f.series).is_err());
}
