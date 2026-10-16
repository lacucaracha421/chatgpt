    use std::{fs, path::PathBuf, time::Instant};

    use image::{
        codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageBuffer, Rgb, RgbImage,
    };
    use rusqlite::params;
    use tempfile::TempDir;

    use super::super::image_fingerprint::{fingerprint, minimum_distance, ImageFingerprint};
    use super::super::{
        error::LibraryError,
        models::{
            AssetCollectionPatch, AssetCursor, ClassificationKind, CollectionType,
            CreateClassification, CreateCollection, ImportSource, IngestMediaRequest,
            IngestOutcome, SimilarityDecision, SimilarityDecisionRequest,
        },
        Library,
    };
    use super::{perceptual_hash_from_file, set_after_review_resolving_hook};

    #[derive(Clone, Copy)]
    enum StripeDirection {
        Vertical,
        Horizontal,
    }

    struct TestLibrary {
        _temp: TempDir,
        library: Library,
    }

    struct ReviewFixture {
        _temp: TempDir,
        library: Library,
        input: PathBuf,
        existing_id: String,
        candidate_id: String,
        review_id: String,
        old_tag: String,
        candidate_asset_path: PathBuf,
        candidate_thumbnail_path: PathBuf,
    }

    #[test]
    fn similarity_ingest_auto_keeps_the_artist_and_retains_both_files_in_library_trash() {
        use image::{
            codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder},
            ImageEncoder,
        };
        for first_reposts in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path().join("library")).unwrap();
            let base = striped_fixture(900, 600, StripeDirection::Vertical);
            let original = temp.path().join("first.png");
            let second = temp.path().join("second.png");
            base.save(&original).unwrap();
            let rgb = base.to_rgb8();
            PngEncoder::new_with_quality(
                fs::File::create(&second).unwrap(),
                CompressionType::Best,
                PngFilter::NoFilter,
            )
            .write_image(rgb.as_raw(), 900, 600, image::ExtendedColorType::Rgb8)
            .unwrap();
            {
                let c = library.connection().unwrap();
                for (handle, reposter) in [("author", false), ("repost", true)] {
                    c.execute("INSERT INTO artists(id,reposter,created_at,updated_at) VALUES(?1,?2,'now','now')",params![handle,reposter]).unwrap();
                    c.execute("INSERT INTO artist_members(creator_key,artist_id,added_at) VALUES(?1,?1,'now')",[handle]).unwrap();
                }
            }
            let request = |path, handle: &str| IngestMediaRequest {
                source_path: path,
                classification_id: None,
                source_url: Some(format!("https://x.com/{handle}/status/1")),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: Some(handle.into()),
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
            };
            let first = library
                .ingest_media(request(
                    original,
                    if first_reposts { "repost" } else { "author" },
                ))
                .unwrap();
            let IngestOutcome::Added { asset: first } = first else {
                panic!("first must be added")
            };
            let outcome = library
                .ingest_media(request(
                    second,
                    if first_reposts { "author" } else { "repost" },
                ))
                .unwrap();
            let IngestOutcome::Added { asset: kept } = outcome else {
                panic!("automatic resolution must not prompt")
            };
            assert_eq!(kept.creator_handle.as_deref(), Some("author"));
            assert_eq!(kept.id == first.id, !first_reposts);
            assert_eq!(
                library
                    .list_similarity_reviews(None, 10)
                    .unwrap()
                    .total_count,
                0
            );
            let c = library.connection().unwrap();
            let rows = c
                .prepare("SELECT relative_path,status FROM assets")
                .unwrap()
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(rows.len(), 2);
            assert_eq!(
                rows.iter().filter(|(_, status)| status == "trash").count(),
                1
            );
            for (path, _) in rows {
                assert!(library.root().join(path).exists());
            }
        }
    }

    #[test]
    fn resized_and_reencoded_image_is_nearer_than_an_unrelated_image() {
        let base = striped_fixture(900, 600, StripeDirection::Vertical);
        let resized_jpeg = jpeg_variant(&base, 450, 300, 70);
        let unrelated = striped_fixture(900, 600, StripeDirection::Horizontal);

        let base_hash = fingerprint(&base).unwrap();
        let resized_hash = fingerprint(&resized_jpeg).unwrap();
        let unrelated_hash = fingerprint(&unrelated).unwrap();

        let resized_distance = minimum_distance(&base_hash, &resized_hash);
        let unrelated_distance = minimum_distance(&base_hash, &unrelated_hash);
        assert!(
            base_hash.quality >= 50 && resized_hash.quality >= 50,
            "quality={}/{}",
            base_hash.quality,
            resized_hash.quality
        );
        assert!(
            resized_distance <= 20,
            "resized distance={resized_distance}, quality={}/{}",
            base_hash.quality,
            resized_hash.quality
        );
        assert!(
            unrelated_distance > 20,
            "unrelated distance={unrelated_distance}"
        );
    }

    #[test]
    fn exif_orientation_is_applied_before_pdq_and_dimensions() {
        let displayed = striped_fixture(640, 480, StripeDirection::Vertical);
        let raw_rotated = displayed.rotate270();
        let plain_path = tempfile::NamedTempFile::new().unwrap();
        let oriented_path = tempfile::NamedTempFile::new().unwrap();
        fs::write(plain_path.path(), jpeg_bytes(&displayed, 95)).unwrap();
        fs::write(
            oriented_path.path(),
            jpeg_with_exif_orientation(jpeg_bytes(&raw_rotated, 95), 6),
        )
        .unwrap();

        let plain = perceptual_hash_from_file(fs::File::open(plain_path.path()).unwrap()).unwrap();
        let oriented =
            perceptual_hash_from_file(fs::File::open(oriented_path.path()).unwrap()).unwrap();
        assert_eq!((plain.width, plain.height), (640, 480));
        assert_eq!((oriented.width, oriented.height), (640, 480));
        assert!(minimum_distance(&plain.fingerprint, &oriented.fingerprint) <= 20);
    }

    #[test]
    fn light_crop_and_corner_watermark_stay_within_pdq_threshold() {
        let base = striped_fixture(900, 600, StripeDirection::Vertical);
        let cropped = base.crop_imm(45, 30, 810, 540);
        let mut watermarked = base.to_rgb8();
        for y in 575..595 {
            for x in 760..880 {
                watermarked.put_pixel(x, y, Rgb([245, 245, 245]));
            }
        }
        let watermarked = DynamicImage::ImageRgb8(watermarked);
        let base = fingerprint(&base).unwrap();
        let cropped = fingerprint(&cropped).unwrap();
        let watermarked = fingerprint(&watermarked).unwrap();

        assert!(base.quality >= 50 && cropped.quality >= 50 && watermarked.quality >= 50);
        let crop_distance = minimum_distance(&base, &cropped);
        let watermark_distance = minimum_distance(&base, &watermarked);
        assert!(
            crop_distance <= 20 && watermark_distance <= 20,
            "crop distance={crop_distance}, watermark distance={watermark_distance}"
        );
    }

    #[test]
    fn pdq_rejects_images_that_collide_under_dhash() {
        let first = horizontal_band_fixture(900, 600, 2);
        let second = horizontal_band_fixture(900, 600, 10);
        let first_dhash = test_dhash(&first);
        let second_dhash = test_dhash(&second);
        let first_pdq = fingerprint(&first).unwrap();
        let second_pdq = fingerprint(&second).unwrap();

        assert_eq!(first_dhash, second_dhash);
        assert!(first_pdq.quality >= 50 && second_pdq.quality >= 50);
        assert!(minimum_distance(&first_pdq, &second_pdq) > 20);
    }

    #[test]
    fn candidate_search_uses_distance_then_collected_at_then_id() {
        let mut one_bit = [0_u8; 32];
        one_bit[0] = 0b0000_0001;
        let mut another_bit = [0_u8; 32];
        another_bit[0] = 0b0000_0010;
        let mut third_bit = [0_u8; 32];
        third_bit[0] = 0b0000_0100;
        let fixture = library_with_hashes(&[
            ("later", one_bit, "2026-08-09T01:00:00Z"),
            ("earlier-b", another_bit, "2026-08-09T00:00:00Z"),
            ("earlier-a", third_bit, "2026-08-09T00:00:00Z"),
        ]);
        let target = ImageFingerprint {
            bytes: [0; 32],
            cropped_bytes: [0; 32],
            quality: 100,
        };

        assert_eq!(
            fixture
                .library
                .find_similar_asset(&target, (100, 100))
                .unwrap()
                .unwrap()
                .asset_id,
            "earlier-a"
        );
    }

    #[test]
    fn candidate_search_rejects_a_hash_blob_with_the_wrong_length() {
        let fixture = library_with_hashes(&[]);
        insert_asset(
            &fixture.library,
            "broken",
            "2026-08-09T00:00:00Z",
            Some(&[0; 7]),
        );
        let target = ImageFingerprint {
            bytes: [0; 32],
            cropped_bytes: [0; 32],
            quality: 100,
        };

        let error = fixture
            .library
            .find_similar_asset(&target, (100, 100))
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidPerceptualHash));
    }

    #[test]
    fn pdq_candidate_applies_quality_distance_and_aspect_gates() {
        let fixture = library_with_hashes(&[]);
        let target = ImageFingerprint {
            bytes: [0; 32],
            cropped_bytes: [0; 32],
            quality: 100,
        };
        let mut distance_twenty = [0_u8; 32];
        distance_twenty[0] = u8::MAX;
        distance_twenty[1] = u8::MAX;
        distance_twenty[2] = 0b0000_1111;
        let mut distance_twenty_one = distance_twenty;
        distance_twenty_one[3] = 1;
        insert_policy_asset(
            &fixture.library,
            "distance-20",
            &distance_twenty,
            100,
            100,
            100,
            "image",
        );
        insert_policy_asset(
            &fixture.library,
            "distance-21",
            &distance_twenty_one,
            100,
            100,
            100,
            "image",
        );
        insert_policy_asset(
            &fixture.library,
            "low-quality",
            &[0; 32],
            49,
            100,
            100,
            "image",
        );
        insert_policy_asset(
            &fixture.library,
            "wrong-aspect",
            &[0; 32],
            100,
            200,
            100,
            "image",
        );
        insert_policy_asset(&fixture.library, "video", &[0; 32], 100, 100, 100, "video");

        let candidate = fixture
            .library
            .find_similar_asset(&target, (100, 100))
            .unwrap()
            .unwrap();

        assert_eq!(candidate.asset_id, "distance-20");
        assert_eq!(candidate.distance, 20);
        let low_quality_target = ImageFingerprint {
            bytes: [0; 32],
            cropped_bytes: [0; 32],
            quality: 49,
        };
        assert!(fixture
            .library
            .find_similar_asset(&low_quality_target, (100, 100))
            .unwrap()
            .is_none());
    }

    #[test]
    fn similarity_profiles_produce_identical_hashes_and_keep_the_fifty_asset_batch() {
        let mut snapshots = Vec::new();
        for profile in [
            crate::performance::Profile::Laptop,
            crate::performance::Profile::Main,
        ] {
            let fixture = library_with_unindexed_assets(51);
            let first = fixture
                .library
                .index_missing_similarity_hashes_with_budget(profile.budgets())
                .unwrap();
            assert_eq!((first.remaining, first.failed), (1, 1));
            let second = fixture
                .library
                .index_missing_similarity_hashes_with_budget(profile.budgets())
                .unwrap();
            assert_eq!((second.remaining, second.failed), (0, 1));
            let connection = fixture.library.connection().unwrap();
            let mut query = connection
                .prepare(
                    "SELECT id, perceptual_hash, perceptual_hash_error FROM assets ORDER BY id",
                )
                .unwrap();
            let rows = query
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<Vec<u8>>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            snapshots.push(rows);
        }
        assert_eq!(snapshots[0], snapshots[1]);
    }

    #[test]
    fn indexing_attempts_fifty_assets_and_records_media_failures_once() {
        let fixture = library_with_unindexed_assets(51);

        let first = fixture.library.index_missing_similarity_hashes().unwrap();
        let second = fixture.library.index_missing_similarity_hashes().unwrap();

        assert_eq!((first.remaining, first.failed), (1, 1));
        assert_eq!((second.remaining, second.failed), (0, 1));
        let error: String = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT perceptual_hash_error FROM assets WHERE id = 'asset-000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(error, "media_not_found");
    }

    #[test]
    fn overlapping_index_requests_finish_distinct_batches_and_preserve_results() {
        let fixture = library_with_unindexed_assets(51);
        fixture.library.connection().unwrap().execute_batch(
            "CREATE TABLE hash_updates(asset_id TEXT); CREATE TRIGGER record_hash_update AFTER UPDATE OF perceptual_hash,perceptual_hash_error ON assets BEGIN INSERT INTO hash_updates VALUES(NEW.id); END;"
        ).unwrap();
        let expected = perceptual_hash_from_file(
            fs::File::open(fixture.library.root().join("assets/asset-001.png")).unwrap(),
        )
        .unwrap();
        let outcomes = std::thread::scope(|scope| {
            let library = &fixture.library;
            let first = scope.spawn(|| library.index_missing_similarity_hashes().unwrap());
            let second = scope.spawn(|| library.index_missing_similarity_hashes().unwrap());
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(
            outcomes
                .iter()
                .map(|outcome| outcome.remaining)
                .sum::<u64>(),
            1
        );
        let connection = fixture.library.connection().unwrap();
        let updates: i64 = connection
            .query_row("SELECT COUNT(*) FROM hash_updates", [], |row| row.get(0))
            .unwrap();
        assert_eq!(updates, 51);
        let (bytes, quality, width, height): (Vec<u8>, u8, u32, u32) = connection.query_row(
            "SELECT perceptual_hash,perceptual_hash_quality,width,height FROM assets WHERE id='asset-001'", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
        ).unwrap();
        assert_eq!(bytes, expected.fingerprint.to_stored_bytes());
        assert_eq!(
            (quality, width, height),
            (
                expected.fingerprint.quality,
                expected.width,
                expected.height
            )
        );
        drop(connection);
        assert_eq!(
            fixture
                .library
                .index_missing_similarity_hashes()
                .unwrap()
                .remaining,
            0
        );
        let updates: i64 = fixture
            .library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM hash_updates", [], |row| row.get(0))
            .unwrap();
        assert_eq!(updates, 51);
    }

    #[test]
    fn indexing_an_empty_library_returns_zero_counts() {
        let fixture = library_with_hashes(&[]);

        let progress = fixture.library.index_missing_similarity_hashes().unwrap();

        assert_eq!((progress.remaining, progress.failed), (0, 0));
    }

    #[test]
    fn pdq_index_includes_gif_and_excludes_video_from_counts() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_policy_asset(&library, "gif", &[0; 32], 100, 12, 8, "gif");
        insert_policy_asset(&library, "video", &[0; 32], 100, 12, 8, "video");
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET perceptual_hash = NULL, perceptual_hash_quality = NULL",
                [],
            )
            .unwrap();
        let gif_path = library.root().join("assets/gif.png");
        fs::create_dir_all(gif_path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(12, 8, Rgb([80, 80, 80]))
            .save_with_format(&gif_path, image::ImageFormat::Gif)
            .unwrap();

        let progress = library.index_missing_similarity_hashes().unwrap();
        let (gif_length, gif_quality): (i64, i64) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT length(perceptual_hash), perceptual_hash_quality
                 FROM assets WHERE id = 'gif'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let video_state: (Option<Vec<u8>>, Option<i64>, Option<String>) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT perceptual_hash, perceptual_hash_quality, perceptual_hash_error
                 FROM assets WHERE id = 'video'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!((progress.remaining, progress.failed), (0, 0));
        assert_eq!(gif_length, 64);
        assert!(gif_quality < 50);
        assert_eq!(video_state, (None, None, None));
    }

    #[test]
    fn new_similarity_reviews_record_pdq_fingerprint_kind() {
        let fixture = review_fixture();
        let kind: String = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT fingerprint_kind FROM similarity_reviews WHERE id = ?1",
                [&fixture.review_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(kind, "pdq-v1");
    }

    #[test]
    fn review_listing_returns_public_assets_and_stable_cursor_pages() {
        let fixture = review_fixture();
        fixture.add_horizontal_review();

        let first = fixture.library.list_similarity_reviews(None, 1).unwrap();
        let second = fixture
            .library
            .list_similarity_reviews(first.next_cursor.clone(), 1)
            .unwrap();

        assert_eq!(first.total_count, 2);
        assert_eq!(first.items.len(), 1);
        assert_eq!(second.items.len(), 1);
        assert_ne!(first.items[0].id, second.items[0].id);
        assert!(first.next_cursor.is_some());
        assert!(second.next_cursor.is_none());
        for review in first.items.iter().chain(&second.items) {
            assert!(!review.existing.format.is_empty());
            assert!(!review.candidate.format.is_empty());
            assert!(!review.existing.asset.original_name.is_empty());
            assert!(!review.candidate.asset.original_name.is_empty());
        }
        assert!(matches!(
            fixture.library.list_similarity_reviews(None, 0),
            Err(LibraryError::InvalidAssetPageLimit)
        ));
        assert!(matches!(
            fixture.library.list_similarity_reviews(
                Some(AssetCursor {
                    token: "not-a-review-cursor".into()
                }),
                20
            ),
            Err(LibraryError::InvalidAssetCursor)
        ));
    }

    #[test]
    fn exact_duplicate_preserves_review_and_rejects_trash_or_missing_original() {
        let f = review_fixture();
        let request = |path| IngestMediaRequest {
            source_path: path,
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
        };
        match f
            .library
            .ingest_media(request(f.input.join("candidate.jpg")))
            .unwrap()
        {
            IngestOutcome::ReviewPending { review_id } => assert_eq!(review_id, f.review_id),
            other => panic!("{other:?}"),
        }
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET status='trash',trashed_at='2026-09-09' WHERE id=?1",
                [&f.existing_id],
            )
            .unwrap();
        assert!(matches!(
            f.library
                .ingest_media(request(f.input.join("existing.png"))),
            Err(LibraryError::DuplicateInTrash)
        ));
        let path: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT relative_path FROM assets WHERE id=?1",
                [&f.existing_id],
                |r| r.get(0),
            )
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET status='normal',trashed_at=NULL WHERE id=?1",
                [&f.existing_id],
            )
            .unwrap();
        fs::remove_file(f.library.root().join(path)).unwrap();
        assert!(f
            .library
            .ingest_media(request(f.input.join("existing.png")))
            .is_err());
    }

    #[test]
    fn review_promotion_and_outbox_are_atomic_and_idempotent() {
        for decision in [
            SimilarityDecision::KeepBoth,
            SimilarityDecision::ReplaceExisting,
        ] {
            let f = review_fixture();
            let count = || {
                f.library
                    .connection()
                    .unwrap()
                    .query_row::<i64, _, _>(
                        "SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_id=?1",
                        [&f.candidate_id],
                        |r| r.get(0),
                    )
                    .unwrap()
            };
            assert_eq!(count(), 0);
            f.library.connection().unwrap().execute_batch("CREATE TRIGGER reject_queue BEFORE INSERT ON cloud_sync_queue BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
            assert!(f
                .library
                .decide_similarity_review(SimilarityDecisionRequest {
                    review_id: f.review_id.clone(),
                    decision
                })
                .is_err());
            assert_eq!(f.status(&f.candidate_id), "review");
            assert_eq!(count(), 0);
            f.library
                .connection()
                .unwrap()
                .execute_batch("DROP TRIGGER reject_queue;")
                .unwrap();
            for _ in 0..2 {
                f.library
                    .decide_similarity_review(SimilarityDecisionRequest {
                        review_id: f.review_id.clone(),
                        decision,
                    })
                    .unwrap();
            }
            assert_eq!(f.status(&f.candidate_id), "normal");
            assert_eq!(count(), 1);
        }
    }

    #[test]
    fn get_asset_returns_normal_assets_but_not_review_candidates() {
        let fixture = review_fixture();

        assert_eq!(
            fixture.library.get_asset(&fixture.existing_id).unwrap().id,
            fixture.existing_id
        );
        assert!(matches!(
            fixture.library.get_asset(&fixture.candidate_id),
            Err(LibraryError::AssetNotFound)
        ));
    }

    #[test]
    fn replace_moves_existing_to_trash_and_transfers_classifications_collection_and_favorite() {
        let fixture = review_fixture();
        let collection = fixture
            .library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        fixture
            .library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec![fixture.existing_id.clone()],
                add_collection_ids: vec![collection.id.clone()],
                remove_collection_ids: vec![],
            })
            .unwrap();
        fixture
            .library
            .set_asset_favorite(&fixture.existing_id, true)
            .unwrap();

        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::ReplaceExisting,
            })
            .unwrap();

        assert_eq!(fixture.status(&fixture.existing_id), "trash");
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        let job = fixture
            .library
            .character_autotag_job(&fixture.candidate_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.state, "pending");
        assert_eq!(job.classification_ids, vec![fixture.old_tag.clone()]);
        assert!(fixture.favorite(&fixture.candidate_id));
        let mut actual = fixture.classification_ids(&fixture.candidate_id);
        actual.sort();
        let mut expected = vec![fixture.old_tag.clone()];
        expected.sort();
        assert_eq!(actual, expected);
        assert_eq!(
            fixture
                .library
                .get_asset_collections(&fixture.candidate_id)
                .unwrap(),
            vec![collection.id]
        );
        assert_eq!(
            fixture.source_url(&fixture.candidate_id),
            Some("https://example.com/new".into())
        );
    }

    #[test]
    fn keep_both_normalizes_only_the_candidate_and_is_idempotent() {
        let fixture = review_fixture();

        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepBoth,
            })
            .unwrap();
        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepBoth,
            })
            .unwrap();
        assert_eq!(fixture.status(&fixture.existing_id), "normal");
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        assert_eq!(fixture.normal_ids().len(), 2);
        let conflict = fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::ReplaceExisting,
            })
            .unwrap_err();
        assert!(matches!(conflict, LibraryError::SimilarityReviewConflict));
        assert!(matches!(
            fixture
                .library
                .decide_similarity_review(SimilarityDecisionRequest {
                    review_id: "missing-review".into(),
                    decision: SimilarityDecision::KeepBoth,
                }),
            Err(LibraryError::SimilarityReviewNotFound)
        ));
    }

    impl ReviewFixture {
        /// A second incoming candidate near the same existing Asset.
        fn add_sibling_review(&self) -> (String, String) {
            let base = striped_fixture(900, 600, StripeDirection::Vertical);
            let path = self.input.join("sibling.jpg");
            jpeg_variant(&base, 600, 400, 80).save(&path).unwrap();
            let review_id = match self
                .library
                .ingest_media(IngestMediaRequest {
                    source_path: path,
                    classification_id: None,
                    source_url: None,
                    collected_at: None,
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::Direct,
                    import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
                })
                .unwrap()
            {
                IngestOutcome::ReviewPending { review_id } => review_id,
                other => panic!("expected a second review, got {other:?}"),
            };
            let (existing, candidate): (String, String) = self
                .library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT existing_asset_id, candidate_asset_id FROM similarity_reviews WHERE id = ?1",
                    [&review_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(existing, self.existing_id);
            (review_id, candidate)
        }

        fn review_state(&self, review_id: &str) -> (String, Option<String>) {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT status, decision FROM similarity_reviews WHERE id = ?1",
                    [review_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        }
    }

    #[test]
    fn replacing_the_existing_asset_releases_its_sibling_review_and_keeps_the_candidate() {
        let fixture = review_fixture();
        let (sibling_review, sibling_candidate) = fixture.add_sibling_review();
        assert_eq!(
            fixture
                .library
                .list_similarity_reviews(None, 20)
                .unwrap()
                .items
                .len(),
            2
        );
        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::ReplaceExisting,
            })
            .unwrap();
        assert_eq!(fixture.status(&fixture.existing_id), "trash");
        assert_eq!(fixture.status(&sibling_candidate), "normal");
        assert_eq!(
            fixture.review_state(&sibling_review),
            ("resolved".into(), Some("keep_both".into()))
        );
        let page = fixture.library.list_similarity_reviews(None, 20).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total_count, 0);
    }

    #[test]
    fn trashing_the_existing_asset_from_the_grid_releases_the_review() {
        let fixture = review_fixture();
        fixture
            .library
            .trash_assets(&[fixture.existing_id.clone()])
            .unwrap();
        assert_eq!(
            fixture.review_state(&fixture.review_id),
            ("resolved".into(), Some("keep_both".into()))
        );
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        // Restoring the existing Asset does not resurrect the review.
        fixture
            .library
            .restore_assets(&[fixture.existing_id.clone()])
            .unwrap();
        assert_eq!(fixture.normal_ids().len(), 2);
        assert_eq!(
            fixture
                .library
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    fn a_stale_review_no_longer_breaks_the_list_and_releases_its_candidate() {
        let fixture = review_fixture();
        fixture.add_horizontal_review();
        // Any path that does not release at trash time (cloud trash, rows written before
        // this release existed) leaves the review open against a trashed existing Asset.
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET status = 'trash', trashed_at = '2026-09-25' WHERE id = ?1",
                [&fixture.existing_id],
            )
            .unwrap();
        let page = fixture.library.list_similarity_reviews(None, 20).unwrap();
        assert_eq!(page.items.len(), 1, "the unrelated review is still listed");
        assert_eq!(page.total_count, 1);
        assert_ne!(page.items[0].id, fixture.review_id);
        assert_eq!(
            fixture.review_state(&fixture.review_id),
            ("resolved".into(), Some("keep_both".into()))
        );
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        // The candidate is a real library Asset again, queued for replication like keep-both.
        let queued: bool = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cloud_sync_queue WHERE entity_type='asset' AND entity_id=?1)",
                [&fixture.candidate_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(queued);
    }

    #[test]
    fn deleting_an_existing_asset_under_an_open_review_fails_its_check_but_purge_releases_it() {
        let fixture = review_fixture();
        // Confirms the review note: ON DELETE SET NULL on an open incoming review violates
        // the open-row CHECK, so a raw delete of the existing Asset is refused.
        let error = fixture
            .library
            .connection()
            .unwrap()
            .execute("DELETE FROM assets WHERE id = ?1", [&fixture.existing_id])
            .unwrap_err();
        assert!(
            error.to_string().contains("CHECK constraint failed"),
            "{error}"
        );
        // A stranded row (trashed without release) is released by the purge itself.
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET status = 'trash', trashed_at = '2026-09-25' WHERE id = ?1",
                [&fixture.existing_id],
            )
            .unwrap();
        let summary = fixture.library.empty_trash().unwrap();
        assert_eq!(summary.deleted_count, 1);
        assert!(summary.failed_asset_ids.is_empty());
        assert!(!fixture.asset_exists(&fixture.existing_id));
        assert_eq!(fixture.status(&fixture.candidate_id), "normal");
        assert_eq!(
            fixture.review_state(&fixture.review_id),
            ("resolved".into(), Some("keep_both".into()))
        );
    }

    #[test]
    fn keep_existing_removes_only_the_managed_candidate() {
        let fixture = review_fixture();

        fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepExisting,
            })
            .unwrap();

        assert_eq!(fixture.status(&fixture.existing_id), "normal");
        assert!(!fixture.asset_exists(&fixture.candidate_id));
        assert!(!fixture.candidate_asset_path.exists());
        assert!(!fixture.candidate_thumbnail_path.exists());
        assert_eq!(
            fixture
                .library
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    fn keep_existing_resumes_file_cleanup_after_reopen() {
        let fixture = review_fixture();
        set_after_review_resolving_hook(|| {
            Err(LibraryError::WriteAsset {
                path: PathBuf::from("simulated"),
                source: std::io::Error::other("simulated interruption"),
            })
        });
        let error = fixture
            .library
            .decide_similarity_review(SimilarityDecisionRequest {
                review_id: fixture.review_id.clone(),
                decision: SimilarityDecision::KeepExisting,
            })
            .unwrap_err();
        assert!(matches!(error, LibraryError::WriteAsset { .. }));

        let root = fixture.library.root().to_path_buf();
        drop(fixture.library);
        let reopened = Library::open(&root).unwrap();

        assert!(!fixture.candidate_asset_path.exists());
        assert!(!fixture.candidate_thumbnail_path.exists());
        assert_eq!(
            reopened
                .list_similarity_reviews(None, 20)
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    #[ignore]
    fn candidate_search_scans_fifty_thousand_hashes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            for index in 0..50_000_u64 {
                let id = format!("asset-{index:05}");
                let mut hash = [0_u8; 32];
                hash[..8].copy_from_slice(&index.rotate_left(17).to_be_bytes());
                transaction
                    .execute(
                        "INSERT INTO assets (
                            id, content_hash, media_kind, original_name, relative_path,
                            thumbnail_relative_path, byte_size, width, height, collected_at,
                            perceptual_hash, perceptual_hash_quality
                         ) VALUES (?1, ?1, 'image', ?1, ?2, ?3, 1, 1, 1,
                            '2026-08-09T00:00:00Z', ?4, 100)",
                        params![
                            id,
                            format!("assets/{id}.png"),
                            format!("thumbnails/{id}.webp"),
                            stored_hash(hash)
                        ],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
        }

        let started = Instant::now();
        let target = ImageFingerprint {
            bytes: [0; 32],
            cropped_bytes: [0; 32],
            quality: 100,
        };
        let candidate = library.find_similar_asset(&target, (1, 1)).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(candidate.unwrap().asset_id, "asset-00000");
        eprintln!("50k similarity scan: {elapsed:?}");
        assert!(elapsed.as_secs_f64() < 1.0);
    }

    fn striped_fixture(width: u32, height: u32, direction: StripeDirection) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            let nx = x as f32 / width as f32;
            let ny = y as f32 / height as f32;
            let mut color = [
                (35.0 + nx * 90.0) as u8,
                (45.0 + ny * 100.0) as u8,
                (170.0 - nx * 55.0) as u8,
            ];
            let featured = match direction {
                StripeDirection::Vertical => {
                    (0.18..0.43).contains(&nx) && (0.12..0.88).contains(&ny)
                }
                StripeDirection::Horizontal => {
                    (0.12..0.88).contains(&nx) && (0.18..0.43).contains(&ny)
                }
            };
            if featured {
                color = [235, 75, 35];
            }
            if (0.55..0.90).contains(&nx) && (0.08..0.20).contains(&ny) {
                color = [245, 205, 35];
            }
            let circle = (nx - 0.72).powi(2) + (ny - 0.68).powi(2) < 0.085;
            if circle {
                color = [25, 215, 135];
            }
            Rgb(color)
        }))
    }

    fn jpeg_variant(source: &DynamicImage, width: u32, height: u32, quality: u8) -> DynamicImage {
        let resized = source.resize_exact(width, height, FilterType::Triangle);
        image::load_from_memory(&jpeg_bytes(&resized, quality)).unwrap()
    }

    fn jpeg_bytes(source: &DynamicImage, quality: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(source)
            .unwrap();
        bytes
    }

    fn jpeg_with_exif_orientation(jpeg: Vec<u8>, orientation: u16) -> Vec<u8> {
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        let mut payload = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        payload.extend_from_slice(&orientation.to_le_bytes());
        payload.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        let length = u16::try_from(payload.len() + 2).unwrap().to_be_bytes();
        let mut output = vec![0xff, 0xd8, 0xff, 0xe1, length[0], length[1]];
        output.extend_from_slice(&payload);
        output.extend_from_slice(&jpeg[2..]);
        output
    }

    fn horizontal_band_fixture(width: u32, height: u32, band_count: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |_, y| {
            let light = (y * band_count / height) % 2 == 0;
            Rgb(if light { [235, 235, 235] } else { [20, 20, 20] })
        }))
    }

    fn test_dhash(image: &DynamicImage) -> u64 {
        let pixels = image.resize_exact(9, 8, FilterType::Triangle).to_luma8();
        let mut hash = 0_u64;
        for y in 0..8 {
            for x in 0..8 {
                hash <<= 1;
                hash |= u64::from(pixels.get_pixel(x, y)[0] > pixels.get_pixel(x + 1, y)[0]);
            }
        }
        hash
    }

    impl ReviewFixture {
        fn add_horizontal_review(&self) {
            let base = striped_fixture(900, 600, StripeDirection::Horizontal);
            let existing_path = self.input.join("horizontal-existing.png");
            base.save(&existing_path).unwrap();
            assert!(matches!(
                self.library
                    .ingest_media(IngestMediaRequest {
                        source_path: existing_path,
                        classification_id: None,
                        source_url: None,
                        collected_at: None,
                        replace_duplicate_metadata: false,
                        source_published_at: None,
                        creator_name: None,
                        creator_handle: None,
                        creator_url: None,
                        import_source: ImportSource::Direct,
                        import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
                    })
                    .unwrap(),
                IngestOutcome::Added { .. }
            ));
            let variant_path = self.input.join("horizontal-variant.jpg");
            jpeg_variant(&base, 450, 300, 70)
                .save(&variant_path)
                .unwrap();
            assert!(matches!(
                self.library
                    .ingest_media(IngestMediaRequest {
                        source_path: variant_path,
                        classification_id: None,
                        source_url: None,
                        collected_at: None,
                        replace_duplicate_metadata: false,
                        source_published_at: None,
                        creator_name: None,
                        creator_handle: None,
                        creator_url: None,
                        import_source: ImportSource::Direct,
                        import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
                    })
                    .unwrap(),
                IngestOutcome::ReviewPending { .. }
            ));
        }

        fn status(&self, asset_id: &str) -> String {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT status FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn favorite(&self, asset_id: &str) -> bool {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT favorite FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn classification_ids(&self, asset_id: &str) -> Vec<String> {
            self.library
                .get_asset_classifications(asset_id)
                .unwrap()
                .into_iter()
                .map(|entry| entry.id)
                .collect()
        }

        fn source_url(&self, asset_id: &str) -> Option<String> {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT source_url FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn normal_ids(&self) -> Vec<String> {
            let connection = self.library.connection().unwrap();
            let mut statement = connection
                .prepare("SELECT id FROM assets WHERE status = 'normal' ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        }

        fn asset_exists(&self, asset_id: &str) -> bool {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
                    [asset_id],
                    |row| row.get(0),
                )
                .unwrap()
        }
    }

    fn review_fixture() -> ReviewFixture {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("input");
        fs::create_dir(&input).unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let old_tag = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "기존 분류".into(),
                parent_id: None,
            })
            .unwrap()
            .id;
        let requested_tag = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "새 분류".into(),
                parent_id: None,
            })
            .unwrap()
            .id;
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO character_series(classification_id,auto_classify) VALUES(?1,1)",
                [&old_tag],
            )
            .unwrap();
        let base = striped_fixture(900, 600, StripeDirection::Vertical);
        let existing_source = input.join("existing.png");
        base.save(&existing_source).unwrap();
        let existing_id = match library
            .ingest_media(IngestMediaRequest {
                source_path: existing_source,
                classification_id: Some(old_tag.clone()),
                source_url: Some("https://example.com/old".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
            })
            .unwrap()
        {
            IngestOutcome::Added { asset } => asset.id,
            other => panic!("expected normal existing asset, got {other:?}"),
        };
        let candidate_source = input.join("candidate.jpg");
        jpeg_variant(&base, 450, 300, 70)
            .save(&candidate_source)
            .unwrap();
        let review_id = match library
            .ingest_media(IngestMediaRequest {
                source_path: candidate_source,
                classification_id: Some(requested_tag.clone()),
                source_url: Some("https://example.com/new".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000002".into(),
            })
            .unwrap()
        {
            IngestOutcome::ReviewPending { review_id } => review_id,
            other => panic!("expected review candidate, got {other:?}"),
        };
        let (candidate_id, relative_path, thumbnail_relative_path): (String, String, String) =
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT assets.id, assets.relative_path, assets.thumbnail_relative_path
                     FROM similarity_reviews
                     JOIN assets ON assets.id = similarity_reviews.candidate_asset_id
                     WHERE similarity_reviews.id = ?1",
                    [&review_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        let candidate_asset_path = library.root().join(relative_path);
        let candidate_thumbnail_path = library.root().join(thumbnail_relative_path);
        ReviewFixture {
            _temp: temp,
            library,
            input,
            existing_id,
            candidate_id,
            review_id,
            old_tag,
            candidate_asset_path,
            candidate_thumbnail_path,
        }
    }

    fn library_with_hashes(rows: &[(&str, [u8; 32], &str)]) -> TestLibrary {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for (id, hash, collected_at) in rows {
            let stored = stored_hash(*hash);
            insert_asset(&library, id, collected_at, Some(&stored));
        }
        TestLibrary {
            _temp: temp,
            library,
        }
    }

    fn library_with_unindexed_assets(count: usize) -> TestLibrary {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for index in 0..count {
            let id = format!("asset-{index:03}");
            insert_asset(&library, &id, "2026-08-09T00:00:00Z", None);
            if index != 0 {
                let path = library.root().join(format!("assets/{id}.png"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                RgbImage::from_pixel(12, 8, Rgb([index as u8, 80, 120]))
                    .save(&path)
                    .unwrap();
            }
        }
        TestLibrary {
            _temp: temp,
            library,
        }
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str, hash: Option<&[u8]>) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    perceptual_hash, perceptual_hash_quality
                 ) VALUES (?1, ?1, 'image', ?1, ?2, ?3, 1, 100, 100, ?4, ?5, ?6)",
                params![
                    id,
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    collected_at,
                    hash,
                    hash.map(|_| 100_u8),
                ],
            )
            .unwrap();
    }

    fn insert_policy_asset(
        library: &Library,
        id: &str,
        hash: &[u8; 32],
        quality: u8,
        width: u32,
        height: u32,
        media_kind: &str,
    ) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    perceptual_hash, perceptual_hash_quality
                 ) VALUES (?1, ?1, ?2, ?1, ?3, ?4, 1, ?5, ?6,
                           '2026-08-09T00:00:00Z', ?7, ?8)",
                params![
                    id,
                    media_kind,
                    format!("assets/{id}.png"),
                    (media_kind != "video").then(|| format!("thumbnails/{id}.webp")),
                    width,
                    height,
                    stored_hash(*hash),
                    quality,
                ],
            )
            .unwrap();
    }

    fn stored_hash(hash: [u8; 32]) -> [u8; 64] {
        let mut stored = [0; 64];
        stored[..32].copy_from_slice(&hash);
        stored[32..].copy_from_slice(&hash);
        stored
    }
