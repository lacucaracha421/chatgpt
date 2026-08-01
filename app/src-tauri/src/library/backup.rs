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
    let result = (|| {
        run_after_reservation_hook(destination)?;
        source
            .backup(MAIN_DB, destination, None)
            .map_err(|source| LibraryError::Backup {
                path: destination.to_path_buf(),
                source: std::io::Error::other(source),
            })?;
        verify_snapshot(destination)
    })();
    if result.is_err() {
        fs::remove_file(destination).map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        })?;
    }

    result
}

fn verify_snapshot(destination: &Path) -> Result<(), LibraryError> {
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
        return Err(LibraryError::InvalidBackup);
    }
    Ok(())
}

#[cfg(test)]
type AfterReservationHook = Box<dyn FnOnce(&Path) -> Result<(), LibraryError>>;

#[cfg(test)]
thread_local! {
    static AFTER_RESERVATION_HOOK: std::cell::RefCell<Option<AfterReservationHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_after_reservation_hook(hook: impl FnOnce(&Path) -> Result<(), LibraryError> + 'static) {
    AFTER_RESERVATION_HOOK.with(|stored_hook| *stored_hook.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_after_reservation_hook(destination: &Path) -> Result<(), LibraryError> {
    AFTER_RESERVATION_HOOK.with(|stored_hook| {
        stored_hook
            .borrow_mut()
            .take()
            .map_or(Ok(()), |hook| hook(destination))
    })
}

#[cfg(not(test))]
fn run_after_reservation_hook(_destination: &Path) -> Result<(), LibraryError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, io};

    use super::{create_verified_snapshot, set_after_reservation_hook};
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
    fn verified_snapshot_removes_the_destination_after_a_post_reservation_failure() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("snapshot.sqlite");
        let destination_for_hook = destination.clone();
        set_after_reservation_hook(move |_| {
            Err(LibraryError::Backup {
                path: destination_for_hook,
                source: io::Error::other("simulated backup failure"),
            })
        });

        let source = rusqlite::Connection::open_in_memory().unwrap();
        let error = create_verified_snapshot(&source, &destination).unwrap_err();

        assert!(matches!(error, LibraryError::Backup { .. }));
        assert!(!destination.exists());
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
