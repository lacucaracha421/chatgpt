use super::*;
use crate::library::{
    av_models::*,
    models::{CollectionType, CreateCollection},
};
use std::{cell::RefCell, collections::VecDeque, io::Cursor};
const SSIS: &[u8] = include_bytes!("fixtures/ssis-001.json");
const ABW: &[u8] = include_bytes!("fixtures/abw-100.json");
const ENDPOINT: &str = "https://fixture.invalid/";
struct FixtureHttp {
    responses: RefCell<VecDeque<(&'static str, HttpResponse)>>,
    calls: RefCell<Vec<String>>,
}
impl FixtureHttp {
    fn new(responses: Vec<(&'static str, HttpResponse)>) -> Self {
        Self {
            responses: RefCell::new(responses.into()),
            calls: RefCell::new(vec![]),
        }
    }
}
impl HttpClient for FixtureHttp {
    fn get(
        &self,
        url: &str,
        token: Option<&str>,
        limit: usize,
    ) -> Result<HttpResponse, LibraryError> {
        self.calls.borrow_mut().push(url.into());
        let (prefix, response) = self
            .responses
            .borrow_mut()
            .pop_front()
            .expect("unexpected HTTP request; fixtures never access the network");
        assert!(url.starts_with(prefix), "{url} did not match {prefix}");
        if !url.starts_with(ENDPOINT) {
            assert!(token.is_none());
        }
        if response.bytes.len() > limit {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(response)
    }
}
fn response(status: u16, bytes: &[u8]) -> HttpResponse {
    HttpResponse {
        status,
        bytes: bytes.into(),
        content_type: None,
    }
}
fn jacket(width: u32, height: u32) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::RgbImage::from_fn(width, height, |x, _| {
        if x < 300 {
            image::Rgb([200, 0, 0])
        } else {
            image::Rgb([0, 0, 200])
        }
    })
    .write_to(&mut out, image::ImageFormat::Png)
    .unwrap();
    out.into_inner()
}
fn setup() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(&dir.path().join("library")).unwrap();
    (dir, lib)
}
fn feed(request: &str, code: &str, sequence: i64) -> FeedPage {
    FeedPage {
        items: vec![FeedItem {
            sequence,
            request_id: request.into(),
            product_code: code.into(),
            source_url: Some("https://fixture.invalid/work".into()),
            received_at: "2026-09-27T00:00:00Z".into(),
        }],
        next_after: sequence,
        has_more: false,
    }
}
fn enqueue(lib: &Library, code: &str) -> String {
    let request = uuid::Uuid::new_v4().to_string();
    lib.ingest_av_link_page(ENDPOINT, 0, feed(&request, code, 1))
        .unwrap();
    lib.connection()
        .unwrap()
        .query_row(
            "SELECT id FROM av_link_inbox WHERE request_id=?1",
            [request],
            |r| r.get(0),
        )
        .unwrap()
}
fn found(lib: &Library) -> String {
    let id = enqueue(lib, "SSIS-001");
    let http = FixtureHttp::new(vec![
        (
            "https://www.libredmm.com/movies/SSIS-001.json",
            response(200, SSIS),
        ),
        ("https://pics.dmm.co.jp/", response(200, &jacket(800, 538))),
        ("https://query.wikidata.org/sparql", response(503, b"")),
    ]);
    assert!(lib.fetch_next_av_link_with(&http, 1000).unwrap());
    assert_eq!(
        lib.get_av_link_candidate(&id, None).unwrap().inbox.status,
        "found"
    );
    id
}
fn new_request() -> ApplyRequest {
    ApplyRequest {
        collection_id: None,
        new_collection_name: Some("".into()),
        expected_revision: None,
        split: Split { x1: 378, x2: 422 },
        surfaces: Surfaces {
            front: SurfaceChoice::Candidate,
            spine: SurfaceChoice::Candidate,
            back: SurfaceChoice::Candidate,
        },
        fields: Fields {
            title_ja: Some("選択した原題".into()),
            release_date: Some("2021-02-20".into()),
            maker: Some("maker".into()),
            label: Some("label".into()),
            series: Some("series".into()),
            genres: Some(vec!["ドラマ".into()]),
        },
        performers: vec![PersonChoice::New {
            name_ja: "葵つかさ".into(),
            display_name: "아오이 츠카사".into(),
        }],
        directors: vec![PersonChoice::New {
            name_ja: "苺原".into(),
            display_name: "苺原".into(),
        }],
    }
}
fn av_collection(lib: &Library, name: &str) -> String {
    lib.create_collection(CreateCollection {
        name: name.into(),
        description: None,
        collection_type: CollectionType::Av,
    })
    .unwrap()
    .id
}

#[test]
fn av_link_normalization_table() {
    for (input, want) in [
        (" ssis-1 ", "SSIS-001"),
        ("ssis00001", "SSIS-001"),
        ("118abw00100", "ABW-100"),
        ("h_1472smkcx00003", "SMKCX-003"),
        ("k9ssis001", "SSIS-001"),
        ("1stars123", "STARS-123"),
        ("abw00100bod", "ABW-100"),
        ("ssis00001r", "SSIS-001"),
        ("ssis00001tk", "SSIS-001"),
        ("FC2-PPV-1234567", "FC2-PPV-1234567"),
        ("fc2ppv1234567", "FC2-PPV-1234567"),
        ("259LUXU-1234", "259LUXU-1234"),
        ("259luxu1234", "259LUXU-1234"),
        ("siro1234", "SIRO-1234"),
        ("SSIS-00001", "SSIS-00001"),
        ("ABW-10000", "ABW-10000"),
    ] {
        assert_eq!(normalize_code(input).as_deref(), Some(want), "{input}");
    }
    for invalid in [
        "",
        "abc",
        "12345",
        "https://bad/SSIS-001",
        "../SSIS-001",
        "SSIS-001?x=1",
        "SSIS\n001",
        "SSIS-1/2",
    ] {
        assert!(normalize_code(invalid).is_none(), "{invalid}");
    }
}
#[test]
fn av_link_fixture_parsing_and_japan_dates() {
    let ssis = parse_movie(SSIS, "SSIS-001").unwrap();
    assert_eq!(ssis.actresses.len(), 2);
    assert_eq!(ssis.directors, vec!["苺原"]);
    assert_eq!(release_date(&ssis).unwrap().as_deref(), Some("2021-02-20"));
    let abw = parse_movie(ABW, "ABW-100").unwrap();
    assert_eq!(abw.volume, Some(serde_json::json!(9300)));
    assert_eq!(abw.makers, vec!["プレステージ"]);
    assert_eq!(release_date(&abw).unwrap().as_deref(), Some("2021-06-11"));
    let mut midnight = abw;
    midnight.date = Some("2021-06-11T23:00:00-07:00".into());
    assert_eq!(
        release_date(&midnight).unwrap().as_deref(),
        Some("2021-06-12")
    );
    assert!(parse_movie(SSIS, "ABW-100").is_err());
}
#[test]
fn av_link_default_splits() {
    let digital = default_split(800, 538);
    assert_eq!(digital.split, Split { x1: 378, x2: 422 });
    assert!(digital.is_wrap && digital.use_spine);
    let dvd = default_split(800, 438);
    assert_eq!(dvd.split, Split { x1: 308, x2: 492 });
    assert!(dvd.is_wrap && !dvd.use_spine);
    let narrow = default_split(650, 538);
    assert_eq!(narrow.split, Split { x1: 325, x2: 325 });
    assert!(!narrow.use_spine);
    let portrait = default_split(378, 538);
    assert_eq!(portrait.split, Split { x1: 0, x2: 0 });
    assert!(!portrait.is_wrap && !portrait.use_spine);
}
#[test]
fn av_link_feed_idempotency_matching_and_cursor_atomicity() {
    let (_dir, lib) = setup();
    let target = av_collection(&lib, "Existing");
    lib.connection().unwrap().execute("INSERT INTO collection_av_details(collection_id,product_code) VALUES(?1,'118abw00100')",[&target]).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    lib.ingest_av_link_page(ENDPOINT, 0, feed(&request, "ABW-100", 1))
        .unwrap();
    lib.ingest_av_link_page(ENDPOINT, 0, feed(&request, "ABW-100", 1))
        .unwrap();
    let rows = lib.list_av_link_inbox().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].collection_id.as_deref(), Some(target.as_str()));
    assert_eq!(lib.av_link_pending_count().unwrap(), 1);
    let mut bad = feed(&uuid::Uuid::new_v4().to_string(), "SSIS-001", 2);
    bad.items.push(FeedItem {
        sequence: 2,
        request_id: "invalid".into(),
        product_code: "SSIS-001".into(),
        source_url: None,
        received_at: "bad".into(),
    });
    assert!(lib.ingest_av_link_page(ENDPOINT, 1, bad).is_err());
    assert_eq!(lib.av_link_pending_count().unwrap(), 1);
    let after: i64 = lib
        .connection()
        .unwrap()
        .query_row(
            "SELECT after_sequence FROM av_link_poll_cursor WHERE endpoint=?1",
            [ENDPOINT],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, 1);
    lib.dismiss_av_link(&rows[0].id).unwrap();
    lib.ingest_av_link_page(ENDPOINT, 0, feed(&request, "ABW-100", 1))
        .unwrap();
    assert_eq!(lib.av_link_pending_count().unwrap(), 0);
    lib.ingest_av_link_page(
        ENDPOINT,
        1,
        feed(&uuid::Uuid::new_v4().to_string(), "ABW-100", 2),
    )
    .unwrap();
    assert_eq!(lib.av_link_pending_count().unwrap(), 1);
}
#[test]
fn av_link_202_backoff_timeout_and_404() {
    let (_dir, lib) = setup();
    let id = enqueue(&lib, "SSIS-001");
    let pending = FixtureHttp::new(vec![("https://www.libredmm.com/", response(202, b""))]);
    lib.fetch_next_av_link_with(&pending, 1000).unwrap();
    assert_eq!(lib.list_av_link_inbox().unwrap()[0].status, "fetching");
    assert!(!lib
        .fetch_next_av_link_with(&FixtureHttp::new(vec![]), 1001)
        .unwrap());
    lib.fetch_next_av_link_with(&FixtureHttp::new(vec![]), 1600)
        .unwrap();
    let item = &lib.list_av_link_inbox().unwrap()[0];
    assert_eq!(item.status, "error");
    assert_eq!(
        item.last_error.as_deref(),
        Some("LibreDMM이 아직 준비 중이에요")
    );
    lib.retry_av_link(&id).unwrap();
    assert_eq!(lib.list_av_link_inbox().unwrap()[0].attempts, 0);
    lib.fetch_next_av_link_with(
        &FixtureHttp::new(vec![("https://www.libredmm.com/", response(404, b""))]),
        1700,
    )
    .unwrap();
    assert_eq!(lib.list_av_link_inbox().unwrap()[0].status, "not_found");
    lib.fix_av_link_code(&id, "118abw00100").unwrap();
    let item = &lib.list_av_link_inbox().unwrap()[0];
    assert_eq!(item.normalized_code.as_deref(), Some("ABW-100"));
    assert_eq!(item.product_code, "SSIS-001");
    assert_eq!(item.status, "queued");
}
#[test]
fn av_link_202_can_become_found_without_sleeping() {
    let (_dir, lib) = setup();
    let id = enqueue(&lib, "ABW-100");
    let http = FixtureHttp::new(vec![
        ("https://www.libredmm.com/", response(202, b"")),
        ("https://www.libredmm.com/", response(200, ABW)),
        ("https://pics.dmm.co.jp/", response(200, &jacket(800, 438))),
        (
            "https://query.wikidata.org/",
            response(200, br#"{"results":{"bindings":[]}}"#),
        ),
    ]);
    lib.fetch_next_av_link_with(&http, 1000).unwrap();
    lib.fetch_next_av_link_with(&http, 1010).unwrap();
    let c = lib.get_av_link_candidate(&id, None).unwrap();
    assert_eq!(c.inbox.attempts, 2);
    assert!(!c.default_split.use_spine);
}
#[test]
fn av_link_bad_cover_and_unsafe_urls_never_create_candidate() {
    for url in [
        "http://127.0.0.1/a.png",
        "https://pics.dmm.co.jp.evil/a.png",
        "file:///etc/passwd",
        "https://user:pass@pics.dmm.co.jp/a.png",
        "https://pics.dmm.co.jp:443/a.png",
    ] {
        // The URL crate removes an explicit default port; it is still the same safe origin.
        if url.ends_with(":443/a.png") {
            continue;
        }
        assert!(jacket_url(url).is_err());
    }
    assert_eq!(
        jacket_url("http://pics.dmm.co.jp/a.jpg").unwrap().scheme(),
        "https"
    );
    let (_dir, lib) = setup();
    let id = enqueue(&lib, "SSIS-001");
    let http = FixtureHttp::new(vec![
        ("https://www.libredmm.com/", response(200, SSIS)),
        ("https://pics.dmm.co.jp/", response(200, b"not image")),
    ]);
    lib.fetch_next_av_link_with(&http, 1000).unwrap();
    assert_eq!(lib.list_av_link_inbox().unwrap()[0].status, "error");
    assert!(lib.get_av_link_candidate(&id, None).is_err());
    assert!(decode_jacket(&vec![0; MAX_JACKET_BYTES + 1]).is_err());
}
#[test]
fn av_link_wikidata_escaping_ambiguity_cache_and_matching() {
    let bindings = serde_json::json!({"results":{"bindings":[{"name":{"value":"葵つかさ"},"person":{"value":"http://www.wikidata.org/entity/Q123"},"ko":{"value":"아오이 츠카사"},"fanza":{"value":"123"}}]}});
    let (_dir, lib) = setup();
    let id = enqueue(&lib, "SSIS-001");
    let http = FixtureHttp::new(vec![
        ("https://www.libredmm.com/", response(200, SSIS)),
        ("https://pics.dmm.co.jp/", response(200, &jacket(800, 538))),
        (
            "https://query.wikidata.org/",
            response(200, bindings.to_string().as_bytes()),
        ),
    ]);
    lib.fetch_next_av_link_with(&http, 1000).unwrap();
    let connection = lib.connection().unwrap();
    for (id, ja, ko, wd, fanza) in [
        ("fanza", "Other", "Other", None, Some("123")),
        ("wiki", "Other", "Other", Some("Q123"), None),
        ("ja", "葵つかさ", "Other", None, None),
        ("ko", "Other", "아오이 츠카사", None, None),
    ] {
        connection.execute("INSERT INTO collection_people(id,display_name,name_ja,wikidata_id,fanza_actress_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'t','t')",params![id,ko,ja,wd,fanza]).unwrap();
    }
    drop(connection);
    for (want, by) in [
        ("fanza", "fanza_actress_id"),
        ("wiki", "wikidata_id"),
        ("ja", "name_ja"),
        ("ko", "display_name"),
    ] {
        let c = lib.get_av_link_candidate(&id, None).unwrap();
        assert_eq!(c.performers[0].person_id.as_deref(), Some(want));
        assert_eq!(c.performers[0].match_by.as_deref(), Some(by));
        lib.connection()
            .unwrap()
            .execute("DELETE FROM collection_people WHERE id=?1", [want])
            .unwrap();
    }
    let movie = parse_movie(SSIS, "SSIS-001").unwrap();
    let cached = lib
        .enrich_names(&FixtureHttp::new(vec![]), &movie, 1001)
        .unwrap();
    assert_eq!(
        cached
            .iter()
            .find(|m| m.name_ja == "葵つかさ")
            .unwrap()
            .name_ko
            .as_deref(),
        Some("아오이 츠카사")
    );
    let url = wikidata_url(&["a\"}\\\n".into()]).unwrap();
    let query = url::Url::parse(&url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "query")
        .unwrap()
        .1
        .into_owned();
    assert!(query.contains("\"a\\\"}\\\\\\n\"@ja"));
    lib.apply_av_link(&id, new_request()).unwrap();
    let saved = lib.connection().unwrap().query_row(
        "SELECT name_ja,wikidata_id,fanza_actress_id FROM collection_people WHERE display_name='아오이 츠카사'", [],
        |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap();
    assert_eq!(saved, ("葵つかさ".into(), "Q123".into(), "123".into()));
    let mut ambiguous = bindings;
    let mut second = ambiguous["results"]["bindings"][0].clone();
    second["person"]["value"] = serde_json::json!("http://www.wikidata.org/entity/Q456");
    ambiguous["results"]["bindings"]
        .as_array_mut()
        .unwrap()
        .push(second);
    assert!(
        parse_names(ambiguous.to_string().as_bytes(), &["葵つかさ".into()]).unwrap()[0]
            .wikidata_id
            .is_none()
    );
}
#[test]
fn av_link_apply_new_crops_fields_people_and_media_route() {
    let (_dir, lib) = setup();
    let id = found(&lib);
    let candidate = lib.get_av_link_candidate(&id, None).unwrap();
    assert!(candidate.current.is_none());
    assert!(candidate.jacket_url.ends_with(&id));
    let response = crate::media_protocol::media_response(
        Some(&lib),
        &tauri::http::Method::GET,
        &format!("/av-link-jacket/{id}"),
    );
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let path = stored(&lib.connection().unwrap(), &id).unwrap().path;
    let result = lib.apply_av_link(&id, new_request()).unwrap();
    let connection = lib.connection().unwrap();
    let current = current_collection(&connection, &result.collection_id).unwrap();
    assert_eq!(current.name, "SSIS-001");
    assert_eq!(current.product_code.as_deref(), Some("SSIS-001"));
    assert_eq!(current.fields.title_ja.as_deref(), Some("選択した原題"));
    assert_eq!(current.fields.release_date.as_deref(), Some("2021-02-20"));
    assert_eq!(current.fields.maker.as_deref(), Some("maker"));
    assert_eq!(current.fields.genres, Some(vec!["ドラマ".into()]));
    assert_eq!(current.people.len(), 2);
    let people = connection
        .prepare("SELECT display_name,name_ja FROM collection_people ORDER BY display_name")
        .unwrap()
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(people.contains(&("아오이 츠카사".into(), "葵つかさ".into())));
    let art=connection.prepare("SELECT kind,width,height,provider,relative_path FROM collection_work_artworks WHERE collection_id=?1 ORDER BY kind").unwrap().query_map([&result.collection_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,u32>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    assert_eq!(art.len(), 3);
    for (kind, w, h, provider, path) in art {
        assert_eq!(w, if kind == "spine" { 44 } else { 378 });
        assert_eq!(h, 538);
        assert_eq!(provider, "libredmm");
        let pixels = image::open(lib.root().join(path)).unwrap().to_rgb8();
        assert_eq!(pixels.width(), w);
        if kind == "cover" {
            assert_eq!(pixels.get_pixel(0, 0).0, [0, 0, 200]);
        }
        if kind == "back" {
            assert_eq!(pixels.get_pixel(0, 0).0, [200, 0, 0]);
        }
    }
    assert_eq!(inbox(&connection, &id).unwrap().status, "applied");
    drop(connection);
    assert!(!lib.root().join(path).exists());
    assert_eq!(lib.av_link_pending_count().unwrap(), 0);
    assert!(lib.apply_av_link(&id, new_request()).is_err());
    assert_eq!(
        crate::media_protocol::media_response(
            Some(&lib),
            &tauri::http::Method::GET,
            &format!("/av-link-jacket/{id}")
        )
        .status(),
        404
    );
}
#[test]
fn av_link_existing_apply_keeps_manual_surface_unselected_fields_and_existing_credits() {
    let (dir, lib) = setup();
    let target = av_collection(&lib, "Manual collection");
    let details = lib
        .save_av_details(
            &target,
            SaveAvDetails {
                expected_revision: 0,
                product_code: Some("ssis00001".into()),
                label: Some("manual label".into()),
                series: Some("manual series".into()),
                people: vec![AvPersonInput {
                    person: AvPersonChoice::New {
                        display_name: "Existing".into(),
                    },
                    role: AvPersonRole::Performer,
                    credit_name: None,
                }],
            },
        )
        .unwrap();
    let path = dir.path().join("manual.png");
    fs::write(&path, jacket(20, 30)).unwrap();
    let preview = lib
        .preview_av_artwork(path.to_str().unwrap(), CoverSurface::Front)
        .unwrap();
    let local = ArtworkDecision::Local {
        path: path.to_str().unwrap().into(),
        sha256: preview.sha256,
    };
    let before = lib
        .apply_av_artwork(
            &target,
            ApplyAvArtwork {
                expected_revision: lib.get_av_cover_set(&target).unwrap().revision,
                front: local.clone(),
                spine: local,
                back: ArtworkDecision::Keep,
            },
        )
        .unwrap();
    let id = found(&lib);
    let c = lib.get_av_link_candidate(&id, None).unwrap();
    assert_eq!(c.current.as_ref().unwrap().collection_id, target);
    let mut request = new_request();
    request.collection_id = Some(target.clone());
    request.new_collection_name = None;
    request.expected_revision = Some(c.current.unwrap().covers.revision);
    request.fields = Fields {
        maker: Some("chosen maker".into()),
        ..Fields::default()
    };
    request.surfaces.front = SurfaceChoice::Keep;
    request.surfaces.spine = SurfaceChoice::Clear;
    request.performers = vec![
        PersonChoice::Link {
            name_ja: "葵つかさ".into(),
            person_id: details.people[0].id.clone(),
        },
        PersonChoice::New {
            name_ja: "乙白さやか".into(),
            display_name: "New person".into(),
        },
    ];
    let result = lib.apply_av_link(&id, request).unwrap();
    assert_eq!(result.covers.front_id, before.front_id);
    assert!(result.covers.spine_id.is_none());
    assert!(result.covers.back_id.is_some());
    let connection = lib.connection().unwrap();
    let current = current_collection(&connection, &target).unwrap();
    assert_eq!(current.fields.label.as_deref(), Some("manual label"));
    assert_eq!(current.fields.series.as_deref(), Some("manual series"));
    assert_eq!(current.fields.maker.as_deref(), Some("chosen maker"));
    assert_eq!(current.people[0].id, details.people[0].id);
    assert_eq!(current.people[1].display_name, "New person");
    assert_eq!(current.people[1].order, 1);
    assert_eq!(current.people.len(), 3);
}
#[test]
fn av_link_stale_revision_and_invalid_person_roll_back() {
    let (_dir, lib) = setup();
    let target = av_collection(&lib, "Target");
    let id = found(&lib);
    let revision = lib.get_av_cover_set(&target).unwrap().revision;
    lib.save_av_details(
        &target,
        SaveAvDetails {
            expected_revision: 0,
            product_code: None,
            label: Some("concurrent".into()),
            series: None,
            people: vec![],
        },
    )
    .unwrap();
    let mut request = new_request();
    request.collection_id = Some(target.clone());
    request.new_collection_name = None;
    request.expected_revision = Some(revision);
    assert!(matches!(
        lib.apply_av_link(&id, request.clone()),
        Err(AvError::Stale)
    ));
    let error: crate::commands::CommandError = AvError::Stale.into();
    assert_eq!(error.code, "av_stale");
    request.expected_revision = Some(lib.get_av_cover_set(&target).unwrap().revision);
    request.performers = vec![PersonChoice::Link {
        name_ja: "葵つかさ".into(),
        person_id: "missing-person".into(),
    }];
    assert!(lib.apply_av_link(&id, request).is_err());
    assert!(lib
        .list_collection_work_artworks(&target)
        .unwrap()
        .is_empty());
    assert_eq!(
        lib.get_av_link_candidate(&id, None).unwrap().inbox.status,
        "found"
    );
    assert_eq!(
        lib.get_av_details(&target).unwrap().label.as_deref(),
        Some("concurrent")
    );
    assert_eq!(
        fs::read_dir(lib.root().join("work-artwork").join(target))
            .unwrap()
            .count(),
        0
    );
    let mut new = new_request();
    new.directors = vec![PersonChoice::New {
        name_ja: "not-in-candidate".into(),
        display_name: "Bad".into(),
    }];
    assert!(lib.apply_av_link(&id, new).is_err());
    let connection = lib.connection().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM collections", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM collection_people", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn av_link_dismiss_removes_candidate_and_jacket() {
    let (_dir, lib) = setup();
    let id = found(&lib);
    let path = stored(&lib.connection().unwrap(), &id).unwrap().path;
    assert!(lib.root().join(&path).exists());
    lib.dismiss_av_link(&id).unwrap();
    assert!(!lib.root().join(path).exists());
    assert!(lib.get_av_link_candidate(&id, None).is_err());
    assert_eq!(lib.av_link_pending_count().unwrap(), 0);
    assert_eq!(
        inbox(&lib.connection().unwrap(), &id).unwrap().status,
        "dismissed"
    );
}
#[test]
fn av_link_discard_during_http_cannot_resurrect_candidate() {
    struct Discard<'a> {
        lib: &'a Library,
        id: &'a str,
        fixture: FixtureHttp,
    }
    impl HttpClient for Discard<'_> {
        fn get(
            &self,
            url: &str,
            token: Option<&str>,
            limit: usize,
        ) -> Result<HttpResponse, LibraryError> {
            if url.starts_with("https://pics.dmm.co.jp/") {
                self.lib.dismiss_av_link(self.id).unwrap();
            }
            self.fixture.get(url, token, limit)
        }
    }
    let (_dir, lib) = setup();
    let id = enqueue(&lib, "SSIS-001");
    let http = Discard {
        lib: &lib,
        id: &id,
        fixture: FixtureHttp::new(vec![
            ("https://www.libredmm.com/", response(200, SSIS)),
            ("https://pics.dmm.co.jp/", response(200, &jacket(800, 538))),
            ("https://query.wikidata.org/", response(503, b"")),
        ]),
    };
    lib.fetch_next_av_link_with(&http, 1000).unwrap();
    assert_eq!(lib.av_link_pending_count().unwrap(), 0);
    assert!(lib.get_av_link_candidate(&id, None).is_err());
    assert_eq!(
        fs::read_dir(lib.root().join("av-link-candidates"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn av_link_feed_http_auth_cadence_and_unconfigured_skip() {
    let (_dir, lib) = setup();
    lib.poll_av_links(&FixtureHttp::new(vec![]), false).unwrap();
    assert_eq!(
        lib.claim_av_link_poll(ENDPOINT, 1000, false).unwrap(),
        Some(0)
    );
    assert_eq!(lib.claim_av_link_poll(ENDPOINT, 1014, false).unwrap(), None);
    // Switching into lightweight mode honors 60 seconds since the previous request.
    assert_eq!(lib.claim_av_link_poll(ENDPOINT, 1015, true).unwrap(), None);
    assert_eq!(
        lib.claim_av_link_poll(ENDPOINT, 1060, true).unwrap(),
        Some(0)
    );
    assert_eq!(
        lib.claim_av_link_poll(ENDPOINT, 1075, false).unwrap(),
        Some(0)
    );
    let client = crate::cloud::client::CloudClient::new(ENDPOINT).unwrap();
    let body = serde_json::json!({"items":[{"sequence":1,"requestId":uuid::Uuid::new_v4().to_string(),"productCode":"ABW-100","sourceUrl":null,"receivedAt":"2026-09-27T00:00:00Z"}],"nextAfter":1,"hasMore":false});
    struct FeedHttp(FixtureHttp);
    impl HttpClient for FeedHttp {
        fn get(
            &self,
            url: &str,
            token: Option<&str>,
            limit: usize,
        ) -> Result<HttpResponse, LibraryError> {
            assert_eq!(token, Some("fixture-publisher"));
            self.0.get(url, token, limit)
        }
    }
    let http = FeedHttp(FixtureHttp::new(vec![(
        "https://fixture.invalid/v1/av-lookups?after=0&limit=100",
        response(200, body.to_string().as_bytes()),
    )]));
    lib.receive_av_link_feed_with(&http, &client, "fixture-publisher", 0)
        .unwrap();
    assert_eq!(lib.av_link_pending_count().unwrap(), 1);
    assert_eq!(
        lib.claim_av_link_poll(ENDPOINT, 1090, false).unwrap(),
        Some(1)
    );
    assert!(matches!(
        lib.receive_av_link_feed_with(
            &FixtureHttp::new(vec![(ENDPOINT, response(401, b""))]),
            &client,
            "fixture-publisher",
            1
        ),
        Err(AvError::Library(LibraryError::CloudUnauthorized))
    ));
    assert_eq!(
        lib.claim_av_link_poll(ENDPOINT, 1105, false).unwrap(),
        Some(1)
    );
}
#[test]
fn av_link_invalid_code_requires_correction_and_legacy_people_match() {
    let (_dir, lib) = setup();
    let bad = enqueue(&lib, "not a product code");
    assert_eq!(lib.list_av_link_inbox().unwrap()[0].status, "error");
    assert!(lib.retry_av_link(&bad).is_err());
    lib.fix_av_link_code(&bad, "ssis00001").unwrap();
    lib.dismiss_av_link(&bad).unwrap();
    assert!(normalize_code("ABW-１２３").is_none());
    let id = found(&lib);
    lib.connection().unwrap().execute("INSERT INTO collection_people(id,display_name,created_at,updated_at) VALUES('legacy-ja','葵つかさ','t','t')",[]).unwrap();
    let c = lib.get_av_link_candidate(&id, None).unwrap();
    assert_eq!(c.performers[0].person_id.as_deref(), Some("legacy-ja"));
    assert_eq!(c.performers[0].match_by.as_deref(), Some("name_ja"));
}
#[test]
fn av_link_series_variants_and_invalid_apply_geometry() {
    let mut json: serde_json::Value = serde_json::from_slice(ABW).unwrap();
    for (value, want) in [
        (serde_json::json!(["Series"]), vec!["Series"]),
        (serde_json::json!("Series"), vec!["Series"]),
        (serde_json::Value::Null, vec![]),
    ] {
        json["series"] = value;
        assert_eq!(
            parse_movie(json.to_string().as_bytes(), "ABW-100")
                .unwrap()
                .series,
            want
        );
    }
    let (_dir, lib) = setup();
    let id = found(&lib);
    for split in [
        Split { x1: 801, x2: 802 },
        Split { x1: 422, x2: 378 },
        Split { x1: 378, x2: 378 },
    ] {
        let mut request = new_request();
        request.split = split;
        assert!(lib.apply_av_link(&id, request).is_err());
        assert_eq!(
            lib.get_av_link_candidate(&id, None).unwrap().inbox.status,
            "found"
        );
    }
    let mut request = new_request();
    request.fields.release_date = Some("2021-02-30".into());
    assert!(lib.apply_av_link(&id, request).is_err());
    assert_eq!(
        lib.connection()
            .unwrap()
            .query_row("SELECT count(*) FROM collections", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn av_link_jacket_route_validates_identity_and_canvas_origin() {
    let (_dir, lib) = setup();
    let id = found(&lib);
    for path in [
        "/av-link-jacket/../library.sqlite".to_string(),
        format!("/av-link-jacket/{id}/more"),
    ] {
        assert_eq!(
            crate::media_protocol::media_response(Some(&lib), &tauri::http::Method::GET, &path)
                .status(),
            400
        );
    }
    let path = format!("/av-link-jacket/{id}");
    let mut response =
        crate::media_protocol::media_response(Some(&lib), &tauri::http::Method::GET, &path);
    crate::collectible_cors::allow_cover_canvas(&mut response, Some("tauri://localhost"), &path);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "tauri://localhost"
    );
    let mut response =
        crate::media_protocol::media_response(Some(&lib), &tauri::http::Method::GET, &path);
    crate::collectible_cors::allow_cover_canvas(
        &mut response,
        Some("https://untrusted.invalid"),
        &path,
    );
    assert!(!response
        .headers()
        .contains_key("access-control-allow-origin"));
}

#[test]
fn av_link_idle_schedule_keeps_poll_retry_and_new_work_deadlines() {
    let now = std::time::Instant::now();
    let root = std::path::Path::new("fixture");
    let mut schedule = TickSchedule {
        root: None,
        restricted: false,
        generation: 0,
        due: None,
    };
    assert!(schedule.ready(root, false, 1, now));
    schedule.due = Some(now + std::time::Duration::from_secs(15));
    for i in 1..15 {
        assert!(!schedule.ready(root, false, 1, now + std::time::Duration::from_secs(i)));
    }
    assert!(schedule.ready(root, false, 1, now + std::time::Duration::from_secs(15)));
    schedule.due = Some(now + std::time::Duration::from_secs(60));
    assert!(schedule.ready(root, false, 2, now + std::time::Duration::from_secs(16)));
    assert!(schedule.ready(root, true, 2, now + std::time::Duration::from_secs(17)));
}

#[test]
fn av_link_not_due_poll_performs_no_writes() {
    let (_dir, lib) = setup();
    assert_eq!(
        lib.claim_av_link_poll(ENDPOINT, 1000, false).unwrap(),
        Some(0)
    );
    let c = lib.connection().unwrap();
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    for i in 1001..1015 {
        assert_eq!(
            Library::claim_av_link_poll_on(&c, ENDPOINT, i, false).unwrap(),
            None
        );
    }
    assert_eq!(c.total_changes(), 0);
}

#[test]
fn av_link_idle_delay_honors_a_pending_retry_and_queue_write_wakes() {
    let (_dir, lib) = setup();
    assert_eq!(
        lib.next_av_link_tick(false).unwrap(),
        std::time::Duration::from_secs(60)
    );
    let generation = WORK_GENERATION.load(Ordering::Acquire);
    let now = chrono::Utc::now().timestamp();
    lib.connection().unwrap().execute(
        "INSERT INTO av_link_inbox(id,request_id,product_code,normalized_code,received_at,status,next_attempt_at)
         VALUES('retry','request','ABW-100','ABW-100','2026','fetching',?1)", [now + 3],
    ).unwrap();
    assert_ne!(WORK_GENERATION.load(Ordering::Acquire), generation);
    let delay = lib.next_av_link_tick(false).unwrap();
    assert!(
        delay >= std::time::Duration::from_secs(1) && delay <= std::time::Duration::from_secs(3)
    );
}
