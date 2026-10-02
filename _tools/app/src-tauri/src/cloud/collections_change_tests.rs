use super::*;
use tiny_http::{Response, Server};

fn fixture() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path()).unwrap();
    library.connection().unwrap().execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('g','Game','game','2026','2026')").unwrap();
    (dir, library)
}

#[test]
fn publication_digest_ignores_transport_revision_and_timestamp_only_writes() {
    let (_dir, library) = fixture();
    let first = library
        .cloud_collections_snapshot(Some("r1".into()), &|_| {})
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute("UPDATE collections SET updated_at='later' WHERE id='g'", [])
        .unwrap();
    let second = library
        .cloud_collections_snapshot(Some("r2".into()), &|_| {})
        .unwrap();
    assert_eq!(
        snapshot_digest(&first.replica).unwrap(),
        snapshot_digest(&second.replica).unwrap()
    );
    library
        .connection()
        .unwrap()
        .execute("UPDATE collections SET name='Changed' WHERE id='g'", [])
        .unwrap();
    let changed = library
        .cloud_collections_snapshot(Some("r2".into()), &|_| {})
        .unwrap();
    assert_ne!(
        snapshot_digest(&first.replica).unwrap(),
        snapshot_digest(&changed.replica).unwrap()
    );
}

#[test]
fn publication_receipts_invalidate_on_remote_revision_or_safety_deadline() {
    let receipt = PublishedSnapshot {
        digest: "d".into(),
        revision: "r1".into(),
        checked_at: 100,
        blobs: Default::default(),
    };
    assert!(receipt.current(Some("r1"), 100 + ARTWORK_RECHECK_SECS - 1));
    assert!(!receipt.current(Some("r1"), 100 + ARTWORK_RECHECK_SECS));
    assert!(!receipt.current(Some("r2"), 101));
    assert!(!receipt.current(None, 101));
}

#[test]
fn unchanged_publication_survives_restart_and_changed_metadata_reuses_verified_blobs() {
    let (dir, library) = fixture();
    std::fs::create_dir_all(dir.path().join("work-artwork")).unwrap();
    std::fs::write(
        dir.path().join("work-artwork/cover.png"),
        b"\x89PNG\r\n\x1a\nfixture",
    )
    .unwrap();
    library.connection().unwrap().execute_batch("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('art','g','local','cover','cover','work-artwork/cover.png','image/png',1,1,1,'2026','2026')").unwrap();
    let server = Server::http("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", server.server_addr());
    let client = CloudClient::new(&endpoint).unwrap();
    let worker = std::thread::spawn(move || {
        let request = server
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(request.url(), "/v1/collections/artworks/check");
        request
            .respond(Response::from_string(r#"{"missing":[]}"#))
            .unwrap();
        for revision in ["r1", "r2"] {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), "/v1/collections/replica");
            request
                .respond(Response::from_string(format!(
                    "{{\"revision\":\"{revision}\"}}"
                )))
                .unwrap();
        }
        let mut request = server
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(request.url(), "/v1/collections/artworks/check");
        let body: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
        assert_eq!(
            body["items"].as_array().unwrap().len(),
            1,
            "only the new blob is checked"
        );
        request
            .respond(Response::from_string(r#"{"missing":[]}"#))
            .unwrap();
        let request = server
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(request.url(), "/v1/collections/replica");
        request
            .respond(Response::from_string(r#"{"revision":"r3"}"#))
            .unwrap();
        assert!(server
            .recv_timeout(std::time::Duration::from_millis(200))
            .unwrap()
            .is_none());
    });
    let first = library.cloud_collections_snapshot(None, &|_| {}).unwrap();
    assert_eq!(
        library
            .publish_changed_snapshot(&client, &endpoint, "token", "token", &first, &|_| {})
            .unwrap()
            .revision,
        "r1"
    );
    drop(library);
    let library = Library::open(dir.path()).unwrap();
    let same = library
        .cloud_collections_snapshot(Some("r1".into()), &|_| {})
        .unwrap();
    assert_eq!(
        library
            .publish_changed_snapshot(&client, &endpoint, "token", "token", &same, &|_| {})
            .unwrap()
            .uploaded,
        0
    );
    library
        .connection()
        .unwrap()
        .execute("UPDATE collections SET name='Changed' WHERE id='g'", [])
        .unwrap();
    let changed = library
        .cloud_collections_snapshot(Some("r1".into()), &|_| {})
        .unwrap();
    assert_eq!(
        library
            .publish_changed_snapshot(&client, &endpoint, "token", "token", &changed, &|_| {})
            .unwrap()
            .revision,
        "r2"
    );
    std::fs::write(
        dir.path().join("work-artwork/hero.png"),
        b"\x89PNG\r\n\x1a\nnew fixture",
    )
    .unwrap();
    library.connection().unwrap().execute_batch("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('hero','g','local','hero','hero','work-artwork/hero.png','image/png',1,1,1,'2026','2026')").unwrap();
    let new_artwork = library
        .cloud_collections_snapshot(Some("r2".into()), &|_| {})
        .unwrap();
    assert_eq!(
        library
            .publish_changed_snapshot(&client, &endpoint, "token", "token", &new_artwork, &|_| {})
            .unwrap()
            .revision,
        "r3"
    );
    worker.join().unwrap();
}
