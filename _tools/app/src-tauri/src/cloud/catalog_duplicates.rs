//! Wire shapes of the Manga Catalog duplicate-edition channel
//! (`/v1/mobile-catalog/duplicates`, server `catalog_duplicates.py`).
//!
//! The server models are strict (`extra="forbid"`, strict types), so these structs carry
//! exactly the server's fields, and every value is checked against the server's bounds
//! before it is sent: one invalid item would reject the whole chunk.
use serde::{Deserialize, Serialize};

use crate::library::error::LibraryError;

pub(crate) const PROVIDER: &str = "kHentai";
/// Items per chunk this PC sends; well under the server's bound (`MAX_ITEMS` = 5000).
pub(crate) const CHUNK_ITEMS: usize = 1_000;
/// Item bytes per chunk, under the server's 8 MiB body limit with room for the envelope.
pub(crate) const MAX_CHUNK_BYTES: usize = 7 * 1024 * 1024;
/// The server's evidence bounds (`EvidenceWork`).
pub(crate) const MAX_TAGS: usize = 64;
pub(crate) const MAX_TAG_CHARS: usize = 520;
pub(crate) const MAX_TEXT_CHARS: usize = 8192;
pub(crate) const MAX_COUNT: i64 = 1_000_000;
/// Decision log page size (the server allows 1..=200).
pub(crate) const PAGE_LIMIT: i64 = 100;
pub(crate) const MAX_CURSOR: i64 = 9_007_199_254_740_991;

/// `^[A-Za-z0-9_-]{1,64}$`
pub(crate) fn valid_work_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `^[A-Za-z0-9._:+-]{1,128}$`
pub(crate) fn valid_token(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".:_+-".contains(&b))
}

/// A canonical lowercase hyphenated UUID (the server compares `str(UUID(value)) == value`).
pub(crate) fn valid_operation_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.hyphenated().to_string() == value)
}

/// `sha256("provider\nleft\nright")[:32]`, the server's `candidate_id`.
pub(crate) fn candidate_id(left: &str, right: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!("{PROVIDER}\n{left}\n{right}"))
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvidenceWork {
    pub work_id: String,
    pub group_id: Option<String>,
    pub title: String,
    pub title_jpn: Option<String>,
    pub pages: i64,
    pub category: i64,
    pub creators: Vec<String>,
    pub languages: Vec<String>,
}

impl EvidenceWork {
    pub(crate) fn valid(&self) -> bool {
        let tags = |values: &[String]| {
            values.len() <= MAX_TAGS
                && values
                    .iter()
                    .all(|v| !v.is_empty() && v.chars().count() <= MAX_TAG_CHARS)
        };
        valid_work_id(&self.work_id)
            && self.group_id.as_deref().is_none_or(valid_token)
            && self.title.chars().count() <= MAX_TEXT_CHARS
            && self
                .title_jpn
                .as_deref()
                .is_none_or(|t| t.chars().count() <= MAX_TEXT_CHARS)
            && (0..=MAX_COUNT).contains(&self.pages)
            && (0..=MAX_COUNT).contains(&self.category)
            && tags(&self.creators)
            && tags(&self.languages)
    }
}

/// One candidate. `left.work_id < right.work_id` (the server orders pairs the same way).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateItem {
    pub provider: String,
    pub reason: String,
    pub page_gap: i64,
    pub algorithm: String,
    pub left: EvidenceWork,
    pub right: EvidenceWork,
}

impl CandidateItem {
    pub(crate) fn valid(&self) -> bool {
        self.provider == PROVIDER
            && ["exactTitle", "koreanAlternateTitle"].contains(&self.reason.as_str())
            && (0..=2).contains(&self.page_gap)
            && valid_token(&self.algorithm)
            && self.left.work_id < self.right.work_id
            && self.left.valid()
            && self.right.valid()
    }
}

/// `PUT /v1/mobile-catalog/duplicates/candidates`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Publication {
    pub version: u8,
    pub operation_id: String,
    pub generation: String,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub includes_server_works: bool,
    pub items: Vec<CandidateItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicationResult {
    pub operation_id: String,
    pub generation: String,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub items: u64,
    pub retired: u64,
}

/// One entry of the decision log (`GET …/decisions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionEntry {
    pub sequence: i64,
    pub operation_id: String,
    pub candidate_id: String,
    pub provider: String,
    pub left_work_id: String,
    pub right_work_id: String,
    pub decision: String,
    pub hidden_work_id: Option<String>,
    pub revision: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionPage {
    pub version: u8,
    pub after: i64,
    pub last_sequence: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<DecisionEntry>,
}

/// Reject a page this PC must not apply: another position, unordered or malformed entries.
pub(crate) fn validate_page(
    page: &DecisionPage,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    let mut previous = after;
    let ordered = page.items.iter().all(|item| {
        let ok = item.sequence > previous && item.sequence <= MAX_CURSOR;
        previous = item.sequence;
        ok
    });
    let expected_next = page.items.last().map_or(after, |item| item.sequence);
    if page.version != 1
        || page.after != after
        || page.items.len() as i64 > limit
        || !ordered
        || page.next_cursor != expected_next
        || page.last_sequence < page.next_cursor
        || page.items.iter().any(|item| {
            item.provider != PROVIDER
                || !valid_work_id(&item.left_work_id)
                || !valid_work_id(&item.right_work_id)
                || item.left_work_id >= item.right_work_id
                || !["keepBoth", "hideEdition", "notDuplicate", "cleared"]
                    .contains(&item.decision.as_str())
                || !valid_operation_id(&item.operation_id)
        })
    {
        return Err(LibraryError::CatalogDuplicateInvalid);
    }
    Ok(())
}

/// `POST /v1/mobile-catalog/duplicates/decisions` (client token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionCommand {
    pub version: u8,
    pub operation_id: String,
    pub candidate_id: String,
    pub decision: String,
    pub hidden_work_id: Option<String>,
    pub expected_revision: i64,
}

/// How the server answered a decision command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommandOutcome {
    Recorded,
    /// Someone decided the pair first (`duplicateDecisionConflict`), or the command can never
    /// be accepted (`operationConflict`, `422`).
    Refused,
    /// The candidate is not on the server (yet): retry after the next upload.
    CandidateMissing,
    /// The server has no such route.
    Unsupported,
}
