use super::*;
use std::{
    cell::{Cell, RefCell},
    io::Cursor,
};

struct FakeHttp {
    now: Cell<u64>,
    bulk: Vec<u8>,
    image: Vec<u8>,
    requests: RefCell<Vec<(String, u64)>>,
    waits: RefCell<Vec<u64>>,
    fail_bulk: Cell<bool>,
    cancel_on_wait: Cell<bool>,
}
impl FakeHttp {
    fn new(xml: &str) -> Self {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "Metadata.xml",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        let bulk = zip.finish().unwrap().into_inner();
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8, 64)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        Self {
            now: Cell::new(DAY_MS * 5),
            bulk,
            image: png.into_inner(),
            requests: RefCell::new(Vec::new()),
            waits: RefCell::new(Vec::new()),
            fail_bulk: Cell::new(false),
            cancel_on_wait: Cell::new(false),
        }
    }
    fn image_requests(&self) -> Vec<(String, u64)> {
        self.requests
            .borrow()
            .iter()
            .filter(|(url, _)| url.starts_with(IMAGE_BASE))
            .cloned()
            .collect()
    }
    fn bulk_count(&self) -> usize {
        self.requests
            .borrow()
            .iter()
            .filter(|(url, _)| url == BULK_URL)
            .count()
    }
}
impl Transport for FakeHttp {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
    fn wait(&self, millis: u64, cancel: &AtomicBool) -> Result<()> {
        self.waits.borrow_mut().push(millis);
        if self.cancel_on_wait.get() {
            cancel.store(true, Ordering::Relaxed);
        }
        self.now.set(self.now.get() + millis);
        check_cancel(cancel)
    }
    fn download(
        &self,
        url: &str,
        max: u64,
        out: &mut dyn Write,
        cancel: &AtomicBool,
    ) -> Result<()> {
        check_cancel(cancel)?;
        self.requests
            .borrow_mut()
            .push((url.into(), self.now.get()));
        let bytes = if url == BULK_URL {
            &self.bulk
        } else {
            &self.image
        };
        assert!(bytes.len() as u64 <= max);
        if url == BULK_URL && self.fail_bulk.get() {
            out.write_all(&bytes[..bytes.len() / 2])?;
            return Err(Error::Http("fixture_partial_failure".into()));
        }
        out.write_all(bytes)?;
        Ok(())
    }
}
fn metadata(games: &[(&str, &str, &str)], images: &[(&str, &str, &str)]) -> String {
    let mut s = "<?xml version=\"1.0\"?><LaunchBox>".to_owned();
    for (id, title, platform) in games {
        s+=&format!("<Game><DatabaseID>{id}</DatabaseID><Name>{title}</Name><Platform>{platform}</Platform><Overview>ignored</Overview></Game>");
    }
    for (id, file, region) in images {
        s+=&format!("<GameImage><DatabaseID>{id}</DatabaseID><FileName>{file}</FileName><Type>Box - Spine</Type><Region>{region}</Region></GameImage>");
    }
    s + "</LaunchBox>"
}
fn game(id: &str, title: &str, platforms: &str, owned: Option<&str>) -> Game {
    Game {
        id: id.into(),
        title: title.into(),
        original_title: None,
        platforms: Some(platforms.into()),
        owned: owned.map(Into::into),
    }
}
fn insert(library: &Library, id: &str, title: &str, platform: &str) {
    library.connection().unwrap().execute("INSERT INTO collections(id,name,type,platforms,created_at,updated_at) VALUES(?1,?2,'game',?3,'2026','2026')",params![id,title,platform]).unwrap();
}
fn fixture() -> (tempfile::TempDir, Library, tempfile::TempDir, FakeHttp) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let cache = tempfile::tempdir().unwrap();
    let io = FakeHttp::new(&metadata(
        &[
            ("1", "Example II: Adventure", "Nintendo Switch"),
            ("2", "Another Game", "Windows"),
        ],
        &[("1", "one.png", "Korea"), ("2", "two.png", "Japan")],
    ));
    (temp, library, cache, io)
}
const ID1: &str = "00000000-0000-4000-8000-000000000001";
const ID2: &str = "00000000-0000-4000-8000-000000000002";
const ID3: &str = "00000000-0000-4000-8000-000000000003";

#[test]
fn launchbox_bulk_reuses_daily_cache_and_preserves_good_copy_after_partial_failure() {
    let cache = tempfile::tempdir().unwrap();
    let io = FakeHttp::new(&metadata(
        &[("1", "Game", "Windows")],
        &[("1", "spine.jpg", "World")],
    ));
    let cancel = AtomicBool::new(false);
    assert_eq!(
        ensure_index(cache.path(), &io, &cancel)
            .unwrap()
            .games
            .len(),
        1
    );
    let state: BulkState = read_json(&cache.path().join("bulk-state.json"), 4096).unwrap();
    let good = cache.path().join(format!(
        "Metadata-{}.zip",
        state.generation.as_ref().unwrap()
    ));
    let bytes = fs::read(&good).unwrap();
    io.now.set(io.now.get() + DAY_MS - 1);
    ensure_index(cache.path(), &io, &cancel).unwrap();
    assert_eq!(io.bulk_count(), 1);
    io.now.set(io.now.get() + 1);
    io.fail_bulk.set(true);
    ensure_index(cache.path(), &io, &cancel).unwrap();
    assert_eq!(io.bulk_count(), 2);
    assert_eq!(fs::read(&good).unwrap(), bytes);
    let after: BulkState = read_json(&cache.path().join("bulk-state.json"), 4096).unwrap();
    assert_eq!(after.generation, state.generation);
    assert_eq!(after.downloaded_at, state.downloaded_at);
    ensure_index(cache.path(), &io, &cancel).unwrap();
    assert_eq!(io.bulk_count(), 2);
    assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 3);
}
#[test]
fn launchbox_failed_first_download_is_not_retried_within_a_day() {
    let cache = tempfile::tempdir().unwrap();
    let io = FakeHttp::new("<LaunchBox></LaunchBox>");
    io.fail_bulk.set(true);
    let cancel = AtomicBool::new(false);
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert_eq!(io.bulk_count(), 1);
    io.now.set(io.now.get() + DAY_MS);
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert_eq!(io.bulk_count(), 2);
}
#[test]
fn launchbox_matching_prefers_owned_platform_then_platform_order_and_region() {
    let io = FakeHttp::new(&metadata(
        &[
            ("1", "Example II: Adventure", "Nintendo Switch"),
            ("2", "Example 2: Adventure", "Sony Playstation 5"),
            ("3", "Example II", "Nintendo Switch 2"),
        ],
        &[
            ("1", "us.jpg", "North America"),
            ("1", "jp.jpg", "Japan"),
            ("1", "kr.jpg", "Korea"),
            ("2", "ps5.jpg", "World"),
            ("3", "switch2.jpg", "World"),
        ],
    ));
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("fixture.zip"), &io.bulk).unwrap();
    let index = parse_zip(&temp.path().join("fixture.zip"), &AtomicBool::new(false)).unwrap();
    let mut g = game(
        ID1,
        "EXAMPLE 2™: Adventure®",
        "Switch · PlayStation 5 · Switch 2",
        Some("PS5"),
    );
    assert_eq!(match_game(&g, &index).unwrap().0.database_id, "2");
    g.owned = Some("Switch".into());
    assert_eq!(match_game(&g, &index).unwrap().1.file_name, "kr.jpg");
    g.owned = None;
    assert_eq!(match_game(&g, &index).unwrap().0.database_id, "3");
    g.title = "Korean title".into();
    g.original_title = Some("Example II: Adventure".into());
    assert_eq!(match_game(&g, &index).unwrap().0.database_id, "3");
    g.platforms = Some("Xbox".into());
    assert!(matches!(
        match_game(&g, &index),
        Err((_, OutcomeStatus::NoMatch))
    ));
}
#[test]
fn launchbox_matching_rejects_ambiguous_titles_and_subtitle_collisions() {
    let io = FakeHttp::new(&metadata(
        &[
            ("1", "Example II: Adventure", "Windows"),
            ("2", "Example 2: Other", "Windows"),
        ],
        &[("1", "a.jpg", "Korea"), ("2", "b.jpg", "Korea")],
    ));
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("fixture.zip"), &io.bulk).unwrap();
    let mut index = parse_zip(&temp.path().join("fixture.zip"), &AtomicBool::new(false)).unwrap();
    let g = game(ID1, "Example 2", "PC", None);
    assert!(matches!(
        match_game(&g, &index),
        Err((_, OutcomeStatus::Ambiguous))
    ));
    let g = game(ID1, "Example 2: Adventure", "PC", None);
    assert_eq!(match_game(&g, &index).unwrap().0.database_id, "1");
    index.games[1].title = "Example II: Adventure".into();
    assert!(matches!(
        match_game(&g, &index),
        Err((_, OutcomeStatus::Ambiguous))
    ));
}
#[test]
fn launchbox_streaming_xml_handles_entities_and_ignores_other_image_types() {
    let xml="<LaunchBox><Game><DatabaseID>1</DatabaseID><Name>Rock &amp; Roll &#50;<![CDATA[: More]]></Name><Platform>Windows</Platform></Game><GameImage><DatabaseID>1</DatabaseID><FileName>cover.png</FileName><Type>Box - Front</Type></GameImage><GameImage><DatabaseID>1</DatabaseID><FileName>spine.png</FileName><Type>Box - Spine</Type></GameImage></LaunchBox>";
    let io = FakeHttp::new(xml);
    let temp = tempfile::tempdir().unwrap();
    let p = temp.path().join("fixture.zip");
    fs::write(&p, &io.bulk).unwrap();
    let index = parse_zip(&p, &AtomicBool::new(false)).unwrap();
    assert_eq!(index.games[0].title, "Rock & Roll 2: More");
    assert_eq!(index.games[0].images.len(), 1);
    fs::write(&p, FakeHttp::new("<LaunchBox><Game>").bulk).unwrap();
    assert!(parse_zip(&p, &AtomicBool::new(false)).is_err());
    fs::write(
        &p,
        FakeHttp::new(&metadata(
            &[("1", "Game", "PC")],
            &[("1", "../escape.jpg", "Korea")],
        ))
        .bulk,
    )
    .unwrap();
    assert!(parse_zip(&p, &AtomicBool::new(false)).is_err());
}
#[test]
fn launchbox_imports_spine_and_never_replaces_an_existing_user_choice() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Example 2: Adventure", "Switch");
    let mut runner = FetchState::default();
    let cancel = AtomicBool::new(false);
    let g = load_game(&library, ID1).unwrap();
    let result = runner
        .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
        .unwrap();
    assert_eq!(result.status, OutcomeStatus::Matched);
    let connection = library.connection().unwrap();
    let row: (String, String, bool) = connection
        .query_row(
            "SELECT kind,provider,selected FROM collection_work_artworks WHERE id=?1",
            [result.artwork_id.as_ref().unwrap()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("spine".into(), "launchbox".into(), true));
    connection.execute("UPDATE collection_work_artworks SET provider='local-manual',provider_image_id='user-choice' WHERE collection_id=?1",[ID1]).unwrap();
    drop(connection);
    let again = runner
        .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
        .unwrap();
    assert_eq!(again.status, OutcomeStatus::Skipped);
    assert_eq!(io.image_requests().len(), 1);
    // Simulate a user import after matching, while the remote image is being fetched.
    let index = ensure_index(cache.path(), &io, &cancel).unwrap();
    let (c, i) = match_game(&g, &index).unwrap();
    assert!(store_spine(&library, &g, c, i, &io.image)
        .unwrap()
        .is_none());
    let connection = library.connection().unwrap();
    let row:(i64,String,bool)=connection.query_row("SELECT COUNT(*),provider,selected FROM collection_work_artworks WHERE collection_id=?1",[ID1],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(row, (1, "local-manual".into(), true));
    assert_eq!(
        fs::read_dir(library.root().join("work-artwork").join(ID1))
            .unwrap()
            .count(),
        1
    );
}
#[test]
fn launchbox_outcomes_are_cached_and_invalidated_when_matching_inputs_change() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Unmatched", "Switch");
    let cancel = AtomicBool::new(false);
    let mut runner = FetchState::default();
    let g = load_game(&library, ID1).unwrap();
    let out = runner
        .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::NoMatch);
    let out = runner
        .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
        .unwrap();
    assert!(out.cached);
    assert_eq!(io.bulk_count(), 1);
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE collections SET name='Example 2: Adventure' WHERE id=?1",
            [ID1],
        )
        .unwrap();
    let g = load_game(&library, ID1).unwrap();
    assert_eq!(
        runner
            .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
            .unwrap()
            .status,
        OutcomeStatus::Matched
    );
}
#[test]
fn launchbox_batch_is_bounded_serial_paced_resumable_and_cancellable() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Example 2: Adventure", "Switch");
    insert(&library, ID2, "Another Game", "PC");
    insert(&library, ID3, "Unknown", "PC");
    let mut runner = FetchState::default();
    let cancel = AtomicBool::new(false);
    let events = RefCell::new(Vec::new());
    let result = runner
        .batch_with(&library, cache.path(), "job", 2, None, &io, &cancel, &|p| {
            events.borrow_mut().push(p)
        })
        .unwrap();
    assert!(!result.cancelled);
    assert!(result.has_more);
    assert_eq!(result.next_cursor.as_deref(), Some(ID2));
    assert_eq!(result.outcomes.len(), 2);
    let requests = io.image_requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].1 - requests[0].1 >= 1000);
    assert_eq!(io.bulk_count(), 1);
    assert_eq!(events.borrow().last().unwrap().phase, "completed");
    assert_eq!(
        events
            .borrow()
            .iter()
            .filter(|p| p.phase == "game_completed")
            .count(),
        2
    );
    let end = runner
        .batch_with(
            &library,
            cache.path(),
            "job",
            2,
            result.next_cursor,
            &io,
            &cancel,
            &|_| {},
        )
        .unwrap();
    assert_eq!(end.outcomes.len(), 1);
    assert!(!end.has_more);
    assert!(runner
        .batch_with(
            &library,
            cache.path(),
            "job",
            MAX_BATCH + 1,
            None,
            &io,
            &cancel,
            &|_| {}
        )
        .is_err());
    let (_temp, l, c, io) = fixture();
    insert(&l, ID1, "Example 2: Adventure", "Switch");
    insert(&l, ID2, "Another Game", "PC");
    io.cancel_on_wait.set(true);
    let mut runner = FetchState::default();
    let result = runner
        .batch_with(&l, c.path(), "job", 2, None, &io, &cancel, &|_| {})
        .unwrap();
    assert!(result.cancelled);
    assert!(result.has_more);
    assert_eq!(result.outcomes.len(), 1);
    assert_eq!(result.next_cursor.as_deref(), Some(ID1));
    assert_eq!(io.image_requests().len(), 1);
    assert!(!has_spine(&l, ID2).unwrap());
}
#[test]
fn launchbox_cancellation_ids_are_scoped_and_cleaned_up() {
    let id = uuid::Uuid::new_v4().to_string();
    let job = Job::register(id.clone()).unwrap();
    assert!(!cancel_job(&uuid::Uuid::new_v4().to_string()));
    assert!(cancel_job(&id));
    assert!(job.cancel.load(Ordering::Relaxed));
    assert!(matches!(Job::register(id.clone()), Err(Error::Busy)));
    drop(job);
    assert!(!cancel_job(&id));
}
#[test]
fn launchbox_batch_request_wire_fields_are_camel_case() {
    let request: SpineBatchRequest = serde_json::from_value(
        serde_json::json!({"action":"run","jobId":ID1,"limit":20,"afterCollectionId":ID2}),
    )
    .unwrap();
    assert!(
        matches!(request,SpineBatchRequest::Run{job_id,limit:20,after_collection_id:Some(after)} if job_id==ID1 && after==ID2)
    );
}

#[test]
fn launchbox_missing_platform_does_not_download_bulk() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Game", "");
    let mut runner = FetchState::default();
    let game = load_game(&library, ID1).unwrap();
    let outcome = runner
        .one_with(
            &library,
            cache.path(),
            &game,
            &io,
            &AtomicBool::new(false),
            &mut None,
            &|_| {},
        )
        .unwrap();
    assert_eq!(outcome.status, OutcomeStatus::NoMatch);
    assert_eq!(outcome.reason, "missing_platform");
    assert!(io.requests.borrow().is_empty());
}

#[test]
fn launchbox_image_pacing_survives_a_new_runner() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Example 2: Adventure", "Switch");
    insert(&library, ID2, "Another Game", "PC");
    let cancel = AtomicBool::new(false);
    for id in [ID1, ID2] {
        let mut runner = FetchState::default();
        let game = load_game(&library, id).unwrap();
        let outcome = runner
            .one_with(
                &library,
                cache.path(),
                &game,
                &io,
                &cancel,
                &mut None,
                &|_| {},
            )
            .unwrap();
        assert_eq!(outcome.status, OutcomeStatus::Matched);
    }
    let requests = io.image_requests();
    assert!(requests[1].1 - requests[0].1 >= 1000);
}

#[test]
fn launchbox_cancel_before_processing_preserves_the_resume_cursor() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID2, "Another Game", "PC");
    let mut runner = FetchState::default();
    let result = runner
        .batch_with(
            &library,
            cache.path(),
            "job",
            1,
            Some(ID1.into()),
            &io,
            &AtomicBool::new(true),
            &|_| {},
        )
        .unwrap();
    assert!(result.cancelled);
    assert!(result.has_more);
    assert_eq!(result.next_cursor.as_deref(), Some(ID1));
    assert!(result.outcomes.is_empty());
    assert!(io.requests.borrow().is_empty());
}

#[test]
fn launchbox_region_order_is_korea_japan_north_america_world_then_others() {
    let mut images = vec![
        SpineImage {
            file_name: "other.png".into(),
            region: "Europe".into(),
        },
        SpineImage {
            file_name: "world.png".into(),
            region: "World".into(),
        },
        SpineImage {
            file_name: "america.png".into(),
            region: "North America".into(),
        },
        SpineImage {
            file_name: "japan.png".into(),
            region: "Japan".into(),
        },
        SpineImage {
            file_name: "korea.png".into(),
            region: "Korea".into(),
        },
    ];
    let game = game(ID1, "Game", "PC", None);
    for file in [
        "korea.png",
        "japan.png",
        "america.png",
        "world.png",
        "other.png",
    ] {
        let index = Index {
            version: 1,
            games: vec![IndexedGame {
                database_id: "1".into(),
                title: "Game".into(),
                platform: "Windows".into(),
                images: images.clone(),
            }],
        };
        assert_eq!(match_game(&game, &index).unwrap().1.file_name, file);
        images.retain(|i| i.file_name != file);
    }
}

#[test]
fn launchbox_lost_derived_index_is_rebuilt_without_a_network_request() {
    let cache = tempfile::tempdir().unwrap();
    let io = FakeHttp::new(&metadata(
        &[("1", "Game", "PC")],
        &[("1", "spine.jpg", "Japan")],
    ));
    let cancel = AtomicBool::new(false);
    ensure_index(cache.path(), &io, &cancel).unwrap();
    let state: BulkState = read_json(&cache.path().join("bulk-state.json"), 4096).unwrap();
    let index_path = cache
        .path()
        .join(format!("index-{}.json", state.generation.unwrap()));
    fs::remove_file(&index_path).unwrap();
    assert_eq!(
        ensure_index(cache.path(), &io, &cancel)
            .unwrap()
            .games
            .len(),
        1
    );
    assert!(index_path.is_file());
    assert_eq!(io.bulk_count(), 1);
}

#[test]
fn launchbox_normalises_punctuation_trademarks_and_canonical_roman_numerals() {
    assert_eq!(
        normalise_title("Final Fantasy XVI™", false),
        normalise_title("final-fantasy 16®", false)
    );
    assert_eq!(
        normalise_title("Baldur’s Gate III", false),
        normalise_title("Baldur's Gate 3", false)
    );
    assert_eq!(
        normalise_title("Game XL: Subtitle", true),
        normalise_title("Game 40", false)
    );
    assert_eq!(roman_number("mmmcmxcix"), Some(3999));
    assert_eq!(roman_number("iiii"), None);
}
