    use std::{
        fs::File,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        time::Duration,
    };

    use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageBuffer, Rgb};
    use tempfile::TempDir;

    use super::{
        clear_after_duplicate_hook, copy_and_hash, encode_thumbnail_webp, install_staged_asset,
        set_after_duplicate_hook, set_staging_hook, set_video_probe_hook, LibraryError,
        PendingFiles, MAX_IMAGE_BYTES,
    };
    use crate::library::{
        models::{
            AssetClassificationPatch, AssetQuery, AssetSort, AssetSummary, ClassificationKind,
            CreateClassification, ImportSource, IngestMediaRequest, IngestOutcome, MediaSummary,
            VideoPreparationState,
        },
        video_media::VideoProbe,
        Library,
    };

    struct IngestionFixture {
        _temp: TempDir,
        library: Library,
        source: PathBuf,
    }

    struct SimilarityIngestionFixture {
        _temp: TempDir,
        library: Library,
        input: PathBuf,
        tag_id: String,
    }

    impl IngestionFixture {
    /// Ingest an Asset with a Classification so the assignment path is exercised.
    fn ingest_with_classification(&self, classification_id: &str) -> IngestOutcome {
        self.library
            .ingest_media(IngestMediaRequest {
                source_path: self.source.clone(),
                classification_id: Some(classification_id.to_owned()),
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
    }

        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source.png");
            write_test_png(&source, [10, 20, 30]);
            let library = Library::open(temp.path().join("library")).unwrap();

            Self {
                _temp: temp,
                library,
                source,
            }
        }

        fn ingest(&self) -> IngestOutcome {
            self.library
                .ingest_media(IngestMediaRequest {
                    source_path: self.source.clone(),
                    classification_id: None,
                    source_url: None,
                    collected_at: None,
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::Direct,
                    import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                })
                .unwrap()
        }
    }

    impl SimilarityIngestionFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let input = temp.path().join("input");
            std::fs::create_dir(&input).unwrap();
            let library = Library::open(temp.path().join("library")).unwrap();
            let tag_id = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Root,
                    name: "게임".into(),
                    parent_id: None,
                })
                .unwrap()
                .id;
            Self {
                _temp: temp,
                library,
                input,
                tag_id,
            }
        }

        fn write_png(&self, name: &str, image: &DynamicImage) -> PathBuf {
            let path = self.input.join(name);
            image
                .save_with_format(&path, image::ImageFormat::Png)
                .unwrap();
            path
        }

        fn write_jpeg(&self, name: &str, image: &DynamicImage, quality: u8) -> PathBuf {
            let path = self.input.join(name);
            JpegEncoder::new_with_quality(File::create(&path).unwrap(), quality)
                .encode_image(image)
                .unwrap();
            path
        }

        fn ingest(
            &self,
            path: &Path,
            classification_id: Option<String>,
            source_url: Option<String>,
        ) -> IngestOutcome {
            self.library
                .ingest_media(IngestMediaRequest {
                    source_path: path.to_path_buf(),
                    classification_id,
                    source_url,
                    collected_at: None,
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::Direct,
                    import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                })
                .unwrap()
        }

        fn all_assets(&self) -> Vec<AssetSummary> {
            self.library
                .list_assets(AssetQuery {
                    classification_id: None,
                    album_id: None,
                    collection_id: None,
                    direct_only: false,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit: 100,
                    ..Default::default()
                })
                .unwrap()
                .items
        }

        fn review_candidate_id(&self) -> String {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT candidate_asset_id FROM similarity_reviews WHERE status = 'open'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn review_count(&self) -> i64 {
            self.library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM similarity_reviews", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
    }

    fn write_test_png(path: &Path, rgb: [u8; 3]) {
        let image = image::RgbImage::from_pixel(8, 6, image::Rgb(rgb));
        image
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    #[test]
    fn thumbnail_webp_is_bounded_and_decodable() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(1200, 800, |x, y| {
            Rgb([
                ((x + y) % 251) as u8,
                ((x * 3) % 253) as u8,
                ((y * 5) % 247) as u8,
            ])
        }));
        let encoded = encode_thumbnail_webp(&image).unwrap();
        let decoded =
            image::load_from_memory_with_format(&encoded, image::ImageFormat::WebP).unwrap();

        assert_eq!((decoded.width(), decoded.height()), (360, 240));
    }

    #[test]
    fn thumbnail_webp_preserves_alpha_channel() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(360, 240, |x, _| {
            let alpha = if x < 120 {
                0
            } else if x < 240 {
                128
            } else {
                255
            };
            image::Rgba([220, 80, 40, alpha])
        }));
        let encoded = encode_thumbnail_webp(&image).unwrap();
        let decoded = image::load_from_memory_with_format(&encoded, image::ImageFormat::WebP)
            .unwrap()
            .to_rgba8();

        assert_eq!(decoded.get_pixel(40, 120)[3], 0);
        assert_eq!(decoded.get_pixel(180, 120)[3], 128);
        assert_eq!(decoded.get_pixel(320, 120)[3], 255);
    }

    #[test]
    fn thumbnail_webp_is_materially_smaller_than_lossless_webp_for_detailed_art() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(360, 360, |x, y| {
            let seed = x
                .wrapping_mul(1_664_525)
                .wrapping_add(y.wrapping_mul(1_013_904_223))
                .wrapping_add((x ^ y).wrapping_mul(2_654_435_761));
            Rgb([(seed >> 16) as u8, (seed >> 8) as u8, seed as u8])
        }));
        let lossy = encode_thumbnail_webp(&image).unwrap();
        let mut lossless = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut lossless, image::ImageFormat::WebP)
            .unwrap();
        let lossless = lossless.into_inner();

        assert!(
            lossy.len() * 5 < lossless.len() * 3,
            "lossy={} lossless={}",
            lossy.len(),
            lossless.len()
        );
    }

    fn stub_video_probe() {
        set_video_probe_hook(|_, extension| {
            Ok(VideoProbe {
                container: extension.to_owned(),
                video_codec: "vp9".into(),
                audio_codec: Some("opus".into()),
                duration_ms: 12_345,
                width: 1280,
                height: 720,
            })
        });
    }

    fn vertical_stripes(width: u32, height: u32) -> DynamicImage {
        scene_fixture(width, height, true)
    }

    fn horizontal_stripes(width: u32, height: u32) -> DynamicImage {
        scene_fixture(width, height, false)
    }

    fn scene_fixture(width: u32, height: u32, vertical: bool) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            let nx = x as f32 / width as f32;
            let ny = y as f32 / height as f32;
            let mut color = [
                (35.0 + nx * 90.0) as u8,
                (45.0 + ny * 100.0) as u8,
                (170.0 - nx * 55.0) as u8,
            ];
            let featured = if vertical {
                (0.18..0.43).contains(&nx) && (0.12..0.88).contains(&ny)
            } else {
                (0.12..0.88).contains(&nx) && (0.18..0.43).contains(&ny)
            };
            if featured {
                color = [235, 75, 35];
            }
            if (0.55..0.90).contains(&nx) && (0.08..0.20).contains(&ny) {
                color = [245, 205, 35];
            }
            if (nx - 0.72).powi(2) + (ny - 0.68).powi(2) < 0.085 {
                color = [25, 215, 135];
            }
            Rgb(color)
        }))
    }

    #[test]
    fn ingested_batch_is_visible_while_a_character_claim_is_held_or_failed() {
        let fixture = IngestionFixture::new();
        let series = fixture.library.create_classification(CreateClassification {
            kind: ClassificationKind::Root, name: "Visibility fixture".into(), parent_id: None,
        }).unwrap();
        fixture.library.save_character_series(crate::library::character_hub::Series {
            classification_id: series.id.clone(), hero_asset_id: None, auto_classify: true,
        }).unwrap();
        let ingest = |index: u8| {
            let path = fixture._temp.path().join(format!("batch-{index}.png"));
            write_test_png(&path, [10 + index, 20, 30]);
            let outcome = fixture.library.ingest_media(IngestMediaRequest {
                source_path: path, classification_id: Some(series.id.clone()), source_url: None,
                collected_at: None, replace_duplicate_metadata: false, source_published_at: None,
                creator_name: None, creator_handle: None, creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            }).unwrap();
            let IngestOutcome::Added { asset } = outcome else { panic!("expected a new fixture"); };
            asset.id
        };
        let first = ingest(1);
        let (claimed_tx, claimed_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_library = fixture.library.clone();
        let worker = std::thread::spawn(move || {
            let job = worker_library.claim_character_autotag().unwrap().unwrap();
            claimed_tx.send(job.asset_id.clone()).unwrap();
            // Deliberately hold the durable claim without holding the database lock.
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
            worker_library.connection().unwrap().execute(
                "UPDATE character_autotag_jobs SET state='failed',review_state='failed',claim_id=NULL WHERE asset_id=?1 AND claim_id=?2",
                rusqlite::params![job.asset_id, job.claim_id],
            ).unwrap();
        });
        assert_eq!(claimed_rx.recv_timeout(Duration::from_secs(5)).unwrap(), first);
        let second = ingest(2);
        let third = ingest(3);
        let assert_visible = || {
            let base = fixture.library.list_assets(AssetQuery {
                classification_id: Some(series.id.clone()), limit: 10, ..Default::default()
            }).unwrap();
            assert_eq!(base.items.len(), 3);
            let page = fixture.library.browse_character_assets(crate::library::character_hub::BrowseQuery {
                series_id: series.id.clone(), target_id: None, group_id: None,
                reference_target_id: None, after: None, limit: 10, all: false,
                series_filter: Some(crate::library::character_hub::SeriesGalleryFilter::Unclassified),
            }).unwrap();
            assert_eq!(page.total_count, 3);
            for id in [&first, &second, &third] {
                assert!(page.items.iter().any(|asset| &asset.id == id));
            }
        };
        assert_eq!(fixture.library.character_autotag_job(&first).unwrap().unwrap().state, "processing");
        assert_visible();
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(fixture.library.character_autotag_job(&first).unwrap().unwrap().state, "failed");
        assert_visible();
    }

    #[test]
    fn successful_asset_commit_creates_one_pending_cloud_upsert() {
        for registered_series in [false, true] {
            let fixture = IngestionFixture::new();
            let classification_id = registered_series.then(|| {
                let series = fixture.library.create_classification(CreateClassification {
                    kind: ClassificationKind::Root,
                    name: "Cloud upsert fixture".into(),
                    parent_id: None,
                }).unwrap();
                fixture.library.save_character_series(crate::library::character_hub::Series {
                    classification_id: series.id.clone(),
                    hero_asset_id: None,
                    auto_classify: true,
                }).unwrap();
                series.id
            });
            let ingest = || match classification_id.as_deref() {
                Some(id) => fixture.ingest_with_classification(id),
                None => fixture.ingest(),
            };
            let IngestOutcome::Added { asset } = ingest() else {
                panic!("expected added asset");
            };

            let count = || {
                fixture
                    .library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM cloud_sync_queue
                         WHERE entity_type = 'asset' AND entity_id = ?1
                           AND operation = 'upsert' AND status = 'pending' AND revision = 1",
                        [&asset.id],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
            };
            assert_eq!(count(), 1);
            let character_job = fixture.library.character_autotag_job(&asset.id).unwrap();
            if registered_series {
                let job = character_job.as_ref().expect("registered series must enqueue analysis");
                assert_eq!(job.state, "pending");
                assert_eq!(job.classification_ids, vec![classification_id.clone().unwrap()]);
            } else {
                assert!(character_job.is_none(), "unclassified images have no character scope");
            }

            assert!(matches!(
                ingest(),
                IngestOutcome::ExactDuplicate { .. }
            ));
            assert_eq!(count(), 1);
            assert_eq!(fixture.library.character_autotag_job(&asset.id).unwrap(), character_job);
        }
    }

    #[test]
    fn ingest_copies_the_image_and_keeps_the_user_source() {
        let fixture = IngestionFixture::new();

        let outcome = fixture.ingest();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert!(fixture.source.is_file());
        assert!(fixture.library.root().join(&asset.relative_path).is_file());
        assert!(fixture
            .library
            .root()
            .join(asset.thumbnail_relative_path.as_deref().unwrap())
            .is_file());
    }

    #[test]
    fn ingestion_fills_artist_from_post_url_for_all_capture_sources() {
        for import_source in [
            ImportSource::Direct,
            ImportSource::BrowserExtension,
            ImportSource::MetadataImport,
        ] {
            let fixture = IngestionFixture::new();
            let outcome = fixture.library.ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/HoundShou/status/123/photo/1".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            }).unwrap();
            let IngestOutcome::Added { asset } = outcome else {
                panic!("expected added asset");
            };
            let artist = fixture.library.asset_artist(&asset.id).unwrap().unwrap();
            assert_eq!(artist.label, "HoundShou");
            assert_eq!(artist.keys, vec!["HoundShou"]);
            assert!(asset.creator_handle.is_none());
            assert_eq!(fixture.library.artist_source_fill_preview().unwrap().fillable, 0);
        }
    }

    #[test]
    fn ingestion_source_fill_observes_the_arriving_assets_excluded_folder() {
        let fixture = IngestionFixture::new();
        let folder = fixture.library.create_classification(CreateClassification {
            kind: ClassificationKind::Root, name: "Excluded".into(), parent_id: None,
        }).unwrap();
        fixture.library.set_artist_excluded_folders(&[folder.id.clone()]).unwrap();
        let outcome = fixture.library.ingest_media(IngestMediaRequest {
            source_path: fixture.source.clone(), classification_id: Some(folder.id),
            source_url: Some("https://x.com/HoundShou/status/123".into()),
            collected_at: None, replace_duplicate_metadata: false, source_published_at: None,
            creator_name: None, creator_handle: None, creator_url: None,
            import_source: ImportSource::BrowserExtension,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        }).unwrap();
        let IngestOutcome::Added { asset } = outcome else { panic!("expected added asset"); };
        assert!(fixture.library.asset_artist(&asset.id).unwrap().is_none());
        let count: i64 = fixture.library.connection().unwrap().query_row(
            "SELECT COUNT(*) FROM asset_artist_assignments", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn video_ingest_registers_original_and_pending_job_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.webm");
        std::fs::write(&source, b"valid-video-fixture").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let classification = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "video".into(),
                parent_id: None,
            })
            .unwrap();
        stub_video_probe();

        let outcome = library
            .ingest_media(IngestMediaRequest {
                source_path: source.clone(),
                classification_id: Some(classification.id.clone()),
                source_url: Some("https://x.com/HoundShou/status/123/video/1".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("video ingest must add an asset");
        };
        assert_eq!(library.asset_artist(&asset.id).unwrap().unwrap().label, "HoundShou");
        assert_eq!(
            asset.media,
            MediaSummary::Video {
                duration_ms: 12_345,
                preparation_state: VideoPreparationState::Pending,
                scrub_frame_count: 0,
            }
        );
        assert_eq!(asset.width, 1280);
        assert_eq!(asset.height, 720);
        assert!(source.is_file());
        assert!(library.root().join(&asset.relative_path).is_file());
        let mut expected_classification = classification;
        expected_classification.asset_count = 1;
        assert_eq!(
            library.get_asset_classifications(&asset.id).unwrap(),
            vec![expected_classification]
        );
        let pending_jobs: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM video_assets WHERE asset_id = ?1 AND preparation_state = 'pending'",
                [&asset.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_jobs, 1);
    }

    #[test]
    fn exact_duplicate_video_creates_no_second_asset_or_job() {
        let temp = tempfile::tempdir().unwrap();
        let first_source = temp.path().join("first.webm");
        let second_source = temp.path().join("second.webm");
        std::fs::write(&first_source, b"same-video-bytes").unwrap();
        std::fs::write(&second_source, b"same-video-bytes").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        stub_video_probe();
        let first = library
            .ingest_media(IngestMediaRequest {
                source_path: first_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = first else {
            panic!("first video ingest must add an asset");
        };

        let second = library
            .ingest_media(IngestMediaRequest {
                source_path: second_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();

        assert_eq!(
            second,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id,
                classification_changed: false,
                metadata_changed: false,
            }
        );
        let counts: (i64, i64) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM assets), (SELECT COUNT(*) FROM video_assets)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1));
    }

    #[test]
    fn video_ingest_never_creates_a_similarity_review() {
        let temp = tempfile::tempdir().unwrap();
        let first_source = temp.path().join("first.webm");
        let second_source = temp.path().join("second.webm");
        std::fs::write(&first_source, b"video-a").unwrap();
        std::fs::write(&second_source, b"video-b").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        stub_video_probe();

        for source_path in [first_source, second_source] {
            assert!(matches!(
                library
                    .ingest_media(IngestMediaRequest {
                        source_path,
                        classification_id: None,
                        source_url: None,
                        collected_at: None,
                        replace_duplicate_metadata: false,
                        source_published_at: None,
                        creator_name: None,
                        creator_handle: None,
                        creator_url: None,
                        import_source: ImportSource::Direct,
                        import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                    })
                    .unwrap(),
                IngestOutcome::Added { .. }
            ));
        }

        let review_count: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM similarity_reviews", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(review_count, 0);
    }

    #[test]
    fn unsupported_media_extension_leaves_no_managed_file_or_database_row() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.mkv");
        std::fs::write(&source, b"unsupported-video-fixture").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();

        let result = library.ingest_media(IngestMediaRequest {
            source_path: source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });

        assert!(matches!(result, Err(LibraryError::UnsupportedVideo)));
        assert!(source.is_file());
        assert!(library
            .root()
            .join("assets/.staging")
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
    }

    #[test]
    fn existing_image_ingest_and_similarity_behavior_is_unchanged() {
        let fixture = SimilarityIngestionFixture::new();
        let base = vertical_stripes(900, 600);
        let original = fixture.write_png("original.png", &base);
        let similar = fixture.write_jpeg(
            "similar.jpg",
            &base.resize_exact(450, 300, FilterType::Triangle),
            70,
        );

        assert!(matches!(
            fixture.ingest(&original, None, None),
            IngestOutcome::Added { .. }
        ));
        assert!(matches!(
            fixture.ingest(&similar, None, None),
            IngestOutcome::ReviewPending { .. }
        ));
        assert_eq!(fixture.review_count(), 1);
    }

    #[test]
    fn ingesting_the_same_bytes_twice_returns_the_existing_asset() {
        let fixture = IngestionFixture::new();
        let first = fixture.ingest();
        let second = fixture.ingest();

        let IngestOutcome::Added { asset } = first else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(
            second,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id,
                classification_changed: false,
                metadata_changed: false,
            },
        );
    }

    #[test]
    fn similar_image_becomes_review_pending_without_entering_normal_queries() {
        let fixture = SimilarityIngestionFixture::new();
        let base = vertical_stripes(900, 600);
        let existing_path = fixture.write_png("existing.png", &base);
        let existing = match fixture.ingest(&existing_path, None, None) {
            IngestOutcome::Added { asset } => asset,
            other => panic!("expected added asset, got {other:?}"),
        };
        let variant_path = fixture.write_jpeg(
            "variant.jpg",
            &base.resize_exact(450, 300, FilterType::Triangle),
            70,
        );

        let outcome = fixture.ingest(
            &variant_path,
            Some(fixture.tag_id.clone()),
            Some("https://example.com/new".into()),
        );

        let review_id = match outcome {
            IngestOutcome::ReviewPending { review_id } => review_id,
            other => panic!("expected review pending, got {other:?}"),
        };
        assert_eq!(
            fixture
                .all_assets()
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec![existing.id]
        );
        let candidate_id = fixture.review_candidate_id();
        let connection = fixture.library.connection().unwrap();
        let stored: (String, String, Option<String>, i64) = connection
            .query_row(
                "SELECT reviews.id, assets.status, assets.source_url,
                        length(assets.perceptual_hash)
                 FROM similarity_reviews AS reviews
                 JOIN assets ON assets.id = reviews.candidate_asset_id
                 WHERE reviews.id = ?1",
                [&review_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let queued_candidate_count = connection
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_id = ?1",
                [&candidate_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            stored,
            (
                review_id,
                "review".into(),
                Some("https://example.com/new".into()),
                64
            )
        );
        assert_eq!(
            fixture
                .library
                .get_asset_classifications(&candidate_id)
                .unwrap()[0]
                .id,
            fixture.tag_id
        );
        assert_eq!(queued_candidate_count, 0);
        assert!(existing_path.is_file());
        assert!(variant_path.is_file());
    }

    #[test]
    fn exact_duplicate_wins_before_similarity_and_does_not_create_review() {
        let fixture = SimilarityIngestionFixture::new();
        let path = fixture.write_png("same.png", &vertical_stripes(900, 600));
        let existing = match fixture.ingest(&path, None, None) {
            IngestOutcome::Added { asset } => asset,
            other => panic!("expected added asset, got {other:?}"),
        };

        let outcome = fixture.ingest(&path, None, None);

        assert_eq!(
            outcome,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: existing.id,
                classification_changed: false,
                metadata_changed: false,
            }
        );
        assert_eq!(fixture.review_count(), 0);
    }

    #[test]
    fn unrelated_image_is_added_normally() {
        let fixture = SimilarityIngestionFixture::new();
        let vertical = fixture.write_png("vertical.png", &vertical_stripes(900, 600));
        let horizontal = fixture.write_png("horizontal.png", &horizontal_stripes(900, 600));
        assert!(matches!(
            fixture.ingest(&vertical, None, None),
            IngestOutcome::Added { .. }
        ));

        let outcome = fixture.ingest(&horizontal, None, None);

        assert!(matches!(outcome, IngestOutcome::Added { .. }));
        assert_eq!(fixture.all_assets().len(), 2);
        assert_eq!(fixture.review_count(), 0);
    }

    #[test]
    fn exact_duplicate_moves_the_existing_asset_to_the_requested_folder() {
        let fixture = IngestionFixture::new();
        let original_classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "original".into(),
                parent_id: None,
            })
            .unwrap();
        let duplicate_classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "duplicate".into(),
                parent_id: None,
            })
            .unwrap();
        let IngestOutcome::Added { asset } = fixture.ingest() else {
            panic!("first ingest must add an asset");
        };
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec![asset.id.clone()],
                add_classification_ids: vec![original_classification.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET title = 'keep me', favorite = 1 WHERE id = ?1",
                [&asset.id],
            )
            .unwrap();

        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: Some(duplicate_classification.id.clone()),
                source_url: Some("https://example.test/duplicate".into()),
                collected_at: Some("2026-08-13T13:44:55+09:00".into()),
                replace_duplicate_metadata: true,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();

        assert_eq!(
            outcome,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id.clone(),
                classification_changed: true,
                metadata_changed: true,
            },
        );
        let mut expected_classification = duplicate_classification;
        expected_classification.asset_count = 1;
        assert_eq!(
            fixture
                .library
                .get_asset_classifications(&asset.id)
                .unwrap(),
            vec![expected_classification],
        );
        assert_eq!(
            fixture
                .library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let stored: (Option<String>, String, i64, Option<String>) = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT source_url, collected_at, favorite, title FROM assets WHERE id = ?1",
                [&asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                Some("https://example.test/duplicate".into()),
                "2026-08-13T04:44:55.000Z".into(),
                1,
                Some("keep me".into()),
            )
        );
    }

    #[test]
    fn added_asset_normalizes_requested_collection_time_and_rejects_invalid_time() {
        let fixture = IngestionFixture::new();
        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: None,
                collected_at: Some("2026-08-13T13:44:55+09:00".into()),
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(asset.collected_at, "2026-08-13T04:44:55.000Z");

        let invalid = fixture.library.ingest_media(IngestMediaRequest {
            source_path: fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: Some("yesterday".into()),
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });
        assert!(matches!(invalid, Err(LibraryError::InvalidCollectedAt)));
    }

    #[test]
    fn jfif_ingestion_keeps_the_original_name_and_stores_jpeg_bytes_as_jpg() {
        let fixture = SimilarityIngestionFixture::new();
        let image = DynamicImage::new_rgb8(4, 4);
        let source = fixture.write_jpeg("portrait.jfif", &image, 90);

        let IngestOutcome::Added { asset } = fixture.ingest(&source, None, None) else {
            panic!("first JFIF ingest must add an asset");
        };

        assert_eq!(asset.original_name, "portrait.jfif");
        assert!(asset.relative_path.ends_with(".jpg"));
    }

    #[test]
    fn ingestion_records_source_metadata_and_preserves_first_provenance_on_duplicates() {
        let fixture = IngestionFixture::new();
        let first_batch = "31d1f90c-214b-41e2-9d84-f9d964bb5bc3";
        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/example/status/1".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: Some("2026-08-01T10:20:30Z".into()),
                creator_name: Some("Example Artist".into()),
                creator_handle: Some("example".into()),
                creator_url: Some("https://x.com/example".into()),
                import_source: ImportSource::Direct,
                import_batch_id: first_batch.into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(asset.import_source, Some(ImportSource::Direct));
        assert_eq!(asset.import_batch_id.as_deref(), Some(first_batch));
        assert!(asset.original_modified_at.is_some());
        let original_modified_at = asset.original_modified_at.clone();

        let duplicate = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/changed/status/2".into()),
                collected_at: None,
                replace_duplicate_metadata: true,
                source_published_at: Some("2026-08-02T10:20:30Z".into()),
                creator_name: Some("Changed Artist".into()),
                creator_handle: Some("changed".into()),
                creator_url: Some("https://x.com/changed".into()),
                import_source: ImportSource::MetadataImport,
                import_batch_id: "fe6dbf94-f018-45c8-814b-79d1962ed377".into(),
            })
            .unwrap();
        assert!(matches!(
            duplicate,
            IngestOutcome::ExactDuplicate {
                metadata_changed: true,
                ..
            }
        ));
        let stored = fixture.library.get_asset(&asset.id).unwrap();
        assert_eq!(stored.creator_name.as_deref(), Some("Changed Artist"));
        assert_eq!(stored.import_source, Some(ImportSource::Direct));
        assert_eq!(stored.import_batch_id.as_deref(), Some(first_batch));
        assert_eq!(stored.original_modified_at, original_modified_at);
    }

    #[test]
    fn ingestion_rejects_invalid_batch_ids_and_omits_extension_file_times() {
        let invalid_fixture = IngestionFixture::new();
        let invalid = invalid_fixture.library.ingest_media(IngestMediaRequest {
            source_path: invalid_fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "not-a-uuid".into(),
        });
        assert!(matches!(invalid, Err(LibraryError::InvalidImportBatchId)));

        let invalid_url = invalid_fixture.library.ingest_media(IngestMediaRequest {
            source_path: invalid_fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: Some("javascript:alert(1)".into()),
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000005".into(),
        });
        assert!(matches!(invalid_url, Err(LibraryError::InvalidCreatorUrl)));

        let invalid_time = invalid_fixture.library.ingest_media(IngestMediaRequest {
            source_path: invalid_fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: Some("not-a-time".into()),
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000005".into(),
        });
        assert!(matches!(
            invalid_time,
            Err(LibraryError::InvalidSourcePublishedAt)
        ));

        let extension_fixture = IngestionFixture::new();
        let outcome = extension_fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: extension_fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/example/status/1".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: Some("example".into()),
                creator_url: Some("https://x.com/example".into()),
                import_source: ImportSource::BrowserExtension,
                import_batch_id: "1be16707-c772-46c7-85b5-ae9be71211a4".into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = outcome else {
            panic!("extension ingest must add an asset");
        };
        assert_eq!(asset.original_modified_at, None);
    }

    #[test]
    fn failed_ingest_keeps_source_and_does_not_leave_a_registered_file() {
        let fixture = IngestionFixture::new();

        let result = fixture.library.ingest_media(IngestMediaRequest {
            source_path: fixture.source.clone(),
            classification_id: Some("missing-classification".into()),
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });

        assert!(result.is_err());
        assert!(fixture.source.is_file());
    }

    #[test]
    fn thumbnail_publication_recovers_empty_orphan_without_overwriting_nonempty_files() {
        let fixture = IngestionFixture::new();
        let relative = "thumbnails/test.webp";
        let path = fixture.library.root().join(relative);
        std::fs::write(&path, []).unwrap();
        let mut pending = PendingFiles::new();
        fixture.library.install_thumbnail(File::open(&fixture.source).unwrap(), &path, relative, &mut pending).unwrap();
        assert!(image::open(&path).is_ok());
        assert!(std::fs::read_dir(path.parent().unwrap()).unwrap().any(|entry| entry.unwrap().path().extension().is_some_and(|ext| ext == "orphan")));
        pending.commit();
        std::fs::write(&path, b"unrelated existing thumbnail").unwrap();
        let original = std::fs::read(&path).unwrap();
        let result = fixture.library.install_thumbnail(File::open(&fixture.source).unwrap(), &path, relative, &mut PendingFiles::new());
        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn thumbnail_decode_failure_never_publishes_final_path() {
        let fixture = IngestionFixture::new();
        std::fs::write(&fixture.source, b"broken image").unwrap();
        let relative = "thumbnails/test.webp";
        let path = fixture.library.root().join(relative);
        assert!(fixture.library.install_thumbnail(File::open(&fixture.source).unwrap(), &path, relative, &mut PendingFiles::new()).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn ingestion_reuses_complete_files_left_before_database_commit() {
        let fixture = IngestionFixture::new();
        let IngestOutcome::Added { asset } = fixture.ingest() else { panic!("expected asset") };
        let path = fixture.library.root().join(&asset.relative_path);
        let original = std::fs::read(&path).unwrap();
        fixture.library.connection().unwrap().execute("DELETE FROM assets WHERE id = ?1", [&asset.id]).unwrap();
        let IngestOutcome::Added { asset: recovered } = fixture.ingest() else { panic!("expected recovered asset") };
        assert_ne!(recovered.id, asset.id);
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert!(image::open(fixture.library.root().join(recovered.thumbnail_relative_path.unwrap())).is_ok());
    }

    #[test]
    fn thumbnail_recovery_preserves_referenced_empty_files() {
        let fixture = IngestionFixture::new();
        let asset = fixture.ingest();
        let IngestOutcome::Added { asset } = asset else { panic!("expected asset") };
        let relative = asset.thumbnail_relative_path.unwrap();
        let path = fixture.library.root().join(&relative);
        std::fs::write(&path, []).unwrap();
        let result = fixture.library.install_thumbnail(File::open(&fixture.source).unwrap(), &path, &relative, &mut PendingFiles::new());
        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::metadata(path).unwrap().len(), 0);
    }

    #[test]
    fn unsupported_image_removes_the_staged_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("not-an-image.bin");
        std::fs::write(&source, b"not an image").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();

        let result = library.ingest_media(IngestMediaRequest {
            source_path: source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });

        assert!(result.is_err());
        assert!(source.is_file());
        assert!(library
            .root()
            .join("assets/.staging")
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
    }

    #[test]
    fn content_hash_is_lowercase_sha256() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.bin");
        let staging = temp.path().join("staging.part");
        std::fs::write(&source, b"hash me").unwrap();
        let mut pending = PendingFiles::new();

        let (content_hash, _) = copy_and_hash(&source, &staging, &mut pending, None).unwrap();

        assert_eq!(content_hash.len(), 64);
        assert!(content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn existing_staging_file_is_never_truncated_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.bin");
        let staging = temp.path().join("foreign.part");
        std::fs::write(&source, b"new source bytes").unwrap();
        std::fs::write(&staging, b"foreign staging bytes").unwrap();

        let mut pending = PendingFiles::new();
        let result = copy_and_hash(&source, &staging, &mut pending, Some(MAX_IMAGE_BYTES));

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign staging bytes");
    }

    #[test]
    fn existing_asset_destination_is_never_overwritten_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("owned.part");
        let asset = temp.path().join("foreign.png");
        std::fs::write(&staging, b"owned staging bytes").unwrap();
        std::fs::write(&asset, b"foreign asset bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(staging.clone());

        let result = install_staged_asset(&staging, &asset, &mut pending);

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(&asset).unwrap(), b"foreign asset bytes");
        assert_eq!(std::fs::read(&staging).unwrap(), b"owned staging bytes");
    }

    #[test]
    fn cleanup_keeps_a_file_replaced_after_it_was_tracked() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owned.part");
        std::fs::write(&path, b"owned bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(path.clone());

        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"foreign replacement").unwrap();
        drop(pending);

        assert_eq!(std::fs::read(&path).unwrap(), b"foreign replacement");
    }

    #[test]
    fn staging_replacement_before_install_is_never_copied_or_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("owned.part");
        let asset = temp.path().join("asset.png");
        std::fs::write(&staging, b"owned staging bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(staging.clone());

        std::fs::remove_file(&staging).unwrap();
        std::fs::write(&staging, b"foreign replacement").unwrap();
        let result = install_staged_asset(&staging, &asset, &mut pending);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign replacement");
        drop(pending);
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign replacement");
        assert!(!asset.exists());
    }

    #[test]
    fn staging_replacement_is_never_inspected_or_thumbnail_copied() {
        let fixture = IngestionFixture::new();
        let replacement = b"foreign invalid image".to_vec();
        let replaced_path = Arc::new(Mutex::new(None));
        let replaced_path_for_hook = Arc::clone(&replaced_path);
        set_staging_hook(move |staging_path| {
            std::fs::remove_file(staging_path).unwrap();
            std::fs::write(staging_path, &replacement).unwrap();
            *replaced_path_for_hook.lock().unwrap() = Some(staging_path.to_path_buf());
        });

        let error = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap_err();

        assert!(
            matches!(error, LibraryError::WriteAsset { .. }),
            "the retained valid image should reach identity-bound cleanup: {error:?}"
        );
        let replaced_path = replaced_path.lock().unwrap().take().unwrap();
        assert_eq!(
            std::fs::read(replaced_path).unwrap(),
            b"foreign invalid image"
        );
    }

    #[test]
    fn library_clones_serialize_ingests_for_one_open_library() {
        let fixture = IngestionFixture::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_hook = Arc::clone(&calls);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let release_rx_for_hook = Arc::clone(&release_rx);
        set_after_duplicate_hook(fixture.library.root().to_path_buf(), move || {
            let call = calls_for_hook.fetch_add(1, Ordering::SeqCst);
            entered_tx.send(call).unwrap();
            if call == 0 {
                release_rx_for_hook.lock().unwrap().recv().unwrap();
            }
        });

        let first_library = fixture.library.clone();
        let first_source = fixture.source.clone();
        let first = std::thread::spawn(move || {
            first_library.ingest_media(IngestMediaRequest {
                source_path: first_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
        });
        let second_library = fixture.library.clone();
        let second_source = fixture.source.clone();
        let second = std::thread::spawn(move || {
            second_library.ingest_media(IngestMediaRequest {
                source_path: second_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
        });

        let first_entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let overlapped = entered_rx.recv_timeout(Duration::from_millis(250)).is_ok();
        release_tx.send(()).unwrap();
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        clear_after_duplicate_hook();

        assert!(
            first_entered,
            "neither ingest reached the duplicate boundary"
        );
        assert!(
            !overlapped,
            "two Library clones entered one library ingest concurrently"
        );
        let mut added = 0;
        let mut duplicate = 0;
        for outcome in [first.unwrap(), second.unwrap()] {
            match outcome {
                IngestOutcome::Added { .. } => added += 1,
                IngestOutcome::ExactDuplicate { .. } => duplicate += 1,
                IngestOutcome::ReviewPending { .. } => {
                    panic!("identical concurrent ingests cannot create a similarity review")
                }
            }
        }
        assert_eq!((added, duplicate), (1, 1));
    }

    /// Ingesting into a Classification must queue the assignment intent.
    ///
    /// The server learns an Asset's Classification only from the authority command line,
    /// so an ingest that writes the local relation without queueing the intent leaves the
    /// Asset permanently absent from the server/mobile Classification view. It must happen
    /// in the ingest transaction, not after commit, or a crash in between loses it.
    #[test]
    fn ingest_with_classification_queues_the_assignment_intent() {
        let fixture = IngestionFixture::new();
        fixture
            .library
            .adopt_classification_authority_for_test("e".repeat(32).as_str(), 1, 1, 0)
            .unwrap();
        // Ingest validates the target Classification, so it has to exist.
        let classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Ingest intent".into(),
                parent_id: None,
            })
            .unwrap();
        let outcome = fixture.ingest_with_classification(&classification.id);
        let connection = fixture.library.connection().unwrap();
        let asset_id = match outcome {
            IngestOutcome::Added { asset } => asset.id,
            other => panic!("expected a new Asset, got {other:?}"),
        };
        let queued: Vec<(String, String)> = connection
            .prepare(
                "SELECT command_type, payload FROM classification_authority_outbox
                 WHERE state = \'pending\' AND command_type = \'setAssetClassification\'
                 ORDER BY seq",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // Creating the Classification queues its own structural command, so this asserts
        // on the assignment lineage specifically.
        assert_eq!(queued.len(), 1, "exactly one assignment intent must be queued");
        assert_eq!(queued[0].0, "setAssetClassification");
        let payload: serde_json::Value = serde_json::from_str(&queued[0].1).unwrap();
        assert_eq!(payload["assetId"], serde_json::json!(asset_id));
        assert_eq!(payload["classificationId"], serde_json::json!(classification.id));
    }

    /// Without an adopted authority the ingest must stay byte-identical to legacy.
    #[test]
    fn ingest_with_classification_queues_nothing_while_inactive() {
        let fixture = IngestionFixture::new();
        let classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Legacy lane".into(),
                parent_id: None,
            })
            .unwrap();
        fixture.ingest_with_classification(&classification.id);
        let connection = fixture.library.connection().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM classification_authority_outbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0,
            "an inactive authority must not receive commands"
        );
    }

    /// An ingest with no Classification still queues the explicit `null` assignment, which
    /// is how the server learns the Asset exists unclassified rather than never learning.
    #[test]
    fn ingest_without_classification_queues_a_null_assignment() {
        let fixture = IngestionFixture::new();
        fixture
            .library
            .adopt_classification_authority_for_test("e".repeat(32).as_str(), 1, 1, 0)
            .unwrap();
        fixture.ingest();
        let connection = fixture.library.connection().unwrap();
        let payload: String = connection
            .query_row(
                "SELECT payload FROM classification_authority_outbox WHERE state = \'pending\'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["classificationId"], serde_json::Value::Null);
    }

    /// The same rule must hold for the video ingest path.
    #[test]
    fn video_ingest_with_classification_queues_the_assignment_intent() {
        stub_video_probe();
        let fixture = IngestionFixture::new();
        fixture
            .library
            .adopt_classification_authority_for_test("e".repeat(32).as_str(), 1, 1, 0)
            .unwrap();
        let classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Video intent".into(),
                parent_id: None,
            })
            .unwrap();
        let video = fixture._temp.path().join("source.mp4");
        std::fs::copy(&fixture.source, &video).unwrap();
        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: video,
                classification_id: Some(classification.id.clone()),
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000003".into(),
            })
            .unwrap();
        let asset_id = match outcome {
            IngestOutcome::Added { asset } => asset.id,
            other => panic!("expected a new video Asset, got {other:?}"),
        };
        let connection = fixture.library.connection().unwrap();
        let payload: String = connection
            .query_row(
                "SELECT payload FROM classification_authority_outbox
                 WHERE state = \'pending\' AND command_type = \'setAssetClassification\'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["assetId"], serde_json::json!(asset_id));
        assert_eq!(payload["classificationId"], serde_json::json!(classification.id));
    }
