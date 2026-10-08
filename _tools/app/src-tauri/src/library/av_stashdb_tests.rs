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

struct RelayFake<'a> {
    lib: &'a Library,
    status: Value,
    replies: RefCell<Vec<(u16, Value)>>,
    calls: RefCell<Vec<(String, Option<Value>)>>,
    image: Vec<u8>,
    during: Option<Box<dyn Fn() + 'a>>,
}
impl StashdbRelay for RelayFake<'_> {
    fn request(&self, path: &str, body: Option<&Value>, _: usize) -> Result<HttpResponse, AvError> {
        self.lib
            .connection()
            .unwrap()
            .query_row("SELECT 1", [], |_| Ok(()))
            .unwrap();
        self.calls.borrow_mut().push((path.into(), body.cloned()));
        if let Some(during) = &self.during {
            during();
        }
        let (status, bytes) = if path == "/v1/providers/status" {
            (200, serde_json::to_vec(&self.status).unwrap())
        } else if path.starts_with("/v1/providers/stashdb/image?") {
            (200, self.image.clone())
        } else {
            let (status, value) = self.replies.borrow_mut().remove(0);
            (status, serde_json::to_vec(&value).unwrap())
        };
        Ok(HttpResponse {
            status,
            bytes,
            content_type: Some("image/jpeg".into()),
        })
    }
}
fn relay_profile(id: &str) -> Value {
    let performer: Performer =
        serde_json::from_value(performer(id, "日本名", json!([]), Value::Null)).unwrap();
    let mut value = serde_json::to_value(performer.validate().unwrap().matched("p")).unwrap();
    value["images"] = json!([{"id":"photo","url":format!("/v1/providers/stashdb/image?stashdbId={id}&imageId=photo"),"width":2,"height":3}]);
    value["imageUrl"] = value["images"][0]["url"].clone();
    value
}
fn active_setup() -> (tempfile::TempDir, Library) {
    use crate::library::collection_authority::tests::{adopt, fixture, work};
    let (dir, lib, status) = fixture();
    let mut work = work("av", 1);
    work["type"] = json!("av");
    work["details"]["av"] = json!({"genres":[]});
    work["avPeople"] = json!([{"personId":"p","displayName":"Name","nameJa":"日本名","entityRevision":1,"memo":null,"favorite":false,"stashdbId":null,"profile":null,"portraitSelection":null}]);
    work["avCredits"] = json!([{"personId":"p","name":"Name","nameJa":"日本名","role":"performer","order":0,"creditName":null,"portraitCrop":null}]);
    adopt(&lib, &status, json!({"works":[work]}));
    (dir, lib)
}
fn relay_fake(lib: &Library, replies: Vec<(u16, Value)>) -> RelayFake<'_> {
    RelayFake {
        lib,
        status: json!({"stashdb":true}),
        replies: RefCell::new(replies),
        calls: RefCell::new(vec![]),
        image: vec![],
        during: None,
    }
}
#[test]
fn av_stashdb_relay_search_choose_refresh_clear_and_local_dismiss() {
    use crate::library::collection_authority::tests::provider_commands;
    let (_dir, lib) = active_setup();
    let state = AvProfileState::default();
    assert!(lib.stashdb_routed().unwrap());
    let relay = relay_fake(
        &lib,
        vec![
            (
                200,
                json!({"items":[relay_profile("one")],"status":"matched","matchedId":"one"}),
            ),
            (200, relay_profile("one")),
        ],
    );
    let found = lib
        .search_av_performer_profile_relay_with("p", &relay)
        .unwrap();
    assert_eq!(found.candidates[0].stashdb_id, "one");
    assert!(lib.get_av_performer_profile("p").unwrap().is_none());
    let pending = lib
        .queue_av_performer_profile_relay_with("p", Some("one"), &state, &relay)
        .unwrap();
    assert!(pending.pending);
    assert!(pending.stashdb_id.is_none());
    let before = provider_commands(&lib);
    assert_eq!(before[0]["stashdbId"], "one");
    assert_eq!(before[0]["expectedRevision"], 1);
    assert!(before[0].get("profile").is_none());
    lib.dismiss_av_performer_profile_routed("p", &state)
        .unwrap();
    assert_eq!(provider_commands(&lib), before);
    assert!(
        lib.refresh_av_performer_profile_relay_with("p", false, &state, &relay)
            .unwrap()
            .unwrap()
            .pending
    );
    assert!(matches!(
        lib.refresh_av_performer_profile_relay_with("p", true, &state, &relay),
        Err(AvError::StashdbRelay("av_stashdb_identity_required", _))
    ));
    lib.queue_av_performer_profile_relay_with("p", None, &state, &relay)
        .unwrap();
    let bodies = provider_commands(&lib);
    assert_eq!(bodies[1]["stashdbId"], Value::Null);
    assert_eq!(bodies[1]["expectedRevision"], 2);
    assert!(relay
        .calls
        .borrow()
        .iter()
        .all(|(path, _)| path.starts_with("/v1/providers/")));
    let (_dir, inactive) = setup();
    assert!(!inactive.stashdb_routed().unwrap());
}
#[test]
fn av_stashdb_relay_old_server_and_not_configured_leave_everything_unchanged() {
    use crate::library::collection_authority::tests::provider_commands;
    let (_dir, lib) = active_setup();
    let state = AvProfileState::default();
    let mut relay = relay_fake(&lib, vec![]);
    relay.status = json!({"tmdb":true});
    assert!(!lib.stashdb_status_with(&relay).unwrap().supported);
    assert!(matches!(
        lib.queue_av_performer_profile_relay_with("p", None, &state, &relay),
        Err(AvError::StashdbRelay("av_stashdb_unsupported", _))
    ));
    relay.status = json!({"stashdb":false});
    assert!(matches!(
        lib.search_av_performer_profile_relay_with("p", &relay),
        Err(AvError::StashdbRelay("av_stashdb_not_configured", _))
    ));
    relay.status = json!({"stashdb":true});
    relay
        .replies
        .borrow_mut()
        .push((404, json!({"detail":"Not Found"})));
    assert!(matches!(
        lib.queue_av_performer_profile_relay_with("p", Some("one"), &state, &relay),
        Err(AvError::StashdbRelay("av_stashdb_unsupported", _))
    ));
    assert!(provider_commands(&lib).is_empty());
    assert!(lib.get_av_performer_profile("p").unwrap().is_none());
    for path in [
        "https://stashdb.org/images/photo",
        "//evil.invalid/v1/providers/stashdb/image?stashdbId=x&imageId=y",
        "/v1/providers/stashdb/image?stashdbId=one&imageId=..%2Fsecret",
        "/v1/providers/stashdb/image?stashdbId=one&imageId=photo&extra=x",
    ] {
        assert!(relay_image_path(path).is_err());
    }
}
#[test]
fn av_stashdb_relay_http_uses_client_auth_status_and_redacts_errors() {
    let (client, requests) = CloudClient::home_test_client(vec![
        json!({"stashdb":true}),
        relay_profile("one"),
        json!({"prepared":true}),
        json!({"tmdb":true}),
    ]);
    let relay = (client, "client-token".into());
    assert!(relay_status(&relay).unwrap().configured);
    assert_eq!(
        relay_detail(&relay, "p", "one")
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("one")
    );
    relay_json(
        &relay,
        "/v1/providers/stashdb/portrait",
        Some(&json!({"stashdbId":"one","imageId":"photo"})),
    )
    .unwrap();
    assert!(!relay_status(&relay).unwrap().supported);
    let requests = requests.lock().unwrap();
    for request in requests.iter() {
        let wire = String::from_utf8_lossy(request).to_ascii_lowercase();
        assert!(wire.contains("authorization: bearer client-token"));
        assert!(!wire.contains("apikey"));
        assert!(!wire.contains("stashdb.org"));
    }
    assert!(String::from_utf8_lossy(&requests[0]).starts_with("GET /v1/providers/status "));
    assert!(
        String::from_utf8_lossy(&requests[2]).starts_with("POST /v1/providers/stashdb/portrait ")
    );
    let error = relay_response(HttpResponse {
        status: 503,
        bytes: json!({"detail":{"code":"providerNotConfigured","message":"secret-key"}})
            .to_string()
            .into_bytes(),
        content_type: None,
    })
    .err()
    .unwrap();
    assert!(matches!(
        error,
        AvError::StashdbRelay("av_stashdb_not_configured", _)
    ));
    assert!(!format!("{error:?}").contains("secret-key"));
}

#[test]
fn av_stashdb_relay_portrait_prepares_manifest_preserves_optimistic_bytes_and_stale_guard() {
    use crate::library::collection_authority::tests::provider_commands;
    let (_dir, lib) = active_setup();
    let portraits = AvPortraitState::default();
    lib.connection().unwrap().execute("UPDATE collection_authority_people_cache SET payload=json_set(payload,'$.stashdbId','one') WHERE person_id='p'",[]).unwrap();
    lib.connection().unwrap().execute("INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,fetched_at) VALUES('p','stashdb','matched','one','Name','now')",[]).unwrap();
    let manifest = json!({"original":{"sha256":"a".repeat(64),"sizeBytes":42,"contentType":"image/jpeg"},"width":2,"height":3,"attribution":{"source":"stashdb","sourceUrl":"https://stashdb.org/images/photo","license":null,"author":null}});
    let mut relay = relay_fake(
        &lib,
        vec![
            (200, relay_profile("one")),
            (200, manifest.clone()),
            (200, relay_profile("one")),
            (200, manifest.clone()),
        ],
    );
    let mut image = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    relay.image = image.into_inner();
    let preview = lib
        .preview_av_stashdb_portrait_relay_with("p", "photo", &portraits, &relay)
        .unwrap();
    assert_eq!((preview.width, preview.height), (2, 3));
    assert!(matches!(
        lib.use_av_stashdb_portrait_relay_with("p", &portraits, &relay)
            .unwrap(),
        AvPortrait::Stashdb { .. }
    ));
    let command = provider_commands(&lib).pop().unwrap();
    assert_eq!(command["commandType"], "setPersonPortrait");
    assert_eq!(command["portrait"]["original"], manifest["original"]);
    assert_eq!(command["expectedRevision"], 1);
    assert_eq!(
        lib.connection()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM collection_authority_portrait_blobs WHERE sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_some());
    let post = relay
        .calls
        .borrow()
        .iter()
        .find(|(p, _)| p == "/v1/providers/stashdb/portrait")
        .unwrap()
        .1
        .clone()
        .unwrap();
    assert_eq!(post, json!({"stashdbId":"one","imageId":"photo"}));
    lib.preview_av_stashdb_portrait_relay_with("p", "photo", &portraits, &relay)
        .unwrap();
    relay.during = Some(Box::new(|| portraits.discard(&lib, "p")));
    assert!(matches!(
        lib.use_av_stashdb_portrait_relay_with("p", &portraits, &relay),
        Err(AvError::Stale)
    ));
    assert_eq!(provider_commands(&lib).len(), 1);
}

impl StashdbRelay for (CloudClient, String) {
    fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<HttpResponse, AvError> {
        Ok(self.0.stashdb_relay_request(path, body, &self.1, limit)?)
    }
}

#[test]
fn av_stashdb_active_cached_provider_urls_never_become_automatic_portraits() {
    let (_dir, lib) = active_setup();
    lib.connection().unwrap().execute("INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,images_json,fetched_at) VALUES('p','stashdb','matched','one','Name',?1,'now')",[relay_profile("one")["images"].to_string().replace("/v1/providers/stashdb/image?stashdbId=one&imageId=photo","https://stashdb.org/images/photo")]).unwrap();
    let profile = lib.get_av_performer_profile("p").unwrap().unwrap();
    assert!(profile.images.is_empty());
    assert_eq!(profile.stashdb_id.as_deref(), Some("one"));
    assert!(lib.get_av_performer("p").unwrap().person.portrait.is_none());
}

#[test]
fn av_stashdb_relay_refresh_uses_saved_identity_and_clear_works_without_server_key() {
    use crate::library::collection_authority::tests::provider_commands;
    let (_dir, library) = active_setup();
    library.connection().unwrap().execute("UPDATE collection_authority_people_cache SET payload=json_set(payload,'$.stashdbId','one') WHERE person_id='p'",[]).unwrap();
    library.connection().unwrap().execute("INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,fetched_at) VALUES('p','stashdb','matched','one','Name','now')",[]).unwrap();
    let state = AvProfileState::default();
    let mut relay = relay_fake(&library, vec![(200, relay_profile("one"))]);
    library
        .refresh_av_performer_profile_relay_with("p", false, &state, &relay)
        .unwrap();
    assert!(relay.calls.borrow().is_empty());
    let result = library
        .refresh_av_performer_profile_relay_with("p", true, &state, &relay)
        .unwrap()
        .unwrap();
    assert_eq!(result.stashdb_id.as_deref(), Some("one"));
    assert!(result.pending);
    relay.status = json!({"stashdb":false});
    library
        .queue_av_performer_profile_relay_with("p", None, &state, &relay)
        .unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands[0]["stashdbId"], "one");
    assert_eq!(commands[1]["stashdbId"], Value::Null);
    assert_eq!(commands[1]["expectedRevision"], 2);
    assert_ne!(commands[0]["operationId"], commands[1]["operationId"]);
    assert_eq!(
        library
            .get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("one")
    );
}
