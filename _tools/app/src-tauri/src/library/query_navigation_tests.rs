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
    let sql = scoped_asset_sql(&connection, CHRONO_DESC_HALF_SQL, &query, 1, 9).unwrap();
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
        scoped_asset_sql(&connection, CHRONO_DESC_HALF_SQL, &query, 1, 9).unwrap(),
        std::borrow::Cow::Borrowed(_)
    ));
}
