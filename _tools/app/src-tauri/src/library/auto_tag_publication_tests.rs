use super::*;
use std::cell::{Cell, RefCell};
#[derive(Default)]
struct Fake {
    bodies: RefCell<Vec<Value>>,
    fail: Cell<bool>,
    fail_asset_page: Cell<Option<usize>>,
}
impl HomeTransport for Fake {
    fn publish(
        &self,
        path: &str,
        body: Option<&Value>,
        token: &str,
    ) -> Result<Value, LibraryError> {
        assert_eq!((path, token), (PATH, "publisher"));
        let body = body.unwrap().clone();
        assert!(serde_json::to_vec(&body).unwrap().len() <= MAX_BYTES);
        assert!(body["assets"].as_array().unwrap().len() <= ASSET_BATCH);
        assert!(body["vocabulary"].as_array().unwrap().len() <= VOCABULARY_BATCH);
        self.bodies.borrow_mut().push(body.clone());
        let asset_pages = self
            .bodies
            .borrow()
            .iter()
            .filter(|body| !body["assets"].as_array().unwrap().is_empty())
            .count();
        if self.fail.get()
            || (!body["assets"].as_array().unwrap().is_empty()
                && self.fail_asset_page.get() == Some(asset_pages))
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(
            json!({"version":2,"revision":1,"changed":true,"assets":body["assets"].as_array().unwrap().len(),"vocabulary":body["vocabulary"].as_array().unwrap().len()}),
        )
    }
    fn intents(&self, _: i64, _: &str) -> Result<Value, LibraryError> {
        panic!("no intents")
    }
    fn artwork(
        &self,
        _: &crate::cloud::collections::ArtworkBlob,
        _: &[u8],
        _: &str,
    ) -> Result<(), LibraryError> {
        panic!("no artwork")
    }
}
fn fixture(count: usize) -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    seed(&library.connection().unwrap(), count);
    (temp, library)
}
fn seed(db: &rusqlite::Connection, count: usize) {
    for index in 0..count {
        let id = format!("a{index:04}");
        db.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,creator_url) VALUES(?1,?1,'image',?1,?1,?1,1,10,10,'2026-10-01','https://artist.test/alice')",[&id]).unwrap();
    }
    for (tag, category) in [
        ("long_hair", "general"),
        ("signature", "general"),
        ("low_(series)", "character"),
        ("high_(series)", "character"),
        ("added_(series)", "character"),
        ("rating", "rating"),
    ] {
        db.execute(
            "INSERT INTO auto_tag_vocabulary VALUES(?1,?2)",
            params![tag, category],
        )
        .unwrap();
    }
    for (tag, score) in [
        ("long_hair", 0.9),
        ("signature", 1.0),
        ("low_(series)", 0.84),
        ("high_(series)", 0.85),
        ("rating", 1.0),
    ] {
        db.execute(
            "INSERT INTO asset_auto_tags VALUES('a0000',?1,?2)",
            params![tag, score],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO asset_auto_tag_edits VALUES('a0000','added_(series)','added','t')",
        [],
    )
    .unwrap();
}

fn run(library: &Library, fake: &Fake, time: i64) -> Result<(), LibraryError> {
    library.run_auto_tags_with(fake, "publisher", "https://example.invalid", time, false)
}
fn assets(fake: &Fake) -> Vec<Value> {
    fake.bodies
        .borrow()
        .iter()
        .flat_map(|body| body["assets"].as_array().unwrap().clone())
        .collect()
}
#[test]
fn first_incremental_manual_edits_labels_and_trash() {
    let (_temp, library) = fixture(2);
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    let first = assets(&fake);
    assert_eq!(first.len(), 2);
    assert_eq!(
        first[0]["tags"],
        json!(["added_(series)", "high_(series)", "long_hair"])
    );
    assert_eq!(first[0]["creatorKey"], "https://artist.test/alice");
    assert!(fake.bodies.borrow().iter().any(|body| body["vocabulary"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag["id"] == "long_hair" && tag["label"] == "긴 머리")));
    assert!(fake.bodies.borrow().iter().any(|body| body["vocabulary"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag["id"] == "rating" && tag["category"] == "rating")));
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 200).unwrap();
    assert!(fake.bodies.borrow().is_empty());
    {
        let db = library.connection().unwrap();
        db.execute(
            "INSERT INTO asset_auto_tag_edits VALUES('a0000','long_hair','removed','t')",
            [],
        )
        .unwrap();
        db.execute("UPDATE assets SET status='trash' WHERE id='a0001'", [])
            .unwrap();
    }
    library.publication_inputs.signal(&[11]);
    run(&library, &fake, 300).unwrap();
    let updated = assets(&fake);
    assert_eq!(updated.len(), 2);
    assert_eq!(
        updated[0]["tags"],
        json!(["added_(series)", "high_(series)"])
    );
    assert_eq!(updated[1]["tags"], json!([]));
    assert!(updated[1]["creatorKey"].is_null());
}
#[test]
fn failed_batches_resume_after_restart_and_lightweight_holds_work() {
    let (temp, library) = fixture(240);
    let fake = Fake::default();
    library
        .run_auto_tags_with(&fake, "publisher", "https://example.invalid", 100, true)
        .unwrap();
    assert!(fake.bodies.borrow().is_empty());
    fake.fail.set(true);
    assert!(run(&library, &fake, 100).is_err());
    let failed = fake.bodies.borrow().last().unwrap().clone();
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    fake.fail.set(false);
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 120).unwrap();
    assert!(fake.bodies.borrow().is_empty());
    run(&library, &fake, 200).unwrap();
    assert_eq!(fake.bodies.borrow()[0], failed);
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    run(&library, &fake, 201).unwrap();
    assert_eq!(assets(&fake).len(), 240);
    let mut ids = assets(&fake)
        .iter()
        .map(|row| row["assetId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 240);
}
#[test]
fn removed_assets_publish_an_empty_replacement() {
    let (_temp, library) = fixture(1);
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM assets WHERE id='a0000'", [])
        .unwrap();
    fake.bodies.borrow_mut().clear();
    library.publication_inputs.signal(&[11]);
    run(&library, &fake, 200).unwrap();
    assert_eq!(
        assets(&fake),
        vec![json!({"assetId":"a0000","creatorKey":null,"tags":[],"contentRating":null})]
    );
}
#[test]
fn publisher_http_boundary_uses_separate_route_and_token() {
    let (client, requests) = crate::cloud::client::CloudClient::home_test_client(vec![
        json!({"version":2,"revision":1,"changed":true,"assets":0,"vocabulary":0}),
    ]);
    client
        .publish(
            PATH,
            Some(&json!({"version":2,"assets":[],"vocabulary":[]})),
            "publisher",
        )
        .unwrap();
    let requests = requests.lock().unwrap();
    let request = String::from_utf8_lossy(&requests[0]);
    assert!(request.starts_with("PUT /v1/library/auto-tags "));
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer publisher"));
}

#[test]
fn successful_asset_pages_are_not_resent_after_a_later_page_fails() {
    let (temp, library) = fixture(240);
    let fake = Fake::default();
    fake.fail_asset_page.set(Some(2));
    assert!(run(&library, &fake, 100).is_err());
    assert_eq!(assets(&fake).len(), 200);
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    fake.fail_asset_page.set(None);
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 200).unwrap();
    let resumed = assets(&fake);
    assert_eq!(resumed.len(), 140);
    assert_eq!(resumed[0]["assetId"], "a0100");
}
#[test]
fn confirmed_characters_hide_model_guesses_but_keep_added_tags() {
    let (_temp, library) = fixture(1);
    {
        let db = library.connection().unwrap();
        db.execute("INSERT INTO character_targets(id,display_name,enabled,created_at,updated_at) VALUES('c','C',1,'t','t')",[]).unwrap();
        db.execute("INSERT INTO character_references(target_id,slot,asset_id,asset_hash) VALUES('c',0,'a0000','hash')",[]).unwrap();
    }
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    assert_eq!(
        assets(&fake)[0]["tags"],
        json!(["added_(series)", "long_hair"])
    );
}
#[test]
fn new_vocabulary_during_a_resumed_scan_is_sent_before_assets() {
    let (_temp, library) = fixture(240);
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    {
        let db = library.connection().unwrap();
        db.execute(
            "INSERT INTO auto_tag_vocabulary VALUES('new_tag','general')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO asset_auto_tags VALUES('a0200','new_tag',0.9)",
            [],
        )
        .unwrap();
    }
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 101).unwrap();
    assert_eq!(fake.bodies.borrow()[0]["vocabulary"][0]["id"], "new_tag");
    assert_eq!(assets(&fake)[0]["tags"], json!(["new_tag"]));
}
#[test]
fn v119_upgrade_preserves_existing_home_state_and_tags() {
    let temp = tempfile::tempdir().unwrap();
    {
        let mut db =
            crate::library::db::open_database(&temp.path().join("library.sqlite")).unwrap();
        crate::library::db::tests::historical_schema(&mut db, 119);
        seed(&db, 1);
        db.execute(
            "INSERT INTO home_publication_state VALUES('endpoint','artists','{}')",
            [],
        )
        .unwrap();
    }
    let library = Library::open(temp.path()).unwrap();
    let db = library.connection().unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::library::db::SCHEMA_VERSION
    );
    assert_eq!(
        db.query_row("SELECT state_json FROM home_publication_state", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "{}"
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM asset_auto_tags", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM asset_auto_tag_edits", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM auto_tag_vocabulary", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert!(db
        .query_row(
            "SELECT likes_album_id IS NULL FROM library_settings",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM auto_tag_publication_digests",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn excess_tags_are_capped_by_manual_score_and_id_without_stalling() {
    let (_temp, library) = fixture(2);
    {
        let db = library.connection().unwrap();
        db.execute("DELETE FROM asset_auto_tags", []).unwrap();
        db.execute("DELETE FROM asset_auto_tag_edits", []).unwrap();
        for i in 0..1001 {
            let tag = format!("tag_{i:04}");
            db.execute(
                "INSERT INTO auto_tag_vocabulary VALUES(?1,'general')",
                [&tag],
            )
            .unwrap();
            db.execute(
                "INSERT INTO asset_auto_tags VALUES('a0000',?1,?2)",
                params![tag, if i == 1000 { 0.1 } else { 0.9 }],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO asset_auto_tag_edits VALUES('a0000','tag_1000','added','t')",
            [],
        )
        .unwrap();
    }
    let fake = Fake::default();
    for time in 100..105 {
        run(&library, &fake, time).unwrap();
    }
    let published = assets(&fake);
    assert_eq!(published.len(), 2);
    let tags = published[0]["tags"].as_array().unwrap();
    assert_eq!(tags.len(), MAX_TAGS_PER_ASSET);
    assert!(tags.contains(&json!("tag_1000")));
    assert!(tags.contains(&json!("tag_0000")));
    assert!(!tags.contains(&json!("tag_0999")));
    assert_eq!(published[1]["assetId"], "a0001");
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 200).unwrap();
    run(&library, &fake, 201).unwrap();
    assert!(assets(&fake).is_empty());
    {
        let db = library.connection().unwrap();
        db.execute("DELETE FROM asset_auto_tag_edits", []).unwrap();
        db.execute(
            "UPDATE asset_auto_tags SET score=1 WHERE tag='tag_0999'",
            [],
        )
        .unwrap();
    }
    library.publication_inputs.signal(&[11]);
    run(&library, &fake, 300).unwrap();
    run(&library, &fake, 301).unwrap();
    let published = assets(&fake);
    let tags = published[0]["tags"].as_array().unwrap();
    assert!(tags.contains(&json!("tag_0999")));
    assert!(!tags.contains(&json!("tag_1000")));
}

#[test]
fn malformed_asset_is_skipped_and_retried_on_the_next_scan() {
    let (_temp, library) = fixture(240);
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET creator_handle='' WHERE id='a0000'", [])
        .unwrap();
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    run(&library, &fake, 101).unwrap();
    let published = assets(&fake);
    assert_eq!(published.len(), 239);
    assert_eq!(published[0]["assetId"], "a0001");
    assert_eq!(published.last().unwrap()["assetId"], "a0239");
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET creator_handle='alice' WHERE id='a0000'",
            [],
        )
        .unwrap();
    fake.bodies.borrow_mut().clear();
    library.publication_inputs.signal(&[11]);
    run(&library, &fake, 200).unwrap();
    assert_eq!(assets(&fake)[0]["assetId"], "a0000");
}

#[test]
fn publication_tag_limit_matches_server_validation() {
    let server = include_str!("../../../../../server/lakomics-api/library_search.py");
    assert!(server.contains(&format!("MAX_TAGS_PER_ASSET = {}", MAX_TAGS_PER_ASSET)));
    assert!(server.contains("Field(max_length=MAX_TAGS_PER_ASSET)"));
}

#[test]
fn auto_tag_rating_is_published_but_never_a_search_tag_and_changes_identity() {
    let (_temp, library) = fixture(1);
    {
        let db = library.connection().unwrap();
        db.execute_batch(
            "DELETE FROM asset_auto_tags WHERE tag='rating';
          INSERT INTO auto_tag_vocabulary VALUES('rating:g','rating'),('rating:e','rating');
          INSERT INTO asset_auto_tags VALUES('a0000','rating:g',0.9),('a0000','rating:e',0.1);",
        )
        .unwrap();
    }
    assert_eq!(
        library
            .get_asset("a0000")
            .unwrap()
            .content_rating
            .as_deref(),
        Some("g")
    );
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    assert_eq!(assets(&fake)[0]["contentRating"], "g");
    assert!(!assets(&fake)[0]["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag.as_str().unwrap().starts_with("rating:")));
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE asset_auto_tags SET score=1.0 WHERE tag='rating:e'",
            [],
        )
        .unwrap();
    fake.bodies.borrow_mut().clear();
    library.publication_inputs.signal(&[11]);
    run(&library, &fake, 200).unwrap();
    assert_eq!(assets(&fake)[0]["contentRating"], "e");
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 300).unwrap();
    assert!(assets(&fake).is_empty());
}

#[test]
fn auto_tag_video_rating_is_null_in_publication() {
    let (_temp, library) = fixture(1);
    library
        .connection()
        .unwrap()
        .execute_batch(
            "DELETE FROM asset_auto_tags WHERE tag='rating';
         INSERT INTO auto_tag_vocabulary VALUES('rating:g','rating');
         INSERT INTO asset_auto_tags VALUES('a0000','rating:g',1.0);
         UPDATE assets SET media_kind='video' WHERE id='a0000';
         INSERT INTO video_assets(asset_id,duration_ms,container,video_codec,preparation_state)
         VALUES('a0000',1000,'mp4','h264','pending');",
        )
        .unwrap();
    assert_eq!(library.get_asset("a0000").unwrap().content_rating, None);
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    assert!(assets(&fake)[0]["contentRating"].is_null());
}

#[test]
fn completed_pass_is_idle_until_signal_or_six_hour_verification() {
    let (_temp, library) = fixture(2);
    let fake = Fake::default();
    let endpoint = "https://example.invalid/";
    run(&library, &fake, 100).unwrap();
    let checkpoint = || State::load(&*library.connection().unwrap(), endpoint).unwrap();
    assert_eq!(checkpoint().next_verification, 100 + VERIFICATION_INTERVAL);
    fake.bodies.borrow_mut().clear();
    for time in [101, 160, 700, 100 + VERIFICATION_INTERVAL - 1] {
        assert!(!library
            .auto_tag_publication_due_on(&*library.connection().unwrap(), endpoint, time)
            .unwrap());
        run(&library, &fake, time).unwrap();
        assert_eq!(checkpoint().next_verification, 100 + VERIFICATION_INTERVAL);
    }
    assert!(fake.bodies.borrow().is_empty());
    // An uninstrumented writer is eventually found by the safety pass.
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET creator_handle='new' WHERE id='a0001'",
            [],
        )
        .unwrap();
    run(&library, &fake, 100 + VERIFICATION_INTERVAL).unwrap();
    assert_eq!(assets(&fake).len(), 1);
    assert_eq!(assets(&fake)[0]["creatorKey"], "new");
    fake.bodies.borrow_mut().clear();
    // The real edit facade wakes the lane inside the safety interval.
    library
        .edit_asset_auto_tag("a0000", "long_hair", auto_tags::AutoTagEdit::Remove)
        .unwrap();
    assert!(library
        .auto_tag_publication_due_on(
            &*library.connection().unwrap(),
            endpoint,
            101 + VERIFICATION_INTERVAL
        )
        .unwrap());
    run(&library, &fake, 101 + VERIFICATION_INTERVAL).unwrap();
    assert_eq!(assets(&fake).len(), 1);
    assert_eq!(assets(&fake)[0]["assetId"], "a0000");
    assert!(!assets(&fake)[0]["tags"]
        .as_array()
        .unwrap()
        .contains(&json!("long_hair")));
}

#[test]
fn signal_rechecks_edits_behind_an_incomplete_cursor_and_restart_verifies_again() {
    let (temp, library) = fixture(240);
    let fake = Fake::default();
    run(&library, &fake, 100).unwrap();
    fake.bodies.borrow_mut().clear();
    library
        .edit_asset_auto_tag("a0000", "low_(series)", auto_tags::AutoTagEdit::Add)
        .unwrap();
    run(&library, &fake, 101).unwrap();
    assert_eq!(assets(&fake)[0]["assetId"], "a0000");
    assert!(assets(&fake)[0]["tags"]
        .as_array()
        .unwrap()
        .contains(&json!("low_(series)")));
    run(&library, &fake, 102).unwrap();
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    assert!(library
        .auto_tag_publication_due_on(
            &*library.connection().unwrap(),
            "https://example.invalid",
            103
        )
        .unwrap());
    fake.bodies.borrow_mut().clear();
    run(&library, &fake, 103).unwrap();
    run(&library, &fake, 104).unwrap();
    assert!(assets(&fake).is_empty()); // A startup verification retains publication receipts.
}
