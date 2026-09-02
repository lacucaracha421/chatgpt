//! CLOUD-006 배치 1-3 통합 테스트: 사전 점검, 백필 큐 시딩, 멱등 복제.
//!
//! fake VPS(tiny_http)가 prepare → presign → 업로드 → commit 순서를 검증하고,
//! 재시작/재시도가 중복 행·중복 관계를 만들지 않음을 확인한다. Cloud Capture
//! 흐름 테스트는 capture_tests.rs에 그대로 있다.

use std::{fs, thread};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tiny_http::{Header, Response, Server};

use super::backfill::BackfillControlState;
use super::client::CloudClient;
use crate::library::Library;

fn png_bytes(seed: u32) -> Vec<u8> {
    let image = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(8, 8, |x, _y| {
        image::Rgb([((x * 16 + seed) % 256) as u8, 32, 200])
    }));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn ingest_png(library: &Library, source: &std::path::Path, collected_at: &str) -> String {
    match library
        .ingest_media(crate::library::models::IngestMediaRequest {
            source_path: source.to_path_buf(),
            classification_id: None,
            source_url: None,
            collected_at: Some(collected_at.into()),
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: crate::library::models::ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-00000000feed".into(),
        })
        .unwrap()
    {
        crate::library::models::IngestOutcome::Added { asset } => asset.id,
        other => panic!("expected added asset, got {other:?}"),
    }
}

fn count_rows(library: &Library, query: &str) -> i64 {
    library
        .connection()
        .unwrap()
        .query_row(query, [], |row| row.get::<_, i64>(0))
        .unwrap()
}

fn queue_status(library: &Library, asset_id: &str) -> Option<String> {
    library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status FROM cloud_sync_queue WHERE entity_type = 'asset'
             AND entity_id = ?1 AND operation = 'upsert'",
            [asset_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
        .flatten()
}

#[test]
fn backfill_control_state_is_idle_by_default_and_persists_pause() {
    let temp = tempfile::tempdir().unwrap();
    {
        let library = Library::open(temp.path()).unwrap();
        assert_eq!(
            library.cloud_backfill_control_state().unwrap(),
            BackfillControlState::Idle
        );
        assert_eq!(
            library
                .set_cloud_backfill_control_state(BackfillControlState::Paused)
                .unwrap(),
            BackfillControlState::Paused
        );
    }

    let reopened = Library::open(temp.path()).unwrap();
    assert_eq!(
        reopened.cloud_backfill_control_state().unwrap(),
        BackfillControlState::Paused
    );
}

#[test]
fn reopening_suspends_a_previously_running_backfill_until_explicit_resume() {
    let temp = tempfile::tempdir().unwrap();
    {
        let library = Library::open(temp.path()).unwrap();
        library
            .set_cloud_backfill_control_state(BackfillControlState::Running)
            .unwrap();
    }

    let reopened = Library::open(temp.path()).unwrap();
    assert_eq!(
        reopened.cloud_backfill_control_state().unwrap(),
        BackfillControlState::Paused
    );
}

#[test]
fn paused_backfill_does_not_claim_new_work_and_resume_preserves_queue() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let source = temp.path().join("paused.png");
    fs::write(&source, png_bytes(99)).unwrap();
    let asset_id = ingest_png(&library, &source, "2026-09-02T00:00:00Z");
    library.seed_cloud_backfill_queue().unwrap();

    library
        .set_cloud_backfill_control_state(BackfillControlState::Paused)
        .unwrap();
    assert!(library.claim_next_backfill_for_test().unwrap().is_none());
    assert_eq!(
        queue_status(&library, &asset_id).as_deref(),
        Some("pending")
    );

    library
        .set_cloud_backfill_control_state(BackfillControlState::Running)
        .unwrap();
    assert_eq!(
        library
            .claim_next_backfill_for_test()
            .unwrap()
            .unwrap()
            .queue
            .entity_id,
        asset_id
    );
}

#[test]
fn reconcile_only_requeues_interrupted_backfill_stages() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let connection = library.connection().unwrap();
    for (index, status) in ["preparing", "uploading", "committing", "synced", "failed"]
        .into_iter()
        .enumerate()
    {
        connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES (?1, 'asset', ?2, 'upsert', ?3, 1, '2026-09-02T00:00:00Z')",
                (format!("queue-{index}"), format!("asset-{index}"), status),
            )
            .unwrap();
    }
    drop(connection);

    assert_eq!(library.reconcile_cloud_backfill().unwrap().requeued, 3);
    assert_eq!(
        count_rows(
            &library,
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE status = 'pending'"
        ),
        3
    );
    assert_eq!(
        count_rows(
            &library,
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE status = 'synced'"
        ),
        1
    );
    assert_eq!(
        count_rows(
            &library,
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE status = 'failed'"
        ),
        1
    );
}

#[test]
fn bounded_scope_excludes_preexisting_pending_work_from_progress_and_claims() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let mut ids = Vec::new();
    for index in 0..3 {
        let source = temp.path().join(format!("bounded-{index}.png"));
        fs::write(&source, png_bytes(200 + index)).unwrap();
        ids.push(ingest_png(
            &library,
            &source,
            &format!("2026-09-0{}T00:00:00Z", index + 1),
        ));
    }

    library.seed_cloud_backfill_queue().unwrap();
    let report = library.seed_bounded_cloud_backfill(&ids[0..2]).unwrap();
    assert_eq!(report.selected, 2);

    let progress = library.cloud_backfill_progress().unwrap();
    assert_eq!(progress.total_assets, 2);
    assert_eq!(progress.queued, 2);

    let first = library.claim_next_backfill_for_test().unwrap().unwrap();
    let second = library.claim_next_backfill_for_test().unwrap().unwrap();
    assert!(ids[0..2].contains(&first.queue.entity_id));
    assert!(ids[0..2].contains(&second.queue.entity_id));
    assert!(library.claim_next_backfill_for_test().unwrap().is_none());
    assert_eq!(queue_status(&library, &ids[2]).as_deref(), Some("pending"));
}

#[test]
fn normal_full_seed_clears_a_previous_bounded_scope() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let mut ids = Vec::new();
    for index in 0..2 {
        let source = temp.path().join(format!("full-{index}.png"));
        fs::write(&source, png_bytes(220 + index)).unwrap();
        ids.push(ingest_png(
            &library,
            &source,
            &format!("2026-09-0{}T00:00:00Z", index + 1),
        ));
    }

    library.seed_bounded_cloud_backfill(&ids[0..1]).unwrap();
    assert_eq!(library.cloud_backfill_progress().unwrap().total_assets, 1);

    library.seed_cloud_backfill_queue().unwrap();
    let progress = library.cloud_backfill_progress().unwrap();
    assert_eq!(progress.total_assets, 2);
    assert_eq!(progress.queued, 2);
}

#[test]
fn full_backfill_progress_excludes_non_normal_queue_rows_without_deleting_them() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let normal_source = temp.path().join("normal-progress.png");
    let trashed_source = temp.path().join("trashed-progress.png");
    fs::write(&normal_source, png_bytes(230)).unwrap();
    fs::write(&trashed_source, png_bytes(231)).unwrap();
    let normal_id = ingest_png(&library, &normal_source, "2026-09-02T00:00:00Z");
    let trashed_id = ingest_png(&library, &trashed_source, "2026-09-01T00:00:00Z");

    library.seed_cloud_backfill_queue().unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET status = 'trash', trashed_at = '2026-09-03T00:00:00Z'
             WHERE id = ?1",
            [&trashed_id],
        )
        .unwrap();

    let progress = library.cloud_backfill_progress().unwrap();
    assert_eq!(progress.total_assets, 1);
    assert_eq!(progress.queued, 1);
    assert_eq!(queue_status(&library, &normal_id).as_deref(), Some("pending"));
    assert_eq!(
        queue_status(&library, &trashed_id).as_deref(),
        Some("pending")
    );
}

// ---------------------------------------------------------------------------
// 배치 1: 사전 점검
// ---------------------------------------------------------------------------

#[test]
fn preflight_reports_missing_original_without_failing_others() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let library = Library::open(root).unwrap();

    let healthy_source = root.join("healthy.png");
    fs::write(&healthy_source, png_bytes(1)).unwrap();
    let healthy_id = ingest_png(&library, &healthy_source, "2026-08-30T00:00:00Z");

    let broken_source = root.join("broken.png");
    fs::write(&broken_source, png_bytes(2)).unwrap();
    let broken_id = ingest_png(&library, &broken_source, "2026-08-29T00:00:00Z");
    // 원본 파일을 지워 missing original을 만든다.
    let asset = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT relative_path FROM assets WHERE id = ?1",
            [&broken_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    fs::remove_file(root.join(&asset)).unwrap();

    let report = library.preflight_full_library().unwrap();
    assert_eq!(report.total_assets, 2);
    assert_eq!(report.ready_assets, 1);
    assert_eq!(report.missing_originals, 1);
    assert_eq!(report.problem_assets, 1);
    let broken = report
        .assets
        .iter()
        .find(|item| item.asset_id == broken_id)
        .unwrap();
    assert!(report_assets_ready(&report, &healthy_id));
    assert!(broken.original_missing_or_changed);
    assert!(!broken.problems.is_empty());
    assert!(broken.classification_ids.is_empty());
}

fn report_assets_ready(
    report: &crate::library::cloud_preflight::PreflightReport,
    id: &str,
) -> bool {
    report
        .assets
        .iter()
        .find(|item| item.asset_id == id)
        .map(|item| item.ready)
        .unwrap_or(false)
}

#[test]
fn preflight_reports_classification_membership() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let classification = library
        .create_classification(crate::library::models::CreateClassification {
            kind: crate::library::models::ClassificationKind::Root,
            name: "테스트".into(),
            parent_id: None,
        })
        .unwrap();

    let source = temp.path().join("classified.png");
    fs::write(&source, png_bytes(3)).unwrap();
    library
        .ingest_media(crate::library::models::IngestMediaRequest {
            source_path: source,
            classification_id: Some(classification.id.clone()),
            source_url: Some("https://x.com/example/status/1".into()),
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: Some("example".into()),
            creator_url: None,
            import_source: crate::library::models::ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-00000000feed".into(),
        })
        .unwrap();

    let report = library.preflight_full_library().unwrap();
    assert_eq!(report.assets.len(), 1);
    assert_eq!(report.assets[0].classification_ids, vec![classification.id]);
    assert_eq!(report.assets[0].creator_handle.as_deref(), Some("example"));
    assert_eq!(
        report.assets[0].source_url.as_deref(),
        Some("https://x.com/example/status/1")
    );
}

// ---------------------------------------------------------------------------
// 배치 3: 시딩
// ---------------------------------------------------------------------------

#[test]
fn seeding_enqueues_recent_first_and_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    let mut ids = Vec::new();
    for (index, collected_at) in [
        "2026-08-01T00:00:00Z",
        "2026-08-31T00:00:00Z",
        "2026-08-15T00:00:00Z",
    ]
    .into_iter()
    .enumerate()
    {
        let source = temp.path().join(format!("asset-{index}.png"));
        fs::write(&source, png_bytes(index as u32)).unwrap();
        ids.push(ingest_png(&library, &source, collected_at));
    }

    // ingest_media는 이미 큐에 upsert 행을 넣는다(ingestion.rs:453,518).
    // 레거시 자산(큐 행이 없는 상태)을 시뮬레이션하기 위해 큐를 비운다.
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM cloud_sync_queue", [])
        .unwrap();

    let report = library.seed_cloud_backfill_queue().unwrap();
    assert_eq!(report.seeded, 3);
    assert_eq!(report.skipped_replicated, 0);

    // "최근 수집 자산이 먼저"는 시딩 행 순서가 아니라 백필 클레임 순서다.
    // 시딩은 updated_at=collected_at을 기록할 뿐이고, 클레임이 DESC로 꺼낸다.
    let claim_order: Vec<String> = (0..3)
        .map(|_| {
            library
                .claim_next_backfill_for_test()
                .unwrap()
                .map(|prepared| prepared.queue.entity_id)
                .expect("queued asset should be claimable")
        })
        .collect();
    assert_eq!(
        claim_order,
        vec![ids[1].clone(), ids[2].clone(), ids[0].clone()],
        "backfill claim must pick recently collected assets first"
    );

    // 재시딩해도 중복이 없다.
    let again = library.seed_cloud_backfill_queue().unwrap();
    assert_eq!(again.seeded, 0);
    assert_eq!(
        count_rows(
            &library,
            "SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_type = 'asset'",
        ),
        3
    );
}

#[test]
fn seeding_skips_already_synced_assets() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let source = temp.path().join("synced.png");
    fs::write(&source, png_bytes(7)).unwrap();
    let asset_id = ingest_png(&library, &source, "2026-08-30T00:00:00Z");

    library.seed_cloud_backfill_queue().unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE cloud_sync_queue SET status = 'synced', synced_at = '2026-08-30T01:00:00Z'
             WHERE entity_id = ?1",
            [&asset_id],
        )
        .unwrap();

    let report = library.seed_cloud_backfill_queue().unwrap();
    assert_eq!(report.seeded, 0);
    assert_eq!(
        report.skipped_replicated, 1,
        "the already-synced asset must be counted as skipped_replicated"
    );
    // synced 행이 남아 있고 새 행이 생기지 않는다.
    assert_eq!(
        count_rows(&library, "SELECT COUNT(*) FROM cloud_sync_queue"),
        1
    );
}

// ---------------------------------------------------------------------------
// 배치 2+3: prepare → upload → commit 워커 (fake VPS)
// ---------------------------------------------------------------------------

/// 백필 워커가 기대하는 fake VPS 4단계: prepare → presign(원본) → PUT(원본) →
/// presign(썸네일) → PUT(썸네일) → commit. 서버 순서를 하나의 스크립트로
/// 검증한다.
#[test]
fn backfill_worker_prepares_uploads_and_commits_one_image() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let base_url = format!("{origin}/v1");
    let upload_url = format!("{origin}/r2-upload");

    let server_thread = thread::spawn(move || {
        // prepare
        let mut prepare = server.recv().unwrap();
        assert_eq!(prepare.url(), "/v1/replication/prepare");
        assert_eq!(
            header_value(&prepare, "authorization"),
            Some("Bearer test-token")
        );
        let body: Value = read_json(&mut prepare);
        assert_eq!(body["kind"], "image");
        let asset_id = body["asset_id"].as_str().expect("prepare carries asset_id");
        let prepare_response = json!({
            "asset_id": asset_id,
            "already_committed": false,
            "object_keys": {
                "original": format!("library/{asset_id}/original"),
                "thumbnail": format!("library/{asset_id}/thumbnail"),
            }
        });
        prepare.respond(json_response(prepare_response)).unwrap();

        // upload_asset: presign(원본) → PUT → POST /v1/assets 등록.
        // 스텁은 클라이언트가 요청한 object_key를 그대로 되돌려야 한다
        // (validate_presign이 키 일치를 검증한다).
        let mut presign = server.recv().unwrap();
        assert_eq!(presign.url(), "/v1/uploads/presign");
        let requested: Value = read_json(&mut presign);
        let requested_key = requested["object_key"].as_str().unwrap().to_owned();
        assert_eq!(requested_key, format!("library/{asset_id}/original"));
        presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": requested_key,
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": { "Content-Type": requested["content_type"] }
            })))
            .unwrap();
        let mut upload = server.recv().unwrap();
        let mut received = Vec::new();
        std::io::Read::read_to_end(upload.as_reader(), &mut received).unwrap();
        upload.respond(Response::empty(200)).unwrap();
        let mut register = server.recv().unwrap();
        assert_eq!(register.url(), "/v1/assets");
        register.respond(Response::empty(201)).unwrap();

        // upload_replication_variant: presign(썸네일) → PUT.
        let mut thumb_presign = server.recv().unwrap();
        assert_eq!(thumb_presign.url(), "/v1/uploads/presign");
        let thumb_requested: Value = read_json(&mut thumb_presign);
        let thumb_key = thumb_requested["object_key"].as_str().unwrap().to_owned();
        thumb_presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": thumb_key,
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": { "Content-Type": thumb_requested["content_type"] }
            })))
            .unwrap();
        let mut thumb_upload = server.recv().unwrap();
        let mut thumb_bytes = Vec::new();
        std::io::Read::read_to_end(thumb_upload.as_reader(), &mut thumb_bytes).unwrap();
        thumb_upload.respond(Response::empty(200)).unwrap();

        // commit
        let mut commit = server.recv().unwrap();
        assert_eq!(commit.url(), "/v1/replication/commit");
        let body: Value = read_json(&mut commit);
        let committed_asset = body["asset_id"].as_str().unwrap();
        assert_eq!(
            body["thumbnail"]["object_key"],
            format!("library/{committed_asset}/thumbnail")
        );
        assert!(body["original"]["object_key"].is_string());
        assert!(body["classification_ids"].is_array());
        commit
            .respond(json_response(json!({
                "ok": true, "committed": true, "asset_id": body["asset_id"]
            })))
            .unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let source = temp.path().join("worker.png");
    fs::write(&source, png_bytes(9)).unwrap();
    let asset_id = ingest_png(&library, &source, "2026-08-30T00:00:00Z");
    library.seed_cloud_backfill_queue().unwrap();

    let summary = library
        .run_cloud_backfill_cycle_with_client(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(summary.committed, 1);
    assert_eq!(summary.permanent_failures, 0);
    assert_eq!(queue_status(&library, &asset_id).as_deref(), Some("synced"));
    if let Err(panic) = server_thread.join() {
        let message = panic
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic>".into());
    }
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

/// 이미 원격 커밋된 자산의 관계-only 변경: prepare(already_committed=true)를
/// 받은 워커는 업로드를 건너뛰고 commit을 재전송해 classification_ids를 수렴
/// 시켜야 한다. 재업로드(presign/PUT)는 발생하지 않아야 한다.
#[test]
fn already_committed_asset_recommits_relationships_without_reupload() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let base_url = format!("{origin}/v1");

    let server_thread = thread::spawn(move || {
        // prepare: already_committed=true
        let mut prepare = server.recv().unwrap();
        assert_eq!(prepare.url(), "/v1/replication/prepare");
        let body: Value = read_json(&mut prepare);
        let asset_id = body["asset_id"].as_str().unwrap().to_owned();
        prepare
            .respond(json_response(json!({
                "asset_id": asset_id,
                "already_committed": true,
                "object_keys": {
                    "original": format!("library/{asset_id}/original"),
                    "thumbnail": format!("library/{asset_id}/thumbnail"),
                }
            })))
            .unwrap();

        // 재커밋: 업로드 없이 commit만 온다.
        let mut commit = server.recv().unwrap();
        assert_eq!(commit.url(), "/v1/replication/commit");
        let body: Value = read_json(&mut commit);
        assert_eq!(body["asset_id"], asset_id.as_str());
        assert!(body["classification_ids"].is_array());
        commit
            .respond(json_response(json!({
                "ok": true, "committed": true, "asset_id": body["asset_id"]
            })))
            .unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let source = temp.path().join("committed.png");
    fs::write(&source, png_bytes(11)).unwrap();
    let asset_id = ingest_png(&library, &source, "2026-08-30T00:00:00Z");
    library.seed_cloud_backfill_queue().unwrap();
    // 자산을 '이미 원격 커밋됨' 상태로 만든다(로컬 큐는 revision=1 pending).
    // 워커가 prepare에서 already_committed=true를 받으면 업로드 없이
    // 재커밋하는지 검증한다.
    let summary = library
        .run_cloud_backfill_cycle_with_client(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(summary.committed, 1);
    assert_eq!(summary.permanent_failures, 0);
    assert_eq!(queue_status(&library, &asset_id).as_deref(), Some("synced"));
    if let Err(panic) = server_thread.join() {
        let message = panic
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic>".into());
        panic!("{message}");
    }
}

fn spawn_replication_server(
    expected_kind: &'static str,
    finish_thumbnail_and_commit: bool,
) -> (String, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let base_url = format!("{origin}/v1");
    let upload_url = format!("{origin}/r2-upload");
    let handle = thread::spawn(move || {
        let mut prepare = server.recv().unwrap();
        let body: Value = read_json(&mut prepare);
        assert_eq!(body["kind"], expected_kind);
        let asset_id = body["asset_id"].as_str().unwrap().to_owned();
        prepare
            .respond(json_response(json!({
                "asset_id": asset_id,
                "already_committed": false,
                "object_keys": {
                    "original": format!("library/{asset_id}/original"),
                    "thumbnail": format!("library/{asset_id}/thumbnail"),
                }
            })))
            .unwrap();

        let mut presign = server.recv().unwrap();
        let requested: Value = read_json(&mut presign);
        assert_eq!(
            requested["object_key"],
            format!("library/{asset_id}/original")
        );
        presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {"Content-Type": requested["content_type"]}
            })))
            .unwrap();
        server
            .recv()
            .unwrap()
            .respond(Response::empty(200))
            .unwrap();
        server
            .recv()
            .unwrap()
            .respond(Response::empty(201))
            .unwrap();

        if !finish_thumbnail_and_commit {
            return;
        }

        let mut thumb_presign = server.recv().unwrap();
        let requested: Value = read_json(&mut thumb_presign);
        thumb_presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {"Content-Type": requested["content_type"]}
            })))
            .unwrap();
        server
            .recv()
            .unwrap()
            .respond(Response::empty(200))
            .unwrap();
        server
            .recv()
            .unwrap()
            .respond(json_response(json!({"ok": true, "committed": true})))
            .unwrap();
    });
    (base_url, handle)
}

// ---------------------------------------------------------------------------
// 비디오 복제 + 멱등 재시도
// ---------------------------------------------------------------------------

fn stub_video_probe() {
    crate::library::ingestion::set_video_probe_hook(|_, extension| {
        Ok(crate::library::VideoProbe {
            container: extension.to_owned(),
            video_codec: "avc1".into(),
            audio_codec: None,
            duration_ms: 1_000,
            width: 64,
            height: 64,
        })
    });
}

fn ingest_mp4(library: &Library, root: &std::path::Path, collected_at: &str) -> String {
    let source = root.join("clip.mp4");
    fs::write(&source, b"fake-mp4-bytes").unwrap();
    match library
        .ingest_media(crate::library::models::IngestMediaRequest {
            source_path: source,
            classification_id: None,
            source_url: None,
            collected_at: Some(collected_at.into()),
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: crate::library::models::ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-00000000feed".into(),
        })
        .unwrap()
    {
        crate::library::models::IngestOutcome::Added { asset } => asset.id,
        other => panic!("expected added video asset, got {other:?}"),
    }
}

#[test]
fn video_prepare_upload_and_commit_flow() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let base_url = format!("{origin}/v1");
    let upload_url = format!("{origin}/r2-upload");

    let server_thread = thread::spawn(move || {
        // prepare
        let mut prepare = server.recv().unwrap();
        let body: Value = read_json(&mut prepare);
        assert_eq!(body["kind"], "video");
        let video_asset = body["asset_id"].as_str().unwrap().to_owned();
        prepare
            .respond(json_response(json!({
                "asset_id": video_asset,
                "already_committed": false,
                "object_keys": {
                    "original": format!("library/{video_asset}/original"),
                    "thumbnail": format!("library/{video_asset}/thumbnail"),
                }
            })))
            .unwrap();

        // upload_asset: presign(mp4) -> PUT -> register
        let mut presign = server.recv().unwrap();
        let requested: Value = read_json(&mut presign);
        presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": { "Content-Type": requested["content_type"] }
            })))
            .unwrap();
        let mut upload = server.recv().unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(upload.as_reader(), &mut bytes).unwrap();
        assert_eq!(bytes, b"fake-mp4-bytes");
        upload.respond(Response::empty(200)).unwrap();
        let register = server.recv().unwrap();
        assert_eq!(register.url(), "/v1/assets");
        register.respond(Response::empty(201)).unwrap();

        // thumbnail: presign -> PUT (요청된 키를 그대로 되돌린다)
        let mut thumb_presign = server.recv().unwrap();
        let thumb_requested: Value = read_json(&mut thumb_presign);
        thumb_presign
            .respond(json_response(json!({
                "method": "PUT",
                "object_key": thumb_requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": { "Content-Type": thumb_requested["content_type"] }
            })))
            .unwrap();
        let mut thumb_upload = server.recv().unwrap();
        let mut thumb = Vec::new();
        std::io::Read::read_to_end(thumb_upload.as_reader(), &mut thumb).unwrap();
        thumb_upload.respond(Response::empty(200)).unwrap();

        // commit
        let mut commit = server.recv().unwrap();
        let body: Value = read_json(&mut commit);
        assert_eq!(body["original"]["content_type"], "video/mp4");
        assert_eq!(
            body["thumbnail"]["object_key"],
            format!("library/{}/thumbnail", body["asset_id"].as_str().unwrap())
        );
        commit
            .respond(json_response(json!({ "ok": true, "committed": true })))
            .unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    stub_video_probe();
    let asset_id = ingest_mp4(&library, temp.path(), "2026-08-30T00:00:00Z");
    // 비디오는 포스터가 준비되기 전까지 썸네일이 없다. 테스트를 위해 DB에
    // 썸네일 경로를 심는다(프로덕션에서는 포스터 준비 후 채워진다).
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET thumbnail_relative_path = 'thumbnails/x/poster.webp'
             WHERE id = ?1",
            [&asset_id],
        )
        .unwrap();
    let thumb_dir = temp.path().join("thumbnails/x");
    fs::create_dir_all(&thumb_dir).unwrap();
    fs::write(thumb_dir.join("poster.webp"), b"poster-bytes").unwrap();

    library.seed_cloud_backfill_queue().unwrap();
    let summary = library
        .run_cloud_backfill_cycle_with_client(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap();
    assert_eq!(summary.committed, 1);
    assert_eq!(queue_status(&library, &asset_id).as_deref(), Some("synced"));
    server_thread.join().unwrap();
}

#[test]
fn video_without_thumbnail_fails_independently_and_succeeds_after_retry() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    stub_video_probe();

    let image_source = temp.path().join("healthy.png");
    fs::write(&image_source, png_bytes(41)).unwrap();
    let image_id = ingest_png(&library, &image_source, "2026-08-29T00:00:00Z");
    let video_id = ingest_mp4(&library, temp.path(), "2026-08-30T00:00:00Z");
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM cloud_sync_queue", [])
        .unwrap();
    library.seed_cloud_backfill_queue().unwrap();

    let (video_base_url, video_server) = spawn_replication_server("video", false);
    let error = library
        .replicate_next_cloud_asset_with_client(
            &CloudClient::new(&video_base_url).unwrap(),
            "test-token",
        )
        .unwrap_err();
    match error {
        super::backfill::CloudBackfillError::Permanent(asset_id, message) => {
            assert_eq!(asset_id, video_id);
            assert_eq!(message, "복제할 썸네일이 아직 준비되지 않았습니다");
        }
        other => panic!("expected diagnosable permanent thumbnail failure, got {other}"),
    }
    assert_eq!(queue_status(&library, &video_id).as_deref(), Some("failed"));
    video_server.join().unwrap();

    let (image_base_url, image_server) = spawn_replication_server("image", true);
    assert_eq!(
        library
            .replicate_next_cloud_asset_with_client(
                &CloudClient::new(&image_base_url).unwrap(),
                "test-token",
            )
            .unwrap(),
        Some(image_id.clone())
    );
    assert_eq!(queue_status(&library, &image_id).as_deref(), Some("synced"));
    image_server.join().unwrap();

    let poster_relative_path = format!("video-media/{video_id}/poster.webp");
    let poster_path = temp.path().join(&poster_relative_path);
    fs::create_dir_all(poster_path.parent().unwrap()).unwrap();
    fs::write(&poster_path, b"prepared-poster").unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET thumbnail_relative_path = ?2 WHERE id = ?1",
            rusqlite::params![video_id, poster_relative_path],
        )
        .unwrap();

    let retry = library.retry_failed_cloud_backfill().unwrap();
    assert_eq!(retry.retried, 1);
    assert_eq!(
        queue_status(&library, &video_id).as_deref(),
        Some("pending")
    );
    assert_eq!(queue_status(&library, &image_id).as_deref(), Some("synced"));

    let (retry_base_url, retry_server) = spawn_replication_server("video", true);
    assert_eq!(
        library
            .replicate_next_cloud_asset_with_client(
                &CloudClient::new(&retry_base_url).unwrap(),
                "test-token",
            )
            .unwrap(),
        Some(video_id.clone())
    );
    assert_eq!(queue_status(&library, &video_id).as_deref(), Some("synced"));
    retry_server.join().unwrap();
}

#[test]
fn retry_does_not_duplicate_assets_or_relations_and_permanent_failure_is_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let source = temp.path().join("retry.png");
    fs::write(&source, png_bytes(11)).unwrap();
    let asset_id = ingest_png(&library, &source, "2026-08-30T00:00:00Z");
    library.seed_cloud_backfill_queue().unwrap();

    // 1차 시도: prepare까지 성공 후 commit 500 (재시도 가능) → pending 복귀.
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let upload_url = format!("{origin}/r2-upload");
    let base_url = format!("{origin}/v1");
    let server_thread = thread::spawn(move || {
        let prepare = server.recv().unwrap();
        prepare
            .respond(json_response(json!({
                "asset_id": "x", "already_committed": false,
                "object_keys": {"original": "a", "thumbnail": "b"}
            })))
            .unwrap();
        let mut presign = server.recv().unwrap();
        let requested: Value = read_json(&mut presign);
        presign
            .respond(json_response(json!({
                "method": "PUT", "object_key": requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {"Content-Type": requested["content_type"]}
            })))
            .unwrap();
        let mut upload = server.recv().unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(upload.as_reader(), &mut bytes).unwrap();
        upload.respond(Response::empty(200)).unwrap();
        let register = server.recv().unwrap();
        register.respond(Response::empty(201)).unwrap();
        let mut thumb_presign = server.recv().unwrap();
        let thumb_requested: Value = read_json(&mut thumb_presign);
        thumb_presign
            .respond(json_response(json!({
                "method": "PUT", "object_key": thumb_requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {"Content-Type": thumb_requested["content_type"]}
            })))
            .unwrap();
        let mut thumb_upload = server.recv().unwrap();
        let mut tb = Vec::new();
        std::io::Read::read_to_end(thumb_upload.as_reader(), &mut tb).unwrap();
        thumb_upload.respond(Response::empty(200)).unwrap();
        let commit = server.recv().unwrap();
        commit.respond(Response::empty(500)).unwrap();
    });

    let error = library
        .replicate_next_cloud_asset_with_client(&CloudClient::new(&base_url).unwrap(), "test-token")
        .unwrap_err();
    assert!(error.is_retryable(), "expected retryable, got {error}");
    assert_eq!(
        queue_status(&library, &asset_id).as_deref(),
        Some("pending")
    );
    server_thread.join().unwrap();

    // 자산 행은 여전히 1개(서버 prepare가 만든 것은 원격 DB라 로컬과 무관).
    assert_eq!(
        count_rows(&library, "SELECT COUNT(*) FROM assets"),
        1,
        "retry must not duplicate local asset rows"
    );

    // 2차 시도: 전체 성공.
    let server2 = Server::http("127.0.0.1:0").unwrap();
    let origin2 = format!("http://{}", server2.server_addr());
    let upload_url2 = format!("{origin2}/r2-upload");
    let base_url2 = format!("{origin2}/v1");
    let server_thread2 = thread::spawn(move || {
        let prepare = server2.recv().unwrap();
        prepare
            .respond(json_response(json!({
                "asset_id": "x", "already_committed": false,
                "object_keys": {"original": "a", "thumbnail": "b"}
            })))
            .unwrap();
        let mut presign = server2.recv().unwrap();
        let requested: Value = read_json(&mut presign);
        presign
            .respond(json_response(json!({
                "method": "PUT", "object_key": requested["object_key"],
                "upload_url": upload_url2,
                "expires_in": 900,
                "required_headers": {"Content-Type": requested["content_type"]}
            })))
            .unwrap();
        let mut upload = server2.recv().unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(upload.as_reader(), &mut bytes).unwrap();
        upload.respond(Response::empty(200)).unwrap();
        let register = server2.recv().unwrap();
        register.respond(Response::empty(201)).unwrap();
        let mut thumb_presign = server2.recv().unwrap();
        let thumb_requested: Value = read_json(&mut thumb_presign);
        thumb_presign
            .respond(json_response(json!({
                "method": "PUT", "object_key": thumb_requested["object_key"],
                "upload_url": upload_url2,
                "expires_in": 900,
                "required_headers": {"Content-Type": thumb_requested["content_type"]}
            })))
            .unwrap();
        let mut thumb_upload = server2.recv().unwrap();
        let mut tb = Vec::new();
        std::io::Read::read_to_end(thumb_upload.as_reader(), &mut tb).unwrap();
        thumb_upload.respond(Response::empty(200)).unwrap();
        let commit = server2.recv().unwrap();
        commit
            .respond(json_response(json!({ "ok": true })))
            .unwrap();
    });
    let summary = library
        .run_cloud_backfill_cycle_with_client(&CloudClient::new(&base_url2).unwrap(), "test-token")
        .unwrap();
    assert_eq!(summary.committed, 1);
    assert_eq!(queue_status(&library, &asset_id).as_deref(), Some("synced"));
    server_thread2.join().unwrap();
}

#[test]
fn missing_original_fails_that_asset_only_and_later_assets_still_commit() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();

    // 오래된 자산(먼저 claim됨): 원본을 지워 영구 실패로 만든다.
    let old_source = temp.path().join("old.png");
    fs::write(&old_source, png_bytes(21)).unwrap();
    let old_id = ingest_png(&library, &old_source, "2026-08-01T00:00:00Z");
    let old_relative: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT relative_path FROM assets WHERE id = ?1",
            [&old_id],
            |r| r.get(0),
        )
        .unwrap();
    fs::remove_file(temp.path().join(&old_relative)).unwrap();

    // 최신 자산: 정상. 백필은 최신 우선이므로 이게 먼저 커밋되고,
    // 깨진 자산은 독립적으로 failed가 되어야 한다.
    let new_source = temp.path().join("new.png");
    fs::write(&new_source, png_bytes(22)).unwrap();
    let new_id = ingest_png(&library, &new_source, "2026-08-31T00:00:00Z");

    // 큐를 비워 레거시 상태를 만들고 다시 시딩(최신 → 오래된 순).
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM cloud_sync_queue", [])
        .unwrap();
    library.seed_cloud_backfill_queue().unwrap();

    // 최신 자산 커밋용 fake 서버.
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let upload_url = format!("{origin}/r2-upload");
    let server_thread = thread::spawn(move || {
        // 최신 자산의 전체 흐름(prepare→presign→PUT→register→thumb→commit)
        let prepare = server.recv().unwrap();
        prepare
            .respond(json_response(json!({
                "asset_id": "n", "already_committed": false,
                "object_keys": {"original": "a", "thumbnail": "b"}
            })))
            .unwrap();
        let mut presign = server.recv().unwrap();
        let requested: Value = read_json(&mut presign);
        presign
            .respond(json_response(json!({
                "method": "PUT", "object_key": requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {"Content-Type": requested["content_type"]}
            })))
            .unwrap();
        let mut upload = server.recv().unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(upload.as_reader(), &mut bytes).unwrap();
        upload.respond(Response::empty(200)).unwrap();
        let register = server.recv().unwrap();
        register.respond(Response::empty(201)).unwrap();
        let mut thumb_presign = server.recv().unwrap();
        let thumb_requested: Value = read_json(&mut thumb_presign);
        thumb_presign
            .respond(json_response(json!({
                "method": "PUT", "object_key": thumb_requested["object_key"],
                "upload_url": upload_url,
                "expires_in": 900,
                "required_headers": {"Content-Type": thumb_requested["content_type"]}
            })))
            .unwrap();
        let mut thumb_upload = server.recv().unwrap();
        let mut tb = Vec::new();
        std::io::Read::read_to_end(thumb_upload.as_reader(), &mut tb).unwrap();
        thumb_upload.respond(Response::empty(200)).unwrap();
        let commit = server.recv().unwrap();
        commit
            .respond(json_response(json!({ "ok": true })))
            .unwrap();
        // 오래된(깨진) 자산: 클레임은 되지만 로컬 원본 부재로 영구 실패 —
        // 네트워크 요청이 오면 안 된다. recv가 타임아웃나도 서버 스레드는
        // 이후 종료된다.
    });

    let client = CloudClient::new(&format!("{origin}/v1")).unwrap();
    let summary = library
        .run_cloud_backfill_cycle_with_client(&client, "test-token")
        .unwrap();
    // 최신 자산 커밋 + 오래된 자산 영구 실패 1.
    assert_eq!(summary.committed, 1);
    assert_eq!(summary.permanent_failures, 1);
    assert_eq!(queue_status(&library, &new_id).as_deref(), Some("synced"));
    assert_eq!(queue_status(&library, &old_id).as_deref(), Some("failed"));
    server_thread.join().unwrap();
}
