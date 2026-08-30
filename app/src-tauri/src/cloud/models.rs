use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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
