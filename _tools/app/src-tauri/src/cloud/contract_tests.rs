use std::{fs, thread};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tiny_http::{Header, Method, Response, Server};

use super::client::CloudClient;
use crate::library::{error::LibraryError, Library};

#[test]
fn uploads_directly_with_presigned_headers_then_registers_the_asset() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let base_url = format!("{origin}/v1");
    let upload_url = format!("{origin}/r2-upload");
    let expected_sha256 = sha256(b"local-image-bytes");
    let server_thread = thread::spawn(move || {
        let mut presign = server.recv().unwrap();
        assert_eq!(presign.method(), &Method::Post);
        assert_eq!(presign.url(), "/v1/uploads/presign");
        assert_eq!(
            header_value(&presign, "authorization"),
            Some("Bearer test-token")
        );
        assert_eq!(
            read_json(&mut presign),
            json!({
                "object_key": "images/00000000-0000-4000-8000-000000000001/original",
                "content_type": "image/png"
            })
        );
        presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": "images/00000000-0000-4000-8000-000000000001/original",
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {
                    "Content-Type": "image/png",
                    "x-test-required": "presigned-value"
                }
            })))
            .unwrap();

        let mut upload = server.recv().unwrap();
        assert_eq!(upload.method(), &Method::Put);
        assert_eq!(upload.url(), "/r2-upload");
        assert_eq!(header_value(&upload, "authorization"), None);
        assert_eq!(header_value(&upload, "content-type"), Some("image/png"));
        assert_eq!(
            header_value(&upload, "x-test-required"),
            Some("presigned-value")
        );
        let mut bytes = Vec::new();
        upload.as_reader().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"local-image-bytes");
        upload.respond(Response::empty(200)).unwrap();

        let mut register = server.recv().unwrap();
        assert_eq!(register.method(), &Method::Post);
        assert_eq!(register.url(), "/v1/assets");
        assert_eq!(
            header_value(&register, "authorization"),
            Some("Bearer test-token")
        );
        assert_eq!(
            read_json(&mut register),
            json!({
                "id": "00000000-0000-4000-8000-000000000001",
                "kind": "image",
                "object_key": "images/00000000-0000-4000-8000-000000000001/original",
                "thumbnail_key": null,
                "content_type": "image/png",
                "size_bytes": 17,
            "sha256": expected_sha256
            })
        );
        register.respond(Response::empty(201)).unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let library = library_with_pending_asset(temp.path());

    let synced = library
        .sync_next_cloud_asset_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(synced.unwrap().status, "synced");
    assert!(library
        .cloud_sync_queue_item("queue-1")
        .unwrap()
        .unwrap()
        .synced_at
        .is_some());
    server_thread.join().unwrap();
}

#[test]
fn failed_presign_is_recorded_and_returns_the_claim_to_pending() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", server.server_addr());
    let server_thread = thread::spawn(move || {
        let request = server.recv().unwrap();
        assert_eq!(request.url(), "/v1/uploads/presign");
        request.respond(Response::empty(503)).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = library_with_pending_asset(temp.path());

    let error = library
        .sync_next_cloud_asset_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();

    assert!(matches!(error, LibraryError::CloudPresignRejected(503)));
    let item = library.cloud_sync_queue_item("queue-1").unwrap().unwrap();
    assert_eq!(item.status, "pending");
    assert_eq!(item.retry_count, 1);
    assert_eq!(
        item.last_error.as_deref(),
        Some("업로드 URL 발급 요청이 거부됐습니다: HTTP 503")
    );
    server_thread.join().unwrap();
}

#[test]
fn object_key_conflict_is_failed_and_not_selected_again() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let upload_url = format!("{origin}/r2-upload");
    let server_thread = thread::spawn(move || {
        let presign = server.recv().unwrap();
        presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": "images/00000000-0000-4000-8000-000000000001/original",
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": { "Content-Type": "image/png" }
            })))
            .unwrap();

        let mut upload = server.recv().unwrap();
        let mut bytes = Vec::new();
        upload.as_reader().read_to_end(&mut bytes).unwrap();
        upload.respond(Response::empty(200)).unwrap();

        let register = server.recv().unwrap();
        assert_eq!(register.url(), "/v1/assets");
        register.respond(Response::empty(409)).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = library_with_pending_asset(temp.path());

    let error = library
        .sync_next_cloud_asset_with(&CloudClient::new(&origin).unwrap(), "test-token")
        .unwrap_err();

    assert!(matches!(error, LibraryError::CloudObjectKeyConflict));
    let item = library.cloud_sync_queue_item("queue-1").unwrap().unwrap();
    assert_eq!(item.status, "failed");
    assert_eq!(item.retry_count, 1);
    assert!(library.claim_next_asset_upload().unwrap().is_none());
    server_thread.join().unwrap();
}

#[test]
fn refuses_to_upload_a_source_that_escapes_the_library_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let library = library_with_pending_asset(&root);
    fs::write(temp.path().join("outside.png"), b"local-image-bytes").unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET relative_path = '../outside.png' WHERE id = ?1",
            ["00000000-0000-4000-8000-000000000001"],
        )
        .unwrap();

    let error = library
        .sync_next_cloud_asset_with(
            &CloudClient::new("http://127.0.0.1:1").unwrap(),
            "test-token",
        )
        .unwrap_err();

    assert!(matches!(error, LibraryError::CloudSourceUnavailable));
    let item = library.cloud_sync_queue_item("queue-1").unwrap().unwrap();
    assert_eq!(item.status, "failed");
    assert_eq!(item.retry_count, 1);
}

#[test]
fn refuses_to_upload_a_source_that_no_longer_matches_its_hash() {
    let temp = tempfile::tempdir().unwrap();
    let library = library_with_pending_asset(temp.path());
    fs::write(temp.path().join("assets/local.png"), b"changed-bytes").unwrap();

    let error = library
        .sync_next_cloud_asset_with(
            &CloudClient::new("http://127.0.0.1:1").unwrap(),
            "test-token",
        )
        .unwrap_err();

    assert!(matches!(error, LibraryError::CloudSourceChanged));
    let item = library.cloud_sync_queue_item("queue-1").unwrap().unwrap();
    assert_eq!(item.status, "failed");
    assert_eq!(item.retry_count, 1);
}

fn library_with_pending_asset(root: &std::path::Path) -> Library {
    let library = Library::open(root).unwrap();
    fs::write(root.join("assets/local.png"), b"local-image-bytes").unwrap();
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (?1, ?2, 'image', 'local.png', 'assets/local.png',
                       'thumbnails/local.webp', 17, 1, 1, ?3)",
            (
                "00000000-0000-4000-8000-000000000001",
                sha256(b"local-image-bytes"),
                "2026-08-30T00:00:00Z",
            ),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO cloud_sync_queue (
                id, entity_type, entity_id, operation, status, revision, updated_at
             ) VALUES ('queue-1', 'asset', ?1, 'upsert', 'pending', 1, ?2)",
            (
                "00000000-0000-4000-8000-000000000001",
                "2026-08-30T00:00:00Z",
            ),
        )
        .unwrap();
    drop(connection);
    library
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn header_value<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.to_string().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn read_json(request: &mut tiny_http::Request) -> Value {
    serde_json::from_reader(request.as_reader()).unwrap()
}

fn json_response(value: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(&value).unwrap())
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

#[test]
fn catalog_publication_sends_the_stable_library_identity_header() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        assert_eq!(request.method(), &Method::Put);
        assert_eq!(request.url(), "/v1/mobile-catalog/publication");
        assert_eq!(
            header_value(&request, "authorization"),
            Some("Bearer test-token")
        );
        let library_header = header_value(&request, "x-lakomics-library-id").map(str::to_owned);
        let body = read_json(&mut request);
        request
            .respond(json_response(json!({
                "publicationRevision": "c".repeat(64),
                "publishedAt": "2026-09-14T00:00:00Z"
            })))
            .unwrap();
        (library_header, body)
    });

    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let expected = library.library_id().unwrap();
    let client = CloudClient::new(&base_url).unwrap();
    let body = json!({
        "version": 1,
        "baseRevision": Value::Null,
        "contentDigest": "d".repeat(64),
        "userSnapshot": users_snapshot_fixture()
    });
    let (revision, published) = client
        .publish_mobile_catalog(&body, "test-token", &expected)
        .unwrap();
    assert_eq!(revision, "c".repeat(64));
    assert_eq!(published, "2026-09-14T00:00:00Z");

    let (sent_header, sent_body) = server_thread.join().unwrap();
    assert_eq!(sent_header.as_deref(), Some(expected.as_str()));
    assert_eq!(sent_body, body, "publication body shape must not change");
}

/// Exact `validate_users` key set, so the body shape is asserted rather than assumed.
fn users_snapshot_fixture() -> Value {
    json!({
        "bookmarks": [],
        "hiddenCategories": [],
        "blockedTags": [],
        "preferences": [],
        "decisions": [],
        "decisionRevision": Sha256::digest(b"[]").iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
    })
}

/// B5 reads: paths, query encoding, auth, and how each HTTP status becomes a
/// recoverable state rather than a generic network failure.
#[test]
fn bookmark_reconciliation_reads_the_authority_snapshot_and_changes() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let library_id = "a".repeat(32);
    let expected_library_id = library_id.clone();
    let server_thread = thread::spawn(move || {
        let mut requests = Vec::new();

        let mut status = server.recv().unwrap();
        assert_eq!(status.method(), &Method::Get);
        assert_eq!(status.url(), "/v1/mobile-catalog/status");
        assert_eq!(
            header_value(&status, "authorization"),
            Some("Bearer test-token")
        );
        requests.push(status.url().to_owned());
        status
            .respond(json_response(json!({
                "authorityLibraryId": library_id,
                "authorityEpoch": 2,
                "authorityContractVersion": 1,
                "authorityCursor": 5
            })))
            .unwrap();

        let mut snapshot = server.recv().unwrap();
        assert_eq!(snapshot.method(), &Method::Get);
        assert_eq!(
            snapshot.url(),
            format!("/v1/mobile-catalog/bookmarks?libraryId={library_id}&epoch=2")
        );
        requests.push(snapshot.url().to_owned());
        snapshot
            .respond(json_response(json!({
                "libraryId": library_id,
                "epoch": 2,
                "contractVersion": 1,
                "cursor": 5,
                "items": [
                    {"provider":"kHentai","workId":"3","desiredState":true,"entityRevision":1,
                     "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
                    {"provider":"heliotrope","workId":"42","desiredState":false,"entityRevision":2,
                     "createdAt":null,"updatedAt":"2026-02-01T00:00:00Z"}
                ]
            })))
            .unwrap();

        let mut changes = server.recv().unwrap();
        assert_eq!(changes.method(), &Method::Get);
        assert_eq!(
            changes.url(),
            format!("/v1/mobile-catalog/bookmarks/changes?libraryId={library_id}&epoch=2&after=5&limit=100")
        );
        requests.push(changes.url().to_owned());
        changes
            .respond(json_response(json!({
                "libraryId": library_id,
                "epoch": 2,
                "contractVersion": 1,
                "cursor": 6,
                "items": [
                    {"sequence":6,"provider":"kHentai","workId":"9","desiredState":true,
                     "entityRevision":1,"operationId":"op","createdAt":"2026-03-01T00:00:00Z",
                     "updatedAt":"2026-03-01T00:00:00Z","changedAt":"2026-03-01T00:00:00Z"}
                ],
                "nextAfter": 6,
                "hasMore": false
            })))
            .unwrap();
        requests
    });

    let client = CloudClient::new(&base_url).unwrap();
    let authority = client.mobile_catalog_authority("test-token").unwrap();
    assert_eq!(
        authority.library_id.as_deref(),
        Some(expected_library_id.as_str())
    );
    assert_eq!(authority.epoch, Some(2));
    assert_eq!(authority.contract_version, Some(1));
    assert_eq!(authority.cursor, Some(5));

    let snapshot = client
        .mobile_catalog_bookmark_snapshot(&expected_library_id, 2, "test-token")
        .unwrap();
    assert_eq!(snapshot.cursor, 5);
    assert_eq!(snapshot.items.len(), 2);
    assert!(snapshot.items[0].desired_state);
    assert!(!snapshot.items[1].desired_state);

    let changes = client
        .mobile_catalog_bookmark_changes(&expected_library_id, 2, 5, 100, "test-token")
        .unwrap();
    assert_eq!(changes.next_after, 6);
    assert!(!changes.has_more);
    assert_eq!(changes.items[0].sequence, 6);

    let urls = server_thread.join().unwrap();
    assert_eq!(urls.len(), 3, "exactly three reads: {urls:?}");
}

#[test]
fn an_inactive_authority_reports_absent_metadata_without_failing() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let server_thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        // The domain is still PC-owned: every authority field is null.
        request
            .respond(json_response(json!({
                "authorityLibraryId": Value::Null,
                "authorityEpoch": Value::Null,
                "authorityContractVersion": Value::Null,
                "authorityCursor": Value::Null
            })))
            .unwrap();
    });

    let client = CloudClient::new(&base_url).unwrap();
    let authority = client.mobile_catalog_authority("test-token").unwrap();
    assert_eq!(
        authority,
        crate::cloud::client::MobileCatalogAuthority::default()
    );
    server_thread.join().unwrap();
}

#[test]
fn a_cursor_beyond_the_server_cursor_is_its_own_recovery_state() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let library_id = "a".repeat(32);
    let server_thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        request
            .respond(
                Response::from_data(b"{}".to_vec())
                    .with_status_code(409)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });

    let client = CloudClient::new(&base_url).unwrap();
    let error = client
        .mobile_catalog_bookmark_changes(&library_id, 1, 99, 100, "test-token")
        .unwrap_err();
    // Must be the documented stale-cursor state, not a generic transport error
    // that a blind retry could never resolve.
    assert!(
        matches!(error, LibraryError::CatalogBookmarkCursorAhead),
        "{error}"
    );
    server_thread.join().unwrap();
}

#[test]
fn a_coded_cursor_expiry_is_distinct_from_an_uncoded_conflict() {
    let library_id = "a".repeat(32);

    // The server's explicit retention expiry: the client must be able to tell it
    // apart, because it is the one 409 whose correct recovery is a fresh baseline.
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        request
            .respond(
                Response::from_data(
                    serde_json::to_vec(&serde_json::json!({
                        "detail": {"code": "cursorExpired", "authorityCursor": 12,
                                   "retentionDays": 180}
                    }))
                    .unwrap(),
                )
                .with_status_code(409)
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });
    let client = CloudClient::new(&base_url).unwrap();
    let error = client
        .mobile_catalog_bookmark_changes(&library_id, 1, 0, 100, "test-token")
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CatalogBookmarkCursorExpired),
        "{error}"
    );
    thread.join().unwrap();

    // A 409 that does not carry the code stays the ahead-of-server state, so a
    // transport or server change cannot silently masquerade as retention expiry.
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        request
            .respond(
                Response::from_data(
                    serde_json::to_vec(&serde_json::json!({"code": "revisionConflict"}))
                        .unwrap(),
                )
                .with_status_code(409)
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });
    let client = CloudClient::new(&base_url).unwrap();
    let error = client
        .mobile_catalog_bookmark_changes(&library_id, 1, 0, 100, "test-token")
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CatalogBookmarkCursorAhead),
        "{error}"
    );
    thread.join().unwrap();
}

#[test]
fn publication_requires_publisher_authority() {
    // The publisher credential boundary: a client-scoped credential must be
    // rejected by the publication route, and the client must surface that as an
    // authorization failure rather than retrying.
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        // The credential actually sent is the one the caller supplied: publication
        // does not silently borrow another stored credential.
        let authorization = request
            .headers()
            .iter()
            .find(|header| header.field.equiv("Authorization"))
            .map(|header| header.value.as_str().to_owned())
            .unwrap_or_default();
        assert_eq!(authorization, "Bearer client-scoped-token");
        request
            .respond(
                Response::from_data(b"{\"detail\":\"Unauthorized\"}".to_vec())
                    .with_status_code(401)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });
    let client = CloudClient::new(&base_url).unwrap();
    let error = client
        .publish_mobile_catalog(
            &serde_json::json!({"version": 1, "baseRevision": Value::Null,
                                "contentDigest": "a".repeat(64), "userSnapshot": {}}),
            "client-scoped-token",
            &"b".repeat(32),
        )
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CloudUnauthorized),
        "{error}"
    );
    thread.join().unwrap();
}

#[test]
fn authority_identity_mismatch_and_contract_skew_are_distinguishable() {
    let library_id = "a".repeat(32);

    // A 409 from the identity-bound snapshot is an identity mismatch.
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        request
            .respond(
                Response::from_data(b"{}".to_vec())
                    .with_status_code(409)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });
    let error = CloudClient::new(&base_url)
        .unwrap()
        .mobile_catalog_bookmark_snapshot(&library_id, 1, "test-token")
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CatalogBookmarkAuthorityMismatch),
        "{error}"
    );
    thread.join().unwrap();

    // A 422 is the server rejecting an unsupported contract version.
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let thread = thread::spawn(move || {
        let mut request = server.recv().unwrap();
        request
            .respond(
                Response::from_data(b"{}".to_vec())
                    .with_status_code(422)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
            )
            .unwrap();
    });
    let error = CloudClient::new(&base_url)
        .unwrap()
        .mobile_catalog_bookmark_snapshot(&library_id, 1, "test-token")
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CatalogBookmarkContractUnsupported),
        "{error}"
    );
    thread.join().unwrap();
}

#[test]
fn a_transient_transport_failure_stays_retryable() {
    let library_id = "a".repeat(32);
    // Nothing is listening on this port, so this is a genuine transport failure.
    let error = CloudClient::new("http://127.0.0.1:1")
        .unwrap()
        .mobile_catalog_bookmark_changes(&library_id, 1, 0, 100, "test-token")
        .unwrap_err();
    assert!(
        matches!(error, LibraryError::CloudRequestUnavailable),
        "{error}"
    );
}

/// B6 writes: the exact B4 payload on the wire, and how each rejection becomes a
/// recoverable typed state instead of a generic network error.
mod bookmark_command {
    use super::*;
    use crate::cloud::client::MobileCatalogBookmarkCommand;

    const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn command(operation_id: &str) -> MobileCatalogBookmarkCommand {
        MobileCatalogBookmarkCommand {
            library_id: LIBRARY.to_owned(),
            epoch: 2,
            contract_version: 1,
            operation_id: operation_id.to_owned(),
            expected_revision: 4,
            desired_state: true,
        }
    }

    fn result_body(operation: &str) -> Value {
        json!({
            "libraryId": LIBRARY,
            "epoch": 2,
            "contractVersion": 1,
            "provider": "kHentai",
            "workId": "7",
            "desiredState": true,
            "entityRevision": 5,
            "changed": true,
            "changeSequence": 6,
            "authorityCursor": 6,
            "createdAt": "2026-09-15T00:00:00Z",
            "updatedAt": "2026-09-15T00:00:00Z",
            "operationId": operation
        })
    }

    /// The request is a `PUT` to the identity path with exactly the B4 key set,
    /// and the body preserves the caller's operation id verbatim.
    #[test]
    fn sends_the_exact_b4_payload_and_path() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", server.server_addr());
        let operation = "00000000-0000-4000-8000-000000000001";
        let server_thread = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            assert_eq!(request.method(), &Method::Put);
            assert_eq!(request.url(), "/v1/mobile-catalog/bookmarks/kHentai/7");
            assert_eq!(
                header_value(&request, "authorization"),
                Some("Bearer test-token")
            );
            assert_eq!(
                header_value(&request, "content-type"),
                Some("application/json")
            );
            let body = read_json(&mut request);
            assert_eq!(
                body,
                json!({
                    "libraryId": LIBRARY, "epoch": 2, "contractVersion": 1,
                    "operationId": operation, "expectedRevision": 4, "desiredState": true
                })
            );
            request
                .respond(json_response(result_body(operation)))
                .unwrap();
        });

        let client = CloudClient::new(&base_url).unwrap();
        let sent = command(operation);
        let confirmed = client
            .mobile_catalog_bookmark_command("kHentai", "7", &sent, "test-token")
            .unwrap();
        assert_eq!(confirmed.entity_revision, 5);
        assert!(confirmed.changed);
        assert_eq!(confirmed.desired_state, true);
        server_thread.join().unwrap();
    }

    /// A stale `expectedRevision` must surface the authority's current state, not a
    /// generic conflict: the caller rebases on that revision.
    #[test]
    fn a_revision_conflict_carries_the_current_authoritative_state() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", server.server_addr());
        let server_thread = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let _ = read_json(&mut request);
            request
                .respond(
                    Response::from_data(
                        serde_json::to_vec(&json!({
                            "detail": {
                                "code": "revisionConflict",
                                "authorityCursor": 9,
                                "current": {
                                    "provider": "kHentai", "workId": "7",
                                    "desiredState": false, "entityRevision": 6,
                                    "createdAt": "2026-01-01T00:00:00Z",
                                    "updatedAt": "2026-09-15T00:00:00Z"
                                }
                            }
                        }))
                        .unwrap(),
                    )
                    .with_status_code(409)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
                )
                .unwrap();
        });

        let client = CloudClient::new(&base_url).unwrap();
        let error = client
            .mobile_catalog_bookmark_command(
                "kHentai",
                "7",
                &command("00000000-0000-4000-8000-000000000002"),
                "test-token",
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            LibraryError::CatalogBookmarkRevisionConflict {
                current_revision: 6,
                current_desired_state: false
            }
            .to_string()
        );
        assert!(matches!(
            error,
            LibraryError::CatalogBookmarkRevisionConflict {
                current_revision: 6,
                current_desired_state: false
            }
        ));
        server_thread.join().unwrap();
    }

    /// A 409 without the conflict detail is authority/epoch skew, which a retry
    /// cannot fix and which must not be mistaken for a revision conflict.
    #[test]
    fn a_409_without_conflict_detail_is_an_authority_mismatch() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", server.server_addr());
        let server_thread = thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(
                    Response::from_data(b"{}".to_vec())
                        .with_status_code(409)
                        .with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        ),
                )
                .unwrap();
        });

        let error = CloudClient::new(&base_url)
            .unwrap()
            .mobile_catalog_bookmark_command(
                "kHentai",
                "7",
                &command("00000000-0000-4000-8000-000000000003"),
                "test-token",
            )
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::CatalogBookmarkAuthorityMismatch),
            "{error}"
        );
        server_thread.join().unwrap();
    }

    /// Every remaining rejection keeps its own typed state.
    #[test]
    fn authorization_contract_and_transport_failures_stay_distinct() {
        for (status, expected) in [
            (401u16, LibraryError::CloudUnauthorized),
            (403, LibraryError::CloudUnauthorized),
            (422, LibraryError::CatalogBookmarkContractUnsupported),
        ] {
            let server = Server::http("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}/v1", server.server_addr());
            let server_thread = thread::spawn(move || {
                let request = server.recv().unwrap();
                request.respond(Response::empty(status)).unwrap();
            });
            let error = CloudClient::new(&base_url)
                .unwrap()
                .mobile_catalog_bookmark_command(
                    "kHentai",
                    "7",
                    &command("00000000-0000-4000-8000-000000000004"),
                    "test-token",
                )
                .unwrap_err();
            assert!(
                std::mem::discriminant(&error) == std::mem::discriminant(&expected),
                "status {status}: {error}"
            );
            server_thread.join().unwrap();
        }

        // Nothing listening: a genuine transport failure, still retryable.
        let error = CloudClient::new("http://127.0.0.1:1")
            .unwrap()
            .mobile_catalog_bookmark_command(
                "kHentai",
                "7",
                &command("00000000-0000-4000-8000-000000000005"),
                "test-token",
            )
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::CloudRequestUnavailable),
            "{error}"
        );
    }

    /// An ambiguous or hostile server response is rejected rather than trusted:
    /// a result for another entity must not be applied as this one's state.
    #[test]
    fn a_result_for_another_entity_is_rejected() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", server.server_addr());
        let operation = "00000000-0000-4000-8000-000000000006";
        let server_thread = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let _ = read_json(&mut request);
            let mut body = result_body(operation);
            body["workId"] = json!("8");
            request.respond(json_response(body)).unwrap();
        });
        let error = CloudClient::new(&base_url)
            .unwrap()
            .mobile_catalog_bookmark_command("kHentai", "7", &command(operation), "test-token")
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::InvalidCloudResponse),
            "{error}"
        );
        server_thread.join().unwrap();
    }

    /// The exact stored work id is preserved on the wire, including an id whose
    /// leading zero would collide with another entity if it were normalized.
    #[test]
    fn keeps_exact_work_identity_in_the_path() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", server.server_addr());
        let operation = "00000000-0000-4000-8000-000000000007";
        let server_thread = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            assert_eq!(request.url(), "/v1/mobile-catalog/bookmarks/kHentai/07");
            let mut body = result_body(operation);
            body["workId"] = json!("07");
            request.respond(json_response(body)).unwrap();
        });
        let confirmed = CloudClient::new(&base_url)
            .unwrap()
            .mobile_catalog_bookmark_command("kHentai", "07", &command(operation), "test-token")
            .unwrap();
        assert_eq!(confirmed.work_id, "07");
        server_thread.join().unwrap();
    }
}
