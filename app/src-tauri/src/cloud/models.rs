use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::library::error::LibraryError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudSyncConfig {
    pub enabled: bool,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudSyncQueueItem {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub status: String,
    pub revision: u64,
    pub retry_count: u32,
    pub updated_at: String,
    pub synced_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedAssetUpload {
    pub queue: CloudSyncQueueItem,
    pub object_key: String,
    pub source_relative_path: String,
    pub kind: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PresignUploadRequest<'a> {
    pub object_key: &'a str,
    pub content_type: &'a str,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PresignUploadResponse {
    pub method: String,
    pub object_key: String,
    pub upload_url: String,
    pub expires_in: u64,
    pub required_headers: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RegisterAssetRequest<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub object_key: &'a str,
    pub thumbnail_key: Option<&'a str>,
    pub content_type: Option<&'a str>,
    pub size_bytes: Option<u64>,
    pub sha256: Option<&'a str>,
}

/// 클라우드 캡처 수신함의 원격 pending capture 한 건.
/// X 확장 → VPS Capture API → R2로 적재된 결과이며, 반대 방향의
/// `CloudSyncQueueItem`(로컬 자산 → 클라우드 복제)과 개념이 다르다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteCapture {
    pub id: String,
    pub media_kind: RemoteCaptureKind,
    pub object_key: String,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub source_url: Option<String>,
    pub classification_id: Option<String>,
    pub creator_handle: Option<String>,
    pub source_published_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteCaptureKind {
    Image,
    Video,
}

impl RemoteCaptureKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

impl TryFrom<RemoteCapturePayload> for RemoteCapture {
    type Error = LibraryError;
    fn try_from(payload: RemoteCapturePayload) -> Result<Self, LibraryError> {
        if payload.id.trim().is_empty() || payload.object_key.trim().is_empty() {
            return Err(LibraryError::InvalidCloudCaptureRecord);
        }
        let media_kind = match payload.kind.as_str() {
            "image" => RemoteCaptureKind::Image,
            "video" => RemoteCaptureKind::Video,
            _ => return Err(LibraryError::InvalidCloudCaptureRecord),
        };
        Ok(Self {
            id: payload.id,
            media_kind,
            object_key: payload.object_key,
            content_type: payload.content_type,
            size_bytes: payload.size_bytes,
            source_url: payload.source_url,
            classification_id: payload.classification_id.and_then(|value| {
                let trimmed = value.trim();
                (!trimmed.is_empty() && trimmed.len() <= 200).then(|| trimmed.to_owned())
            }),
            creator_handle: payload.creator_handle,
            source_published_at: payload.source_published_at,
            created_at: payload.created_at,
        })
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RemoteCapturePage {
    #[serde(default)]
    pub captures: Vec<RemoteCapturePayload>,
}

/// 개별 기록의 필드 누락이 목록 전체를 죽이지 않도록 관대하게 역직렬화하고,
/// 유효성은 `TryFrom<RemoteCapturePayload>`에서 타입별로 확인한다.
#[derive(Debug, Deserialize)]
pub(crate) struct RemoteCapturePayload {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub object_key: String,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub source_url: Option<String>,
    pub classification_id: Option<String>,
    pub creator_handle: Option<String>,
    pub source_published_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RemoteCaptureDownloadTicket {
    pub method: String,
    pub download_url: String,
    pub required_headers: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AcknowledgeCaptureRequest {
    pub imported_at: String,
}

/// PC 라이브러리가 VPS에 게시하는 분류 스냅샷. 모바일 확장의 donut은
/// entries(레이아웃·핀은 확장 로컬 상태)만 소비하므로 확장 API 계약인
/// camelCase ClassificationEntry 배열을 그대로 전달한다. VPS는 이 스냅샷의
/// 보관소일 뿐 분류 데이터의 원본이 아니다.
#[derive(Debug, Serialize)]
pub(crate) struct ClassificationSnapshotPublish<'a> {
    pub entries: &'a [crate::library::models::ClassificationEntry],
    pub published_at: &'a str,
}

/// PC 라이브러리에서 계산한 X 사진 저장 키의 최신 전체 스냅샷.
#[derive(Debug, Serialize)]
pub(crate) struct SavedXMediaSnapshotPublish<'a> {
    pub keys: &'a [String],
}

/// CLOUD-006 복제: 서버 prepare 요청. 멱등 — 같은 asset_id로 재호출해도
/// 같은 object key를 돌려준다.
#[derive(Debug, Serialize)]
pub(crate) struct ReplicationPrepareRequest<'a> {
    pub asset_id: &'a str,
    pub kind: &'a str,
    pub content_type: &'a str,
    pub size_bytes: u64,
    pub sha256: &'a str,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReplicationPrepareResponse {
    pub asset_id: String,
    pub already_committed: bool,
    pub object_keys: BTreeMap<String, String>,
}

/// CLOUD-006 복제: 서버 commit 요청. 원본·썸네일 variant와 모바일 브라우징
/// 메타데이터, 분류 관계를 한 번에 커밋한다.
#[derive(Debug, Serialize)]
pub(crate) struct ReplicationCommitRequest {
    pub asset_id: String,
    pub kind: String,
    pub original: ReplicationVariantPayload,
    pub thumbnail: ReplicationVariantPayload,
    pub content_type: String,
    pub collected_at: Option<String>,
    pub source_published_at: Option<String>,
    pub source_url: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub import_source: Option<String>,
    pub classification_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReplicationVariantPayload {
    pub object_key: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}
