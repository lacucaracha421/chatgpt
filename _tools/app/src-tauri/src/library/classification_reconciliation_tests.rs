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
    ClassificationChange {
        sequence,
        authority_cursor: sequence,
        command_type: "deleteClassification".to_owned(),
        operation_id: format!("op-{sequence}"),
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

fn outbox_tables(connection: &Connection) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
               AND name LIKE '%classification%outbox%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
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
    // 2B ships the receive half only.
    assert_eq!(outbox_tables(&connection), 0);
}

// ---------------------------------------------------------------------------
// 36. No Classification outbox/send behavior is introduced
// ---------------------------------------------------------------------------

#[test]
fn the_receive_batch_creates_no_classification_outbox() {
    let (_temp, library) = open();
    adopt_one_root(&library, 0);
    let connection = library.connection().unwrap();
    assert_eq!(outbox_tables(&connection), 0);
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
    assert_eq!(outbox_tables(&connection), 0);
}

// ---------------------------------------------------------------------------
// 5/9. Exact first adoption succeeds and does not rewrite product tables
// ---------------------------------------------------------------------------

#[test]
fn an_exact_first_adoption_installs_only_authority_metadata() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    let created = library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
             VALUES ('originals', 'root', '오리지널', NULL, '2026-09-16T00:00:00Z'),
                    ('series', 'tag', '시리즈', 'originals', '2026-09-16T00:00:00Z')",
            [],
        )
        .unwrap();
    assert_eq!(created, 2);
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
            "INSERT INTO asset_classifications (asset_id, classification_id) VALUES ('asset-1', 'series')",
            [],
        )
        .unwrap();

    library
        .require_classification_first_adoption_match_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[assignment("asset-1", Some("series"), 1)],
            &[originals("originals")],
        )
        .unwrap();

    library
        .install_classification_baseline_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[assignment("asset-1", Some("series"), 1)],
            &[originals("originals")],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 4)),
        "the adoption marker records the identity and cursor"
    );
    assert_eq!(
        revision_cache(&connection),
        [
            ("originals".to_owned(), 1, 0),
            ("series".to_owned(), 1, 0)
        ]
    );
    assert_eq!(
        assignment_cache(&connection),
        [("asset-1".to_owned(), Some("series".to_owned()), 1)]
    );
    // Product state is the same state the baseline describes, so it is still there and
    // still exactly as it was.
    assert_eq!(projections(&connection), [("asset-1".to_owned(), "series".to_owned())]);
    assert_eq!(roles(&connection), [("originals".to_owned(), "originals".to_owned())]);
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
}

// ---------------------------------------------------------------------------
// 6. First adoption hierarchy mismatch fails atomically
// ---------------------------------------------------------------------------

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
        .require_classification_first_adoption_match_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("series", "시리즈", Some("originals"), 1),
            ],
            &[],
            &[originals("originals")],
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
        .require_classification_first_adoption_match_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[],
            &[originals("originals")],
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
        .require_classification_first_adoption_match_for_test(
            &[classification("originals", "오리지널", None, 1)],
            &[assignment("asset-1", Some("originals"), 1)],
            &[originals("originals")],
        )
        .unwrap();
}

// ---------------------------------------------------------------------------
// 8. First adoption role mismatch fails atomically
// ---------------------------------------------------------------------------

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
        .require_classification_first_adoption_match_for_test(
            &[
                classification("originals", "오리지널", None, 1),
                classification("other", "기타", None, 1),
            ],
            &[],
            &[originals("originals")],
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
// Integration: the real CloudClient over a real socket
// ---------------------------------------------------------------------------

/// The full orchestration against a real HTTP server: `/v1/sync/status`, baseline pages
/// and change pages. A mocked transport would hide the wire contract, so these run the
/// production `CloudClient` over a real socket.
///
/// The scripted bodies are the **server's** exact encoding, taken from
/// `server/lakomics-api/classification_authority.py` (`encode_page`, `change_items`,
/// `classification_projection`, `assignment_projection`, `role_projection`) and
/// `sync_status.py`. `the_server_wire_fixture_deserializes_through_the_client_contract`
/// additionally reads the checked-in cross-language fixture.
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

    /// A scripted server: it answers requests in order until the script is exhausted.
    ///
    /// The script is only ever a *lower* bound on the requests a pass makes, and a pass
    /// that legitimately stops early must not leave the server thread blocked, so the
    /// loop also exits as soon as the test signals that it is done. A short receive
    /// timeout is what keeps that exit possible without racing the last response.
    struct Scripted {
        base: String,
        paths: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl Scripted {
        fn start(script: Vec<(serde_json::Value, u16)>) -> Self {
            let server = Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://{}/v1", server.server_addr());
            let paths = Arc::new(Mutex::new(Vec::new()));
            let log = Arc::clone(&paths);
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
}
