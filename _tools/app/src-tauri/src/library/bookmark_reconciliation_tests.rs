//! B5 regression coverage: the PC receive half of bookmark reconciliation.
//!
//! These tests exercise the production apply path (`apply_page`,
//! `replace_with_baseline`) and the real durable cursor row. The transport is
//! covered separately by `cloud::contract_tests`, which drives the real
//! `CloudClient` against a real HTTP server.
//!
//! `Library::connection()` takes the library's database mutex, so a test must
//! never call another accessor while it holds a connection guard. Each assertion
//! block below therefore reads every value it needs from one connection.

use rusqlite::Connection;

use crate::cloud::client::{MobileCatalogBookmarkItem, MobileCatalogChange};
use crate::library::error::LibraryError;
use crate::library::Library;

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_LIBRARY: &str = "0f9e8d7c6b5a4938271605f4e3d2c1b0";

fn item(provider: &str, work_id: &str, desired: bool, created: &str) -> MobileCatalogBookmarkItem {
    MobileCatalogBookmarkItem {
        provider: provider.to_owned(),
        work_id: work_id.to_owned(),
        desired_state: desired,
        entity_revision: 1,
        created_at: Some(created.to_owned()),
    }
}

fn change(
    sequence: i64,
    provider: &str,
    work_id: &str,
    desired: bool,
    created: &str,
) -> MobileCatalogChange {
    MobileCatalogChange {
        sequence,
        provider: provider.to_owned(),
        work_id: work_id.to_owned(),
        desired_state: desired,
        entity_revision: 1,
        created_at: Some(created.to_owned()),
    }
}

fn bookmark_pairs(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT provider, work_id FROM online_catalog_bookmarks ORDER BY provider, work_id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn created_at(connection: &Connection, provider: &str, work_id: &str) -> String {
    connection
        .query_row(
            "SELECT created_at FROM online_catalog_bookmarks WHERE provider=?1 AND work_id=?2",
            [provider, work_id],
            |row| row.get(0),
        )
        .unwrap()
}

/// The durable sync row, read from an existing connection guard.
fn sync_row(connection: &Connection) -> Option<(String, i64, i64, i64)> {
    connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor FROM catalog_bookmark_sync WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()
}

fn open() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

#[test]
fn baseline_replaces_local_bookmarks_and_records_the_cursor() {
    let (_temp, library) = open();
    {
        let connection = library.connection().unwrap();
        // Pre-existing local state the authority does not contain.
        connection
            .execute(
                "INSERT INTO online_catalog_bookmarks VALUES('kHentai','stale','2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
    }
    let items = vec![
        item("kHentai", "3", true, "2026-01-01T00:00:00Z"),
        // A tombstone: a full replacement must not leave this row behind.
        item("kHentai", "9", false, "2026-01-02T00:00:00Z"),
        item("heliotrope", "42", true, "2026-01-03T00:00:00Z"),
    ];
    library
        .adopt_bookmark_baseline_for_test(LIBRARY, 1, 1, 7, &items)
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        bookmark_pairs(&connection),
        vec![
            ("heliotrope".to_owned(), "42".to_owned()),
            ("kHentai".to_owned(), "3".to_owned()),
        ]
    );
    // The authority's created_at is preserved exactly, not overwritten.
    assert_eq!(
        created_at(&connection, "kHentai", "3"),
        "2026-01-01T00:00:00Z"
    );
    assert_eq!(
        sync_row(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 7)),
        "baseline cursor must be the snapshot cursor"
    );
}

#[test]
fn applied_changes_and_cursor_commit_together() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(LIBRARY, 1, 1, 0, &[])
        .unwrap();
    let page = vec![
        change(1, "kHentai", "6", true, "2026-02-01T00:00:00Z"),
        change(2, "kHentai", "7", true, "2026-02-02T00:00:00Z"),
    ];
    library
        .apply_bookmark_page_for_test(LIBRARY, 1, 1, &page, 2)
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        bookmark_pairs(&connection),
        vec![
            ("kHentai".to_owned(), "6".to_owned()),
            ("kHentai".to_owned(), "7".to_owned()),
        ]
    );
    assert_eq!(
        sync_row(&connection).map(|row| row.3),
        Some(2),
        "cursor advances only with the applied page"
    );
}

#[test]
fn a_tombstone_removes_the_local_bookmark() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(
            LIBRARY,
            1,
            1,
            0,
            &[item("kHentai", "5", true, "2026-01-01T00:00:00Z")],
        )
        .unwrap();
    library
        .apply_bookmark_page_for_test(
            LIBRARY,
            1,
            1,
            &[change(1, "kHentai", "5", false, "2026-01-01T00:00:00Z")],
            1,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert!(bookmark_pairs(&connection).is_empty());
}

#[test]
fn re_bookmarking_takes_the_authority_created_at() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(
            LIBRARY,
            1,
            1,
            0,
            &[item("kHentai", "8", true, "2020-01-01T00:00:00Z")],
        )
        .unwrap();
    // The server resets created_at when a tombstone is re-bookmarked; the local
    // value must follow the authority rather than keep the stale one.
    library
        .apply_bookmark_page_for_test(
            LIBRARY,
            1,
            1,
            &[change(1, "kHentai", "8", true, "2026-09-14T00:00:00Z")],
            1,
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        created_at(&connection, "kHentai", "8"),
        "2026-09-14T00:00:00Z"
    );
}

#[test]
fn applying_changes_enqueues_no_outgoing_work() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(LIBRARY, 1, 1, 0, &[])
        .unwrap();
    library
        .apply_bookmark_page_for_test(
            LIBRARY,
            1,
            1,
            &[
                change(1, "kHentai", "6", true, "2026-02-01T00:00:00Z"),
                change(2, "kHentai", "6", false, "2026-02-01T00:00:00Z"),
            ],
            2,
        )
        .unwrap();
    // Receiving a change must not become an outgoing change: no queue row may
    // appear for it, in the asset replication queue or in B6's bookmark outbox.
    let connection = library.connection().unwrap();
    let queued: i64 = connection
        .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(queued, 0, "remote apply must not enqueue an outgoing write");
    let bookmark_outbox: i64 = connection
        .query_row("SELECT COUNT(*) FROM catalog_bookmark_outbox", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        bookmark_outbox, 0,
        "a remote apply must never become a bookmark command"
    );
    assert!(
        bookmark_pairs(&connection).is_empty(),
        "net effect is removal"
    );
}

#[test]
fn restart_preserves_the_cursor_and_the_adopted_bookmarks() {
    let (temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(
            LIBRARY,
            1,
            1,
            4,
            &[item("kHentai", "1", true, "2026-01-01T00:00:00Z")],
        )
        .unwrap();
    library
        .apply_bookmark_page_for_test(
            LIBRARY,
            1,
            1,
            &[change(5, "kHentai", "2", true, "2026-03-01T00:00:00Z")],
            5,
        )
        .unwrap();
    drop(library);

    // Reopening the library is the restart boundary: both the cursor and the
    // applied rows must survive with no network access.
    let reopened = Library::open(temp.path()).unwrap();
    let connection = reopened.connection().unwrap();
    assert_eq!(sync_row(&connection).map(|row| row.3), Some(5));
    assert_eq!(
        bookmark_pairs(&connection),
        vec![
            ("kHentai".to_owned(), "1".to_owned()),
            ("kHentai".to_owned(), "2".to_owned()),
        ]
    );
    drop(connection);

    let state = reopened.catalog_bookmark_sync_state().unwrap().unwrap();
    assert_eq!(state.local_cursor, Some(5));
    assert_eq!(state.library_id.as_deref(), Some(LIBRARY));
}

#[test]
fn a_non_ascending_page_is_rejected_atomically() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(LIBRARY, 1, 1, 0, &[])
        .unwrap();
    // Sequences must be strictly ascending; otherwise the local result would
    // depend on delivery order.
    let error = library
        .apply_bookmark_page_for_test(
            LIBRARY,
            1,
            1,
            &[
                change(9, "kHentai", "6", true, "2026-02-01T00:00:00Z"),
                change(4, "kHentai", "6", false, "2026-02-01T00:00:00Z"),
            ],
            9,
        )
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::InvalidCloudResponse),
        "{error}"
    );
    // The whole page rolled back, including the cursor and the first change.
    let connection = library.connection().unwrap();
    assert_eq!(sync_row(&connection).map(|row| row.3), Some(0));
    assert!(bookmark_pairs(&connection).is_empty());
}

#[test]
fn a_page_without_created_at_is_rejected_rather_than_stored_empty() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(LIBRARY, 1, 1, 0, &[])
        .unwrap();
    let mut malformed = change(1, "kHentai", "6", true, "2026-02-01T00:00:00Z");
    malformed.created_at = None;
    let error = library
        .apply_bookmark_page_for_test(LIBRARY, 1, 1, &[malformed], 1)
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::InvalidCloudResponse),
        "{error}"
    );
    let connection = library.connection().unwrap();
    assert!(bookmark_pairs(&connection).is_empty());
    assert_eq!(sync_row(&connection).map(|row| row.3), Some(0));
}

#[test]
fn an_unadopted_domain_is_distinguishable_from_an_adopted_one() {
    let (_temp, library) = open();
    // Before adoption no state row exists, so the domain reads as PC-owned and
    // nothing local has been replaced.
    assert!(library.catalog_bookmark_sync_state().unwrap().is_none());
    library
        .adopt_bookmark_baseline_for_test(LIBRARY, 1, 1, 0, &[])
        .unwrap();
    let state = library.catalog_bookmark_sync_state().unwrap().unwrap();
    assert_eq!(state.library_id.as_deref(), Some(LIBRARY));
    assert_eq!(state.epoch, Some(1));
    assert_eq!(state.contract_version, Some(1));
}

#[test]
fn re_basing_replaces_identity_epoch_and_cursor_together() {
    let (_temp, library) = open();
    library
        .adopt_bookmark_baseline_for_test(
            LIBRARY,
            1,
            1,
            3,
            &[item("kHentai", "1", true, "2026-01-01T00:00:00Z")],
        )
        .unwrap();
    {
        let connection = library.connection().unwrap();
        assert_eq!(sync_row(&connection).unwrap().0, LIBRARY);
    }
    // Adopting a different authority must not mix two change histories: identity,
    // epoch and cursor move together, and the old authority's rows are replaced.
    library
        .adopt_bookmark_baseline_for_test(
            OTHER_LIBRARY,
            2,
            1,
            0,
            &[item("kHentai", "42", true, "2026-05-01T00:00:00Z")],
        )
        .unwrap();
    let connection = library.connection().unwrap();
    assert_eq!(
        sync_row(&connection),
        Some((OTHER_LIBRARY.to_owned(), 2, 1, 0))
    );
    assert_eq!(
        bookmark_pairs(&connection),
        vec![("kHentai".to_owned(), "42".to_owned())]
    );
}

/// The full orchestration against a real HTTP server: `/status` → snapshot →
/// change pages. This is the case that a mocked transport would hide, so it runs
/// the real `CloudClient` over a real socket.
mod integration {
    use super::*;
    use crate::cloud::client::CloudClient;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use tiny_http::{Header, Method, Response, Server};
    fn json_response(value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    fn scripted_server(
        library_id: String,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            // 1. status: authority is active at cursor 2.
            let mut request = server.recv().unwrap();
            assert_eq!(request.method(), &Method::Get);
            log.lock().unwrap().push(request.url().to_owned());
            request
                .respond(json_response(serde_json::json!({
                    "authorityLibraryId": library_id,
                    "authorityEpoch": 1,
                    "authorityContractVersion": 1,
                    "authorityCursor": 2
                })))
                .unwrap();

            // 2. baseline snapshot: one live bookmark at cursor 1.
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": library_id,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 1,
                    "items": [
                        {"provider":"kHentai","workId":"1","desiredState":true,
                         "entityRevision":1,"createdAt":"2026-01-01T00:00:00Z",
                         "updatedAt":"2026-01-01T00:00:00Z"}
                    ]
                })))
                .unwrap();

            // 3. first page after the baseline cursor: one add, more to come.
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            assert!(request.url().contains("after=1"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": library_id,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 2,
                    "items": [
                        {"sequence":2,"provider":"kHentai","workId":"2","desiredState":true,
                         "entityRevision":1,"operationId":"op-2",
                         "createdAt":"2026-02-01T00:00:00Z","updatedAt":"2026-02-01T00:00:00Z",
                         "changedAt":"2026-02-01T00:00:00Z"}
                    ],
                    "nextAfter": 2,
                    "hasMore": true
                })))
                .unwrap();

            // 4. second page: end of the log.
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            assert!(request.url().contains("after=2"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": library_id,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 2,
                    "items": [],
                    "nextAfter": 2,
                    "hasMore": false
                })))
                .unwrap();
        });
        (base, seen, handle)
    }

    /// `/status` at cursor 5, a change page that answers `cursorExpired`, then a
    /// fresh baseline at cursor 5 containing work 8.
    fn expired_cursor_server(
        library_id: String,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            request
                .respond(json_response(serde_json::json!({
                    "authorityLibraryId": library_id,
                    "authorityEpoch": 1,
                    "authorityContractVersion": 1,
                    "authorityCursor": 5
                })))
                .unwrap();

            // The stale cursor is refused with the coded expiry.
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            assert!(request.url().contains("after=1"), "{}", request.url());
            request
                .respond(
                    json_response(serde_json::json!({
                        "detail": {"code": "cursorExpired", "authorityCursor": 5, "retentionDays": 180}
                    }))
                    .with_status_code(409),
                )
                .unwrap();

            // The recovery baseline includes the local intent's entity as the
            // authority already holds it, plus the local intent's own row.
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            assert!(request.url().contains("/bookmarks?"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": library_id,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 5,
                    "items": [
                        {"provider":"kHentai","workId":"8","desiredState":true,
                         "entityRevision":2,"createdAt":"2026-01-01T00:00:00Z",
                         "updatedAt":"2026-01-01T00:00:00Z"},
                        {"provider":"kHentai","workId":"777","desiredState":true,
                         "entityRevision":1,"createdAt":"2026-03-02T00:00:00Z",
                         "updatedAt":"2026-03-02T00:00:00Z"}
                    ]
                })))
                .unwrap();

            // Nothing remained after the fresh cursor.
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            assert!(request.url().contains("after=5"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": library_id,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 5,
                    "items": [],
                    "nextAfter": 5,
                    "hasMore": false
                })))
                .unwrap();
        });
        (base, seen, handle)
    }

    /// A change page that answers a 409 with no `cursorExpired` code.
    fn uncoded_conflict_server(
        library_id: String,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            request
                .respond(json_response(serde_json::json!({
                    "authorityLibraryId": library_id,
                    "authorityEpoch": 1,
                    "authorityContractVersion": 1,
                    "authorityCursor": 9
                })))
                .unwrap();
            let mut request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            request
                .respond(
                    json_response(serde_json::json!({"detail": "Change cursor is beyond the authority cursor"}))
                        .with_status_code(409),
                )
                .unwrap();
        });
        (base, seen, handle)
    }

    #[test]
    fn a_full_run_adopts_the_baseline_then_applies_every_page() {
        let (_temp, library) = open();
        {
            let connection = library.connection().unwrap();
            connection
                .execute(
                    "INSERT INTO online_catalog_bookmarks VALUES('kHentai','999','2020-01-01T00:00:00Z')",
                    [],
                )
                .unwrap();
        }
        let library_id = library.library_id().unwrap();
        let (base, seen, handle) = scripted_server(library_id.clone());
        let client = CloudClient::new(&base).unwrap();

        let result = library
            .reconcile_catalog_bookmarks_with(&client, "test-token")
            .unwrap();
        handle.join().unwrap();

        assert!(result.adopted_baseline, "a first run must adopt a baseline");
        assert_eq!(result.applied_changes, 1, "only the change page applied");
        assert_eq!(result.local_cursor, Some(2));
        assert_eq!(result.server_cursor, Some(2));
        assert_eq!(result.behind_by, 0);
        assert_eq!(result.library_id.as_deref(), Some(library_id.as_str()));

        let connection = library.connection().unwrap();
        // Baseline replaced the local row, then the change page added work 2.
        assert_eq!(
            bookmark_pairs(&connection),
            vec![
                ("kHentai".to_owned(), "1".to_owned()),
                ("kHentai".to_owned(), "2".to_owned()),
            ]
        );
        assert_eq!(
            sync_row(&connection),
            Some((library_id.clone(), 1, 1, 2)),
            "cursor must land on the last applied page"
        );
        drop(connection);

        // The reads are exactly the documented ones, in order, with no writes.
        let urls = seen.lock().unwrap().clone();
        assert_eq!(urls.len(), 4, "{urls:?}");
        assert!(urls[0].ends_with("/status"));
        assert!(urls[1].contains("/bookmarks?"));
        assert!(urls[2].contains("/bookmarks/changes?"));
        assert!(urls[3].contains("/bookmarks/changes?"));

        // Receiving must not become sending: neither the asset replication queue
        // nor B6's bookmark outbox may gain a row from a remote apply.
        let connection = library.connection().unwrap();
        let queued: i64 = connection
            .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
        let bookmark_outbox: i64 = connection
            .query_row("SELECT COUNT(*) FROM catalog_bookmark_outbox", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            bookmark_outbox, 0,
            "the full receive path must enqueue nothing"
        );
    }

    /// Expiry recovery: a pruned cursor must re-baseline, keep the local intent,
    /// advance the cursor, and still enqueue nothing.
    ///
    /// `cursorExpired` is delivered as a coded 409 on the change page; a mocked
    /// transport would not prove the code is parsed from the real body.
    #[test]
    fn an_expired_change_cursor_adopts_a_fresh_baseline_and_keeps_pending_intents() {
        let (_temp, library) = open();
        let library_id = library.library_id().unwrap();
        // A pending B6 intent that has not reached the authority yet.
        {
            let connection = library.connection().unwrap();
            connection
                .execute(
                    "INSERT INTO catalog_bookmark_outbox(operation_id,provider,work_id,desired_state,epoch,base_revision,created_at) VALUES('op-local','kHentai','777',1,1,0,'2026-03-01T00:00:00Z')",
                    [],
                )
                .unwrap();
            // Local sync state whose cursor predates retained history.
            connection
                .execute(
                    "INSERT INTO catalog_bookmark_sync(singleton,library_id,epoch,contract_version,cursor,updated_at) VALUES(1,?1,1,1,1,'2026-01-01T00:00:00Z')",
                    [&library_id],
                )
                .unwrap();
        }
        let (base, seen, handle) = expired_cursor_server(library_id.clone());
        let client = CloudClient::new(&base).unwrap();

        let result = library
            .reconcile_catalog_bookmarks_with(&client, "test-token")
            .unwrap();
        handle.join().unwrap();

        assert!(result.adopted_baseline, "expiry must adopt a fresh baseline");
        assert_eq!(result.local_cursor, Some(5), "cursor advances to the snapshot's");
        assert_eq!(result.epoch, Some(1));

        let connection = library.connection().unwrap();
        // The authority's live bookmark is present, and the undelivered local
        // intent survived: it is not authority state and must not be erased.
        assert_eq!(
            bookmark_pairs(&connection),
            vec![
                ("kHentai".to_owned(), "777".to_owned()),
                ("kHentai".to_owned(), "8".to_owned()),
            ]
        );
        assert_eq!(sync_row(&connection), Some((library_id, 1, 1, 5)));
        // The intent is still queued for delivery rather than silently dropped.
        let pending: i64 = connection
            .query_row("SELECT COUNT(*) FROM catalog_bookmark_outbox", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(pending, 1, "the pending local intent must survive re-baseline");
        // Receiving never becomes sending.
        let queued: i64 = connection
            .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
        let delivered: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM catalog_bookmark_outbox WHERE operation_id<>'op-local'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(delivered, 0, "re-baseline must not enqueue new work");
        drop(connection);

        // Order: status, the change read that expired, the fresh baseline, then the
        // catch-up from the baseline's own cursor. The incremental read is never
        // silently treated as "no changes".
        let urls = seen.lock().unwrap().clone();
        assert_eq!(urls.len(), 4, "{urls:?}");
        assert!(urls[0].ends_with("/status"));
        assert!(urls[1].contains("after=1"), "the stale cursor is attempted first");
        assert!(urls[2].contains("/bookmarks?"), "then a fresh baseline: {urls:?}");
        assert!(urls[3].contains("after=5"), "then catch up from it: {urls:?}");
    }

    /// A 409 whose body is *not* the coded expiry must stay a hard failure, so a
    /// transport change cannot silently turn identity skew into a re-baseline.
    #[test]
    fn an_uncoded_change_page_conflict_does_not_trigger_a_baseline() {
        let (_temp, library) = open();
        let library_id = library.library_id().unwrap();
        {
            let connection = library.connection().unwrap();
            connection
                .execute(
                    "INSERT INTO catalog_bookmark_sync(singleton,library_id,epoch,contract_version,cursor,updated_at) VALUES(1,?1,1,1,1,'2026-01-01T00:00:00Z')",
                    [&library_id],
                )
                .unwrap();
        }
        let (base, _seen, handle) = uncoded_conflict_server(library_id);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .reconcile_catalog_bookmarks_with(&client, "test-token")
            .unwrap_err();
        drop(handle);
        assert!(
            matches!(error, LibraryError::CatalogBookmarkCursorAhead),
            "{error}"
        );
        let connection = library.connection().unwrap();
        // No baseline was adopted and the cursor did not move.
        assert_eq!(sync_row(&connection).map(|row| row.3), Some(1));
    }

    #[test]
    fn an_authority_for_another_library_is_rejected_before_any_local_change() {
        let (_temp, library) = open();
        {
            let connection = library.connection().unwrap();
            connection
                .execute(
                    "INSERT INTO online_catalog_bookmarks VALUES('kHentai','7','2020-01-01T00:00:00Z')",
                    [],
                )
                .unwrap();
        }
        // The server claims a library this PC is not.
        let (base, _seen, handle) = scripted_server(OTHER_LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();

        let error = library
            .reconcile_catalog_bookmarks_with(&client, "test-token")
            .unwrap_err();
        // The read loop stops at the first read, so this server thread is still
        // blocked on its second `recv`; detach it instead of joining.
        drop(handle);
        assert!(
            matches!(error, LibraryError::CatalogBookmarkAuthorityMismatch),
            "{error}"
        );
        // Untouched: no baseline adopted, no row replaced, no cursor written.
        let connection = library.connection().unwrap();
        assert_eq!(
            bookmark_pairs(&connection),
            vec![("kHentai".to_owned(), "7".to_owned())]
        );
        assert!(sync_row(&connection).is_none());
    }
}
