use super::*;

fn fixture(count: usize) -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    {
        let mut connection = library.connection().unwrap();
        let tx = connection.transaction().unwrap();
        tx.execute("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('nav-folder','work','Navigation fixture','2026-01-01')", []).unwrap();
        {
            let mut insert = tx.prepare("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,creator_handle) VALUES(?1,?1,'image',?1,?1,?1,1024,800,1200,'2026-01-01T00:00:00.000Z',?2)").unwrap();
            for i in 0..count {
                insert
                    .execute(params![
                        format!("nav-{i:08}"),
                        format!("creator-{:04}", i / 100)
                    ])
                    .unwrap();
            }
        }
        tx.execute("INSERT INTO asset_classifications(asset_id,classification_id) SELECT id,'nav-folder' FROM assets ORDER BY id LIMIT 20", []).unwrap();
        tx.commit().unwrap();
    }
    (temp, library)
}

#[test]
fn list_assets_reuses_filtered_count_across_navigation_and_refreshes_after_writes() {
    let (_temp, library) = fixture(6);
    let likes_album = library.ensure_likes_album().unwrap();
    let query = AssetQuery {
        limit: 2,
        ..Default::default()
    };
    FILTERED_COUNTS.with(|count| count.set(0));
    let first = library.list_assets(query.clone()).unwrap();
    assert_eq!(first.total_count, 6);
    let second = library
        .clone()
        .list_assets(AssetQuery {
            after: first.next_cursor,
            ..query.clone()
        })
        .unwrap();
    assert_eq!(second.total_count, 6);
    assert_ne!(first.items[0].id, second.items[0].id);
    let before = encode_cursor(&query, &chrono_row(&second.items[0]));
    let previous = library
        .list_assets(AssetQuery {
            before: Some(before),
            ..query.clone()
        })
        .unwrap();
    assert_eq!(previous.total_count, 6);
    assert_eq!(previous.items[0].id, first.items[0].id);
    let anchored = library
        .list_assets(AssetQuery {
            around_date: Some("2026-01-01".into()),
            ..query.clone()
        })
        .unwrap();
    assert_eq!(anchored.total_count, 6);
    for sort in [AssetSort::Oldest, AssetSort::Favorites, AssetSort::Random] {
        let sorted = library
            .list_assets(AssetQuery {
                sort,
                random_pivot: Some("pivot".into()),
                limit: 3,
                ..query.clone()
            })
            .unwrap();
        assert_eq!(sorted.total_count, 6);
    }
    assert_eq!(FILTERED_COUNTS.with(|count| count.get()), 1);

    library.connection().unwrap().execute(
        "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES('added','added','image','added','added','added',1024,800,1200,'2026-01-02T00:00:00.000Z')", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 7);
    library.connection().unwrap().execute(
        "UPDATE assets SET status='trash' WHERE id='added'", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 6);
    let favorites = AssetQuery {
        favorite_only: true,
        ..query.clone()
    };
    assert_eq!(library.list_assets(favorites.clone()).unwrap().total_count, 0);
    library.connection().unwrap().execute(
        "INSERT INTO asset_albums(asset_id,album_id) VALUES('nav-00000000',?1)", [&likes_album.id]
    ).unwrap();
    assert_eq!(library.list_assets(favorites.clone()).unwrap().total_count, 1);
    assert_eq!(library.list_assets(query).unwrap().total_count, 6);
    assert_eq!(FILTERED_COUNTS.with(|count| count.get()), 6);
    library.connection().unwrap().execute(
        "INSERT INTO albums(id,name,created_at) VALUES('empty-likes','Empty likes','2026-01-01')", []
    ).unwrap();
    assert_eq!(library.list_assets(favorites.clone()).unwrap().total_count, 1);
    library.connection().unwrap().execute(
        "UPDATE library_settings SET likes_album_id='empty-likes' WHERE singleton=1", []
    ).unwrap();
    assert_eq!(library.list_assets(favorites).unwrap().total_count, 0);
}

#[test]
fn list_assets_count_cache_tracks_auto_tag_filters_and_without_rowid_writes() {
    let (_temp, library) = fixture(3);
    let query = AssetQuery {
        auto_tags: Some(super::super::models::AutoTagFilter {
            include: vec!["sample".into()],
            exclude: vec![],
        }),
        limit: 2,
        ..Default::default()
    };
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 0);
    library.connection().unwrap().execute(
        "INSERT INTO asset_auto_tags(asset_id,tag,score) VALUES('nav-00000000','sample',0.5)", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 1);
    library.connection().unwrap().execute(
        "INSERT INTO auto_tag_vocabulary(tag,category) VALUES('sample','character')", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 0);
    library.connection().unwrap().execute(
        "INSERT INTO asset_auto_tag_edits(asset_id,tag,state,created_at) VALUES('nav-00000001','sample','added','2026-01-01')", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 1);
    let excluded = AssetQuery {
        auto_tags: Some(super::super::models::AutoTagFilter {
            include: vec![],
            exclude: vec!["sample".into()],
        }),
        ..query.clone()
    };
    assert_eq!(library.list_assets(excluded).unwrap().total_count, 2);
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM asset_auto_tag_edits", [])
        .unwrap();
    assert_eq!(library.list_assets(query).unwrap().total_count, 0);
}

#[test]
fn list_assets_count_cache_tracks_artist_scope_view_inputs() {
    let (_temp, library) = fixture(3);
    library.connection().unwrap().execute_batch(
        "INSERT INTO artists(id,created_at,updated_at) VALUES('first','2026-01-01','2026-01-01');
         INSERT INTO artists(id,created_at,updated_at) VALUES('second','2026-01-01','2026-01-01');"
    ).unwrap();
    let query = AssetQuery {
        creator_key: Some("artist:first".into()),
        limit: 2,
        ..Default::default()
    };
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 0);
    library.connection().unwrap().execute(
        "INSERT INTO artist_members(creator_key,artist_id,added_at) VALUES('creator-0000','first','2026-01-01')", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 3);
    library.connection().unwrap().execute(
        "INSERT INTO asset_artist_assignments(asset_id,artist_id,source,created_at) VALUES('nav-00000000','second','manual','2026-01-01')", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 2);
    library.connection().unwrap().execute(
        "INSERT INTO artist_excluded_classifications(classification_id,added_at) VALUES('nav-folder','2026-01-01')", []
    ).unwrap();
    assert_eq!(library.list_assets(query.clone()).unwrap().total_count, 0);
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM artist_excluded_classifications", [])
        .unwrap();
    assert_eq!(library.list_assets(query).unwrap().total_count, 2);
}

#[test]
fn creator_navigation_keeps_each_creator_and_activity_separate() {
    let (_temp, library) = fixture(250);
    library
        .record_asset_opened("nav-00000099", "2026-02-01T00:00:00Z")
        .unwrap();
    let creators = library.list_asset_creators(AssetQuery::default()).unwrap();
    assert_eq!(creators.len(), 3);
    assert_eq!(
        creators.iter().map(|c| c.asset_count).collect::<Vec<_>>(),
        vec![100, 100, 50]
    );
    assert_eq!(creators[0].key, "creator-0000");
    assert_eq!(
        creators[0].last_opened_at.as_deref(),
        Some("2026-02-01T00:00:00Z")
    );
    assert_eq!(creators[1].last_opened_at, None);
    assert_eq!(creators[0].cover_asset_ids.len(), 8);
    assert!(creators[0]
        .cover_asset_ids
        .iter()
        .all(|id| id.starts_with("nav-000000")));
}

#[test]
fn creator_navigation_without_creators_is_empty() {
    let (_temp, library) = fixture(0);
    assert!(library
        .list_asset_creators(AssetQuery::default())
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "synthetic navigation benchmark; no production library or media"]
fn navigation_query_benchmark() {
    let (_temp, library) = fixture(50_000);
    for (name, query) in [
        (
            "all",
            AssetQuery {
                limit: 100,
                ..Default::default()
            },
        ),
        (
            "sparse_folder",
            AssetQuery {
                classification_id: Some("nav-folder".into()),
                limit: 100,
                ..Default::default()
            },
        ),
    ] {
        let started = std::time::Instant::now();
        let page = library.list_assets(query).unwrap();
        println!(
            "navigation {name}: {:?}, rows={}, total={}",
            started.elapsed(),
            page.items.len(),
            page.total_count
        );
    }
    let started = std::time::Instant::now();
    let creators = library.list_asset_creators(AssetQuery::default()).unwrap();
    println!(
        "navigation creators: {:?}, rows={}",
        started.elapsed(),
        creators.len()
    );
}

#[test]
fn small_folder_uses_membership_and_asset_id_indexes() {
    let (_temp, library) = fixture(50);
    let connection = library.connection().unwrap();
    let query = AssetQuery {
        classification_id: Some("nav-folder".into()),
        limit: 100,
        ..Default::default()
    };
    let sql = scoped_asset_sql(&connection, CHRONO_DESC_HALF_SQL.as_str(), &query, 1, 9).unwrap();
    let mut statement = connection
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap();
    let plan = statement
        .query_map(
            params![
                "nav-folder",
                false,
                false,
                false,
                None::<String>,
                None::<String>,
                None::<String>,
                None::<String>,
                None::<String>,
                101,
                None::<String>,
                None::<String>,
                None::<String>,
                None::<String>,
                None::<String>
            ],
            |row| row.get::<_, String>(3),
        )
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    assert!(
        plan.contains("asset_classifications_by_classification"),
        "{plan}"
    );
    assert!(
        plan.contains("SEARCH asset USING INDEX sqlite_autoindex_assets_1 (id=?)"),
        "{plan}"
    );
    assert!(!plan.contains("assets_by_collected_at"), "{plan}");
}

#[test]
fn broad_folder_keeps_ordered_scan() {
    let (_temp, library) = fixture(1_100);
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT OR IGNORE INTO asset_classifications SELECT id,'nav-folder' FROM assets",
            [],
        )
        .unwrap();
    let query = AssetQuery {
        classification_id: Some("nav-folder".into()),
        limit: 100,
        ..Default::default()
    };
    assert!(matches!(
        scoped_asset_sql(&connection, CHRONO_DESC_HALF_SQL.as_str(), &query, 1, 9).unwrap(),
        std::borrow::Cow::Borrowed(_)
    ));
}
