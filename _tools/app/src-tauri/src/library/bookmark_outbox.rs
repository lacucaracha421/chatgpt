//! B6 — PC-side send half of catalog-bookmark reconciliation.
//!
//! B5 made the PC able to *receive* the server-owned bookmark authority. This
//! module makes its own mutations travel the other way, durably:
//!
//! **local bookmark mutation → durable outbox entry → B4 bookmark command →
//! confirmed state**
//!
//! Three properties carry the design:
//!
//! 1. **One logical intent per entity, minted once.** `operation_id` is created
//!    when the local mutation is accepted and is reused verbatim on transport
//!    retry. A lost response therefore resolves through the server's B4 receipt
//!    instead of becoming a second logical write. A *superseding* local mutation
//!    is a different intent and takes a fresh operation id, because the server
//!    keys receipts by operation id and rejects reuse with a different payload.
//! 2. **The mutation and its operation commit together.** Both happen in one
//!    transaction, so a crash cannot leave a changed bookmark without its
//!    operation nor an operation for a bookmark that never changed.
//! 3. **Confirmation is atomic and durable.** The authoritative revision, the
//!    applied bookmark row and the removal of the outbox entry commit together, so
//!    a restart cannot resend an already confirmed intent.
//!
//! Send and receive cannot form a loop: the receive half writes
//! `online_catalog_bookmarks` without consulting or writing this queue, and
//! nothing here reacts to a remote apply by creating new work.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::cloud::client::{
    CloudClient, MobileCatalogBookmarkCommand, MobileCatalogBookmarkCommandResult,
};
use crate::library::{credential, error::LibraryError, Library};

use super::bookmark_reconciliation::{read_state, CONTRACT_VERSION};

/// Deterministic send order: oldest intent first, operation id breaking ties.
const OUTBOX_SELECT: &str =
    "SELECT operation_id, provider, work_id, desired_state, epoch, base_revision, created_at
     FROM catalog_bookmark_outbox ORDER BY created_at, operation_id";

/// A locally accepted bookmark intent that the authority has not confirmed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutboxEntry {
    pub operation_id: String,
    pub provider: String,
    pub work_id: String,
    pub desired_state: bool,
    pub epoch: i64,
    pub base_revision: i64,
    pub created_at: String,
}

impl OutboxEntry {
    fn command(&self, library_id: &str) -> MobileCatalogBookmarkCommand {
        MobileCatalogBookmarkCommand {
            library_id: library_id.to_owned(),
            epoch: self.epoch,
            contract_version: CONTRACT_VERSION,
            operation_id: self.operation_id.clone(),
            expected_revision: self.base_revision,
            desired_state: self.desired_state,
        }
    }
}

/// Outcome of one send pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkOutboxFlush {
    /// Intents the authority confirmed during this pass.
    pub sent: usize,
    /// Confirmed intents whose desired state the authority already held.
    pub already_current: usize,
    /// Intents still unconfirmed, with their operation ids unchanged.
    pub pending: usize,
    /// True when the authority's state moved under a queued intent and the intent
    /// was re-pointed at the refreshed authoritative revision.
    pub rebased: bool,
    /// True when no legal send was possible (PC-owned domain, or the server has
    /// not advertised the write capability). Nothing was sent or discarded.
    pub authority_unavailable: bool,
}

/// Pending/confirmed view for one entity: the domain-layer state B7 renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDeliveryState {
    pub provider: String,
    pub work_id: String,
    /// The desired state the PC currently holds for this entity.
    pub desired_state: bool,
    /// Whether an unconfirmed local intent exists for it.
    pub pending: bool,
    /// The operation id of that intent, when one exists. Stable across retries.
    pub operation_id: Option<String>,
    /// Last authoritative entity revision this PC has observed.
    pub confirmed_revision: Option<i64>,
}

fn read_outbox(connection: &Connection) -> Result<Vec<OutboxEntry>, LibraryError> {
    let mut statement = connection.prepare(OUTBOX_SELECT)?;
    let rows = statement.query_map([], |row| {
        Ok(OutboxEntry {
            operation_id: row.get(0)?,
            provider: row.get(1)?,
            work_id: row.get(2)?,
            desired_state: row.get::<_, i64>(3)? != 0,
            epoch: row.get(4)?,
            base_revision: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Record the authoritative revision of one entity.
fn write_revision(
    transaction: &Transaction<'_>,
    provider: &str,
    work_id: &str,
    revision: i64,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO catalog_bookmark_revisions (provider, work_id, revision) VALUES (?1, ?2, ?3)
         ON CONFLICT(provider, work_id) DO UPDATE SET revision = excluded.revision",
        params![provider, work_id, revision],
    )?;
    Ok(())
}

fn read_revision(
    connection: &Connection,
    provider: &str,
    work_id: &str,
) -> Result<Option<i64>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT revision FROM catalog_bookmark_revisions WHERE provider=?1 AND work_id=?2",
            params![provider, work_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Authority state this PC may send under.
struct Authority {
    library_id: String,
    epoch: i64,
}

/// Resolve the authority a send pass may use, or why it may not.
///
/// The identity fence B5 applies on receive is applied here *before* anything is
/// sent: a server advertising another library or another contract must never
/// receive this PC's commands. `Ok(None)` is the documented "no legal send"
/// state — the domain is still PC-owned, or the server owns it without
/// advertising the write capability — never an error to retry blindly.
fn resolve_authority(
    library: &Library,
    client: &CloudClient,
    token: &str,
) -> Result<Option<Authority>, LibraryError> {
    let authority = client.mobile_catalog_authority(token)?;
    let Some(server_library_id) = authority.library_id else {
        return Ok(None);
    };
    if !authority.bookmark_write {
        // The domain is server-owned but writes are not advertised. Queued
        // intents are retained: they become sendable once the server is upgraded,
        // and discarding them would lose user intent.
        return Ok(None);
    }
    let server_contract = authority
        .contract_version
        .ok_or(LibraryError::InvalidCloudResponse)?;
    if server_contract != CONTRACT_VERSION {
        return Err(LibraryError::CatalogBookmarkContractUnsupported);
    }
    if server_library_id != library.library_id()? {
        return Err(LibraryError::CatalogBookmarkAuthorityMismatch);
    }
    Ok(Some(Authority {
        library_id: server_library_id,
        epoch: authority.epoch.ok_or(LibraryError::InvalidCloudResponse)?,
    }))
}

/// Apply one confirmed command result and retire its intent in one transaction.
///
/// `changed: false` means the authority already held the desired state; the
/// command is still confirmed, so the intent is finished either way. A confirmed
/// `changed: true` result *is* the authority's current materialization, so the
/// local row adopts the authority's `created_at` — the same rule the receive half
/// applies when that change arrives through the change log instead.
fn confirm(
    library: &Library,
    entry: &OutboxEntry,
    result: &MobileCatalogBookmarkCommandResult,
    library_id: &str,
) -> Result<(), LibraryError> {
    if result.library_id != library_id
        || result.epoch != entry.epoch
        || result.contract_version != CONTRACT_VERSION
        || result.provider != entry.provider
        || result.work_id != entry.work_id
        || result.desired_state != entry.desired_state
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let connection = library.connection()?;
    let mut connection = connection;
    let transaction = connection.transaction()?;
    apply_confirmed_state(&transaction, entry, result)?;
    write_revision(
        &transaction,
        &entry.provider,
        &entry.work_id,
        result.entity_revision,
    )?;
    // Only the intent actually sent is retired. A superseding intent accepted
    // while this request was in flight has a different operation id and stays.
    transaction.execute(
        "DELETE FROM catalog_bookmark_outbox
         WHERE provider = ?1 AND work_id = ?2 AND operation_id = ?3",
        params![entry.provider, entry.work_id, entry.operation_id],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Write a confirmed desired state into the bookmark table.
fn apply_confirmed_state(
    transaction: &Transaction<'_>,
    entry: &OutboxEntry,
    result: &MobileCatalogBookmarkCommandResult,
) -> Result<(), LibraryError> {
    if !result.changed {
        // The authority reported no state change, so the local row already
        // matches what the authority holds.
        return Ok(());
    }
    if result.desired_state {
        let created = result
            .created_at
            .clone()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        transaction.execute(
            "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(provider, work_id) DO UPDATE SET created_at = excluded.created_at",
            params![entry.provider, entry.work_id, created],
        )?;
    } else {
        transaction.execute(
            "DELETE FROM online_catalog_bookmarks WHERE provider = ?1 AND work_id = ?2",
            params![entry.provider, entry.work_id],
        )?;
    }
    Ok(())
}

/// Retire an intent the authority has already satisfied.
///
/// Reached when a revision conflict reveals the authority already holds exactly
/// this intent's desired state: there is nothing left to write, so the intent is
/// completed locally rather than re-sent. Manufacturing a second command here
/// would be a duplicate logical write for no state change.
fn retire_satisfied(
    library: &Library,
    entry: &OutboxEntry,
    authoritative_revision: i64,
) -> Result<(), LibraryError> {
    let connection = library.connection()?;
    let mut connection = connection;
    let transaction = connection.transaction()?;
    write_revision(
        &transaction,
        &entry.provider,
        &entry.work_id,
        authoritative_revision,
    )?;
    transaction.execute(
        "DELETE FROM catalog_bookmark_outbox
         WHERE provider = ?1 AND work_id = ?2 AND operation_id = ?3",
        params![entry.provider, entry.work_id, entry.operation_id],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Re-point a rejected intent at the authoritative revision.
///
/// The local bookmark row is deliberately untouched: the local database is
/// PC-owned, so the user's visible state is already what they asked for, and only
/// the *queue entry* needs the authority's revision.
///
/// The operation id is **kept**. That is safe, not merely convenient: the server
/// looks up a receipt before it compares revisions, and acceptance always records
/// the receipt in the same transaction. A revision conflict therefore proves no
/// receipt exists for this operation id, so re-sending the same id under the
/// refreshed revision cannot collide with a recorded payload and cannot duplicate
/// a logical write. Keeping the id preserves the intent's identity, which is what
/// makes a subsequent lost response idempotent.
fn rebase(
    library: &Library,
    entry: &OutboxEntry,
    epoch: i64,
    revision: i64,
) -> Result<(), LibraryError> {
    let connection = library.connection()?;
    let mut connection = connection;
    let transaction = connection.transaction()?;
    write_revision(&transaction, &entry.provider, &entry.work_id, revision)?;
    transaction.execute(
        "UPDATE catalog_bookmark_outbox SET epoch = ?1, base_revision = ?2
         WHERE provider = ?3 AND work_id = ?4 AND operation_id = ?5",
        params![
            epoch,
            revision,
            entry.provider,
            entry.work_id,
            entry.operation_id
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

/// An intent composed under another epoch cannot reuse its stored revision:
/// revisions are only comparable inside one epoch. It is re-pointed at the live
/// epoch with a zero base, which lets the server's compare-and-set decide the
/// outcome instead of the PC guessing a cross-epoch mapping.
fn rebase_across_epoch(
    library: &Library,
    entry: &OutboxEntry,
    epoch: i64,
) -> Result<(), LibraryError> {
    let connection = library.connection()?;
    connection.execute(
        "UPDATE catalog_bookmark_outbox SET epoch = ?1, base_revision = 0
         WHERE provider = ?2 AND work_id = ?3 AND operation_id = ?4",
        params![epoch, entry.provider, entry.work_id, entry.operation_id],
    )?;
    Ok(())
}

impl Library {
    /// Pending/confirmed state for one bookmark entity.
    ///
    /// Reads only local durable state: an intent is pending while the outbox
    /// holds it, and a confirmed revision is one the authority has already
    /// reported. No network access, so a caller can render either offline.
    pub fn catalog_bookmark_delivery_state(
        &self,
        provider: &str,
        work_id: &str,
    ) -> Result<BookmarkDeliveryState, LibraryError> {
        let connection = self.connection()?;
        let bookmarked: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM online_catalog_bookmarks WHERE provider=?1 AND work_id=?2)",
            params![provider, work_id],
            |row| row.get(0),
        )?;
        let pending: Option<(String, bool)> = connection
            .query_row(
                "SELECT operation_id, desired_state FROM catalog_bookmark_outbox
                 WHERE provider=?1 AND work_id=?2",
                params![provider, work_id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()?;
        let (operation_id, desired_state) = match &pending {
            Some((operation_id, desired)) => (Some(operation_id.clone()), *desired),
            None => (None, bookmarked),
        };
        Ok(BookmarkDeliveryState {
            provider: provider.to_owned(),
            work_id: work_id.to_owned(),
            desired_state,
            pending: pending.is_some(),
            operation_id,
            confirmed_revision: read_revision(&connection, provider, work_id)?,
        })
    }

    /// Send pending bookmark intents to the authority, oldest first.
    ///
    /// Every intent is sent with its own durable operation id, so repeating a
    /// whole pass — including after a restart — is safe. A transport or
    /// authorization failure propagates as its typed state and leaves the intent,
    /// and the intents behind it, durable and pending.
    pub fn flush_catalog_bookmark_outbox(&self) -> Result<BookmarkOutboxFlush, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = credential::read_cloud_api_token_os()?;
        let token = token.expose();
        let client = CloudClient::new(endpoint)?;
        self.flush_catalog_bookmark_outbox_with(&client, &token)
    }

    /// The send pass against an already-built client, mirroring
    /// `reconcile_catalog_bookmarks_with` so the orchestration can run against a
    /// real server without going through credentials.
    pub(crate) fn flush_catalog_bookmark_outbox_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<BookmarkOutboxFlush, LibraryError> {
        let mut outcome = BookmarkOutboxFlush {
            sent: 0,
            already_current: 0,
            pending: 0,
            rebased: false,
            authority_unavailable: false,
        };
        let Some(authority) = resolve_authority(self, client, token)? else {
            outcome.authority_unavailable = true;
            outcome.pending = self.pending_intent_count()?;
            return Ok(outcome);
        };

        for entry in self.outbox_entries()? {
            let mut entry = entry;
            if entry.epoch != authority.epoch {
                // Revisions are only comparable inside one epoch, so an intent
                // composed under a previous one re-points at the live epoch with a
                // zero base and lets the server's compare-and-set decide.
                rebase_across_epoch(self, &entry, authority.epoch)?;
                entry.epoch = authority.epoch;
                entry.base_revision = 0;
                outcome.rebased = true;
            }
            let mut attempts = 0;
            loop {
                attempts += 1;
                let command = entry.command(&authority.library_id);
                match client.mobile_catalog_bookmark_command(
                    &entry.provider,
                    &entry.work_id,
                    &command,
                    token,
                ) {
                    Ok(result) => {
                        if !result.changed {
                            outcome.already_current += 1;
                        }
                        confirm(self, &entry, &result, &authority.library_id)?;
                        outcome.sent += 1;
                        break;
                    }
                    Err(LibraryError::CatalogBookmarkRevisionConflict {
                        current_revision,
                        current_desired_state,
                    }) => {
                        // The entity moved since this intent was composed. Refresh
                        // the local server-derived state through the B5 receive path
                        // first, so a stale replica is corrected by the same
                        // authoritative mechanism every other read uses. The
                        // conflict body is the authority's own current revision, so
                        // that is what the intent is re-pointed at.
                        self.reconcile_catalog_bookmarks_with(client, token)?;
                        outcome.rebased = true;
                        if current_desired_state == entry.desired_state {
                            // The authority already holds what this intent asks
                            // for, so there is nothing left to write. Completing it
                            // locally avoids manufacturing a duplicate command.
                            retire_satisfied(self, &entry, current_revision)?;
                            outcome.already_current += 1;
                            outcome.sent += 1;
                            break;
                        }
                        rebase(self, &entry, authority.epoch, current_revision)?;
                        if attempts > 1 {
                            // A second consecutive conflict means another writer is
                            // racing this entity. Leave the intent queued with its
                            // operation id and let a later pass settle it instead of
                            // thrashing here.
                            break;
                        }
                        entry.base_revision = current_revision;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        outcome.pending = self.pending_intent_count()?;
        Ok(outcome)
    }

    /// Pending intents read under one connection guard.
    fn outbox_entries(&self) -> Result<Vec<OutboxEntry>, LibraryError> {
        let connection = self.connection()?;
        read_outbox(&connection)
    }

    pub(crate) fn pending_intent_count(&self) -> Result<usize, LibraryError> {
        Ok(self.outbox_entries()?.len())
    }
}

/// Test seam: read the queue in production send order.
#[cfg(test)]
pub(crate) fn outbox_for_test(connection: &Connection) -> Vec<OutboxEntry> {
    read_outbox(connection).unwrap()
}

/// Record the authority revision of one snapshot row or change-log row.
///
/// Called by the receive half inside the transaction that applies the row, so the
/// revision cache always describes rows this PC has actually applied. It creates
/// no outgoing work.
pub(super) fn record_revision(
    transaction: &Transaction<'_>,
    provider: &str,
    work_id: &str,
    revision: i64,
) -> Result<(), LibraryError> {
    write_revision(transaction, provider, work_id, revision)
}

/// The `expectedRevision` a new local intent must present.
///
/// A cached revision is the authority's current value for the entity. With no
/// cached revision the entity has never been seen by this PC, whose conceptual
/// revision for an absent row is 0 — the same convention the server uses.
pub(super) fn base_revision_for(
    connection: &Connection,
    provider: &str,
    work_id: &str,
) -> Result<i64, LibraryError> {
    Ok(read_revision(connection, provider, work_id)?.unwrap_or(0))
}

/// The authority this PC has adopted, if any.
///
/// Local mutations queue an intent only under an adopted authority. While the
/// domain is still PC-owned there is no authority to send to, so pre-B6 local
/// behavior stays byte-identical and no library accumulates orphaned intents.
pub(super) fn current_authority(
    connection: &Connection,
) -> Result<Option<(String, i64)>, LibraryError> {
    Ok(read_state(connection)?.map(|state| (state.library_id, state.epoch)))
}

/// Write one intent into the caller's transaction, coalescing onto the entity.
///
/// `UNIQUE(provider, work_id)` admits one intent per entity: a superseding local
/// mutation replaces the stored one and always arrives with a fresh operation id,
/// because the server keys receipts by operation id and rejects reuse with a
/// different payload.
fn enqueue(
    transaction: &Transaction<'_>,
    provider: &str,
    work_id: &str,
    desired_state: bool,
    epoch: i64,
    base_revision: i64,
    created_at: &str,
    operation_id: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO catalog_bookmark_outbox
            (operation_id, provider, work_id, desired_state, epoch, base_revision, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(provider, work_id) DO UPDATE SET
             operation_id = excluded.operation_id,
             desired_state = excluded.desired_state,
             epoch = excluded.epoch,
             base_revision = excluded.base_revision,
             created_at = excluded.created_at",
        params![
            operation_id,
            provider,
            work_id,
            i64::from(desired_state),
            epoch,
            base_revision,
            created_at
        ],
    )?;
    // Wake the coordinated authority pass instead of waiting out its idle backoff.
    super::authority_pass::note_local_work();
    Ok(())
}

/// Record a local bookmark mutation as a durable operation, inside the caller's
/// transaction.
///
/// This is the single enqueue path for PC-owned mutations: the bookmark table
/// change and its operation commit together, so a crash cannot separate them.
/// Nothing calls it from the receive half, so a remote apply never enqueues.
///
/// A `true`-state add that the local table already holds, or a `false`-state
/// removal of a row already absent, is not a mutation and enqueues nothing —
/// matching the server, which accepts that same intent as a receipted no-op.
pub(super) fn enqueue_local_mutation(
    transaction: &Transaction<'_>,
    provider: &str,
    work_id: &str,
    desired_state: bool,
    changed: bool,
) -> Result<(), LibraryError> {
    let Some((_library_id, epoch)) = current_authority(transaction)? else {
        return Ok(());
    };
    if !changed {
        return Ok(());
    }
    let base_revision = base_revision_for(transaction, provider, work_id)?;
    enqueue(
        transaction,
        provider,
        work_id,
        desired_state,
        epoch,
        base_revision,
        &chrono::Utc::now().to_rfc3339(),
        &uuid::Uuid::new_v4().to_string(),
    )
}

/// Re-assert every pending intent over bookmark rows a remote apply just wrote.
///
/// The authority is the source of truth for *confirmed* state, but an intent this
/// PC has not delivered yet must not disappear from the user's view because an
/// unrelated baseline or change page arrived first. This runs inside the same
/// transaction as the apply, writes only the bookmark table, and enqueues
/// nothing.
pub(super) fn overlay_pending_intents(transaction: &Transaction<'_>) -> Result<(), LibraryError> {
    let mut statement = transaction.prepare(
        "SELECT provider, work_id, desired_state, created_at FROM catalog_bookmark_outbox",
    )?;
    let entries = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (provider, work_id, desired_state, created_at) in entries {
        if desired_state {
            transaction.execute(
                "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(provider, work_id) DO NOTHING",
                params![provider, work_id, created_at],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM online_catalog_bookmarks WHERE provider=?1 AND work_id=?2",
                params![provider, work_id],
            )?;
        }
    }
    Ok(())
}
