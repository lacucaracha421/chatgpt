use super::*;
use crate::library::{
    av_link::provider::HttpResponse, av_models::AvPortrait, av_portrait::AvPortraitState,
    error::LibraryError,
};
use std::{cell::RefCell, io::Cursor};

fn setup() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    lib.connection().unwrap().execute("INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES('p','Korean Name','日本名','t','t')", []).unwrap();
    (dir, lib)
}
struct Fake<'a> {
    lib: &'a Library,
    calls: RefCell<Vec<Value>>,
    response: RefCell<Value>,
    image: Vec<u8>,
    during: Option<Box<dyn Fn() + 'a>>,
}
impl HttpClient for Fake<'_> {
    fn post_json(
        &self,
        url: &str,
        key: &str,
        body: &[u8],
        limit: usize,
    ) -> Result<HttpResponse, LibraryError> {
        assert_eq!(url, ENDPOINT);
        assert_eq!(key, "test-secret");
        assert_eq!(limit, MAX_JSON);
        // A held library connection would deadlock this access.
        self.lib
            .connection()
            .unwrap()
            .query_row("SELECT 1", [], |_| Ok(()))
            .unwrap();
        self.calls
            .borrow_mut()
            .push(serde_json::from_slice(body).unwrap());
        if let Some(during) = &self.during {
            during();
        }
        Ok(HttpResponse {
            status: 200,
            bytes: serde_json::to_vec(&*self.response.borrow()).unwrap(),
            content_type: None,
        })
    }
    fn get(
        &self,
        _: &str,
        token: Option<&str>,
        limit: usize,
    ) -> Result<HttpResponse, LibraryError> {
        assert!(token.is_none());
        assert_eq!(limit, 15 * 1024 * 1024);
        self.lib
            .connection()
            .unwrap()
            .query_row("SELECT 1", [], |_| Ok(()))
            .unwrap();
        if let Some(during) = &self.during {
            during();
        }
        Ok(HttpResponse {
            status: 200,
            bytes: self.image.clone(),
            content_type: None,
        })
    }
}
fn performer(id: &str, name: &str, aliases: Value, gender: Value) -> Value {
    json!({"id":id,"name":name,"aliases":aliases,"gender":gender,"birth_date":"2001-12-08","height":156,
        "band_size":34,"waist_size":23,"hip_size":33,"cup_size":"E","breast_type":"NATURAL",
        "career_start_year":2021,"urls":[{"url":"https://example.com","site":{"name":"Studio Profile"}}],
        "images":[{"id":"photo","url":"https://stashdb.org/images/photo","width":2000,"height":3000}]})
}
fn fake(lib: &Library, results: Value) -> Fake<'_> {
    Fake {
        lib,
        calls: RefCell::new(vec![]),
        response: RefCell::new(json!({"data":{"searchPerformer":results}})),
        image: vec![],
        during: None,
    }
}
fn refresh(
    lib: &Library,
    state: &AvProfileState,
    http: &Fake<'_>,
    force: bool,
) -> AvPerformerProfile {
    lib.refresh_av_performer_profile_with("p", force, state, http, Some("test-secret"))
        .unwrap()
        .unwrap()
}
#[test]
fn av_stashdb_exact_alias_width_whitespace_match_and_gender_filter() {
    let (_dir, lib) = setup();
    let state = AvProfileState::default();
    let http = fake(
        &lib,
        json!([
            performer("1", "Other", json!([" 日本名 "]), json!("FEMALE")),
            performer("male", "日本名", json!([]), json!("MALE"))
        ]),
    );
    let p = refresh(&lib, &state, &http, false);
    assert_eq!(p.status, "matched");
    assert_eq!(p.stashdb_id.as_deref(), Some("1"));
    assert_eq!(p.band_in, Some(34));
    assert_eq!(p.height_cm, Some(156));
    assert_eq!(http.calls.borrow()[0]["variables"]["t"], "日本名");
    assert_eq!(normalize("　Ａlice   Ｎame "), "alice name");
    assert_eq!(
        lib.get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .images
            .len(),
        1
    );
}
#[test]
fn av_stashdb_ambiguous_none_and_nonfemale() {
    let (_dir, lib) = setup();
    let state = AvProfileState::default();
    let http = fake(
        &lib,
        json!([
            performer("1", "日本名", json!([]), Value::Null),
            performer("2", "Other", json!(["日本名"]), json!("FEMALE"))
        ]),
    );
    let p = refresh(&lib, &state, &http, true);
    assert_eq!(p.status, "ambiguous");
    assert_eq!(p.candidates.len(), 2);
    *http.response.borrow_mut() =
        json!({"data":{"searchPerformer":[performer("x","Unrelated",json!([]),Value::Null)]}});
    assert_eq!(refresh(&lib, &state, &http, true).status, "ambiguous");
    *http.response.borrow_mut() =
        json!({"data":{"searchPerformer":[performer("x","日本名",json!([]),json!("MALE"))]}});
    assert_eq!(refresh(&lib, &state, &http, true).status, "none");
    *http.response.borrow_mut() = json!({"data":{"searchPerformer":[]}});
    assert_eq!(refresh(&lib, &state, &http, true).status, "none");
}
#[test]
fn av_stashdb_freshness_force_no_key_and_failed_response_preserve_cache() {
    let (_dir, lib) = setup();
    let state = AvProfileState::default();
    let http = fake(&lib, json!([]));
    assert!(lib
        .refresh_av_performer_profile_with("p", true, &state, &http, None)
        .unwrap()
        .is_none());
    assert!(http.calls.borrow().is_empty());
    refresh(&lib, &state, &http, false);
    refresh(&lib, &state, &http, false);
    assert_eq!(http.calls.borrow().len(), 1);
    refresh(&lib, &state, &http, true);
    assert_eq!(http.calls.borrow().len(), 2);
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE collection_person_profiles SET fetched_at=?1",
            [(Utc::now() - Duration::days(31)).to_rfc3339()],
        )
        .unwrap();
    let old = refresh(&lib, &state, &http, false);
    assert_eq!(http.calls.borrow().len(), 3);
    lib.refresh_av_performer_profile_with("p", true, &state, &http, None)
        .unwrap();
    assert_eq!(http.calls.borrow().len(), 3);
    *http.response.borrow_mut() = json!({"errors":[{"message":"test-secret"}]});
    let err = lib
        .refresh_av_performer_profile_with("p", true, &state, &http, Some("test-secret"))
        .unwrap_err();
    assert!(!format!("{err:?} {err}").contains("test-secret"));
    assert_eq!(
        lib.get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .fetched_at,
        old.fetched_at
    );
}
#[test]
fn av_stashdb_choose_search_dismiss_and_clear() {
    let (_dir, lib) = setup();
    let state = AvProfileState::default();
    let http = fake(
        &lib,
        json!([performer("1", "日本名", json!([]), Value::Null)]),
    );
    let chooser = lib
        .search_av_performer_profile_with("p", &http, Some("test-secret"))
        .unwrap();
    assert_eq!(chooser.status, "ambiguous");
    assert_eq!(chooser.candidates.len(), 1);
    assert!(lib.get_av_performer_profile("p").unwrap().is_none());
    *http.response.borrow_mut() =
        json!({"data":{"findPerformer":performer("1","日本名",json!([]),Value::Null)}});
    let p = lib
        .choose_av_performer_profile_with("p", "1", &state, &http, Some("test-secret"))
        .unwrap();
    assert_eq!(p.status, "matched");
    assert!(http.calls.borrow()[1]["query"]
        .as_str()
        .unwrap()
        .contains("findPerformer"));
    assert_eq!(
        lib.get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("1")
    );
    lib.dismiss_av_performer_profile("p", &state).unwrap();
    assert_eq!(
        lib.get_av_performer_profile("p").unwrap().unwrap().status,
        "none"
    );
    lib.clear_av_performer_profile("p", &state).unwrap();
    assert!(lib.get_av_performer_profile("p").unwrap().is_none());
}
#[test]
fn av_stashdb_late_refresh_cannot_overwrite_dismissal() {
    let (_dir, lib) = setup();
    let state = AvProfileState::default();
    let mut http = fake(
        &lib,
        json!([performer("1", "日本名", json!([]), Value::Null)]),
    );
    http.during = Some(Box::new(|| {
        lib.dismiss_av_performer_profile("p", &state).unwrap();
    }));
    assert!(matches!(
        lib.refresh_av_performer_profile_with("p", true, &state, &http, Some("test-secret")),
        Err(AvError::Stale)
    ));
    assert_eq!(
        lib.get_av_performer_profile("p").unwrap().unwrap().status,
        "none"
    );
}
#[test]
fn av_stashdb_portrait_preview_reencodes_caps_and_persists() {
    let (_dir, lib) = setup();
    let state = AvProfileState::default();
    let portraits = AvPortraitState::default();
    let mut http = fake(
        &lib,
        json!([performer("1", "日本名", json!([]), Value::Null)]),
    );
    refresh(&lib, &state, &http, false);
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1800, 2400)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    http.image = png.into_inner();
    let p = lib
        .preview_av_stashdb_portrait_with("p", "photo", &portraits, &http)
        .unwrap();
    assert_eq!((p.width, p.height), (1200, 1600));
    assert!(p.data_url.starts_with("data:image/jpeg;base64,"));
    assert!(matches!(
        lib.use_av_stashdb_portrait("p", &portraits).unwrap(),
        AvPortrait::Stashdb { .. }
    ));
    let c = lib.connection().unwrap();
    let (kind, bytes, author, license): (String, Vec<u8>, Option<String>, Option<String>) = c
        .query_row(
            "SELECT kind,image_bytes,author,license FROM collection_person_portraits",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(kind, "stashdb");
    assert!(author.is_none() && license.is_none());
    assert_eq!(
        image::guess_format(&bytes).unwrap(),
        image::ImageFormat::Jpeg
    );
    drop(c);
    assert!(matches!(
        lib.get_av_performer("p").unwrap().person.portrait,
        Some(AvPortrait::Stashdb { .. })
    ));
    http.image = vec![0; 15 * 1024 * 1024 + 1];
    assert!(lib
        .preview_av_stashdb_portrait_with("p", "photo", &portraits, &http)
        .is_err());
    assert!(lib.use_av_stashdb_portrait("p", &portraits).is_err());
}
#[test]
fn av_stashdb_preview_cannot_survive_profile_change_or_discard() {
    let (_dir, lib) = setup();
    let profiles = AvProfileState::default();
    let portraits = AvPortraitState::default();
    let mut http = fake(
        &lib,
        json!([performer("1", "日本名", json!([]), Value::Null)]),
    );
    refresh(&lib, &profiles, &http, false);
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    http.image = png.into_inner();
    lib.preview_av_stashdb_portrait_with("p", "photo", &portraits, &http)
        .unwrap();
    lib.dismiss_av_performer_profile("p", &profiles).unwrap();
    assert!(matches!(
        lib.use_av_stashdb_portrait("p", &portraits),
        Err(AvError::Stale)
    ));
    refresh(&lib, &profiles, &http, true);
    http.during = Some(Box::new(|| portraits.discard(&lib, "p")));
    assert!(matches!(
        lib.preview_av_stashdb_portrait_with("p", "photo", &portraits, &http),
        Err(AvError::Stale)
    ));
}
