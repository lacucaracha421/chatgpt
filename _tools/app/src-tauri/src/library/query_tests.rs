    use rusqlite::params;

    use crate::library::{
        error::LibraryError,
        models::{
            AssetAlbumPatch, AssetClassificationPatch, AssetCollectionPatch, AssetCursor,
            AssetDateBucket, AssetDateBucketQuery, AssetPage, AspectRatioFilter, AssetQuery,
            AssetSort, ClassificationKind, CollectionType,
            CreateAlbum, CreateClassification, CreateCollection, ImportSource, MediaKindFilter,
            MediaSummary, UtcDateRange, VideoPreparationState,
        },
        Library,
    };

    #[test]
    fn refreshing_retained_ids_removes_trash_and_filter_departures() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for i in 0..250 { insert_asset(&library, &format!("retained-{i}"), "2026-08-06T00:00:00Z"); }
        let ids = (0..250).map(|i| format!("retained-{i}")).collect::<Vec<_>>();
        assert_eq!(library.refresh_assets(AssetQuery::default(),ids.clone()).unwrap().len(),250);
        library.connection().unwrap().execute("UPDATE assets SET status='trash',trashed_at='2026-08-07' WHERE id='retained-249'",[]).unwrap();
        set_liked(&library, "retained-248");
        let rows=library.refresh_assets(AssetQuery {favorite_only:true,..Default::default()},ids).unwrap();
        assert_eq!(rows.len(),1);assert_eq!(rows[0].id,"retained-248");
    }

    #[test]
    fn exact_collected_range_excludes_neighboring_instants() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "before", "2026-08-05T14:59:59.999Z");
        insert_asset(&library, "inside", "2026-08-05T15:00:00.000Z");
        insert_asset(&library, "after", "2026-08-06T15:00:00.000Z");

        let page = library
            .list_assets(AssetQuery {
                collected_range: Some(UtcDateRange {
                    local_date: "2026-08-06".into(),
                    start_utc: "2026-08-05T15:00:00.000Z".into(),
                    end_utc: "2026-08-06T15:00:00.000Z".into(),
                }),
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["inside"]
        );
    }

    #[test]
    fn date_buckets_apply_the_callers_offset() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "late-utc", "2026-08-05T16:00:00.000Z");

        let buckets = library
            .list_asset_date_buckets(AssetDateBucketQuery {
                start_utc: "2026-07-31T15:00:00.000Z".into(),
                end_utc: "2026-08-31T15:00:00.000Z".into(),
                offset_minutes: 540,
                images_only: false,
                local_days: None,
            })
            .unwrap();

        assert_eq!(
            buckets,
            vec![AssetDateBucket {
                date: "2026-08-06".into(),
                count: 1,
            }]
        );
    }

    #[test]
    fn date_buckets_count_normal_images_across_local_dst_midnights() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        // New York's 2026-11-01 lasts 25 hours. Both instances of 01:30 belong to it.
        for (id, at) in [
            ("before", "2026-11-01T03:59:59.999Z"),
            ("first", "2026-11-01T05:30:00.000Z"),
            ("second", "2026-11-01T06:30:00.000Z"),
            ("gif", "2026-11-02T04:59:59.999Z"),
            ("next-day", "2026-11-02T05:00:00.000Z"),
            ("outside", "2026-11-03T05:00:00.000Z"),
            ("video", "2026-11-01T12:00:00.000Z"),
            ("trash", "2026-11-01T12:00:00.000Z"),
        ] {
            insert_asset(&library, id, at);
        }
        {
            // The library serializes database access, so this guard must end before it is used again.
            let connection = library.connection().unwrap();
            connection.execute("UPDATE assets SET media_kind='gif' WHERE id='gif'", []).unwrap();
            connection.execute("UPDATE assets SET media_kind='video' WHERE id='video'", []).unwrap();
            connection.execute("UPDATE assets SET status='trash', trashed_at='2026-11-02' WHERE id='trash'", []).unwrap();
        }
        let query = AssetDateBucketQuery {
            start_utc: "2026-11-01T00:00:00-04:00".into(),
            end_utc: "2026-11-03T00:00:00-05:00".into(),
            offset_minutes: -240,
            images_only: true,
            local_days: Some(vec![
                UtcDateRange { local_date: "2026-11-01".into(), start_utc: "2026-11-01T00:00:00-04:00".into(), end_utc: "2026-11-02T00:00:00-05:00".into() },
                UtcDateRange { local_date: "2026-11-02".into(), start_utc: "2026-11-02T00:00:00-05:00".into(), end_utc: "2026-11-03T00:00:00-05:00".into() },
            ]),
        };
        assert_eq!(library.list_asset_date_buckets(query.clone()).unwrap(), vec![
            AssetDateBucket { date: "2026-11-02".into(), count: 1 },
            AssetDateBucket { date: "2026-11-01".into(), count: 3 },
        ]);
        // The all-media caller retains its old behavior.
        assert_eq!(library.list_asset_date_buckets(AssetDateBucketQuery { images_only: false, ..query.clone() }).unwrap()[1].count, 4);
        let connection = library.connection().unwrap();
        let plan = connection.prepare(&format!("EXPLAIN QUERY PLAN {}", super::LOCAL_DATE_BUCKETS_SQL)).unwrap()
            .query_map(params!["2026-11-01T04:00:00.000Z", "2026-11-03T05:00:00.000Z", -240, true, "[]"], |row| row.get::<_, String>(3)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap().join("\n");
        assert!(plan.contains("assets_by_collected_at"), "{plan}");
        drop(connection);
        let mut invalid = query;
        invalid.local_days.as_mut().unwrap()[1].start_utc = "2026-11-02T06:00:00Z".into();
        assert!(matches!(library.list_asset_date_buckets(invalid), Err(LibraryError::InvalidAssetDateRange)));
    }

    #[test]
    fn list_assets_returns_tagged_image_gif_and_video_summaries() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        for (id, hash, media_kind, thumbnail, collected_at) in [
            (
                "image-1",
                "hash-image",
                "image",
                Some("thumbnails/image.webp"),
                "2026-08-09T00:00:00Z",
            ),
            (
                "gif-1",
                "hash-gif",
                "gif",
                Some("thumbnails/gif.webp"),
                "2026-08-09T00:00:01Z",
            ),
            (
                "video-1",
                "hash-video",
                "video",
                None,
                "2026-08-09T00:00:02Z",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO assets (
                        id, content_hash, media_kind, original_name, relative_path,
                        thumbnail_relative_path, byte_size, width, height, collected_at
                     ) VALUES (?1, ?2, ?3, ?1, ?4, ?5, 1, 1920, 1080, ?6)",
                    params![
                        id,
                        hash,
                        media_kind,
                        format!("assets/{id}"),
                        thumbnail,
                        collected_at
                    ],
                )
                .unwrap();
        }
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

        let page = library
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
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            page.items[0].media,
            MediaSummary::Video {
                duration_ms: 12_345,
                preparation_state: VideoPreparationState::Pending,
                scrub_frame_count: 0,
            }
        );
        assert_eq!(page.items[1].media, MediaSummary::Gif);
        assert_eq!(page.items[2].media, MediaSummary::Image);
    }

    #[test]
    fn media_and_aspect_filters_apply_before_pagination() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_filter_asset(&library, "image-square", "image", 1000, 1000, "2026-08-08T00:00:00Z");
        insert_filter_asset(&library, "gif-portrait", "gif", 600, 1000, "2026-08-07T00:00:00Z");
        insert_filter_asset(&library, "video-landscape", "video", 1600, 900, "2026-08-06T00:00:00Z");
        insert_filter_asset(&library, "ratio-4x5", "image", 800, 1000, "2026-08-05T00:00:00Z");
        insert_filter_asset(&library, "ratio-1x1", "gif", 1000, 1000, "2026-08-04T00:00:00Z");
        insert_filter_asset(&library, "ratio-5x4", "image", 1250, 1000, "2026-08-03T00:00:00Z");
        insert_filter_asset(&library, "ratio-wide", "image", 1251, 1000, "2026-08-02T00:00:00Z");
        insert_filter_asset(&library, "ratio-tall", "image", 799, 1000, "2026-08-01T00:00:00Z");

        let list = |media_kind, aspect_ratio, limit, after| {
            library
                .list_assets(AssetQuery {
                    media_kind,
                    aspect_ratio,
                    limit,
                    after,
                    sort: AssetSort::Newest,
                    ..Default::default()
                })
                .unwrap()
        };
        let sorted_ids = |page: AssetPage| {
            let mut ids: Vec<_> = page.items.into_iter().map(|asset| asset.id).collect();
            ids.sort();
            ids
        };

        assert_eq!(
            sorted_ids(list(Some(MediaKindFilter::Images), None, 20, None)),
            vec!["gif-portrait", "image-square", "ratio-1x1", "ratio-4x5", "ratio-5x4", "ratio-tall", "ratio-wide"],
        );
        assert_eq!(
            sorted_ids(list(Some(MediaKindFilter::Videos), None, 20, None)),
            vec!["video-landscape"],
        );
        assert_eq!(
            sorted_ids(list(None, Some(AspectRatioFilter::Square), 20, None)),
            vec!["image-square", "ratio-1x1", "ratio-4x5", "ratio-5x4"],
        );
        assert_eq!(
            sorted_ids(list(None, Some(AspectRatioFilter::Landscape), 20, None)),
            vec!["ratio-wide", "video-landscape"],
        );
        assert_eq!(
            sorted_ids(list(None, Some(AspectRatioFilter::Portrait), 20, None)),
            vec!["gif-portrait", "ratio-tall"],
        );

        let first = list(
            Some(MediaKindFilter::Images),
            Some(AspectRatioFilter::Portrait),
            1,
            None,
        );
        assert_eq!(first.items[0].id, "gif-portrait");
        let second = list(
            Some(MediaKindFilter::Images),
            Some(AspectRatioFilter::Portrait),
            1,
            first.next_cursor,
        );
        assert_eq!(second.items[0].id, "ratio-tall");

    }

    #[test]
    fn asset_source_provenance_round_trips_through_queries() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at,
                    source_published_at, creator_name, creator_handle, creator_url,
                    import_source, import_batch_id, original_modified_at
                 ) VALUES (
                    'asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
                    'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z',
                    '2026-08-01T10:20:30Z', 'Example Artist', 'example',
                    'https://x.com/example', 'metadata_import',
                    '31d1f90c-214b-41e2-9d84-f9d964bb5bc3', '2026-07-31T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
        drop(connection);

        let asset = library.get_asset("asset-1").unwrap();
        assert_eq!(
            asset.source_published_at.as_deref(),
            Some("2026-08-01T10:20:30Z")
        );
        assert_eq!(asset.creator_name.as_deref(), Some("Example Artist"));
        assert_eq!(asset.creator_handle.as_deref(), Some("example"));
        assert_eq!(asset.creator_url.as_deref(), Some("https://x.com/example"));
        assert_eq!(asset.import_source, Some(ImportSource::MetadataImport));
        assert_eq!(
            asset.import_batch_id.as_deref(),
            Some("31d1f90c-214b-41e2-9d84-f9d964bb5bc3")
        );
        assert_eq!(
            asset.original_modified_at.as_deref(),
            Some("2026-07-31T09:00:00Z")
        );
    }

    #[test]
    fn descendant_assets_are_included_unless_direct_only_is_requested() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let tag = classification(&library, ClassificationKind::Tag, "아로나", Some(work.id));
        insert_asset(&library, "asset-1", "2026-07-30T00:00:00Z");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-1".into()],
                add_classification_ids: vec![tag.id],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let descendants = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id.clone()),
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();
        let direct = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                album_id: None,
                collection_id: None,
                direct_only: true,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            descendants
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-1"]
        );
        assert!(direct.items.is_empty());
    }

    #[test]
    fn descendant_links_do_not_duplicate_an_asset() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let tag = classification(
            &library,
            ClassificationKind::Tag,
            "아로나",
            Some(work.id.clone()),
        );
        insert_asset(&library, "asset-1", "2026-07-30T00:00:00Z");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-1".into()],
                add_classification_ids: vec![work.id, tag.id],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let page = library
            .list_assets(AssetQuery {
                classification_id: Some(root.id),
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "asset-1");
    }

    #[test]
    fn parent_album_query_includes_descendants_once_and_hides_trash() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let first_child = library
            .create_album(CreateAlbum {
                name: "게임".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let second_child = library
            .create_album(CreateAlbum {
                name: "만화".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        insert_asset(&library, "asset-1", "2026-08-12T00:00:00Z");
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset-1".into()],
                add_album_ids: vec![first_child.id, second_child.id],
                remove_album_ids: Vec::new(),
            })
            .unwrap();
        let query = AssetQuery {
            classification_id: None,
            album_id: Some(root.id),
            collection_id: None,
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort: AssetSort::Newest,
            random_pivot: None,
            after: None,
            limit: 20,
            ..Default::default()
        };

        assert_eq!(library.list_assets(query.clone()).unwrap().items.len(), 1);
        library.trash_assets(&["asset-1".into()]).unwrap();
        assert!(library.list_assets(query.clone()).unwrap().items.is_empty());
        library.restore_asset("asset-1").unwrap();
        assert_eq!(library.list_assets(query).unwrap().items.len(), 1);
    }

    #[test]
    fn collection_query_returns_only_normal_members_and_restores_membership() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        insert_asset(&library, "member", "2026-08-12T00:00:00Z");
        insert_asset(&library, "other", "2026-08-11T00:00:00Z");
        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["member".into()],
                add_collection_ids: vec![collection.id.clone()],
                remove_collection_ids: Vec::new(),
            })
            .unwrap();
        let query = AssetQuery {
            classification_id: None,
            album_id: None,
            collection_id: Some(collection.id),
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort: AssetSort::Newest,
            random_pivot: None,
            after: None,
            limit: 20,
            ..Default::default()
        };

        assert_eq!(
            library
                .list_assets(query.clone())
                .unwrap()
                .items
                .into_iter()
                .map(|asset| asset.id)
                .collect::<Vec<_>>(),
            vec!["member"]
        );
        library.trash_assets(&["member".into()]).unwrap();
        assert!(library.list_assets(query.clone()).unwrap().items.is_empty());
        assert_eq!(
            library
                .get_collection(query.collection_id.as_deref().unwrap())
                .unwrap()
                .asset_count,
            0
        );
        library.restore_asset("member").unwrap();
        assert_eq!(library.list_assets(query).unwrap().items.len(), 1);
    }

    #[test]
    fn rejects_collection_combined_with_another_location_scope() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "Covers".into(),
                parent_id: None,
            })
            .unwrap();

        let error = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: Some(album.id),
                collection_id: Some(collection.id),
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidAssetScope));
    }

    #[test]
    fn rejects_simultaneous_folder_and_album_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let folder = classification(&library, ClassificationKind::Root, "게임", None);
        let album = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();

        let error = library
            .list_assets(AssetQuery {
                classification_id: Some(folder.id),
                album_id: Some(album.id),
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 20,
                ..Default::default()
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidAssetScope));
    }

    #[test]
    fn unclassified_query_returns_only_assets_without_classification_links() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        insert_asset(&library, "unclassified", "2026-07-31T00:00:00Z");
        insert_asset(&library, "unclassified-older", "2026-07-29T00:00:00Z");
        insert_asset(&library, "classified", "2026-07-30T00:00:00Z");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["classified".into()],
                add_classification_ids: vec![root.id],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let first = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: true,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: None,
                limit: 1,
                ..Default::default()
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: true,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: first.next_cursor.clone(),
                limit: 1,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            first
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["unclassified"]
        );
        assert_eq!(
            second
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["unclassified-older"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn keyset_pages_follow_collected_at_and_id_without_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-a", "2026-07-30T00:00:00Z");
        insert_asset(&library, "asset-b", "2026-07-31T00:00:00Z");
        insert_asset(&library, "asset-c", "2026-07-30T00:00:00Z");

        let first = library
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
                limit: 2,
                ..Default::default()
            })
            .unwrap();
        let second = library
            .list_assets(AssetQuery {
                classification_id: None,
                album_id: None,
                collection_id: None,
                direct_only: false,
                favorite_only: false,
                unclassified_only: false,
                sort: AssetSort::Newest,
                random_pivot: None,
                after: first.next_cursor.clone(),
                limit: 2,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(
            first
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-b", "asset-c"]
        );
        assert_eq!(
            second
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            ["asset-a"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn total_count_covers_all_pages_sorts_and_filters() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        insert_asset_with_fields(&library, "a", "hash-a", "2026-07-30T00:00:00Z", false);
        insert_asset_with_fields(&library, "b", "hash-b", "2026-07-31T00:00:00Z", true);
        insert_asset_with_fields(&library, "c", "hash-c", "2026-07-30T00:00:00Z", false);
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["c".into()],
                add_classification_ids: vec![root.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 2;
        let first = library.list_assets(query.clone()).unwrap();
        assert_eq!(first.total_count, 3);
        let mut next = query.clone();
        next.after = first.next_cursor.clone();
        let second = library.list_assets(next).unwrap();
        assert_eq!(second.total_count, 3);

        let mut oldest = chrono_query(AssetSort::Oldest);
        oldest.limit = 2;
        assert_eq!(library.list_assets(oldest).unwrap().total_count, 3);

        let mut favorites = chrono_query(AssetSort::Favorites);
        favorites.favorite_only = true;
        assert_eq!(library.list_assets(favorites).unwrap().total_count, 1);

        let mut scoped = chrono_query(AssetSort::Newest);
        scoped.classification_id = Some(root.id);
        assert_eq!(library.list_assets(scoped).unwrap().total_count, 1);

        let mut unclassified = chrono_query(AssetSort::Newest);
        unclassified.unclassified_only = true;
        assert_eq!(library.list_assets(unclassified).unwrap().total_count, 2);

        let mut random = chrono_query(AssetSort::Random);
        random.random_pivot = Some("pivot".into());
        assert_eq!(library.list_assets(random).unwrap().total_count, 3);
    }

    #[test]
    fn total_count_matches_anchor_and_before_windows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for day in 26..=31 {
            insert_asset(
                &library,
                &format!("a{day}"),
                &format!("2026-07-{day:02}T00:00:00Z"),
            );
        }

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 4;
        query.around_date = Some("2026-07-29".into());
        let anchor = library.list_assets(query.clone()).unwrap();
        assert_eq!(anchor.total_count, 6);

        query.around_date = None;
        query.before = anchor.previous_cursor.clone();
        let head = library.list_assets(query).unwrap();
        assert_eq!(head.total_count, 6);
    }

    fn insert_matrix_asset(
        library: &Library,
        id: &str,
        media_kind: &str,
        width: i64,
        height: i64,
        creator: Option<&str>,
        collected_at: &str,
        favorite: bool,
    ) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height,
                    collected_at, favorite, creator_handle
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    media_kind,
                    format!("{id}.bin"),
                    format!("assets/{id}.bin"),
                    format!("thumbnails/{id}.webp"),
                    width,
                    height,
                    collected_at,
                    favorite,
                    creator,
                ],
            )
            .unwrap();
        if favorite { set_liked(library, id); }
    }

    fn matrix_totals(library: &Library, mutate: impl FnOnce(&mut AssetQuery)) -> (usize, u64) {
        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 20;
        mutate(&mut query);
        let page = library.list_assets(query).unwrap();
        (page.items.len(), page.total_count)
    }

    #[test]
    fn total_count_matches_items_across_the_full_filter_matrix() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_matrix_asset(
            &library,
            "land",
            "image",
            400,
            200,
            Some("hana"),
            "2026-07-30T00:00:00Z",
            false,
        );
        insert_matrix_asset(
            &library,
            "port",
            "image",
            200,
            400,
            Some("hana"),
            "2026-07-31T00:00:00Z",
            false,
        );
        insert_matrix_asset(
            &library,
            "sq",
            "image",
            200,
            200,
            Some("other"),
            "2026-07-29T00:00:00Z",
            false,
        );
        insert_matrix_asset(
            &library,
            "vid",
            "video",
            640,
            360,
            Some("hana"),
            "2026-07-28T00:00:00Z",
            false,
        );
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO video_assets (asset_id, duration_ms, container, video_codec, preparation_state)
                 VALUES ('vid', 10000, 'mp4', 'h264', 'pending')",
                [],
            )
            .unwrap();
        insert_matrix_asset(
            &library,
            "fav",
            "image",
            800,
            600,
            None,
            "2026-07-27T00:00:00Z",
            true,
        );
        insert_matrix_asset(
            &library,
            "anim",
            "gif",
            100,
            100,
            None,
            "2026-07-26T00:00:00Z",
            false,
        );

        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let child = classification(
            &library,
            ClassificationKind::Tag,
            "하위",
            Some(root.id.clone()),
        );
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["land".into()],
                add_classification_ids: vec![root.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["port".into()],
                add_classification_ids: vec![child.id],
                remove_classification_ids: vec![],
            })
            .unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["sq".into()],
                add_album_ids: vec![album.id.clone()],
                remove_album_ids: vec![],
            })
            .unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Ref".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["vid".into()],
                add_collection_ids: vec![collection.id.clone()],
                remove_collection_ids: vec![],
            })
            .unwrap();

        assert_eq!(matrix_totals(&library, |_| {}), (6, 6));
        assert_eq!(
            matrix_totals(&library, |query| query.media_kind =
                Some(MediaKindFilter::Images)),
            (5, 5)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.media_kind =
                Some(MediaKindFilter::Videos)),
            (1, 1)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.aspect_ratio =
                Some(AspectRatioFilter::Landscape)),
            (3, 3)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.aspect_ratio =
                Some(AspectRatioFilter::Portrait)),
            (1, 1)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.aspect_ratio =
                Some(AspectRatioFilter::Square)),
            (2, 2)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.creator_key = Some("hana".into())),
            (3, 3)
        );
        assert_eq!(
            matrix_totals(&library, |query| {
                query.classification_id = Some(root.id.clone());
                query.direct_only = true;
            }),
            (1, 1)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.classification_id =
                Some(root.id.clone())),
            (2, 2)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.album_id = Some(album.id.clone())),
            (1, 1)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.collection_id =
                Some(collection.id.clone())),
            (1, 1)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.favorite_only = true),
            (1, 1)
        );
        assert_eq!(
            matrix_totals(&library, |query| query.unclassified_only = true),
            (4, 4)
        );
        assert_eq!(
            matrix_totals(&library, |query| {
                query.collected_range = Some(crate::library::models::UtcDateRange {
                    local_date: "2026-07-30".into(),
                    start_utc: "2026-07-29T00:00:00Z".into(),
                    end_utc: "2026-08-01T00:00:00Z".into(),
                })
            }),
            (3, 3)
        );
    }

    fn chrono_query(sort: AssetSort) -> AssetQuery {
        AssetQuery {
            classification_id: None,
            album_id: None,
            collection_id: None,
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort,
            random_pivot: None,
            after: None,
            limit: 100,
            ..Default::default()
        }
    }

    fn ids(page: &AssetPage) -> Vec<&str> {
        page.items.iter().map(|asset| asset.id.as_str()).collect()
    }

    #[test]
    fn anchor_query_loads_assets_on_both_sides_of_the_target_date() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "n1", "2026-08-01T09:00:00Z");
        insert_asset(&library, "o1", "2026-07-31T13:00:00Z");
        insert_asset(&library, "o2", "2026-07-31T12:00:00Z");
        insert_asset(&library, "o3", "2026-07-31T11:00:00Z");
        insert_asset(&library, "p1", "2026-07-30T15:00:00Z");
        insert_asset(&library, "p2", "2026-07-30T10:00:00Z");
        insert_asset(&library, "q1", "2026-07-29T08:00:00Z");

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 6;
        query.around_date = Some("2026-07-31".into());
        let window = library.list_assets(query.clone()).unwrap();

        // Half window is 3: head keeps [n1] (fewer newer assets exist), tail
        // starts at the boundary with the three newest 07-31 assets.
        assert_eq!(ids(&window), ["n1", "o1", "o2", "o3"]);
        assert!(window.previous_cursor.is_none());
        assert!(window.next_cursor.is_some());
    }

    #[test]
    fn anchor_window_paginates_in_both_directions_without_gaps_or_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for day in 26..=31 {
            for slot in 0..4i32 {
                insert_asset(
                    &library,
                    &format!("a{day}-{slot}"),
                    &format!("2026-07-{day:02}T{slot:02}:00:00Z"),
                );
            }
        }
        // 24 assets from 07-26 to 07-31. Display order (newest first) is the
        // exact reverse of insertion order.

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 8;
        query.around_date = Some("2026-07-29".into());
        let anchor = library.list_assets(query.clone()).unwrap();
        assert_eq!(anchor.items.len(), 8);
        assert!(anchor.previous_cursor.is_some());
        assert!(anchor.next_cursor.is_some());

        // Walk upward to the very top.
        let mut upward = Vec::new();
        let mut cursor = anchor.previous_cursor.clone();
        while let Some(token) = cursor {
            query.after = None;
            query.before = Some(token);
            query.around_date = None;
            let page = library.list_assets(query.clone()).unwrap();
            let reached_top = page.previous_cursor.is_none();
            upward.extend(page.items.iter().map(|asset| asset.id.clone()));
            cursor = page.previous_cursor;
            if reached_top {
                break;
            }
        }

        // Walk downward to the very bottom.
        let mut downward = Vec::new();
        let mut cursor = anchor.next_cursor.clone();
        while let Some(token) = cursor {
            query.before = None;
            query.after = Some(token);
            let page = library.list_assets(query.clone()).unwrap();
            downward.extend(page.items.iter().map(|asset| asset.id.clone()));
            cursor = page.next_cursor;
        }

        let expected: Vec<String> = library
            .list_assets(chrono_query(AssetSort::Newest))
            .unwrap()
            .items
            .into_iter()
            .map(|asset| asset.id)
            .collect();
        let mut combined = upward;
        combined.extend(anchor.items.iter().map(|asset| asset.id.clone()));
        combined.extend(downward);
        assert_eq!(combined, expected);
    }

    #[test]
    fn anchor_window_works_for_oldest_sort_and_keeps_display_order() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "old", "2026-07-28T09:00:00Z");
        insert_asset(&library, "d1", "2026-07-29T10:00:00Z");
        insert_asset(&library, "d2", "2026-07-29T11:00:00Z");
        insert_asset(&library, "d3", "2026-07-29T12:00:00Z");
        insert_asset(&library, "new1", "2026-07-30T09:00:00Z");
        insert_asset(&library, "new2", "2026-07-30T10:00:00Z");

        let mut query = chrono_query(AssetSort::Oldest);
        query.limit = 6;
        query.around_date = Some("2026-07-30".into());
        let window = library.list_assets(query.clone()).unwrap();

        // Oldest display order is ascending; the boundary sits at day start,
        // so the head keeps the three newest pre-day assets and the tail the
        // two assets of 07-30.
        assert_eq!(ids(&window), ["d1", "d2", "d3", "new1", "new2"]);
        assert!(window.previous_cursor.is_some());
        assert!(window.next_cursor.is_none());

        query.before = window.previous_cursor.clone();
        query.around_date = None;
        let head = library.list_assets(query).unwrap();
        assert_eq!(ids(&head), ["old"]);
        assert!(head.previous_cursor.is_none());
    }

    #[test]
    fn identical_timestamps_keep_stable_order_across_anchor_pages() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "u1", "2026-07-31T11:00:00Z");
        insert_asset(&library, "u2", "2026-07-31T12:00:00Z");
        insert_asset(&library, "u3", "2026-07-31T13:00:00Z");
        insert_asset(&library, "top", "2026-07-31T09:00:00Z");
        insert_asset(&library, "t1", "2026-07-30T00:00:00Z");
        insert_asset(&library, "t2", "2026-07-30T00:00:00Z");
        insert_asset(&library, "t3", "2026-07-30T00:00:00Z");
        insert_asset(&library, "bottom", "2026-07-29T09:00:00Z");

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 4;
        query.around_date = Some("2026-07-30".into());
        let window = library.list_assets(query.clone()).unwrap();

        // Newest-first display: u3,u2,u1,top | t3,t2,t1,bottom. The window
        // keeps the two assets adjacent above the 07-31/07-30 boundary and
        // the first two below it, with cursors for both directions.
        assert_eq!(ids(&window), ["u1", "top", "t3", "t2"]);
        assert!(window.previous_cursor.is_some());
        assert!(window.next_cursor.is_some());

        query.before = window.previous_cursor.clone();
        query.around_date = None;
        let head = library.list_assets(query.clone()).unwrap();
        assert_eq!(ids(&head), ["u3", "u2"]);
        assert!(head.previous_cursor.is_none());

        query.after = window.next_cursor;
        query.before = None;
        let tail = library.list_assets(query).unwrap();
        assert_eq!(ids(&tail), ["t1", "bottom"]);
        assert!(tail.next_cursor.is_none());

        // Oldest sort mirrors the behavior with the boundary at day start.
        let mut query = chrono_query(AssetSort::Oldest);
        query.limit = 4;
        query.around_date = Some("2026-07-31".into());
        let oldest_window = library.list_assets(query.clone()).unwrap();
        // Head keeps the two assets adjacent below 07-31 (reversed), tail the
        // two oldest 07-31 assets.
        assert_eq!(ids(&oldest_window), ["t2", "t3", "top", "u1"]);
        assert!(oldest_window.previous_cursor.is_some());
        assert!(oldest_window.next_cursor.is_some());
        query.before = oldest_window.previous_cursor;
        query.around_date = None;
        let oldest_head = library.list_assets(query).unwrap();
        assert_eq!(ids(&oldest_head), ["bottom", "t1"]);
    }

    #[test]
    fn scope_filters_apply_to_anchor_and_before_pagination() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = classification(&library, ClassificationKind::Root, "게임", None);
        let work = classification(
            &library,
            ClassificationKind::Work,
            "블루 아카이브",
            Some(root.id.clone()),
        );
        let timestamps = [
            ("in-top", "2026-08-01T11:00:00Z"),
            ("in-newest", "2026-08-01T10:00:00Z"),
            ("in-newer", "2026-08-01T09:00:00Z"),
            ("in-day", "2026-07-30T00:00:00Z"),
            ("in-older", "2026-07-29T00:00:00Z"),
            ("out-day", "2026-07-30T12:00:00Z"),
        ];
        for (id, collected_at) in timestamps {
            insert_asset(&library, id, collected_at);
        }
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec![
                    "in-top".into(),
                    "in-newest".into(),
                    "in-newer".into(),
                    "in-day".into(),
                    "in-older".into(),
                ],
                add_classification_ids: vec![work.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        let mut query = chrono_query(AssetSort::Newest);
        query.limit = 4;
        query.classification_id = Some(work.id.clone());
        query.around_date = Some("2026-07-30".into());
        // Half window is 2 and the untagged asset stays out of both halves.
        let window = library.list_assets(query.clone()).unwrap();
        assert_eq!(ids(&window), ["in-newest", "in-newer", "in-day", "in-older"]);
        assert!(window.previous_cursor.is_some());
        assert!(window.next_cursor.is_none());

        query.before = window.previous_cursor;
        query.around_date = None;
        let head = library.list_assets(query).unwrap();
        assert_eq!(ids(&head), ["in-top"]);
    }

    #[test]
    fn anchor_rejects_invalid_dates_and_non_chronological_sorts() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let mut query = chrono_query(AssetSort::Newest);
        query.around_date = Some("not-a-date".into());
        assert!(matches!(
            library.list_assets(query.clone()),
            Err(LibraryError::InvalidAssetCursor)
        ));

        query.sort = AssetSort::Favorites;
        query.around_date = Some("2026-07-30".into());
        assert!(matches!(
            library.list_assets(query.clone()),
            Err(LibraryError::InvalidAssetCursor)
        ));

        query.sort = AssetSort::Random;
        query.random_pivot = Some(hash('a'));
        assert!(matches!(
            library.list_assets(query),
            Err(LibraryError::InvalidAssetCursor)
        ));
    }

    #[test]
    fn page_limit_must_be_between_one_and_two_hundred() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for limit in [0, 201] {
            let error = library
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
                    limit,
                    ..Default::default()
                })
                .unwrap_err();

            assert!(matches!(error, LibraryError::InvalidAssetPageLimit));
        }
    }

    #[test]
    fn querying_a_missing_classification_returns_the_established_error() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        for direct_only in [false, true] {
            let error = library
                .list_assets(AssetQuery {
                    classification_id: Some("missing-classification".into()),
                    album_id: None,
                    collection_id: None,
                    direct_only,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit: 20,
                    ..Default::default()
                })
                .unwrap_err();

            assert!(matches!(error, LibraryError::ClassificationNotFound));
        }
    }

    #[test]
    fn stable_sorts_page_without_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset_with_fields(&library, "a", &hash('1'), "2026-07-30T00:00:00Z", false);
        insert_asset_with_fields(&library, "b", &hash('4'), "2026-07-30T00:00:00Z", true);
        insert_asset_with_fields(&library, "c", &hash('8'), "2026-07-31T00:00:00Z", false);
        insert_asset_with_fields(&library, "d", &hash('c'), "2026-07-31T00:00:00Z", true);

        assert_eq!(
            two_pages(&library, AssetSort::Newest, None),
            ["d", "c", "b", "a"]
        );
        assert_eq!(
            two_pages(&library, AssetSort::Oldest, None),
            ["a", "b", "c", "d"]
        );
        assert_eq!(
            two_pages(&library, AssetSort::Favorites, None),
            ["d", "b", "c", "a"]
        );
    }

    #[test]
    fn random_sort_uses_a_stable_pivot_and_validates_cursors() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for (id, hex) in [("a", '1'), ("b", '4'), ("c", '8'), ("d", 'c')] {
            insert_asset_with_fields(&library, id, &hash(hex), "2026-07-30T00:00:00Z", false);
        }

        let first = two_pages(&library, AssetSort::Random, Some("8"));
        let second = two_pages(&library, AssetSort::Random, Some("8"));
        assert_eq!(
            first, second,
            "the same pivot must return the same complete order"
        );
        assert_eq!(first.len(), 4);
        for id in ["a", "b", "c", "d"] {
            assert_eq!(first.iter().filter(|current| current == &id).count(), 1);
        }

        let malformed = library
            .list_assets(AssetQuery {
                after: Some(AssetCursor {
                    token: "not-json".into(),
                }),
                ..query(AssetSort::Newest, None)
            })
            .unwrap_err();
        assert!(matches!(malformed, LibraryError::InvalidAssetCursor));

        let newest = library.list_assets(query(AssetSort::Newest, None)).unwrap();
        let wrong_sort = library
            .list_assets(AssetQuery {
                after: newest.next_cursor,
                ..query(AssetSort::Oldest, None)
            })
            .unwrap_err();
        assert!(matches!(wrong_sort, LibraryError::InvalidAssetCursor));
    }

    fn two_pages(library: &Library, sort: AssetSort, random_pivot: Option<&str>) -> Vec<String> {
        let first = library.list_assets(query(sort, random_pivot)).unwrap();
        let second = library
            .list_assets(AssetQuery {
                after: first.next_cursor.clone(),
                ..query(sort, random_pivot)
            })
            .unwrap();
        first
            .items
            .into_iter()
            .chain(second.items)
            .map(|asset| asset.id)
            .collect()
    }

    fn query(sort: AssetSort, random_pivot: Option<&str>) -> AssetQuery {
        AssetQuery {
            classification_id: None,
            album_id: None,
            collection_id: None,
            direct_only: false,
            favorite_only: false,
            unclassified_only: false,
            sort,
            random_pivot: random_pivot.map(str::to_owned),
            after: None,
            limit: 2,
            ..Default::default()
        }
    }

    fn hash(hex: char) -> String {
        std::iter::repeat_n(hex, 64).collect()
    }

    fn classification(
        library: &Library,
        kind: ClassificationKind,
        name: &str,
        parent_id: Option<String>,
    ) -> crate::library::models::ClassificationEntry {
        library
            .create_classification(CreateClassification {
                kind,
                name: name.into(),
                parent_id,
            })
            .unwrap()
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str) {
        insert_asset_with_fields(library, id, &format!("hash-{id}"), collected_at, false);
    }

    fn set_liked(library: &Library, id: &str) {
        let album = library.ensure_likes_album().unwrap();
        library.patch_asset_albums(AssetAlbumPatch {
            asset_ids: vec![id.into()],
            add_album_ids: vec![album.id],
            remove_album_ids: vec![],
        }).unwrap();
    }

    fn insert_asset_with_fields(
        library: &Library,
        id: &str,
        content_hash: &str,
        collected_at: &str,
        favorite: bool,
    ) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, favorite
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 400, 200, ?6, ?7)",
                params![
                    id,
                    content_hash,
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    collected_at,
                    favorite,
                ],
            )
            .unwrap();
        if favorite { set_liked(library, id); }
    }

    fn insert_filter_asset(
        library: &Library,
        id: &str,
        media_kind: &str,
        width: i64,
        height: i64,
        collected_at: &str,
    ) {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, favorite
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, 0)",
                params![
                    id,
                    format!("hash-{id}"),
                    media_kind,
                    format!("{id}.bin"),
                    format!("assets/{id}.bin"),
                    format!("thumbnails/{id}.webp"),
                    width,
                    height,
                    collected_at,
                ],
            )
            .unwrap();
        if media_kind == "video" {
            connection
                .execute(
                    "INSERT INTO video_assets (
                        asset_id, duration_ms, container, video_codec, audio_codec,
                        preparation_state, scrub_frame_count
                     ) VALUES (?1, 1000, 'mp4', 'h264', 'aac', 'pending', 0)",
                    [id],
                )
                .unwrap();
        }
    }
