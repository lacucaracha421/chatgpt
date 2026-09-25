use super::*;
use crate::library::aladin::AladinItem;
use crate::library::aladin_flow::group_items;
use crate::library::collection_personal_edits::tests::configure;
use crate::library::mangadex::{parse_work_preview, MangaDexFetchedWork};
use serde_json::{json, Value};
use std::sync::Mutex;

const MANGA_ID: &str = "d1a9fdeb-f713-407f-960c-8326b586e6fd";

/// (url, If-None-Match, body) of each request the server saw.
type Seen = Vec<(String, Option<String>, String)>;

/// A local server answering each request with `handler(url, body)`; returns what it saw.
/// A reply status of 304 carries no body; an `etag:` prefix on the reply sets the ETag.
fn serve(
    count: usize,
    handler: impl Fn(&str, &str) -> (u16, String) + Send + 'static,
) -> (String, std::thread::JoinHandle<Seen>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..count {
            let mut request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .expect("request");
            let header = |request: &tiny_http::Request, name: &'static str| {
                request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv(name))
                    .map(|h| h.value.to_string())
            };
            assert_eq!(
                header(&request, "Authorization").as_deref(),
                Some("Bearer publisher")
            );
            let if_none_match = header(&request, "If-None-Match");
            let mut body = String::new();
            std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
            let url = request.url().to_string();
            let (status, reply) = handler(&url, &body);
            seen.push((url, if_none_match, body));
            let (etag, reply) = match reply.strip_prefix("etag:") {
                Some(rest) => {
                    let (etag, reply) = rest.split_once(' ').unwrap();
                    (Some(etag.to_owned()), reply.to_owned())
                }
                None => (None, reply),
            };
            let mut response = tiny_http::Response::from_string(reply).with_status_code(status);
            if let Some(etag) = etag {
                response.add_header(tiny_http::Header::from_bytes("ETag", etag).unwrap());
            }
            request.respond(response).unwrap();
        }
        seen
    });
    (base, handle)
}

fn request(
    id: i64,
    collection: &str,
    provider: &str,
    choice: Value,
    expected: Value,
    state: &str,
) -> Value {
    json!({"requestId":id,"operationId":format!("00000000-0000-4000-8000-{id:012}"),
        "collectionId":collection,"provider":provider,"choice":choice,"expected":expected,
        "state":state,"reason":null,"replaces":null,"createdAt":"2026-09-26T00:00:00Z",
        "updatedAt":"2026-09-26T00:00:00Z","resolvedAt":null})
}

fn page(after: i64, items: Vec<Value>, has_more: bool, last: i64, oldest: Option<i64>) -> String {
    let next = items
        .last()
        .map_or(after, |i| i["requestId"].as_i64().unwrap());
    json!({"version":1,"after":after,"lastSequence":last,"oldestPendingSequence":oldest,
        "logEpoch":"epoch-1","nextCursor":next,"hasMore":has_more,"items":items})
    .to_string()
}

fn recorded(body: &str) -> (u16, String) {
    let result: Value = serde_json::from_str(body).unwrap();
    (200, json!({"version":1,"request":result}).to_string())
}

fn mangadex_choice() -> Value {
    json!({"mangaId":MANGA_ID,"title":"던전밥","coverUrl":null})
}

fn kakao_items() -> Vec<AladinItem> {
    (1..=3)
        .map(|n| AladinItem {
            item_id: format!("k-{n}"),
            title: format!("던전밥 {n}권"),
            author: Some("쿠이 료코".into()),
            publisher: Some("소미미디어".into()),
            isbn13: None,
            publication_date: Some(format!("2024-0{n}-01")),
            item_url: None,
            volume_number: n,
            base_title: "던전밥".into(),
            snapshot_json: format!(r#"{{"itemId":"k-{n}"}}"#),
        })
        .collect()
}

fn kakao_choice(anchor: &str) -> Value {
    let group = &group_items(kakao_items())[0];
    json!({"query":"던전밥","anchorItemId":anchor,"groupFingerprint":group.group_fingerprint,
        "title":"던전밥"})
}

/// Applies with the PC apply code on fixtures instead of the network; queued errors are
/// returned first.
#[derive(Default)]
struct Fake {
    errors: Mutex<Vec<LibraryError>>,
    calls: Mutex<Vec<String>>,
}

impl Fake {
    fn failing(error: LibraryError) -> Self {
        Self {
            errors: Mutex::new(vec![error]),
            ..Self::default()
        }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn queued(&self, call: String) -> Result<(), LibraryError> {
        self.calls.lock().unwrap().push(call);
        match self.errors.lock().unwrap().pop() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl BindingApplier for Fake {
    fn mangadex(
        &self,
        library: &Library,
        request: MangaDexApplyRequest,
    ) -> Result<(), LibraryError> {
        self.queued(format!("mangadex:{}", request.manga_id))?;
        let mut preview = parse_work_preview(
            include_str!("fixtures/mangadex_detail.json"),
            include_str!("fixtures/mangadex_covers.json"),
        )
        .unwrap();
        preview
            .covers
            .retain(|cover| cover.language.as_deref() != Some("ja"));
        let fetched = MangaDexFetchedWork {
            preview,
            snapshot_json: "{}".into(),
        };
        library
            .apply_fetched_mangadex(request, fetched, None)
            .map(|_| ())
    }
    fn kakao(&self, library: &Library, request: AladinApplyRequest) -> Result<(), LibraryError> {
        let anchors: Vec<_> = request.groups.iter().map(|g| g.anchor_item_id.as_str()).collect();
        self.queued(format!("kakao:{}", anchors.join("+")))?;
        library
            .book_flow("kakao")
            .apply_requested_items(request, kakao_items())
            .map(|_| ())
    }
}

fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO collections(id,name,type,created_at,updated_at) VALUES
             ('m','던전밥','manga','2026','2026'),('g','Game','game','2026','2026');",
        )
        .unwrap();
    (temp, library)
}

fn binding(library: &Library, provider: &str) -> Option<String> {
    library
        .connection()
        .unwrap()
        .query_row(
            "SELECT external_id FROM collection_external_bindings WHERE collection_id='m' AND provider=?1",
            [provider],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
}

/// Allow the next pass now (the poll throttle is covered separately).
fn due(library: &Library, base: &str) {
    library
        .update_binding_sync_state(base, |s| {
            s.last_polled = 0;
            s.retry_after = 0;
        })
        .unwrap();
}

fn results(seen: &Seen) -> Vec<(String, Value)> {
    seen.iter()
        .filter(|(url, _, _)| url.ends_with("/result"))
        .map(|(url, _, body)| (url.clone(), serde_json::from_str(body).unwrap()))
        .collect()
}

#[test]
fn log_pages_advance_the_cursor_skip_resolved_rows_and_reuse_the_etag() {
    let (_temp, library) = fixture();
    let (base, handle) = serve(3, |url, _| match url {
        "/v1/collections/bindings/log?after=0&limit=50" => (
            200,
            page(
                0,
                vec![
                    request(
                        1,
                        "m",
                        "mangadex",
                        mangadex_choice(),
                        Value::Null,
                        "superseded",
                    ),
                    request(2, "m", "kakao", kakao_choice("k-1"), Value::Null, "applied"),
                ],
                true,
                3,
                None,
            ),
        ),
        "/v1/collections/bindings/log?after=2&limit=50" => (
            200,
            page(
                2,
                vec![request(
                    3,
                    "m",
                    "mangadex",
                    mangadex_choice(),
                    Value::Null,
                    "failed",
                )],
                false,
                3,
                None,
            ),
        ),
        "/v1/collections/bindings/log?after=3&limit=50" => (
            200,
            format!("etag:\"e1\" {}", page(3, vec![], false, 3, None)),
        ),
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let fake = Fake::default();
    library
        .sync_collection_bindings_with(&client, "publisher", &base, &fake)
        .unwrap();
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!(state.cursor, 3);
    assert_eq!(state.epoch.as_deref(), Some("\"epoch-1\""));
    // Throttled: no request within the poll interval (the endpoint is unreachable).
    let offline = CloudClient::new("http://127.0.0.1:9").unwrap();
    library
        .sync_collection_bindings_with(&offline, "publisher", &base, &fake)
        .unwrap();
    due(&library, &base);
    library
        .sync_collection_bindings_with(&client, "publisher", &base, &fake)
        .unwrap();
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!(
        (state.etag.as_deref(), state.etag_cursor),
        (Some("\"e1\""), 3)
    );
    // Superseded and resolved rows are never applied.
    assert!(fake.calls().is_empty());
    assert_eq!(handle.join().unwrap().len(), 3);
    // An unchanged log answers 304 to the stored tag.
    let (base2, handle2) = serve(1, |_, _| (304, String::new()));
    library
        .update_binding_sync_state(&base2, |s| *s = state.clone())
        .unwrap();
    due(&library, &base2);
    configure(&library, &base2);
    let client2 = CloudClient::new(&base2).unwrap();
    library
        .sync_collection_bindings_with(&client2, "publisher", &base2, &fake)
        .unwrap();
    let seen = handle2.join().unwrap();
    assert_eq!(seen[0].0, "/v1/collections/bindings/log?after=3&limit=50");
    assert_eq!(seen[0].1.as_deref(), Some("\"e1\""));
    assert_eq!(
        library
            .collection_binding_sync_state(&base2)
            .unwrap()
            .cursor,
        3
    );
}

#[test]
fn a_pending_mangadex_request_is_applied_with_the_pc_code_and_reported() {
    let (_temp, library) = fixture();
    let published: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT generation FROM mobile_publication_state WHERE kind='collections'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let (base, handle) = serve(2, |url, body| match url {
        "/v1/collections/bindings/log?after=0&limit=50" => (
            200,
            page(
                0,
                vec![request(
                    1,
                    "m",
                    "mangadex",
                    mangadex_choice(),
                    json!({"externalId":null}),
                    "pending",
                )],
                false,
                1,
                Some(1),
            ),
        ),
        "/v1/collections/bindings/requests/1/result" => recorded(body),
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let fake = Fake::default();
    library
        .sync_collection_bindings_with(&client, "publisher", &base, &fake)
        .unwrap();
    let seen = handle.join().unwrap();
    assert_eq!(fake.calls(), [format!("mangadex:{MANGA_ID}")]);
    assert_eq!(binding(&library, "mangadex").as_deref(), Some(MANGA_ID));
    // The blank 원제 took the MangaDex Japanese title.
    let original: Option<String> = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT original_title FROM collections WHERE id='m'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(original.as_deref(), Some("ダンジョン飯"));
    assert_eq!(
        results(&seen)[0].1,
        json!({"version":1,"state":"applied","reason":null})
    );
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!((state.cursor, state.failures, state.retry_after), (1, 0, 0));
    // The binding dirtied the Collections publication like the PC command does.
    let generation: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT generation FROM mobile_publication_state WHERE kind='collections'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(generation > published);
}

#[test]
fn a_kakao_request_binds_its_group_even_after_the_anchor_drifted() {
    let (_temp, library) = fixture();
    let group = group_items(kakao_items()).remove(0);
    let (base, handle) = serve(3, |url, body| match url {
        "/v1/collections/bindings/log?after=0&limit=50" => (
            200,
            page(
                0,
                vec![
                    // The tablet's anchor is no longer in the search; the fingerprint still is.
                    request(
                        1,
                        "m",
                        "kakao",
                        kakao_choice("gone"),
                        Value::Null,
                        "pending",
                    ),
                    // A different group (unknown fingerprint): ambiguous.
                    request(
                        2,
                        "g",
                        "kakao",
                        json!({"query":"던전밥","anchorItemId":"k-1",
                "groupFingerprint":"0".repeat(64),"title":"x"}),
                        Value::Null,
                        "pending",
                    ),
                ],
                false,
                2,
                Some(1),
            ),
        ),
        "/v1/collections/bindings/requests/1/result"
        | "/v1/collections/bindings/requests/2/result" => recorded(body),
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let fake = Fake::default();
    library
        .sync_collection_bindings_with(&client, "publisher", &base, &fake)
        .unwrap();
    let seen = handle.join().unwrap();
    assert_eq!(
        binding(&library, "kakao"),
        Some(group.anchor_item_id.clone())
    );
    let volumes: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM collection_volumes WHERE collection_id='m'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(volumes, 3);
    let results = results(&seen);
    assert_eq!(results[0].1["state"], "applied");
    // The game Collection is refused before any provider call.
    assert_eq!(results[1].1["state"], "failed");
    assert_eq!(results[1].1["reason"]["code"], "collectionNotManga");
    assert_eq!(fake.calls(), ["kakao:gone"]);
    // The strict PC apply still refuses an unknown fingerprint.
    let request = AladinApplyRequest {
        collection_id: "m".into(),
        query: "던전밥".into(),
        groups: vec![AladinGroupSelection {
            anchor_item_id: group.anchor_item_id.clone(),
            group_fingerprint: "0".repeat(64),
        }],
    };
    assert!(matches!(
        library
            .book_flow("kakao")
            .apply_requested_items(request, kakao_items()),
        Err(LibraryError::AmbiguousAladinBinding)
    ));
}

#[test]
fn a_changed_binding_fails_the_request_without_applying() {
    let (_temp, library) = fixture();
    library.connection().unwrap().execute(
        "INSERT INTO collection_external_bindings(collection_id,provider,external_id,created_at,updated_at)
         VALUES('m','mangadex','11111111-2222-4333-8444-555555555555','2026','2026')", []).unwrap();
    let (base, handle) = serve(2, |url, body| match url {
        "/v1/collections/bindings/log?after=0&limit=50" => (
            200,
            page(
                0,
                vec![request(
                    1,
                    "m",
                    "mangadex",
                    mangadex_choice(),
                    json!({"externalId":null}),
                    "pending",
                )],
                false,
                1,
                Some(1),
            ),
        ),
        "/v1/collections/bindings/requests/1/result" => recorded(body),
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    let fake = Fake::default();
    library
        .sync_collection_bindings_with(&CloudClient::new(&base).unwrap(), "publisher", &base, &fake)
        .unwrap();
    let result = &results(&handle.join().unwrap())[0].1;
    assert_eq!(result["state"], "failed");
    assert_eq!(result["reason"]["code"], "bindingChanged");
    assert!(result["reason"]["message"]
        .as_str()
        .unwrap()
        .contains("PC의 연결"));
    assert!(fake.calls().is_empty());
    assert_eq!(
        binding(&library, "mangadex").as_deref(),
        Some("11111111-2222-4333-8444-555555555555")
    );
}

#[test]
fn transient_failures_retry_later_and_permanent_ones_are_reported() {
    let (_temp, library) = fixture();
    let log = |url: &str, body: &str| match url {
        "/v1/collections/bindings/log?after=0&limit=50" => (
            200,
            page(
                0,
                vec![request(
                    1,
                    "m",
                    "kakao",
                    kakao_choice("k-1"),
                    Value::Null,
                    "pending",
                )],
                false,
                1,
                Some(1),
            ),
        ),
        "/v1/collections/bindings/requests/1/result" => recorded(body),
        other => panic!("unexpected {other}"),
    };
    // Network: nothing is reported, the cursor stays and the lane backs off.
    let (base, handle) = serve(1, log);
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let before = unix_now();
    let error = library
        .sync_collection_bindings_with(
            &client,
            "publisher",
            &base,
            &Fake::failing(LibraryError::AladinTimedOut),
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::AladinTimedOut));
    assert_eq!(handle.join().unwrap().len(), 1);
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!(
        (
            state.cursor,
            state.failures,
            state.stuck_request,
            state.stuck_attempts
        ),
        (0, 1, 1, 1)
    );
    assert!(state.retry_after >= before + 60);
    // Backing off: no request at all.
    let offline = CloudClient::new("http://127.0.0.1:9").unwrap();
    library
        .sync_collection_bindings_with(&offline, "publisher", &base, &Fake::default())
        .unwrap();
    // No Kakao key on the PC: reported failed with a Korean reason.
    let (base, handle) = serve(2, log);
    library
        .update_binding_sync_state(&base, |s| *s = state.clone())
        .unwrap();
    due(&library, &base);
    configure(&library, &base);
    library
        .sync_collection_bindings_with(
            &CloudClient::new(&base).unwrap(),
            "publisher",
            &base,
            &Fake::failing(LibraryError::AladinCredentialNotConfigured),
        )
        .unwrap();
    let result = &results(&handle.join().unwrap())[0].1;
    assert_eq!(result["reason"]["code"], "kakaoCredentialMissing");
    assert!(result["reason"]["message"]
        .as_str()
        .unwrap()
        .contains("카카오 API 키"));
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!(
        (state.cursor, state.failures, state.stuck_request),
        (1, 0, 0)
    );
    // A request that keeps failing transiently is eventually reported failed.
    let (base, handle) = serve(2, log);
    library
        .update_binding_sync_state(&base, |s| {
            s.stuck_request = 1;
            s.stuck_attempts = MAX_TRANSIENT_ATTEMPTS - 1;
        })
        .unwrap();
    configure(&library, &base);
    library
        .sync_collection_bindings_with(
            &CloudClient::new(&base).unwrap(),
            "publisher",
            &base,
            &Fake::failing(LibraryError::AladinUnavailable),
        )
        .unwrap();
    assert_eq!(
        results(&handle.join().unwrap())[0].1["reason"]["code"],
        "providerUnavailable"
    );
}

#[test]
fn classification_separates_transient_and_permanent_errors() {
    for error in [
        LibraryError::CloudRequestUnavailable,
        LibraryError::MangaDexRateLimited,
        LibraryError::AladinUnavailable,
        LibraryError::CredentialStoreLocked,
    ] {
        assert!(matches!(classify(error), Decision::Retry(_)));
    }
    for (error, code) in [
        (LibraryError::AmbiguousAladinBinding, "ambiguousGroup"),
        (LibraryError::InvalidCollectionType, "collectionNotManga"),
        (LibraryError::CollectionNotFound, "collectionNotFound"),
        (LibraryError::MangaDexNotFound, "mangadexNotFound"),
        (
            LibraryError::DuplicateProviderBinding,
            "alreadyBoundElsewhere",
        ),
        (
            LibraryError::InvalidAladinCredential,
            "kakaoCredentialRejected",
        ),
        (LibraryError::VideoToolUnavailable, "applyFailed"),
    ] {
        match classify(error) {
            Decision::Failed(reason) => {
                assert_eq!(reason.code, code);
                assert!(!reason.message.is_empty() && reason.message.chars().count() <= 500);
            }
            other => panic!("{code}: {other:?}"),
        }
    }
}

#[test]
fn a_lost_report_is_resent_without_applying_again() {
    let (_temp, library) = fixture();
    let replies = Mutex::new(vec![200, 500]);
    let (base, handle) = serve(4, move |url, body| match url {
        "/v1/collections/bindings/log?after=0&limit=50" => (
            200,
            page(
                0,
                vec![request(
                    1,
                    "m",
                    "mangadex",
                    mangadex_choice(),
                    json!({"externalId":null}),
                    "pending",
                )],
                false,
                1,
                Some(1),
            ),
        ),
        "/v1/collections/bindings/requests/1/result" => {
            let status = replies.lock().unwrap().pop().unwrap();
            if status == 200 {
                recorded(body)
            } else {
                (500, "{}".into())
            }
        }
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    let fake = Fake::default();
    assert!(library
        .sync_collection_bindings_with(&client, "publisher", &base, &fake)
        .is_err());
    assert_eq!(
        library.collection_binding_sync_state(&base).unwrap().cursor,
        0
    );
    due(&library, &base);
    // The PC already has the binding (which the stale `expected` would refuse): applied.
    library
        .sync_collection_bindings_with(&client, "publisher", &base, &fake)
        .unwrap();
    let seen = handle.join().unwrap();
    assert_eq!(fake.calls().len(), 1);
    let results = results(&seen);
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|(_, r)| r["state"] == "applied"));
    assert_eq!(
        library.collection_binding_sync_state(&base).unwrap().cursor,
        1
    );
}

#[test]
fn cursor_recovery_restart_rewind_and_older_servers() {
    let (_temp, library) = fixture();
    // A rejected cursor restarts from 0.
    let (base, handle) = serve(2, |url, _| {
        match url {
        "/v1/collections/bindings/log?after=9&limit=50" => (409, json!({"detail":{"code":"bindCursorRejected","message":"x","lastSequence":2,"logEpoch":"epoch-1"}}).to_string()),
        "/v1/collections/bindings/log?after=0&limit=50" => (200, page(0, vec![
            request(2, "m", "mangadex", mangadex_choice(), Value::Null, "applied"),
        ], false, 2, None)),
        other => panic!("unexpected {other}"),
    }
    });
    configure(&library, &base);
    library
        .update_binding_sync_state(&base, |s| {
            s.cursor = 9;
            s.epoch = Some("\"epoch-0\"".into());
        })
        .unwrap();
    library
        .sync_collection_bindings_with(
            &CloudClient::new(&base).unwrap(),
            "publisher",
            &base,
            &Fake::default(),
        )
        .unwrap();
    assert_eq!(handle.join().unwrap().len(), 2);
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!(
        (state.cursor, state.epoch.as_deref()),
        (2, Some("\"epoch-1\""))
    );
    // A cursor past a pending request rewinds to just before it; a pruned request
    // (404 bindRequestNotFound) is done.
    let (base, handle) = serve(3, |url, _| match url {
        "/v1/collections/bindings/log?after=5&limit=50" => {
            (200, page(5, vec![], false, 5, Some(2)))
        }
        "/v1/collections/bindings/log?after=1&limit=50" => (
            200,
            page(
                1,
                vec![request(
                    2,
                    "m",
                    "mangadex",
                    mangadex_choice(),
                    json!({"externalId":"other"}),
                    "pending",
                )],
                false,
                5,
                Some(2),
            ),
        ),
        "/v1/collections/bindings/requests/2/result" => (
            404,
            json!({"detail":{"code":"bindRequestNotFound","message":"x"}}).to_string(),
        ),
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    library
        .update_binding_sync_state(&base, |s| {
            s.cursor = 5;
            s.epoch = Some("\"epoch-1\"".into());
        })
        .unwrap();
    library
        .sync_collection_bindings_with(
            &CloudClient::new(&base).unwrap(),
            "publisher",
            &base,
            &Fake::default(),
        )
        .unwrap();
    handle.join().unwrap();
    assert_eq!(
        library.collection_binding_sync_state(&base).unwrap().cursor,
        2
    );
    // A new log epoch restarts from 0.
    let (base, handle) = serve(2, |url, _| match url {
        "/v1/collections/bindings/log?after=5&limit=50" => (200, page(5, vec![], false, 5, None)),
        "/v1/collections/bindings/log?after=0&limit=50" => (200, page(0, vec![], false, 5, None)),
        other => panic!("unexpected {other}"),
    });
    configure(&library, &base);
    library
        .update_binding_sync_state(&base, |s| {
            s.cursor = 5;
            s.epoch = Some("\"epoch-0\"".into());
        })
        .unwrap();
    library
        .sync_collection_bindings_with(
            &CloudClient::new(&base).unwrap(),
            "publisher",
            &base,
            &Fake::default(),
        )
        .unwrap();
    assert_eq!(handle.join().unwrap().len(), 2);
    let state = library.collection_binding_sync_state(&base).unwrap();
    assert_eq!(
        (state.cursor, state.epoch.as_deref()),
        (0, Some("\"epoch-1\""))
    );
    // An older server without the route: look again in an hour.
    let (base, handle) = serve(1, |_, _| (404, "{\"detail\":\"Not Found\"}".into()));
    configure(&library, &base);
    let now = unix_now();
    library
        .sync_collection_bindings_with(
            &CloudClient::new(&base).unwrap(),
            "publisher",
            &base,
            &Fake::default(),
        )
        .unwrap();
    handle.join().unwrap();
    assert!(
        library
            .collection_binding_sync_state(&base)
            .unwrap()
            .retry_after
            >= now + 3600
    );
}

/// Two Kakao groups of one search: vols 1-2 under one publisher, vol 3 under another.
fn split_kakao_items() -> Vec<AladinItem> {
    kakao_items()
        .into_iter()
        .map(|mut item| {
            if item.volume_number == 3 {
                item.publisher = Some("S코믹스".into());
            }
            item
        })
        .collect()
}

fn split_groups_choice() -> Value {
    let groups: Vec<Value> = group_items(split_kakao_items())
        .into_iter()
        .map(|g| json!({"anchorItemId":g.anchor_item_id,"groupFingerprint":g.group_fingerprint,
            "title":g.title,"firstVolume":g.volumes[0].volume_number}))
        .collect();
    json!({"query":"던전밥","groups":groups,"title":"던전밥","author":null,"publisher":null,
        "volumeCount":3,"thumbnailUrl":null})
}

fn bind_item(choice: Value) -> BindRequest {
    serde_json::from_value(request(1, "m", "kakao", choice, Value::Null, "pending")).unwrap()
}

#[test]
fn kakao_targets_read_groups_and_the_legacy_single_form() {
    let Ok(Target::Kakao(multi)) = target(&bind_item(split_groups_choice())) else {
        panic!("groups choice refused");
    };
    assert_eq!(multi.groups.len(), 2);
    let Ok(Target::Kakao(legacy)) = target(&bind_item(kakao_choice("k-1"))) else {
        panic!("legacy choice refused");
    };
    assert_eq!(legacy.groups.len(), 1);
    assert_eq!(legacy.groups[0].anchor_item_id, "k-1");
    let mut repeated = split_groups_choice();
    let first = repeated["groups"][0].clone();
    repeated["groups"][1] = first;
    let mut empty = split_groups_choice();
    empty["groups"] = json!([]);
    let mut eleven = split_groups_choice();
    eleven["groups"] = Value::Array(
        (0..11)
            .map(|n| json!({"anchorItemId":format!("a{n}"),"groupFingerprint":format!("{n:064x}")}))
            .collect(),
    );
    let mut bad_fingerprint = split_groups_choice();
    bad_fingerprint["groups"][0]["groupFingerprint"] = json!("X".repeat(64));
    for choice in [repeated, empty, eleven, bad_fingerprint] {
        assert!(target(&bind_item(choice)).is_err());
    }
}

#[test]
fn a_requested_multi_group_apply_resolves_each_group_and_merges() {
    let (_temp, library) = fixture();
    let Ok(Target::Kakao(mut request)) = target(&bind_item(split_groups_choice())) else {
        panic!("groups choice refused");
    };
    // The second group's anchor drifted since the tablet picked it.
    request.groups[1].anchor_item_id = "gone".into();
    library
        .book_flow("kakao")
        .apply_requested_items(request, split_kakao_items())
        .unwrap();
    let volumes: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM collection_volume_sources WHERE collection_id='m' AND provider='kakao'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(volumes, 3);
    assert_eq!(binding(&library, "kakao").as_deref(), Some("k-1"));
    // Re-reading the same request (a crash before reporting) counts as applied; a request
    // for only one of the groups does not.
    let item = bind_item(split_groups_choice());
    let target_now = target(&item).unwrap();
    assert!(matches!(
        library.binding_precheck(&item, &target_now).unwrap(),
        Some(Decision::Applied)
    ));
    let mut single = split_groups_choice();
    single["groups"].as_array_mut().unwrap().truncate(1);
    let item = bind_item(single);
    let target_now = target(&item).unwrap();
    assert!(library.binding_precheck(&item, &target_now).unwrap().is_none());
}
