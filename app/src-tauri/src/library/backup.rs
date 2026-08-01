use std::{
    fs::{self, OpenOptions},
    path::Path,
};

use rusqlite::{Connection, MAIN_DB};

use super::{db, error::LibraryError};

#[allow(dead_code)] // Used by the backup rotation command introduced in the next safety slice.
pub(crate) fn create_verified_snapshot(
    source: &Connection,
    destination: &Path,
) -> Result<(), LibraryError> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        })?;
    source
        .backup(MAIN_DB, destination, None)
        .map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source: std::io::Error::other(source),
        })?;

    let snapshot = Connection::open(destination).map_err(|source| LibraryError::Backup {
        path: destination.to_path_buf(),
        source: std::io::Error::other(source),
    })?;
    let quick_check: String = snapshot
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source: std::io::Error::other(source),
        })?;
    let version: i64 = snapshot
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source: std::io::Error::other(source),
        })?;
    if quick_check != "ok" || !(1..=db::SCHEMA_VERSION).contains(&version) {
        drop(snapshot);
        fs::remove_file(destination).map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        })?;
        return Err(LibraryError::InvalidBackup);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::create_verified_snapshot;
    use crate::library::{db, error::LibraryError};

    #[test]
    fn verified_snapshot_contains_committed_wal_rows() {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("library.sqlite");
        let destination = temp.path().join("snapshot.sqlite");
        let source = db::open_database(&source_path).unwrap();
        source
            .execute(
                "INSERT INTO classification_entries
                 (id, kind, name, parent_id, created_at)
                 VALUES ('root', 'root', '게임', NULL, '2026-08-01T00:00:00Z')",
                [],
            )
            .unwrap();

        create_verified_snapshot(&source, &destination).unwrap();

        let snapshot = rusqlite::Connection::open(destination).unwrap();
        assert_eq!(
            snapshot
                .query_row("SELECT COUNT(*) FROM classification_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
        );
    }

    #[test]
    fn verified_snapshot_does_not_overwrite_an_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("snapshot.sqlite");
        fs::write(&destination, "keep this backup").unwrap();

        let source = rusqlite::Connection::open_in_memory().unwrap();
        let error = create_verified_snapshot(&source, &destination).unwrap_err();

        assert!(matches!(error, LibraryError::Backup { .. }));
        assert_eq!(fs::read_to_string(destination).unwrap(), "keep this backup");
    }

    #[test]
    fn verified_snapshot_removes_an_unsupported_schema_version() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("snapshot.sqlite");
        let source = rusqlite::Connection::open_in_memory().unwrap();
        source.execute_batch("PRAGMA user_version = 2;").unwrap();

        let error = create_verified_snapshot(&source, &destination).unwrap_err();

        assert!(matches!(error, LibraryError::InvalidBackup));
        assert!(!destination.exists());
    }
}
