use std::{fs, thread};

use image::{DynamicImage, ImageBuffer, Rgb};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tiny_http::{Header, Response, Server};

use super::client::CloudClient;
use crate::library::Library;

// 클라우드 캡처 수신함(원격 → 로컬) 계약 테스트. fake VPS가 capture 목록,
// 다운로드 티켓, 미디어, imported acknowledge 순서를 검증한다.
// cloud_sync_queue(로컬 → 클라우드)와 개념·상태가 분리됨도 함께 확인한다.

fn png_bytes() -> Vec<u8> {
    // 동일한 내용의 PNG를 만들어 중복 검사가 결정적으로 동작하게 한다.
    let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(8, 8, |x, _y| {
        Rgb([(x * 16 % 256) as u8, 32, 200])
    }));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
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
        "classification_id": "game",
        "creator_handle": "example",
        "source_published_at": "2026-05-01T10:00:00Z",
        "created_at": "2026-08-30T00:00:00Z",
    })
}

/// 서로 다른 내용의 PNG. 배치 테스트에서 캡처별로 별개 자산이 생기도록
/// 콘텐츠를 변형한다.
fn distinct_png_bytes(seed: u32) -> Vec<u8> {
    let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(8, 8, |x, _y| {
        Rgb([((x * 16 + seed) % 256) as u8, 32, 200])
    }));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn download_ticket(server_addr: String) -> Value {
    json!({
        "method": "GET",
        "download_url": format!("http://{server_addr}/r2-download/capture-original"),
        "required_headers": { "x-test-required": "ticket-value" }
    })
}

/// capture id별로 서로 다른 다운로드 URL을 주는 티켓. 배치 헬퍼에서
/// 캡처별 미디어를 구분하는 데 쓴다.
fn capture_specific_ticket(server_addr: &str, capture_id: &str) -> Value {
    json!({
        "method": "GET",
        "download_url": format!("http://{server_addr}/r2-download/{capture_id}/original"),
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
                    assert_eq!(
                        header_value(&request, "x-test-required"),
                        Some("ticket-value")
                    );
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
    let (base_url, handle) = serve_capture_flow(
        "capture-1",
        media.clone(),
        PendingListMode::OneCapture,
        AcknowledgeMode::Succeed,
    );
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(
        result,
        super::captures::CloudCaptureSyncResult {
            attempted: 1,
            acknowledged: 1,
            failed: 0,
            review_pending: 0,
            added: 1,
            video_added: 0,
            classification_changed: 0,
        }
    );

    // 로컬 라이브러리에 실제로 수집됐다.
    let assets = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(assets.items.len(), 1);
    let asset = &assets.items[0];
    assert_eq!(
        asset.source_url.as_deref(),
        Some("https://x.com/example/status/123/photo/1")
    );
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
fn pending_capture_preserves_existing_classification_id() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let classification = library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Root,
            name: "Cloud Game".into(),
            parent_id: None,
        })
        .unwrap();
    let mut capture = pending_capture_json("capture-classified");
    capture["classification_id"] = json!(classification.id);
    let media_by_object_key = vec![(
        "captures/capture-classified/original".to_string(),
        distinct_png_bytes(44),
    )];
    let (base_url, handle) = serve_multi_capture_list(vec![capture], &[], &media_by_object_key);

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result.added, 1);
    let asset = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 1,
            ..Default::default()
        })
        .unwrap()
        .items
        .into_iter()
        .next()
        .unwrap();
    let linked: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT classification_id FROM asset_classifications WHERE asset_id = ?1",
            [asset.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(linked, classification.id);
    handle.join().unwrap();
}

#[test]
fn download_failure_does_not_acknowledge() {
    let (base_url, handle) = thread_handle_with_failing_download();
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 다운로드 실패는 그 캡처만 건너뛴다(원격은 pending 유지). 폴 자체는 오류가 아니다.
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result.attempted, 1);
    assert_eq!(result.acknowledged, 0);
    assert_eq!(result.failed, 1);

    let count: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_capture_imports", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    handle.join().unwrap();
}

fn thread_handle_with_failing_download() -> (String, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(
            json!({ "captures": [pending_capture_json("capture-1")] }),
        ))
        .unwrap();
        let mut ticket = server.recv().unwrap();
        ticket
            .respond(json_response(download_ticket(
                server.server_addr().to_string(),
            )))
            .unwrap();
        let mut download = server.recv().unwrap();
        download.respond(Response::empty(403)).unwrap();
    });
    (base_url, handle)
}

#[test]
fn duplicate_capture_is_still_acknowledged_without_new_asset() {
    let media = png_bytes();
    let (base_url, handle) = serve_capture_flow(
        "capture-1",
        media.clone(),
        PendingListMode::OneCapture,
        AcknowledgeMode::Succeed,
    );
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let first = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(first.acknowledged, 1);

    // 서버가 같은 캡처를 다시 pending 목록에 준 상황(ack 유실 후 재시도 포함):
    // exact duplicate로 수집돼야 하고 자산은 여전히 하나다.
    let (base_url2, handle2) = serve_capture_flow(
        "capture-1",
        media,
        PendingListMode::OneCapture,
        AcknowledgeMode::Succeed,
    );
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    // imported 기록이 있는 캡처는 consume 대신 ack만 다시 보낸다(중복 수집 없음).
    assert_eq!(result.attempted, 1);
    assert_eq!(result.acknowledged, 1);
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
    let (base_url, handle) = serve_capture_flow(
        "capture-1",
        media.clone(),
        PendingListMode::OneCapture,
        AcknowledgeMode::FailWith(503),
    );
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    // 로컬 수집 + imported 기록은 됐지만 acknowledge가 503 → 이번 폴의 이 캡처는
    // failed로 집계하고 재시도는 다음 폴에서 한다. 원격과 로컬 기록이 불일치한다.
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result.attempted, 1);
    assert_eq!(result.acknowledged, 0);
    assert_eq!(result.failed, 1);
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
    let (base_url2, handle2) = serve_capture_flow(
        "capture-1",
        media,
        PendingListMode::OneCapture,
        AcknowledgeMode::Succeed,
    );
    let retry = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    assert_eq!(retry.attempted, 1);
    assert_eq!(retry.acknowledged, 1);
    assert_eq!(retry.failed, 0);
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
    let (base_url, handle) = serve_capture_flow(
        "capture-1",
        media.clone(),
        PendingListMode::OneCapture,
        AcknowledgeMode::Succeed,
    );
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 첫 실행: 로컬 수집 + imported 기록 (ack 성공).
    let first = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(first.acknowledged, 1);
    handle.join().unwrap();

    // 이전 버전의 기록 상태(imported는 남지만, 서버가 아직 pending으로 주는) 시뮬레이션:
    // 다음 실행에서 같은 캡처가 목록에 다시 오면 ack 재전송뿐이다.
    let (base_url2, handle2) = serve_capture_flow(
        "capture-1",
        media,
        PendingListMode::OneCapture,
        AcknowledgeMode::Succeed,
    );
    // 이미 imported 기록이 있으므로 consume 없이 ack만 다시 보내고 넘어간다.
    let second = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    assert_eq!(second.attempted, 1);
    assert_eq!(second.acknowledged, 1);
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
    // malformed 기록도 그 항목만 건너뛴다. staging은 건드리지 않는다. 시도 집계에도
    // 들어가지 않는다. malformed 항목은 상한 소비량도 차지하지 않는다.
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result, super::captures::CloudCaptureSyncResult::default());

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
        list.respond(json_response(json!({ "captures": [capture] })))
            .unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 알 수 없는 종류의 기록은 그 캡처만 건너뛴다. 폴은 정상이고 시도 집계에도
    // 들어가지 않는다.
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result, super::captures::CloudCaptureSyncResult::default());
    handle.join().unwrap();
}

#[test]
fn empty_capture_list_is_a_clean_noop() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        let mut list = server.recv().unwrap();
        list.respond(json_response(json!({ "captures": [] })))
            .unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result, super::captures::CloudCaptureSyncResult::default());
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

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result.attempted, 2);
    assert_eq!(result.acknowledged, 1);
    assert_eq!(result.failed, 1);
    assert_eq!(result.review_pending, 0);
    handle.join().unwrap();
}

#[test]
fn ingest_failure_does_not_acknowledge() {
    // PNG로 위장한 잘못된 바이트: ingest 단계(이미지 검사)에서 실패해야 한다.
    let (base_url, handle) = thread_handle_with_invalid_media();
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 수집 실패도 그 캡처만 건너뛴다. 원격은 imported로 만들지 않는다.
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result.attempted, 1);
    assert_eq!(result.acknowledged, 0);
    assert_eq!(result.failed, 1);

    let count: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_capture_imports", [], |row| {
            row.get(0)
        })
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
        list.respond(json_response(
            json!({ "captures": [pending_capture_json("capture-1")] }),
        ))
        .unwrap();
        let mut ticket = server.recv().unwrap();
        ticket
            .respond(json_response(download_ticket(
                server.server_addr().to_string(),
            )))
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
        list.respond(json_response(json!({ "captures": [] })))
            .unwrap();
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
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result, super::captures::CloudCaptureSyncResult::default());
    let outbound: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(outbound, 1);
    let imports: i64 = library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cloud_capture_imports", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(imports, 0);
    handle.join().unwrap();
}

/// 여러 캡처를 한 번의 목록으로 처리하는 범용 fake VPS. 목록 요청 1회에
/// captures JSON을 응답하고, 이후 ticket/다운로드/ack를 각 캡처별로 순서대로
/// 처리한다. failing_ticket_ids에 포함된 캡처의 티켓 요청은 500으로 거절한다.
/// 다운로드 응답은 media_by_object_key의 object_key별 바이트를 사용하며,
/// 없는 object_key는 기본 png_bytes()를 내려준다.
fn serve_multi_capture_list(
    captures: Vec<Value>,
    failing_ticket_ids: &[&str],
    media_by_object_key: &[(String, Vec<u8>)],
) -> (String, thread::JoinHandle<Vec<String>>) {
    let failing_ticket_ids: Vec<String> =
        failing_ticket_ids.iter().map(|id| id.to_string()).collect();
    let media_by_object_key: Vec<(String, Vec<u8>)> = media_by_object_key.to_vec();
    let server = Server::http("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", server.server_addr());
    let addr = server.server_addr().to_string();
    let handle = thread::spawn(move || {
        let mut seen = Vec::new();
        let capture_count = captures.len();
        let captures = json!({ "captures": captures });
        let mut list = server.recv().unwrap();
        seen.push(list.url().to_string());
        list.respond(json_response(captures)).unwrap();
        // 각 캡처의 ticket → download → acknowledge 순서를 상한까지 받는다.
        for _ in 0..capture_count * 3 + 4 {
            use std::time::Duration;
            let mut request = match server.recv_timeout(Duration::from_secs(5)) {
                Ok(Some(request)) => request,
                _ => break,
            };
            let url = request.url().to_string();
            let failing = failing_ticket_ids
                .iter()
                .any(|id| url.starts_with(&format!("/v1/captures/{id}/download")));
            seen.push(url.clone());
            if url.starts_with("/v1/captures/") && url != "/v1/captures/pending" {
                if url.ends_with("/download") {
                    if failing {
                        request.respond(Response::empty(500)).unwrap();
                    } else {
                        // download_url에 capture id를 넣어 캡처별 미디어를 구분한다.
                        let capture_id = url
                            .strip_prefix("/v1/captures/")
                            .and_then(|rest| rest.strip_suffix("/download"))
                            .unwrap_or("unknown");
                        request
                            .respond(json_response(capture_specific_ticket(&addr, capture_id)))
                            .unwrap();
                    }
                } else if url.ends_with("/acknowledge") {
                    request.respond(Response::empty(200)).unwrap();
                } else {
                    request.respond(Response::empty(404)).unwrap();
                }
                continue;
            }
            if url.starts_with("/r2-download/") {
                // URL 경로 조각(capture id/original)이 미디어 키의 접미사와 일치하는지로 찾는다.
                let suffix = url.strip_prefix("/r2-download/").unwrap_or("");
                let served = media_by_object_key
                    .iter()
                    .find(|(key, _)| key.ends_with(suffix))
                    .map(|(_, bytes)| bytes.clone())
                    .unwrap_or_else(png_bytes);
                request.respond(Response::from_data(served)).unwrap();
            } else {
                request.respond(Response::empty(404)).unwrap();
            }
        }
        seen
    });
    (base_url, handle)
}

#[test]
fn one_invocation_drains_multiple_valid_captures() {
    // 서로 다른 콘텐츠로 각 캡처를 만든다. 같은 바이트면 완전 중복으로
    // 하나의 자산만 생기므로 자산 수 검증이 의미 없어진다.
    let captures = vec![
        pending_capture_json("capture-a"),
        pending_capture_json("capture-b"),
        pending_capture_json("capture-c"),
    ];
    let media_by_object_key = vec![
        (
            "captures/capture-a/original".to_string(),
            distinct_png_bytes(1),
        ),
        (
            "captures/capture-b/original".to_string(),
            distinct_png_bytes(2),
        ),
        (
            "captures/capture-c/original".to_string(),
            distinct_png_bytes(3),
        ),
    ];
    let (base_url, handle) = serve_multi_capture_list(captures, &[], &media_by_object_key);
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(
        result,
        super::captures::CloudCaptureSyncResult {
            attempted: 3,
            acknowledged: 3,
            failed: 0,
            review_pending: 0,
            added: 3,
            video_added: 0,
            classification_changed: 0,
        }
    );
    let acknowledged: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM cloud_capture_imports WHERE status = 'acknowledged'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(acknowledged, 3);
    let assets = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(assets.items.len(), 3);
    handle.join().unwrap();
}

#[test]
fn one_invocation_processes_at_most_25_attempts() {
    // 26건의 유효한 캡처를 한 번의 목록으로 제공한다. 25건만 처리하고 남은
    // 1건은 다음 폴로 미룬다. cap은 attempted 기준이다.
    let captures: Vec<Value> = (0..26)
        .map(|index| pending_capture_json(&format!("capture-{index:02}")))
        .collect();
    let media_by_object_key: Vec<(String, Vec<u8>)> = (0..26)
        .map(|index| {
            (
                format!("captures/capture-{index:02}/original"),
                distinct_png_bytes(100 + index),
            )
        })
        .collect();
    let (base_url, handle) = serve_multi_capture_list(captures, &[], &media_by_object_key);
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(
        result,
        super::captures::CloudCaptureSyncResult {
            attempted: 25,
            acknowledged: 25,
            failed: 0,
            review_pending: 0,
            added: 25,
            video_added: 0,
            classification_changed: 0,
        }
    );
    let acknowledged: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM cloud_capture_imports WHERE status = 'acknowledged'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(acknowledged, 25);
    handle.join().unwrap();
}

#[test]
fn middle_failure_leaves_later_captures_imported() {
    // pending: A(정상) B(티켓 500) C(정상). 한 번의 폴에서 A·C는 imported+ack,
    // B만 pending에 남는다.
    let captures = vec![
        pending_capture_json("capture-ok-1"),
        pending_capture_json("capture-broken"),
        pending_capture_json("capture-ok-2"),
    ];
    let media_by_object_key = vec![
        (
            "captures/capture-ok-1/original".to_string(),
            distinct_png_bytes(11),
        ),
        (
            "captures/capture-ok-2/original".to_string(),
            distinct_png_bytes(12),
        ),
    ];
    let (base_url, handle) =
        serve_multi_capture_list(captures, &["capture-broken"], &media_by_object_key);
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(
        result,
        super::captures::CloudCaptureSyncResult {
            attempted: 3,
            acknowledged: 2,
            failed: 1,
            review_pending: 0,
            added: 2,
            video_added: 0,
            classification_changed: 0,
        }
    );
    let broken_status: Option<String> = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_capture_imports WHERE capture_id = 'capture-broken'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(broken_status, None);
    let acknowledged: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM cloud_capture_imports WHERE status = 'acknowledged'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(acknowledged, 2);
    let assets = library
        .list_assets(crate::library::models::AssetQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(assets.items.len(), 2);
    handle.join().unwrap();
}

#[test]
fn review_pending_capture_is_not_acknowledged() {
    // 유사 이미지 후보는 검토 확정 전까지 원격 imported로 만들지 않는다.
    // 폴은 정상 종료되고 해당 캡처는 review_pending으로 집계된다.
    let base = vertical_stripes_fixture(900, 600);
    let original = base.clone();
    let similar = base.resize_exact(450, 300, image::imageops::FilterType::Triangle);
    let dir = tempfile::tempdir().unwrap();
    let original_path = dir.path().join("original.png");
    let similar_path = dir.path().join("similar.png");
    original
        .save_with_format(&original_path, image::ImageFormat::Png)
        .unwrap();
    similar
        .save_with_format(&similar_path, image::ImageFormat::Png)
        .unwrap();

    let library = tempfile::tempdir().unwrap();
    let library = Library::open(library.path()).unwrap();
    // 먼저 라이브러리에 유사한 이미지를 수집해 둔다.
    library
        .ingest_media(crate::library::models::IngestMediaRequest {
            source_path: original_path,
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: crate::library::models::ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        })
        .unwrap();

    // 다운로드로 내려줄 유사 이미지 바이트. 원본과 크기·압축만 다른 변형이다.
    let similar_bytes = {
        let mut bytes = std::io::Cursor::new(Vec::new());
        similar
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    };
    let captures = vec![pending_capture_json("capture-similar")];
    let media_by_object_key = vec![(
        "captures/capture-similar/original".to_string(),
        similar_bytes,
    )];
    let (base_url, handle) = serve_multi_capture_list(captures, &[], &media_by_object_key);
    let result = library
        .sync_next_cloud_capture_with(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(result.attempted, 1);
    assert_eq!(result.acknowledged, 0);
    assert_eq!(result.failed, 0);
    assert_eq!(result.review_pending, 1);
    // 원격 상태 표시는 없다: ack 요청이 오지 않았음을 기록 상태로도 확인한다.
    let import_record: Option<String> = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_capture_imports WHERE capture_id = 'capture-similar'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(import_record, None);
    handle.join().unwrap();
}

/// 검토 트리거용 큰 이미지 픽스처. ingestion 테스트의 scene_fixture와 같은
/// 패턴으로 유사 해시가 결정적으로 나오도록 한다.
fn vertical_stripes_fixture(width: u32, height: u32) -> image::DynamicImage {
    image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(width, height, |x, y| {
        let nx = x as f32 / width as f32;
        let ny = y as f32 / height as f32;
        let mut color = [
            (35.0 + nx * 90.0) as u8,
            (45.0 + ny * 100.0) as u8,
            (170.0 - nx * 55.0) as u8,
        ];
        let featured = (0.18..0.43).contains(&nx) && (0.12..0.88).contains(&ny);
        if featured {
            color = [235, 75, 35];
        }
        if (0.55..0.90).contains(&nx) && (0.08..0.20).contains(&ny) {
            color = [245, 205, 35];
        }
        if (nx - 0.72).powi(2) + (ny - 0.68).powi(2) < 0.085 {
            color = [25, 215, 135];
        }
        image::Rgb(color)
    }))
}

fn count_files(directory: &std::path::Path) -> usize {
    fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .file_type()
                        .map(|kind| kind.is_file())
                        .unwrap_or(false)
                })
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
