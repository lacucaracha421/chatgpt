//! Classification authority on the PC: durable state, a transactional outbox and the flush.
//!
//! This module owns what the PC *knows* about the server's Classification authority and
//! what it *intends*. The receive half lives in
//! [`super::classification_reconciliation`].
//!
//! * `classification_authority_sync` — the adopted authority identity and cursor;
//! * `classification_authority_revisions` — confirmed Classification revisions and
//!   tombstones;
//! * `classification_authority_assignment_revisions` — confirmed assignment lineage
//!   state, including authoritative *unassigned* rows;
//! * `classification_authority_outbox` — durable outgoing intents in strict FIFO order.
//!
//! # Confirmed versus pending
//!
//! The revision caches record what the *server* confirmed. `classification_entries`,
//! `asset_classifications` and `classification_roles` are the materialized view, which
//! is legitimately ahead of confirmed state while optimistic operations are queued.
//! Speculative revisions live only inside queued payloads, never in the caches, so a
//! later command can always tell the server's truth from the user's intent.
//!
//! # Nothing is coalesced
//!
//! Bookmarks keep one intent per entity, because the newest desired state is the whole
//! meaning of a toggle. Classification commands are ordered and dependent —
//! `create X -> rename X -> move X -> assign Asset -> X` must reach the server in that
//! order, and a later command's expectation only exists because its predecessors are
//! ahead of it — so the outbox is strict FIFO and each accepted mutation appends a row.
//!
//! # Two revision lineages, deliberately independent
//!
//! A Classification's own revision versions its structure and appearance. An Asset's
//! assignment is its own lineage, keyed by the Asset, and cannot be satisfied by a
//! Classification revision. Predictions compose each lineage separately
//! ([`predicted_classification_revision`], [`predicted_assignment_revision`]).
//!
//! # Two credentials
//!
//! The server separates the write classes. `setAssetClassification` is an ordinary
//! client operation and presents the client credential; every structural command
//! requires the publisher role, because the character-series-into-`originals` rule is
//! still a PC-derived constraint the server cannot enforce. The send half therefore
//! resolves the publisher credential *only* when it is about to send a structural
//! command, so an assignment-only queue is deliverable with the client credential
//! alone.
//!
//! # Two states that must stay distinct
//!
//! An assignment lineage has three possible local representations, and the difference
//! between the last two is load-bearing:
//!
//! * no cache row — this PC has never been told about that Asset (revision 0);
//! * a row with `classification_id = NULL` — an authoritative *unassigned* state at a
//!   real revision 1+;
//! * a row with a Classification id — an authoritative live assignment.
//!
//! Collapsing the middle case into the first would make a cleared assignment look like
//! one the authority never mentioned, so a later command would present revision 0 for a
//! lineage that had legitimately advanced.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::cloud::client::{ClassificationCommandOutcome, CloudClient};

use super::error::LibraryError;
use super::{credential, Library};

/// The shared domain name the server reports Classification authority under.
pub(crate) const CLASSIFICATION_DOMAIN: &str = "classifications";

/// The Classification domain contract this build speaks.
pub(crate) const CLASSIFICATION_CONTRACT_VERSION: i64 = 1;

/// The `originals` role v1 carries. Immutable authority state: no command produces it,
/// so the only way a replica learns it is from a baseline.
pub(crate) const ORIGINALS_ROLE: &str = "originals";

/// Command names, matching the server's exactly.
pub(crate) const CREATE: &str = crate::cloud::client::CLASSIFICATION_CREATE;
pub(crate) const RENAME: &str = crate::cloud::client::CLASSIFICATION_RENAME;
pub(crate) const MOVE: &str = crate::cloud::client::CLASSIFICATION_MOVE;
pub(crate) const APPEARANCE: &str = crate::cloud::client::CLASSIFICATION_APPEARANCE;
pub(crate) const DELETE: &str = crate::cloud::client::CLASSIFICATION_DELETE;
pub(crate) const ASSIGNMENT: &str = crate::cloud::client::CLASSIFICATION_ASSIGNMENT;

/// The conflict code an accepted-but-unresolvable structural edit reports.
pub(crate) const REVISION_CONFLICT: &str = "revisionConflict";

/// The code the server returns when an assignment names an Asset it has not committed.
///
/// This is a legitimate transient cross-domain ordering state — the Asset exists
/// locally and the assignment intent is queued, but Asset replication has not reached
/// the server yet — so it stays pending and retries with the identical operation id
/// rather than blocking the user's intent.
pub(crate) const INVALID_ASSIGNMENT: &str = "invalidClassificationAssignment";

/// The adopted Classification authority, or `None` while the domain is still PC-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClassificationAuthority {
    pub(crate) library_id: String,
    pub(crate) epoch: i64,
    pub(crate) contract_version: i64,
    pub(crate) cursor: i64,
}

/// One durable outgoing Classification intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClassificationOutboxEntry {
    pub seq: i64,
    pub operation_id: String,
    pub command_type: String,
    pub classification_id: Option<String>,
    pub asset_id: Option<String>,
    pub epoch: i64,
    /// The exact command body, serialized once at enqueue time so every retry sends
    /// provably identical bytes.
    pub payload: serde_json::Value,
    pub state: String,
    pub conflict_code: Option<String>,
    pub conflict_detail: Option<serde_json::Value>,
    pub created_at: String,
}

impl ClassificationOutboxEntry {
    pub(crate) fn is_blocked(&self) -> bool {
        self.state == "blocked"
    }

    /// Whether this intent is an ordinary client operation rather than a structural one.
    ///
    /// The server authorizes the two write classes with different credentials, and the
    /// send half must know which one this row needs *before* it resolves a token.
    pub(crate) fn is_assignment(&self) -> bool {
        self.command_type == ASSIGNMENT
    }
}

/// Typed Classification sync/delivery status for the UI and for later conflict work.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationSyncStatus {
    pub adopted: bool,
    pub library_id: Option<String>,
    pub epoch: Option<i64>,
    pub contract_version: Option<i64>,
    pub cursor: Option<i64>,
    pub pending_count: u32,
    pub blocked_count: u32,
    pub oldest_pending_operation_id: Option<String>,
}

/// Outcome of one Classification outbox flush pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationOutboxFlush {
    pub sent: u32,
    /// Accepted commands the authority already held the desired state for.
    pub no_op: u32,
    /// Assignment intents automatically rebased onto the authority's current revision.
    ///
    /// The conflict was never accepted or receipted, so rewriting only the pending
    /// payload's `expectedRevision` is a legal rebase of the same logical intent.
    pub rebased: u32,
    pub blocked: u32,
    pub pending: u32,
    pub stopped: bool,
}

/// Outcome of one Classification reconciliation pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationReconciliation {
    /// True once a Classification authority has been adopted locally.
    pub adopted: bool,
    /// True when this pass adopted or re-based a full baseline.
    pub adopted_baseline: bool,
    /// Change rows applied during this pass.
    pub applied_changes: u32,
    /// Authority cursor the server reported at the start of this pass.
    pub server_cursor: Option<i64>,
    /// Cursor durably applied locally at the end of this pass.
    pub local_cursor: Option<i64>,
    /// How far behind the authority the local replica still is.
    pub behind_by: i64,
    /// Confirmed assignments projected into `asset_classifications` by this pass whose
    /// Asset had not been materialized when the assignment was first confirmed.
    pub rematerialized_assignments: u32,
    /// True when the queue was not clean, so no receive was attempted.
    pub deferred_to_outbox: bool,
}

// ---------------------------------------------------------------------------
// Local durable state
// ---------------------------------------------------------------------------

/// The singleton adoption row, or `None` before any baseline is adopted.
///
/// Its presence *is* the adoption marker: migration 0083 documents that an empty
/// table means Classification authority was never adopted, and the restore guard reads
/// exactly this.
pub(super) fn read_authority(
    connection: &Connection,
) -> Result<Option<ClassificationAuthority>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor
             FROM classification_authority_sync WHERE singleton = 1",
            [],
            |row| {
                Ok(ClassificationAuthority {
                    library_id: row.get(0)?,
                    epoch: row.get(1)?,
                    contract_version: row.get(2)?,
                    cursor: row.get(3)?,
                })
            },
        )
        .optional()?)
}

pub(super) fn write_authority(
    transaction: &Transaction<'_>,
    authority: &ClassificationAuthority,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO classification_authority_sync
            (singleton, library_id, epoch, contract_version, cursor, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(singleton) DO UPDATE SET library_id = excluded.library_id,
             epoch = excluded.epoch, contract_version = excluded.contract_version,
             cursor = excluded.cursor, updated_at = excluded.updated_at",
        params![
            authority.library_id,
            authority.epoch,
            authority.contract_version,
            authority.cursor,
            now
        ],
    )?;
    Ok(())
}

/// The confirmed Classification revision and tombstone flag, or `None` when the
/// authority has never told this PC about that Classification.
pub(super) fn read_classification_revision(
    connection: &Connection,
    classification_id: &str,
) -> Result<Option<(i64, bool)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT entity_revision, deleted FROM classification_authority_revisions
             WHERE classification_id = ?1",
            [classification_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(super) fn write_classification_revision(
    transaction: &Transaction<'_>,
    classification_id: &str,
    revision: i64,
    deleted: bool,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO classification_authority_revisions
            (classification_id, entity_revision, deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(classification_id) DO UPDATE SET
             entity_revision = excluded.entity_revision, deleted = excluded.deleted,
             updated_at = excluded.updated_at",
        params![classification_id, revision, i64::from(deleted), now],
    )?;
    Ok(())
}

/// The confirmed assignment lineage state, or `None` when this PC has never been told
/// about that Asset.
///
/// `Some((None, revision))` is the authoritative unassigned state, which is not the
/// same as `None`: see the module docs.
pub(super) fn read_assignment_revision(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<(Option<String>, i64)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT classification_id, entity_revision
             FROM classification_authority_assignment_revisions WHERE asset_id = ?1",
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(super) fn write_assignment_revision(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
    revision: i64,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO classification_authority_assignment_revisions
            (asset_id, classification_id, entity_revision, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(asset_id) DO UPDATE SET
             classification_id = excluded.classification_id,
             entity_revision = excluded.entity_revision, updated_at = excluded.updated_at",
        params![asset_id, classification_id, revision, now],
    )?;
    Ok(())
}

/// Every cached assignment whose lineage currently names this Classification.
///
/// This reads the *authority cache*, not `asset_classifications`, because the authority
/// legitimately holds assignments for Assets this PC has not materialized. The count it
/// returns is what a delete transition is verified against.
pub(super) fn assignments_naming(
    connection: &Connection,
    classification_id: &str,
) -> Result<Vec<(String, i64)>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT asset_id, entity_revision FROM classification_authority_assignment_revisions
         WHERE classification_id = ?1 ORDER BY asset_id",
    )?;
    let rows = statement.query_map([classification_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ---------------------------------------------------------------------------
// Durable outgoing intents
// ---------------------------------------------------------------------------

fn decode_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClassificationOutboxEntry> {
    let payload: String = row.get(6)?;
    let conflict: Option<String> = row.get(9)?;
    Ok(ClassificationOutboxEntry {
        seq: row.get(0)?,
        operation_id: row.get(1)?,
        command_type: row.get(2)?,
        classification_id: row.get(3)?,
        asset_id: row.get(4)?,
        epoch: row.get(5)?,
        // A payload that cannot be decoded is kept as `Null` rather than dropped: the
        // row is still one logical intent, and the send half refuses to send an intent
        // whose stored bytes it cannot present identically.
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        state: row.get(7)?,
        conflict_code: row.get(8)?,
        conflict_detail: conflict.and_then(|value| serde_json::from_str(&value).ok()),
        created_at: row.get(10)?,
    })
}

const OUTBOX_SELECT: &str =
    "SELECT seq, operation_id, command_type, classification_id, asset_id, epoch, payload,
            state, conflict_code, conflict_detail, created_at
     FROM classification_authority_outbox ORDER BY seq";

/// Every queued intent, strictly oldest first.
pub(super) fn read_outbox(
    connection: &Connection,
) -> Result<Vec<ClassificationOutboxEntry>, LibraryError> {
    let mut statement = connection.prepare(OUTBOX_SELECT)?;
    let entries = statement
        .query_map([], decode_entry)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries)
}

fn outbox_counts(connection: &Connection) -> Result<(u32, u32), LibraryError> {
    let mut statement =
        connection.prepare("SELECT state, COUNT(*) FROM classification_authority_outbox GROUP BY state")?;
    let mut pending = 0;
    let mut blocked = 0;
    for row in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
        let (state, count) = row?;
        let count = u32::try_from(count).unwrap_or(u32::MAX);
        match state.as_str() {
            "pending" => pending = count,
            "blocked" => blocked = count,
            _ => {}
        }
    }
    Ok((pending, blocked))
}

// ---------------------------------------------------------------------------
// Revision prediction
// ---------------------------------------------------------------------------

/// The structural revision a *new* local command must expect, given queued operations.
///
/// Confirmed state is the server's truth; queued operations are the user's intent. A
/// confirmed tombstone (or no confirmed row at all) means the Classification does not
/// exist, so a queued create starts the expectation at 1 rather than reusing a
/// tombstone's revision. Each later structural operation on the same Classification
/// increments it, so an offline `create -> rename -> move` composes correct
/// `expectedRevision` values before any response arrives.
pub(super) fn predicted_classification_revision(
    connection: &Connection,
    classification_id: &str,
) -> Result<i64, LibraryError> {
    let confirmed = read_classification_revision(connection, classification_id)?;
    let mut revision = match confirmed {
        // A confirmed tombstone means the Classification does not exist, so a queued
        // create starts from 1 instead of reusing the tombstone's revision.
        Some((_, true)) | None => 0,
        Some((revision, false)) => revision,
    };
    let mut statement = connection.prepare(
        "SELECT command_type FROM classification_authority_outbox
         WHERE classification_id = ?1 AND command_type <> ?2 ORDER BY seq",
    )?;
    let commands = statement
        .query_map(params![classification_id, ASSIGNMENT], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for command in commands {
        match command.as_str() {
            CREATE => revision = 1,
            RENAME | MOVE | APPEARANCE | DELETE => revision += 1,
            _ => {}
        }
    }
    Ok(revision.max(1))
}

/// The assignment revision a new local assignment command must expect.
///
/// Assignment is its own lineage, so it is predicted only from confirmed assignment
/// state and queued assignment commands for the same Asset — never from a
/// Classification entity revision, which a compare-and-set on this lineage could not
/// satisfy. No confirmed row means revision 0, which is exactly the value the server
/// reports for an Asset whose assignment it has never seen.
///
/// A queued structural **delete** can also increment this lineage on the server, for
/// every Asset that still names the deleted Classification. That transition is
/// deliberately *not* reconstructed here: predicting it would mean inferring the
/// server's whole materialized assignment set from local state, and a wrong guess
/// would present a fabricated expectation. Strict FIFO means the delete reaches the
/// server first, and the resulting assignment `revisionConflict` is automatically
/// rebased through the desired-state rule in [`flush_outbox`].
pub(super) fn predicted_assignment_revision(
    connection: &Connection,
    asset_id: &str,
) -> Result<i64, LibraryError> {
    let mut revision = read_assignment_revision(connection, asset_id)?
        .map(|(_, revision)| revision)
        .unwrap_or(0);
    let queued: i64 = connection.query_row(
        "SELECT COUNT(*) FROM classification_authority_outbox
         WHERE command_type = ?1 AND asset_id = ?2",
        params![ASSIGNMENT, asset_id],
        |row| row.get(0),
    )?;
    // Every queued assignment intent for one Asset is a real state change (an
    // already-matching desired value is never enqueued), and the server increments the
    // lineage once per accepted change, so each one consumes exactly one revision.
    revision += queued;
    Ok(revision)
}

// ---------------------------------------------------------------------------
// Enqueue (local mutation path only)
// ---------------------------------------------------------------------------

/// Append one durable intent inside the caller's transaction.
///
/// The payload is built and serialized here, once: re-serializing at send time could
/// let a representation change between attempts turn one logical operation into two,
/// and the stored bytes are what a retry presents identically.
fn enqueue_intent(
    transaction: &Connection,
    authority: &ClassificationAuthority,
    command_type: &str,
    classification_id: Option<&str>,
    asset_id: Option<&str>,
    fields: serde_json::Map<String, serde_json::Value>,
    created_at: &str,
) -> Result<(), LibraryError> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let mut body = fields;
    body.insert("libraryId".into(), authority.library_id.clone().into());
    body.insert("epoch".into(), authority.epoch.into());
    body.insert("contractVersion".into(), CLASSIFICATION_CONTRACT_VERSION.into());
    body.insert("operationId".into(), operation_id.clone().into());
    body.insert("commandType".into(), command_type.into());
    if let Some(classification_id) = classification_id {
        body.insert("classificationId".into(), classification_id.into());
    }
    if let Some(asset_id) = asset_id {
        body.insert("assetId".into(), asset_id.into());
    }
    let encoded = serde_json::to_string(&serde_json::Value::Object(body))
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
    transaction.execute(
        "INSERT INTO classification_authority_outbox
            (operation_id, command_type, classification_id, asset_id, epoch, payload, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
        params![
            operation_id,
            command_type,
            classification_id,
            asset_id,
            authority.epoch,
            encoded,
            created_at
        ],
    )?;
    Ok(())
}

impl Library {
    /// Enqueue a local Classification structural intent in the caller's transaction.
    ///
    /// Called only from the local mutation path, so a remote apply cannot manufacture
    /// outgoing work. `fields` carries the command's own keys; the envelope, the
    /// operation id and the command name are added here so a caller cannot forget one.
    /// When no authority is adopted this appends nothing, which is what keeps every
    /// pre-adoption Classification path byte-identical.
    pub(super) fn enqueue_classification_intent(
        transaction: &Connection,
        command_type: &str,
        classification_id: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), LibraryError> {
        let Some(authority) = read_authority(transaction)? else {
            return Ok(());
        };
        enqueue_intent(
            transaction,
            &authority,
            command_type,
            Some(classification_id),
            None,
            fields,
            &chrono::Utc::now().to_rfc3339(),
        )
    }

    /// Enqueue one local assignment intent, using the assignment revision lineage.
    ///
    /// One row per changed Asset, because the server's command is keyed by the Asset
    /// and this payload could not describe several compare-and-set lineages at once.
    pub(super) fn enqueue_classification_assignment_intent(
        transaction: &Connection,
        asset_id: &str,
        classification_id: Option<&str>,
    ) -> Result<(), LibraryError> {
        let Some(authority) = read_authority(transaction)? else {
            return Ok(());
        };
        let expected = predicted_assignment_revision(transaction, asset_id)?;
        let mut fields = serde_json::Map::new();
        fields.insert(
            "classificationId".into(),
            match classification_id {
                Some(classification_id) => classification_id.into(),
                None => serde_json::Value::Null,
            },
        );
        fields.insert("expectedRevision".into(), expected.into());
        enqueue_intent(
            transaction,
            &authority,
            ASSIGNMENT,
            None,
            Some(asset_id),
            fields,
            &chrono::Utc::now().to_rfc3339(),
        )
    }

    /// Whether this library has adopted the Classification authority locally.
    ///
    /// The durable identity row is the adoption marker, so this is the same proof the
    /// restore guard and the receive half use. It exists as its own accessor because the
    /// legacy publication lane must consult it without asking the server, and because
    /// the local mutation path consults it inside its own transaction.
    pub(crate) fn classification_authority_adopted(&self) -> Result<bool, LibraryError> {
        let connection = self.connection()?;
        Ok(read_authority(&connection)?.is_some())
    }

    /// Typed Classification sync/delivery status.
    pub(crate) fn classification_sync_status(&self) -> Result<ClassificationSyncStatus, LibraryError> {
        let connection = self.connection()?;
        let authority = read_authority(&connection)?;
        let (pending, blocked) = outbox_counts(&connection)?;
        let oldest = connection
            .query_row(
                "SELECT operation_id FROM classification_authority_outbox
                 WHERE state = 'pending' ORDER BY seq LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(ClassificationSyncStatus {
            adopted: authority.is_some(),
            library_id: authority.as_ref().map(|value| value.library_id.clone()),
            epoch: authority.as_ref().map(|value| value.epoch),
            contract_version: authority.as_ref().map(|value| value.contract_version),
            cursor: authority.as_ref().map(|value| value.cursor),
            pending_count: pending,
            blocked_count: blocked,
            oldest_pending_operation_id: oldest,
        })
    }
}

/// The role binding this PC has adopted, or `None` before adoption.
///
/// Roles are not stored in a new table: `classification_roles` (migration 0060) is the
/// existing product table and already *is* the local materialization of the immutable
/// role. A second copy would be a second source of truth for the same authority state.
pub(super) fn read_role(
    connection: &Connection,
    role: &str,
) -> Result<Option<String>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT classification_id FROM classification_roles WHERE role = ?1",
            [role],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn write_role(
    transaction: &Transaction<'_>,
    role: &str,
    classification_id: &str,
) -> Result<(), LibraryError> {
    // `classification_id` is `UNIQUE` across roles, so a role that moved to a different
    // Classification must not leave the old binding behind: clearing first keeps the
    // table's own constraint satisfied while the row is replaced.
    transaction.execute("DELETE FROM classification_roles WHERE role = ?1", [role])?;
    transaction.execute(
        "INSERT INTO classification_roles (role, classification_id) VALUES (?1, ?2)",
        params![role, classification_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

impl Library {
    /// Send pending Classification intents to the authority, oldest first.
    ///
    /// Transport or authorization failures propagate as their typed state and leave this
    /// intent and every intent behind it durable and pending, because the pass stops at
    /// the first unresolved row.
    pub fn flush_classification_outbox(&self) -> Result<ClassificationOutboxFlush, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let client = CloudClient::new(endpoint)?;
        // Neither secret is resolved here. Every credential is obtained through the
        // source, and only when a command of that class is actually sent — so this
        // function performs no credential IO of its own. See [`CredentialSource`].
        self.flush_classification_outbox_with_source(&client, &OsCredentials)
    }

    /// The send pass against an explicit credential source.
    pub(crate) fn flush_classification_outbox_with_source(
        &self,
        client: &CloudClient,
        credentials: &dyn CredentialSource,
    ) -> Result<ClassificationOutboxFlush, LibraryError> {
        // Every Classification delivery entry point funnels through here, so the domain's
        // single-flight gate covers all of them — the mutation kick, the periodic sync hook and
        // the focus/online events alike. See [`Library::flush_outbox_single_flight`].
        self.flush_outbox_single_flight(&self.classification_flush_lock, || {
            flush_outbox(
                self,
                client,
                credentials,
                &chrono::Utc::now().to_rfc3339(),
            )
        })
    }

    /// The send pass against explicitly supplied credentials.
    ///
    /// Both tokens are supplied so an HTTP fixture can prove the credential split: a
    /// structural command presents the publisher token, an assignment presents the client
    /// token, and neither substitutes for the other.
    pub(crate) fn flush_classification_outbox_with_credentials(
        &self,
        client: &CloudClient,
        client_token: &str,
        publisher_token: &str,
    ) -> Result<ClassificationOutboxFlush, LibraryError> {
        self.flush_classification_outbox_with_source(
            client,
            &FixedCredentials {
                client_token,
                publisher_token,
            },
        )
    }

}

/// Where a flush pass obtains the two credentials the server's role split requires.
///
/// This is a seam, not an abstraction for its own sake. The credentials live in the OS
/// store, which a unit test cannot configure, so the *policy* — which command class reads
/// which secret, and when — would otherwise be untestable precisely where it matters. The
/// production implementation is [`OsCredentials`]; tests supply a recording double.
///
/// # Why resolution is lazy
///
/// An assignment is an ordinary client operation, so a queue holding only assignment
/// intents must be deliverable with the client credential alone. Reading the publisher
/// secret up front would make an ordinary personal organization action fail outright
/// whenever that secret is unset — the normal state for a user who has never published a
/// catalog — and would report it as a credential problem the user cannot act on.
///
/// The decision is also **per row**, not once per pass: the pass continues past accepted
/// assignment rows, so a structural command further down the queue must resolve its own
/// credential at the moment it is actually sent.
pub(super) trait CredentialSource {
    /// The credential for an ordinary client operation (`setAssetClassification`).
    fn client(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError>;
    /// The credential for a structural command, which the server requires the publisher
    /// role for. Called only when such a command is actually sent.
    fn publisher(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError>;
}

/// The production credential source: the OS credential store.
pub(super) struct OsCredentials;

impl CredentialSource for OsCredentials {
    fn client(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError> {
        Ok(std::borrow::Cow::Owned(credential::read_cloud_api_token_os()?.expose().to_owned()))
    }

    fn publisher(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError> {
        Ok(std::borrow::Cow::Owned(
            credential::read_cloud_publisher_token_os()?.expose().to_owned(),
        ))
    }
}

/// A credential source with both tokens supplied by the caller, for HTTP fixtures.
pub(super) struct FixedCredentials<'a> {
    pub client_token: &'a str,
    pub publisher_token: &'a str,
}

impl CredentialSource for FixedCredentials<'_> {
    fn client(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError> {
        Ok(std::borrow::Cow::Borrowed(self.client_token))
    }

    fn publisher(&self) -> Result<std::borrow::Cow<'_, str>, LibraryError> {
        Ok(std::borrow::Cow::Borrowed(self.publisher_token))
    }
}

/// Send pending Classification intents oldest-first, stopping at the first unresolved one.
///
/// Stopping is the point. Classification commands are ordered and dependent, so sending
/// around a blocked or unresolved intent could apply a rename before its create, or let
/// a later assignment present a revision the queue ahead of it owns. A retry of one
/// logical operation always presents the same operation id and the same stored bytes.
pub(super) fn flush_outbox(
    library: &Library,
    client: &CloudClient,
    credentials: &dyn CredentialSource,
    now: &str,
) -> Result<ClassificationOutboxFlush, LibraryError> {
    let mut report = ClassificationOutboxFlush::default();
    // The lock is released between reads: `Library::connection()` takes a non-reentrant
    // mutex, so holding one guard across another would deadlock.
    let entries = {
        let connection = library.connection()?;
        read_outbox(&connection)?
    };
    // The queue is read once: this pass sends at most one intent per row it already
    // holds, and a concurrent mutation blocks on the same database lock.
    report.pending = u32::try_from(entries.iter().filter(|entry| entry.state == "pending").count())
        .unwrap_or(u32::MAX);
    report.blocked =
        u32::try_from(entries.iter().filter(|entry| entry.is_blocked()).count()).unwrap_or(u32::MAX);
    if entries.is_empty() {
        return Ok(report);
    }
    let authority = {
        let connection = library.connection()?;
        read_authority(&connection)?
    };
    let Some(authority) = authority else {
        // An adopted authority is the only way a local mutation appends a row, so
        // queued intents without one is an inconsistent database rather than
        // "nothing to send".
        return Err(LibraryError::ClassificationAuthorityInactive);
    };
    for entry in entries {
        if entry.is_blocked() {
            // An unresolved structural conflict stops delivery: a later operation may
            // depend on this one, and receiving over the optimistic state would hide it.
            report.stopped = true;
            return Ok(report);
        }
        if entry.epoch != authority.epoch {
            // Revisions are only comparable inside one epoch, so an intent composed
            // under another epoch cannot present a meaningful expectation. It is blocked
            // rather than silently re-pointed, because guessing a cross-epoch mapping is
            // exactly the implicit rebase this domain forbids.
            block_entry(library, entry.seq, "epochMismatch", serde_json::Value::Null, now)?;
            report.blocked += 1;
            report.pending -= 1;
            report.stopped = true;
            return Ok(report);
        }
        // The stored payload is the only thing sent. A payload this build cannot read
        // back is not a command it may re-encode, because a re-encoded body would no
        // longer be provably the accepted intent's own bytes.
        if !entry.payload.is_object() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // The credential is chosen per row at send time, not once for the pass. An
        // assignment is an ordinary client operation, so a queue that only holds
        // assignments never touches the publisher secret; and because the pass continues
        // past accepted rows, a structural command further down the queue resolves its own
        // credential exactly when it is sent.
        let token = if entry.is_assignment() {
            credentials.client()?
        } else {
            credentials.publisher()?
        };
        match client.classification_command(&entry.payload, token.as_ref())? {
            ClassificationCommandOutcome::Accepted(result) => {
                confirm(library, &entry, &result, now)?;
                report.pending -= 1;
                if result.changed {
                    report.sent += 1;
                } else {
                    report.no_op += 1;
                }
            }
            ClassificationCommandOutcome::Dropped => {
                // The Asset is tombstoned: the intent can never apply, so it is retired
                // instead of blocking the queue.
                library.connection()?.execute(
                    "DELETE FROM classification_authority_outbox WHERE operation_id = ?1",
                    [&entry.operation_id],
                )?;
                report.pending -= 1;
                report.no_op += 1;
            }
            ClassificationCommandOutcome::Conflict(conflict) => {
                if entry.is_assignment() && conflict.code == REVISION_CONFLICT {
                    // A desired-state scalar may be rebased when preserving the same
                    // user intent is unambiguous. The conflict was never accepted or
                    // receipted, so rewriting **only** the pending payload's
                    // `expectedRevision` keeps one logical intent rather than creating a
                    // second. Stopping the pass makes the retry a separate, simple step:
                    // the rebased row is re-read and sent on the next pass.
                    rebase_assignment(library, &entry, &conflict.detail, now)?;
                    report.rebased += 1;
                    report.stopped = true;
                    return Ok(report);
                }
                // A structural rejection — and any assignment code that is not a
                // rebasable revision conflict — preserves the intent for a user
                // decision instead of silently selecting a winner.
                block_entry(library, entry.seq, &conflict.code, conflict.detail, now)?;
                report.blocked += 1;
                report.pending -= 1;
                report.stopped = true;
                return Ok(report);
            }
        }
    }
    Ok(report)
}

/// Record one accepted operation and retire its intent in a single transaction.
///
/// The visible local materialization is deliberately *not* rewritten here. It may
/// already include later optimistic operations, and the following receive pass replays
/// the full ordered server log to converge it. Only confirmed revision state is
/// updated, so the caches keep describing the server rather than the queue. The local
/// change cursor is likewise untouched: cursor advancement belongs to `/changes` replay.
fn confirm(
    library: &Library,
    entry: &ClassificationOutboxEntry,
    result: &crate::cloud::client::ClassificationCommandResult,
    now: &str,
) -> Result<(), LibraryError> {
    let mut connection = library.connection()?;
    let transaction = connection.transaction()?;
    if let Some(classification) = &result.classification {
        write_classification_revision(
            &transaction,
            &classification.id,
            classification.entity_revision,
            classification.deleted,
            now,
        )?;
    }
    for assignment in &result.assignments {
        // Revision 0 is the authority's own representation of "this Asset has no
        // assignment row and its desired state is unassigned", which this table already
        // expresses by *absence*. Writing a row would turn authoritative unassigned
        // revision 0 into the distinct state "unassigned at revision 0", which cannot be
        // compared against anything. A real revision 1+ is recorded as reported.
        if assignment.entity_revision == 0 {
            continue;
        }
        write_assignment_revision(
            &transaction,
            &assignment.asset_id,
            assignment.classification_id.as_deref(),
            assignment.entity_revision,
            now,
        )?;
    }
    // A delete's aggregate reassignment is part of the confirmed result, so the cache must
    // move with it. Without this the cache keeps naming a Classification the authority has
    // already deleted, which is the conflation this domain must not have: the row would
    // describe neither the state at the cursor nor the state the accepted command produced.
    // The deferred-assignment projection then reads that stale name and refuses the very
    // change that would have corrected it, so the domain stops converging.
    //
    // Only the *cache* moves here. The visible projection is deliberately left alone: it may
    // already include later optimistic operations, and receive replays the ordered log to
    // converge it when the queue is clean.
    //
    // The number moved is recorded durably, because the change that carries the same
    // transition must later be able to tell "I already did part of this" from "this replica
    // is missing lineages". The tombstone cannot answer that: the replay writes it itself.
    if let Some(transition) = &result.assignment_transition {
        let moved = move_assignments_naming(
            &transaction,
            &transition.from_classification_id,
            transition.to_classification_id.as_deref(),
            now,
        )?;
        // Only a *changed* delete has a change sequence to replay, so only it needs a record:
        // an accepted no-op has nothing to account for and nothing to order. A changed delete
        // records its header even when `before` is empty — recognition of the confirmed
        // ordering is exactly what makes an earlier assignment to the deleted node legal.
        if let Some(change_sequence) = result.change_sequence.filter(|_| result.changed) {
            record_preapplied_delete(
                &transaction,
                &entry.operation_id,
                entry.epoch,
                change_sequence,
                transition,
                transition.affects_assignments,
                i64::try_from(moved).map_err(|_| LibraryError::InvalidCloudResponse)?,
                now,
            )?;
        }
    }
    // The intent is finished either way: an accepted no-op means the authority already
    // held the desired state, so there is nothing left to deliver.
    transaction.execute(
        "DELETE FROM classification_authority_outbox WHERE operation_id = ?1",
        [&entry.operation_id],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Rewrite one pending assignment intent's expectation onto the authority's current one.
///
/// This is the only automatic rebase in the domain, and it is legal precisely because an
/// assignment is a desired-state scalar: the user's intent is the desired Classification,
/// which is unchanged, and the rejected attempt was never accepted or receipted. Every
/// other field is preserved — same operation id, same command type, same Asset, same
/// epoch, same desired value — so the retry is the *same logical intent* presented
/// against the revision the authority actually holds.
///
/// This is what makes `delete Classification C` followed by `set Asset A -> X` safe: the
/// delete increments assignment lineages server-side for every Asset naming C, so an
/// assignment composed against the pre-delete revision conflicts once, rebases, and then
/// succeeds. The delete outbox row does not try to predict those increments.
fn rebase_assignment(
    library: &Library,
    entry: &ClassificationOutboxEntry,
    detail: &serde_json::Value,
    now: &str,
) -> Result<(), LibraryError> {
    let current = detail
        .get("current")
        .ok_or(LibraryError::InvalidCloudResponse)?;
    // The rebase is only meaningful against the *same* Asset this intent targets.
    // A conflict body describing another Asset would mean the response does not belong
    // to this command, so rebasing onto it would rewrite a correct expectation with a
    // foreign revision.
    if current.get("assetId").and_then(|value| value.as_str()) != entry.asset_id.as_deref() {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let revision = current
        .get("entityRevision")
        .and_then(|value| value.as_i64())
        .filter(|revision| *revision >= 0)
        .ok_or(LibraryError::InvalidCloudResponse)?;
    let mut payload = entry.payload.clone();
    let body = payload
        .as_object_mut()
        .ok_or(LibraryError::InvalidCloudResponse)?;
    body.insert("expectedRevision".into(), revision.into());
    let encoded =
        serde_json::to_string(&payload).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let connection = library.connection()?;
    connection.execute(
        "UPDATE classification_authority_outbox SET payload = ?2 WHERE operation_id = ?1",
        params![entry.operation_id, encoded],
    )?;
    let _ = now;
    Ok(())
}

/// Record what the authority said a confirmed delete did, for its own later replay.
///
/// This is the durable half of the transition accounting. The change that later carries the
/// same transition cannot infer its pre-applied work from the tombstone — the replay writes
/// the tombstone in the same iteration — so what this PC learned when it accepted the command
/// is remembered here instead, keyed by the operation id the change itself names.
///
/// The recorded count is the authority's own `affectsAssignments`, not a local recount: it is
/// the number the authority used when it ran the transition, so a later page claiming a
/// different number is falsifiable against durable state instead of against a value this PC
/// could have recomputed wrongly.
///
/// A row is written even when the transition moved nothing locally, because replay also needs
/// to recognise a delete this PC already confirmed at a specific sequence in order to accept an
/// earlier assignment naming the deleted Classification. A change the authority ordered before
/// that delete is historical, not impossible, and only this row can say so.
fn record_preapplied_delete(
    transaction: &Transaction<'_>,
    operation_id: &str,
    epoch: i64,
    change_sequence: i64,
    transition: &crate::cloud::client::ClassificationAssignmentTransition,
    affects_assignments: i64,
    preapplied_moved: i64,
    now: &str,
) -> Result<(), LibraryError> {
    if change_sequence < 1 || affects_assignments < 0 || preapplied_moved < 0 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    transaction.execute(
        "INSERT INTO classification_authority_preapplied_deletes
            (operation_id, epoch, change_sequence, from_classification_id,
             to_classification_id, affects_assignments, preapplied_moved, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(operation_id, epoch) DO UPDATE SET
             change_sequence = excluded.change_sequence,
             from_classification_id = excluded.from_classification_id,
             to_classification_id = excluded.to_classification_id,
             affects_assignments = excluded.affects_assignments,
             preapplied_moved = excluded.preapplied_moved,
             created_at = excluded.created_at",
        params![
            operation_id,
            epoch,
            change_sequence,
            transition.from_classification_id,
            transition.to_classification_id,
            affects_assignments,
            preapplied_moved,
            now
        ],
    )?;
    Ok(())
}

/// What a confirmed delete durably recorded about itself, for its own later replay.
///
/// The endpoints are validated inside [`read_preapplied_delete`] against the incoming
/// transition, so only the ordering and the authority's own count survive to the caller.
pub(super) struct PreappliedDelete {
    /// The sequence the authority assigned the delete, which orders it against the log.
    pub(super) change_sequence: i64,
    /// The `affectsAssignments` the authority reported in the accepted result.
    pub(super) affects_assignments: i64,
    /// How many lineages the pre-application itself moved.
    pub(super) preapplied_moved: i64,
}

/// The durable pre-application for a delete the change log is about to replay.
///
/// Returns `None` when no header matches, which is the correct reading for every delete this
/// PC did not itself confirm: nothing was applied ahead of the change, so the whole transition
/// is still outstanding.
///
/// The header must describe *this* delete, so the operation id, the epoch and the transition's
/// own endpoints all have to agree. The operation id alone is not enough: an epoch
/// re-activation could otherwise let a row from the previous authority be matched by a new
/// change that happened to reuse an id, and a row moved across identities would excuse a
/// transition the replica never applied.
pub(super) fn read_preapplied_delete(
    transaction: &Transaction<'_>,
    operation_id: &str,
    epoch: i64,
    transition: &crate::cloud::client::ClassificationAssignmentTransition,
) -> Result<Option<PreappliedDelete>, LibraryError> {
    let row = transaction
        .query_row(
            "SELECT change_sequence, from_classification_id, to_classification_id
             FROM classification_authority_preapplied_deletes
             WHERE operation_id = ?1 AND epoch = ?2",
            params![operation_id, epoch],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let Some((change_sequence, from, to)) = row else {
        return Ok(None);
    };
    if from != transition.from_classification_id || to != transition.to_classification_id {
        // A header for a different Classification cannot describe this transition. Refusing
        // is the fail-closed reading: treating it as "no header" would under-count the
        // pre-applied work and then fail the count check anyway, with a less clear reason.
        return Err(LibraryError::InvalidCloudResponse);
    }
    if change_sequence < 1 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let (affects_assignments, preapplied_moved): (i64, i64) = transaction.query_row(
        "SELECT affects_assignments, preapplied_moved
         FROM classification_authority_preapplied_deletes
         WHERE operation_id = ?1 AND epoch = ?2",
        params![operation_id, epoch],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if affects_assignments < 0 || preapplied_moved < 0 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(Some(PreappliedDelete {
        change_sequence,
        affects_assignments,
        preapplied_moved,
    }))
}

/// Whether some confirmed delete already removed `classification_id` before `sequence`.
///
/// This is the evidence that makes an assignment naming a deleted Classification legitimate
/// rather than corrupt. The server moves every naming lineage away atomically with the delete
/// and validates every assignment target, so it can never emit an assignment to an
/// already-deleted node *after* that delete. Only an assignment the authority ordered
/// *earlier* — which this replica has simply not replayed yet — can legitimately name it, and
/// a header with a greater sequence is exactly what proves that ordering.
///
/// A tombstone alone is deliberately not accepted as the evidence: the replay writes the
/// tombstone itself, so trusting it would make the check unfalsifiable.
///
/// `sequence` is `None` for a projection that makes no ordering claim (deferred
/// materialization, a baseline install). Any header naming the Classification then counts,
/// which is the narrowest reading available without an ordering.
pub(super) fn preapplied_delete_covers(
    transaction: &Transaction<'_>,
    epoch: i64,
    classification_id: &str,
    sequence: Option<i64>,
) -> Result<bool, LibraryError> {
    let covered: bool = transaction.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM classification_authority_preapplied_deletes
             WHERE epoch = ?1 AND from_classification_id = ?2
               AND (?3 IS NULL OR change_sequence > ?3))",
        params![epoch, classification_id, sequence],
        |row| row.get(0),
    )?;
    Ok(covered)
}

/// Retire a pre-application once its change has been replayed.
///
/// The change is now behind the cursor, so it can never be replayed again; keeping the row
/// would only risk matching a later change that reused the id.
pub(super) fn retire_preapplied_delete(
    transaction: &Transaction<'_>,
    operation_id: &str,
    epoch: i64,
) -> Result<(), LibraryError> {
    transaction.execute(
        "DELETE FROM classification_authority_preapplied_deletes
         WHERE operation_id = ?1 AND epoch = ?2",
        params![operation_id, epoch],
    )?;
    Ok(())
}

/// Move every cached assignment naming `from` to `to`, incrementing each revision by one.
///
/// This is the confirmed-cache counterpart of the server's own delete transition, which is
/// exactly one `UPDATE ... SET classification_id = ?, entity_revision = entity_revision + 1
/// WHERE classification_id = from`. Reproducing the same predicate and the same increment is
/// what keeps the cache equal to the authority's post-delete lineage, so replaying the same
/// change later is a no-op rather than a contradiction.
///
/// It is intentionally *not* a re-derivation from `asset_classifications`: the authority holds
/// assignments for Assets this PC has not materialized, and their lineages must move too.
pub(super) fn move_assignments_naming(
    transaction: &Transaction<'_>,
    from: &str,
    to: Option<&str>,
    now: &str,
) -> Result<usize, LibraryError> {
    let moved = transaction.execute(
        "UPDATE classification_authority_assignment_revisions
         SET classification_id = ?2, entity_revision = entity_revision + 1, updated_at = ?3
         WHERE classification_id = ?1",
        params![from, to, now],
    )?;
    Ok(moved)
}

/// Preserve an intent the authority rejected on structural grounds.
///
/// The row keeps its payload and operation id, and the optimistic local effect stays
/// visible. Structural conflicts are never rebased automatically: choosing a winner for
/// a hierarchy edit is a user decision, and the conflict-resolution UI is a later batch.
/// What matters now is that the conflict is durable and observable, so no other writer
/// can be enabled on top of it.
pub(super) fn block_entry(
    library: &Library,
    seq: i64,
    code: &str,
    detail: serde_json::Value,
    now: &str,
) -> Result<(), LibraryError> {
    let encoded = if detail.is_null() {
        None
    } else {
        Some(serde_json::to_string(&detail).map_err(|_| LibraryError::InvalidCloudResponse)?)
    };
    let connection = library.connection()?;
    connection.execute(
        "UPDATE classification_authority_outbox
         SET state = 'blocked', conflict_code = ?2, conflict_detail = ?3
         WHERE seq = ?1",
        params![seq, code, encoded],
    )?;
    let _ = now;
    Ok(())
}

#[cfg(test)]
impl super::Library {
    /// Test seam: write the adoption row exactly as a completed baseline adoption does.
    pub(crate) fn adopt_classification_authority_for_test(
        &self,
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
    ) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        write_authority(
            &transaction,
            &ClassificationAuthority {
                library_id: library_id.to_owned(),
                epoch,
                contract_version,
                cursor,
            },
            &now,
        )?;
        transaction.commit()?;
        Ok(())
    }
}
