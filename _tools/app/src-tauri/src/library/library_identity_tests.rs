//! Batch B2: durable library identity stored inside library.sqlite.
use super::tests::historical_schema;
use super::*;
use crate::library::backup::create_verified_snapshot;
use crate::library::models::TrashPolicy;
use crate::library::Library;
use rusqlite::Connection;
use std::fs;

fn is_valid_identity(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn identity_of(path: &Path) -> String {
    let connection = Connection::open(path).unwrap();
    connection
        .query_row(
            "SELECT library_id FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn migrates_v78_library_to_a_stable_identity() {
    let mut connection = Connection::open_in_memory().unwrap();
    historical_schema(&mut connection, 78);
    let has_column = connection
        .prepare(
            "SELECT COUNT(*) FROM pragma_table_info('library_settings') WHERE name = 'library_id'",
        )
        .unwrap()
        .query_row([], |row| row.get::<_, i64>(0))
        .unwrap();
    assert_eq!(has_column, 0, "v78 must not carry an identity column");

    migrate_to_latest(&mut connection, 78).unwrap();

    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION,
    );
    let identity: String = connection
        .query_row(
            "SELECT library_id FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(is_valid_identity(&identity), "{identity}");
}

#[test]
fn new_library_keeps_one_identity_across_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let first = {
        let library = Library::open(root).unwrap();
        library.library_id().unwrap()
    };
    assert!(is_valid_identity(&first), "{first}");
    let second = Library::open(root).unwrap().library_id().unwrap();
    assert_eq!(first, second);
    assert_eq!(identity_of(&root.join("library.sqlite")), first);
}

#[test]
fn independently_created_libraries_have_distinct_identities() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_id = Library::open(first.path()).unwrap().library_id().unwrap();
    let second_id = Library::open(second.path()).unwrap().library_id().unwrap();
    assert!(is_valid_identity(&first_id), "{first_id}");
    assert!(is_valid_identity(&second_id), "{second_id}");
    assert_ne!(first_id, second_id);
}

#[test]
fn identity_survives_moving_the_library_directory() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let moved = temp.path().join("moved");
    let identity = {
        let library = Library::open(&original).unwrap();
        create_verified_snapshot(
            &library.connection().unwrap(),
            &temp.path().join("copy.sqlite"),
        )
        .unwrap();
        library.library_id().unwrap()
    };
    fs::create_dir_all(&moved).unwrap();
    fs::copy(
        temp.path().join("copy.sqlite"),
        moved.join("library.sqlite"),
    )
    .unwrap();
    assert_eq!(identity_of(&moved.join("library.sqlite")), identity);
    let reopened = Library::open(&moved).unwrap().library_id().unwrap();
    assert_eq!(reopened, identity);
}

#[test]
fn verified_snapshot_preserves_library_identity() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let identity = library.library_id().unwrap();
    let destination = temp.path().join("backups").join("snapshot.sqlite");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    create_verified_snapshot(&library.connection().unwrap(), &destination).unwrap();
    assert_eq!(identity_of(&destination), identity);
}

#[test]
fn identity_is_independent_from_mutable_settings() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let identity = library.library_id().unwrap();
    library
        .set_trash_policy(TrashPolicy {
            retention_days: Some(45),
        })
        .unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let vault = elsewhere.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    library.register_private_vault(&vault).unwrap();
    library.unregister_private_vault().unwrap();
    assert_eq!(library.library_id().unwrap(), identity);
}

#[test]
fn accessor_fails_closed_on_a_malformed_identity() {
    for value in [
        "".to_owned(),
        "0".repeat(31),
        "0".repeat(33),
        "g".repeat(32),
        "A".repeat(32),
        "0123456789ABCDEF0123456789abcdef".to_owned(),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE library_settings SET library_id = ?1 WHERE singleton = 1",
                [&value],
            )
            .unwrap();
        let error = library.library_id();
        assert!(error.is_err(), "accepted {value:?}");
        assert_eq!(
            identity_of(&temp.path().join("library.sqlite")),
            value,
            "must not self-heal"
        );
    }
}

#[test]
fn accessor_fails_closed_on_a_null_identity() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE library_settings SET library_id = NULL WHERE singleton = 1",
            [],
        )
        .unwrap();
    assert!(library.library_id().is_err());
    let connection = Connection::open(temp.path().join("library.sqlite")).unwrap();
    let value: Option<String> = connection
        .query_row(
            "SELECT library_id FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(value.is_none(), "must not repair on read");
}

#[test]
fn migration_validation_rejects_a_malformed_final_identity() {
    for value in [
        None,
        Some("short".to_owned()),
        Some("G".repeat(32)),
        Some("A".repeat(32)),
    ] {
        let mut connection = Connection::open_in_memory().unwrap();
        historical_schema(&mut connection, 78);
        let transaction = connection.transaction().unwrap();
        transaction
            .execute_batch(include_str!("../../migrations/0079_library_identity.sql"))
            .unwrap();
        transaction
            .execute(
                "UPDATE library_settings SET library_id = ?1 WHERE singleton = 1",
                rusqlite::params![value],
            )
            .unwrap();
        assert!(
            validate_library_identity(&transaction).is_err(),
            "accepted {value:?}"
        );
        transaction.rollback().unwrap();
    }
    let mut connection = Connection::open_in_memory().unwrap();
    historical_schema(&mut connection, 78);
    let transaction = connection.transaction().unwrap();
    transaction
        .execute_batch(include_str!("../../migrations/0079_library_identity.sql"))
        .unwrap();
    validate_library_identity(&transaction).unwrap();
    transaction.rollback().unwrap();
}
