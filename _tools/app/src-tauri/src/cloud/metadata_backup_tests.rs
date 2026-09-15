//! The whole-`library.sqlite` restore must not run once a shared domain is
//! server-authoritative.
//!
//! ADR-0037 decision 6 makes server state, not an old PC snapshot, the canonical
//! recovery source. The gate therefore has to run *before* the download and the
//! database swap, and it has to fail closed: an authority status the client cannot
//! read is not evidence that no authority exists.
//!
//! These tests drive the real `CloudClient` over a real socket and then assert the
//! local database is byte-identical, which is what proves nothing destructive ran.

use std::thread;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

use super::client::CloudClient;
use crate::library::{error::LibraryError, Library};

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_LIBRARY: &str = "0f9e8d7c6b5a4938271605f4e3d2c1b0";

/// A local library with observable state that a restore would have replaced.
fn library_with_observable_state(root: &std::path::Path) -> Library {
    let library = Library::open(root).unwrap();
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES ('asset-1', 'hash-1', 'image', 'local.png', 'assets/local.png',
                       'thumbnails/local.webp', 4, 1, 1, '2026-09-15T00:00:00Z')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO catalog_bookmark_outbox
                (operation_id, provider, work_id, desired_state, epoch, base_revision, created_at)
             VALUES ('op-1', 'kHentai', '7', 1, 1, 0, '2026-09-15T00:00:00Z')",
            [],
        )
        .unwrap();
    drop(connection);
    library
}

/// The exact local state the gate must leave untouched.
fn observable_state(library: &Library) -> (String, Vec<(String, String, i64)>, i64) {
    let connection = library.connection().unwrap();
    let library_id: String = connection
        .query_row(
            "SELECT library_id FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let outbox: Vec<(String, String, i64)> = connection
        .prepare("SELECT operation_id, provider, desired_state FROM catalog_bookmark_outbox ORDER BY operation_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let assets: i64 = connection
        .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
        .unwrap();
    (library_id, outbox, assets)
}

fn sync_status_body(
    active: bool,
    domains: serde_json::Value,
) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(
        serde_json::to_vec(&json!({
            "protocolVersion": 1,
            "active": active,
            "libraryId": if active { json!(LIBRARY) } else { json!(null) },
            "domains": domains
        }))
        .unwrap(),
    )
    .with_status_code(200)
    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

fn answer_status(server: &Server, active: bool, domains: serde_json::Value) {
    let mut request = server.recv().unwrap();
    assert_eq!(request.method(), &Method::Get);
    assert_eq!(request.url(), "/v1/sync/status");
    assert_eq!(
        header_value(&request, "authorization"),
        Some("Bearer test-token")
    );
    request.respond(sync_status_body(active, domains)).unwrap();
}

fn header_value<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.to_string().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

/// With no active authority the gate passes, so the restore proceeds to its first
/// network step. The server then answers the backup-metadata request with 404,
/// which is the pre-existing "no backup on the server" outcome — proof the gate did
/// not block a legitimate restore.
#[test]
fn an_inactive_authority_leaves_the_old_restore_path_reachable() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        answer_status(&server, false, json!([]));
        let metadata = server.recv().unwrap();
        assert_eq!(metadata.url(), "/v1/library/metadata-backup");
        metadata.respond(Response::empty(404)).unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let library = library_with_observable_state(temp.path());
    let before = observable_state(&library);

    let error = library
        .restore_cloud_library_from_server_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();

    assert!(
        matches!(error, LibraryError::CloudMetadataBackupNotFound),
        "{error}"
    );
    assert_eq!(observable_state(&library), before);
    server_thread.join().unwrap();
}

/// An active authority domain must refuse before the snapshot is even downloaded.
#[test]
fn an_active_authority_refuses_before_any_destructive_work() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        answer_status(
            &server,
            true,
            json!([{
                "domain": "catalog-bookmarks", "libraryId": LIBRARY,
                "epoch": 1, "contractVersion": 1, "cursor": 5
            }]),
        );
        // No further request may arrive: a destructive restore would have asked for
        // the snapshot next. `recv_timeout` returning None is the assertion.
        assert!(server
            .recv_timeout(std::time::Duration::from_millis(500))
            .unwrap()
            .is_none());
    });

    let temp = tempfile::tempdir().unwrap();
    let library = library_with_observable_state(temp.path());
    let before = observable_state(&library);

    let error = library
        .restore_cloud_library_from_server_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();

    assert!(
        matches!(error, LibraryError::RestoreAuthorityActive { .. }),
        "{error}"
    );
    assert_eq!(observable_state(&library), before);
    server_thread.join().unwrap();
}

/// A contradictory envelope is refused as unreadable rather than being resolved in
/// whichever direction lets the restore proceed. `active:false` alongside a domain
/// row is exactly the contradiction that must not become "nothing is active".
#[test]
fn an_inconsistent_envelope_never_allows_a_destructive_restore() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        answer_status(
            &server,
            false,
            json!([{
                "domain": "classifications", "libraryId": LIBRARY,
                "epoch": 2, "contractVersion": 1, "cursor": 11
            }]),
        );
        // The guard must not download the snapshot after refusing.
        assert!(server
            .recv_timeout(std::time::Duration::from_millis(500))
            .unwrap()
            .is_none());
    });

    let temp = tempfile::tempdir().unwrap();
    let library = library_with_observable_state(temp.path());
    let before = observable_state(&library);

    let error = library
        .restore_cloud_library_from_server_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();

    assert!(
        matches!(error, LibraryError::RestoreAuthorityUnknown),
        "{error}"
    );
    assert_eq!(observable_state(&library), before);
    server_thread.join().unwrap();
}

/// An older server without the route cannot report authority state. Treating that
/// as "no authority" is exactly the guess this gate must not make.
#[test]
fn an_unreadable_authority_status_fails_closed() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        let request = server.recv().unwrap();
        assert_eq!(request.url(), "/v1/sync/status");
        request.respond(Response::empty(404)).unwrap();
        assert!(server
            .recv_timeout(std::time::Duration::from_millis(500))
            .unwrap()
            .is_none());
    });

    let temp = tempfile::tempdir().unwrap();
    let library = library_with_observable_state(temp.path());
    let before = observable_state(&library);

    let error = library
        .restore_cloud_library_from_server_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();

    assert!(
        matches!(error, LibraryError::RestoreAuthorityUnknown),
        "{error}"
    );
    assert_eq!(observable_state(&library), before);
    server_thread.join().unwrap();
}

/// A malformed status document is also "unknown", never "inactive".
#[test]
fn a_malformed_authority_status_fails_closed() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        let request = server.recv().unwrap();
        request
            .respond(
                Response::from_data(serde_json::to_vec(&json!({"domains": []})).unwrap())
                    .with_status_code(200)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let library = library_with_observable_state(temp.path());
    let before = observable_state(&library);

    let error = library
        .restore_cloud_library_from_server_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();

    assert!(
        matches!(error, LibraryError::RestoreAuthorityUnknown),
        "{error}"
    );
    assert_eq!(observable_state(&library), before);
    server_thread.join().unwrap();
}

/// The aggregate status response parses into the typed per-domain contract, and it
/// carries no global cursor that a client could mistake for synchronization truth.
#[test]
fn sync_status_reports_per_domain_epochs_and_cursors() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        answer_status(
            &server,
            true,
            json!([
                {"domain": "albums", "libraryId": LIBRARY, "epoch": 2, "contractVersion": 1, "cursor": 9},
                {"domain": "catalog-bookmarks", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 3}
            ]),
        );
    });

    let status = CloudClient::new(&base_url)
        .unwrap()
        .sync_status("test-token")
        .unwrap();

    assert_eq!(status.protocol_version, 1);
    assert!(status.active);
    assert_eq!(status.library_id.as_deref(), Some(LIBRARY));
    assert_eq!(
        status
            .domains
            .iter()
            .map(|domain| (domain.domain.as_str(), domain.epoch, domain.cursor))
            .collect::<Vec<_>>(),
        [("albums", 2, 9), ("catalog-bookmarks", 1, 3)]
    );
    server_thread.join().unwrap();
}

/// An inactive server reports no domains, which is the pre-cutover state a client
/// must read as "nothing has moved yet".
#[test]
fn inactive_sync_status_reports_no_domains() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        answer_status(&server, false, json!([]));
    });

    let status = CloudClient::new(&base_url)
        .unwrap()
        .sync_status("test-token")
        .unwrap();

    assert!(!status.active);
    assert!(status.domains.is_empty());
    assert!(status.library_id.is_none());
    server_thread.join().unwrap();
}

/// Any envelope the client cannot trust must never become proof that legacy restore
/// is safe. Each case below is a way a broken or hostile server could report
/// "nothing is active" while actually having an active domain.
mod sync_status_validation {
    use super::*;

    fn status_error(body: Value) -> LibraryError {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", server.server_addr());
        let server_thread = thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(
                    Response::from_data(serde_json::to_vec(&body).unwrap())
                        .with_status_code(200)
                        .with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        ),
                )
                .unwrap();
        });
        let error = CloudClient::new(&base_url)
            .unwrap()
            .sync_status("test-token")
            .unwrap_err();
        server_thread.join().unwrap();
        error
    }

    fn envelope(active: bool, library: Value, domains: Value) -> Value {
        json!({"protocolVersion": 1, "active": active, "libraryId": library, "domains": domains})
    }

    #[test]
    fn a_future_protocol_version_is_refused_rather_than_interpreted() {
        let error = status_error(json!({
            "protocolVersion": 2, "active": false, "libraryId": null, "domains": []
        }));
        assert!(
            matches!(error, LibraryError::SyncProtocolUnsupported),
            "{error}"
        );
    }

    #[test]
    fn an_inactive_envelope_that_names_a_library_is_refused() {
        // `active:false` with a library and no domains contradicts itself; reading
        // it as "nothing is active" is exactly the unsafe interpretation.
        for body in [
            envelope(false, json!(LIBRARY), json!([])),
            envelope(
                false,
                json!(LIBRARY),
                json!([
                    {"domain": "albums", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 0}
                ]),
            ),
            envelope(
                true,
                json!(null),
                json!([
                    {"domain": "albums", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 0}
                ]),
            ),
            envelope(true, json!(LIBRARY), json!([])),
        ] {
            let error = status_error(body);
            assert!(
                matches!(error, LibraryError::RestoreAuthorityUnknown),
                "{error}"
            );
        }
    }

    #[test]
    fn a_domain_naming_another_library_is_refused() {
        let error = status_error(envelope(
            true,
            json!(LIBRARY),
            json!([
                {"domain": "albums", "libraryId": OTHER_LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 0}
            ]),
        ));
        assert!(
            matches!(error, LibraryError::RestoreAuthorityUnknown),
            "{error}"
        );
    }

    #[test]
    fn a_duplicate_or_empty_domain_name_is_refused() {
        for body in [
            envelope(
                true,
                json!(LIBRARY),
                json!([
                    {"domain": "albums", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 0},
                    {"domain": "albums", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 4}
                ]),
            ),
            envelope(
                true,
                json!(LIBRARY),
                json!([
                    {"domain": "  ", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": 0}
                ]),
            ),
        ] {
            let error = status_error(body);
            assert!(
                matches!(error, LibraryError::RestoreAuthorityUnknown),
                "{error}"
            );
        }
    }

    #[test]
    fn non_positive_authority_values_are_refused() {
        for domain in [
            json!({"domain": "albums", "libraryId": LIBRARY, "epoch": 0, "contractVersion": 1, "cursor": 0}),
            json!({"domain": "albums", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 0, "cursor": 0}),
            json!({"domain": "albums", "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "cursor": -1}),
            json!({"domain": "albums", "libraryId": "not-a-library-id", "epoch": 1, "contractVersion": 1, "cursor": 0}),
        ] {
            let error = status_error(envelope(true, json!(LIBRARY), json!([domain])));
            assert!(
                matches!(error, LibraryError::RestoreAuthorityUnknown),
                "{error}"
            );
        }
    }

    #[test]
    fn a_top_level_library_that_is_not_a_valid_identity_is_refused() {
        let error = status_error(envelope(true, json!("placeholder"), json!([])));
        assert!(
            matches!(error, LibraryError::RestoreAuthorityUnknown),
            "{error}"
        );
    }
}
