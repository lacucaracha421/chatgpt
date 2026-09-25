//! Wire shapes of the tablet-requested MangaDex / Kakao connections
//! (`/v1/collections/bindings`, server `collection_bindings.py`). The PC reads the request
//! log and reports each outcome; applying happens in `library/collection_binding_sync.rs`.
use serde::{Deserialize, Serialize};

use crate::library::error::LibraryError;

/// Log page size (the server allows 1..=200). Small: each pending item may be applied.
pub(crate) const PAGE_LIMIT: i64 = 50;
pub(crate) const MAX_CURSOR: i64 = 9_007_199_254_740_991;

/// One bind request (`Request`). `choice` / `expected` stay raw: the PC reads only the
/// fields it applies, and a malformed one is reported as a failed request, not a bad page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindRequest {
    pub request_id: i64,
    pub collection_id: String,
    pub provider: String,
    #[serde(default)]
    pub choice: serde_json::Value,
    #[serde(default)]
    pub expected: Option<serde_json::Value>,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindLogPage {
    pub version: u8,
    pub after: i64,
    pub last_sequence: i64,
    #[serde(default)]
    pub oldest_pending_sequence: Option<i64>,
    /// Random identity of the server's log; a new value means the log was replaced.
    #[serde(default)]
    pub log_epoch: Option<serde_json::Value>,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<BindRequest>,
}

/// `GET …/bindings/log` outcome.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LogRead {
    Page {
        page: BindLogPage,
        etag: Option<String>,
    },
    /// `304`: identical to the page the stored ETag describes.
    NotModified,
    /// `404`: an older server without the channel.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BindReason {
    pub code: String,
    pub message: String,
}

/// `POST …/requests/{requestId}/result` body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BindResult {
    pub version: u8,
    pub state: String,
    pub reason: Option<BindReason>,
}

/// `POST …/result` outcome. `Conflict` / `NotFound` both end the PC's work on the request:
/// another outcome is already recorded, or the resolved row was pruned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResultOutcome {
    Recorded,
    Conflict,
    NotFound,
    Unsupported,
}

/// Reject a log page that does not continue from `after`.
pub(crate) fn validate_log_page(
    page: &BindLogPage,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    let invalid = Err(LibraryError::BindingSyncInvalid);
    if page.version != 1 || page.after != after || page.items.len() as i64 > limit {
        return invalid;
    }
    let mut previous = after;
    for item in &page.items {
        if item.request_id <= previous || item.request_id > MAX_CURSOR {
            return invalid;
        }
        previous = item.request_id;
    }
    if page.next_cursor != previous
        || page.last_sequence < page.next_cursor
        || (page.has_more && page.items.is_empty())
        || page
            .oldest_pending_sequence
            .is_some_and(|oldest| !(1..=page.last_sequence).contains(&oldest))
    {
        return invalid;
    }
    Ok(())
}
