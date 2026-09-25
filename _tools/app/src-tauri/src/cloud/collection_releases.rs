//! Wire shapes of the manga release-notification channel (`/v1/collections/releases`,
//! server `collection_releases.py`).
//!
//! The server models are strict (`extra="forbid"`, strict types), so these structs carry
//! exactly the server's fields, and every event is checked against the server's bounds
//! before it is sent: one invalid item would reject the whole chunk.
use serde::{Deserialize, Serialize};

use crate::library::error::LibraryError;

/// Items per chunk (the server's `MAX_ITEMS`).
pub(crate) const CHUNK_ITEMS: usize = 500;
/// Item bytes per chunk, under the server's 4 MiB body limit with room for the envelope.
pub(crate) const MAX_CHUNK_BYTES: usize = 3 * 1024 * 1024 + 512 * 1024;
/// Rows the server stores at most (`MAX_EVENTS`); the PC uploads its newest unread events.
pub(crate) const MAX_EVENTS: usize = 5_000;
/// Read-log page size (the server allows 1..=200).
pub(crate) const PAGE_LIMIT: i64 = 200;
pub(crate) const MAX_CURSOR: i64 = 9_007_199_254_740_991;

const PROVIDERS: [&str; 3] = ["aladin", "kakao", "mangadex"];
const KINDS: [&str; 3] = [
    "new_volume",
    "release_date_changed",
    "release_status_changed",
];

fn charset(value: &str, max: usize, extra: &[u8]) -> bool {
    (1..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}

/// `^[A-Za-z0-9_.:-]{1,128}$`
pub(crate) fn valid_event_id(value: &str) -> bool {
    charset(value, 128, b"_.:-")
}

/// `^[A-Za-z0-9_-]{1,128}$`
pub(crate) fn valid_collection_id(value: &str) -> bool {
    charset(value, 128, b"_-")
}

/// One unread release event (`Event`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseEvent {
    pub event_id: String,
    pub collection_id: String,
    pub collection_name: String,
    pub provider: String,
    pub kind: String,
    pub volume_number: i64,
    pub previous_value: Option<String>,
    pub current_value: Option<String>,
    pub detected_at: String,
}

impl ReleaseEvent {
    pub(crate) fn valid(&self) -> bool {
        let value = |v: &Option<String>| v.as_deref().is_none_or(|v| v.chars().count() <= 200);
        valid_event_id(&self.event_id)
            && valid_collection_id(&self.collection_id)
            && (1..=2000).contains(&self.collection_name.chars().count())
            && PROVIDERS.contains(&self.provider.as_str())
            && KINDS.contains(&self.kind.as_str())
            && (1..=999).contains(&self.volume_number)
            && value(&self.previous_value)
            && value(&self.current_value)
            && (1..=64).contains(&self.detected_at.len())
    }
}

/// `PUT /v1/collections/releases/unread`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseUpload {
    pub version: u8,
    pub operation_id: String,
    /// A positive decimal integer (Unix milliseconds at upload start), ordered numerically.
    pub generation: String,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub items: Vec<ReleaseEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseUploadResult {
    pub operation_id: String,
    pub generation: String,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub items: u64,
    #[serde(default)]
    pub already_read: Vec<String>,
}

/// One entry of the read log (`GET …/reads`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadEntry {
    pub sequence: i64,
    pub operation_id: String,
    pub collection_id: String,
    pub event_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadPage {
    pub version: u8,
    pub after: i64,
    pub last_sequence: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<ReadEntry>,
}

/// Split the unread set into chunks of one generation; the last (or only, possibly empty)
/// chunk is `final`, which retires every older-generation event on the server.
pub(crate) fn chunk_uploads(
    items: Vec<ReleaseEvent>,
    generation: i64,
) -> Result<Vec<ReleaseUpload>, LibraryError> {
    if !(1..=MAX_CURSOR).contains(&generation) {
        return Err(LibraryError::ReleaseSyncInvalid);
    }
    let mut chunks: Vec<Vec<ReleaseEvent>> = vec![Vec::new()];
    let mut bytes = 0;
    for item in items {
        let size = serde_json::to_vec(&item)
            .map_err(|_| LibraryError::InvalidCloudResponse)?
            .len()
            + 1;
        let current = chunks.last().map_or(0, Vec::len);
        if current > 0 && (current >= CHUNK_ITEMS || bytes + size > MAX_CHUNK_BYTES) {
            chunks.push(Vec::new());
            bytes = 0;
        }
        bytes += size;
        chunks.last_mut().expect("one chunk").push(item);
    }
    let last = chunks.len() - 1;
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(index, items)| ReleaseUpload {
            version: 1,
            operation_id: uuid::Uuid::new_v4().to_string(),
            generation: generation.to_string(),
            is_final: index == last,
            items,
        })
        .collect())
}

/// Reject a reply that does not answer this chunk.
pub(crate) fn validate_upload_result(
    upload: &ReleaseUpload,
    result: &ReleaseUploadResult,
) -> Result<(), LibraryError> {
    let ids: std::collections::HashSet<&str> =
        upload.items.iter().map(|i| i.event_id.as_str()).collect();
    if result.operation_id != upload.operation_id
        || result.generation != upload.generation
        || result.is_final != upload.is_final
        || result.items != upload.items.len() as u64
        || result
            .already_read
            .iter()
            .any(|id| !ids.contains(id.as_str()))
    {
        return Err(LibraryError::ReleaseSyncInvalid);
    }
    Ok(())
}

/// Reject a read-log page that does not continue from `after`.
pub(crate) fn validate_read_page(
    page: &ReadPage,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    let invalid = Err(LibraryError::ReleaseSyncInvalid);
    if page.version != 1 || page.after != after || page.items.len() as i64 > limit {
        return invalid;
    }
    let mut previous = after;
    for item in &page.items {
        if item.sequence <= previous
            || item.sequence > MAX_CURSOR
            || !valid_event_id(&item.event_id)
            || !valid_collection_id(&item.collection_id)
        {
            return invalid;
        }
        previous = item.sequence;
    }
    if page.next_cursor != previous
        || page.last_sequence < page.next_cursor
        || (page.has_more && page.items.is_empty())
    {
        return invalid;
    }
    Ok(())
}
