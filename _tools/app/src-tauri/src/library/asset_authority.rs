//! Confirmed server lifecycle, durable optimistic intent, and local byte materialization.
use super::{
    error::LibraryError,
    models::{ImportSource, IngestMediaRequest},
    Library,
};
use crate::cloud::{client::CloudClient, models::RemoteCaptureDownloadTicket};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetProjection {
    #[serde(default)]
    pub has_image_text: bool,
    pub asset_id: String,
    pub lifecycle: String,
    pub entity_revision: i64,
    pub kind: Option<String>,
    pub object_key: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
    pub source_url: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub collected_at: Option<String>,
    pub source_published_at: Option<String>,
    pub import_source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
impl AssetProjection {
    fn validate(&self) -> Result<(), LibraryError> {
        if self.asset_id.is_empty()
            || self.asset_id.len() > 128
            || !self
                .asset_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || self.size_bytes.is_some_and(|size| size > i64::MAX as u64)
            || self.entity_revision < 1
            || !matches!(self.lifecycle.as_str(), "normal" | "trash" | "tombstoned")
            || self.sha256.as_ref().is_some_and(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(())
    }
}
#[derive(Clone)]
pub(crate) struct MaterializationIdentity {
    pub asset_id: String,
    pub sha256: String,
    pub size_bytes: u64,
}
#[derive(Clone, Debug, PartialEq)]
struct Authority {
    library: String,
    epoch: i64,
    contract: i64,
    cursor: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleIntentFailure {
    pub asset_id: String,
    pub desired: String,
    pub reason: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSyncResult {
    pub adopted: bool,
    pub applied_changes: u32,
    pub materialized: u32,
    pub flushed: u32,
    pub stopped: bool,
    pub held: bool,
    pub materialization_failures: u32,
    pub lifecycle_failures: Vec<LifecycleIntentFailure>,
}

/// Retry metadata lives in the existing error slot; no schema upgrade is needed.
/// A conflict uses the existing terminal materialization state and needs recovery.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterializationFailure {
    code: String,
    attempts: u32,
    retry_at: i64,
    at: String,
    /// Consecutive downloads whose bytes did not match the replica's hash or size.
    #[serde(default)]
    integrity_attempts: u32,
}

const MATERIALIZATION_RETRY_BASE_SECONDS: i64 = 30;
const MATERIALIZATION_RETRY_MAX_SECONDS: i64 = 60 * 60;
/// A post-download hash/size mismatch can be a truncated or corrupted transfer, so it is
/// retried with backoff and parked only after this many consecutive mismatches.
const MATERIALIZATION_INTEGRITY_MAX_ATTEMPTS: u32 = 3;
/// Parked because another local Asset already holds the same content; released by the
/// materialization pass once that local row is gone.
const LOCAL_HASH_CONFLICT: &str = "localHashConflict";

fn invalid<T>() -> Result<T, LibraryError> {
    Err(LibraryError::InvalidCloudResponse)
}
fn authority(db: &Connection) -> Result<Option<Authority>, LibraryError> {
    Ok(db.query_row("SELECT library_id,epoch,contract_version,cursor FROM asset_authority WHERE singleton=1",[],|r|Ok(Authority{library:r.get(0)?,epoch:r.get(1)?,contract:r.get(2)?,cursor:r.get(3)?})).optional()?)
}
fn projection(db: &Connection, id: &str) -> Result<Option<AssetProjection>, LibraryError> {
    let raw: Option<String> = db
        .query_row(
            "SELECT projection FROM asset_authority_state WHERE asset_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| LibraryError::InvalidCloudResponse))
        .transpose()
}
fn local_projection(db: &Connection, id: &str) -> Result<(), LibraryError> {
    let lifecycle:Option<String>=db.query_row("SELECT desired FROM asset_lifecycle_outbox WHERE asset_id=? ORDER BY sequence DESC LIMIT 1",[id],|r|r.get(0)).optional()?;
    let confirmed: Option<String> = db
        .query_row(
            "SELECT lifecycle FROM asset_authority_state WHERE asset_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let target = match lifecycle {
        // A queued tombstone is not a deletion yet: the row and its bytes stay (hidden as
        // purge pending) until the server accepts it, so a restore elsewhere can still win.
        Some(desired) if desired == "tombstoned" && confirmed.as_deref() != Some("tombstoned") => {
            Some("trash".to_owned())
        }
        lifecycle => lifecycle.or(confirmed),
    };
    match target.as_deref() {
        Some("tombstoned") => retire_local_row(db, id)?,
        Some(status) => {
            // Each PC starts its retention clock when it adopts a trash: a row that was not
            // already in the trash gets the adoption time, never a stale earlier value.
            db.execute("UPDATE assets SET status=?1,trashed_at=CASE WHEN ?1='trash' THEN CASE WHEN status='trash' THEN COALESCE(trashed_at,?2) ELSE ?2 END ELSE NULL END WHERE id=?3",params![status,chrono::Utc::now().to_rfc3339(),id])?;
            if status != "normal" {
                super::similarity::release_incoming_reviews_without_existing(db, None)?;
            }
        }
        None => {}
    }
    Ok(())
}

/// Delete the local row of a confirmed tombstone.
///
/// Whether this PC or another device asked for the purge, the Asset's own recorded file
/// paths are captured in the same transaction that deletes the row, so the files can be
/// removed after commit (under the guards of `delete_accepted_purge_files`) and a crash in
/// between is finished on the next start.
fn retire_local_row(db: &Connection, id: &str) -> Result<(), LibraryError> {
    let paths: Option<(String, Option<String>, String)> = db
        .query_row(
            "SELECT relative_path,thumbnail_relative_path,media_kind FROM assets WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match paths {
        Some((original, thumbnail, media_kind)) => {
            let video_directory = (media_kind == "video").then(|| format!("video-media/{id}"));
            let now = chrono::Utc::now().to_rfc3339();
            db.execute(
                "INSERT INTO asset_purge_pending(asset_id,requested_at,accepted_at,relative_path,
                                                 thumbnail_relative_path,video_directory)
                 VALUES(?1,?2,?2,?3,?4,?5)
                 ON CONFLICT(asset_id) DO UPDATE SET accepted_at=excluded.accepted_at,
                   relative_path=excluded.relative_path,
                   thumbnail_relative_path=excluded.thumbnail_relative_path,
                   video_directory=excluded.video_directory
                 WHERE asset_purge_pending.accepted_at IS NULL",
                params![id, now, original, thumbnail, video_directory],
            )?;
        }
        None => {
            db.execute(
                "DELETE FROM asset_purge_pending WHERE asset_id=? AND accepted_at IS NULL",
                [id],
            )?;
        }
    }
    // An open incoming similarity review would fail the delete through its CHECK.
    super::similarity::release_incoming_reviews_without_existing(db, Some(id))?;
    db.execute("DELETE FROM assets WHERE id=?", [id])?;
    Ok(())
}

/// Settle purge-pending rows whose tombstone intent is no longer queued.
///
/// The normal path resolves a purge through the outbox; this covers the rest (an intent
/// removed by a rebaseline, a lost `changed:false` receipt, a row whose Asset vanished) so
/// no Asset stays hidden forever: a still-trashed Asset re-queues its tombstone, a restored
/// one comes back, a tombstoned one is retired.
pub(crate) fn reconcile_purge_pending(db: &Connection) -> Result<(), LibraryError> {
    let orphaned = db
        .prepare(
            "SELECT p.asset_id FROM asset_purge_pending p
             WHERE p.accepted_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM asset_lifecycle_outbox o
               WHERE o.asset_id=p.asset_id AND o.desired='tombstoned')",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in orphaned {
        let confirmed: Option<String> = db
            .query_row(
                "SELECT lifecycle FROM asset_authority_state WHERE asset_id=?",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let present: bool =
            db.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", [&id], |r| r.get(0))?;
        match confirmed.as_deref() {
            Some("trash") if present && authority(db)?.is_some() => {
                enqueue(db, &[id], "tombstoned")?;
            }
            Some("tombstoned") => retire_local_row(db, &id)?,
            _ => {
                db.execute("DELETE FROM asset_purge_pending WHERE asset_id=?", [&id])?;
                if present {
                    local_projection(db, &id)?;
                }
            }
        }
    }
    Ok(())
}
/// Whether this Asset's canonical media already came from the server.
///
/// The single ownership rule for the outbound replication lane: an Asset whose bytes the
/// server already holds must never be re-uploaded through the legacy new-Asset
/// transport. Every queue writer consults this rather than re-deriving it, so a new
/// caller cannot accidentally reintroduce a redundant upload.
///
/// Keyed on explicit provenance (`server_created`), not on a heuristic such as the id
/// looking server-generated, the file existing, or the queue having once been empty —
/// those all guess at the same fact and would be wrong for a locally-created Asset with
/// a similar id.
pub(crate) fn is_server_owned(db: &Connection, asset_id: &str) -> Result<bool, LibraryError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_authority_state WHERE asset_id=? AND server_created=1)",
        [asset_id],
        |row| row.get::<_, bool>(0),
    )?)
}

pub(crate) fn mark_materialized(db: &Connection, id: &str) -> Result<(), LibraryError> {
    db.execute("UPDATE asset_authority_state SET materialization='complete',last_error=NULL,server_created=1 WHERE asset_id=?",[id])?;
    // Other domains may have arrived before the original bytes. Reconcile their
    // deferred organization without creating local assignment/membership commands.
    db.execute("INSERT OR IGNORE INTO asset_classifications(asset_id,classification_id) SELECT r.asset_id,r.classification_id FROM classification_authority_assignment_revisions r JOIN classification_entries c ON c.id=r.classification_id WHERE r.asset_id=? AND NOT EXISTS(SELECT 1 FROM classification_authority_outbox o WHERE o.asset_id=r.asset_id)", [id])?;
    db.execute("INSERT OR IGNORE INTO asset_albums(asset_id,album_id) SELECT r.asset_id,r.album_id FROM album_authority_membership_revisions r JOIN albums a ON a.id=r.album_id WHERE r.asset_id=? AND r.desired_state=1 AND NOT EXISTS(SELECT 1 FROM album_authority_outbox o WHERE o.asset_id=r.asset_id)", [id])?;
    local_projection(db, id)?;
    // Ingest runs before deferred assignments are visible. Enroll only after the
    // final folder and lifecycle are projected; unchanged retries remain a no-op.
    super::character_autotag::enqueue(db, id, super::character_autotag::Cause::Ingestion)?;
    Ok(())
}
fn apply(db: &Connection, p: &AssetProjection) -> Result<(), LibraryError> {
    p.validate()?;
    let prior = projection(db, &p.asset_id)?;
    if let Some(old) = &prior {
        if old.entity_revision > p.entity_revision {
            return Ok(());
        }
        // Only newer canonical state can revive an Asset. An old capture or receipt
        // cannot turn the retained tombstone into a normal local row.
        if old.lifecycle == "tombstoned"
            && p.lifecycle != "tombstoned"
            && (p.lifecycle != "normal" || p.entity_revision <= old.entity_revision)
        {
            return invalid();
        }
        if old.sha256.is_some() && old.sha256 != p.sha256 {
            return invalid();
        }
    }
    let local: Option<String> = db
        .query_row(
            "SELECT content_hash FROM assets WHERE id=?",
            [&p.asset_id],
            |r| r.get(0),
        )
        .optional()?;
    if local
        .as_ref()
        .is_some_and(|hash| p.sha256.as_ref().is_some_and(|s| s != hash))
    {
        return invalid();
    }
    let status = if local.is_some() {
        "complete"
    } else {
        "pending"
    };
    db.execute("INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,sha256,size_bytes,projection,materialization) VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET lifecycle=excluded.lifecycle,entity_revision=excluded.entity_revision,sha256=excluded.sha256,size_bytes=excluded.size_bytes,projection=excluded.projection",params![p.asset_id,p.lifecycle,p.entity_revision,p.sha256,p.size_bytes.map(|size|size as i64),serde_json::to_string(p).map_err(|_|LibraryError::InvalidCloudResponse)?,status])?;
    if p.lifecycle == "normal"
        && prior.as_ref().is_some_and(|old| old.lifecycle != "normal")
    {
        // A previous import may have been complete before permanent deletion removed
        // its row/files. Requeue under the same canonical identity, never a new ID.
        db.execute(
            "UPDATE asset_authority_state SET materialization=?,last_error=NULL WHERE asset_id=?",
            params![status, p.asset_id],
        )?;
        db.execute("DELETE FROM asset_purge_pending WHERE asset_id=?", [&p.asset_id])?;
    }
    // The local status is read before `local_projection` adopts the incoming lifecycle,
    // because adopting it is what rewrites `assets.status`.
    let local_status: Option<String> = db
        .query_row("SELECT status FROM assets WHERE id=?", [&p.asset_id], |r| r.get(0))
        .optional()?;
    if let Some(local_status) = local_status {
        reconcile_unsent_local_trash(db, &p.asset_id, &local_status, &p.lifecycle,
                                     prior.is_some())?;
    }
    local_projection(db, &p.asset_id)
}
/// Called by the local lifecycle mutation in the SAME transaction as optimistic state.
/// Queue a lifecycle command for the Assets whose lifecycle the *server* owns.
///
/// An Asset the server has never seen has no canonical projection and no entity
/// revision, so there is nothing to compare-and-set against and no command to send: its
/// lifecycle is simply local state until replication commits it. Skipping such an Asset
/// is therefore correct, not a failure - including it would either fabricate a revision
/// or abort the whole call, which is how a batch containing one unregistered Asset used
/// to fail entirely.
///
/// Selection is explicit: it keys on the presence of canonical authority state, never on
/// an id shape, a file existing, or the queue being empty.
pub(crate) fn enqueue(
    db: &Connection,
    ids: &[String],
    desired: &str,
) -> Result<(), LibraryError> {
    let Some(a) = authority(db)? else {
        return Ok(());
    };
    for id in ids {
        let Some(p) = projection(db, id)? else {
            continue;
        };
        if p.lifecycle == "tombstoned" {
            return invalid();
        }
        db.execute("INSERT INTO asset_lifecycle_outbox(operation_id,library_id,epoch,contract_version,asset_id,desired,expected_revision,created_at) VALUES(?,?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),a.library,a.epoch,a.contract,id,desired,p.entity_revision,chrono::Utc::now().to_rfc3339()])?;
    }
    super::authority_pass::note_local_work();
    Ok(())
}

/// Preserve a local trash the server never learned about.
///
/// A local-only Asset can be trashed while its own upload is in flight. The server then
/// commits it as `normal`, and the canonical projection arrives with no command ever
/// sent - so the local trash would be silently overwritten. Recording it is the only
/// outcome consistent with the user's action.
///
/// The discriminator is whether canonical state *already existed* before this projection:
///
/// * no prior canonical row -> the Asset had no server-visible lifecycle at all, so a
///   local `trash` against an arriving `normal` is strictly unsent intent; re-queue it.
/// * a prior canonical row -> the local status was previously confirmed by the server
///   (or the server has since changed it), so the arriving value is authoritative and is
///   adopted untouched. This is what keeps a restore from another client from being
///   fought by a stale local trash.
///
/// Only `trash` against an arriving `normal` is reconciled: a local `normal` against an
/// arriving `trash` is a server-side retirement, and adopting it is the whole point of a
/// replica. A queued command suppresses the rewrite so an accepted transition is never
/// re-sent.
fn reconcile_unsent_local_trash(
    db: &Connection,
    asset_id: &str,
    local_status: &str,
    incoming_lifecycle: &str,
    had_canonical: bool,
) -> Result<(), LibraryError> {
    if had_canonical || local_status != "trash" || incoming_lifecycle != "normal" {
        return Ok(());
    }
    let queued: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_lifecycle_outbox WHERE asset_id=?)",
        [asset_id],
        |r| r.get(0))?;
    if queued {
        return Ok(());
    }
    enqueue(db, &[asset_id.to_string()], "trash")
}
/// A queued purge lost its race: the server Asset is no longer in the trash.
///
/// * `normal` — another device restored it. Rebasing would tombstone an Asset the user
///   just chose to keep, so the intent is dropped and the local row comes back (or is
///   re-materialized if an older build already removed it).
/// * `tombstoned` — someone else already retired it; the intent is done.
fn resolve_tombstone_conflict(
    db: &Connection,
    seq: i64,
    current: &AssetProjection,
) -> Result<(), LibraryError> {
    db.execute("DELETE FROM asset_lifecycle_outbox WHERE sequence=?", [seq])?;
    if current.lifecycle == "normal" {
        db.execute(
            "DELETE FROM asset_purge_pending WHERE asset_id=? AND accepted_at IS NULL",
            [&current.asset_id],
        )?;
    }
    apply(db, current)?;
    local_projection(db, &current.asset_id)?;
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)",
        [&current.asset_id],
        |r| r.get(0),
    )?;
    if current.lifecycle == "normal" && !present {
        db.execute(
            "UPDATE asset_authority_state SET materialization='pending',last_error=NULL WHERE asset_id=? AND materialization<>'conflict'",
            [&current.asset_id],
        )?;
    }
    Ok(())
}
/// Prefix of `asset_authority_state.last_error` for a lifecycle intent that was dropped
/// because the server state won (a coded rejection, a tombstone, or an authority epoch
/// change). The row keeps the server's state; this records why the user's choice did not
/// stick, so the count and reasons stay queryable:
/// `SELECT asset_id,last_error FROM asset_authority_state WHERE last_error LIKE 'lifecycleRejected:%'`.
pub(crate) const LIFECYCLE_REJECTED: &str = "lifecycleRejected:";
fn record_rejection(db: &Connection, id: &str, reason: &str) -> Result<(), LibraryError> {
    db.execute(
        "UPDATE asset_authority_state SET last_error=? WHERE asset_id=?",
        params![format!("{LIFECYCLE_REJECTED}{reason}"), id],
    )?;
    Ok(())
}
/// A dropped tombstone intent leaves no purge behind: unless another queued tombstone
/// still carries it, the Asset leaves the hidden purge-pending state.
fn settle_dropped_tombstone(db: &Connection, id: &str) -> Result<(), LibraryError> {
    db.execute(
        "DELETE FROM asset_purge_pending WHERE asset_id=?1 AND accepted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM asset_lifecycle_outbox WHERE asset_id=?1 AND desired='tombstoned')",
        [id],
    )?;
    Ok(())
}
/// The server no longer knows this Asset (absent from a new baseline, or `assetNotFound`).
///
/// This PC may hold the only copy, so the local row is never deleted for that reason. It
/// becomes a PC-only Asset again, exactly like one that was never committed: its stale
/// confirmed state and its lifecycle commands go (no revision exists to present), its local
/// status stays as it is, and a fresh replication upload is queued so the server gets it
/// back. The replication lane uploads only `normal` Assets, so a locally trashed one waits
/// in the queue until it is restored.
///
/// An Asset the user already chose to delete (confirmed tombstone, a purge pending, or a
/// queued tombstone) is never uploaded again: its purge is finished locally exactly as an
/// accepted tombstone is (`retire_local_row`, then `delete_accepted_purge_files`).
fn release_to_local(tx: &Transaction, id: &str) -> Result<(), LibraryError> {
    let purged: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_authority_state WHERE asset_id=?1 AND lifecycle='tombstoned')
             OR EXISTS(SELECT 1 FROM asset_purge_pending WHERE asset_id=?1)
             OR EXISTS(SELECT 1 FROM asset_lifecycle_outbox WHERE asset_id=?1 AND desired='tombstoned')",
        [id],
        |r| r.get(0),
    )?;
    tx.execute("DELETE FROM asset_lifecycle_outbox WHERE asset_id=?", [id])?;
    if purged {
        tx.execute("DELETE FROM cloud_sync_queue WHERE entity_type='asset' AND entity_id=?", [id])?;
        let finished: bool = tx.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM assets WHERE id=?1)
                AND NOT EXISTS(SELECT 1 FROM asset_purge_pending WHERE asset_id=?1)",
            [id],
            |r| r.get(0),
        )?;
        if finished {
            // Nothing local is left to delete; the stale state row can go.
            tx.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [id])?;
            return Ok(());
        }
        // The file-deletion step only acts on a confirmed tombstone, so the purge is
        // recorded as one. Its revision is the maximum so no later change for this id can
        // revive it through the change feed (which would otherwise fail every pass); only a
        // future baseline that lists the id again replaces it (`apply_baseline`).
        if let Some(mut p) = projection(tx, id)? {
            p.lifecycle = "tombstoned".into();
            p.entity_revision = i64::MAX;
            tx.execute(
                "UPDATE asset_authority_state SET lifecycle='tombstoned',entity_revision=?,projection=? WHERE asset_id=?",
                params![p.entity_revision, serde_json::to_string(&p).map_err(|_| LibraryError::InvalidCloudResponse)?, id],
            )?;
        }
        return retire_local_row(tx, id);
    }
    tx.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [id])?;
    // A `synced` upload row is what other domains read as "the server holds this Asset"
    // (Album/Classification readiness, the backfill seeders). It is derived queue state and
    // no longer true, so it goes; an upload still in flight is left to its worker.
    tx.execute(
        "DELETE FROM cloud_sync_queue WHERE entity_type='asset' AND entity_id=? AND operation='upsert' AND status='synced'",
        [id],
    )?;
    let present: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", [id], |r| r.get(0))?;
    if present {
        crate::cloud::queue::enqueue_asset_upsert(tx, id, &chrono::Utc::now().to_rfc3339())?;
    }
    Ok(())
}
/// A baseline is complete server truth, not a replayed change. After an authority backup
/// restore it can be *older* than what this replica had confirmed (a lower revision, or a
/// tombstone that the restored server never recorded), and it still replaces confirmed
/// state; otherwise every later command would present a revision the server never issued.
fn apply_baseline(db: &Connection, p: &AssetProjection) -> Result<(), LibraryError> {
    p.validate()?;
    let Some(old) = projection(db, &p.asset_id)? else {
        return apply(db, p);
    };
    let regressed = old.entity_revision > p.entity_revision
        || (old.lifecycle == "tombstoned" && p.lifecycle != "tombstoned");
    if !regressed {
        return apply(db, p);
    }
    let local: Option<String> = db
        .query_row("SELECT content_hash FROM assets WHERE id=?", [&p.asset_id], |r| r.get(0))
        .optional()?;
    if (old.sha256.is_some() && old.sha256 != p.sha256)
        || local.as_ref().is_some_and(|hash| p.sha256.as_ref().is_some_and(|s| s != hash))
    {
        return invalid();
    }
    db.execute("UPDATE asset_authority_state SET lifecycle=?,entity_revision=?,sha256=?,size_bytes=?,projection=?,materialization=CASE WHEN ? OR materialization='conflict' THEN materialization ELSE 'pending' END WHERE asset_id=?",params![p.lifecycle,p.entity_revision,p.sha256,p.size_bytes.map(|size|size as i64),serde_json::to_string(p).map_err(|_|LibraryError::InvalidCloudResponse)?,local.is_some(),p.asset_id])?;
    local_projection(db, &p.asset_id)
}
/// Re-issue or drop lifecycle intents composed for another authority identity.
///
/// ADR-0038 §5: a command from another epoch cannot present a meaningful revision, so an
/// old-epoch row is never sent as is, and it must not block the new baseline either. Asset
/// lifecycle is a desired state, so where the user's choice is still a legal transition
/// from the new confirmed state it is re-issued against the new baseline (new operation id,
/// new identity, the baseline's revision). It is dropped when it is already satisfied, when
/// the new state is a tombstone, when it is a purge of an Asset the new baseline has as
/// `normal` (a restore wins, as in §7a), or when it belongs to another library (a different
/// revision lineage). Dropped choices the server overrode are recorded on the Asset.
fn rebase_foreign_intents(tx: &Transaction, a: &Authority) -> Result<(), LibraryError> {
    let rows = tx
        .prepare("SELECT sequence,asset_id,desired,library_id FROM asset_lifecycle_outbox WHERE asset_id IN (SELECT asset_id FROM asset_lifecycle_outbox WHERE library_id<>?1 OR epoch<>?2 OR contract_version<>?3) ORDER BY sequence")?
        .query_map(params![a.library, a.epoch, a.contract], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut simulated: std::collections::HashMap<String, Option<(String, i64)>> = Default::default();
    for (seq, id, desired, library) in rows {
        if !simulated.contains_key(&id) {
            let current = projection(tx, &id)?.map(|p| (p.lifecycle, p.entity_revision));
            simulated.insert(id.clone(), current);
        }
        let state = simulated.get_mut(&id).unwrap();
        let keep = library == a.library
            && state.as_ref().is_some_and(|(lifecycle, _)| {
                lifecycle != "tombstoned"
                    && *lifecycle != desired
                    && (desired != "tombstoned" || lifecycle == "trash")
            });
        if keep {
            let revision = state.as_ref().unwrap().1;
            tx.execute("UPDATE asset_lifecycle_outbox SET operation_id=?,library_id=?,epoch=?,contract_version=?,expected_revision=?,status='pending',last_error=NULL WHERE sequence=?",params![uuid::Uuid::new_v4().to_string(),a.library,a.epoch,a.contract,revision,seq])?;
            state.as_mut().unwrap().0 = desired;
        } else {
            tx.execute("DELETE FROM asset_lifecycle_outbox WHERE sequence=?", [seq])?;
            if state.as_ref().is_some_and(|(lifecycle, _)| *lifecycle != desired) {
                record_rejection(tx, &id, "epochChanged")?;
            }
        }
    }
    for id in simulated.keys() {
        settle_dropped_tombstone(tx, id)?;
        local_projection(tx, id)?;
    }
    Ok(())
}
fn verify_envelope(value: &Value, a: &Authority) -> Result<(), LibraryError> {
    if value["libraryId"].as_str() != Some(&a.library)
        || value["epoch"].as_i64() != Some(a.epoch)
        || value["contractVersion"].as_i64() != Some(a.contract)
    {
        return invalid();
    }
    Ok(())
}
fn parse(value: Value) -> Result<AssetProjection, LibraryError> {
    let p: AssetProjection =
        serde_json::from_value(value).map_err(|_| LibraryError::InvalidCloudResponse)?;
    p.validate()?;
    Ok(p)
}
impl Library {
    pub fn sync_asset_authority(&self) -> Result<AssetSyncResult, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(AssetSyncResult::default());
        }
        let client = self.cloud_client(
            config
                .api_base_url
                .as_deref()
                .ok_or(LibraryError::InvalidCloudSyncConfig)?,
        )?;
        let token = super::credential::read_cloud_api_token_os()?;
        let result = self.sync_assets_with(&client, token.expose(), None, crate::workload::is_restricted());
        if matches!(result, Err(LibraryError::CloudUnauthorized)) {
            super::credential_broker::broker()
                .invalidate(super::credential::CredentialTarget::CloudApi);
        }
        result
    }
    pub(crate) fn sync_assets_with(
        &self,
        client: &CloudClient,
        token: &str,
        publisher: Option<&str>,
        restricted: bool,
    ) -> Result<AssetSyncResult, LibraryError> {
        self.sync_assets_with_status(
            client,
            token,
            publisher,
            restricted,
            &|| client.sync_status(token),
            false,
        )
    }
    /// One Asset pass against a caller-supplied `/v1/sync/status` read. With
    /// `skip_unchanged` (the coordinated poll only) an unmoved cursor skips the change
    /// feed; queued lifecycle intents and materialization still run.
    pub(crate) fn sync_assets_with_status(
        &self,
        client: &CloudClient,
        token: &str,
        publisher: Option<&str>,
        restricted: bool,
        read_status: &dyn Fn() -> Result<crate::cloud::client::SyncStatus, LibraryError>,
        skip_unchanged: bool,
    ) -> Result<AssetSyncResult, LibraryError> {
        let _single = self
            .asset_sync_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let status = read_status()?;
        let received = match self.receive_assets(client, token, &status, skip_unchanged) {
            Err(LibraryError::CloudSyncHeld) => {
                return Ok(AssetSyncResult {
                    held: true,
                    ..Default::default()
                })
            }
            result => result?,
        };
        let Some((a, applied)) = received
        else {
            return Ok(AssetSyncResult::default());
        };
        let mut result = AssetSyncResult {
            adopted: true,
            applied_changes: applied,
            ..Default::default()
        };
        // Queued lifecycle writes require the publisher role; do not touch that credential on a clean queue.
        let pending: i64 = self.connection()?.query_row(
            "SELECT count(*) FROM asset_lifecycle_outbox",
            [],
            |r| r.get(0),
        )?;
        result.held = pending > 0 && (self.sync_held(client.base()) || client.held());
        if pending > 0 && !result.held {
            if let Some(publisher) = publisher {
                self.flush_assets(client, publisher, &a, &mut result)?;
            } else {
                let secret = super::credential::read_cloud_publisher_token_os()?;
                self.flush_assets(client, secret.expose(), &a, &mut result)?;
            }
        }
        // Finish file deletion for purges the server has accepted (this pass or earlier).
        self.delete_accepted_purge_files()?;
        self.materialize_candidates(client, token, &mut result, restricted)?;
        Ok(result)
    }
    /// Bring the confirmed replica to `status`: a baseline on a new identity or a cursor
    /// the change feed refuses, otherwise the change feed. `None` when the server has no
    /// Asset domain and this library never adopted one. The caller holds `asset_sync_lock`.
    fn receive_assets(
        &self,
        client: &CloudClient,
        token: &str,
        status: &crate::cloud::client::SyncStatus,
        skip_unchanged: bool,
    ) -> Result<Option<(Authority, u32)>, LibraryError> {
        crate::activities::RequestJob::run("server-trash-receive", "server_exchange", "서버 변경 주고받기", || {
        let Some(remote) = status.domains.iter().find(|d| d.domain == "assets") else {
            if authority(&*self.connection()?)?.is_some() {
                return invalid();
            }
            return Ok(None);
        };
        if remote.library_id != self.library_id()? || remote.contract_version != 1 {
            return invalid();
        }
        let a = Authority {
            library: remote.library_id.clone(),
            epoch: remote.epoch,
            contract: remote.contract_version,
            cursor: remote.cursor,
        };
        let local = authority(&*self.connection()?)?;
        let need_baseline = local.as_ref().is_none_or(|l| {
            l.library != a.library || l.epoch != a.epoch || l.contract != a.contract
        });
        let mut applied = 0;
        if need_baseline {
            self.install_asset_baseline(client, token, &a)?;
            applied += 1;
        } else if skip_unchanged && local.as_ref().is_some_and(|l| l.cursor == a.cursor) {
            // The shared status proves the feed has nothing after the stored cursor.
        } else {
            let cursor = local.unwrap().cursor;
            match self.catch_up_assets(client, token, &a, cursor) {
                Ok(count) => applied += count,
                Err(LibraryError::AssetAuthorityRejected { ref code, .. })
                    if matches!(
                        code.as_str(),
                        "cursorExpired" | "cursorAhead" | "baselineChanged"
                    ) =>
                {
                    self.install_asset_baseline(client, token, &a)?;
                    applied += 1;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(Some((a, applied)))
        })
    }

    /// Before Album and Classification receive: when `status` shows the adopted Asset
    /// authority moved to another identity or behind this replica's cursor (a server
    /// authority restore), re-baseline the Asset replica first.
    ///
    /// Those baselines replace their relation tables wholesale. Only after the Asset
    /// re-baseline has released the Assets the server lost (re-queueing their upload) can
    /// they tell such an Asset's relations apart from ones the server removed, and keep
    /// them. `Ok(Some(changed))`: the relation lanes may receive; `changed` when the Asset
    /// replica moved. `Ok(None)`: the Asset lane is busy on another thread, so they wait
    /// for a later pass.
    pub(crate) fn settle_asset_identity_with_status(
        &self,
        client: &CloudClient,
        token: &str,
        status: &crate::cloud::client::SyncStatus,
    ) -> Result<Option<bool>, LibraryError> {
        let pending = |local: Option<Authority>| {
            let remote = status.domains.iter().find(|d| d.domain == "assets");
            match (local, remote) {
                (Some(l), Some(r)) => {
                    l.library != r.library_id
                        || l.epoch != r.epoch
                        || l.contract != r.contract_version
                        || l.cursor > r.cursor
                }
                _ => false,
            }
        };
        if !pending(authority(&*self.connection()?)?) {
            return Ok(Some(false));
        }
        let _single = match self.asset_sync_lock.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
        };
        // Re-read under the lock: the Asset lane may have settled it meanwhile.
        if !pending(authority(&*self.connection()?)?) {
            return Ok(Some(false));
        }
        let applied = self
            .receive_assets(client, token, status, false)?
            .map_or(0, |(_, applied)| applied);
        Ok(Some(applied > 0))
    }
    fn install_asset_baseline(
        &self,
        client: &CloudClient,
        token: &str,
        a: &Authority,
    ) -> Result<(), LibraryError> {
        // A new baseline may retire or reissue lifecycle intents. During recovery those
        // choices stay queued; defer this baseline instead of claiming catch-up completed.
        if self.sync_held(client.base()) || client.held() {
            let pending: bool = self.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM asset_lifecycle_outbox)", [], |row| row.get(0),
            )?;
            if pending { return Err(LibraryError::CloudSyncHeld); }
        }
        let mut after: Option<String> = None;
        let mut cursor = None;
        let mut all = Vec::new();
        let mut seen = HashSet::new();
        for _ in 0..100_000 {
            let path = format!(
                "/v1/assets/authority/baseline?libraryId={}&epoch={}&limit=500{}{}",
                a.library,
                a.epoch,
                after
                    .as_ref()
                    .map(|s| format!("&after={s}"))
                    .unwrap_or_default(),
                cursor
                    .map(|v| format!("&expectedCursor={v}"))
                    .unwrap_or_default()
            );
            let page = client.asset_request(&path, None, token)?;
            verify_envelope(&page, a)?;
            let next_cursor = page["cursor"]
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or(LibraryError::InvalidCloudResponse)?;
            if cursor.is_some_and(|v| v != next_cursor) {
                return invalid();
            }
            cursor = Some(next_cursor);
            let items = page["items"]
                .as_array()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            if items.len() > 500 {
                return invalid();
            }
            let mut previous = after.clone();
            for value in items {
                let p = parse(value.clone())?;
                if previous.as_ref().is_some_and(|last| p.asset_id <= *last)
                    || !seen.insert(p.asset_id.clone())
                {
                    return invalid();
                }
                previous = Some(p.asset_id.clone());
                all.push(p);
            }
            let more = page["hasMore"]
                .as_bool()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            if !more {
                let _trash = self.trash_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut db = self.connection()?;
                let tx = db.transaction()?;
                // Keep byte-progress for identities present in both snapshots; replace confirmed rows only.
                let same_identity = authority(&tx)?.is_some_and(|old|
                    old.library == a.library && old.epoch == a.epoch && old.contract == a.contract);
                for p in &all {
                    if same_identity {
                        // Expired-history recovery is still the same revision lineage.
                        // Replaying an older baseline must not revive a tombstone.
                        apply(&tx, p)?;
                    } else {
                        apply_baseline(&tx, p)?;
                    }
                }
                // Absence from the new baseline never deletes a local Asset (review H4).
                let old = tx
                    .prepare("SELECT asset_id FROM asset_authority_state")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                for id in old {
                    if !seen.contains(&id) {
                        release_to_local(&tx, &id)?;
                    }
                }
                // Old-identity intents are rebased or dropped here, never left to block (review M1).
                rebase_foreign_intents(&tx, a)?;
                tx.execute("INSERT INTO asset_authority VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET library_id=excluded.library_id,epoch=excluded.epoch,contract_version=excluded.contract_version,cursor=excluded.cursor",params![a.library,a.epoch,a.contract,cursor.unwrap()])?;
                tx.commit()?;
                return Ok(());
            }
            let next = page["nextAfter"]
                .as_str()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            if items.last().and_then(|p| p["assetId"].as_str()) != Some(next)
                || after.as_deref() == Some(next)
            {
                return invalid();
            }
            after = Some(next.to_owned());
        }
        invalid()
    }
    fn catch_up_assets(
        &self,
        client: &CloudClient,
        token: &str,
        a: &Authority,
        mut after: i64,
    ) -> Result<u32, LibraryError> {
        let mut count = 0;
        for _ in 0..100_000 {
            let page = client.asset_request(
                &format!(
                    "/v1/assets/authority/changes?libraryId={}&epoch={}&after={}&limit=200",
                    a.library, a.epoch, after
                ),
                None,
                token,
            )?;
            verify_envelope(&page, a)?;
            let ceiling = page["cursor"]
                .as_i64()
                .filter(|v| *v >= after)
                .ok_or(LibraryError::InvalidCloudResponse)?;
            let items = page["items"]
                .as_array()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            let mut parsed = Vec::new();
            let mut next = after;
            for item in items {
                next += 1;
                if item["sequence"].as_i64() != Some(next) || next > ceiling {
                    return invalid();
                }
                parsed.push(parse(item["asset"].clone())?);
            }
            let more = page["hasMore"]
                .as_bool()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            if page["nextAfter"].as_i64() != Some(next)
                || more != (next < ceiling)
                || (more && next == after)
            {
                return invalid();
            }
            let _trash = self.trash_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            if authority(&tx)?
                .as_ref()
                .is_none_or(|s| s.library != a.library || s.epoch != a.epoch || s.cursor != after)
            {
                return invalid();
            }
            for p in &parsed {
                apply(&tx, p)?;
            }
            tx.execute(
                "UPDATE asset_authority SET cursor=? WHERE singleton=1",
                [next],
            )?;
            tx.commit()?;
            count += parsed.len() as u32;
            after = next;
            if !more {
                return Ok(count);
            }
        }
        invalid()
    }
    fn flush_assets(
        &self,
        client: &CloudClient,
        token: &str,
        a: &Authority,
        result: &mut AssetSyncResult,
    ) -> Result<(), LibraryError> {
        crate::activities::RequestJob::run("server-trash-send", "server_exchange", "서버 변경 주고받기", || {
        self.ensure_send_to(client.base())?;
        client.ensure_send()?;
        for _ in 0..100 {
            let row:Option<(i64,String,String,String,i64)>=self.connection()?.query_row("SELECT sequence,operation_id,asset_id,desired,expected_revision FROM asset_lifecycle_outbox ORDER BY sequence LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let Some((seq, operation, id, desired, expected)) = row else {
                return Ok(());
            };
            // A row an older build parked as `conflict` is simply re-sent under its own
            // operation id: the server replays its receipt or the same rejection, which is
            // now resolved below instead of stopping the queue.
            self.connection()?.execute(
                "UPDATE asset_lifecycle_outbox SET status='sending' WHERE sequence=?",
                [seq],
            )?;
            let command = match desired.as_str() {
                "normal" => "restoreAsset",
                "trash" => "trashAsset",
                _ => "tombstoneAsset",
            };
            let body = json!({"libraryId":a.library,"epoch":a.epoch,"contractVersion":a.contract,"operationId":operation,"commandType":command,"assetId":id,"expectedEntityRevision":expected});
            match client.asset_request("/v1/assets/authority/commands", Some(&body), token) {
                Ok(receipt) => {
                    verify_envelope(&receipt, a)?;
                    if receipt["operationId"].as_str() != Some(&operation)
                        || receipt["commandType"].as_str() != Some(command)
                    {
                        return invalid();
                    }
                    let changed = receipt["changed"]
                        .as_bool()
                        .ok_or(LibraryError::InvalidCloudResponse)?;
                    let p = if changed {
                        Some(parse(receipt["asset"].clone())?)
                    } else {
                        None
                    };
                    if p.as_ref().is_some_and(|p| {
                        p.asset_id != id
                            || p.lifecycle != desired
                            || p.entity_revision != expected + 1
                    }) {
                        return invalid();
                    }
                    let _trash = self.trash_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    let mut db = self.connection()?;
                    let tx = db.transaction()?;
                    if let Some(p) = p {
                        apply(&tx, &p)?;
                    }
                    tx.execute(
                        "DELETE FROM asset_lifecycle_outbox WHERE sequence=? AND operation_id=?",
                        params![seq, operation],
                    )?;
                    let revision = projection(&tx, &id)?
                        .ok_or(LibraryError::InvalidCloudResponse)?
                        .entity_revision;
                    tx.execute("UPDATE asset_lifecycle_outbox SET expected_revision=? WHERE asset_id=? AND status='pending'",params![revision,id])?;
                    local_projection(&tx, &id)?;
                    tx.commit()?;
                    result.flushed += 1;
                }
                Err(LibraryError::AssetAuthorityConflict {
                    asset_id,
                    current_revision,
                    lifecycle,
                }) => {
                    if asset_id != id {
                        return invalid();
                    }
                    let _trash = self.trash_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    let mut db = self.connection()?;
                    let tx = db.transaction()?;
                    let mut p = projection(&tx, &id)?.ok_or(LibraryError::InvalidCloudResponse)?;
                    if current_revision < p.entity_revision {
                        return invalid();
                    }
                    p.entity_revision = current_revision;
                    p.lifecycle = lifecycle.clone();
                    if desired == "tombstoned" && lifecycle != "trash" {
                        resolve_tombstone_conflict(&tx, seq, &p)?;
                        tx.commit()?;
                        result.applied_changes += 1;
                        continue;
                    }
                    if lifecycle == "tombstoned" {
                        // A tombstone is terminal: no queued trash or restore for this Asset
                        // can ever be accepted. Adopt it (the local row retires through the
                        // purge path) and drop every intent for the Asset (review H3).
                        tx.execute("DELETE FROM asset_lifecycle_outbox WHERE asset_id=?", [&id])?;
                        apply(&tx, &p)?;
                        record_rejection(&tx, &id, "assetTombstoned")?;
                        tx.commit()?;
                        result.applied_changes += 1;
                        result.lifecycle_failures.push(LifecycleIntentFailure {
                            asset_id: id, desired, reason: "assetTombstoned".into(),
                        });
                        continue;
                    }
                    apply(&tx, &p)?;
                    tx.execute("UPDATE asset_lifecycle_outbox SET operation_id=?,expected_revision=?,status='pending',last_error=NULL WHERE sequence=?",params![uuid::Uuid::new_v4().to_string(),current_revision,seq])?;
                    tx.commit()?;
                }
                Err(LibraryError::AssetAuthorityRejected { code, .. }) => {
                    if !matches!(
                        code.as_str(),
                        "assetNotFound"
                            | "lifecycleTransitionRefused"
                            | "operationConflict"
                            | "similarityKeptByTabletDecision"
                    ) {
                        // Not a definitive answer about this intent: the domain identity moved
                        // under this pass (the next pass's status check re-baselines and
                        // rebases the row), or the answer is uncoded / unknown (a misrouted
                        // or rolled-back server, a request-schema 422). The row keeps its
                        // exact operation and payload and is retried next pass; a server
                        // fault is never turned into lost user intent.
                        result.stopped = true;
                        result.lifecycle_failures.push(LifecycleIntentFailure {
                            asset_id: id, desired, reason: code,
                        });
                        return Ok(());
                    }
                    // (`similarityKeptByTabletDecision`: the tablet's server-applied similarity
                    // decision kept this Asset, so this PC's trash of it is rolled back to the
                    // confirmed state, as for any refused intent.)
                    // The command handler's definitive coded rejections (server
                    // `asset_authority.apply_command`) end this intent, and lifecycle commands
                    // for different Assets are independent, so it must not stop the queue
                    // (review H3). The rejection carries no usable server state and no
                    // single-Asset read exists, so the Asset falls back to its confirmed
                    // replica state (kept current by the change feed) and the intent is
                    // dropped with a durable reason. Uncertain transport outcomes still keep
                    // the exact operation and payload for receipt retry (the arm below).
                    let _trash = self.trash_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    let mut db = self.connection()?;
                    let tx = db.transaction()?;
                    if code == "assetNotFound" {
                        release_to_local(&tx, &id)?;
                    } else {
                        tx.execute("DELETE FROM asset_lifecycle_outbox WHERE sequence=?", [seq])?;
                        settle_dropped_tombstone(&tx, &id)?;
                        local_projection(&tx, &id)?;
                        record_rejection(&tx, &id, &code)?;
                    }
                    tx.commit()?;
                    result.lifecycle_failures.push(LifecycleIntentFailure {
                        asset_id: id, desired, reason: code,
                    });
                }
                Err(LibraryError::CloudUnauthorized) => {
                    super::credential_broker::broker()
                        .invalidate(super::credential::CredentialTarget::CloudPublisher);
                    return Err(LibraryError::CloudUnauthorized);
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
        })
    }
    fn pending_materializations(&self, restricted: bool) -> Result<Vec<String>, LibraryError> {
        let candidates=self.connection()?.prepare("SELECT projection FROM asset_authority_state
            WHERE materialization='pending' AND lifecycle='normal'
            AND CASE WHEN json_valid(last_error) THEN COALESCE(json_extract(last_error,'$.retryAt'),0) ELSE 0 END <= ?2
            AND NOT EXISTS (SELECT 1 FROM asset_lifecycle_outbox o WHERE o.asset_id=asset_authority_state.asset_id AND o.desired<>'normal')
            ORDER BY asset_id LIMIT ?1")?.query_map(params![if restricted { 5 } else { 25 }, chrono::Utc::now().timestamp()],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        Ok(candidates)
    }

    fn record_materialization_failure(&self, p: &AssetProjection, error: &LibraryError, now: chrono::DateTime<chrono::Utc>) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        let previous: Option<String> = connection.query_row(
            "SELECT last_error FROM asset_authority_state WHERE asset_id=?", [&p.asset_id], |r| r.get(0),
        )?;
        let previous = previous.as_deref().and_then(|raw| serde_json::from_str::<MaterializationFailure>(raw).ok());
        let attempts = previous.as_ref().map_or(1, |failure| failure.attempts.saturating_add(1));
        let integrity_attempts = if matches!(error, LibraryError::DuplicateOriginalCorrupt) {
            previous.as_ref().map_or(1, |failure| failure.integrity_attempts.saturating_add(1))
        } else {
            0
        };
        // An identity rejection (another local Asset owns this content) shows up as an
        // invalid response, either from the pre-download check or from ingestion's race check.
        let local_conflict = matches!(error, LibraryError::InvalidCloudResponse) && match p.sha256.as_deref() {
            Some(digest) => connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE content_hash=?1 AND id<>?2)",
                params![digest, p.asset_id], |r| r.get::<_, bool>(0),
            )?,
            None => false,
        };
        let persistent = local_conflict
            || integrity_attempts >= MATERIALIZATION_INTEGRITY_MAX_ATTEMPTS
            || matches!(error, LibraryError::InvalidCloudResponse | LibraryError::UnsupportedImage | LibraryError::CloudCaptureTooLarge);
        let delay = (MATERIALIZATION_RETRY_BASE_SECONDS * (1_i64 << attempts.saturating_sub(1).min(7)))
            .min(MATERIALIZATION_RETRY_MAX_SECONDS);
        let failure = MaterializationFailure {
            code: if local_conflict { LOCAL_HASH_CONFLICT } else if persistent { "identityOrIntegrityConflict" } else { "materializationRetry" }.into(),
            attempts,
            retry_at: if persistent { 0 } else { now.timestamp().saturating_add(delay) },
            at: now.to_rfc3339(),
            integrity_attempts,
        };
        connection.execute(
            "UPDATE asset_authority_state SET materialization=?1,last_error=?2
             WHERE asset_id=?3 AND entity_revision=?4 AND materialization='pending'",
            params![if persistent { "conflict" } else { "pending" }, serde_json::to_string(&failure).map_err(|_| LibraryError::InvalidCloudResponse)?, p.asset_id, p.entity_revision],
        )?;
        Ok(())
    }

    /// Re-queue assets parked behind a local duplicate that no longer exists (purged,
    /// retired or otherwise removed). Evaluated each pass, so every row-deleting path is covered.
    fn release_resolved_local_conflicts(&self) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE asset_authority_state SET materialization='pending',last_error=NULL
             WHERE materialization='conflict' AND lifecycle='normal'
             AND CASE WHEN json_valid(last_error) THEN json_extract(last_error,'$.code') ELSE NULL END = ?1
             AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.content_hash=asset_authority_state.sha256
                             AND a.id<>asset_authority_state.asset_id)",
            [LOCAL_HASH_CONFLICT],
        )?;
        Ok(())
    }

    /// Surface durable recovery trouble even on an idle pass or after restarting.
    pub(crate) fn asset_materialization_recovery_failure(&self) -> Result<Option<super::authority_pass::LaneFailure>, LibraryError> {
        let row: Option<(Option<String>, String)> = self.connection()?.query_row(
            "SELECT last_error,projection FROM asset_authority_state WHERE materialization='conflict' AND lifecycle='normal' ORDER BY asset_id LIMIT 1",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        row.map(|(error, raw)| {
            // Lifecycle-rejection evidence shares last_error. Even if it replaced
            // the materialization detail, the durable conflict must stay visible.
            let at = if let Some(failure) = error.as_deref().and_then(|raw| serde_json::from_str::<MaterializationFailure>(raw).ok()) {
                failure.at
            } else {
                serde_json::from_str::<AssetProjection>(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?.updated_at
            };
            Ok(super::authority_pass::LaneFailure { code: "identity_or_integrity_conflict", at })
        }).transpose()
    }
    fn materialize_candidates(
        &self,
        client: &CloudClient,
        token: &str,
        result: &mut AssetSyncResult,
        restricted: bool,
    ) -> Result<(), LibraryError> {
        self.release_resolved_local_conflicts()?;
        let candidates = self.pending_materializations(restricted)?;
        if !candidates.is_empty() {
        crate::activities::Job::run("server-downloads", "server_downloads", "파일 내려받기", None, |activity| {
        let total = candidates.len() as u64;
        for (index, raw) in candidates.into_iter().enumerate() {
            activity.progress(index as u64, None, Some(format!("{}개 남음", total - index as u64)));
            if crate::workload::is_restricted() && index >= 5 { break; }
            let p: AssetProjection =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            let outcome = self.materialize_asset(client, token, &p);
            match outcome {
                Ok(()) => result.materialized += 1,
                Err(error) => {
                    result.materialization_failures += 1;
                    self.record_materialization_failure(&p, &error, chrono::Utc::now())?;
                }
            }
        }
        Ok::<_, LibraryError>(())
        })?;
        }
        self.fetch_missing_asset_image_text(client, token, restricted)?;
        Ok(())
    }

    fn fetch_missing_asset_image_text(
        &self,
        client: &CloudClient,
        token: &str,
        restricted: bool,
    ) -> Result<(), LibraryError> {
        // Bound work per pass. Random order keeps stale flags returning 404 from
        // permanently blocking other missing rows behind a fixed first page.
        let projections: Vec<String> = {
            let db = self.connection()?;
            let mut query = db.prepare(
                "SELECT s.projection FROM asset_authority_state s
                 JOIN assets a ON a.id=s.asset_id
                 LEFT JOIN asset_image_text t ON t.asset_id=s.asset_id
                 WHERE s.lifecycle='normal' AND t.asset_id IS NULL
                   AND json_extract(s.projection,'$.hasImageText')=1
                 ORDER BY random() LIMIT ?1",
            )?;
            let rows = query.query_map([if restricted { 5 } else { 25 }], |row| row.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for raw in projections {
            let projection: AssetProjection =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            if let Err(error) =
                self.refresh_asset_image_text_with(&projection.asset_id, client, token)
            {
                // One request per candidate per sync pass; leave the cache intact on failure.
                eprintln!("asset image text {}: {error}", projection.asset_id);
            }
        }
        Ok(())
    }
    fn materialize_asset(
        &self,
        client: &CloudClient,
        token: &str,
        p: &AssetProjection,
    ) -> Result<(), LibraryError> {
        p.validate()?;
        let digest = p.sha256.clone().ok_or(LibraryError::InvalidCloudResponse)?;
        // Identity rejection remains in ingestion to catch races too. A known
        // local conflict is decided before any ticket request or original download.
        let conflict: bool = self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE content_hash=?1 AND id<>?2)",
            params![digest, p.asset_id], |r| r.get(0),
        )?;
        if conflict { return invalid(); }
        let size = p
            .size_bytes
            .filter(|size| *size > 0 && *size <= 512 * 1024 * 1024)
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let content = p
            .content_type
            .as_deref()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let extension = match content {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            "video/mp4" => "mp4",
            "video/webm" => "webm",
            _ => return invalid(),
        };
        // UUID-named local TEMP; no server-provided path is ever joined to the library.
        let directory = self.root().join("assets/.staging");
        fs::create_dir_all(&directory).map_err(|_| LibraryError::CloudCaptureStagingFailed)?;
        let file = tempfile::Builder::new()
            .prefix("authority-")
            .suffix(&format!(".{extension}"))
            .tempfile_in(&directory)
            .map_err(|_| LibraryError::CloudCaptureStagingFailed)?;
        let ticket = client.asset_request(
            &format!("/v1/library/assets/{}/media-ticket", p.asset_id),
            Some(&json!({"variant":"original"})),
            token,
        ).map_err(|error| {
            // A malformed ticket response can be a transient gateway/server error.
            // Only validated media/identity failures below are parked permanently.
            if matches!(error, LibraryError::InvalidCloudResponse) { LibraryError::CloudRequestUnavailable } else { error }
        })?;
        let download = RemoteCaptureDownloadTicket {
            method: "GET".into(),
            download_url: ticket["url"]
                .as_str()
                .ok_or(LibraryError::CloudRequestUnavailable)?
                .into(),
            required_headers: Default::default(),
        };
        let copied = client.download_capture_media(&download, file.path(), size).map_err(|error| {
            if matches!(error, LibraryError::InvalidCloudResponse) { LibraryError::CloudRequestUnavailable } else { error }
        })?;
        if copied != size {
            return Err(LibraryError::DuplicateOriginalCorrupt);
        }
        let identity = MaterializationIdentity {
            asset_id: p.asset_id.clone(),
            sha256: digest,
            size_bytes: size,
        };
        self.ingest_media_with_identity(
            IngestMediaRequest {
                source_path: file.path().to_owned(),
                classification_id: None,
                source_url: p.source_url.clone(),
                collected_at: p.collected_at.clone(),
                replace_duplicate_metadata: false,
                source_published_at: p.source_published_at.clone(),
                creator_name: p.creator_name.clone(),
                creator_handle: p.creator_handle.clone(),
                creator_url: None,
                import_source: if p.import_source.as_deref() == Some("favorite_cover") {
                    ImportSource::FavoriteCover
                } else {
                    ImportSource::BrowserExtension
                },
                import_batch_id: uuid::Uuid::new_v4().to_string(),
            },
            Some(&identity),
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "asset_authority_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "asset_authority_http_tests.rs"]
mod http_integration;
