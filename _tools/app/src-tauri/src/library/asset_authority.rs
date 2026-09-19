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
    let target = lifecycle.or(confirmed);
    match target.as_deref() {
        Some("tombstoned") => {
            db.execute("DELETE FROM assets WHERE id=?", [id])?;
        }
        Some(status) => {
            db.execute("UPDATE assets SET status=?1,trashed_at=CASE WHEN ?1='trash' THEN COALESCE(trashed_at,?2) ELSE NULL END WHERE id=?3",params![status,chrono::Utc::now().to_rfc3339(),id])?;
        }
        None => {}
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
    local_projection(db, id)
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
        let result = self.sync_assets_with(&client, token.expose(), None);
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
    ) -> Result<AssetSyncResult, LibraryError> {
        let _single = self
            .asset_sync_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let status = client.sync_status(token)?;
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
        self.materialize_candidates(client, token, &mut result)?;
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
                if tx.query_row("SELECT EXISTS(SELECT 1 FROM asset_lifecycle_outbox WHERE library_id<>? OR epoch<>? OR contract_version<>?)",params![a.library,a.epoch,a.contract],|r|r.get::<_,bool>(0))?{return invalid();}
                let old = tx
                    .prepare("SELECT asset_id FROM asset_authority_state")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                for id in old {
                    if !seen.contains(&id) {
                        tx.execute("DELETE FROM assets WHERE id=?", [&id])?;
                    }
                }
                // Keep byte-progress for identities present in both snapshots; replace confirmed rows only.
                for p in &all {
                    apply(&tx, p)?;
                }
                let old = tx
                    .prepare("SELECT asset_id FROM asset_authority_state")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                for id in old {
                    if !seen.contains(&id) {
                        tx.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [id])?;
                    }
                }
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
            let row:Option<(i64,String,String,String,i64,String)>=self.connection()?.query_row("SELECT sequence,operation_id,asset_id,desired,expected_revision,status FROM asset_lifecycle_outbox ORDER BY sequence LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
            let Some((seq, operation, id, desired, expected, status)) = row else {
                return Ok(());
            };
            if status == "conflict" {
                result.stopped = true;
                return Ok(());
            }
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
                    apply(&tx, &p)?;
                    if lifecycle == "tombstoned" && desired != "tombstoned" {
                        tx.execute("UPDATE asset_lifecycle_outbox SET status='conflict',last_error='lifecycleTransitionRefused' WHERE sequence=?",[seq])?;
                        tx.commit()?;
                        result.stopped = true;
                        return Ok(());
                    }
                    tx.execute("UPDATE asset_lifecycle_outbox SET operation_id=?,expected_revision=?,status='pending',last_error=NULL WHERE sequence=?",params![uuid::Uuid::new_v4().to_string(),current_revision,seq])?;
                    tx.commit()?;
                }
                Err(LibraryError::AssetAuthorityRejected { code, .. }) => {
                    // A coded rejection is definitive. Preserve intent and expose a durable blocked row;
                    // uncertain transport outcomes keep the exact operation and payload for receipt retry.
                    self.connection()?.execute("UPDATE asset_lifecycle_outbox SET status='conflict',last_error=? WHERE sequence=?",params![code,seq])?;
                    result.stopped = true;
                    return Ok(());
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
    fn materialize_candidates(
        &self,
        client: &CloudClient,
        token: &str,
        result: &mut AssetSyncResult,
    ) -> Result<(), LibraryError> {
        let candidates=self.connection()?.prepare("SELECT projection FROM asset_authority_state WHERE materialization='pending' AND lifecycle='normal' AND NOT EXISTS (SELECT 1 FROM asset_lifecycle_outbox o WHERE o.asset_id=asset_authority_state.asset_id AND o.desired<>'normal') ORDER BY asset_id LIMIT 25")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        for raw in candidates {
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
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
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
            .sync_assets_with(&client, token, Some(&publisher))
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
                .sync_assets_with(&client, token, Some(&publisher))
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
            .sync_assets_with(&client, token, Some(&publisher))
            .unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher))
            .unwrap();
        assert_eq!(
            client
                .asset_request("/v1/library/assets", None, token)
                .unwrap()["items"][0]["id"],
            id
        );
        library.trash_assets(&[id.clone()]).unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher))
            .unwrap();
        library.empty_trash().unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher))
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
            .sync_assets_with(&client, token, Some(&publisher))
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
