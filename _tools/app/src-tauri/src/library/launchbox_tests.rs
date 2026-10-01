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
        steam_app_id: None,
        igdb_name: None,
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
fn launchbox_failed_download_is_retried_after_a_short_pause_and_cleans_leftovers() {
    let cache = tempfile::tempdir().unwrap();
    let io = FakeHttp::new("<LaunchBox></LaunchBox>");
    io.fail_bulk.set(true);
    let cancel = AtomicBool::new(false);
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert_eq!(io.bulk_count(), 1);
    // A download the app did not finish (closed mid-way) leaves a temp file behind.
    fs::write(cache.path().join(".tmpLeftover"), b"partial").unwrap();
    io.now.set(io.now.get() + RETRY_MS - 1);
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert_eq!(io.bulk_count(), 1);
    io.now.set(io.now.get() + 1);
    assert!(ensure_index(cache.path(), &io, &cancel).is_err());
    assert_eq!(io.bulk_count(), 2);
    assert!(!cache.path().join(".tmpLeftover").exists());
}
#[test]
fn launchbox_failed_outcomes_are_not_reused_once_the_download_works() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Example II: Adventure", "Switch");
    let cancel = AtomicBool::new(false);
    let g = load_game(&library, ID1).unwrap();
    io.fail_bulk.set(true);
    let out = FetchState::default()
        .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::Failed);
    io.fail_bulk.set(false);
    io.now.set(io.now.get() + RETRY_MS);
    let out = FetchState::default()
        .one_with(&library, cache.path(), &g, &io, &cancel, &mut None, &|_| {})
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::Matched);
    assert!(!out.cached);
}
#[test]
fn launchbox_matching_prefers_owned_platform_then_platform_order_and_region() {
    let io = FakeHttp::new(&metadata(
        &[
            ("1", "Example II: Adventure", "Nintendo Switch"),
            ("2", "Example 2: Adventure", "Sony Playstation 5"),
            ("3", "Example II: Adventure", "Nintendo Switch 2"),
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
    assert_eq!(match_game(&g, &index).unwrap().0.database_id, "1");
    g.title = "Korean title".into();
    g.original_title = Some("Example II: Adventure".into());
    assert_eq!(match_game(&g, &index).unwrap().0.database_id, "1");
    g.platforms = Some("Xbox".into());
    assert!(matches!(
        match_game(&g, &index),
        Err((_, OutcomeStatus::NoMatch))
    ));
}
#[test]
fn launchbox_matching_rejects_ambiguous_titles_and_does_not_guess_subtitles() {
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
        Err((_, OutcomeStatus::NoMatch))
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
    let (c, i, _) = match_game(&g, &index).unwrap();
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
        matches!(request,SpineBatchRequest::Run{job_id,limit:20,after_collection_id:Some(after),..} if job_id==ID1 && after==ID2)
    );
}

#[test]
fn launchbox_game_without_platforms_matches_on_any_platform() {
    let (_temp, library, cache, io) = fixture();
    // Most library games have no platform list; the title still finds the Switch entry.
    insert(&library, ID1, "Example II: Adventure", "");
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
    assert_eq!(outcome.status, OutcomeStatus::Matched);
    assert_eq!(outcome.platform.as_deref(), Some("Nintendo Switch"));
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
            version: INDEX_VERSION,
            games: vec![IndexedGame {
                database_id: "1".into(),
                title: "Game".into(),
                platform: "Windows".into(),
                release_date: None,
                steam_app_id: None,
                alternate_names: Vec::new(),
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

fn sekiro_metadata() -> &'static str {
    r#"<LaunchBox>
      <Game><DatabaseID>164149</DatabaseID><Name>Sekiro: Shadows Die Twice</Name><Platform>Windows</Platform><SteamAppId>814380</SteamAppId></Game>
      <Game><DatabaseID>165025</DatabaseID><Name>Sekiro: Shadows Die Twice</Name><Platform>Sony Playstation 4</Platform></Game>
      <GameAlternateName><AlternateName>세키로: 섀도우 다이 트와이스</AlternateName><DatabaseID>164149</DatabaseID><Region>Korea</Region></GameAlternateName>
      <GameAlternateName><AlternateName>セキロ</AlternateName><DatabaseID>164149</DatabaseID><Region>Japan</Region></GameAlternateName>
      <GameAlternateName><AlternateName>Sekiro Alternate</AlternateName><DatabaseID>164149</DatabaseID><Region>Europe</Region></GameAlternateName>
      <GameAlternateName><AlternateName>Sekiro™ Alternate</AlternateName><DatabaseID>164149</DatabaseID><Region>World</Region></GameAlternateName>
      <GameImage><DatabaseID>165025</DatabaseID><FileName>sekiro-ps4.png</FileName><Type>Box - Spine</Type><Region>Japan</Region></GameImage>
    </LaunchBox>"#
}
fn parse_fixture(xml: &str) -> Index {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("fixture.zip");
    fs::write(&path, FakeHttp::new(xml).bulk).unwrap();
    parse_zip(&path, &AtomicBool::new(false)).unwrap()
}
fn binding(library: &Library, id: &str, provider: &str, external_id: &str, data: Option<&str>) {
    library.connection().unwrap().execute(
        "INSERT INTO collection_external_bindings(collection_id,provider,external_id,provider_data_json,created_at,updated_at) VALUES(?1,?2,?3,?4,'2026','2026')",
        params![id,provider,external_id,data],
    ).unwrap();
}
fn fetch_fixture(library: &Library, cache: &Path, io: &FakeHttp, id: &str) -> SpineOutcome {
    FetchState::default()
        .one_with(
            library,
            cache,
            &load_game(library, id).unwrap(),
            io,
            &AtomicBool::new(false),
            &mut None,
            &|_| {},
        )
        .unwrap()
}

#[test]
fn launchbox_steam_id_resolves_a_spine_on_another_platform() {
    let (_temp, library, cache, _) = fixture();
    insert(
        &library,
        ID1,
        "세키로: 섀도우 다이 트와이스",
        "PC (Microsoft Windows) · PlayStation 4",
    );
    binding(&library, ID1, "steam", "814380", None);
    let io = FakeHttp::new(sekiro_metadata());
    let outcome = fetch_fixture(&library, cache.path(), &io, ID1);
    assert_eq!(outcome.status, OutcomeStatus::Matched);
    assert_eq!(outcome.matched_by, Some(MatchedBy::Steam));
    assert_eq!(outcome.database_id.as_deref(), Some("165025"));
    assert_eq!(outcome.platform.as_deref(), Some("Sony Playstation 4"));
    assert_eq!(
        io.image_requests()[0].0,
        format!("{IMAGE_BASE}sekiro-ps4.png")
    );
    assert_eq!(
        serde_json::to_value(&outcome).unwrap()["matchedBy"],
        "steam"
    );
}

#[test]
fn launchbox_korean_japanese_and_other_alternates_resolve_canonical_name() {
    let index = parse_fixture(sekiro_metadata());
    assert_eq!(index.games.len(), 2);
    assert!(index.games[0].images.is_empty());
    assert_eq!(index.games[0].steam_app_id.as_deref(), Some("814380"));
    assert_eq!(index.games[0].alternate_names.len(), 3);
    for title in [
        "세키로: 섀도우 다이 트와이스",
        "セキロ",
        "SEKIRO Alternate®",
    ] {
        let game = game(ID1, title, "PlayStation 4", None);
        let (candidate, _, matched_by) = match_game(&game, &index).unwrap();
        assert_eq!(candidate.database_id, "165025");
        assert_eq!(matched_by, MatchedBy::Alternate);
    }
    let (_temp, library, cache, _) = fixture();
    insert(
        &library,
        ID1,
        "세키로: 섀도우 다이 트와이스",
        "PlayStation 4",
    );
    let outcome = fetch_fixture(
        &library,
        cache.path(),
        &FakeHttp::new(sekiro_metadata()),
        ID1,
    );
    assert_eq!(outcome.status, OutcomeStatus::Matched);
    assert_eq!(outcome.matched_by, Some(MatchedBy::Alternate));
}

#[test]
fn launchbox_igdb_binding_name_resolves_a_korean_library_title() {
    let (_temp, library, cache, _) = fixture();
    insert(&library, ID1, "이름을 찾을 수 없는 게임", "PlayStation 4");
    binding(
        &library,
        ID1,
        "igdb",
        "104745",
        Some(r#"{"name":"Sekiro: Shadows Die Twice"}"#),
    );
    let io = FakeHttp::new(sekiro_metadata());
    let outcome = fetch_fixture(&library, cache.path(), &io, ID1);
    assert_eq!(outcome.status, OutcomeStatus::Matched);
    assert_eq!(outcome.matched_by, Some(MatchedBy::Igdb));
    assert_eq!(outcome.database_id.as_deref(), Some("165025"));
}

#[test]
fn launchbox_conflicting_identity_sources_are_ambiguous_before_platform_selection() {
    let xml = sekiro_metadata().replace("</LaunchBox>", r#"
      <Game><DatabaseID>9</DatabaseID><Name>Another Game</Name><Platform>Nintendo Switch 2</Platform><SteamAppId>999</SteamAppId></Game>
      <GameAlternateName><DatabaseID>9</DatabaseID><AlternateName>다른 게임</AlternateName><Region>Korea</Region></GameAlternateName>
      <GameImage><DatabaseID>9</DatabaseID><FileName>other.png</FileName><Type>Box - Spine</Type><Region>Korea</Region></GameImage>
    </LaunchBox>"#);
    let index = parse_fixture(&xml);
    for title in ["Another Game", "다른 게임"] {
        let mut game = game(ID1, title, "PlayStation 4", Some("PlayStation 4"));
        game.steam_app_id = Some("814380".into());
        assert!(matches!(
            match_game(&game, &index),
            Err(("conflicting_canonical_names", OutcomeStatus::Ambiguous))
        ));
    }
    let mut game = game(ID1, "세키로: 섀도우 다이 트와이스", "PlayStation 4", None);
    game.igdb_name = Some("Another Game".into());
    assert!(matches!(
        match_game(&game, &index),
        Err((_, OutcomeStatus::Ambiguous))
    ));
    game.igdb_name = None;
    game.original_title = Some("Another Game".into());
    assert!(matches!(
        match_game(&game, &index),
        Err((_, OutcomeStatus::Ambiguous))
    ));
    game.original_title = None;
    game.steam_app_id = Some("999".into());
    game.igdb_name = Some("Sekiro: Shadows Die Twice".into());
    assert!(matches!(
        match_game(&game, &index),
        Err((_, OutcomeStatus::Ambiguous))
    ));

    let (_temp, library, cache, _) = fixture();
    insert(&library, ID1, "다른 게임", "PlayStation 4");
    binding(&library, ID1, "steam", "814380", None);
    let io = FakeHttp::new(&xml);
    let outcome = fetch_fixture(&library, cache.path(), &io, ID1);
    assert_eq!(outcome.status, OutcomeStatus::Ambiguous);
    assert!(io.image_requests().is_empty());
}

#[test]
fn launchbox_agreeing_sources_record_the_first_matching_key() {
    let index = parse_fixture(sekiro_metadata());
    let mut game = game(ID1, "세키로: 섀도우 다이 트와이스", "PlayStation 4", None);
    game.steam_app_id = Some("814380".into());
    game.igdb_name = Some("Sekiro: Shadows Die Twice".into());
    assert_eq!(match_game(&game, &index).unwrap().2, MatchedBy::Steam);
    game.steam_app_id = None;
    assert_eq!(match_game(&game, &index).unwrap().2, MatchedBy::Alternate);
    game.original_title = Some("Sekiro: Shadows Die Twice".into());
    assert_eq!(match_game(&game, &index).unwrap().2, MatchedBy::Title);
    game.original_title = None;
    game.title = "unknown".into();
    assert_eq!(match_game(&game, &index).unwrap().2, MatchedBy::Igdb);
}

#[test]
fn launchbox_old_index_rebuilds_from_cached_zip_even_when_refresh_is_due() {
    let cache = tempfile::tempdir().unwrap();
    let io = FakeHttp::new(&sekiro_metadata().replace(
        "<SteamAppId>814380",
        "<ReleaseDate>2019-03-22</ReleaseDate><SteamAppId>814380",
    ));
    let cancel = AtomicBool::new(false);
    ensure_index(cache.path(), &io, &cancel).unwrap();
    let state: BulkState = read_json(&cache.path().join("bulk-state.json"), 4096).unwrap();
    let generation = state.generation.as_ref().unwrap();
    let index_path = cache.path().join(format!("index-{generation}.json"));
    let zip_path = cache.path().join(format!("Metadata-{generation}.zip"));
    let zip_before = fs::read(&zip_path).unwrap();
    // The old index contained only entries with images and had no identity fields.
    write_json(&index_path, &serde_json::json!({"version":2,"games":[{
        "database_id":"165025","title":"Sekiro: Shadows Die Twice",
        "platform":"Sony Playstation 4","images":[{"file_name":"sekiro-ps4.png","region":"Japan"}]
    }]})).unwrap();
    io.now.set(io.now.get() + DAY_MS);
    let rebuilt = ensure_index(cache.path(), &io, &cancel).unwrap();
    assert_eq!(rebuilt.version, INDEX_VERSION);
    assert_eq!(rebuilt.games.len(), 2);
    assert_eq!(rebuilt.games[0].steam_app_id.as_deref(), Some("814380"));
    assert_eq!(rebuilt.games[0].release_date, Some(17977));
    assert_eq!(rebuilt.games[0].alternate_names.len(), 3);
    assert_eq!(io.bulk_count(), 1);
    assert_eq!(fs::read(&zip_path).unwrap(), zip_before);
    let after: BulkState = read_json(&cache.path().join("bulk-state.json"), 4096).unwrap();
    assert_eq!(after.downloaded_at, state.downloaded_at);
    assert_eq!(after.last_attempt_at, state.last_attempt_at);
    assert_eq!(
        read_json::<Index>(&index_path, MAX_INDEX_BYTES)
            .unwrap()
            .version,
        INDEX_VERSION
    );
}

#[test]
fn launchbox_old_no_match_outcome_is_retried_without_a_bulk_download() {
    let (_temp, library, cache, _) = fixture();
    insert(
        &library,
        ID1,
        "세키로: 섀도우 다이 트와이스",
        "PlayStation 4",
    );
    binding(&library, ID1, "steam", "814380", None);
    let game = load_game(&library, ID1).unwrap();
    let io = FakeHttp::new(sekiro_metadata());
    ensure_index(cache.path(), &io, &AtomicBool::new(false)).unwrap();
    let legacy_bytes = serde_json::to_vec(&(
        3u32,
        &game.title,
        &game.original_title,
        &game.platforms,
        &game.owned,
        &game.steam_app_id,
        &game.igdb_name,
    ))
    .unwrap();
    let legacy_fingerprint: String = Sha256::digest(legacy_bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let outcome_path = cache
        .path()
        .join("outcomes")
        .join(library.library_id().unwrap())
        .join(format!("{ID1}.json"));
    let mut old = serde_json::to_value(SpineOutcome::new(
        ID1,
        OutcomeStatus::NoMatch,
        "no_title_platform_match",
    ))
    .unwrap();
    old.as_object_mut().unwrap().remove("matchedBy");
    write_json(
        &outcome_path,
        &serde_json::json!({"fingerprint":legacy_fingerprint,"at":io.now_ms(),"outcome":old}),
    )
    .unwrap();
    // Ensure legacy outcomes deserialize so invalidation really comes from the fingerprint.
    assert_eq!(
        read_json::<CachedOutcome>(&outcome_path, 64 * 1024)
            .unwrap()
            .outcome
            .status,
        OutcomeStatus::NoMatch
    );
    let outcome = fetch_fixture(&library, cache.path(), &io, ID1);
    assert_eq!(outcome.status, OutcomeStatus::Matched);
    assert!(!outcome.cached);
    assert_eq!(outcome.matched_by, Some(MatchedBy::Steam));
    assert_eq!(io.bulk_count(), 1);
    assert_eq!(io.image_requests().len(), 1);
}

#[test]
fn launchbox_bindings_invalidate_outcomes_and_guard_in_flight_imports() {
    let (_temp, library, cache, _) = fixture();
    insert(&library, ID1, "unmatched", "PlayStation 4");
    let io = FakeHttp::new(sekiro_metadata());
    assert_eq!(
        fetch_fixture(&library, cache.path(), &io, ID1).status,
        OutcomeStatus::NoMatch
    );
    assert!(fetch_fixture(&library, cache.path(), &io, ID1).cached);
    binding(
        &library,
        ID1,
        "igdb",
        "104745",
        Some(r#"{"name":"Sekiro: Shadows Die Twice"}"#),
    );
    let old = load_game(&library, ID1).unwrap();
    let index = parse_fixture(sekiro_metadata());
    let (candidate, image, _) = match_game(&old, &index).unwrap();
    binding(&library, ID1, "steam", "814380", None);
    assert!(matches!(
        store_spine(&library, &old, candidate, image, &io.image),
        Err(Error::InvalidRequest)
    ));
    let outcome = fetch_fixture(&library, cache.path(), &io, ID1);
    assert_eq!(outcome.status, OutcomeStatus::Matched);
    assert_eq!(outcome.matched_by, Some(MatchedBy::Steam));
    assert_eq!(io.bulk_count(), 1);
}

#[test]
fn launchbox_information_fills_all_canonical_platforms_by_release_without_images() {
    let (_temp, library, cache, _) = fixture();
    insert(&library, ID1, "Example", "");
    insert(&library, ID2, "User Example", "My own platforms");
    let xml = "<LaunchBox><Game><DatabaseID>1</DatabaseID><Name>Example</Name><Platform>Windows</Platform><ReleaseDate>2001-01-01T00:00:00</ReleaseDate></Game><Game><DatabaseID>2</DatabaseID><Name>Example</Name><Platform>Nintendo Switch 2</Platform><ReleaseDate>2025-01-01</ReleaseDate></Game><Game><DatabaseID>3</DatabaseID><Name>Example</Name><Platform>PlayStation 5</Platform><ReleaseDate>2025-01-01</ReleaseDate></Game></LaunchBox>";
    let io = FakeHttp::new(xml);
    let mut no_igdb = |_: &[String],
                       _: &AtomicBool,
                       _: &dyn Fn(
        &str,
        std::result::Result<bool, super::super::error::LibraryError>,
    )| Ok(());
    let result = FetchState::default()
        .information_with(
            &library,
            cache.path(),
            "job",
            50,
            None,
            &io,
            &AtomicBool::new(false),
            &mut no_igdb,
            &|_| {},
        )
        .unwrap();
    assert_eq!(result.platforms_filled, 1);
    assert_eq!(
        library.get_collection(ID1).unwrap().platforms.as_deref(),
        Some("Windows · Nintendo Switch 2 · PlayStation 5")
    );
    assert_eq!(
        library.get_collection(ID2).unwrap().platforms.as_deref(),
        Some("My own platforms")
    );
    assert_eq!(io.bulk_count(), 1);
    assert!(io.image_requests().is_empty());
    assert!(!fill_launchbox_platforms(
        &library,
        ID2,
        &ensure_index(cache.path(), &io, &AtomicBool::new(false)).unwrap(),
        &AtomicBool::new(false)
    )
    .unwrap());
}

#[test]
fn launchbox_information_cancel_never_fetches_launchbox_or_starts_spines() {
    let (_temp, library, cache, io) = fixture();
    insert(&library, ID1, "Example", "");
    let cancel = AtomicBool::new(false);
    let mut fill =
        |_: &[String],
         c: &AtomicBool,
         _: &dyn Fn(&str, std::result::Result<bool, super::super::error::LibraryError>)| {
            c.store(true, Ordering::Relaxed);
            Ok(())
        };
    let result = FetchState::default()
        .information_with(
            &library,
            cache.path(),
            "job",
            50,
            None,
            &io,
            &cancel,
            &mut fill,
            &|_| {},
        )
        .unwrap();
    assert!(result.cancelled);
    assert!(result.outcomes.is_empty());
    assert_eq!(result.next_cursor, None);
    assert_eq!(io.bulk_count(), 0);
    assert!(io.image_requests().is_empty());
}
