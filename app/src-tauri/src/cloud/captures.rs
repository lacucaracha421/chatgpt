use std::{fs, io, path::Path, path::PathBuf};

use rusqlite::OptionalExtension;
use uuid::Uuid;

use super::{
    client::CloudClient,
    models::{ClassificationSnapshotPublish, RemoteCapture, RemoteCaptureKind},
};
use crate::library::{
    error::LibraryError,
    models::{ImportSource, IngestMediaRequest, IngestOutcome},
    Library,
};

/// 클라우드 캡처 수신함(원격 → 로컬) 폴 한 번의 결과 요약. 로컬 → 클라우드
/// `cloud_sync_queue` 동기화와는 무관하다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudCaptureSyncResult {
    /// 이번 폴에서 실제 처리 대상으로 삼은 유효한 pending capture 수.
    /// malformed 기록은 포함하지 않는다. 25건 상한도 이 값 기준.
    pub attempted: u32,
    /// 최종 acknowledge까지 성공한 수. 신규 Added, ExactDuplicate,
    /// 이전 실행에서 이미 로컬 import돼 ack만 재시도한 경우를 포함한다.
    pub acknowledged: u32,
    /// 다운로드·ingest·acknowledge 오류로 이번 폴에서 완료되지 못한 수. 원격 pending 유지.
    pub failed: u32,
    /// 유사 이미지 검토로 acknowledge하지 않고 pending에 남긴 수.
    pub review_pending: u32,
    /// Newly added Assets in this poll.
    pub added: u32,
    /// Newly added video Assets; used to trigger normal video preparation.
    pub video_added: u32,
    /// ExactDuplicate outcomes whose classification membership actually changed.
    pub classification_changed: u32,
}

/// 캡처 다운로드 상한. 이미지는 수집 파이프라인의 상한을 따르고,
/// 영상은 확장 API의 원격 영상 상한을 따른다.
const MAX_CAPTURE_IMAGE_BYTES: u64 = crate::library::ingestion::MAX_IMAGE_BYTES;
const MAX_CAPTURE_VIDEO_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 한 건의 캡처를 완전히 소비한 결과. Imported는 로컬 수집 확정 + 원격
/// acknowledge까지 끝난 경우다.
enum ConsumedCapture {
    Added { video: bool },
    ExactDuplicate { classification_changed: bool },
    ReviewPending,
}

impl Library {
    /// 한 번의 폴에서 처리 시도하는 pending capture 상한.
    const MAX_CAPTURES_PER_SYNC: usize = 25;

    /// 클라우드 캡처 수신함에서 pending capture 목록을 한 번 받아 최대
    /// `MAX_CAPTURES_PER_SYNC`건까지 순차적으로 수집한다. 성공한 캡처만 원격에서
    /// imported로 표시한다. 방향은 클라우드 → 로컬이며 `cloud_sync_queue`(로컬 →
    /// 클라우드)와 상태를 공유하지 않는다.
    pub(crate) fn sync_next_cloud_capture(&self) -> Result<CloudCaptureSyncResult, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(CloudCaptureSyncResult::default());
        }
        let base_url = config
            .api_base_url
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(&base_url)?;
        let result = self.sync_next_cloud_capture_with(&client, &token)?;
        // 수집 폴과 같은 주기로 분류 스냅샷을 게시해 모바일 확장이 PC 없이
        // donut을 그릴 수 있게 유지한다. 게시 실패는 수집 결과를 막지 않는다.
        if let Err(error) = self.publish_classification_snapshot() {
            eprintln!("cloud classifications publish: {error}");
        }
        Ok(result)
    }

    pub(crate) fn test_cloud_capture_connection(&self) -> Result<u32, LibraryError> {
        let config = self.cloud_sync_config()?;
        let base_url = config.api_base_url.ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(&base_url)?;
        Ok(client.list_pending_captures(&token)?.len() as u32)
    }

    /// 현재 분류 상태의 스냅샷을 VPS에 게시한다. PC 라이브러리가 분류의
    /// 원본이며 VPS는 모바일 확장이 PC 없이 donut을 그리기 위한 최소 사본만
    /// 저장한다. 게시 실패는 수집 폴을 막지 않는다.
    pub(crate) fn publish_classification_snapshot(&self) -> Result<(), LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(());
        }
        let base_url = config
            .api_base_url
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(&base_url)?;
        let entries = self.list_classifications()?;
        let published_at = chrono::Utc::now().to_rfc3339();
        client.publish_classification_snapshot(
            &token,
            &ClassificationSnapshotPublish {
                entries: &entries,
                published_at: &published_at,
            },
        )
    }

    pub(super) fn sync_next_cloud_capture_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<CloudCaptureSyncResult, LibraryError> {
        // 한 번의 폴에서 상한까지 계속 소진한다. 실패한 캡처는 건너뛰고 다음
        // 캡처로 진행하므로 한 건의 오류가 이후 캡처를 막지 않는다.
        let captures = client.list_pending_captures(token)?;
        let mut result = CloudCaptureSyncResult::default();
        for payload in captures {
            if result.attempted >= Self::MAX_CAPTURES_PER_SYNC as u32 {
                break;
            }
            let capture = match RemoteCapture::try_from(payload) {
                Ok(capture) => capture,
                Err(error) => {
                    // malformed 기록은 건너뛰고 다음 캡처를 계속 처리한다.
                    eprintln!("cloud capture: skipping malformed record: {error}");
                    continue;
                }
            };
            result.attempted += 1;
            if self.cloud_capture_imported(&capture.id)? {
                // 이전 실행에서 로컬 수집은 끝났지만 acknowledge가 유실된 케이스.
                let imported_at = chrono::Utc::now().to_rfc3339();
                client.acknowledge_capture_imported(&capture.id, token, &imported_at)?;
                self.mark_cloud_capture_acknowledged(&capture.id)?;
                result.acknowledged += 1;
                continue;
            }
            match self.consume_cloud_capture(client, token, &capture) {
                Ok(outcome) => match outcome {
                    ConsumedCapture::Added { video } => {
                        result.acknowledged += 1;
                        result.added += 1;
                        if video {
                            result.video_added += 1;
                        }
                    }
                    ConsumedCapture::ExactDuplicate { classification_changed } => {
                        result.acknowledged += 1;
                        if classification_changed {
                            result.classification_changed += 1;
                        }
                    }
                    ConsumedCapture::ReviewPending => result.review_pending += 1,
                },
                Err(error) => {
                    // 한 건의 실패가 이후 캡처를 막지 않는다. 재시도 가능
                    // 오류라도 다음 캡처로 넘어가고, 문제의 원인은 로그로 남긴다.
                    result.failed += 1;
                    eprintln!("cloud capture {}: {error}", capture.id);
                }
            }
        }
        Ok(result)
    }

    fn consume_cloud_capture(
        &self,
        client: &CloudClient,
        token: &str,
        capture: &RemoteCapture,
    ) -> Result<ConsumedCapture, LibraryError> {
        let maximum_bytes = match capture.media_kind {
            RemoteCaptureKind::Image => MAX_CAPTURE_IMAGE_BYTES,
            RemoteCaptureKind::Video => MAX_CAPTURE_VIDEO_BYTES,
        };
        let ticket = client.capture_download_ticket(&capture.id, token)?;
        let staging_directory = self.root().join("assets").join(".staging");
        fs::create_dir_all(&staging_directory)
            .map_err(|_| LibraryError::CloudCaptureStagingFailed)?;
        let temporary_path = staging_directory.join(format!(
            "remote-capture-{}.{}",
            Uuid::new_v4(),
            capture_extension(capture)?
        ));
        let downloaded_bytes =
            client.download_capture_media(&ticket, &temporary_path, maximum_bytes);
        let temporary = TemporaryCaptureDownload::new(temporary_path);
        let downloaded_bytes = downloaded_bytes?;
        if downloaded_bytes == 0 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let outcome = self.ingest_capture_media(capture, temporary.path())?;
        // ingest_media는 성공 시 staging 파일을 library로 이동시키므로
        // TemporaryCaptureDownload의 Drop 정리는 NotFound를 조용히 지나간다.
        drop(temporary);
        let (status, asset_id, consumed) = match &outcome {
            IngestOutcome::Added { asset } => (
                "imported",
                Some(asset.id.clone()),
                ConsumedCapture::Added { video: capture.media_kind == RemoteCaptureKind::Video },
            ),
            IngestOutcome::ExactDuplicate {
                existing_asset_id, classification_changed, ..
            } => (
                "imported",
                Some(existing_asset_id.clone()),
                ConsumedCapture::ExactDuplicate { classification_changed: *classification_changed },
            ),
            IngestOutcome::ReviewPending { .. } => {
                // 유사 이미지 검토는 로컬 확정이 아니다. 원격은 imported로 만들지 않고
                // 다음 폴에서 다시 시도한다.
                return Ok(ConsumedCapture::ReviewPending);
            }
        };
        let imported_at = chrono::Utc::now().to_rfc3339();
        // 로컬 수집 확정을 먼저 기록한다. ack 실패 시 다음 폴이 이 기록으로
        // 중복 수집 없이 ack만 재시도할 수 있다. ack가 영원히 실패하면
        // 로컬은 이미 온전하고 원격 pending이 남는 쪽이 안전하다.
        self.mark_cloud_capture_imported(&capture.id, status, asset_id.as_deref(), &imported_at)?;
        client.acknowledge_capture_imported(&capture.id, token, &imported_at)?;
        self.mark_cloud_capture_acknowledged(&capture.id)?;
        Ok(consumed)
    }

    fn ingest_capture_media(
        &self,
        capture: &RemoteCapture,
        source_path: &Path,
    ) -> Result<IngestOutcome, LibraryError> {
        let request = self.capture_ingest_request(capture, source_path)?;
        self.ingest_media(request)
    }

    fn capture_ingest_request(
        &self,
        capture: &RemoteCapture,
        source_path: &Path,
    ) -> Result<IngestMediaRequest, LibraryError> {
        // object key와 캡처 ID만 경로 재료로 쓴다. 원격 원본 파일명은 신뢰하지 않는다.
        let source_url = capture.source_url.as_deref().filter(|value| {
            value.starts_with("https://x.com/") || value.starts_with("https://twitter.com/")
        });
        let creator_url = source_url.and_then(capture_creator_url);
        let creator_handle = capture.creator_handle.clone().or_else(|| {
            creator_url.as_deref().and_then(|url| {
                url::Url::parse(url)
                    .ok()
                    .and_then(|parsed| x_creator_handle(&parsed))
            })
        });
        Ok(IngestMediaRequest {
            source_path: source_path.to_path_buf(),
            classification_id: self.valid_capture_classification_id(capture)?,
            source_url: source_url.map(str::to_string),
            collected_at: Some(capture.created_at.clone()),
            replace_duplicate_metadata: false,
            source_published_at: capture
                .source_published_at
                .clone()
                .filter(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok()),
            creator_name: None,
            creator_handle,
            creator_url,
            import_source: ImportSource::BrowserExtension,
            import_batch_id: Uuid::new_v4().to_string(),
        })
    }

    fn valid_capture_classification_id(
        &self,
        capture: &RemoteCapture,
    ) -> Result<Option<String>, LibraryError> {
        let Some(classification_id) = capture.classification_id.as_deref() else {
            return Ok(None);
        };
        let exists = self.connection()?.query_row(
            "SELECT 1 FROM classification_entries WHERE id = ?1 LIMIT 1",
            [classification_id],
            |_| Ok(()),
        ).optional()?.is_some();
        Ok(exists.then(|| classification_id.to_owned()))
    }
}

impl Library {
    /// 이전 실행에서 이미 로컬 수집이 끝난 캡처인지 확인한다.
    pub(crate) fn cloud_capture_imported(&self, capture_id: &str) -> Result<bool, LibraryError> {
        let status: Option<String> = self
            .connection()?
            .query_row(
                "SELECT status FROM cloud_capture_imports WHERE capture_id = ?1
                 AND status IN ('imported', 'acknowledged')",
                [capture_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(status.is_some())
    }

    pub(crate) fn mark_cloud_capture_imported(
        &self,
        capture_id: &str,
        status: &str,
        asset_id: Option<&str>,
        imported_at: &str,
    ) -> Result<(), LibraryError> {
        if capture_id.trim().is_empty() {
            return Err(LibraryError::InvalidCloudCaptureRecord);
        }
        self.connection()?.execute(
            "INSERT INTO cloud_capture_imports (capture_id, status, asset_id, imported_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(capture_id) DO UPDATE SET status = ?2, asset_id = ?3",
            rusqlite::params![capture_id, status, asset_id, imported_at],
        )?;
        Ok(())
    }

    pub(crate) fn mark_cloud_capture_acknowledged(
        &self,
        capture_id: &str,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE cloud_capture_imports SET status = 'acknowledged' WHERE capture_id = ?1",
            [capture_id],
        )?;
        Ok(())
    }
}

/// staging 경로의 접미사는 미디어 종류에서 온다. 원격 파일명은 확장자로도 쓰지 않는다.
fn capture_extension(capture: &RemoteCapture) -> Result<&'static str, LibraryError> {
    let from_content_type = capture
        .content_type
        .as_deref()
        .and_then(|value| match value {
            "image/png" => Some("png"),
            "image/jpeg" => Some("jpg"),
            "image/webp" => Some("webp"),
            "image/gif" => Some("gif"),
            "video/mp4" => Some("mp4"),
            "video/webm" => Some("webm"),
            _ => None,
        });
    match capture.media_kind {
        RemoteCaptureKind::Image => Ok(from_content_type.unwrap_or("png")),
        RemoteCaptureKind::Video => Ok(from_content_type.unwrap_or("mp4")),
    }
}

fn capture_creator_url(source_url: &str) -> Option<String> {
    let parsed = url::Url::parse(source_url).ok()?;
    let handle = x_creator_handle(&parsed)?;
    Some(format!("https://x.com/{handle}"))
}

fn x_creator_handle(url: &url::Url) -> Option<String> {
    if !matches!(url.host_str(), Some("x.com" | "twitter.com")) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let handle = segments.next()?;
    let status = segments.next()?;
    if handle.is_empty() || handle.eq_ignore_ascii_case("i") || status != "status" {
        return None;
    }
    Some(handle.to_string())
}

fn is_retryable_capture_error(error: &LibraryError) -> bool {
    match error {
        LibraryError::CloudRequestTimedOut | LibraryError::CloudRequestUnavailable => true,
        LibraryError::CloudCaptureListRejected(status)
        | LibraryError::CloudCaptureTicketRejected(status)
        | LibraryError::CloudCaptureDownloadRejected(status)
        | LibraryError::CloudCaptureAcknowledgementRejected(status) => {
            *status == 429 || (500..=599).contains(status)
        }
        _ => false,
    }
}

struct TemporaryCaptureDownload {
    path: PathBuf,
}

impl TemporaryCaptureDownload {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryCaptureDownload {
    fn drop(&mut self) {
        // 삭제 실패는 치명적이지 않다. 남은 임시 파일은 라이브러리 자산이 아니다.
        let _ =
            fs::remove_file(&self.path).is_err_and(|error| error.kind() != io::ErrorKind::NotFound);
    }
}
