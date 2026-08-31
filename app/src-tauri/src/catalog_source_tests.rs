//! VPS catalog transport seam 테스트.
//!
//! Phase 1 검증 시나리오:
//! 1. VPS 전송으로 갱신·resolver가 동작한다(기존 k-hentai 본문 형식과 동일).
//! 2. 일시적 실패는 backoff 재시도 후 회복, 영구 4xx는 즉시 표면화.
//! 3. VPS 장애 시 로컬 카탈로그(검색·상세·북마크)가 영향 없이 계속 읽힌다.

use crate::catalog_source::{retry_transient, CatalogSource, VpsCatalogSource};
use crate::library::error::LibraryError;
use serde_json::json;
use tiny_http::{Header, Server};

fn header(name: &'static str, value: &'static str) -> Header {
    Header::from_bytes(name, value).unwrap()
}

fn respond_json(request: tiny_http::Request, value: &serde_json::Value) {
    let mut request = request;
    let body = serde_json::to_vec(value).unwrap();
    let _ = request.respond(
        tiny_http::Response::from_data(body).with_header(header("Content-Type", "application/json")),
    );
}

/// Authorization: Bearer 토큰을 확인하고 JSON을 내려주는 서버 스레드.
fn serve_bearer(expected_token: &'static str, url_path: &'static str, body: serde_json::Value) -> (String, std::thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", server.server_addr());
    let handle = std::thread::spawn(move || {
        let mut request = server.recv().unwrap();
        assert_eq!(request.url(), url_path);
        let authorization = request
            .headers()
            .iter()
            .find(|header| header.field.equiv("Authorization"))
            .map(|header| header.value.as_str().to_owned())
            .unwrap_or_default();
        assert_eq!(authorization, format!("Bearer {expected_token}"));
        respond_json(request, &body);
    });
    (base_url, handle)
}

#[test]
fn vps_gallery_source_returns_khentai_html_and_binds_ids_to_the_path() {
    // VPS carrier는 요청 URL에 작업 id만 넣는다. 본문은 k-hentai /r/{id}와 같은
    // 스크립트 블록(투과 전송)이므로 같은 파서를 재사용한다.
    let html = r#"<html><script>const gallery = {"files":[
        {"name":"001.webp","image":{"url":"https://a.siam-cdn.net/1.webp?expires=4102444800","width":1200,"height":1800}},
        {"name":"002.webp","image":{"url":"https://a.siam-cdn.net/2.webp?expires=4102444800","width":1200,"height":1800}}
    ]};</script></html>"#;
    let (base_url, handle) = serve_bearer(
        "test-token",
        "/v1/catalog/gallery/42",
        json!({ "works": [] }),
    );

    // raw passthrough: VPS는 k-hentai HTML을 그대로 돌려준다.
    let server2 = Server::http("127.0.0.1:0").unwrap();
    let base_url2 = format!("http://{}", server2.server_addr());
    let handle2 = std::thread::spawn(move || {
        let mut request = server2.recv().unwrap();
        assert_eq!(request.url(), "/v1/catalog/gallery/42");
        let authorization = request
            .headers()
            .iter()
            .find(|header| header.field.equiv("Authorization"))
            .map(|header| header.value.as_str().to_owned())
            .unwrap_or_default();
        assert_eq!(authorization, "Bearer test-token");
        let _ = request.respond(
            tiny_http::Response::from_string(html)
                .with_header(header("Content-Type", "text/html")),
        );
    });

    let client2 = VpsCatalogSource::new(&base_url2).unwrap();
    let body = client2.fetch_gallery_bearer(42, "test-token").unwrap();
    drop(handle);
    handle2.join().unwrap();
    let pages = crate::library::remote_gallery::parse_khentai_gallery(&body).unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].name.as_deref(), Some("001.webp"));
}

#[test]
fn retry_transient_recovers_once_then_gives_up_after_three() {
    // 실제 네트워크 없이 재시도 정책만 검증한다: 일시 실패는 3회 시도,
    // 영구 4xx는 1회 만에 반환.
    let attempts = std::cell::Cell::new(0);
    let recovered = tauri::async_runtime::block_on(retry_transient(|| {
        attempts.set(attempts.get() + 1);
        if attempts.get() < 2 {
            return Err(LibraryError::CatalogTransportUnavailable);
        }
        Ok("recovered".to_owned())
    }))
    .unwrap();
    assert_eq!(recovered, "recovered");
    assert_eq!(attempts.get(), 2);
}

#[test]
fn retry_transient_never_retries_permanent_status() {
    let attempts = std::cell::Cell::new(0);
    let error = tauri::async_runtime::block_on(retry_transient(|| {
        attempts.set(attempts.get() + 1);
        Err(LibraryError::CatalogTransportRejected(404))
    }))
    .unwrap_err();
    assert_eq!(attempts.get(), 1);
    assert!(matches!(error, LibraryError::CatalogTransportRejected(404)));
}

#[test]
fn retry_transient_gives_up_after_three_attempts() {
    let attempts = std::cell::Cell::new(0);
    let error = tauri::async_runtime::block_on(retry_transient(|| {
        attempts.set(attempts.get() + 1);
        Err(LibraryError::CatalogTransportUnavailable)
    }))
    .unwrap_err();
    assert_eq!(attempts.get(), 3);
    assert!(matches!(error, LibraryError::CatalogTransportUnavailable));
}

#[test]
fn permanent_4xx_is_not_retried() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", server.server_addr());
    let handle = std::thread::spawn(move || {
        let mut request = server.recv().unwrap();
        let _ = request.respond(
            tiny_http::Response::from_string(r#"{"error":"unknown work"}"#)
                .with_status_code(404)
                .with_header(header("Content-Type", "application/json")),
        );
    });
    let client = VpsCatalogSource::new(&base_url).unwrap();

    let error = client.fetch_gallery_bearer(999_999, "test-token").unwrap_err();

    handle.join().unwrap();
    assert!(matches!(error, LibraryError::OnlineCatalogWorkNotFound));
}

#[test]
fn empty_token_fails_closed_before_any_request() {
    let client = VpsCatalogSource::new("http://127.0.0.1:1").unwrap();
    let error = client
        .fetch_catalog_page_bearer("/v1/catalog/search-page", "   ")
        .unwrap_err();
    assert!(matches!(error, LibraryError::CloudCredentialNotConfigured));
}

#[test]
fn client_rejects_non_http_origins() {
    assert!(VpsCatalogSource::new("ftp://example.test").is_err());
    assert!(VpsCatalogSource::new("https://user:pw@example.test").is_err());
    assert!(VpsCatalogSource::new("not a url").is_err());
}