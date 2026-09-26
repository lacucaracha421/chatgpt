//! The shared-status hub, the lane due rule, the watcher state machine, the watcher loop
//! against a long-poll fake server, and the idle-request model behind the design gates
//! (`docs/research/perf-all-longpoll-design-20260926.md` §6, desktop).
use super::*;
use crate::cloud::client::{CapturesHead, ReleaseReadsHead};
use serde_json::{json, Value};
use std::sync::{Condvar, Mutex};

/// A status document with only `publisherLogs` of interest (no active domain).
pub(crate) fn status_with(logs: Option<PublisherLogs>) -> SyncStatus {
    SyncStatus {
        protocol_version: 1,
        active: false,
        library_id: None,
        domains: Vec::new(),
        publisher_logs: logs,
    }
}

pub(crate) fn logs(bindings_last: i64, captures_pending: i64) -> PublisherLogs {
    PublisherLogs {
        character_exclusions: Some(3),
        character_review_decisions: Some(4),
        similarity_decisions: Some(5),
        catalog_duplicate_decisions: Some(6),
        release_reads: Some(ReleaseReadsHead {
            last: 7,
            pruned_through: 2,
        }),
        bindings: Some(BindingsHead {
            log_epoch: Some("epoch-1".into()),
            last: bindings_last,
            oldest_pending: None,
        }),
        personal_edits: Some(9),
        captures: Some(CapturesHead {
            pending: captures_pending,
            latest: Some(11),
        }),
    }
}

fn seq(value: i64) -> Head {
    Head::Sequence(value)
}

#[test]
fn the_due_rule_reads_a_moved_log_once_and_otherwise_waits_for_the_safety_interval() {
    let now = 10_000;
    let at = |cursor| LogPosition::cursor(Some(cursor));
    // Never checked: due.
    assert!(decide(Some(&seq(5)), at(5), None, None, now));
    // Head equals cursor: only the 30-minute safety interval.
    assert!(!decide(Some(&seq(5)), at(5), Some(now - 61), None, now));
    assert!(!decide(
        Some(&seq(5)),
        at(5),
        Some(now - SAFETY_INTERVAL + 1),
        None,
        now
    ));
    assert!(decide(
        Some(&seq(5)),
        at(5),
        Some(now - SAFETY_INTERVAL),
        None,
        now
    ));
    // Head moved: due at once, even one second after the last check...
    assert!(decide(
        Some(&seq(6)),
        at(5),
        Some(now - 1),
        Some(&seq(5)),
        now
    ));
    // ...but a head already acted on (the lane could not catch up) waits for the old minute.
    assert!(!decide(
        Some(&seq(6)),
        at(5),
        Some(now - 59),
        Some(&seq(6)),
        now
    ));
    assert!(decide(
        Some(&seq(6)),
        at(5),
        Some(now - 60),
        Some(&seq(6)),
        now
    ));
    // A cursor ahead of the head is a restarted log: read it.
    assert!(decide(Some(&seq(2)), at(5), Some(now - 1), None, now));
    // No trusted head, or a lane that has not adopted the log: the legacy minute.
    assert!(!decide(None, at(5), Some(now - 59), None, now));
    assert!(decide(None, at(5), Some(now - 60), None, now));
    assert!(!decide(
        Some(&seq(5)),
        LogPosition::cursor(None),
        Some(now - 59),
        None,
        now
    ));
    assert!(decide(
        Some(&seq(5)),
        LogPosition::cursor(None),
        Some(now - 60),
        None,
        now
    ));
    // A check time in the future is a backoff.
    assert!(!decide(Some(&seq(9)), at(5), Some(now + 3600), None, now));
}

#[test]
fn read_log_and_binding_heads_compare_their_own_fields() {
    let reads = Head::Reads {
        last: 7,
        pruned_through: 2,
    };
    assert!(!reads.moved(LogPosition::cursor(Some(7))));
    assert!(reads.moved(LogPosition::cursor(Some(6))));
    let pruned = Head::Reads {
        last: 7,
        pruned_through: 7,
    };
    assert!(!pruned.moved(LogPosition::cursor(Some(7))));
    assert!(Head::Reads {
        last: 3,
        pruned_through: 3
    }
    .moved(LogPosition::cursor(Some(1))));
    let bindings = |epoch: &str, last, oldest| {
        Head::Bindings(BindingsHead {
            log_epoch: Some(epoch.into()),
            last,
            oldest_pending: oldest,
        })
    };
    let at = |cursor, epoch| LogPosition {
        cursor: Some(cursor),
        epoch,
    };
    assert!(!bindings("e1", 5, None).moved(at(5, Some("e1"))));
    // The first read records the epoch; a head before that is not a replacement.
    assert!(!bindings("e1", 5, None).moved(at(5, None)));
    assert!(bindings("e2", 5, None).moved(at(5, Some("e1"))));
    assert!(bindings("e1", 6, None).moved(at(5, Some("e1"))));
    // A pending request at or behind the cursor must be re-read.
    assert!(bindings("e1", 5, Some(4)).moved(at(5, Some("e1"))));
    assert!(!bindings("e1", 5, Some(6)).moved(at(5, Some("e1"))));
}

#[test]
fn log_due_uses_the_hub_head_and_remembers_the_head_it_acted_on() {
    let endpoint = "http://log-due.hub.test/";
    let now = unix_now();
    let position = LogPosition {
        cursor: Some(5),
        epoch: Some("epoch-1"),
    };
    // No document yet: the legacy minute.
    assert!(!log_due(
        endpoint,
        LogKind::Bindings,
        position,
        Some(now - 10),
        now
    ));
    observe(endpoint, &status_with(Some(logs(5, 0))), now, Source::Pass);
    assert!(!log_due(
        endpoint,
        LogKind::Bindings,
        position,
        Some(now - 120),
        now
    ));
    // A tablet filed request 6: due at once, then not again for the same head.
    observe(
        endpoint,
        &status_with(Some(logs(6, 0))),
        now,
        Source::Watcher,
    );
    assert!(log_due(
        endpoint,
        LogKind::Bindings,
        position,
        Some(now - 1),
        now
    ));
    assert!(!log_due(
        endpoint,
        LogKind::Bindings,
        position,
        Some(now),
        now + 30
    ));
    assert!(log_due(
        endpoint,
        LogKind::Bindings,
        position,
        Some(now),
        now + 60
    ));
    // Other lanes are unaffected by one lane's memo.
    assert!(!log_due(
        endpoint,
        LogKind::ReleaseReads,
        LogPosition::cursor(Some(7)),
        Some(now - 120),
        now
    ));
    // A document the server has not confirmed for three minutes vouches for nothing: the
    // lane is back on the legacy minute instead of the safety interval.
    let stale = now + TRUST_WINDOW + 1;
    let reads = LogPosition::cursor(Some(7));
    assert!(!log_due(
        endpoint,
        LogKind::ReleaseReads,
        reads,
        Some(stale - 30),
        stale
    ));
    assert!(log_due(
        endpoint,
        LogKind::ReleaseReads,
        reads,
        Some(stale - 81),
        stale
    ));
    // A lane without a durable check time uses the hub's own record.
    let dup = LogPosition::cursor(Some(6));
    assert!(log_due(
        endpoint,
        LogKind::CatalogDuplicateDecisions,
        dup,
        None,
        now
    ));
    assert!(!log_due(
        endpoint,
        LogKind::CatalogDuplicateDecisions,
        dup,
        None,
        now + 61
    ));
}

#[test]
fn observed_changes_are_split_by_what_moved() {
    let endpoint = "http://observe.hub.test/";
    let now = unix_now();
    let first = observe(endpoint, &status_with(Some(logs(5, 0))), now, Source::Pass);
    assert_eq!(
        first,
        Changes {
            domains: true,
            logs: true,
            captures: true
        }
    );
    let same = observe(endpoint, &status_with(Some(logs(5, 0))), now, Source::Pass);
    assert_eq!(same, Changes::default());
    let bind = observe(endpoint, &status_with(Some(logs(6, 0))), now, Source::Pass);
    assert_eq!(
        bind,
        Changes {
            logs: true,
            ..Changes::default()
        }
    );
    let capture = observe(endpoint, &status_with(Some(logs(6, 1))), now, Source::Pass);
    assert_eq!(
        capture,
        Changes {
            captures: true,
            ..Changes::default()
        }
    );
    let mut active = status_with(Some(logs(6, 1)));
    active.active = true;
    active.library_id = Some("a1b2c3d4e5f60718293a4b5c6d7e8f90".into());
    active.domains = vec![crate::cloud::client::SyncAuthorityDomain {
        domain: "albums".into(),
        library_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90".into(),
        epoch: 1,
        contract_version: 1,
        cursor: 3,
    }];
    assert_eq!(
        observe(endpoint, &active, now, Source::Pass),
        Changes {
            domains: true,
            ..Changes::default()
        }
    );
}

#[test]
fn a_live_watcher_serves_its_document_and_quiet_captures() {
    let endpoint = "http://live.hub.test/";
    let now = unix_now();
    observe(
        endpoint,
        &status_with(Some(logs(5, 0))),
        now,
        Source::Watcher,
    );
    assert!(live_status(endpoint, now).is_none());
    assert!(!captures_quiet(endpoint, now));
    set_live(endpoint, 7, true);
    assert_eq!(
        live_status(endpoint, now),
        Some(status_with(Some(logs(5, 0))))
    );
    assert!(captures_quiet(endpoint, now));
    observe(
        endpoint,
        &status_with(Some(logs(5, 2))),
        now,
        Source::Watcher,
    );
    assert!(!captures_quiet(endpoint, now));
    // Unconfirmed for too long: not served.
    assert!(live_status(endpoint, now + TRUST_WINDOW + 1).is_none());
    // Only the owner clears its liveness.
    set_live(endpoint, 8, false);
    assert!(is_live(endpoint));
    set_live(endpoint, 7, false);
    assert!(!is_live(endpoint));
}

#[test]
fn publisher_logs_parse_leniently_head_by_head() {
    let full = json!({"characterExclusions":3,"characterReviewDecisions":4,"similarityDecisions":5,
        "catalogDuplicateDecisions":6,"releaseReads":{"last":7,"prunedThrough":2},
        "bindings":{"logEpoch":"epoch-1","last":8,"oldestPending":null},"personalEdits":9,
        "captures":{"pending":0,"latest":11},"futureLog":{"x":1}});
    assert_eq!(PublisherLogs::parse(&full), Some(logs(8, 0)));
    // A malformed head is absent; the others stay usable.
    let partial = json!({"characterExclusions":"3","releaseReads":{"last":7},
        "bindings":{"logEpoch":5,"last":8},"personalEdits":-1,"captures":{"pending":2,"latest":null},
        "similarityDecisions":5});
    let parsed = PublisherLogs::parse(&partial).unwrap();
    assert_eq!(parsed.character_exclusions, None);
    assert_eq!(parsed.release_reads, None);
    assert_eq!(parsed.bindings, None);
    assert_eq!(parsed.personal_edits, None);
    assert_eq!(parsed.similarity_decisions, Some(5));
    assert_eq!(
        parsed.captures,
        Some(CapturesHead {
            pending: 2,
            latest: None
        })
    );
    assert_eq!(PublisherLogs::parse(&json!("nope")), None);
    assert_eq!(PublisherLogs::parse(&Value::Null), None);
}

/// Serve `bodies` in order, one request each, and return the client's view of each.
fn read_documents(bodies: Vec<Value>) -> Vec<Result<SyncStatus, LibraryError>> {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let count = bodies.len();
    let worker = std::thread::spawn(move || {
        for body in bodies {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .expect("request");
            request
                .respond(tiny_http::Response::from_string(body.to_string()))
                .unwrap();
        }
    });
    let client = CloudClient::new(&base).unwrap();
    let results = (0..count).map(|_| client.sync_status("token")).collect();
    worker.join().unwrap();
    results
}

#[test]
fn a_malformed_publisher_block_never_makes_the_status_unreadable() {
    let lib = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    let domain =
        json!({"domain":"albums","libraryId":lib,"epoch":1,"contractVersion":1,"cursor":2});
    let results = read_documents(vec![
        json!({"protocolVersion":1,"active":true,"libraryId":lib,"domains":[domain.clone()],
            "publisherLogs":"garbage"}),
        json!({"protocolVersion":1,"active":true,"libraryId":lib,"domains":[domain.clone()],
            "publisherLogs":{"bindings":{"last":"x"},"personalEdits":4},"signals":{"x":1}}),
        json!({"protocolVersion":1,"active":true,"libraryId":lib,"domains":[domain.clone()]}),
        // The domain validation and the restore guard are unchanged by the new block.
        json!({"protocolVersion":1,"active":false,"libraryId":lib,"domains":[domain],
            "publisherLogs":{"personalEdits":4}}),
    ]);
    let status = results[0].as_ref().unwrap();
    assert_eq!(status.publisher_logs, None);
    assert_eq!(status.domains.len(), 1);
    let partial = results[1].as_ref().unwrap().publisher_logs.clone().unwrap();
    assert_eq!((partial.bindings, partial.personal_edits), (None, Some(4)));
    assert_eq!(results[2].as_ref().unwrap().publisher_logs, None);
    assert!(matches!(
        results[3],
        Err(LibraryError::RestoreAuthorityUnknown)
    ));
}

#[test]
fn the_watcher_goes_live_on_the_header_and_backs_off_on_failures() {
    let mut state = WatchState::new();
    assert_eq!(
        (state.mode(), state.live(), state.wait()),
        (Mode::Probing, false, 50)
    );
    // First answer (no tag yet): live, re-issue after the change spacing.
    assert_eq!(
        state.next(
            Outcome::Changed {
                advertised: Some(50)
            },
            0.0
        ),
        CHANGE_SPACING
    );
    assert!(state.live());
    // A held 304: re-issue within the jitter bound.
    let held = Outcome::NotModified {
        advertised: Some(50),
        held: Duration::from_secs(50),
    };
    assert!(state.next(held, 0.99) <= REISSUE_JITTER);
    // Failures: 5, 15, 60 s (+ up to half again as jitter), then recovery.
    let fail = Outcome::Failed { slept: false };
    let delays: Vec<u64> = (0..4).map(|_| state.next(fail, 0.0).as_secs()).collect();
    assert_eq!(delays, vec![5, 15, 60, 60]);
    assert!(state.next(fail, 1.0) <= Duration::from_secs(90));
    assert!(!state.live());
    assert!(state.next(held, 0.0) <= REISSUE_JITTER);
    assert!(state.live());
    // A request that ran across a laptop sleep is retried promptly and is not a failure.
    assert_eq!(
        state.next(Outcome::Failed { slept: true }, 0.0),
        CHANGE_SPACING
    );
    assert!(state.live());
    // The server's own smaller maximum is honoured.
    state.next(
        Outcome::NotModified {
            advertised: Some(20),
            held: Duration::from_secs(20),
        },
        0.0,
    );
    assert_eq!(state.wait(), 20);
}

#[test]
fn a_server_without_the_header_leaves_the_watcher_dormant() {
    let mut state = WatchState::new();
    assert_eq!(
        state.next(Outcome::Changed { advertised: None }, 0.0),
        REPROBE
    );
    assert_eq!((state.mode(), state.live()), (Mode::Dormant, false));
    // A later probe that finds the header (the server was upgraded) goes live.
    state.next(
        Outcome::Changed {
            advertised: Some(50),
        },
        0.0,
    );
    assert!(state.live());
    // Losing it again (a rollback) goes dormant.
    let delay = state.next(
        Outcome::NotModified {
            advertised: None,
            held: Duration::ZERO,
        },
        0.0,
    );
    assert_eq!((delay, state.live()), (REPROBE, false));
}

#[test]
fn unheld_not_modified_answers_back_off_instead_of_looping() {
    let mut state = WatchState::new();
    state.next(
        Outcome::Changed {
            advertised: Some(50),
        },
        0.0,
    );
    let unheld = Outcome::NotModified {
        advertised: Some(50),
        held: Duration::from_millis(30),
    };
    let delays: Vec<u64> = (0..4).map(|_| state.next(unheld, 0.0).as_secs()).collect();
    assert_eq!(delays, vec![5, 15, 60, 60]);
    // A held answer ends the guard.
    let held = Outcome::NotModified {
        advertised: Some(50),
        held: Duration::from_secs(49),
    };
    assert!(state.next(held, 0.0) < Duration::from_secs(1));
    assert_eq!(state.next(unheld, 0.0).as_secs(), 5);
}

// --- A long-poll fake server --------------------------------------------------------------

/// How the fake answers `/v1/sync/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Serve {
    /// Holds a matching conditional request until the document changes or the wait ends.
    LongPoll,
    /// An older server: answers at once, without `Lakomics-Status-Wait`.
    NoHeader,
    /// Advertises the header but answers a matching request at once (over its waiter cap).
    Unheld,
}

#[derive(Debug, Clone)]
pub(crate) struct Doc {
    pub bindings_last: i64,
    pub captures_pending: i64,
    pub refuse_publisher: bool,
    generation: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct SeenRequest {
    pub path: String,
    pub query: String,
    pub auth: String,
    pub conditional: bool,
}

/// A fake Cloud API for the watcher: `/v1/sync/status` with long-poll semantics like
/// `sync_status.py` (publisher-only `publisherLogs`, per-variant ETag, 304 at the deadline),
/// plus the bindings request log. Each request is answered on its own thread.
pub(crate) struct LongPollServer {
    pub base: String,
    state: Arc<(Mutex<Doc>, Condvar)>,
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

fn render(doc: &Doc, publisher: bool) -> (String, String) {
    let mut body = json!({"protocolVersion":1,"active":false,"libraryId":null,"domains":[]});
    if publisher {
        body["publisherLogs"] = json!({"characterExclusions":0,"characterReviewDecisions":0,
            "similarityDecisions":0,"catalogDuplicateDecisions":0,
            "releaseReads":{"last":0,"prunedThrough":0},
            "bindings":{"logEpoch":"epoch-1","last":doc.bindings_last,"oldestPending":null},
            "personalEdits":0,"captures":{"pending":doc.captures_pending,"latest":null}});
    }
    let text = body.to_string();
    let etag = format!("\"{}\"", &credential_digest(&text)[..16]);
    (text, etag)
}

impl LongPollServer {
    pub(crate) fn start(serve: Serve, advertised: u64) -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", server.server_addr());
        let state = Arc::new((
            Mutex::new(Doc {
                bindings_last: 5,
                captures_pending: 0,
                refuse_publisher: false,
                generation: 0,
            }),
            Condvar::new(),
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, log, halt) = (state.clone(), seen.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !halt.load(Ordering::Acquire) {
                let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(20)) else {
                    continue;
                };
                let (shared, log, halt) = (shared.clone(), log.clone(), halt.clone());
                std::thread::spawn(move || {
                    answer(request, serve, advertised, &shared, &log, &halt)
                });
            }
        });
        Self {
            base,
            state,
            seen,
            stop,
            worker: Some(worker),
        }
    }

    /// Change the document and release held requests, like a write bumping the signal.
    pub(crate) fn change(&self, edit: impl FnOnce(&mut Doc)) {
        let (lock, changed) = &*self.state;
        let mut doc = lock.lock().unwrap();
        edit(&mut doc);
        doc.generation += 1;
        changed.notify_all();
    }

    pub(crate) fn seen(&self) -> Vec<SeenRequest> {
        self.seen.lock().unwrap().clone()
    }

    pub(crate) fn status_requests(&self) -> Vec<SeenRequest> {
        self.seen()
            .into_iter()
            .filter(|seen| seen.path == "/v1/sync/status")
            .collect()
    }
}

impl Drop for LongPollServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.state.1.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn answer(
    request: tiny_http::Request,
    serve: Serve,
    advertised: u64,
    state: &(Mutex<Doc>, Condvar),
    log: &Mutex<Vec<SeenRequest>>,
    halt: &AtomicBool,
) {
    let header = |name: &'static str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_owned())
    };
    let url = request.url().to_owned();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let (path, query) = (path.to_owned(), query.to_owned());
    let auth = header("Authorization").unwrap_or_default();
    let tag = header("If-None-Match");
    log.lock().unwrap().push(SeenRequest {
        path: path.clone(),
        query: query.clone(),
        auth: auth.clone(),
        conditional: tag.is_some(),
    });
    let with =
        |response: tiny_http::Response<std::io::Cursor<Vec<u8>>>, name: &str, value: &str| {
            response.with_header(tiny_http::Header::from_bytes(name, value).unwrap())
        };
    if path == "/v1/collections/bindings/log" {
        let last = state.0.lock().unwrap().bindings_last;
        let after: i64 = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("after="))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let items: Vec<Value> = ((after + 1)..=last)
            .map(|id| {
                json!({"requestId":id,"collectionId":"c","provider":"mangadex",
                "choice":{},"expected":null,"state":"applied"})
            })
            .collect();
        let body = json!({"version":1,"after":after,"lastSequence":last,"oldestPendingSequence":null,
            "logEpoch":"epoch-1","nextCursor":last.max(after),"hasMore":false,"items":items});
        let _ = request.respond(tiny_http::Response::from_string(body.to_string()));
        return;
    }
    if path != "/v1/sync/status" {
        let _ = request.respond(tiny_http::Response::from_string("{}").with_status_code(404));
        return;
    }
    let publisher = auth == "Bearer publisher";
    let (lock, changed) = state;
    let mut doc = lock.lock().unwrap();
    if publisher && doc.refuse_publisher {
        drop(doc);
        let _ = request.respond(tiny_http::Response::from_string("{}").with_status_code(401));
        return;
    }
    let (mut body, mut etag) = render(&doc, publisher);
    let wait: f64 = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("wait="))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0.0);
    if serve == Serve::LongPoll && wait > 0.0 && tag.as_deref() == Some(etag.as_str()) {
        let deadline = Instant::now() + Duration::from_secs_f64(wait.min(advertised as f64));
        let generation = doc.generation;
        while doc.generation == generation && !halt.load(Ordering::Acquire) {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            doc = changed.wait_timeout(doc, deadline - now).unwrap().0;
        }
        (body, etag) = render(&doc, publisher);
    }
    drop(doc);
    let mut response = if tag.as_deref() == Some(etag.as_str()) {
        tiny_http::Response::from_data(Vec::new()).with_status_code(304)
    } else {
        tiny_http::Response::from_data(body.into_bytes())
    };
    response = with(response, "ETag", &etag);
    if serve != Serve::NoHeader {
        response = with(response, "Lakomics-Status-Wait", &advertised.to_string());
    }
    let _ = request.respond(response);
}

/// Run the real watcher loop on its own thread. Dropping it stops the watcher the way the
/// supervisor does: not live at once, the thread ends after its held request returns.
pub(crate) struct RunningWatcher {
    endpoint: String,
    owner: u64,
    stop: Arc<AtomicBool>,
}

impl RunningWatcher {
    pub(crate) fn start(endpoint: &str, owner: u64) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_stop, thread_endpoint) = (stop.clone(), endpoint.to_owned());
        std::thread::spawn(move || {
            watch(&thread_endpoint, owner, &thread_stop, &|| Tokens {
                client: Some("client".into()),
                publisher: Some("publisher".into()),
            })
        });
        Self {
            endpoint: endpoint.to_owned(),
            owner,
            stop,
        }
    }
}

impl Drop for RunningWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        set_live(&self.endpoint, self.owner, false);
    }
}

/// Poll `condition` every 20 ms for up to `limit`.
pub(crate) fn eventually(limit: Duration, condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

#[test]
fn the_watcher_holds_requests_and_delivers_a_change_at_once() {
    let server = LongPollServer::start(Serve::LongPoll, 50);
    let endpoint = server.base.clone();
    let watcher = RunningWatcher::start(&endpoint, 101);
    assert!(eventually(Duration::from_secs(5), || is_live(&endpoint)));
    // The second request is the held one; nothing else is sent while it is held.
    assert!(eventually(Duration::from_secs(3), || server
        .status_requests()
        .len()
        == 2));
    std::thread::sleep(Duration::from_millis(500));
    let seen = server.status_requests();
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert!(seen
        .iter()
        .all(|s| s.auth == "Bearer publisher" && s.query == "wait=50"));
    assert!(seen[1].conditional);
    let changed = Instant::now();
    server.change(|doc| doc.bindings_last = 6);
    let position = LogPosition {
        cursor: Some(5),
        epoch: Some("epoch-1"),
    };
    assert!(eventually(Duration::from_secs(2), || {
        hub()
            .get(&endpoint_key(&endpoint))
            .and_then(|entry| entry.status.as_ref()?.publisher_logs.clone())
            .and_then(|logs| logs.bindings)
            .is_some_and(|head| head.last == 6)
    }));
    assert!(changed.elapsed() < Duration::from_secs(1));
    assert!(log_due(
        &endpoint,
        LogKind::Bindings,
        position,
        Some(unix_now()),
        unix_now()
    ));
    drop(watcher);
    assert!(!is_live(&endpoint));
}

#[test]
fn the_watcher_stays_dormant_against_a_server_without_long_poll() {
    let server = LongPollServer::start(Serve::NoHeader, 50);
    let endpoint = server.base.clone();
    let watcher = RunningWatcher::start(&endpoint, 102);
    assert!(eventually(Duration::from_secs(3), || server
        .status_requests()
        .len()
        == 1));
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(server.status_requests().len(), 1);
    assert!(!is_live(&endpoint));
    // Its document still feeds the hub (the pass would read it anyway).
    assert!(hub()
        .get(&endpoint_key(&endpoint))
        .is_some_and(|entry| entry.status.is_some()));
    drop(watcher);
}

#[test]
fn an_unheld_server_does_not_drive_the_watcher_into_a_hot_loop() {
    let server = LongPollServer::start(Serve::Unheld, 50);
    let endpoint = server.base.clone();
    let watcher = RunningWatcher::start(&endpoint, 103);
    assert!(eventually(Duration::from_secs(3), || server
        .status_requests()
        .len()
        == 2));
    // The next request waits for the 5 s guard.
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(server.status_requests().len(), 2);
    drop(watcher);
}

#[test]
fn a_refused_publisher_credential_falls_back_to_the_client_credential() {
    let server = LongPollServer::start(Serve::LongPoll, 50);
    server.change(|doc| doc.refuse_publisher = true);
    let endpoint = server.base.clone();
    let watcher = RunningWatcher::start(&endpoint, 104);
    assert!(eventually(Duration::from_secs(5), || is_live(&endpoint)));
    assert!(eventually(Duration::from_secs(3), || server
        .status_requests()
        .len()
        == 3));
    let auths: Vec<String> = server
        .status_requests()
        .into_iter()
        .map(|s| s.auth)
        .collect();
    assert_eq!(
        auths,
        vec!["Bearer publisher", "Bearer client", "Bearer client"]
    );
    // The client variant carries no publisher logs: the lanes keep their own cadence.
    assert!(hub()
        .get(&endpoint_key(&endpoint))
        .and_then(|entry| entry.status.clone())
        .is_some_and(|status| status.publisher_logs.is_none()));
    drop(watcher);
}

// --- The idle-request model (design §6, desktop G1 / G2) ------------------------------------

/// Requests in `window` of idle time from the watcher against a server that holds every
/// request for the full wait and never changes, after it is live.
fn idle_watcher_requests(window: Duration, jitter: f64) -> usize {
    let mut state = WatchState::new();
    state.next(
        Outcome::Changed {
            advertised: Some(MAX_WAIT),
        },
        jitter,
    );
    let mut elapsed = Duration::ZERO;
    let mut requests = 0;
    while elapsed < window {
        requests += 1;
        let held = Duration::from_secs(state.wait());
        elapsed += held;
        elapsed += state.next(
            Outcome::NotModified {
                advertised: Some(MAX_WAIT),
                held,
            },
            jitter,
        );
    }
    requests
}

#[test]
fn gate_g1_idle_quarter_hour_stays_within_the_request_budget() {
    let window = Duration::from_secs(15 * 60);
    // The watcher: one held request per ~50 s.
    let watcher = (0..=10)
        .map(|step| idle_watcher_requests(window, f64::from(step) / 10.0))
        .max()
        .unwrap();
    assert!(watcher <= 19, "{watcher}");
    // The authority pass while the watcher is live: its idle delay is five minutes and it
    // reads the watcher's document (no request; `authority_pass` tests prove the zero).
    let mut schedule = crate::library::authority_pass::AuthoritySchedule::new(Instant::now());
    let start = Instant::now();
    let mut passes = 0;
    let mut now = start;
    while now < start + window {
        schedule.begin();
        passes += 1;
        now += schedule.finished(false, false, true, now);
    }
    assert!(passes <= 3, "{passes}");
    // Every publication lane on its 10 s tick with heads equal to cursors, last checked a
    // minute before the window: no log read in the window.
    let head = seq(5);
    let t0 = 1_000_000;
    let mut log_reads = 0;
    for tick in (0..900).step_by(10) {
        for _lane in 0..7 {
            if decide(
                Some(&head),
                LogPosition::cursor(Some(5)),
                Some(t0 - 60),
                None,
                t0 + tick,
            ) {
                log_reads += 1;
            }
        }
    }
    assert_eq!(log_reads, 0);
    // Captures: one safety poll at most (`useCloudCaptureSync` QUIET_FALLBACK_MS = 15 min,
    // vitest-gated); notes sync while open: at most 3 (unchanged, not a poller here).
    let captures = 1;
    let notes = 3;
    let total = watcher + captures + notes;
    assert!(total <= 25, "{total}");
    // With an exchange token: its receiver holds its own status read (`exchange` tests).
    let exchange = crate::exchange::idle_status_requests(window, false);
    assert!(exchange <= 19, "{exchange}");
    assert!(total + exchange <= 45, "{}", total + exchange);
}

#[test]
fn gate_g2_bind_pickup_against_a_server_without_long_poll_is_within_61_seconds() {
    // The watcher is dormant; the pass reads the status every 60 s at most (idle backoff)
    // and a moved head raises the publication wake, which the 1 s owner loop honours.
    let mut schedule = crate::library::authority_pass::AuthoritySchedule::new(Instant::now());
    let t0 = Instant::now();
    let mut now = t0;
    let mut worst = Duration::ZERO;
    let mut passes = Vec::new();
    while now < t0 + Duration::from_secs(900) {
        schedule.begin();
        passes.push(now);
        now += schedule.finished(false, false, false, now);
    }
    for pair in passes.windows(2) {
        // A request filed just after a pass is seen by the next one, then dispatched on the
        // next loop tick (≤ 1 s) and read at once by the lane (`decide`, moved head).
        let pickup = pair[1] - pair[0] + Duration::from_secs(1);
        worst = worst.max(pickup);
    }
    assert!(decide(
        Some(&seq(6)),
        LogPosition::cursor(Some(5)),
        Some(1_000),
        Some(&seq(5)),
        1_001
    ));
    assert!(worst <= Duration::from_secs(61), "{worst:?}");
}

/// Design gate G1, lane side: with the shared heads equal to every lane's cursor, no lane
/// reads its log (the client points at an unreachable endpoint, so any request would fail),
/// and a moved head makes exactly that lane due at once.
#[test]
fn gate_g1_idle_lanes_read_no_log_while_the_heads_match() {
    use crate::library::collection_personal_edits::tests::configure;
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    // Unique and unreachable: port 9 (discard) refuses connections on the test host.
    let endpoint = "http://127.0.0.1:9/gate-g1/";
    configure(&library, endpoint);
    let lib = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    let now = unix_now();
    {
        let db = library.connection().unwrap();
        for (table, cursor) in [
            ("mobile_character_exclusion_sync", 3),
            ("mobile_character_review_sync", 4),
            ("mobile_similarity_review_sync", 5),
            ("mobile_collection_personal_edit_sync", 9),
        ] {
            db.execute(
                &format!("INSERT INTO {table}(endpoint,library_id,received_cursor,updated_at) VALUES(?1,?2,?3,'now')"),
                rusqlite::params![endpoint, lib, cursor],
            )
            .unwrap();
        }
        for table in [
            "mobile_character_exclusion_poll",
            "mobile_character_review_poll",
            "mobile_similarity_review_poll",
            "mobile_collection_personal_edit_poll",
        ] {
            db.execute(
                &format!("INSERT INTO {table}(endpoint,last_checked) VALUES(?1,?2)"),
                rusqlite::params![endpoint, now - 120],
            )
            .unwrap();
        }
        let (_, fingerprint) = crate::library::collection_release_sync::unread_set(&db).unwrap();
        db.execute(
            "INSERT INTO notes_state(key,value) VALUES(?1,?2)",
            rusqlite::params![
                format!("collectionReleaseSync:{endpoint}"),
                json!({"readCursor":7,"uploaded":fingerprint,"uploadedAt":now,"generation":1,
                    "retryAfter":0,"lastPolled":now - 120,"fullUpload":false})
                .to_string()
            ],
        )
        .unwrap();
    }
    observe(endpoint, &status_with(Some(logs(5, 0))), now, Source::Pass);
    let dead = CloudClient::new(endpoint).unwrap();
    // Idle: nothing is due and nothing is sent.
    library.run_due_character_exclusions(endpoint).unwrap();
    assert!(!library.claim_character_review_poll(endpoint).unwrap());
    assert!(!library.claim_similarity_review_poll(endpoint).unwrap());
    assert!(!library
        .claim_collection_personal_edit_poll(endpoint)
        .unwrap());
    library
        .sync_collection_releases_with(&dead, "publisher", endpoint)
        .unwrap();
    let checked: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT last_checked FROM mobile_character_exclusion_poll WHERE endpoint=?1",
            [endpoint],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checked, now - 120);
    // A tablet review decision moves only its head: that lane is due at once, the others not.
    let mut moved = logs(5, 0);
    moved.character_review_decisions = Some(5);
    moved.release_reads = Some(ReleaseReadsHead {
        last: 8,
        pruned_through: 2,
    });
    observe(
        endpoint,
        &status_with(Some(moved)),
        unix_now(),
        Source::Watcher,
    );
    assert!(library.claim_character_review_poll(endpoint).unwrap());
    assert!(!library.claim_character_review_poll(endpoint).unwrap());
    assert!(!library.claim_similarity_review_poll(endpoint).unwrap());
    assert!(!library
        .claim_collection_personal_edit_poll(endpoint)
        .unwrap());
    // The read log moved too: its lane now reads (and fails against the dead endpoint).
    assert!(library
        .sync_collection_releases_with(&dead, "publisher", endpoint)
        .is_err());
}

#[test]
fn review_regression_slow_pass_cannot_replace_newer_watcher_document() {
    let endpoint = "http://slow-pass.review.test/";
    let now = unix_now();
    let older = status_with(Some(logs(5, 0)));
    let newer = status_with(Some(logs(6, 1)));
    let revision = status_revision(endpoint);
    // Pass A is in flight when the watcher receives B.
    observe(endpoint, &newer, now, Source::Watcher);
    set_live(endpoint, 99, true);
    assert_eq!(observe_pass(endpoint, &older, now + 1, revision), newer);
    assert_eq!(live_status(endpoint, now + 1), Some(newer));
}

#[test]
fn review_regression_304_confirms_only_its_own_document() {
    let endpoint = "http://confirm.review.test/";
    let now = unix_now();
    let newer = status_with(Some(logs(6, 1)));
    let document = WatchDocument {
        scope: "publisher".into(), etag: "B".into(), status: newer.clone(),
    };
    observe(endpoint, &newer, now, Source::Watcher);
    set_live(endpoint, 100, true);
    // Even if another producer changed the hub, a 304 for B never confirms A.
    observe(endpoint, &status_with(Some(logs(5, 0))), now + 1, Source::Pass);
    for elapsed in (50..=350).step_by(50) {
        document.confirm(endpoint, now + elapsed);
    }
    assert_eq!(live_status(endpoint, now + 350), Some(newer));
    assert!(!captures_quiet(endpoint, now + 350));
}

#[test]
fn an_uncontested_pass_still_updates_the_hub() {
    let endpoint = "http://uncontested-pass.review.test/";
    let now = unix_now();
    let older = status_with(Some(logs(5, 0)));
    let newer = status_with(Some(logs(6, 1)));
    observe_pass(endpoint, &older, now, status_revision(endpoint));
    let revision = status_revision(endpoint);
    assert_eq!(observe_pass(endpoint, &newer, now + 1, revision), newer);
    assert_eq!(hub().get(&endpoint_key(endpoint)).unwrap().status, Some(newer));
}
