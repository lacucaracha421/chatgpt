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
