//! Wire shapes of the mobile similarity review channel (`/v1/library/similarity/review`).
//!
//! The pair feed carries each image's sha256 so the server can drop pairs whose bytes changed.
//! It is a separate export type on purpose: the desktop review DTO
//! (`SimilarityReviewAsset`) must never serialize hashes or paths.
use serde::{Deserialize, Serialize};

use crate::library::error::LibraryError;

pub(crate) const MAX_ITEMS: usize = 5_000;
pub(crate) const MAX_SKIPPED: usize = 1_000;
pub(crate) const MAX_CLASSIFICATIONS: usize = 64;
pub(crate) const MAX_LABEL_CHARS: usize = 300;
/// The server bounds the log page to 1..=100.
pub(crate) const PAGE_LIMIT: i64 = 100;
/// The server's cursor bound (JavaScript's exact-integer maximum).
pub(crate) const MAX_CURSOR: i64 = 9_007_199_254_740_991;

/// One image of a published pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedSide {
    pub asset_id: String,
    pub sha256: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub byte_size: Option<u64>,
    pub format: String,
    pub source_label: Option<String>,
    pub collected_at: Option<String>,
    pub classifications: Vec<String>,
}

/// One open historical pair. `a` is the existing image, `b` the candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedItem {
    pub review_id: String,
    pub kind: String,
    pub distance: u32,
    pub recommended_asset_id: Option<String>,
    pub recommendation: Option<String>,
    pub a: FeedSide,
    pub b: FeedSide,
}

impl FeedItem {
    /// `a` → `keep_existing`, `b` → `replace_existing`, anything else → no recommendation.
    pub(crate) fn recommend(&mut self, asset_id: Option<&str>) {
        let recommendation = match asset_id {
            Some(id) if id == self.a.asset_id => Some("keep_existing"),
            Some(id) if id == self.b.asset_id => Some("replace_existing"),
            _ => None,
        };
        self.recommendation = recommendation.map(str::to_owned);
        self.recommended_asset_id = recommendation.and(asset_id.map(str::to_owned));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FeedSkipped {
    pub sequence: i64,
    pub reason: String,
}

/// `PUT /v1/library/similarity/review/feed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedBody {
    pub version: u8,
    pub library_id: String,
    pub base_revision: Option<String>,
    pub decision_cursor: i64,
    pub generated_at: String,
    pub skipped: Vec<FeedSkipped>,
    pub items: Vec<FeedItem>,
}

/// `PUT …/feed` receipt.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FeedResult {
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionBasis {
    pub feed_revision: String,
    pub a_sha256: String,
    pub b_sha256: String,
}

/// One accepted mobile decision from the server's ordered log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionEntry {
    pub sequence: i64,
    pub operation_id: String,
    pub review_id: String,
    pub decision: String,
    pub a_asset_id: String,
    pub b_asset_id: String,
    pub trash_asset_id: Option<String>,
    /// For `withdrawn`: the sequence of the decision it takes back.
    pub withdraws: Option<i64>,
    pub basis: DecisionBasis,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionPage {
    pub version: u8,
    pub library_id: String,
    pub after: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<DecisionEntry>,
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reject a page the caller must not apply: it must be for this library and position,
/// contiguous from `after + 1`, end at `next_cursor`, and each entry must be well formed.
pub(crate) fn validate_page(
    page: &DecisionPage,
    library_id: &str,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    let invalid = || Err(LibraryError::SimilarityReviewInvalid);
    if !(0..MAX_CURSOR).contains(&after) {
        return invalid();
    }
    if page.version != 1 || page.library_id != library_id || page.after != after {
        return invalid();
    }
    if page.items.len() as i64 > limit.min(PAGE_LIMIT) {
        return invalid();
    }
    let mut expected = after + 1;
    for item in &page.items {
        let trash = match item.decision.as_str() {
            "keep_existing" => Some(&item.b_asset_id),
            "replace_existing" => Some(&item.a_asset_id),
            "keep_both" | "withdrawn" => None,
            _ => return invalid(),
        };
        let withdraws_ok = match (item.decision.as_str(), item.withdraws) {
            ("withdrawn", Some(target)) => target > 0 && target < item.sequence,
            ("withdrawn", None) => false,
            (_, withdraws) => withdraws.is_none(),
        };
        if item.sequence != expected
            || item.operation_id.is_empty()
            || item.operation_id.len() > 64
            || !valid_id(&item.review_id)
            || !valid_id(&item.a_asset_id)
            || !valid_id(&item.b_asset_id)
            || item.a_asset_id == item.b_asset_id
            || item.trash_asset_id.as_ref() != trash
            || !withdraws_ok
            || !valid_sha256(&item.basis.a_sha256)
            || !valid_sha256(&item.basis.b_sha256)
            || !valid_sha256(&item.basis.feed_revision)
        {
            return invalid();
        }
        expected += 1;
    }
    if page.next_cursor != expected - 1 || (page.has_more && page.items.is_empty()) {
        return invalid();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../tests/fixtures/mobile-similarity-review-feed.json"),
        )
        .unwrap()
    }

    #[test]
    fn the_shared_feed_fixture_round_trips_through_the_export_type() {
        let raw: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
        // `deny_unknown_fields` makes this fail on any field the PC does not produce.
        let body: FeedBody = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(&body).unwrap(), raw);
        assert_eq!(body.items.len(), 5);
        for item in &body.items {
            let mut again = item.clone();
            again.recommend(item.recommended_asset_id.as_deref());
            assert_eq!(&again, item, "recommendation mapping of {}", item.review_id);
        }
    }

    #[test]
    fn recommendation_maps_a_to_keep_existing_and_b_to_replace_existing() {
        let raw: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
        let mut item: FeedItem = serde_json::from_value(raw["items"][0].clone()).unwrap();
        item.recommend(Some("a"));
        assert_eq!(
            (
                item.recommended_asset_id.as_deref(),
                item.recommendation.as_deref()
            ),
            (Some("a"), Some("keep_existing"))
        );
        item.recommend(Some("s1"));
        assert_eq!(
            (
                item.recommended_asset_id.as_deref(),
                item.recommendation.as_deref()
            ),
            (Some("s1"), Some("replace_existing"))
        );
        for other in [None, Some("elsewhere")] {
            item.recommend(other);
            assert_eq!(
                (
                    item.recommended_asset_id.clone(),
                    item.recommendation.clone()
                ),
                (None, None)
            );
        }
    }

    fn entry(sequence: i64, decision: &str, withdraws: Option<i64>) -> DecisionEntry {
        DecisionEntry {
            sequence,
            operation_id: format!("op-{sequence}"),
            review_id: "r1".into(),
            decision: decision.into(),
            a_asset_id: "a".into(),
            b_asset_id: "b".into(),
            trash_asset_id: match decision {
                "keep_existing" => Some("b".into()),
                "replace_existing" => Some("a".into()),
                _ => None,
            },
            withdraws,
            basis: DecisionBasis {
                feed_revision: "f".repeat(64),
                a_sha256: "a".repeat(64),
                b_sha256: "b".repeat(64),
            },
            created_at: "2026-09-24T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_page_must_be_contiguous_and_well_formed() {
        let library = "e".repeat(32);
        let page = |items: Vec<DecisionEntry>| DecisionPage {
            version: 1,
            library_id: library.clone(),
            after: 0,
            next_cursor: items.last().map_or(0, |i| i.sequence),
            has_more: false,
            items,
        };
        let good = page(vec![
            entry(1, "keep_existing", None),
            entry(2, "withdrawn", Some(1)),
        ]);
        assert!(validate_page(&good, &library, 0, 100).is_ok());
        let gap = page(vec![entry(2, "keep_both", None)]);
        assert!(validate_page(&gap, &library, 0, 100).is_err());
        let mut wrong_trash = entry(1, "keep_existing", None);
        wrong_trash.trash_asset_id = Some("a".into());
        assert!(validate_page(&page(vec![wrong_trash]), &library, 0, 100).is_err());
        let forward = page(vec![entry(1, "withdrawn", Some(1))]);
        assert!(validate_page(&forward, &library, 0, 100).is_err());
        assert!(validate_page(&good, &"f".repeat(32), 0, 100).is_err());
    }
}
