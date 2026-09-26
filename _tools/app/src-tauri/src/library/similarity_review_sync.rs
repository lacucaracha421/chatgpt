//! Mobile similarity review on the PC: publish open historical pairs and apply mobile
//! decisions (design: `docs/research/mobile-similarity-review-design-20260924.md`).
//!
//! Perceptual similarity stays PC analysis (ADR-0007). The PC publishes its open historical
//! pairs, mobile devices record one decision per pair on the server while the PC may be off,
//! and the PC applies each decision through the ordinary `decide_similarity_review`. The image
//! that is not kept goes to Library Trash (never a hard delete) and its lifecycle command is
//! queued in the same transaction (ADR-0038). Incoming pairs stay PC-only (user decision 1):
//! the phone can never trigger the incoming path's permanent delete.
//!
//! * **Feed** (`PUT …/similarity/review/feed`): open historical pairs whose two Assets are
//!   `normal` here and in the canonical authority state with a known sha256. The first PUT
//!   (`baseRevision: null`) adopts the feature on the server. Durable, debounced and throttled
//!   like the character candidate feed (migration 0094). A missing route (`404`) or an
//!   unlinked server library is retried after five minutes and never fails another lane.
//! * **Apply** (`GET …/decisions`): the log is read to its confirmed end (bounded by
//!   [`LOOKAHEAD_PAGES`] past the applied window) before anything is applied, and entries taken
//!   back by any later `withdrawn` read so far are skipped, so a decision and its withdrawal on
//!   different pages never trash an image; the local sha256 of both Assets must match the
//!   entry's `basis`.
//!   `decide_similarity_review` runs its own transactions, so each entry's receipt and cursor
//!   step are written afterwards; a crash in between re-delivers the entry, and the same
//!   decision on an already resolved review is `Ok`, which records `applied`.
//! * Deterministic outcomes (`skipped:resolvedOnPc|stale|changed|assetGone|withdrawn`)
//!   advance the cursor and are reported in the next feed PUT; only transport/DB errors,
//!   malformed pages and receipt divergences hold it.
use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    error::LibraryError,
    models::{SimilarityDecision, SimilarityDecisionRequest},
    similarity::{
        classifications_for_assets, load_asset_summaries, provenance_rank, review_format,
    },
    Library,
};
use crate::cloud::client::CloudClient;
use crate::cloud::similarity_review::{
    valid_id, valid_sha256, DecisionEntry, FeedBody, FeedItem, FeedSide, FeedSkipped,
    MAX_CLASSIFICATIONS, MAX_ITEMS, MAX_LABEL_CHARS, MAX_SKIPPED, PAGE_LIMIT,
};
use crate::library::credential;

/// Pages one pass may apply; the durable cursor lets a backlog drain across passes.
const MAX_PAGES: usize = 10;
/// Pages the withdrawal look-ahead may read past the applied window. A decision stays
/// withdrawable on the server until the PC reports it applied, so its `withdrawn` can be on any
/// later page; only a backlog longer than this window plus the look-ahead is read partially.
const LOOKAHEAD_PAGES: usize = 50;
/// Item bytes kept under the server's 8 MiB body limit, leaving room for the envelope.
const MAX_ITEM_BYTES: usize = 7 * 1024 * 1024 + 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FeedOutcome {
    /// Not configured, no publisher credential, or the endpoint is not bound yet.
    NotReady,
    NotDue,
    /// Rebuilt, but identical to what the server already has: nothing was sent.
    Unchanged,
    Published {
        revision: String,
    },
    /// The server has no feed route, or refused adoption for now.
    Unsupported,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PageOutcome {
    pub applied: u64,
    pub skipped: u64,
    pub already_consumed: u64,
}

/// A cheap counter the desktop polls to reload the review screen and the trash count after
/// mobile decisions were applied.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityInboundStatus {
    pub applied: u64,
}

enum Outcome {
    Applied,
    Skipped(&'static str),
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn decision_kind(decision: &str) -> Option<SimilarityDecision> {
    match decision {
        "keep_existing" => Some(SimilarityDecision::KeepExisting),
        "replace_existing" => Some(SimilarityDecision::ReplaceExisting),
        "keep_both" => Some(SimilarityDecision::KeepBoth),
        _ => None,
    }
}

/// `x.com/artist/status/1` from `https://x.com/artist/status/1?s=20`, like the desktop label.
fn source_label(url: Option<&str>) -> Option<String> {
    let url = url?.trim();
    let label = match url::Url::parse(url) {
        Ok(parsed) if parsed.host_str().is_some() => {
            format!("{}{}", parsed.host_str().unwrap_or_default(), parsed.path())
        }
        _ => url.to_owned(),
    };
    let label: String = label.chars().take(MAX_LABEL_CHARS).collect();
    (!label.trim().is_empty()).then_some(label)
}

/// The server's opaque token shape (`[A-Za-z0-9._:+-]{1,128}`); anything else is omitted.
fn token(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".:_+-".contains(&b)))
    .then(|| value.to_owned())
}

fn format_label(relative_path: &str) -> String {
    let format = review_format(relative_path);
    if !format.is_empty()
        && format.len() <= 32
        && format
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
    {
        format
    } else {
        "IMAGE".into()
    }
}

struct PairRow {
    review_id: String,
    distance: u32,
    a: (String, String),
    b: (String, String),
}

impl Library {
    /// The export: open historical pairs whose two Assets are `normal` locally and in the
    /// canonical authority state, with the authority sha256 equal to the local bytes. At most
    /// [`MAX_ITEMS`] pairs (oldest first) and ~7.5 MiB of items.
    pub(crate) fn similarity_review_feed_items(&self) -> Result<Vec<FeedItem>, LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let rows = transaction
            .prepare(
                "SELECT r.id, r.distance, a.id, a.content_hash, b.id, b.content_hash
                 FROM similarity_reviews r
                 JOIN assets a ON a.id = r.existing_asset_id AND a.status = 'normal'
                 JOIN assets b ON b.id = r.candidate_asset_id AND b.status = 'normal'
                 JOIN asset_authority_state sa ON sa.asset_id = a.id
                      AND sa.lifecycle = 'normal' AND sa.sha256 = a.content_hash
                 JOIN asset_authority_state sb ON sb.asset_id = b.id
                      AND sb.lifecycle = 'normal' AND sb.sha256 = b.content_hash
                 WHERE r.review_kind = 'historical' AND r.status = 'open'
                 ORDER BY r.created_at, r.id
                 LIMIT ?1",
            )?
            .query_map([MAX_ITEMS as i64], |row| {
                Ok(PairRow {
                    review_id: row.get(0)?,
                    distance: row.get(1)?,
                    a: (row.get(2)?, row.get(3)?),
                    b: (row.get(4)?, row.get(5)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let rows: Vec<PairRow> = rows
            .into_iter()
            .filter(|row| {
                valid_id(&row.review_id)
                    && valid_id(&row.a.0)
                    && valid_id(&row.b.0)
                    && valid_sha256(&row.a.1)
                    && valid_sha256(&row.b.1)
                    && row.distance <= 1024
            })
            .collect();
        let mut summaries = HashMap::new();
        let mut classifications = HashMap::new();
        let ids: Vec<String> = rows
            .iter()
            .flat_map(|row| [row.a.0.clone(), row.b.0.clone()])
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        for chunk in ids.chunks(400) {
            summaries.extend(load_asset_summaries(&transaction, chunk)?);
            classifications.extend(classifications_for_assets(&transaction, chunk)?);
        }
        transaction.commit()?;

        let side = |(id, sha256): &(String, String)| -> Option<FeedSide> {
            let asset = summaries.get(id)?;
            let names = classifications
                .get(id)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| entry.name.chars().take(MAX_LABEL_CHARS).collect::<String>())
                        .filter(|name| !name.trim().is_empty())
                        .take(MAX_CLASSIFICATIONS)
                        .collect()
                })
                .unwrap_or_default();
            Some(FeedSide {
                asset_id: id.clone(),
                sha256: sha256.clone(),
                width: (1..=1_000_000)
                    .contains(&asset.width)
                    .then_some(asset.width),
                height: (1..=1_000_000)
                    .contains(&asset.height)
                    .then_some(asset.height),
                byte_size: Some(asset.byte_size),
                format: format_label(&asset.relative_path),
                source_label: source_label(asset.source_url.as_deref()),
                collected_at: token(&asset.collected_at),
                classifications: names,
            })
        };
        let mut items = Vec::new();
        let mut bytes = 0;
        for row in &rows {
            let (Some(a), Some(b)) = (side(&row.a), side(&row.b)) else {
                continue;
            };
            let recommended = match provenance_rank(&summaries[&row.a.0])
                .cmp(&provenance_rank(&summaries[&row.b.0]))
            {
                std::cmp::Ordering::Greater => Some(row.a.0.as_str()),
                std::cmp::Ordering::Less => Some(row.b.0.as_str()),
                std::cmp::Ordering::Equal => None,
            };
            let mut item = FeedItem {
                review_id: row.review_id.clone(),
                kind: "historical".into(),
                distance: row.distance,
                recommended_asset_id: None,
                recommendation: None,
                a,
                b,
            };
            item.recommend(recommended);
            bytes += serde_json::to_vec(&item)
                .map_err(|_| LibraryError::InvalidCloudResponse)?
                .len()
                + 1;
            if bytes > MAX_ITEM_BYTES {
                break;
            }
            items.push(item);
        }
        Ok(items)
    }

    /// The bound `(library_id, received_cursor)` for one endpoint, if any.
    pub(crate) fn similarity_review_adoption(
        &self,
        endpoint: &str,
    ) -> Result<Option<(String, i64)>, LibraryError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT library_id, received_cursor FROM mobile_similarity_review_sync
                 WHERE endpoint = ?1",
                [endpoint],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Bind this endpoint to the local library at cursor zero; an existing row keeps its cursor.
    pub(crate) fn adopt_similarity_review_library(
        &self,
        endpoint: &str,
        library_id: &str,
    ) -> Result<(), LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::SimilarityReviewCursorRejected);
        }
        self.connection()?.execute(
            "INSERT INTO mobile_similarity_review_sync(endpoint, library_id, received_cursor, updated_at)
             VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(endpoint, library_id) DO NOTHING",
            params![endpoint, library_id, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Claim the receive poll for this endpoint, durably: when the log head in the shared
    /// status moved past the received cursor, every 30 minutes otherwise, and once a minute
    /// without a trusted head (`cloud::status_watch::log_due`).
    pub(crate) fn claim_similarity_review_poll(&self, endpoint: &str) -> Result<bool, LibraryError> {
        use crate::cloud::status_watch::{log_due, unix_now, LogKind, LogPosition};
        let cursor = self.similarity_review_adoption(endpoint)?.map(|(_, cursor)| cursor);
        let db = self.connection()?;
        let now = unix_now();
        let last: Option<i64> = db
            .query_row(
                "SELECT last_checked FROM mobile_similarity_review_poll WHERE endpoint = ?1",
                [endpoint],
                |row| row.get(0),
            )
            .optional()?;
        let position = LogPosition::cursor(cursor);
        let due = log_due(endpoint, LogKind::SimilarityDecisions, position, last, now);
        if due {
            db.execute(
                "INSERT INTO mobile_similarity_review_poll(endpoint, last_checked) VALUES (?1, ?2)
                 ON CONFLICT(endpoint) DO UPDATE SET last_checked = excluded.last_checked",
                rusqlite::params![endpoint, now],
            )?;
        }
        Ok(due)
    }

    /// The `similarity` publication lane: compare newly materialized Assets, receive and apply
    /// mobile decisions (at most once a minute), then publish the pair feed when due. Network
    /// work holds no database lock; a feed failure is logged and never fails the receive.
    pub(crate) fn run_due_similarity_review(&self, endpoint: &str) -> Result<(), LibraryError> {
        if let Err(error) = self.run_similarity_auto_compare_batch() {
            eprintln!("similarity auto compare: {error}");
        }
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        let client = CloudClient::new(endpoint)?;
        let received = if self.claim_similarity_review_poll(endpoint)? {
            match self.receive_similarity_review_with(&client, publisher.expose(), endpoint) {
                Ok(_) | Err(LibraryError::SimilarityReviewUnsupported) => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            Ok(())
        };
        if self.similarity_review_adoption(endpoint)?.is_some() {
            let published = credential::read_cloud_api_token_os().and_then(|token| {
                self.publish_due_similarity_review_feed_with(
                    &client,
                    publisher.expose(),
                    token.expose(),
                    endpoint,
                )
            });
            if let Err(error) = published {
                eprintln!("similarity review feed: {error}");
            }
        }
        received
    }

    /// Pull and apply pending decisions, up to [`MAX_PAGES`] pages. An unbound endpoint is
    /// probed first: `404` (an older server) or `similarityReviewUnsupported` (server library
    /// not linked) leave it unbound (`Ok(None)`); otherwise it is bound at cursor zero and the
    /// next feed PUT adopts the feature. Returns the durable cursor.
    pub(crate) fn receive_similarity_review_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<Option<i64>, LibraryError> {
        let library_id = self.library_id()?;
        let mut cursor = match self.similarity_review_adoption(endpoint)? {
            Some((adopted, _)) if adopted != library_id => {
                return Err(LibraryError::SimilarityReviewCursorRejected)
            }
            Some((_, cursor)) => cursor,
            None => match client.similarity_review_decisions(publisher_token, &library_id, 0, 1) {
                Ok(None) | Err(LibraryError::SimilarityReviewUnsupported) => return Ok(None),
                Ok(Some(_)) => {
                    self.adopt_similarity_review_library(endpoint, &library_id)?;
                    0
                }
                Err(error) => return Err(error),
            },
        };
        // Read before applying: up to MAX_PAGES pages form the applied window, and the log is
        // read on to its end (or LOOKAHEAD_PAGES further) only to collect withdrawals. The
        // durable cursor moves only as window entries are applied, so an entry that is not
        // applied in this pass is read again by the next one.
        let window_limit = MAX_PAGES * PAGE_LIMIT as usize;
        let mut window = Vec::new();
        let mut withdrawn = HashSet::new();
        let mut after = cursor;
        for _ in 0..MAX_PAGES + LOOKAHEAD_PAGES {
            let page = client
                .similarity_review_decisions(publisher_token, &library_id, after, PAGE_LIMIT)?
                .ok_or(LibraryError::SimilarityReviewUnsupported)?;
            withdrawn.extend(page.items.iter().filter_map(|item| item.withdraws));
            let room = window_limit.saturating_sub(window.len());
            window.extend(page.items.into_iter().take(room));
            if !page.has_more {
                break;
            }
            after = page.next_cursor;
        }
        if !window.is_empty() {
            self.apply_similarity_review_page(endpoint, &library_id, &window, &withdrawn)?;
            cursor = self
                .similarity_review_adoption(endpoint)?
                .map(|(_, cursor)| cursor)
                .ok_or(LibraryError::SimilarityReviewCursorRejected)?;
        }
        Ok(Some(cursor))
    }

    /// Apply validated, contiguous entries in order. Each entry is decided first (its own
    /// transactions) and then its receipt and the cursor step are written together,
    /// compare-and-set on the cursor, so a replay is harmless and a stale page can never
    /// rewind it. `read_ahead` holds the targets of the withdrawals read so far, including
    /// those after `items` (the look-ahead); withdrawals inside `items` are added here.
    pub(crate) fn apply_similarity_review_page(
        &self,
        endpoint: &str,
        library_id: &str,
        items: &[DecisionEntry],
        read_ahead: &HashSet<i64>,
    ) -> Result<PageOutcome, LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::SimilarityReviewCursorRejected);
        }
        // Look-ahead: a decision taken back by a later entry that was read is never applied.
        let mut withdrawn = read_ahead.clone();
        withdrawn.extend(
            items
                .iter()
                .filter(|item| item.decision == "withdrawn")
                .filter_map(|item| item.withdraws),
        );
        let mut outcome = PageOutcome::default();
        for item in items {
            let durable = self.similarity_received_cursor(endpoint, library_id)?;
            let consumed = {
                let connection = self.connection()?;
                receipt_matches(&connection, item, endpoint, library_id)?
            };
            if item.sequence <= durable {
                if !consumed {
                    return Err(LibraryError::SimilarityReviewInvalid);
                }
                outcome.already_consumed += 1;
                continue;
            }
            if item.sequence != durable + 1 || consumed {
                return Err(LibraryError::SimilarityReviewInvalid);
            }
            let result = if withdrawn.contains(&item.sequence) {
                Outcome::Skipped("withdrawn")
            } else if item.decision == "withdrawn" {
                // Nothing left to take back here: its target was skipped above, or was
                // already applied (the image is in Library Trash and restorable there).
                Outcome::Applied
            } else {
                self.apply_similarity_entry(item)?
            };
            let recorded = match result {
                Outcome::Applied => {
                    outcome.applied += 1;
                    "applied".to_string()
                }
                Outcome::Skipped(reason) => {
                    outcome.skipped += 1;
                    format!("skipped:{reason}")
                }
            };
            let now = chrono::Utc::now().to_rfc3339();
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO mobile_similarity_review_receipts
                    (endpoint, library_id, operation_id, sequence, review_id, decision, outcome, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    endpoint,
                    library_id,
                    item.operation_id,
                    item.sequence,
                    item.review_id,
                    item.decision,
                    recorded,
                    now
                ],
            )?;
            let advanced = transaction.execute(
                "UPDATE mobile_similarity_review_sync SET received_cursor = ?3, updated_at = ?4
                 WHERE endpoint = ?1 AND library_id = ?2 AND received_cursor = ?5",
                params![endpoint, library_id, item.sequence, now, durable],
            )?;
            if advanced != 1 {
                return Err(LibraryError::SimilarityReviewCursorRejected);
            }
            transaction.commit()?;
        }
        Ok(outcome)
    }

    fn similarity_received_cursor(
        &self,
        endpoint: &str,
        library_id: &str,
    ) -> Result<i64, LibraryError> {
        self.connection()?
            .query_row(
                "SELECT received_cursor FROM mobile_similarity_review_sync
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::SimilarityReviewCursorRejected)
    }

    /// Decide one mobile entry locally, or say why it cannot apply here.
    fn apply_similarity_entry(&self, item: &DecisionEntry) -> Result<Outcome, LibraryError> {
        let Some(decision) = decision_kind(&item.decision) else {
            return Err(LibraryError::SimilarityReviewInvalid);
        };
        type Review = (bool, String, Option<String>, Option<String>, Option<String>);
        let read = |library: &Library| -> Result<Option<Review>, LibraryError> {
            Ok(library
                .connection()?
                .query_row(
                    "SELECT review_kind = 'historical', status, decision, existing_asset_id, candidate_asset_id
                     FROM similarity_reviews WHERE id = ?1",
                    [&item.review_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?)
        };
        // A deleted Asset first marks its open pairs stale (0090), then clears the pair's id.
        let gone = |library: &Library| -> Result<bool, LibraryError> {
            Ok(library.connection()?.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM assets WHERE id = ?1)
                     OR NOT EXISTS(SELECT 1 FROM assets WHERE id = ?2)",
                params![item.a_asset_id, item.b_asset_id],
                |row| row.get(0),
            )?)
        };
        let unavailable = |library: &Library| -> Result<Outcome, LibraryError> {
            Ok(Outcome::Skipped(if gone(library)? {
                "assetGone"
            } else {
                "stale"
            }))
        };
        let Some((historical, status, decided, existing, candidate)) = read(self)? else {
            return unavailable(self);
        };
        // Incoming pairs are PC-only: their "keep existing" permanently deletes a file.
        if !historical {
            return Ok(Outcome::Skipped("stale"));
        }
        match status.as_str() {
            // A re-delivery after a crash between the decision and its receipt lands here.
            "resolved" if decided.as_deref() == Some(item.decision.as_str()) => {}
            "resolved" => return Ok(Outcome::Skipped("resolvedOnPc")),
            "open" => {
                if existing.as_deref() != Some(item.a_asset_id.as_str())
                    || candidate.as_deref() != Some(item.b_asset_id.as_str())
                {
                    return if gone(self)? {
                        Ok(Outcome::Skipped("assetGone"))
                    } else {
                        Ok(Outcome::Skipped("changed"))
                    };
                }
                let connection = self.connection()?;
                for (asset_id, sha256) in [
                    (&item.a_asset_id, &item.basis.a_sha256),
                    (&item.b_asset_id, &item.basis.b_sha256),
                ] {
                    let local: Option<(String, String)> = connection
                        .query_row(
                            "SELECT content_hash, status FROM assets WHERE id = ?1",
                            [asset_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?;
                    match local {
                        None => return Ok(Outcome::Skipped("assetGone")),
                        Some((_, status)) if status != "normal" => {
                            return Ok(Outcome::Skipped("stale"))
                        }
                        Some((hash, _)) if !hash.eq_ignore_ascii_case(sha256) => {
                            return Ok(Outcome::Skipped("changed"))
                        }
                        Some(_) => {}
                    }
                }
            }
            _ => return unavailable(self),
        }
        match self.decide_similarity_review(SimilarityDecisionRequest {
            review_id: item.review_id.clone(),
            decision,
        }) {
            Ok(()) => Ok(Outcome::Applied),
            Err(LibraryError::SimilarityReviewNotFound | LibraryError::AssetNotFound) => {
                unavailable(self)
            }
            // Something changed between the checks above and the decision (a desktop decision,
            // a trash elsewhere): classify by the review's state now.
            Err(LibraryError::SimilarityReviewConflict) => Ok(match read(self)? {
                Some((_, status, decided, _, _)) if status == "resolved" => {
                    if decided.as_deref() == Some(item.decision.as_str()) {
                        Outcome::Applied
                    } else {
                        Outcome::Skipped("resolvedOnPc")
                    }
                }
                _ => unavailable(self)?,
            }),
            Err(error) => Err(error),
        }
    }

    /// Cheap fingerprint of what the feed depends on (see the migration 0094 notes).
    fn similarity_review_feed_input(&self, cursor: i64) -> Result<String, LibraryError> {
        let (reviews, authority): (Option<String>, Option<String>) = self.connection()?.query_row(
            "SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), '') || ':'
                            || COALESCE(MAX(resolved_at), '') || ':' || COALESCE(SUM(status = 'open'), 0)
                     FROM similarity_reviews WHERE review_kind = 'historical'),
                    (SELECT COUNT(*) || ':' || COALESCE(SUM(entity_revision), 0)
                     FROM asset_authority_state)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(hex(
            serde_json::json!([reviews, authority, cursor]).to_string()
        ))
    }

    /// The feed publication with an injected transport and credentials.
    ///
    /// Adoption: the first accepted PUT (`baseRevision: null`) enables the feature on the
    /// server. A server without the route (`404`) or not ready to adopt
    /// (`similarityReviewUnsupported`) is retried after five minutes. A stale base re-reads
    /// the server revision through the mobile route and retries once.
    pub(crate) fn publish_due_similarity_review_feed_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        api_token: &str,
        endpoint: &str,
    ) -> Result<FeedOutcome, LibraryError> {
        let library_id = self.library_id()?;
        let cursor: Option<i64> = self
            .connection()?
            .query_row(
                "SELECT received_cursor FROM mobile_similarity_review_sync
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(received) = cursor else {
            return Ok(FeedOutcome::NotReady);
        };
        let input = self.similarity_review_feed_input(received)?;
        let due = {
            let db = self.connection()?;
            db.execute(
                "INSERT OR IGNORE INTO mobile_similarity_review_feed_state(endpoint,library_id,input_digest,first_dirty,last_dirty)
                 VALUES(?1,?2,?3,unixepoch(),unixepoch())",
                params![endpoint, library_id, input],
            )?;
            db.execute(
                "UPDATE mobile_similarity_review_feed_state SET input_digest=?3,
                 first_dirty=CASE WHEN input_digest IS published_input_digest THEN unixepoch() ELSE first_dirty END,
                 last_dirty=unixepoch()
                 WHERE endpoint=?1 AND library_id=?2 AND input_digest IS NOT ?3",
                params![endpoint, library_id, input],
            )?;
            let due: bool = db.query_row(
                "SELECT retry_after<=unixepoch() AND (
                    published_input_digest IS NULL
                    OR (input_digest IS NOT published_input_digest
                        AND (last_dirty<=unixepoch()-30 OR first_dirty<=unixepoch()-300))
                    OR built_at<=unixepoch()-300)
                 FROM mobile_similarity_review_feed_state WHERE endpoint=?1 AND library_id=?2",
                params![endpoint, library_id],
                |row| row.get(0),
            )?;
            if due {
                db.execute(
                    "UPDATE mobile_similarity_review_feed_state SET retry_after=unixepoch()+60
                     WHERE endpoint=?1 AND library_id=?2",
                    params![endpoint, library_id],
                )?;
            }
            due
        };
        if !due {
            return Ok(FeedOutcome::NotDue);
        }
        let (adopted, body_digest, base, published_cursor): (
            bool,
            Option<String>,
            Option<String>,
            i64,
        ) = self.connection()?.query_row(
            "SELECT adopted, body_digest, published_revision, published_cursor
                 FROM mobile_similarity_review_feed_state WHERE endpoint=?1 AND library_id=?2",
            params![endpoint, library_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let items = self.similarity_review_feed_items()?;
        // Skipped decisions consumed since the previous feed, bounded like the server.
        let mut cursor = received.max(published_cursor);
        let mut skipped = self
            .connection()?
            .prepare(
                "SELECT sequence, substr(outcome, 9) FROM mobile_similarity_review_receipts
                 WHERE endpoint=?1 AND library_id=?2 AND outcome LIKE 'skipped:%'
                   AND sequence>?3 AND sequence<=?4 ORDER BY sequence LIMIT ?5",
            )?
            .query_map(
                params![
                    endpoint,
                    library_id,
                    published_cursor,
                    cursor,
                    (MAX_SKIPPED + 1) as i64
                ],
                |row| {
                    Ok(FeedSkipped {
                        sequence: row.get(0)?,
                        reason: row.get(1)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        if skipped.len() > MAX_SKIPPED {
            skipped.truncate(MAX_SKIPPED);
            cursor = skipped[MAX_SKIPPED - 1].sequence;
        }
        let mut body = FeedBody {
            version: 1,
            library_id: library_id.clone(),
            base_revision: None,
            decision_cursor: cursor,
            generated_at: String::new(),
            skipped,
            items,
        };
        let digest =
            hex(serde_json::to_vec(&body).map_err(|_| LibraryError::InvalidCloudResponse)?);
        if adopted && body_digest.as_deref() == Some(digest.as_str()) {
            self.connection()?.execute(
                "UPDATE mobile_similarity_review_feed_state SET published_input_digest=?3,
                 built_at=unixepoch(), retry_after=0, first_dirty=0
                 WHERE endpoint=?1 AND library_id=?2",
                params![endpoint, library_id, input],
            )?;
            return Ok(FeedOutcome::Unchanged);
        }
        body.generated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let encode = |body: &FeedBody| {
            serde_json::to_vec(body).map_err(|_| LibraryError::InvalidCloudResponse)
        };
        body.base_revision = base;
        let result = match client.publish_similarity_review_feed(publisher_token, &encode(&body)?) {
            Err(LibraryError::SimilarityReviewFeedConflict) => {
                // Another publisher (or a lost response) moved the feed: retry once on the
                // server's current revision.
                body.base_revision = client.similarity_review_feed_revision(api_token)?;
                client.publish_similarity_review_feed(publisher_token, &encode(&body)?)
            }
            result => result,
        };
        let published = match result {
            Ok(Some(published)) => published,
            Ok(None) | Err(LibraryError::SimilarityReviewUnsupported) => {
                self.connection()?.execute(
                    "UPDATE mobile_similarity_review_feed_state SET retry_after=unixepoch()+300
                     WHERE endpoint=?1 AND library_id=?2",
                    params![endpoint, library_id],
                )?;
                return Ok(FeedOutcome::Unsupported);
            }
            Err(error) => return Err(error),
        };
        self.connection()?.execute(
            "UPDATE mobile_similarity_review_feed_state SET adopted=1, published_revision=?3,
             published_cursor=MAX(published_cursor, ?4), body_digest=?5, published_input_digest=?6,
             built_at=unixepoch(), retry_after=0, first_dirty=0
             WHERE endpoint=?1 AND library_id=?2",
            params![
                endpoint,
                library_id,
                published.revision,
                cursor,
                digest,
                input
            ],
        )?;
        Ok(FeedOutcome::Published {
            revision: published.revision,
        })
    }

    /// Mobile decisions this PC applied; a change tells the desktop to reload the review
    /// screen and the trash count.
    pub fn similarity_review_inbound_status(
        &self,
    ) -> Result<SimilarityInboundStatus, LibraryError> {
        let applied: i64 = self.connection()?.query_row(
            "SELECT COUNT(*) FROM mobile_similarity_review_receipts
             WHERE outcome = 'applied' AND decision != 'withdrawn'",
            [],
            |row| row.get(0),
        )?;
        Ok(SimilarityInboundStatus {
            applied: applied.max(0) as u64,
        })
    }
}

/// Whether this origin already consumed this exact entry; a receipt with other content under
/// the same operation id, or another operation at the same position, is a divergence.
fn receipt_matches(
    connection: &Connection,
    item: &DecisionEntry,
    endpoint: &str,
    library_id: &str,
) -> Result<bool, LibraryError> {
    let recorded: Option<(i64, String, String)> = connection
        .query_row(
            "SELECT sequence, review_id, decision FROM mobile_similarity_review_receipts
             WHERE endpoint = ?1 AND library_id = ?2 AND operation_id = ?3",
            params![endpoint, library_id, &item.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match recorded {
        Some((sequence, review, decision))
            if sequence == item.sequence
                && review == item.review_id
                && decision == item.decision =>
        {
            Ok(true)
        }
        Some(_) => Err(LibraryError::SimilarityReviewInvalid),
        None => {
            let taken: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM mobile_similarity_review_receipts
                 WHERE endpoint = ?1 AND library_id = ?2 AND sequence = ?3)",
                params![endpoint, library_id, item.sequence],
                |row| row.get(0),
            )?;
            if taken {
                return Err(LibraryError::SimilarityReviewInvalid);
            }
            Ok(false)
        }
    }
}

#[cfg(test)]
#[path = "similarity_review_sync_tests.rs"]
mod tests;
