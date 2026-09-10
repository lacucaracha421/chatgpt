use super::*;
use crate::library::{
    db,
    models::{ClassificationKind, CreateClassification, SetAssetClassification},
};
use std::{fs, path::Path};

pub(in crate::library) struct Fixture {
    pub(in crate::library) library: Library,
    pub(in crate::library) temp: tempfile::TempDir,
    pub(in crate::library) series: String,
    pub(in crate::library) child: String,
    pub(in crate::library) outside: String,
    pub(in crate::library) refs: Vec<String>,
}

fn folder(library: &Library, name: &str, parent: Option<String>) -> String {
    library
        .create_classification(CreateClassification {
            kind: if parent.is_some() {
                ClassificationKind::Tag
            } else {
                ClassificationKind::Root
            },
            name: name.into(),
            parent_id: parent,
        })
        .unwrap()
        .id
}

impl Fixture {
    pub(in crate::library) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = folder(&library, "Root", None);
        let series = folder(&library, "Series is a tag", Some(root));
        let child = folder(&library, "Character or theme", Some(series.clone()));
        let outside = folder(&library, "Other", None);
        let refs = (0..5).map(|i| format!("asset-{i}")).collect();
        for i in 0..7 {
            let id = format!("asset-{i}");
            let original = format!("assets/{id}.png");
            let thumbnail = format!("thumbnails/{id}.webp");
            fs::write(temp.path().join(&original), id.as_bytes()).unwrap();
            fs::write(temp.path().join(&thumbnail), id.as_bytes()).unwrap();
            let connection = library.connection().unwrap();
            connection.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                VALUES(?1,?2,'image',?1,?3,?4,7,1,1,'2026-09-08','normal')", params![id,Sha256::digest(id.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),original,thumbnail]).unwrap();
            connection
                .execute(
                    "INSERT INTO asset_classifications VALUES(?1,?2)",
                    params![
                        id,
                        if i < 5 {
                            &child
                        } else if i == 5 {
                            &series
                        } else {
                            &outside
                        }
                    ],
                )
                .unwrap();
        }
        Self {
            library,
            temp,
            series,
            child,
            outside,
            refs,
        }
    }

    fn target(&self, name: &str) -> Target {
        self.library
            .save_character_target(TargetDraft {
                description: String::new(),
                thumbnail_asset_id: None,
                id: None,
                expected_revision: None,
                series_classification_id: Some(self.series.clone()),
                linked_classification_id: Some(self.child.clone()),
                display_name: name.into(),
                enabled: true,
            })
            .unwrap()
    }

    pub(in crate::library) fn ready(&self, name: &str) -> Target {
        let target = self.target(name);
        self.library
            .replace_character_references(&target.id, target.revision, &self.refs)
            .unwrap()
    }

    fn decide(&self, target: &Target, asset_ids: &[&str], decision: DecisionKind) -> Result<u64> {
        self.library.record_character_decisions(DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: asset_ids.iter().map(|s| s.to_string()).collect(),
            decision,
            baseline_fingerprint: None,
            scan_id: None,
        })
    }
}

fn edit(target: &Target) -> TargetDraft {
    TargetDraft {
        description: String::new(),
        thumbnail_asset_id: None,
        id: Some(target.id.clone()),
        expected_revision: Some(target.revision),
        series_classification_id: target.series_classification_id.clone(),
        linked_classification_id: target.linked_classification_id.clone(),
        display_name: target.display_name.clone(),
        enabled: target.enabled,
    }
}

fn legacy_v43(path: &Path) {
    fs::create_dir_all(path.parent().unwrap().join("backups")).unwrap();
    let mut connection = rusqlite::Connection::open(path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    let transaction = connection.transaction().unwrap();
    let mut files = fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| {
            p.extension().is_some_and(|s| s == "sql")
                && p.file_name().unwrap().to_string_lossy().as_ref() < "0044"
        })
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files.len(), 43);
    for file in files {
        transaction
            .execute_batch(&fs::read_to_string(file).unwrap())
            .unwrap();
    }
    transaction
        .execute(
            "INSERT INTO notes(id,payload,operation_id) VALUES('preserved','ciphertext','op')",
            [],
        )
        .unwrap();
    transaction.commit().unwrap();
}

#[test]
fn registry_accepts_recursive_refs_and_rejects_invalid_atomic_replacement() {
    let f = Fixture::new();
    let target = f.target("A");
    assert!(!target.ready);
    let partial = f
        .library
        .replace_character_references(&target.id, target.revision, &f.refs[..2])
        .unwrap();
    assert!(!partial.ready);
    let target = f
        .library
        .replace_character_references(&target.id, partial.revision, &f.refs)
        .unwrap();
    assert!(target.ready);
    assert_eq!(
        f.library
            .replace_character_references(&target.id, target.revision, &f.refs)
            .unwrap()
            .revision,
        target.revision
    );
    for invalid in [
        vec!["asset-0".into(), "asset-0".into()],
        vec!["asset-0".into(), "asset-6".into()],
        vec!["missing".into()],
        (0..6).map(|i| format!("asset-{i}")).collect(),
    ] {
        assert!(f
            .library
            .replace_character_references(&target.id, target.revision, &invalid)
            .is_err());
        assert_eq!(
            f.library
                .get_character_target(&target.id)
                .unwrap()
                .fingerprint,
            target.fingerprint
        );
    }
    assert!(matches!(
        f.library
            .replace_character_references(&target.id, partial.revision, &[]),
        Err(Error::Stale)
    ));
    let mut changed = edit(&target);
    changed.display_name = "renamed".into();
    let updated = f.library.save_character_target(changed).unwrap();
    assert_eq!(updated.revision, target.revision + 1);
    assert!(matches!(
        f.library.save_character_target(edit(&target)),
        Err(Error::Stale)
    ));
}

#[test]
fn trash_restore_missing_file_and_hard_delete_preserve_reference_slots() {
    let f = Fixture::new();
    let target = f.ready("A");
    f.library.trash_assets(&[f.refs[0].clone()]).unwrap();
    let trashed = f.library.get_character_target(&target.id).unwrap();
    assert!(!trashed.ready);
    assert_eq!(trashed.references[0].asset_id.as_deref(), Some("asset-0"));
    assert!(matches!(
        f.decide(&target, &["asset-5"], DecisionKind::Accepted),
        Err(Error::Stale)
    ));
    f.library.restore_assets(&[f.refs[0].clone()]).unwrap();
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .fingerprint,
        target.fingerprint
    );
    let path = f.temp.path().join("assets/asset-0.png");
    fs::remove_file(&path).unwrap();
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .references[0]
            .status,
        "missing_file"
    );
    fs::write(path, b"asset-0").unwrap();
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM assets WHERE id='asset-0'", [])
        .unwrap();
    let deleted = f.library.get_character_target(&target.id).unwrap();
    assert_eq!(deleted.references.len(), 5);
    assert_eq!(deleted.references[0].asset_id, None);
    assert_eq!(
        deleted.references[0].asset_hash,
        target.references[0].asset_hash
    );
    assert!(!deleted.ready);
}

#[test]
fn references_in_other_scope_or_unsupported_state_are_not_ready() {
    let f = Fixture::new();
    let target = f.ready("A");
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-0".into()],
            classification_id: Some(f.outside.clone()),
        })
        .unwrap();
    assert!(!f.library.get_character_target(&target.id).unwrap().ready);
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-0".into()],
            classification_id: Some(f.child.clone()),
        })
        .unwrap();
    f.library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET media_kind='gif' WHERE id='asset-0'", [])
        .unwrap();
    assert!(!f.library.get_character_target(&target.id).unwrap().ready);
    assert!(f
        .library
        .replace_character_references(&target.id, target.revision, &f.refs)
        .is_err());
}

#[test]
fn deleting_folders_detaches_targets_without_reparenting_or_losing_history() {
    let f = Fixture::new();
    let target = f.ready("A");
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    f.library.delete_classification(&f.child).unwrap();
    let detached_link = f.library.get_character_target(&target.id).unwrap();
    assert!(detached_link.ready);
    assert_eq!(detached_link.linked_classification_id, None);
    f.library.delete_classification(&f.series).unwrap();
    let detached = f.library.get_character_target(&target.id).unwrap();
    assert_eq!(detached.series_classification_id, None);
    assert!(!detached.ready);
    assert_eq!(
        f.library
            .list_character_decisions(&target.id, None, 200)
            .unwrap()
            .len(),
        1
    );
    let mut draft = edit(&detached);
    draft.enabled = false;
    assert!(!f.library.save_character_target(draft).unwrap().enabled);
}

#[test]
fn human_relations_are_multi_character_atomic_idempotent_and_folder_independent() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    let bytes = fs::read(f.temp.path().join("assets/asset-5.png")).unwrap();
    assert_eq!(
        f.decide(&a, &["asset-5", "asset-5"], DecisionKind::Accepted)
            .unwrap(),
        1
    );
    assert_eq!(
        f.decide(&a, &["asset-5"], DecisionKind::Accepted).unwrap(),
        0
    );
    f.decide(&b, &["asset-5"], DecisionKind::Accepted).unwrap();
    assert_eq!(
        f.library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .len(),
        2
    );
    assert!(f
        .decide(&a, &["asset-0", "asset-6"], DecisionKind::Accepted)
        .is_err());
    assert!(f
        .library
        .character_relations_for_asset("asset-0")
        .unwrap()
        .is_empty());
    assert_eq!(
        f.library.get_asset_classifications("asset-5").unwrap()[0].id,
        f.series
    );
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    f.library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-5".into()],
            classification_id: Some(f.outside.clone()),
        })
        .unwrap();
    assert_eq!(
        f.library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .len(),
        2
    );
    f.decide(&a, &["asset-5"], DecisionKind::Cleared).unwrap();
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![b.id]
    );
    assert_eq!(
        fs::read(f.temp.path().join("assets/asset-5.png")).unwrap(),
        bytes
    );
}

#[test]
fn decision_history_survives_ref_changes_trash_and_asset_deletion() {
    let f = Fixture::new();
    let target = f.ready("A");
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    let updated = f
        .library
        .replace_character_references(&target.id, target.revision, &f.refs[..2])
        .unwrap();
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![target.id.clone()]
    );
    assert!(matches!(
        f.decide(&target, &["asset-5"], DecisionKind::Rejected),
        Err(Error::Stale)
    ));
    f.decide(&updated, &["asset-5"], DecisionKind::Rejected)
        .unwrap();
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
    f.decide(&updated, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    f.library.trash_assets(&["asset-5".into()]).unwrap();
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
    f.library.restore_assets(&["asset-5".into()]).unwrap();
    assert_eq!(
        f.library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .len(),
        1
    );
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM assets WHERE id='asset-5'", [])
        .unwrap();
    let history = f
        .library
        .list_character_decisions(&target.id, None, 200)
        .unwrap();
    assert_eq!(history.len(), 3);
    assert!(history
        .iter()
        .all(|d| d.asset_id.is_none() && d.source_asset_id == "asset-5"));
    let old_refs: serde_json::Value = serde_json::from_str(&history[2].reference_snapshot).unwrap();
    assert_eq!(old_refs.as_array().unwrap().len(), 5);
    assert_eq!(
        f.library
            .list_character_decisions(&target.id, Some(history[1].sequence), 1)
            .unwrap()[0]
            .sequence,
        history[2].sequence
    );
}

#[test]
fn restart_and_cloud_snapshot_restore_keep_registry_refs_and_human_decisions() {
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    f.decide(&a, &["asset-5"], DecisionKind::Accepted).unwrap();
    f.decide(&b, &["asset-5"], DecisionKind::Rejected).unwrap();
    let snapshot = f.temp.path().join("snapshot.sqlite");
    f.library.create_cloud_metadata_snapshot(&snapshot).unwrap();
    f.library
        .replace_character_references(&a.id, a.revision, &[])
        .unwrap();
    f.library
        .restore_cloud_metadata_snapshot(&snapshot)
        .unwrap();
    assert!(f.library.get_character_target(&a.id).unwrap().ready);
    assert_eq!(
        f.library.list_character_decisions(&b.id, None, 10).unwrap()[0].decision,
        "rejected"
    );
    let Fixture { library, temp, .. } = f;
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    assert!(library.get_character_target(&a.id).unwrap().ready);
    assert_eq!(
        library.character_relations_for_asset("asset-5").unwrap(),
        vec![a.id]
    );
    fs::remove_file(temp.path().join("assets/asset-0.png")).unwrap();
    library.restore_cloud_metadata_snapshot(&snapshot).unwrap();
    assert!(!library.list_character_targets().unwrap()[0].ready);
}

#[test]
fn v43_migration_preserves_user_data_and_a_verified_pre_migration_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("library.sqlite");
    legacy_v43(&path);
    let connection = db::initialize_database(&path).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        db::SCHEMA_VERSION
    );
    assert_eq!(
        connection
            .query_row("SELECT payload FROM notes WHERE id='preserved'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "ciphertext"
    );
    assert!(!connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    let backup = fs::read_dir(temp.path().join("backups"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = rusqlite::Connection::open(backup).unwrap();
    assert_eq!(
        original
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        43
    );
    assert_eq!(
        original
            .pragma_query_value(None, "quick_check", |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn old_snapshot_restore_has_new_schema_before_character_api_resumes() {
    let f = Fixture::new();
    f.ready("Will be replaced");
    let old = f.temp.path().join("old.sqlite");
    legacy_v43(&old);
    f.library.restore_cloud_metadata_snapshot(&old).unwrap();
    assert!(f.library.list_character_targets().unwrap().is_empty());
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        db::SCHEMA_VERSION
    );
    assert_eq!(
        rusqlite::Connection::open(old)
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        43
    );
}

#[test]
fn migration_failure_and_restore_failure_leave_original_data_intact() {
    let f = Fixture::new();
    let target = f.ready("keep");
    let old = f.temp.path().join("broken.sqlite");
    legacy_v43(&old);
    let connection = rusqlite::Connection::open(&old).unwrap();
    connection
        .execute_batch("CREATE TABLE character_targets(conflicting_column TEXT);")
        .unwrap();
    drop(connection);
    assert!(f.library.restore_cloud_metadata_snapshot(&old).is_err());
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .fingerprint,
        target.fingerprint
    );
    assert!(!f.temp.path().join("library.sqlite.restore.part").exists());
    assert!(db::initialize_database(&old).is_err());
    let old = rusqlite::Connection::open(old).unwrap();
    assert_eq!(
        old.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        43
    );
    assert_eq!(
        old.query_row("SELECT payload FROM notes WHERE id='preserved'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "ciphertext"
    );
    assert!(!old
        .prepare("SELECT name FROM sqlite_master WHERE name='character_references'")
        .unwrap()
        .exists([])
        .unwrap());
}

#[test]
fn foreign_key_failure_rolls_back_new_schema_before_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("library.sqlite");
    legacy_v43(&path);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=OFF; INSERT INTO asset_classifications VALUES('absent-asset','absent-folder');").unwrap();
    drop(connection);
    assert!(db::initialize_database(&path).is_err());
    let connection = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        43
    );
    assert!(!connection
        .prepare("SELECT name FROM sqlite_master WHERE name='character_targets'")
        .unwrap()
        .exists([])
        .unwrap());
}

#[test]
fn learned_examples_are_explicit_and_stable_across_membership_decisions() {
    let f = Fixture::new();
    let target = f.ready("Towa");
    let clear_reconsideration = || {
        f.library
            .connection()
            .unwrap()
            .execute("DELETE FROM character_autotag_reconsideration", [])
            .unwrap();
    };
    let reconsideration_count = || {
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id=?1",
                [&f.series],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };

    clear_reconsideration();
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    assert!(f
        .library
        .get_character_target(&target.id)
        .unwrap()
        .learned_references
        .is_empty());
    assert_eq!(reconsideration_count(), 0);

    let learned = f
        .library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    assert_eq!(learned.learned_references.len(), 1);
    assert_eq!(reconsideration_count(), 1);

    clear_reconsideration();
    f.decide(&target, &["asset-5"], DecisionKind::Rejected)
        .unwrap();
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .learned_references
            .len(),
        1
    );
    assert_eq!(reconsideration_count(), 0);
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .learned_references
            .len(),
        1
    );
    assert_eq!(reconsideration_count(), 0);
}

#[test]
fn explicit_learning_changes_reconsider_once_and_is_idempotent() {
    let f = Fixture::new();
    let target = f.ready("Towa");
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    let clear = || {
        f.library
            .connection()
            .unwrap()
            .execute("DELETE FROM character_autotag_reconsideration", [])
            .unwrap();
    };
    let count = || {
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id=?1",
                [&f.series],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };

    clear();
    f.library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    assert_eq!(count(), 1);
    clear();
    f.library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    assert_eq!(count(), 0);

    f.library
        .exclude_character_reference(&target.id, target.revision, "asset-5")
        .unwrap();
    assert_eq!(count(), 1);
    clear();
    f.library
        .exclude_character_reference(&target.id, target.revision, "asset-5")
        .unwrap();
    assert_eq!(count(), 0);

    f.library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    assert_eq!(count(), 1);
    assert_eq!(
        f.library
            .get_character_target(&target.id)
            .unwrap()
            .learned_references
            .len(),
        1
    );
}

#[test]
fn source_changes_reconsider_only_explicit_recognition_references() {
    let f = Fixture::new();
    let target = f.ready("Towa");
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    let clear = || {
        f.library
            .connection()
            .unwrap()
            .execute("DELETE FROM character_autotag_reconsideration", [])
            .unwrap();
    };
    let count = || {
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration WHERE series_id=?1",
                [&f.series],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    let original: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT relative_path FROM assets WHERE id='asset-5'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    clear();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET relative_path=?1 WHERE id='asset-5'",
            [format!("{original}.tmp")],
        )
        .unwrap();
    assert_eq!(count(), 0);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET relative_path=?1 WHERE id='asset-5'",
            [&original],
        )
        .unwrap();
    assert_eq!(count(), 0);

    f.library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    clear();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET relative_path=?1 WHERE id='asset-5'",
            [format!("{original}.tmp")],
        )
        .unwrap();
    assert_eq!(count(), 1);
}

#[test]
fn folder_registration_is_atomic_idempotent_and_preserves_memberships() {
    let f = Fixture::new();
    assert_eq!(
        f.library
            .character_folder_image_count(f.series.clone(), false)
            .unwrap(),
        1
    );
    assert_eq!(
        f.library
            .character_folder_image_count(f.series.clone(), true)
            .unwrap(),
        6
    );
    let request = |target: Option<&Target>, count| FolderRegistration {
        folder_id: f.child.clone(),
        series_id: f.series.clone(),
        recursive: false,
        cleanup_folder: false,
        expected_count: count,
        target_id: target.map(|t| t.id.clone()),
        expected_fingerprint: target.map(|t| t.fingerprint.clone()),
        display_name: "Imported".into(),
        reference_ids: vec![],
        thumbnail_id: None,
    };
    assert!(f
        .library
        .register_character_folder(request(None, 6))
        .is_err());
    assert!(f.library.list_character_targets().unwrap().is_empty());
    let target = f
        .library
        .register_character_folder(request(None, 5))
        .unwrap();
    assert_eq!(
        f.library.character_relations_for_asset("asset-0").unwrap(),
        vec![target.id.clone()]
    );
    assert_eq!(
        f.library.get_asset_classifications("asset-0").unwrap()[0].id,
        f.child
    );
    assert!(f
        .library
        .register_character_folder(request(None, 5))
        .is_err());
    f.library
        .register_character_folder(request(Some(&target), 5))
        .unwrap();
    assert_eq!(
        f.library
            .list_character_decisions(&target.id, None, 200)
            .unwrap()
            .len(),
        5
    );
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
}

#[test]
fn manual_video_membership_is_visible_but_not_recognition_evidence() {
    let f = Fixture::new();
    let target = f.ready("Video owner");
    f.library.connection().unwrap().execute("INSERT INTO video_assets(asset_id,duration_ms,container,video_codec,preparation_state) VALUES('asset-5',1000,'mp4','h264','pending')", []).unwrap();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET media_kind='video' WHERE id IN ('asset-5','asset-6')",
            [],
        )
        .unwrap();
    let request = |id: &str, decision| DecisionRequest {
        target_id: target.id.clone(),
        expected_fingerprint: target.fingerprint.clone(),
        asset_ids: vec![id.into()],
        decision,
        baseline_fingerprint: None,
        scan_id: None,
    };
    assert!(f
        .library
        .record_character_decisions(request("asset-6", DecisionKind::Accepted))
        .is_err());
    f.library
        .record_character_decisions(request("asset-5", DecisionKind::Accepted))
        .unwrap();
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![target.id.clone()]
    );
    let page = f
        .library
        .browse_character_assets(super::super::character_hub::BrowseQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            reference_target_id: None,
            all: false,
            after: None,
            limit: 100,
        })
        .unwrap();
    assert!(page.items.iter().any(|a| a.id == "asset-5"));
    let c = f.library.connection().unwrap();
    assert!(super::super::character_hub::candidate_image(&c, &f.series, "asset-5").is_err());
    assert!(scoped_image(&c, &f.series, "asset-5").is_err());
    assert!(!super::super::character_autotag::enqueue(
        &c,
        "asset-5",
        super::super::character_autotag::Cause::Ingestion
    )
    .unwrap());
    drop(c);
    assert!(f
        .library
        .get_character_target(&target.id)
        .unwrap()
        .learned_references
        .is_empty());
    f.library
        .record_character_decisions(request("asset-5", DecisionKind::Cleared))
        .unwrap();
    assert!(f
        .library
        .character_relations_for_asset("asset-5")
        .unwrap()
        .is_empty());
}

#[test]
fn removing_explicit_learning_preserves_character_membership() {
    let f = Fixture::new();
    let target = f.ready("Towa");
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    f.library
        .add_character_learned_references(&target.id, target.revision, &["asset-5".into()])
        .unwrap();
    let result = f
        .library
        .exclude_character_reference(&target.id, target.revision, "asset-5")
        .unwrap();
    assert!(result.learned_references.is_empty());
    assert_eq!(result.fingerprint, target.fingerprint);
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![target.id.clone()]
    );
    assert!(f
        .library
        .add_character_learned_references(&target.id, target.revision, &["asset-0".into()])
        .is_err());
}

#[test]
fn character_groups_do_not_change_recognition_and_reject_cross_series() {
    use super::super::character_groups::GroupDraft;
    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    let save = |id: Option<String>, revision: Option<i64>, ids: Vec<String>, delete| {
        f.library.save_character_group(GroupDraft {
            id,
            series_id: f.series.clone(),
            expected_revision: revision,
            name: "Group".into(),
            target_ids: ids,
            delete,
        })
    };
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_autotag_reconsideration", [])
        .unwrap();
    save(None, None, vec![a.id.clone()], false).unwrap();
    let group = f.library.character_groups(&f.series).unwrap().remove(0);
    assert_eq!(
        f.library.get_character_target(&a.id).unwrap().fingerprint,
        a.fingerprint
    );
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_reconsideration",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(save(None, None, vec![a.id.clone()], false).is_err());
    assert!(save(Some(group.id.clone()), Some(0), vec![b.id.clone()], false).is_err());
    save(
        Some(group.id.clone()),
        Some(group.revision),
        vec![a.id.clone(), b.id.clone()],
        false,
    )
    .unwrap();
    save(Some(group.id), Some(group.revision + 1), vec![], true).unwrap();
    assert!(f.library.character_groups(&f.series).unwrap().is_empty());
    assert_eq!(f.library.list_character_targets().unwrap().len(), 2);
}

#[test]
fn conversion_merges_same_name_and_preserves_other_character() {
    let f = Fixture::new();
    let target = f.ready("Converted");
    let other = f.ready("Other");
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    f.decide(&other, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    let folder = f
        .library
        .create_classification(super::super::models::CreateClassification {
            kind: super::super::models::ClassificationKind::Tag,
            name: "Converted".into(),
            parent_id: Some(f.series.clone()),
        })
        .unwrap();
    let preview = f.library.character_conversion_preview(&target.id).unwrap();
    assert_eq!(preview.asset_count, 6);
    assert_eq!(preview.shared_count, 1);
    assert_eq!(preview.destination_id, Some(folder.id.clone()));
    assert!(f
        .library
        .convert_character_to_folder(&target.id, &preview.token, "wrong")
        .is_err());
    assert!(f.library.get_character_target(&target.id).is_ok());
    let result = f
        .library
        .convert_character_to_folder(&target.id, &preview.token, "Converted")
        .unwrap();
    assert_eq!(result, folder.id);
    assert!(f.library.get_character_target(&target.id).is_err());
    assert_eq!(
        f.library.character_relations_for_asset("asset-5").unwrap(),
        vec![other.id.clone()]
    );
    assert_eq!(
        f.library
            .get_character_target(&other.id)
            .unwrap()
            .fingerprint,
        other.fingerprint
    );
    assert_eq!(
        f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM asset_classifications WHERE classification_id=?1",
                [&folder.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        6
    );
}

#[test]
fn registration_cleanup_moves_direct_assets_and_removes_only_empty_folder() {
    let f = Fixture::new();
    let target = f
        .library
        .register_character_folder(FolderRegistration {
            folder_id: f.child.clone(),
            series_id: f.series.clone(),
            recursive: false,
            cleanup_folder: true,
            expected_count: 5,
            target_id: None,
            expected_fingerprint: None,
            display_name: "Registered".into(),
            reference_ids: vec![],
            thumbnail_id: None,
        })
        .unwrap();
    assert!(target.linked_classification_id.is_none());
    assert!(!f
        .library
        .list_classifications()
        .unwrap()
        .iter()
        .any(|entry| entry.id == f.child));
    assert_eq!(
        f.library.character_relations_for_asset("asset-0").unwrap(),
        vec![target.id]
    );
}

#[test]
fn conversion_rejects_changed_assets_before_creating_a_folder() {
    let f = Fixture::new();
    let target = f.ready("Conversion");
    let preview = f.library.character_conversion_preview(&target.id).unwrap();
    f.decide(&target, &["asset-5"], DecisionKind::Accepted)
        .unwrap();
    assert!(matches!(
        f.library
            .convert_character_to_folder(&target.id, &preview.token, "Conversion"),
        Err(Error::Stale)
    ));
    assert!(f.library.get_character_target(&target.id).is_ok());
    assert!(!f
        .library
        .list_classifications()
        .unwrap()
        .iter()
        .any(|entry| entry.name == "Conversion"));
}

#[test]
fn folder_registration_inherits_video_and_gif_without_using_them_as_references() {
    let f = Fixture::new();
    let c = f.library.connection().unwrap();
    c.execute(
        "UPDATE assets SET media_kind='video' WHERE id='asset-0'",
        [],
    )
    .unwrap();
    c.execute("UPDATE assets SET media_kind='gif' WHERE id='asset-1'", [])
        .unwrap();
    drop(c);
    assert_eq!(
        f.library
            .character_folder_image_count(f.child.clone(), false)
            .unwrap(),
        3
    );
    assert_eq!(
        f.library
            .character_folder_asset_count(f.child.clone(), false)
            .unwrap(),
        5
    );
    let request = |references| FolderRegistration {
        folder_id: f.child.clone(),
        series_id: f.series.clone(),
        recursive: false,
        cleanup_folder: true,
        expected_count: 5,
        target_id: None,
        expected_fingerprint: None,
        display_name: "Mixed".into(),
        reference_ids: references,
        thumbnail_id: None,
    };
    assert!(f
        .library
        .register_character_folder(request(vec!["asset-0".into()]))
        .is_err());
    assert!(f.library.list_character_targets().unwrap().is_empty());
    let target = f
        .library
        .register_character_folder(request(vec![]))
        .unwrap();
    for id in ["asset-0", "asset-1", "asset-2"] {
        assert_eq!(
            f.library.character_relations_for_asset(id).unwrap(),
            vec![target.id.clone()]
        );
        assert_eq!(
            f.library.get_asset_classifications(id).unwrap()[0].id,
            f.series
        );
        assert!(f.temp.path().join(format!("assets/{id}.png")).exists());
    }
    assert!(target.references.is_empty());
    assert!(target.linked_classification_id.is_none());
    assert!(super::super::character_hub::candidate_image_mode(
        &f.library.connection().unwrap(),
        &f.series,
        "asset-0",
        false
    )
    .is_err());
}

#[test]
fn character_drop_moves_video_and_gif_out_of_original_folder() {
    let f = Fixture::new();
    let target = f.target("Marcus");
    let other = f.target("Other character");
    let connection = f.library.connection().unwrap();
    connection
        .execute(
            "UPDATE assets SET media_kind='video' WHERE id='asset-0'",
            [],
        )
        .unwrap();
    connection
        .execute("UPDATE assets SET media_kind='gif' WHERE id='asset-1'", [])
        .unwrap();
    drop(connection);
    f.decide(&other, &["asset-0"], DecisionKind::Accepted)
        .unwrap();
    assert_eq!(
        f.library
            .move_assets_to_character(
                target.id.clone(),
                target.fingerprint.clone(),
                vec!["asset-0".into(), "asset-1".into()]
            )
            .unwrap(),
        2
    );
    let connection = f.library.connection().unwrap();
    for id in ["asset-0", "asset-1"] {
        let folder: String = connection
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folder, f.series);
        let assigned: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE target_id=?1 AND asset_id=?2)", params![target.id, id], |r| r.get(0)).unwrap();
        assert!(assigned);
        assert!(f.temp.path().join(format!("assets/{id}.png")).exists());
    }
    let retained: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE target_id=?1 AND asset_id='asset-0')", [&other.id], |r| r.get(0)).unwrap();
    assert!(retained);
}

#[test]
fn character_drop_rejects_other_series_atomically() {
    let f = Fixture::new();
    let target = f.target("Marcus");
    assert!(f
        .library
        .move_assets_to_character(
            target.id.clone(),
            target.fingerprint.clone(),
            vec!["asset-0".into(), "asset-6".into()]
        )
        .is_err());
    let connection = f.library.connection().unwrap();
    let folder: String = connection
        .query_row(
            "SELECT classification_id FROM asset_classifications WHERE asset_id='asset-0'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(folder, f.child);
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM character_relations WHERE target_id=?1",
            [&target.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    drop(connection);
    assert!(f
        .library
        .move_assets_to_character(target.id, "stale".into(), vec!["asset-0".into()])
        .is_err());
}
