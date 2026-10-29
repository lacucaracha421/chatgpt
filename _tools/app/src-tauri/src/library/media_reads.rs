//! Reusable read-only connections for media lookups and background queries.
//!
//! A `/thumbnail/<id>` request reads one row. Through [`super::Library::connection`] that
//! read opened a fresh connection (and loaded the schema) under `database_lock`, which cost
//! about 2.3 ms and serialized every media slot behind any other database work. These
//! connections stay open, skip the lock, and refuse writes (`query_only`). In WAL mode a
//! reader sees the last committed state and never waits for a writer, so a lookup returns
//! what the locked path would have returned just before that writer took the lock. Nothing
//! is cached above SQLite: every request still reads the current row, so trash, restore,
//! a replaced thumbnail or a restored database take effect on the next request.
use std::{
    fmt,
    path::Path,
    sync::{Condvar, Mutex, PoisonError, RwLock, RwLockWriteGuard},
};

use rusqlite::Connection;

use super::{db, error::LibraryError};

/// Bound both idle and active readers, while allowing long queries and media lookups in parallel.
const MAX_READERS: usize = 4;

#[derive(Default)]
struct Readers {
    idle: Vec<Connection>,
    active: usize,
}

#[derive(Default)]
pub(crate) struct MediaReads {
    // Lookups share it; replacing the database file takes it exclusively, so no idle
    // handle keeps the old file open (Windows refuses to rename an open file) or reads it.
    gate: RwLock<()>,
    readers: Mutex<Readers>,
    available: Condvar,
}

// Return the slot even if opening a connection fails or the query unwinds.
struct Reader<'a> {
    owner: &'a MediaReads,
    connection: Option<Connection>,
}

impl Drop for Reader<'_> {
    fn drop(&mut self) {
        let mut readers = self
            .owner
            .readers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(connection) = self.connection.take() {
            readers.idle.push(connection);
        }
        readers.active -= 1;
        self.owner.available.notify_one();
    }
}

impl fmt::Debug for MediaReads {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("MediaReads").finish_non_exhaustive()
    }
}

impl MediaReads {
    /// Reuse a reader, opening up to MAX_READERS; wait only when all slots are busy.
    pub(crate) fn read<T>(
        &self,
        database: &Path,
        read: impl FnOnce(&Connection) -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let _gate = self.gate.read().unwrap_or_else(PoisonError::into_inner);
        let mut readers = self.readers.lock().unwrap_or_else(PoisonError::into_inner);
        while readers.active == MAX_READERS {
            readers = self
                .available
                .wait(readers)
                .unwrap_or_else(PoisonError::into_inner);
        }
        readers.active += 1;
        let mut reader = Reader {
            owner: self,
            connection: readers.idle.pop(),
        };
        drop(readers);
        let connection = match reader.connection.take() {
            Some(connection) => connection,
            None => {
                let _open = crate::media_protocol_timing::stage(
                    crate::media_protocol_timing::Stage::DatabaseOpen,
                );
                open(database)?
            }
        };
        let result = read(&connection);
        // A failed read may have left the handle in an unknown state; open a fresh one next time.
        if result.is_ok() {
            reader.connection = Some(connection);
        }
        result
    }

    /// Close every idle connection and hold off new reads until the guard is dropped.
    /// Take it, after `database_lock`, before replacing the database file.
    pub(crate) fn exclusive(&self) -> RwLockWriteGuard<'_, ()> {
        let guard = self.gate.write().unwrap_or_else(PoisonError::into_inner);
        self.readers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .idle
            .clear();
        guard
    }

    #[cfg(test)]
    pub(crate) fn idle_count(&self) -> usize {
        self.readers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .idle
            .len()
    }
}

fn open(database: &Path) -> Result<Connection, LibraryError> {
    let connection = db::open_database(database)?;
    connection.pragma_update(None, "query_only", "ON")?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};

    #[test]
    fn media_reads_run_in_parallel_with_a_fixed_connection_limit() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("library.sqlite");
        drop(open(&database).unwrap());
        let reads = MediaReads::default();
        let release = (Mutex::new(false), Condvar::new());
        let (send, receive) = mpsc::channel();
        thread::scope(|scope| {
            let workers = (0..MAX_READERS + 1)
                .map(|_| {
                    let send = send.clone();
                    let reads = &reads;
                    let database = &database;
                    let release = &release;
                    scope.spawn(move || {
                        reads
                            .read(database, |connection| {
                                let value: i64 =
                                    connection.query_row("SELECT 1", [], |r| r.get(0))?;
                                send.send(value).unwrap();
                                let mut released = release.0.lock().unwrap();
                                while !*released {
                                    released = release.1.wait(released).unwrap();
                                }
                                Ok(())
                            })
                            .unwrap();
                    })
                })
                .collect::<Vec<_>>();
            let parallel = (0..MAX_READERS)
                .map(|_| receive.recv_timeout(Duration::from_secs(5)))
                .collect::<Vec<_>>();
            let extra = receive.recv_timeout(Duration::from_millis(100));
            *release.0.lock().unwrap() = true;
            release.1.notify_all();
            for worker in workers {
                worker.join().unwrap();
            }
            assert!(parallel.into_iter().all(|result| result == Ok(1)));
            assert_eq!(extra, Err(mpsc::RecvTimeoutError::Timeout));
        });
        assert_eq!(reads.idle_count(), MAX_READERS);
    }

    #[test]
    fn media_reads_release_slots_after_open_and_query_errors() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("library.sqlite");
        let reads = MediaReads::default();
        assert!(reads.read(temp.path(), |_| Ok(())).is_err());
        assert_eq!(reads.readers.lock().unwrap().active, 0);
        assert!(reads
            .read(&database, |connection| {
                connection.execute("CREATE TABLE forbidden (id INTEGER)", [])?;
                Ok(())
            })
            .is_err());
        assert_eq!(reads.readers.lock().unwrap().active, 0);
        assert_eq!(reads.idle_count(), 0);
        reads
            .read(&database, |connection| {
                Ok(connection.query_row("SELECT 1", [], |_| Ok(()))?)
            })
            .unwrap();
        assert_eq!(reads.idle_count(), 1);
    }
}
