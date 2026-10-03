use super::*;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::VecDeque;

#[derive(Default)]
struct Fake {
    requests: RefCell<Vec<(String, Option<Value>)>>,
    pages: RefCell<VecDeque<Value>>,
    uploads: RefCell<Vec<ArtworkBlob>>,
    fail: std::cell::Cell<bool>,
}
impl HomeTransport for Fake {
    fn publish(
        &self,
        path: &str,
        body: Option<&Value>,
        token: &str,
    ) -> Result<Value, LibraryError> {
        assert_eq!(token, "publisher");
        if let Some(sha) = body.and_then(|v| v["pick"]["cover"]["sha256"].as_str()) {
            assert!(
                self.uploads.borrow().iter().any(|blob| blob.sha256 == sha),
                "cover must be confirmed before publishing"
            );
        }
        self.requests
            .borrow_mut()
            .push((path.into(), body.cloned()));
        if self.fail.get() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(
            json!({"version":1,"revision":self.requests.borrow().len(),"changed":true,
            "acknowledgedThrough":body.map(|v|v["intentCursor"].clone()).unwrap_or(json!(0)),"active":body.is_some()}),
        )
    }
    fn intents(&self, after: i64, token: &str) -> Result<Value, LibraryError> {
        assert_eq!(token, "publisher");
        Ok(self
            .pages
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| page(after, vec![])))
    }
    fn artwork(&self, blob: &ArtworkBlob, bytes: &[u8], token: &str) -> Result<(), LibraryError> {
        assert_eq!(token, "publisher");
        assert_eq!(blob.size_bytes, bytes.len() as u64);
        assert_eq!(
            blob.sha256,
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        self.uploads.borrow_mut().push(blob.clone());
        Ok(())
    }
}
fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-09-26T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
fn setup() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    (dir, lib)
}
fn run(lib: &Library, fake: &Fake, kind: &str, seconds: i64) {
    lib.run_home_with(
        fake,
        "publisher",
        "https://fake.invalid",
        kind,
        now() + chrono::Duration::seconds(seconds),
        now().date_naive(),
        false,
    )
    .unwrap();
}
fn game() -> ReleaseTitle {
    ReleaseTitle {
        id: "igdb:1942".into(),
        kind: ReleaseKind::Game,
        provider: "igdb".into(),
        external_id: "1942".into(),
        title: "젤다".into(),
        original_title: None,
        cover: Some("co1".into()),
        platforms: vec!["Switch".into()],
        date: Some("2026-11-14".into()),
        precision: release_calendar::DatePrecision::Exact,
        region: Some("KR".into()),
        popularity: 12.5,
        dates: vec![release_calendar::ProviderReleaseDate {
            region: "KR".into(),
            platform: "Switch".into(),
            date: Some("2026-11-14".into()),
            precision: release_calendar::DatePrecision::Exact,
        }],
        port: false,
    }
}
fn cache(lib: &Library, titles: &[ReleaseTitle]) {
    lib.connection().unwrap().execute("INSERT OR REPLACE INTO release_calendar_cache(provider,fetched_at,attempted_at,entries_json) VALUES('igdb',?1,?1,?2)",params![now().to_rfc3339(),serde_json::to_string(titles).unwrap()]).unwrap();
}
fn intent(sequence: i64, action: &str, id: &str) -> Value {
    json!({"sequence":sequence,"operationId":uuid::Uuid::new_v4().to_string(),"action":action,"itemId":id,"eventIds":null,"createdAt":"2026-09-26T00:00:00Z"})
}
fn page(after: i64, items: Vec<Value>) -> Value {
    let last = items
        .last()
        .map(|v| v["sequence"].as_i64().unwrap())
        .unwrap_or(after);
    json!({"version":1,"after":after,"lastSequence":last,"acknowledgedThrough":0,"prunedThrough":0,"nextCursor":last,"hasMore":false,"items":items})
}

#[test]
fn upcoming_serializer_matches_server_title_example_and_includes_anime() {
    let (_dir, lib) = setup();
    let mut anime = game();
    anime.id = "tmdb:tv:123:s2".into();
    anime.kind = ReleaseKind::Anime;
    anime.provider = "tmdb".into();
    anime.external_id = "tv:123:s2".into();
    cache(&lib, &[game(), anime.clone()]);
    release_wishlist::insert_watch(
        &*lib.connection().unwrap(),
        &anime,
        "calendar",
        now(),
        now().date_naive(),
    )
    .unwrap();
    let fake = Fake::default();
    run(&lib, &fake, "upcoming", 0);
    let requests = fake.requests.borrow();
    let body = requests[0].1.as_ref().unwrap();
    // tests/test_home_upcoming.py:title(), including every nullable field.
    assert_eq!(
        body["entries"][0],
        json!({"id":"igdb:1942","kind":"game","title":"젤다","originalTitle":null,
        "date":"2026-11-14","precision":"exact","region":"KR","platforms":["Switch"],"releaseType":null,
        "cover":{"url":"https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg"},"popularity":12.5,"port":false})
    );
    // tests/test_home_upcoming.py accepts `tmdb:tv:<show>:s<season>` as kind anime.
    assert_eq!(body["entries"].as_array().unwrap().len(), 2);
    assert_eq!(
        (
            body["entries"][1]["id"].as_str(),
            body["entries"][1]["kind"].as_str()
        ),
        (Some("tmdb:tv:123:s2"), Some("anime"))
    );
    assert_eq!(body["wishlist"][0]["id"], "tmdb:tv:123:s2");
    assert_eq!(body["sources"].as_array().unwrap().len(), 2);
    assert!(body.get("generatedAt").is_some());
    assert_eq!(body["intentCursor"], 0);
}

#[test]
fn unchanged_upcoming_and_artists_are_not_put_again_even_after_restart() {
    let (dir, lib) = setup();
    cache(&lib, &[game()]);
    let fake = Fake::default();
    for kind in ["upcoming", "artists"] {
        run(&lib, &fake, kind, 0);
        run(&lib, &fake, kind, 61);
    }
    assert_eq!(fake.requests.borrow().len(), 2);
    drop(lib);
    let reopened = Library::open(dir.path()).unwrap();
    for kind in ["upcoming", "artists"] {
        run(&reopened, &fake, kind, 122);
    }
    assert_eq!(fake.requests.borrow().len(), 2);
}

#[test]
fn tablet_intents_apply_and_republish_with_durable_cursor() {
    let (dir, lib) = setup();
    cache(&lib, &[game()]);
    let fake = Fake::default();
    run(&lib, &fake, "upcoming", 0);
    fake.pages.borrow_mut().push_back(page(
        0,
        vec![
            intent(1, "add", "igdb:1942"),
            intent(2, "mute", "igdb:1942"),
        ],
    ));
    run(&lib, &fake, "upcoming", 61);
    assert!(lib.list_release_watch().unwrap()[0].muted);
    let body = fake.requests.borrow().last().unwrap().1.clone().unwrap();
    assert_eq!(body["intentCursor"], 2);
    assert_eq!(body["wishlist"][0]["source"], "calendar");
    assert_eq!(body["wishlist"][0]["muted"], true);
    assert!(body["wishlist"][0].get("unread").is_none());
    drop(lib);
    let lib = Library::open(dir.path()).unwrap();
    fake.pages.borrow_mut().push_back(page(
        2,
        vec![
            intent(3, "unmute", "igdb:1942"),
            intent(4, "remove", "igdb:1942"),
        ],
    ));
    run(&lib, &fake, "upcoming", 122);
    assert!(lib.list_release_watch().unwrap().is_empty());
    assert_eq!(
        fake.requests.borrow().last().unwrap().1.as_ref().unwrap()["intentCursor"],
        4
    );
}

#[test]
fn failed_put_retries_same_envelope_and_does_not_reapply_intents() {
    let (_dir, lib) = setup();
    cache(&lib, &[game()]);
    let fake = Fake::default();
    fake.pages
        .borrow_mut()
        .push_back(page(0, vec![intent(1, "add", "igdb:1942")]));
    fake.fail.set(true);
    assert!(lib
        .run_home_with(
            &fake,
            "publisher",
            "https://fake.invalid",
            "upcoming",
            now(),
            now().date_naive(),
            false
        )
        .is_err());
    let added = lib.list_release_watch().unwrap()[0].added_at.clone();
    run(&lib, &fake, "upcoming", 30);
    assert_eq!(fake.requests.borrow().len(), 1);
    fake.fail.set(false);
    run(&lib, &fake, "upcoming", 60);
    assert_eq!(lib.list_release_watch().unwrap()[0].added_at, added);
    assert_eq!(fake.requests.borrow()[0], fake.requests.borrow()[1]);
}

#[test]
fn malformed_page_rolls_back_and_unknown_add_is_acknowledged() {
    let (_dir, lib) = setup();
    cache(&lib, &[game()]);
    let fake = Fake::default();
    fake.pages.borrow_mut().push_back(page(
        0,
        vec![
            intent(1, "add", "igdb:1942"),
            intent(3, "remove", "igdb:1942"),
        ],
    ));
    assert!(lib
        .run_home_with(
            &fake,
            "publisher",
            "https://fake.invalid",
            "upcoming",
            now(),
            now().date_naive(),
            false
        )
        .is_err());
    assert!(lib.list_release_watch().unwrap().is_empty());
    fake.pages
        .borrow_mut()
        .push_back(page(0, vec![intent(1, "add", "igdb:999")]));
    run(&lib, &fake, "upcoming", 60);
    assert_eq!(
        fake.requests.borrow()[0].1.as_ref().unwrap()["intentCursor"],
        1
    );
}

#[test]
fn av_absence_deletes_once_and_lightweight_mode_spaces_builds() {
    let (_dir, lib) = setup();
    let fake = Fake::default();
    lib.run_home_with(
        &fake,
        "publisher",
        "https://fake.invalid",
        "avPick",
        now(),
        now().date_naive(),
        true,
    )
    .unwrap();
    run(&lib, &fake, "avPick", 61);
    assert_eq!(
        fake.requests.borrow().as_slice(),
        &[("/v1/home/av-pick".into(), None)]
    );
    let state = State::load(
        &*lib.connection().unwrap(),
        "https://fake.invalid/",
        "avPick",
    )
    .unwrap();
    assert_eq!(state.next_build, now().timestamp() + BUILD_INTERVAL);
    run(&lib, &fake, "avPick", 301);
    assert_eq!(fake.requests.borrow().len(), 1);
}

fn av_fixture(lib: &Library) {
    lib.connection().unwrap().execute_batch("INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES('person-1','배우','別名','2026-09-26T00:00:00Z','2026-09-26T00:00:00Z');
        INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('col-1','Latest','av','2026-09-26T00:00:00Z','2026-09-26T00:00:00Z');
        INSERT INTO collection_av_details(collection_id,product_code,label,release_date) VALUES('col-1','ABC-123','ABC','2026-08-01');
        INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES('col-1','person-1','performer',0);").unwrap();
}

#[test]
fn av_schema_front_cover_receipt_change_detection_and_delete() {
    let (_dir, lib) = setup();
    av_fixture(&lib);
    let fake = Fake::default();
    let path = lib.root().join("front.png");
    image::RgbImage::from_pixel(12, 18, image::Rgb([200, 20, 40]))
        .save(&path)
        .unwrap();
    lib.connection().unwrap().execute_batch("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('front','col-1','local','front','cover','front.png','image/png',12,18,1,'2026-09-26','2026-09-26');").unwrap();
    run(&lib, &fake, "avPick", 0);
    let body = fake.requests.borrow()[0].1.clone().unwrap();
    // test_home_av_pick.py:pick(), adapted to this one-work PC fixture.
    let mut expected = json!({"version":1,"pick":{"date":"2026-09-26","personId":"person-1","name":"배우",
        "aliases":["別名"],"workCount":1,"latestWork":{"code":"ABC-123","label":null,"series":null,
            "title":"Latest","date":"2026-08-01","collectionId":"col-1"},"cover":null}});
    expected["pick"]["cover"] = body["pick"]["cover"].clone();
    assert_eq!(body, expected);
    assert_eq!(fake.uploads.borrow().len(), 1);
    assert_eq!(
        body["pick"]["cover"]["sha256"],
        fake.uploads.borrow()[0].sha256
    );
    assert!(body["pick"].get("portrait").is_none());
    assert!(body["pick"].get("recentOwnedWorks").is_none());
    run(&lib, &fake, "avPick", 61);
    assert_eq!(fake.requests.borrow().len(), 1);
    assert_eq!(fake.uploads.borrow().len(), 1);
    lib.connection()
        .unwrap()
        .execute("DELETE FROM collection_person_relations", [])
        .unwrap();
    lib.publication_inputs.signal(&[9]);
    run(&lib, &fake, "avPick", 122);
    assert!(fake.requests.borrow()[1].1.is_none());
}

fn asset(lib: &Library, id: &str, key: Option<&str>) {
    lib.connection().unwrap().execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,creator_name,creator_handle) VALUES(?1,?1,'image',?1,'assets/'||?1,'thumbnails/'||?1,1,10,10,'2026-09-01T00:00:00Z',?2,?2)",params![id,key]).unwrap();
}

#[test]
fn artists_publish_complete_hub_schema_assignments_and_unique_creator_fallback_keys() {
    let (_dir, lib) = setup();
    asset(&lib, "asset-1", Some("alice"));
    asset(&lib, "asset-2", Some("alice"));
    asset(&lib, "asset-9", None);
    lib.connection().unwrap().execute_batch("INSERT INTO artists(id,display_name,pinned,created_at,updated_at) VALUES('a1','앨리스',1,'2026-09-26','2026-09-26'),('a2','Other',0,'2026-09-26','2026-09-26');
        INSERT INTO artist_members(creator_key,artist_id,added_at) VALUES('alice','a1','2026-09-26');
        INSERT INTO asset_artist_assignments(asset_id,artist_id,source,created_at) VALUES('asset-9','a1','manual','2026-09-26'),('asset-2','a2','manual','2026-09-26');").unwrap();
    let fake = Fake::default();
    run(&lib, &fake, "artists", 0);
    let body = fake.requests.borrow()[0].1.clone().unwrap();
    assert_eq!(
        body["settings"],
        json!({"mainMinCount":5,"recentMinCount":2,"recentDays":30})
    );
    assert_eq!(body["unknown"], json!({"none":0,"source":0}));
    // Same exact Artist field set as test_library_artists.py:artist().
    assert_eq!(
        body["artists"][0],
        json!({"id":"artist:a1","label":"앨리스","displayName":"앨리스",
        "sourceName":"alice","keys":["alice"],"assetCount":2,"recentCount":2,
        "firstSavedAt":"2026-09-01T00:00:00Z","lastSavedAt":"2026-09-01T00:00:00Z","lastOpenedAt":null,
        "pinned":true,"hidden":false,"main":true,"coverAssetIds":["asset-9","asset-1"]})
    );
    assert_eq!(body["artists"][1]["keys"], json!([]));
    assert_eq!(
        body["assignments"],
        json!([{"assetId":"asset-2","artistId":"artist:a2","source":"manual"},{"assetId":"asset-9","artistId":"artist:a1","source":"manual"}])
    );
    run(&lib, &fake, "artists", 61);
    assert_eq!(fake.requests.borrow().len(), 1);
    lib.connection()
        .unwrap()
        .execute("UPDATE artists SET hidden=1 WHERE id='a1'", [])
        .unwrap();
    lib.publication_inputs.signal(&[10]);
    run(&lib, &fake, "artists", 122);
    assert_eq!(
        fake.requests.borrow()[1].1.as_ref().unwrap()["artists"][0]["hidden"],
        true
    );
}

#[test]
fn acknowledgement_only_reads_the_requested_items_events() {
    let (_dir, lib) = setup();
    cache(&lib, &[game()]);
    release_wishlist::insert_watch(
        &*lib.connection().unwrap(),
        &game(),
        "calendar",
        now(),
        now().date_naive(),
    )
    .unwrap();
    lib.connection().unwrap().execute_batch("INSERT INTO release_watch_item_events(id,item_id,event_kind,detected_at) VALUES('ev1','igdb:1942','released','2026-09-26T00:00:00Z'),('ev2','igdb:1942','date_changed','2026-09-26T00:00:00Z');").unwrap();
    let fake = Fake::default();
    run(&lib, &fake, "upcoming", 0);
    let mut wrong = intent(1, "acknowledge", "igdb:999");
    wrong["eventIds"] = json!(["ev1"]);
    let mut right = intent(2, "acknowledge", "igdb:1942");
    right["eventIds"] = json!(["ev2"]);
    fake.pages
        .borrow_mut()
        .push_back(page(0, vec![wrong, right]));
    run(&lib, &fake, "upcoming", 61);
    let watches = lib.list_release_watch().unwrap();
    assert_eq!(watches[0].unread.len(), 1);
    assert_eq!(watches[0].unread[0].id, "ev1");
    let requests = fake.requests.borrow();
    let event = &requests.last().unwrap().1.as_ref().unwrap()["wishlist"][0]["events"][0];
    assert_eq!(
        *event,
        json!({"id":"ev1","kind":"released","previousValue":null,"currentValue":null,"detectedAt":"2026-09-26T00:00:00Z","readAt":null})
    );
}

#[test]
fn expired_and_ahead_cursors_are_rejected_without_inventing_an_acknowledgement() {
    for (pruned, last) in [(1, 1), (0, -1)] {
        let mut value = page(0, vec![]);
        value["prunedThrough"] = json!(pruned);
        value["lastSequence"] = json!(last);
        assert!(serde_json::from_value::<IntentPage>(value)
            .unwrap()
            .validate(0)
            .is_err());
    }
}

#[test]
fn provider_cover_urls_are_bounded_and_do_not_allow_foreign_urls() {
    assert_eq!(
        cover(ReleaseKind::Movie, Some("/m.jpg")),
        json!({"url":"https://image.tmdb.org/t/p/w342/m.jpg"})
    );
    assert!(cover(ReleaseKind::Movie, Some("https://secret.invalid/x")).is_null());
    assert!(cover(ReleaseKind::Game, Some("../secret")).is_null());
}

#[test]
fn fake_http_uses_publisher_auth_correct_routes_and_methods() {
    let (_dir, lib) = setup();
    cache(&lib, &[game()]);
    av_fixture(&lib);
    let endpoint = "http://127.0.0.1";
    let reply = |active| json!({"version":1,"revision":1,"changed":true,"acknowledgedThrough":0,"active":active});
    let (client, requests) = CloudClient::home_test_client(vec![
        page(0, vec![]),
        reply(true),
        reply(true),
        reply(true),
        reply(false),
    ]);
    for kind in ["upcoming", "artists", "avPick"] {
        lib.run_home_with(
            &client,
            "publisher",
            endpoint,
            kind,
            now(),
            now().date_naive(),
            false,
        )
        .unwrap();
    }
    lib.connection()
        .unwrap()
        .execute("DELETE FROM collection_person_relations", [])
        .unwrap();
    lib.publication_inputs.signal(&[9]);
    lib.run_home_with(
        &client,
        "publisher",
        endpoint,
        "avPick",
        now() + chrono::Duration::seconds(61),
        now().date_naive(),
        false,
    )
    .unwrap();
    let requests = requests.lock().unwrap();
    for (raw, (method, path)) in requests.iter().zip([
        (
            "GET",
            "/v1/home/upcoming/wishlist/intents?after=0&limit=200",
        ),
        ("PUT", "/v1/home/upcoming"),
        ("PUT", "/v1/library/artists"),
        ("PUT", "/v1/home/av-pick"),
        ("DELETE", "/v1/home/av-pick"),
    ]) {
        let raw = std::str::from_utf8(raw).unwrap();
        let (headers, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with(&format!("{method} {path} HTTP/1.1")));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer publisher"));
        if method == "PUT" {
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["version"], 1);
            if path.ends_with("upcoming") {
                assert_eq!(body["entries"][0], title(&game()));
            }
            if path.ends_with("artists") {
                assert_eq!(body["artists"], json!([]));
            }
            if path.ends_with("av-pick") {
                assert_eq!(body["pick"]["personId"], "person-1");
            }
        }
    }
    assert_eq!(requests.len(), 5);
}

#[test]
fn fake_http_confirms_av_front_blob_before_publishing_the_reference() {
    let (_dir, lib) = setup();
    av_fixture(&lib);
    image::RgbImage::from_pixel(2, 3, image::Rgb([1, 2, 3]))
        .save(lib.root().join("front.png"))
        .unwrap();
    lib.connection().unwrap().execute_batch("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('front','col-1','local','front','cover','front.png','image/png',2,3,1,'2026-09-26','2026-09-26');").unwrap();
    let (body, artwork) = lib.av_pick_body(now().date_naive()).unwrap();
    let (blob, _) = artwork.unwrap();
    let (client, requests) = CloudClient::home_test_client(vec![
        json!({"objectKey":blob.object_key,"uploadUrl":null,"requiredHeaders":{}}),
        json!({"version":1,"revision":1,"changed":true,"active":true}),
    ]);
    lib.run_home_with(
        &client,
        "publisher",
        "http://127.0.0.1",
        "avPick",
        now(),
        now().date_naive(),
        false,
    )
    .unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let parse = |bytes: &Vec<u8>| -> (String, Value) {
        let raw = std::str::from_utf8(bytes).unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        (head.into(), serde_json::from_str(body).unwrap())
    };
    let (head, prepared) = parse(&requests[0]);
    assert!(head.starts_with("POST /v1/collections/artworks/prepare HTTP/1.1"));
    assert_eq!(prepared, body["pick"]["cover"]);
    let (head, published) = parse(&requests[1]);
    assert!(head.starts_with("PUT /v1/home/av-pick HTTP/1.1"));
    assert_eq!(published, body);
}

#[test]
fn home_state_migration_and_endpoint_checkpoints_preserve_existing_data() {
    let (_dir, lib) = setup();
    cache(&lib, &[game()]);
    let db = lib.connection().unwrap();
    db.execute("DROP TABLE home_publication_state", []).unwrap();
    db.execute_batch(include_str!("../../migrations/0109_home_publications.sql"))
        .unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        109
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM release_calendar_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!db
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    State {
        cursor: 7,
        published_digest: "first".into(),
        ..Default::default()
    }
    .save(&db, "https://first.invalid/", "upcoming")
    .unwrap();
    assert_eq!(
        State::load(&db, "https://second.invalid/", "upcoming")
            .unwrap()
            .cursor,
        0
    );
}

#[test]
fn tablet_intent_adds_an_anime_season_to_the_wishlist() {
    let (_dir, lib) = setup();
    let mut anime = game();
    anime.id = "tmdb:tv:283938:s1".into();
    anime.kind = ReleaseKind::Anime;
    anime.provider = "tmdb".into();
    anime.external_id = "tv:283938:s1".into();
    lib.connection().unwrap().execute("INSERT OR REPLACE INTO release_calendar_cache(provider,fetched_at,attempted_at,entries_json) VALUES('tmdb_tv',?1,?1,?2)",params![now().to_rfc3339(),serde_json::to_string(&[anime]).unwrap()]).unwrap();
    let fake = Fake::default();
    run(&lib, &fake, "upcoming", 0);
    fake.pages
        .borrow_mut()
        .push_back(page(0, vec![intent(1, "add", "tmdb:tv:283938:s1")]));
    run(&lib, &fake, "upcoming", 61);
    let watched = lib.list_release_watch().unwrap();
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0].id, "tmdb:tv:283938:s1");
    // A malformed TV id is still rejected as a bad page.
    fake.pages
        .borrow_mut()
        .push_back(page(1, vec![intent(2, "add", "tmdb:tv:x:s1")]));
    let rejected = lib.run_home_with(
        &fake,
        "publisher",
        "https://fake.invalid",
        "upcoming",
        now() + chrono::Duration::seconds(122),
        now().date_naive(),
        false,
    );
    assert!(rejected.is_err());
    assert_eq!(lib.list_release_watch().unwrap().len(), 1);
}

#[test]
fn home_idle_signal_and_safety_deadlines_bound_body_builds() {
    let (_dir, lib) = setup();
    asset(&lib, "asset-1", Some("alice"));
    cache(&lib, &[game()]);
    let fake = Fake::default();
    let checkpoint =
        |kind| State::load(&*lib.connection().unwrap(), "https://fake.invalid/", kind).unwrap();
    for kind in ["artists", "avPick", "upcoming"] {
        run(&lib, &fake, kind, 0);
        for seconds in [1, 59, 60, 300, BUILD_INTERVAL - 1] {
            run(&lib, &fake, kind, seconds);
            assert_eq!(
                checkpoint(kind).next_build,
                now().timestamp() + BUILD_INTERVAL
            );
        }
        run(&lib, &fake, kind, BUILD_INTERVAL);
        assert_eq!(
            checkpoint(kind).next_build,
            now().timestamp() + 2 * BUILD_INTERVAL
        );
    }
    let count = fake.requests.borrow().len();
    lib.update_asset_metadata(super::super::models::AssetMetadataPatch {
        asset_id: "asset-1".into(),
        source_published_at: None,
        creator_name: Some("New name".into()),
        creator_handle: Some("new".into()),
        creator_url: None,
    })
    .unwrap();
    run(&lib, &fake, "artists", BUILD_INTERVAL + 1);
    assert_eq!(fake.requests.borrow().len(), count + 1);
    assert_eq!(
        checkpoint("artists").next_build,
        now().timestamp() + 2 * BUILD_INTERVAL + 1
    );
    // The artist facade also signals promptly, including pins and display-name edits.
    lib.set_artist_flags("new", Some(true), None, None).unwrap();
    run(&lib, &fake, "artists", BUILD_INTERVAL + 2);
    assert_eq!(fake.requests.borrow().len(), count + 2);
    lib.set_release_watch_muted("invalid", true).unwrap_err(); // A failed write sends no signal.
}

#[test]
fn av_day_rollover_builds_before_the_ten_minute_deadline() {
    let (_dir, lib) = setup();
    av_fixture(&lib);
    let fake = Fake::default();
    run(&lib, &fake, "avPick", 0);
    let tomorrow = now().date_naive().succ_opt().unwrap();
    lib.run_home_with(
        &fake,
        "publisher",
        "https://fake.invalid",
        "avPick",
        now() + chrono::Duration::seconds(1),
        tomorrow,
        false,
    )
    .unwrap();
    assert_eq!(fake.requests.borrow().len(), 2);
    assert_eq!(
        fake.requests.borrow()[1].1.as_ref().unwrap()["pick"]["date"],
        tomorrow.to_string()
    );
}

#[test]
fn upcoming_intent_poll_keeps_legacy_cadence_without_rebuilding_unchanged_body() {
    let (_dir, lib) = setup();
    cache(&lib, &[game()]);
    let fake = Fake::default();
    let endpoint = "https://intent-cadence.invalid";
    let publish = |seconds| {
        lib.run_home_with(
            &fake,
            "publisher",
            endpoint,
            "upcoming",
            now() + chrono::Duration::seconds(seconds),
            now().date_naive(),
            false,
        )
        .unwrap()
    };
    let checkpoint = || {
        State::load(
            &*lib.connection().unwrap(),
            &status_watch::endpoint_key(endpoint),
            "upcoming",
        )
        .unwrap()
    };
    publish(0);
    fake.pages
        .borrow_mut()
        .push_back(page(0, vec![intent(1, "add", "igdb:1942")]));
    publish(59);
    assert_eq!(fake.pages.borrow().len(), 1);
    assert_eq!(checkpoint().last_poll, Some(now().timestamp()));
    publish(60);
    assert!(fake.pages.borrow().is_empty());
    assert_eq!(checkpoint().cursor, 1);
    assert_eq!(checkpoint().last_poll, Some(now().timestamp() + 60));
    assert_eq!(fake.requests.borrow().len(), 2);
    publish(120);
    assert_eq!(checkpoint().last_poll, Some(now().timestamp() + 120));
    assert_eq!(
        checkpoint().next_build,
        now().timestamp() + 60 + BUILD_INTERVAL
    );
    assert_eq!(fake.requests.borrow().len(), 2);
}
