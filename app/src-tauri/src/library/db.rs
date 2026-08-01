use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::error::LibraryError;

pub(crate) const SCHEMA_VERSION: i64 = 1;
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");

pub fn open_database(path: &Path) -> Result<Connection, LibraryError> {
    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(Duration::from_secs(5))?;

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        0 => {
            let transaction = connection.transaction()?;
            transaction.execute_batch(INITIAL_SCHEMA)?;
            transaction.commit()?;
        }
        SCHEMA_VERSION => {}
        other => return Err(LibraryError::UnsupportedSchema(other)),
    }
    Ok(connection)
}
