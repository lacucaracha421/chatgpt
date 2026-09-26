//! Mobile character-candidate review: receive and apply the server's decision log.
//!
//! Mobile devices judge PC-published candidates ("맞음" / "아님" / "되돌리기") and add assets
//! to characters from the viewer. The server accepts those decisions while the PC may be off
//! and keeps an ordered log; the PC stays the only owner of character membership. This module
//! pulls the log and applies each entry through the ordinary character decision path, then the
//! next navigation snapshot republishes memberships (design:
//! `docs/research/mobile-character-review-design-20260924.md`). Mirrors the Character exclusion
//! channel (`character_exclusions.rs`, 0089) and Collection personal edits (0091).
//!
//! * `accepted` / `cleared` go through `write_character_decisions` with the target's *current*
//!   fingerprint read in the same transaction: a decision still applies after the character's
//!   references changed (user decision 3). `rejected` goes through
//!   `write_inbound_character_rejection`, which also holds for an asset moved out of the series.
//! * `superseded`: a newer local decision for the pair, made outside this channel and newer
//!   than the entry's `basis` (the latest decision sequence the PC published for the pair),
//!   wins. A viewer entry without a basis is an explicit request and is not superseded.
//! * Undo: a `cleared` entry only clears a decision this channel wrote (receipt
//!   `decision_sequence`). If the pair's latest decision is an independent PC decision — older
//!   or newer — the entry is `superseded` and nothing is cleared.
//! * Deterministic failures (missing target/asset, changed bytes, protected reference, failed
//!   eligibility) are `skipped:<reason>` and the cursor still advances; only transport/DB
//!   errors, malformed pages, gaps and receipt conflicts hold it.
//! * Each page is applied in one transaction that re-reads and advances the durable cursor, so a
//!   replay is a no-op and a stale page can never rewind it.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::characters::{DecisionKind, DecisionRequest, Error as CharacterError};
use super::{error::LibraryError, Library};
use crate::cloud::client::CloudClient;
use crate::library::credential;

/// The server bounds this to 1..=100.
const PAGE_LIMIT: i64 = 100;
/// Pages one pass may apply; the durable cursor lets a backlog drain across passes.
const MAX_PAGES: usize = 10;
/// The server's cursor bound (JavaScript's exact-integer maximum).
const MAX_CURSOR: i64 = 9_007_199_254_740_991;

/// One accepted decision from the server's ordered log.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewDecisionEntry {
    pub sequence: i64,
    pub operation_id: String,
    pub target_id: String,
    pub asset_id: String,
    pub decision: String,
    pub origin: String,
    pub basis: Option<String>,
    pub asset_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewDecisionPage {
    pub version: u8,
    pub library_id: String,
    pub after: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub items: Vec<ReviewDecisionEntry>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReviewPageOutcome {
    /// Entries that wrote a character decision.
    pub changed: u64,
    /// Entries whose desired state was already the local state.
    pub unchanged: u64,
    pub superseded: u64,
    pub skipped: u64,
    pub already_consumed: u64,
}

/// A cheap counter the desktop review screen polls to reload after inbound mobile decisions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInboundStatus {
    pub applied: u64,
}

/// What one entry did locally.
enum EntryOutcome {
    Applied(Option<i64>),
    Superseded,
    Skipped(&'static str),
}

/// Reject a page the caller must not apply: it must be for this library and position,
/// contiguous from `after + 1`, and end at `next_cursor`.
pub(crate) fn validate_page(
    page: &ReviewDecisionPage,
    library_id: &str,
    after: i64,
    limit: i64,
) -> Result<(), LibraryError> {
    let invalid = || Err(LibraryError::CharacterReviewInvalid);
    if !(0..MAX_CURSOR).contains(&after) {
        return invalid();
    }
    if page.version != 1 || page.library_id != library_id || page.after != after {
        return invalid();
    }
    if page.items.len() > 100 || page.items.len() as i64 > limit {
        return invalid();
    }
    let id = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    let mut expected = after + 1;
    for item in &page.items {
        if item.sequence != expected
            || item.operation_id.is_empty()
            || item.operation_id.len() > 64
            || !id(&item.target_id)
            || !id(&item.asset_id)
            || !matches!(item.decision.as_str(), "accepted" | "rejected" | "cleared")
            || !matches!(item.origin.as_str(), "feed" | "viewer")
            || item.basis.as_ref().is_some_and(|basis| basis.len() > 128)
            || item.asset_sha256.len() != 64
            || !item
                .asset_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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

fn hold(error: CharacterError) -> LibraryError {
    match error {
        CharacterError::Library(error) => error,
        CharacterError::Db(error) => LibraryError::Database(error),
        _ => LibraryError::CharacterReviewInvalid,
    }
}

fn latest_decision(
    connection: &Connection,
    target_id: &str,
    asset_id: &str,
) -> Result<Option<(i64, String)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT sequence, decision FROM character_decisions
             WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
            params![target_id, asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

impl Library {
    /// The adopted `(library_id, received_cursor)` for one endpoint, if any.
    pub(crate) fn character_review_adoption(
        &self,
        endpoint: &str,
    ) -> Result<Option<(String, i64)>, LibraryError> {
        let connection = self.connection()?;
        Ok(connection
            .query_row(
                "SELECT library_id, received_cursor FROM mobile_character_review_sync
                 WHERE endpoint = ?1",
                [endpoint],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Bind this endpoint to the local library at cursor zero. An existing row keeps its
    /// cursor (`DO NOTHING`).
    pub(crate) fn adopt_character_review_library(
        &self,
        endpoint: &str,
        library_id: &str,
    ) -> Result<(), LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::CharacterReviewCursorRejected);
        }
        self.connection()?.execute(
            "INSERT INTO mobile_character_review_sync(endpoint, library_id, received_cursor, acknowledged_cursor, updated_at)
             VALUES (?1, ?2, 0, 0, ?3)
             ON CONFLICT(endpoint, library_id) DO NOTHING",
            params![endpoint, library_id, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Receive pending review decisions before a navigation snapshot is composed, and say
    /// whether that snapshot carries `reviewDecisionCursor`.
    ///
    /// Only called under the adopted manual-exclusion feature (the server requires
    /// `manualExclusionVersion` with the review cursor). Fallback rules, so character
    /// publication never breaks on an older or unlinked server:
    ///
    /// * the log route answers `404` → an older server: no review cursor (`Ok(false)`); an
    ///   older server would refuse the unknown field;
    /// * a coded `characterReviewUnsupported` (server library not linked) → no review cursor.
    ///   Before adoption no decision can exist, so nothing is lost; after adoption the server
    ///   refuses a snapshot without the cursor, which surfaces as a publication error;
    /// * otherwise the endpoint is bound at cursor zero on first sight, the log is received,
    ///   and the snapshot carries the durable cursor (`0` before adoption, as the server
    ///   requires).
    pub(crate) fn prepare_character_review(
        &self,
        client: &CloudClient,
        endpoint: &str,
        publisher_token: &str,
    ) -> Result<bool, LibraryError> {
        let library_id = self.library_id()?;
        match self.character_review_adoption(endpoint)? {
            Some((adopted, _)) if adopted != library_id => {
                return Err(LibraryError::CharacterReviewCursorRejected)
            }
            Some(_) => {}
            None => match client.character_review_decisions(publisher_token, &library_id, 0, 1) {
                Ok(None) | Err(LibraryError::CharacterReviewUnsupported) => return Ok(false),
                Ok(Some(_)) => self.adopt_character_review_library(endpoint, &library_id)?,
                Err(error) => return Err(error),
            },
        }
        match self.receive_character_review_decisions_with(client, publisher_token, endpoint) {
            Ok(_) => Ok(true),
            Err(LibraryError::CharacterReviewUnsupported) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Claim the receive poll for this endpoint, durably: when the log head in the shared
    /// status moved past the received cursor, every 30 minutes otherwise, and once a minute
    /// without a trusted head (`cloud::status_watch::log_due`).
    pub(crate) fn claim_character_review_poll(&self, endpoint: &str) -> Result<bool, LibraryError> {
        use crate::cloud::status_watch::{log_due, unix_now, LogKind, LogPosition};
        let cursor = self.character_review_adoption(endpoint)?.map(|(_, cursor)| cursor);
        let db = self.connection()?;
        let now = unix_now();
        let last: Option<i64> = db
            .query_row(
                "SELECT last_checked FROM mobile_character_review_poll WHERE endpoint = ?1",
                [endpoint],
                |row| row.get(0),
            )
            .optional()?;
        let position = LogPosition::cursor(cursor);
        let due = log_due(endpoint, LogKind::CharacterReviewDecisions, position, last, now);
        if due {
            db.execute(
                "INSERT INTO mobile_character_review_poll(endpoint, last_checked) VALUES (?1, ?2)
                 ON CONFLICT(endpoint) DO UPDATE SET last_checked = excluded.last_checked",
                rusqlite::params![endpoint, now],
            )?;
        }
        Ok(due)
    }

    /// Idle poll, not gated on a dirty publication: a decision accepted while the PC sat idle
    /// is exactly the case no local change would publish. Runs only once the manual-exclusion
    /// feature is adopted for this endpoint. Network work holds no DB lock.
    pub(crate) fn run_due_character_review(&self, endpoint: &str) -> Result<(), LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        if self.character_exclusion_adoption(endpoint)?.is_none() {
            return Ok(());
        }
        if !self.claim_character_review_poll(endpoint)? {
            return Ok(());
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        let client = CloudClient::new(endpoint)?;
        self.prepare_character_review(&client, endpoint, publisher.expose())?;
        Ok(())
    }

    /// Pull and apply pending decisions for the adopted endpoint, up to [`MAX_PAGES`] pages.
    /// Returns the durable cursor, or `None` when the endpoint is not configured/adopted.
    /// A missing route is `Err(CharacterReviewUnsupported)`.
    pub(crate) fn receive_character_review_decisions_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<Option<i64>, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(None);
        }
        let Some((library_id, mut cursor)) = self.character_review_adoption(endpoint)? else {
            return Ok(None);
        };
        for _ in 0..MAX_PAGES {
            let page = client
                .character_review_decisions(publisher_token, &library_id, cursor, PAGE_LIMIT)?
                .ok_or(LibraryError::CharacterReviewUnsupported)?;
            self.apply_character_review_page(endpoint, &library_id, &page.items)?;
            // Re-read the durable position; another pass may have moved it further.
            let durable = self
                .character_review_adoption(endpoint)?
                .map(|(_, cursor)| cursor)
                .ok_or(LibraryError::CharacterReviewCursorRejected)?;
            cursor = durable;
            if !page.has_more || durable <= page.after {
                break;
            }
        }
        Ok(Some(cursor))
    }

    /// Apply one validated page, advancing the cursor and writing receipts in the same
    /// transaction. The persisted cursor is read inside it, so a stale page is harmless.
    pub(crate) fn apply_character_review_page(
        &self,
        endpoint: &str,
        library_id: &str,
        items: &[ReviewDecisionEntry],
    ) -> Result<ReviewPageOutcome, LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::CharacterReviewCursorRejected);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let durable: i64 = transaction
            .query_row(
                "SELECT received_cursor FROM mobile_character_review_sync
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CharacterReviewCursorRejected)?;
        let mut expected = durable + 1;
        let mut highest = durable;
        let mut outcome = ReviewPageOutcome::default();
        let now = chrono::Utc::now().to_rfc3339();
        for item in items {
            let consumed = receipt_matches(&transaction, item, endpoint, library_id)?;
            if item.sequence <= durable {
                // Below the cursor only a receipt explains the entry; anything else is a
                // divergence this PC cannot reconcile.
                if !consumed {
                    return Err(LibraryError::CharacterReviewInvalid);
                }
                outcome.already_consumed += 1;
                continue;
            }
            if item.sequence != expected {
                return Err(LibraryError::CharacterReviewInvalid);
            }
            if consumed {
                outcome.already_consumed += 1;
            } else {
                let (result, decision_sequence) =
                    match self.apply_review_entry(&transaction, item)? {
                        EntryOutcome::Applied(Some(sequence)) => {
                            outcome.changed += 1;
                            ("applied".to_string(), Some(sequence))
                        }
                        EntryOutcome::Applied(None) => {
                            outcome.unchanged += 1;
                            ("applied".to_string(), None)
                        }
                        EntryOutcome::Superseded => {
                            outcome.superseded += 1;
                            ("superseded".to_string(), None)
                        }
                        EntryOutcome::Skipped(reason) => {
                            outcome.skipped += 1;
                            (format!("skipped:{reason}"), None)
                        }
                    };
                transaction.execute(
                    "INSERT INTO mobile_character_review_receipts
                        (endpoint, library_id, operation_id, sequence, target_id, asset_id, asset_sha256,
                         decision, origin, basis, outcome, decision_sequence, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    params![
                        endpoint,
                        library_id,
                        item.operation_id,
                        item.sequence,
                        item.target_id,
                        item.asset_id,
                        item.asset_sha256,
                        item.decision,
                        item.origin,
                        item.basis,
                        result,
                        decision_sequence,
                        now
                    ],
                )?;
            }
            expected += 1;
            highest = item.sequence;
        }
        if highest > durable {
            transaction.execute(
                "UPDATE mobile_character_review_sync
                 SET received_cursor = ?3, updated_at = ?4
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id, highest, now],
            )?;
            // Even a skipped/superseded entry needs a publication so the server can
            // acknowledge the new cursor; a written decision is also dirtied by 0074.
            transaction.execute(
                "UPDATE mobile_publication_state SET generation=generation+1,
                 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
                 last_dirty=unixepoch() WHERE kind='characters'",
                [],
            )?;
        }
        transaction.commit()?;
        Ok(outcome)
    }

    /// Apply one entry inside a savepoint, so a deterministic failure part-way through a
    /// write leaves nothing behind while the page transaction continues.
    fn apply_review_entry(
        &self,
        transaction: &Connection,
        item: &ReviewDecisionEntry,
    ) -> Result<EntryOutcome, LibraryError> {
        transaction.execute_batch("SAVEPOINT character_review_entry")?;
        let result = self.review_entry(transaction, item);
        match &result {
            Ok(EntryOutcome::Applied(_) | EntryOutcome::Superseded) => {}
            Ok(EntryOutcome::Skipped(_)) | Err(_) => {
                transaction.execute_batch("ROLLBACK TO character_review_entry")?;
            }
        }
        transaction.execute_batch("RELEASE character_review_entry")?;
        result
    }

    fn review_entry(
        &self,
        transaction: &Connection,
        item: &ReviewDecisionEntry,
    ) -> Result<EntryOutcome, LibraryError> {
        let target = match self.read_character_target(transaction, &item.target_id) {
            Ok(target) => target,
            Err(CharacterError::NotFound) => return Ok(EntryOutcome::Skipped("targetMissing")),
            Err(error) => return Err(hold(error)),
        };
        let hash: Option<String> = transaction
            .query_row(
                "SELECT content_hash FROM assets WHERE id=?1 AND status='normal'",
                [&item.asset_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(hash) = hash else {
            return Ok(EntryOutcome::Skipped("assetMissing"));
        };
        // Same-byte identity: the asset id may have been re-ingested with other bytes.
        if !hash.eq_ignore_ascii_case(&item.asset_sha256) {
            return Ok(EntryOutcome::Skipped("assetChanged"));
        }
        if item.decision != "cleared" {
            let protected: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_references WHERE target_id=?1 AND asset_id=?2)
                     OR EXISTS(SELECT 1 FROM character_learned_references WHERE target_id=?1 AND asset_id=?2)",
                params![target.id, item.asset_id],
                |row| row.get(0),
            )?;
            if protected {
                return Ok(EntryOutcome::Skipped("protectedReference"));
            }
        }
        let latest = latest_decision(transaction, &target.id, &item.asset_id)?;
        let by_channel = match &latest {
            Some((sequence, _)) => transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM mobile_character_review_receipts WHERE decision_sequence=?1)",
                [sequence],
                |row| row.get::<_, bool>(0),
            )?,
            None => false,
        };
        let written = |transaction: &Connection| -> Result<Option<i64>, LibraryError> {
            Ok(latest_decision(transaction, &target.id, &item.asset_id)?
                .map(|(sequence, _)| sequence))
        };
        if item.decision == "cleared" {
            // Undo only what this channel did: an independent PC decision, however old, is
            // never cleared by a mobile undo.
            return match latest {
                None => Ok(EntryOutcome::Applied(None)),
                Some(_) if !by_channel => Ok(EntryOutcome::Superseded),
                Some((_, decision)) if decision == "cleared" => Ok(EntryOutcome::Applied(None)),
                Some(_) => {
                    let changed = self
                        .write_character_decisions(
                            transaction,
                            DecisionRequest {
                                target_id: target.id.clone(),
                                expected_fingerprint: target.fingerprint.clone(),
                                asset_ids: vec![item.asset_id.clone()],
                                decision: DecisionKind::Cleared,
                                baseline_fingerprint: None,
                                scan_id: None,
                            },
                        )
                        .map_err(hold)?;
                    Ok(EntryOutcome::Applied(if changed > 0 {
                        written(transaction)?
                    } else {
                        None
                    }))
                }
            };
        }
        if let Some((sequence, _)) = &latest {
            // A viewer "add" carries no basis: an explicit request, not a stale candidate.
            let basis = match (&item.basis, item.origin.as_str()) {
                (None, "viewer") => None,
                (basis, _) => Some(
                    basis
                        .as_deref()
                        .and_then(|basis| basis.parse::<i64>().ok())
                        .unwrap_or(0),
                ),
            };
            if !by_channel && basis.is_some_and(|basis| *sequence > basis) {
                return Ok(EntryOutcome::Superseded);
            }
        }
        if item.decision == "rejected" {
            return match self.write_inbound_character_rejection(
                transaction,
                &target.id,
                &item.asset_id,
                &item.asset_sha256,
            ) {
                Ok(true) => Ok(EntryOutcome::Applied(written(transaction)?)),
                Ok(false) => Ok(EntryOutcome::Applied(None)),
                Err(CharacterError::InboundProtectedReference) => {
                    Ok(EntryOutcome::Skipped("protectedReference"))
                }
                Err(CharacterError::InboundAssetChanged) => {
                    Ok(EntryOutcome::Skipped("assetChanged"))
                }
                Err(CharacterError::InboundTargetNotFound | CharacterError::NotFound) => {
                    Ok(EntryOutcome::Skipped("assetMissing"))
                }
                Err(error) => Err(hold(error)),
            };
        }
        match self.write_character_decisions(
            transaction,
            DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec![item.asset_id.clone()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            },
        ) {
            Ok(0) => Ok(EntryOutcome::Applied(None)),
            Ok(_) => Ok(EntryOutcome::Applied(written(transaction)?)),
            // Folder eligibility (series scope, originals area, media kind) failed.
            Err(CharacterError::Invalid(_) | CharacterError::Stale | CharacterError::NotFound) => {
                Ok(EntryOutcome::Skipped("ineligible"))
            }
            Err(error) => Err(hold(error)),
        }
    }

    /// Record the review position a successful navigation snapshot carried. The candidate
    /// feed reuses it as its `decisionCursor`. Only ever forwards.
    pub(crate) fn acknowledge_character_review_publication(
        &self,
        endpoint: &str,
        library_id: &str,
        cursor: i64,
    ) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE mobile_character_review_sync SET acknowledged_cursor = MAX(acknowledged_cursor, ?3)
             WHERE endpoint = ?1 AND library_id = ?2",
            params![endpoint, library_id, cursor],
        )?;
        Ok(())
    }

    /// Inbound mobile character decisions (review and exclusions) that wrote a local decision.
    /// A change tells an open review screen to reload.
    pub fn character_review_inbound_status(&self) -> Result<ReviewInboundStatus, LibraryError> {
        let applied: i64 = self.connection()?.query_row(
            "SELECT (SELECT COUNT(*) FROM mobile_character_review_receipts WHERE decision_sequence IS NOT NULL)
                  + (SELECT COUNT(*) FROM mobile_character_exclusion_receipts)",
            [],
            |row| row.get(0),
        )?;
        Ok(ReviewInboundStatus {
            applied: applied.max(0) as u64,
        })
    }
}

/// Whether this origin already consumed this exact entry; a receipt with other content
/// under the same operation id is a divergence and is refused.
fn receipt_matches(
    transaction: &Connection,
    item: &ReviewDecisionEntry,
    endpoint: &str,
    library_id: &str,
) -> Result<bool, LibraryError> {
    type Recorded = (i64, String, String, String, String, String, Option<String>);
    let recorded: Option<Recorded> = transaction
        .query_row(
            "SELECT sequence, target_id, asset_id, asset_sha256, decision, origin, basis
             FROM mobile_character_review_receipts
             WHERE endpoint = ?1 AND library_id = ?2 AND operation_id = ?3",
            params![endpoint, library_id, &item.operation_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((sequence, target, asset, sha256, decision, origin, basis)) = recorded else {
        return Ok(false);
    };
    if sequence != item.sequence
        || target != item.target_id
        || asset != item.asset_id
        || !sha256.eq_ignore_ascii_case(&item.asset_sha256)
        || decision != item.decision
        || origin != item.origin
        || basis != item.basis
    {
        return Err(LibraryError::CharacterReviewInvalid);
    }
    Ok(true)
}

#[cfg(test)]
#[path = "character_review_sync_tests.rs"]
mod tests;
