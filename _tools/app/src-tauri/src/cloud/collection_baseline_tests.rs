use super::*;
use serde_json::Value;
const ENDPOINT: &str = "https://fixture.test";
const ALL: ReplicaFeatures = ReplicaFeatures {
    av: true,
    work_record: true,
    cover_focus: true,
    people: true,
    portrait_image: true,
};

#[test]
fn collection_baseline_offline_export_preserves_steam_and_memberships_without_source_writes() {
    let (temp, library, _feature) = fixture();
    let db = library.connection().unwrap();
    db.execute("INSERT INTO collection_external_bindings(collection_id,provider,external_id,provider_data_json,created_at,updated_at) VALUES('g','steam','570','{\"developer\":\"must not merge\"}','2026','2026')", []).unwrap();
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    drop(db);
    let database = std::fs::read(temp.path().join("library.sqlite")).unwrap();
    let output = tempfile::tempdir().unwrap();
    let destination = output.path().join("snapshot");
    let (baseline, legacy) =
        Library::export_collection_baseline(temp.path(), &destination, ENDPOINT, "revision")
            .unwrap();
    let steam = baseline["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["provider"] == "steam")
        .unwrap();
    assert_eq!(steam["externalId"], "570");
    assert_eq!(steam["values"], serde_json::json!({}));
    assert_eq!(
        baseline["memberships"],
        serde_json::json!([{"workId":"g","assetId":"asset","addedAt":"2026-10-04T00:00:00Z"}])
    );
    assert_eq!(baseline["personalEditCursor"], 7);
    assert_eq!(legacy["personalEditVersion"], 3);
    assert_eq!(
        std::fs::read(temp.path().join("library.sqlite")).unwrap(),
        database
    );
    assert!(!temp.path().join(".cache/mobile-collections").exists());
    assert!(destination
        .join(".cache/mobile-collections/thumbnails")
        .is_dir());
    // Same committed replica, including source artwork manifests and portraits.
    let ordinary = library
        .collection_authority_baseline(ENDPOINT, "revision", Some(&_feature), ALL, &|_| {})
        .unwrap();
    assert_eq!(baseline, ordinary);
    assert!(
        Library::export_collection_baseline(temp.path(), &destination, ENDPOINT, "revision")
            .is_err()
    );
    let nested = temp.path().join("forbidden");
    assert!(
        Library::export_collection_baseline(temp.path(), &nested, ENDPOINT, "revision").is_err()
    );
    assert!(!nested.exists());
    std::fs::write(temp.path().join("library.sqlite-wal"), b"pending").unwrap();
    let refused = output.path().join("refused");
    assert!(
        Library::export_collection_baseline(temp.path(), &refused, ENDPOINT, "revision").is_err()
    );
    assert!(!refused.exists());
}

fn keys(value: &Value, expected: &[&str]) {
    let actual: std::collections::BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(actual, expected.iter().copied().collect());
}
fn item<'a>(doc: &'a Value, section: &str, key: &str, id: &str) -> &'a Value {
    doc[section]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v[key] == id)
        .unwrap()
}
fn fixture() -> (tempfile::TempDir, Library, PersonalEditFeature) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE library_settings SET library_id=?1 WHERE singleton=1",
            ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
        )
        .unwrap();
    let library_id = library.library_id().unwrap();
    library
        .adopt_collection_personal_edit_library(ENDPOINT, &library_id)
        .unwrap();
    let feature = PersonalEditFeature {
        endpoint: ENDPOINT.into(),
        library_id,
        edit_version: 3,
    };
    let db = library.connection().unwrap();
    db.execute_batch(r#"
        INSERT INTO collections(id,name,type,created_at,updated_at,my_score,showcase,showcase_order) VALUES
        ('g','Game','game','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z',4.5,1,3),('m','Manga','manga','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z',0,0,NULL),
        ('film','Film','movie','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z',NULL,0,NULL),('tv','TV','movie','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z',NULL,0,NULL),('av','AV','av','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z',NULL,0,NULL);
        INSERT INTO collection_pc_records(collection_id,status,owned_platform) VALUES ('g','playing','PS5'),('m','collecting',NULL);
        INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES
        ('spine','g','local','spine','spine','spine.png','image/png',4,6,1,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('cover','m','local','cover','volume_cover','cover.png','image/png',4,6,0,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('front','av','local','front','cover','front.png','image/png',4,6,1,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('back','av','local','back','back','back.png','image/png',4,6,1,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('missing','g','local','missing','back','missing.png','image/png',4,6,0,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z');
        INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,created_at,updated_at) VALUES ('v','m',1,0,9,'cover','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z');
        INSERT INTO collection_volume_cover_focus(volume_id,cover_artwork_id,focus_x,method) VALUES ('v','cover',0.25,'head');
        INSERT INTO collection_external_bindings(collection_id,provider,external_id,provider_data_json,last_synced_at,created_at,updated_at) VALUES
        ('m','kakao','book','{}','2026-10-01','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('g','igdb','123','{"developer":"Maker","platforms":["PS5"]}',NULL,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('film','tmdb','1','{"film":{"cast":[{"name":"Actor"}],"tagline":"Tag"}}',NULL,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),
        ('tv','tmdb','tv:2','{"series":{"status":"Ended","cast":[],"seasons":[]}}',NULL,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z');
        INSERT INTO collection_volume_sources(collection_id,volume_number,provider,provider_item_id,title,isbn13,publication_date,provider_data_json,created_at,updated_at) VALUES ('m',1,'kakao','book1','Book','1234567890123','2026-09-01','{}','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z');
        INSERT INTO collection_volume_ownership VALUES ('m',1,0,1,1);
        INSERT INTO collection_ownership_tracking VALUES ('m',0);
        INSERT INTO release_watch_subscriptions(collection_id,provider,last_checked_at) VALUES ('m','kakao','2026-10-01');
        INSERT INTO collection_av_details(collection_id,product_code,title_ja,maker,label,series,genres_json,release_date) VALUES ('av','TEST-1','作品','Maker','Label','Series','["Genre"]','2026-01-01');
        INSERT INTO collection_people(id,display_name,name_ja,memo,created_at,updated_at) VALUES ('crop','Crop','出演者','Memo','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z'),('portrait','Portrait',NULL,NULL,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z');
        INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES ('av','crop','performer',0),('av','portrait','director',1);
        INSERT INTO collection_person_portraits(person_id,kind,artwork_id,x,y,w,h,updated_at) VALUES ('crop','crop','front',0.1,0.2,0.3,0.4,'2026-10-04T00:00:00Z');
        INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at) VALUES ('portrait','stashdb',X'89504E470D0A1A0A66697874757265','image/png',4,6,'portrait.png','https://fixture.test/portrait','2026-10-04T00:00:00Z');
        INSERT INTO av_favorite_performers(person_id,created_at) VALUES ('crop','2026-10-04T00:00:00Z');
        INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES ('asset','hash','image','asset.png','asset.png','asset-thumb.webp',1,4,6,'2026-10-04T00:00:00Z');
        INSERT INTO collection_assets VALUES ('g','asset','2026-10-04T00:00:00Z');
        UPDATE mobile_collection_personal_edit_sync SET received_cursor=7;
        INSERT INTO notes_state(key,value) VALUES ('collectionBindingSync:https://fixture.test','{"cursor":8}'),('collectionReleaseSync:https://fixture.test','{"readCursor":9,"generation":10}');
    "#).unwrap();
    let source = temp.path().join("collection-sources/book");
    let manga = source.join("comics/manga/covers");
    std::fs::create_dir_all(&manga).unwrap();
    image::RgbaImage::from_pixel(16, 24, image::Rgba([120, 100, 80, 255]))
        .save(manga.join("vol_2_cover.png"))
        .unwrap();
    db.execute(
        "UPDATE library_settings SET collection_source_root=?1 WHERE singleton=1",
        [source.to_str().unwrap()],
    )
    .unwrap();
    db.execute(
        "UPDATE collections SET source_path='manga' WHERE id='m'",
        [],
    )
    .unwrap();
    drop(db);
    for name in ["spine", "cover", "front", "back"] {
        std::fs::write(
            temp.path().join(format!("{name}.png")),
            b"\x89PNG\r\n\x1a\nfixture",
        )
        .unwrap();
    }
    (temp, library, feature)
}

#[test]
fn collection_baseline_maps_every_replica_field_and_exact_section_keys() {
    let (_temp, library, feature) = fixture();
    let mut db = rusqlite::Connection::open(library.root().join("library.sqlite")).unwrap();
    let tx = db.transaction().unwrap();
    let snapshot = snapshot_from_transaction(
        &library.root().canonicalize().unwrap(),
        &tx,
        Some("revision".into()),
        Some(&feature),
        ALL,
        &|_| {},
    )
    .unwrap();
    let replica = serde_json::to_value(&snapshot.replica).unwrap();
    let doc = collection_baseline::from_snapshot(&tx, &snapshot, ENDPOINT, "revision").unwrap();
    keys(
        &doc,
        &[
            "stagingVersion",
            "libraryId",
            "personalEditCursor",
            "legacyRevision",
            "bindingRequestSequence",
            "releaseReadCursor",
            "releaseGeneration",
            "works",
            "bindings",
            "artworks",
            "volumes",
            "volumeSources",
            "ownership",
            "memberships",
            "people",
        ],
    );
    for (key, expected) in [
        ("stagingVersion", 2),
        ("personalEditCursor", 7),
        ("bindingRequestSequence", 8),
        ("releaseReadCursor", 9),
        ("releaseGeneration", 10),
    ] {
        assert_eq!(doc[key], expected);
    }
    for w in doc["works"].as_array().unwrap() {
        keys(
            w,
            &[
                "workId",
                "type",
                "legacyKind",
                "name",
                "fields",
                "showcase",
                "showcaseOrder",
                "selection",
                "details",
                "derived",
                "avCredits",
                "createdAt",
                "updatedAt",
            ],
        );
        keys(
            &w["fields"],
            &[
                "description",
                "coverAssetId",
                "year",
                "originalTitle",
                "runtimeMinutes",
                "author",
                "director",
                "developer",
                "publisher",
                "platforms",
                "productionCompany",
                "releaseDate",
                "externalScore",
                "myScore",
                "genres",
                "overview",
                "status",
                "ownedPlatform",
            ],
        );
        keys(&w["selection"], &["work", "hero", "backdrop", "spine"]);
        keys(&w["details"], &["series", "film", "av"]);
        keys(
            &w["derived"],
            &[
                "unreadReleaseCount",
                "releaseWatch",
                "ownedVolumes",
                "releaseSchedule",
            ],
        );
        let live = item(&replica, "collections", "id", w["workId"].as_str().unwrap());
        for (key, value) in w["fields"].as_object().unwrap() {
            assert_eq!(value, &live[key]);
        }
        for (key, value) in w["derived"].as_object().unwrap() {
            assert_eq!(value, &live[key]);
        }
        for key in ["series", "film"] {
            assert_eq!(w["details"][key], live[key]);
        }
        for key in [
            "type",
            "name",
            "showcase",
            "showcaseOrder",
            "createdAt",
            "updatedAt",
        ] {
            assert_eq!(w[key], live[key]);
        }
        let staged_art: Vec<_> = doc["artworks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["workId"] == w["workId"])
            .collect();
        for (order, a) in live["artworks"].as_array().unwrap().iter().enumerate() {
            assert_eq!(staged_art[order]["artworkId"], a["id"]);
            assert_eq!(staged_art[order]["order"], order);
            for key in ["kind", "selected", "original", "thumbnail"] {
                assert_eq!(staged_art[order][key], a[key]);
            }
        }
        for (order, v) in live["volumes"].as_array().unwrap().iter().enumerate() {
            let staged = item(&doc, "volumes", "volumeId", v["id"].as_str().unwrap());
            assert_eq!(staged["order"], order);
            for key in [
                "volumeNumber",
                "editionIndex",
                "displayLabel",
                "coverArtworkId",
                "coverFocusX",
            ] {
                assert_eq!(staged[key], v[key]);
            }
            for key in ["releaseStatus", "localReleaseDate", "isbn13"] {
                assert_eq!(staged["published"][key], v[key]);
            }
        }
    }
    let sections: &[(&str, &[&str])] = &[
        (
            "bindings",
            &[
                "workId",
                "provider",
                "externalId",
                "config",
                "snapshot",
                "values",
                "lastSyncedAt",
            ],
        ),
        (
            "artworks",
            &[
                "artworkId",
                "workId",
                "kind",
                "selected",
                "provider",
                "providerImageId",
                "width",
                "height",
                "language",
                "original",
                "thumbnail",
                "createdAt",
                "order",
            ],
        ),
        (
            "volumes",
            &[
                "volumeId",
                "workId",
                "volumeNumber",
                "editionIndex",
                "sortOrder",
                "order",
                "displayLabel",
                "coverArtworkId",
                "sourceProvider",
                "sourceCoverId",
                "coverFocusX",
                "published",
            ],
        ),
        (
            "volumeSources",
            &[
                "workId",
                "volumeNumber",
                "provider",
                "providerItemId",
                "title",
                "author",
                "publisher",
                "isbn13",
                "publicationDate",
                "itemUrl",
                "data",
            ],
        ),
        (
            "ownership",
            &[
                "workId",
                "volumeNumber",
                "editionIndex",
                "physical",
                "digital",
            ],
        ),
        ("memberships", &["workId", "assetId", "addedAt"]),
        (
            "people",
            &[
                "personId",
                "memo",
                "favorite",
                "profile",
                "portrait",
                "portraitImage",
            ],
        ),
    ];
    for (section, expected) in sections {
        assert!(!doc[section].as_array().unwrap().is_empty(), "{section}");
        for row in doc[section].as_array().unwrap() {
            keys(row, expected);
        }
    }
    assert_eq!(
        item(&doc, "works", "workId", "g")["selection"]["spine"],
        "spine"
    );
    assert_eq!(item(&doc, "works", "workId", "g")["fields"]["myScore"], 4.5);
    assert_eq!(item(&doc, "works", "workId", "m")["fields"]["myScore"], 0.0);
    assert_eq!(item(&doc, "volumes", "volumeId", "v")["coverFocusX"], 0.25);
    assert_eq!(doc["volumes"].as_array().unwrap().len(), 2);
    let manga = item(&doc, "works", "workId", "m");
    assert_eq!(manga["derived"]["ownedVolumes"][0]["count"], 1);
    assert_eq!(manga["derived"]["releaseWatch"]["enabled"], true);
    assert_eq!(
        manga["derived"]["releaseSchedule"]["kakao"]["volumes"][0]["date"],
        "2026-09-01"
    );
    assert!(item(&doc, "works", "workId", "film")["details"]["film"].is_object());
    assert!(item(&doc, "works", "workId", "tv")["details"]["series"].is_object());
    let av = item(&doc, "works", "workId", "av");
    assert_eq!(
        item(&doc, "artworks", "artworkId", "back")["selected"],
        true
    );
    assert_eq!(
        item(&doc, "artworks", "artworkId", "cover")["selected"],
        false
    );
    assert!(av["selection"]
        .as_object()
        .unwrap()
        .values()
        .all(|id| id != "back"));
    keys(
        &av["details"]["av"],
        &[
            "productCode",
            "titleJa",
            "maker",
            "label",
            "series",
            "genres",
            "releaseDate",
        ],
    );
    for p in av["avCredits"].as_array().unwrap() {
        keys(
            p,
            &[
                "personId",
                "name",
                "nameJa",
                "role",
                "order",
                "portraitCrop",
            ],
        );
    }
    assert_eq!(av["avCredits"][0]["portraitCrop"]["artworkId"], "front");
    let portrait = &item(&doc, "people", "personId", "portrait")["portraitImage"];
    keys(
        portrait,
        &["sha256", "sizeBytes", "contentType", "width", "height"],
    );
    assert_eq!(
        portrait,
        &item(&replica, "collections", "id", "av")["av"]["people"][1]["portraitImage"]
    );
    assert!(snapshot
        .files
        .contains_key(portrait["sha256"].as_str().unwrap()));
    assert!(item(&doc, "artworks", "artworkId", "missing")["original"].is_null());
    assert!(doc["artworks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["artworkId"] != "missing")
        .all(|a| a["original"].is_object()));
}

#[test]
fn collection_baseline_matches_committed_server_interop_fixture() {
    let (temp, library, feature) = fixture();
    // Activation requires every original. The mapping test above separately covers
    // missing files, which only verification accepts.
    std::fs::copy(
        temp.path().join("front.png"),
        temp.path().join("missing.png"),
    )
    .unwrap();
    let mut doc = library
        .collection_authority_baseline(ENDPOINT, "revision", Some(&feature), ALL, &|_| {})
        .unwrap();
    doc.sort_all_objects();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/fixtures/collection-authority/pc-staging-v2-generated.json");
    let pretty = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());
    if std::env::var("LAKOMICS_WRITE_INTEROP_FIXTURE").as_deref() == Ok("1") {
        std::fs::write(&path, &pretty).unwrap();
    }
    let committed = std::fs::read_to_string(&path).expect(
        "Generate the fixture with LAKOMICS_WRITE_INTEROP_FIXTURE=1 cargo test --lib collection_baseline",
    );
    assert_eq!(doc, serde_json::from_str::<Value>(&committed).unwrap());
    assert_eq!(
        pretty, committed,
        "Fixture formatting must also be deterministic"
    );
}

#[test]
fn collection_baseline_and_replica_share_one_read_transaction() {
    let (_temp, library, feature) = fixture();
    let mut db = rusqlite::Connection::open(library.root().join("library.sqlite")).unwrap();
    let tx = db.transaction().unwrap();
    let snapshot = snapshot_from_transaction(
        &library.root().canonicalize().unwrap(),
        &tx,
        None,
        Some(&feature),
        ALL,
        &|_| {},
    )
    .unwrap();
    library.connection().unwrap().execute_batch("UPDATE collections SET name='Changed' WHERE id='g'; UPDATE mobile_collection_personal_edit_sync SET received_cursor=99; UPDATE notes_state SET value='{\"cursor\":99}' WHERE key LIKE 'collectionBindingSync:%'; UPDATE collection_volume_ownership SET physical=0,digital=0;").unwrap();
    let doc = collection_baseline::from_snapshot(&tx, &snapshot, ENDPOINT, "revision").unwrap();
    assert_eq!(item(&doc, "works", "workId", "g")["name"], "Game");
    assert_eq!(doc["personalEditCursor"], 7);
    assert_eq!(doc["bindingRequestSequence"], 8);
    assert_eq!(doc["ownership"][0]["physical"], true);
    tx.commit().unwrap();
    let next = library
        .collection_authority_baseline(ENDPOINT, "revision", Some(&feature), ALL, &|_| {})
        .unwrap();
    assert_eq!(next["personalEditCursor"], 99);
    assert_eq!(item(&next, "works", "workId", "g")["name"], "Changed");
}
