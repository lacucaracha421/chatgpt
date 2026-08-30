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
