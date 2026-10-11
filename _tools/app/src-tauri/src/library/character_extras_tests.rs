use std::collections::BTreeSet;
use std::fs;

use rusqlite::params;
use sha2::{Digest, Sha256};

use super::*;
use crate::library::{
    character_groups::GroupDraft,
    character_hub::{BrowseQuery, Series, SeriesGalleryFilter},
    characters::{
        tests::{historical_character_library, Fixture},
        DecisionKind, DecisionRequest, TargetDraft,
    },
};

fn put(f: &Fixture, target: &Target, ids: &[&str], decision: DecisionKind) -> Result<u64> {
    let fresh = f.library.get_character_target(&target.id).unwrap();
    f.library.record_character_decisions(DecisionRequest {
        target_id: fresh.id.clone(),
        expected_fingerprint: fresh.fingerprint.clone(),
        asset_ids: ids.iter().map(|id| id.to_string()).collect(),
        decision,
        baseline_fingerprint: None,
        scan_id: None,
    })
}

fn members(f: &Fixture, target: &Target) -> BTreeSet<String> {
    f.library
        .connection()
        .unwrap()
        .prepare("SELECT asset_id FROM character_relations WHERE target_id=?1")
        .unwrap()
        .query_map([&target.id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}

fn register(f: &Fixture) {
    f.library
        .save_character_series(Series {
            classification_id: f.series.clone(),
            hero_asset_id: None,
            auto_classify: true,
        })
        .unwrap();
}

fn set(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

fn count(f: &Fixture, sql: &str) -> i64 {
    f.library
        .connection()
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

/// What an automatic engine writes: an accepted decision with origin `automatic`.
fn automatic_accept(f: &Fixture, target: &Target, asset: &str) {
    let connection = f.library.connection().unwrap();
    let hash: String = connection
        .query_row(
            "SELECT content_hash FROM assets WHERE id=?1",
            [asset],
            |r| r.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,
              target_fingerprint,reference_snapshot,origin,created_at)
             VALUES(?1,?2,?2,?3,'accepted','fingerprint','{}','automatic','2026-10-11')",
            params![target.id, asset, hash],
        )
        .unwrap();
}

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

fn real_group(f: &Fixture, series: &str, name: &str, members: &[&Target]) -> String {
    f.library
        .save_character_group(GroupDraft {
            id: None,
            series_id: series.into(),
            expected_revision: None,
            name: name.into(),
            target_ids: members.iter().map(|t| t.id.clone()).collect(),
            delete: false,
        })
        .unwrap();
    f.library
        .character_groups(series)
        .unwrap()
        .into_iter()
        .find(|g| g.name == name)
        .unwrap()
        .id
}

fn tag_asset(f: &Fixture, asset: &str, tag: &str, pixai: f64, canary: f64) {
    let c = f.library.connection().unwrap();
    for (source, score) in [("pixai", pixai), ("canary", canary)] {
        c.execute(
            "INSERT OR IGNORE INTO asset_tagger_coverage(asset_id,source) VALUES(?1,?2)",
            params![asset, source],
        )
        .unwrap();
        c.execute(
            "INSERT OR IGNORE INTO tagger_character_vocabulary(source,tag) VALUES(?1,?2)",
            params![source, tag],
        )
        .unwrap();
        c.execute(
            "INSERT INTO asset_tagger_character_scores(asset_id,source,tag,score) VALUES(?1,?2,?3,?4)",
            params![asset, source, tag, score],
        )
        .unwrap();
    }
}

#[test]
fn migration_adds_extras_columns_without_changing_existing_characters() {
    let (temp, c) = historical_character_library(126);
    c.execute_batch(
        "INSERT INTO character_groups(id,series_id,name) VALUES('team','series','Team');
         INSERT INTO character_group_members(target_id,group_id) VALUES('target','team');
         INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,
           target_fingerprint,reference_snapshot,created_at)
         VALUES('target','reference-0','reference-0','hash-0','accepted','fp','{}','2026-10-11');",
    )
    .unwrap();
    drop(c);
    let reopened = Library::open(temp.path()).unwrap();
    let target = reopened.get_character_target("target").unwrap();
    assert_eq!(target.role, "character");
    assert_eq!(target.extras_group_id, None);
    assert_eq!(target.revision, 3);
    assert!(target.ready);
    // Nothing is created by the upgrade: a 기타 appears when a screen first needs it.
    assert!(reopened.character_extras().unwrap().is_empty());
    let groups = reopened.character_groups("series").unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].target_ids, vec!["target"]);
    assert_eq!(groups[0].extras_target_id, None);
    assert_eq!(
        reopened
            .character_relations_for_asset("reference-0")
            .unwrap(),
        vec!["target"]
    );
    let c = reopened.connection().unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::library::db::SCHEMA_VERSION
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    // The old empty-group rule still holds for groups without a 기타.
    c.execute(
        "DELETE FROM character_group_members WHERE target_id='target'",
        [],
    )
    .unwrap();
    drop(c);
    assert!(reopened.character_groups("series").unwrap().is_empty());
}

#[test]
fn the_undo_script_removes_the_extras_columns() {
    let f = Fixture::new();
    let c = f.library.connection().unwrap();
    c.execute_batch(crate::library::db::UNDO_AFTER_102).unwrap();
    let columns = c
        .prepare("SELECT name FROM pragma_table_info('character_targets')")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert!(!columns
        .iter()
        .any(|c| c == "role" || c == "extras_group_id"));
}

#[test]
fn one_extras_per_series_and_per_group_is_enforced() {
    let f = Fixture::new();
    let a = f.ready("A");
    let group = real_group(&f, &f.series, "Team", &[&a]);
    let series_extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    let group_extras = f
        .library
        .ensure_character_extras(&f.series, Some(&group))
        .unwrap();
    assert_eq!(series_extras.role, "extras");
    assert_eq!(series_extras.extras_group_id, None);
    assert_eq!(
        group_extras.extras_group_id.as_deref(),
        Some(group.as_str())
    );
    assert!(series_extras.manual_only && group_extras.manual_only);
    assert_ne!(series_extras.display_name, group_extras.display_name);
    assert!(group_extras.display_name.starts_with("Team"));
    // Asking again returns the same bucket.
    assert_eq!(
        f.library
            .ensure_character_extras(&f.series, None)
            .unwrap()
            .id,
        series_extras.id
    );
    assert_eq!(
        f.library
            .ensure_character_extras(&f.series, Some(&group))
            .unwrap()
            .id,
        group_extras.id
    );
    let other = real_group(&f, &f.series, "Other team", &[&f.ready("B")]);
    let c = f.library.connection().unwrap();
    let insert = |id: &str, name: &str, group: Option<&str>, manual: i64| {
        c.execute(
            "INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,
              role,extras_group_id,created_at,updated_at) VALUES(?1,?2,?3,1,?4,'extras',?5,'2026','2026')",
            params![id, f.series, name, manual, group],
        )
    };
    assert!(insert("dup-series", "Another", None, 1).is_err());
    assert!(insert("dup-group", "Another group", Some(&group), 1).is_err());
    // A 기타 is manual-only and never changes kind.
    assert!(insert("recognised", "Recognised", Some("other-group"), 0).is_err());
    assert!(c
        .execute(
            "UPDATE character_targets SET manual_only=0 WHERE id=?1",
            [&series_extras.id]
        )
        .is_err());
    assert!(c
        .execute(
            "UPDATE character_targets SET role='character' WHERE id=?1",
            [&series_extras.id]
        )
        .is_err());
    assert!(c
        .execute(
            "UPDATE character_targets SET role='extras' WHERE id=?1",
            [&a.id]
        )
        .is_err());
    // A group's 기타 only fits its own group.
    assert!(c
        .execute(
            "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2)",
            params![series_extras.id, group]
        )
        .is_err());
    assert!(c
        .execute(
            "INSERT INTO character_group_members(target_id,group_id) VALUES(?1,?2)",
            params![group_extras.id, other]
        )
        .is_err());
    drop(c);
    assert_eq!(f.library.character_extras().unwrap().len(), 2);
}

#[test]
fn extras_is_never_a_recognition_target_or_learning_source() {
    let f = Fixture::new();
    let a = f.ready("A");
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    // Recognition candidates of an image in the series: only the real character.
    let connection = f.library.connection().unwrap();
    let targets = f
        .library
        .character_autotag_targets(&connection, "asset-5")
        .unwrap();
    assert_eq!(
        targets.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        vec![a.id.clone()]
    );
    drop(connection);
    // No references: not through the settings paths, not through the database.
    for result in [
        f.library
            .replace_character_references(&extras.id, extras.revision, &f.refs),
        f.library
            .add_character_learned_references(&extras.id, extras.revision, &f.refs[..1]),
        f.library
            .exclude_character_reference(&extras.id, extras.revision, "asset-0"),
    ] {
        assert!(result.is_err());
    }
    assert!(f.library.reference_candidates(&extras.id, 5).is_err());
    let c = f.library.connection().unwrap();
    assert!(c
        .execute(
            "INSERT INTO character_references(target_id,slot,asset_id,asset_hash) VALUES(?1,0,'asset-6','h')",
            [&extras.id]
        )
        .is_err());
    assert!(c
        .execute(
            "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at)
             VALUES(?1,'asset-6','h','2026')",
            [&extras.id]
        )
        .is_err());
    // A tagger name cannot be mapped to it (the insert is silently skipped).
    c.execute_batch(
        "INSERT INTO tagger_character_vocabulary(source,tag) VALUES('pixai','someone');",
    )
    .unwrap();
    drop(c);
    crate::library::character_tagger_tags::explicitly_link(
        &f.library.connection().unwrap(),
        &extras.id,
        "someone",
    )
    .unwrap();
    assert_eq!(
        count(&f, "SELECT COUNT(*) FROM character_target_tagger_tags"),
        0
    );
    // Settings of a 기타 cannot be edited.
    let draft = TargetDraft {
        id: Some(extras.id.clone()),
        expected_revision: Some(extras.revision),
        series_classification_id: extras.series_classification_id.clone(),
        linked_classification_id: None,
        display_name: "Renamed".into(),
        description: String::new(),
        thumbnail_asset_id: None,
        enabled: true,
    };
    assert!(f.library.save_character_target(draft).is_err());
    assert!(!extras.ready);
}

#[test]
fn a_group_with_only_extras_is_allowed_and_survives_losing_its_last_member() {
    let f = Fixture::new();
    let a = f.ready("A");
    let group = real_group(&f, &f.series, "Team", &[&a]);
    let extras = f
        .library
        .ensure_character_extras(&f.series, Some(&group))
        .unwrap();
    // Group listings keep real members and the 기타 apart.
    let listed = f.library.character_groups(&f.series).unwrap().remove(0);
    assert_eq!(listed.target_ids, vec![a.id.clone()]);
    assert_eq!(listed.extras_target_id.as_deref(), Some(extras.id.as_str()));
    put(&f, &extras, &["asset-5"], DecisionKind::Accepted).unwrap();
    // The last real member goes away: the group stays because its 기타 has an image.
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_targets WHERE id=?1", [&a.id])
        .unwrap();
    let kept = f.library.character_groups(&f.series).unwrap();
    assert_eq!(kept.len(), 1);
    assert!(kept[0].target_ids.is_empty());
    assert_eq!(
        kept[0].extras_target_id.as_deref(),
        Some(extras.id.as_str())
    );
    // Explicit deletion is refused while the 기타 holds images.
    let refused = f.library.save_character_group(GroupDraft {
        id: Some(group.clone()),
        series_id: f.series.clone(),
        expected_revision: Some(kept[0].revision),
        name: "Team".into(),
        target_ids: vec![],
        delete: true,
    });
    assert!(refused.is_err());
    // Emptying the 기타 and deleting the group removes both, with no stray character left.
    put(&f, &extras, &["asset-5"], DecisionKind::Cleared).unwrap();
    f.library
        .save_character_group(GroupDraft {
            id: Some(group),
            series_id: f.series.clone(),
            expected_revision: Some(kept[0].revision),
            name: "Team".into(),
            target_ids: vec![],
            delete: true,
        })
        .unwrap();
    assert!(f.library.character_groups(&f.series).unwrap().is_empty());
    assert!(f.library.character_extras().unwrap().is_empty());
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_targets WHERE role='extras'"
        ),
        0
    );
}

#[test]
fn an_empty_extras_does_not_keep_a_group_alive_and_leaves_no_orphan() {
    let f = Fixture::new();
    let a = f.ready("A");
    let group = real_group(&f, &f.series, "Team", &[&a]);
    f.library
        .ensure_character_extras(&f.series, Some(&group))
        .unwrap();
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_targets WHERE id=?1", [&a.id])
        .unwrap();
    assert!(f.library.character_groups(&f.series).unwrap().is_empty());
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_targets WHERE role='extras'"
        ),
        0
    );
}

#[test]
fn creating_a_group_that_has_only_extras_works_and_keeps_group_edits_safe() {
    let f = Fixture::new();
    register(&f);
    let created = f
        .library
        .create_character_extras_group(&f.series, "Solo team")
        .unwrap();
    assert!(created.group.target_ids.is_empty());
    assert_eq!(
        created.group.extras_target_id.as_deref(),
        Some(created.extras.id.as_str())
    );
    put(&f, &created.extras, &["asset-5"], DecisionKind::Accepted).unwrap();
    // A real character joins; an edit that echoes the 기타 id keeps it a 기타.
    let a = f.ready("A");
    f.library
        .save_character_group(GroupDraft {
            id: Some(created.group.id.clone()),
            series_id: f.series.clone(),
            expected_revision: Some(created.group.revision),
            name: "Renamed team".into(),
            target_ids: vec![a.id.clone(), created.extras.id.clone()],
            delete: false,
        })
        .unwrap();
    let group = f.library.character_groups(&f.series).unwrap().remove(0);
    assert_eq!(group.target_ids, vec![a.id.clone()]);
    assert_eq!(
        group.extras_target_id.as_deref(),
        Some(created.extras.id.as_str())
    );
    // Renaming the group renames the stored 기타 name too.
    let extras = f.library.get_character_target(&created.extras.id).unwrap();
    assert!(extras.display_name.starts_with("Renamed team"));
    // Releasing the last real member keeps the group because the 기타 has an image.
    f.library
        .save_character_group(GroupDraft {
            id: Some(group.id.clone()),
            series_id: f.series.clone(),
            expected_revision: Some(group.revision),
            name: "Renamed team".into(),
            target_ids: vec![],
            delete: false,
        })
        .unwrap();
    let group = f.library.character_groups(&f.series).unwrap().remove(0);
    assert!(group.target_ids.is_empty());
    assert_eq!(members(&f, &extras), set(&["asset-5"]));
}

#[test]
fn people_and_engines_taking_an_image_empty_it_from_extras_without_a_wrong_mark() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    let group = real_group(&f, &f.series, "Team", &[&b]);
    let series_extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    let group_extras = f
        .library
        .ensure_character_extras(&f.series, Some(&group))
        .unwrap();
    add_asset(&f, "x-1", &f.child);
    add_asset(&f, "x-2", &f.child);
    add_asset(&f, "x-3", &f.child);
    put(
        &f,
        &series_extras,
        &["asset-5", "x-1", "x-3"],
        DecisionKind::Accepted,
    )
    .unwrap();
    put(&f, &group_extras, &["x-2", "x-3"], DecisionKind::Accepted).unwrap();
    // A person confirms an image for a real character.
    put(&f, &a, &["asset-5"], DecisionKind::Accepted).unwrap();
    assert_eq!(members(&f, &series_extras), set(&["x-1", "x-3"]));
    // An engine writes an automatic acceptance for another character of the series: it leaves
    // both the series' and the group's 기타.
    automatic_accept(&f, &b, "x-3");
    automatic_accept(&f, &b, "x-2");
    assert_eq!(members(&f, &series_extras), set(&["x-1"]));
    assert_eq!(members(&f, &group_extras), set(&[]));
    assert_eq!(members(&f, &b), set(&["x-3", "x-2"]));
    // Recorded as a removal ("cleared"), never as a rejection.
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_decisions WHERE decision='rejected'"
        ),
        0
    );
    assert_eq!(
        count(
            &f,
            &format!(
                "SELECT COUNT(*) FROM character_decisions WHERE target_id='{}' AND source_asset_id='x-3' AND decision='cleared'",
                series_extras.id
            )
        ),
        1
    );
    // The reverse is refused: an image that has a character cannot be put in a 기타.
    assert!(put(&f, &series_extras, &["asset-5"], DecisionKind::Accepted).is_err());
    // A 기타 takes no "아님" and no wrong-region mark.
    assert!(put(&f, &series_extras, &["x-1"], DecisionKind::Rejected).is_err());
    assert!(put(
        &f,
        &series_extras,
        &["x-1"],
        DecisionKind::AcceptedWrongRegion
    )
    .is_err());
    // A character of an unrelated series does not empty this series' 기타.
    let other = f.ready_in_series("Nested", &f.child);
    automatic_accept(&f, &other, "x-1");
    assert_eq!(members(&f, &series_extras), set(&["x-1"]));
}

#[test]
fn the_old_membership_paths_work_for_extras() {
    let f = Fixture::new();
    register(&f);
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    let fresh = f.library.get_character_target(&extras.id).unwrap();
    // "Move to character" (adds and moves the image into the series) accepts a 기타.
    f.library
        .move_assets_to_character(
            extras.id.clone(),
            fresh.fingerprint.clone(),
            vec!["asset-6".into()],
        )
        .unwrap();
    assert_eq!(members(&f, &extras), set(&["asset-6"]));
    put(&f, &extras, &["asset-6"], DecisionKind::Cleared).unwrap();
    assert!(members(&f, &extras).is_empty());
}

#[test]
fn historical_refresh_also_considers_extras_images() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    add_asset(&f, "x-1", &f.child);
    add_asset(&f, "x-2", &f.child);
    put(&f, &extras, &["asset-5", "x-1"], DecisionKind::Accepted).unwrap();
    put(&f, &b, &["x-2"], DecisionKind::Accepted).unwrap();
    let a = f.library.get_character_target(&a.id).unwrap();
    let receipt = f
        .library
        .request_character_reference_refresh(&a.id, a.revision)
        .unwrap();
    let items = f
        .library
        .connection()
        .unwrap()
        .prepare("SELECT asset_id FROM character_reference_refresh_items WHERE target_id=?1")
        .unwrap()
        .query_map([&a.id], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<BTreeSet<_>, _>>()
        .unwrap();
    assert!(
        items.contains("asset-5") && items.contains("x-1"),
        "{items:?}"
    );
    // An image a real character already holds stays out, as before.
    assert!(!items.contains("x-2"));
    assert_eq!(receipt.eligible_count, items.len());
}

#[test]
fn counts_include_extras_and_the_parent_unclassified_view_leaves_them_out() {
    let f = Fixture::new();
    let a = f.ready("A");
    let group = real_group(&f, &f.series, "Team", &[&a]);
    let group_extras = f
        .library
        .ensure_character_extras(&f.series, Some(&group))
        .unwrap();
    let series_extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    add_asset(&f, "x-1", &f.child);
    add_asset(&f, "x-2", &f.child);
    add_asset(&f, "x-3", &f.child);
    put(&f, &group_extras, &["x-1", "x-2"], DecisionKind::Accepted).unwrap();
    put(&f, &series_extras, &["asset-5"], DecisionKind::Accepted).unwrap();
    let counts = f.library.character_sidebar_counts().unwrap();
    assert_eq!(counts.targets[&group_extras.id], 2);
    assert_eq!(counts.targets[&series_extras.id], 1);
    // The group counts its member's images and its 기타.
    assert_eq!(counts.groups[&group], counts.targets[&a.id] + 2);
    let page = |filter| {
        f.library
            .browse_character_assets(BrowseQuery {
                series_id: f.series.clone(),
                target_id: None,
                group_id: None,
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: Some(filter),
            })
            .unwrap()
    };
    let unclassified = page(SeriesGalleryFilter::Unclassified)
        .items
        .into_iter()
        .map(|item| item.id)
        .collect::<BTreeSet<_>>();
    assert!(unclassified.contains("x-3"));
    for held in ["x-1", "x-2", "asset-5"] {
        assert!(!unclassified.contains(held), "{held} is in a 기타");
    }
    // Opening the 기타 as a character and opening the group both list its images.
    let browse = |target: Option<&str>, group: Option<&str>| {
        f.library
            .browse_character_assets(BrowseQuery {
                series_id: f.series.clone(),
                target_id: target.map(str::to_owned),
                group_id: group.map(str::to_owned),
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: None,
            })
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.id)
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(browse(Some(&group_extras.id), None), set(&["x-1", "x-2"]));
    assert!(browse(None, Some(&group)).is_superset(&set(&["x-1", "x-2"])));
}

#[test]
fn extras_are_not_counted_as_other_characters_for_reference_choices() {
    let f = Fixture::new();
    register(&f);
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    put(&f, &extras, &["asset-5"], DecisionKind::Accepted).unwrap();
    let a = f.target("A");
    // Choosing an image that only a 기타 holds as a reference needs no person region.
    f.library
        .replace_character_references_selection(
            &a.id,
            a.revision,
            &["asset-0".into(), "asset-1".into(), "asset-5".into()],
            true,
        )
        .unwrap();
}

#[test]
fn promotion_suggestions_need_five_images_read_under_one_name() {
    let f = Fixture::new();
    register(&f);
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    put(
        &f,
        &extras,
        &["asset-0", "asset-1", "asset-2", "asset-3"],
        DecisionKind::Accepted,
    )
    .unwrap();
    for id in ["asset-0", "asset-1", "asset-2", "asset-3"] {
        tag_asset(&f, id, "ren_(story)", 0.95, 0.9);
    }
    // Four is not enough.
    assert!(f
        .library
        .character_extras_suggestions(&extras.id)
        .unwrap()
        .is_empty());
    put(&f, &extras, &["asset-4"], DecisionKind::Accepted).unwrap();
    tag_asset(&f, "asset-4", "ren_(story)", 0.9, 0.2);
    // A weak reading of another name never counts.
    for id in ["asset-0", "asset-1", "asset-2", "asset-3", "asset-4"] {
        tag_asset(&f, id, "weak_name", 0.5, 0.4);
    }
    let suggestions = f.library.character_extras_suggestions(&extras.id).unwrap();
    assert_eq!(suggestions.len(), 1);
    let s = &suggestions[0];
    assert_eq!(s.tag, "ren_(story)");
    assert_eq!(s.image_count, 5);
    assert_eq!(s.both_count, 4);
    assert_eq!(s.pixai_count, 5);
    assert_eq!(s.canary_count, 4);
    assert_eq!(
        set(&s.asset_ids.iter().map(String::as_str).collect::<Vec<_>>()),
        set(&["asset-0", "asset-1", "asset-2", "asset-3", "asset-4"])
    );
    // A real character is not a 기타: it has no suggestions.
    let a = f.target("A");
    assert!(f.library.character_extras_suggestions(&a.id).is_err());
    // A name already linked to a character, or dismissed, is not offered.
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_suggestion_ignored_tags VALUES('ren_(story)','2026')",
            [],
        )
        .unwrap();
    assert!(f
        .library
        .character_extras_suggestions(&extras.id)
        .unwrap()
        .is_empty());
}

fn fill_extras(f: &Fixture, ids: &[&str]) -> Target {
    register(f);
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    put(f, &extras, ids, DecisionKind::Accepted).unwrap();
    f.library.get_character_target(&extras.id).unwrap()
}

fn promote(f: &Fixture, extras: &Target, name: &str, ids: &[&str]) -> Result<PromoteExtrasResult> {
    f.library.promote_character_extras(PromoteExtrasRequest {
        target_id: extras.id.clone(),
        expected_fingerprint: extras.fingerprint.clone(),
        display_name: name.into(),
        asset_ids: ids.iter().map(|id| id.to_string()).collect(),
        thumbnail_asset_id: None,
        reference_asset_ids: None,
        tag: None,
    })
}

#[test]
fn promotion_with_five_references_starts_recognition() {
    let f = Fixture::new();
    let all = [
        "asset-0", "asset-1", "asset-2", "asset-3", "asset-4", "asset-5",
    ];
    let extras = fill_extras(&f, &all);
    let result = promote(&f, &extras, "Ren", &all).unwrap();
    assert_eq!(result.moved_count, 6);
    assert!(result.recognition);
    assert!(result.reference_count >= 5);
    let ren = &result.target;
    assert_eq!(ren.role, "character");
    assert!(ren.ready && !ren.manual_only);
    assert_eq!(ren.thumbnail_asset_id.as_deref(), Some("asset-0"));
    assert_eq!(members(&f, ren), set(&all));
    assert!(members(&f, &extras).is_empty());
    // 맞음 for the new character, 빼기 for the 기타, never 아님.
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_decisions WHERE decision='rejected'"
        ),
        0
    );
    let removal = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT decision,origin FROM character_decisions WHERE target_id=?1 AND source_asset_id='asset-3' ORDER BY sequence DESC LIMIT 1",
            [&extras.id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(removal, ("cleared".to_owned(), "manual".to_owned()));
    // Not a manual character any more, and no comparison was queued by the promotion.
    assert_eq!(
        count(
            &f,
            &format!(
                "SELECT COUNT(*) FROM character_manual_targets WHERE target_id='{}'",
                ren.id
            )
        ),
        0
    );
    assert_eq!(count(&f, "SELECT COUNT(*) FROM character_autotag_jobs"), 0);
    assert_eq!(
        count(&f, "SELECT COUNT(*) FROM character_reference_refresh_items"),
        0
    );
}

#[test]
fn promotion_with_fewer_than_five_references_starts_as_a_manual_character() {
    let f = Fixture::new();
    let extras = fill_extras(&f, &["asset-0", "asset-1", "asset-2", "asset-5"]);
    let group_less = promote(&f, &extras, "Few", &["asset-0", "asset-1", "asset-2"]).unwrap();
    assert!(!group_less.recognition);
    assert!(group_less.target.manual_only);
    assert!(!group_less.target.ready);
    assert_eq!(group_less.moved_count, 3);
    assert_eq!(
        count(
            &f,
            &format!(
                "SELECT COUNT(*) FROM character_manual_targets WHERE target_id='{}'",
                group_less.target.id
            )
        ),
        1
    );
    // The rest stays in the 기타.
    let extras_now = f.library.get_character_target(&extras.id).unwrap();
    assert_eq!(members(&f, &extras_now), set(&["asset-5"]));
    // The same name cannot be used twice.
    assert!(promote(&f, &extras_now, "few", &["asset-5"]).is_err());
    // Only images the 기타 holds can move.
    assert!(promote(&f, &extras_now, "Other", &["asset-6"]).is_err());
}

#[test]
fn promotion_inside_a_group_joins_the_group_and_links_the_tag() {
    let f = Fixture::new();
    let a = f.ready("A");
    let group = real_group(&f, &f.series, "Team", &[&a]);
    let extras = f
        .library
        .ensure_character_extras(&f.series, Some(&group))
        .unwrap();
    add_asset(&f, "x-1", &f.child);
    put(&f, &extras, &["x-1", "asset-5"], DecisionKind::Accepted).unwrap();
    let extras = f.library.get_character_target(&extras.id).unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO tagger_character_vocabulary(source,tag) VALUES('pixai','ren')",
            [],
        )
        .unwrap();
    let result = f
        .library
        .promote_character_extras(PromoteExtrasRequest {
            target_id: extras.id.clone(),
            expected_fingerprint: extras.fingerprint.clone(),
            display_name: "Ren".into(),
            asset_ids: vec!["x-1".into(), "asset-5".into()],
            thumbnail_asset_id: Some("asset-5".into()),
            reference_asset_ids: None,
            tag: Some("ren".into()),
        })
        .unwrap();
    assert_eq!(result.target.thumbnail_asset_id.as_deref(), Some("asset-5"));
    let groups = f.library.character_groups(&f.series).unwrap();
    assert!(groups[0].target_ids.contains(&result.target.id));
    assert_eq!(
        groups[0].extras_target_id.as_deref(),
        Some(extras.id.as_str())
    );
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_target_tagger_tags WHERE tag='ren'"
        ),
        1
    );
    // The group still exists after its 기타 was emptied, with its real members.
    assert!(members(&f, &extras).is_empty());
}

#[test]
fn a_failed_promotion_changes_nothing() {
    let f = Fixture::new();
    let all = [
        "asset-0", "asset-1", "asset-2", "asset-3", "asset-4", "asset-5",
    ];
    let extras = fill_extras(&f, &all);
    let before = (
        count(&f, "SELECT COUNT(*) FROM character_targets"),
        count(&f, "SELECT COUNT(*) FROM character_decisions"),
        count(&f, "SELECT COUNT(*) FROM character_manual_targets"),
        count(&f, "SELECT COUNT(*) FROM character_references"),
    );
    // The decisions are written before the references; a missing original fails the references.
    fs::remove_file(f.temp.path().join("assets/asset-4.png")).unwrap();
    let result = f.library.promote_character_extras(PromoteExtrasRequest {
        target_id: extras.id.clone(),
        expected_fingerprint: extras.fingerprint.clone(),
        display_name: "Ren".into(),
        asset_ids: all.iter().map(|id| id.to_string()).collect(),
        thumbnail_asset_id: None,
        reference_asset_ids: Some(all[..5].iter().map(|id| id.to_string()).collect()),
        tag: None,
    });
    assert!(result.is_err());
    let after = (
        count(&f, "SELECT COUNT(*) FROM character_targets"),
        count(&f, "SELECT COUNT(*) FROM character_decisions"),
        count(&f, "SELECT COUNT(*) FROM character_manual_targets"),
        count(&f, "SELECT COUNT(*) FROM character_references"),
    );
    assert_eq!(before, after);
    assert_eq!(members(&f, &extras), set(&all));
    assert!(!f
        .library
        .connection()
        .unwrap()
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    // Without the damage the same request works.
    fs::write(f.temp.path().join("assets/asset-4.png"), b"asset-4").unwrap();
    let ok = promote(&f, &extras, "Ren", &all).unwrap();
    assert!(ok.recognition);
}

#[test]
fn an_older_tablets_exclusion_of_an_extras_image_is_a_removal_not_a_wrong_mark() {
    let f = Fixture::new();
    let extras = fill_extras(&f, &["asset-5"]);
    let hash: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT content_hash FROM assets WHERE id='asset-5'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut connection = f.library.connection().unwrap();
    let tx = connection.transaction().unwrap();
    assert!(f
        .library
        .write_inbound_character_rejection(&tx, &extras.id, "asset-5", &hash)
        .unwrap());
    // Replaying it changes nothing.
    assert!(!f
        .library
        .write_inbound_character_rejection(&tx, &extras.id, "asset-5", &hash)
        .unwrap());
    tx.commit().unwrap();
    drop(connection);
    assert!(members(&f, &extras).is_empty());
    assert_eq!(
        count(
            &f,
            "SELECT COUNT(*) FROM character_decisions WHERE decision='rejected'"
        ),
        0
    );
}

#[test]
fn an_extras_cannot_become_a_folder_move_to_another_series_or_a_tag_target() {
    let f = Fixture::new();
    register(&f);
    let extras = f.library.ensure_character_extras(&f.series, None).unwrap();
    assert!(f.library.character_conversion_preview(&extras.id).is_err());
    assert!(f
        .library
        .character_series_move_preview(&extras.id, &f.child)
        .is_err());
}
