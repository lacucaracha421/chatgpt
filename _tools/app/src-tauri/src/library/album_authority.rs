//! Album authority on the PC: durable state, a transactional outbox and the flush.
//!
//! The receive half lives in [`super::album_reconciliation`]. This module owns what
//! the PC *knows* and what it *intends*:
//!
//! * `album_authority_sync` — the adopted authority identity, cursor and epoch;
//! * `album_authority_revisions` — confirmed Album entity revisions and tombstones;
//! * `album_authority_membership_revisions` — confirmed membership revisions,
//!   including removed relations;
//! * `album_authority_outbox` — durable outgoing intents in strict FIFO order.
//!
//! # Confirmed versus pending
//!
//! The revision caches record what the *server* confirmed. The local `albums` and
//! `asset_albums` tables hold the materialized view, which is legitimately ahead of
//! confirmed state while optimistic operations are queued. Speculative revisions live
//! only inside queued payloads, never in the caches, so a later command can always
//! tell the server's truth from the user's intent.
//!
//! # Nothing is coalesced
//!
//! Bookmarks keep one intent per entity, because the newest desired state is the
//! whole meaning of a toggle. Album operations are ordered and dependent:
//! `create A -> rename A -> move A` must reach the server in that order, so the
//! outbox is strict FIFO and each accepted mutation appends a row.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::cloud::client::{AlbumCommandOutcome, CloudClient};

use super::error::LibraryError;
use super::Library;

/// The shared domain name the server reports this authority under.
pub(crate) const ALBUM_DOMAIN: &str = "albums";

/// The Album domain contract this build speaks.
pub(crate) const ALBUM_CONTRACT_VERSION: i64 = 1;

/// Command names, matching the server's exactly.
pub(crate) const CREATE: &str = "createAlbum";
pub(crate) const RENAME: &str = "renameAlbum";
pub(crate) const MOVE: &str = "moveAlbum";
pub(crate) const APPEARANCE: &str = "updateAlbumAppearance";
pub(crate) const DELETE: &str = "deleteAlbum";
pub(crate) const MEMBERSHIP: &str = "setAlbumMembership";

/// The server's refusal of a membership whose Asset it does not hold as linkable.
const INVALID_MEMBERSHIP: &str = "invalidAlbumMembership";

/// The adopted Album authority, or `None` while the domain is still PC-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AlbumAuthority {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub cursor: i64,
}

/// One durable outgoing Album intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AlbumOutboxEntry {
    pub seq: i64,
    pub operation_id: String,
    pub command_type: String,
    pub album_id: String,
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

impl AlbumOutboxEntry {
    pub(crate) fn is_blocked(&self) -> bool {
        self.state == "blocked"
    }
}

/// Typed Album sync/delivery status for the UI and for later conflict work.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSyncStatus {
    pub adopted: bool,
    pub library_id: Option<String>,
    pub epoch: Option<i64>,
    pub contract_version: Option<i64>,
    pub cursor: Option<i64>,
    pub pending_count: u32,
    pub blocked_count: u32,
    /// Pending membership intents waiting for their Asset's upload to commit.
    pub waiting_count: u32,
    /// Intents retired without delivery since this library began recording them.
    pub dropped_count: u32,
    pub last_drop_reason: Option<String>,
    pub oldest_pending_operation_id: Option<String>,
}

/// Outcome of one Album outbox flush pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumOutboxFlush {
    pub sent: u32,
    pub no_op: u32,
    pub blocked: u32,
    pub pending: u32,
    /// Membership intents left pending because their Asset's upload has not committed.
    /// They neither stop the pass nor defer receive.
    pub waiting: u32,
    /// Intents retired without delivery (see [`record_dropped_intents`]).
    pub dropped: u32,
    pub stopped: bool,
}

// ---------------------------------------------------------------------------
// Asset-subject intents that wait for Asset replication
// ---------------------------------------------------------------------------
//
// Album membership and Classification assignment intents name an Asset. A locally
// ingested Asset exists on the server only after its replication upload commits, and the
// server refuses to *add* a relation to an Asset it has not committed. Such an intent is
// not a conflict: it waits for the upload without holding up intents for other Assets
// and without stopping receive. The rules are shared by both domains so they cannot
// drift apart.

/// Drop reason: the Asset row no longer exists locally (purged or deleted).
pub(super) const DROP_ASSET_DELETED: &str = "assetDeleted";
/// Drop reason: the Asset went to the trash before its upload ever committed.
pub(super) const DROP_ASSET_TRASHED_BEFORE_UPLOAD: &str = "assetTrashedBeforeUpload";
/// Drop reason: the purge of a never-committed Asset retired its intents.
pub(super) const DROP_ASSET_PURGED: &str = "assetPurged";
/// Drop reason: the server tombstoned the Asset (`assetTombstoned`).
pub(super) const DROP_ASSET_TOMBSTONED: &str = "assetTombstoned";
/// Drop reason: the Album was deleted while the membership waited for its Asset.
pub(super) const DROP_ALBUM_DELETED: &str = "albumDeleted";

/// What the send half may do with an Asset-subject intent right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AssetIntentReadiness {
    /// The server has the Asset, or nothing local says it does not: send.
    Send,
    /// The Asset's upload is still outstanding: keep the intent, skip it this pass.
    Wait,
    /// The intent can never apply; retire it with this reason.
    Drop(&'static str),
}

/// Whether the server is known to hold this Asset: its replication upload committed, or
/// the Asset authority reported it. Either is written only after the server committed.
const ASSET_COMMITTED_SQL: &str = "(EXISTS(SELECT 1 FROM cloud_sync_queue q
        WHERE q.entity_type = 'asset' AND q.entity_id = {asset} AND q.operation = 'upsert'
          AND q.status = 'synced')
     OR EXISTS(SELECT 1 FROM asset_authority_state s WHERE s.asset_id = {asset}))";

/// SQL predicate: the Asset named by `column` is waiting for its upload to commit.
///
/// Mirrors [`asset_intent_readiness`] returning [`AssetIntentReadiness::Wait`]: the Asset
/// exists locally and is not in the trash, the server is not known to hold it, and an
/// upload is still queued (pending, in flight or failed — a failed upload can still be
/// retried by the user). An Asset with no upload row at all is *not* waiting: nothing
/// local says the server lacks it, so its intents are sent as before.
pub(super) fn asset_waiting_sql(column: &str) -> String {
    format!(
        "(EXISTS(SELECT 1 FROM assets w WHERE w.id = {column} AND w.status <> 'trash')
          AND NOT {committed}
          AND EXISTS(SELECT 1 FROM cloud_sync_queue u
              WHERE u.entity_type = 'asset' AND u.entity_id = {column}
                AND u.operation = 'upsert' AND u.status <> 'synced'))",
        committed = ASSET_COMMITTED_SQL.replace("{asset}", column),
    )
}

/// Decide whether an intent naming `asset_id` may be sent now.
pub(super) fn asset_intent_readiness(
    connection: &Connection,
    asset_id: &str,
) -> Result<AssetIntentReadiness, LibraryError> {
    let status: Option<String> = connection
        .query_row("SELECT status FROM assets WHERE id = ?1", [asset_id], |row| row.get(0))
        .optional()?;
    let Some(status) = status else {
        // Intents are only ever enqueued for a local Asset, so a missing row means it was
        // purged or deleted here. Whatever the server holds, this PC has nothing left to
        // relate, and a tombstoned Asset would be refused anyway.
        return Ok(AssetIntentReadiness::Drop(DROP_ASSET_DELETED));
    };
    let (committed, outstanding): (bool, bool) = connection.query_row(
        &format!(
            "SELECT {committed}, EXISTS(SELECT 1 FROM cloud_sync_queue u
                 WHERE u.entity_type = 'asset' AND u.entity_id = ?1
                   AND u.operation = 'upsert' AND u.status <> 'synced')",
            committed = ASSET_COMMITTED_SQL.replace("{asset}", "?1"),
        ),
        [asset_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if committed || !outstanding {
        return Ok(AssetIntentReadiness::Send);
    }
    if status == "trash" {
        // Replication claims only `normal` Assets, so a trashed never-committed Asset will
        // not reach the server while it stays in the trash.
        return Ok(AssetIntentReadiness::Drop(DROP_ASSET_TRASHED_BEFORE_UPLOAD));
    }
    Ok(AssetIntentReadiness::Wait)
}

/// Readiness decided once per Asset for one whole flush pass.
///
/// The upload lane runs concurrently, so re-reading readiness per entry could let an Asset
/// commit mid-pass: an earlier add would be skipped as waiting while a later remove for the
/// same relation went out, and the next pass would then apply the add over it. Deciding
/// once per Asset per pass keeps all of one Asset's intents either held or sent in order.
#[derive(Default)]
pub(super) struct PassReadiness(std::collections::HashMap<String, AssetIntentReadiness>);

impl PassReadiness {
    /// The pass's decision for this Asset, reading it from the database the first time.
    pub(super) fn get(
        &mut self,
        library: &Library,
        asset_id: Option<&str>,
    ) -> Result<AssetIntentReadiness, LibraryError> {
        let Some(asset_id) = asset_id else {
            return Ok(AssetIntentReadiness::Send);
        };
        if let Some(readiness) = self.0.get(asset_id) {
            return Ok(*readiness);
        }
        let readiness = asset_intent_readiness(&*library.connection()?, asset_id)?;
        self.0.insert(asset_id.to_owned(), readiness);
        Ok(readiness)
    }

    /// Re-read after the server refused an intent for this Asset, and make that the
    /// decision for the rest of the pass.
    pub(super) fn refresh(
        &mut self,
        library: &Library,
        asset_id: Option<&str>,
    ) -> Result<AssetIntentReadiness, LibraryError> {
        if let Some(asset_id) = asset_id {
            self.0.remove(asset_id);
        }
        self.get(library, asset_id)
    }
}

/// Durably count intents retired without delivery, per domain, with the latest reason.
///
/// The row is what a later status surface reads; it survives re-adoption because it is
/// not part of the replica.
pub(super) fn record_dropped_intents(
    connection: &Connection,
    domain: &str,
    count: usize,
    reason: &str,
    operation_id: Option<&str>,
    now: &str,
) -> Result<(), LibraryError> {
    if count == 0 {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO authority_intent_drops
            (domain, dropped_count, last_reason, last_operation_id, last_dropped_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(domain) DO UPDATE SET dropped_count = dropped_count + excluded.dropped_count,
             last_reason = excluded.last_reason, last_operation_id = excluded.last_operation_id,
             last_dropped_at = excluded.last_dropped_at",
        params![domain, i64::try_from(count).unwrap_or(i64::MAX), reason, operation_id, now],
    )?;
    Ok(())
}

/// The durable drop record for one domain: `(count, last reason)`.
pub(super) fn read_dropped_intents(
    connection: &Connection,
    domain: &str,
) -> Result<(u32, Option<String>), LibraryError> {
    Ok(connection
        .query_row(
            "SELECT dropped_count, last_reason FROM authority_intent_drops WHERE domain = ?1",
            [domain],
            |row| {
                Ok((
                    u32::try_from(row.get::<_, i64>(0)?).unwrap_or(u32::MAX),
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?
        .unwrap_or((0, None)))
}

/// Retire every Album membership intent naming one of `asset_ids`, in the caller's
/// transaction, and record the drop. Used when a never-committed Asset is purged.
pub(super) fn drop_album_intents_for_assets(
    connection: &Connection,
    asset_ids: &[String],
    reason: &str,
    now: &str,
) -> Result<(), LibraryError> {
    let mut dropped = 0;
    for asset_id in asset_ids {
        dropped += connection.execute(
            "DELETE FROM album_authority_outbox WHERE command_type = ?1 AND asset_id = ?2",
            params![MEMBERSHIP, asset_id],
        )?;
    }
    record_dropped_intents(connection, ALBUM_DOMAIN, dropped, reason, None, now)
}

/// Whether any Album intent still stands between the replica and a receive.
///
/// Membership intents waiting for their Asset's upload do not count: the server cannot
/// describe that Asset yet, so no received change can overwrite their optimistic effect.
pub(super) fn has_unresolved_intents(connection: &Connection) -> Result<bool, LibraryError> {
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM album_authority_outbox o
                 WHERE NOT (o.state = 'pending' AND o.command_type = '{MEMBERSHIP}'
                            AND {waiting}))",
            waiting = asset_waiting_sql("o.asset_id"),
        ),
        [],
        |row| row.get(0),
    )?)
}

// ---------------------------------------------------------------------------
// Local durable state
// ---------------------------------------------------------------------------

pub(super) fn read_authority(
    connection: &Connection,
) -> Result<Option<AlbumAuthority>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor FROM album_authority_sync WHERE singleton = 1",
            [],
            |row| {
                Ok(AlbumAuthority {
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
    authority: &AlbumAuthority,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO album_authority_sync (singleton, library_id, epoch, contract_version, cursor, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(singleton) DO UPDATE SET library_id = excluded.library_id, epoch = excluded.epoch,
             contract_version = excluded.contract_version, cursor = excluded.cursor, updated_at = excluded.updated_at",
        params![authority.library_id, authority.epoch, authority.contract_version, authority.cursor, now],
    )?;
    Ok(())
}

/// The confirmed Album entity revision and tombstone flag, or `None` when the server
/// has never told this PC about that Album.
pub(super) fn read_album_revision(
    connection: &Connection,
    album_id: &str,
) -> Result<Option<(i64, bool)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT entity_revision, deleted FROM album_authority_revisions WHERE album_id = ?1",
            [album_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()?)
}

pub(super) fn read_membership_revision(
    connection: &Connection,
    album_id: &str,
    asset_id: &str,
) -> Result<Option<(i64, bool)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT entity_revision, desired_state FROM album_authority_membership_revisions
             WHERE album_id = ?1 AND asset_id = ?2",
            params![album_id, asset_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()?)
}

pub(super) fn write_album_revision(
    transaction: &Transaction<'_>,
    album_id: &str,
    revision: i64,
    deleted: bool,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO album_authority_revisions (album_id, entity_revision, deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(album_id) DO UPDATE SET entity_revision = excluded.entity_revision,
             deleted = excluded.deleted, updated_at = excluded.updated_at",
        params![album_id, revision, i64::from(deleted), now],
    )?;
    Ok(())
}

pub(super) fn write_membership_revision(
    transaction: &Transaction<'_>,
    album_id: &str,
    asset_id: &str,
    desired_state: bool,
    revision: i64,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO album_authority_membership_revisions
            (album_id, asset_id, desired_state, entity_revision, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(album_id, asset_id) DO UPDATE SET desired_state = excluded.desired_state,
             entity_revision = excluded.entity_revision, updated_at = excluded.updated_at",
        params![album_id, asset_id, i64::from(desired_state), revision, now],
    )?;
    Ok(())
}

fn decode_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumOutboxEntry> {
    let payload: String = row.get(6)?;
    let conflict: Option<String> = row.get(9)?;
    Ok(AlbumOutboxEntry {
        seq: row.get(0)?,
        operation_id: row.get(1)?,
        command_type: row.get(2)?,
        album_id: row.get(3)?,
        asset_id: row.get(4)?,
        epoch: row.get(5)?,
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        state: row.get(7)?,
        conflict_code: row.get(8)?,
        conflict_detail: conflict.and_then(|value| serde_json::from_str(&value).ok()),
        created_at: row.get(10)?,
    })
}

const OUTBOX_SELECT: &str =
    "SELECT seq, operation_id, command_type, album_id, asset_id, epoch, payload, state,
            conflict_code, conflict_detail, created_at
     FROM album_authority_outbox ORDER BY seq";

pub(super) fn read_outbox(connection: &Connection) -> Result<Vec<AlbumOutboxEntry>, LibraryError> {
    let mut statement = connection.prepare(OUTBOX_SELECT)?;
    let entries = statement
        .query_map([], decode_entry)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries)
}

fn outbox_counts(connection: &Connection) -> Result<(u32, u32), LibraryError> {
    let mut statement = connection.prepare(
        "SELECT state, COUNT(*) FROM album_authority_outbox GROUP BY state",
    )?;
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

/// The revision a *new* local Album command must expect, given queued operations.
///
/// Confirmed state is the server's truth; queued operations are the user's intent. A
/// create makes the Album exist at revision 1 and each later structural operation on
/// the same Album increments that expectation, so a dependent offline command presents
/// the revision the server will report once the queue drains.
pub(super) fn predicted_album_revision(
    connection: &Connection,
    album_id: &str,
) -> Result<i64, LibraryError> {
    let confirmed = read_album_revision(connection, album_id)?;
    let mut revision = match confirmed {
        // A confirmed tombstone means the Album does not exist, so a queued create
        // starts from 1 rather than reusing the tombstone's revision.
        Some((_, true)) | None => 0,
        Some((revision, false)) => revision,
    };
    let mut statement = connection
        .prepare("SELECT command_type FROM album_authority_outbox WHERE album_id = ?1 ORDER BY seq")?;
    let commands = statement
        .query_map([album_id], |row| row.get::<_, String>(0))?
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

/// The membership revision a new local membership command must expect.
///
/// Membership is its own lineage: it is predicted only from confirmed membership state
/// and queued membership commands for the same relation, never from the Album entity
/// revision.
pub(super) fn predicted_membership_revision(
    connection: &Connection,
    album_id: &str,
    asset_id: &str,
) -> Result<i64, LibraryError> {
    let mut revision = read_membership_revision(connection, album_id, asset_id)?
        .map(|(revision, _)| revision)
        .unwrap_or(0);
    let mut statement = connection.prepare(
        "SELECT 1 FROM album_authority_outbox
         WHERE command_type = ?1 AND album_id = ?2 AND asset_id = ?3",
    )?;
    let queued = statement
        .query_map(params![MEMBERSHIP, album_id, asset_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    revision += queued.len() as i64;
    Ok(revision)
}

// ---------------------------------------------------------------------------
// Enqueue (local mutation path only)
// ---------------------------------------------------------------------------

/// Append one durable intent inside the caller's transaction.
///
/// Returns the queue sequence, or `None` when no authority is adopted. The payload is
/// built and serialized here, once: re-serializing at send time could let a
/// representation change between attempts turn one logical operation into two.
fn enqueue_intent(
    transaction: &Transaction<'_>,
    authority: &AlbumAuthority,
    command_type: &str,
    album_id: &str,
    asset_id: Option<&str>,
    fields: serde_json::Map<String, serde_json::Value>,
    created_at: &str,
) -> Result<(), LibraryError> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let mut body = fields;
    body.insert("libraryId".into(), authority.library_id.clone().into());
    body.insert("epoch".into(), authority.epoch.into());
    body.insert("contractVersion".into(), ALBUM_CONTRACT_VERSION.into());
    body.insert("operationId".into(), operation_id.clone().into());
    body.insert("commandType".into(), command_type.into());
    body.insert("albumId".into(), album_id.into());
    let encoded = serde_json::to_string(&serde_json::Value::Object(body))
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
    transaction.execute(
        "INSERT INTO album_authority_outbox
            (operation_id, command_type, album_id, asset_id, epoch, payload, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
        params![operation_id, command_type, album_id, asset_id, authority.epoch, encoded, created_at],
    )?;
    // Wake the coordinated authority pass instead of waiting out its idle backoff.
    super::authority_pass::note_local_work();
    Ok(())
}

impl Library {
    /// Enqueue a local Album structural intent in the caller's transaction.
    ///
    /// Called only from the local mutation path, so a remote apply cannot manufacture
    /// outgoing work. `fields` carries the command's own keys; the envelope, the
    /// operation id and the command name are added here so a caller cannot forget one.
    pub(super) fn enqueue_album_intent(
        transaction: &Transaction<'_>,
        command_type: &str,
        album_id: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), LibraryError> {
        let Some(authority) = read_authority(transaction)? else {
            return Ok(());
        };
        enqueue_intent(
            transaction,
            &authority,
            command_type,
            album_id,
            None,
            fields,
            &chrono::Utc::now().to_rfc3339(),
        )
    }

    /// Enqueue a local membership intent, using the membership revision lineage.
    pub(super) fn enqueue_album_membership_intent(
        transaction: &Transaction<'_>,
        album_id: &str,
        asset_id: &str,
        desired_state: bool,
    ) -> Result<(), LibraryError> {
        let Some(authority) = read_authority(transaction)? else {
            return Ok(());
        };
        let expected = predicted_membership_revision(transaction, album_id, asset_id)?;
        let mut fields = serde_json::Map::new();
        fields.insert("assetId".into(), asset_id.into());
        fields.insert("desiredState".into(), desired_state.into());
        fields.insert("expectedRevision".into(), expected.into());
        enqueue_intent(
            transaction,
            &authority,
            MEMBERSHIP,
            album_id,
            Some(asset_id),
            fields,
            &chrono::Utc::now().to_rfc3339(),
        )
    }

    /// Whether this library has adopted the Album authority locally.
    ///
    /// The durable identity row is the adoption marker, so this is the same proof the
    /// restore guard and the receive half use. It exists as its own accessor because the
    /// legacy Album publication lane must consult it without asking the server.
    pub(crate) fn album_authority_adopted(&self) -> Result<bool, LibraryError> {
        let connection = self.connection()?;
        Ok(read_authority(&connection)?.is_some())
    }

    /// Typed Album sync/delivery status.
    pub(crate) fn album_sync_status(&self) -> Result<AlbumSyncStatus, LibraryError> {
        let connection = self.connection()?;
        let authority = read_authority(&connection)?;
        let (pending, blocked) = outbox_counts(&connection)?;
        let oldest = connection
            .query_row(
                "SELECT operation_id FROM album_authority_outbox WHERE state = 'pending' ORDER BY seq LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let waiting: i64 = connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM album_authority_outbox o
                 WHERE o.state = 'pending' AND o.command_type = '{MEMBERSHIP}' AND {waiting}",
                waiting = asset_waiting_sql("o.asset_id"),
            ),
            [],
            |row| row.get(0),
        )?;
        let (dropped, last_drop_reason) = read_dropped_intents(&connection, ALBUM_DOMAIN)?;
        Ok(AlbumSyncStatus {
            adopted: authority.is_some(),
            library_id: authority.as_ref().map(|value| value.library_id.clone()),
            epoch: authority.as_ref().map(|value| value.epoch),
            contract_version: authority.as_ref().map(|value| value.contract_version),
            cursor: authority.as_ref().map(|value| value.cursor),
            pending_count: pending,
            blocked_count: blocked,
            waiting_count: u32::try_from(waiting).unwrap_or(u32::MAX),
            dropped_count: dropped,
            last_drop_reason,
            oldest_pending_operation_id: oldest,
        })
    }

    /// Send pending Album intents to the authority, oldest first.
    ///
    /// A transport or authorization failure propagates as its typed state and leaves
    /// this intent and every intent behind it durable and pending, because the pass
    /// stops at the first unresolved row.
    pub fn flush_album_outbox(&self) -> Result<AlbumOutboxFlush, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let token = token.expose();
        let client = CloudClient::new(endpoint)?;
        self.flush_album_outbox_with(&client, &token)
    }

    /// The send pass against an already-built client, mirroring
    /// `flush_catalog_bookmark_outbox_with` so the orchestration can run against a real
    /// server without going through credentials.
    pub(crate) fn flush_album_outbox_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<AlbumOutboxFlush, LibraryError> {
        // Every Album delivery entry point funnels through here, so the domain's single-flight
        // gate covers all of them. See [`Library::flush_outbox_single_flight`].
        self.flush_outbox_single_flight(&self.album_flush_lock, || {
            flush_outbox(self, client, token, &chrono::Utc::now().to_rfc3339())
        })
    }
}

// ---------------------------------------------------------------------------
// Flush (Scope F)
// ---------------------------------------------------------------------------

/// Send pending Album intents oldest-first, stopping at the first unresolved one.
///
/// Stopping is the point: a later operation may depend on an earlier one, so sending
/// around a blocked or unresolved intent could apply a rename before its create. A
/// retry of one logical operation always presents the same operation id and the same
/// stored bytes.
///
/// One exception: a membership whose Asset's upload has not committed is skipped (it
/// *waits*) rather than stopping the pass, and one that can never apply is retired with
/// a recorded reason. See [`asset_intent_readiness`]. Every intent for that Asset shares
/// its readiness, so a relation's own intents never overtake each other.
pub(super) fn flush_outbox(
    library: &Library,
    client: &CloudClient,
    token: &str,
    now: &str,
) -> Result<AlbumOutboxFlush, LibraryError> {
    let mut report = AlbumOutboxFlush::default();
    // The lock is released between the two reads: `Library::connection()` takes a
    // non-reentrant mutex, so holding one guard across the other would deadlock.
    let entries = {
        let connection = library.connection()?;
        read_outbox(&connection)?
    };
    // The queue is read once: this pass sends at most one intent per row it already
    // holds, and a concurrent mutation blocks on the same database lock.
    report.pending = u32::try_from(
        entries.iter().filter(|entry| entry.state == "pending").count(),
    )
    .unwrap_or(u32::MAX);
    report.blocked = u32::try_from(
        entries.iter().filter(|entry| entry.is_blocked()).count(),
    )
    .unwrap_or(u32::MAX);
    if entries.is_empty() {
        return Ok(report);
    }
    let authority = {
        let connection = library.connection()?;
        read_authority(&connection)?
    };
    let Some(authority) = authority else {
        // No adopted authority while intents are queued cannot arise from the local
        // mutation path — `enqueue_album_intent` appends nothing without one — so it is
        // an inconsistent database rather than "nothing to send".
        return Err(LibraryError::AlbumAuthorityInactive);
    };
    let mut readiness_by_asset = PassReadiness::default();
    for entry in entries {
        if entry.is_blocked() {
            // An unresolved structural conflict stops delivery: a later operation may
            // depend on this one, and receiving over the optimistic state would hide it.
            report.stopped = true;
            return Ok(report);
        }
        if entry.command_type == MEMBERSHIP {
            // A membership depends only on its own relation's earlier intents and on its
            // Album's create, which is always ahead of it. Every intent for one Asset
            // shares the Asset's readiness, so skipping a waiting one keeps its later
            // intents behind it while other Assets and Albums proceed.
            let readiness = readiness_by_asset.get(library, entry.asset_id.as_deref())?;
            match readiness {
                AssetIntentReadiness::Wait => {
                    report.waiting += 1;
                    continue;
                }
                AssetIntentReadiness::Drop(reason) => {
                    drop_entry(library, &entry, reason, now)?;
                    report.pending -= 1;
                    report.dropped += 1;
                    continue;
                }
                AssetIntentReadiness::Send => {}
            }
            // A waiting membership can be overtaken by a later delete of its Album. The
            // relation then has nothing to belong to: the server would refuse it with
            // `albumNotFound`, and blocking on that would stop the whole domain.
            let album = read_album_revision(&*library.connection()?, &entry.album_id)?;
            if matches!(album, Some((_, true))) {
                drop_entry(library, &entry, DROP_ALBUM_DELETED, now)?;
                report.pending -= 1;
                report.dropped += 1;
                continue;
            }
        }
        if entry.epoch != authority.epoch {
            // Revisions are only comparable inside one epoch, so an intent composed
            // under another epoch cannot present a meaningful expectation. It is
            // blocked rather than silently re-pointed, because guessing a cross-epoch
            // mapping is exactly the kind of implicit rebase this domain forbids.
            block_entry(library, entry.seq, "epochMismatch", serde_json::Value::Null, now)?;
            report.blocked += 1;
            report.pending -= 1;
            report.stopped = true;
            return Ok(report);
        }
        match client.album_command(&entry.payload, token)? {
            AlbumCommandOutcome::Accepted(result) => {
                confirm(library, &entry, &result, now)?;
                report.pending -= 1;
                if result.changed {
                    report.sent += 1;
                } else {
                    report.no_op += 1;
                }
            }
            AlbumCommandOutcome::Dropped => {
                // The Asset is tombstoned: the intent can never apply, so it is retired
                // instead of blocking the queue.
                drop_entry(library, &entry, DROP_ASSET_TOMBSTONED, now)?;
                report.pending -= 1;
                report.no_op += 1;
                report.dropped += 1;
            }
            AlbumCommandOutcome::Conflict(conflict)
                if entry.command_type == MEMBERSHIP && conflict.code == INVALID_MEMBERSHIP =>
            {
                // On the command route the server raises this code only when it does not
                // hold the Asset as a linkable (committed, not tombstoned) Asset; a missing
                // Album is `albumNotFound` and a tombstone is `assetTombstoned`. It is
                // therefore never a user-resolvable content conflict. An upload still in
                // flight waits; otherwise nothing this PC can do will make the server know
                // the Asset, so the intent is retired with a recorded reason instead of
                // blocking every later Album intent and the receive half.
                let readiness = readiness_by_asset.refresh(library, entry.asset_id.as_deref())?;
                match readiness {
                    AssetIntentReadiness::Wait => report.waiting += 1,
                    AssetIntentReadiness::Drop(reason) => {
                        drop_entry(library, &entry, reason, now)?;
                        report.pending -= 1;
                        report.dropped += 1;
                    }
                    AssetIntentReadiness::Send => {
                        drop_entry(library, &entry, INVALID_MEMBERSHIP, now)?;
                        report.pending -= 1;
                        report.dropped += 1;
                    }
                }
            }
            AlbumCommandOutcome::Conflict(conflict) => {
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
/// updated, so the caches keep describing the server rather than the queue.
fn confirm(
    library: &Library,
    entry: &AlbumOutboxEntry,
    result: &crate::cloud::client::AlbumCommandResult,
    now: &str,
) -> Result<(), LibraryError> {
    let mut connection = library.connection()?;
    let transaction = connection.transaction()?;
    if let Some(album) = &result.album {
        write_album_revision(
            &transaction,
            &album.id,
            album.entity_revision,
            album.deleted,
            now,
        )?;
    }
    if let Some(membership) = &result.membership {
        write_membership_revision(
            &transaction,
            &membership.album_id,
            &membership.asset_id,
            membership.desired_state,
            membership.entity_revision,
            now,
        )?;
    }
    // The intent is finished either way: an accepted no-op means the authority already
    // held the desired state, so there is nothing left to deliver.
    transaction.execute(
        "DELETE FROM album_authority_outbox WHERE operation_id = ?1",
        [&entry.operation_id],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Retire one intent that can never apply, and record why, in one transaction.
fn drop_entry(
    library: &Library,
    entry: &AlbumOutboxEntry,
    reason: &str,
    now: &str,
) -> Result<(), LibraryError> {
    let mut connection = library.connection()?;
    let transaction = connection.transaction()?;
    let deleted = transaction.execute(
        "DELETE FROM album_authority_outbox WHERE operation_id = ?1",
        [&entry.operation_id],
    )?;
    record_dropped_intents(
        &transaction,
        ALBUM_DOMAIN,
        deleted,
        reason,
        Some(&entry.operation_id),
        now,
    )?;
    transaction.commit()?;
    Ok(())
}

/// Preserve an intent the authority rejected on structural grounds.
///
/// The row keeps its payload and operation id, and the optimistic local effect stays
/// visible. Rename/move/delete/membership conflicts are never rebased automatically:
/// choosing a winner for a structural edit is a user decision, and the conflict
/// resolution UI is a later batch. What matters now is that the conflict is durable
/// and observable, so no other writer can be enabled on top of it.
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
        "UPDATE album_authority_outbox SET state = 'blocked', conflict_code = ?2, conflict_detail = ?3
         WHERE seq = ?1",
        params![seq, code, encoded],
    )?;
    let _ = now;
    Ok(())
}
