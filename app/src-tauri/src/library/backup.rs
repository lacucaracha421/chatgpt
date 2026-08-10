use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
};

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags, MAIN_DB};
use uuid::Uuid;

use super::{
    db,
    error::LibraryError,
    models::{BackupKind, MetadataBackup},
    Library,
};

const DAILY_BACKUP_LIMIT: usize = 7;
const BACKUP_TIMESTAMP_FORMAT: &str = "%Y%m%d-%H%M%S";

struct BackupEntry {
    metadata: MetadataBackup,
    path: PathBuf,
}

impl Library {
    pub fn ensure_daily_backup(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<MetadataBackup>, LibraryError> {
        let _backup_guard = self
            .backup_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entries = backup_entries(&self.root)?;
        if entries.iter().any(|entry| {
            entry.metadata.kind == BackupKind::Daily
                && entry.metadata.created_at[..10] == now.to_rfc3339()[..10]
        }) {
            return Ok(None);
        }

        let path = backup_path(&self.root, BackupKind::Daily, now, None);
        let connection = self.connection()?;
        create_verified_snapshot(&connection, &path)?;
        rotate_daily_backups(&self.root)?;
        Ok(backup_entry(&path).map(|entry| entry.metadata))
    }

    pub fn list_backups(&self) -> Result<Vec<MetadataBackup>, LibraryError> {
        let _backup_guard = self
            .backup_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(backup_entries(&self.root)?
            .into_iter()
            .map(|entry| entry.metadata)
            .collect())
    }

    pub fn restore_backup(&self, backup_id: &str) -> Result<(), LibraryError> {
        let _backup_guard = self
            .backup_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _database_guard = self
            .database_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let selected = backup_entries(&self.root)?
            .into_iter()
            .find(|entry| entry.metadata.id == backup_id)
            .ok_or(LibraryError::InvalidBackup)?;
        let current = self.root.join("library.sqlite");
        let temporary = self.root.join("library.sqlite.restore.part");
        let recovery = self.root.join(format!(
            "library.sqlite.restore-old-{}.sqlite",
            Uuid::new_v4()
        ));
        cleanup_temporary_restore(&temporary)?;

        let current_connection = self.unlocked_connection()?;
        current_connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let pre_restore = backup_path(&self.root, BackupKind::PreRestore, Utc::now(), None);
        create_verified_snapshot(&current_connection, &pre_restore)?;
        drop(current_connection);

        let selected_connection =
            Connection::open_with_flags(&selected.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|source| backup_error(&selected.path, std::io::Error::other(source)))?;
        create_verified_snapshot(&selected_connection, &temporary)?;
        drop(selected_connection);

        if let Err(source) = rename_database(&current, &recovery) {
            cleanup_temporary_restore(&temporary)?;
            return Err(backup_error(&current, source));
        }
        if let Err(error) = rename_database(&temporary, &current) {
            if rollback_restore(&self.root, &current, &recovery).is_err() {
                return Err(LibraryError::RestoreFailed {
                    recovery_path: recovery,
                });
            }
            cleanup_temporary_restore(&temporary)?;
            return Err(backup_error(&temporary, error));
        }

        let post_swap = (|| {
            run_after_swap_hook()?;
            remove_database_sidecars(&current)?;
            drop(db::open_database(&current)?);
            remove_database_sidecars(&recovery)?;
            remove_file_if_exists(&recovery)
        })();
        match post_swap {
            Ok(()) => Ok(()),
            Err(error) => {
                if rollback_restore(&self.root, &current, &recovery).is_err() {
                    return Err(LibraryError::RestoreFailed {
                        recovery_path: recovery,
                    });
                }
                Err(error)
            }
        }
    }
}

fn backup_entries(root: &Path) -> Result<Vec<BackupEntry>, LibraryError> {
    let directory = root.join("backups");
    let entries = fs::read_dir(&directory)
        .map_err(|source| backup_error(&directory, source))?
        .filter_map(Result::ok)
        .filter_map(|entry| backup_entry(&entry.path()))
        .collect::<Vec<_>>();
    Ok(entries)
}

fn backup_entry(path: &Path) -> Option<BackupEntry> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || verify_snapshot(path).is_err() {
        return None;
    }
    let (kind, created_at, id) = parse_backup_filename(path.file_name()?.to_str()?)?;
    Some(BackupEntry {
        metadata: MetadataBackup {
            id,
            kind,
            created_at: created_at.to_rfc3339(),
            byte_size: metadata.len(),
        },
        path: path.to_path_buf(),
    })
}

fn parse_backup_filename(name: &str) -> Option<(BackupKind, DateTime<Utc>, String)> {
    let stem = name.strip_suffix(".sqlite")?;
    let (kind, remainder) = if let Some(remainder) = stem.strip_prefix("daily-") {
        (BackupKind::Daily, remainder)
    } else if let Some(remainder) = stem.strip_prefix("pre-restore-") {
        (BackupKind::PreRestore, remainder)
    } else {
        (
            BackupKind::PreMigration,
            stem.strip_prefix("pre-migration-")?,
        )
    };
    let (prefix, id) = remainder
        .get(..remainder.len().checked_sub(36)?)
        .zip(remainder.get(remainder.len().checked_sub(36)?..))?;
    let prefix = prefix.strip_suffix('-')?;
    let (timestamp, id) = if kind == BackupKind::PreMigration {
        let timestamp_and_version = prefix;
        let (timestamp, version) = timestamp_and_version.rsplit_once("-v")?;
        version.parse::<i64>().ok()?;
        (timestamp, id)
    } else {
        (prefix, id)
    };
    let created_at = NaiveDateTime::parse_from_str(timestamp, BACKUP_TIMESTAMP_FORMAT)
        .ok()?
        .and_utc();
    Some((kind, created_at, Uuid::parse_str(id).ok()?.to_string()))
}

fn backup_path(
    root: &Path,
    kind: BackupKind,
    created_at: DateTime<Utc>,
    source_version: Option<i64>,
) -> PathBuf {
    let timestamp = created_at.format(BACKUP_TIMESTAMP_FORMAT);
    let id = Uuid::new_v4();
    let name = match kind {
        BackupKind::Daily => format!("daily-{timestamp}-{id}.sqlite"),
        BackupKind::PreMigration => format!(
            "pre-migration-{timestamp}-v{}-{id}.sqlite",
            source_version.expect("pre-migration backups have a source version")
        ),
        BackupKind::PreRestore => format!("pre-restore-{timestamp}-{id}.sqlite"),
    };
    root.join("backups").join(name)
}

fn rotate_daily_backups(root: &Path) -> Result<(), LibraryError> {
    let mut daily = backup_entries(root)?
        .into_iter()
        .filter(|entry| entry.metadata.kind == BackupKind::Daily)
        .collect::<Vec<_>>();
    daily.sort_by(|left, right| {
        right
            .metadata
            .created_at
            .cmp(&left.metadata.created_at)
            .then_with(|| right.metadata.id.cmp(&left.metadata.id))
    });
    for entry in daily.into_iter().skip(DAILY_BACKUP_LIMIT) {
        remove_file_if_exists(&entry.path)?;
    }
    Ok(())
}

fn rollback_restore(root: &Path, current: &Path, recovery: &Path) -> Result<(), LibraryError> {
    let failed_new = root.join(format!(
        "library.sqlite.restore-new-{}.sqlite",
        Uuid::new_v4()
    ));
    let preserved_new = current.exists();
    if preserved_new {
        move_database_set(current, &failed_new)?;
    }
    rename_database(recovery, current).map_err(|source| backup_error(recovery, source))?;
    if preserved_new {
        remove_database_sidecars(&failed_new)?;
        remove_file_if_exists(&failed_new)?;
    }
    Ok(())
}

fn move_database_set(from: &Path, to: &Path) -> Result<(), LibraryError> {
    rename_database(from, to).map_err(|source| backup_error(from, source))?;
    for suffix in ["-wal", "-shm"] {
        let from_sidecar = PathBuf::from(format!("{}{suffix}", from.display()));
        if from_sidecar.exists() {
            let to_sidecar = PathBuf::from(format!("{}{suffix}", to.display()));
            rename_database(&from_sidecar, &to_sidecar)
                .map_err(|source| backup_error(&from_sidecar, source))?;
        }
    }
    Ok(())
}

fn cleanup_temporary_restore(temporary: &Path) -> Result<(), LibraryError> {
    remove_database_sidecars(temporary)?;
    remove_file_if_exists(temporary)
}

fn rename_database(from: &Path, to: &Path) -> std::io::Result<()> {
    run_before_rename_hook(from, to)?;
    fs::rename(from, to)
}

fn remove_database_sidecars(path: &Path) -> Result<(), LibraryError> {
    for suffix in ["-wal", "-shm"] {
        remove_file_if_exists(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), LibraryError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(backup_error(path, source)),
    }
}

fn backup_error(path: &Path, source: std::io::Error) -> LibraryError {
    LibraryError::Backup {
        path: path.to_path_buf(),
        source,
    }
}

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

pub(crate) fn pre_migration_snapshot_path(root: &Path, source_version: i64) -> PathBuf {
    backup_path(
        root,
        BackupKind::PreMigration,
        Utc::now(),
        Some(source_version),
    )
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
type BeforeRenameHook = Box<dyn Fn(&Path, &Path) -> std::io::Result<()>>;

#[cfg(test)]
type AfterSwapHook = Box<dyn FnOnce() -> Result<(), LibraryError>>;

#[cfg(test)]
thread_local! {
    static BEFORE_RENAME_HOOK: std::cell::RefCell<Option<BeforeRenameHook>> = const { std::cell::RefCell::new(None) };
    static AFTER_SWAP_HOOK: std::cell::RefCell<Option<AfterSwapHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_before_rename_hook(hook: impl Fn(&Path, &Path) -> std::io::Result<()> + 'static) {
    BEFORE_RENAME_HOOK.with(|stored_hook| *stored_hook.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_before_rename_hook(from: &Path, to: &Path) -> std::io::Result<()> {
    BEFORE_RENAME_HOOK.with(|stored_hook| {
        stored_hook
            .borrow()
            .as_ref()
            .map_or(Ok(()), |hook| hook(from, to))
    })
}

#[cfg(not(test))]
fn run_before_rename_hook(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
fn set_after_swap_hook(hook: impl FnOnce() -> Result<(), LibraryError> + 'static) {
    AFTER_SWAP_HOOK.with(|stored_hook| *stored_hook.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_after_swap_hook() -> Result<(), LibraryError> {
    AFTER_SWAP_HOOK.with(|stored_hook| {
        stored_hook
            .borrow_mut()
            .take()
            .map_or(Ok(()), |hook| hook())
    })
}

#[cfg(not(test))]
fn run_after_swap_hook() -> Result<(), LibraryError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs, io,
        path::PathBuf,
        sync::{mpsc, Arc, Barrier},
        time::Duration,
    };

    use chrono::{TimeZone, Utc};

    use super::{
        create_verified_snapshot, parse_backup_filename, set_after_reservation_hook,
        set_after_swap_hook, set_before_rename_hook,
    };
    use crate::library::{
        db,
        error::LibraryError,
        models::{BackupKind, ClassificationKind, CreateClassification, TrashPolicy},
        Library,
    };

    #[test]
    fn daily_backups_are_created_once_per_utc_date_and_retain_the_newest_seven() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let first = Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap();

        assert!(library.ensure_daily_backup(first).unwrap().is_some());
        assert!(library
            .ensure_daily_backup(first + chrono::Duration::hours(1))
            .unwrap()
            .is_none());
        for day in 2..=8 {
            assert!(library
                .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, day, 12, 0, 0).unwrap())
                .unwrap()
                .is_some());
        }

        let mut dates = library
            .list_backups()
            .unwrap()
            .into_iter()
            .filter(|backup| backup.kind == BackupKind::Daily)
            .map(|backup| backup.created_at[..10].to_owned())
            .collect::<Vec<_>>();
        dates.sort();

        assert_eq!(
            dates,
            [
                "2026-08-02",
                "2026-08-03",
                "2026-08-04",
                "2026-08-05",
                "2026-08-06",
                "2026-08-07",
                "2026-08-08",
            ]
        );
    }

    #[test]
    fn parses_a_module_owned_daily_filename() {
        assert!(parse_backup_filename(
            "daily-20260801-120000-550e8400-e29b-41d4-a716-446655440000.sqlite"
        )
        .is_some());
    }

    #[test]
    fn corrupted_backups_are_rejected_without_changing_the_current_database() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Current only".into(),
                parent_id: None,
            })
            .unwrap();
        let backup_path = fs::read_dir(library.root().join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.to_string_lossy().contains(&backup.id))
            .unwrap();
        fs::write(backup_path, b"corrupted backup").unwrap();

        let error = library.restore_backup(&backup.id).unwrap_err();

        assert!(matches!(error, LibraryError::InvalidBackup));
        assert_eq!(library.list_classifications().unwrap().len(), 1);
    }

    #[test]
    fn successful_restore_creates_exactly_one_pre_restore_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Before backup".into(),
                parent_id: None,
            })
            .unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "After backup".into(),
                parent_id: None,
            })
            .unwrap();

        library.restore_backup(&backup.id).unwrap();

        assert_eq!(library.list_classifications().unwrap().len(), 1);
        assert_eq!(
            library
                .list_backups()
                .unwrap()
                .into_iter()
                .filter(|entry| entry.kind == BackupKind::PreRestore)
                .count(),
            1
        );
    }

    #[test]
    fn restore_replaces_a_stale_temporary_database() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        let temporary = library.root().join("library.sqlite.restore.part");
        fs::write(&temporary, b"stale restore").unwrap();

        library.restore_backup(&backup.id).unwrap();

        assert!(!temporary.exists());
    }

    #[test]
    fn database_mutation_waits_until_restore_finishes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        let current = library.root().join("library.sqlite");
        let restore_library = library.clone();
        let barrier = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let hook_barrier = Arc::clone(&barrier);
        let hook_release = Arc::clone(&release);
        let restore = std::thread::spawn(move || {
            set_before_rename_hook(move |from, _| {
                if from == current {
                    hook_barrier.wait();
                    hook_release.wait();
                }
                Ok(())
            });
            restore_library.restore_backup(&backup.id).unwrap();
        });
        barrier.wait();

        let mutation_library = library.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let mutation = std::thread::spawn(move || {
            mutation_library
                .set_trash_policy(TrashPolicy {
                    retention_days: Some(7),
                })
                .unwrap();
            done_tx.send(()).unwrap();
        });

        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release.wait();
        restore.join().unwrap();
        mutation.join().unwrap();
        assert_eq!(library.trash_policy().unwrap().retention_days, Some(7));
    }

    #[test]
    fn failed_temporary_swap_cleans_up_the_temporary_database() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        let temporary = library.root().join("library.sqlite.restore.part");
        let current = library.root().join("library.sqlite");
        let temporary_for_hook = temporary.clone();
        let current_for_hook = current.clone();
        set_before_rename_hook(move |from, to| {
            if from == temporary_for_hook && to == current_for_hook {
                return Err(io::Error::other("temporary swap failed"));
            }
            Ok(())
        });

        let error = library.restore_backup(&backup.id).unwrap_err();

        assert!(matches!(error, LibraryError::Backup { .. }));
        assert!(!temporary.exists());
        assert!(current.exists());
    }

    #[test]
    fn failed_current_database_move_cleans_up_the_temporary_database() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        let temporary = library.root().join("library.sqlite.restore.part");
        let current = library.root().join("library.sqlite");
        let current_for_hook = current.clone();
        set_before_rename_hook(move |from, to| {
            let is_old_recovery = to
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .is_some_and(|name| name.starts_with("library.sqlite.restore-old-"));
            if from == current_for_hook && is_old_recovery {
                return Err(io::Error::other("current move failed"));
            }
            Ok(())
        });

        let error = library.restore_backup(&backup.id).unwrap_err();

        assert!(matches!(error, LibraryError::Backup { .. }));
        assert!(!temporary.exists());
        assert!(current.exists());
    }

    #[test]
    fn failed_rollback_preserves_the_swapped_database_as_a_distinct_recovery_file() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let backup = library
            .ensure_daily_backup(Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap())
            .unwrap()
            .unwrap();
        let current = library.root().join("library.sqlite");
        set_after_swap_hook(|| {
            Err(LibraryError::Backup {
                path: PathBuf::from("post-swap"),
                source: io::Error::other("post-swap failure"),
            })
        });
        let current_for_hook = current.clone();
        set_before_rename_hook(move |from, to| {
            let is_old_recovery = from
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .is_some_and(|name| name.starts_with("library.sqlite.restore-old-"));
            if to == current_for_hook && is_old_recovery {
                return Err(io::Error::other("rollback rename failed"));
            }
            Ok(())
        });

        let error = library.restore_backup(&backup.id).unwrap_err();
        let recovery_count = fs::read_dir(library.root())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("library.sqlite.restore-new-"))
            .count();

        assert!(matches!(error, LibraryError::RestoreFailed { .. }));
        assert_eq!(recovery_count, 1);
    }

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
        source.execute_batch("PRAGMA user_version = 6;").unwrap();

        let error = create_verified_snapshot(&source, &destination).unwrap_err();

        assert!(matches!(error, LibraryError::InvalidBackup));
        assert!(!destination.exists());
    }
}
