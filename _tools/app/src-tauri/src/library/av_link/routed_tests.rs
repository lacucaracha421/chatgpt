//! Server AV inbox routing, apply sequence, resume and migration. Every server call goes
//! through a mock: no test touches a network, a credential store or a real library.
use super::routed::{InboxServer, Route};
use super::*;
use crate::cloud::client::CollectionDelivery;
use crate::library::collection_authority::{
    collection_write_status,
    tests::{adopt, fixture, provider_commands, work},
    CollectionAuthorityStatus,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};

const NOW: &str = "2026-10-09T00:00:00Z";
const ENDPOINT: &str = "https://fixture.invalid/";
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---- mock inbox server --------------------------------------------------------------

type Handler = Box<dyn FnMut(&str, &str, Option<&Value>) -> HttpResponse>;
struct Mock {
    calls: RefCell<Vec<(String, String, Option<Value>)>>,
    handler: RefCell<Handler>,
}
impl Mock {
    fn new(handler: impl FnMut(&str, &str, Option<&Value>) -> HttpResponse + 'static) -> Self {
        Self {
            calls: RefCell::new(vec![]),
            handler: RefCell::new(Box::new(handler)),
        }
    }
    fn paths(&self) -> Vec<String> {
        self.calls
            .borrow()
            .iter()
            .map(|(m, p, _)| format!("{m} {p}"))
            .collect()
    }
    fn bodies(&self, needle: &str) -> Vec<Value> {
        self.calls
            .borrow()
            .iter()
            .filter(|(_, p, _)| p.contains(needle))
            .filter_map(|(_, _, b)| b.clone())
            .collect()
    }
}
impl InboxServer for Mock {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        _limit: usize,
    ) -> Result<HttpResponse, AvError> {
        self.calls
            .borrow_mut()
            .push((method.into(), path.into(), body.cloned()));
        Ok((self.handler.borrow_mut())(method, path, body))
    }
}
fn reply(status: u16, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        bytes: body.to_string().into_bytes(),
        content_type: Some("application/json".into()),
    }
}
fn coded(status: u16, code: &str) -> HttpResponse {
    reply(status, json!({"detail":{"code":code}}))
}

// ---- fixtures -------------------------------------------------------------------------

fn summary(id: &str, status: &str, code: &str) -> Value {
    json!({"id":id,"requestId":id,"sequence":1,"productCode":code,"normalizedCode":code,
        "sourceUrl":"https://fixture.invalid/work","receivedAt":"2026-10-09T01:00:00Z",
        "status":status,"attempts":1,"lastError":null,"fetchedAt":null,"appliedWorkId":null,"titleJa":null})
}
fn candidate(width: u32, wrap: bool) -> Value {
    json!({
        "metadata":{"normalized_id":"SSIS-001","title":"候補タイトル","date":"2021-02-19","makers":["メーカーA"],
            "labels":["レーベルA"],"series":[],"actresses":[{"name":"葵つかさ","image_url":null},{"name":"女優B","image_url":null}],
            "directors":["苺原"],"genres":["ドラマ"],"cover_image_url":"https://pics.dmm.co.jp/x.jpg",
            "thumbnail_image_url":null,"volume":null},
        "fields":{"titleJa":"候補タイトル","releaseDate":"2021-02-19","maker":"メーカーA","label":"レーベルA","series":null,"genres":["ドラマ"]},
        "jacketWidth":width,"jacketHeight":538,"jacketUrl":"/v1/av-inbox/x/jacket",
        "defaultSplit":{"x1":if wrap{378}else{0},"x2":if wrap{422}else{0},"isWrap":wrap,"useSpine":wrap},
        "performers":[{"nameJa":"葵つかさ","nameKo":"아오이 츠카사","wikidataId":"Q1","fanzaActressId":null},
            {"nameJa":"女優B","nameKo":null,"wikidataId":null,"fanzaActressId":null}],
        "directors":[{"nameJa":"苺原","nameKo":null,"wikidataId":null,"fanzaActressId":null}],
    })
}
fn detail(id: &str, matches: Value) -> Value {
    json!({"inbox":summary(id,"found","SSIS-001"),"candidate":candidate(800,true),"matches":matches})
}
fn manifest(surface: &str, split: (u32, u32)) -> Value {
    let kind = if surface == "front" { "cover" } else { surface };
    json!({"surface":surface,"kind":kind,"provider":"libredmm",
        "providerImageId":format!("SSIS-001:jacket:{}:{}:{surface}",split.0,split.1),
        "width":100,"height":538,"language":"ja",
        "original":{"sha256":SHA,"sizeBytes":1234,"contentType":"image/jpeg"},
        "thumbnail":{"sha256":SHA,"sizeBytes":99,"contentType":"image/webp"}})
}

fn av_work(id: &str, rev: i64, code: Option<&str>) -> Value {
    let mut w = work(id, rev);
    w["type"] = json!("av");
    w["name"] = json!(format!("AV {id}"));
    w["fields"]["status"] = Value::Null;
    w["selection"] = json!({"work":null,"hero":null,"backdrop":null,"spine":null,"back":null});
    w["details"]["av"] = json!({"productCode":code,"titleJa":null,"maker":null,"label":null,"series":null,"genres":[],"releaseDate":null});
    w["avCredits"] = json!([]);
    w["avPeople"] = json!([]);
    w
}
fn person(id: &str, name: &str, ja: &str) -> Value {
    json!({"personId":id,"displayName":name,"nameJa":ja,"memo":null,"profile":null,"portrait":null})
}
fn credit(person: &str, role: &str, order: i64, name: &str) -> Value {
    json!({"personId":person,"name":name,"nameJa":null,"role":role,"order":order,"creditName":name,"portraitCrop":null})
}
fn artwork(id: &str, work: &str, kind: &str) -> Value {
    json!({"artworkId":id,"workId":work,"kind":kind,"provider":"local-manual","providerImageId":format!("{kind}/{id}"),
        "width":10,"height":20,"language":null,"original":{"sha256":SHA,"sizeBytes":5,"contentType":"image/png","objectKey":"unused"},
        "thumbnail":null,"createdAt":NOW,"entityRevision":1})
}

/// A library with the authority adopted, a configured server and the Server route confirmed.
fn routed(entities: Value) -> (tempfile::TempDir, Library, CollectionAuthorityStatus) {
    let (temp, library, status) = fixture();
    adopt(&library, &status, entities);
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE library_settings SET cloud_api_base_url=?1 WHERE singleton=1",
            [ENDPOINT],
        )
        .unwrap();
    let probe =
        Mock::new(|_, _, _| reply(200, json!({"items":[],"nextBefore":null,"hasMore":false})));
    library.refresh_av_route_with(&probe, 1_000).unwrap();
    assert_eq!(library.av_link_route().unwrap(), Route::Server);
    let status = collection_write_status(&library.connection().unwrap()).unwrap();
    (temp, library, status)
}

fn request_new() -> ApplyRequest {
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

// ---- a model of the authority server -----------------------------------------------

/// Enough of the authority to check composed commands: ids, field CAS, selection CAS and
/// revision CAS with the documented bump rules. A command id is never accepted twice.
struct Authority {
    works: BTreeMap<String, Value>,
    artworks: BTreeMap<String, Value>,
    accepted: BTreeSet<String>,
    sent: Vec<String>,
    cursor: i64,
    refuse: Option<(String, CollectionDelivery)>,
}
impl Authority {
    fn new(works: Vec<Value>) -> Self {
        Self {
            works: works
                .into_iter()
                .map(|w| (w["workId"].as_str().unwrap().to_owned(), w))
                .collect(),
            artworks: BTreeMap::new(),
            accepted: BTreeSet::new(),
            sent: vec![],
            cursor: 0,
            refuse: None,
        }
    }
    fn revision(&self, work: &str) -> i64 {
        self.works[work]["entityRevision"].as_i64().unwrap()
    }
    fn handle(&mut self, status: &CollectionAuthorityStatus, body: &Value) -> CollectionDelivery {
        let op = body["operationId"].as_str().unwrap().to_owned();
        assert!(
            !self.accepted.contains(&op),
            "operation {op} was sent after acceptance"
        );
        let kind = body["commandType"].as_str().unwrap().to_owned();
        if let Some((target, _)) = &self.refuse {
            if *target == kind {
                return self.refuse.take().unwrap().1;
            }
        }
        self.sent.push(kind.clone());
        let work_id = body["workId"].as_str().unwrap_or("").to_owned();
        let mut entities = json!({});
        let mut changed = false;
        match kind.as_str() {
            "createWork" => {
                assert!(!self.works.contains_key(&work_id));
                let mut w = av_work(&work_id, 0, None);
                w["name"] = body["name"].clone();
                w["details"]["av"] = Value::Null;
                self.works.insert(work_id.clone(), w);
                changed = true;
            }
            "addArtwork" => {
                let mut a = artwork(
                    body["artworkId"].as_str().unwrap(),
                    &work_id,
                    body["kind"].as_str().unwrap(),
                );
                a["provider"] = body["provider"].clone();
                a["providerImageId"] = body["providerImageId"].clone();
                a["original"] = body["original"].clone();
                entities["artworks"] = json!([a.clone()]);
                self.artworks
                    .insert(a["artworkId"].as_str().unwrap().to_owned(), a);
            }
            "selectArtwork" => {
                let w = self.works.get_mut(&work_id).unwrap();
                let slot = body["slot"].as_str().unwrap();
                if w["selection"][slot] != body["expectedArtworkId"] {
                    return CollectionDelivery::Conflict(
                        json!({"code":"selectionConflict","current":{"work":w.clone()}}),
                    );
                }
                if w["selection"][slot] != body["artworkId"] {
                    w["selection"][slot] = body["artworkId"].clone();
                    changed = true;
                }
            }
            "setAvDetails" => {
                let w = self.works.get_mut(&work_id).unwrap();
                if w["details"]["av"].is_null() {
                    w["details"]["av"] = json!({"productCode":null,"titleJa":null,"maker":null,"label":null,"series":null,"genres":[],"releaseDate":null});
                }
                for (field, value) in body["changes"].as_object().unwrap() {
                    assert_eq!(
                        body["expected"][field], w["details"]["av"][field],
                        "field CAS for {field}"
                    );
                    if w["details"]["av"][field] != *value {
                        w["details"]["av"][field] = value.clone();
                        changed = true;
                    }
                }
            }
            "setAvCredits" => {
                let w = self.works.get_mut(&work_id).unwrap();
                if w["entityRevision"] != body["expectedRevision"] {
                    return CollectionDelivery::Conflict(
                        json!({"code":"revisionConflict","current":{"work":w.clone()}}),
                    );
                }
                for p in body["people"].as_array().unwrap() {
                    w["avPeople"].as_array_mut().unwrap().push(json!({"personId":p["personId"],"displayName":p["displayName"],"nameJa":p["nameJa"],"memo":null,"profile":null,"portrait":null}));
                }
                changed = w["avCredits"].as_array().unwrap().len()
                    != body["credits"].as_array().unwrap().len();
                w["avCredits"] = json!(body["credits"].as_array().unwrap().iter().map(|c| {
                    let name = c["creditName"].clone();
                    json!({"personId":c["personId"],"name":name,"nameJa":null,"role":c["role"],"order":c["order"],"creditName":c["creditName"],"portraitCrop":null})
                }).collect::<Vec<_>>());
            }
            other => panic!("unexpected command {other}"),
        }
        if changed {
            let w = self.works.get_mut(&work_id).unwrap();
            w["entityRevision"] = json!(w["entityRevision"].as_i64().unwrap() + 1);
        }
        if !work_id.is_empty() && kind != "addArtwork" {
            entities["works"] = json!([self.works[&work_id].clone()]);
        }
        self.cursor += 1;
        self.accepted.insert(op.clone());
        let mut receipt = json!({"libraryId":status.library_id,"epoch":status.epoch,"contractVersion":status.contract_version});
        receipt["operationId"] = json!(op);
        receipt["commandType"] = json!(kind);
        receipt["changed"] = json!(changed);
        receipt["authorityCursor"] = json!(self.cursor);
        receipt["entities"] = entities;
        CollectionDelivery::Accepted(receipt)
    }
}

fn flush(
    library: &Library,
    status: &CollectionAuthorityStatus,
    authority: &RefCell<Authority>,
    limit: usize,
    now: i64,
) {
    let remaining = RefCell::new(limit);
    library
        .flush_collection_outbox_with(
            status,
            &|body| {
                let mut left = remaining.borrow_mut();
                if *left == 0 {
                    return Ok(CollectionDelivery::Retry);
                }
                *left -= 1;
                Ok(authority.borrow_mut().handle(status, body))
            },
            now,
        )
        .unwrap();
}

fn outbox(library: &Library) -> Vec<(String, String)> {
    library
        .connection()
        .unwrap()
        .prepare("SELECT command_type,state FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The server mock for one found item: detail, artwork preparation and acknowledgement.
fn item_server(id: &'static str, matches: Value) -> Mock {
    Mock::new(move |method, path, body| {
        if path == format!("/v1/av-inbox/{id}") {
            reply(200, detail(id, matches.clone()))
        } else if path == format!("/v1/av-inbox/{id}/artwork") {
            let body = body.unwrap();
            let split = (
                body["x1"].as_u64().unwrap() as u32,
                body["x2"].as_u64().unwrap() as u32,
            );
            let items: Vec<Value> = body["surfaces"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| manifest(s.as_str().unwrap(), split))
                .collect();
            reply(200, json!({"items":items}))
        } else if path == format!("/v1/av-inbox/{id}/applied") {
            assert_eq!(method, "POST");
            let mut applied = summary(id, "applied", "SSIS-001");
            applied["appliedWorkId"] = body.unwrap()["workId"].clone();
            reply(200, json!({"inbox":applied,"candidate":null,"matches":[]}))
        } else {
            reply(404, json!({"detail":"unexpected"}))
        }
    })
}

const ID: &str = "11111111-1111-4111-8111-111111111111";

// ---- routing ------------------------------------------------------------------------

#[test]
fn routing_follows_authority_and_server_support() {
    let (temp, library, status) = fixture();
    // Authority inactive: today's local path, no server involved.
    assert_eq!(library.av_link_route().unwrap(), Route::Local);
    library
        .ingest_av_link_page(
            ENDPOINT,
            0,
            FeedPage {
                items: vec![FeedItem {
                    sequence: 1,
                    request_id: ID.into(),
                    product_code: "SSIS-001".into(),
                    source_url: None,
                    received_at: "2026-10-09T00:00:00Z".into(),
                }],
                next_after: 1,
                has_more: false,
            },
        )
        .unwrap();
    assert_eq!(library.list_av_link_inbox().unwrap().len(), 1);
    assert_eq!(library.av_link_pending_count().unwrap(), 1);

    // Authority active, route not probed: still the local inbox, apply fenced.
    adopt(&library, &status, json!({"works":[]}));
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE library_settings SET cloud_api_base_url=?1 WHERE singleton=1",
            [ENDPOINT],
        )
        .unwrap();
    assert_eq!(library.av_link_route().unwrap(), Route::OldServer);
    let local_id = library.list_av_link_inbox().unwrap()[0].id.clone();
    let fenced = library.apply_av_link(&local_id, request_new()).unwrap_err();
    assert!(matches!(
        fenced,
        AvError::Library(LibraryError::CollectionAuthorityOperationUnavailable)
    ));

    // An older server answers 404: the local inbox stays, and it is probed again only later.
    let old = Mock::new(|_, _, _| coded(404, "notFound"));
    library.refresh_av_route_with(&old, 1_000).unwrap();
    assert_eq!(library.av_link_route().unwrap(), Route::OldServer);
    assert_eq!(library.list_av_link_inbox().unwrap().len(), 1);
    library.refresh_av_route_with(&old, 1_100).unwrap();
    assert_eq!(old.calls.borrow().len(), 1);
    // The upgraded server confirms the route and the list now comes from the server mirror.
    let upgraded =
        Mock::new(|_, _, _| reply(200, json!({"items":[],"nextBefore":null,"hasMore":false})));
    library.refresh_av_route_with(&upgraded, 2_000).unwrap();
    assert_eq!(library.av_link_route().unwrap(), Route::Server);
    assert!(library.list_av_link_inbox().unwrap().is_empty());
    assert_eq!(library.av_link_pending_count().unwrap(), 0);
    // A server that loses the route falls back to the local inbox.
    let gone = Mock::new(|_, _, _| coded(404, "notFound"));
    assert!(library.refresh_av_mirror_with(&gone, 3_000).is_err());
    assert_eq!(library.av_link_route().unwrap(), Route::OldServer);
    drop(temp);
}

#[test]
fn routed_mode_never_runs_the_local_provider_worker() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    // A local row that would be due for a LibreDMM fetch.
    library
        .connection()
        .unwrap()
        .execute("INSERT INTO av_link_inbox(id,request_id,product_code,normalized_code,received_at,status) VALUES('l','00000000-0000-4000-8000-000000000001','SSIS-001','SSIS-001','2026-10-09T00:00:00Z','queued')", [])
        .unwrap();
    let server =
        Mock::new(|_, _, _| reply(200, json!({"items":[],"nextBefore":null,"hasMore":false})));
    let now = chrono::Utc::now().timestamp();
    assert!(library.routed_av_cycle(&server, now, false));
    assert!(library.routed_av_cycle(&server, now, false));
    // Only server inbox traffic: no LibreDMM, Wikidata or feed poll.
    for path in server.paths() {
        assert!(
            path.contains("/v1/av-inbox") || path.contains("/v1/av-lookups"),
            "unexpected request {path}"
        );
    }
    let c = library.connection().unwrap();
    assert_eq!(
        c.query_row("SELECT status FROM av_link_inbox WHERE id='l'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "queued"
    );
    drop(c);
    // The local queued row does not wake the worker in routed mode.
    let due = library.next_av_link_due_at(false).unwrap().unwrap();
    assert!(due > now, "routed due time ignores the local queue");
    // After a failed server contact the cycle waits instead of retrying every second.
    super::routed::note_retry(&library.connection().unwrap(), now + 500);
    assert!(library.next_av_link_due_at(false).unwrap().unwrap() >= now + 500);
}

// ---- list and candidate -----------------------------------------------------------

#[test]
fn list_maps_server_states_and_matches() {
    let mut a = av_work("av-a", 1, Some("SSIS-001"));
    a["name"] = json!("A 작품");
    let mut b = av_work("av-b", 1, Some("SSIS-001"));
    b["name"] = json!("B 작품");
    let mut c = av_work("av-c", 1, Some("ABW-100"));
    c["name"] = json!("C 작품");
    let (_temp, library, _) = routed(json!({"works":[a, b, c]}));
    let ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
    ];
    let mut items = vec![
        summary(ids[0], "found", "SSIS-001"),
        summary(ids[1], "queued", "NEW-1"),
        summary(ids[2], "not_found", "NOPE-1"),
        summary(ids[3], "error", "ERR-1"),
        summary(ids[4], "found", "ABW-100"),
    ];
    items[0]["receivedAt"] = json!("2026-10-09T01:00:00Z");
    items[1]["receivedAt"] = json!("2026-10-09T02:00:00Z");
    items[3]["lastError"] = json!("avLookupReadyTimeout");
    items[4]["receivedAt"] = json!("2026-10-09T05:00:00Z");
    let server = Mock::new(move |_, _, _| {
        reply(
            200,
            json!({"items":items.clone(),"nextBefore":null,"hasMore":false}),
        )
    });
    library.refresh_av_mirror_with(&server, 2_000).unwrap();
    let list = library.list_av_link_inbox().unwrap();
    assert_eq!(list.len(), 5);
    assert_eq!(
        list.iter().map(|i| i.status.as_str()).collect::<Vec<_>>(),
        ["found", "not_found", "error", "queued", "found"]
    );
    // Two live collections share SSIS-001: no auto-pick, the user chooses.
    assert_eq!(list[0].collection_id, None);
    assert_eq!(
        list[0]
            .matches
            .iter()
            .map(|m| m.collection_id.as_str())
            .collect::<Vec<_>>(),
        ["av-a", "av-b"]
    );
    // A single match is offered directly.
    assert_eq!(list[4].collection_id.as_deref(), Some("av-c"));
    assert_eq!(list[4].collection_name.as_deref(), Some("C 작품"));
    assert_eq!(
        list[2].last_error.as_deref(),
        Some("LibreDMM이 아직 준비 중이에요")
    );
    assert_eq!(library.av_link_pending_count().unwrap(), 5);

    // The chooser reads the server detail; several matches stay unselected.
    let detail_server = item_server(
        ids[0],
        json!([
        {"libraryId":"l","workId":"av-a","name":"x","entityRevision":1},
        {"libraryId":"l","workId":"av-b","name":"y","entityRevision":1}]),
    );
    let candidate = library
        .routed_candidate(&detail_server, ids[0], None)
        .unwrap();
    assert!(candidate.current.is_none());
    assert_eq!(candidate.matches.len(), 2);
    assert_eq!(candidate.matches[0].name, "A 작품");
    assert_eq!(candidate.performers.len(), 2);
    assert_eq!(
        candidate.performers[0].mapping.name_ko.as_deref(),
        Some("아오이 츠카사")
    );
    assert_eq!(candidate.directors[0].mapping.name_ja, "苺原");
    assert_eq!(candidate.jacket_width, 800);
    assert!(candidate.default_split.is_wrap);
    // Choosing one explicitly previews that collection.
    let chosen = library
        .routed_candidate(&detail_server, ids[0], Some("av-b"))
        .unwrap();
    assert_eq!(chosen.current.unwrap().collection_id, "av-b");
    // A server match this PC has not received yet is never silently replaced by a new work.
    let syncing = item_server(
        ids[0],
        json!([{"libraryId":"l","workId":"missing","name":"z","entityRevision":1}]),
    );
    assert!(matches!(
        library.routed_candidate(&syncing, ids[0], None),
        Err(AvError::Inbox("av_inbox_work_syncing", _))
    ));
}

#[test]
fn actions_go_to_the_server_and_update_the_mirror() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    let mut dismissed = summary(ID, "dismissed", "SSIS-001");
    dismissed["lastError"] = Value::Null;
    let server = Mock::new(move |_, path, _| {
        if path.ends_with("/retry") || path.ends_with("/fix-code") {
            reply(
                200,
                json!({"inbox":summary(ID,"queued","ABW-100"),"candidate":null,"matches":[]}),
            )
        } else if path.ends_with("/dismiss") {
            reply(
                200,
                json!({"inbox":dismissed.clone(),"candidate":null,"matches":[]}),
            )
        } else {
            reply(
                200,
                json!({"items":[summary(ID,"not_found","ABW-100")],"nextBefore":null,"hasMore":false}),
            )
        }
    });
    library.refresh_av_mirror_with(&server, 2_000).unwrap();
    library.routed_retry(&server, ID).unwrap();
    assert_eq!(library.list_av_link_inbox().unwrap()[0].status, "queued");
    library.routed_fix_code(&server, ID, " abw-100 ").unwrap();
    assert_eq!(
        server.bodies("/fix-code")[0],
        json!({"productCode":"ABW-100"})
    );
    assert!(matches!(
        library.routed_fix_code(&server, ID, "!!"),
        Err(AvError::Invalid)
    ));
    library.routed_dismiss(&server, ID).unwrap();
    assert!(library.list_av_link_inbox().unwrap().is_empty());
    assert_eq!(library.av_link_pending_count().unwrap(), 0);
}

// ---- apply ----------------------------------------------------------------------------

#[test]
fn apply_new_work_queues_the_exact_sequence_and_acknowledges_once() {
    let (_temp, library, status) = routed(json!({"works":[]}));
    let server = item_server(ID, json!([]));
    let result = library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap();
    let work_id = result.collection_id.clone();
    // The wrap split sends exactly the chosen surfaces.
    assert_eq!(
        server.bodies("/artwork"),
        vec![json!({"x1":378,"x2":422,"surfaces":["front","spine","back"]})]
    );
    let commands = provider_commands(&library);
    let kinds: Vec<&str> = commands
        .iter()
        .map(|c| c["commandType"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "createWork",
            "addArtwork",
            "selectArtwork",
            "addArtwork",
            "selectArtwork",
            "addArtwork",
            "selectArtwork",
            "setAvDetails",
            "setAvCredits"
        ]
    );
    assert_eq!(commands[0]["name"], "SSIS-001");
    assert_eq!(commands[0]["workId"], work_id);
    assert_eq!(commands[0]["type"], "av");
    assert!(commands[0]["binding"].is_null() && commands[0]["fields"] == json!({}));
    assert!(commands[1].get("surface").is_none());
    assert_eq!(commands[1]["kind"], "cover");
    assert_eq!(commands[1]["provider"], "libredmm");
    assert_eq!(commands[2]["slot"], "work");
    assert!(commands[2]["expectedArtworkId"].is_null());
    assert_eq!(commands[2]["artworkId"], commands[1]["artworkId"]);
    assert_eq!(commands[4]["slot"], "spine");
    assert_eq!(commands[6]["slot"], "back");
    assert_eq!(commands[7]["changes"]["productCode"], "SSIS-001");
    assert_eq!(commands[7]["changes"]["titleJa"], "選択した原題");
    assert_eq!(commands[7]["changes"]["genres"], json!(["ドラマ"]));
    assert_eq!(commands[7]["expected"]["genres"], json!([]));
    assert!(commands[7]["expected"]["titleJa"].is_null());
    // create 1, three changed selections 4, changed details 5.
    assert_eq!(commands[8]["expectedRevision"], 5);
    assert_eq!(commands[8]["people"].as_array().unwrap().len(), 2);
    assert_eq!(commands[8]["people"][0]["displayName"], "아오이 츠카사");
    assert_eq!(commands[8]["people"][0]["nameJa"], "葵つかさ");
    assert!(commands[8]["people"][0].get("wikidataId").is_none());
    assert_eq!(commands[8]["credits"][0]["role"], "director");
    assert_eq!(commands[8]["credits"][0]["creditName"], "苺原");
    assert_eq!(commands[8]["credits"][1]["role"], "performer");
    // While the choice is being written the row says so and no longer counts as waiting.
    let found_list = Mock::new(|_, _, _| {
        reply(
            200,
            json!({"items":[summary(ID,"found","SSIS-001")],"nextBefore":null,"hasMore":false}),
        )
    });
    library.refresh_av_mirror_with(&found_list, 500).unwrap();
    assert_eq!(
        library.list_av_link_inbox().unwrap()[0]
            .apply_state
            .as_deref(),
        Some("applying")
    );
    assert_eq!(library.av_link_pending_count().unwrap(), 0);
    // Locally the new work is visible at once; the old inbox state is untouched.
    let c = library.connection().unwrap();
    let name: String = c
        .query_row(
            "SELECT name FROM collections WHERE id=?1",
            [&work_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "SSIS-001");
    drop(c);

    // The model authority accepts every expectation: predicted revisions and CAS values hold.
    let authority = RefCell::new(Authority::new(vec![]));
    flush(&library, &status, &authority, usize::MAX, 1_000_000);
    assert_eq!(authority.borrow().sent.len(), 9);
    assert_eq!(authority.borrow().revision(&work_id), 6);
    assert!(
        outbox(&library).iter().all(|(_, s)| s == "accepted"),
        "{:?}",
        outbox(&library)
    );
    let covers = library.get_av_cover_set(&work_id).unwrap();
    assert!(covers.front_id.is_some() && covers.spine_id.is_some() && covers.back_id.is_some());

    // Accepted commands make the acknowledgement due immediately.
    assert!(library.next_av_link_due_at(false).unwrap().unwrap() <= chrono::Utc::now().timestamp());
    // The acknowledgement goes out once all commands are accepted, and only once.
    let now = 10_000;
    library.resume_av_inbox_applies(&server, now).unwrap();
    library.resume_av_inbox_applies(&server, now + 100).unwrap();
    let acks = server.bodies("/applied");
    assert_eq!(acks, vec![json!({"workId":work_id})]);
    assert_eq!(provider_commands(&library).len(), 9);
    // Acknowledged: the row is gone from the list.
    assert!(library.list_av_link_inbox().unwrap().is_empty());
}

#[test]
fn apply_existing_work_keeps_manual_surfaces_and_existing_credits() {
    let mut w = av_work("av-1", 3, Some("SSIS-001"));
    w["selection"]["work"] = json!("manual-front");
    w["selection"]["back"] = json!("manual-back");
    w["avCredits"] = json!([credit("p1", "performer", 0, "既存")]);
    w["avPeople"] = json!([
        person("p1", "기존 배우", "既存"),
        person("p2", "다른 배우", "葵つかさ")
    ]);
    let arts = json!([
        artwork("manual-front", "av-1", "cover"),
        artwork("manual-back", "av-1", "back")
    ]);
    let (_temp, library, status) = routed(json!({"works":[w.clone()],"artworks":arts}));
    // A person only this PC knows (never credited on the server).
    library
        .connection()
        .unwrap()
        .execute("INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES('p3','로컬 감독','苺原',?1,?1)", [NOW])
        .unwrap();
    let server = item_server(
        ID,
        json!([{"libraryId":"l","workId":"av-1","name":"AV av-1","entityRevision":3}]),
    );
    let mut request = request_new();
    request.new_collection_name = None;
    request.collection_id = Some("av-1".into());
    request.expected_revision = Some(library.get_av_cover_set("av-1").unwrap().revision);
    request.surfaces = Surfaces {
        front: SurfaceChoice::Keep,
        spine: SurfaceChoice::Candidate,
        back: SurfaceChoice::Clear,
    };
    request.fields = Fields {
        title_ja: Some("원제".into()),
        ..Default::default()
    };
    request.performers = vec![
        PersonChoice::Link {
            name_ja: "葵つかさ".into(),
            person_id: "p2".into(),
        },
        PersonChoice::New {
            name_ja: "女優B".into(),
            display_name: "여배우 B".into(),
        },
    ];
    request.directors = vec![PersonChoice::Link {
        name_ja: "苺原".into(),
        person_id: "p3".into(),
    }];
    library
        .apply_av_link_routed_with(&server, ID, request)
        .unwrap();
    // Only the spine is prepared; the manual front is kept, the manual back cleared.
    assert_eq!(
        server.bodies("/artwork"),
        vec![json!({"x1":378,"x2":422,"surfaces":["spine"]})]
    );
    let commands = provider_commands(&library);
    let kinds: Vec<&str> = commands
        .iter()
        .map(|c| c["commandType"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "addArtwork",
            "selectArtwork",
            "selectArtwork",
            "setAvDetails",
            "setAvCredits"
        ]
    );
    assert_eq!(commands[1]["slot"], "spine");
    assert!(commands[1]["expectedArtworkId"].is_null());
    assert_eq!(commands[2]["slot"], "back");
    assert!(commands[2]["artworkId"].is_null());
    assert_eq!(commands[2]["expectedArtworkId"], "manual-back");
    // The product code already matches: only the chosen field changes.
    assert_eq!(commands[3]["changes"], json!({"titleJa":"원제"}));
    // 3 + spine selection + back clear = 5; details 6.
    assert_eq!(commands[4]["expectedRevision"], 6);
    let credits = commands[4]["credits"].as_array().unwrap();
    assert_eq!(credits.len(), 4);
    assert_eq!(credits[0]["personId"], "p3");
    assert_eq!(credits[0]["role"], "director");
    assert_eq!(credits[1]["personId"], "p1");
    assert_eq!(credits[2]["personId"], "p2");
    assert_eq!(credits[2]["order"], 1);
    assert_eq!(credits[3]["order"], 2);
    // p2 is known to the authority, so it is only linked; the new performer is created and
    // the PC-only director travels once as a person record.
    let people = commands[4]["people"].as_array().unwrap();
    assert_eq!(people.len(), 2);
    assert_eq!(people[0]["displayName"], "여배우 B");
    assert_eq!(people[1]["personId"], "p3");
    assert_eq!(people[1]["displayName"], "로컬 감독");
    let authority = RefCell::new(Authority::new(vec![w]));
    flush(&library, &status, &authority, usize::MAX, 1_000_000);
    assert_eq!(
        authority.borrow().sent.len(),
        5,
        "model server accepted every expectation"
    );
    assert!(outbox(&library).iter().all(|(_, s)| s == "accepted"));
}

#[test]
fn apply_refuses_a_destination_with_another_product_code() {
    let w = av_work("av-x", 1, Some("ABW-100"));
    let (_temp, library, _) = routed(json!({"works":[w]}));
    let server = item_server(ID, json!([]));
    let mut request = request_new();
    request.new_collection_name = None;
    request.collection_id = Some("av-x".into());
    request.expected_revision = Some(library.get_av_cover_set("av-x").unwrap().revision);
    let error = library
        .apply_av_link_routed_with(&server, ID, request)
        .unwrap_err();
    assert!(matches!(error, AvError::Inbox("av_inbox_code_mismatch", _)));
    assert!(provider_commands(&library).is_empty());
    // The failed attempt leaves no progress behind.
    assert!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM notes_state WHERE key LIKE 'avInbox:apply:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
            == 0
    );
}

#[test]
fn apply_rejects_a_changed_destination_and_bad_choices_without_queueing() {
    let w = av_work("av-1", 1, Some("SSIS-001"));
    let (_temp, library, _) = routed(json!({"works":[w]}));
    let server = item_server(ID, json!([]));
    let mut stale = request_new();
    stale.new_collection_name = None;
    stale.collection_id = Some("av-1".into());
    stale.expected_revision = Some("old-revision".into());
    assert!(matches!(
        library.apply_av_link_routed_with(&server, ID, stale),
        Err(AvError::Stale)
    ));
    let mut unknown = request_new();
    unknown.performers = vec![PersonChoice::New {
        name_ja: "知らない人".into(),
        display_name: "x".into(),
    }];
    assert!(matches!(
        library.apply_av_link_routed_with(&server, ID, unknown),
        Err(AvError::Invalid)
    ));
    let mut link = request_new();
    link.performers = vec![PersonChoice::Link {
        name_ja: "葵つかさ".into(),
        person_id: "missing".into(),
    }];
    assert!(matches!(
        library.apply_av_link_routed_with(&server, ID, link),
        Err(AvError::Invalid)
    ));
    assert!(provider_commands(&library).is_empty());
}

#[test]
fn crash_mid_sequence_resumes_without_duplicates_and_retries_the_acknowledgement() {
    let (temp, library, status) = routed(json!({"works":[]}));
    let ack_failures = RefCell::new(2);
    let base = item_server(ID, json!([]));
    let server = Mock::new(move |method, path, body| {
        if path.ends_with("/applied") {
            let mut left = ack_failures.borrow_mut();
            if *left > 0 {
                *left -= 1;
                return coded(503, "providerUnavailable");
            }
        }
        (base.handler.borrow_mut())(method, path, body)
    });
    let work_id = library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap()
        .collection_id;
    let authority = RefCell::new(Authority::new(vec![]));
    // The process dies after three commands were accepted.
    flush(&library, &status, &authority, 3, 1_000_000);
    assert_eq!(authority.borrow().sent.len(), 3);
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    let status = collection_write_status(&library.connection().unwrap()).unwrap();
    // Nothing is acknowledged while commands are still outstanding.
    library.resume_av_inbox_applies(&server, 5_000).unwrap();
    assert!(server.bodies("/applied").is_empty());
    flush(&library, &status, &authority, usize::MAX, 2_000_000);
    assert_eq!(
        authority.borrow().sent.len(),
        9,
        "each command was delivered exactly once"
    );
    assert_eq!(outbox(&library).len(), 9);
    // The acknowledgement fails twice (transport), then succeeds: choices are never reapplied.
    library.resume_av_inbox_applies(&server, 5_000).unwrap();
    assert_eq!(server.bodies("/applied").len(), 1);
    library.resume_av_inbox_applies(&server, 5_001).unwrap();
    assert_eq!(
        server.bodies("/applied").len(),
        1,
        "backoff holds the retry"
    );
    library.resume_av_inbox_applies(&server, 5_100).unwrap();
    library.resume_av_inbox_applies(&server, 5_900).unwrap();
    assert_eq!(server.bodies("/applied").len(), 3);
    library.resume_av_inbox_applies(&server, 9_000).unwrap();
    assert_eq!(
        server.bodies("/applied").len(),
        3,
        "acknowledged once the server accepted"
    );
    assert_eq!(provider_commands(&library).len(), 9);
    assert_eq!(server.bodies("/artwork").len(), 1);
    let c = library.connection().unwrap();
    let state: String = c
        .query_row(
            "SELECT json_extract(value,'$.state') FROM notes_state WHERE key=?1",
            [format!("avInbox:apply:{ID}")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "done");
    let _ = work_id;
}

#[test]
fn crash_before_the_commands_were_queued_resumes_the_stored_plan() {
    let (temp, library, _) = routed(json!({"works":[]}));
    let server = item_server(ID, json!([]));
    // Simulate a crash after the plan was stored but before the commands were queued.
    let failing = Mock::new(|_, path, _| {
        if path.ends_with("/artwork") {
            coded(503, "providerUnavailable")
        } else {
            reply(200, detail(ID, json!([])))
        }
    });
    let chosen;
    {
        // Build the progress the way a user apply does, but stop at the artwork call.
        let error = library
            .apply_av_link_routed_with(&failing, ID, request_new())
            .unwrap_err();
        assert!(matches!(error, AvError::Inbox("av_inbox_unavailable", _)));
        assert!(provider_commands(&library).is_empty());
        // A user-visible failure leaves nothing behind...
        assert!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM notes_state WHERE key LIKE 'avInbox:apply:%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap()
                == 0
        );
        // ...while a stored `preparing` row (as left by a crash) is resumed by the tick.
        let request = request_new();
        let parsed = routed::parse_detail(&detail(ID, json!([]))).unwrap();
        let mut progress = library
            .build_progress_for_test(ID, &request, &parsed)
            .unwrap();
        routed_apply::write_progress(&library.connection().unwrap(), None, &mut progress).unwrap();
        chosen = Some(progress.plan.work_id.clone());
    }
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    library.resume_av_inbox_applies(&server, 1).unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands[0]["commandType"], "createWork");
    assert_eq!(commands[0]["workId"], chosen.clone().unwrap());
    // Resuming twice never duplicates the sequence.
    library.resume_av_inbox_applies(&server, 2).unwrap();
    assert_eq!(provider_commands(&library).len(), commands.len());
}
impl Library {
    fn build_progress_for_test(
        &self,
        id: &str,
        request: &ApplyRequest,
        parsed: &routed::ServerCandidate,
    ) -> Result<routed_apply::Progress, AvError> {
        self.build_progress(id, request, parsed, "SSIS-001", None)
    }
}

#[test]
fn a_conflict_stops_the_sequence_and_keeps_the_users_choices() {
    let (_temp, library, status) = routed(json!({"works":[]}));
    let server = item_server(ID, json!([]));
    let work_id = library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap()
        .collection_id;
    let authority = RefCell::new(Authority::new(vec![]));
    // Someone else changed the work between composition and delivery.
    authority.borrow_mut().refuse = Some((
        "setAvCredits".into(),
        CollectionDelivery::Conflict(json!({"code":"revisionConflict"})),
    ));
    flush(&library, &status, &authority, usize::MAX, 1_000_000);
    let states = outbox(&library);
    assert_eq!(states[7], ("setAvDetails".into(), "accepted".into()));
    assert_eq!(states[8], ("setAvCredits".into(), "blocked".into()));
    library.resume_av_inbox_applies(&server, 100).unwrap();
    // No acknowledgement, the choices stay stored, and the item shows as blocked.
    assert!(server.bodies("/applied").is_empty());
    let progress = routed_apply::read_progress(&library.connection().unwrap(), ID)
        .unwrap()
        .unwrap();
    assert_eq!(progress.state, "blocked");
    assert_eq!(progress.plan.work_id, work_id);
    assert_eq!(progress.plan.fields["titleJa"], "選択した原題");
    assert_eq!(progress.plan.credits.len(), 2);
    let list_server = Mock::new(|_, _, _| {
        reply(
            200,
            json!({"items":[summary(ID,"found","SSIS-001")],"nextBefore":null,"hasMore":false}),
        )
    });
    library.refresh_av_mirror_with(&list_server, 200).unwrap();
    let item = &library.list_av_link_inbox().unwrap()[0];
    assert_eq!(item.apply_state.as_deref(), Some("blocked"));
    assert_eq!(library.av_link_pending_count().unwrap(), 1);
    // A blocked apply cannot be applied again or discarded behind the queue's back.
    assert!(matches!(
        library.apply_av_link_routed_with(&server, ID, request_new()),
        Err(AvError::Inbox("av_inbox_applying", _))
    ));
    assert!(matches!(
        library.routed_dismiss(&server, ID),
        Err(AvError::Inbox("av_inbox_applying", _))
    ));
}

#[test]
fn a_refused_command_cancels_the_rest_and_allows_applying_again() {
    let (_temp, library, status) = routed(json!({"works":[]}));
    let server = item_server(ID, json!([]));
    library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap();
    let authority = RefCell::new(Authority::new(vec![]));
    authority.borrow_mut().refuse = Some((
        "addArtwork".into(),
        CollectionDelivery::Dropped(json!({"code":"artworkBlobUnconfirmed"})),
    ));
    flush(&library, &status, &authority, usize::MAX, 1_000_000);
    let states = outbox(&library);
    assert_eq!(states[0].1, "accepted");
    assert_eq!(states[1].1, "dropped");
    // The commands composed against the refused one never reach the server.
    assert!(states[2..].iter().all(|(_, s)| s == "dropped"));
    assert_eq!(authority.borrow().sent, ["createWork"]);
    library.resume_av_inbox_applies(&server, 100).unwrap();
    assert!(server.bodies("/applied").is_empty());
    let progress = routed_apply::read_progress(&library.connection().unwrap(), ID)
        .unwrap()
        .unwrap();
    assert_eq!(progress.state, "failed");
    // The user can look at the item again and apply with a fresh set of ids.
    let list_server = Mock::new(|_, _, _| {
        reply(
            200,
            json!({"items":[summary(ID,"found","SSIS-001")],"nextBefore":null,"hasMore":false}),
        )
    });
    library.refresh_av_mirror_with(&list_server, 200).unwrap();
    assert_eq!(
        library.list_av_link_inbox().unwrap()[0]
            .apply_state
            .as_deref(),
        Some("failed")
    );
    let before = provider_commands(&library).len();
    assert!(library
        .apply_av_link_routed_with(&server, ID, request_new())
        .is_ok());
    // The work the refused attempt created is continued, not duplicated.
    let again = provider_commands(&library);
    assert!(again[before..]
        .iter()
        .all(|c| c["commandType"] != "createWork"));
}

#[test]
fn the_acknowledgement_gives_up_when_the_server_never_sees_the_work() {
    let (_temp, library, status) = routed(json!({"works":[]}));
    let base = item_server(ID, json!([]));
    let server = Mock::new(move |method, path, body| {
        if path.ends_with("/applied") {
            return coded(409, "avInboxWorkMismatch");
        }
        (base.handler.borrow_mut())(method, path, body)
    });
    library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap();
    let authority = RefCell::new(Authority::new(vec![]));
    flush(&library, &status, &authority, usize::MAX, 1_000_000);
    let mut now = 1_000;
    for _ in 0..10 {
        library.resume_av_inbox_applies(&server, now).unwrap();
        now += 1_000;
    }
    let progress = routed_apply::read_progress(&library.connection().unwrap(), ID)
        .unwrap()
        .unwrap();
    assert_eq!(progress.state, "failed");
    assert_eq!(server.bodies("/applied").len() as i64, 6);
    // Applied elsewhere (for example the tablet): nothing is left to acknowledge.
    let (_t2, other, status2) = routed(json!({"works":[]}));
    let conflict = {
        let base = item_server(ID, json!([]));
        Mock::new(move |method, path, body| {
            if path.ends_with("/applied") {
                return coded(409, "avInboxStateConflict");
            }
            (base.handler.borrow_mut())(method, path, body)
        })
    };
    other
        .apply_av_link_routed_with(&conflict, ID, request_new())
        .unwrap();
    flush(
        &other,
        &status2,
        &RefCell::new(Authority::new(vec![])),
        usize::MAX,
        1_000_000,
    );
    other.resume_av_inbox_applies(&conflict, 10).unwrap();
    let state: String = other
        .connection()
        .unwrap()
        .query_row(
            "SELECT json_extract(value,'$.state') FROM notes_state WHERE key=?1",
            [format!("avInbox:apply:{ID}")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "done");
}

// ---- migration ------------------------------------------------------------------------

fn local_row(
    library: &Library,
    id: &str,
    request: &str,
    code: &str,
    status: &str,
    collection: Option<&str>,
) {
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO av_link_inbox(id,request_id,product_code,normalized_code,source_url,received_at,status,collection_id) VALUES(?1,?2,?3,?3,?4,'2026-10-01T00:00:00Z',?5,?6)",
            params![id, request, code, "https://fixture.invalid/p", status, collection],
        )
        .unwrap();
}

#[test]
fn migration_resends_unresolved_items_once_and_never_reapplies_old_choices() {
    let (_temp, library, _) = routed(json!({"works":[av_work("old-work", 1, Some("EEE-005"))]}));
    let on_server = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let missing = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let dismissed_open = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let applied_gone = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let applied_open = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    local_row(&library, "l1", on_server, "AAA-001", "found", None);
    local_row(&library, "l2", missing, "BBB-002", "not_found", None);
    local_row(&library, "l3", dismissed_open, "CCC-003", "dismissed", None);
    local_row(
        &library,
        "l4",
        applied_gone,
        "DDD-004",
        "applied",
        Some("old-work"),
    );
    local_row(
        &library,
        "l5",
        applied_open,
        "EEE-005",
        "applied",
        Some("old-work"),
    );
    let posted = RefCell::new(Vec::<Value>::new());
    let listing = json!({"items":[
        summary(on_server,"found","AAA-001"),
        summary(dismissed_open,"queued","CCC-003"),
        summary(applied_open,"found","EEE-005")],"nextBefore":null,"hasMore":false});
    let server = Mock::new(move |method, path, body| {
        if method == "POST" && path == "/v1/av-lookups" {
            posted.borrow_mut().push(body.unwrap().clone());
            return reply(
                200,
                json!({"requestId":body.unwrap()["requestId"],"sequence":9,"receivedAt":NOW}),
            );
        }
        if method == "POST" {
            return reply(
                200,
                json!({"inbox":summary(ID,"dismissed","X"),"candidate":null,"matches":[]}),
            );
        }
        reply(200, listing.clone())
    });
    let counts = library
        .migrate_local_av_inbox_with(&server, 5_000)
        .unwrap()
        .unwrap();
    assert_eq!(counts.on_server, 1);
    assert_eq!(counts.sent, 1);
    assert_eq!(counts.closed, 2);
    assert_eq!(counts.remaining, 0);
    let sends = server.bodies("/v1/av-lookups");
    assert_eq!(sends.len(), 1);
    // A migration id of its own, the code, the https source; the old id is not reused.
    assert_ne!(sends[0]["requestId"], missing);
    assert_eq!(sends[0]["productCode"], "BBB-002");
    assert_eq!(sends[0]["sourceUrl"], "https://fixture.invalid/p");
    // Locally discarded/applied items are closed on the server, never re-sent or reapplied.
    assert_eq!(server.bodies("/dismiss").len(), 1);
    let acknowledged = server.bodies("/applied");
    assert_eq!(acknowledged, vec![json!({"workId":"old-work"})]);
    assert!(provider_commands(&library).is_empty());
    // The run is recorded: nothing repeats, even with the server still missing the id.
    assert!(library
        .migrate_local_av_inbox_with(&server, 6_000)
        .unwrap()
        .is_none());
    assert_eq!(server.bodies("/v1/av-lookups").len(), 1);
}

#[test]
fn migration_interrupted_by_a_network_failure_reuses_the_same_request_id() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    let req = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    local_row(&library, "l1", req, "BBB-002", "error", None);
    let attempt = RefCell::new(0);
    let sent_ids = std::rc::Rc::new(RefCell::new(Vec::<String>::new()));
    let seen = sent_ids.clone();
    let server = Mock::new(move |method, path, body| {
        if method == "POST" && path == "/v1/av-lookups" {
            seen.borrow_mut()
                .push(body.unwrap()["requestId"].as_str().unwrap().to_owned());
            *attempt.borrow_mut() += 1;
            if *attempt.borrow() == 1 {
                return coded(503, "providerUnavailable");
            }
            return reply(200, json!({}));
        }
        reply(200, json!({"items":[],"nextBefore":null,"hasMore":false}))
    });
    assert!(library.migrate_local_av_inbox_with(&server, 5_000).is_err());
    // Too soon: waits out the retry delay.
    assert!(library
        .migrate_local_av_inbox_with(&server, 5_010)
        .unwrap()
        .is_none());
    let counts = library
        .migrate_local_av_inbox_with(&server, 5_100)
        .unwrap()
        .unwrap();
    assert_eq!(counts.sent, 1);
    let ids = sent_ids.borrow();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1]);
    assert_ne!(ids[0], req);
}

#[test]
fn migration_skips_when_the_server_listing_is_incomplete() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    local_row(
        &library,
        "l1",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "BBB-002",
        "found",
        None,
    );
    let server = Mock::new(|method, _, _| {
        assert_eq!(
            method, "GET",
            "nothing is sent while the list cannot be read"
        );
        coded(503, "providerUnavailable")
    });
    assert!(library.migrate_local_av_inbox_with(&server, 5_000).is_err());
}

// ---- jacket and errors ----------------------------------------------------------------

#[test]
fn the_jacket_is_read_from_the_server_and_checked() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(4, 4)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let bytes = png.into_inner();
    let reply_bytes = bytes.clone();
    let id = "99999999-9999-4999-8999-999999999999";
    let server = Mock::new(move |_, _, _| HttpResponse {
        status: 200,
        bytes: reply_bytes.clone(),
        content_type: Some("image/png".into()),
    });
    let (got, mime) = library.routed_jacket(&server, id).unwrap();
    assert_eq!((got, mime), (bytes.clone(), "image/png"));
    // A second read comes from the short-lived cache.
    library.routed_jacket(&server, id).unwrap();
    assert_eq!(server.calls.borrow().len(), 1);
    // A body that is not the declared image is refused.
    let wrong = "88888888-8888-4888-8888-888888888888";
    let lying = Mock::new(|_, _, _| HttpResponse {
        status: 200,
        bytes: b"<html>".to_vec(),
        content_type: Some("image/png".into()),
    });
    assert!(library.routed_jacket(&lying, wrong).is_err());
}

#[test]
fn server_refusals_become_user_messages() {
    assert!(matches!(
        super::routed::refusal(409, Some("avInboxStateConflict")),
        AvError::Stale
    ));
    assert!(matches!(
        super::routed::refusal(422, Some("invalidAvSplit")),
        AvError::Invalid
    ));
    assert!(matches!(
        super::routed::refusal(404, Some("avInboxNotFound")),
        AvError::Inbox("av_inbox_missing", _)
    ));
    assert!(matches!(
        super::routed::refusal(429, Some("providerBusy")),
        AvError::Inbox("av_inbox_busy", _)
    ));
    assert!(matches!(
        super::routed::refusal(502, None),
        AvError::Inbox("av_inbox_unavailable", _)
    ));
}

#[test]
fn resume_rechecks_progress_after_claim_and_rejects_stale_writes() {
    for existing in [false, true] {
        let entities = if existing {
            json!({"works":[av_work("av-1", 1, Some("SSIS-001"))]})
        } else {
            json!({"works":[]})
        };
        let (_temp, library, _) = routed(entities);
        let server = item_server(ID, json!([]));
        let mut request = request_new();
        if existing {
            request.new_collection_name = None;
            request.collection_id = Some("av-1".into());
            request.expected_revision = Some(library.get_av_cover_set("av-1").unwrap().revision);
        }
        let parsed = routed::parse_detail(&detail(ID, json!([]))).unwrap();
        let mut progress = library
            .build_progress_for_test(ID, &request, &parsed)
            .unwrap();
        routed_apply::write_progress(&library.connection().unwrap(), None, &mut progress).unwrap();
        // Tick takes its snapshot; user finishes queueing before the tick claims the lane.
        let snapshot = routed_apply::all_progress(&library.connection().unwrap()).unwrap();
        library
            .apply_av_link_routed_with(&server, ID, request)
            .unwrap();
        let queued = routed_apply::read_progress(&library.connection().unwrap(), ID)
            .unwrap()
            .unwrap();
        let count = provider_commands(&library).len();
        library.resume_av_inbox_rows(&server, 2, snapshot).unwrap();
        let current = routed_apply::read_progress(&library.connection().unwrap(), ID)
            .unwrap()
            .unwrap();
        assert_eq!(current.state, "queued");
        assert_eq!(current.operations, queued.operations);
        assert_eq!(provider_commands(&library).len(), count);
        assert_eq!(server.bodies("/artwork").len(), 1);
        let mut stale = progress.clone();
        stale.state = "failed".into();
        assert!(matches!(
            routed_apply::discard_progress(&library.connection().unwrap(), &progress),
            Err(AvError::Stale)
        ));
        assert!(matches!(
            routed_apply::write_progress(
                &library.connection().unwrap(),
                Some(&progress),
                &mut stale
            ),
            Err(AvError::Stale)
        ));
        assert!(matches!(
            routed_apply::write_progress(&library.connection().unwrap(), None, &mut stale),
            Err(AvError::Stale)
        ));
    }
}

#[test]
fn preparing_artwork_retries_back_off_per_row_and_survive_restart() {
    for status in [429, 503] {
        let (temp, library, _) = routed(json!({"works":[]}));
        let parsed = routed::parse_detail(&detail(ID, json!([]))).unwrap();
        let mut progress = library
            .build_progress_for_test(ID, &request_new(), &parsed)
            .unwrap();
        routed_apply::write_progress(&library.connection().unwrap(), None, &mut progress).unwrap();
        let server = Mock::new(move |_, path, _| {
            assert!(path.ends_with("/artwork"));
            coded(status, "providerUnavailable")
        });
        let mut now = 100;
        for delay in [15, 30, 60, 120, 240, 300, 300] {
            library.resume_av_inbox_applies(&server, now).unwrap();
            let row = routed_apply::read_progress(&library.connection().unwrap(), ID)
                .unwrap()
                .unwrap();
            assert_eq!(row.state, "preparing");
            assert_eq!(row.prepare_retry_at, now + delay);
            let calls = server.calls.borrow().len();
            library
                .resume_av_inbox_applies(&server, now + delay - 1)
                .unwrap();
            assert_eq!(server.calls.borrow().len(), calls);
            now += delay;
        }
        // Isolate apply scheduling from mirror/migration deadlines.
        let c = library.connection().unwrap();
        routed::set_note(&c, "avInbox:mirrorAt", &now.to_string()).unwrap();
        routed::set_note(&c, "avInbox:migrationRetry", &(now + 1000).to_string()).unwrap();
        assert_eq!(routed_apply::routed_due_at(&c, false).unwrap(), Some(now));
        drop(c);
        drop(library);
        let reopened = Library::open(temp.path()).unwrap();
        let calls = server.calls.borrow().len();
        reopened.resume_av_inbox_applies(&server, now - 1).unwrap();
        assert_eq!(server.calls.borrow().len(), calls);
        reopened
            .resume_av_inbox_applies(&item_server(ID, json!([])), now)
            .unwrap();
        assert_eq!(
            routed_apply::read_progress(&reopened.connection().unwrap(), ID)
                .unwrap()
                .unwrap()
                .state,
            "queued"
        );
    }
}

#[test]
fn applied_ack_404_stays_pending_until_the_server_accepts() {
    let (_temp, library, status) = routed(json!({"works":[]}));
    let server = item_server(ID, json!([]));
    library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap();
    let authority = RefCell::new(Authority::new(vec![]));
    flush(&library, &status, &authority, usize::MAX, 1_000_000);
    let missing = Mock::new(|_, path, _| {
        assert!(path.ends_with("/applied"));
        coded(404, "notFound")
    });
    library.resume_av_inbox_applies(&missing, 100).unwrap();
    let row = routed_apply::read_progress(&library.connection().unwrap(), ID)
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "acking");
    assert_eq!(row.ack_retry_at, 115);
    library.resume_av_inbox_applies(&missing, 114).unwrap();
    assert_eq!(missing.calls.borrow().len(), 1);
    library.resume_av_inbox_applies(&server, 115).unwrap();
    assert_eq!(
        routed_apply::read_progress(&library.connection().unwrap(), ID)
            .unwrap()
            .unwrap()
            .state,
        "done"
    );
    assert_eq!(server.bodies("/artwork").len(), 1);
}

#[test]
fn chooser_falls_back_to_pending_local_code_matches_without_picking_among_several() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    let server = item_server(ID, json!([]));
    let first = library
        .apply_av_link_routed_with(&server, ID, request_new())
        .unwrap()
        .collection_id;
    let candidate = library.routed_candidate(&server, ID, None).unwrap();
    assert_eq!(
        candidate.inbox.collection_id.as_deref(),
        Some(first.as_str())
    );
    assert_eq!(candidate.current.unwrap().name, "SSIS-001");
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";
    let mut request = request_new();
    request.new_collection_name = Some("Second local work".into());
    library
        .apply_av_link_routed_with(&item_server(SECOND, json!([])), SECOND, request)
        .unwrap();
    let candidate = library.routed_candidate(&server, ID, None).unwrap();
    assert!(candidate.inbox.collection_id.is_none());
    assert!(candidate.current.is_none());
    assert_eq!(candidate.matches.len(), 2);
    assert_eq!(candidate.inbox.matches.len(), 2);
}

#[test]
fn artwork_selections_expect_pending_inbox_choices_for_every_slot() {
    use crate::library::collection_authority::{
        enqueue_artwork_selection, enqueue_av_inbox_apply, AvInboxPlan, AvInboxSurfacePlan,
    };
    let mut w = av_work("av-1", 1, Some("SSIS-001"));
    let mut arts = vec![];
    for (slot, kind) in [("work", "cover"), ("spine", "spine"), ("back", "back")] {
        w["selection"][slot] = json!(format!("manual-{slot}"));
        arts.push(artwork(&format!("manual-{slot}"), "av-1", kind));
    }
    for ordinary in [false, true] {
        let (_temp, library, status) = routed(json!({"works":[w.clone()],"artworks":arts}));
        library
            .apply_av_link_routed_with(
                &item_server(ID, json!([])),
                ID,
                ApplyRequest {
                    collection_id: Some("av-1".into()),
                    new_collection_name: None,
                    expected_revision: Some(library.get_av_cover_set("av-1").unwrap().revision),
                    ..request_new()
                },
            )
            .unwrap();
        let before = provider_commands(&library);
        let mut c = library.connection().unwrap();
        let tx = c.transaction().unwrap();
        for (surface, slot, kind) in [
            ("front", "work", "cover"),
            ("spine", "spine", "spine"),
            ("back", "back", "back"),
        ] {
            let chosen = before
                .iter()
                .find(|b| b["commandType"] == "selectArtwork" && b["slot"] == slot)
                .unwrap()["artworkId"]
                .clone();
            let old = format!("manual-{slot}");
            // Old artwork is still displayed, but selecting it is no longer a no-op.
            let displayed: String = tx.query_row("SELECT id FROM collection_work_artworks WHERE collection_id='av-1' AND kind=?1 AND selected=1", [kind], |r| r.get(0)).unwrap();
            assert_eq!(displayed, old);
            if ordinary {
                enqueue_artwork_selection(&tx, &status, "av-1", kind, Some(&old)).unwrap();
                enqueue_artwork_selection(&tx, &status, "av-1", kind, Some(&old)).unwrap();
            // actual FIFO no-op
            } else {
                let plan = AvInboxPlan {
                    work_id: "av-1".into(),
                    is_new: false,
                    name: String::new(),
                    fields: json!({}),
                    credits: vec![],
                    surfaces: vec![AvInboxSurfacePlan {
                        surface: surface.into(),
                        action: "clear".into(),
                        artwork_id: None,
                        manifest: None,
                    }],
                };
                assert_eq!(
                    enqueue_av_inbox_apply(&tx, "second", &plan).unwrap().len(),
                    1
                );
                assert!(enqueue_av_inbox_apply(&tx, "third", &plan)
                    .unwrap()
                    .is_empty());
            }
            let raw: String = tx
                .query_row(
                    "SELECT payload FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let body: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(body["expectedArtworkId"], chosen);
            assert_eq!(
                body["artworkId"],
                if ordinary { json!(old) } else { Value::Null }
            );
        }
        tx.commit().unwrap();
        drop(c);
        let authority = RefCell::new(Authority::new(vec![w.clone()]));
        flush(&library, &status, &authority, usize::MAX, 1_000_000);
        assert!(outbox(&library)
            .iter()
            .all(|(_, state)| state == "accepted"));
    }
}

#[test]
fn migration_corrects_the_local_fixed_code_once_even_after_a_partial_run() {
    let (_temp, library, _) = routed(json!({"works":[]}));
    local_row(&library, "fixed", ID, "SSIS-001", "found", None);
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE av_link_inbox SET product_code='WRONG-001' WHERE id='fixed'",
            [],
        )
        .unwrap();
    local_row(
        &library,
        "missing",
        "22222222-2222-4222-8222-222222222222",
        "BBB-002",
        "error",
        None,
    );
    let server = Mock::new(|method, path, body| {
        if method == "GET" {
            return reply(
                200,
                json!({"items":[summary(ID,"found","WRONG-001")],"nextBefore":null,"hasMore":false}),
            );
        }
        if path.ends_with("/fix-code") {
            assert_eq!(body.unwrap(), &json!({"productCode":"SSIS-001"}));
            return reply(200, detail(ID, json!([])));
        }
        coded(503, "providerUnavailable")
    });
    assert!(library.migrate_local_av_inbox_with(&server, 100).is_err());
    assert!(library.migrate_local_av_inbox_with(&server, 200).is_err());
    assert_eq!(server.bodies("/fix-code").len(), 1);
}

#[test]
fn migration_never_puts_invalid_request_ids_in_action_urls() {
    let (_temp, library, _) = routed(json!({"works":[av_work("old-work", 1, Some("SSIS-001"))]}));
    let invalid = "bad/../target?query=1";
    local_row(
        &library,
        "applied",
        invalid,
        "SSIS-001",
        "applied",
        Some("old-work"),
    );
    local_row(
        &library,
        "dismissed",
        "not-a-uuid",
        "SSIS-001",
        "dismissed",
        None,
    );
    let server = Mock::new(move |method, _, _| {
        assert_eq!(method, "GET");
        reply(
            200,
            json!({"items":[summary(invalid,"found","SSIS-001"),summary("not-a-uuid","queued","SSIS-001")],"nextBefore":null,"hasMore":false}),
        )
    });
    for id in [invalid, "not-a-uuid"] {
        assert!(matches!(
            routed_migration::inbox_path(id),
            Err(AvError::Invalid)
        ));
    }
    assert!(matches!(
        library.migrate_local_av_inbox_with(&server, 100),
        Err(AvError::Invalid)
    ));
    assert!(server
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
}
