//! PC 2B.1 regression coverage: the Classification send half.
//!
//! The queue, the mutation/enqueue boundary and the confirmation transaction run against
//! a real library database. The send pass runs against a real HTTP server, so it executes
//! the production code path end to end — including the credential split the server
//! enforces, which is why both tokens are supplied explicitly rather than read from the OS
//! credential store.
//!
//! `Library::connection()` takes a non-reentrant database mutex, so no assertion block
//! below calls a second accessor while it holds a connection guard.

use rusqlite::Connection;
use std::sync::mpsc;
use std::thread;

use tiny_http::{Header, Method, Response, Server};

use crate::cloud::client::CloudClient;
use crate::library::error::LibraryError;
use crate::library::models::{
    AssetClassificationPatch, ClassificationKind, CreateClassification, SetAssetClassification,
};
use crate::library::Library;

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn open() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    // Migrations 0058/0060 seed a protected Originals root and its role into every new
    // library. Each test below states the Classification state it means to exercise, so
    // the fixture starts from an empty table rather than from whatever the chain seeds.
    library
        .connection()
        .unwrap()
        .execute_batch("DELETE FROM classification_roles; DELETE FROM classification_entries;")
        .unwrap();
    (temp, library)
}

/// Adopt a Classification authority so local mutations start queueing.
fn adopt(library: &Library, epoch: i64, cursor: i64) {
    library
        .adopt_classification_authority_for_test(LIBRARY, epoch, 1, cursor)
        .unwrap();
}

fn outbox(connection: &Connection) -> Vec<(String, String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, command_type, payload FROM classification_authority_outbox
             ORDER BY seq",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn payloads(connection: &Connection) -> Vec<serde_json::Value> {
    outbox(connection)
        .into_iter()
        .map(|(_, _, payload)| serde_json::from_str(&payload).unwrap())
        .collect()
}

/// One committed Asset, which is what an assignment may reference.
fn insert_asset(library: &Library, id: &str) {
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (?1, ?2, 'image', 'asset.png', ?3, ?4, 1, 1, 1,
                '2026-09-17T00:00:00Z')",
            rusqlite::params![
                id,
                format!("hash-{id}"),
                format!("assets/{id}.png"),
                format!("thumbnails/{id}.webp"),
            ],
        )
        .unwrap();
}

/// A tiny real PNG, so an ingest test stages bytes the pipeline accepts.
fn png_bytes() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(4, 4, |x, _y| {
        image::Rgb([(x * 40 % 256) as u8, 32, 200])
    }));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

/// A committed Asset plus a Cloud-sync-eligible `cloud_sync_queue` baseline.
///
/// The pre-adoption legacy lane writes a relation-only Asset upsert, so a test comparing
/// the two eras must start from a state where such a write is even possible.
fn asset_with_legacy_queue(library: &Library, id: &str) {
    insert_asset(library, id);
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO cloud_sync_queue
                (id, entity_type, entity_id, operation, status, revision, updated_at)
             VALUES (?1, 'asset', ?2, 'upsert', 'pending', 1, '2026-09-17T00:00:00Z')",
            rusqlite::params![format!("queue-{id}"), id],
        )
        .unwrap();
}

fn cloud_sync_queue_rows(connection: &Connection, asset_id: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_type = 'asset' AND entity_id = ?1",
            [asset_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn create_root(library: &Library, name: &str) -> String {
    library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Root,
            name: name.to_owned(),
            parent_id: None,
        })
        .unwrap()
        .id
}

// ---------------------------------------------------------------------------
// Compatibility: an unadopted library is unchanged
// ---------------------------------------------------------------------------

/// A library that never adopted Classification authority must behave exactly as before.
///
/// This is the compatibility half of the whole batch: an unsynchronized library's
/// Classification mutations must not acquire a queue, a revision expectation or a new
/// failure mode merely because the send half now exists.
#[test]
fn classification_mutations_are_unchanged_while_no_authority_is_adopted() {
    let (_temp, library) = open();
    let root = create_root(&library, "업로드");
    library.rename_classification(&root, "업로드2").unwrap();
    library
        .update_classification_appearance(&root, Some("folder"), Some("blue"))
        .unwrap();
    library.move_classification(&root, None).unwrap();

    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM classification_entries WHERE id = ?1",
                [&root],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "업로드2"
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM classification_authority_sync", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

/// Adopted mutations commit the local effect and the durable intent together.
///
/// The pair is the contract: a crash may never leave a changed Classification with no
/// queued intent, nor an intent for a Classification that never changed.
#[test]
fn adopted_structural_mutations_queue_in_order_with_dependent_revisions() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "시리즈");
    library.rename_classification(&root, "시리즈2").unwrap();
    library
        .update_classification_appearance(&root, Some("folder"), Some("green"))
        .unwrap();
    library.move_classification(&root, None).unwrap();

    let connection = library.connection().unwrap();
    let queued = payloads(&connection);
    assert_eq!(
        queued
            .iter()
            .map(|body| body["commandType"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "createClassification",
            "renameClassification",
            "updateClassificationAppearance",
            "moveClassification"
        ]
    );
    // A create begins the entity at revision 1, so each dependent command presents the
    // revision its predecessors imply. This is exactly why the queue cannot coalesce.
    assert!(queued[0].get("expectedRevision").is_none(), "a create has nothing to compare against");
    assert_eq!(queued[1]["expectedRevision"], 1);
    assert_eq!(queued[2]["expectedRevision"], 2);
    assert_eq!(queued[3]["expectedRevision"], 3);
    // The envelope is identical on every row and carries the adopted identity.
    for body in &queued {
        assert_eq!(body["libraryId"], LIBRARY);
        assert_eq!(body["epoch"], 1);
        assert_eq!(body["contractVersion"], 1);
        assert_eq!(body["classificationId"], root.as_str());
        assert!(body["operationId"].as_str().is_some_and(|value| !value.is_empty()));
    }
}

/// A create payload states every field the server's contract requires.
///
/// The route rejects a body whose key set disagrees with its declared command, so the
/// fields this PC leaves unset on a new Classification must be sent as explicit nulls
/// rather than omitted.
#[test]
fn a_create_payload_matches_the_server_command_shape() {
    let (_temp, library) = open();
    adopt(&library, 2, 7);
    let root = create_root(&library, "게임");
    let connection = library.connection().unwrap();
    let body = &payloads(&connection)[0];
    assert_eq!(
        body,
        &serde_json::json!({
            "libraryId": LIBRARY,
            "epoch": 2,
            "contractVersion": 1,
            "operationId": body["operationId"],
            "commandType": "createClassification",
            "classificationId": root,
            "kind": "root",
            "name": "게임",
            "parentId": null,
            "iconKey": null,
            "colorKey": null
        })
    );
}

/// A rejected local mutation leaves no intent and no local change.
///
/// The enqueue happens after the write inside one transaction, so a validation failure
/// that returns early cannot leave either half behind.
#[test]
fn a_rejected_local_mutation_leaves_no_intent() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    assert!(matches!(
        library.create_classification(CreateClassification {
            kind: ClassificationKind::Work,
            name: "잘못된 작업".into(),
            parent_id: None,
        }),
        Err(LibraryError::InvalidClassificationParent)
    ));
    assert!(matches!(
        library.rename_classification(&root, "   "),
        Err(LibraryError::EmptyClassificationName)
    ));
    assert!(matches!(
        library.move_classification(&root, Some(&root)),
        Err(LibraryError::ClassificationCycle)
    ));
    assert!(matches!(
        library.update_classification_appearance(&root, Some("없는아이콘"), None),
        Err(LibraryError::InvalidClassificationAppearance)
    ));
    assert!(matches!(
        library.delete_classification("없는분류"),
        Err(LibraryError::ClassificationNotFound)
    ));

    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
}

// ---------------------------------------------------------------------------
// Local invariants survive adoption
// ---------------------------------------------------------------------------

/// The protected Originals node is refused locally, with no intent queued.
#[test]
fn protected_originals_are_refused_locally_with_no_intent() {
    let (_temp, library) = open();
    let root = create_root(&library, "오리지널");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', ?1)",
            [&root],
        )
        .unwrap();
    adopt(&library, 1, 0);

    assert!(matches!(
        library.rename_classification(&root, "새 이름"),
        Err(LibraryError::ProtectedClassification)
    ));
    assert!(matches!(
        library.move_classification(&root, None),
        Err(LibraryError::ProtectedClassification)
    ));
    assert!(matches!(
        library.delete_classification(&root),
        Err(LibraryError::ProtectedClassification)
    ));

    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM classification_entries WHERE id = ?1",
                [&root],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "오리지널"
    );
}

/// A Character-series subtree still cannot be moved into the Originals scope.
///
/// The server intentionally cannot enforce this yet, which is exactly why structural
/// commands are publisher-only. The PC rule must therefore survive the cutover unchanged.
#[test]
fn a_character_series_subtree_cannot_move_into_the_originals_scope() {
    let (_temp, library) = open();
    let originals = create_root(&library, "오리지널");
    let series = create_root(&library, "시리즈");
    library
        .connection()
        .unwrap()
        .execute_batch(&format!(
            "INSERT INTO classification_roles (role, classification_id)
                VALUES ('originals', '{originals}');
             INSERT INTO character_series (classification_id, hero_asset_id, auto_classify)
                VALUES ('{series}', NULL, 1);"
        ))
        .unwrap();
    adopt(&library, 1, 0);

    assert!(matches!(
        library.move_classification(&series, Some(&originals)),
        Err(LibraryError::ProtectedClassification)
    ));
    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id = ?1",
                [&series],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
        None
    );
}

/// Children still refuse deletion, and a child deletion reparents its Assets.
#[test]
fn delete_refuses_children_and_reparents_assets_to_the_parent() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    let child = library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Tag,
            name: "하위".into(),
            parent_id: Some(root.clone()),
        })
        .unwrap()
        .id;
    insert_asset(&library, "asset-1");
    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(child.clone()),
        })
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    assert!(matches!(
        library.delete_classification(&root),
        Err(LibraryError::ClassificationHasChildren)
    ));
    library.delete_classification(&child).unwrap();

    let connection = library.connection().unwrap();
    // Exactly one structural intent: the server's delete owns the whole atomic effect,
    // including the assignment lineage increments. One assignment intent per affected
    // Asset would be a competing description of the same change.
    let queued = payloads(&connection);
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["commandType"], "deleteClassification");
    assert_eq!(queued[0]["classificationId"], child.as_str());
    assert!(queued[0].get("assetId").is_none());
    // The local reparent still happened, as before.
    assert_eq!(
        connection
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = 'asset-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        root
    );
}

// ---------------------------------------------------------------------------
// Assignment: one command per Asset, own lineage
// ---------------------------------------------------------------------------

/// One assignment intent per changed Asset, and none for an idempotent request.
#[test]
fn an_assignment_patch_queues_one_command_per_changed_asset() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    for id in ["asset-1", "asset-2", "asset-3"] {
        insert_asset(&library, id);
    }
    // asset-3 already holds this Classification, so its desired value is unchanged.
    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-3".into()],
            classification_id: Some(root.clone()),
        })
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into(), "asset-2".into(), "asset-3".into()],
            classification_id: Some(root.clone()),
        })
        .unwrap();

    let connection = library.connection().unwrap();
    let queued = payloads(&connection);
    assert_eq!(
        queued
            .iter()
            .map(|body| body["assetId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["asset-1", "asset-2"],
        "an Asset whose desired value is already effective queues nothing"
    );
    for body in &queued {
        assert_eq!(body["commandType"], "setAssetClassification");
        assert_eq!(body["classificationId"], root.as_str());
        // No confirmed assignment row exists, so the lineage is at revision 0.
        assert_eq!(body["expectedRevision"], 0);
        assert!(body.get("classificationId").is_some());
    }
}

/// Assignment predictions use the assignment lineage, never a Classification revision.
#[test]
fn assignment_revisions_are_independent_of_classification_revisions() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    let other = create_root(&library, "다른");
    insert_asset(&library, "asset-1");
    // The Classification is at revision 3 after its own structural edits...
    library.rename_classification(&root, "게임2").unwrap();
    library.rename_classification(&root, "게임3").unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    // ...but an Asset that has never been assigned is still at assignment revision 0.
    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(root.clone()),
        })
        .unwrap();
    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(other.clone()),
        })
        .unwrap();

    let connection = library.connection().unwrap();
    let queued = payloads(&connection);
    assert_eq!(queued.len(), 2);
    assert_eq!(queued[0]["expectedRevision"], 0);
    // The second composes against the first queued intent, not against any entity
    // revision: each accepted assignment change consumes exactly one revision.
    assert_eq!(queued[1]["expectedRevision"], 1);
    assert_eq!(queued[1]["classificationId"], other.as_str());
}

// ---------------------------------------------------------------------------
// Revision prediction
// ---------------------------------------------------------------------------

/// A queued create predicts revision 1 even when a confirmed tombstone exists.
///
/// A tombstone means the Classification does not exist, so reusing its revision would
/// present an expectation the server's create can never satisfy.
#[test]
fn a_prediction_over_a_tombstone_starts_a_queued_create_at_one() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    let connection = library.connection().unwrap();
    connection
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();
    // The authority confirmed this Classification deleted at revision 9.
    connection
        .execute(
            "INSERT INTO classification_authority_revisions
                (classification_id, entity_revision, deleted, updated_at)
             VALUES (?1, 9, 1, '2026-09-17T00:00:00Z')",
            [&root],
        )
        .unwrap();
    // A create for that id is queued (the id reuse the server refuses, but the
    // prediction is what is under test).
    connection
        .execute(
            "INSERT INTO classification_authority_outbox
                (operation_id, command_type, classification_id, epoch, payload, state, created_at)
             VALUES ('00000000-0000-4000-8000-0000000000dd', 'createClassification', ?1, 1,
                     '{\"libraryId\":\"x\"}', 'pending', '2026-09-17T00:00:00Z')",
            [&root],
        )
        .unwrap();

    assert_eq!(
        crate::library::classification_authority::predicted_classification_revision(
            &connection, &root
        )
        .unwrap(),
        1,
        "a tombstone's revision is not a starting point for a create"
    );
    assert_eq!(
        crate::library::classification_authority::predicted_classification_revision(
            &connection, "다른분류"
        )
        .unwrap(),
        1,
        "an unknown Classification also starts from absence"
    );
}

/// A confirmed tombstone is absence, so the fold starts from zero rather than its revision.
///
/// This is what distinguishes the two representations: a tombstone at revision 9 must not
/// make a queued dependent command present 10. Without a create ahead of it, the fold
/// itself is the only thing that can produce the answer, so this pins the starting point
/// rather than the create's own override.
#[test]
fn a_tombstone_is_absence_not_a_revision_to_continue_from() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    let connection = library.connection().unwrap();
    connection
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO classification_authority_revisions
                (classification_id, entity_revision, deleted, updated_at)
             VALUES (?1, 9, 1, '2026-09-17T00:00:00Z')",
            [&root],
        )
        .unwrap();
    // A rename queued for that id: with a tombstone at 9, continuing the revision would
    // predict 10, while treating absence as the start predicts 1.
    connection
        .execute(
            "INSERT INTO classification_authority_outbox
                (operation_id, command_type, classification_id, epoch, payload, state, created_at)
             VALUES ('00000000-0000-4000-8000-0000000000ee', 'renameClassification', ?1, 1,
                     '{\"libraryId\":\"x\"}', 'pending', '2026-09-17T00:00:00Z')",
            [&root],
        )
        .unwrap();

    assert_eq!(
        crate::library::classification_authority::predicted_classification_revision(
            &connection, &root
        )
        .unwrap(),
        1,
        "a tombstone's revision must not be continued from"
    );

    // A live confirmed Classification at revision 9 *does* continue: the contrast is the
    // rule, not the number.
    connection
        .execute(
            "UPDATE classification_authority_revisions SET deleted = 0 WHERE classification_id = ?1",
            [&root],
        )
        .unwrap();
    assert_eq!(
        crate::library::classification_authority::predicted_classification_revision(
            &connection, &root
        )
        .unwrap(),
        10
    );
}

/// The assignment prediction reads the confirmed *assignment* lineage.
///
/// A Classification entity revision versions structure and appearance; it can never
/// satisfy an assignment compare-and-set, so a prediction that read it would present an
/// expectation the server's assignment command cannot match.
#[test]
fn a_prediction_reads_the_confirmed_assignment_lineage() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    insert_asset(&library, "asset-1");
    let connection = library.connection().unwrap();
    connection
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();
    // The authority confirmed an assignment for asset-1 at revision 4.
    connection
        .execute(
            "INSERT INTO classification_authority_assignment_revisions
                (asset_id, classification_id, entity_revision, updated_at)
             VALUES ('asset-1', ?1, 4, '2026-09-17T00:00:00Z')",
            [&root],
        )
        .unwrap();

    assert_eq!(
        crate::library::classification_authority::predicted_assignment_revision(
            &connection, "asset-1"
        )
        .unwrap(),
        4
    );
    assert_eq!(
        crate::library::classification_authority::predicted_assignment_revision(
            &connection, "never-seen"
        )
        .unwrap(),
        0,
        "an Asset the authority never mentioned is at revision 0"
    );
}

// ---------------------------------------------------------------------------
// Legacy relation replication cutover
// ---------------------------------------------------------------------------

/// Before adoption the relation-only legacy Asset upsert is still created.
#[test]
fn a_pre_adoption_assignment_still_creates_the_legacy_relation_upsert() {
    let (_temp, library) = open();
    let root = create_root(&library, "게임");
    asset_with_legacy_queue(&library, "asset-1");

    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(root),
        })
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
    // The relation is carried by the next Asset revision, exactly as before.
    assert_eq!(cloud_sync_queue_rows(&connection, "asset-1"), 2);
}

/// After adoption a Classification-only change creates the intent and **not** that upsert.
///
/// The Classification command owns the relation once the server does. A relation-only
/// Asset upsert would re-upload Asset metadata, advance the server's metadata revision
/// and converge nothing, because the activated replication lane no longer writes
/// `asset_classifications`.
#[test]
fn a_post_adoption_assignment_does_not_create_the_legacy_relation_upsert() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    asset_with_legacy_queue(&library, "asset-1");
    // Clear the create so the assignment is the only intent under test.
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(root),
        })
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(outbox(&connection).len(), 1);
    assert_eq!(outbox(&connection)[0].1, "setAssetClassification");
    assert_eq!(
        cloud_sync_queue_rows(&connection, "asset-1"),
        1,
        "only the pre-existing Asset row remains; no relation-only upsert is added"
    );
}

/// Asset metadata/media replication is not globally disabled by the Classification cutover.
///
/// Only the *relation-only* upsert this module used to write is removed. A real Asset
/// ingest must still create its replication row.
#[test]
fn ordinary_asset_replication_survives_classification_adoption() {
    let (temp, library) = open();
    adopt(&library, 1, 0);
    let source = temp.path().join("asset.png");
    std::fs::write(&source, png_bytes()).unwrap();

    let outcome = library
        .ingest_media(crate::library::models::IngestMediaRequest {
            source_path: source,
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: crate::library::models::ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-00000000000a".into(),
        })
        .unwrap();
    let crate::library::models::IngestOutcome::Added { asset } = outcome else {
        panic!("a fresh ingest must add an asset");
    };

    let connection = library.connection().unwrap();
    assert_eq!(
        cloud_sync_queue_rows(&connection, &asset.id),
        1,
        "Asset replication remains its own lane"
    );
    // ...and the ingest created no Classification intent, because it made no
    // Classification change.
    assert!(outbox(&connection).is_empty());
}

// ---------------------------------------------------------------------------
// patch_asset_classifications under authority
// ---------------------------------------------------------------------------

/// An adopted patch queues one desired-state command per changed Asset.
#[test]
fn an_adopted_patch_queues_one_final_desired_state_per_changed_asset() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    let other = create_root(&library, "다른");
    for id in ["asset-1", "asset-2"] {
        insert_asset(&library, id);
    }
    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(root.clone()),
        })
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    // Move asset-1 from `root` to `other`, and assign asset-2 to `other`.
    library
        .patch_asset_classifications(AssetClassificationPatch {
            asset_ids: vec!["asset-1".into(), "asset-2".into()],
            add_classification_ids: vec![other.clone()],
            remove_classification_ids: vec![root.clone()],
        })
        .unwrap();

    let connection = library.connection().unwrap();
    let queued = payloads(&connection);
    assert_eq!(queued.len(), 2);
    for body in &queued {
        assert_eq!(body["commandType"], "setAssetClassification");
        assert_eq!(body["classificationId"], other.as_str());
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = 'asset-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        other
    );
}

/// A patch that would leave several Classifications on one Asset fails locally.
///
/// The authority invariant is single-valued, so committing that state would create
/// something the contract cannot represent and no command could deliver.
#[test]
fn an_adopted_patch_that_leaves_two_classifications_fails_locally() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let first = create_root(&library, "첫째");
    let second = create_root(&library, "둘째");
    insert_asset(&library, "asset-1");
    library
        .set_asset_classification(SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(first.clone()),
        })
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    let error = library
        .patch_asset_classifications(AssetClassificationPatch {
            asset_ids: vec!["asset-1".into()],
            add_classification_ids: vec![second],
            remove_classification_ids: vec![],
        })
        .unwrap_err();

    assert!(matches!(error, LibraryError::InvalidAssetSelection));
    let connection = library.connection().unwrap();
    // Nothing was committed: the relation is unchanged and no intent was queued.
    assert!(outbox(&connection).is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = 'asset-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        first
    );
}

/// An adopted patch queues Character reconsideration for every changed Asset.
///
/// The receive half runs the same step for a change it applies, so skipping it on the
/// local path would leave recognition inputs stale for the user's own edits.
#[test]
fn an_adopted_patch_queues_character_reconsideration() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let root = create_root(&library, "게임");
    let series = library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Tag,
            name: "시리즈".into(),
            parent_id: Some(root.clone()),
        })
        .unwrap()
        .id;
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute_batch(&format!(
            "INSERT INTO character_series (classification_id, hero_asset_id, auto_classify)
                VALUES ('{series}', NULL, 1);"
        ))
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM classification_authority_outbox", [])
        .unwrap();

    library
        .patch_asset_classifications(AssetClassificationPatch {
            asset_ids: vec!["asset-1".into()],
            add_classification_ids: vec![series.clone()],
            remove_classification_ids: vec![],
        })
        .unwrap();

    let connection = library.connection().unwrap();
    let (state, cause) = connection
        .query_row(
            "SELECT state, cause FROM character_autotag_jobs WHERE asset_id = 'asset-1'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(state, "pending");
    assert_eq!(cause, "classification");
    assert_eq!(outbox(&connection).len(), 1);
}

/// A pre-adoption patch keeps its exact previous behavior, including no queue.
#[test]
fn a_pre_adoption_patch_is_unchanged() {
    let (_temp, library) = open();
    let root = create_root(&library, "게임");
    insert_asset(&library, "asset-1");
    library
        .patch_asset_classifications(AssetClassificationPatch {
            asset_ids: vec!["asset-1".into()],
            add_classification_ids: vec![root.clone()],
            remove_classification_ids: vec![],
        })
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = 'asset-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        root
    );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[test]
fn sync_status_separates_pending_from_confirmed() {
    let (_temp, library) = open();
    let status = library.classification_sync_status().unwrap();
    assert!(!status.adopted);
    assert_eq!(status.pending_count, 0);

    adopt(&library, 2, 12);
    let root = create_root(&library, "게임");
    library.rename_classification(&root, "게임2").unwrap();

    let status = library.classification_sync_status().unwrap();
    assert!(status.adopted);
    assert_eq!(status.library_id.as_deref(), Some(LIBRARY));
    assert_eq!(status.epoch, Some(2));
    assert_eq!(status.cursor, Some(12));
    assert_eq!(status.pending_count, 2);
    assert_eq!(status.blocked_count, 0);
    assert_eq!(
        status.oldest_pending_operation_id.as_deref(),
        Some(outbox(&library.connection().unwrap())[0].0.as_str())
    );
}

/// A flush with an empty queue is a no-op and must not require an authority.
#[test]
fn an_empty_queue_needs_no_authority_to_flush() {
    let (_temp, library) = open();
    let server = Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        // No request may arrive: with nothing queued there is nothing to send.
        let _ = server.recv_timeout(std::time::Duration::from_millis(300));
    });
    let client = CloudClient::new(&base).unwrap();
    let report = library
        .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
        .unwrap();
    handle.join().unwrap();
    assert_eq!(report.pending, 0);
    assert_eq!(report.sent, 0);
    assert!(!report.stopped);
}

// ---------------------------------------------------------------------------
// The send pass against a real HTTP server
// ---------------------------------------------------------------------------

mod integration {
    use super::*;

    fn json_response(value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    fn coded_response(status: u16, value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_status_code(status)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    fn read_body(request: &mut tiny_http::Request) -> serde_json::Value {
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        serde_json::from_str(&body).unwrap()
    }

    /// A credential source that records which secret each command class asked for.
    ///
    /// The OS store cannot be configured from a test, so this is what makes the
    /// "assignments never read the publisher secret" policy directly observable rather
    /// than an inference from a request that happened to be served.
    struct RecordingCredentials {
        client_token: String,
        publisher_token: Option<String>,
        publisher_reads: std::sync::atomic::AtomicU32,
    }

    impl RecordingCredentials {
        fn new(client_token: &str, publisher_token: Option<&str>) -> Self {
            Self {
                client_token: client_token.to_owned(),
                publisher_token: publisher_token.map(str::to_owned),
                publisher_reads: std::sync::atomic::AtomicU32::new(0),
            }
        }

        fn publisher_reads(&self) -> u32 {
            self.publisher_reads.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl crate::library::classification_authority::CredentialSource for RecordingCredentials {
        fn client(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError> {
            Ok(std::borrow::Cow::Borrowed(&self.client_token))
        }

        fn publisher(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError> {
            self.publisher_reads
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match &self.publisher_token {
                Some(token) => Ok(std::borrow::Cow::Borrowed(token)),
                None => Err(LibraryError::CloudCredentialNotConfigured),
            }
        }
    }

    /// One request the fixture received, with the credential it presented.
    #[derive(Debug, PartialEq)]
    struct Received {
        body: serde_json::Value,
        token: String,
    }

    /// The server's own accepted-result shape for the command a request carried.
    fn accepted_result(body: &serde_json::Value, revision: i64) -> serde_json::Value {
        let command = body["commandType"].as_str().unwrap();
        let classification = match command {
            "setAssetClassification" => serde_json::Value::Null,
            "deleteClassification" => serde_json::json!({
                "id": body["classificationId"],
                "kind": "root",
                "name": "삭제됨",
                "parentId": null,
                "iconKey": null,
                "colorKey": null,
                "deleted": true,
                "entityRevision": revision
            }),
            _ => serde_json::json!({
                "id": body["classificationId"],
                "kind": body.get("kind").and_then(|value| value.as_str()).unwrap_or("root"),
                "name": body.get("name").and_then(|value| value.as_str()).unwrap_or("이름"),
                "parentId": body.get("parentId").cloned().unwrap_or(serde_json::Value::Null),
                "iconKey": body.get("iconKey").cloned().unwrap_or(serde_json::Value::Null),
                "colorKey": body.get("colorKey").cloned().unwrap_or(serde_json::Value::Null),
                "deleted": false,
                "entityRevision": revision
            }),
        };
        let assignments = if command == "setAssetClassification" {
            vec![serde_json::json!({
                "assetId": body["assetId"],
                "classificationId": body["classificationId"],
                "entityRevision": revision.max(1)
            })]
        } else {
            Vec::new()
        };
        let transition = (command == "deleteClassification").then(|| {
            serde_json::json!({
                "fromClassificationId": body["classificationId"],
                "toClassificationId": null,
                "affectsAssignments": 0
            })
        });
        serde_json::json!({
            "libraryId": body["libraryId"],
            "epoch": body["epoch"],
            "contractVersion": body["contractVersion"],
            "commandType": command,
            "operationId": body["operationId"],
            "changed": true,
            "changeSequence": revision,
            "authorityCursor": revision,
            "classification": classification,
            "assignments": assignments,
            "assignmentTransition": transition,
            "updatedAt": "2026-09-17T00:00:00Z"
        })
    }

    /// A server that accepts every command, recording the body and credential it saw.
    ///
    /// Requests are reported over a channel rather than a shared lock: the fixture needs
    /// an ordered log owned by the server thread and read by the test, which a channel
    /// expresses directly.
    fn accepting_server(library_id: String) -> (String, mpsc::Receiver<Received>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            for revision in 1..=8i64 {
                // Serving stops on an idle gap, because the flush legitimately stops early
                // when the queue is blocked or drained before this bound.
                let Ok(Some(mut request)) = server.recv_timeout(std::time::Duration::from_millis(500))
                else {
                    return;
                };
                assert_eq!(request.method(), &Method::Put);
                let token = request
                    .headers()
                    .iter()
                    .find(|header| {
                        header.field.to_string().eq_ignore_ascii_case("Authorization")
                    })
                    .map(|header| header.value.as_str().to_owned())
                    .unwrap_or_default();
                let body = read_body(&mut request);
                if sender
                    .send(Received { body: body.clone(), token })
                    .is_err()
                {
                    return;
                }
                let mut result = accepted_result(&body, revision);
                result["libraryId"] = library_id.clone().into();
                request.respond(json_response(result)).unwrap();
            }
        });
        (base, receiver, handle)
    }

    /// A server that answers every command with one specific coded rejection.
    ///
    /// Serving stops on an idle gap: every caller of this fixture sends exactly one
    /// command, because a rejection ends the pass.
    fn coded_rejection_server(
        code: &'static str,
        status: u16,
        current: Option<serde_json::Value>,
    ) -> (String, mpsc::Receiver<Received>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            loop {
                let Ok(Some(mut request)) = server.recv_timeout(std::time::Duration::from_millis(300))
                else {
                    return;
                };
                let body = read_body(&mut request);
                if sender
                    .send(Received { body: body.clone(), token: String::new() })
                    .is_err()
                {
                    return;
                }
                let mut detail = serde_json::json!({ "code": code, "authorityCursor": 4 });
                if let Some(current) = &current {
                    detail["current"] = current.clone();
                }
                request
                    .respond(coded_response(status, serde_json::json!({ "detail": detail })))
                    .unwrap();
            }
        });
        (base, receiver, handle)
    }

    /// Drain everything the fixture reported, in order.
    fn received(receiver: &mpsc::Receiver<Received>) -> Vec<Received> {
        receiver.try_iter().collect()
    }

    /// The full send path: each intent sent oldest-first, retired exactly once.
    ///
    /// The bytes sent are the bytes stored, operation id included, which is what makes a
    /// lost response resolvable instead of a second logical write.
    #[test]
    fn a_flush_sends_every_intent_in_order_and_retires_it() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        let child = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "하위".into(),
                parent_id: Some(root.clone()),
            })
            .unwrap()
            .id;
        insert_asset(&library, "asset-1");
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(child.clone()),
            })
            .unwrap();
        library.rename_classification(&child, "하위2").unwrap();

        let queued = outbox(&library.connection().unwrap());
        assert_eq!(
            queued.iter().map(|(_, kind, _)| kind.as_str()).collect::<Vec<_>>(),
            [
                "createClassification",
                "createClassification",
                "setAssetClassification",
                "renameClassification"
            ]
        );

        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 4);
        assert_eq!(report.pending, 0);
        assert_eq!(report.blocked, 0);
        assert!(!report.stopped);
        assert!(outbox(&library.connection().unwrap()).is_empty());

        let sent = received(&receiver);
        assert_eq!(
            sent.iter()
                .map(|received| received.body["commandType"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "createClassification",
                "createClassification",
                "setAssetClassification",
                "renameClassification"
            ]
        );
        for (received, (operation_id, _, payload)) in sent.iter().zip(queued.iter()) {
            assert_eq!(received.body["operationId"].as_str().unwrap(), operation_id);
            let stored: serde_json::Value = serde_json::from_str(payload).unwrap();
            assert_eq!(received.body, stored);
        }

        // Only the confirmed revision cache is updated by the send half; the visible
        // materialization is the receive half's job.
        let connection = library.connection().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT entity_revision FROM classification_authority_revisions
                     WHERE classification_id = ?1",
                    [&child],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            4
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT entity_revision FROM classification_authority_assignment_revisions
                     WHERE asset_id = 'asset-1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
    }

    /// The credential split is enforced by the caller, per command class.
    ///
    /// Structural commands present the publisher token; an assignment presents the client
    /// token. Neither substitutes for the other, and an assignment must not require the
    /// publisher credential merely to be delivered.
    #[test]
    fn structural_commands_use_the_publisher_token_and_assignments_the_client_token() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root.clone()),
            })
            .unwrap();
        library.rename_classification(&root, "게임2").unwrap();

        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        let sent = received(&receiver);
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].body["commandType"], "createClassification");
        assert_eq!(sent[0].token, "Bearer publisher-token");
        assert_eq!(sent[1].body["commandType"], "setAssetClassification");
        assert_eq!(sent[1].token, "Bearer client-token");
        assert_eq!(sent[2].body["commandType"], "renameClassification");
        assert_eq!(sent[2].token, "Bearer publisher-token");
    }

    /// An assignment-only queue is deliverable without the publisher credential.
    ///
    /// Requiring it would make an ordinary personal action depend on a publication secret
    /// it has nothing to do with.
    #[test]
    fn an_assignment_only_queue_needs_no_publisher_credential() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();

        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        // An empty publisher token is not a valid bearer credential, so a pass that
        // resolved one would fail before sending anything.
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "")
            .unwrap();
        handle.join().unwrap();
        assert_eq!(report.sent, 1);
        assert_eq!(received(&receiver)[0].token, "Bearer client-token");
    }

    /// A 200 describing another operation is a protocol failure, not an acceptance.
    #[test]
    fn an_acceptance_for_another_operation_is_refused_and_the_intent_survives() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            let Ok(Some(mut request)) = server.recv_timeout(std::time::Duration::from_secs(10))
            else {
                return;
            };
            let body = read_body(&mut request);
            let mut result = accepted_result(&body, 1);
            result["operationId"] = "00000000-0000-4000-8000-0000000000ff".into();
            result["libraryId"] = LIBRARY.into();
            request.respond(json_response(result)).unwrap();
        });

        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));

        let connection = library.connection().unwrap();
        assert_eq!(outbox(&connection).len(), 1, "the intent must stay deliverable");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM classification_authority_revisions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
            "no revision from a mismatched echo may reach the confirmed cache"
        );
    }

    /// A 200 whose target entity disagrees with the stored intent is refused.
    #[test]
    fn an_acceptance_for_another_entity_is_refused() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            let Ok(Some(mut request)) = server.recv_timeout(std::time::Duration::from_secs(10))
            else {
                return;
            };
            let body = read_body(&mut request);
            let mut result = accepted_result(&body, 1);
            result["libraryId"] = LIBRARY.into();
            result["classification"]["id"] = "00000000-0000-4000-8000-00000000dead".into();
            request.respond(json_response(result)).unwrap();
        });

        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
        assert_eq!(outbox(&library.connection().unwrap()).len(), 1);
    }

    /// A 200 for the wrong library, epoch, contract or command type is refused.
    #[test]
    fn an_acceptance_with_a_wrong_envelope_is_refused() {
        for (field, value) in [
            ("libraryId", serde_json::json!("0f9e8d7c6b5a4938271605f4e3d2c1b0")),
            ("epoch", serde_json::json!(9)),
            ("contractVersion", serde_json::json!(9)),
            ("commandType", serde_json::json!("renameClassification")),
        ] {
            let (_temp, library) = open();
            adopt(&library, 1, 0);
            create_root(&library, "게임");

            let server = Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://{}/v1", server.server_addr());
            let handle = thread::spawn(move || {
                let Ok(Some(mut request)) =
                    server.recv_timeout(std::time::Duration::from_secs(10))
                else {
                    return;
                };
                let body = read_body(&mut request);
                let mut result = accepted_result(&body, 1);
                result["libraryId"] = LIBRARY.into();
                result[field] = value;
                request.respond(json_response(result)).unwrap();
            });

            let client = CloudClient::new(&base).unwrap();
            let error = library
                .flush_classification_outbox_with_credentials(
                    &client,
                    "client-token",
                    "publisher-token",
                )
                .unwrap_err();
            handle.join().unwrap();
            assert!(
                matches!(error, LibraryError::InvalidCloudResponse),
                "{field} mismatch must be refused"
            );
            assert_eq!(
                outbox(&library.connection().unwrap()).len(),
                1,
                "{field} mismatch must leave the intent durable"
            );
        }
    }

    /// A structural rejection blocks the intent durably and stops delivery.
    #[test]
    fn a_structural_rejection_blocks_the_queue_and_keeps_the_local_edit() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        library.rename_classification(&root, "게임2").unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "DELETE FROM classification_authority_outbox WHERE command_type = 'createClassification'",
                [],
            )
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO classification_authority_outbox
                    (operation_id, command_type, classification_id, epoch, payload, state, created_at)
                 VALUES ('00000000-0000-4000-8000-0000000000aa', 'moveClassification', ?1, 1,
                         '{\"libraryId\":\"x\"}', 'pending', '2026-09-17T00:00:00Z')",
                [&root],
            )
            .unwrap();

        let (base, receiver, handle) = coded_rejection_server("revisionConflict", 409, None);
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.blocked, 1);
        assert!(report.stopped);
        assert_eq!(
            received(&receiver).len(),
            1,
            "a blocked queue sends nothing more"
        );

        let connection = library.connection().unwrap();
        let (state, code, command) = connection
            .query_row(
                "SELECT state, conflict_code, command_type FROM classification_authority_outbox
                 WHERE command_type = 'renameClassification'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(state, "blocked");
        assert_eq!(code, "revisionConflict");
        assert_eq!(command, "renameClassification");
        // The user's rename is still what they see.
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM classification_entries WHERE id = ?1",
                    [&root],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "게임2"
        );
    }

    /// A row already blocked stops the pass without sending anything at all.
    ///
    /// A later intent may depend on the blocked one, so delivery must stop there — and it
    /// must stop *before* any request, not after failing on it.
    #[test]
    fn a_pre_blocked_row_stops_delivery_without_sending() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        library.rename_classification(&root, "게임2").unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE classification_authority_outbox
                 SET state = 'blocked', conflict_code = 'revisionConflict'",
                [],
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            // No request may arrive: the queue is already unresolved.
            let _ = server.recv_timeout(std::time::Duration::from_millis(300));
        });
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert!(report.stopped);
        assert_eq!(report.sent, 0);
        assert_eq!(report.blocked, 2);
        assert_eq!(outbox(&library.connection().unwrap()).len(), 2);
    }

    /// Every semantic structural rejection blocks, and never becomes a retry loop.
    #[test]
    fn semantic_structural_rejections_block_the_intent_durably() {
        for (code, status) in [
            ("duplicateClassificationName", 409u16),
            ("classificationCycle", 422),
            ("classificationHasChildren", 409),
            ("classificationExists", 409),
            ("classificationNotFound", 404),
            ("invalidClassificationParent", 422),
            ("protectedClassification", 409),
        ] {
            let (_temp, library) = open();
            adopt(&library, 1, 0);
            create_root(&library, "게임");

            let (base, receiver, handle) = coded_rejection_server(code, status, None);
            let client = CloudClient::new(&base).unwrap();
            let report = library
                .flush_classification_outbox_with_credentials(
                    &client,
                    "client-token",
                    "publisher-token",
                )
                .unwrap();
            handle.join().unwrap();

            assert_eq!(report.blocked, 1, "{code} must block, not retry");
            assert!(report.stopped, "{code} must stop the FIFO pass");
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT conflict_code FROM classification_authority_outbox",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                code
            );
        }
    }

    /// An assignment `revisionConflict` rebases only the expectation and keeps the intent.
    #[test]
    fn an_assignment_revision_conflict_rebases_only_the_expected_revision() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root.clone()),
            })
            .unwrap();
        let queued = outbox(&library.connection().unwrap());

        let (base, receiver, handle) = coded_rejection_server(
            "revisionConflict",
            409,
            Some(serde_json::json!({
                "assetId": "asset-1",
                "classificationId": null,
                "entityRevision": 7
            })),
        );
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.rebased, 1);
        assert_eq!(report.blocked, 0, "a rebase is not a conflict");
        assert!(report.stopped, "the pass stops so the next one retries the same row");
        assert_eq!(received(&receiver).len(), 1);

        let connection = library.connection().unwrap();
        let (operation_id, command_type, payload) = &outbox(&connection)[0];
        assert_eq!(command_type, "setAssetClassification");
        // The same logical intent: same operation id, same command, same Asset, same
        // desired value, same epoch. Only the expectation moved.
        assert_eq!(operation_id, &queued[0].0);
        let body: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(body["operationId"], queued[0].0.as_str());
        assert_eq!(body["commandType"], "setAssetClassification");
        assert_eq!(body["assetId"], "asset-1");
        assert_eq!(body["classificationId"], root.as_str());
        assert_eq!(body["epoch"], 1);
        assert_eq!(body["expectedRevision"], 7);
    }

    /// A rebased row then succeeds on the next pass, and retires exactly once.
    #[test]
    fn a_rebased_row_succeeds_on_the_next_pass() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root.clone()),
            })
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            // First attempt: stale revision. Second attempt: accept.
            for attempt in 0..2 {
                let Ok(Some(mut request)) =
                    server.recv_timeout(std::time::Duration::from_secs(10))
                else {
                    return;
                };
                let body = read_body(&mut request);
                if sender
                    .send(Received { body: body.clone(), token: String::new() })
                    .is_err()
                {
                    return;
                }
                if attempt == 0 {
                    request
                        .respond(coded_response(
                            409,
                            serde_json::json!({ "detail": {
                                "code": "revisionConflict",
                                "authorityCursor": 2,
                                "current": {
                                    "assetId": "asset-1",
                                    "classificationId": null,
                                    "entityRevision": 5
                                }
                            }}),
                        ))
                        .unwrap();
                    continue;
                }
                // The retry must present the rebased expectation.
                assert_eq!(body["expectedRevision"], 5);
                let mut result = accepted_result(&body, 6);
                result["libraryId"] = LIBRARY.into();
                request.respond(json_response(result)).unwrap();
            }
        });

        let client = CloudClient::new(&base).unwrap();
        let first = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(first.rebased, 1);
        let second = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(second.sent, 1);
        assert!(outbox(&library.connection().unwrap()).is_empty());
        assert_eq!(received(&receiver).len(), 2);
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT entity_revision FROM classification_authority_assignment_revisions
                     WHERE asset_id = 'asset-1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            6
        );
    }

    /// A rebase body describing another Asset is refused rather than applied.
    #[test]
    fn a_rebase_for_another_asset_is_refused() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();

        let (base, receiver, handle) = coded_rejection_server(
            "revisionConflict",
            409,
            Some(serde_json::json!({
                "assetId": "asset-other",
                "classificationId": null,
                "entityRevision": 7
            })),
        );
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));

        let connection = library.connection().unwrap();
        let (state, payload) = {
            let (operation_id, command_type, payload) = outbox(&connection).remove(0);
            let _ = (operation_id, command_type);
            let body: serde_json::Value = serde_json::from_str(&payload).unwrap();
            (
                connection
                    .query_row(
                        "SELECT state FROM classification_authority_outbox",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
                body,
            )
        };
        assert_eq!(state, "pending");
        // The expectation was not rewritten from a foreign body.
        assert_eq!(payload["expectedRevision"], 0);
    }

    /// A transient `invalidClassificationAssignment` stays pending and stops the pass.
    ///
    /// The Asset exists locally and this intent is queued, but Asset replication has not
    /// reached the server yet. Blocking would permanently refuse a legitimate intent on a
    /// condition that resolves itself.
    #[test]
    fn a_transient_invalid_assignment_stays_pending() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();

        let (base, receiver, handle) = coded_rejection_server("invalidClassificationAssignment", 422, None);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(
            error,
            LibraryError::ClassificationCommandOutcomeUnknown
        ));

        let connection = library.connection().unwrap();
        let (state, code): (String, Option<String>) = connection
            .query_row(
                "SELECT state, conflict_code FROM classification_authority_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending", "a self-resolving state must not block");
        assert_eq!(code, None);
    }

    /// An authority mismatch is a typed error, never a stored user conflict.
    #[test]
    fn an_authority_mismatch_is_not_stored_as_a_structural_conflict() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");

        let (base, receiver, handle) = coded_rejection_server("authorityLibraryMismatch", 409, None);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::ClassificationAuthorityMismatch));

        let connection = library.connection().unwrap();
        let (state, code): (String, Option<String>) = connection
            .query_row(
                "SELECT state, conflict_code FROM classification_authority_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending", "an identity problem is not a user conflict");
        assert_eq!(code, None);
    }

    /// `operationConflict` is an integrity failure, not a user-visible conflict.
    #[test]
    fn an_operation_conflict_is_an_integrity_error_not_a_user_conflict() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");

        let (base, receiver, handle) = coded_rejection_server("operationConflict", 409, None);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::ClassificationOperationConflict));
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT conflict_code FROM classification_authority_outbox",
                    [],
                    |row| row.get::<_, Option<String>>(0)
                )
                .unwrap(),
            None
        );
    }

    /// An uncoded rejection stays retryable rather than becoming a contract upgrade.
    #[test]
    fn an_unrecognized_rejection_stays_retryable() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");

        let (base, receiver, handle) = coded_rejection_server("somethingNew", 422, None);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(
            error,
            LibraryError::ClassificationCommandOutcomeUnknown
        ));
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT state FROM classification_authority_outbox",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
    }

    /// A malformed command is its own state, not a contract upgrade.
    #[test]
    fn a_malformed_command_is_distinct_from_a_contract_upgrade() {
        for code in [
            "invalidClassificationCommand",
            "invalidClassificationRevision",
            "invalidClassificationKind",
            "invalidClassificationAppearance",
        ] {
            let (_temp, library) = open();
            adopt(&library, 1, 0);
            create_root(&library, "게임");

            let (base, receiver, handle) = coded_rejection_server(code, 422, None);
            let client = CloudClient::new(&base).unwrap();
            let error = library
                .flush_classification_outbox_with_credentials(
                    &client,
                    "client-token",
                    "publisher-token",
                )
                .unwrap_err();
            handle.join().unwrap();
            match error {
                LibraryError::ClassificationCommandRejected { code: rejected } => {
                    assert_eq!(rejected, code)
                }
                other => panic!("{code} mapped to {other:?}"),
            }
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT state FROM classification_authority_outbox",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "pending",
                "{code} must leave the intent deliverable"
            );
        }
    }

    /// An intent composed under another epoch is blocked, never silently re-pointed.
    #[test]
    fn an_epoch_mismatch_blocks_rather_than_rebasing() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");
        // The authority moved to a new epoch.
        library
            .adopt_classification_authority_for_test(LIBRARY, 2, 1, 0)
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            // No request may arrive: the mismatch is decided from local state.
            let _ = server.recv_timeout(std::time::Duration::from_millis(300));
        });
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.blocked, 1);
        assert!(report.stopped);
        let connection = library.connection().unwrap();
        let (state, code, epoch) = connection
            .query_row(
                "SELECT state, conflict_code, epoch FROM classification_authority_outbox",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(state, "blocked");
        assert_eq!(code, "epochMismatch");
        assert_eq!(epoch, 1, "the stored intent keeps the epoch it was composed in");
    }

    /// A retry after a lost response resends identical bytes and applies exactly once.
    #[test]
    fn a_lost_response_is_resolved_by_resending_the_same_operation() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();
        let queued = outbox(&library.connection().unwrap());

        // The server accepts and records the command, but the response is lost.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let body = read_body(&mut request);
            // Recorded server-side, then the connection drops without a usable body.
            request.respond(Response::empty(500)).unwrap();
            if sender.send(Received { body, token: String::new() }).is_err() {
                return;
            }

            // The retry is resolved by the durable receipt.
            let mut request = server.recv().unwrap();
            let retry = read_body(&mut request);
            if sender
                .send(Received { body: retry.clone(), token: String::new() })
                .is_err()
            {
                return;
            }
            let mut result = accepted_result(&retry, 9);
            result["libraryId"] = LIBRARY.into();
            request.respond(json_response(result)).unwrap();
        });

        let client = CloudClient::new(&base).unwrap();
        assert!(library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .is_err());
        // The intent survived with its identity and payload intact.
        let connection = library.connection().unwrap();
        let after_loss = outbox(&connection);
        assert_eq!(after_loss.len(), 1);
        assert_eq!(after_loss[0].0, queued[0].0);
        assert_eq!(after_loss[0].2, queued[0].2);
        assert!(connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_assignment_revisions",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap()
            .eq(&0));
        drop(connection);

        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 1);
        assert!(outbox(&library.connection().unwrap()).is_empty());
        let sent = received(&receiver);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], sent[1], "a retry must resend the stored bytes");
        // The confirmed cache is written once, from the durable receipt.
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT entity_revision FROM classification_authority_assignment_revisions
                     WHERE asset_id = 'asset-1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            9
        );
    }

    /// An accepted no-op at revision 0 must not create an invalid revision-cache row.
    #[test]
    fn an_accepted_no_op_null_at_revision_zero_writes_no_assignment_row() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        insert_asset(&library, "asset-1");
        // The Asset has no assignment, so the local desired value is already null and no
        // intent is queued. Queue one by hand so the no-op acceptance path is exercised.
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO classification_authority_outbox
                    (operation_id, command_type, classification_id, asset_id, epoch, payload, state, created_at)
                 VALUES ('00000000-0000-4000-8000-0000000000bb', 'setAssetClassification',
                         NULL, 'asset-1', 1,
                         '{\"libraryId\":\"a1b2c3d4e5f60718293a4b5c6d7e8f90\",\"epoch\":1,\"contractVersion\":1,\"operationId\":\"00000000-0000-4000-8000-0000000000bb\",\"commandType\":\"setAssetClassification\",\"classificationId\":null,\"assetId\":\"asset-1\",\"expectedRevision\":0}',
                         'pending', '2026-09-17T00:00:00Z')",
                [],
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let _ = read_body(&mut request);
            // The authority already held the desired (unassigned) state, and reports the
            // never-seen lineage as unassigned at revision 0.
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY,
                    "epoch": 1,
                    "contractVersion": 1,
                    "commandType": "setAssetClassification",
                    "operationId": "00000000-0000-4000-8000-0000000000bb",
                    "changed": false,
                    "changeSequence": null,
                    "authorityCursor": 0,
                    "classification": null,
                    "assignments": [{
                        "assetId": "asset-1",
                        "classificationId": null,
                        "entityRevision": 0
                    }],
                    "assignmentTransition": null,
                    "updatedAt": "2026-09-17T00:00:00Z"
                })))
                .unwrap();
        });

        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.no_op, 1);
        assert!(outbox(&library.connection().unwrap()).is_empty());
        // "No row" is the representation of authoritative unassigned revision 0, so a
        // revision-0 result must not create the distinct, incomparable row.
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM classification_authority_assignment_revisions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    /// A delete ahead of an assignment converges through the assignment rebase.
    ///
    /// This is exactly the sequence the automatic rebase exists for: the delete reaches
    /// the server first (strict FIFO), the server increments every assignment lineage that
    /// named the deleted Classification, and the assignment composed against the pre-delete
    /// revision conflicts **once** and then succeeds with the same operation id.
    #[test]
    fn a_delete_ahead_of_an_assignment_converges_through_the_rebase() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        let doomed = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "삭제될".into(),
                parent_id: Some(root.clone()),
            })
            .unwrap()
            .id;
        insert_asset(&library, "asset-1");
        // Adopt and clear the creates so the queue under test is exactly the user's two
        // real intents, in the order they were made.
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        // 1. asset-1 is assigned to `doomed` — composed against assignment revision 0.
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(doomed.clone()),
            })
            .unwrap();
        // 2. `doomed` is deleted. Strict FIFO puts the delete *after* the assignment.
        library.delete_classification(&doomed).unwrap();
        let queued = outbox(&library.connection().unwrap());
        assert_eq!(
            queued.iter().map(|(_, kind, _)| kind.as_str()).collect::<Vec<_>>(),
            ["setAssetClassification", "deleteClassification"],
        );
        // The assignment's expectation is not recomputed after the fact: it is the queued
        // intent under test, and the delete ahead of it is exactly what makes it stale.
        let assignment_body: serde_json::Value = serde_json::from_str(&queued[0].2).unwrap();
        assert_eq!(assignment_body["expectedRevision"], 0);
        let clear_body: serde_json::Value = serde_json::from_str(&queued[1].2).unwrap();
        assert_eq!(clear_body["commandType"], "deleteClassification");
        assert_eq!(clear_body["classificationId"], doomed.as_str());

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            // 1. The assignment is sent first (strict FIFO) and is stale, because the
            //    server already incremented the lineage for the delete it will record next.
            //    Its expectation (0) predates the revision the delete produces.
            let mut request = server.recv().unwrap();
            let assignment = read_body(&mut request);
            assert_eq!(assignment["commandType"], "setAssetClassification");
            assert_eq!(assignment["expectedRevision"], 0);
            if sender
                .send(Received { body: assignment.clone(), token: String::new() })
                .is_err()
            {
                return;
            }
            request
                .respond(coded_response(
                    409,
                    serde_json::json!({ "detail": {
                        "code": "revisionConflict",
                        "authorityCursor": 0,
                        "current": {
                            "assetId": "asset-1",
                            "classificationId": null,
                            "entityRevision": 5
                        }
                    }}),
                ))
                .unwrap();

            // 2. The same logical intent retries against the revision the delete produced.
            let mut request = server.recv().unwrap();
            let retry = read_body(&mut request);
            assert_eq!(retry["operationId"], assignment["operationId"]);
            assert_eq!(retry["expectedRevision"], 5);
            if sender
                .send(Received { body: retry.clone(), token: String::new() })
                .is_err()
            {
                return;
            }
            let mut result = accepted_result(&retry, 1);
            result["libraryId"] = LIBRARY.into();
            request.respond(json_response(result)).unwrap();

            // 3. The delete reaches the server and is accepted.
            let mut request = server.recv().unwrap();
            let delete = read_body(&mut request);
            assert_eq!(delete["commandType"], "deleteClassification");
            if sender
                .send(Received { body: delete.clone(), token: String::new() })
                .is_err()
            {
                return;
            }
            let mut result = accepted_result(&delete, 2);
            result["libraryId"] = LIBRARY.into();
            request.respond(json_response(result)).unwrap();
        });

        let client = CloudClient::new(&base).unwrap();
        let first = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        // The stale assignment rebased rather than blocking, so the pass stopped there.
        assert_eq!(first.rebased, 1);
        assert_eq!(first.blocked, 0);
        assert_eq!(first.sent, 0);

        let second = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        // The rebased assignment was delivered, and the delete behind it followed.
        assert_eq!(second.sent, 2);
        assert_eq!(second.pending, 0);
        handle.join().unwrap();

        assert!(outbox(&library.connection().unwrap()).is_empty());

        let sent = received(&receiver);
        assert_eq!(sent.len(), 3);
        // The same logical intent appears twice, with only its expectation changed between
        // the attempts — no second intent was minted.
        assert_eq!(sent[0].body["operationId"], queued[0].0.as_str());
        assert_eq!(sent[1].body["operationId"], queued[0].0.as_str());
        assert_eq!(sent[0].body["expectedRevision"], 0);
        assert_eq!(sent[1].body["expectedRevision"], 5);
        assert_eq!(sent[1].body["classificationId"], doomed.as_str());
        // The delete the user made was delivered with its own identity.
        assert_eq!(sent[2].body["commandType"], "deleteClassification");
        assert_eq!(sent[2].body["operationId"], queued[1].0.as_str());
        // Accepting the delete moved the confirmed lineage the same way the server did:
        // asset-1 no longer names `doomed` and its revision incremented once. The cache
        // must describe the authority's post-delete state, not the deleted name — a cache
        // still naming `doomed` would make the deferred-assignment projection refuse the
        // very change that corrects it.
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT classification_id, entity_revision
                     FROM classification_authority_assignment_revisions
                     WHERE asset_id = 'asset-1'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, i64>(1)?,
                        ))
                    },
                )
                .unwrap(),
            (None, 2)
        );
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT entity_revision FROM classification_authority_revisions
                     WHERE classification_id = ?1",
                    [&doomed],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }

    /// A malformed stored payload is refused rather than re-encoded and sent.
    #[test]
    fn a_payload_this_build_cannot_read_is_not_sent() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO classification_authority_outbox
                    (operation_id, command_type, classification_id, epoch, payload, state, created_at)
                 VALUES ('00000000-0000-4000-8000-0000000000cc', 'createClassification',
                         'x', 1, '\"not-an-object\"', 'pending', '2026-09-17T00:00:00Z')",
                [],
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            let _ = server.recv_timeout(std::time::Duration::from_millis(300));
        });
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
        assert_eq!(outbox(&library.connection().unwrap()).len(), 1);
    }

    /// The send loop never reads the publisher credential for an assignment-only queue.
    ///
    /// This is the property the production entry point depends on, and it is asserted at
    /// the seam where the policy lives: the pass is handed a credential source that fails
    /// if the publisher secret is ever requested. An assignment is an ordinary client
    /// operation, so a user who has never configured a publisher secret — the normal state
    /// for anyone who does not publish a catalog — must still be able to organize folders.
    #[test]
    fn an_assignment_only_queue_never_reads_the_publisher_credential() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();

        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        let source = RecordingCredentials::new("client-token", None);
        let report = library
            .flush_classification_outbox_with_source(&client, &source)
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 1);
        assert_eq!(
            source.publisher_reads(),
            0,
            "an assignment-only queue must never touch the publisher secret"
        );
        assert_eq!(received(&receiver)[0].token, "Bearer client-token");
    }

    /// A structural command resolves the publisher credential exactly once, at send time.
    #[test]
    fn a_structural_command_reads_the_publisher_credential_at_send_time() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root.clone()),
            })
            .unwrap();
        library.rename_classification(&root, "게임2").unwrap();

        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        let source = RecordingCredentials::new("client-token", Some("publisher-token"));
        let report = library
            .flush_classification_outbox_with_source(&client, &source)
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 2);
        assert_eq!(source.publisher_reads(), 1, "resolved once, for the structural row");
        let sent = received(&receiver);
        assert_eq!(sent[0].body["commandType"], "setAssetClassification");
        assert_eq!(sent[0].token, "Bearer client-token");
        assert_eq!(sent[1].body["commandType"], "renameClassification");
        assert_eq!(sent[1].token, "Bearer publisher-token");
    }

    /// A missing publisher credential preserves the structural intent as pending.
    #[test]
    fn a_missing_publisher_credential_preserves_the_structural_intent() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        create_root(&library, "게임");

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            // No request may arrive: the credential is resolved before the send.
            let _ = server.recv_timeout(std::time::Duration::from_millis(300));
        });
        let client = CloudClient::new(&base).unwrap();
        let source = RecordingCredentials::new("client-token", None);
        let error = library
            .flush_classification_outbox_with_source(&client, &source)
            .unwrap_err();
        handle.join().unwrap();

        assert!(
            matches!(error, LibraryError::CloudCredentialNotConfigured),
            "a missing publisher credential is its own error: {error:?}"
        );
        let connection = library.connection().unwrap();
        let (state, code): (String, Option<String>) = connection
            .query_row(
                "SELECT state, conflict_code FROM classification_authority_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending", "a credential problem is not a user conflict");
        assert_eq!(code, None);
    }

    /// A structural command later in the queue still resolves its own credential.
    ///
    /// The pass continues past accepted assignment rows, so a credential decision taken
    /// once from the queue's head would send the structural command with the client token
    /// and have the server refuse it. This pins per-row selection rather than
    /// once-per-pass selection.
    #[test]
    fn a_structural_command_behind_an_assignment_uses_the_publisher_token() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        // The assignment is queued *first*, so the structural command is not the head.
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root.clone()),
            })
            .unwrap();
        library.rename_classification(&root, "게임2").unwrap();

        let queued = outbox(&library.connection().unwrap());
        assert_eq!(
            queued.iter().map(|(_, kind, _)| kind.as_str()).collect::<Vec<_>>(),
            ["setAssetClassification", "renameClassification"]
        );

        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 2);
        let sent = received(&receiver);
        assert_eq!(sent[0].body["commandType"], "setAssetClassification");
        assert_eq!(sent[0].token, "Bearer client-token");
        assert_eq!(sent[1].body["commandType"], "renameClassification");
        assert_eq!(sent[1].token, "Bearer publisher-token");
    }

    /// Concurrent delivery callers share one pass per domain.
    ///
    /// Single-flight has to be a property of the *domain*, not of one caller: several
    /// independent callers deliver the same queue — a mutation-triggered kick, the periodic
    /// sync hook, and focus/online events — so coalescing only the kick still let it overlap a
    /// running background pass. Two overlapping passes read the same snapshot of the queue and
    /// both send the same row, which the server's operation-id receipt makes idempotent but
    /// does not make free.
    ///
    /// This holds the first pass inside its HTTP response, starts a second caller while it is
    /// held, and proves only one request was ever delivered for the one queued row.
    #[test]
    fn concurrent_delivery_callers_never_double_send_one_row() {
        use std::sync::{Arc, Barrier};

        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();

        // The server parks inside the first response until the test releases it, so the second
        // caller provably arrives while a pass is genuinely in flight.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let deliveries = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let count = Arc::clone(&deliveries);
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            loop {
                let Ok(Some(mut request)) =
                    server.recv_timeout(std::time::Duration::from_millis(600))
                else {
                    return;
                };
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = read_body(&mut request);
                // Only the very first delivery is held; later ones answer immediately so a
                // follow-up pass can finish.
                if count.load(std::sync::atomic::Ordering::SeqCst) == 1 {
                    let _ = release_rx.recv_timeout(std::time::Duration::from_secs(10));
                }
                let mut result = accepted_result(&body, 5);
                result["libraryId"] = LIBRARY.into();
                let _ = request.respond(json_response(result));
            }
        });

        let shared = Arc::new(library);
        let client = Arc::new(CloudClient::new(&base).unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let worker_a = {
            let shared = Arc::clone(&shared);
            let client = Arc::clone(&client);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                shared
                    .flush_classification_outbox_with_credentials(
                        &client,
                        "client-token",
                        "publisher-token",
                    )
                    .map(|report| report.sent)
            })
        };
        let worker_b = {
            let shared = Arc::clone(&shared);
            let client = Arc::clone(&client);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                // Give the first pass time to reach the server and park.
                thread::sleep(std::time::Duration::from_millis(200));
                shared
                    .flush_classification_outbox_with_credentials(
                        &client,
                        "client-token",
                        "publisher-token",
                    )
                    .map(|report| report.sent)
            })
        };

        // Release the held response once the second caller has had time to arrive.
        thread::sleep(std::time::Duration::from_millis(400));
        let _ = release_tx.send(());
        let first = worker_a.join().unwrap();
        let second = worker_b.join().unwrap();
        handle.join().unwrap();

        // Exactly one delivery reached the server for the single queued intent.
        assert_eq!(
            deliveries.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "two callers must not each send the same queued row"
        );
        // The pass that actually delivered reports the send; the other observed an empty
        // queue afterwards, which is the coalesced outcome rather than a second delivery.
        let sent = first.unwrap_or(0) + second.unwrap_or(0);
        assert_eq!(sent, 1, "exactly one caller reports the delivered intent");
        assert!(outbox(&shared.connection().unwrap()).is_empty());
    }

    /// A failed pass must not leave the domain unable to deliver later work.
    ///
    /// The gate is held across the whole pass, so a failure has to release it like any other
    /// exit. If a transport error kept the gate, every later caller would block forever and the
    /// queue would silently stop draining.
    #[test]
    fn a_failed_delivery_pass_does_not_suppress_later_delivery() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let root = create_root(&library, "게임");
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM classification_authority_outbox", [])
            .unwrap();
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some(root),
            })
            .unwrap();

        // No server is listening, so the first pass fails on transport.
        let dead = CloudClient::new("http://127.0.0.1:9/v1").unwrap();
        let failed = library
            .flush_classification_outbox_with_credentials(&dead, "client-token", "publisher-token");
        assert!(failed.is_err(), "an unreachable authority fails the pass");
        assert_eq!(
            outbox(&library.connection().unwrap()).len(),
            1,
            "the intent stays durable across the failure"
        );

        // A later pass against a working authority must still deliver it.
        let (base, receiver, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        handle.join().unwrap();
        assert_eq!(report.sent, 1, "the gate was released by the failed pass");
        assert_eq!(received(&receiver).len(), 1);
        assert!(outbox(&library.connection().unwrap()).is_empty());
    }
}
