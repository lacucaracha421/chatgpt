use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::{backup, error::LibraryError};

pub(crate) const SCHEMA_VERSION: i64 = 2;
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");
const VAULT_SAFETY_SCHEMA: &str = include_str!("../../migrations/0002_vault_safety.sql");

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
            transaction.execute_batch(VAULT_SAFETY_SCHEMA)?;
            transaction.commit()?;
        }
        1 => {
            let root = path
                .parent()
                .expect("database paths have a parent directory");
            let snapshot = backup::pre_migration_snapshot_path(root, version);
            backup::create_verified_snapshot(&connection, &snapshot)?;
            let transaction = connection.transaction()?;
            transaction.execute_batch(VAULT_SAFETY_SCHEMA)?;
            transaction.commit()?;
        }
        SCHEMA_VERSION => {}
        other => return Err(LibraryError::UnsupportedSchema(other)),
    }
    Ok(connection)
}
