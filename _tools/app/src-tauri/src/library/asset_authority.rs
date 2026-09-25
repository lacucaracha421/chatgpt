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
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSyncResult {
    pub adopted: bool,
    pub applied_changes: u32,
    pub materialized: u32,
    pub flushed: u32,
    pub stopped: bool,
    pub materialization_failures: u32,
}
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
        if old.lifecycle == "tombstoned" && p.lifecycle != "tombstoned" {
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
            "UPDATE asset_authority_state SET materialization='pending',last_error=NULL WHERE asset_id=?",
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
    db.execute("UPDATE asset_authority_state SET lifecycle=?,entity_revision=?,sha256=?,size_bytes=?,projection=?,materialization=CASE WHEN ? THEN materialization ELSE 'pending' END WHERE asset_id=?",params![p.lifecycle,p.entity_revision,p.sha256,p.size_bytes.map(|size|size as i64),serde_json::to_string(p).map_err(|_|LibraryError::InvalidCloudResponse)?,local.is_some(),p.asset_id])?;
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
        let client = CloudClient::new(
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
        let Some(remote) = status.domains.iter().find(|d| d.domain == "assets") else {
            if authority(&*self.connection()?)?.is_some() {
                return invalid();
            }
            return Ok(AssetSyncResult::default());
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
        let mut result = AssetSyncResult {
            adopted: true,
            ..Default::default()
        };
        let local = authority(&*self.connection()?)?;
        let need_baseline = local.as_ref().is_none_or(|l| {
            l.library != a.library || l.epoch != a.epoch || l.contract != a.contract
        });
        if need_baseline {
            self.install_asset_baseline(client, token, &a)?;
            result.applied_changes += 1;
        } else if skip_unchanged && local.as_ref().is_some_and(|l| l.cursor == a.cursor) {
            // The shared status proves the feed has nothing after the stored cursor.
        } else {
            let cursor = local.unwrap().cursor;
            match self.catch_up_assets(client, token, &a, cursor) {
                Ok(count) => result.applied_changes += count,
                Err(LibraryError::AssetAuthorityRejected { ref code, .. })
                    if matches!(
                        code.as_str(),
                        "cursorExpired" | "cursorAhead" | "baselineChanged"
                    ) =>
                {
                    self.install_asset_baseline(client, token, &a)?;
                    result.applied_changes += 1;
                }
                Err(e) => return Err(e),
            }
        }
        // Queued lifecycle writes require the publisher role; do not touch that credential on a clean queue.
        let pending: i64 = self.connection()?.query_row(
            "SELECT count(*) FROM asset_lifecycle_outbox",
            [],
            |r| r.get(0),
        )?;
        if pending > 0 {
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
    fn install_asset_baseline(
        &self,
        client: &CloudClient,
        token: &str,
        a: &Authority,
    ) -> Result<(), LibraryError> {
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
                let mut db = self.connection()?;
                let tx = db.transaction()?;
                // Keep byte-progress for identities present in both snapshots; replace confirmed rows only.
                for p in &all {
                    apply_baseline(&tx, p)?;
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
                        continue;
                    }
                    apply(&tx, &p)?;
                    tx.execute("UPDATE asset_lifecycle_outbox SET operation_id=?,expected_revision=?,status='pending',last_error=NULL WHERE sequence=?",params![uuid::Uuid::new_v4().to_string(),current_revision,seq])?;
                    tx.commit()?;
                }
                Err(LibraryError::AssetAuthorityRejected { code, .. }) => {
                    if !matches!(
                        code.as_str(),
                        "assetNotFound" | "lifecycleTransitionRefused" | "operationConflict"
                    ) {
                        // Not a definitive answer about this intent: the domain identity moved
                        // under this pass (the next pass's status check re-baselines and
                        // rebases the row), or the answer is uncoded / unknown (a misrouted
                        // or rolled-back server, a request-schema 422). The row keeps its
                        // exact operation and payload and is retried next pass; a server
                        // fault is never turned into lost user intent.
                        result.stopped = true;
                        return Ok(());
                    }
                    // The command handler's definitive coded rejections (server
                    // `asset_authority.apply_command`) end this intent, and lifecycle commands
                    // for different Assets are independent, so it must not stop the queue
                    // (review H3). The rejection carries no usable server state and no
                    // single-Asset read exists, so the Asset falls back to its confirmed
                    // replica state (kept current by the change feed) and the intent is
                    // dropped with a durable reason. Uncertain transport outcomes still keep
                    // the exact operation and payload for receipt retry (the arm below).
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
    }
    fn pending_materializations(&self, restricted: bool) -> Result<Vec<String>, LibraryError> {
        let candidates=self.connection()?.prepare("SELECT projection FROM asset_authority_state WHERE materialization='pending' AND lifecycle='normal' AND NOT EXISTS (SELECT 1 FROM asset_lifecycle_outbox o WHERE o.asset_id=asset_authority_state.asset_id AND o.desired<>'normal') ORDER BY asset_id LIMIT ?1")?.query_map([if restricted { 5 } else { 25 }],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        Ok(candidates)
    }
    fn materialize_candidates(
        &self,
        client: &CloudClient,
        token: &str,
        result: &mut AssetSyncResult,
        restricted: bool,
    ) -> Result<(), LibraryError> {
        let candidates = self.pending_materializations(restricted)?;
        for (index, raw) in candidates.into_iter().enumerate() {
            if crate::workload::is_restricted() && index >= 5 { break; }
            let p: AssetProjection =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            let outcome = self.materialize_asset(client, token, &p);
            match outcome {
                Ok(()) => result.materialized += 1,
                Err(error) => {
                    result.materialization_failures += 1;
                    let code = if matches!(error, LibraryError::InvalidCloudResponse) {
                        "identityOrIntegrityConflict"
                    } else {
                        "materializationRetry"
                    };
                    self.connection()?.execute(
                        "UPDATE asset_authority_state SET last_error=? WHERE asset_id=?",
                        params![code, p.asset_id],
                    )?;
                }
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
        )?;
        let download = RemoteCaptureDownloadTicket {
            method: "GET".into(),
            download_url: ticket["url"]
                .as_str()
                .ok_or(LibraryError::InvalidCloudResponse)?
                .into(),
            required_headers: Default::default(),
        };
        let copied = client.download_capture_media(&download, file.path(), size)?;
        if copied != size {
            return invalid();
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
                import_source: ImportSource::BrowserExtension,
                import_batch_id: uuid::Uuid::new_v4().to_string(),
            },
            Some(&identity),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;
    const ID: &str = "80000000-0000-4000-8000-000000000001";
    #[test]
    fn workload_materialization_cap_preserves_pending_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for n in 0..30 {
            library.connection().unwrap().execute("INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection) VALUES(?1,'normal',1,'{}')", [format!("id-{n:02}")]).unwrap();
        }
        assert_eq!(library.pending_materializations(true).unwrap().len(), 5);
        assert_eq!(library.pending_materializations(false).unwrap().len(), 25);
        assert_eq!(library.connection().unwrap().query_row("SELECT count(*) FROM asset_authority_state WHERE materialization='pending'", [], |r| r.get::<_, i64>(0)).unwrap(), 30);
    }
    fn media() -> Vec<u8> {
        let mut data = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut data, image::ImageFormat::Png)
            .unwrap();
        data.into_inner()
    }
    fn asset(bytes: &[u8]) -> AssetProjection {
        AssetProjection {
            asset_id: ID.into(),
            lifecycle: "normal".into(),
            entity_revision: 1,
            kind: Some("image".into()),
            object_key: Some("cloud/original".into()),
            content_type: Some("image/png".into()),
            size_bytes: Some(bytes.len() as u64),
            sha256: Some(
                Sha256::digest(bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect(),
            ),
            source_url: None,
            creator_name: None,
            creator_handle: None,
            collected_at: Some("2026-09-18T00:00:00Z".into()),
            source_published_at: None,
            import_source: Some("capture".into()),
            created_at: "2026-09-18T00:00:00Z".into(),
            updated_at: "2026-09-18T00:00:00Z".into(),
        }
    }
    fn setup() -> (tempfile::TempDir, Library, AssetProjection) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .set_cloud_settings(
                crate::cloud::models::CloudSyncConfig {
                    enabled: true,
                    api_base_url: Some("http://127.0.0.1:32146".into()),
                },
                true,
            )
            .unwrap();
        let p = asset(&media()); // Resolve identity before taking the library's non-reentrant DB lock.
        let id = library.library_id().unwrap();
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO asset_authority VALUES(1,?,1,1,0)", [id])
            .unwrap();
        apply(&tx, &p).unwrap();
        tx.commit().unwrap();
        drop(db);
        (temp, library, p)
    }
    fn ingest(library: &Library, p: &AssetProjection, bytes: &[u8]) -> Result<(), LibraryError> {
        let path = library.root().join("incoming.png");
        fs::write(&path, bytes).unwrap();
        library
            .ingest_media_with_identity(
                IngestMediaRequest {
                    source_path: path,
                    classification_id: None,
                    source_url: None,
                    collected_at: p.collected_at.clone(),
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::BrowserExtension,
                    import_batch_id: uuid::Uuid::new_v4().to_string(),
                },
                Some(&MaterializationIdentity {
                    asset_id: p.asset_id.clone(),
                    sha256: p.sha256.clone().unwrap(),
                    size_bytes: p.size_bytes.unwrap(),
                }),
            )
            .map(|_| ())
    }
    #[test]
    fn canonical_materialization_keeps_server_id_and_never_enqueues_upload() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        ingest(&library, &p, &media()).unwrap();
        assert_eq!(library.seed_cloud_backfill_queue().unwrap().seeded, 0);
        assert_eq!(
            library
                .seed_bounded_cloud_backfill(&[ID.into()])
                .unwrap()
                .newly_queued,
            0
        );
        assert_eq!(
            library.reconcile_cloud_backfill().unwrap().seeded_missing,
            0
        );
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            crate::cloud::queue::enqueue_asset_upsert(&tx, ID, "2026").unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT id FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            ID
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT materialization FROM asset_authority_state",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "complete"
        );
    }
    #[test]
    fn materialization_projects_deferred_organization_and_restore_preserves_it() {
        let (_temp, library, p) = setup();
        {
            let db = library.connection().unwrap();
            db.execute("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('class','root','Class','2026')",[]).unwrap();
            db.execute("INSERT INTO classification_authority_assignment_revisions VALUES(?,'class',1,'2026')",[ID]).unwrap();
            db.execute(
                "INSERT INTO albums(id,name,created_at) VALUES('album','Album','2026')",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO album_authority_membership_revisions VALUES('album',?,1,1,'2026')",
                [ID],
            )
            .unwrap();
        }
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id=?",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "class"
        );
        assert_eq!(
            db.query_row(
                "SELECT album_id FROM asset_albums WHERE asset_id=?",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "album"
        );
        assert_eq!(
            db.query_row("SELECT content_hash FROM assets WHERE id=?", [ID], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            p.sha256.unwrap()
        );
    }
    fn defer_character_series(library: &Library, auto_classify: bool) {
        let db = library.connection().unwrap();
        db.execute(
            "INSERT INTO classification_entries(id,kind,name,created_at) VALUES('series','root','Series','2026')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO character_series(classification_id,auto_classify) VALUES('series',?)",
            [auto_classify],
        )
        .unwrap();
        db.execute(
            "INSERT INTO classification_authority_assignment_revisions VALUES(?,'series',1,'2026')",
            [ID],
        )
        .unwrap();
    }

    #[test]
    fn materialization_enqueues_character_work_after_deferred_assignment_without_restarting_it() {
        let (_temp, library, p) = setup();
        defer_character_series(&library, true);
        ingest(&library, &p, &media()).unwrap();
        {
            let db = library.connection().unwrap();
            let job: (String, String, i64, String) = db
                .query_row(
                    "SELECT state,cause,generation,classification_ids FROM character_autotag_jobs WHERE asset_id=?",
                    [ID],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .expect("materialization must enqueue after projecting the series assignment");
            assert_eq!(job.0, "pending");
            assert_eq!(job.1, "ingestion");
            assert_eq!(job.2, 1);
            assert_eq!(
                serde_json::from_str::<Vec<String>>(&job.3).unwrap(),
                ["series"]
            );
            db.execute(
                "UPDATE character_autotag_jobs SET state='completed' WHERE asset_id=?",
                [ID],
            )
            .unwrap();
        }
        ingest(&library, &p, &media()).unwrap();
        let db = library.connection().unwrap();
        let job: (String, i64) = db
            .query_row(
                "SELECT state,generation FROM character_autotag_jobs WHERE asset_id=?",
                [ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(job, ("completed".into(), 1));
        for table in [
            "cloud_sync_queue",
            "classification_authority_outbox",
            "asset_lifecycle_outbox",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "materialization must not create outbound work in {table}"
            );
        }
    }

    #[test]
    fn materialization_retry_enqueues_character_work_when_assignment_arrives_after_bytes() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM character_autotag_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        defer_character_series(&library, true);
        ingest(&library, &p, &media()).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT state FROM character_autotag_jobs WHERE asset_id=?",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "pending"
        );
    }

    #[test]
    fn materialization_character_work_respects_series_opt_out_and_projected_trash() {
        for (auto_classify, lifecycle) in [(false, "normal"), (true, "trash")] {
            let (_temp, library, mut p) = setup();
            defer_character_series(&library, auto_classify);
            p.lifecycle = lifecycle.into();
            p.entity_revision = 2;
            apply(&library.connection().unwrap(), &p).unwrap();
            ingest(&library, &p, &media()).unwrap();
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT status FROM assets WHERE id=?", [ID], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                lifecycle
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM character_autotag_jobs", [], |r| r.get::<_, i64>(0)).unwrap(),
                0,
                "excluded images must not be queued: auto_classify={auto_classify}, lifecycle={lifecycle}"
            );
        }
    }

    #[test]
    fn invalid_materialization_is_not_half_registered_and_retries_safely() {
        let (_temp, library, mut p) = setup();
        p.sha256 = Some("f".repeat(64));
        assert!(ingest(&library, &p, &media()).is_err());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let p = asset(&media());
        ingest(&library, &p, &media()).unwrap();
    }
    #[test]
    fn trash_restore_and_logical_delete_keep_confirmed_revision_separate_from_intent() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(projection(&db, ID).unwrap().unwrap().entity_revision, 1);
        assert_eq!(projection(&db, ID).unwrap().unwrap().lifecycle, "normal");
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT status FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "normal"
        );
        drop(db);
        library.trash_assets(&[ID.into()]).unwrap();
        assert_eq!(library.empty_trash().unwrap().deleted_count, 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT desired FROM asset_lifecycle_outbox ORDER BY sequence DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "tombstoned"
        );
        // Two-phase purge: the row stays (hidden as purge pending) until acceptance.
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_purge_pending", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(projection(&db, ID).unwrap().is_some());
    }
    #[test]
    fn a_local_only_asset_trashes_without_authority_state_and_queues_no_command() {
        // The cutover case: authority is adopted but this Asset was never committed, so
        // it has no canonical projection. Trashing it is legitimate local intent, not an
        // error, and it must not fabricate a lifecycle command for a server that cannot
        // resolve the Asset.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_authority_state", [])
            .unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "trash"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "a server-unknown Asset must not emit a lifecycle command"
        );
    }

    /// A local-only Asset that never reached the server, as the production cutover has.
    fn insert_local_only(library: &Library, id: &str, status: &str, hash: char) {
        insert_local_only_from(library, id, status, hash, ID);
    }

    /// Clone a specific source row so the copy's unique identity columns differ.
    fn insert_local_only_from(library: &Library, id: &str, status: &str, hash: char, source_id: &str) {
        let db = library.connection().unwrap();
        let cols: Vec<String> = db
            .prepare("PRAGMA table_info(assets)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let select: Vec<String> = cols
            .iter()
            .map(|c| match c.as_str() {
                "id" => "? AS id".to_string(),
                "content_hash" => "? AS content_hash".to_string(),
                "relative_path" => "? AS relative_path".to_string(),
                "thumbnail_relative_path" => "? AS thumbnail_relative_path".to_string(),
                "status" => "? AS status".to_string(),
                _ => c.clone(),
            })
            .collect();
        db.execute(
            &format!(
                "INSERT INTO assets SELECT {} FROM assets WHERE id=?",
                select.join(",")
            ),
            params![id, hash.to_string().repeat(64), format!("assets/ff/{id}"),
                    format!("assets/ff/{id}-thumb"), status, source_id],
        )
        .unwrap();
    }

    #[test]
    fn a_local_only_trash_asset_restores_without_an_authority_command() {
        // Required case 1: restore must succeed locally and must not fail because the
        // server has no canonical row for the Asset.
        let (_temp, library, _) = setup();
        let id = "80000000-0000-4000-8000-0000000000cc";
        ingest(&library, &asset(&media()), &media()).unwrap();
        insert_local_only(&library, id, "trash", 'a');
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_authority_state WHERE asset_id<>?", [ID])
            .unwrap();
        library.restore_assets(&[id.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets WHERE id=?", [id], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "normal"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox WHERE asset_id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "no command may be sent for an Asset the server does not own"
        );
    }

    #[test]
    fn a_restored_local_only_asset_is_eligible_for_normal_replication() {
        // Required case 2: after restore it is an ordinary PC-created Asset again, so the
        // legacy upload lane must pick it up exactly as it would a fresh ingest.
        let (_temp, library, _) = setup();
        let id = "80000000-0000-4000-8000-0000000000dd";
        ingest(&library, &asset(&media()), &media()).unwrap();
        insert_local_only(&library, id, "trash", 'b');
        library.restore_assets(&[id.into()]).unwrap();
        assert!(library.seed_cloud_backfill_queue().unwrap().seeded >= 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT status FROM cloud_sync_queue WHERE entity_id=? AND operation='upsert'",
                [id], |r| r.get::<_, String>(0))
                .unwrap(),
            "pending"
        );
        assert!(!super::is_server_owned(&db, id).unwrap(),
                "the Asset is still locally owned until the server commits it");
    }

    #[test]
    fn a_local_only_trash_asset_purges_without_a_tombstone_command() {
        // Required cases 3 and 4: purge succeeds locally, and the queued upload work is
        // cancelled so the purged Asset cannot be published afterwards.
        let (_temp, library, _) = setup();
        let id = "80000000-0000-4000-8000-0000000000ee";
        ingest(&library, &asset(&media()), &media()).unwrap();
        insert_local_only(&library, id, "trash", 'c');
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES('q1','asset',?,'upsert','pending',1,'2026')",
                [id],
            )
            .unwrap();
        let purged = library.empty_trash().unwrap();
        assert!(purged.deleted_count >= 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets WHERE id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue WHERE entity_id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "queued upload work must be cancelled so purge cannot be undone"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox WHERE asset_id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn a_trashed_asset_racing_its_own_upload_keeps_the_trash_intent() {
        // Required case 5/6: the Asset is trashed locally while its upload is in flight,
        // and canonical `normal` arrives with no command ever sent. Adopting `normal`
        // would silently resurrect the user's trash.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        {
            let db = library.connection().unwrap();
            db.execute("DELETE FROM asset_authority_state", []).unwrap();
        }
        library.trash_assets(&[ID.into()]).unwrap();
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            apply(&tx, &p).unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox WHERE asset_id=? AND desired='trash'", [ID], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1,
            "the local trash must survive the server committing the Asset as normal"
        );
    }

    #[test]
    fn a_server_side_trash_is_adopted_even_after_a_local_trash() {
        // The mirror case: the local row already had canonical state, so an arriving
        // `trash` is the server's decision and must be adopted without fighting it.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        {
            let mut db = library.connection().unwrap();
            let mut trashed = p.clone();
            trashed.lifecycle = "trash".into();
            trashed.entity_revision = p.entity_revision + 1;
            let tx = db.transaction().unwrap();
            apply(&tx, &trashed).unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "trash"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "the server's own trash needs no command back"
        );
    }

    #[test]
    fn an_already_queued_command_is_not_duplicated_when_canonical_state_arrives() {
        // Response-loss shape: the command was accepted server-side but its reply was
        // lost, then canonical state arrives. The queued intent must not be rewritten
        // into a second command.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let before: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, 1);
        {
            let mut db = library.connection().unwrap();
            let mut normal = p.clone();
            normal.entity_revision = p.entity_revision + 5;
            let tx = db.transaction().unwrap();
            apply(&tx, &normal).unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            before,
            "a queued command already carries the intent; do not re-send it"
        );
    }

    #[test]
    fn the_production_cutover_shape_restores_purges_and_mixes_safely() {
        // Mirrors the real production cutover: authority adopted locally, 21 local trash
        // Assets with no canonical row, plus server-known trash Assets in the same
        // library. Every operation must work, and a mixed batch must not half-apply.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let local_only: Vec<String> = (0..21)
            .map(|i| format!("90000000-0000-4000-8000-0000000000{i:02x}"))
            .collect();
        for (i, id) in local_only.iter().enumerate() {
            // `content_hash` is UNIQUE, so each cloned row needs its own digest.
            insert_local_only(&library, id, "trash", char::from(b'a' + i as u8));
        }
        {
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM asset_authority_state", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1,
                "only the server-known Asset has canonical state, as in production"
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM assets WHERE status='trash'", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                22
            );
        }

        // A mixed batch: server-known Asset first, then a local-only one.
        library
            .restore_assets(&[ID.into(), local_only[0].clone()])
            .unwrap();
        {
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM assets WHERE status='normal'", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2,
                "the batch must apply to both Assets without aborting"
            );
            // No command may name a local-only Asset, at any revision.
            let queued: Vec<String> = db
                .prepare("SELECT DISTINCT asset_id FROM asset_lifecycle_outbox")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(queued, vec![ID.to_string()],
                       "only the server-known Asset may be named in a lifecycle command");
        }

        // Purge the remaining local-only trashes in one call. Their managed bytes must
        // actually go: the server will never run GC for an Asset it never committed, so
        // leaving the file behind would orphan it on disk permanently.
        let root = library.root().to_path_buf();
        let probe = root.join(format!("assets/ff/{}", local_only[1]));
        fs::create_dir_all(probe.parent().unwrap()).unwrap();
        fs::write(&probe, b"local-only-bytes").unwrap();
        let purged = library.empty_trash().unwrap();
        assert_eq!(purged.deleted_count, 20);
        assert!(purged.failed_asset_ids.is_empty());
        assert!(!probe.exists(),
                "a purged local-only Asset must not leave its bytes behind");
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue WHERE operation='upsert' AND status<>'synced'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "purged local-only Assets leave no upload work behind"
        );
    }

    #[test]
    fn a_server_owned_trash_asset_purge_keeps_sending_its_tombstone() {
        // The behaviour the mixed batch above must not regress: a server-known Asset
        // still retires through the authority outbox when purged.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox", [])
            .unwrap();
        let purged = library.empty_trash().unwrap();
        assert_eq!(purged.deleted_count, 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT desired FROM asset_lifecycle_outbox ORDER BY sequence DESC LIMIT 1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "tombstoned"
        );
    }

    #[test]
    fn a_mixed_batch_trashes_both_and_commands_only_the_server_known_asset() {
        // A batch that mixes a server-known Asset with a local-only one must not abort:
        // the old code failed the whole call on whichever Asset lacked a projection.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let local_only = "80000000-0000-4000-8000-0000000000bb";
        {
            let db = library.connection().unwrap();
            // Clone the ingested row, overriding only identity columns, so every other NOT
            // NULL column comes from the real schema instead of a hand-written list that
            // silently rots as the table grows.
            let cols: Vec<String> = db
                .prepare("PRAGMA table_info(assets)")
                .unwrap()
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let select: Vec<String> = cols
                .iter()
                .map(|c| match c.as_str() {
                    "id" => "? AS id".to_string(),
                    "content_hash" => "? AS content_hash".to_string(),
                    // The unique identity columns must differ from the source row.
                    "relative_path" => "? AS relative_path".to_string(),
                    "thumbnail_relative_path" => "? AS thumbnail_relative_path".to_string(),
                    _ => c.clone(),
                })
                .collect();
            db.execute(
                &format!("INSERT INTO assets SELECT {} FROM assets WHERE id=?", select.join(",")),
                params![local_only, "f".repeat(64),
                        format!("assets/ff/{local_only}"), format!("assets/ff/{local_only}-thumb"),
                        ID],
            )
            .unwrap();
        }
        library.trash_assets(&[ID.into(), local_only.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets WHERE status='trash'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let queued: Vec<String> = db
            .prepare("SELECT asset_id FROM asset_lifecycle_outbox ORDER BY asset_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(queued, vec![ID.to_string()],
                   "only the server-known Asset gets a command");
    }
    /// Every enqueue path must respect server ownership, not just the observed one.
    ///
    /// The `enqueue_asset_upsert` helper and the backfill seeders already refuse a
    /// server-owned Asset. `set_asset_classification` has its own direct INSERT for the
    /// legacy relation-only lane, so it is a separate path that can independently break
    /// the invariant. This covers it explicitly rather than trusting that the helper is
    /// the only writer.
    #[test]
    fn a_classification_mutation_never_uploads_a_server_owned_asset() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        // Legacy lane: Classification authority is NOT adopted, so the relation-only
        // upsert branch is live. Asset authority *is* adopted and owns this Asset.
        let classification = library
            .create_classification(crate::library::models::CreateClassification {
                kind: crate::library::models::ClassificationKind::Root,
                name: "fixture".into(),
                parent_id: None,
            })
            .unwrap();
        library
            .set_asset_classification(crate::library::models::SetAssetClassification {
                asset_ids: vec![ID.into()],
                classification_id: Some(classification.id.clone()),
            })
            .unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "a server-owned Asset must never be queued for media replication by a local classification change"
        );
    }

    /// The same guarantee for the other local-analysis lanes that normalize metadata.
    #[test]
    fn derived_local_analysis_never_uploads_a_server_owned_asset() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        // Similarity resolution and character automation both funnel through
        // `enqueue_asset_upsert`; drive it directly so this test owns the invariant
        // rather than one caller's incidental behavior.
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            crate::cloud::queue::enqueue_asset_upsert(&tx, ID, "2026").unwrap();
            crate::library::character_autotag::enqueue(
                &tx, ID, crate::library::character_autotag::Cause::Restore,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(library.seed_cloud_backfill_queue().unwrap().seeded, 0);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    /// The counter-case: a genuinely new locally-created Asset must still replicate.
    ///
    /// Suppressing every enqueue would satisfy the no-reupload invariant trivially while
    /// breaking the ordinary PC-created path, so this pins that the rule is scoped to
    /// server-owned Assets and not to "Assets that exist".
    #[test]
    fn a_locally_created_asset_still_queues_normal_replication() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .set_cloud_settings(
                crate::cloud::models::CloudSyncConfig {
                    enabled: true,
                    api_base_url: Some("http://127.0.0.1:32146".into()),
                },
                true,
            )
            .unwrap();
        let path = library.root().join("local.png");
        fs::write(&path, media()).unwrap();
        // No MaterializationIdentity: this is an ordinary local ingest, not a
        // server-owned Asset being materialized.
        library
            .ingest_media(IngestMediaRequest {
                source_path: path,
                classification_id: None,
                source_url: None,
                collected_at: Some("2026-09-18T00:00:00Z".into()),
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1,
            "an ordinary local Asset must still be replicated"
        );
    }

    /// `/v1/replication/commit` owns immutable media identity and provenance metadata,
    /// not user-owned fields, so a local title/favorite change has nothing to republish.
    /// This documents that boundary rather than assuming it.
    #[test]
    fn the_replication_contract_does_not_own_user_metadata() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.set_asset_favorite(ID, true).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT favorite FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        // A favorite is local-only, so it must not create replication work for a
        // server-owned Asset.
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    fn count(library: &Library, sql: &str) -> i64 {
        library
            .connection()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
    fn files(library: &Library) -> (std::path::PathBuf, std::path::PathBuf) {
        let db = library.connection().unwrap();
        let (original, thumbnail): (String, String) = db
            .query_row(
                "SELECT relative_path,thumbnail_relative_path FROM assets WHERE id=?",
                [ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        (library.root().join(original), library.root().join(thumbnail))
    }
    /// A server-known Asset whose trash the server already confirmed (revision 2).
    fn confirmed_trash(library: &Library, p: &AssetProjection) {
        let mut trashed = p.clone();
        trashed.lifecycle = "trash".into();
        trashed.entity_revision = 2;
        apply(&library.connection().unwrap(), &trashed).unwrap();
    }
    fn authority_of(library: &Library) -> Authority {
        authority(&library.connection().unwrap()).unwrap().unwrap()
    }
    /// Answer lifecycle commands in order; returns the command bodies received.
    fn command_server(
        responses: Vec<(u16, Value)>,
    ) -> (CloudClient, std::thread::JoinHandle<Vec<Value>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let worker = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for (status, body) in responses {
                let mut request = server
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.url(), "/v1/assets/authority/commands");
                let mut raw = String::new();
                request.as_reader().read_to_string(&mut raw).unwrap();
                let sent: Value = serde_json::from_str(&raw).unwrap();
                let body = if status == 200 {
                    let mut body = body;
                    body["operationId"] = sent["operationId"].clone();
                    body
                } else {
                    body
                };
                bodies.push(sent);
                request
                    .respond(
                        tiny_http::Response::from_string(body.to_string()).with_status_code(status),
                    )
                    .unwrap();
            }
            bodies
        });
        (client, worker)
    }
    fn accepted_tombstone(library: &Library, p: &AssetProjection, revision: i64) -> Value {
        let mut tombstoned = p.clone();
        tombstoned.lifecycle = "tombstoned".into();
        tombstoned.entity_revision = revision;
        json!({"libraryId":library.library_id().unwrap(),"epoch":1,"contractVersion":1,
               "commandType":"tombstoneAsset","changed":true,"asset":tombstoned})
    }
    fn revision_conflict(revision: i64, lifecycle: &str) -> Value {
        json!({"detail":{"code":"revisionConflict","assetId":ID,
               "currentEntityRevision":revision,"lifecycle":lifecycle}})
    }

    #[test]
    fn a_remote_trash_starts_the_retention_clock_at_adoption() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        // A stale timestamp on a normal row must never shorten the adopted retention.
        library
            .connection()
            .unwrap()
            .execute("UPDATE assets SET trashed_at='2020-01-01T00:00:00Z' WHERE id=?", [ID])
            .unwrap();
        let before = chrono::Utc::now();
        confirmed_trash(&library, &p);
        let trashed_at: String = library
            .connection()
            .unwrap()
            .query_row("SELECT trashed_at FROM assets WHERE id=?", [ID], |r| r.get(0))
            .unwrap();
        let adopted = chrono::DateTime::parse_from_rfc3339(&trashed_at).unwrap();
        assert!(adopted >= before - chrono::Duration::seconds(1));
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 1);
        // Default retention is 30 days, counted from adoption.
        let early = library
            .purge_expired_trash(before + chrono::Duration::days(29))
            .unwrap();
        assert_eq!(early.deleted_count, 0);
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 1);
        let due = library
            .purge_expired_trash(before + chrono::Duration::days(31))
            .unwrap();
        assert_eq!(due.deleted_count, 1);
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
        // Re-adopting the same trash keeps the first adoption time.
        confirmed_trash(&library, &p);
        let again: String = library
            .connection()
            .unwrap()
            .query_row("SELECT trashed_at FROM assets WHERE id=?", [ID], |r| r.get(0))
            .unwrap();
        assert_eq!(again, trashed_at);
    }

    #[test]
    fn a_remote_restore_restores_the_local_row() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        p.entity_revision = 3;
        apply(&library.connection().unwrap(), &p).unwrap();
        assert_eq!(
            count(&library, "SELECT count(*) FROM assets WHERE status='normal' AND trashed_at IS NULL"),
            1
        );
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
    }

    #[test]
    fn emptying_keeps_the_row_and_files_until_the_tombstone_is_accepted_then_deletes_both() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        assert!(original.is_file() && thumbnail.is_file());

        assert_eq!(library.empty_trash().unwrap().deleted_count, 1);
        // Hidden from the trash, but nothing is deleted before acceptance.
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NULL"), 1);
        assert!(original.is_file() && thumbnail.is_file());
        // A second empty/purge does not queue a second tombstone or restore the row.
        library.empty_trash().unwrap();
        assert!(library.restore_assets(&[ID.into()]).is_ok());
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"),
            1
        );
        // An unrelated sync touching the Asset before acceptance keeps it intact.
        confirmed_trash(&library, &p);
        assert!(original.is_file());
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 1);

        let (client, worker) = command_server(vec![(200, accepted_tombstone(&library, &p, 3))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent[0]["commandType"], "tombstoneAsset");
        assert_eq!(sent[0]["expectedEntityRevision"], 2);
        assert_eq!(result.flushed, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NOT NULL"), 1);

        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_crash_after_acceptance_finishes_file_deletion_on_the_next_start() {
        let (temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        library.empty_trash().unwrap();
        let (client, worker) = command_server(vec![(200, accepted_tombstone(&library, &p, 3))]);
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default())
            .unwrap();
        worker.join().unwrap();
        // "Crash": the process ends before the file step runs.
        drop(library);
        assert!(original.is_file() && thumbnail.is_file());
        let reopened = Library::open(temp.path()).unwrap();
        let summary = reopened.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert!(summary.failed_asset_ids.is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&reopened, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_crash_before_acceptance_leaves_the_asset_intact() {
        let (temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        library.empty_trash().unwrap();
        drop(library);
        let reopened = Library::open(temp.path()).unwrap();
        reopened.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert!(original.is_file() && thumbnail.is_file());
        assert_eq!(count(&reopened, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(
            count(&reopened, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"),
            1
        );
    }

    #[test]
    fn a_tombstone_that_loses_to_a_restore_is_dropped_and_the_asset_comes_back() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, _) = files(&library);
        library.empty_trash().unwrap();
        let (client, worker) = command_server(vec![(409, revision_conflict(3, "normal"))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 1, "the tombstone must not be re-sent");
        assert_eq!(result.applied_changes, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(
            count(&library, "SELECT count(*) FROM assets WHERE status='normal' AND trashed_at IS NULL"),
            1
        );
        assert!(original.is_file());
        assert_eq!(projection(&library.connection().unwrap(), ID).unwrap().unwrap().entity_revision, 3);
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(original.is_file());
    }

    #[test]
    fn a_restore_that_wins_after_an_old_build_removed_the_row_re_materializes_it() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        library.empty_trash().unwrap();
        // Older builds deleted the row as soon as the tombstone was queued.
        library
            .connection()
            .unwrap()
            .execute_batch("DELETE FROM asset_purge_pending; DELETE FROM assets;")
            .unwrap();
        let (client, worker) = command_server(vec![(409, revision_conflict(3, "normal"))]);
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default())
            .unwrap();
        worker.join().unwrap();
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_authority_state WHERE materialization='pending' AND lifecycle='normal'"),
            1
        );
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
    }

    #[test]
    fn a_tombstone_conflicting_with_a_newer_trash_rebases_and_then_purges() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, _) = files(&library);
        library.empty_trash().unwrap();
        let (client, worker) = command_server(vec![
            (409, revision_conflict(4, "trash")),
            (200, accepted_tombstone(&library, &p, 5)),
        ]);
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default())
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1]["commandType"], "tombstoneAsset");
        assert_eq!(sent[1]["expectedEntityRevision"], 4);
        assert_ne!(sent[0]["operationId"], sent[1]["operationId"]);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 0);
        library.delete_accepted_purge_files().unwrap();
        assert!(!original.exists());
    }

    fn remote_tombstone(library: &Library, p: &AssetProjection) {
        let mut tombstoned = p.clone();
        tombstoned.lifecycle = "tombstoned".into();
        tombstoned.entity_revision = 3;
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        apply(&tx, &tombstoned).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn a_tombstone_issued_elsewhere_deletes_this_pcs_own_files() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        remote_tombstone(&library, &p);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 0);
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NOT NULL"),
            1
        );
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
    }

    #[test]
    fn a_tombstone_issued_elsewhere_keeps_a_file_another_asset_references() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let (original, thumbnail) = files(&library);
        let other = "80000000-0000-4000-8000-0000000000aa";
        insert_local_only(&library, other, "normal", 'e');
        let shared: String = library
            .connection()
            .unwrap()
            .query_row("SELECT thumbnail_relative_path FROM assets WHERE id=?", [ID], |r| r.get(0))
            .unwrap();
        remote_tombstone(&library, &p);
        // Another remaining Asset names the same thumbnail file.
        library
            .connection()
            .unwrap()
            .execute("UPDATE assets SET thumbnail_relative_path=? WHERE id=?", params![shared, other])
            .unwrap();
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists(), "the Asset's own original goes");
        assert!(thumbnail.is_file(), "a file another Asset still names is kept");
    }

    #[test]
    fn a_crash_between_a_remote_tombstone_and_file_deletion_recovers_on_start() {
        let (temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let (original, thumbnail) = files(&library);
        remote_tombstone(&library, &p);
        // "Crash" before the file step.
        drop(library);
        assert!(original.is_file() && thumbnail.is_file());
        let reopened = Library::open(temp.path()).unwrap();
        assert!(reopened
            .purge_expired_trash(chrono::Utc::now())
            .unwrap()
            .failed_asset_ids
            .is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&reopened, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_purge_pending_asset_without_its_intent_is_settled_not_stranded() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        library.empty_trash().unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox", [])
            .unwrap();
        // Still trash on the server: the tombstone is re-queued, the row stays hidden.
        library.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"),
            1
        );
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
        // Restored on the server with the intent gone: the Asset comes back.
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox", [])
            .unwrap();
        let mut normal = p.clone();
        normal.entity_revision = 3;
        apply(&library.connection().unwrap(), &normal).unwrap();
        library.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
    }

    #[test]
    fn remote_trash_restore_tombstone_never_enqueue_and_old_receipt_replay_does_not_resurrect() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let mut db = library.connection().unwrap();
        for (revision, lifecycle) in [(2, "trash"), (3, "normal"), (4, "tombstoned")] {
            p.entity_revision = revision;
            p.lifecycle = lifecycle.into();
            let tx = db.transaction().unwrap();
            apply(&tx, &p).unwrap();
            tx.commit().unwrap();
        }
        p.entity_revision = 1;
        p.lifecycle = "normal".into();
        let tx = db.transaction().unwrap();
        apply(&tx, &p).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            projection(&db, ID).unwrap().unwrap().lifecycle,
            "tombstoned"
        );
    }

    const OTHER: &str = "80000000-0000-4000-8000-0000000000b2";
    /// A second server-known Asset (a clone of the ingested row with its own bytes).
    fn second_projection() -> AssetProjection {
        let mut other = asset(&media());
        other.asset_id = OTHER.into();
        other.sha256 = Some("b".repeat(64));
        other
    }
    fn second_asset(library: &Library, status: &str) -> AssetProjection {
        insert_local_only(library, OTHER, status, 'b');
        let mut other = second_projection();
        other.lifecycle = status.into();
        apply(&library.connection().unwrap(), &other).unwrap();
        other
    }
    /// Answer baseline reads with one complete page for `epoch`.
    fn baseline_server(
        library: &Library,
        epoch: i64,
        items: Vec<AssetProjection>,
    ) -> (CloudClient, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let body = json!({"libraryId":library.library_id().unwrap(),"epoch":epoch,"contractVersion":1,
                          "cursor":7,"items":items,"hasMore":false});
        let worker = std::thread::spawn(move || {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
                .unwrap();
            assert!(request.url().starts_with("/v1/assets/authority/baseline?"));
            request
                .respond(tiny_http::Response::from_string(body.to_string()))
                .unwrap();
        });
        (client, worker)
    }
    fn rebaseline(library: &Library, epoch: i64, items: Vec<AssetProjection>) {
        let (client, worker) = baseline_server(library, epoch, items);
        let mut a = authority_of(library);
        a.epoch = epoch;
        library.install_asset_baseline(&client, "token", &a).unwrap();
        worker.join().unwrap();
    }
    fn trash_accepted(library: &Library, p: &AssetProjection, revision: i64) -> Value {
        let mut trashed = p.clone();
        trashed.lifecycle = "trash".into();
        trashed.entity_revision = revision;
        json!({"libraryId":library.library_id().unwrap(),"epoch":1,"contractVersion":1,
               "commandType":"trashAsset","changed":true,"asset":trashed})
    }

    #[test]
    fn a_rebaseline_keeps_local_assets_it_does_not_list_and_requeues_their_upload() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        second_asset(&library, "trash");
        {
            let db = library.connection().unwrap();
            db.execute("INSERT INTO albums(id,name,created_at) VALUES('album','Album','2026')", []).unwrap();
            db.execute("INSERT INTO asset_albums(asset_id,album_id) VALUES(?,'album')", [ID]).unwrap();
            db.execute("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('class','root','Class','2026')", []).unwrap();
            db.execute("INSERT OR IGNORE INTO asset_classifications(asset_id,classification_id) VALUES(?,'class')", [ID]).unwrap();
            // Both were replicated before: the old queue rows say `synced`.
            for (n, id) in [ID, OTHER].iter().enumerate() {
                db.execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES(?,'asset',?,'upsert','synced',1,'2026')", params![format!("q{n}"), id]).unwrap();
            }
        }
        library.trash_assets(&[OTHER.into()]).unwrap();
        // A restored server authority backup that predates both Assets.
        rebaseline(&library, 2, vec![]);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 2, "no local Asset is deleted");
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE id='80000000-0000-4000-8000-000000000001' AND status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE id='80000000-0000-4000-8000-0000000000b2' AND status='trash'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_albums"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_classifications"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT epoch FROM asset_authority"), 2);
        assert_eq!(
            count(&library, "SELECT count(*) FROM cloud_sync_queue WHERE status='pending'"),
            2,
            "both get a fresh upload"
        );
        assert_eq!(
            count(&library, "SELECT count(*) FROM cloud_sync_queue WHERE status='synced'"),
            0,
            "no stale evidence that the server still holds them"
        );
        // Other domains now see the Asset as not yet on the server, so their relation
        // intents wait for the re-upload instead of being sent and refused.
        {
            use crate::library::album_authority::{asset_intent_readiness, AssetIntentReadiness};
            let db = library.connection().unwrap();
            assert!(asset_intent_readiness(&db, ID).unwrap() == AssetIntentReadiness::Wait);
        }
        // Only the normal Asset is uploadable; the trashed one waits until it is restored.
        let claimed = library.claim_next_backfill_for_test().unwrap().unwrap();
        assert_eq!(claimed.queue.entity_id, ID);
        assert!(library.claim_next_backfill_for_test().unwrap().is_none());
    }

    #[test]
    fn a_new_epoch_rebases_or_drops_queued_intents_instead_of_failing_every_pass() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        // Epoch 1: ID's trash is confirmed at r2 and a restore is queued; OTHER is
        // trashed and emptied (the purge replaces its queued trash with a tombstone).
        confirmed_trash(&library, &p);
        library.restore_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        library.empty_trash().unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 2);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 1);
        let old_ops: Vec<String> = library.connection().unwrap()
            .prepare("SELECT operation_id FROM asset_lifecycle_outbox").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        // Epoch 2 comes from an older backup: ID is trash at r1 (lower than confirmed),
        // OTHER is trash at r1.
        let mut id_trash = p.clone();
        id_trash.lifecycle = "trash".into();
        let mut other_trash = other.clone();
        other_trash.lifecycle = "trash".into();
        rebaseline(&library, 2, vec![id_trash, other_trash]);
        let rows: Vec<(String, String, i64, i64, String)> = library.connection().unwrap()
            .prepare("SELECT asset_id,desired,epoch,expected_revision,operation_id FROM asset_lifecycle_outbox ORDER BY sequence").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        // ID's restore is re-issued against the new baseline revision.
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2, rows[0].3), (ID, "normal", 2, 1));
        // OTHER's purge is re-issued against its new trash revision.
        assert_eq!((rows[1].0.as_str(), rows[1].1.as_str(), rows[1].2, rows[1].3), (OTHER, "tombstoned", 2, 1));
        assert!(rows.iter().all(|r| !old_ops.contains(&r.4)), "re-issued intents get new operation ids");
        assert_eq!(projection(&library.connection().unwrap(), ID).unwrap().unwrap().entity_revision, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 1);

        // A purge against an Asset the new baseline has as `normal` is dropped (restore wins).
        library.connection().unwrap()
            .execute("UPDATE asset_lifecycle_outbox SET epoch=1", []).unwrap();
        library.connection().unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox WHERE asset_id=?", [ID]).unwrap();
        library.connection().unwrap()
            .execute("UPDATE asset_authority SET epoch=1", []).unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"), 1);
        let mut other_normal = asset(&media());
        other_normal.asset_id = OTHER.into();
        other_normal.sha256 = Some("b".repeat(64));
        let mut id_normal = p.clone();
        id_normal.entity_revision = 1;
        rebaseline(&library, 3, vec![id_normal, other_normal]);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 2);
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_authority_state WHERE last_error='lifecycleRejected:epochChanged'"),
            1
        );
    }

    #[test]
    fn a_tombstone_conflict_at_the_head_is_adopted_and_later_intents_still_flush() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        // An older build parked this row; it must not stop the queue any more.
        library.connection().unwrap()
            .execute("UPDATE asset_lifecycle_outbox SET status='conflict' WHERE asset_id=?", [ID]).unwrap();
        let (client, worker) = command_server(vec![
            (409, revision_conflict(3, "tombstoned")),
            (200, trash_accepted(&library, &other, 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1]["assetId"], OTHER);
        assert!(!result.stopped);
        assert_eq!(result.flushed, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        let db = library.connection().unwrap();
        let state = projection(&db, ID).unwrap().unwrap();
        assert_eq!((state.lifecycle.as_str(), state.entity_revision), ("tombstoned", 3));
        assert_eq!(db.query_row("SELECT count(*) FROM assets WHERE id=?", [ID], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            db.query_row("SELECT last_error FROM asset_authority_state WHERE asset_id=?", [ID], |r| r.get::<_, String>(0)).unwrap(),
            "lifecycleRejected:assetTombstoned"
        );
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [OTHER], |r| r.get::<_, String>(0)).unwrap(), "trash");
    }

    #[test]
    fn a_refused_head_intent_falls_back_to_server_state_and_does_not_block() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        let (client, worker) = command_server(vec![
            (409, json!({"detail":{"code":"lifecycleTransitionRefused","assetId":ID}})),
            (200, trash_accepted(&library, &other, 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 2);
        assert!(!result.stopped);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        let db = library.connection().unwrap();
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [ID], |r| r.get::<_, String>(0)).unwrap(), "normal",
                   "the confirmed server state wins over the refused trash");
        assert_eq!(
            db.query_row("SELECT last_error FROM asset_authority_state WHERE asset_id=?", [ID], |r| r.get::<_, String>(0)).unwrap(),
            "lifecycleRejected:lifecycleTransitionRefused"
        );
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [OTHER], |r| r.get::<_, String>(0)).unwrap(), "trash");
    }

    #[test]
    fn an_asset_the_server_no_longer_knows_is_requeued_for_upload_not_blocking() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let (client, worker) = command_server(vec![(404, json!({"detail":{"code":"assetNotFound"}}))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 1, "the restore behind it is dropped with the Asset's server state");
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM cloud_sync_queue WHERE status='pending'"), 1);
    }

    /// The user already emptied this Asset from the trash; only the server's answer is pending.
    fn purge_pending(library: &Library, p: &AssetProjection) -> (std::path::PathBuf, std::path::PathBuf) {
        ingest(library, p, &media()).unwrap();
        confirmed_trash(library, p);
        let paths = files(library);
        library.connection().unwrap()
            .execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES('q','asset',?,'upsert','synced',1,'2026')", [ID]).unwrap();
        library.empty_trash().unwrap();
        assert_eq!(count(library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NULL"), 1);
        paths
    }
    fn assert_purge_finished_locally(library: &Library, original: &std::path::Path, thumbnail: &std::path::Path) {
        assert_eq!(count(library, "SELECT count(*) FROM assets"), 0, "a purged Asset never comes back");
        assert_eq!(count(library, "SELECT count(*) FROM cloud_sync_queue"), 0, "and is never re-uploaded");
        assert_eq!(count(library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NULL"), 0);
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(library, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_rebaseline_without_a_purge_pending_asset_finishes_the_purge_instead_of_uploading() {
        let (_temp, library, p) = setup();
        let (original, thumbnail) = purge_pending(&library, &p);
        rebaseline(&library, 2, vec![]);
        assert_purge_finished_locally(&library, &original, &thumbnail);
        // Once nothing local is left, a later baseline drops the stale state row.
        rebaseline(&library, 3, vec![]);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state"), 0);
    }

    #[test]
    fn asset_not_found_answering_a_purge_finishes_it_locally_instead_of_uploading() {
        let (_temp, library, p) = setup();
        let (original, thumbnail) = purge_pending(&library, &p);
        let (client, worker) = command_server(vec![(404, json!({"detail":{"code":"assetNotFound"}}))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap()[0]["commandType"], "tombstoneAsset");
        assert!(!result.stopped);
        assert_purge_finished_locally(&library, &original, &thumbnail);
    }

    #[test]
    fn an_uncoded_or_unknown_rejection_keeps_the_intent_and_retries_it_next_pass() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        for response in [
            (404, json!({"detail":"Not Found"})),
            (422, json!({"detail":[{"loc":["body"],"msg":"field required"}]})),
            (409, json!({"detail":{"code":"someFutureCode"}})),
        ] {
            let (client, worker) = command_server(vec![response]);
            let mut result = AssetSyncResult::default();
            library
                .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
                .unwrap();
            assert_eq!(worker.join().unwrap().len(), 1, "the pass stops at the head");
            assert!(result.stopped);
            assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 2);
            assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 2,
                       "a server fault never undoes the user's trash");
            assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state WHERE last_error IS NOT NULL"), 0);
        }
        let operation: String = library.connection().unwrap()
            .query_row("SELECT operation_id FROM asset_lifecycle_outbox ORDER BY sequence LIMIT 1", [], |r| r.get(0)).unwrap();
        let (client, worker) = command_server(vec![
            (200, trash_accepted(&library, &p, 2)),
            (200, trash_accepted(&library, &second_projection(), 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent[0]["operationId"], operation, "the retry presents the same operation");
        assert_eq!(result.flushed, 2);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
    }
}

#[cfg(test)]
mod http_integration {
    use super::*;
    #[test]
    #[ignore = "requires the isolated tests/asset_pc_fixture.py HTTP process, never production"]
    fn real_server_materialization_response_loss_and_lifecycle_converge_without_duplicate_upload() {
        let endpoint = std::env::var("LAKOMICS_ASSET_TEST_API").unwrap();
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        let publisher = std::env::var("LAKOMICS_ASSET_TEST_PUBLISHER").unwrap();
        let client = CloudClient::new(&endpoint).unwrap();
        let token = "asset-fixture-client";
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .connection()
            .unwrap()
            .execute("UPDATE library_settings SET library_id=?", ["e".repeat(32)])
            .unwrap();
        library
            .set_cloud_settings(
                crate::cloud::models::CloudSyncConfig {
                    enabled: true,
                    api_base_url: Some(endpoint),
                },
                true,
            )
            .unwrap();
        let first = library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        assert_eq!(first.materialized, 1);
        assert!(first.adopted);
        let id = library
            .connection()
            .unwrap()
            .query_row("SELECT asset_id FROM asset_authority_state", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        {
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT id FROM assets", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                id
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            db.execute("CREATE TABLE fixture_saved AS SELECT * FROM assets", [])
                .unwrap();
        }
        library.trash_assets(&[id.clone()]).unwrap();
        // The server accepted the immutable operation, but the PC lost the response.
        let body = {
            let db = library.connection().unwrap();
            let (op, rev): (String, i64) = db
                .query_row(
                    "SELECT operation_id,expected_revision FROM asset_lifecycle_outbox",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            db.execute("UPDATE asset_lifecycle_outbox SET status='sending'", [])
                .unwrap();
            json!({"libraryId":"e".repeat(32),"epoch":1,"contractVersion":1,"operationId":op,"commandType":"trashAsset","assetId":id,"expectedEntityRevision":rev})
        };
        client
            .asset_request("/v1/assets/authority/commands", Some(&body), &publisher)
            .unwrap();
        assert_eq!(
            library
                .sync_assets_with(&client, token, Some(&publisher), false)
                .unwrap()
                .flushed,
            1
        );
        let list = client
            .asset_request("/v1/library/assets", None, token)
            .unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 0);
        assert_eq!(
            client
                .asset_request(
                    &format!("/v1/assets/authority/status?libraryId={}", "e".repeat(32)),
                    None,
                    token
                )
                .unwrap()["cursor"],
            2
        );
        library.restore_assets(&[id.clone()]).unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        assert_eq!(
            client
                .asset_request("/v1/library/assets", None, token)
                .unwrap()["items"][0]["id"],
            id
        );
        library.trash_assets(&[id.clone()]).unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        library.empty_trash().unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        client
            .asset_request("/_fixture/prune", Some(&json!({})), token)
            .unwrap();
        // Simulate recovery of a previously-known stale normal Asset after history expired.
        {
            let db = library.connection().unwrap();
            db.execute("INSERT INTO assets SELECT * FROM fixture_saved", [])
                .unwrap();
            db.execute("UPDATE asset_authority SET cursor=0", [])
                .unwrap();
        }
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            projection(&db, &id).unwrap().unwrap().lifecycle,
            "tombstoned"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
