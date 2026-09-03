use std::{path::Path, time::Duration};

use rusqlite::Connection;

use super::{backup, error::LibraryError};

pub(crate) const SCHEMA_VERSION: i64 = 32;
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
const LEGACY_PACKAGE_IMPORTS_SCHEMA: &str =
    include_str!("../../migrations/0020_legacy_package_imports.sql");
const COLLECTION_LEGACY_KIND_SCHEMA: &str =
    include_str!("../../migrations/0021_collection_legacy_kind.sql");
const COLLECTION_FOUNDATION_SCHEMA: &str =
    include_str!("../../migrations/0022_collection_foundation.sql");
const GAME_PROVIDER_DETAIL_SCHEMA: &str =
    include_str!("../../migrations/0023_game_provider_detail.sql");
const MOVIE_PROVIDER_DETAIL_SCHEMA: &str =
    include_str!("../../migrations/0024_movie_provider_detail.sql");
const PDQ_SIMILARITY_SCHEMA: &str = include_str!("../../migrations/0025_pdq_similarity.sql");
const COLLECTED_AT_UTC_SCHEMA: &str = include_str!("../../migrations/0026_collected_at_utc.sql");

const REVISIT_SCHEMA: &str = include_str!("../../migrations/0027_revisit.sql");
const CLOUD_SYNC_QUEUE_SCHEMA: &str = include_str!("../../migrations/0028_cloud_sync_queue.sql");
const CLOUD_CAPTURE_IMPORTS_SCHEMA: &str =
    include_str!("../../migrations/0029_cloud_capture_imports.sql");
const CLOUD_BACKFILL_QUEUE_SCHEMA: &str =
    include_str!("../../migrations/0030_cloud_backfill_queue.sql");
const CLOUD_BACKFILL_CONTROL_SCHEMA: &str =
    include_str!("../../migrations/0031_cloud_backfill_control.sql");
const MANGA_CATALOG_RECOVERY_SCHEMA: &str =
    include_str!("../../migrations/0032_manga_catalog_recovery.sql");

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
        version @ 0..=31 => {
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
        if version <= 19 {
            transaction.execute_batch(LEGACY_PACKAGE_IMPORTS_SCHEMA)?;
        }
        if version <= 20 {
            transaction.execute_batch(COLLECTION_LEGACY_KIND_SCHEMA)?;
        }
        if version <= 21 {
            transaction.execute_batch(COLLECTION_FOUNDATION_SCHEMA)?;
        }
        if version <= 22 {
            transaction.execute_batch(GAME_PROVIDER_DETAIL_SCHEMA)?;
        }
        if version <= 23 {
            transaction.execute_batch(MOVIE_PROVIDER_DETAIL_SCHEMA)?;
        }
        if version <= 24 {
            transaction.execute_batch(PDQ_SIMILARITY_SCHEMA)?;
        }
        if version <= 25 {
            transaction.execute_batch(COLLECTED_AT_UTC_SCHEMA)?;
        }
        if version <= 26 {
            transaction.execute_batch(REVISIT_SCHEMA)?;
        }
        if version <= 27 {
            transaction.execute_batch(CLOUD_SYNC_QUEUE_SCHEMA)?;
        }
        if version <= 28 {
            transaction.execute_batch(CLOUD_CAPTURE_IMPORTS_SCHEMA)?;
        }
        if version <= 29 {
            transaction.execute_batch(CLOUD_BACKFILL_QUEUE_SCHEMA)?;
        }
        if version <= 30 {
            transaction.execute_batch(CLOUD_BACKFILL_CONTROL_SCHEMA)?;
        }
        if version <= 31 {
            transaction.execute_batch(MANGA_CATALOG_RECOVERY_SCHEMA)?;
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
    fn migrates_v27_to_cloud_queue_with_disabled_defaults() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
            COLLECTED_AT_UTC_SCHEMA,
            REVISIT_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 27).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT cloud_sync_enabled FROM library_settings WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT cloud_api_base_url FROM library_settings WHERE singleton = 1",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None,
        );
        // v28 큐 migration에 이어 0029 캡처 수신함 테이블까지 적용된다.
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );

        connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-1', 'asset', 'asset-1', 'upsert', 'pending', 1,
                           '2026-08-30T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-2', 'asset', 'asset-1', 'upsert', 'pending', 1,
                           '2026-08-30T00:00:01Z')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-3', 'asset', 'asset-2', 'upsert', 'unknown', 1,
                           '2026-08-30T00:00:02Z')",
                [],
            )
            .is_err());
    }

    #[test]
    fn migrates_v25_collected_at_offsets_to_utc_milliseconds() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES
                    ('later', 'hash-later', 'image', 'later.png', 'assets/later.png',
                     'thumbnails/later.webp', 1, 1, 1, '2026-08-13T14:00:00+09:00'),
                    ('earlier', 'hash-earlier', 'image', 'earlier.png', 'assets/earlier.png',
                     'thumbnails/earlier.webp', 1, 1, 1, '2026-08-13T04:30:00Z'),
                    ('invalid', 'hash-invalid', 'image', 'invalid.png', 'assets/invalid.png',
                     'thumbnails/invalid.webp', 1, 1, 1, 'legacy-invalid');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 25).unwrap();

        let mut statement = connection
            .prepare("SELECT id, collected_at FROM assets ORDER BY collected_at ASC")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("earlier".into(), "2026-08-13T04:30:00.000Z".into()),
                ("later".into(), "2026-08-13T05:00:00.000Z".into()),
                ("invalid".into(), "legacy-invalid".into()),
            ]
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }

    #[test]
    fn migrates_v24_similarity_state_to_pdq_v25() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    status, perceptual_hash, perceptual_hash_error
                 ) VALUES
                    ('existing', 'hash-existing', 'image', 'existing.png', 'assets/existing.png',
                     'thumbnails/existing.webp', 1, 100, 100, '2026-08-01T00:00:00Z',
                     'normal', X'0102030405060708', NULL),
                    ('candidate', 'hash-candidate', 'image', 'candidate.png', 'assets/candidate.png',
                     'thumbnails/candidate.webp', 1, 100, 100, '2026-08-02T00:00:00Z',
                     'review', X'1112131415161718', 'unsupported_image'),
                    ('gif', 'hash-gif', 'gif', 'moving.gif', 'assets/moving.gif',
                     'thumbnails/moving.webp', 1, 100, 100, '2026-08-03T00:00:00Z',
                     'normal', X'2122232425262728', NULL),
                    ('video', 'hash-video', 'video', 'clip.mp4', 'assets/clip.mp4',
                     NULL, 1, 100, 100, '2026-08-04T00:00:00Z',
                     'normal', NULL, 'unsupported_image');

                 INSERT INTO similarity_reviews (
                    id, existing_asset_id, candidate_asset_id, distance,
                    status, decision, created_at, resolved_at
                 ) VALUES
                    ('open-review', 'existing', 'candidate', 2,
                     'open', NULL, '2026-08-02T00:00:00Z', NULL),
                    ('resolved-review', 'existing', 'gif', 6,
                     'resolved', 'keep_both', '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 24).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM similarity_reviews WHERE fingerprint_kind = 'dhash-v1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM assets
                     WHERE perceptual_hash IS NOT NULL
                        OR perceptual_hash_quality IS NOT NULL
                        OR perceptual_hash_error IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
        assert!(connection
            .execute(
                "INSERT INTO similarity_reviews (
                    id, existing_asset_id, candidate_asset_id, distance,
                    fingerprint_kind, status, created_at
                 ) VALUES ('duplicate', 'existing', 'candidate', 20,
                           'pdq-v1', 'open', '2026-08-05T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

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
    fn migrates_v20_collection_legacy_kind_without_losing_collections() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, type, created_at, updated_at)
                 VALUES ('game-1', 'Normal Game', 'game', 't', 't')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 20).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT legacy_kind FROM collections WHERE id = 'game-1'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn migrates_v21_collection_foundation_without_rewriting_ratings() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO collections
                (id, name, type, author, my_score, showcase, created_at, updated_at)
             VALUES
                ('game-a', 'Game A', 'game', 'Studio A', 5, 1, '2026-01-01', '2026-01-01'),
                ('game-b', 'Game B', 'game', 'Studio B', 4, 1, '2026-01-02', '2026-01-02'),
                ('movie-a', 'Movie A', 'movie', NULL, 3, 1, '2026-01-01', '2026-01-01');",
            )
            .unwrap();

        migrate_to_latest(&mut connection, 21).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let game: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<f64>,
            Option<i64>,
        ) = connection
            .query_row(
                "SELECT developer, production_company, release_date, my_score, showcase_order
                     FROM collections WHERE id = 'game-a'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            game,
            (Some("Studio A".into()), None, None, Some(5.0), Some(0))
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT showcase_order FROM collections WHERE id = 'game-b'",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            Some(1)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT showcase_order FROM collections WHERE id = 'movie-a'",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            Some(0)
        );
    }

    #[test]
    fn migrates_v22_to_v23_game_provider_detail() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, type, created_at, updated_at)
                 VALUES ('game-1', 'Sega Game', 'game', 't', 't')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 22).unwrap();

        let provider_detail: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT publisher, platforms FROM collections WHERE id = 'game-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(provider_detail, (None, None));
    }

    #[test]
    fn migrates_v23_to_v24_movie_provider_detail() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, type, created_at, updated_at)
                 VALUES ('movie-1', 'Movie', 'movie', 't', 't')",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 23).unwrap();

        let fields: (Option<String>, Option<i64>) = connection
            .query_row(
                "SELECT original_title, runtime_minutes FROM collections WHERE id = 'movie-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(fields, (None, None));
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
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

    #[test]
    fn migrates_v19_to_legacy_package_mappings() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
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
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-22T00:00:00Z'
                 )",
                [],
            )
            .unwrap();

        migrate_to_latest(&mut connection, 19).unwrap();

        for item in ["item-1", "item-2"] {
            connection
                .execute(
                    "INSERT INTO legacy_package_asset_mappings (
                        source_library_id, source_item_id, asset_id, source_sha256,
                        raw_metadata_json, imported_at
                     ) VALUES (
                        'legacy-library', ?1, 'asset-1',
                        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                        '{}', '2026-08-22T00:00:00Z'
                     )",
                    [item],
                )
                .unwrap();
        }
        assert!(connection
            .execute(
                "INSERT INTO legacy_package_asset_mappings (
                    source_library_id, source_item_id, asset_id, source_sha256,
                    raw_metadata_json, imported_at
                 ) VALUES (
                    'legacy-library', 'item-1', 'asset-1',
                    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                    '{}', '2026-08-22T00:00:00Z'
                 )",
                [],
            )
            .is_err());
        assert!(!connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }

    #[test]
    fn migrates_v26_to_revisit_schema() {
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
            ONLINE_CATALOG_BOOKMARKS_SCHEMA,
            LEGACY_PACKAGE_IMPORTS_SCHEMA,
            COLLECTION_LEGACY_KIND_SCHEMA,
            COLLECTION_FOUNDATION_SCHEMA,
            GAME_PROVIDER_DETAIL_SCHEMA,
            MOVIE_PROVIDER_DETAIL_SCHEMA,
            PDQ_SIMILARITY_SCHEMA,
            COLLECTED_AT_UTC_SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }

        migrate_to_latest(&mut connection, 26).unwrap();

        for table in [
            "asset_activity",
            "revisit_slates",
            "revisit_bundles",
            "revisit_bundle_assets",
            "revisit_preferences",
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        [table],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
                    > 0
            );
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }
    #[test]
    fn migrates_v31_to_manga_catalog_recovery_links() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "user_version", 31).unwrap();

        migrate_to_latest(&mut connection, 31).unwrap();

        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'manga_catalog_recovery_links'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION,
        );
    }
}
