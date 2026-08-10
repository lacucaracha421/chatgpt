use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::{backup, error::LibraryError};

pub(crate) const SCHEMA_VERSION: i64 = 5;
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");
const VAULT_SAFETY_SCHEMA: &str = include_str!("../../migrations/0002_vault_safety.sql");
const SIMILARITY_REVIEW_SCHEMA: &str = include_str!("../../migrations/0003_similarity_review.sql");
const VIDEO_MEDIA_SCHEMA: &str = include_str!("../../migrations/0004_video_media.sql");
const MANGA_SCHEMA: &str = include_str!("../../migrations/0005_manga.sql");

pub fn open_database(path: &Path) -> Result<Connection, LibraryError> {
    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(Duration::from_secs(5))?;

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        SCHEMA_VERSION => {}
        version @ 0..=4 => {
            if version > 0 {
                let root = path
                    .parent()
                    .expect("database paths have a parent directory");
                let snapshot = backup::pre_migration_snapshot_path(root, version);
                backup::create_verified_snapshot(&connection, &snapshot)?;
            }
            migrate_to_latest(&mut connection, version)?;
        }
        other => return Err(LibraryError::UnsupportedSchema(other)),
    }
    Ok(connection)
}

fn migrate_to_latest(connection: &mut Connection, version: i64) -> Result<(), LibraryError> {
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    let migration = (|| {
        let transaction = connection.transaction()?;
        if version == 0 {
            transaction.execute_batch(INITIAL_SCHEMA)?;
        }
        if version <= 1 {
            transaction.execute_batch(VAULT_SAFETY_SCHEMA)?;
        }
        if version <= 2 {
            transaction.execute_batch(SIMILARITY_REVIEW_SCHEMA)?;
        }
        if version <= 3 {
            transaction.execute_batch(VIDEO_MEDIA_SCHEMA)?;
        }
        if version <= 4 {
            transaction.execute_batch(MANGA_SCHEMA)?;
        }
        transaction.commit()?;
        Ok::<(), LibraryError>(())
    })();
    connection.pragma_update(None, "foreign_keys", "ON")?;
    migration?;

    let has_foreign_key_error = connection.prepare("PRAGMA foreign_key_check")?.exists([])?;
    if has_foreign_key_error {
        return Err(LibraryError::Database(rusqlite::Error::InvalidQuery));
    }
    Ok(())
}
