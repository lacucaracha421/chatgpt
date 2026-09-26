//! Manual character exclusions accepted by the mobile server while the PC was off.
//!
//! A user can exclude an asset from a character on mobile. That correction has to survive
//! a PC that is closed, so the *server* accepts it, reflects it in its read projection,
//! and keeps an ordered log. The PC then pulls that log and records the same explicit
//! rejection locally, through the shared character decision path. Character inference
//! stays entirely on the PC — nothing here classifies, scores or backfills.
//!
//! # The shape of the trust boundary
//!
//! The server owns *acceptance*; this PC owns *application*. That split is why the log is
//! a list of claims (`targetId`, `assetId`, `assetSha256`) rather than decisions: a claim
//! is only recorded after this library proves it locally.
//!
//! Every entry is validated against local truth before it is applied:
//!
//! * the target must exist in this library;
//! * the asset must still exist and be `normal`;
//! * the stored `content_hash` must equal the claimed `assetSha256`, because an asset id
//!   can be re-ingested with different bytes and rejecting those would be a different
//!   decision than the user made;
//! * the asset must not be one of the target's base or learned references, because a
//!   reference is what *defines* the character.
//!
//! Each of those checks describes a state that can only move further away: a deleted target
//! does not come back, a trashed asset is no longer a member, other bytes are a different
//! image, and a reference defines the character. An entry failing one of them is therefore
//! *consumed as skipped*: its receipt is written, the cursor advances past it, and the pass
//! records it under a closed reason (`targetMissing`, `assetMissing`, `assetChanged`,
//! `protectedReference`, the same codes `character_review_sync` records) in the receipt's
//! `skip_reason`, which the sync-state panel reads. Holding the cursor
//! on such an entry would retry it forever and block every later correction behind it.
//!
//! Only errors that may clear on retry (database or I/O failures) still fail the whole page
//! closed: no decision is written and the cursor does not move.
//!
//! The server keeps no per-entry outcome. Acknowledging the cursor only ends the server's
//! pending overlay for those entries; membership then follows this PC's published snapshot,
//! which is the correct view for every skip reason (the pair no longer exists as a member,
//! or the image is a reference of the character).
//!
//! # Idempotency
//!
//! Delivery is at-least-once. Two guards make a replay harmless: the durable
//! `received_cursor` (read and advanced inside the applying transaction) and a scoped receipt
//! per operation carrying the claim it consumed. An older page fetched before another pass
//! advanced the cursor therefore cannot rewind it or re-insert a rejection the user has since
//! overridden.
//!
//! The latest-decision check in `write_inbound_character_rejection` does **not** provide this:
//! it only dedupes the *same* desired state, and after a later PC re-accept a replayed
//! rejection looks like a genuinely new intent to that check alone.
//!
//! # Bounded passes
//!
//! One pass applies at most [`MAX_PAGES`] pages; a backlog drains across ticks.
//!
//! # No outbound work
//!
//! Receiving creates no outgoing intent. The decision written here is a local
//! materialization of a correction the server already accepted, so recording it consumes
//! no receipt and enqueues no duplicate; the publication that follows simply reflects the
//! new state through the existing dirty-trigger path.
use rusqlite::{params, Connection, OptionalExtension};

use super::{error::LibraryError, Library};
use crate::cloud::characters::ExclusionEntry;
use crate::cloud::client::CloudClient;
use crate::library::credential;

/// The server bounds this to 1..=100.
const PAGE_LIMIT: i64 = 100;
/// Pages one pass may apply before returning.
///
/// This is a deliberate bound on how long a single background tick can spend, not a limit on
/// how much can ever be received: the cursor is durable, so an unfinished backlog is picked up
/// by the next pass. Ten pages is already 1000 entries in one tick, far more than a mobile
/// session is likely to produce, and it keeps the lane responsive.
const MAX_PAGES: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExclusionSyncOutcome {
    pub library_id: String,
    pub received_cursor: i64,
    pub applied: u64,
    pub already_consumed: u64,
    /// Entries consumed without a decision because they can never apply here.
    pub skipped: u64,
}

impl Library {
    /// The adopted `(library_id, received_cursor)` for one endpoint, if any.
    ///
    /// `None` is the documented "never adopted" state and is distinct from an adopted
    /// zero cursor: the first is "this PC has never spoken to an exclusion-aware server"
    /// and the second is "it has, and nothing was waiting". Only the first permits a
    /// legacy publication, so the two must not collapse.
    pub(crate) fn character_exclusion_adoption(
        &self,
        endpoint: &str,
    ) -> Result<Option<(String, i64)>, LibraryError> {
        let connection = self.connection()?;
        Ok(connection
            .query_row(
                "SELECT library_id, received_cursor FROM mobile_character_exclusion_sync
                 WHERE endpoint = ?1",
                [endpoint],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?)
    }

    /// Bind this endpoint to a library with a zero cursor, marking characters dirty.
    ///
    /// `ON CONFLICT DO NOTHING` is load-bearing: a concurrent pass that already adopted the
    /// same endpoint must keep its cursor, and re-adopting is only ever legal for an endpoint
    /// that has no row. The dirty bump runs only when a row was actually inserted, so a
    /// redundant adopt cannot manufacture publication churn.
    ///
    /// Bumping the publication generation is what makes the server ever learn the feature is
    /// in use: the first feature-aware snapshot is what transitions the server's `NULL` state
    /// row into existence, and without this the bootstrap could sit unadvertised until some
    /// unrelated character edit happened to dirty the lane.
    pub(crate) fn adopt_character_exclusion_library(
        &self,
        endpoint: &str,
        library_id: &str,
    ) -> Result<(), LibraryError> {
        if !super::is_valid_library_id(library_id) || self.library_id()? != library_id {
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let inserted = transaction.execute(
            "INSERT INTO mobile_character_exclusion_sync(endpoint, library_id, received_cursor, updated_at)
             VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(endpoint, library_id) DO NOTHING",
            params![endpoint, library_id, chrono::Utc::now().to_rfc3339()],
        )?;
        if inserted == 1 {
            transaction.execute(
                "UPDATE mobile_publication_state SET generation=generation+1,
                 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
                 last_dirty=unixepoch() WHERE kind='characters'",
                [],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Probe the log route and adopt this endpoint on first sight.
    ///
    /// Used by the receive poll so a server upgraded while this PC was idle is discovered
    /// without waiting for an unrelated local edit. `Ok(false)` means the route is absent: an
    /// older server, which no adoption is recorded against. `Ok(true)` means this endpoint is
    /// now bound (either just now or previously) and the caller may receive.
    pub(crate) fn bootstrap_character_exclusions(
        &self,
        endpoint: &str,
    ) -> Result<bool, LibraryError> {
        if self.character_exclusion_adoption(endpoint)?.is_some() {
            return Ok(true);
        }
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(false);
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(false),
            Err(error) => return Err(error),
        };
        let client = CloudClient::new(endpoint)?;
        self.bootstrap_character_exclusions_with(&client, publisher.expose(), endpoint)
    }

    /// The probe-and-adopt step with an injected transport and token, so a scripted server
    /// drives the real path without reading this machine's OS credential store.
    pub(crate) fn bootstrap_character_exclusions_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<bool, LibraryError> {
        if self.character_exclusion_adoption(endpoint)?.is_some() {
            return Ok(true);
        }
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(false);
        }
        let library_id = self.library_id()?;
        match client.character_exclusions(publisher_token, &library_id, 0, 1)? {
            None => Ok(false),
            Some(_) => {
                self.adopt_character_exclusion_library(endpoint, &library_id)?;
                Ok(true)
            }
        }
    }

    /// Pull and apply pending exclusions for the adopted endpoint, up to [`MAX_PAGES`].
    ///
    /// Network reads happen with no database lock held. Each page is applied in its own local
    /// transaction that re-reads and advances the durable cursor, so a page fetched from a
    /// position another pass has already moved past is a harmless no-op rather than a rewind.
    /// `Ok(None)` means this endpoint has no adopted library, so there is nothing to do — that
    /// is a state, not an error.
    pub(crate) fn receive_character_exclusions(
        &self,
        endpoint: &str,
    ) -> Result<Option<ExclusionSyncOutcome>, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(None);
        }
        // The log is publisher-only.
        let publisher = credential::read_cloud_publisher_token_os()?;
        let publisher = publisher.expose();
        let client = CloudClient::new(endpoint)?;
        self.receive_character_exclusions_with(&client, publisher, endpoint)
    }

    /// The receive pass with an injected transport, so a scripted server can drive the real
    /// production path end to end rather than a double standing in for it.
    pub(crate) fn receive_character_exclusions_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<Option<ExclusionSyncOutcome>, LibraryError> {
        // The endpoint must be the configured one before any read, so a stale or forged value
        // cannot direct corrections from somewhere this PC is not bound to.
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(None);
        }
        let Some((library_id, mut cursor)) = self.character_exclusion_adoption(endpoint)? else {
            return Ok(None);
        };
        let mut applied = 0;
        let mut already_consumed = 0;
        let mut skipped = 0;
        for _ in 0..MAX_PAGES {
            // Read the page with no database lock held. An adopted binding means this PC has
            // already established that it speaks to a capable server, so an absent route is
            // surfaced here rather than treated as a compatibility state.
            let page = client
                .character_exclusions(publisher_token, &library_id, cursor, PAGE_LIMIT)?
                .ok_or(LibraryError::CharacterExclusionUnsupported)?;
            let step = self.apply_character_exclusion_page(endpoint, &library_id, &page.items)?;
            applied += step.0;
            already_consumed += step.1;
            skipped += step.2;
            // Re-read the durable position rather than trusting the page just fetched. A
            // concurrent pass may have advanced it further, and the outcome must describe
            // what is actually stored.
            let durable = self
                .character_exclusion_adoption(endpoint)?
                .map(|(_, cursor)| cursor)
                .ok_or(LibraryError::CharacterExclusionCursorRejected)?;
            cursor = durable;
            // `has_more` with no forward movement would spin, so it ends the pass; the next
            // tick resumes from the durable cursor.
            if !page.has_more || durable <= page.after {
                break;
            }
        }
        Ok(Some(ExclusionSyncOutcome {
            library_id,
            received_cursor: cursor,
            applied,
            already_consumed,
            skipped,
        }))
    }

    /// Apply one validated page, advancing the cursor in the same transaction.
    ///
    /// Returns `(applied, already_consumed, skipped)`. The whole page is one transaction, so an
    /// interruption re-applies it rather than skipping past it; the receipts make that
    /// re-application a no-op. An entry that can never apply is receipted and counted as
    /// skipped; any other failure aborts the transaction, which leaves both the decisions and
    /// the cursor exactly where they were.
    ///
    /// The persisted cursor is read **inside** this transaction and the page is checked
    /// against it, not against whatever position the caller believed when it issued the
    /// network read. A receive pass reads its pages outside any database lock, so another
    /// pass or a publication can advance the durable cursor in between; a stale caller
    /// position must never move it backwards or re-apply an already-consumed entry.
    pub(crate) fn apply_character_exclusion_page(
        &self,
        endpoint: &str,
        library_id: &str,
        items: &[ExclusionEntry],
    ) -> Result<(u64, u64, u64), LibraryError> {
        if !super::is_valid_library_id(library_id) {
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        // The local library must actually be the library this endpoint is bound to. A row
        // naming another identity means the library directory was copied or restored under
        // a different identity, and applying its corrections here would be wrong.
        if self.library_id()? != library_id {
            return Err(LibraryError::CharacterExclusionCursorRejected);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let durable: i64 = transaction
            .query_row(
                "SELECT received_cursor FROM mobile_character_exclusion_sync
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CharacterExclusionCursorRejected)?;
        let mut expected = durable + 1;
        let mut highest = durable;
        let mut applied = 0;
        let mut already_consumed = 0;
        let mut skipped = 0;
        let now = chrono::Utc::now().to_rfc3339();
        for item in items {
            let consumed =
                Self::exclusion_receipt_matches(&transaction, item, endpoint, library_id)?;
            if item.sequence <= durable {
                // At or below the durable cursor this entry is already accounted for. It is
                // only skipped when a receipt proves it, because a position below the cursor
                // with no receipt is a state this PC cannot explain; applying it would insert
                // behind a position already acknowledged, and skipping it silently would hide
                // the divergence. Failing closed is the only honest answer.
                if !consumed {
                    return Err(LibraryError::CharacterExclusionInvalid);
                }
                already_consumed += 1;
                continue;
            }
            if item.sequence != expected {
                // A gap would advance past an entry never seen, with no later read able to
                // recover it.
                return Err(LibraryError::CharacterExclusionInvalid);
            }
            if consumed {
                already_consumed += 1;
            } else {
                let mut skip_reason = None;
                match self.write_inbound_character_rejection(
                    &transaction,
                    &item.target_id,
                    &item.asset_id,
                    &item.asset_sha256,
                ) {
                    Ok(true) => applied += 1,
                    Ok(false) => {}
                    Err(error) => match permanent_skip_reason(&error) {
                        // The validation runs before any write, so nothing needs undoing.
                        Some(reason) => {
                            skipped += 1;
                            skip_reason = Some(reason);
                        }
                        None => return Err(map_character_exclusion_error(error)),
                    },
                }
                // The receipt is written only for an entry this pass actually consumed,
                // applied or skipped. An already-receipted entry needs no second row, and its
                // uniqueness key would reject one anyway.
                transaction.execute(
                    "INSERT INTO mobile_character_exclusion_receipts
                        (endpoint, library_id, operation_id, sequence, target_id, asset_id, asset_sha256, created_at, skip_reason)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        endpoint,
                        library_id,
                        item.operation_id,
                        item.sequence,
                        item.target_id,
                        item.asset_id,
                        item.asset_sha256,
                        now,
                        skip_reason
                    ],
                )?;
            }
            expected += 1;
            highest = item.sequence;
        }
        // Only ever forwards. A page whose entries were all already consumed leaves the
        // cursor exactly where it was instead of rewinding it to this page's end.
        if highest > durable {
            transaction.execute(
                "UPDATE mobile_character_exclusion_sync
                 SET received_cursor = ?3, updated_at = ?4
                 WHERE endpoint = ?1 AND library_id = ?2",
                params![endpoint, library_id, highest, now],
            )?;
            // A correction may already be rejected locally. Advancing its receipt still
            // needs a publication so the server can acknowledge this cursor.
            transaction.execute(
                "UPDATE mobile_publication_state SET generation=generation+1,
                 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
                 last_dirty=unixepoch() WHERE kind='characters'",
                [],
            )?;
        }
        transaction.commit()?;
        Ok((applied, already_consumed, skipped))
    }

    /// Whether this origin already consumed this exact entry.
    ///
    /// Looked up by the full key `(endpoint, library_id, operation_id)`, because an operation
    /// id is only unique inside the server that minted it. A row found under this key whose
    /// recorded sequence or claim differs from the entry being applied is a divergence the PC
    /// cannot reconcile, so it is refused rather than accepted as a no-op.
    fn exclusion_receipt_matches(
        transaction: &Connection,
        item: &ExclusionEntry,
        endpoint: &str,
        library_id: &str,
    ) -> Result<bool, LibraryError> {
        let recorded: Option<(i64, String, String, String)> = transaction
            .query_row(
                "SELECT sequence, target_id, asset_id, asset_sha256
                 FROM mobile_character_exclusion_receipts
                 WHERE endpoint = ?1 AND library_id = ?2 AND operation_id = ?3",
                params![endpoint, library_id, &item.operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((sequence, target, asset, sha256)) = recorded else {
            return Ok(false);
        };
        if sequence != item.sequence
            || target != item.target_id
            || asset != item.asset_id
            || !sha256.eq_ignore_ascii_case(&item.asset_sha256)
        {
            return Err(LibraryError::CharacterExclusionInvalid);
        }
        Ok(true)
    }
}

/// The closed reason for a validation failure that can never clear on retry, if it is one.
///
/// These are the states the module docs list: none of them is transient, so the entry is
/// consumed as skipped instead of holding the cursor. Everything else is `None` and still
/// fails the page closed.
fn permanent_skip_reason(error: &super::characters::Error) -> Option<&'static str> {
    use super::characters::Error;
    match error {
        Error::NotFound => Some("targetMissing"),
        Error::InboundTargetNotFound => Some("assetMissing"),
        Error::InboundAssetChanged => Some("assetChanged"),
        Error::InboundProtectedReference => Some("protectedReference"),
        _ => None,
    }
}

/// Map a local character validation failure onto this feature's own error surface.
///
/// The distinct variants matter because they demand different actions: a missing row is a
/// library that moved on, while a hash mismatch is an asset whose bytes changed. Folding
/// them into one error would leave "retry forever" as the only visible response to both.
fn map_character_exclusion_error(error: super::characters::Error) -> LibraryError {
    use super::characters::Error;
    match error {
        Error::InboundProtectedReference => LibraryError::CharacterExclusionProtectedReference,
        Error::InboundAssetChanged => LibraryError::CharacterExclusionAssetChanged,
        Error::InboundTargetNotFound | Error::NotFound => {
            LibraryError::CharacterExclusionTargetMissing
        }
        Error::Library(error) => error,
        Error::Db(error) => LibraryError::Database(error),
        Error::Json(_) | Error::Io(_) | Error::Invalid(_) | Error::Stale | Error::Worker(_) => {
            LibraryError::InvalidCloudResponse
        }
    }
}
