use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::{backup, error::LibraryError};

pub(crate) const SCHEMA_VERSION: i64 = 9;
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");
const VAULT_SAFETY_SCHEMA: &str = include_str!("../../migrations/0002_vault_safety.sql");
const SIMILARITY_REVIEW_SCHEMA: &str = include_str!("../../migrations/0003_similarity_review.sql");
const VIDEO_MEDIA_SCHEMA: &str = include_str!("../../migrations/0004_video_media.sql");
const MANGA_SCHEMA: &str = include_str!("../../migrations/0005_manga.sql");
const MANGA_MODIFIED_SCHEMA: &str = include_str!("../../migrations/0006_manga_modified.sql");
const CLASSIFICATION_APPEARANCE_SCHEMA: &str =
    include_str!("../../migrations/0007_classification_appearance.sql");
const ASSET_ALBUMS_SCHEMA: &str = include_str!("../../migrations/0008_asset_albums.sql");
const ASSET_SOURCE_PROVENANCE_SCHEMA: &str =
    include_str!("../../migrations/0009_asset_source_provenance.sql");

pub fn open_database(path: &Path) -> Result<Connection, LibraryError> {
    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(Duration::from_secs(5))?;

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        SCHEMA_VERSION => {}
        version @ 0..=8 => {
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
        if version <= 5 {
            transaction.execute_batch(MANGA_MODIFIED_SCHEMA)?;
        }
        if version <= 6 {
            transaction.execute_batch(CLASSIFICATION_APPEARANCE_SCHEMA)?;
        }
        if version <= 7 {
            transaction.execute_batch(ASSET_ALBUMS_SCHEMA)?;
        }
        if version <= 8 {
            transaction.execute_batch(ASSET_SOURCE_PROVENANCE_SCHEMA)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v8_to_asset_source_provenance() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
            ASSET_ALBUMS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 8).unwrap();

        let metadata = connection
            .query_row(
                "SELECT source_published_at, creator_name, creator_handle, creator_url,
                        import_source, import_batch_id, original_modified_at
                   FROM assets WHERE id = 'asset-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(metadata, (None, None, None, None, None, None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            9
        );
    }

    #[test]
    fn migrates_v7_to_nested_albums_without_changing_classification_links() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
            CLASSIFICATION_APPEARANCE_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 7).unwrap();

        connection
            .execute(
                "INSERT INTO albums (id, name, parent_id, icon_key, color_key, created_at)
                 VALUES ('album-1', '표지', NULL, NULL, NULL, '2026-08-12T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_albums (asset_id, album_id)
                 VALUES ('asset-1', 'album-1')",
                [],
            )
            .unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            9
        );
    }

    #[test]
    fn migrates_existing_classifications_to_nullable_appearance() {
        let mut connection = Connection::open_in_memory().unwrap();
        for schema in [
            INITIAL_SCHEMA,
            VAULT_SAFETY_SCHEMA,
            SIMILARITY_REVIEW_SCHEMA,
            VIDEO_MEDIA_SCHEMA,
            MANGA_SCHEMA,
            MANGA_MODIFIED_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                 VALUES ('folder-1', 'root', 'Games', NULL, '2026-08-11T00:00:00Z')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 6).unwrap();

        let appearance = connection
            .query_row(
                "SELECT icon_key, color_key FROM classification_entries WHERE id = 'folder-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(appearance, (None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            9
        );
    }
}
