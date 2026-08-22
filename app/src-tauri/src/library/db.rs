use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::{backup, error::LibraryError};

pub(crate) const SCHEMA_VERSION: i64 = 19;
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
const COLLECTIONS_SCHEMA: &str = include_str!("../../migrations/0010_collections.sql");
const COLLECTIONS_TYPED_SCHEMA: &str =
    include_str!("../../migrations/0011_collections_typed_metadata.sql");
const COLLECTION_SOURCE_SCHEMA: &str = include_str!("../../migrations/0012_collection_source.sql");
const COLLECTION_EXTERNAL_BINDINGS_SCHEMA: &str =
    include_str!("../../migrations/0013_collection_external_bindings.sql");
const COLLECTION_WORK_ARTWORKS_SCHEMA: &str =
    include_str!("../../migrations/0014_collection_work_artworks.sql");
const COLLECTION_VOLUMES_SCHEMA: &str =
    include_str!("../../migrations/0015_collection_volumes.sql");
const ALADIN_VOLUME_SOURCES_SCHEMA: &str =
    include_str!("../../migrations/0016_aladin_volume_sources.sql");
const ALADIN_RELEASE_WATCH_SCHEMA: &str =
    include_str!("../../migrations/0017_aladin_release_watch.sql");
const ONLINE_CATALOG_SCHEMA: &str = include_str!("../../migrations/0018_online_catalog.sql");
const ONLINE_CATALOG_BOOKMARKS_SCHEMA: &str =
    include_str!("../../migrations/0019_online_catalog_bookmarks.sql");

pub fn open_database(path: &Path) -> Result<Connection, LibraryError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}

pub fn initialize_database(path: &Path) -> Result<Connection, LibraryError> {
    let mut connection = open_database(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;

    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        SCHEMA_VERSION => {}
        version @ 0..=18 => {
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
        if version <= 9 {
            transaction.execute_batch(COLLECTIONS_SCHEMA)?;
        }
        if version <= 10 {
            transaction.execute_batch(COLLECTIONS_TYPED_SCHEMA)?;
        }
        if version <= 11 {
            transaction.execute_batch(COLLECTION_SOURCE_SCHEMA)?;
        }
        if version <= 12 {
            transaction.execute_batch(COLLECTION_EXTERNAL_BINDINGS_SCHEMA)?;
        }
        if version <= 13 {
            transaction.execute_batch(COLLECTION_WORK_ARTWORKS_SCHEMA)?;
        }
        if version <= 14 {
            transaction.execute_batch(COLLECTION_VOLUMES_SCHEMA)?;
        }
        if version <= 15 {
            transaction.execute_batch(ALADIN_VOLUME_SOURCES_SCHEMA)?;
        }
        if version <= 16 {
            transaction.execute_batch(ALADIN_RELEASE_WATCH_SCHEMA)?;
        }
        if version <= 17 {
            transaction.execute_batch(ONLINE_CATALOG_SCHEMA)?;
        }
        if version <= 18 {
            transaction.execute_batch(ONLINE_CATALOG_BOOKMARKS_SCHEMA)?;
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
    fn opens_a_routine_connection_while_another_connection_is_writing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE").unwrap();

        let opened = open_database(&path);

        writer.execute_batch("ROLLBACK").unwrap();
        assert!(opened.is_ok(), "{opened:?}");
    }

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
            SCHEMA_VERSION
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
            SCHEMA_VERSION
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
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v9_to_persisted_collections_without_changing_assets() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
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
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-16T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 9).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, cover_asset_id, created_at, updated_at
                 ) VALUES (
                    'collection-1', 'Favorites', NULL, 'asset-1',
                    '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collection_assets (collection_id, asset_id, added_at)
                 VALUES ('collection-1', 'asset-1', '2026-08-16T00:00:00Z')",
                [],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn migrates_v12_external_identity_to_normalized_binding() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, external_id,
                    external_source, external_synced_at, showcase, external_metadata_json,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, ' md-1 ', ' MangaDex ',
                    '2026-08-20T01:02:03Z', 0, '{\"title\":\"Provider title\"}',
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, external_id,
                    external_source, external_synced_at, showcase, external_metadata_json,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-2', 'Work Two', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, NULL, 'legacy-only', NULL, 0, 'raw-only',
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 12).unwrap();

        let migrated: (String, String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT provider, external_id, provider_data_json, last_synced_at
                 FROM collection_external_bindings WHERE collection_id = 'work-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(migrated.0, "mangadex");
        assert_eq!(migrated.1, "md-1");
        assert_eq!(
            migrated.2.as_deref(),
            Some("{\"title\":\"Provider title\"}")
        );
        assert_eq!(migrated.3.as_deref(), Some("2026-08-20T01:02:03Z"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT external_source, external_metadata_json
                     FROM collections WHERE id = 'work-2'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap(),
            ("legacy-only".into(), "raw-only".into())
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v13_to_v14_work_artwork_constraints() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0,
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 13).unwrap();

        connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
                    'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
                    'ja', 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-2', 'work-1', 'mangadex', 'cover-2', 'cover',
                    'work-artwork/work-1/art-2.jpg', 'image/jpeg', 100, 150,
                    NULL, 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-3', 'work-1', 'mangadex', 'cover-1', 'alternate',
                    'work-artwork/work-1/art-3.jpg', 'image/jpeg', 100, 150,
                    NULL, 0, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [],
            )
            .is_err());

        connection
            .execute("DELETE FROM collections WHERE id = 'work-1'", [])
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM collection_work_artworks", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v14_to_v15_collection_volumes() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0,
                    '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
                    'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
                    'ja', 1, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 14).unwrap();

        connection
            .execute(
                "INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    cover_artwork_id, source_provider, source_cover_id, source_file_name,
                    created_at, updated_at
                 ) VALUES (
                    'volume-1', 'work-1', 1, 0, 10,
                    'art-1', 'mangadex', 'cover-1', 'cover.jpg',
                    '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    created_at, updated_at
                 ) VALUES ('duplicate', 'work-1', 1, 0, 10, 't', 't')",
                [],
            )
            .is_err());
        for (id, volume_number, edition_index) in [("zero", 0, 0), ("edition-4", 2, 4)] {
            assert!(connection
                .execute(
                    "INSERT INTO collection_volumes (
                        id, collection_id, volume_number, edition_index, sort_order,
                        created_at, updated_at
                     ) VALUES (?1, 'work-1', ?2, ?3, 20, 't', 't')",
                    rusqlite::params![id, volume_number, edition_index],
                )
                .is_err());
        }

        connection
            .execute(
                "DELETE FROM collection_work_artworks WHERE id = 'art-1'",
                [],
            )
            .unwrap();
        let cover_id: Option<String> = connection
            .query_row(
                "SELECT cover_artwork_id FROM collection_volumes WHERE id = 'volume-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cover_id, None);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_v15_to_aladin_volume_sources() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0, 't', 't', NULL
                 );
                 INSERT INTO collection_external_bindings (
                    collection_id, provider, external_id, provider_data_json,
                    last_synced_at, created_at, updated_at
                 ) VALUES ('work-1', 'mangadex', 'md-1', '{}', 't', 't', 't');
                 INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
                    'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
                    'ja', 1, 't', 't'
                 );
                 INSERT INTO collection_volumes (
                    id, collection_id, volume_number, edition_index, sort_order,
                    cover_artwork_id, source_provider, source_cover_id, source_file_name,
                    created_at, updated_at
                 ) VALUES (
                    'volume-1', 'work-1', 1, 0, 1, 'art-1',
                    'mangadex', 'cover-1', 'cover.jpg', 't', 't'
                 );",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 15).unwrap();

        let config: Option<String> = connection
            .query_row(
                "SELECT provider_config_json FROM collection_external_bindings
                 WHERE collection_id = 'work-1' AND provider = 'mangadex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(config, None);
        connection
            .execute(
                "INSERT INTO collection_volume_sources (
                    collection_id, volume_number, provider, provider_item_id,
                    title, author, publisher, isbn13, publication_date, item_url,
                    provider_data_json, created_at, updated_at
                 ) VALUES (
                    'work-1', 1, 'aladin', 'item-1', '던전밥 1',
                    '쿠이 료코', '소미미디어', '9780000000001', '2026-09-01',
                    'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1', '{}', 't', 't'
                 )",
                [],
            )
            .unwrap();
        let cover: Option<String> = connection
            .query_row(
                "SELECT cover_artwork_id FROM collection_volumes WHERE id = 'volume-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cover.as_deref(), Some("art-1"));
    }

    #[test]
    fn migrates_v16_to_release_watch_without_enabling_bindings() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id, year, author, director,
                    external_score, my_score, genres, overview, showcase,
                    created_at, updated_at, source_path
                 ) VALUES (
                    'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, 0, 't', 't', NULL
                 );
                 INSERT INTO collection_external_bindings (
                    collection_id, provider, external_id, provider_data_json,
                    last_synced_at, created_at, updated_at
                 ) VALUES ('work-1', 'aladin', 'item-1', '{}', 't', 't', 't');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 16).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM release_watch_subscriptions",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            0
        );
        assert!(connection
            .execute(
                "INSERT INTO release_watch_subscriptions (
                    collection_id, provider, last_checked_at
                 ) VALUES ('work-1', 'mangadex', NULL)",
                [],
            )
            .is_err());
        connection
            .execute(
                "INSERT INTO release_watch_subscriptions (
                    collection_id, provider, last_checked_at
                 ) VALUES ('work-1', 'aladin', NULL)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO release_watch_events (
                    id, collection_id, event_kind, volume_number,
                    previous_value, current_value, detected_at, read_at
                 ) VALUES (
                    'event-1', 'work-1', 'new_volume', 1,
                    NULL, '2026-09-01', '2026-08-22T00:00:00Z', NULL
                 )",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO release_watch_events (
                    id, collection_id, event_kind, volume_number,
                    detected_at, read_at
                 ) VALUES (
                    'event-2', 'work-1', 'renamed', 1,
                    '2026-08-22T00:00:00Z', NULL
                 )",
                [],
            )
            .is_err());

        connection
            .execute("DELETE FROM collections WHERE id = 'work-1'", [])
            .unwrap();
        for table in ["release_watch_subscriptions", "release_watch_events"] {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should cascade with the Collection");
        }
    }

    #[test]
    fn migrates_v17_to_online_catalog() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 17).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT update_enabled FROM online_catalog_settings WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );
        assert!(connection
            .prepare("SELECT provider, work_id, last_page FROM remote_reading_progress")
            .is_ok());
    }

    #[test]
    fn migrates_v18_to_online_catalog_bookmarks() {
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
            ASSET_SOURCE_PROVENANCE_SCHEMA,
            COLLECTIONS_SCHEMA,
            COLLECTIONS_TYPED_SCHEMA,
            COLLECTION_SOURCE_SCHEMA,
            COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
            COLLECTION_WORK_ARTWORKS_SCHEMA,
            COLLECTION_VOLUMES_SCHEMA,
            ALADIN_VOLUME_SOURCES_SCHEMA,
            ALADIN_RELEASE_WATCH_SCHEMA,
            ONLINE_CATALOG_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 18).unwrap();
        connection
            .execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
                 VALUES ('kHentai', '42', '2026-08-22T00:00:00Z')",
                [],
            )
            .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT provider || ':' || work_id FROM online_catalog_bookmarks",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "kHentai:42",
        );
    }
}
