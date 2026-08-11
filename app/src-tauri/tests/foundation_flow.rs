use std::{
    fs,
    path::{Path, PathBuf},
};

use app_lib::library::{
    error::LibraryError,
    models::{
        AssetCursor, AssetPage, AssetQuery, AssetSort, AssetSummary, ClassificationKind,
        CreateClassification, IngestMediaRequest, IngestOutcome, MediaSummary, TrashPolicy,
    },
    Library,
};
use chrono::{TimeZone, Utc};
use image::{ImageFormat, Rgb, RgbImage};
use rusqlite::{params, Connection};
use tempfile::TempDir;

struct ClassificationPath {
    root_id: String,
    tag_id: String,
}

struct FoundationFixture {
    _temp: TempDir,
    library: Library,
    source_path: PathBuf,
}

struct MigrationFixture {
    _temp: TempDir,
    root: PathBuf,
}

impl MigrationFixture {
    fn root(&self) -> &Path {
        &self.root
    }
}

impl FoundationFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("arona.png");
        write_image(&source_path, ImageFormat::Png);
        let library = Library::open(temp.path().join("Lakomics Library")).unwrap();
        Self {
            _temp: temp,
            library,
            source_path,
        }
    }

    fn create_game_work_tag(&self) -> ClassificationPath {
        let root = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "게임".into(),
                parent_id: None,
            })
            .unwrap();
        let work = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "블루 아카이브".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let tag = self
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "아로나".into(),
                parent_id: Some(work.id),
            })
            .unwrap();
        ClassificationPath {
            root_id: root.id,
            tag_id: tag.id,
        }
    }

    fn ingest(&self, classification_id: &str) -> AssetSummary {
        match self.ingest_raw(classification_id) {
            IngestOutcome::Added { asset } => asset,
            IngestOutcome::ExactDuplicate { .. } => panic!("first ingest must add an asset"),
            IngestOutcome::ReviewPending { .. } => {
                panic!("first ingest cannot need similarity review")
            }
        }
    }

    fn ingest_raw(&self, classification_id: &str) -> IngestOutcome {
        self.library
            .ingest_media(IngestMediaRequest {
                source_path: self.source_path.clone(),
                classification_id: Some(classification_id.into()),
                source_url: None,
            })
            .unwrap()
    }

    fn query(&self, classification_id: &str) -> AssetPage {
        self.library
            .list_assets(AssetQuery {
                classification_id: Some(classification_id.into()),
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 100,
            })
            .unwrap()
    }
}

#[test]
fn image_can_be_ingested_classified_queried_and_deduplicated() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let added = fixture.ingest(&classification.tag_id);
    let page = fixture.query(&classification.root_id);

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, added.id);
    assert!(fixture.source_path.is_file());

    let classifications_before = fixture
        .library
        .get_asset_classifications(&added.id)
        .unwrap();
    assert_eq!(classifications_before.len(), 1);
    assert_eq!(classifications_before[0].id, classification.tag_id);
    let duplicate_target = fixture
        .library
        .create_classification(CreateClassification {
            kind: ClassificationKind::Root,
            name: "중복 수집 대상".into(),
            parent_id: None,
        })
        .unwrap();

    let duplicate = fixture.ingest_raw(&duplicate_target.id);
    assert_eq!(
        duplicate,
        IngestOutcome::ExactDuplicate {
            existing_asset_id: added.id.clone(),
        },
    );
    assert_eq!(
        fixture
            .library
            .get_asset_classifications(&added.id)
            .unwrap(),
        classifications_before,
    );
    assert!(fixture.query(&duplicate_target.id).items.is_empty());
    assert_eq!(fixture.query(&classification.root_id), page);
    assert!(fixture.source_path.is_file());
}

#[test]
fn png_jpeg_and_gif_images_can_be_ingested() {
    for (extension, format) in [
        ("png", ImageFormat::Png),
        ("jpg", ImageFormat::Jpeg),
        ("gif", ImageFormat::Gif),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join(format!("source.{extension}"));
        write_image(&source_path, format);
        let library = Library::open(temp.path().join("library")).unwrap();

        let outcome = library
            .ingest_media(IngestMediaRequest {
                source_path: source_path.clone(),
                classification_id: None,
                source_url: None,
            })
            .unwrap();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("{extension} must add an asset");
        };
        assert_eq!((asset.width, asset.height), (8, 6));
        assert_eq!(
            asset.media,
            if extension == "gif" {
                MediaSummary::Gif
            } else {
                MediaSummary::Image
            }
        );
        assert!(source_path.is_file());
    }
}

#[test]
fn public_asset_flow_supports_favorites_sorts_random_paging_and_source_urls() {
    let temp = tempfile::tempdir().unwrap();
    let first_path = temp.path().join("first.png");
    let second_path = temp.path().join("second.png");
    write_distinct_image(&first_path, 0);
    write_distinct_image(&second_path, 1);
    let library = Library::open(temp.path().join("library")).unwrap();

    let first = ingest(&library, &first_path, Some("https://example.test/first"));
    let second = ingest(&library, &second_path, None);
    library.set_asset_favorite(&first.id, true).unwrap();

    let favorites = library
        .list_assets(asset_query(AssetSort::Favorites, true, None, 20))
        .unwrap();
    assert_eq!(favorites.items.len(), 1);
    assert_eq!(favorites.items[0].id, first.id);
    assert!(favorites.items[0].favorite);
    assert_eq!(
        favorites.items[0].source_url.as_deref(),
        Some("https://example.test/first")
    );

    let newest = library
        .list_assets(asset_query(AssetSort::Newest, false, None, 1))
        .unwrap();
    let oldest = library
        .list_assets(asset_query(AssetSort::Oldest, false, None, 1))
        .unwrap();
    assert_eq!(newest.items.len(), 1);
    assert_eq!(oldest.items.len(), 1);
    assert_ne!(newest.next_cursor, None);
    assert_ne!(oldest.next_cursor, None);

    let random = asset_query(AssetSort::Random, false, Some("8"), 20);
    assert_eq!(
        library.list_assets(random.clone()).unwrap(),
        library.list_assets(random).unwrap()
    );
    assert_ne!(first.id, second.id);
}

#[test]
fn migrates_v1_after_creating_a_verified_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    fs::create_dir(&root).unwrap();
    let database_path = root.join("library.sqlite");
    let database = Connection::open(&database_path).unwrap();
    database
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    database
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (
                'asset-1', 'hash-1', 'image', 'asset.png', 'assets/asset.png',
                'thumbnails/asset.png', 1, 1, 1, '2026-08-01T00:00:00Z'
             )",
            [],
        )
        .unwrap();
    drop(database);

    let library = Library::open(&root).unwrap();

    assert_eq!(user_version(&library), 7);
    assert_eq!(library.trash_policy().unwrap().retention_days, Some(30));
    assert!(!library.root().join("trash").exists());
    assert_eq!(library.get_asset("asset-1").unwrap().id, "asset-1");
    let backups = pre_migration_backups(library.root());
    assert_eq!(backups.len(), 1);
    let snapshot = Connection::open(&backups[0]).unwrap();
    assert_eq!(
        snapshot
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        snapshot
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let snapshot_asset: (String, String, String, String) = snapshot
        .query_row(
            "SELECT id, content_hash, original_name, status FROM assets",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        snapshot_asset,
        (
            "asset-1".into(),
            "hash-1".into(),
            "asset.png".into(),
            "normal".into(),
        )
    );
}

#[test]
fn version_two_library_migrates_similarity_state_after_a_verified_backup() {
    let fixture = version_two_library();
    let library = Library::open(fixture.root()).unwrap();
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();

    assert_eq!(user_version(&library), 7);
    connection
        .execute(
            "UPDATE assets SET perceptual_hash = ?2 WHERE id = ?1",
            params!["asset-1", vec![0_u8; 8]],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO similarity_reviews (
                id, existing_asset_id, candidate_asset_id, distance, status, created_at
             ) VALUES ('review-1', 'asset-1', 'asset-2', 2, 'open', '2026-08-09T00:00:00Z')",
            [],
        )
        .unwrap();
    assert_eq!(pre_migration_backups(library.root()).len(), 1);
}

#[test]
fn version_three_library_migrates_video_state_without_changing_images() {
    let fixture = version_three_library();
    let library = Library::open(fixture.root()).unwrap();
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();

    assert_eq!(user_version(&library), 7);
    let preserved: (String, Option<String>) = connection
        .query_row(
            "SELECT media_kind, thumbnail_relative_path FROM assets WHERE id = 'asset-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        preserved,
        ("image".into(), Some("thumbnails/aa/image.webp".into()))
    );
    connection
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (
                'video-1', 'video-hash', 'video', 'clip.webm', 'assets/vi/clip.webm',
                NULL, 10, 1920, 1080, '2026-08-09T00:00:00Z'
             )",
            [],
        )
        .unwrap();
    assert_eq!(pre_migration_backups(library.root()).len(), 1);
}

#[test]
fn video_media_summary_is_preserved_in_get_asset_and_trash_list() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (
                'video-1', 'video-hash', 'video', 'clip.webm', 'assets/vi/clip.webm',
                NULL, 10, 1920, 1080, '2026-08-09T00:00:00Z'
             )",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO video_assets (
                asset_id, duration_ms, container, video_codec, audio_codec,
                preparation_state, scrub_frame_count
             ) VALUES ('video-1', 12345, 'webm', 'vp9', 'opus', 'pending', 0)",
            [],
        )
        .unwrap();
    drop(connection);
    let expected = MediaSummary::Video {
        duration_ms: 12_345,
        preparation_state: app_lib::library::models::VideoPreparationState::Pending,
        scrub_frame_count: 0,
    };

    assert_eq!(library.get_asset("video-1").unwrap().media, expected);
    library.trash_assets(&["video-1".into()]).unwrap();
    let trash = library.list_trash(None, 20).unwrap();
    assert_eq!(trash.items[0].asset.media, expected);
}

#[test]
fn video_trash_retains_derivatives_and_restore_reuses_them() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let (original, derivatives) = insert_ready_video(&library, "video-trash", "normal");

    library.trash_assets(&["video-trash".into()]).unwrap();

    assert!(original.is_file());
    assert!(derivatives.join("poster.webp").is_file());
    assert!(derivatives.join("scrub/000.webp").is_file());
    library.restore_asset("video-trash").unwrap();
    assert!(matches!(
        library.get_asset("video-trash").unwrap().media,
        MediaSummary::Video {
            preparation_state: app_lib::library::models::VideoPreparationState::Ready,
            ..
        }
    ));
    assert!(derivatives.join("poster.webp").is_file());
}

#[test]
fn video_trash_purge_removes_original_derivative_directory_and_rows() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let (original, derivatives) = insert_ready_video(&library, "video-purge", "trash");

    let result = library.empty_trash().unwrap();

    assert_eq!(result.deleted_count, 1);
    assert!(result.failed_asset_ids.is_empty());
    assert!(!original.exists());
    assert!(!derivatives.exists());
    let counts: (i64, i64) = Connection::open(library.root().join("library.sqlite"))
        .unwrap()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM assets WHERE id = 'video-purge'),
                    (SELECT COUNT(*) FROM video_assets WHERE asset_id = 'video-purge')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (0, 0));
}

#[test]
fn video_drag_out_copies_only_the_original() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let (original, derivatives) = insert_ready_video(&library, "video-drag", "normal");

    let prepared = library.prepare_asset_drag(&["video-drag".into()]).unwrap();

    assert_eq!(prepared.files.len(), 1);
    assert_eq!(
        std::fs::read(&prepared.files[0]).unwrap(),
        b"original-video"
    );
    assert_eq!(
        prepared.files[0].file_name().unwrap().to_string_lossy(),
        "video-drag.webm"
    );
    assert!(prepared.preview.is_file());
    assert_eq!(std::fs::read(&original).unwrap(), b"original-video");
    assert!(derivatives.join("poster.webp").is_file());
}

#[test]
fn missing_video_derivative_is_requeued_on_open_without_replacing_original() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let library = Library::open(&root).unwrap();
    let (original, derivatives) = insert_ready_video(&library, "video-requeue", "normal");
    std::fs::remove_file(derivatives.join("poster.webp")).unwrap();
    drop(library);

    let library = Library::open(&root).unwrap();

    assert_eq!(std::fs::read(&original).unwrap(), b"original-video");
    assert!(!derivatives.exists());
    let state: (String, Option<String>, Option<String>) =
        Connection::open(library.root().join("library.sqlite"))
            .unwrap()
            .query_row(
                "SELECT video.preparation_state, video.poster_relative_path,
                    asset.thumbnail_relative_path
             FROM video_assets AS video JOIN assets AS asset ON asset.id = video.asset_id
             WHERE video.asset_id = 'video-requeue'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
    assert_eq!(state, ("pending".into(), None, None));
}

#[test]
fn trash_policy_defaults_updates_and_rejects_out_of_range_retention() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();

    assert_eq!(
        library.trash_policy().unwrap(),
        TrashPolicy {
            retention_days: Some(30),
        }
    );
    library
        .set_trash_policy(TrashPolicy {
            retention_days: None,
        })
        .unwrap();
    assert_eq!(library.trash_policy().unwrap().retention_days, None);
    for retention_days in [Some(0), Some(3651)] {
        let error = library
            .set_trash_policy(TrashPolicy { retention_days })
            .unwrap_err();
        assert!(matches!(error, LibraryError::InvalidTrashRetention));
    }
}

#[test]
fn trash_keeps_files_in_place_and_restore_keeps_metadata() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let asset = fixture.ingest(&classification.tag_id);
    let asset_path = fixture.library.root().join(&asset.relative_path);
    let thumbnail_path = fixture
        .library
        .root()
        .join(asset.thumbnail_relative_path.as_deref().unwrap());

    fixture
        .library
        .trash_assets(std::slice::from_ref(&asset.id))
        .unwrap();

    assert!(fixture.library.get_asset(&asset.id).is_err());
    assert!(asset_path.is_file());
    assert!(thumbnail_path.is_file());
    assert_eq!(fixture.library.list_trash(None, 20).unwrap().items.len(), 1);

    fixture.library.restore_asset(&asset.id).unwrap();

    assert_eq!(fixture.library.get_asset(&asset.id).unwrap().id, asset.id);
    assert!(fixture
        .library
        .list_trash(None, 20)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        fixture
            .library
            .get_asset_classifications(&asset.id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec![classification.tag_id]
    );
}

#[test]
fn trash_pages_by_trashed_at_and_id_and_derives_purge_at() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let first_path = temp.path().join("first.png");
    let second_path = temp.path().join("second.png");
    let third_path = temp.path().join("third.png");
    write_distinct_image(&first_path, 0);
    write_distinct_image(&second_path, 1);
    write_distinct_image(&third_path, 2);
    let first = ingest(&library, &first_path, None);
    let second = ingest(&library, &second_path, None);
    let third = ingest(&library, &third_path, None);
    library
        .set_trash_policy(TrashPolicy {
            retention_days: Some(7),
        })
        .unwrap();
    for asset in [&first, &second, &third] {
        library
            .trash_assets(std::slice::from_ref(&asset.id))
            .unwrap();
    }
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();
    for (asset_id, trashed_at) in [
        (&first.id, "2026-08-01T00:00:00Z"),
        (&second.id, "2026-08-03T00:00:00Z"),
        (&third.id, "2026-08-02T00:00:00Z"),
    ] {
        connection
            .execute(
                "UPDATE assets SET trashed_at = ?2 WHERE id = ?1",
                [asset_id, trashed_at],
            )
            .unwrap();
    }

    let first_page = library.list_trash(None, 2).unwrap();
    let second_page = library
        .list_trash(first_page.next_cursor.clone(), 2)
        .unwrap();

    assert_eq!(first_page.total_count, 3);
    assert_eq!(
        first_page.total_bytes,
        first.byte_size + second.byte_size + third.byte_size
    );
    assert_eq!(
        first_page
            .items
            .iter()
            .map(|item| item.asset.id.as_str())
            .collect::<Vec<_>>(),
        [second.id.as_str(), third.id.as_str()]
    );
    assert_eq!(
        first_page.items[0].purge_at.as_deref(),
        Some("2026-08-10T00:00:00+00:00")
    );
    assert_eq!(
        second_page
            .items
            .iter()
            .map(|item| item.asset.id.as_str())
            .collect::<Vec<_>>(),
        [first.id.as_str()]
    );
}

#[test]
fn empty_trash_preserves_records_when_a_managed_path_is_unsafe() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let asset = fixture.ingest(&classification.tag_id);
    fixture
        .library
        .trash_assets(std::slice::from_ref(&asset.id))
        .unwrap();
    let external_copy = fixture
        .library
        .root()
        .parent()
        .unwrap()
        .join("external-user-copy.png");
    fs::write(&external_copy, b"user-owned").unwrap();
    Connection::open(fixture.library.root().join("library.sqlite"))
        .unwrap()
        .execute(
            "UPDATE assets SET relative_path = '../external-user-copy.png' WHERE id = ?1",
            [&asset.id],
        )
        .unwrap();

    let result = fixture.library.empty_trash().unwrap();

    assert_eq!(result.deleted_count, 0);
    assert_eq!(result.failed_asset_ids, vec![asset.id.clone()]);
    assert_eq!(fs::read(&external_copy).unwrap(), b"user-owned");
    assert_eq!(fixture.library.list_trash(None, 20).unwrap().items.len(), 1);
    assert_eq!(
        fixture
            .library
            .get_asset_classifications(&asset.id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec![classification.tag_id]
    );
}

#[test]
fn empty_trash_keeps_a_partial_failure_until_a_missing_file_can_be_retried() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let asset = fixture.ingest(&classification.tag_id);
    let asset_path = fixture.library.root().join(&asset.relative_path);
    let thumbnail_path = fixture
        .library
        .root()
        .join(asset.thumbnail_relative_path.as_deref().unwrap());
    fixture
        .library
        .trash_assets(std::slice::from_ref(&asset.id))
        .unwrap();
    fs::remove_file(&thumbnail_path).unwrap();
    fs::create_dir(&thumbnail_path).unwrap();

    let failed = fixture.library.empty_trash().unwrap();

    assert_eq!(failed.deleted_count, 0);
    assert_eq!(failed.failed_asset_ids, vec![asset.id.clone()]);
    assert!(!asset_path.exists());
    assert!(thumbnail_path.is_dir());
    assert_eq!(fixture.library.list_trash(None, 20).unwrap().items.len(), 1);
    assert_eq!(
        fixture
            .library
            .get_asset_classifications(&asset.id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec![classification.tag_id]
    );

    fs::remove_dir(&thumbnail_path).unwrap();
    fs::write(&thumbnail_path, b"replacement thumbnail").unwrap();
    let retried = fixture.library.empty_trash().unwrap();

    assert_eq!(retried.deleted_count, 1);
    assert!(retried.failed_asset_ids.is_empty());
    assert!(fixture
        .library
        .list_trash(None, 20)
        .unwrap()
        .items
        .is_empty());
    assert!(fixture
        .library
        .get_asset_classifications(&asset.id)
        .unwrap()
        .is_empty());
}

#[test]
fn list_trash_reuses_cursor_and_page_limit_validation() {
    let fixture = FoundationFixture::new();

    for limit in [0, 201] {
        assert!(matches!(
            fixture.library.list_trash(None, limit),
            Err(LibraryError::InvalidAssetPageLimit)
        ));
    }
    assert!(matches!(
        fixture.library.list_trash(
            Some(AssetCursor {
                token: "not-a-trash-cursor".into(),
            }),
            20,
        ),
        Err(LibraryError::InvalidAssetCursor)
    ));
}

#[test]
fn purge_expired_trash_removes_managed_files_and_metadata() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let asset = fixture.ingest(&classification.tag_id);
    let asset_path = fixture.library.root().join(&asset.relative_path);
    let thumbnail_path = fixture
        .library
        .root()
        .join(asset.thumbnail_relative_path.as_deref().unwrap());
    fixture
        .library
        .set_trash_policy(TrashPolicy {
            retention_days: Some(7),
        })
        .unwrap();
    fixture
        .library
        .trash_assets(std::slice::from_ref(&asset.id))
        .unwrap();
    Connection::open(fixture.library.root().join("library.sqlite"))
        .unwrap()
        .execute(
            "UPDATE assets SET trashed_at = '2026-07-01T00:00:00Z' WHERE id = ?1",
            [&asset.id],
        )
        .unwrap();

    let result = fixture
        .library
        .purge_expired_trash(Utc.with_ymd_and_hms(2026, 7, 8, 0, 0, 0).unwrap())
        .unwrap();

    assert_eq!(result.deleted_count, 1);
    assert!(result.failed_asset_ids.is_empty());
    assert!(!asset_path.exists());
    assert!(!thumbnail_path.exists());
    assert!(fixture
        .library
        .list_trash(None, 20)
        .unwrap()
        .items
        .is_empty());
    assert!(fixture.library.get_asset(&asset.id).is_err());
}

fn ingest(library: &Library, source_path: &Path, source_url: Option<&str>) -> AssetSummary {
    let outcome = library
        .ingest_media(IngestMediaRequest {
            source_path: source_path.to_path_buf(),
            classification_id: None,
            source_url: source_url.map(str::to_owned),
        })
        .unwrap();
    let IngestOutcome::Added { asset } = outcome else {
        panic!("each distinct test image must be added");
    };
    asset
}

fn asset_query(
    sort: AssetSort,
    favorite_only: bool,
    random_pivot: Option<&str>,
    limit: u32,
) -> AssetQuery {
    AssetQuery {
        classification_id: None,
        direct_only: false,
        favorite_only,
        unclassified_only: false,
        sort,
        random_pivot: random_pivot.map(str::to_owned),
        after: None,
        limit,
    }
}

fn write_distinct_image(path: &Path, pattern: u8) {
    RgbImage::from_fn(96, 64, |x, y| {
        let light = match pattern {
            0 => (x / 8) % 2 == 0,
            1 => (y / 8) % 2 == 0,
            _ => ((x + y) / 8) % 2 == 0,
        };
        Rgb(if light { [240, 180, 30] } else { [20, 60, 180] })
    })
    .save_with_format(path, ImageFormat::Png)
    .unwrap();
}

fn write_image(path: &Path, format: ImageFormat) {
    RgbImage::from_pixel(8, 6, Rgb([40, 80, 120]))
        .save_with_format(path, format)
        .unwrap();
}

fn version_two_library() -> MigrationFixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    fs::create_dir(&root).unwrap();
    let database = Connection::open(root.join("library.sqlite")).unwrap();
    database
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    database
        .execute_batch(include_str!("../migrations/0002_vault_safety.sql"))
        .unwrap();
    for (id, hash, name) in [
        ("asset-1", "hash-1", "first.png"),
        ("asset-2", "hash-2", "second.png"),
    ] {
        database
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1, '2026-08-01T00:00:00Z')",
                params![
                    id,
                    hash,
                    name,
                    format!("assets/{name}"),
                    format!("thumbnails/{name}")
                ],
            )
            .unwrap();
    }
    drop(database);
    MigrationFixture { _temp: temp, root }
}

fn insert_ready_video(library: &Library, asset_id: &str, status: &str) -> (PathBuf, PathBuf) {
    let original_relative = format!("assets/vi/{asset_id}.webm");
    let derivative_relative = format!("video-media/{asset_id}");
    let poster_relative = format!("{derivative_relative}/poster.webp");
    let scrub_relative = format!("{derivative_relative}/scrub");
    let original = library.root().join(&original_relative);
    let derivatives = library.root().join(&derivative_relative);
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::create_dir_all(derivatives.join("scrub")).unwrap();
    std::fs::write(&original, b"original-video").unwrap();
    std::fs::write(derivatives.join("poster.webp"), b"poster").unwrap();
    std::fs::write(derivatives.join("scrub/000.webp"), b"frame").unwrap();
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at, status,
                trashed_at
             ) VALUES (?1, ?2, 'video', ?3, ?4, ?5, 14, 1280, 720,
                '2026-08-09T00:00:00Z', ?6, CASE WHEN ?6 = 'trash' THEN '2026-08-09T00:00:00Z' END)",
            params![
                asset_id,
                format!("hash-{asset_id}"),
                format!("{asset_id}.webm"),
                original_relative,
                poster_relative,
                status,
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO video_assets (
                asset_id, duration_ms, container, video_codec, audio_codec,
                preparation_state, playback_kind, poster_relative_path,
                scrub_relative_dir, scrub_frame_count
             ) VALUES (?1, 5000, 'webm', 'vp9', 'opus', 'ready', 'original', ?2, ?3, 1)",
            params![asset_id, poster_relative, scrub_relative],
        )
        .unwrap();
    (original, derivatives)
}

fn version_three_library() -> MigrationFixture {
    let fixture = version_two_library();
    let database = Connection::open(fixture.root.join("library.sqlite")).unwrap();
    database
        .execute_batch(include_str!("../migrations/0003_similarity_review.sql"))
        .unwrap();
    database
        .execute(
            "UPDATE assets
             SET relative_path = 'assets/aa/image.png',
                 thumbnail_relative_path = 'thumbnails/aa/image.webp'
             WHERE id = 'asset-1'",
            [],
        )
        .unwrap();
    drop(database);
    fixture
}

fn user_version(library: &Library) -> i64 {
    Connection::open(library.root().join("library.sqlite"))
        .unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn pre_migration_backups(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root.join("backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("pre-migration-"))
        })
        .collect()
}
