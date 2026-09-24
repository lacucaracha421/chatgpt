//! B6 regression coverage: the PC send half of bookmark reconciliation.
//!
//! The durable queue, the mutation/enqueue boundary and the confirmation
//! transaction are exercised against a real library database. The send pass runs
//! against a real HTTP server, so it executes its production code path end to end,
//! including the B5 refresh on a revision conflict. A scripted stub rather than a
//! fake transport is used deliberately: a transport double in process could hide
//! the very ordering and lost-response behavior these tests exist to pin down.
//!
//! `Library::connection()` takes the library's database mutex, so a test must
//! never call another accessor while it holds a connection guard. Each assertion
//! block reads every value it needs from one connection.

use rusqlite::Connection;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tiny_http::{Header, Response, Server};

use crate::cloud::client::CloudClient;
use crate::library::catalog_provider::CatalogWorkIdentity;
use crate::library::error::LibraryError;
use crate::library::Library;

use super::bookmark_outbox::outbox_for_test;

/// A library identity that is deliberately not this PC's, for the mismatch test.
const OTHER_LIBRARY: &str = "0f9e8d7c6b5a4938271605f4e3d2c1b0";

// --- fixtures ---

fn open() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

/// The identity of the opened library, which is what a matching authority must
/// advertise.
fn local_id(library: &Library) -> String {
    library.library_id().unwrap()
}

/// Adopt an authority so local mutations start queueing, returning the library
/// identity the authority must advertise. Every stub in this file advertises the
/// real identity unless the test is specifically about a mismatch: the send path
/// fences on it exactly as the receive path does.
fn adopt(library: &Library, epoch: i64, cursor: i64) -> String {
    let library_id = local_id(library);
    library
        .adopt_bookmark_baseline_for_test(&library_id, epoch, 1, cursor, &[])
        .unwrap();
    library_id
}

fn bookmark(library: &Library, work_id: u64, bookmarked: bool) {
    library
        .set_online_catalog_bookmark(&CatalogWorkIdentity::khentai(work_id), bookmarked)
        .unwrap();
}

/// A snapshot row, as the receive half deserializes it.
fn item(
    provider: &str,
    work_id: &str,
    desired: bool,
    revision: i64,
) -> crate::cloud::client::MobileCatalogBookmarkItem {
    crate::cloud::client::MobileCatalogBookmarkItem {
        provider: provider.to_owned(),
        work_id: work_id.to_owned(),
        desired_state: desired,
        entity_revision: revision,
        created_at: Some("2026-09-01T00:00:00Z".to_owned()),
    }
}

/// A change-log row, as the receive half deserializes it.
fn change(
    sequence: i64,
    provider: &str,
    work_id: &str,
    desired: bool,
    revision: i64,
) -> crate::cloud::client::MobileCatalogChange {
    crate::cloud::client::MobileCatalogChange {
        sequence,
        provider: provider.to_owned(),
        work_id: work_id.to_owned(),
        desired_state: desired,
        entity_revision: revision,
        created_at: Some("2026-09-01T00:00:00Z".to_owned()),
    }
}

// --- local state readers ---

fn queued(connection: &Connection) -> Vec<(String, String, bool, i64, i64)> {
    outbox_for_test(connection)
        .into_iter()
        .map(|entry| {
            (
                entry.provider,
                entry.work_id,
                entry.desired_state,
                entry.epoch,
                entry.base_revision,
            )
        })
        .collect()
}

fn operation_ids(connection: &Connection) -> Vec<String> {
    outbox_for_test(connection)
        .into_iter()
        .map(|entry| entry.operation_id)
        .collect()
}

fn only_operation(connection: &Connection) -> String {
    let mut ids = operation_ids(connection);
    assert_eq!(ids.len(), 1, "exactly one queued operation");
    ids.remove(0)
}

fn only_queued(connection: &Connection) -> (String, String, bool, i64, i64) {
    let mut rows = queued(connection);
    assert_eq!(rows.len(), 1, "exactly one queued intent");
    rows.remove(0)
}

fn is_bookmarked(connection: &Connection, provider: &str, work_id: &str) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM online_catalog_bookmarks WHERE provider=?1 AND work_id=?2)",
            [provider, work_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn cached_revision(connection: &Connection, work_id: &str) -> Option<i64> {
    connection
        .query_row(
            "SELECT revision FROM catalog_bookmark_revisions WHERE provider='kHentai' AND work_id=?1",
            [work_id],
            |row| row.get(0),
        )
        .ok()
}

fn clear_outbox(connection: &Connection) {
    connection
        .execute("DELETE FROM catalog_bookmark_outbox", [])
        .unwrap();
}

/// A real catalog plus one unregistered manga series, so the recovery mutation
/// actually creates a bookmark.
fn recovery_fixture(library: &Library) {
    let catalogs = library.root().join("catalogs");
    std::fs::create_dir_all(&catalogs).unwrap();
    let catalog = Connection::open(catalogs.join("kdata.db")).unwrap();
    catalog
        .execute_batch(
            "CREATE TABLE Works (
                 Id INTEGER PRIMARY KEY, Title TEXT NOT NULL DEFAULT '', TitleJpn TEXT,
                 FileCount INTEGER NOT NULL DEFAULT 0, Expunged INTEGER NOT NULL DEFAULT 0,
                 ParentGid INTEGER, CurrentGid INTEGER, FirstGid INTEGER);
             CREATE TABLE Tags (
                 WorkId INTEGER NOT NULL, Namespace TEXT NOT NULL, Value TEXT NOT NULL,
                 PRIMARY KEY (WorkId, Namespace, Value)) WITHOUT ROWID;
             INSERT INTO Works (Id, Title, TitleJpn, FileCount, Expunged) VALUES
                 (10, 'Active A', 'Active A JP', 20, 0),
                 (12, 'Active B', NULL, 22, 0);",
        )
        .unwrap();
    drop(catalog);
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO manga_series
                (id, relative_path, title, author, gallery_id, page_count,
                 thumbnail_relative_path, scanned_at, modified_at)
             VALUES ('m-active-a', 'path-a', 'Title A', 'artist', '10', 20,
                     'thumb.webp', 'now', 'now')",
            [],
        )
        .unwrap();
}

// --- stub server ---

/// How the stub answers one bookmark command.
enum Answer {
    /// Accept with this recorded result body.
    Accept(serde_json::Value),
    /// Reject as a stale revision with this `current` detail payload.
    Conflict {
        cursor: i64,
        desired: bool,
        revision: i64,
    },
    /// Reject with this HTTP status and no body.
    Status(u16),
}

/// One observed command attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SentCommand {
    path: String,
    epoch: i64,
    expected_revision: i64,
    operation_id: String,
}

#[derive(Default)]
struct Seen {
    requests: Vec<String>,
    commands: Vec<SentCommand>,
}

/// A stub authority. Reads are answered from the configured values; commands are
/// answered in script order.
struct Stub {
    base: String,
    seen: Arc<Mutex<Seen>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Stub {
    fn new(
        status: serde_json::Value,
        snapshot: serde_json::Value,
        changes: serde_json::Value,
        commands: Vec<Answer>,
    ) -> Self {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Seen::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let log = Arc::clone(&seen);
        let halt = Arc::clone(&stop);
        let mut pending = VecDeque::from(commands);
        let handle = thread::spawn(move || {
            while !halt.load(Ordering::Relaxed) {
                let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(25)) else {
                    continue;
                };
                let path = request.url().to_owned();
                log.lock().unwrap().requests.push(path.clone());
                if path.ends_with("/status") {
                    request.respond(json_response(status.clone())).unwrap();
                } else if path.contains("/bookmarks/changes") {
                    request.respond(json_response(changes.clone())).unwrap();
                } else if path.contains("/bookmarks?") {
                    request.respond(json_response(snapshot.clone())).unwrap();
                } else {
                    let body: serde_json::Value =
                        serde_json::from_reader(request.as_reader()).unwrap();
                    log.lock().unwrap().commands.push(SentCommand {
                        path,
                        epoch: body["epoch"].as_i64().unwrap_or(-1),
                        expected_revision: body["expectedRevision"].as_i64().unwrap_or(-1),
                        operation_id: body["operationId"].as_str().unwrap_or_default().to_owned(),
                    });
                    match pending
                        .pop_front()
                        .expect("no scripted command was expected")
                    {
                        Answer::Accept(result) => request.respond(json_response(result)).unwrap(),
                        Answer::Conflict {
                            cursor,
                            desired,
                            revision,
                        } => request
                            .respond(json_status(
                                revision_conflict(cursor, desired, revision),
                                409,
                            ))
                            .unwrap(),
                        Answer::Status(code) => request.respond(Response::empty(code)).unwrap(),
                    }
                }
            }
        });
        Self {
            base,
            seen,
            stop,
            handle: Some(handle),
        }
    }

    fn client(&self) -> CloudClient {
        CloudClient::new(&self.base).unwrap()
    }

    /// Stop the stub and return everything it observed.
    fn finish(mut self) -> Seen {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
        let seen = self.seen.lock().unwrap();
        Seen {
            requests: seen.requests.clone(),
            commands: seen.commands.clone(),
        }
    }
}

impl Seen {
    fn command_paths(&self) -> Vec<String> {
        self.commands
            .iter()
            .map(|command| command.path.clone())
            .collect()
    }

    fn operation_ids(&self) -> Vec<String> {
        self.commands
            .iter()
            .map(|command| command.operation_id.clone())
            .collect()
    }

    fn revisions(&self) -> Vec<i64> {
        self.commands
            .iter()
            .map(|command| command.expected_revision)
            .collect()
    }

    fn read_paths(&self) -> Vec<String> {
        self.requests
            .iter()
            .filter(|path| !path.contains("/bookmarks/kHentai/"))
            .cloned()
            .collect()
    }
}

fn json_response(value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(&value).unwrap())
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

fn json_status(value: serde_json::Value, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(value).with_status_code(status)
}

fn status_body(library_id: &str, epoch: i64, cursor: i64, write: bool) -> serde_json::Value {
    serde_json::json!({
        "authorityLibraryId": library_id,
        "authorityEpoch": epoch,
        "authorityContractVersion": 1,
        "authorityCursor": cursor,
        "capabilities": {"providers": ["kHentai"], "read": true, "bookmarkWrite": write}
    })
}

fn revision_conflict(cursor: i64, desired: bool, revision: i64) -> serde_json::Value {
    serde_json::json!({
        "detail": {
            "code": "revisionConflict",
            "authorityCursor": cursor,
            "current": {
                "provider": "kHentai", "workId": "7", "desiredState": desired,
                "entityRevision": revision,
                "createdAt": if desired { Some("2026-09-01T00:00:00Z") } else { None },
                "updatedAt": "2026-09-02T00:00:00Z"
            }
        }
    })
}

fn snapshot_body(
    library_id: &str,
    epoch: i64,
    cursor: i64,
    items: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "libraryId": library_id, "epoch": epoch, "contractVersion": 1,
        "cursor": cursor, "items": items
    })
}

fn empty_changes(library_id: &str, epoch: i64, cursor: i64) -> serde_json::Value {
    serde_json::json!({
        "libraryId": library_id, "epoch": epoch, "contractVersion": 1,
        "cursor": cursor, "items": [], "nextAfter": cursor, "hasMore": false
    })
}

fn command_result(
    library_id: &str,
    epoch: i64,
    work_id: &str,
    desired: bool,
    revision: i64,
    changed: bool,
) -> serde_json::Value {
    serde_json::json!({
        "libraryId": library_id, "epoch": epoch, "contractVersion": 1,
        "provider": "kHentai", "workId": work_id, "desiredState": desired,
        "entityRevision": revision, "changed": changed,
        "changeSequence": if changed { Some(revision) } else { None },
        "authorityCursor": revision,
        "createdAt": if desired { Some("2026-09-15T00:00:00Z") } else { None },
        "updatedAt": "2026-09-15T00:00:00Z"
    })
}

/// A stub that offers no authority at all, answering only `/status`.
fn status_only_stub(status: serde_json::Value) -> Stub {
    Stub::new(
        status,
        serde_json::Value::Null,
        serde_json::Value::Null,
        Vec::new(),
    )
}

// --- 1/2/3. local mutation entry points, and atomicity with the queue ---

#[test]
fn a_local_add_enqueues_exactly_one_durable_operation() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);

    bookmark(&library, 7, true);

    let connection = library.connection().unwrap();
    assert!(is_bookmarked(&connection, "kHentai", "7"));
    let rows = outbox_for_test(&connection);
    assert_eq!(rows.len(), 1, "exactly one logical operation");
    assert_eq!(rows[0].provider, "kHentai");
    assert_eq!(rows[0].work_id, "7");
    assert!(rows[0].desired_state);
    assert_eq!(rows[0].epoch, 1);
    // The entity was absent from the baseline, whose conceptual revision is 0.
    assert_eq!(rows[0].base_revision, 0);
    uuid::Uuid::parse_str(&rows[0].operation_id).expect("a durable operation id");
}

#[test]
fn a_local_removal_enqueues_exactly_one_durable_operation() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    bookmark(&library, 7, false);

    let connection = library.connection().unwrap();
    assert!(!is_bookmarked(&connection, "kHentai", "7"));
    // One entity, one intent: the removal supersedes the add rather than queueing
    // beside it.
    assert_eq!(
        only_queued(&connection),
        ("kHentai".to_owned(), "7".to_owned(), false, 1, 0)
    );
}

/// A superseding mutation is a different logical operation. Reusing the operation
/// id would make the server reject it as a payload mismatch, so it must be fresh.
#[test]
fn a_superseding_mutation_takes_a_fresh_operation_id() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let first = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    bookmark(&library, 7, false);

    let second = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };
    assert_ne!(first, second, "a new payload needs a new operation id");
}

/// A rejected mutation writes neither the bookmark nor an operation.
#[test]
fn a_rejected_mutation_leaves_no_bookmark_and_no_operation() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);

    let invalid = CatalogWorkIdentity {
        provider: crate::library::catalog_provider::CatalogProvider::KHentai,
        provider_work_id: "   ".to_owned(),
    };
    assert!(library.set_online_catalog_bookmark(&invalid, true).is_err());

    let connection = library.connection().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM online_catalog_bookmarks", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(queued(&connection), Vec::new());
}

/// The recovery mutation is the third PC-owned bookmark writer, so a bookmark it
/// creates queues its own operation in the same transaction.
#[test]
fn a_recovery_created_bookmark_enqueues_one_operation() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    recovery_fixture(&library);

    let result = library.apply_manga_catalog_recovery().unwrap();

    assert_eq!(result.created_bookmarks, 1);
    let connection = library.connection().unwrap();
    assert!(is_bookmarked(&connection, "kHentai", "10"));
    assert_eq!(
        only_queued(&connection),
        ("kHentai".to_owned(), "10".to_owned(), true, 1, 0)
    );
}

/// Re-running the recovery creates nothing and therefore queues nothing more: the
/// mapping is idempotent and the queue does not grow.
#[test]
fn a_repeated_recovery_enqueues_no_second_operation() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    recovery_fixture(&library);
    library.apply_manga_catalog_recovery().unwrap();
    let first = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    let again = library.apply_manga_catalog_recovery().unwrap();

    assert_eq!(again.created_bookmarks, 0);
    let connection = library.connection().unwrap();
    assert_eq!(operation_ids(&connection), vec![first]);
}

// --- pre-authority and redundant-mutation behavior ---

/// Without an adopted authority there is no server to send to, so the mutation is
/// purely local and the queue stays empty. This is the pre-B6 behavior every
/// existing library keeps until an authority is activated.
#[test]
fn a_pc_owned_domain_mutates_locally_without_queueing() {
    let (_temp, library) = open();

    bookmark(&library, 7, true);
    bookmark(&library, 7, false);

    let connection = library.connection().unwrap();
    assert!(!is_bookmarked(&connection, "kHentai", "7"));
    assert_eq!(queued(&connection), Vec::new());
}

/// Setting a state the PC already holds is not a mutation, matching the server's
/// receipted no-op: no intent is manufactured for it.
#[test]
fn a_redundant_local_mutation_enqueues_nothing() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    {
        let connection = library.connection().unwrap();
        clear_outbox(&connection);
    }

    bookmark(&library, 7, true);
    bookmark(&library, 9, false);

    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
}

// --- 4. the receive half never enqueues ---

#[test]
fn a_remote_baseline_and_change_page_enqueue_nothing() {
    let (_temp, library) = open();
    let items = vec![
        item("kHentai", "1", true, 1),
        // A tombstone: present in the baseline so its revision is known.
        item("kHentai", "2", false, 2),
    ];
    library
        .adopt_bookmark_baseline_for_test(&local_id(&library), 1, 1, 3, &items)
        .unwrap();
    let page = vec![change(4, "kHentai", "5", true, 1)];
    library
        .apply_bookmark_page_for_test(&local_id(&library), 1, 1, &page, 4)
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(is_bookmarked(&connection, "kHentai", "1"));
    assert!(!is_bookmarked(&connection, "kHentai", "2"));
    assert!(is_bookmarked(&connection, "kHentai", "5"));
    // Receiving must never become outgoing work.
    assert_eq!(queued(&connection), Vec::new());
    // It does record the authority revisions it applied, so a later local mutation
    // can compose against them. A tombstone's revision is recorded too, because
    // re-bookmarking it must present that revision.
    assert_eq!(cached_revision(&connection, "1"), Some(1));
    assert_eq!(cached_revision(&connection, "2"), Some(2));
    assert_eq!(cached_revision(&connection, "5"), Some(1));
}

/// A local add composed after a remote baseline presents the authority revision
/// the baseline carried, not zero.
#[test]
fn a_local_mutation_uses_the_authority_revision_it_observed() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    library
        .adopt_bookmark_baseline_for_test(
            &local_id(&library),
            1,
            1,
            3,
            &[item("kHentai", "7", false, 4)],
        )
        .unwrap();

    bookmark(&library, 7, true);

    let connection = library.connection().unwrap();
    assert_eq!(
        only_queued(&connection),
        ("kHentai".to_owned(), "7".to_owned(), true, 1, 4),
        "a re-bookmark of a tombstone presents that tombstone's revision"
    );
}

/// A baseline must not erase an intent the user has made but this PC has not
/// delivered, and applying it must still enqueue nothing.
#[test]
fn a_remote_baseline_preserves_an_undelivered_local_intent() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    // The authority's baseline does not contain work 7 yet.
    library
        .adopt_bookmark_baseline_for_test(&local_id(&library), 1, 1, 5, &[])
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(
        is_bookmarked(&connection, "kHentai", "7"),
        "an undelivered intent stays visible"
    );
    assert_eq!(
        only_queued(&connection),
        ("kHentai".to_owned(), "7".to_owned(), true, 1, 0),
        "and stays queued exactly once"
    );
}

/// The same protection applies to an ordered change page, not just a baseline.
#[test]
fn a_remote_change_page_preserves_an_undelivered_local_intent() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    library
        .adopt_bookmark_baseline_for_test(&local_id(&library), 1, 1, 0, &[])
        .unwrap();

    // The authority tombstones work 7 at revision 1, racing the local add.
    library
        .apply_bookmark_page_for_test(
            &local_id(&library),
            1,
            1,
            &[change(1, "kHentai", "7", false, 1)],
            1,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(
        is_bookmarked(&connection, "kHentai", "7"),
        "the undelivered add stays visible over the tombstone"
    );
    assert_eq!(only_queued(&connection).2, true, "and stays queued");
}

// --- 5/12. confirmation and its durability ---

#[test]
fn a_confirmed_send_clears_pending_state_and_survives_restart() {
    let (temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let operation = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 1, "7", true, 5, true))],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert_eq!(seen.operation_ids(), vec![operation]);
    assert_eq!(outcome.sent, 1);
    assert_eq!(outcome.pending, 0);
    assert!(!outcome.rebased);
    {
        let connection = library.connection().unwrap();
        assert_eq!(queued(&connection), Vec::new());
        assert_eq!(cached_revision(&connection, "7"), Some(5));
        // The local row adopts the authority's creation time, exactly as the
        // receive half does for the same change arriving through the change log.
        let created: String = connection
            .query_row(
                "SELECT created_at FROM online_catalog_bookmarks WHERE provider='kHentai' AND work_id='7'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(created, "2026-09-15T00:00:00Z");
    }

    // Restart: a locally confirmed intent must not be sent again.
    drop(library);
    let reopened = Library::open(temp.path()).unwrap();
    let connection = reopened.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
    assert!(is_bookmarked(&connection, "kHentai", "7"));
}

#[test]
fn a_confirmed_removal_deletes_the_bookmark_and_drops_the_intent() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    {
        let connection = library.connection().unwrap();
        clear_outbox(&connection);
    }
    bookmark(&library, 7, false);

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 1, "7", false, 6, true))],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    stub.finish();

    assert_eq!(outcome.sent, 1);
    let connection = library.connection().unwrap();
    assert!(!is_bookmarked(&connection, "kHentai", "7"));
    assert_eq!(queued(&connection), Vec::new());
}

/// A command the authority reports as `changed: false` is still confirmed, so the
/// intent completes instead of being retried forever.
#[test]
fn an_already_current_command_confirms_without_a_second_write() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 1, "7", true, 3, false))],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert_eq!(seen.commands.len(), 1, "one command, not two");
    assert_eq!(outcome.sent, 1);
    assert_eq!(outcome.already_current, 1);
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
    assert!(is_bookmarked(&connection, "kHentai", "7"));
    assert_eq!(cached_revision(&connection, "7"), Some(3));
}

// --- 6/7. restart and lost-response idempotency ---

#[test]
fn a_restart_retries_with_the_same_durable_operation_id() {
    let (temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let before = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };
    drop(library);

    let reopened = Library::open(temp.path()).unwrap();
    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 1, "7", true, 1, true))],
    );
    let outcome = reopened
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert_eq!(outcome.sent, 1);
    assert_eq!(
        seen.operation_ids(),
        vec![before],
        "the same durable operation id survived the restart"
    );
}

/// The response is lost after the server accepted the command. The retry reuses
/// the operation id, and the client accepts the recorded result without inventing
/// a second logical write.
#[test]
fn a_lost_response_retries_idempotently_and_does_not_duplicate() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{Shutdown, TcpListener};

    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let operation = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    // tiny_http ignores a response's Connection header and can keep a truncated
    // response alive. Own the socket here so loss means EOF, not a 30s timeout.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = CloudClient::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = thread::spawn(move || {
        let mut commands = Vec::<serde_json::Value>::new();
        for attempt in 0..2 {
            for is_command in [false, true] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert_eq!(
                    line,
                    if is_command {
                        "PUT /v1/mobile-catalog/bookmarks/kHentai/7 HTTP/1.1\r\n"
                    } else {
                        "GET /v1/mobile-catalog/status HTTP/1.1\r\n"
                    }
                );
                let mut length = 0;
                loop {
                    line.clear();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    let (name, value) = line.split_once(':').unwrap();
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                assert!(length <= 4096);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                if is_command {
                    commands.push(serde_json::from_slice(&body).unwrap());
                }
                if is_command && attempt == 0 {
                    // The server received the entire command but the client cannot
                    // read a complete result. Closing the write half makes loss immediate.
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n{").unwrap();
                } else {
                    let result = if is_command {
                        assert_eq!(commands[0], commands[1], "retry the entire same command");
                        command_result(&id, 1, "7", true, 1, true)
                    } else {
                        status_body(&id, 1, 0, true)
                    };
                    let body = serde_json::to_vec(&result).unwrap();
                    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    socket.write_all(&body).unwrap();
                }
                socket.shutdown(Shutdown::Write).unwrap();
            }
        }
        commands
    });

    // First pass: the transport fails, so the intent stays queued and unchanged.
    let error = library
        .flush_catalog_bookmark_outbox_with(&client, "test-token")
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CloudRequestUnavailable),
        "{error}"
    );
    {
        let connection = library.connection().unwrap();
        assert_eq!(operation_ids(&connection), vec![operation.clone()]);
    }

    // Second pass: the same durable operation id is sent, and the intent completes.
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&client, "test-token")
        .unwrap();
    let commands = server.join().unwrap();

    assert_eq!(outcome.sent, 1);
    let ids: Vec<_> = commands
        .iter()
        .map(|command| command["operationId"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "two transport attempts");
    assert_eq!(ids[0], ids[1], "identical on the wire");
    assert_eq!(ids[0], operation);
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
}

/// After a confirmed intent there is nothing left to send, so a later pass sends
/// nothing at all.
#[test]
fn a_confirmed_intent_is_not_sent_again() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 1, "7", true, 1, true))],
    );
    let client = stub.client();
    library
        .flush_catalog_bookmark_outbox_with(&client, "test-token")
        .unwrap();
    let second = library
        .flush_catalog_bookmark_outbox_with(&client, "test-token")
        .unwrap();
    let seen = stub.finish();

    assert_eq!(second.sent, 0);
    assert_eq!(seen.commands.len(), 1, "exactly one command ever");
}

// --- 8. stale revision ---

/// A stale `expectedRevision` must not drop the intent. The PC refreshes through
/// the B5 receive path, then completes the intent whose desired state the
/// authority already holds, without a duplicate write.
#[test]
fn a_stale_revision_refreshes_the_authority_and_keeps_the_intent() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let operation = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    let stub = Stub::new(
        status_body(&id, 1, 1, true),
        snapshot_body(
            &id,
            1,
            1,
            serde_json::json!([{
                "provider": "kHentai", "workId": "7", "desiredState": true,
                "entityRevision": 1, "createdAt": "2026-09-01T00:00:00Z",
                "updatedAt": "2026-09-01T00:00:00Z"
            }]),
        ),
        empty_changes(&id, 1, 1),
        vec![Answer::Conflict {
            cursor: 1,
            desired: true,
            revision: 1,
        }],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert!(outcome.rebased, "the queue was rebased onto the authority");
    // The authority already holds the desired state, so the intent completes with
    // no duplicate write and no lost local intent.
    assert_eq!(outcome.already_current, 1);
    assert_eq!(outcome.sent, 1);
    assert_eq!(seen.operation_ids(), vec![operation]);
    assert_eq!(
        seen.revisions(),
        vec![0],
        "composed against an absent entity"
    );
    // The refresh really ran the B5 read path, not a private shortcut.
    assert!(
        seen.read_paths()
            .iter()
            .any(|path| path.ends_with("/status")),
        "{:?}",
        seen.read_paths()
    );
    assert!(
        seen.read_paths()
            .iter()
            .any(|path| path.contains("/bookmarks/changes")),
        "the B5 catch-up ran: {:?}",
        seen.read_paths()
    );
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
    assert!(is_bookmarked(&connection, "kHentai", "7"));
    assert_eq!(cached_revision(&connection, "7"), Some(1));
}

/// When the authority *disagrees* with a stale intent, the retry presents the
/// refreshed revision and keeps the intent's identity, so a later lost response is
/// still idempotent.
#[test]
fn a_stale_revision_against_a_different_authority_state_retries_the_same_intent() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let operation = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    let stub = Stub::new(
        status_body(&id, 1, 2, true),
        snapshot_body(
            &id,
            1,
            2,
            serde_json::json!([{
                "provider": "kHentai", "workId": "7", "desiredState": false,
                "entityRevision": 2, "createdAt": null,
                "updatedAt": "2026-09-02T00:00:00Z"
            }]),
        ),
        empty_changes(&id, 1, 2),
        vec![
            // The authority holds desiredState=false at revision 2.
            Answer::Conflict {
                cursor: 2,
                desired: false,
                revision: 2,
            },
            Answer::Accept(command_result(&id, 1, "7", true, 3, true)),
        ],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert!(outcome.rebased);
    assert_eq!(outcome.sent, 1);
    assert_eq!(
        seen.revisions(),
        vec![0, 2],
        "the retry presents the refreshed revision"
    );
    assert_eq!(
        seen.operation_ids(),
        vec![operation.clone(), operation],
        "under the same operation id, so the logical write stays single"
    );
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
    assert!(is_bookmarked(&connection, "kHentai", "7"));
}

/// Revisions are only comparable inside one epoch, so an intent composed under a
/// previous epoch re-points at the live one with a zero base, keeping its
/// identity, instead of presenting a meaningless revision or being dropped.
#[test]
fn an_epoch_change_rebases_the_intent_instead_of_dropping_it() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let operation = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    let stub = Stub::new(
        status_body(&id, 2, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 2, "7", true, 1, true))],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert!(outcome.rebased);
    assert_eq!(outcome.sent, 1);
    assert_eq!(
        seen.revisions(),
        vec![0],
        "no cross-epoch revision is presented"
    );
    assert_eq!(seen.operation_ids(), vec![operation]);
    assert_eq!(seen.commands[0].epoch, 2, "re-pointed at the live epoch");
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection), Vec::new());
}

// --- 9. cross-library mismatch ---

/// A server advertising another library must not receive this PC's commands, and
/// must not cost the PC its pending intent or its local bookmark state.
#[test]
fn a_cross_library_authority_sends_nothing_and_loses_nothing() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = status_only_stub(status_body(OTHER_LIBRARY, 1, 0, true));
    let error = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap_err();
    let seen = stub.finish();

    assert!(
        matches!(error, LibraryError::CatalogBookmarkAuthorityMismatch),
        "{error}"
    );
    assert!(
        seen.commands.is_empty(),
        "no command was sent: {seen:?}",
        seen = seen.commands.len()
    );
    assert_eq!(
        seen.read_paths(),
        vec!["/v1/mobile-catalog/status".to_owned()],
        "only the status read happened"
    );
    let connection = library.connection().unwrap();
    assert!(
        is_bookmarked(&connection, "kHentai", "7"),
        "local state kept"
    );
    assert_eq!(queued(&connection).len(), 1, "the intent is not discarded");
}

// --- 10/11. authority, capability and typed rejection gates ---

/// The server owns the domain but has not advertised the write capability. That
/// is not an error, and nothing may be sent or discarded.
#[test]
fn an_unadvertised_write_capability_sends_nothing_and_keeps_the_intent() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = status_only_stub(status_body(&id, 1, 0, false));
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert!(outcome.authority_unavailable);
    assert_eq!(outcome.sent, 0);
    assert_eq!(outcome.pending, 1);
    assert!(seen.commands.is_empty());
    assert_eq!(
        seen.read_paths(),
        vec!["/v1/mobile-catalog/status".to_owned()]
    );
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection).len(), 1);
}

/// With no authority at all the domain is still PC-owned, so nothing is sent.
#[test]
fn an_absent_authority_sends_nothing() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = status_only_stub(serde_json::json!({
        "authorityLibraryId": null, "authorityEpoch": null,
        "authorityContractVersion": null, "authorityCursor": null,
        "capabilities": {"bookmarkWrite": false}
    }));
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert!(outcome.authority_unavailable);
    assert_eq!(outcome.pending, 1);
    assert!(seen.commands.is_empty());
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection).len(), 1);
}

/// A contract this build cannot speak is a typed version-skew state, not a
/// network error, and the intent survives it.
#[test]
fn an_unsupported_contract_is_a_typed_state() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = status_only_stub(serde_json::json!({
        "authorityLibraryId": id, "authorityEpoch": 1,
        "authorityContractVersion": 2, "authorityCursor": 0,
        "capabilities": {"bookmarkWrite": true}
    }));
    let error = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap_err();
    let seen = stub.finish();

    assert!(
        matches!(error, LibraryError::CatalogBookmarkContractUnsupported),
        "{error}"
    );
    assert!(seen.commands.is_empty());
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection).len(), 1);
}

/// An authorization failure is the credential's problem, not the intent's: the
/// intent keeps its operation id and stays queued.
#[test]
fn an_unauthorized_command_keeps_its_intent() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    let operation = {
        let connection = library.connection().unwrap();
        only_operation(&connection)
    };

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Status(401)],
    );
    let error = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap_err();
    stub.finish();

    assert!(matches!(error, LibraryError::CloudUnauthorized), "{error}");
    let connection = library.connection().unwrap();
    assert_eq!(operation_ids(&connection), vec![operation]);
    assert!(is_bookmarked(&connection, "kHentai", "7"));
}

/// A rejected command likewise leaves the intent and the local state intact.
#[test]
fn a_rejected_command_keeps_its_intent() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Status(500)],
    );
    let error = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap_err();
    stub.finish();

    assert!(
        matches!(error, LibraryError::CatalogBookmarkSyncRejected(500)),
        "{error}"
    );
    let connection = library.connection().unwrap();
    assert_eq!(queued(&connection).len(), 1);
    assert!(is_bookmarked(&connection, "kHentai", "7"));
}

// --- 5. pending/confirmed representation ---

#[test]
fn delivery_state_distinguishes_pending_from_confirmed() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);

    // Never touched: neither pending nor confirmed.
    let absent = library
        .catalog_bookmark_delivery_state("kHentai", "7")
        .unwrap();
    assert!(!absent.pending);
    assert!(!absent.desired_state);
    assert_eq!(absent.operation_id, None);
    assert_eq!(absent.confirmed_revision, None);

    // Locally applied, not yet delivered.
    bookmark(&library, 7, true);
    let pending = library
        .catalog_bookmark_delivery_state("kHentai", "7")
        .unwrap();
    assert!(pending.pending);
    assert!(pending.desired_state);
    assert_eq!(pending.operation_id.as_deref().map(str::len), Some(36));
    assert_eq!(pending.confirmed_revision, None);

    // Confirmed by the authority.
    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![Answer::Accept(command_result(&id, 1, "7", true, 4, true))],
    );
    library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    stub.finish();

    let confirmed = library
        .catalog_bookmark_delivery_state("kHentai", "7")
        .unwrap();
    assert!(!confirmed.pending);
    assert!(confirmed.desired_state);
    assert_eq!(confirmed.operation_id, None);
    assert_eq!(confirmed.confirmed_revision, Some(4));
}

// --- deterministic processing ---

/// Intents are sent oldest first, so an interrupted pass resumes in the same
/// order rather than depending on row layout.
#[test]
fn processing_order_is_deterministic_oldest_first() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    for work_id in [7u64, 8, 9] {
        bookmark(&library, work_id, true);
    }
    {
        let connection = library.connection().unwrap();
        // Distinguish the timestamps rather than rely on operation-id tie-breaking.
        for (index, work_id) in ["7", "8", "9"].iter().enumerate() {
            connection
                .execute(
                    "UPDATE catalog_bookmark_outbox SET created_at=?1 WHERE work_id=?2",
                    rusqlite::params![format!("2026-09-15T00:00:0{index}Z"), work_id],
                )
                .unwrap();
        }
    }

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![
            Answer::Accept(command_result(&id, 1, "7", true, 1, true)),
            Answer::Accept(command_result(&id, 1, "8", true, 2, true)),
            Answer::Accept(command_result(&id, 1, "9", true, 3, true)),
        ],
    );
    let outcome = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap();
    let seen = stub.finish();

    assert_eq!(outcome.sent, 3);
    assert_eq!(outcome.pending, 0);
    assert_eq!(
        seen.command_paths(),
        vec![
            "/v1/mobile-catalog/bookmarks/kHentai/7".to_owned(),
            "/v1/mobile-catalog/bookmarks/kHentai/8".to_owned(),
            "/v1/mobile-catalog/bookmarks/kHentai/9".to_owned(),
        ]
    );
}

/// An interrupt in the middle of the queue leaves the untouched intents pending,
/// so the next pass resumes rather than restarting the whole queue.
#[test]
fn a_failed_send_leaves_the_remaining_intents_pending() {
    let (_temp, library) = open();
    let id = adopt(&library, 1, 0);
    bookmark(&library, 7, true);
    bookmark(&library, 8, true);
    {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "UPDATE catalog_bookmark_outbox SET created_at='2026-09-15T00:00:00Z' WHERE work_id='7'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE catalog_bookmark_outbox SET created_at='2026-09-15T00:00:01Z' WHERE work_id='8'",
                [],
            )
            .unwrap();
    }

    let stub = Stub::new(
        status_body(&id, 1, 0, true),
        serde_json::Value::Null,
        serde_json::Value::Null,
        vec![
            Answer::Accept(command_result(&id, 1, "7", true, 1, true)),
            Answer::Status(500),
        ],
    );
    let error = library
        .flush_catalog_bookmark_outbox_with(&stub.client(), "test-token")
        .unwrap_err();
    let seen = stub.finish();

    assert!(
        matches!(error, LibraryError::CatalogBookmarkSyncRejected(500)),
        "{error}"
    );
    // The first intent was confirmed and retired; the second is still pending.
    assert_eq!(seen.command_paths().len(), 2);
    let connection = library.connection().unwrap();
    assert_eq!(
        queued(&connection),
        vec![("kHentai".to_owned(), "8".to_owned(), true, 1, 0)]
    );
}
