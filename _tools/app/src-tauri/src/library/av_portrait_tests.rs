use super::*;
use crate::library::{
    av_link::provider::HttpResponse,
    error::LibraryError,
    models::{CollectionType, CreateCollection},
};
use std::cell::RefCell;

fn setup() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path()).unwrap();
    library.connection().unwrap().execute_batch("INSERT INTO collection_people(id,display_name,name_ja,wikidata_id,created_at,updated_at) VALUES('p','Person','日本名','Q123','t','t'),('q','Co performer',NULL,NULL,'t','t'),('d','Director',NULL,NULL,'t','t');").unwrap();
    (dir, library)
}
fn work(
    lib: &Library,
    name: &str,
    date: Option<&str>,
    label: Option<&str>,
    series: Option<&str>,
    people: &[(&str, &str)],
) -> String {
    let id = lib
        .create_collection(CreateCollection {
            name: name.into(),
            description: None,
            collection_type: CollectionType::Av,
        })
        .unwrap()
        .id;
    let c = lib.connection().unwrap();
    c.execute("INSERT INTO collection_av_details(collection_id,product_code,release_date,maker,label,series,title_ja,genres_json) VALUES(?1,'TEST-001',?2,' Maker ',?3,?4,'原題','[\"genre\"]')",params![id,date,label,series]).unwrap();
    for (i, (person, role)) in people.iter().enumerate() {
        c.execute("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order) VALUES(?1,?2,?3,?4)",params![id,person,role,i as i64]).unwrap();
    }
    id
}
fn cover(lib: &Library, id: &str) -> String {
    let artwork = uuid::Uuid::new_v4().to_string();
    lib.connection().unwrap().execute("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES(?1,?2,'fixture',?1,'cover',?1,'image/png',300,400,1,'t','t')",params![artwork,id]).unwrap();
    artwork
}
fn rect() -> AvPortraitRect {
    AvPortraitRect {
        x: 0.0,
        y: 0.0,
        w: 0.75,
        h: 0.75,
    }
}
#[test]
fn av_details_fields_counts_and_home_portrait() {
    let (_dir, lib) = setup();
    let a = work(
        &lib,
        "A",
        None,
        Some(" Label "),
        Some(" Series "),
        &[("p", "performer"), ("p", "director")],
    );
    work(
        &lib,
        "B",
        Some("2024-01-01"),
        Some("Label"),
        Some("Series"),
        &[("p", "director")],
    );
    let movie = work(
        &lib,
        "Movie",
        None,
        Some("Label"),
        Some("Series"),
        &[("p", "performer")],
    );
    {
        let c = lib.connection().unwrap();
        c.execute("UPDATE collections SET type='movie' WHERE id=?1", [movie])
            .unwrap();
        c.execute(
            "UPDATE collections SET release_date='2023-01-01' WHERE id=?1",
            [&a],
        )
        .unwrap();
    }
    let art = cover(&lib, &a);
    lib.set_av_portrait_crop("p", &art, rect()).unwrap();
    let detail = lib.get_av_details(&a).unwrap();
    assert_eq!(detail.title_ja.as_deref(), Some("原題"));
    assert_eq!(detail.release_date.as_deref(), Some("2023-01-01"));
    assert_eq!(detail.genres, vec!["genre"]);
    assert_eq!(
        (detail.maker_count, detail.label_count, detail.series_count),
        (2, 2, 2)
    );
    assert_eq!(detail.people[0].work_count, 2);
    assert_eq!(detail.people[0].name_ja.as_deref(), Some("日本名"));
    assert!(detail.people[0].portrait.is_some());
    assert!(lib
        .home_av_performer(chrono::NaiveDate::from_ymd_opt(2026, 9, 27).unwrap())
        .unwrap()
        .unwrap()
        .portrait
        .is_some());
    let json = serde_json::to_value(detail).unwrap();
    assert!(json["people"][0]["portrait"]["artworkId"].is_string());
    assert!(json.get("makerCount").is_some());
    lib.connection().unwrap().execute("UPDATE collection_av_details SET genres_json='invalid',maker=NULL,label=NULL,series=NULL WHERE collection_id=?1",[&a]).unwrap();
    let detail = lib.get_av_details(&a).unwrap();
    assert!(detail.genres.is_empty());
    assert_eq!(
        (detail.maker_count, detail.label_count, detail.series_count),
        (0, 0, 0)
    );
}
#[test]
fn av_related_shelves_exclude_current_and_order_series() {
    let (_dir, lib) = setup();
    let a = work(
        &lib,
        "Current",
        Some("2024-02-01"),
        Some("L"),
        Some("S"),
        &[("p", "performer")],
    );
    let empty = lib.get_av_related(&a).unwrap();
    assert_eq!(empty.performers.len(), 1);
    assert_eq!(empty.performers[0].total, 0);
    assert!(empty.performers[0].items.is_empty());
    assert!(empty.series.is_none());
    assert!(empty.label.is_none());
    let b = work(
        &lib,
        "Earlier",
        Some("2024-01-01"),
        Some(" L "),
        Some(" S "),
        &[("p", "performer")],
    );
    let c = work(
        &lib,
        "Later",
        Some("2025-01-01"),
        Some("L"),
        Some("S"),
        &[("p", "performer")],
    );
    let undated = work(
        &lib,
        "Undated",
        None,
        Some("L"),
        Some("S"),
        &[("p", "performer")],
    );
    let related = lib.get_av_related(&a).unwrap();
    assert_eq!(related.performers[0].total, 3);
    assert_eq!(related.performers[0].items[0].collection_id, c);
    assert!(related.performers[0]
        .items
        .iter()
        .all(|w| w.collection_id != a));
    let series = related.series.unwrap();
    assert_eq!(series.total, 4);
    assert_eq!(
        series
            .items
            .iter()
            .map(|i| i.work.collection_id.as_str())
            .collect::<Vec<_>>(),
        vec![b.as_str(), a.as_str(), c.as_str(), undated.as_str()]
    );
    assert!(series.items[1].current);
    assert_eq!(series.items.iter().filter(|i| i.current).count(), 1);
    let label = related.label.unwrap();
    assert_eq!(label.total, 3);
    assert_eq!(label.items[0].collection_id, c);
    assert!(label.items.iter().all(|w| w.collection_id != a));
    assert_eq!(
        label.items[0].cover_revision,
        lib.get_av_cover_set(&c).unwrap().revision
    );
}
#[test]
fn av_series_window_keeps_current_and_shelves_are_bounded() {
    let (_dir, lib) = setup();
    let mut current = String::new();
    for i in 1..=20 {
        let id = work(
            &lib,
            &format!("{i}"),
            Some(&format!("2024-01-{i:02}")),
            Some("L"),
            Some("S"),
            &[("p", "performer")],
        );
        if i == 17 {
            current = id;
        }
    }
    let related = lib.get_av_related(&current).unwrap();
    let series = related.series.unwrap();
    assert_eq!(series.total, 20);
    assert_eq!(series.items.len(), 12);
    assert_eq!(series.items.iter().filter(|w| w.current).count(), 1);
    assert_eq!(related.performers[0].items.len(), 12);
    assert_eq!(related.label.unwrap().items.len(), 12);
}
#[test]
fn av_performer_aggregates_distinct_works_roles_solo_and_scores() {
    let (_dir, lib) = setup();
    let a = work(
        &lib,
        "Solo",
        Some("2024-01-01"),
        Some(" L "),
        None,
        &[("p", "performer"), ("p", "director"), ("d", "director")],
    );
    let b = work(
        &lib,
        "Shared",
        Some("2025-01-01"),
        Some("L"),
        None,
        &[("p", "performer"), ("q", "performer")],
    );
    let c = work(
        &lib,
        "Director",
        None,
        Some("Other"),
        None,
        &[("p", "director"), ("q", "performer")],
    );
    {
        let c = lib.connection().unwrap();
        c.execute("UPDATE collections SET my_score=6 WHERE id=?1", [&a])
            .unwrap();
        c.execute("UPDATE collections SET my_score=8 WHERE id=?1", [&b])
            .unwrap();
    }
    let page = lib.get_av_performer("p").unwrap();
    assert_eq!(page.stats.work_count, 3);
    assert_eq!(page.stats.average_score, Some(7.0));
    assert_eq!(page.stats.first_release.as_deref(), Some("2024-01-01"));
    assert_eq!(page.stats.last_release.as_deref(), Some("2025-01-01"));
    assert_eq!(page.works[0].work.collection_id, b);
    assert!(!page.works[0].solo);
    assert!(page.works[1].solo);
    assert_eq!(page.works[1].role, AvPersonRole::Performer);
    assert_eq!(page.works[2].work.collection_id, c);
    assert_eq!(page.works[2].role, AvPersonRole::Director);
    assert!(!page.works[2].solo);
    assert_eq!(page.co_performers.len(), 1);
    assert_eq!(page.co_performers[0].id, "q");
    assert_eq!(page.co_performers[0].count, 1);
    assert_eq!(page.labels[0].name, "L");
    assert_eq!(page.labels[0].count, 2);
    assert!(lib.get_av_performer("d").unwrap().co_performers.is_empty());
}
#[test]
fn av_memo_trims_clears_and_validates_people() {
    let (_dir, lib) = setup();
    assert_eq!(
        lib.save_av_person_memo("p", Some("  memo\n ".into()))
            .unwrap()
            .person
            .memo
            .as_deref(),
        Some("memo")
    );
    assert!(lib
        .save_av_person_memo("p", Some(" \n ".into()))
        .unwrap()
        .person
        .memo
        .is_none());
    assert!(lib
        .save_av_person_memo("p", None)
        .unwrap()
        .person
        .memo
        .is_none());
    assert!(matches!(
        lib.save_av_person_memo("p", Some("한".repeat(2001))),
        Err(AvError::Invalid)
    ));
    assert!(lib
        .save_av_person_memo("p", Some("한".repeat(2000)))
        .is_ok());
    assert!(matches!(
        lib.get_av_performer("missing"),
        Err(AvError::Invalid)
    ));
    assert!(matches!(
        lib.get_av_details("missing"),
        Err(AvError::Invalid)
    ));
    assert!(matches!(
        lib.get_av_related("missing"),
        Err(AvError::Invalid)
    ));
    assert!(matches!(
        lib.save_av_person_memo("missing", None),
        Err(AvError::Invalid)
    ));
    assert!(matches!(
        lib.clear_av_portrait("missing"),
        Err(AvError::Invalid)
    ));
    assert!(matches!(
        lib.list_av_portrait_sources("missing"),
        Err(AvError::Invalid)
    ));
}
#[test]
fn av_crop_validates_credit_selection_rect_and_handles_deleted_artwork() {
    let (_dir, lib) = setup();
    let a = work(&lib, "A", None, None, None, &[("p", "performer")]);
    let art = cover(&lib, &a);
    assert!(matches!(
        lib.set_av_portrait_crop("q", &art, rect()),
        Err(AvError::Invalid)
    ));
    for bad in [
        AvPortraitRect {
            x: f64::NAN,
            ..rect()
        },
        AvPortraitRect { x: -0.1, ..rect() },
        AvPortraitRect { w: 0.02, ..rect() },
        AvPortraitRect {
            h: f64::INFINITY,
            ..rect()
        },
        AvPortraitRect { x: 0.5, ..rect() },
    ] {
        assert!(matches!(
            lib.set_av_portrait_crop("p", &art, bad),
            Err(AvError::Invalid)
        ));
    }
    let saved = lib.set_av_portrait_crop("p", &art, rect()).unwrap();
    if let AvPortrait::Crop { revision, .. } = saved {
        assert_eq!(revision, lib.get_av_cover_set(&a).unwrap().revision)
    } else {
        panic!()
    }
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE collection_work_artworks SET selected=0 WHERE id=?1",
            [&art],
        )
        .unwrap();
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_none());
    assert!(lib.set_av_portrait_crop("p", &art, rect()).is_err());
    lib.connection()
        .unwrap()
        .execute("DELETE FROM collection_work_artworks WHERE id=?1", [&art])
        .unwrap();
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_none());
}
#[test]
fn av_portrait_sources_solo_first_and_only_selected_performer_covers() {
    let (_dir, lib) = setup();
    let solo = work(
        &lib,
        "Solo",
        Some("2020-01-01"),
        None,
        None,
        &[("p", "performer")],
    );
    cover(&lib, &solo);
    let shared = work(
        &lib,
        "Shared",
        Some("2025-01-01"),
        None,
        None,
        &[("p", "performer"), ("q", "performer")],
    );
    cover(&lib, &shared);
    let director = work(&lib, "Director", None, None, None, &[("p", "director")]);
    cover(&lib, &director);
    let sources = lib.list_av_portrait_sources("p").unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].collection_id, solo);
    assert!(sources[0].solo);
    assert_eq!(sources[1].collection_id, shared);
    assert_eq!((sources[0].width, sources[0].height), (300, 400));
    assert_eq!(
        sources[0].revision,
        lib.get_av_cover_set(&solo).unwrap().revision
    );
}
struct FakeHttp<'a> {
    library: &'a Library,
    responses: RefCell<Vec<Vec<u8>>>,
    urls: RefCell<Vec<String>>,
}
impl HttpClient for FakeHttp<'_> {
    fn get(
        &self,
        url: &str,
        token: Option<&str>,
        limit: usize,
    ) -> Result<HttpResponse, LibraryError> {
        // Acquiring the library connection here catches any DB lock held over HTTP.
        let _connection = self.library.connection()?;
        assert!(token.is_none());
        assert!(limit <= MAX_IMAGE_BYTES);
        self.urls.borrow_mut().push(url.into());
        Ok(HttpResponse {
            status: 200,
            bytes: self.responses.borrow_mut().remove(0),
            content_type: None,
        })
    }
}
fn fake(lib: &Library, responses: Vec<Vec<u8>>) -> FakeHttp<'_> {
    FakeHttp {
        library: lib,
        responses: RefCell::new(responses),
        urls: RefCell::new(vec![]),
    }
}
fn png() -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 4)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .unwrap();
    buffer.into_inner()
}
fn commons_responses(thumb: &str) -> Vec<Vec<u8>> {
    vec![serde_json::to_vec(&serde_json::json!({"entities":{"Q123":{"claims":{"P18":[{"mainsnak":{"datavalue":{"value":"Portrait name.png"}}}]}}}})).unwrap(),serde_json::to_vec(&serde_json::json!({"query":{"pages":{"1":{"imageinfo":[{"thumburl":thumb,"descriptionurl":"https://commons.wikimedia.org/wiki/File:Portrait_name.png","extmetadata":{"Artist":{"value":"<a href=\"example\">Photo &amp; Author</a>"},"LicenseShortName":{"value":"CC BY-SA 4.0"},"LicenseUrl":{"value":"https://creativecommons.org/licenses/by-sa/4.0/"}}}]}}}})).unwrap(),png()]
}
#[test]
fn av_commons_missing_p18_or_qid_is_null_and_invalid_qid_never_leaves_pc() {
    let (_dir, lib) = setup();
    let state = AvPortraitState::default();
    let http = fake(
        &lib,
        vec![b"{\"entities\":{\"Q123\":{\"claims\":{}}}}".to_vec()],
    );
    assert!(lib
        .preview_av_commons_portrait_with("p", &state, &http)
        .unwrap()
        .is_none());
    assert!(matches!(
        lib.use_av_commons_portrait("p", &state),
        Err(AvError::Invalid)
    ));
    assert!(lib
        .preview_av_commons_portrait_with("q", &state, &http)
        .unwrap()
        .is_none());
    assert_eq!(http.urls.borrow().len(), 1);
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE collection_people SET wikidata_id='Q123/secret' WHERE id='p'",
            [],
        )
        .unwrap();
    assert!(matches!(
        lib.preview_av_commons_portrait_with("p", &state, &http),
        Err(AvError::Invalid)
    ));
    assert_eq!(http.urls.borrow().len(), 1);
    assert!(matches!(
        lib.preview_av_commons_portrait_with("missing", &state, &http),
        Err(AvError::Invalid)
    ));
    assert!(matches!(
        lib.use_av_commons_portrait("missing", &state),
        Err(AvError::Invalid)
    ));
}
#[test]
fn av_commons_preview_is_memory_only_then_saved_with_plain_author() {
    let (_dir, lib) = setup();
    let state = AvPortraitState::default();
    let http = fake(
        &lib,
        commons_responses("https://upload.wikimedia.org/portrait.png"),
    );
    let preview = lib
        .preview_av_commons_portrait_with("p", &state, &http)
        .unwrap()
        .unwrap();
    assert_eq!(preview.author.as_deref(), Some("Photo & Author"));
    assert_eq!(preview.license.as_deref(), Some("CC BY-SA 4.0"));
    assert!(preview.data_url.starts_with("data:image/png;base64,iVBOR"));
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_none());
    let urls = http.urls.borrow();
    assert_eq!(urls.len(), 3);
    assert_eq!(
        urls[0],
        "https://www.wikidata.org/wiki/Special:EntityData/Q123.json"
    );
    assert!(urls
        .iter()
        .all(|u| !u.contains("Person") && !u.contains("日本名")));
    let portrait = lib.use_av_commons_portrait("p", &state).unwrap();
    assert_eq!(
        lib.get_av_performer("p").unwrap().person.portrait,
        Some(portrait.clone())
    );
    let json = serde_json::to_value(portrait).unwrap();
    assert_eq!(json["kind"], "commons");
    assert_eq!(json["fileName"], "Portrait name.png");
    assert!(json.get("preview").is_none());
    assert!(lib.use_av_commons_portrait("p", &state).is_err());
    lib.clear_av_portrait("p").unwrap();
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_none());
}
#[test]
fn av_commons_rejects_foreign_hosts_bad_bytes_and_oversized_images() {
    let (_dir, lib) = setup();
    let state = AvPortraitState::default();
    for url in [
        "http://upload.wikimedia.org/image.png",
        "https://evil.example/image.png",
        "https://upload.wikimedia.org.evil.example/image.png",
        "https://user@upload.wikimedia.org/image.png",
    ] {
        let http = fake(&lib, commons_responses(url));
        assert!(lib
            .preview_av_commons_portrait_with("p", &state, &http)
            .is_err());
        assert_eq!(http.urls.borrow().len(), 2);
    }
    for bytes in [b"not an image".to_vec(), vec![0; MAX_IMAGE_BYTES + 1]] {
        let mut responses = commons_responses("https://upload.wikimedia.org/image.png");
        responses[2] = bytes;
        let http = fake(&lib, responses);
        assert!(matches!(
            lib.preview_av_commons_portrait_with("p", &state, &http),
            Err(AvError::Image)
        ));
    }
    assert!(lib.use_av_commons_portrait("p", &state).is_err());
}
#[test]
fn av_commons_preview_is_library_scoped_and_discardable() {
    let (_dir, lib) = setup();
    let (_other_dir, other) = setup();
    let state = AvPortraitState::default();
    let http = fake(
        &lib,
        commons_responses("https://upload.wikimedia.org/image.png"),
    );
    lib.preview_av_commons_portrait_with("p", &state, &http)
        .unwrap();
    assert!(other.use_av_commons_portrait("p", &state).is_err());
    state.discard(&lib, "p");
    assert!(lib.use_av_commons_portrait("p", &state).is_err());
}
#[test]
fn av_cloud_snapshot_excludes_portraits_and_retains_shared_people() {
    let (dir, lib) = setup();
    let state = AvPortraitState::default();
    let http = fake(
        &lib,
        commons_responses("https://upload.wikimedia.org/image.png"),
    );
    lib.preview_av_commons_portrait_with("p", &state, &http)
        .unwrap();
    lib.use_av_commons_portrait("p", &state).unwrap();
    lib.connection().unwrap().execute("INSERT INTO collection_person_profiles(person_id,source,status,name,fetched_at) VALUES('p','stashdb','none','Private StashDB profile marker','t')", []).unwrap();
    let snapshot = dir.path().join("cloud-snapshot.sqlite");
    lib.create_cloud_metadata_snapshot(&snapshot).unwrap();
    let c = Connection::open(&snapshot).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM collection_person_profiles", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        lib.connection()
            .unwrap()
            .query_row("SELECT count(*) FROM collection_person_profiles", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!std::fs::read(&snapshot)
        .unwrap()
        .windows(b"Private StashDB profile marker".len())
        .any(|w| w == b"Private StashDB profile marker"));
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_person_portraits",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM collection_people", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_some());
    assert!(!std::fs::read(&snapshot)
        .unwrap()
        .windows(b"Portrait name.png".len())
        .any(|w| w == b"Portrait name.png"));
}
