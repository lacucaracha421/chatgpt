//! Preparation runs independently of navigation; query connections never migrate.
use std::{path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags};

use super::{catalog_counts, error::LibraryError, models::CatalogLanguage, Library};

pub(super) struct CatalogReadConnection<'a> {
    connection: Connection,
    _file_guard: std::sync::RwLockReadGuard<'a, ()>,
}

impl std::ops::Deref for CatalogReadConnection<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.connection
    }
}

impl std::ops::DerefMut for CatalogReadConnection<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
}

#[derive(Debug, Default)]
pub(super) struct PreparationState {
    running: bool,
    requested: bool,
    error: Option<String>,
}

pub(super) fn attach_catalog_readonly(
    connection: &Connection,
    root: &Path,
) -> Result<(), LibraryError> {
    let mut uri = url::Url::from_file_path(root.join("catalogs/kdata.db"))
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    uri.set_query(Some("mode=ro"));
    connection.execute("ATTACH DATABASE ?1 AS catalog", [uri.as_str()])?;
    Ok(())
}

impl Library {
    pub(crate) fn catalog_source_revision(&self) -> Result<Option<String>, LibraryError> {
        let _file_guard = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = self.root.join("catalogs/kdata.db");
        if !path.is_file() {
            return Ok(None);
        }
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(Some(super::catalog_revision::content_revision(&source)?))
    }

    pub(crate) fn catalog_source_published(
        &self,
        previous: Option<&str>,
    ) -> Result<bool, LibraryError> {
        let current = self.catalog_source_revision()?;
        Ok(current.is_some()
            && current.as_deref() != previous
            && self.request_catalog_preparation())
    }

    pub(crate) fn request_catalog_preparation(&self) -> bool {
        if !self.root.join("catalogs/kdata.db").is_file() {
            return false;
        }
        let mut state = self
            .catalog_preparation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.requested = true;
        if state.running {
            return false;
        }
        state.running = true;
        state.error = None;
        drop(state);
        let library = self.clone();
        std::thread::spawn(move || loop {
            library
                .catalog_preparation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .requested = false;
            let result = library.prepare_online_catalog_counts();
            let mut state = library
                .catalog_preparation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.error = result.err().map(|error| error.to_string());
            if !state.requested {
                state.running = false;
                break;
            }
        });
        true
    }

    pub(super) fn catalog_preparation_status(&self) -> (bool, Option<String>) {
        let state = self
            .catalog_preparation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (state.running, state.error.clone())
    }

    /// Explicit preparation boundary. Only a legacy source needs a canonical
    /// metadata write; unchanged sources are opened read-only. Never call from
    /// a search request to memoize its first slow COUNT.
    pub(super) fn prepare_online_catalog_counts(&self) -> Result<bool, LibraryError> {
        let path = self.root.join("catalogs/kdata.db");
        if !path.is_file() {
            return Ok(false);
        }
        if self.catalog_source_revision()?.as_deref() == Some("legacy") {
            let _file_guard = self
                .catalog_file_lock
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
            source.busy_timeout(Duration::from_secs(5))?;
            super::catalog_revision::initialize_content_revision(&source)?;
        }

        // A concurrent source publication can supersede membership/preparation.
        // Retry a bounded number of fresh snapshots; never publish the old one.
        for _ in 0..3 {
            {
                let _file_guard = self
                    .catalog_file_lock
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut writer = self.connection()?;
                attach_catalog_readonly(&writer, &self.root)?;
                let tx = writer.transaction()?;
                super::catalog_groups::ensure_membership(&tx)?;
                tx.commit()?;
            }
            let prepared = {
                let mut reader = self.catalog_read_connection()?;
                let snapshot = reader.transaction()?;
                let mut ready = true;
                for language in [
                    None,
                    Some(CatalogLanguage::Korean),
                    Some(CatalogLanguage::Japanese),
                ] {
                    for reveal in [false, true] {
                        ready &= catalog_counts::lookup(&snapshot, language, reveal)?.is_some();
                    }
                }
                if ready {
                    return Ok(false);
                }
                catalog_counts::compute(&snapshot)?
                // Snapshot and its connection drop BEFORE fresh publication.
            };
            let Some(prepared) = prepared else { continue };
            let _file_guard = self
                .catalog_file_lock
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut writer = self.connection()?;
            attach_catalog_readonly(&writer, &self.root)?;
            let tx = writer.transaction()?;
            if catalog_counts::publish(&tx, &prepared)? {
                tx.commit()?;
                return Ok(true);
            }
        }
        Err(rusqlite::Error::InvalidQuery.into())
    }

    pub(super) fn catalog_read_connection(
        &self,
    ) -> Result<CatalogReadConnection<'_>, LibraryError> {
        let file_guard = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let reader = Connection::open_with_flags(
            self.root.join("library.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        reader.busy_timeout(Duration::from_secs(5))?;
        attach_catalog_readonly(&reader, &self.root)?;
        Ok(CatalogReadConnection {
            connection: reader,
            _file_guard: file_guard,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Library) {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        std::fs::create_dir(root.path().join("catalogs")).unwrap();
        let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        catalog
            .execute_batch(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
            CREATE TABLE Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
                FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,
                Title TEXT,TitleJpn TEXT,FileCount INTEGER,Category INTEGER,Uploader TEXT,
                Expunged INTEGER DEFAULT 0,Posted INTEGER,Views INTEGER);
            CREATE TABLE Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,
                PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
            CREATE INDEX IdxTagsLookup ON Tags(Namespace,Value);
            CREATE INDEX IdxWorksPosted ON Works(Posted DESC);
            CREATE INDEX IdxWorksRank ON Works(Expunged,Views DESC,Posted);
            INSERT INTO Works(Id,Token,Title,FileCount,Category,Posted,Views) VALUES
                (1,'one','alpha',20,1,1000,90),(2,'two','beta',200,2,2000,10),
                (3,'three','alpha beta',120,1,1500,50);
            UPDATE Works SET ParentGid=1,ParentKey='one' WHERE Id=2;
            INSERT INTO Tags VALUES (1,'language','korean'),(2,'language','japanese'),
                (3,'language','korean');",
            )
            .unwrap();
        (root, library)
    }

    #[test]
    fn catalog_preparation_initializes_once_and_reuses_persisted_counts_after_restart() {
        let (root, library) = fixture();
        assert!(library.prepare_online_catalog_counts().unwrap());
        let catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        let revision = super::super::catalog_revision::content_revision(&catalog).unwrap();
        assert_ne!(revision, "legacy");
        assert!(!library.prepare_online_catalog_counts().unwrap());
        drop(library);
        let reopened = Library::open(root.path()).unwrap();
        assert!(!reopened.prepare_online_catalog_counts().unwrap());
        assert_eq!(
            super::super::catalog_revision::content_revision(&catalog).unwrap(),
            revision
        );
        let read = reopened.catalog_read_connection().unwrap();
        assert_eq!(
            super::super::catalog_counts::lookup(&read, None, false).unwrap(),
            Some(2)
        );
    }

    #[test]
    fn catalog_read_connection_is_readonly_and_does_not_acquire_library_mutex() {
        let (_root, library) = fixture();
        let guard = library.connection().unwrap();
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            reader
                .query_row("SELECT COUNT(*) FROM catalog.Works", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert!(reader.execute("DELETE FROM catalog.Works", []).is_err());
        assert!(reader
            .execute("DELETE FROM online_catalog_bookmarks", [])
            .is_err());
        drop(guard);
    }

    #[test]
    fn catalog_read_connection_prevents_file_replacement_until_closed() {
        let (_root, library) = fixture();
        let reader = library.catalog_read_connection().unwrap();
        assert!(library.catalog_file_lock.try_write().is_err());
        drop(reader);
        assert!(library.catalog_file_lock.try_write().is_ok());
    }

    #[test]
    fn catalog_preparation_restore_waits_for_reader_and_prepares_restored_state() {
        let (_root, library) = fixture();
        let backup = library
            .create_pre_migration_backup("legacy-lakomics")
            .unwrap();
        library.prepare_online_catalog_counts().unwrap();
        let reader = library.catalog_read_connection().unwrap();
        let restore_library = library.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let restore = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            finished_tx
                .send(restore_library.restore_backup(&backup.id))
                .unwrap();
        });
        started_rx.recv().unwrap();
        let completed_while_reading = finished_rx.recv_timeout(Duration::from_millis(100));
        drop(reader);
        assert!(matches!(
            completed_while_reading,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        finished_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        restore.join().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while library.catalog_preparation_status().0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            catalog_counts::lookup(&reader, None, false).unwrap(),
            Some(2)
        );
    }

    #[test]
    fn catalog_preparation_refreshes_after_policy_and_source_changes() {
        let (root, library) = fixture();
        assert!(library.prepare_online_catalog_counts().unwrap());
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO online_catalog_hidden_categories VALUES(1,'now')",
                [],
            )
            .unwrap();
        assert!(library.prepare_online_catalog_counts().unwrap());
        let read = library.catalog_read_connection().unwrap();
        assert_eq!(
            super::super::catalog_counts::lookup(&read, None, false).unwrap(),
            Some(1)
        );
        assert_eq!(
            super::super::catalog_counts::lookup(&read, None, true).unwrap(),
            Some(2)
        );
        drop(read);
        let mut catalog = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        let tx = catalog.transaction().unwrap();
        tx.execute("UPDATE Works SET Expunged=1 WHERE Id=2", [])
            .unwrap();
        super::super::catalog_revision::mark_catalog_changed(&tx).unwrap();
        tx.commit().unwrap();
        assert!(library.prepare_online_catalog_counts().unwrap());
        let read = library.catalog_read_connection().unwrap();
        assert_eq!(
            super::super::catalog_counts::lookup(&read, None, false).unwrap(),
            Some(0)
        );
    }

    #[test]
    fn catalog_preparation_worker_prepares_before_any_search_and_recovers_from_failure() {
        let (_root, library) = fixture();
        assert!(library.request_catalog_preparation());
        let wait = || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while library.catalog_preparation_status().0 {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        wait();
        assert_eq!(library.catalog_preparation_status(), (false, None));
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            catalog_counts::lookup(&reader, None, false).unwrap(),
            Some(2)
        );
        drop(reader);
        library.connection().unwrap().execute_batch("INSERT INTO online_catalog_hidden_categories VALUES(1,'now');
            CREATE TRIGGER fail_prepared BEFORE INSERT ON online_catalog_prepared_counts BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(library.request_catalog_preparation());
        wait();
        assert!(library.catalog_preparation_status().1.is_some());
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(catalog_counts::lookup(&reader, None, false).unwrap(), None);
        drop(reader);
        library
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_prepared")
            .unwrap();
        assert!(library.request_catalog_preparation());
        wait();
        assert_eq!(library.catalog_preparation_status(), (false, None));
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            catalog_counts::lookup(&reader, None, false).unwrap(),
            Some(1)
        );
    }

    #[test]
    fn catalog_preparation_starts_on_open_without_search() {
        let (root, library) = fixture();
        drop(library);
        let library = Library::open(root.path()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while library.catalog_preparation_status().0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            catalog_counts::lookup(&reader, None, false).unwrap(),
            Some(2)
        );
    }

    #[test]
    fn catalog_preparation_source_publication_schedules_only_content_changes() {
        let (root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        let before = library.catalog_source_revision().unwrap().unwrap();
        assert!(!library.catalog_source_published(Some(&before)).unwrap());
        let mut source = Connection::open(root.path().join("catalogs/kdata.db")).unwrap();
        source
            .execute(
                "INSERT INTO CrawlState VALUES('checkpoint-only','next')",
                [],
            )
            .unwrap();
        assert!(!library.catalog_source_published(Some(&before)).unwrap());
        let tx = source.transaction().unwrap();
        tx.execute("UPDATE Works SET Expunged=1 WHERE Id=3", [])
            .unwrap();
        super::super::catalog_revision::mark_catalog_changed(&tx).unwrap();
        tx.commit().unwrap();
        assert!(library.catalog_source_published(Some(&before)).unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while library.catalog_preparation_status().0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            catalog_counts::lookup(&reader, None, false).unwrap(),
            Some(1)
        );
    }

    #[test]
    fn catalog_preparation_policy_setter_schedules_without_search() {
        let (_root, library) = fixture();
        library.prepare_online_catalog_counts().unwrap();
        library.set_catalog_category_hidden(1, true).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while library.catalog_preparation_status().0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let reader = library.catalog_read_connection().unwrap();
        assert_eq!(
            catalog_counts::lookup(&reader, None, false).unwrap(),
            Some(1)
        );
    }
}
