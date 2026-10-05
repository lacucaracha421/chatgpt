//! Reusable read-only connections for the media protocol's per-request lookups.
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
    sync::{Mutex, PoisonError, RwLock, RwLockWriteGuard},
};

use rusqlite::Connection;

use super::{db, error::LibraryError};

/// Idle connections kept per Library: the asset-thumbnail media slots on the main profile.
const MAX_IDLE: usize = 4;

#[derive(Default)]
pub(crate) struct MediaReads {
    // Lookups share it; replacing the database file takes it exclusively, so no idle
    // handle keeps the old file open (Windows refuses to rename an open file) or reads it.
    gate: RwLock<()>,
    idle: Mutex<Vec<Connection>>,
}

impl fmt::Debug for MediaReads {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("MediaReads").finish_non_exhaustive()
    }
}

impl MediaReads {
    /// Run one read on an idle connection to `database`, opening one if none is idle.
    pub(crate) fn read<T>(
        &self,
        database: &Path,
        read: impl FnOnce(&Connection) -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let _gate = self.gate.read().unwrap_or_else(PoisonError::into_inner);
        let idle = self
            .idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop();
        let connection = match idle {
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
            let mut idle = self.idle.lock().unwrap_or_else(PoisonError::into_inner);
            if idle.len() < MAX_IDLE {
                idle.push(connection);
            }
        }
        result
    }

    /// Close every idle connection and hold off new reads until the guard is dropped.
    /// Take it, after `database_lock`, before replacing the database file.
    pub(crate) fn exclusive(&self) -> RwLockWriteGuard<'_, ()> {
        let guard = self.gate.write().unwrap_or_else(PoisonError::into_inner);
        self.idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        guard
    }

    #[cfg(test)]
    pub(crate) fn idle_count(&self) -> usize {
        self.idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

fn open(database: &Path) -> Result<Connection, LibraryError> {
    let connection = db::open_database(database)?;
    connection.pragma_update(None, "query_only", "ON")?;
    Ok(connection)
}
