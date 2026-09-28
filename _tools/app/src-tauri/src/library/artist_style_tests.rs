use super::*;

fn fixture() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path()).unwrap();
    (dir, library)
}
fn asset(library: &Library, id: &str, artist: Option<&str>, source: Option<&str>) {
    library.connection().unwrap().execute(
        "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,creator_handle,source_url) VALUES(?1,?1,'image',?1,?1,?1,1,10,10,'2026-09-28T00:00:00Z',?2,?3)",params![id,artist,source]).unwrap();
}
fn blob(values: &[f32]) -> Vec<u8> {
    // Test inputs use exactly representable, small normal binary16 numbers or zero.
    let mut out = vec![0; DIM * 2];
    for (i, &value) in values.iter().enumerate() {
        let bits = value.to_bits();
        let half = if value == 0.0 {
            0
        } else {
            (((bits >> 16) & 0x8000) | ((((bits >> 23) & 255) - 112) << 10) | ((bits >> 13) & 1023))
                as u16
        };
        out[i * 2..i * 2 + 2].copy_from_slice(&half.to_le_bytes());
    }
    out
}
fn import_file(dir: &Path, rows: &[(&str, &[f32])]) -> PathBuf {
    let path = dir.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value);CREATE TABLE features(asset_id TEXT PRIMARY KEY,vector BLOB NOT NULL);").unwrap();
    conn.execute(
        "INSERT INTO meta VALUES('model','kaloscope2'),('dim','2048'),('mean',?1)",
        [vec![0u8; DIM * 4]],
    )
    .unwrap();
    for (id, values) in rows {
        conn.execute(
            "INSERT INTO features VALUES(?1,?2)",
            params![id, blob(values)],
        )
        .unwrap();
    }
    path
}
fn basic() -> (tempfile::TempDir, Library) {
    let (dir, lib) = fixture();
    asset(&lib, "a", Some("alice"), None);
    asset(&lib, "b", Some("bob"), None);
    asset(&lib, "c", None, None);
    let path = import_file(
        dir.path(),
        &[("a", &[1., 0.]), ("b", &[0., 1.]), ("c", &[4., 3.])],
    );
    lib.import_artist_style_features(&path).unwrap();
    (dir, lib)
}

#[test]
fn excluded_folders_are_absent_from_artist_style_inputs() {
    let (_dir, lib) = fixture();
    asset(&lib, "kept", Some("alice"), None);
    asset(&lib, "excluded", Some("alice"), None);
    lib.connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES('ai','root','ai',NULL,'t');
             INSERT INTO asset_classifications(asset_id,classification_id) VALUES('excluded','ai');",
        )
        .unwrap();
    lib.set_artist_excluded_folders(&["ai".into()]).unwrap();

    let inputs = inputs(&lib.connection().unwrap()).unwrap();
    assert_eq!(
        inputs.assets.iter().map(|asset| asset.id.as_str()).collect::<Vec<_>>(),
        vec!["kept"]
    );
    assert_eq!(inputs.excluded_classifications, vec!["ai"]);
    assert!(inputs.artists.contains_key("alice"));
}

#[test]
fn import_merge_skip_mismatch_and_rollback() {
    let (dir, lib) = basic();
    let path = import_file(dir.path(), &[("a", &[0., 1.]), ("missing", &[1.])]);
    let result = lib.import_artist_style_features(&path).unwrap();
    assert_eq!((result.imported, result.skipped), (1, 1));
    assert_eq!(lib.artist_style_status().unwrap().features, 3);
    let store = read_only(&lib.artist_style_path()).unwrap();
    assert_eq!(
        store
            .query_row("SELECT vector FROM features WHERE asset_id='a'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .unwrap(),
        blob(&[0., 1.])
    );
    for (key, value) in [("model", "other"), ("dim", "512")] {
        let bad = import_file(dir.path(), &[("c", &[1.])]);
        Connection::open(&bad)
            .unwrap()
            .execute("UPDATE meta SET value=?2 WHERE key=?1", params![key, value])
            .unwrap();
        assert!(lib
            .import_artist_style_features(&bad)
            .unwrap_err()
            .to_string()
            .contains("모델 또는 차원"));
    }
    let bad = import_file(dir.path(), &[("a", &[1.]), ("c", &[1.])]);
    Connection::open(&bad)
        .unwrap()
        .execute("UPDATE features SET vector=x'0000' WHERE asset_id='c'", [])
        .unwrap();
    assert!(lib.import_artist_style_features(&bad).is_err());
    assert_eq!(
        store
            .query_row("SELECT vector FROM features WHERE asset_id='a'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .unwrap(),
        blob(&[0., 1.])
    );
    assert!(lib
        .import_artist_style_features(&lib.artist_style_path())
        .is_err());
}
#[test]
fn suggestion_contract_cache_assignment_and_trash() {
    let (_dir, lib) = basic();
    let suggestion = lib.artist_style_suggestion_now("c").unwrap().unwrap();
    assert_eq!(suggestion.artist.id, "alice");
    assert!((suggestion.score - 0.8).abs() < 0.0001);
    assert_eq!(suggestion.reference_asset_ids, vec!["a"]);
    assert_eq!(suggestion.runner_up.unwrap().artist.id, "bob");
    let page = lib.list_artist_style_suggestions_now(0, 5).unwrap();
    assert_eq!(
        (page.total_images, page.total_artists, page.groups.len()),
        (1, 1, 1)
    );
    assert_eq!(
        lib.list_artist_style_suggestions_now(1, 5)
            .unwrap()
            .groups
            .len(),
        0
    );
    assert_eq!(lib.artist_overview().unwrap().style_suggestion_count, 1);
    assert_eq!(lib.artist_style_status().unwrap().suggestions, 1);
    let stamp = meta(&read_only(&lib.artist_style_path()).unwrap(), "inputs").unwrap();
    lib.artist_style_suggestion_now("c").unwrap();
    assert_eq!(
        meta(&read_only(&lib.artist_style_path()).unwrap(), "inputs").unwrap(),
        stamp
    );
    let artist = lib
        .assign_assets_to_artist(&["c".into()], Some("alice"), None)
        .unwrap();
    assert_eq!(lib.artist_style_status().unwrap().suggestions, 0);
    assert!(lib.artist_style_suggestion_now("c").unwrap().is_none());
    lib.detach_artist_assignments(&artist, "manual").unwrap();
    assert!(lib.artist_style_suggestion_now("c").unwrap().is_some());
    lib.connection()
        .unwrap()
        .execute("UPDATE assets SET status='trash' WHERE id='c'", [])
        .unwrap();
    assert!(lib.artist_style_suggestion_now("c").unwrap().is_none());
}
#[test]
fn thresholds_lead_and_centering() {
    let (dir, lib) = basic();
    for vector in [&[1., 1., 3.][..], &[1., 1.][..]] {
        let path = import_file(dir.path(), &[("c", vector)]);
        lib.import_artist_style_features(&path).unwrap();
        assert!(lib.artist_style_suggestion_now("c").unwrap().is_none());
    }
    // An affine translation is removed by the stored mean.
    let path = import_file(
        dir.path(),
        &[("a", &[2., 1.]), ("b", &[1., 2.]), ("c", &[5., 4.])],
    );
    let mut mean = vec![0u8; DIM * 4];
    mean[..4].copy_from_slice(&1f32.to_le_bytes());
    mean[4..8].copy_from_slice(&1f32.to_le_bytes());
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE meta SET value=?1 WHERE key='mean'", [mean])
        .unwrap();
    lib.import_artist_style_features(&path).unwrap();
    assert!((lib.artist_style_suggestion_now("c").unwrap().unwrap().score - 0.8).abs() < 0.0001);
    assert_eq!(f16(1), 2f32.powi(-24));
    assert_eq!(f16(0x8000).to_bits(), (-0f32).to_bits());
    assert!(decode(&vec![0xff; DIM * 2]).is_err());
}
#[test]
fn reposter_roundtrip_untouched_hidden_and_dismissal_merge() {
    let (_dir, lib) = basic();
    let id = lib
        .set_artist_flags("alice", None, None, Some(true))
        .unwrap();
    assert!(id.starts_with("artist:"));
    let list = lib
        .list_artists(&artists::ArtistListQuery {
            bucket: artists::ArtistBucket::Reposter,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(list.total, 1);
    assert!(list.artists[0].reposter);
    assert_eq!(lib.artist_overview().unwrap().reposter, 1);
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    lib.set_artist_flags(&id, None, Some(true), Some(false))
        .unwrap();
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    lib.set_artist_flags(&id, None, Some(false), None).unwrap();
    lib.dismiss_artist_style_suggestion(&["c".into()], "alice")
        .unwrap();
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    // A touched artist with dismissals must survive dropping its last flag/name.
    let alice = lib
        .set_artist_flags("alice", None, None, Some(false))
        .unwrap();
    let merged = lib.merge_artists("bob", &[alice], None).unwrap();
    assert!(lib.artist_style_suggestion_now("c").unwrap().is_none());
    let conn = lib.connection().unwrap();
    assert!(conn
        .prepare("SELECT 1 FROM artist_style_dismissals WHERE artist_id=?1")
        .unwrap()
        .exists([merged])
        .unwrap());
}
#[test]
fn duplicate_groups_posts_pdq_quality_and_unfeatured_bridge() {
    let (_dir, lib) = basic();
    let update = |id: &str, url: &str| {
        lib.connection()
            .unwrap()
            .execute(
                "UPDATE assets SET source_url=?2 WHERE id=?1",
                params![id, url],
            )
            .unwrap();
    };
    update("a", "https://twitter.com/alice/status/123/photo/1");
    update("c", "https://x.com/i/web/status/123?x=2");
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    update("a", "https://www.pixiv.net/en/artworks/123");
    update("c", "https://pixiv.net/artworks/123#test");
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    update("a", "https://example.com/a?x=1");
    update("c", "https://example.com/a#two");
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    update("a", "https://example.com/different");
    let mut hash = vec![0u8; 64];
    hash[32..].fill(255);
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE assets SET perceptual_hash=?1,perceptual_hash_quality=50 WHERE id IN ('a','c')",
            [&hash],
        )
        .unwrap();
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE assets SET perceptual_hash_quality=49 WHERE id='c'",
            [],
        )
        .unwrap();
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "alice"
    );
    // No feature for bridge; it joins candidate by source and known image by crop PDQ.
    asset(&lib, "bridge", None, Some("https://example.com/a"));
    let mut crop = vec![0x55u8; 64];
    crop[32..].fill(0);
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE assets SET perceptual_hash=?1,perceptual_hash_quality=50 WHERE id='bridge'",
            [crop],
        )
        .unwrap();
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        "bob"
    );
}
#[test]
fn listing_answers_from_the_last_ranking_after_an_assignment() {
    let (_dir, lib) = basic();
    let page = lib.list_artist_style_suggestions_now(0, 5).unwrap();
    assert!(page.up_to_date);
    assert_eq!(page.total_images, 1);
    // Assigning makes the ranking stale; the list must not wait for a new one and must
    // already drop the image that now has an artist.
    lib.assign_assets_to_artist(&["c".to_owned()], Some("alice"), None)
        .unwrap();
    let page = lib.list_artist_style_suggestions(0, 5).unwrap();
    assert_eq!((page.total_images, page.total_artists), (0, 0));
    assert!(page.groups.is_empty());
    assert!(lib.list_artist_style_suggestions_now(0, 5).unwrap().up_to_date);
}
#[test]
fn empty_status_does_not_create_store() {
    let (_dir, lib) = fixture();
    assert_eq!(lib.artist_style_status().unwrap().features, 0);
    assert_eq!(
        lib.list_artist_style_suggestions_now(0, 5)
            .unwrap()
            .total_images,
        0
    );
    assert!(!lib.artist_style_path().exists());
}

#[test]
fn group_order_references_and_manual_precedence() {
    let (dir, lib) = basic();
    let mut rows: Vec<(&str, &[f32])> = vec![("a", &[1., 0.]), ("b", &[0., 1.]), ("c", &[4., 3.])];
    for id in ["a2", "a3", "a4", "a5"] {
        asset(&lib, id, Some("alice"), None);
        rows.push((id, &[1., 0.]));
    }
    asset(&lib, "c2", None, None);
    rows.push(("c2", &[4., 3.]));
    asset(&lib, "c3", None, None);
    rows.push(("c3", &[0., 1.]));
    let path = import_file(dir.path(), &rows);
    lib.import_artist_style_features(&path).unwrap();
    let page = lib.list_artist_style_suggestions_now(0, 1).unwrap();
    assert_eq!((page.total_images, page.total_artists), (3, 2));
    assert_eq!(page.groups[0].artist.id, "alice");
    assert_eq!(page.groups[0].candidates.len(), 2);
    assert_eq!(
        page.groups[0].reference_asset_ids,
        vec!["a", "a2", "a3", "a4"]
    );
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .reference_asset_ids,
        vec!["a", "a2", "a3"]
    );
    assert_eq!(
        lib.list_artist_style_suggestions_now(1, 1).unwrap().groups[0]
            .artist
            .id,
        "bob"
    );
    // Moving every Alice image to Bob overrides creator keys, without changing asset count.
    let ids = ["a", "a2", "a3", "a4", "a5"].map(str::to_owned);
    let bob = lib
        .assign_assets_to_artist(&ids, Some("bob"), None)
        .unwrap();
    assert_eq!(
        lib.artist_style_suggestion_now("c")
            .unwrap()
            .unwrap()
            .artist
            .id,
        bob
    );
}

#[test]
fn boundary_rule_and_single_artist() {
    let values = |first: f32, second: f32| {
        let mut v = vec![0.; DIM];
        v[0] = first;
        v[1] = second;
        v
    };
    let known = vec![
        Vector {
            asset: 0,
            artist: 0,
            group: 0,
            values: values(1., 0.),
        },
        Vector {
            asset: 1,
            artist: 1,
            group: 1,
            values: values(0., 1.),
        },
    ];
    for (score, second, expected) in [
        (0.55, 0.49, true),
        (0.549, 0.0, false),
        (0.8, 0.751, false),
        (0.8, 0.74, true),
    ] {
        let candidate = Vector {
            asset: 2,
            artist: 0,
            group: 2,
            values: values(score, second),
        };
        assert_eq!(
            !math::rank(&known, &[candidate], 2, &HashSet::new()).is_empty(),
            expected
        );
    }
    let candidate = Vector {
        asset: 2,
        artist: 0,
        group: 2,
        values: values(0.55, 0.),
    };
    let ranked = math::rank(&known[..1], &[candidate], 1, &HashSet::new());
    assert_eq!(ranked.len(), 1);
    assert!(ranked[0].runner.is_none());
}
