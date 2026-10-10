use super::*;
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct Fake {
    bodies: RefCell<Vec<Value>>,
    /// Fail the request with this 1-based number (counted over the fake's lifetime).
    fail_request: Cell<Option<usize>>,
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
        let bytes = serde_json::to_vec(&body).unwrap().len();
        assert!(bytes <= MAX_BYTES, "request of {bytes} bytes");
        let captions = body["captions"].as_array().unwrap().len();
        let names = body["names"].as_array().unwrap().len();
        assert!(captions <= BATCH_ROWS && names <= BATCH_ROWS);
        assert_eq!(body["version"], 1);
        self.bodies.borrow_mut().push(body);
        if self.fail_request.get() == Some(self.bodies.borrow().len()) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(json!({"version":1,"revision":1,"changed":true,"captions":captions,"names":names}))
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
impl Fake {
    fn captions(&self) -> Vec<Value> {
        self.bodies
            .borrow()
            .iter()
            .flat_map(|b| b["captions"].as_array().unwrap().clone())
            .collect()
    }
    fn names(&self) -> Vec<Value> {
        self.bodies
            .borrow()
            .iter()
            .flat_map(|b| b["names"].as_array().unwrap().clone())
            .collect()
    }
    fn clear(&self) {
        self.bodies.borrow_mut().clear();
    }
}

const ENDPOINT: &str = "https://example.invalid";

fn insert_asset(db: &Connection, id: &str, kind: &str, status: &str) {
    db.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status) VALUES(?1,?1,?2,?1,?1,?1,1,10,10,'2026-10-01',?3)", params![id, kind, status]).unwrap();
}
fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    {
        let db = library.connection().unwrap();
        for (id, kind, status) in [
            ("a1", "image", "normal"),
            ("a2", "gif", "normal"),
            ("v1", "video", "normal"),
            ("t1", "image", "trash"),
        ] {
            insert_asset(&db, id, kind, status);
        }
        db.execute_batch(
            "INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES('csm','work','체인소맨',NULL,'t');
            INSERT INTO character_targets(id,series_classification_id,display_name,enabled,created_at,updated_at) VALUES('reze','csm','레제/Reze',1,'t','t'),('solo',NULL,'솔로',1,'t','t');
            INSERT INTO character_target_tagger_tags VALUES('reze','reze_(chainsaw_man)'),('reze','reze');",
        )
        .unwrap();
    }
    (temp, library)
}
/// Replace the imported cache; `None` writes a cache without a caption table (an older export).
fn cache(library: &Library, captions: Option<&[(&str, &str)]>) {
    let path = library.nl_search_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let _ = std::fs::remove_file(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
        .unwrap();
    if let Some(captions) = captions {
        conn.execute_batch("CREATE TABLE captions(asset_id TEXT PRIMARY KEY,text TEXT NOT NULL);")
            .unwrap();
        for (id, text) in captions {
            conn.execute("INSERT INTO captions VALUES(?1,?2)", params![id, text])
                .unwrap();
        }
    }
}
fn run(library: &Library, fake: &Fake, now: i64) -> Result<(), LibraryError> {
    library.run_captions_with(fake, "publisher", ENDPOINT, now)
}
fn state(library: &Library) -> State {
    State::load(
        &*library.connection().unwrap(),
        &crate::cloud::status_watch::endpoint_key(ENDPOINT),
    )
    .unwrap()
}
fn digests(library: &Library, kind: &str) -> i64 {
    library
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM caption_publication_digests WHERE kind=?1",
            [kind],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn first_publication_sends_names_and_eligible_captions_then_nothing() {
    let (_temp, library) = fixture();
    cache(
        &library,
        Some(&[
            ("a1", "  흰 머리 소녀  "),
            ("a2", "빨간 우산"),
            ("v1", "영상"),
            ("t1", "휴지통"),
            ("zz", "없는 에셋"),
            ("a3", " "),
        ]),
    );
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    assert_eq!(
        fake.captions(),
        vec![
            json!({"assetId":"a1","text":"흰 머리 소녀"}),
            json!({"assetId":"a2","text":"빨간 우산"})
        ]
    );
    assert_eq!(
        fake.names(),
        vec![
            json!({"targetId":"reze","displayName":"레제/Reze","seriesName":"체인소맨","tags":["reze","reze_(chainsaw_man)"]}),
            json!({"targetId":"solo","displayName":"솔로","seriesName":null,"tags":[]}),
        ]
    );
    assert_eq!(
        (digests(&library, "caption"), digests(&library, "name")),
        (2, 2)
    );
    let saved = state(&library);
    assert!(
        !saved.more
            && saved.retry_after == 0
            && saved.next_verification == 1000 + VERIFICATION_INTERVAL
    );
    assert_eq!(saved.cache_stamp, library.nl_search_cache_stamp());
    fake.clear();
    run(&library, &fake, 1100).unwrap();
    assert!(
        fake.bodies.borrow().is_empty(),
        "unchanged data is not sent again"
    );
}

#[test]
fn changes_and_removals_send_only_the_differences_with_explicit_deletions() {
    let (_temp, library) = fixture();
    cache(&library, Some(&[("a1", "하나"), ("a2", "둘")]));
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    fake.clear();
    // a1 changed, a2 left the export; a character was renamed and the other deleted.
    cache(&library, Some(&[("a1", "하나 수정")]));
    {
        let db = library.connection().unwrap();
        db.execute(
            "UPDATE character_targets SET display_name='레제/Reze/폭탄' WHERE id='reze'",
            [],
        )
        .unwrap();
        db.execute("DELETE FROM character_targets WHERE id='solo'", [])
            .unwrap();
    }
    run(&library, &fake, 1100).unwrap();
    assert_eq!(
        fake.captions(),
        vec![
            json!({"assetId":"a1","text":"하나 수정"}),
            json!({"assetId":"a2","text":null})
        ]
    );
    let names = fake.names();
    assert_eq!(names.len(), 2);
    assert_eq!(names[0]["displayName"], "레제/Reze/폭탄");
    assert_eq!(names[1], json!({"targetId":"solo","deleted":true}));
    assert_eq!(
        (digests(&library, "caption"), digests(&library, "name")),
        (1, 1)
    );
    fake.clear();
    run(&library, &fake, 1200).unwrap();
    assert!(fake.bodies.borrow().is_empty());
}

#[test]
fn a_trashed_asset_is_removed_at_the_next_verification() {
    let (_temp, library) = fixture();
    cache(&library, Some(&[("a1", "하나"), ("a2", "둘")]));
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    fake.clear();
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status='trash' WHERE id='a2'", [])
        .unwrap();
    run(&library, &fake, 1100).unwrap();
    assert!(
        fake.captions().is_empty(),
        "eligibility is re-read only on a scan"
    );
    run(&library, &fake, 1000 + VERIFICATION_INTERVAL).unwrap();
    assert_eq!(fake.captions(), vec![json!({"assetId":"a2","text":null})]);
}

#[test]
fn a_cache_without_captions_never_deletes_published_ones() {
    let (_temp, library) = fixture();
    cache(&library, Some(&[("a1", "하나")]));
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    fake.clear();
    cache(&library, None);
    run(&library, &fake, 1100).unwrap();
    assert!(fake.captions().is_empty());
    assert_eq!(digests(&library, "caption"), 1);
    std::fs::remove_file(library.nl_search_path()).unwrap();
    run(&library, &fake, 1000 + VERIFICATION_INTERVAL).unwrap();
    assert!(fake.captions().is_empty());
    assert_eq!(digests(&library, "caption"), 1);
}

#[test]
fn large_publications_are_batched_bounded_per_tick_and_resume() {
    let (_temp, library) = fixture();
    let ids: Vec<String> = (0..4500).map(|i| format!("b{i:05}")).collect();
    {
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        for id in &ids {
            insert_asset(&tx, id, "image", "normal");
        }
        tx.commit().unwrap();
    }
    let rows: Vec<(&str, String)> = ids
        .iter()
        .map(|id| (id.as_str(), format!("캡션 {id}")))
        .collect();
    let borrowed: Vec<(&str, &str)> = rows.iter().map(|(id, text)| (*id, text.as_str())).collect();
    cache(&library, Some(&borrowed));
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    // Names ride their own request; captions fill the other three of this tick's four requests.
    assert_eq!(fake.bodies.borrow().len(), BATCHES_PER_TICK);
    assert_eq!(fake.captions().len(), 3 * BATCH_ROWS);
    assert!(state(&library).more);
    assert!(library
        .caption_publication_due_on(&*library.connection().unwrap(), ENDPOINT, 1001)
        .unwrap());
    fake.clear();
    run(&library, &fake, 1001).unwrap();
    assert_eq!(fake.captions().len(), 1500);
    assert!(!state(&library).more);
    assert_eq!(digests(&library, "caption"), 4500);
    fake.clear();
    run(&library, &fake, 1002).unwrap();
    assert!(fake.bodies.borrow().is_empty());
}

#[test]
fn requests_stay_below_the_byte_limit() {
    let (_temp, library) = fixture();
    let ids: Vec<String> = (0..1200).map(|i| format!("c{i:05}")).collect();
    {
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        for id in &ids {
            insert_asset(&tx, id, "image", "normal");
        }
        tx.commit().unwrap();
    }
    let long = "가".repeat(MAX_CAPTION_CHARS);
    let borrowed: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), long.as_str())).collect();
    cache(&library, Some(&borrowed));
    let fake = Fake::default();
    let mut now = 1000;
    while now < 1100 && (now == 1000 || state(&library).more) {
        run(&library, &fake, now).unwrap();
        now += 1;
    }
    assert_eq!(fake.captions().len(), 1200);
    // 12 KB per row: about 500 rows per 6 MiB request.
    assert!(
        fake.bodies
            .borrow()
            .iter()
            .filter(|b| !b["captions"].as_array().unwrap().is_empty())
            .count()
            >= 3
    );
}

#[test]
fn invalid_rows_are_skipped_not_fatal() {
    let (_temp, library) = fixture();
    let too_long = "가".repeat(MAX_CAPTION_CHARS + 1);
    cache(&library, Some(&[("a1", "정상"), ("a2", too_long.as_str())]));
    library.connection().unwrap().execute("INSERT INTO character_targets(id,display_name,enabled,created_at,updated_at) VALUES('bad id!','이상',1,'t','t')", []).unwrap();
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    assert_eq!(fake.captions().len(), 1);
    assert_eq!(fake.names().len(), 2);
}

#[test]
fn failure_keeps_acknowledged_rows_backs_off_and_resumes() {
    let (_temp, library) = fixture();
    cache(&library, Some(&[("a1", "하나")]));
    let fake = Fake::default();
    // Request 1 carries the names, request 2 the caption: fail the second.
    fake.fail_request.set(Some(2));
    assert!(run(&library, &fake, 1000).is_err());
    assert_eq!(
        (digests(&library, "name"), digests(&library, "caption")),
        (2, 0)
    );
    let failed = state(&library);
    assert_eq!(
        (failed.failures, failed.retry_after, failed.more),
        (1, 1060, true)
    );
    fake.clear();
    run(&library, &fake, 1010).unwrap();
    assert!(fake.bodies.borrow().is_empty(), "backoff holds the lane");
    run(&library, &fake, 1060).unwrap();
    assert_eq!(fake.captions(), vec![json!({"assetId":"a1","text":"하나"})]);
    assert!(fake.names().is_empty(), "acknowledged names are not resent");
    let saved = state(&library);
    assert_eq!(
        (saved.failures, saved.retry_after, saved.more),
        (0, 0, false)
    );
}

#[test]
fn a_bad_reply_is_a_failure() {
    struct Wrong;
    impl HomeTransport for Wrong {
        fn publish(&self, _: &str, _: Option<&Value>, _: &str) -> Result<Value, LibraryError> {
            Ok(json!({"version":1,"revision":1,"changed":true,"captions":0,"names":0}))
        }
        fn intents(&self, _: i64, _: &str) -> Result<Value, LibraryError> {
            panic!()
        }
        fn artwork(
            &self,
            _: &crate::cloud::collections::ArtworkBlob,
            _: &[u8],
            _: &str,
        ) -> Result<(), LibraryError> {
            panic!()
        }
    }
    let (_temp, library) = fixture();
    cache(&library, Some(&[("a1", "하나")]));
    assert!(library
        .run_captions_with(&Wrong, "publisher", ENDPOINT, 1000)
        .is_err());
    assert_eq!(digests(&library, "name") + digests(&library, "caption"), 0);
}

#[test]
fn the_dispatcher_hint_follows_imports_and_verification() {
    let (_temp, library) = fixture();
    let due = |now| {
        library
            .caption_publication_due_on(&*library.connection().unwrap(), ENDPOINT, now)
            .unwrap()
    };
    assert!(
        !due(1000),
        "nothing imported and never run: left to the startup dispatch"
    );
    cache(&library, Some(&[("a1", "하나")]));
    assert!(due(1000));
    let fake = Fake::default();
    run(&library, &fake, 1000).unwrap();
    assert!(!due(1001));
    assert!(due(1000 + VERIFICATION_INTERVAL));
    cache(&library, Some(&[("a1", "하나"), ("a2", "둘")]));
    assert!(due(1001), "a new import");
}
