use super::*;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,
         thumbnail_relative_path,byte_size,width,height,collected_at)
         VALUES('a','hash','image','a.png','assets/a.png','thumbnails/a.webp',1,1,1,'t')",
            [],
        )
        .unwrap();
    (temp, library)
}

fn text(korean: &str) -> AssetImageText {
    validate(&json!([{"original":"hello", "korean":korean}])).unwrap()
}

fn server_response(status: u16, value: Value) -> (CloudClient, std::thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let client = CloudClient::new(&format!("http://{}/v1", server.server_addr())).unwrap();
    let handle = std::thread::spawn(move || {
        let request = server
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert_eq!(request.method().as_str(), "GET");
        assert_eq!(request.url(), "/v1/library/assets/a/image-text");
        assert!(request
            .headers()
            .iter()
            .any(|h| h.field.equiv("Authorization") && h.value.as_str() == "Bearer test"));
        request
            .respond(tiny_http::Response::from_string(value.to_string()).with_status_code(status))
            .unwrap();
    });
    (client, handle)
}

#[test]
fn image_text_validation_caps_and_unicode() {
    let mut rows = vec![
        json!({"original": "a".repeat(801), "korean":"invalid"}),
        json!({"original":"ok", "korean":"   "}),
        json!({"original":3,"korean":"invalid"}),
    ];
    rows.extend(
        (0..65)
            .map(|_| json!({"original":"界".repeat(800),"korean":"한".repeat(800),"future":true})),
    );
    let result = validate(&json!(rows)).unwrap();
    assert_eq!(result.lines.len(), 60);
    assert_eq!(result.lines[0].original.chars().count(), 800);
    assert!(validate(&json!([{"original":"a", "korean":"한".repeat(801)}])).is_none());
    assert!(validate(&json!({})).is_none());
    assert!(validate(&json!([])).is_none());
    assert!(validate(&json!([null, false, 12, {"original":"a"}])).is_none());
}

#[test]
fn image_text_invalid_boxes_are_dropped_without_losing_lines() {
    for bounds in [
        json!({"x0":0,"y0":0,"x1":1001,"y1":1000}),
        json!({"x0":0,"y0":0,"x1":0,"y1":1000}),
        json!({"x0":0,"y0":100,"x1":1000,"y1":100}),
        json!({"x0":-1,"y0":0,"x1":10,"y1":10}),
        json!({"x0":false,"y0":0,"x1":10,"y1":10}),
        json!({"x0":0.0,"y0":0,"x1":10,"y1":10}),
        json!({"x0":0,"y0":0,"x1":10}),
        json!("bad"),
        Value::Null,
    ] {
        let result = validate(&json!([{"original":"", "korean":" 한글 ", "box":bounds}])).unwrap();
        assert_eq!(result.lines[0].korean, "한글");
        assert!(result.lines[0].r#box.is_none());
    }
    let result = validate(&json!([{"original":"hello", "korean":"안녕", "box":{"x0":0,"y0":0,"x1":1000,"y1":1000,"future":1}}])).unwrap();
    assert_eq!(result.lines[0].r#box.as_ref().unwrap().x1, 1000);
}

#[test]
fn image_text_canonical_payload_matches_server_digest() {
    let result = validate(&json!([{"original":" hello ", "korean":" 안녕 ", "box":{"x0":0,"y0":10,"x1":1000,"y1":900}}])).unwrap();
    let expected =
        r#"[{"box":{"x0":0,"x1":1000,"y0":10,"y1":900},"korean":"안녕","original":"hello"}]"#;
    assert_eq!(canonical_payload(&result.lines), expected);
    let digest: String = Sha256::digest(expected.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(result.digest, digest);
}

#[test]
fn image_text_local_read_replace_and_unchanged_digest() {
    let (_temp, library) = fixture();
    assert_eq!(library.asset_image_text("a").unwrap(), None);
    library.store_asset_image_text("a", &text("first")).unwrap();
    library
        .connection()
        .unwrap()
        .execute("UPDATE asset_image_text SET updated_at='unchanged'", [])
        .unwrap();
    library.store_asset_image_text("a", &text("first")).unwrap();
    let at: String = library
        .connection()
        .unwrap()
        .query_row("SELECT updated_at FROM asset_image_text", [], |r| r.get(0))
        .unwrap();
    assert_eq!(at, "unchanged");
    library
        .store_asset_image_text("a", &text("second"))
        .unwrap();
    assert_eq!(library.asset_image_text("a").unwrap(), Some(text("second")));
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM assets WHERE id='a'", [])
        .unwrap();
    assert_eq!(library.asset_image_text("a").unwrap(), None);
}

#[test]
fn image_text_refresh_replaces_without_asset_event_and_404_deletes() {
    let (_temp, library) = fixture();
    library.store_asset_image_text("a", &text("old")).unwrap();
    let new = text("new");
    let (client, handle) = server_response(200, serde_json::to_value(&new).unwrap());
    assert_eq!(
        library
            .refresh_asset_image_text_with("a", &client, "test")
            .unwrap(),
        Some(new.clone())
    );
    handle.join().unwrap();
    assert_eq!(library.asset_image_text("a").unwrap(), Some(new));
    let (client, handle) = server_response(404, Value::Null);
    assert_eq!(
        library
            .refresh_asset_image_text_with("a", &client, "test")
            .unwrap(),
        None
    );
    handle.join().unwrap();
    assert_eq!(library.asset_image_text("a").unwrap(), None);
}

#[test]
fn image_text_refresh_errors_preserve_cache() {
    let (_temp, library) = fixture();
    let old = text("old");
    library.store_asset_image_text("a", &old).unwrap();
    for (status, body) in [
        (500, Value::Null),
        (401, Value::Null),
        (200, json!({"lines":old.lines,"digest":"bad"})),
        (200, json!({"lines":"bad", "digest":"bad"})),
    ] {
        let (client, handle) = server_response(status, body);
        assert!(library
            .refresh_asset_image_text_with("a", &client, "test")
            .is_err());
        handle.join().unwrap();
        assert_eq!(library.asset_image_text("a").unwrap(), Some(old.clone()));
    }
}

#[test]
fn image_text_refresh_without_cloud_returns_local_cache() {
    let (_temp, library) = fixture();
    library.store_asset_image_text("a", &text("local")).unwrap();
    assert_eq!(
        library.refresh_asset_image_text("a").unwrap(),
        Some(text("local"))
    );
}

#[test]
fn image_text_configured_refresh_uses_client_credential_and_returns_new_value() {
    let (_temp, library) = fixture();
    library.store_asset_image_text("a", &text("old")).unwrap();
    let new = text("new");
    let (client, handle) = server_response(200, serde_json::to_value(&new).unwrap());
    library
        .set_cloud_settings(
            crate::cloud::models::CloudSyncConfig {
                // Read-only refresh remains available with outbound replication disabled.
                enabled: false,
                api_base_url: Some(client.base().into()),
            },
            true,
        )
        .unwrap();
    // Unit-test credentials are thread-local and never touch the OS store.
    crate::library::credential::set_cloud_api_token_os("test").unwrap();
    let result = library.refresh_asset_image_text("a");
    crate::library::credential::delete_cloud_api_token_os().unwrap();
    assert_eq!(result.unwrap(), Some(new));
    handle.join().unwrap();
    // A configured URL without a credential still gives the viewer its cached text.
    assert!(library.refresh_asset_image_text("a").unwrap().is_some());
}
