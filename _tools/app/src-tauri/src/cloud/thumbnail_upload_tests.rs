use super::{
    client::CloudClient,
    thumbnail_upload::{self, Journal, Thumbnail},
};
use serde_json::{json, Value};
use std::{thread, time::Duration};
use tiny_http::{Response, Server};

fn recv(server: &Server) -> tiny_http::Request {
    server
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .expect("request deadline")
}
fn body(request: &mut tiny_http::Request) -> Value {
    serde_json::from_reader(request.as_reader()).unwrap()
}
fn reply(request: tiny_http::Request, status: u16, body: Value) {
    request
        .respond(Response::from_string(body.to_string()).with_status_code(status))
        .unwrap();
}
fn prepared(origin: &str, manifest: &Value, committed: bool) -> Value {
    json!({"asset_id": "asset", "upload_id": "upload", "committed": committed,
        "thumbnail_key": format!("derived/library-thumbnails/v1/{}.webp", manifest["sha256"].as_str().unwrap()),
        "upload_url": if committed { Value::Null } else { json!(format!("{origin}/temp")) },
        "required_headers": {"Content-Type": "image/webp", "Content-Length": manifest["size_bytes"].as_u64().unwrap().to_string()}})
}

#[test]
fn thumbnail_manifest_matches_uploaded_buffer_and_resumes_after_lost_commit_response() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let client = CloudClient::new(&origin).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"same exact thumbnail buffer".to_vec();
    let expected = bytes.clone();
    let handle = thread::spawn(move || {
        let mut request = recv(&server);
        assert_eq!(request.url(), "/v1/replication/thumbnails/prepare");
        let manifest = body(&mut request);
        assert_eq!(manifest["sha256"], thumbnail_upload::digest(&expected));
        assert_eq!(manifest["size_bytes"], expected.len());
        reply(request, 200, prepared(&origin, &manifest, false));
        let mut request = recv(&server);
        assert_eq!(request.url(), "/temp");
        assert_eq!(request.method().as_str(), "PUT");
        let mut actual = Vec::new();
        request.as_reader().read_to_end(&mut actual).unwrap();
        assert_eq!(actual, expected);
        reply(request, 200, json!({}));
        let mut request = recv(&server);
        assert_eq!(request.url(), "/v1/replication/thumbnails/commit");
        let commit = body(&mut request);
        // The server applied the operation, but the acknowledgement is unusable.
        request
            .respond(Response::from_string("lost response").with_status_code(200))
            .unwrap();
        let mut request = recv(&server);
        assert_eq!(request.url(), "/v1/replication/thumbnails/prepare");
        assert_eq!(body(&mut request), manifest);
        reply(request, 200, prepared(&origin, &manifest, true));
        let mut request = recv(&server);
        assert_eq!(request.url(), "/v1/replication/thumbnails/commit");
        assert_eq!(body(&mut request), commit);
        reply(
            request,
            200,
            json!({"ok": true, "asset_id": "asset", "upload_id": "upload"}),
        );
    });
    let journal = client
        .thumbnail_journal(temp.path(), "refresh:asset")
        .unwrap();
    assert!(thumbnail_upload::refresh(&client, &journal, "asset", bytes.clone(), "token").is_err());
    let operation_id = journal.load().unwrap().unwrap().operation_id;
    drop(journal);
    let journal = client
        .thumbnail_journal(temp.path(), "refresh:asset")
        .unwrap();
    assert_eq!(journal.load().unwrap().unwrap().operation_id, operation_id);
    thumbnail_upload::refresh(&client, &journal, "asset", bytes, "token").unwrap();
    assert!(journal.load().unwrap().is_none());
    handle.join().unwrap();
}

#[test]
fn thumbnail_legacy_fallback_requires_unknown_route_and_stops_at_blocked_presign() {
    for blocked in [false, true] {
        let server = Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr());
        let client = CloudClient::new(&origin).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let handle = thread::spawn(move || {
            let request = recv(&server);
            assert_eq!(request.url(), "/v1/replication/thumbnails/prepare");
            reply(request, 404, json!({"detail": "Not Found"}));
            let mut request = recv(&server);
            assert_eq!(request.url(), "/v1/uploads/presign");
            let manifest = body(&mut request);
            if blocked {
                reply(
                    request,
                    409,
                    json!({"detail": {"code": "thumbnailUpgradeRequired"}}),
                );
            } else {
                reply(
                    request,
                    200,
                    json!({"method": "PUT", "object_key": manifest["object_key"],
                    "upload_url": format!("{origin}/legacy"), "expires_in": 600,
                    "required_headers": {"Content-Type": "image/webp"}}),
                );
                let request = recv(&server);
                assert_eq!(request.url(), "/legacy");
                reply(request, 200, json!({}));
            }
            assert!(server
                .recv_timeout(Duration::from_millis(100))
                .unwrap()
                .is_none());
        });
        let journal = client.thumbnail_journal(temp.path(), "new:asset").unwrap();
        let result = thumbnail_upload::upload(&client, &journal, "asset", b"abc".to_vec(), "token");
        if blocked {
            assert!(result.is_err());
        } else {
            let Thumbnail::Legacy(variant) = result.unwrap() else {
                panic!("expected legacy")
            };
            assert_eq!(variant.size_bytes, 3);
            assert_eq!(variant.sha256.unwrap(), thumbnail_upload::digest(b"abc"));
        }
        handle.join().unwrap();
    }
}

#[test]
fn thumbnail_never_falls_back_for_blocked_resource_missing_or_transient_errors() {
    for (status, detail) in [
        (409, json!({"code": "thumbnailUpgradeRequired"})),
        (404, json!({"code": "thumbnailAssetNotPrepared"})),
        (503, json!({"code": "thumbnailStorageUnavailable"})),
        (401, json!("Unauthorized")),
        (422, json!("invalid bytes")),
    ] {
        let server = Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let handle = thread::spawn(move || {
            let request = recv(&server);
            reply(request, status, json!({"detail": detail}));
            assert!(server
                .recv_timeout(Duration::from_millis(100))
                .unwrap()
                .is_none());
        });
        let journal = client.thumbnail_journal(temp.path(), "new:asset").unwrap();
        assert!(
            thumbnail_upload::upload(&client, &journal, "asset", b"abc".to_vec(), "token").is_err()
        );
        handle.join().unwrap();
    }
}

#[test]
fn thumbnail_expired_session_gets_a_new_persisted_operation_on_retry() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let client = CloudClient::new(&origin).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let handle = thread::spawn(move || {
        let mut request = recv(&server);
        let first = body(&mut request);
        reply(
            request,
            410,
            json!({"detail": {"code": "thumbnailSessionExpired"}}),
        );
        let mut request = recv(&server);
        let second = body(&mut request);
        assert_ne!(first["operation_id"], second["operation_id"]);
        reply(request, 200, prepared(&origin, &second, true));
    });
    let journal = client.thumbnail_journal(temp.path(), "new:asset").unwrap();
    assert!(
        thumbnail_upload::upload(&client, &journal, "asset", b"abc".to_vec(), "token").is_err()
    );
    assert!(journal.load().unwrap().is_none());
    assert!(thumbnail_upload::upload(&client, &journal, "asset", b"abc".to_vec(), "token").is_ok());
    handle.join().unwrap();
}

#[test]
fn thumbnail_journal_is_scoped_to_server_and_work_and_reopens_durably() {
    let temp = tempfile::tempdir().unwrap();
    let journal = Journal::open(temp.path(), "server-a", "queue-a").unwrap();
    let operation = thumbnail_upload::Operation {
        operation_id: "persisted".into(),
        sha256: "hash".into(),
        size_bytes: 3,
        commit: None,
    };
    journal.save(&operation).unwrap();
    drop(journal);
    assert_eq!(
        Journal::open(temp.path(), "server-a", "queue-a")
            .unwrap()
            .load()
            .unwrap()
            .unwrap()
            .operation_id,
        "persisted"
    );
    assert!(Journal::open(temp.path(), "server-b", "queue-a")
        .unwrap()
        .load()
        .unwrap()
        .is_none());
    assert!(Journal::open(temp.path(), "server-a", "queue-b")
        .unwrap()
        .load()
        .unwrap()
        .is_none());
}

#[test]
fn thumbnail_invalid_buffers_fail_before_any_network_or_operation_creation() {
    let temp = tempfile::tempdir().unwrap();
    let client = CloudClient::new("http://127.0.0.1:1").unwrap();
    let journal = client.thumbnail_journal(temp.path(), "new:asset").unwrap();
    for bytes in [Vec::new(), vec![0; thumbnail_upload::MAX_BYTES + 1]] {
        assert!(matches!(
            thumbnail_upload::upload(&client, &journal, "asset", bytes, "token"),
            Err(crate::library::error::LibraryError::CloudThumbnailUnavailable)
        ));
        assert!(journal.load().unwrap().is_none());
    }
}
