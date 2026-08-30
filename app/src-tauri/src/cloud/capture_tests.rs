use std::{
    fs,
    io::Read,
    thread,
};

use image::{DynamicImage, ImageBuffer, Rgb};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

use super::client::CloudClient;
use crate::library::{error::LibraryError, models::IngestOutcome, Library};

// 클라우드 캡처 수신함(원격 → 로컬) 계약 테스트. fake VPS가 capture 목록,
// 다운로드 티켓, 미디어, imported acknowledge 순서를 검증한다.
// cloud_sync_queue(로컬 → 클라우드)와 개념·상태가 분리됨도 함께 확인한다.

fn png_bytes() -> Vec<u8> {
    // 동일한 내용의 PNG를 만들어 중복 검사가 결정적으로 동작하게 한다.
    let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(8, 8, |x, _y| {
        Rgb([(x * 16 % 256) as u8, 32, 200])
    }));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

fn pending_capture_json(id: &str) -> Value {
    json!({
        "id": id,
        "kind": "image",
        "object_key": format!("captures/{id}/original"),
        "content_type": "image/png",
        "size_bytes": null,
        "source_url": "https://x.com/example/status/123/photo/1",
        "creator_handle": "example",
        "source_published_at": "2026-05-01T10:00:00Z",
        "created_at": "2026-08-30T00:00:00Z",
    })
}

fn download_ticket(server_addr: String) -> Value {
    json!({
        "method": "GET",
        "download_url": format!("http://{server_addr}/r2-download/capture-original"),
        "required_headers": { "x-test-required": "ticket-value" }
    })
}

enum AcknowledgeMode {
    Succeed,
    FailWith(u16),
    Never,
}

enum PendingListMode {
    OneCapture,
    Malformed,
    ServerError(u16),
}

/// fake VPS 플로우: 목록 → 티켓 → 미디어 GET → (acknowledge) 요청 순서를 검증하고
/// 설정된 모드대로 응답한다. acknowledge에 도달하지 않으면 N개의 요청만 온다.
fn serve_capture_flow(
    capture_id: &'static str,
    media: Vec<u8>,
    list_mode: PendingListMode,
    acknowledge: AcknowledgeMode,
) -> (String, thread::JoinHandle<Vec<String>>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let (urls_tx, urls_rx) = std::sync::mpsc::channel::<String>();
    let handle = thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..4 {
            let mut request = match server.recv() {
                Ok(request) => request,
                Err(_) => break,
            };
            let url = request.url().to_string();
            seen.push(url.clone());
            match url.as_str() {
                "/v1/captures/pending" => {
                    assert_eq!(
                        header_value(&request, "authorization"),
                        Some("Bearer test-token")
                    );
                    match &list_mode {
                        PendingListMode::OneCapture => {
                            let payload = json!({ "captures": [pending_capture_json(capture_id)] });
                            request.respond(json_response(payload)).unwrap();
                        }
                        PendingListMode::Malformed => {
                            request
                                .respond(json_response(json!({ "captures": [{ "id": "x" }] })))
                                .unwrap();
                        }
                        PendingListMode::ServerError(status) => {
                            request.respond(Response::empty(*status)).unwrap();
                            break;
                        }
                    }
                }
                "/v1/captures/capture-1/download" => {
                    let ticket = download_ticket(server.server_addr().to_string());
                    request.respond(json_response(ticket)).unwrap();
                }
                "/r2-download/capture-original" => {
                    assert_eq!(header_value(&request, "x-test-required"), Some("ticket-value"));
                    request.respond(Response::from_data(media.clone())).unwrap();
                }
                "/v1/captures/capture-1/acknowledge" => {
                    match &acknowledge {
                        AcknowledgeMode::Succeed => {
                            request.respond(Response::empty(200)).unwrap();
                        }
                        AcknowledgeMode::FailWith(status) => {
                            request.respond(Response::empty(*status)).unwrap();
                        }
                        AcknowledgeMode::Never => unreachable!("acknowledge should not be sent"),
                    }
                    break;
                }
                _ => {
                    request.respond(Response::empty(404)).unwrap();
                    break;
                }
            }
        }
        let _ = urls_tx;
        seen
    });
    (base_url, handle)
}

#[test]
fn pending_capture_downloads_ingests_and_acknowledges() {
    let media = png_bytes();
    let (base_url, handle) = serve_capture_flow("capture-1", media.clone(), PendingListMode::OneCapture, AcknowledgeMode::Succeed);
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled.as_deref(), Some("capture-1"));

    // 로컬 라이브러리에 실제로 수집됐다.
    let assets = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(assets.items.len(), 1);
    let asset = &assets.items[0];
    assert_eq!(asset.source_url.as_deref(), Some("https://x.com/example/status/123/photo/1"));
    assert_eq!(asset.creator_handle.as_deref(), Some("example"));
    // 로컬 수집 + 원격 ack까지 끝나면 기록은 acknowledged로 남는다.
    let import_status: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_capture_imports WHERE capture_id = 'capture-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(import_status, "acknowledged");
    handle.join().unwrap();
}

#[test]
fn download_failure_does_not_acknowledge() {
    let (base_url, handle) = thread_handle_with_failing_download();
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 다운로드 실패는 그 캡처만 건너뛴다(원격은 pending 유지). 폴 자체는 오류가 아니다.
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);

    let count: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_capture_imports", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    handle.join().unwrap();
}

fn thread_handle_with_failing_download() -> (String, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({ "captures": [pending_capture_json("capture-1")] })))
            .unwrap();
        let mut ticket = server.recv().unwrap();
        ticket
            .respond(json_response(download_ticket(server.server_addr().to_string())))
            .unwrap();
        let mut download = server.recv().unwrap();
        download.respond(Response::empty(403)).unwrap();
    });
    (base_url, handle)
}

#[test]
fn duplicate_capture_is_still_acknowledged_without_new_asset() {
    let media = png_bytes();
    let (base_url, handle) = serve_capture_flow("capture-1", media.clone(), PendingListMode::OneCapture, AcknowledgeMode::Succeed);
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap()
        .unwrap();

    // 서버가 같은 캡처를 다시 pending 목록에 준 상황(ack 유실 후 재시도 포함):
    // exact duplicate로 수집돼야 하고 자산은 여전히 하나다.
    let (base_url2, handle2) = serve_capture_flow("capture-1", media, PendingListMode::OneCapture, AcknowledgeMode::Succeed);
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    // imported 기록이 있는 캡처는 consume 대신 ack만 다시 보낸다(None 반환 계약).
    assert_eq!(handled, None);
    let ack_status: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_capture_imports WHERE capture_id = 'capture-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ack_status, "acknowledged");
    let assets = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(assets.items.len(), 1);
    handle.join().unwrap();
    handle2.join().unwrap();
}

#[test]
fn acknowledgement_failure_after_import_is_safe_to_retry() {
    let media = png_bytes();
    let (base_url, handle) = serve_capture_flow("capture-1", media.clone(), PendingListMode::OneCapture, AcknowledgeMode::FailWith(503));
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 로컬 수집 + imported 기록은 됐지만 acknowledge가 503 → 폴은 정상(None)으로
    // 끝나고 재시도는 다음 폴에서 한다. 원격과 로컬 기록 상태가 불일치한다.
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);
    let import_status: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_capture_imports WHERE capture_id = 'capture-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(import_status, "imported");

    // 재시도: 서버가 같은 캡처를 다시 목록에 준다. 로컬은 duplicate로 인식하고
    // ack만 성공시킨다. 새 자산이 생기지 않는다.
    let (base_url2, handle2) = serve_capture_flow("capture-1", media, PendingListMode::OneCapture, AcknowledgeMode::Succeed);
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);
    let ack_status: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_capture_imports WHERE capture_id = 'capture-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ack_status, "acknowledged");
    let assets = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(assets.items.len(), 1);
    handle.join().unwrap();
    handle2.join().unwrap();
}

#[test]
fn interrupted_import_is_recovered_as_duplicate_on_next_run() {
    let media = png_bytes();
    let (base_url, handle) = serve_capture_flow("capture-1", media.clone(), PendingListMode::OneCapture, AcknowledgeMode::Succeed);
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 첫 실행: 로컬 수집 + imported 기록 (ack 성공).
    library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    handle.join().unwrap();

    // 이전 버전의 기록 상태(imported는 남지만, 서버가 아직 pending으로 주는) 시뮬레이션:
    // 다음 실행에서 같은 캡처가 목록에 다시 오면 ack 재전송뿐이다.
    let (base_url2, handle2) = serve_capture_flow("capture-1", media, PendingListMode::OneCapture, AcknowledgeMode::Succeed);
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    // 이미 imported 기록이 있으므로 consume 없이 ack만 다시 보내고 넘어간다.
    assert_eq!(handled, None);
    handle2.join().unwrap();
}

#[test]
fn malformed_capture_record_cannot_escape_staging() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({ "captures": [{ "id": "x" }] })))
            .unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // malformed 기록도 그 항목만 건너뛴다. staging은 건드리지 않는다.
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);

    let staging = temp.path().join("assets/.staging");
    let leftovers = count_files(&staging);
    assert_eq!(leftovers, 0);
    handle.join().unwrap();
}

#[test]
fn unknown_media_kind_is_rejected() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        let mut capture = pending_capture_json("capture-1");
        capture["kind"] = json!("animated_webp");
        list.respond(json_response(json!({ "captures": [capture] }))).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 알 수 없는 종류의 기록은 그 캡처만 건너뛴다. 폴은 정상이다.
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);
    handle.join().unwrap();
}

#[test]
fn empty_capture_list_is_a_clean_noop() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({ "captures": [] }))).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);
    handle.join().unwrap();
}

#[test]
fn broken_capture_does_not_block_a_healthy_later_capture() {
    let media = png_bytes();
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let addr = server.server_addr().to_string();
    let handle = thread::spawn(move || {
        // 한 번의 목록에 broken + good이 함께 온다. 폴은 목록을 한 번만 받는다.
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({
            "captures": [pending_capture_json("capture-broken"), pending_capture_json("capture-good")],
        })))
        .unwrap();
        // broken 티켓이 500 → 소비자는 그 캡처를 건너뛰고 good을 계속 처리한다.
        let mut ticket = server.recv().unwrap();
        ticket.respond(Response::empty(500)).unwrap();
        let mut ticket2 = server.recv().unwrap();
        ticket2
            .respond(json_response(download_ticket(addr)))
            .unwrap();
        let mut download = server.recv().unwrap();
        let mut bytes = Vec::new();
        download.as_reader().read_to_end(&mut bytes).unwrap();
        download.respond(Response::from_data(media)).unwrap();
        let mut acknowledge = server.recv().unwrap();
        acknowledge.respond(Response::empty(200)).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled.as_deref(), Some("capture-good"));
    handle.join().unwrap();
}

#[test]
fn ingest_failure_does_not_acknowledge() {
    // PNG로 위장한 잘못된 바이트: ingest 단계(이미지 검사)에서 실패해야 한다.
    let (base_url, handle) = thread_handle_with_invalid_media();
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 수집 실패도 그 캡처만 건너뛴다. 원격은 imported로 만들지 않는다.
    let handled = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(handled, None);

    let count: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_capture_imports", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    // staging에 임시 파일이 남지 않는다.
    let staging = temp.path().join("assets/.staging");
    assert_eq!(count_files(&staging), 0);
    handle.join().unwrap();
}

/// 목록 → 티켓 →(무효 미디어)까지만 응답하는 서버. acknowledge 요청이 오면 안 된다.
fn thread_handle_with_invalid_media() -> (String, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({ "captures": [pending_capture_json("capture-1")] })))
            .unwrap();
        let mut ticket = server.recv().unwrap();
        ticket
            .respond(json_response(download_ticket(server.server_addr().to_string())))
            .unwrap();
        let mut download = server.recv().unwrap();
        download
            .respond(Response::from_data(b"definitely-not-a-png".to_vec()))
            .unwrap();
    });
    (base_url, handle)
}

#[test]
fn inbound_captures_and_outbound_queue_remain_independent() {
    let media = png_bytes();
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({ "captures": [] }))).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    // outbound 개념의 로컬 레코드를 심는다.
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO cloud_sync_queue (id, entity_type, entity_id, operation, status, revision, updated_at)
             VALUES ('queue-1', 'asset', '00000000-0000-4000-8000-000000000001', 'upsert', 'pending', 1, '2026-08-30T00:00:00Z')",
            [],
        )
        .unwrap();

    // inbound 폴: outbound 큐에 아무 영향이 없다.
    library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    let outbound: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_sync_queue WHERE status = 'pending'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(outbound, 1);
    let imports: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_capture_imports", [], |row| row.get(0))
        .unwrap();
    assert_eq!(imports, 0);
    handle.join().unwrap();
}

fn count_files(directory: &std::path::Path) -> usize {
    fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

fn header_value<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.to_string().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn json_response(value: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(&value).unwrap())
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}