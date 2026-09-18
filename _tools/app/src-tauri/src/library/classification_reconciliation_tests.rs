//! PC 2B regression coverage: the Classification receive half.
//!
//! These tests exercise the production apply paths (`install_classification_baseline`,
//! `apply_classification_page`, `materialize_deferred_classification_assignments`) and
//! the real durable rows. The transport is covered by the integration module at the
//! bottom, which drives the real `CloudClient` over a real socket.
//!
//! `Library::connection()` takes a non-reentrant database mutex, so no assertion block
//! below calls a second accessor while it holds a connection guard.

use rusqlite::Connection;

use crate::cloud::client::{
    ClassificationAssignmentProjection, ClassificationAssignmentTransition, ClassificationChange,
    ClassificationProjection, ClassificationRoleProjection,
};
use crate::library::error::LibraryError;
use crate::library::models::SetAssetClassification;
use crate::library::Library;

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_LIBRARY: &str = "0f9e8d7c6b5a4938271605f4e3d2c1b0";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn open() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    // Migrations 0058/0060 seed a protected Originals root (`lakomics-originals`) and
    // its `originals` role into every new library. Each test below states the exact
    // Classification state it means to reconcile, so the fixture starts from a known
    // empty table rather than from whatever the migration chain happens to seed.
    library
        .connection()
        .unwrap()
        .execute_batch("DELETE FROM classification_roles; DELETE FROM classification_entries;")
        .unwrap();
    (temp, library)
}

fn insert_asset(library: &Library, id: &str) {
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (?1, ?2, 'image', 'asset.png', ?3, ?4, 1, 1, 1,
                '2026-09-16T00:00:00Z')",
            rusqlite::params![
                id,
                format!("hash-{id}"),
                format!("assets/{id}.png"),
                format!("thumbnails/{id}.webp"),
            ],
        )
        .unwrap();
}

fn classification(
    id: &str,
    name: &str,
    parent: Option<&str>,
    revision: i64,
) -> ClassificationProjection {
    ClassificationProjection {
        id: id.to_owned(),
        kind: if parent.is_none() { "root" } else { "tag" }.to_owned(),
        name: name.to_owned(),
        parent_id: parent.map(str::to_owned),
        icon_key: None,
        color_key: None,
        deleted: false,
        entity_revision: revision,
    }
}

fn tombstone(id: &str, name: &str, revision: i64) -> ClassificationProjection {
    ClassificationProjection {
        id: id.to_owned(),
        kind: "root".to_owned(),
        name: name.to_owned(),
        parent_id: None,
        icon_key: None,
        color_key: None,
        deleted: true,
        entity_revision: revision,
    }
}

fn assignment(
    asset_id: &str,
    classification_id: Option<&str>,
    revision: i64,
) -> ClassificationAssignmentProjection {
    ClassificationAssignmentProjection {
        asset_id: asset_id.to_owned(),
        classification_id: classification_id.map(str::to_owned),
        entity_revision: revision,
    }
}

fn originals(id: &str) -> ClassificationRoleProjection {
    ClassificationRoleProjection {
        role: "originals".to_owned(),
        classification_id: id.to_owned(),
    }
}

fn classification_change(sequence: i64, value: ClassificationProjection) -> ClassificationChange {
    ClassificationChange {
        sequence,
        authority_cursor: sequence,
        command_type: "renameClassification".to_owned(),
        operation_id: format!("op-{sequence}"),
        changed_at: "2026-09-16T00:00:00Z".to_owned(),
        classification: Some(value),
        assignment: None,
        assignment_transition: None,
    }
}

fn assignment_change(
    sequence: i64,
    value: ClassificationAssignmentProjection,
) -> ClassificationChange {
    ClassificationChange {
        sequence,
        authority_cursor: sequence,
        command_type: "setAssetClassification".to_owned(),
        operation_id: format!("op-{sequence}"),
        changed_at: "2026-09-16T00:00:00Z".to_owned(),
        classification: None,
        assignment: Some(value),
        assignment_transition: None,
    }
}

fn delete_change(
    sequence: i64,
    value: ClassificationProjection,
    transition: ClassificationAssignmentTransition,
) -> ClassificationChange {
    delete_change_for_operation(sequence, value, transition, &format!("op-{sequence}"))
}

/// One delete change naming a *specific* operation id.
///
/// A confirmed delete's durable record is keyed by the operation id the change names, so a
/// test that wants replay to match that record has to present the same id — the default
/// `op-{sequence}` deliberately does not, which keeps tests that are not about pre-application
/// on the "no record" path.
fn delete_change_for_operation(
    sequence: i64,
    value: ClassificationProjection,
    transition: ClassificationAssignmentTransition,
    operation_id: &str,
) -> ClassificationChange {
    ClassificationChange {
        sequence,
        authority_cursor: sequence,
        command_type: "deleteClassification".to_owned(),
        operation_id: operation_id.to_owned(),
        changed_at: "2026-09-16T00:00:00Z".to_owned(),
        classification: Some(value),
        assignment: None,
        assignment_transition: Some(transition),
    }
}

fn transition(from: &str, to: Option<&str>, affects: i64) -> ClassificationAssignmentTransition {
    ClassificationAssignmentTransition {
        from_classification_id: from.to_owned(),
        to_classification_id: to.map(str::to_owned),
        affects_assignments: affects,
    }
}

// ---------------------------------------------------------------------------
// Local readers
// ---------------------------------------------------------------------------

fn entries(connection: &Connection) -> Vec<(String, String, String, Option<String>)> {
    let mut statement = connection
        .prepare("SELECT id, kind, name, parent_id FROM classification_entries ORDER BY id")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn projections(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare("SELECT asset_id, classification_id FROM asset_classifications ORDER BY asset_id")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn roles(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare("SELECT role, classification_id FROM classification_roles ORDER BY role")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn authority(connection: &Connection) -> Option<(String, i64, i64, i64)> {
    connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor
             FROM classification_authority_sync WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()
}

fn revision_cache(connection: &Connection) -> Vec<(String, i64, i64)> {
    let mut statement = connection
        .prepare(
            "SELECT classification_id, entity_revision, deleted
             FROM classification_authority_revisions ORDER BY classification_id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn assignment_cache(connection: &Connection) -> Vec<(String, Option<String>, i64)> {
    let mut statement = connection
        .prepare(
            "SELECT asset_id, classification_id, entity_revision
             FROM classification_authority_assignment_revisions ORDER BY asset_id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

/// How many durable pre-applied-delete records survive.
///
/// A record is written when this PC confirms a delete command and retired when that delete's
/// change is replayed, so its count says whether the pre-application accounting is live,
/// already consumed, or restored by a page rollback.
fn preapplied_delete_records(connection: &Connection) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

/// Every durable Classification intent currently queued, oldest first.
///
/// The receive half must never create one of these: remote apply writes the replica and
/// the revision caches only, so the two halves cannot form a loop.
fn outbox_rows(connection: &Connection) -> Vec<(String, String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, command_type, payload
             FROM classification_authority_outbox ORDER BY seq",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

/// Pin the local library identity so a scripted server can legitimately match it.
///
/// Migration 0079 mints a random identity, and the reconciliation refuses a remote
/// authority whose library id differs from this PC's, so a matching case must state the
/// identity it is matching.
fn pin_library_id(library: &Library) {
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE library_settings SET library_id = ?1 WHERE singleton = 1",
            [LIBRARY],
        )
        .unwrap();
}

/// Adopt an authority through the production install path, then return the library.
fn adopt_one_root(library: &Library, cursor: i64) {
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            cursor,
        )
        .unwrap();
}

/// Make `id` an Asset that Character reconsideration actually applies to.
///
/// `character_autotag::enqueue` is deliberately a no-op for an Asset that is not a
/// normal image or that resolves to no Character scope, so a test that wants to observe
/// a queued reconsideration has to build both.
fn make_character_eligible(library: &Library, id: &str, series: &str) {
    let connection = library.connection().unwrap();
    connection
        .execute(
            "UPDATE assets SET media_kind = 'image', status = 'normal' WHERE id = ?1",
            [id],
        )
        .unwrap();
    // The series root must sit outside the `originals` role subtree: Character scope
    // resolution excludes that whole subtree, so a series under it would make every
    // enqueue a no-op and the test would prove nothing.
    connection
        .execute(
            "INSERT OR IGNORE INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES (?1, 'root', ?1, NULL, '2026-09-16T00:00:00Z')",
            [series],
        )
        .unwrap();
    connection
        .execute(
            "INSERT OR IGNORE INTO character_series (classification_id, auto_classify)
             VALUES (?1, 1)",
            [series],
        )
        .unwrap();
}

/// The Asset's durable Character reconsideration job, if one exists.
fn character_job(connection: &Connection, asset_id: &str) -> Option<(String, String, String)> {
    connection
        .query_row(
            "SELECT state, cause, classification_ids FROM character_autotag_jobs
             WHERE asset_id = ?1",
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
}

/// Any legacy relation-replication intent queued for an Asset.
fn cloud_queue_rows(connection: &Connection, asset_id: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_id = ?1",
            [asset_id],
            |row| row.get(0),
        )
        .unwrap()
}

// ---------------------------------------------------------------------------
// 1. Migration creates empty receive tables and no adoption
// ---------------------------------------------------------------------------

#[test]
fn the_migration_creates_empty_receive_tables_and_adopts_nothing() {
    let (_temp, library) = open();
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
    assert!(revision_cache(&connection).is_empty());
    assert!(assignment_cache(&connection).is_empty());
    // Migration 0084 creates the durable command outbox, empty. The adopted authority
    // is the adoption marker, so an unadopted library still queues nothing.
    assert!(outbox_rows(&connection).is_empty());
}

// ---------------------------------------------------------------------------
// 36. The receive path never creates outgoing work
// ---------------------------------------------------------------------------

#[test]
fn the_receive_batch_creates_no_classification_outbox() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let connection = library.connection().unwrap();
    // Remote apply is receive-only: adopting a baseline writes the replica and the
    // revision caches, and mints no intent. This is what keeps the two halves from
    // forming a loop.
    assert!(outbox_rows(&connection).is_empty());
    // Migration 0082's Album outbox is untouched and still exists.
    let album_outbox: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
               AND name = 'album_authority_outbox'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(album_outbox, 1);
}

// ---------------------------------------------------------------------------
// 35. Pre-adoption Classification behavior is unchanged
// ---------------------------------------------------------------------------

#[test]
fn pre_adoption_classification_behavior_is_unchanged() {
    let (_temp, library) = open();
    // A local mutation before any adoption still writes the product tables directly and
    // queues nothing Classification-authority related.
    let created = library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Root,
            name: "업로드".to_owned(),
            parent_id: None,
        })
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
    assert!(entries(&connection)
        .iter()
        .any(|(id, _, name, _)| id == &created.id && name == "업로드"));
    assert!(outbox_rows(&connection).is_empty());
}

// ---------------------------------------------------------------------------
// 5/9. Exact first adoption succeeds and does not rewrite product tables
// ---------------------------------------------------------------------------

/// Exact first adoption must write **zero** product-table rows.
///
/// The strongest available proof is to make any such write fail: these triggers abort
/// every INSERT/UPDATE/DELETE on the three product tables, so an adoption that touched
/// them could not possibly succeed. The adoption therefore passing is evidence it wrote
/// only the durable authority metadata and revision caches.
#[test]
fn an_exact_first_adoption_performs_no_product_table_writes() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    // A Character series with derived state, so an unnecessary rewrite would have
    // something real to damage.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('franchise', 'root', '작품군', NULL, '2026-09-16T00:00:00Z');
             INSERT INTO classification_roles (role, classification_id)
             VALUES ('originals', 'originals');
             INSERT INTO asset_classifications (asset_id, classification_id)
             VALUES ('asset-1', 'franchise');
             INSERT INTO character_series (classification_id) VALUES ('franchise');
             CREATE TRIGGER guard_classification_entries
               BEFORE INSERT ON classification_entries
               BEGIN SELECT RAISE(ABORT, 'product write: classification_entries'); END;
             CREATE TRIGGER guard_classification_entries_update
               BEFORE UPDATE ON classification_entries
               BEGIN SELECT RAISE(ABORT, 'product write: classification_entries'); END;
             CREATE TRIGGER guard_classification_entries_delete
               BEFORE DELETE ON classification_entries
               BEGIN SELECT RAISE(ABORT, 'product write: classification_entries'); END;
             CREATE TRIGGER guard_asset_classifications
               BEFORE INSERT ON asset_classifications
               BEGIN SELECT RAISE(ABORT, 'product write: asset_classifications'); END;
             CREATE TRIGGER guard_asset_classifications_delete
               BEFORE DELETE ON asset_classifications
               BEGIN SELECT RAISE(ABORT, 'product write: asset_classifications'); END;
             CREATE TRIGGER guard_classification_roles
               BEFORE INSERT ON classification_roles
               BEGIN SELECT RAISE(ABORT, 'product write: classification_roles'); END;
             CREATE TRIGGER guard_classification_roles_delete
               BEFORE DELETE ON classification_roles
               BEGIN SELECT RAISE(ABORT, 'product write: classification_roles'); END;",
        )
        .unwrap();

    library
        .adopt_first_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .expect("an exact first adoption writes no product tables, so no guard may fire");

    let connection = library.connection().unwrap();
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 4)),
        "the adoption marker records the identity and cursor"
    );
    assert_eq!(
        revision_cache(&connection),
        [
            ("franchise".to_owned(), 1, 0),
            ("originals".to_owned(), 1, 0)
        ]
    );
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), Some("franchise".to_owned()), 1)]
    );
    // Product state is exactly what it was before the adoption.
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "franchise".to_owned())]);
    assert_eq!(roles(&connection), [("originals".to_owned(), "originals".to_owned())]);
    assert_eq!(
        entries(&connection),
        [
            ("franchise".to_owned(), "root".to_owned(), "작품군".to_owned(), None),
            ("originals".to_owned(), "root".to_owned(), "오리지널".to_owned(), None),
        ]
    );
    let character_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM character_series WHERE classification_id = 'franchise'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(character_rows, 1, "Character state was not disturbed");
}

/// The comparison and the metadata write now share one transaction, so the adoption row
/// can never describe a state the comparison did not actually see.
#[test]
fn a_first_adoption_failure_leaves_no_authority_row() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '다른 이름', NULL, '2026-09-16T00:00:00Z');
             INSERT INTO classification_roles (role, classification_id)
             VALUES ('originals', 'originals');",
        )
        .unwrap();
    let error = library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::ClassificationFirstAdoptionMismatch
    ));
    let connection = library.connection().unwrap();
    assert!(
        authority(&connection).is_none(),
        "a refused adoption must leave no marker for a later pass to build on"
    );
    assert!(revision_cache(&connection).is_empty());
    assert!(assignment_cache(&connection).is_empty());
}

#[test]
fn a_first_adoption_hierarchy_mismatch_writes_nothing() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('series', 'tag', '다른 이름', 'originals', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    let error = library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::ClassificationFirstAdoptionMismatch
    ));
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
    assert!(revision_cache(&connection).is_empty());
    // The mismatching local row was not "fixed" by the comparison.
    assert!(entries(&connection).iter().any(|(_, _, name, _)| name == "다른 이름"));
}

// ---------------------------------------------------------------------------
// 7. First adoption assignment mismatch fails atomically
// ---------------------------------------------------------------------------

#[test]
fn a_first_adoption_assignment_mismatch_writes_nothing() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications (asset_id, classification_id) VALUES ('asset-1', 'originals')",
            [],
        )
        .unwrap();
    // The role is made to match, so the assignment comparison is the only difference
    // left: otherwise an earlier rule would report the mismatch and this test would not
    // actually exercise the assignment rule.
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'originals')",
            [],
        )
        .unwrap();
    let error = library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::ClassificationFirstAdoptionMismatch
    ));
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
    assert_eq!(
        projections(&connection),
        [("asset-1".to_owned(), "originals".to_owned())]
    );
}

// ---------------------------------------------------------------------------
// 7b. A trashed Asset keeps its assignment, so first adoption still matches
// ---------------------------------------------------------------------------

#[test]
fn first_adoption_compares_assignments_for_trashed_assets_too() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status = 'trash' WHERE id = 'asset-1'", [])
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications (asset_id, classification_id) VALUES ('asset-1', 'originals')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'originals')",
            [],
        )
        .unwrap();
    // Classification assignment deliberately survives local trash, so a status filter
    // would have reported a false mismatch here.
    library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap();
}

// ---------------------------------------------------------------------------
// 8. First adoption role mismatch fails atomically
// ---------------------------------------------------------------------------

/// A baseline assignment for an Asset this PC does not hold must fail first adoption.
///
/// The authority was activated from this PC's own staged snapshot, so a non-null
/// assignment naming an Asset that is now absent locally means local canonical state
/// changed after staging. Accepting it would adopt that divergence silently.
#[test]
fn a_first_adoption_assignment_for_a_locally_absent_asset_is_a_mismatch() {
    let (_temp, library) = open();
    // Structure and role match the baseline exactly; only the extra assignment differs.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z');
             INSERT INTO classification_roles (role, classification_id)
             VALUES ('originals', 'originals');",
        )
        .unwrap();
    let error = library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            // `absent-elsewhere` is not in local `assets` at all.
            &[assignment("absent-elsewhere", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::ClassificationFirstAdoptionMismatch
    ));
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
    assert!(revision_cache(&connection).is_empty());
    assert!(assignment_cache(&connection).is_empty());
    assert!(entries(&connection).iter().any(|(id, _, _, _)| id == "originals"));
}

/// An explicit null row is effective unassigned state, so it corresponds to no local
/// relation and must not be read as a missing assignment.
#[test]
fn a_first_adoption_null_assignment_row_is_effective_unassigned_state() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z');
             INSERT INTO classification_roles (role, classification_id)
             VALUES ('originals', 'originals');",
        )
        .unwrap();
    library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", None, 3)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            5,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), None, 3)],
        "the null row is cached as revision state"
    );
    assert!(projections(&connection).is_empty());
}

#[test]
fn a_first_adoption_role_mismatch_writes_nothing() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('other', 'root', '기타', NULL, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'other')",
            [],
        )
        .unwrap();
    let error = library
        .adopt_first_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1),
                classification("other", "기타", None, 1),],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::ClassificationFirstAdoptionMismatch
    ));
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
    assert_eq!(roles(&connection), [("originals".to_owned(), "other".to_owned())]);
}

// ---------------------------------------------------------------------------
// 10. Multi-page frozen baseline installs only after the final complete page
// ---------------------------------------------------------------------------

#[test]
fn a_baseline_materializes_live_state_and_caches_every_revision() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    insert_asset(&library, "asset-2");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 3),
                classification("series", "시리즈", Some("originals"), 2),
                tombstone("gone", "삭제됨", 5),
            ],
            &[
                assignment("asset-1", Some("series"), 4),
                assignment("asset-2", None, 7),
            ],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        entries(&connection),
        [
            ("originals".to_owned(), "root".to_owned(), "오리지널".to_owned(), None),
            (
                "series".to_owned(),
                "tag".to_owned(),
                "시리즈".to_owned(),
                Some("originals".to_owned())
            ),
        ],
        "a tombstoned Classification has no live local row"
    );
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "series".to_owned())]);
    assert_eq!(
        revision_cache(&connection),
        [
            ("gone".to_owned(), 5, 1),
            ("originals".to_owned(), 3, 0),
            ("series".to_owned(), 2, 0),
        ],
        "tombstones stay in the cache so a later command presents a real revision"
    );
    assert_eq!(
        assignment_cache(&connection),
        [
            ("asset-1".to_owned(), Some("series".to_owned()), 4),
            // A NULL classification id is an authoritative unassigned state at a real
            // revision, not "never seen".
            ("asset-2".to_owned(), None, 7),
        ]
    );
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 9))
    );
}

// ---------------------------------------------------------------------------
// 23. Assignment to a missing Asset is cached, not rejected
// ---------------------------------------------------------------------------

#[test]
fn an_assignment_for_an_unmaterialized_asset_is_cached() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("not-here", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        assignment_cache(&connection),
        [("not-here".to_owned(), Some("originals".to_owned()), 1)]
    );
    assert!(
        projections(&connection).is_empty(),
        "the visible row is withheld until the Asset exists locally"
    );
}

// ---------------------------------------------------------------------------
// 24. Deferred assignment materializes when that Asset later appears
// ---------------------------------------------------------------------------

#[test]
fn a_deferred_assignment_materializes_when_the_asset_appears() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("later", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    assert_eq!(library.materialize_deferred_classification_assignments().unwrap(), 0);
    insert_asset(&library, "later");
    assert_eq!(library.materialize_deferred_classification_assignments().unwrap(), 1);
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("later".to_owned(), "originals".to_owned())]);
    // The recovery step is a local projection only: no revision, no cursor movement.
    assert_eq!(
        assignment_cache(&connection),
        [("later".to_owned(), Some("originals".to_owned()), 1)]
    );
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
}

// ---------------------------------------------------------------------------
// 24b. The idle pass keeps an unchanged replica to one statement
// ---------------------------------------------------------------------------

/// A converged replica does no per-Asset Rust-side work, however many assignments it holds.
///
/// The deferred-materialization step runs on every foreground pass, so its no-op path must not
/// issue per-row point queries. Before this it swept the whole cache and ran three point queries
/// per row — around 24k statements for 8k assignments — on every idle tick. The improvement is
/// that the work moved into one set-based candidate query, not that the pass stopped touching
/// the confirmed rows at all.
#[test]
fn a_converged_replica_visits_no_assignments() {
    let (_temp, library) = open();
    const COUNT: usize = 2_000;
    for index in 0..COUNT {
        insert_asset(&library, &format!("asset-{index:05}"));
    }
    // Install the authority's own view of those Assets, so the replica starts converged:
    // the projection this baseline makes *is* the authoritative value for every row.
    let assignments: Vec<ClassificationAssignmentProjection> = (0..COUNT)
        .map(|index| assignment(&format!("asset-{index:05}"), Some("originals"), 1))
        .collect();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &assignments,
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            7,
        )
        .unwrap();
    assert_eq!(
        library.deferred_assignment_work_for_test().unwrap(),
        0,
        "a converged pass must visit nothing"
    );
    assert_eq!(library.materialize_deferred_classification_assignments().unwrap(), 0);
    assert_eq!(
        library.deferred_assignment_work_for_test().unwrap(),
        0,
        "the pass itself must not create work to redo"
    );
}

/// Only the Asset whose projection is actually wrong is visited.
///
/// This is the property that makes the set-based selection equivalent to the per-row check
/// it replaced: the visited set is exactly the rows that would change, plus the corrupt rows
/// that must fail closed.
#[test]
fn only_the_diverged_assignment_is_visited() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("stale", "예전", Some("originals"), 1),
            ],
            &[
                assignment("settled", Some("originals"), 1),
                assignment("diverged", Some("originals"), 1),
                assignment("cleared", None, 2),
                assignment("deferred", Some("originals"), 1),
            ],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    insert_asset(&library, "settled");
    insert_asset(&library, "diverged");
    insert_asset(&library, "cleared");
    // `deferred` deliberately has no local Asset yet: withholding it *is* the deferred
    // state, so it must not be visited even though its projection is "wrong".
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications (asset_id, classification_id)
             VALUES ('settled', 'originals'), ('diverged', 'stale'), ('cleared', 'stale')",
            [],
        )
        .unwrap();
    assert_eq!(
        library.deferred_assignment_work_for_test().unwrap(),
        2,
        "`diverged` and `cleared` owe work; `settled` and the unmaterialized `deferred` do not"
    );
    assert_eq!(library.materialize_deferred_classification_assignments().unwrap(), 2);
    {
        let connection = library.connection().unwrap();
        assert_eq!(
            projections(&connection),
            [
                ("diverged".to_owned(), "originals".to_owned()),
                ("settled".to_owned(), "originals".to_owned()),
            ],
            "`cleared` loses its stale relation and `diverged` is rewritten to the authoritative value"
        );
    }
    assert_eq!(library.deferred_assignment_work_for_test().unwrap(), 0);
}

/// A newly-arrived Asset still receives its previously-deferred authoritative assignment.
///
/// The set-based path must not lose the recovery the full sweep provided: the row becomes
/// eligible exactly when the Asset appears.
#[test]
fn a_newly_arrived_asset_becomes_visible_work() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("later", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    assert_eq!(library.deferred_assignment_work_for_test().unwrap(), 0);
    insert_asset(&library, "later");
    assert_eq!(library.deferred_assignment_work_for_test().unwrap(), 1);
    assert_eq!(library.materialize_deferred_classification_assignments().unwrap(), 1);
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("later".to_owned(), "originals".to_owned())]);
}

/// A corrupt cached assignment is still refused rather than silently skipped.
///
/// The selection is a superset of the writes precisely so this row is visited and
/// `project_assignment` can fail closed on it, exactly as the per-row sweep did.
#[test]
fn a_corrupt_assignment_is_still_selected_and_refused() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_authority_assignment_revisions
                (asset_id, classification_id, entity_revision, updated_at)
             VALUES ('asset-1', 'absent', 1, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    assert_eq!(
        library.deferred_assignment_work_for_test().unwrap(),
        1,
        "an assignment naming an absent Classification must still be visited"
    );
    let error = library
        .materialize_deferred_classification_assignments()
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
}

#[test]
fn a_deferred_null_assignment_clears_a_stale_local_relation() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    // A relation exists, and the authority's confirmed value for that Asset is
    // *unassigned*: the projection is stale and must be cleared.
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications (asset_id, classification_id) VALUES ('asset-1', 'originals')",
            [],
        )
        .unwrap();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", None, 2)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    library.materialize_deferred_classification_assignments().unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), None, 2)]
    );
}

// ---------------------------------------------------------------------------
// 15/16. Strict sequence contiguity and atomic page/cursor commit
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. Received assignment changes queue Character reconsideration
// ---------------------------------------------------------------------------

/// A received assignment change is semantically the same change a local edit makes, so it
/// must queue Character reconsideration for the Asset it moved — and nothing else.
///
/// `originals` and everything under it are deliberately *outside* Character scope
/// (`resolve_character_scope` excludes the whole role subtree), so `franchise` is a
/// separate root registered as a Character series: moving an Asset onto it is a real
/// reconsideration, while moving to `series` under `originals` would be a no-op.
#[test]
fn a_received_assignment_change_queues_character_reconsideration() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("series"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    {
        let connection = library.connection().unwrap();
        assert!(
            character_job(&connection, "asset-1").is_none(),
            "adopting the matching local state is not itself a change"
        );
    }
    // The authority moves the Asset from an out-of-scope folder onto a Character series.
    library
        .apply_classification_page_for_test(
            &[assignment_change(2, assignment("asset-1", Some("franchise"), 2))],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    let (state, cause, classifications) =
        character_job(&connection, "asset-1").expect("received change must queue reconsideration");
    assert_eq!(state, "pending");
    assert_eq!(cause, "classification");
    assert!(
        classifications.contains("franchise"),
        "the queued job carries the new classification: {classifications}"
    );
    // Receive-only: no send work of any kind is created.
    assert_eq!(cloud_queue_rows(&connection, "asset-1"), 0);
    assert!(outbox_rows(&connection).is_empty());
}

/// An authoritative unassign takes the Asset out of every Character scope, so the receive
/// path must run the same Character step a local unassign runs — superseding existing
/// work rather than leaving it claiming a resolution no worker can produce.
#[test]
fn a_received_unassign_runs_the_character_step() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_classification_page_for_test(
            &[assignment_change(2, assignment("asset-1", None, 2))],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    // A queued job must not survive the change as `pending`, because the Asset can no
    // longer resolve to any Character scope.
    if let Some((state, _, _)) = character_job(&connection, "asset-1") {
        assert_eq!(state, "superseded");
    }
    assert_eq!(cloud_queue_rows(&connection, "asset-1"), 0);
}

#[test]
fn a_delete_transition_queues_character_reconsideration_for_affected_assets() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("tagger", "태그", Some("franchise"), 1),
            ],
            &[assignment("asset-1", Some("tagger"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // Deleting the tag moves its Assets up to `franchise`, which *is* the Character series.
    library
        .apply_classification_page_for_test(
            &[delete_change(
                2,
                tombstone("tagger", "태그", 2),
                transition("tagger", Some("franchise"), 1),
            )],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "franchise".to_owned())]);
    let (state, cause, classifications) = character_job(&connection, "asset-1")
        .expect("the transition moved this Asset's assignment, so reconsideration is owed");
    assert_eq!(state, "pending");
    assert_eq!(cause, "classification");
    assert!(classifications.contains("franchise"), "{classifications}");
    assert_eq!(cloud_queue_rows(&connection, "asset-1"), 0);
}

/// Deferred materialization must be **one** transaction for every projection it makes.
///
/// Two Assets both need their stale relation replaced. The injected failure fires only on
/// the *second* Asset, after the first has already been reconciled — the exact situation a
/// per-Asset commit could not recover from, since the first Asset's new relation and the
/// second's stale one would both survive. One transaction means neither change is visible.
#[test]
fn deferred_materialization_rolls_back_every_projection_on_failure() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    insert_asset(&library, "asset-2");
    make_character_eligible(&library, "asset-1", "franchise");
    make_character_eligible(&library, "asset-2", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("stale", "예전", None, 1),
            ],
            // The authority's confirmed values differ from the local relations below.
            &[
                assignment("asset-1", Some("franchise"), 5),
                assignment("asset-2", Some("franchise"), 6),
            ],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    // Installing already applied those values, which is not what this test is about:
    // start from a clean slate where both projections are stale.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "DELETE FROM character_autotag_jobs;
             UPDATE asset_classifications SET classification_id = 'stale'
               WHERE asset_id IN ('asset-1', 'asset-2');
             CREATE TRIGGER fail_second_asset_character_step
               BEFORE INSERT ON character_autotag_jobs
               WHEN NEW.asset_id = 'asset-2'
               BEGIN SELECT RAISE(ABORT, 'later reconciliation step failed'); END;",
        )
        .unwrap();
    let error = library
        .materialize_deferred_classification_assignments()
        .unwrap_err();
    assert!(
        matches!(&error, LibraryError::Database(_)),
        "the injected failure must surface: {error:?}"
    );
    {
        let connection = library.connection().unwrap();
        assert_eq!(
            projections(&connection),
            [
                ("asset-1".to_owned(), "stale".to_owned()),
                ("asset-2".to_owned(), "stale".to_owned()),
            ],
            "the first Asset's new relation must roll back with the second Asset's failure"
        );
        assert!(character_job(&connection, "asset-1").is_none());
        // The caches and cursor are authority state, untouched either way.
        assert_eq!(
            assignment_cache(&connection),
            [
                ("asset-1".to_owned(), Some("franchise".to_owned()), 5),
                ("asset-2".to_owned(), Some("franchise".to_owned()), 6),
            ]
        );
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
        connection
            .execute("DROP TRIGGER fail_second_asset_character_step", [])
            .unwrap();
    }
    // With the injected failure removed, the same projection completes for both Assets and
    // each ends holding exactly one Classification — never both at once.
    assert_eq!(
        library.materialize_deferred_classification_assignments().unwrap(),
        2
    );
    let connection = library.connection().unwrap();
    assert_eq!(
        projections(&connection),
        [
            ("asset-1".to_owned(), "franchise".to_owned()),
            ("asset-2".to_owned(), "franchise".to_owned()),
        ]
    );
}

#[test]
fn an_assignment_cached_for_a_missing_asset_queues_nothing_yet() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    library
        .apply_classification_page_for_test(
            &[assignment_change(1, assignment("absent", Some("originals"), 1))],
            1,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    assert_eq!(
        character_job(&connection, "absent"),
        None,
        "there is no local Asset to reconsider"
    );
    assert_eq!(cloud_queue_rows(&connection, "absent"), 0);
}

#[test]
fn deferred_materialization_queues_character_reconsideration_when_the_asset_appears() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            // The authority already assigned an Asset this PC had not materialized.
            &[assignment("later", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    assert_eq!(
        library.materialize_deferred_classification_assignments().unwrap(),
        0
    );
    insert_asset(&library, "later");
    make_character_eligible(&library, "later", "franchise");
    assert_eq!(
        library.materialize_deferred_classification_assignments().unwrap(),
        1
    );
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("later".to_owned(), "franchise".to_owned())]);
    let (state, cause, _) = character_job(&connection, "later")
        .expect("the deferred projection changed this Asset's assignment");
    assert_eq!(state, "pending");
    assert_eq!(cause, "classification");
    assert_eq!(cloud_queue_rows(&connection, "later"), 0);
}

#[test]
fn an_idempotent_assignment_projection_queues_no_character_work() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // Installing the baseline materialized an assignment that had no local relation, so
    // it legitimately queued work. Clear that (as a completed pass would) to isolate what
    // the *re-projection* alone contributes.
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_autotag_jobs", [])
        .unwrap();
    // Re-projecting the same authoritative value is not a change.
    library
        .apply_classification_page_for_test(
            &[assignment_change(2, assignment("asset-1", Some("franchise"), 2))],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "franchise".to_owned())]);
    assert_eq!(
        character_job(&connection, "asset-1"),
        None,
        "no visible change means no derived work"
    );
    // The revision cache still advances, because that is authority state, not a change
    // to the Asset's assignment.
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), Some("franchise".to_owned()), 2)]
    );
}

#[test]
fn a_received_change_creates_no_legacy_replication_intent() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("series"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    let before = {
        let connection = library.connection().unwrap();
        connection
            .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    library
        .apply_classification_page_for_test(
            &[assignment_change(2, assignment("asset-1", Some("franchise"), 2))],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    let after = connection
        .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(
        after, before,
        "the receive path must not enqueue legacy replication work"
    );
}

#[test]
fn a_change_page_applies_and_advances_the_cursor_together() {
    let (_temp, library) = open();
    adopt_one_root(&library, 3);
    library
        .apply_classification_page_for_test(
            &[
                classification_change(4, classification("series", "시리즈", Some("originals"), 1)),
                assignment_change(5, assignment("asset-1", Some("series"), 1)),
            ],
            5,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 5)));
    assert!(entries(&connection)
        .iter()
        .any(|(id, _, name, _)| id == "series" && name == "시리즈"));
    // The assignment named an Asset that does not exist locally, so it is cached only.
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), Some("series".to_owned()), 1)]
    );
}

#[test]
fn a_gap_in_the_change_sequence_rolls_back_the_page_and_the_cursor() {
    let (_temp, library) = open();
    adopt_one_root(&library, 3);
    let error = library
        .apply_classification_page_for_test(
            &[
                classification_change(4, classification("series", "시리즈", Some("originals"), 1)),
                // 6 skips 5.
                classification_change(6, classification("other", "기타", Some("originals"), 1)),
            ],
            6,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 3)),
        "the cursor must not advance over a change that was not applied"
    );
    assert!(
        !entries(&connection).iter().any(|(id, _, _, _)| id == "series"),
        "the applied part of the page is rolled back with it"
    );
}

#[test]
fn a_repeated_change_sequence_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 3);
    let error = library
        .apply_classification_page_for_test(
            &[
                classification_change(4, classification("series", "시리즈", Some("originals"), 1)),
                classification_change(4, classification("other", "기타", Some("originals"), 1)),
            ],
            4,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
}

#[test]
fn a_backwards_change_sequence_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 3);
    let error = library
        .apply_classification_page_for_test(
            &[
                classification_change(4, classification("series", "시리즈", Some("originals"), 1)),
                classification_change(3, classification("other", "기타", Some("originals"), 1)),
            ],
            4,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
}

#[test]
fn a_page_that_stops_short_of_its_cursor_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 3);
    let error = library
        .apply_classification_page_for_test(
            &[classification_change(4, classification("series", "시리즈", Some("originals"), 1))],
            6,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
    assert!(!entries(&connection).iter().any(|(id, _, _, _)| id == "series"));
}

// ---------------------------------------------------------------------------
// 17-20. Create / rename / move / appearance replay
// ---------------------------------------------------------------------------

#[test]
fn a_create_change_materializes_a_new_classification() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    library
        .apply_classification_page_for_test(
            &[classification_change(1, classification("new-root", "새 분류", None, 1))],
            1,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(entries(&connection)
        .iter()
        .any(|(id, kind, name, parent)| id == "new-root"
            && kind == "root"
            && name == "새 분류"
            && parent.is_none()));
    assert!(revision_cache(&connection)
        .contains(&("new-root".to_owned(), 1, 0)));
}

#[test]
fn a_rename_change_updates_the_live_name_and_revision() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    library
        .apply_classification_page_for_test(&[classification_change(1, classification("originals", "오리지널", None, 1))], 1)
        .unwrap();
    library
        .apply_classification_page_for_test(&[classification_change(2, classification("originals", "새 이름", None, 2))], 2)
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(entries(&connection)
        .iter()
        .any(|(id, _, name, _)| id == "originals" && name == "새 이름"));
    assert!(revision_cache(&connection).contains(&("originals".to_owned(), 2, 0)));
}

#[test]
fn a_move_change_updates_kind_and_parent() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    library
        .apply_classification_page_for_test(&[classification_change(1, classification("mover", "이동", None, 1))], 1)
        .unwrap();
    // A root moved under a parent becomes a tag on the server, and the projection
    // carries that derived kind.
    let mut moved = classification("mover", "이동", Some("originals"), 2);
    moved.kind = "tag".to_owned();
    library
        .apply_classification_page_for_test(&[classification_change(2, moved)], 2)
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(entries(&connection).iter().any(|(id, kind, _, parent)| id == "mover"
        && kind == "tag"
        && parent.as_deref() == Some("originals")));
}

#[test]
fn an_appearance_change_updates_keys_and_revision() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let mut styled = classification("originals", "오리지널", None, 1);
    styled.icon_key = Some("star".to_owned());
    styled.color_key = Some("blue".to_owned());
    library
        .apply_classification_page_for_test(&[classification_change(1, styled)], 1)
        .unwrap();
    let connection = library.connection().unwrap();
    let (icon, color): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT icon_key, color_key FROM classification_entries WHERE id = 'originals'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(icon.as_deref(), Some("star"));
    assert_eq!(color.as_deref(), Some("blue"));
    assert!(revision_cache(&connection).contains(&("originals".to_owned(), 1, 0)));
}

// ---------------------------------------------------------------------------
// 21/22. Assignment materialization through the change log
// ---------------------------------------------------------------------------

#[test]
fn an_assignment_change_materializes_exactly_one_relation() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    adopt_one_root(&library, 0);
    library
        .apply_classification_page_for_test(
            &[assignment_change(1, assignment("asset-1", Some("originals"), 1))],
            1,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "originals".to_owned())]);
}

#[test]
fn an_assignment_change_replaces_a_previous_relation_because_assignment_is_single_valued() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('other', 'tag', '기타', 'originals', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("other", "기타", Some("originals"), 1),
            ],
            &[assignment("asset-1", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_classification_page_for_test(
            &[assignment_change(2, assignment("asset-1", Some("other"), 2))],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        projections(&connection),
        [("asset-1".to_owned(), "other".to_owned())],
        "an Asset holds one Classification, so the old relation is replaced"
    );
}

#[test]
fn a_null_assignment_change_clears_the_local_relation() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_classification_page_for_test(
            &[assignment_change(2, assignment("asset-1", None, 2))],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    // The cleared lineage keeps a row at a real revision rather than reverting to 0.
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), None, 2)]
    );
}

#[test]
fn an_assignment_change_for_a_missing_asset_does_not_fail_reconciliation() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    library
        .apply_classification_page_for_test(
            &[assignment_change(1, assignment("absent", Some("originals"), 1))],
            1,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 1)));
    assert!(projections(&connection).is_empty());
    assert_eq!(
        assignment_cache(&connection),
        [("absent".to_owned(), Some("originals".to_owned()), 1)]
    );
}

// ---------------------------------------------------------------------------
// 25/26/27. Delete + assignment transition
// ---------------------------------------------------------------------------

#[test]
fn a_delete_and_its_transition_apply_atomically() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    insert_asset(&library, "asset-2");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[
                assignment("asset-1", Some("series"), 1),
                assignment("asset-2", Some("series"), 1),
            ],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // Deleting a non-root Classification moves its Assets to the parent, so both
    // assignments increment by exactly one.
    library
        .apply_classification_page_for_test(
            &[delete_change(
                2,
                tombstone("series", "시리즈", 2),
                transition("series", Some("originals"), 2),
            )],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(
        !entries(&connection).iter().any(|(id, _, _, _)| id == "series"),
        "the deleted Classification has no live local row"
    );
    assert!(revision_cache(&connection).contains(&("series".to_owned(), 2, 1)));
    assert_eq!(
        assignment_cache(&connection),
        [
            ("asset-1".to_owned(), Some("originals".to_owned()), 2),
            ("asset-2".to_owned(), Some("originals".to_owned()), 2),
        ],
        "each matching revision increments by exactly one"
    );
    assert_eq!(
        projections(&connection),
        [
            ("asset-1".to_owned(), "originals".to_owned()),
            ("asset-2".to_owned(), "originals".to_owned())
        ]
    );
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 2)));
}

#[test]
fn a_root_delete_transition_leaves_its_assets_unassigned() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("extra", "추가", None, 1),
            ],
            &[assignment("asset-1", Some("extra"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_classification_page_for_test(
            &[delete_change(
                2,
                tombstone("extra", "추가", 2),
                transition("extra", None, 1),
            )],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    assert_eq!(assignment_cache(&connection), [("asset-1".to_owned(), None, 2)]);
}

#[test]
fn a_delete_transition_verifies_its_count_against_the_full_authority_cache() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[
                assignment("asset-1", Some("series"), 1),
                // This Asset is not materialized locally, and the transition must still
                // count it: the authority knows about it, so a `asset_classifications`
                // count would under-report for a reason that is not divergence.
                assignment("not-local", Some("series"), 1),
            ],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_classification_page_for_test(
            &[delete_change(
                2,
                tombstone("series", "시리즈", 2),
                transition("series", Some("originals"), 2),
            )],
            2,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        assignment_cache(&connection),
        [
            ("asset-1".to_owned(), Some("originals".to_owned()), 2),
            ("not-local".to_owned(), Some("originals".to_owned()), 2),
        ]
    );
}

#[test]
fn a_transition_count_mismatch_rolls_back_the_cursor_and_the_state() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[assignment("asset-1", Some("series"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // The server says two assignments move, but the cache holds one: replica
    // divergence, which must fail the page rather than silently move one.
    let error = library
        .apply_classification_page_for_test(
            &[delete_change(
                2,
                tombstone("series", "시리즈", 2),
                transition("series", Some("originals"), 2),
            )],
            2,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 1)),
        "the cursor stays where the log was last fully applied"
    );
    assert!(
        entries(&connection).iter().any(|(id, _, _, _)| id == "series"),
        "the tombstone is rolled back with the failed page"
    );
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), Some("series".to_owned()), 1)]
    );
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "series".to_owned())]);
}

#[test]
fn a_bare_tombstone_without_its_transition_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let mut change = classification_change(1, tombstone("series", "시리즈", 2));
    change.classification = Some(tombstone("series", "시리즈", 2));
    change.assignment_transition = None;
    let error = library.apply_classification_page_for_test(&[change], 1).unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
}

#[test]
fn a_transition_that_names_a_different_classification_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let error = library
        .apply_classification_page_for_test(
            &[delete_change(
                1,
                tombstone("series", "시리즈", 2),
                transition("other", Some("originals"), 0),
            )],
            1,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_some(), "the adopt row is untouched");
    assert_eq!(authority(&connection).unwrap().3, 0);
}

#[test]
fn a_transition_on_a_live_classification_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let mut change = classification_change(1, classification("series", "시리즈", None, 2));
    change.assignment_transition = Some(transition("series", None, 0));
    let error = library.apply_classification_page_for_test(&[change], 1).unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
}

#[test]
fn an_assignment_change_carrying_a_transition_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let mut change = assignment_change(1, assignment("asset-1", Some("originals"), 1));
    change.assignment_transition = Some(transition("originals", None, 0));
    let error = library.apply_classification_page_for_test(&[change], 1).unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
}

#[test]
fn a_change_carrying_no_delta_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let error = library
        .apply_classification_page_for_test(
            &[ClassificationChange {
                sequence: 1,
                authority_cursor: 1,
                command_type: "renameClassification".to_owned(),
                operation_id: "op-1".to_owned(),
                changed_at: "2026-09-16T00:00:00Z".to_owned(),
                classification: None,
                assignment: None,
                assignment_transition: None,
            }],
            1,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
}

#[test]
fn a_change_carrying_both_a_classification_and_an_assignment_is_refused() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let mut change = classification_change(1, classification("series", "시리즈", None, 1));
    change.assignment = Some(assignment("asset-1", Some("series"), 1));
    let error = library.apply_classification_page_for_test(&[change], 1).unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
}

// ---------------------------------------------------------------------------
// 30. A valid final sibling-name arrangement rebases without a UNIQUE failure
// ---------------------------------------------------------------------------

#[test]
fn a_baseline_rebase_reaches_a_valid_final_name_arrangement() {
    let (_temp, library) = open();
    // Adopt a state where `series` is a child of `originals` holding the name "공유".
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "공유", Some("originals"), 1),
            ],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // The authority's next arrangement gives "공유" to a *new* sibling and renames
    // `series` away from it. The new holder is listed first, so applying the final rows
    // in the authority's own order would insert it while `series` still held the name —
    // which the sibling-name unique index refuses. That state is reachable on the
    // server, so a rebase that could not install it would leave a valid baseline
    // unusable.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("newcomer", "공유", Some("originals"), 1),
                classification("series", "새 이름", Some("originals"), 3),
            ],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        entries(&connection),
        [
            (
                "newcomer".to_owned(),
                "tag".to_owned(),
                "공유".to_owned(),
                Some("originals".to_owned())
            ),
            ("originals".to_owned(), "root".to_owned(), "오리지널".to_owned(), None),
            (
                "series".to_owned(),
                "tag".to_owned(),
                "새 이름".to_owned(),
                Some("originals".to_owned())
            ),
        ],
        "the baseline\'s final arrangement is installed exactly"
    );
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 9)));
}
#[test]
fn a_baseline_rebase_removes_an_obsolete_classification_that_still_holds_an_assignment() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('obsolete', 'tag', '낡음', 'originals', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'originals')",
            [],
        )
        .unwrap();
    // The obsolete Classification still holds a local relation. `asset_classifications
    // .classification_id` is `ON DELETE RESTRICT` and is not deferrable, so removing the
    // Classification without first re-projecting assignments would be refused outright
    // rather than merely leaving a stale row.
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications (asset_id, classification_id) VALUES ('asset-1', 'obsolete')",
            [],
        )
        .unwrap();
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("obsolete", "낡음", Some("originals"), 1),
            ],
            &[assignment("asset-1", Some("obsolete"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // The authority drops `obsolete` and clears the Asset's assignment in the same
    // baseline, so the projection is rebuilt before the row is removed.
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", None, 2)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            6,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(!entries(&connection).iter().any(|(id, _, _, _)| id == "obsolete"));
    assert!(
        projections(&connection).is_empty(),
        "the assignment projection follows the authority instead of blocking the removal"
    );
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), None, 2)],
        "the cleared lineage keeps its real revision"
    );
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 6)));
}

#[test]
fn a_baseline_rebase_drops_a_local_relation_to_a_classification_the_authority_removed() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('obsolete', 'tag', '낡음', 'originals', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'originals')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications (asset_id, classification_id) VALUES ('asset-1', 'obsolete')",
            [],
        )
        .unwrap();
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("obsolete", "낡음", Some("originals"), 1),
            ],
            &[assignment("asset-1", Some("obsolete"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // The authority drops `obsolete` and says nothing about this Asset at all, so no
    // assignment row re-projects it. Only clearing the materialized view before the
    // Classification is removed keeps the relation from outliving its target, which the
    // local schema refuses.
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            6,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(!entries(&connection).iter().any(|(id, _, _, _)| id == "obsolete"));
    assert!(
        projections(&connection).is_empty(),
        "no local relation may point at a Classification the authority removed"
    );
    assert!(assignment_cache(&connection).is_empty());
}

#[test]
fn a_baseline_rebase_preserves_character_state_for_live_classifications() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('series', 'tag', '시리즈', 'originals', '2026-09-16T00:00:00Z'),
                    ('obsolete', 'root', '낡음', NULL, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    // Character-derived state on the *surviving* Classification: a cascade delete of
    // `classification_entries` would have destroyed this row.
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_series (classification_id) VALUES ('series'),
                    ('obsolete')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_folder_exclusions (classification_id) VALUES ('series')",
            [],
        )
        .unwrap();
    // A character target pointing at the surviving series; `ON DELETE SET NULL` would
    // have blanked this if the row had been deleted and reinserted.
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_targets
                (id, series_classification_id, display_name, enabled, created_at, updated_at)
             VALUES ('target-1', 'series', '주인공', 1,
                     '2026-09-16T00:00:00Z', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    // The authority adopts the state this PC already holds, so nothing is dropped yet:
    // the comparison below is about what a *later* rebase does, not this install.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
                classification("obsolete", "낡음", None, 1),
            ],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // A later authority baseline keeps `series` (reparented onto a new root) and drops
    // `obsolete`. Removing `obsolete` must not disturb `series` — the row a wholesale
    // `DELETE FROM classification_entries` would have cascaded away.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("new-root", "새 루트", None, 1),
                classification("series", "시리즈", Some("new-root"), 4),
            ],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            12,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    let series_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM character_series WHERE classification_id = 'series'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(series_rows, 1, "Character state on a live id must survive a rebase");
    let exclusion_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM character_folder_exclusions WHERE classification_id = 'series'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exclusion_rows, 1);
    let target: Option<String> = connection
        .query_row(
            "SELECT series_classification_id FROM character_targets WHERE id = 'target-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        target.as_deref(),
        Some("series"),
        "the reparent did not blank the target's series link"
    );
}

// ---------------------------------------------------------------------------
// 32. Deleting an authority-deleted Classification follows existing FK semantics
// ---------------------------------------------------------------------------

#[test]
fn an_authority_deleted_classification_follows_existing_fk_semantics() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('gone', 'tag', '삭제될 분류', 'originals', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_series (classification_id) VALUES ('gone')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'originals')",
            [],
        )
        .unwrap();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // The authority no longer lists `gone`, so the local row is removed and its
    // Character-derived state follows the schema's own `CASCADE`.
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            5,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(!entries(&connection).iter().any(|(id, _, _, _)| id == "gone"));
    let cascaded: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM character_series WHERE classification_id = 'gone'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cascaded, 0, "CASCADE semantics are preserved for a real delete");
}

// ---------------------------------------------------------------------------
// 33. classification_roles converges to the baseline role
// ---------------------------------------------------------------------------

#[test]
fn the_role_binding_converges_to_the_baseline() {
    let (_temp, library) = open();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('replacement', 'root', '대체', NULL, '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_roles (role, classification_id) VALUES ('originals', 'originals')",
            [],
        )
        .unwrap();
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("replacement", "대체", None, 1),
            ],
            &[],
            &[originals("replacement")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        roles(&connection),
        [("originals".to_owned(), "replacement".to_owned())],
        "the role follows the authority, and the old binding does not linger"
    );
}

// ---------------------------------------------------------------------------
// Malformed baseline responses
// ---------------------------------------------------------------------------

#[test]
fn a_baseline_without_the_originals_role_is_refused() {
    let (_temp, library) = open();
    let error = library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert!(authority(&connection).is_none());
}

#[test]
fn a_baseline_page_with_a_mismatched_section_is_refused() {
    let page = crate::cloud::client::ClassificationBaselinePage {
        library_id: LIBRARY.to_owned(),
        epoch: 1,
        contract_version: 1,
        snapshot_cursor: 3,
        // Declares the classification section while carrying assignment-shaped items.
        section: "classifications".to_owned(),
        roles: vec![originals("originals")],
        items: serde_json::json!([{"assetId": "a", "classificationId": null, "entityRevision": 1}]),
        next_after: None,
        has_more: false,
        complete: true,
    };
    assert!(matches!(
        page.decode(),
        Err(LibraryError::InvalidCloudResponse)
    ));
}

#[test]
fn a_baseline_page_with_an_unknown_section_is_refused() {
    let page = crate::cloud::client::ClassificationBaselinePage {
        library_id: LIBRARY.to_owned(),
        epoch: 1,
        contract_version: 1,
        snapshot_cursor: 3,
        section: "something-else".to_owned(),
        roles: vec![],
        items: serde_json::json!([]),
        next_after: None,
        has_more: false,
        complete: true,
    };
    assert!(matches!(
        page.decode(),
        Err(LibraryError::InvalidCloudResponse)
    ));
}

#[test]
fn a_baseline_page_with_malformed_items_is_refused() {
    let page = crate::cloud::client::ClassificationBaselinePage {
        library_id: LIBRARY.to_owned(),
        epoch: 1,
        contract_version: 1,
        snapshot_cursor: 3,
        section: "classifications".to_owned(),
        roles: vec![originals("originals")],
        // `entityRevision` is missing, so this is not a Classification projection.
        items: serde_json::json!([{"id": "a", "kind": "root", "name": "x"}]),
        next_after: None,
        has_more: false,
        complete: true,
    };
    assert!(matches!(
        page.decode(),
        Err(LibraryError::InvalidCloudResponse)
    ));
}

// ---------------------------------------------------------------------------
// Client-side validation of the request contract
// ---------------------------------------------------------------------------

#[test]
fn a_negative_snapshot_cursor_is_refused_before_the_request_is_sent() {
    let client = crate::cloud::client::CloudClient::new("https://example.invalid").unwrap();
    assert!(matches!(
        client.classification_baseline_page(LIBRARY, 1, Some(-1), None, None, "token"),
        Err(LibraryError::InvalidCloudResponse)
    ));
    assert!(matches!(
        client.classification_changes(LIBRARY, 1, -1, 100, "token"),
        Err(LibraryError::InvalidCloudResponse)
    ));
}

// ---------------------------------------------------------------------------
// 3. Rebase Character reconsideration from true before/after state
// ---------------------------------------------------------------------------

/// A rebase must queue reconsideration from the *pre-rebase* assignment state.
///
/// The rebase clears `asset_classifications` globally before projecting the baseline, so a
/// per-row comparison would see `null -> B` instead of the real transition. Each case
/// below therefore pins exactly what the whole-state comparison has to get right.
#[test]
fn a_rebase_queues_reconsideration_for_a_changed_assignment() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("elsewhere", "다른곳", None, 1),
            ],
            // Local: assigned to `elsewhere`, which is outside Character scope.
            &[assignment("asset-1", Some("elsewhere"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_autotag_jobs", [])
        .unwrap();
    // The authority rebases onto the Character series.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("elsewhere", "다른곳", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 2)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "franchise".to_owned())]);
    let (state, cause, _) = character_job(&connection, "asset-1")
        .expect("A -> B must queue one reconsideration");
    assert_eq!(state, "pending");
    assert_eq!(cause, "classification");
    assert_eq!(cloud_queue_rows(&connection, "asset-1"), 0);
}

/// `A -> null` is the case a per-row comparison loses entirely: after the global clear both
/// sides look empty, so the Asset's reconsideration would be silently dropped.
#[test]
fn a_rebase_to_unassigned_queues_reconsideration() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_autotag_jobs", [])
        .unwrap();
    // The authority now reports the Asset as unassigned.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", None, 2)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    // Leaving Character scope supersedes rather than queues, which is the same rule the
    // incremental path follows. What matters is that the pre-rebase state was *seen*: a
    // per-row comparison would leave no job at all even if one had been pending.
    if let Some((state, _, _)) = character_job(&connection, "asset-1") {
        assert_eq!(state, "superseded");
    }
}

/// The authoritative baseline need not mention the Asset at all: absence is still a change
/// away from the local relation, and the comparison must treat it that way.
#[test]
fn a_rebase_to_no_authoritative_row_queues_reconsideration() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library.connection().unwrap().execute("DELETE FROM character_autotag_jobs", []).unwrap();
    // No assignment row for asset-1 at all, and no `elsewhere` Classification either.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(
        projections(&connection).is_empty(),
        "an absent authoritative row clears the local relation"
    );
    if let Some((state, _, _)) = character_job(&connection, "asset-1") {
        assert_eq!(state, "superseded");
    }
}

/// The reverse false positive: `A -> A` must not manufacture work. A per-row comparison
/// would read this as `null -> A` after the global clear and queue a spurious job.
#[test]
fn a_rebase_with_an_unchanged_assignment_queues_nothing() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library.connection().unwrap().execute("DELETE FROM character_autotag_jobs", []).unwrap();
    // A later rebase carrying the identical assignment.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 4)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "franchise".to_owned())]);
    assert_eq!(
        character_job(&connection, "asset-1"),
        None,
        "A -> A is not a change, so no reconsideration may be queued"
    );
}

/// A large unchanged assignment set must not manufacture jobs: the comparison is per Asset
/// and by value, not per baseline row.
#[test]
fn a_rebase_over_a_large_unchanged_assignment_set_queues_nothing() {
    let (_temp, library) = open();
    let classifications: Vec<ClassificationProjection> = std::iter::once(classification(
        "originals",
        "오리지널",
        None,
        1,
    ))
    .chain((0..25).map(|index| {
        classification(&format!("series-{index}"), &format!("시리즈 {index}"), None, 1)
    }))
    .collect();
    let mut assignments = Vec::new();
    for index in 0..25 {
        insert_asset(&library, &format!("asset-{index}"));
        make_character_eligible(&library, &format!("asset-{index}"), "series-0");
        assignments.push(assignment(
            &format!("asset-{index}"),
            Some(&format!("series-{index}")),
            1,
        ));
    }
    library
        .install_classification_baseline_for_test(
            &classifications,
            &assignments,
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library.connection().unwrap().execute("DELETE FROM character_autotag_jobs", []).unwrap();
    // The same set again, with only revisions advanced.
    let advanced: Vec<ClassificationAssignmentProjection> = assignments
        .iter()
        .map(|value| {
            assignment(
                &value.asset_id,
                value.classification_id.as_deref(),
                value.entity_revision + 1,
            )
        })
        .collect();
    library
        .install_classification_baseline_for_test(
            &classifications,
            &advanced,
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    let jobs: i64 = connection
        .query_row("SELECT COUNT(*) FROM character_autotag_jobs", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(jobs, 0, "an unchanged rebase owes no Character work at all");
}

/// A failure after the assignment materialization must roll back the materialized changes
/// *and* the reconsideration work, because a rebase is one transaction.
#[test]
fn a_failed_rebase_rolls_back_materialization_and_reconsideration() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    make_character_eligible(&library, "asset-1", "franchise");
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("elsewhere", "다른곳", None, 1),
            ],
            // Local state: assigned somewhere outside Character scope.
            &[assignment("asset-1", Some("elsewhere"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library.connection().unwrap().execute("DELETE FROM character_autotag_jobs", []).unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "CREATE TRIGGER fail_rebase_character_step BEFORE INSERT ON character_autotag_jobs
             BEGIN SELECT RAISE(ABORT, 'rebase character step failed'); END",
            [],
        )
        .unwrap();
    // The authority moves the Asset onto the Character series, so the Character step
    // definitely runs — and, with the trigger in place, definitely fails.
    let error = library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("elsewhere", "다른곳", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 2)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap_err();
    assert!(matches!(&error, LibraryError::Database(_)), "{error:?}");
    {
        let connection = library.connection().unwrap();
        assert_eq!(
            projections(&connection),
            [("asset-1".to_owned(), "elsewhere".to_owned())],
            "the materialized assignment change rolled back"
        );
        assert!(
            character_job(&connection, "asset-1").is_none(),
            "the queued reconsideration rolled back"
        );
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 1)),
            "the cursor rolled back with them"
        );
        assert_eq!(
            assignment_cache(&connection),
            [("asset-1".to_owned(), Some("elsewhere".to_owned()), 1)]
        );
        connection.execute("DROP TRIGGER fail_rebase_character_step", []).unwrap();
    }
    // With the injected failure gone the same rebase completes.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("franchise", "작품군", None, 1),
                classification("elsewhere", "다른곳", None, 1),
            ],
            &[assignment("asset-1", Some("franchise"), 2)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "franchise".to_owned())]);
    assert!(character_job(&connection, "asset-1").is_some());
}

// ---------------------------------------------------------------------------
// 4. A missing Classification is corruption, not a deferred projection
// ---------------------------------------------------------------------------

/// An incremental change whose assignment names a Classification this PC does not have is a
/// corrupt replica, not a pending projection: the server validates every assignment target.
#[test]
fn an_incremental_assignment_to_a_missing_classification_fails_closed() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    adopt_one_root(&library, 5);
    let error = library
        .apply_classification_page_for_test(
            // `absent` is not in `classification_entries`.
            &[assignment_change(6, assignment("asset-1", Some("absent"), 1))],
            6,
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert!(
        projections(&connection).is_empty(),
        "no relation may be left materialized"
    );
    assert!(
        assignment_cache(&connection).is_empty(),
        "the revision written earlier in the page must roll back with it"
    );
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 5)),
        "the cursor must not advance over a page that failed"
    );
}

/// The same rule for the deferred step: a cached assignment whose target Classification has
/// gone missing must fail rather than silently reporting success.
#[test]
fn deferred_materialization_fails_when_the_target_classification_is_absent() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            // Cached for an Asset this PC had not materialized, pointing at `later`.
            &[assignment("asset-1", Some("later"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    // The Asset appears, but `later` was never a live Classification: the target cannot be
    // satisfied, which is corruption rather than a projection that is merely pending.
    insert_asset(&library, "asset-1");
    let error = library
        .materialize_deferred_classification_assignments()
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), Some("later".to_owned()), 1)],
        "the cache is authority state and is left exactly as it was"
    );
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
}

/// A missing *Asset* remains a legitimate deferred projection.
#[test]
fn an_assignment_targeting_a_missing_asset_is_still_deferred() {
    let (_temp, library) = open();
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("not-here", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            3,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(projections(&connection).is_empty());
    assert_eq!(
        assignment_cache(&connection),
        [("not-here".to_owned(), Some("originals".to_owned()), 1)]
    );
}

// ---------------------------------------------------------------------------
// Envelope and change-row validation
// ---------------------------------------------------------------------------

/// Build a change page for the validator unit tests.
fn changes_page(
    library_id: &str,
    epoch: i64,
    contract_version: i64,
    cursor: i64,
    items: serde_json::Value,
    next_after: i64,
    has_more: bool,
) -> crate::cloud::client::ClassificationChanges {
    serde_json::from_value(serde_json::json!({
        "libraryId": library_id,
        "epoch": epoch,
        "contractVersion": contract_version,
        "cursor": cursor,
        "items": items,
        "nextAfter": next_after,
        "hasMore": has_more,
    }))
    .unwrap()
}

fn classification_item_json(
    id: &str,
    kind: &str,
    name: &str,
    revision: i64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id, "kind": kind, "name": name, "parentId": null,
        "iconKey": null, "colorKey": null, "deleted": false, "entityRevision": revision
    })
}

/// One valid `renameClassification` row at `sequence`.
fn one_change(sequence: i64) -> serde_json::Value {
    serde_json::json!([{
        "sequence": sequence, "authorityCursor": sequence,
        "commandType": "renameClassification", "operationId": "op-1",
        "changedAt": "2026-09-16T00:00:00Z",
        "classification": classification_item_json("originals", "root", "새 이름", 2)
    }])
}

#[test]
fn a_changes_page_must_name_the_authority_it_was_requested_from() {
    let valid = changes_page(LIBRARY, 1, 1, 5, one_change(4), 4, true);
    assert!(valid.validate(LIBRARY, 1, 4).is_ok());

    for bad in [
        changes_page(OTHER_LIBRARY, 1, 1, 5, one_change(4), 4, true),
        changes_page(LIBRARY, 2, 1, 5, one_change(4), 4, true),
        changes_page(LIBRARY, 1, 2, 5, one_change(4), 4, true),
    ] {
        assert!(matches!(
            bad.validate(LIBRARY, 1, 4),
            Err(LibraryError::ClassificationAuthorityMismatch)
        ));
    }
}

#[test]
fn a_changes_page_cursor_envelope_must_agree_with_itself() {
    // A valid page: one item at 4, the authority ahead at 5, so more remains.
    assert!(changes_page(LIBRARY, 1, 1, 5, one_change(4), 4, true)
        .validate(LIBRARY, 1, 4)
        .is_ok());
    // A valid empty page sits exactly on the requested cursor with nothing more.
    assert!(changes_page(LIBRARY, 1, 1, 3, serde_json::json!([]), 3, false)
        .validate(LIBRARY, 1, 3)
        .is_ok());

    let invalid = [
        (
            "nextAfter beyond the authority cursor",
            changes_page(LIBRARY, 1, 1, 4, one_change(5), 5, false),
        ),
        (
            "nextAfter behind the requested cursor",
            // Requested from 5, but the page reports a cursor at 3.
            changes_page(LIBRARY, 1, 1, 9, one_change(3), 3, true),
        ),
        (
            "hasMore understated",
            changes_page(LIBRARY, 1, 1, 9, one_change(4), 4, false),
        ),
        (
            "hasMore overstated",
            changes_page(LIBRARY, 1, 1, 4, one_change(4), 4, true),
        ),
        (
            "empty page advanced",
            changes_page(LIBRARY, 1, 1, 9, serde_json::json!([]), 7, true),
        ),
        (
            "final row disagrees with nextAfter",
            changes_page(LIBRARY, 1, 1, 9, one_change(4), 6, true),
        ),
        (
            "negative cursor",
            changes_page(LIBRARY, 1, 1, -1, one_change(-1), -1, false),
        ),
    ];
    // Validated from a cursor of 5 so the "behind the requested cursor" vector is genuinely
    // behind it rather than merely equal.
    for (label, page) in invalid {
        assert!(
            matches!(page.validate(LIBRARY, 1, 5), Err(LibraryError::InvalidCloudResponse)),
            "{label} must be refused"
        );
    }
}

#[test]
fn a_change_row_must_label_the_payload_it_carries() {
    let make = |command: &str,
                classification: Option<serde_json::Value>,
                assignment: Option<serde_json::Value>,
                transition: Option<serde_json::Value>| {
        let mut row = serde_json::json!({
            "sequence": 7, "authorityCursor": 7, "commandType": command,
            "operationId": "op-7", "changedAt": "2026-09-16T00:00:00Z"
        });
        if let Some(value) = classification {
            row["classification"] = value;
        }
        if let Some(value) = assignment {
            row["assignment"] = value;
        }
        if let Some(value) = transition {
            row["assignmentTransition"] = value;
        }
        serde_json::from_value::<ClassificationChange>(row).unwrap()
    };
    let live = || classification_item_json("originals", "root", "오리지널", 1);
    let tomb = || {
        let mut value = classification_item_json("originals", "root", "오리지널", 2);
        value["deleted"] = serde_json::json!(true);
        value
    };
    let assign = || {
        serde_json::json!({
            "assetId": "asset-1", "classificationId": "originals", "entityRevision": 1
        })
    };
    let trans = || {
        serde_json::json!({
            "fromClassificationId": "originals",
            "toClassificationId": null,
            "affectsAssignments": 0
        })
    };

    // Every legal command/payload pairing.
    for command in [
        "createClassification",
        "renameClassification",
        "moveClassification",
        "updateClassificationAppearance",
    ] {
        assert!(
            make(command, Some(live()), None, None).delta().is_ok(),
            "{command} with one live Classification is valid"
        );
    }
    assert!(make("setAssetClassification", None, Some(assign()), None)
        .delta()
        .is_ok());
    assert!(make("deleteClassification", Some(tomb()), None, Some(trans()))
        .delta()
        .is_ok());

    let malformed = [
        (
            "unknown command name",
            make("frobnicate", Some(live()), None, None),
        ),
        (
            "assignment labelled rename",
            make("renameClassification", None, Some(assign()), None),
        ),
        (
            "live Classification labelled delete",
            make("deleteClassification", Some(live()), None, Some(trans())),
        ),
        (
            "tombstone under rename",
            make("renameClassification", Some(tomb()), None, None),
        ),
        (
            "delete without its transition",
            make("deleteClassification", Some(tomb()), None, None),
        ),
        (
            "transition under rename",
            make("renameClassification", Some(live()), None, Some(trans())),
        ),
        (
            "classification and assignment together",
            make("renameClassification", Some(live()), Some(assign()), None),
        ),
        (
            "transition without a payload",
            make("deleteClassification", None, None, Some(trans())),
        ),
    ];
    for (label, row) in malformed {
        assert!(
            matches!(row.delta(), Err(LibraryError::InvalidCloudResponse)),
            "{label} must be refused"
        );
    }
}

#[test]
fn a_change_row_must_carry_its_own_sequence_as_the_authority_cursor() {
    let row: ClassificationChange = serde_json::from_value(serde_json::json!({
        "sequence": 7, "authorityCursor": 8, "commandType": "renameClassification",
        "operationId": "op-7", "changedAt": "2026-09-16T00:00:00Z",
        "classification": classification_item_json("originals", "root", "오리지널", 1)
    }))
    .unwrap();
    assert!(matches!(row.delta(), Err(LibraryError::InvalidCloudResponse)));
}

/// An empty page is not progress, so it must leave the cursor exactly where it was.
#[test]
fn an_empty_change_page_does_not_advance_the_cursor() {
    let (_temp, library) = open();
    adopt_one_root(&library, 5);
    library.apply_classification_page_for_test(&[], 5).unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 5)));
}

// ---------------------------------------------------------------------------
// Integration: the real CloudClient over a real socket
// ---------------------------------------------------------------------------

/// The full orchestration against a real HTTP server: `/v1/sync/status`, baseline pages
/// and change pages. A mocked transport would hide the wire contract, so these run the
/// production `CloudClient` over a real socket.
///
/// The responses are built from the server's own encoding rules
/// (`server/lakomics-api/classification_authority.py`: `encode_page`,
/// `classification_projection`, `assignment_projection`, `role_projection`, and the
/// `change_items` row shape). One test below additionally deserializes the checked-in
/// `tests/fixtures/classification-authority-wire.json`, which is generated by running
/// those server functions (`tests/fixtures/classification-authority-wire.py`).
// ---------------------------------------------------------------------------
// 2B.1: receive coordination over the durable outbox
// ---------------------------------------------------------------------------

/// A live HTTP server that must receive no request, plus its base URL.
///
/// A pass that correctly defers still returns without any round trip, so an idle fixture
/// proves the "no request" half of the claim rather than merely assuming it.
fn idle_server() -> (String, std::thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", server.server_addr());
    let handle = std::thread::spawn(move || {
        let _ = server.recv_timeout(std::time::Duration::from_millis(300));
    });
    (base, handle)
}

/// Queue one durable intent without going through a local mutation.
fn queue_intent(library: &Library, command_type: &str, classification_id: &str, state: &str) {
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_authority_outbox
                (operation_id, command_type, classification_id, epoch, payload, state, created_at)
             VALUES (?1, ?2, ?3, 1, '{\"libraryId\":\"x\"}', ?4, '2026-09-17T00:00:00Z')",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                command_type,
                classification_id,
                state
            ],
        )
        .unwrap();
}

/// A non-empty outbox defers the receive, and the deferral is reported.
#[test]
fn a_pending_intent_defers_the_receive() {
    let (_temp, library) = open();
    pin_library_id(&library);
    let (base, server) = idle_server();
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    adopt_one_root(&library, 0);
    queue_intent(&library, "renameClassification", "originals", "pending");

    let result = library
        .reconcile_classification_authority(&client, "token")
        .unwrap();
    assert!(result.deferred_to_outbox);
    assert_eq!(result.applied_changes, 0);
    assert!(!result.adopted_baseline);
    server.join().unwrap();
}

/// A blocked intent defers the receive indefinitely.
#[test]
fn a_blocked_intent_defers_the_receive() {
    let (_temp, library) = open();
    pin_library_id(&library);
    let (base, server) = idle_server();
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    adopt_one_root(&library, 0);
    queue_intent(&library, "renameClassification", "originals", "blocked");

    let result = library
        .reconcile_classification_authority(&client, "token")
        .unwrap();
    assert!(result.deferred_to_outbox);
    server.join().unwrap();
}

/// A `cursorExpired` rebase cannot overwrite pending optimistic state.
///
/// Receive never runs while the queue is unresolved, so the rebase path that would
/// replace the confirmed replica has no opportunity to run over the user's edit.
#[test]
fn a_cursor_expired_rebase_cannot_run_over_a_pending_intent() {
    let (_temp, library) = open();
    pin_library_id(&library);
    let (base, server) = idle_server();
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    adopt_one_root(&library, 5);
    // A local edit the server has not accepted: the optimistic value is what the user
    // currently sees, and it must survive.
    insert_asset(&library, "asset-1");
    library
        .set_asset_classification(crate::library::models::SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some("originals".into()),
        })
        .unwrap();

    let result = library
        .reconcile_classification_authority(&client, "token")
        .unwrap();
    server.join().unwrap();

    assert!(result.deferred_to_outbox);
    let connection = library.connection().unwrap();
    // The confirmed replica was not replaced and the optimistic relation is intact.
    assert_eq!(authority(&connection).unwrap().3, 5);
    assert_eq!(
        connection
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = 'asset-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "originals"
    );
}

/// The deferred materialization step refuses to run over a pending intent.
///
/// It writes confirmed state, so running it while the queue holds the user's newer value
/// would silently revert that value outside the reconciliation guard.
#[test]
fn deferred_materialization_refuses_to_run_over_a_pending_intent() {
    let (_temp, library) = open();
    let root = library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Root,
            name: "게임".into(),
            parent_id: None,
        })
        .unwrap();
    let other = library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Root,
            name: "다른".into(),
            parent_id: None,
        })
        .unwrap();
    insert_asset(&library, "asset-1");
    library
        .install_classification_baseline_for_test(
            &[
                classification(&root.id, "게임", None, 1),
                classification(&other.id, "다른", None, 1),
            ],
            // The authority's confirmed value for asset-1 is `root`.
            &[assignment("asset-1", Some(&root.id), 1)],
            &[originals(&root.id)],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // The user then moves asset-1 to `other`; that intent is still queued.
    library
        .set_asset_classification(crate::library::models::SetAssetClassification {
            asset_ids: vec!["asset-1".into()],
            classification_id: Some(other.id.clone()),
        })
        .unwrap();

    let changed = library.materialize_deferred_classification_assignments().unwrap();

    assert_eq!(changed, 0, "confirmed state must not overwrite a pending intent");
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id = 'asset-1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        other.id
    );
}

/// Queue durability and strict FIFO order survive a reopen.
#[test]
fn the_outbox_survives_a_reopen_in_strict_fifo_order() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .adopt_classification_authority_for_test(LIBRARY, 1, 1, 0)
        .unwrap();
    let mut created = Vec::new();
    for name in ["하나", "둘", "셋"] {
        created.push(
            library
                .create_classification(crate::library::models::CreateClassification {
                    kind: crate::library::models::ClassificationKind::Root,
                    name: name.into(),
                    parent_id: None,
                })
                .unwrap()
                .id,
        );
    }
    let before = outbox_rows(&library.connection().unwrap());
    drop(library);

    // Reopening runs the migration chain again; the queue and its order must be intact.
    let library = Library::open(temp.path()).unwrap();
    let after = outbox_rows(&library.connection().unwrap());
    assert_eq!(after, before);
    assert_eq!(after.len(), 3);
    let ids: Vec<String> = after
        .iter()
        .map(|(_, _, payload)| {
            let body: serde_json::Value = serde_json::from_str(payload).unwrap();
            body["classificationId"].as_str().unwrap().to_owned()
        })
        .collect();
    assert_eq!(ids, created);
    // Operation ids are durable and unique.
    let operations: std::collections::BTreeSet<&String> =
        after.iter().map(|(operation_id, _, _)| operation_id).collect();
    assert_eq!(operations.len(), 3);
}

/// A failed local mutation rolls back its intent with it.
#[test]
fn a_rolled_back_mutation_rolls_back_its_intent() {
    let (_temp, library) = open();
    library
        .adopt_classification_authority_for_test(LIBRARY, 1, 1, 0)
        .unwrap();
    let root = library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Root,
            name: "게임".into(),
            parent_id: None,
        })
        .unwrap();
    // A trigger that fails every classification_entries write makes the mutation's own
    // statement fail *after* the create succeeded in this fixture.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_rename BEFORE UPDATE ON classification_entries
             BEGIN SELECT RAISE(ABORT,'fixture'); END;",
        )
        .unwrap();

    assert!(library.rename_classification(&root.id, "새 이름").is_err());

    let connection = library.connection().unwrap();
    // Neither half: the name is unchanged and no rename intent exists.
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM classification_entries WHERE id = ?1",
                [&root.id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "게임"
    );
    assert_eq!(
        outbox_rows(&connection)
            .iter()
            .filter(|(_, kind, _)| kind == "renameClassification")
            .count(),
        0
    );
}

mod integration {
    use super::*;
    use crate::cloud::client::CloudClient;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tiny_http::{Header, Response, Server};

    fn json_response(value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    fn coded_response(status: u16, value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_status_code(status)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    /// `/v1/sync/status` reporting the Classification domain at `cursor`.
    fn status_body(cursor: i64) -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": 1,
            "active": true,
            "libraryId": LIBRARY,
            "domains": [{
                "domain": "classifications",
                "libraryId": LIBRARY,
                "epoch": 1,
                "contractVersion": 1,
                "cursor": cursor
            }]
        })
    }

    /// The role set the server carries on every baseline page. Its wire key is
    /// `classificationId`, taken from the server's own `role_projection`.
    fn roles_json() -> serde_json::Value {
        serde_json::json!([{"role": "originals", "classificationId": "originals"}])
    }

    /// One baseline page in the server's exact shape.
    fn baseline_page(
        cursor: i64,
        section: &str,
        items: serde_json::Value,
        next_after: Option<&str>,
        has_more: bool,
        complete: bool,
    ) -> serde_json::Value {
        serde_json::json!({
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "snapshotCursor": cursor, "section": section,
            "roles": roles_json(),
            "items": items,
            "nextAfter": next_after,
            "hasMore": has_more,
            "complete": complete
        })
    }

    /// One baseline page for an explicit epoch.
    ///
    /// A re-adoption happens because the authority's epoch changed, so a test that drives one
    /// has to serve pages for that new epoch — the identity check refuses a page whose epoch
    /// disagrees with the `/status` reading, which is exactly what makes a wrong-library or
    /// wrong-epoch response impossible to adopt.
    fn baseline_page_at_epoch(
        epoch: i64,
        cursor: i64,
        section: &str,
        items: serde_json::Value,
        next_after: Option<&str>,
        has_more: bool,
        complete: bool,
    ) -> serde_json::Value {
        serde_json::json!({
            "libraryId": LIBRARY, "epoch": epoch, "contractVersion": 1,
            "snapshotCursor": cursor, "section": section,
            "roles": roles_json(),
            "items": items,
            "nextAfter": next_after,
            "hasMore": has_more,
            "complete": complete
        })
    }

    fn classification_item(
        id: &str,
        kind: &str,
        name: &str,
        parent: Option<&str>,
        revision: i64,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id, "kind": kind, "name": name, "parentId": parent,
            "iconKey": null, "colorKey": null, "deleted": false,
            "entityRevision": revision
        })
    }

    /// A complete two-section baseline adopting one root, one child and one assignment.
    fn complete_baseline(cursor: i64) -> Vec<serde_json::Value> {
        vec![
            baseline_page(
                cursor,
                "classifications",
                serde_json::json!([
                    classification_item("originals", "root", "오리지널", None, 1),
                    classification_item("series", "tag", "시리즈", Some("originals"), 2)
                ]),
                None,
                false,
                false,
            ),
            baseline_page(
                cursor,
                "assignments",
                serde_json::json!([
                    {"assetId": "asset-1", "classificationId": "series", "entityRevision": 1}
                ]),
                None,
                false,
                true,
            ),
        ]
    }

    /// The body of one received request, parsed as JSON.
    ///
    /// Reading the body is what lets a test assert the *wire* shape of a sent command — an
    /// unchanged operation id across a rebase, for example — instead of inferring it from the
    /// state that happened to result.
    fn read_request_body(request: &mut tiny_http::Request) -> serde_json::Value {
        let mut body = String::new();
        use std::io::Read;
        request.as_reader().read_to_string(&mut body).unwrap();
        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null)
    }

    /// A scripted server: it answers requests in order until the script is exhausted.
    ///
    /// The script is only ever a *lower* bound on the requests a pass makes, and a pass
    /// that legitimately stops early must not leave the server thread blocked, so the
    /// loop also exits as soon as the test signals that it is done. A short receive
    /// timeout is what keeps that exit possible without racing the last response.
    struct Scripted {
        base: String,
        paths: Arc<Mutex<Vec<String>>>,
        /// The exact bodies received, in order, so a test can assert what was actually sent
        /// rather than only the state that resulted from it.
        bodies: Arc<Mutex<Vec<serde_json::Value>>>,
        stop: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl Scripted {
        fn start(script: Vec<(serde_json::Value, u16)>) -> Self {
            let server = Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://{}/v1", server.server_addr());
            let paths = Arc::new(Mutex::new(Vec::new()));
            let log = Arc::clone(&paths);
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let logged_bodies = Arc::clone(&bodies);
            let stop = Arc::new(AtomicBool::new(false));
            let flag = Arc::clone(&stop);
            let handle = thread::spawn(move || {
                let mut remaining = script.into_iter();
                while !flag.load(Ordering::Relaxed) {
                    let Some((body, status)) = remaining.next() else {
                        // The pass asked for fewer requests than the script described.
                        return;
                    };
                    // Generous, because this must not fire merely because the client
                    // thread has not been scheduled yet; it exists so an early-stopping
                    // pass cannot leave this thread parked forever.
                    let Ok(Some(mut request)) = server.recv_timeout(Duration::from_secs(10))
                    else {
                        return;
                    };
                    log.lock().unwrap().push(request.url().to_owned());
                    logged_bodies.lock().unwrap().push(read_request_body(&mut request));
                    let _ = request.respond(if status == 200 {
                        json_response(body)
                    } else {
                        coded_response(status, body)
                    });
                }
            });
            Self {
                base,
                paths,
                bodies,
                stop,
                handle: Some(handle),
            }
        }

        fn finish(mut self) -> Vec<String> {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
            self.paths.lock().unwrap().clone()
        }

        /// The bodies received, in order, as parsed JSON.
        fn bodies(&self) -> Vec<serde_json::Value> {
            self.bodies.lock().unwrap().clone()
        }
    }

    /// A change page carrying one Classification projection.
    fn classification_change_page(
        cursor: i64,
        sequence: i64,
        id: &str,
        name: &str,
        revision: i64,
    ) -> serde_json::Value {
        serde_json::json!({
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": cursor,
            "items": [{
                "sequence": sequence, "authorityCursor": sequence,
                "commandType": "renameClassification", "operationId": "op-1",
                "changedAt": "2026-09-16T00:00:00Z",
                "classification": classification_item(id, "root", name, None, revision)
            }],
            "nextAfter": sequence, "hasMore": false
        })
    }

    /// Create the local state `complete_baseline` describes.
    ///
    /// A first adoption is only legal when the authority's baseline already matches this
    /// PC, so an adopting test must hold exactly the state the baseline carries.
    fn seed_matching_local_state(library: &Library) {
        library
            .connection()
            .unwrap()
            .execute_batch(
                "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                 VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                        ('series', 'tag', '시리즈', 'originals', '2026-09-16T00:00:00Z');
                 INSERT INTO classification_roles (role, classification_id)
                 VALUES ('originals', 'originals');
                 INSERT INTO asset_classifications (asset_id, classification_id)
                 VALUES ('asset-1', 'series');",
            )
            .unwrap();
    }

/// A clean outbox permits the receive.
#[test]
fn a_clean_outbox_permits_the_receive() {
    let (_temp, library) = open();
    pin_library_id(&library);
    let mut script = vec![(status_body(7), 200)];
    script.extend(complete_baseline(7).into_iter().map(|body| (body, 200)));
    let server = Scripted::start(script);
    let client = CloudClient::new(&server.base).unwrap();
    insert_asset(&library, "asset-1");
    seed_matching_local_state(&library);

    let result = library
        .reconcile_classification_authority(&client, "token")
        .unwrap();
    let paths = server.finish();
    assert!(!result.deferred_to_outbox);
    assert!(result.adopted_baseline);
    assert!(paths.iter().any(|path| path.contains("/v1/sync/status")));
}

    #[test]
    fn the_real_client_adopts_a_frozen_baseline_over_a_socket() {
        let mut script = vec![(status_body(7), 200)];
        script.extend(complete_baseline(7).into_iter().map(|body| (body, 200)));
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        seed_matching_local_state(&library);
        let reconciliation = library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        let paths = server.finish();
        assert!(reconciliation.adopted);
        assert!(reconciliation.adopted_baseline);
        assert_eq!(reconciliation.local_cursor, Some(7));
        assert_eq!(reconciliation.behind_by, 0);

        let connection = library.connection().unwrap();
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 7)));
        assert_eq!(projections(&connection), [("asset-1".to_owned(), "series".to_owned())]);
        assert_eq!(
            entries(&connection),
            [
                ("originals".to_owned(), "root".to_owned(), "오리지널".to_owned(), None),
                (
                    "series".to_owned(),
                    "tag".to_owned(),
                    "시리즈".to_owned(),
                    Some("originals".to_owned())
                ),
            ]
        );
        assert_eq!(
            revision_cache(&connection),
            [("originals".to_owned(), 1, 0), ("series".to_owned(), 2, 0)]
        );
        // The requests went to the authority routes under the dedicated prefix.
        assert!(paths[0].contains("/v1/sync/status"), "{}", paths[0]);
        assert!(
            paths
                .iter()
                .skip(1)
                .all(|path| path.contains("/v1/classifications/authority/baseline")),
            "{paths:?}"
        );
    }

    #[test]
    fn a_server_without_the_classification_domain_changes_nothing() {
        let script = vec![(
            serde_json::json!({
                "protocolVersion": 1, "active": false, "libraryId": null, "domains": []
            }),
            200,
        )];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                 VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z')",
                [],
            )
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO asset_classifications (asset_id, classification_id)
                 VALUES ('asset-1', 'originals')",
                [],
            )
            .unwrap();
        let reconciliation = library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        let paths = server.finish();
        assert!(!reconciliation.adopted);
        assert!(!reconciliation.adopted_baseline);
        assert_eq!(paths.len(), 1, "only discovery runs: {paths:?}");
        let connection = library.connection().unwrap();
        // No adoption row, no caches, and local Classification state is untouched.
        assert!(authority(&connection).is_none());
        assert!(revision_cache(&connection).is_empty());
        assert!(assignment_cache(&connection).is_empty());
        assert_eq!(projections(&connection), [("asset-1".to_owned(), "originals".to_owned())]);
        assert!(entries(&connection).iter().any(|(id, _, _, _)| id == "originals"));
    }

    #[test]
    fn a_wrong_contract_version_is_rejected_without_local_writes() {
        let script = vec![(
            serde_json::json!({
                "protocolVersion": 1,
                "active": true,
                "libraryId": LIBRARY,
                "domains": [{
                    "domain": "classifications", "libraryId": LIBRARY,
                    "epoch": 1, "contractVersion": 2, "cursor": 4
                }]
            }),
            200,
        )];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::ClassificationContractUnsupported));
        let connection = library.connection().unwrap();
        assert!(authority(&connection).is_none());
        assert!(entries(&connection).is_empty());
    }

    #[test]
    fn a_server_library_mismatch_is_rejected_and_never_adopts_the_other_library() {
        let script = vec![(
            serde_json::json!({
                "protocolVersion": 1,
                "active": true,
                "libraryId": OTHER_LIBRARY,
                "domains": [{
                    "domain": "classifications", "libraryId": OTHER_LIBRARY,
                    "epoch": 1, "contractVersion": 1, "cursor": 4
                }]
            }),
            200,
        )];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::ClassificationAuthorityMismatch));
        {
            let connection = library.connection().unwrap();
            assert!(authority(&connection).is_none(), "fail closed: no adoption");
        }
        // The lock is non-reentrant, so the identity is read after releasing it.
        assert_eq!(
            library.library_id().unwrap(),
            LIBRARY,
            "the local identity must not be replaced by the remote one"
        );
    }

    #[test]
    fn a_change_page_replayed_over_a_socket_applies_and_advances_the_cursor() {
        let script = vec![
            (status_body(4), 200),
            (classification_change_page(4, 4, "originals", "새 이름", 2), 200),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        adopt_one_root(&library, 3);
        let reconciliation = library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        server.finish();
        assert_eq!(reconciliation.applied_changes, 1);
        assert_eq!(reconciliation.local_cursor, Some(4));
        assert_eq!(reconciliation.server_cursor, Some(4));
        let connection = library.connection().unwrap();
        assert!(entries(&connection)
            .iter()
            .any(|(id, _, name, _)| id == "originals" && name == "새 이름"));
        assert!(revision_cache(&connection).contains(&("originals".to_owned(), 2, 0)));
    }

    #[test]
    fn the_servers_delete_change_shape_applies_through_the_real_client() {
        let script = vec![
            (status_body(5), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 5,
                    "items": [{
                        "sequence": 5, "authorityCursor": 5,
                        "commandType": "deleteClassification", "operationId": "op-delete",
                        "changedAt": "2026-09-16T00:00:00Z",
                        "classification": {
                            "id": "series", "kind": "tag", "name": "시리즈", "parentId": null,
                            "iconKey": null, "colorKey": null, "deleted": true,
                            "entityRevision": 3
                        },
                        "assignmentTransition": {
                            "fromClassificationId": "series",
                            "toClassificationId": "originals",
                            "affectsAssignments": 1
                        }
                    }],
                    "nextAfter": 5, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("series", "시리즈", Some("originals"), 2),
                ],
                &[assignment("asset-1", Some("series"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();
        library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        server.finish();
        let connection = library.connection().unwrap();
        assert!(!entries(&connection).iter().any(|(id, _, _, _)| id == "series"));
        assert!(revision_cache(&connection).contains(&("series".to_owned(), 3, 1)));
        assert_eq!(
            assignment_cache(&connection),
            [("asset-1".to_owned(), Some("originals".to_owned()), 2)]
        );
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 5)));
    }

    #[test]
    fn an_expired_cursor_triggers_a_fresh_baseline_rebase() {
        let baseline = complete_baseline(9);
        let script = vec![
            (status_body(9), 200),
            (serde_json::json!({"detail": {"code": "cursorExpired"}}), 409),
            (baseline[0].clone(), 200),
            (baseline[1].clone(), 200),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        adopt_one_root(&library, 3);
        let reconciliation = library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        let paths = server.finish();
        assert!(reconciliation.adopted_baseline, "expiry recovers by re-basing");
        assert!(
            paths[1].contains("after=3"),
            "the stale cursor was resumed first: {}",
            paths[1]
        );
        let connection = library.connection().unwrap();
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 9)));
        assert_eq!(projections(&connection), [("asset-1".to_owned(), "series".to_owned())]);
    }

    #[test]
    fn a_cursor_ahead_of_the_server_triggers_a_safe_rebase() {
        let baseline = complete_baseline(2);
        let script = vec![
            (status_body(2), 200),
            (serde_json::json!({"detail": {"code": "cursorAhead"}}), 409),
            (baseline[0].clone(), 200),
            (baseline[1].clone(), 200),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // A stored cursor far beyond the server's: identity skew, not retention.
        adopt_one_root(&library, 900);
        let reconciliation = library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        server.finish();
        assert!(reconciliation.adopted_baseline);
        let connection = library.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 2)),
            "the skewed cursor is replaced by the authority's own"
        );
    }

    #[test]
    fn a_snapshot_cursor_change_between_pages_does_not_combine_two_states() {
        let script = vec![
            (status_body(4), 200),
            // The first page freezes snapshot 4 and claims more work.
            (
                baseline_page(
                    4,
                    "classifications",
                    serde_json::json!([classification_item(
                        "originals",
                        "root",
                        "오리지널",
                        None,
                        1
                    )]),
                    Some("originals"),
                    true,
                    false,
                ),
                200,
            ),
            // The next page belongs to a different materialized state.
            (
                baseline_page(5, "classifications", serde_json::json!([]), None, false, false),
                200,
            ),
            // The bounded retry re-reads from page one and completes at the newer cursor.
            (complete_baseline(5)[0].clone(), 200),
            (complete_baseline(5)[1].clone(), 200),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        seed_matching_local_state(&library);
        let reconciliation = library
            .reconcile_classification_authority(&client, "token")
            .unwrap();
        let paths = server.finish();
        assert!(reconciliation.adopted_baseline);
        assert!(
            paths[2].contains("snapshot=4"),
            "later pages must name the frozen cursor: {}",
            paths[2]
        );
        let connection = library.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 5)),
            "only the state the completed walk described is adopted"
        );
        assert_eq!(
            entries(&connection).len(),
            2,
            "pages from two different snapshots were not combined"
        );
    }

    #[test]
    fn inconsistent_roles_across_baseline_pages_are_rejected() {
        let second_page = baseline_page(
            4,
            "classifications",
            serde_json::json!([]),
            None,
            false,
            false,
        );
        let mut second_page = second_page;
        // The role set differs on this page, so the walk describes two different states.
        second_page["roles"] =
            serde_json::json!([{"role": "originals", "classificationId": "someone-else"}]);
        let script = vec![
            (status_body(4), 200),
            (
                baseline_page(
                    4,
                    "classifications",
                    serde_json::json!([classification_item(
                        "originals",
                        "root",
                        "오리지널",
                        None,
                        1
                    )]),
                    Some("originals"),
                    true,
                    false,
                ),
                200,
            ),
            (second_page, 200),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
        let connection = library.connection().unwrap();
        assert!(authority(&connection).is_none());
        assert!(entries(&connection).is_empty());
    }

    #[test]
    fn a_non_progressing_baseline_page_is_refused() {
        let script = vec![
            (status_body(4), 200),
            // Claims more work but does not advance `nextAfter`.
            (
                baseline_page(
                    4,
                    "classifications",
                    serde_json::json!([classification_item(
                        "originals",
                        "root",
                        "오리지널",
                        None,
                        1
                    )]),
                    None,
                    true,
                    false,
                ),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
        let connection = library.connection().unwrap();
        assert!(authority(&connection).is_none());
    }

    #[test]
    fn a_partial_baseline_failure_writes_nothing() {
        let script = vec![
            (status_body(4), 200),
            // The walk is cut short: no second page ever arrives.
            (
                baseline_page(
                    4,
                    "classifications",
                    serde_json::json!([classification_item(
                        "originals",
                        "root",
                        "오리지널",
                        None,
                        1
                    )]),
                    Some("originals"),
                    true,
                    false,
                ),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::CloudRequestUnavailable));
        let connection = library.connection().unwrap();
        assert!(authority(&connection).is_none());
        assert!(
            entries(&connection).is_empty(),
            "a page that arrived before the failure must not be installed"
        );
    }

    #[test]
    fn a_bad_delete_change_shape_is_refused_without_moving_the_cursor() {
        let script = vec![
            (status_body(4), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 4,
                    "items": [{
                        "sequence": 4, "authorityCursor": 4,
                        "commandType": "deleteClassification", "operationId": "op-bad",
                        "changedAt": "2026-09-16T00:00:00Z",
                        "classification": {
                            "id": "series", "kind": "tag", "name": "시리즈", "parentId": null,
                            "iconKey": null, "colorKey": null, "deleted": true,
                            "entityRevision": 3
                        },
                        "assignmentTransition": {
                            "fromClassificationId": "someone-else",
                            "toClassificationId": "originals",
                            "affectsAssignments": 0
                        }
                    }],
                    "nextAfter": 4, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        adopt_one_root(&library, 3);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
        let connection = library.connection().unwrap();
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
    }

    /// A malformed or foreign `/changes` page must be refused by the real client before any
    /// local write, leaving the replica and the cursor exactly where they were.
    #[test]
    fn a_malformed_change_page_leaves_the_replica_unchanged() {
        fn page(
            library_id: &str,
            epoch: i64,
            contract_version: i64,
            cursor: i64,
            items: serde_json::Value,
            next_after: i64,
            has_more: bool,
        ) -> serde_json::Value {
            serde_json::json!({
                "libraryId": library_id,
                "epoch": epoch,
                "contractVersion": contract_version,
                "cursor": cursor,
                "items": items,
                "nextAfter": next_after,
                "hasMore": has_more,
            })
        }
        let change = serde_json::json!([{
            "sequence": 4, "authorityCursor": 4,
            "commandType": "renameClassification", "operationId": "op-4",
            "changedAt": "2026-09-16T00:00:00Z",
            "classification": classification_item("originals", "root", "새 이름", None, 2)
        }]);
        let cases = [
            (
                "wrong libraryId",
                page(OTHER_LIBRARY, 1, 1, 5, change.clone(), 4, true),
            ),
            ("wrong epoch", page(LIBRARY, 9, 1, 5, change.clone(), 4, true)),
            ("wrong contractVersion", page(LIBRARY, 1, 9, 5, change.clone(), 4, true)),
            (
                "nextAfter beyond the cursor",
                page(LIBRARY, 1, 1, 4, change.clone(), 5, false),
            ),
            (
                "nextAfter behind the requested cursor",
                page(LIBRARY, 1, 1, 9, change.clone(), 2, true),
            ),
            (
                "hasMore disagrees with the cursors",
                page(LIBRARY, 1, 1, 9, change.clone(), 4, false),
            ),
            (
                "empty page advances",
                page(LIBRARY, 1, 1, 9, serde_json::json!([]), 7, true),
            ),
        ];
        for (label, body) in cases {
            let script = vec![(status_body(9), 200), (body, 200)];
            let server = Scripted::start(script);
            let client = CloudClient::new(&server.base).unwrap();
            let (_temp, library) = open();
            pin_library_id(&library);
            adopt_one_root(&library, 3);
            let error = library
                .reconcile_classification_authority(&client, "token")
                .unwrap_err();
            server.finish();
            assert!(
                matches!(
                    error,
                    LibraryError::InvalidCloudResponse | LibraryError::ClassificationAuthorityMismatch
                ),
                "{label} must be refused, got {error:?}"
            );
            let connection = library.connection().unwrap();
            assert_eq!(
                authority(&connection),
                Some((LIBRARY.to_owned(), 1, 1, 3)),
                "{label} must not move the cursor"
            );
            assert!(
                !entries(&connection).iter().any(|(id, _, name, _)| id == "originals" && name == "새 이름"),
                "{label} must not apply the row"
            );
        }
    }

    /// A row whose `authorityCursor` disagrees with its sequence is not the change it claims.
    #[test]
    fn a_change_row_with_a_mismatched_authority_cursor_is_refused() {
        let script = vec![
            (status_body(4), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 4,
                    "items": [{
                        "sequence": 4, "authorityCursor": 3,
                        "commandType": "renameClassification", "operationId": "op-4",
                        "changedAt": "2026-09-16T00:00:00Z",
                        "classification": classification_item("originals", "root", "새 이름", None, 2)
                    }],
                    "nextAfter": 4, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let (_temp, library) = open();
        pin_library_id(&library);
        adopt_one_root(&library, 3);
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        server.finish();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
        let connection = library.connection().unwrap();
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
    }

    /// The checked-in cross-language fixture must deserialize and validate through the
    /// real client contract.
    ///
    /// The fixture is produced by running the server's own encoders
    /// (`tests/fixtures/classification-authority-wire.py` calls `encode_page`,
    /// `classification_projection`, `assignment_projection` and `role_projection` from
    /// `server/lakomics-api/classification_authority.py`), so a Rust-only expectation
    /// cannot silently drift from what the server sends.
    #[test]
    fn the_server_wire_fixture_deserializes_through_the_client_contract() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/classification-authority-wire.json"
        ))
        .unwrap();
        let page: crate::cloud::client::ClassificationBaselinePage =
            serde_json::from_value(fixture["classificationPage"].clone()).unwrap();
        assert_eq!(page.section, "classifications");
        assert!(
            !page.complete,
            "the classification page is never the completing one"
        );
        assert_eq!(
            page.roles,
            vec![ClassificationRoleProjection {
                role: "originals".to_owned(),
                classification_id: "originals".to_owned()
            }],
            "the role projection binds to the server's own wire key"
        );
        let (classifications, assignments) = page.decode().unwrap();
        assert!(assignments.is_empty());
        assert_eq!(
            classifications.len(),
            2,
            "the fixture carries the hierarchy the server encodes"
        );

        let assignment_page: crate::cloud::client::ClassificationBaselinePage =
            serde_json::from_value(fixture["assignmentPage"].clone()).unwrap();
        assert!(
            assignment_page.complete,
            "only the final assignment page completes"
        );
        let (_, assignments) = assignment_page.decode().unwrap();
        assert_eq!(assignments.len(), 2);
        // An unassigned Asset is a retained row with a null classification id at a real
        // revision, which is exactly what the server's assignment projection encodes.
        assert_eq!(
            assignments
                .iter()
                .filter(|value| value.classification_id.is_none())
                .count(),
            1
        );

        let changes: crate::cloud::client::ClassificationChanges =
            serde_json::from_value(fixture["changes"].clone()).unwrap();
        assert_eq!(changes.items.len(), 2);
        // A normal change carries one assignment delta.
        let (classification, assignment, transition) = changes.items[0].delta().unwrap();
        assert!(classification.is_none());
        assert!(assignment.is_some());
        assert!(transition.is_none());
        // The delete change carries the two-part shape the server emits.
        let (classification, assignment, transition) = changes.items[1].delta().unwrap();
        assert!(classification.is_some_and(|value| value.deleted));
        assert!(assignment.is_none());
        assert_eq!(
            transition.map(|value| value.affects_assignments),
            Some(1),
            "the delete transition is the server's own count"
        );
    }

    // -----------------------------------------------------------------------
    // Deleting a Classification that holds Assets converges end to end
    // -----------------------------------------------------------------------

    /// The delete command body the server would accept, keyed to a real queued intent.
    fn delete_change_row(sequence: i64, classification_id: &str, to: Option<&str>, affects: i64,
                         operation_id: &str) -> serde_json::Value {
        serde_json::json!({
            "sequence": sequence,
            "authorityCursor": sequence,
            "commandType": "deleteClassification",
            "operationId": operation_id,
            "changedAt": "2026-09-17T00:00:00Z",
            "classification": {
                "id": classification_id,
                "kind": "tag",
                "name": "삭제됨",
                "parentId": null,
                "iconKey": null,
                "colorKey": null,
                "deleted": true,
                "entityRevision": 2
            },
            "assignmentTransition": {
                "fromClassificationId": classification_id,
                "toClassificationId": to,
                "affectsAssignments": affects
            }
        })
    }

    /// One accepted delete: the tombstone, the transition, and the cursor it occupies.
    fn accepted_delete(operation_id: &str, classification_id: &str, to: Option<&str>,
                       affects: i64, revision: i64, sequence: i64) -> serde_json::Value {
        serde_json::json!({
            "libraryId": LIBRARY,
            "epoch": 1,
            "contractVersion": 1,
            "commandType": "deleteClassification",
            "operationId": operation_id,
            "changed": true,
            "changeSequence": sequence,
            "authorityCursor": sequence,
            "classification": {
                "id": classification_id,
                "kind": "tag",
                "name": "삭제됨",
                "parentId": null,
                "iconKey": null,
                "colorKey": null,
                "deleted": true,
                "entityRevision": revision
            },
            "assignments": [],
            "assignmentTransition": {
                "fromClassificationId": classification_id,
                "toClassificationId": to,
                "affectsAssignments": affects
            },
            "updatedAt": "2026-09-17T00:00:00Z"
        })
    }

    /// Adopt a replica whose Asset is assigned to a deletable child Classification.
    ///
    /// `asset-1 -> doomed`, `doomed` under a live `parent`, with `asset-1` a real local Asset
    /// so the assignment is materialized rather than deferred. The cursor is 1, so the delete
    /// the server accepts lands at sequence 2.
    fn adopt_asset_in_doomed(library: &Library) {
        library
            .install_classification_baseline_for_test(
                &[
                    // The role binding is `ON DELETE RESTRICT` against this table, so the
                    // node it names has to exist in every baseline a test installs.
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                    // The reassignment target for the second test in this pair.
                    classification("other", "기타", None, 1),
                ],
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                1,
            )
            .unwrap();
    }

    /// Deleting a Classification that holds an Asset converges through the real path.
    ///
    /// The local delete moves the Asset to the parent and queues exactly one structural
    /// intent. Once the server confirms it, the assignment cache must no longer describe the
    /// deleted Classification: the confirmed result is the authority's own post-delete
    /// lineage, and the following receive replays the same transition. Mixing "state at the
    /// cursor" with "state a later confirmed command produced" let the cache keep naming a
    /// Classification the authority had already deleted, so the deferred-assignment
    /// projection then refused the very change that would have corrected it.
    #[test]
    fn deleting_a_classification_holding_an_asset_converges() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        adopt_asset_in_doomed(&library);
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        assert_eq!(queued.len(), 1, "one structural intent owns the whole effect");

        let (operation_id, _, _) = queued[0].clone();
        let script = vec![
            // 1. The delete is accepted at sequence 2.
            (
                accepted_delete(&operation_id, "doomed", Some("parent"), 1, 2, 2),
                200,
            ),
            // 2. `/status` now advertises cursor 2.
            (status_body(2), 200),
            // 3. `/changes` replays the same delete as one change.
            (
                serde_json::json!({
                    "libraryId": LIBRARY,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 2,
                    "items": [
                        serde_json::json!({
                            "sequence": 2,
                            "authorityCursor": 2,
                            "commandType": "deleteClassification",
                            "operationId": operation_id,
                            "changedAt": "2026-09-16T00:00:00Z",
                            "classification": {
                                "id": "doomed", "kind": "tag", "name": "삭제될",
                                "parentId": null, "iconKey": null, "colorKey": null,
                                "deleted": true, "entityRevision": 2
                            },
                            "assignmentTransition": {
                                "fromClassificationId": "doomed",
                                "toClassificationId": "parent",
                                "affectsAssignments": 1
                            }
                        })
                    ],
                    "nextAfter": 2,
                    "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();

        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        assert!(outbox_rows(&library.connection().unwrap()).is_empty());

        let result = library
            .reconcile_classification_authority(&client, "token");
        let result = result.expect("a confirmed delete must converge the replica");
        server.finish();
        assert!(result.adopted);

        let connection = library.connection().unwrap();
        // The Asset ends in the server-authoritative destination ...
        assert_eq!(
            projections(&connection),
            [("asset-1".to_owned(), "parent".to_owned())],
            "the Asset converges to the deleted Classification's parent"
        );
        // ... and nothing anywhere still names the deleted Classification.
        assert_eq!(
            assignment_cache(&connection),
            [("asset-1".to_owned(), Some("parent".to_owned()), 2)],
            "the confirmed lineage names the destination, not the deleted node"
        );
        let stale: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_assignment_revisions
                 WHERE classification_id = 'doomed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "no cached lineage may still point at the deleted node");
        assert!(assignment_naming_count(&connection, "doomed") == 0);
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 2)));
    }

    /// How many cached assignment lineages name a Classification.
    fn assignment_naming_count(connection: &Connection, classification_id: &str) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_assignment_revisions
                 WHERE classification_id = ?1",
                [classification_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// A delete change cannot prove its own transition was already applied.
    ///
    /// The transition is verified against the assignment cache: `affectsAssignments` counts
    /// the assignments naming the Classification when the server deleted it, and a replica at
    /// a valid cursor holds exactly that set. Reading the tombstone this same replay just
    /// wrote would make the verification unfalsifiable — every delete would look "already
    /// materialized" — so a page claiming assignments the replica never had would advance the
    /// cursor over state it cannot reproduce.
    #[test]
    fn a_delete_claiming_assignments_the_replica_never_had_is_refused() {
        let (_temp, library) = open();
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("doomed", "삭제될", Some("originals"), 1),
                ],
                // Nothing names `doomed`, so this replica holds none of the assignments the
                // server says the delete moved — and nothing pre-applied the transition.
                &[],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                3,
            )
            .unwrap();

        let error = library
            .apply_classification_page_for_test(
                &[delete_change(
                    4,
                    tombstone("doomed", "삭제될", 2),
                    transition("doomed", Some("originals"), 1),
                )],
                4,
            )
            .unwrap_err();

        assert!(
            matches!(error, LibraryError::InvalidCloudResponse),
            "a transition with no matching lineage must fail closed, got {error:?}"
        );
        let connection = library.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 3)),
            "the cursor must not advance over a page that failed"
        );
        assert!(
            entries(&connection).iter().any(|(id, _, _, _)| id == "doomed"),
            "the incoming tombstone must roll back with the refused page"
        );
        // The baseline recorded a *live* revision for `doomed`; the refused page must not
        // have replaced it with the tombstone's revision.
        assert_eq!(
            revision_cache(&connection)
                .into_iter()
                .find(|(id, _, _)| id == "doomed"),
            Some(("doomed".to_owned(), 1, 0)),
            "the refused page must not commit its tombstone over the live revision"
        );
    }

    /// A partially pre-applied delete converges when the unseen changes arrive later.
    ///
    /// A real multi-device history can make the server count assignments this PC has never
    /// heard of: another device assigned `B -> C` at a sequence this replica has not reached,
    /// so when the PC's own delete of `C` runs the server moves *two* lineages. The PC could
    /// pre-apply the transition only to the one lineage it held.
    ///
    /// Replay must therefore account for pre-applied work explicitly instead of inferring it
    /// from the tombstone: `pre-applied + still-naming = affectsAssignments`, and only the
    /// still-naming remainder moves. Inferring from the tombstone would skip moving `B` while
    /// still advancing the cursor, leaving a lineage naming a deleted Classification forever.
    #[test]
    fn a_partially_pre_applied_delete_converges_when_the_unseen_change_arrives() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        insert_asset(&library, "asset-2");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                ],
                // Only A is known to this replica; the other device's `B -> C` sits at
                // sequence 11, which this cursor (10) has not reached.
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                10,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        assert_eq!(queued.len(), 1);
        let (delete_op, _, _) = queued[0].clone();

        let script = vec![
            // The server accepted the delete at sequence 12 and moved both lineages.
            (
                accepted_delete(&delete_op, "doomed", Some("parent"), 2, 2, 12),
                200,
            ),
            (status_body(12), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 12,
                    "items": [
                        // The other device's assignment, which this PC had not seen.
                        {
                            "sequence": 11, "authorityCursor": 11,
                            "commandType": "setAssetClassification",
                            "operationId": "other-device-op",
                            "changedAt": "2026-09-16T00:00:00Z",
                            "assignment": {
                                "assetId": "asset-2",
                                "classificationId": "doomed",
                                "entityRevision": 1
                            }
                        },
                        // The PC's own delete, counting both Asset lineages.
                        {
                            "sequence": 12, "authorityCursor": 12,
                            "commandType": "deleteClassification",
                            "operationId": delete_op,
                            "changedAt": "2026-09-16T00:00:01Z",
                            "classification": {
                                "id": "doomed", "kind": "tag", "name": "삭제될",
                                "parentId": null, "iconKey": null, "colorKey": null,
                                "deleted": true, "entityRevision": 2
                            },
                            "assignmentTransition": {
                                "fromClassificationId": "doomed",
                                "toClassificationId": "parent",
                                "affectsAssignments": 2
                            }
                        }
                    ],
                    "nextAfter": 12, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();

        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        // The pre-application moved only the lineage this replica actually held.
        {
            let connection = library.connection().unwrap();
            assert_eq!(
                assignment_cache(&connection),
                [("asset-1".to_owned(), Some("parent".to_owned()), 2)],
                "only the known lineage is pre-applied"
            );
            assert_eq!(assignment_naming_count(&connection, "doomed"), 0);
        }

        let result = library
            .reconcile_classification_authority(&client, "token")
            .expect("partial pre-application plus the unseen change must converge");
        server.finish();
        assert!(result.adopted);

        let connection = library.connection().unwrap();
        assert_eq!(result.applied_changes, 2, "both changes are replayed");
        assert_eq!(
            assignment_cache(&connection),
            [
                ("asset-1".to_owned(), Some("parent".to_owned()), 2),
                ("asset-2".to_owned(), Some("parent".to_owned()), 2),
            ],
            "the unseen lineage moves too, at the revision the server's transition implies"
        );
        assert_eq!(
            projections(&connection),
            [
                ("asset-1".to_owned(), "parent".to_owned()),
                ("asset-2".to_owned(), "parent".to_owned()),
            ],
            "both Assets converge to the delete destination"
        );
        assert_eq!(
            assignment_naming_count(&connection, "doomed"),
            0,
            "nothing may still name the deleted Classification"
        );
        // The marker must be consumed by the replay it accounted for, so it cannot excuse a
        // later delete that reused the operation id.
        let markers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(markers, 0, "no stale pre-applied-transition marker may remain");
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 12)));
    }

    /// A delete that pre-applied zero local assignments still records its transition.
    ///
    /// The PC may hold no lineage naming `C` at all — another device created `B -> C` at a
    /// sequence this replica has not reached — so confirmation moves nothing. The transition
    /// still has to be durable: replay must know this delete is already structurally confirmed
    /// at a specific sequence, which is what makes the earlier `B -> C` legitimate rather than
    /// an assignment to a deleted Classification (see
    /// `an_assignment_to_an_already_deleted_classification_is_refused`).
    #[test]
    fn a_delete_that_preapplied_nothing_still_records_its_transition() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-2");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                ],
                // Nothing names `doomed` locally, so the delete moves nothing here.
                &[],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                10,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        let (delete_op, _, _) = queued[0].clone();

        let script = vec![
            (
                accepted_delete(&delete_op, "doomed", Some("parent"), 1, 2, 12),
                200,
            ),
            (status_body(12), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 12,
                    "items": [
                        {
                            "sequence": 11, "authorityCursor": 11,
                            "commandType": "setAssetClassification",
                            "operationId": "other-device-op",
                            "changedAt": "2026-09-16T00:00:00Z",
                            "assignment": {
                                "assetId": "asset-2",
                                "classificationId": "doomed",
                                "entityRevision": 1
                            }
                        },
                        {
                            "sequence": 12, "authorityCursor": 12,
                            "commandType": "deleteClassification",
                            "operationId": delete_op,
                            "changedAt": "2026-09-16T00:00:01Z",
                            "classification": {
                                "id": "doomed", "kind": "tag", "name": "삭제될",
                                "parentId": null, "iconKey": null, "colorKey": null,
                                "deleted": true, "entityRevision": 2
                            },
                            "assignmentTransition": {
                                "fromClassificationId": "doomed",
                                "toClassificationId": "parent",
                                "affectsAssignments": 1
                            }
                        }
                    ],
                    "nextAfter": 12, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        // The transition header must exist even though no member was pre-applied: that is what
        // lets replay recognise seq 11 as historically earlier than this delete.
        {
            let connection = library.connection().unwrap();
            let headers: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(headers, 1, "a zero-member transition is still recorded");
        }

        let result = library
            .reconcile_classification_authority(&client, "token")
            .expect("zero local pre-application plus the unseen change must converge");
        server.finish();
        assert!(result.adopted);

        let connection = library.connection().unwrap();
        assert_eq!(result.applied_changes, 2);
        assert_eq!(
            assignment_cache(&connection),
            [("asset-2".to_owned(), Some("parent".to_owned()), 2)],
            "the unseen lineage moves to the delete destination"
        );
        assert_eq!(
            assignment_naming_count(&connection, "doomed"),
            0,
            "nothing may still name the deleted Classification"
        );
        let markers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(markers, 0, "the transition state is retired after replay");
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 12)));
    }

    /// An unseen assignment *leaving* the deleted Classification must not be counted twice.
    ///
    /// The opposite direction from the unseen-`B -> C` case: another device moved `A` out of
    /// `C` at a sequence this replica has not reached, so when the PC's own delete of `C` runs
    /// the server finds *no* assignments naming `C` and reports `affectsAssignments = 0`.
    ///
    /// The stale local cache still said `A -> C`, so confirmation pre-applied the transition to
    /// `A`. A bare count cannot express that this pre-application is now void: replaying seq 11
    /// (`A -> D`) supersedes it, so `1 + 0 != 0` would reject valid server history.
    ///
    /// The pre-applied work therefore has to be tracked per *lineage*, and an earlier change to
    /// a lineage must invalidate that lineage's contribution before the delete is verified.
    #[test]
    fn an_unseen_assignment_leaving_the_deleted_classification_still_converges() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                    classification("elsewhere", "다른 곳", None, 1),
                ],
                // This PC still believes A names `doomed`; the other device already moved it.
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                10,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        assert_eq!(queued.len(), 1);
        let (delete_op, _, _) = queued[0].clone();

        let script = vec![
            // The server's delete moved nothing: no lineage named `doomed` by then.
            (
                accepted_delete(&delete_op, "doomed", Some("parent"), 0, 2, 12),
                200,
            ),
            (status_body(12), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 12,
                    "items": [
                        // The other device's earlier move, which this PC had not seen.
                        {
                            "sequence": 11, "authorityCursor": 11,
                            "commandType": "setAssetClassification",
                            "operationId": "other-device-op",
                            "changedAt": "2026-09-16T00:00:00Z",
                            "assignment": {
                                "assetId": "asset-1",
                                "classificationId": "elsewhere",
                                "entityRevision": 2
                            }
                        },
                        {
                            "sequence": 12, "authorityCursor": 12,
                            "commandType": "deleteClassification",
                            "operationId": delete_op,
                            "changedAt": "2026-09-16T00:00:01Z",
                            "classification": {
                                "id": "doomed", "kind": "tag", "name": "삭제될",
                                "parentId": null, "iconKey": null, "colorKey": null,
                                "deleted": true, "entityRevision": 2
                            },
                            "assignmentTransition": {
                                "fromClassificationId": "doomed",
                                "toClassificationId": "parent",
                                "affectsAssignments": 0
                            }
                        }
                    ],
                    "nextAfter": 12, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();

        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1, "the delete is accepted at sequence 12");
        // The stale cache made confirmation pre-apply the transition to A.
        {
            let connection = library.connection().unwrap();
            assert_eq!(
                assignment_cache(&connection),
                [("asset-1".to_owned(), Some("parent".to_owned()), 2)],
                "the stale lineage was pre-applied"
            );
        }

        let result = library
            .reconcile_classification_authority(&client, "token")
            .expect("an unseen move out of the deleted Classification must still converge");
        server.finish();
        assert!(result.adopted);

        let connection = library.connection().unwrap();
        assert_eq!(result.applied_changes, 2, "both changes are replayed");
        // seq 11 wins over the voided pre-application, and the delete adds nothing.
        assert_eq!(
            assignment_cache(&connection),
            [("asset-1".to_owned(), Some("elsewhere".to_owned()), 2)],
            "the earlier move out of C is authoritative; the delete must not re-move it"
        );
        assert_eq!(
            projections(&connection),
            [("asset-1".to_owned(), "elsewhere".to_owned())],
            "the Asset converges to where the other device put it"
        );
        assert_eq!(
            assignment_naming_count(&connection, "doomed"),
            0,
            "nothing may still name the deleted Classification"
        );
        let markers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(markers, 0, "the transition state is fully retired");
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 12)));
    }

    /// A delete claiming work this replica cannot account for is refused.
    ///
    /// The authority's delete moved every lineage naming `C` at the time, and this PC's own
    /// confirmation moved whatever *it* held — which can be fewer, because the rest are
    /// lineages this replica has never seen. Replay can therefore only bound the remainder:
    /// the lineages still naming `from` must not account for *less* than the delete claims
    /// beyond what the pre-application itself moved.
    ///
    /// Here the delete claims five lineages, the pre-application moved two, and the cache now
    /// holds none. Three lineages the authority moved are neither here nor accounted for, so
    /// the replica is missing state and advancing would bury that silently.
    #[test]
    fn a_delete_claiming_lineages_this_replica_cannot_account_for_is_refused() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                ],
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                10,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        let (delete_op, _, _) = queued[0].clone();

        // The authority reports five affected lineages; this PC held only one, so its own
        // confirmation moves exactly one and records both numbers truthfully.
        let script = vec![(
            accepted_delete(&delete_op, "doomed", Some("parent"), 5, 2, 11),
            200,
        )];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        server.finish();
        {
            let connection = library.connection().unwrap();
            let (affects, moved): (i64, i64) = connection
                .query_row(
                    "SELECT affects_assignments, preapplied_moved
                     FROM classification_authority_preapplied_deletes WHERE operation_id = ?1",
                    [&delete_op],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                (affects, moved),
                (5, 1),
                "both the authority's count and this PC's own work are recorded"
            );
        }

        // The change agrees with the record, but the cache can only account for the one
        // lineage the pre-application moved — three remain unexplained.
        let error = library
            .apply_classification_page_for_test(
                &[
                    assignment_change(11, assignment("asset-1", Some("parent"), 2)),
                    // The change names the very operation whose record is stored, so replay
                    // takes the pre-application-aware path rather than the no-record one.
                    delete_change_for_operation(
                        12,
                        tombstone("doomed", "삭제될", 2),
                        transition("doomed", Some("parent"), 5),
                        &delete_op,
                    ),
                ],
                12,
            )
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::InvalidCloudResponse),
            "a delete claiming unaccountable lineages must be refused, got {error:?}"
        );
        assert_eq!(
            authority(&library.connection().unwrap()),
            Some((LIBRARY.to_owned(), 1, 1, 10)),
            "the cursor must not advance over the refused page"
        );
    }

    /// A delete whose change contradicts the count the authority reported is refused.
    ///
    /// The durable record and the change row are two statements about one operation. They
    /// describe different values, the response does not belong to the command this PC
    /// confirmed, and applying it would let a page redefine work the authority already
    /// reported as done.
    ///
    /// The count alone would not catch this: with the pre-application having moved the one
    /// lineage it held, a change claiming the delete moved *nothing* leaves a remainder of zero,
    /// which the bound accepts. Only comparing against the authority's own recorded count
    /// falsifies it.
    #[test]
    fn a_delete_that_contradicts_its_recorded_count_is_refused() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                ],
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                1,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        let (delete_op, _, _) = queued[0].clone();

        // The authority reports one affected lineage, which this PC also holds.
        let script = vec![(
            accepted_delete(&delete_op, "doomed", Some("parent"), 1, 2, 2),
            200,
        )];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        server.finish();

        // The change names the same operation but claims the delete moved nothing.
        let error = library
            .apply_classification_page_for_test(
                &[delete_change_for_operation(
                    2,
                    tombstone("doomed", "삭제될", 2),
                    transition("doomed", Some("parent"), 0),
                    &delete_op,
                )],
                2,
            )
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::InvalidCloudResponse),
            "a change contradicting the recorded count must be refused, got {error:?}"
        );
        assert_eq!(
            authority(&library.connection().unwrap()),
            Some((LIBRARY.to_owned(), 1, 1, 1)),
            "the cursor must not advance over the refused change"
        );
    }

    /// A delete replayed at a sequence its own record does not name is refused.
    ///
    /// The record and the change row are two statements about one operation, and the sequence
    /// the authority assigned that operation is part of its identity. A change naming the same
    /// operation at a different sequence is not the change this PC confirmed, so applying it
    /// would let a page relocate a confirmed operation inside the log.
    #[test]
    fn a_delete_replayed_at_a_sequence_its_record_does_not_name_is_refused() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                ],
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                1,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        let (delete_op, _, _) = queued[0].clone();

        // The authority confirms the delete at sequence 2.
        let script = vec![(
            accepted_delete(&delete_op, "doomed", Some("parent"), 1, 2, 2),
            200,
        )];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        server.finish();

        // The page replays the same operation at sequence 3, which the record does not name.
        let error = library
            .apply_classification_page_for_test(
                &[
                    // A harmless filler so the delete lands at sequence 3.
                    classification_change(2, classification("originals", "오리지널", None, 2)),
                    delete_change_for_operation(
                        3,
                        tombstone("doomed", "삭제될", 2),
                        transition("doomed", Some("parent"), 1),
                        &delete_op,
                    ),
                ],
                3,
            )
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::InvalidCloudResponse),
            "a delete at a sequence its record does not name must be refused, got {error:?}"
        );
        assert_eq!(
            authority(&library.connection().unwrap()),
            Some((LIBRARY.to_owned(), 1, 1, 1)),
            "the cursor must not advance over the refused page"
        );
    }

    /// An assignment to an already-deleted Classification is refused, even with a tombstone.
    ///
    /// A historical assignment *before* a pre-applied delete is legitimate (see the A1 tests
    /// above). An assignment *after* the delete is not: the server moves every naming lineage
    /// away atomically and validates every assignment target, so it can never emit one. A
    /// tombstone alone is therefore not evidence that such a change is historical.
    #[test]
    fn an_assignment_to_an_already_deleted_classification_is_refused() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // A real confirmed delete with a zero pre-applied count, so a marker legitimately
        // exists for it. The malformed change below must still be refused.
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("doomed", "삭제될", Some("originals"), 1),
                ],
                &[],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                10,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        let (delete_op, _, _) = queued[0].clone();

        let script = vec![
            (
                accepted_delete(&delete_op, "doomed", Some("originals"), 0, 2, 11),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        server.finish();

        // The delete is replayed first (legitimate), then an assignment to the deleted node.
        // The change names the very operation whose pre-applied record exists, so the first
        // change really does consume it — and the page's rollback is what has to restore it.
        assert_eq!(
            preapplied_delete_records(&library.connection().unwrap()),
            1,
            "the confirmed delete left a live pre-application record to consume"
        );
        let error = library
            .apply_classification_page_for_test(
                &[
                    delete_change_for_operation(
                        11,
                        tombstone("doomed", "삭제될", 2),
                        transition("doomed", Some("originals"), 0),
                        &delete_op,
                    ),
                    assignment_change(12, assignment("asset-1", Some("doomed"), 1)),
                ],
                12,
            )
            .unwrap_err();

        assert!(
            matches!(error, LibraryError::InvalidCloudResponse),
            "an assignment to an already-deleted Classification must be refused, got {error:?}"
        );
        let connection = library.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 10)),
            "the cursor must not advance over the refused page"
        );
        assert!(
            assignment_cache(&connection).is_empty(),
            "no assignment cache row may commit for the refused change"
        );
        // The refused page must roll back *whole*. Its first change legitimately replayed the
        // delete, which consumes the pre-application record — so the record surviving proves
        // the transaction was abandoned wholesale rather than the delete alone having committed.
        //
        // That the record really is consumed on a successful replay is asserted separately by
        // `a_delete_that_preapplied_nothing_still_records_its_transition` and the historical
        // test below; here the count is only the evidence of rollback.
        assert_eq!(
            preapplied_delete_records(&connection),
            1,
            "the whole page must roll back, pre-application record included"
        );
    }

    /// A historical assignment before the pre-applied delete remains accepted.
    ///
    /// The complement of the refusal above: the same ordering is legitimate when the assignment
    /// change is *earlier* than a delete this PC has already confirmed and partially projected,
    /// which is exactly what the pre-applied transition marker records.
    #[test]
    fn a_historical_assignment_before_a_preapplied_delete_is_accepted() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    classification("parent", "게임", None, 1),
                    classification("doomed", "삭제될", Some("parent"), 1),
                ],
                &[assignment("asset-1", Some("doomed"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                10,
            )
            .unwrap();
        library.delete_classification("doomed").unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        let (delete_op, _, _) = queued[0].clone();

        let script = vec![
            (
                accepted_delete(&delete_op, "doomed", Some("parent"), 1, 2, 12),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();
        let flush = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(flush.sent, 1);
        server.finish();

        // seq 11 names `doomed`, which the confirmed delete already removed locally, but it is
        // *earlier* than the delete's own sequence 12 — so it is historical, not impossible.
        // The delete names the confirmed operation, so replay matches the durable record, which
        // is the only evidence that makes that ordering claim checkable.
        assert_eq!(
            preapplied_delete_records(&library.connection().unwrap()),
            1,
            "the confirmed delete left a live pre-application record"
        );
        library
            .apply_classification_page_for_test(
                &[
                    assignment_change(11, assignment("asset-1", Some("doomed"), 1)),
                    delete_change_for_operation(
                        12,
                        tombstone("doomed", "삭제될", 2),
                        transition("doomed", Some("parent"), 1),
                        &delete_op,
                    ),
                ],
                12,
            )
            .expect("a historical pre-delete assignment must be tolerated");

        let connection = library.connection().unwrap();
        assert_eq!(
            assignment_cache(&connection),
            [("asset-1".to_owned(), Some("parent".to_owned()), 2)],
            "the delete moved the lineage and nothing still names the deleted node"
        );
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 12)));
        assert_eq!(
            preapplied_delete_records(&connection),
            0,
            "the successful replay must fully retire the matching record"
        );
    }

    /// Deleting then reassigning converges through the real server's revision conflict.
    ///
    /// The server increments an Asset's assignment revision during Classification deletion, so
    /// a `set Asset -> X` composed before the delete presents a stale `expectedRevision` and is
    /// **rejected**, not accepted. The client must rebase only the expectation onto the revision
    /// the delete produced, keep the same operation id and desired value, and retry — which is
    /// the real multi-device history, unlike an acceptance at the pre-delete revision.
    ///
    /// This asserts the wire bodies rather than only the end state: "the rebase preserved the
    /// logical intent" is a claim about what was sent, and a test that only inspects the final
    /// cache cannot tell a legal rebase from a rewritten intent.
    #[test]
    fn deleting_then_reassigning_converges_through_a_real_revision_conflict() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        adopt_asset_in_doomed(&library);
        // 1. Delete `doomed`, which locally moves asset-1 to `parent`.
        library.delete_classification("doomed").unwrap();
        // 2. Reassign asset-1 to a different live Classification before reconciling. Its
        //    expectation is composed from confirmed state, so it still expects revision 1.
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-1".into()],
                classification_id: Some("other".into()),
            })
            .unwrap();
        let queued = outbox_rows(&library.connection().unwrap());
        assert_eq!(
            queued.iter().map(|(_, kind, _)| kind.as_str()).collect::<Vec<_>>(),
            ["deleteClassification", "setAssetClassification"],
            "strict FIFO keeps the delete ahead of the reassignment"
        );
        let (delete_op, _, delete_payload) = queued[0].clone();
        let (assign_op, _, assign_payload) = queued[1].clone();
        let queued_assign: serde_json::Value = serde_json::from_str(&assign_payload).unwrap();
        assert_eq!(
            queued_assign["expectedRevision"], 1,
            "the queued intent is composed against the pre-delete revision"
        );

        let script = vec![
            // The delete is accepted at sequence 2, moving asset-1 to `parent` and taking its
            // lineage to revision 2.
            (
                accepted_delete(&delete_op, "doomed", Some("parent"), 1, 2, 2),
                200,
            ),
            // The stale assignment is rejected: revision 1 no longer matches the server's 2.
            (
                serde_json::json!({ "detail": {
                    "code": "revisionConflict",
                    "authorityCursor": 2,
                    "current": {
                        "assetId": "asset-1",
                        "classificationId": "parent",
                        "entityRevision": 2
                    }
                }}),
                409,
            ),
            // The retried intent is accepted and takes the lineage to revision 3.
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                    "commandType": "setAssetClassification",
                    "operationId": assign_op,
                    "changed": true, "changeSequence": 3, "authorityCursor": 3,
                    "classification": null,
                    "assignments": [{
                        "assetId": "asset-1",
                        "classificationId": "other",
                        "entityRevision": 3
                    }],
                    "assignmentTransition": null,
                    "updatedAt": "2026-09-17T00:00:00Z"
                }),
                200,
            ),
        ];
        let server = Scripted::start(script);
        let client = CloudClient::new(&server.base).unwrap();

        // The first pass sends the delete, whose acceptance rebases the queued assignment, and
        // the rebase stops the pass so the retry is its own step.
        let first = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(first.sent, 1, "the delete is delivered");
        assert_eq!(first.rebased, 1, "the stale assignment rebased rather than blocking");
        assert_eq!(first.blocked, 0);
        // The rebase rewrote only the expectation; the intent is the same one.
        let rebased = outbox_rows(&library.connection().unwrap());
        assert_eq!(rebased.len(), 1, "no second intent was minted");
        assert_eq!(rebased[0].0, assign_op, "the operation id is preserved");
        let rebased_payload: serde_json::Value = serde_json::from_str(&rebased[0].2).unwrap();
        assert_eq!(rebased_payload["expectedRevision"], 2, "rebased onto the delete's revision");
        assert_eq!(rebased_payload["classificationId"], "other", "the desired value is unchanged");
        assert_eq!(rebased_payload["assetId"], "asset-1");
        assert_eq!(rebased_payload["operationId"], assign_op.as_str());

        // The retry is then delivered at the rebased expectation.
        let second = library
            .flush_classification_outbox_with_credentials(&client, "client-token", "publisher-token")
            .unwrap();
        assert_eq!(second.sent, 1, "the rebased retry is accepted");
        assert!(outbox_rows(&library.connection().unwrap()).is_empty());

        // What was on the wire, in order: the delete, the rejected attempt, the retry.
        let bodies = server.bodies();
        assert_eq!(bodies.len(), 3, "three commands reached the server");
        assert_eq!(bodies[0]["commandType"], "deleteClassification");
        assert_eq!(bodies[1]["commandType"], "setAssetClassification");
        assert_eq!(bodies[1]["operationId"], assign_op.as_str());
        assert_eq!(bodies[1]["expectedRevision"], 1, "the stale expectation is what 409'd");
        assert_eq!(bodies[2]["operationId"], assign_op.as_str(), "same logical intent");
        assert_eq!(bodies[2]["expectedRevision"], 2, "retried against the delete's revision");
        assert_eq!(bodies[2]["classificationId"], "other");

        // 8. Replaying the log converges: the delete at seq 2 is fully accounted for by the
        //    pre-applied transition, and the reassignment at seq 3 wins.
        let replay = vec![
            (status_body(3), 200),
            (
                serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 3,
                    "items": [
                        serde_json::json!({
                            "sequence": 2, "authorityCursor": 2,
                            "commandType": "deleteClassification",
                            "operationId": delete_op, "changedAt": "2026-09-16T00:00:00Z",
                            "classification": {
                                "id": "doomed", "kind": "tag", "name": "삭제될",
                                "parentId": null, "iconKey": null, "colorKey": null,
                                "deleted": true, "entityRevision": 2
                            },
                            "assignmentTransition": {
                                "fromClassificationId": "doomed",
                                "toClassificationId": "parent",
                                "affectsAssignments": 1
                            }
                        }),
                        serde_json::json!({
                            "sequence": 3, "authorityCursor": 3,
                            "commandType": "setAssetClassification",
                            "operationId": assign_op, "changedAt": "2026-09-16T00:00:00Z",
                            "assignment": {
                                "assetId": "asset-1",
                                "classificationId": "other",
                                "entityRevision": 3
                            }
                        })
                    ],
                    "nextAfter": 3, "hasMore": false
                }),
                200,
            ),
        ];
        let server = Scripted::start(replay);
        let client = CloudClient::new(&server.base).unwrap();
        let result = library
            .reconcile_classification_authority(&client, "token")
            .expect("replaying the older delete over newer confirmed state must not fail");
        server.finish();
        assert!(result.adopted);

        let connection = library.connection().unwrap();
        assert_eq!(
            projections(&connection),
            [("asset-1".to_owned(), "other".to_owned())],
            "the Asset converges to the reassignment"
        );
        assert_eq!(
            assignment_cache(&connection),
            [("asset-1".to_owned(), Some("other".to_owned()), 3)],
            "the confirmed lineage is the reassignment at the revision the server reported"
        );
        assert_eq!(assignment_naming_count(&connection, "doomed"), 0);
        // 9. No pre-applied marker survives the replay it accounted for.
        let markers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM classification_authority_preapplied_deletes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(markers, 0, "the marker is consumed by the replay");
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 3)));
    }

    /// A local edit committed while `/changes` is in flight must not be overwritten.
    ///
    /// The receive half reads the queue *before* it issues the request, so that read cannot
    /// authorize a write that lands after it. Here the server deliberately blocks its
    /// response until a local mutation has been durably committed, which is exactly the race
    /// the pre-request check cannot see. The page must be abandoned: the optimistic local
    /// state survives, the intent stays queued, and the cursor does not advance.
    #[test]
    fn a_local_edit_during_the_request_is_never_overwritten() {
        use std::sync::mpsc;

        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // Adopt a real replica so the pass takes the incremental `/changes` path.
        library
            .install_classification_baseline_for_test(
                &[
                    classification("originals", "오리지널", None, 1),
                    // A second destination, so the mid-flight local edit has a real target
                    // and the incoming change can name a different one.
                    classification("series", "시리즈", Some("originals"), 2),
                ],
                &[assignment("asset-1", Some("originals"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();
        assert_eq!(
            projections(&library.connection().unwrap()),
            [("asset-1".to_owned(), "originals".to_owned())]
        );

        // The change the server will send moves asset-1 to a *different* Classification, so
        // applying it would visibly replace whatever the local edit chose.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            // 1. `/status` advertises cursor 5.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "classifications",
                        "libraryId": LIBRARY,
                        "epoch": 1,
                        "contractVersion": 1,
                        "cursor": 5
                    }]
                })))
                .unwrap();
            // 2. Hold `/changes` until the test has committed its local edit. The handler
            //    signals readiness first, so the test is never guessing at timing.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/changes"), "{}", request.url());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 5,
                    "items": [{
                        "sequence": 5,
                        "authorityCursor": 5,
                        "commandType": "setAssetClassification",
                        "operationId": "00000000-0000-4000-8000-000000000005",
                        "changedAt": "2026-09-17T00:00:00Z",
                        "assignment": {
                            "assetId": "asset-1",
                            "classificationId": "originals",
                            "entityRevision": 9
                        }
                    }],
                    "nextAfter": 5,
                    "hasMore": false
                })))
                .unwrap();
            // The pass must not ask for another page.
            let _ = server.recv_timeout(Duration::from_millis(500));
        });

        let shared = std::sync::Arc::new(library);
        let worker = std::sync::Arc::clone(&shared);
        // Wait until the server is actually holding the response, then commit a local edit.
        let release = thread::spawn(move || {
            // A short sleep is enough: the request is already parked in the handler.
            thread::sleep(Duration::from_millis(250));
            // The user assigns asset-1 to a different Classification while the response is
            // in flight, which durably queues an intent.
            worker.queue_local_assignment_for_test("asset-1", "series");
            let _ = release_tx.send(());
        });

        let client = CloudClient::new(&base).unwrap();
        let result = shared
            .reconcile_classification_authority(&client, "token")
            .expect("a mid-flight local edit is a deferral, not an error");
        release.join().unwrap();
        handle.join().unwrap();

        assert!(
            result.deferred_to_outbox,
            "the pass must report the intent as taking precedence this cycle"
        );
        assert_eq!(result.applied_changes, 0, "no change row was applied");
        assert_eq!(result.local_cursor, Some(4), "the cursor did not advance");
        let connection = shared.connection().unwrap();
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 4)));
        assert_eq!(
            outbox_rows(&connection).len(),
            1,
            "the local intent is still durably queued"
        );
    }

    /// A baseline install must not overwrite newer authority state installed meanwhile.
    ///
    /// The outbox-clean check alone is not a sufficient precondition. Two receives can both
    /// read the same stored authority and begin a walk from it: B completes first and installs
    /// a newer baseline (say the epoch was re-activated), then A returns, still finds the queue
    /// clean, and would replace B's newer state with the stale baseline it started from. The
    /// cursor would move *backwards* and the replica would describe an authority identity the
    /// server no longer has.
    ///
    /// The install therefore has to prove, inside its own transaction, that the authority state
    /// it was requested against has not moved. That is the same class of re-check as the
    /// outbox guard — a precondition read before the network round trip, re-asserted where it
    /// authorizes the write — and it fails closed the same way.
    #[test]
    fn a_stale_baseline_install_is_refused_when_a_newer_one_landed_first() {
        use std::sync::mpsc;

        let (_temp, library) = open();
        pin_library_id(&library);
        // Every receive starts from this stored authority.
        library
            .install_classification_baseline_for_test(
                &[classification("originals", "오리지널", None, 1)],
                &[],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();

        // Server A advertises epoch 2 and parks on the first baseline page.
        let server_a = Server::http("127.0.0.1:0").unwrap();
        let base_a = format!("http://{}/v1", server_a.server_addr());
        let (parked_tx, parked_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle_a = thread::spawn(move || {
            let request = server_a.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1, "active": true, "libraryId": LIBRARY,
                    "domains": [{"domain": "classifications", "libraryId": LIBRARY,
                                 "epoch": 2, "contractVersion": 1, "cursor": 1}]
                })))
                .unwrap();
            // The first baseline page is held until B has installed its newer state, so A's
            // walk provably spans B's install rather than racing it on timing.
            let request = server_a.recv().unwrap();
            assert!(request.url().contains("/baseline"), "{}", request.url());
            let _ = parked_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            request
                .respond(json_response(baseline_page_at_epoch(
                    2, 1, "classifications",
                    serde_json::json!([classification_item("originals", "root", "오리지널", None, 1)]),
                    None, false, false,
                )))
                .unwrap();
            // A's remaining pages, should it ignore the refusal and keep walking.
            while let Ok(Some(request)) = server_a.recv_timeout(Duration::from_millis(400)) {
                let _ = request.respond(json_response(baseline_page_at_epoch(
                    2, 1, "assignments", serde_json::json!([]), None, false, true,
                )));
            }
        });

        // Server B advertises epoch 3 at cursor 9 and installs that newer baseline.
        let server_b = Server::http("127.0.0.1:0").unwrap();
        let base_b = format!("http://{}/v1", server_b.server_addr());
        let handle_b = thread::spawn(move || {
            // 1. `/status` reports the re-activated authority: same library, epoch 3.
            let request = server_b.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1, "active": true, "libraryId": LIBRARY,
                    "domains": [{"domain": "classifications", "libraryId": LIBRARY,
                                 "epoch": 3, "contractVersion": 1, "cursor": 9}]
                })))
                .unwrap();
            // 2. The structure section, then 3. the final assignment page that completes it.
            for (section, items, complete) in [
                (
                    "classifications",
                    serde_json::json!([classification_item("originals", "root", "오리지널", None, 1)]),
                    false,
                ),
                ("assignments", serde_json::json!([]), true),
            ] {
                let request = server_b.recv().unwrap();
                assert!(request.url().contains("/baseline"), "{}", request.url());
                assert!(request.url().contains(section), "{}", request.url());
                request
                    .respond(json_response(baseline_page_at_epoch(
                        3, 9, section, items, None, false, complete,
                    )))
                    .unwrap();
            }
            let _ = server_b.recv_timeout(Duration::from_millis(300));
        });

        let shared = std::sync::Arc::new(library);
        let worker_a = std::sync::Arc::clone(&shared);
        let client_a = CloudClient::new(&base_a).unwrap();
        let received_a =
            thread::spawn(move || worker_a.reconcile_classification_authority(&client_a, "token"));

        // Only once A is genuinely parked mid-walk does B install the newer baseline.
        parked_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let worker_b = std::sync::Arc::clone(&shared);
        let client_b = CloudClient::new(&base_b).unwrap();
        let received_b =
            thread::spawn(move || worker_b.reconcile_classification_authority(&client_b, "token"));
        let result_b = received_b.join().unwrap().expect("B adopts the newer baseline");
        assert!(result_b.adopted && result_b.adopted_baseline);

        // A's response arrives afterwards, against the state B has already replaced.
        let _ = release_tx.send(());
        let result_a = received_a.join().unwrap();
        handle_a.join().unwrap();
        handle_b.join().unwrap();

        // The refusal is the same class of condition as a mid-walk local edit — the state the
        // request was based on is gone — so it becomes the usual "nothing applied this cycle"
        // deferral rather than an error the user sees. The next pass simply re-reads `/status`.
        assert!(
            result_a
                .as_ref()
                .is_ok_and(|result| result.deferred_to_outbox && !result.adopted_baseline),
            "a stale baseline install must be refused, got {result_a:?}"
        );
        let connection = shared.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 3, 1, 9)),
            "B's newer authority state must remain installed"
        );
        assert!(
            entries(&connection).iter().any(|(id, _, _, _)| id == "originals"),
            "product state must not be rolled back by the stale install"
        );
    }

    /// A stored Classification authority for a *different* library is never continued.
    ///
    /// The same independent validation as Album: a database corrupted by the older guard holds
    /// a foreign authority row, and no re-adoption trigger fires when the correct library
    /// reports the same epoch. Walking the foreign identity's change log would compare a cursor
    /// across two different libraries, which is meaningless.
    #[test]
    fn a_stored_foreign_classification_authority_is_never_continued_incrementally() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_classification_baseline_for_test(
                &[classification("originals", "오리지널", None, 1)],
                &[assignment("asset-1", Some("originals"), 1)],
                &[originals("originals")],
                OTHER_LIBRARY,
                1,
                1,
                5,
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let paths = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&paths);
        let handle = thread::spawn(move || {
            // `/status` reports this library at the same epoch as the corrupted row.
            let request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            request.respond(json_response(status_body(6))).unwrap();
            // Anything further would be a request the foreign identity must never produce.
            while let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(400)) {
                log.lock().unwrap().push(request.url().to_owned());
                let _ = request.respond(json_response(status_body(6)));
            }
        });
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .reconcile_classification_authority(&client, "token")
            .unwrap_err();
        handle.join().unwrap();

        assert!(
            matches!(error, LibraryError::ClassificationAuthorityMismatch),
            "a stored foreign identity must be an explicit refusal, got {error:?}"
        );
        let requested = paths.lock().unwrap();
        assert!(
            !requested.iter().any(|path| path.contains("/changes")),
            "no incremental path may be attempted against the foreign identity: {requested:?}"
        );
        let connection = library.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((OTHER_LIBRARY.to_owned(), 1, 1, 5)),
            "the refusal must not silently rewrite the stored identity"
        );
    }

    /// A local edit committed during the baseline walk must not be replaced by the baseline.
    ///
    /// A baseline walk is several requests, so the window between "the queue was read as clean"
    /// and "the baseline is installed" is far wider than on the incremental path. The install
    /// must re-assert that precondition inside its own transaction: otherwise a user edit
    /// committed mid-download is silently replaced by the pre-edit state the server described,
    /// and the durable intent is thrown away with it.
    #[test]
    fn a_local_edit_during_a_baseline_walk_is_never_replaced() {
        use std::sync::mpsc;

        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // Adopt a replica at cursor 4, then force a re-adoption so the pass takes the baseline
        // path: a different epoch is the designed "the authority restarted" state.
        library
            .install_classification_baseline_for_test(
                &[classification("originals", "오리지널", None, 1)],
                &[assignment("asset-1", Some("originals"), 1)],
                &[originals("originals")],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();
        {
            let connection = library.connection().unwrap();
            connection
                .execute(
                    "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                     VALUES ('series', 'tag', '시리즈', 'originals', '2026-09-16T00:00:00Z')",
                    [],
                )
                .unwrap();
        }

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            // 1. `/status` advertises a *new epoch*, which is what makes the pass re-adopt.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "classifications",
                        "libraryId": LIBRARY,
                        "epoch": 2,
                        "contractVersion": 1,
                        "cursor": 1
                    }]
                })))
                .unwrap();
            // 2. Hold the baseline's first page until the local edit has committed.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/baseline"), "{}", request.url());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            request
                .respond(json_response(baseline_page_at_epoch(
                    2,
                    1,
                    "classifications",
                    serde_json::json!([classification_item(
                        "originals", "root", "오리지널", None, 1
                    )]),
                    None,
                    false,
                    false,
                )))
                .unwrap();
            // 3. The assignment section, whose `complete` is the adoption point.
            let request = server.recv().unwrap();
            request
                .respond(json_response(baseline_page_at_epoch(
                    2,
                    1,
                    "assignments",
                    serde_json::json!([]),
                    None,
                    false,
                    true,
                )))
                .unwrap();
            let _ = server.recv_timeout(Duration::from_millis(500));
        });

        let shared = std::sync::Arc::new(library);
        let worker = std::sync::Arc::clone(&shared);
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            // The user assigns asset-1 to `series` while the baseline is still downloading.
            worker.queue_local_assignment_for_test("asset-1", "series");
            let _ = release_tx.send(());
        });

        let client = CloudClient::new(&base).unwrap();
        let result = shared
            .reconcile_classification_authority(&client, "token")
            .expect("a mid-baseline local edit is a deferral, not an error");
        release.join().unwrap();
        handle.join().unwrap();

        assert!(
            result.deferred_to_outbox,
            "the pass must report the intent as taking precedence this cycle"
        );
        let connection = shared.connection().unwrap();
        assert_eq!(
            projections(&connection),
            [("asset-1".to_owned(), "series".to_owned())],
            "the optimistic local edit must survive"
        );
        assert_eq!(
            outbox_rows(&connection).len(),
            1,
            "the durable intent must survive"
        );
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 4)),
            "the refused install must not change the authority identity or cursor"
        );
    }
}

// ---------------------------------------------------------------------------
// 36. Clean receive passes do not maintain the retired legacy dirty state
// ---------------------------------------------------------------------------

/// A clean authority pass must not touch the legacy Classification publication state.
///
/// Production measured this as real cost, not a theoretical one: authority receive
/// rewrites each confirmed assignment (DELETE + INSERT, because assignment is
/// single-valued) and migration 0076's triggers turned each rewrite into a `cloud_metadata_publication_state`
/// increment, so a five-second pass over 8,936 assignments fired roughly 17,900
/// updates with nothing to publish — the legacy lane is fenced after adoption and the
/// generation is consumed locally rather than sent.
///
/// This pins the whole property end to end: repeated passes over unchanged confirmed
/// authority state leave the legacy Classification generation, the Album and saved_x
/// domains, the authority cursor, the authority caches and the outbox all exactly as
/// they were.
#[test]
fn clean_receive_passes_do_not_maintain_the_legacy_classification_generation() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    insert_asset(&library, "asset-2");
    // Adopt a real baseline so the confirmed assignment cache and the visible relations
    // hold values that a subsequent pass re-projects.
    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[
                assignment("asset-1", Some("series"), 1),
                assignment("asset-2", Some("originals"), 1),
            ],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();

    let generations = |connection: &Connection| -> Vec<(String, i64)> {
        let mut statement = connection
            .prepare(
                "SELECT kind, generation FROM cloud_metadata_publication_state ORDER BY kind",
            )
            .unwrap();
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };

    let connection = library.connection().unwrap();
    let before_generations = generations(&connection);
    let before_classification_generation = generation_of(&connection, "classifications");
    let before_projections = projections(&connection);
    let before_cursor = authority(&connection).map(|value| value.3);
    let before_assignments = assignment_cache(&connection);
    assert!(
        before_projections.len() == 2 && before_assignments.len() == 2,
        "the fixture must carry confirmed state for a pass to re-project"
    );
    // The library lock is not reentrant, so release it before driving passes that take
    // it themselves.
    drop(connection);

    // Five clean passes, standing in for the five-second production loop. Each one
    // re-projects every confirmed assignment it knows about.
    for _ in 0..5 {
        let rematerialized = library
            .materialize_deferred_classification_assignments()
            .unwrap();
        assert_eq!(
            rematerialized, 0,
            "an already-correct projection is not a change and must report none"
        );
    }

    let connection = library.connection().unwrap();
    assert_eq!(
        generations(&connection),
        before_generations,
        "a clean pass must not dirty any legacy publication domain"
    );
    assert_eq!(
        generation_of(&connection, "classifications"),
        before_classification_generation,
        "the legacy Classification generation in particular must not grow"
    );
    assert_eq!(projections(&connection), before_projections);
    assert_eq!(assignment_cache(&connection), before_assignments);
    assert_eq!(authority(&connection).map(|value| value.3), before_cursor, "no cursor movement without server changes");
    assert!(outbox_rows(&connection).is_empty(), "a clean pass mints no intent");
}

/// The legacy Classification generation for one kind.
fn generation_of(connection: &Connection, kind: &str) -> Option<i64> {
    connection
        .query_row(
            "SELECT generation FROM cloud_metadata_publication_state WHERE kind = ?1",
            [kind],
            |row| row.get(0),
        )
        .ok()
}

/// A clean pass must not rewrite assignment rows at all.
///
/// The counter check above proves the retired legacy state stops growing, but it cannot
/// see a projection that still rewrites every row and merely stops *counting* it. This
/// measures the writes themselves through a temporary counting trigger, so the property
/// "an unchanged projection performs no DML" is pinned independently of the legacy
/// counter's existence.
#[test]
fn a_clean_pass_rewrites_no_assignment_rows() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_classification_baseline_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", Some("originals"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    {
        let connection = library.connection().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE classification_write_probe (writes INTEGER NOT NULL);
                 INSERT INTO classification_write_probe VALUES (0);
                 CREATE TRIGGER classification_write_probe_insert
                 AFTER INSERT ON asset_classifications BEGIN
                  UPDATE classification_write_probe SET writes = writes + 1;
                 END;
                 CREATE TRIGGER classification_write_probe_delete
                 AFTER DELETE ON asset_classifications BEGIN
                  UPDATE classification_write_probe SET writes = writes + 1;
                 END;",
            )
            .unwrap();
    }
    for _ in 0..5 {
        library
            .materialize_deferred_classification_assignments()
            .unwrap();
    }
    let connection = library.connection().unwrap();
    let writes: i64 = connection
        .query_row("SELECT writes FROM classification_write_probe", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        writes, 0,
        "re-projecting a value that is already correct must not write the row"
    );
    assert_eq!(
        projections(&connection),
        [("asset-1".to_owned(), "originals".to_owned())],
        "the projection is still correct"
    );
}
