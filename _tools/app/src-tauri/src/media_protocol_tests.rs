    use std::io::Cursor;
    use std::time::{Duration, SystemTime};

    use image::{DynamicImage, ImageFormat};
    use rusqlite::params;
    use tauri::http::{
        header::{ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE},
        Method, Response, StatusCode,
    };

    use crate::library::{error::LibraryError, models::thumbnail_revision, Library, MediaVariant};

    use super::{
        cached_preview_from, media_response, media_response_with_range,
        parse_catalog_thumbnail_path, parse_media_path, parse_path, parse_remote_manga_path,
        PreviewCache, PreviewCacheKey, PreviewVariant,
    };

    const ASSET_ID: &str = "00000000-0000-4000-8000-000000000001";
    const MISSING_ID: &str = "00000000-0000-4000-8000-000000000002";
    const REVIEW_ID: &str = "00000000-0000-4000-8000-000000000003";
    const TRASH_ID: &str = "00000000-0000-4000-8000-000000000004";
    const SERIES_ID: &str = "00000000-0000-4000-8000-000000000005";
    const COLLECTION_ID: &str = "00000000-0000-4000-8000-000000000006";
    const ARTWORK_ID: &str = "00000000-0000-4000-8000-000000000007";

    fn preview_test_response(status: StatusCode, bytes: &[u8]) -> Response<Vec<u8>> {
        Response::builder()
            .status(status)
            .header(CONTENT_TYPE, "image/png")
            .body(bytes.to_vec())
            .unwrap()
    }

    #[test]
    fn preview_disk_cache_survives_memory_reset_and_separates_provider_sizes() {
        let directory = tempfile::tempdir().unwrap();
        let key = PreviewCacheKey::new(PreviewVariant::TmdbPoster, "/cover.png");
        cached_preview_from(
            &std::sync::Mutex::new(PreviewCache::new(32)),
            key.clone(),
            || {
                super::cached_preview_disk_from(Some(directory.path()), &key, || {
                    preview_test_response(StatusCode::OK, b"disk")
                })
            },
        );
        let warm = cached_preview_from(
            &std::sync::Mutex::new(PreviewCache::new(32)),
            key.clone(),
            || {
                super::cached_preview_disk_from(Some(directory.path()), &key, || {
                    panic!("warm restart must not fetch")
                })
            },
        );
        assert_eq!(warm.body(), b"disk");
        assert_eq!(warm.headers()[CONTENT_TYPE], "image/png");
        for variant in [
            PreviewVariant::TmdbBackdrop,
            PreviewVariant::IgdbCover,
            PreviewVariant::IgdbHero,
        ] {
            assert!(super::preview_disk_read(
                directory.path(),
                &PreviewCacheKey::new(variant, "/cover.png")
            )
            .is_none());
        }
    }

    #[test]
    fn preview_disk_cache_recovers_corruption_and_never_caches_failures() {
        let directory = tempfile::tempdir().unwrap();
        let key = PreviewCacheKey::new(PreviewVariant::IgdbCover, "cover");
        let path = super::preview_disk_path(directory.path(), &key);
        std::fs::write(&path, b"invalid").unwrap();
        let response = super::cached_preview_disk_from(Some(directory.path()), &key, || {
            preview_test_response(StatusCode::OK, b"recovered")
        });
        assert_eq!(response.body(), b"recovered");
        assert_eq!(
            super::preview_disk_read(directory.path(), &key)
                .unwrap()
                .body(),
            b"recovered"
        );
        let old = SystemTime::now() - super::PREVIEW_DISK_AGE - Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert!(super::preview_disk_read(directory.path(), &key).is_none());
        super::cached_preview_disk_from(Some(directory.path()), &key, || {
            preview_test_response(StatusCode::OK, b"renewed")
        });
        assert_eq!(
            super::preview_disk_read(directory.path(), &key)
                .unwrap()
                .body(),
            b"renewed"
        );
        let missing = PreviewCacheKey::new(PreviewVariant::TmdbPoster, "/missing.png");
        for _ in 0..2 {
            assert_eq!(
                super::cached_preview_disk_from(Some(directory.path()), &missing, || {
                    preview_test_response(StatusCode::NOT_FOUND, b"")
                })
                .status(),
                StatusCode::NOT_FOUND
            );
            assert!(!super::preview_disk_path(directory.path(), &missing).exists());
        }
    }

    #[test]
    fn preview_disk_cache_bounds_bytes_and_entries_without_touching_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let other = directory.path().join("other.txt");
        std::fs::write(&other, b"keep").unwrap();
        for name in ["a", "b", "c"] {
            super::preview_disk_write(
                directory.path(),
                &PreviewCacheKey::new(PreviewVariant::IgdbCover, name),
                &preview_test_response(StatusCode::OK, b"123456"),
            );
        }
        super::prune_preview_disk(directory.path(), 32, 1);
        let files = std::fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "preview"))
            .collect::<Vec<_>>();
        assert!(files.len() <= 1);
        assert!(
            files
                .iter()
                .map(|entry| entry.metadata().unwrap().len())
                .sum::<u64>()
                <= 32
        );
        assert_eq!(std::fs::read(other).unwrap(), b"keep");
    }

    #[test]
    fn preview_cache_hit_returns_stored_bytes_without_fetching() {
        let cache = std::sync::Mutex::new(PreviewCache::new(32));
        let key = PreviewCacheKey::new(PreviewVariant::IgdbCover, "cover-1");
        let mut fetches = 0;

        cached_preview_from(&cache, key.clone(), || {
            fetches += 1;
            preview_test_response(StatusCode::OK, b"cached")
        });
        let response = cached_preview_from(&cache, key, || {
            fetches += 1;
            preview_test_response(StatusCode::OK, b"fresh")
        });

        assert_eq!(fetches, 1);
        assert_eq!(response.body(), b"cached");
        assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[CACHE_CONTROL], "private, max-age=86400");
        assert_eq!(response.headers()[CONTENT_LENGTH], "6");
    }

    #[test]
    fn preview_cache_does_not_store_errors() {
        let cache = std::sync::Mutex::new(PreviewCache::new(32));
        let key = PreviewCacheKey::new(PreviewVariant::TmdbPoster, "poster-1");
        let mut fetches = 0;

        for _ in 0..2 {
            let response = cached_preview_from(&cache, key.clone(), || {
                fetches += 1;
                preview_test_response(StatusCode::NOT_FOUND, b"")
            });
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }

        assert_eq!(fetches, 2);
    }

    #[test]
    fn preview_cache_evicts_the_oldest_entry_over_budget() {
        let cache = std::sync::Mutex::new(PreviewCache::new(5));
        let oldest = PreviewCacheKey::new(PreviewVariant::IgdbCover, "oldest");
        let newest = PreviewCacheKey::new(PreviewVariant::IgdbHero, "newest");

        cached_preview_from(&cache, oldest.clone(), || {
            preview_test_response(StatusCode::OK, b"123")
        });
        cached_preview_from(&cache, newest.clone(), || {
            preview_test_response(StatusCode::OK, b"456")
        });

        let newest_response = cached_preview_from(&cache, newest, || {
            panic!("the newest entry should remain cached")
        });
        assert_eq!(newest_response.body(), b"456");

        let mut refetched = 0;
        let oldest_response = cached_preview_from(&cache, oldest, || {
            refetched += 1;
            preview_test_response(StatusCode::OK, b"789")
        });
        assert_eq!(refetched, 1);
        assert_eq!(oldest_response.body(), b"789");
    }

    #[test]
    fn remote_manga_routes_accept_only_closed_numeric_paths() {
        assert_eq!(
            parse_remote_manga_path("/remote-manga-page/kHentai/42/3"),
            Some((42, 3))
        );
        assert_eq!(
            parse_remote_manga_path("/remote-manga-thumbnail/42"),
            Some((42, 1))
        );
        for path in [
            "/remote-manga-page/hitomi/42/3",
            "/remote-manga-page/kHentai/42/0",
            "/remote-manga-page/kHentai/../3",
            "/remote-manga-thumbnail/42/extra",
        ] {
            assert_eq!(parse_remote_manga_path(path), None, "{path}");
        }
    }

    #[test]
    fn catalog_thumbnail_route_requires_a_provider_qualified_identity() {
        let identity = parse_catalog_thumbnail_path("/remote-catalog-thumbnail/kHentai/42").unwrap();
        assert_eq!(identity.provider, crate::library::catalog_provider::CatalogProvider::KHentai);
        assert_eq!(identity.provider_work_id, "42");
        for path in [
            "/remote-catalog-thumbnail/42",
            "/remote-catalog-thumbnail/unknown/42",
            "/remote-catalog-thumbnail/0",
            "/remote-catalog-thumbnail/-1",
            "/remote-catalog-thumbnail/abc",
            "/remote-catalog-thumbnail/kHentai/42/extra",
            "/remote-catalog-thumbnail/",
        ] {
            assert_eq!(parse_catalog_thumbnail_path(path), None, "{path}");
        }
    }

    fn collection_source_library(with_preview: bool) -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let source_root = temp.path().join("source");
        let collection_dir = source_root.join("series");
        std::fs::create_dir_all(&collection_dir).unwrap();
        if with_preview {
            std::fs::write(collection_dir.join("thumbnail.webp"), b"source preview").unwrap();
        }
        library
            .set_collection_source_root(Some(source_root.to_string_lossy().as_ref()))
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collections (id, name, created_at, updated_at, source_path)
                 VALUES (?1, 'Series', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 'series')",
                [COLLECTION_ID],
            )
            .unwrap();
        (temp, library)
    }

    fn collection_thumbnail_library() -> (tempfile::TempDir, Library) {
        let (temp, library) = collection_source_library(false);
        let collection_dir = temp.path().join("source").join("series");
        std::fs::create_dir_all(collection_dir.join("covers")).unwrap();
        DynamicImage::new_rgb8(1200, 800)
            .save(collection_dir.join("thumbnail.png"))
            .unwrap();
        DynamicImage::new_rgb8(800, 1200)
            .save(collection_dir.join("covers").join("vol_1_cover.png"))
            .unwrap();
        (temp, library)
    }

    #[test]
    fn collection_thumbnail_routes_serve_bounded_webp() {
        let (_temp, library) = collection_thumbnail_library();

        let source = media_response(
            Some(&library),
            &Method::GET,
            &format!("/collection-source-thumbnail/{COLLECTION_ID}"),
        );
        assert_eq!(source.status(), StatusCode::OK);
        assert_eq!(source.headers()[CONTENT_TYPE], "image/webp");

        let cover = media_response(
            Some(&library),
            &Method::GET,
            &format!(
                "/collection-cover-thumbnail/{COLLECTION_ID}/vol_1_cover.png"
            ),
        );
        assert_eq!(cover.status(), StatusCode::OK);
        assert_eq!(cover.headers()[CONTENT_TYPE], "image/webp");
    }

    #[test]
    fn collection_thumbnail_routes_reject_open_or_traversal_paths() {
        let (temp, library) = collection_thumbnail_library();
        DynamicImage::new_rgb8(400, 400)
            .save(temp.path().join("source").join("series").join("outside.png"))
            .unwrap();

        for path in [
            "/collection-source-thumbnail/not-a-uuid".to_string(),
            format!("/collection-cover-thumbnail/{COLLECTION_ID}"),
            format!("/collection-cover-thumbnail/{COLLECTION_ID}/..%2Foutside.png"),
        ] {
            assert_eq!(
                media_response(Some(&library), &Method::GET, &path).status(),
                StatusCode::BAD_REQUEST,
                "{path}",
            );
        }
    }

    #[test]
    fn collection_source_preview_route_serves_the_resolved_image() {
        let (_temp, library) = collection_source_library(true);

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/collection-source-preview/{COLLECTION_ID}"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(response.body(), b"source preview");
    }

    #[test]
    fn collection_source_preview_route_returns_not_found_without_a_candidate() {
        let (_temp, library) = collection_source_library(false);

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/collection-source-preview/{COLLECTION_ID}"),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn work_artwork_route_serves_only_the_id_resolved_file() {
        let (_temp, library) = collection_source_library(false);
        let relative_path = format!("work-artwork/{COLLECTION_ID}/{ARTWORK_ID}.png");
        let absolute_path = library.root().join(&relative_path);
        std::fs::create_dir_all(absolute_path.parent().unwrap()).unwrap();
        let mut artwork_bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(900, 1350)
            .write_to(&mut artwork_bytes, ImageFormat::Png)
            .unwrap();
        let artwork_bytes = artwork_bytes.into_inner();
        std::fs::write(&absolute_path, &artwork_bytes).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, selected, created_at, updated_at
                 ) VALUES (?1, ?2, 'mangadex', 'cover-1', 'cover', ?3,
                    'image/png', 10, 15, 1,
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')",
                params![ARTWORK_ID, COLLECTION_ID, relative_path],
            )
            .unwrap();

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/work-artwork/{ARTWORK_ID}"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(response.body(), &artwork_bytes);

        let cold_started = std::time::Instant::now();
        let thumbnail = media_response(
            Some(&library),
            &Method::GET,
            &format!("/work-artwork-thumbnail/{ARTWORK_ID}"),
        );
        let cold_elapsed = cold_started.elapsed();
        assert_eq!(thumbnail.status(), StatusCode::OK);
        assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
        let decoded = image::load_from_memory(thumbnail.body()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (240, 360));
        // A warm request must only read the small cached file, even if the original
        // cannot be decoded. This also guards against moving resizing into the WebView.
        std::fs::write(&absolute_path, b"not an image").unwrap();
        let warm_started = std::time::Instant::now();
        for _ in 0..20 {
            let warm = media_response(
                Some(&library),
                &Method::GET,
                &format!("/work-artwork-thumbnail/{ARTWORK_ID}"),
            );
            assert_eq!(warm.status(), StatusCode::OK);
            assert_eq!(warm.body(), thumbnail.body());
        }
        // Generate from the cached thumbnail even when the original is unreadable.
        let spine_path = format!("/work-artwork-thumbnail/{ARTWORK_ID}/spine");
        let mut spine = media_response(Some(&library), &Method::GET, &spine_path);
        assert_eq!(spine.status(), StatusCode::OK);
        assert_eq!(spine.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(spine.headers()[CACHE_CONTROL], "private, max-age=86400");
        let decoded = image::load_from_memory(spine.body()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 96));
        crate::collectible_cors::allow_cover_canvas(&mut spine, Some("http://tauri.localhost"), &spine_path);
        assert_eq!(spine.headers()["access-control-allow-origin"], "http://tauri.localhost");
        let mut external = media_response(Some(&library), &Method::GET, &spine_path);
        crate::collectible_cors::allow_cover_canvas(&mut external, Some("https://example.com"), &spine_path);
        assert!(!external.headers().contains_key("access-control-allow-origin"));
        library.cleanup_unreferenced_work_artwork().unwrap();
        let cached_spine = library.root().join(format!("work-artwork-thumbnails/{COLLECTION_ID}/{ARTWORK_ID}.spine.webp"));
        assert!(cached_spine.exists());
        // A warm spine read does not decode or recreate either larger source.
        std::fs::write(library.root().join(format!("work-artwork-thumbnails/{COLLECTION_ID}/{ARTWORK_ID}.webp")), b"not an image").unwrap();
        let warm = media_response(Some(&library), &Method::GET, &spine_path);
        assert_eq!(warm.status(), StatusCode::OK);
        assert_eq!(warm.body(), spine.body());
        for path in [format!("/work-artwork-thumbnail/not-a-uuid/spine"), format!("{spine_path}/more")] {
            assert_eq!(media_response(Some(&library), &Method::GET, &path).status(), StatusCode::BAD_REQUEST);
        }
        eprintln!(
            "w5 fixture: cold={cold_elapsed:?}, 20 warm requests={:?}",
            warm_started.elapsed()
        );
        assert!(library
            .root()
            .join(format!(
                "work-artwork-thumbnails/{COLLECTION_ID}/{ARTWORK_ID}.webp"
            ))
            .exists());
        assert_eq!(
            media_response(
                Some(&library),
                &Method::GET,
                "/work-artwork-thumbnail/not-a-uuid",
            )
            .status(),
            StatusCode::BAD_REQUEST,
        );
        assert_eq!(
            media_response(
                Some(&library),
                &Method::GET,
                &format!("/work-artwork-thumbnail/{ARTWORK_ID}/more"),
            )
            .status(),
            StatusCode::BAD_REQUEST,
        );
    }

    #[test]
    fn authority_work_artwork_cover_is_listed_and_served() {
        // Authority preserves imported UUIDs and also creates source-<sha> IDs.
        for artwork_id in [ARTWORK_ID.to_string(), format!("source-{}", "e5".repeat(32))] {
            let (_temp, library) = collection_source_library(false);
            let relative_path = format!(
                "work-artwork/authority/{COLLECTION_ID}/{artwork_id}-{}.webp",
                "2f".repeat(32)
            );
            let path = library.root().join(&relative_path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::new_rgb8(300, 450)
                .write_to(&mut bytes, ImageFormat::WebP)
                .unwrap();
            std::fs::write(&path, bytes.get_ref()).unwrap();
            library.connection().unwrap().execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, selected, created_at, updated_at
                 ) VALUES (?1, ?2, 'authority', ?1, 'cover', ?3,
                    'image/webp', 300, 450, 1, 't', 't')",
                params![artwork_id, COLLECTION_ID, relative_path],
            ).unwrap();
            let summary = library.list_collections().unwrap().into_iter()
                .find(|work| work.id == COLLECTION_ID).unwrap();
            assert_eq!(summary.selected_work_artwork_id.as_deref(), Some(artwork_id.as_str()));
            let original = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork/{artwork_id}"));
            assert_eq!(original.status(), StatusCode::OK, "{artwork_id}");
            assert_eq!(original.body(), bytes.get_ref());
            let thumbnail = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork-thumbnail/{artwork_id}"));
            assert_eq!(thumbnail.status(), StatusCode::OK, "{artwork_id}");
            assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
            let image = image::load_from_memory(thumbnail.body()).unwrap();
            assert_eq!((image.width(), image.height()), (240, 360));
            // The existing materialized thumbnail is served without opening the original.
            std::fs::remove_file(&path).unwrap();
            let warm = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork-thumbnail/{artwork_id}"));
            assert_eq!(warm.status(), StatusCode::OK);
            assert_eq!(warm.body(), thumbnail.body());
            let spine = media_response(Some(&library), &Method::GET,
                &format!("/work-artwork-thumbnail/{artwork_id}/spine"));
            assert_eq!(spine.status(), StatusCode::OK, "{artwork_id}");
            let decoded = image::load_from_memory(spine.body()).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (64, 96));
        }
    }

    #[test]
    fn parses_mangadex_cover_preview_route() {
        let file_name = "a1b2c3d4-e5f6-47a8-9000-111122223333.jpg";
        let (variant, manga_id, parsed_file_name) = parse_path(&format!(
            "/mangadex-cover-preview/{COLLECTION_ID}/{file_name}"
        ))
        .unwrap();

        assert!(matches!(variant, MediaVariant::MangaDexCoverPreview));
        assert_eq!(manga_id, COLLECTION_ID);
        assert_eq!(parsed_file_name.as_deref(), Some(file_name));
    }

    #[test]
    fn parses_igdb_image_preview_routes() {
        let (variant, image_id) = parse_media_path("/igdb-image-preview/cover/co1abc").unwrap();
        assert!(matches!(variant, MediaVariant::IgdbImagePreviewCover));
        assert_eq!(image_id.as_deref(), Some("co1abc"));
        assert!(parse_media_path("/igdb-image-preview/hero/..%2Fsecret").is_err());
    }

    #[test]
    fn parses_tmdb_image_preview_routes() {
        let (variant, path) =
            parse_media_path("/tmdb-image-preview/poster/%2Fabcd1234.jpg").unwrap();
        assert!(matches!(variant, MediaVariant::TmdbImagePreviewPoster));
        assert_eq!(path.as_deref(), Some("/abcd1234.jpg"));
        let (variant, path) =
            parse_media_path("/tmdb-image-preview/backdrop/%2Fabcd1234.webp").unwrap();
        assert!(matches!(variant, MediaVariant::TmdbImagePreviewBackdrop));
        assert_eq!(path.as_deref(), Some("/abcd1234.webp"));
        assert!(parse_media_path("/tmdb-image-preview/backdrop/..%2Fsecret.jpg").is_err());
    }

    fn cache_control(response: &Response<Vec<u8>>) -> Option<&str> {
        response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
    }

    const IMMUTABLE: &str = "private, max-age=31536000, immutable";

    #[test]
    fn only_a_current_thumbnail_revision_is_served_as_immutable() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "assets/image.png",
            "thumbnails/aa/old.webp",
        );
        std::fs::create_dir_all(library.root().join("thumbnails/aa")).unwrap();
        std::fs::write(
            library.root().join("thumbnails/aa/old.webp"),
            b"old thumbnail",
        )
        .unwrap();
        let old_revision = thumbnail_revision("thumbnails/aa/old.webp");
        let get = |path: String| media_response(Some(&library), &Method::GET, &path);

        let current = get(format!("/thumbnail/{ASSET_ID}/v{old_revision}"));
        assert_eq!(current.status(), StatusCode::OK);
        assert_eq!(current.body(), b"old thumbnail");
        assert_eq!(cache_control(&current), Some(IMMUTABLE));
        // Unrevisioned and foreign-revision URLs keep the regenerate-in-place policy.
        assert_eq!(
            cache_control(&get(format!("/thumbnail/{ASSET_ID}"))),
            Some("no-store")
        );
        assert_eq!(
            cache_control(&get(format!("/thumbnail/{ASSET_ID}/v7"))),
            Some("no-store")
        );

        // A regenerated thumbnail is a new file: the old URL no longer freezes anything and
        // the new revision names the new bytes.
        std::fs::write(
            library.root().join("thumbnails/aa/new.webp"),
            b"new thumbnail",
        )
        .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET thumbnail_relative_path = 'thumbnails/aa/new.webp' WHERE id = ?1",
                [ASSET_ID],
            )
            .unwrap();
        let stale = get(format!("/thumbnail/{ASSET_ID}/v{old_revision}"));
        assert_eq!(stale.body(), b"new thumbnail");
        assert_eq!(cache_control(&stale), Some("no-store"));
        let new_revision = thumbnail_revision("thumbnails/aa/new.webp");
        assert_ne!(new_revision, old_revision);
        let fresh = get(format!("/thumbnail/{ASSET_ID}/v{new_revision}"));
        assert_eq!(fresh.body(), b"new thumbnail");
        assert_eq!(cache_control(&fresh), Some(IMMUTABLE));
    }

    #[test]
    fn revisioned_thumbnails_of_trash_or_empty_files_are_never_cached() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        std::fs::create_dir_all(library.root().join("thumbnails")).unwrap();
        insert_asset_with_status(
            &library,
            TRASH_ID,
            "assets/t.png",
            "thumbnails/t.webp",
            "trash",
        );
        std::fs::write(library.root().join("thumbnails/t.webp"), b"trashed").unwrap();
        insert_asset(&library, ASSET_ID, "assets/e.png", "thumbnails/e.webp");
        std::fs::write(library.root().join("thumbnails/e.webp"), b"").unwrap();

        let trashed = media_response(
            Some(&library),
            &Method::GET,
            &format!(
                "/thumbnail/{TRASH_ID}/v{}",
                thumbnail_revision("thumbnails/t.webp")
            ),
        );
        assert_eq!(trashed.status(), StatusCode::NOT_FOUND);
        assert_eq!(cache_control(&trashed), None);
        let empty = media_response(
            Some(&library),
            &Method::GET,
            &format!(
                "/thumbnail/{ASSET_ID}/v{}",
                thumbnail_revision("thumbnails/e.webp")
            ),
        );
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(cache_control(&empty), Some("no-store"));
    }

    #[test]
    fn scrub_frames_are_immutable_only_under_the_current_revision() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");
        let revision = thumbnail_revision(&format!("video-media/{ASSET_ID}/poster.webp"));
        let get = |path: String| media_response(Some(&library), &Method::GET, &path);

        let frame = get(format!("/scrub-frame/{ASSET_ID}/0/v{revision}"));
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(frame.body(), b"scrub-frame");
        assert_eq!(cache_control(&frame), Some(IMMUTABLE));
        assert_eq!(
            cache_control(&get(format!("/scrub-frame/{ASSET_ID}/0/v1"))),
            Some("no-store")
        );
        assert_eq!(
            cache_control(&get(format!("/scrub-frame/{ASSET_ID}/0"))),
            None
        );
        let poster = get(format!("/thumbnail/{ASSET_ID}/v{revision}"));
        assert_eq!(poster.body(), b"poster");
        assert_eq!(cache_control(&poster), Some(IMMUTABLE));
        for path in [
            format!("/scrub-frame/{ASSET_ID}/0/7"),
            format!("/scrub-frame/{ASSET_ID}/0/v"),
            format!("/scrub-frame/{ASSET_ID}/0/v1/more"),
        ] {
            assert_eq!(
                get(path.clone()).status(),
                StatusCode::BAD_REQUEST,
                "{path}"
            );
        }
    }

    #[test]
    fn originals_and_other_library_media_keep_their_cache_policy() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "assets/image.png",
            "thumbnails/image.webp",
        );
        std::fs::write(library.root().join("assets/image.png"), b"asset bytes").unwrap();
        let original = media_response(Some(&library), &Method::GET, &format!("/asset/{ASSET_ID}"));
        assert_eq!(original.status(), StatusCode::OK);
        assert_eq!(cache_control(&original), None);
    }

    fn preview_library(width: u32, height: u32) -> (tempfile::TempDir, Library, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/image.jpg", "thumbnails/image.webp");
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x * 255 / width) as u8, (y * 255 / height) as u8, ((x ^ y) & 0xff) as u8])
        });
        let mut original = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut original), ImageFormat::Jpeg)
            .unwrap();
        std::fs::write(library.root().join("assets/image.jpg"), &original).unwrap();
        (temp, library, original)
    }

    fn dimensions(bytes: &[u8]) -> (u32, u32) {
        image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap()
    }

    #[test]
    fn preview_route_serves_a_downscaled_copy_within_the_requested_edge() {
        let (_temp, library, original) = preview_library(3000, 2000);
        let default = media_response(Some(&library), &Method::GET, &format!("/preview/{ASSET_ID}"));
        assert_eq!(default.status(), StatusCode::OK);
        assert_eq!(default.headers()[CONTENT_TYPE], "image/jpeg");
        assert_eq!(dimensions(default.body()), (1600, 1067));
        assert!(default.body().len() < original.len());
        assert_eq!(cache_control(&default), Some("private, max-age=60"));
        let wide = media_response(Some(&library), &Method::GET, &format!("/preview/{ASSET_ID}/1280"));
        assert_eq!(dimensions(wide.body()), (1280, 853));
        // The requested edge is clamped to 640..2560.
        let tiny = media_response(Some(&library), &Method::GET, &format!("/preview/{ASSET_ID}/10"));
        assert_eq!(dimensions(tiny.body()), (640, 427));
        // The original route is untouched, and nothing was written next to the library file.
        let asset = media_response(Some(&library), &Method::GET, &format!("/asset/{ASSET_ID}"));
        assert_eq!(asset.body(), &original);
        assert_eq!(std::fs::read_dir(library.root().join("assets")).unwrap().count(), 1);
    }

    #[test]
    fn preview_route_serves_small_originals_unchanged_and_follows_the_asset_rules() {
        let (_temp, library, original) = preview_library(1200, 800);
        let small = media_response(Some(&library), &Method::GET, &format!("/preview/{ASSET_ID}"));
        assert_eq!(small.status(), StatusCode::OK);
        assert_eq!(small.body(), &original);
        assert_eq!(cache_control(&small), None);

        insert_asset_with_status(&library, TRASH_ID, "assets/trash.jpg", "thumbnails/t.webp", "trash");
        for (path, status) in [
            (format!("/preview/{TRASH_ID}"), StatusCode::NOT_FOUND),
            (format!("/preview/{MISSING_ID}"), StatusCode::NOT_FOUND),
            ("/preview/not-a-uuid".to_string(), StatusCode::BAD_REQUEST),
            (format!("/preview/{ASSET_ID}/wide"), StatusCode::BAD_REQUEST),
        ] {
            assert_eq!(media_response(Some(&library), &Method::GET, &path).status(), status, "{path}");
        }
        assert_eq!(
            media_response(None, &Method::GET, &format!("/preview/{ASSET_ID}")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            media_response(Some(&library), &Method::POST, &format!("/preview/{ASSET_ID}")).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[test]
    fn preview_route_decodes_once_then_answers_from_the_lru_until_the_file_changes() {
        let (_temp, library, _) = preview_library(3000, 2000);
        let cache = std::sync::Mutex::new(super::preview::Lru::new(24, 64 * 1024 * 1024));
        let builds = || super::preview::BUILDS.with(|count| count.get());
        let first = super::preview::serve(&cache, &library, ASSET_ID, 1600);
        assert_eq!(builds(), 1);
        let second = super::preview::serve(&cache, &library, ASSET_ID, 1600);
        assert_eq!(builds(), 1, "a repeat is a cache hit");
        assert_eq!(first.body(), second.body());
        super::preview::serve(&cache, &library, ASSET_ID, 1280);
        assert_eq!(builds(), 2, "another edge is another entry");

        // New bytes under the same id and path never see the old preview.
        let image = image::RgbImage::from_pixel(2400, 1800, image::Rgb([200, 10, 10]));
        let mut changed = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut changed), ImageFormat::Jpeg)
            .unwrap();
        std::fs::write(library.root().join("assets/image.jpg"), &changed).unwrap();
        let third = super::preview::serve(&cache, &library, ASSET_ID, 1600);
        assert_eq!(builds(), 3);
        assert_eq!(dimensions(third.body()), (1600, 1200));
    }

    #[test]
    fn protocol_serves_only_id_resolved_asset_and_thumbnail_bytes_with_mime() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "assets/image.png",
            "thumbnails/image.webp",
        );
        std::fs::write(library.root().join("assets/image.png"), b"asset bytes").unwrap();
        std::fs::write(
            library.root().join("thumbnails/image.webp"),
            b"thumbnail bytes",
        )
        .unwrap();

        let asset = media_response(Some(&library), &Method::GET, &format!("/asset/{ASSET_ID}"));
        let thumbnail = media_response(
            Some(&library),
            &Method::GET,
            &format!("/thumbnail/{ASSET_ID}"),
        );

        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(asset.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(asset.body(), b"asset bytes");
        assert_eq!(thumbnail.status(), StatusCode::OK);
        assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(thumbnail.body(), b"thumbnail bytes");
    }

    #[test]
    fn protocol_rejects_non_get_and_every_path_other_than_variant_uuid() {
        let invalid_requests = [
            (
                Method::POST,
                format!("/asset/{ASSET_ID}"),
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                Method::GET,
                "/thumbnail/../secret".into(),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::GET,
                format!("/thumbnail/{ASSET_ID}/more"),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::GET,
                format!("/assets/{ASSET_ID}"),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::GET,
                "/asset/not-a-uuid".into(),
                StatusCode::BAD_REQUEST,
            ),
        ];

        for (method, path, expected) in invalid_requests {
            assert_eq!(media_response(None, &method, &path).status(), expected);
        }
    }

    #[test]
    fn protocol_returns_not_found_for_an_unknown_asset_id() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let response = media_response(
            Some(&library),
            &Method::GET,
            &format!("/asset/{MISSING_ID}"),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn trash_thumbnail_route_only_exposes_trashed_thumbnails() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        for (id, status) in [(ASSET_ID, "normal"), (REVIEW_ID, "review"), (TRASH_ID, "trash")] {
            let thumbnail = format!("thumbnails/{id}.webp");
            insert_asset_with_status(&library, id, &format!("assets/{id}.png"), &thumbnail, status);
            std::fs::write(library.root().join(thumbnail), b"thumbnail bytes").unwrap();
            let response = media_response(Some(&library), &Method::GET, &format!("/trash-thumbnail/{id}"));
            assert_eq!(response.status(), if status == "trash" { StatusCode::OK } else { StatusCode::NOT_FOUND });
            if status == "trash" { assert_eq!(response.body(), b"thumbnail bytes"); }
        }
    }

    #[test]
    fn review_media_is_available_without_exposing_trash() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        for (id, status) in [(REVIEW_ID, "review"), (TRASH_ID, "trash")] {
            let asset_path = format!("assets/{id}.png");
            let thumbnail_path = format!("thumbnails/{id}.webp");
            insert_asset_with_status(&library, id, &asset_path, &thumbnail_path, status);
            std::fs::write(library.root().join(asset_path), b"asset bytes").unwrap();
            std::fs::write(library.root().join(thumbnail_path), b"thumbnail bytes").unwrap();
        }

        for variant in ["asset", "thumbnail"] {
            assert_eq!(
                media_response(
                    Some(&library),
                    &Method::GET,
                    &format!("/{variant}/{REVIEW_ID}"),
                )
                .status(),
                StatusCode::OK
            );
            assert_eq!(
                media_response(
                    Some(&library),
                    &Method::GET,
                    &format!("/{variant}/{TRASH_ID}"),
                )
                .status(),
                StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn resolve_media_rejects_a_canonical_path_outside_the_library_root() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        std::fs::write(temp.path().join("outside.png"), b"outside bytes").unwrap();
        insert_asset(
            &library,
            ASSET_ID,
            "../outside.png",
            "thumbnails/missing.webp",
        );

        let error = library
            .resolve_media(ASSET_ID, MediaVariant::Asset)
            .unwrap_err();

        assert!(matches!(error, LibraryError::UnsafeMediaPath));
    }

    #[test]
    fn playback_serves_bounded_open_ended_and_suffix_ranges() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");

        for (range, expected_range, expected_body) in [
            ("bytes=10-19", "bytes 10-19/36", b"abcdefghij".as_slice()),
            ("bytes=30-", "bytes 30-35/36", b"uvwxyz".as_slice()),
            ("bytes=-10", "bytes 26-35/36", b"qrstuvwxyz".as_slice()),
        ] {
            let response = media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/playback/{ASSET_ID}"),
                Some(range),
            );
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[CONTENT_RANGE], expected_range);
            assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
            assert_eq!(
                response.headers()[CONTENT_LENGTH],
                expected_body.len().to_string()
            );
            assert_eq!(response.body(), expected_body);
        }
    }

    #[test]
    fn open_playback_range_is_bounded_by_the_chunk_limit() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");
        // 픽스처 36바이트는 8MiB 상한보다 작다: 열린 range도 잘리지 않고
        // 전체 구간이 정확히 서빙된다(기존 동작 불변).
        let response = media_response_with_range(
            Some(&library),
            &Method::GET,
            &format!("/playback/{ASSET_ID}"),
            Some("bytes=0-1048575"),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers().get(CONTENT_LENGTH).unwrap(), "36");
        assert_eq!(response.headers().get(CONTENT_RANGE).unwrap(), "bytes 0-35/36");
    }
    #[test]
    fn playback_rejects_unranged_unsatisfiable_and_multi_range_requests() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");

        for range in [None, Some("bytes=99-120"), Some("bytes=0-1,4-5")] {
            let response = media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/playback/{ASSET_ID}"),
                range,
            );
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(response.headers()[CONTENT_RANGE], "bytes */36");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn scrub_frame_is_complete_but_missing_and_trashed_video_media_are_hidden() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_prepared_video(&library, ASSET_ID, "normal");
        insert_prepared_video(&library, TRASH_ID, "trash");

        let frame = media_response_with_range(
            Some(&library),
            &Method::GET,
            &format!("/scrub-frame/{ASSET_ID}/0"),
            None,
        );
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(frame.headers()[CONTENT_TYPE], "image/webp");
        assert_eq!(frame.body(), b"scrub-frame");
        assert_eq!(
            media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/scrub-frame/{ASSET_ID}/1"),
                None,
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            media_response_with_range(
                Some(&library),
                &Method::GET,
                &format!("/playback/{TRASH_ID}"),
                Some("bytes=0-1"),
            )
            .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn manga_page_route_rejects_out_of_range_page() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let manga_root = temp.path().join("manga");
        std::fs::create_dir_all(manga_root.join("series-a")).unwrap();
        write_test_png(&manga_root.join("series-a/1.png"));
        write_test_png(&manga_root.join("series-a/2.png"));
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();
        library.scan_manga().unwrap();
        let series = library.list_manga_series().unwrap();
        assert_eq!(series.len(), 1);
        let series_id = &series[0].id;

        let cover = media_response(
            Some(&library),
            &Method::GET,
            &format!("/manga-cover/{series_id}"),
        );
        assert_eq!(cover.status(), StatusCode::OK);
        assert_eq!(cover.headers()[CONTENT_TYPE], "image/webp");

        for page in [1, 2] {
            let response = media_response(
                Some(&library),
                &Method::GET,
                &format!("/manga-page/{series_id}/{page}"),
            );
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        }

        for page in [0, 3, 999] {
            let response = media_response(
                Some(&library),
                &Method::GET,
                &format!("/manga-page/{series_id}/{page}"),
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn manga_routes_reject_unsafe_paths_and_malformed_requests() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let manga_root = temp.path().join("manga");
        std::fs::create_dir_all(manga_root.join("series-a")).unwrap();
        write_test_png(&manga_root.join("series-a/1.png"));
        library
            .set_manga_root(Some(manga_root.to_string_lossy().as_ref()))
            .unwrap();
        library.scan_manga().unwrap();
        let series_id = library.list_manga_series().unwrap()[0].id.clone();

        let cases = [
            (
                format!("/manga-page/{series_id}/not-a-number"),
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("/manga-page/{series_id}/1/extra"),
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("/manga-cover/{series_id}/extra"),
                StatusCode::BAD_REQUEST,
            ),
            (format!("/manga-cover/{MISSING_ID}"), StatusCode::NOT_FOUND),
            (format!("/manga-page/{MISSING_ID}/1"), StatusCode::NOT_FOUND),
        ];
        for (path, expected) in cases {
            assert_eq!(
                media_response(Some(&library), &Method::GET, &path).status(),
                expected
            );
        }
    }

    #[test]
    fn manga_routes_are_hidden_when_no_library_is_open() {
        let response = media_response(None, &Method::GET, &format!("/manga-cover/{SERIES_ID}"));
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    fn thumbnail(library: &Library, id: &str) -> Response<Vec<u8>> {
        media_response(Some(library), &Method::GET, &format!("/thumbnail/{id}"))
    }

    fn set_thumbnail(library: &Library, id: &str, relative_path: &str, bytes: &[u8]) {
        let path = library.root().join(relative_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET thumbnail_relative_path = ?2 WHERE id = ?1",
                params![id, relative_path],
            )
            .unwrap();
    }

    #[test]
    fn thumbnail_lookups_read_the_current_row_on_every_request() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/a.png", "thumbnails/aa/old.webp");
        set_thumbnail(&library, ASSET_ID, "thumbnails/aa/old.webp", b"old");
        assert_eq!(thumbnail(&library, ASSET_ID).body(), b"old");

        // A replaced thumbnail is served from the next request on.
        set_thumbnail(&library, ASSET_ID, "thumbnails/aa/new.webp", b"new");
        assert_eq!(thumbnail(&library, ASSET_ID).body(), b"new");

        // Trash hides it at once; restore brings it back.
        library.trash_assets(&[ASSET_ID.to_owned()]).unwrap();
        assert_eq!(
            thumbnail(&library, ASSET_ID).status(),
            StatusCode::NOT_FOUND
        );
        library.restore_assets(&[ASSET_ID.to_owned()]).unwrap();
        let restored = thumbnail(&library, ASSET_ID);
        assert_eq!(restored.status(), StatusCode::OK);
        assert_eq!(restored.body(), b"new");

        // Review keeps it, any other status hides it, and a deleted row is gone.
        for (status, expected) in [
            ("review", StatusCode::OK),
            ("trash", StatusCode::NOT_FOUND),
            ("normal", StatusCode::OK),
        ] {
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE assets SET status = ?2 WHERE id = ?1",
                    params![ASSET_ID, status],
                )
                .unwrap();
            assert_eq!(thumbnail(&library, ASSET_ID).status(), expected, "{status}");
        }
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM assets WHERE id = ?1", [ASSET_ID])
            .unwrap();
        assert_eq!(
            thumbnail(&library, ASSET_ID).status(),
            StatusCode::NOT_FOUND
        );
        // The reads reuse a bounded set of connections instead of opening one each.
        assert_eq!(library.media_reads_idle(), 1);
    }

    #[test]
    fn an_asset_without_a_thumbnail_answers_not_found_until_one_is_installed() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/v.webm", "thumbnails/v.webp");
        // Like every video in the real library: a video Asset with no poster yet.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET media_kind = 'video', thumbnail_relative_path = NULL
                 WHERE id = ?1",
                [ASSET_ID],
            )
            .unwrap();
        for _ in 0..3 {
            let response = thumbnail(&library, ASSET_ID);
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(response.body().is_empty());
            assert_eq!(cache_control(&response), None);
        }

        set_thumbnail(&library, ASSET_ID, "thumbnails/v.webp", b"poster");
        let installed = thumbnail(&library, ASSET_ID);
        assert_eq!(installed.status(), StatusCode::OK);
        assert_eq!(installed.body(), b"poster");
    }

    #[test]
    fn thumbnail_lookups_never_cross_libraries() {
        let temp = tempfile::tempdir().unwrap();
        let first = Library::open(temp.path().join("first")).unwrap();
        let second = Library::open(temp.path().join("second")).unwrap();
        insert_asset(&first, ASSET_ID, "assets/a.png", "thumbnails/a.webp");
        set_thumbnail(&first, ASSET_ID, "thumbnails/a.webp", b"first");
        assert_eq!(thumbnail(&first, ASSET_ID).body(), b"first");
        assert_eq!(thumbnail(&second, ASSET_ID).status(), StatusCode::NOT_FOUND);

        insert_asset(&second, ASSET_ID, "assets/a.png", "thumbnails/a.webp");
        set_thumbnail(&second, ASSET_ID, "thumbnails/a.webp", b"second");
        drop(first);
        assert_eq!(thumbnail(&second, ASSET_ID).body(), b"second");
    }

    #[test]
    fn thumbnail_lookups_do_not_wait_for_the_database_lock_or_see_uncommitted_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        insert_asset(&library, ASSET_ID, "assets/a.png", "thumbnails/old.webp");
        set_thumbnail(&library, ASSET_ID, "thumbnails/old.webp", b"old");
        std::fs::write(library.root().join("thumbnails/new.webp"), b"new").unwrap();

        // Hold the database lock inside an open write transaction that replaces the thumbnail.
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "UPDATE assets SET thumbnail_relative_path = 'thumbnails/new.webp' WHERE id = ?1",
                [ASSET_ID],
            )
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let sender = sender.clone();
                let library = &library;
                scope.spawn(move || sender.send(thumbnail(library, ASSET_ID)).unwrap());
            }
            for _ in 0..4 {
                let response = receiver
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .expect("a thumbnail lookup waited for the database lock");
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.body(), b"old");
            }
        });
        transaction.commit().unwrap();
        drop(connection);
        assert_eq!(thumbnail(&library, ASSET_ID).body(), b"new");
    }

    fn write_test_png(path: &std::path::Path) {
        let image = image::RgbImage::from_pixel(8, 6, image::Rgb([10, 20, 30]));
        image
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    fn insert_asset(
        library: &Library,
        id: &str,
        relative_path: &str,
        thumbnail_relative_path: &str,
    ) {
        insert_asset_with_status(
            library,
            id,
            relative_path,
            thumbnail_relative_path,
            "normal",
        );
    }

    fn insert_asset_with_status(
        library: &Library,
        id: &str,
        relative_path: &str,
        thumbnail_relative_path: &str,
        status: &str,
    ) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, status
                 ) VALUES (?1, ?2, 'image', 'image.png', ?3, ?4, 11, 4, 3, ?5, ?6)",
                params![
                    id,
                    format!("hash-{id}"),
                    relative_path,
                    thumbnail_relative_path,
                    "2026-07-30T00:00:00Z",
                    status,
                ],
            )
            .unwrap();
    }

    fn insert_prepared_video(library: &Library, id: &str, status: &str) {
        let original = format!("assets/{id}.webm");
        let poster = format!("video-media/{id}/poster.webp");
        let scrub = format!("video-media/{id}/scrub");
        std::fs::create_dir_all(library.root().join(&scrub)).unwrap();
        std::fs::write(
            library.root().join(&original),
            b"0123456789abcdefghijklmnopqrstuvwxyz",
        )
        .unwrap();
        std::fs::write(library.root().join(&poster), b"poster").unwrap();
        std::fs::write(library.root().join(&scrub).join("000.webp"), b"scrub-frame").unwrap();
        let trashed_at = (status == "trash").then_some("2026-08-09T00:00:00Z");
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    status, trashed_at
                 ) VALUES (?1, ?2, 'video', 'clip.webm', ?3, ?4, 36, 1280, 720,
                    '2026-08-09T00:00:00Z', ?5, ?6)",
                params![
                    id,
                    format!("hash-{id}"),
                    original,
                    poster,
                    status,
                    trashed_at
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
                params![id, poster, scrub],
            )
            .unwrap();
    }
