//! Dormant Collections authority replica. Confirmed revisions are never optimistic.
//! Every page and its checkpoint commit together. Core PC writes use the outbox;
//! later batches route or fence the remaining writers before activation.
use super::{error::LibraryError, Library};
use crate::cloud::client::{CloudClient, CollectionDelivery, SyncStatus};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::path::{Component, Path};

const SECTIONS: &[&str] = &[
    "works",
    "bindings",
    "artworks",
    "volumes",
    "volumeSources",
    "ownership",
    "memberships",
];
const PAGE_BUDGET: usize = 20;
const COMMANDS: &[&str] = &[
    "createWork",
    "updateWork",
    "deleteWork",
    "restoreWork",
    "purgeWork",
    "purgeExpiredTrash",
    "setShowcaseOrder",
    "bindProvider",
    "unbindProvider",
    "applyProviderSnapshot",
    "addArtwork",
    "selectArtwork",
    "upsertVolume",
    "upsertVolumeSource",
    "setVolumeOwnership",
    "setMembership",
    "setOwnershipTracking",
    "setReleaseSubscription",
    "setVolumeRange",
    "recordReleaseEvent",
    "acknowledgeReleaseEvents",
];

#[derive(Clone, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionAuthorityStatus {
    pub active: bool,
    #[serde(default)]
    pub library_id: Option<String>,
    #[serde(default)]
    pub epoch: Option<i64>,
    #[serde(default)]
    pub contract_version: Option<i64>,
    #[serde(default)]
    pub cursor: Option<i64>,
}

impl CollectionAuthorityStatus {
    fn identity(&self, db: &Connection) -> Result<Option<Identity>, LibraryError> {
        if !self.active {
            return Ok(None);
        }
        let id = Identity {
            library: self
                .library_id
                .clone()
                .ok_or(LibraryError::InvalidCloudResponse)?,
            epoch: self
                .epoch
                .filter(|e| *e >= 1)
                .ok_or(LibraryError::InvalidCloudResponse)?,
            version: self
                .contract_version
                .filter(|v| *v == 1)
                .ok_or(LibraryError::CollectionAuthorityMismatch)?,
            cursor: self
                .cursor
                .filter(|v| *v >= 0)
                .ok_or(LibraryError::InvalidCloudResponse)?,
        };
        if id.library != super::library_id_on(db)? {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        Ok(Some(id))
    }
}

#[derive(Clone, Debug)]
struct Identity {
    library: String,
    epoch: i64,
    version: i64,
    cursor: i64,
}
#[derive(Debug)]
struct Local {
    id: Identity,
    adopted: bool,
    snapshot: Option<i64>,
    section: usize,
    after: Option<String>,
    count: i64,
    manifest: Value,
    generation: String,
}

fn local(db: &Connection) -> Result<Option<Local>, LibraryError> {
    let raw = db.query_row("SELECT library_id,epoch,contract_version,cursor,adopted,snapshot_cursor,baseline_section,baseline_after,baseline_count,manifest,generation FROM collection_authority_sync WHERE singleton=1", [], |r| {
        Ok((Identity { library:r.get(0)?, epoch:r.get(1)?, version:r.get(2)?, cursor:r.get(3)? },
            r.get::<_,bool>(4)?,r.get::<_,Option<i64>>(5)?,r.get::<_,i64>(6)? as usize,r.get::<_,Option<String>>(7)?,
            r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,String>(10)?))
    }).optional()?;
    raw.map(
        |(id, adopted, snapshot, section, after, count, manifest, generation)| {
            Ok(Local {
                id,
                adopted,
                snapshot,
                section,
                after,
                count,
                manifest: serde_json::from_str(manifest.as_deref().unwrap_or("null"))
                    .map_err(|_| LibraryError::InvalidCloudResponse)?,
                generation,
            })
        },
    )
    .transpose()
}

fn same(a: &Identity, b: &Identity) -> bool {
    a.library == b.library && a.epoch == b.epoch && a.version == b.version
}
fn envelope(value: &Value, id: &Identity) -> Result<(), LibraryError> {
    if value["libraryId"] != id.library
        || value["epoch"] != id.epoch
        || value["contractVersion"] != id.version
    {
        return Err(LibraryError::CollectionAuthorityMismatch);
    }
    Ok(())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, LibraryError> {
    v[key].as_str().ok_or(LibraryError::InvalidCloudResponse)
}
fn integer(v: &Value, key: &str) -> Result<i64, LibraryError> {
    v[key].as_i64().ok_or(LibraryError::InvalidCloudResponse)
}
fn boolean(v: &Value, key: &str) -> Result<bool, LibraryError> {
    v[key].as_bool().ok_or(LibraryError::InvalidCloudResponse)
}
fn optional_json(v: &Value) -> Option<String> {
    (!v.is_null()).then(|| v.to_string())
}
fn sql_value(v: &Value) -> Result<rusqlite::types::Value, LibraryError> {
    use rusqlite::types::Value as S;
    Ok(match v {
        Value::Null => S::Null,
        Value::String(s) => S::Text(s.clone()),
        Value::Bool(b) => S::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                S::Integer(i)
            } else {
                S::Real(n.as_f64().ok_or(LibraryError::InvalidCloudResponse)?)
            }
        }
        _ => return Err(LibraryError::InvalidCloudResponse),
    })
}
fn safe_id(s: &str) -> Result<&str, LibraryError> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(s)
}
fn key(section: &str, v: &Value) -> Result<String, LibraryError> {
    let w = || text(v, "workId");
    Ok(match section {
        "works" => json!([w()?]),
        "bindings" => json!([w()?, text(v, "provider")?]),
        "artworks" => json!([text(v, "artworkId")?]),
        "volumes" => json!([text(v, "volumeId")?]),
        "volumeSources" => json!([w()?, integer(v, "volumeNumber")?, text(v, "provider")?]),
        "ownership" => json!([
            w()?,
            integer(v, "volumeNumber")?,
            integer(v, "editionIndex")?
        ]),
        "memberships" => json!([w()?, text(v, "assetId")?]),
        _ => return Err(LibraryError::InvalidCloudResponse),
    }
    .to_string())
}

/// Later writers call this before touching shared data. An inactive library keeps
/// its legacy path; unknown/mismatched adopted identity never falls back to legacy.
pub(crate) fn ensure_collection_write_ready(
    db: &Connection,
    status: &CollectionAuthorityStatus,
) -> Result<bool, LibraryError> {
    let Some(id) = status.identity(db)? else {
        return if local(db)?.is_some() {
            Err(LibraryError::CollectionAuthorityMismatch)
        } else {
            Ok(false)
        };
    };
    match local(db)? {
        Some(l) if l.adopted && same(&id, &l.id) => Ok(true),
        _ => Err(LibraryError::CollectionAuthorityNotAdopted),
    }
}

/// The durable activation marker also fences edits while baseline adoption is pending.
pub(crate) fn collection_write_status(
    db: &Connection,
) -> Result<CollectionAuthorityStatus, LibraryError> {
    let state = local(db)?;
    let status = CollectionAuthorityStatus {
        active: state.is_some(),
        library_id: state.as_ref().map(|s| s.id.library.clone()),
        epoch: state.as_ref().map(|s| s.id.epoch),
        contract_version: state.as_ref().map(|s| s.id.version),
        cursor: state.as_ref().map(|s| s.id.cursor),
    };
    ensure_collection_write_ready(db, &status)?;
    Ok(status)
}

pub(crate) fn fence_collection_operation(db: &Connection) -> Result<(), LibraryError> {
    if local(db)?.is_some() {
        return Err(LibraryError::CollectionAuthorityOperationUnavailable);
    }
    Ok(())
}

pub(crate) fn collection_authority_active(db: &Connection) -> Result<bool, LibraryError> {
    Ok(local(db)?.is_some())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionTrashItem {
    work_id: String,
    r#type: String,
    name: String,
    trashed_at: String,
    purge_at: String,
    entity_revision: i64,
    #[serde(default)]
    restore_pending: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionTrashPage {
    library_id: String,
    epoch: i64,
    items: Vec<CollectionTrashItem>,
    has_more: bool,
}

fn pending_restore(db: &Connection, work: &str, revision: i64) -> Result<bool, LibraryError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM collection_authority_outbox o JOIN collection_authority_sync s ON s.singleton=1 AND o.library_id=s.library_id AND o.epoch=s.epoch AND o.contract_version=s.contract_version WHERE o.command_type='restoreWork' AND json_extract(o.payload,'$.workId')=?1 AND (o.state IN ('pending','blocked') OR (o.state='accepted' AND json_extract(o.payload,'$.expectedRevision')=?2)))",
        params![work, revision], |row| row.get(0),
    )?)
}

impl Library {
    pub(crate) fn list_collection_trash(&self) -> Result<CollectionTrashPage, LibraryError> {
        let status = collection_write_status(&*self.connection()?)?;
        if !status.active {
            return Err(LibraryError::CollectionAuthorityNotAdopted);
        }
        let config = self.cloud_sync_config()?;
        let client = self.cloud_client(
            config
                .api_base_url
                .as_deref()
                .ok_or(LibraryError::InvalidCloudSyncConfig)?,
        )?;
        let token = super::credential::read_cloud_api_token_os()?;
        self.list_collection_trash_with(&client, &token.expose())
    }

    fn list_collection_trash_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<CollectionTrashPage, LibraryError> {
        let status = collection_write_status(&*self.connection()?)?;
        let id = status
            .identity(&*self.connection()?)?
            .ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
        let value = client.collection_authority_read(&url_path("trash", &id, &[]), token)?;
        envelope(&value, &id)?;
        let mut page: CollectionTrashPage =
            serde_json::from_value(value).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let db = self.connection()?;
        // The read must still belong to the adopted identity after network I/O.
        let current = collection_write_status(&db)?
            .identity(&db)?
            .ok_or(LibraryError::CollectionAuthorityMismatch)?;
        if !same(&id, &current) {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        for item in &mut page.items {
            safe_id(&item.work_id)?;
            if item.entity_revision < 1
                || !matches!(item.r#type.as_str(), "game" | "manga" | "movie" | "av")
            {
                return Err(LibraryError::InvalidCloudResponse);
            }
            item.restore_pending = pending_restore(&db, &item.work_id, item.entity_revision)?;
        }
        Ok(page)
    }

    /// One trashed work's cached cover thumbnail, read on demand as raw bytes (never inlined in the list).
    pub(crate) fn collection_trash_cover(
        &self,
        work: &str,
    ) -> Result<Option<Vec<u8>>, LibraryError> {
        use std::io::Read;
        safe_id(work)?;
        let db = self.connection()?;
        let db = &*db;
        // Trashing removes the live artwork rows, but keeps their cached files.
        // Read an existing thumbnail only; never backfill/download media here.
        let raw: Option<String> = db.query_row("SELECT payload FROM collection_authority_revisions WHERE section='works' AND work_id=?1", [work], |row| row.get(0)).optional()?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let payload: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let path = if let Some(artwork) = payload["selection"]["work"].as_str() {
            safe_id(artwork)?;
            Some(format!("work-artwork-thumbnails/{work}/{artwork}.webp"))
        } else if let Some(asset) = payload["fields"]["coverAssetId"].as_str() {
            db.query_row(
                "SELECT thumbnail_relative_path FROM assets WHERE id=?1",
                [asset],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        } else {
            None
        };
        let Some(path) = path else {
            return Ok(None);
        };
        let Ok(media) = self.open_library_media(&path) else {
            return Ok(None);
        };
        const MAX_COVER_BYTES: u64 = 256 * 1024;
        if media.length > MAX_COVER_BYTES
            || !matches!(media.mime, "image/webp" | "image/png" | "image/jpeg")
        {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        if media
            .file
            .take(MAX_COVER_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_COVER_BYTES
        {
            return Ok(None);
        }
        Ok(Some(bytes))
    }

    pub(crate) fn restore_collection_work(
        &self,
        work: &str,
        revision: i64,
        library: &str,
        epoch: i64,
    ) -> Result<(), LibraryError> {
        safe_id(work)?;
        if revision < 1 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let status = collection_write_status(&tx)?;
        let id = status
            .identity(&tx)?
            .ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
        if id.library != library || id.epoch != epoch {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        if !pending_restore(&tx, work, revision)? {
            enqueue_collection_command(
                &tx,
                &status,
                "restoreWork",
                work,
                json!({"workId":work,"expectedRevision":revision}),
            )?;
        }
        // Keep the work in trash until the authority's receipt/change projects it.
        tx.commit()?;
        Ok(())
    }
}

/// Queue provider metadata and project its FIFO merge without changing confirmed revisions.
pub(crate) fn enqueue_provider_snapshot(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    work: &str,
    input: &super::models::ExternalBindingInput,
) -> Result<(), LibraryError> {
    use sha2::{Digest, Sha256};
    if !status.active {
        return Ok(());
    }
    let provider = input.provider.trim().to_ascii_lowercase();
    let parse = |raw: &Option<String>| -> Result<Value, LibraryError> {
        raw.as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| LibraryError::InvalidExternalBinding)
            .map(|v| v.unwrap_or(Value::Null))
    };
    let config = parse(&input.provider_config_json)?;
    let snapshot = parse(&input.provider_data_json)?;
    if !matches!(
        provider.as_str(),
        "mangadex" | "kakao" | "aladin" | "tmdb" | "igdb"
    ) || input.external_id.trim().is_empty()
        || (!config.is_null() && !config.is_object())
        || (!snapshot.is_null() && !snapshot.is_object())
    {
        return Err(LibraryError::InvalidExternalBinding);
    }
    let entity_key = json!([work, provider]).to_string();
    let mut base: Value = tx.query_row("SELECT payload FROM collection_authority_revisions WHERE section='bindings' AND entity_key=?1", [&entity_key], |r| r.get::<_,String>(0)).optional()?
        .map(|raw| serde_json::from_str(&raw)).transpose().map_err(|_| LibraryError::InvalidCloudResponse)?.unwrap_or(Value::Null);
    let mut revision = base["entityRevision"].as_i64().unwrap_or(0);
    // Earlier intents are immutable. Predict only their binding state/digest for FIFO CAS.
    let pending = tx.prepare("SELECT payload FROM collection_authority_outbox WHERE (entity_key=?1 OR (command_type='createWork' AND json_extract(payload,'$.workId')=?2)) AND state IN ('pending','blocked') ORDER BY seq")?
        .query_map(params![entity_key,work], |r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in pending {
        let body: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        match body["commandType"].as_str() {
            Some("createWork") if body["binding"]["provider"] == provider => {
                base = body["binding"].clone();
                base["bound"] = json!(true);
                base["snapshotDigest"] = snapshot_digest(&base["snapshot"]);
                revision = 1;
            }
            Some("bindProvider") => {
                if base["bound"] != true
                    || base["externalId"] != body["externalId"]
                    || base["config"] != body["config"]
                {
                    revision += 1;
                }
                if !base.is_object() {
                    base = json!({});
                }
                base["externalId"] = body["externalId"].clone();
                base["config"] = body["config"].clone();
                base["bound"] = json!(true);
            }
            Some("applyProviderSnapshot") => {
                revision += 1;
                if !base.is_object() {
                    base = json!({});
                }
                base["externalId"] = body["externalId"].clone();
                base["snapshot"] = body["snapshot"].clone();
                base["values"] = body["values"].clone();
                base["snapshotDigest"] =
                    json!(Sha256::digest(body["snapshot"].to_string().as_bytes())
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>());
            }
            _ => {}
        }
    }
    let external = input.external_id.trim();
    if base["bound"] != true || base["externalId"] != external || base["config"] != config {
        let expected_revision = if base["bound"] == true { revision } else { 0 };
        enqueue_collection_command(
            tx,
            status,
            "bindProvider",
            &entity_key,
            json!({"workId":work,"provider":provider,"externalId":external,"config":config,"expectedRevision":expected_revision}),
        )?;
    }
    if !snapshot.is_null() {
        let values = provider_snapshot_values(&provider, &snapshot)?;
        let details = provider_details(&provider, &snapshot);
        if base["externalId"] != external
            || base["snapshot"] != snapshot
            || base["values"] != values
        {
            let operation = enqueue_collection_command(
                tx,
                status,
                "applyProviderSnapshot",
                &entity_key,
                json!({"workId":work,"provider":provider,"externalId":external,"snapshot":snapshot,"values":values,"details":details,"baseSnapshotDigest":base["snapshotDigest"]}),
            )?;
            let retry_key = format!("collectionProviderRetry:{entity_key}");
            if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_state WHERE key=?1)",
                [&retry_key],
                |r| r.get::<_, bool>(0),
            )? {
                tx.execute("UPDATE collection_authority_outbox SET conflict_code='providerSnapshotRetry' WHERE operation_id=?1",[operation])?;
                tx.execute("DELETE FROM notes_state WHERE key=?1", [retry_key])?;
            }
        }
    }
    reapply_pending_core_edits(tx)?;
    Ok(())
}

fn snapshot_digest(snapshot: &Value) -> Value {
    use sha2::{Digest, Sha256};
    json!(Sha256::digest(snapshot.to_string().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>())
}

fn provider_snapshot_values(provider: &str, snapshot: &Value) -> Result<Value, LibraryError> {
    let mut values =
        crate::cloud::collections::collection_baseline::provider_values(provider, snapshot)?;
    if provider == "igdb" {
        let fallback = values["platforms"]
            .as_str()
            .map(|v| v.split(" · ").map(str::to_owned).collect::<Vec<_>>())
            .unwrap_or_default();
        let platforms = super::igdb_flow::ordered_igdb_platforms(&snapshot.to_string(), &fallback)?;
        values["platforms"] = if platforms.is_empty() {
            Value::Null
        } else {
            json!(platforms.join(" · "))
        };
    }
    Ok(values)
}

pub(crate) fn provider_details(provider: &str, snapshot: &Value) -> Value {
    if provider != "tmdb" {
        return Value::Null;
    }
    let series = snapshot.get("series").filter(|v| v.is_object()).and_then(|series| {
    let seasons = series.get("seasons").and_then(|s| s.as_array()).into_iter().flatten().map(|s| {
        let episodes: Vec<_> = s.get("episodes").and_then(|v| v.as_array()).into_iter().flatten().map(|e| serde_json::json!({"id":e["id"],"episodeNumber":e["episodeNumber"],"name":e["name"],"airDate":e["airDate"],"runtimeMinutes":e["runtimeMinutes"]})).collect();
        serde_json::json!({"id":s["id"],"seasonNumber":s["seasonNumber"],"name":s["name"],"airDate":s["airDate"],"posterArtworkId":s["posterArtworkId"],"episodes":episodes})
    }).collect::<Vec<_>>();
    Some(serde_json::json!({"status":series["status"],"cast":series.get("cast").cloned().unwrap_or(serde_json::json!([])),"seasons":seasons}))
    });
    let film = snapshot.get("film").filter(|v| v.is_object()).and_then(|film| {
    let rows = |key: &str, limit: usize| film.get(key).and_then(Value::as_array).into_iter().flatten().filter(|v| v.is_object()).take(limit).cloned().collect::<Vec<_>>();
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let cast: Vec<_> = rows("cast", 200).iter().filter(|c| c["name"].is_string()).map(|c| json!({"name":c["name"],"character":text(c,"character")})).collect();
    let releases: Vec<_> = rows("releases", 500).iter()
        .filter(|r| r["country"].is_string() && r["date"].is_string() && r["releaseType"].as_u64().is_some_and(|t| (1..=6).contains(&t)))
        .map(|r| json!({"country":r["country"],"releaseType":r["releaseType"],"date":r["date"],"certification":text(r,"certification")})).collect();
    let related = film.get("related").filter(|r| r.is_object() && r["collectionName"].is_string()).map(|related| {
        let parts: Vec<_> = related.get("parts").and_then(Value::as_array).into_iter().flatten()
            .filter(|p| p["movieId"].is_i64() && p["title"].is_string()).take(200)
            .map(|p| json!({"movieId":p["movieId"],"title":p["title"],"releaseDate":p["releaseDate"].as_str()})).collect();
        json!({"collectionName":related["collectionName"],"parts":parts})
    });
    Some(json!({"cast":cast,"releases":releases,"related":related}))
    });
    json!({"series":series,"film":film})
}

pub(crate) struct ProviderArtwork<'a> {
    pub image: &'a str,
    pub kind: &'a str,
    pub bytes: &'a [u8],
    pub select: bool,
    pub season: Option<i64>,
}

/// The extra byte signals an oversized image to the operation's skip/report path.
/// Stop reading there even if the provider serves an arbitrarily large body.
pub(crate) fn read_provider_artwork(reader: impl std::io::Read) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Pending identities are visible to follow-up actions (connect then artwork in
/// the existing IGDB dialog). Binding snapshots remain confirmed only.
pub(crate) fn provider_binding_state(
    db: &Connection,
    work: &str,
    provider: &str,
) -> Result<Option<(String, Option<String>, Option<String>)>, LibraryError> {
    let mut binding = db.query_row("SELECT external_id,last_synced_at,provider_data_json FROM collection_external_bindings WHERE collection_id=?1 AND provider=?2",params![work,provider],|r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))).optional()?;
    if !collection_authority_active(db)? {
        return Ok(binding);
    }
    let pending = db.prepare("SELECT payload FROM collection_authority_outbox WHERE state IN ('pending','blocked') AND json_extract(payload,'$.workId')=?1 ORDER BY seq")?.query_map([work], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in pending {
        let body: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let candidate = if body["commandType"] == "createWork" {
            &body["binding"]
        } else {
            &body
        };
        if candidate["provider"] != provider {
            continue;
        }
        match body["commandType"].as_str() {
            Some("unbindProvider") => binding = None,
            Some("createWork" | "bindProvider" | "applyProviderSnapshot") => {
                let previous = binding.take();
                binding = Some((
                    text(candidate, "externalId")?.to_owned(),
                    previous.as_ref().and_then(|b| b.1.clone()),
                    previous.and_then(|b| b.2),
                ));
            }
            _ => {}
        }
    }
    Ok(binding)
}

impl Library {
    /// Staging files and immutable commands commit as one durable operation.
    /// addArtwork delivery uses the existing upload and confirmation path.
    pub(crate) fn queue_provider_operation(
        &self,
        work: &str,
        new_name: Option<&str>,
        work_type: &str,
        input: Option<super::models::ExternalBindingInput>,
        artworks: &[ProviderArtwork<'_>],
        clears: &[&str],
    ) -> Result<super::models::CollectionSummary, LibraryError> {
        let provider_name = input
            .as_ref()
            .map(|v| v.provider.clone())
            .unwrap_or_else(|| {
                if work_type == "movie" {
                    "tmdb".into()
                } else {
                    "igdb".into()
                }
            });
        let provider = provider_name.as_str();
        let mut skipped = Vec::new();
        let mut prepared = Vec::new();
        for art in artworks {
            if art.bytes.len() > 16 * 1024 * 1024 {
                skipped.push(art.image.to_owned());
                continue;
            }
            match self.prepare_work_artwork(work, art.bytes) {
                Ok(image) => prepared.push((art, image)),
                // The legacy IGDB gallery import skips a broken screenshot while
                // selected cover/hero preparation errors still abort atomically.
                Err(_) if art.kind == "screenshot" && !art.select => {
                    skipped.push(art.image.to_owned())
                }
                Err(error) => return Err(error),
            }
        }
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let status = collection_write_status(&tx)?;
        if !status.active {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        let mut input = input;
        if let Some(name) = new_name {
            let name = super::collection::normalized_name(name.to_owned())?;
            let binding = input.as_ref().ok_or(LibraryError::InvalidExternalBinding)?;
            let snapshot: Value = serde_json::from_str(
                binding
                    .provider_data_json
                    .as_deref()
                    .ok_or(LibraryError::InvalidExternalBinding)?,
            )
            .map_err(|_| LibraryError::InvalidExternalBinding)?;
            let values = provider_snapshot_values(provider, &snapshot)?;
            let mut fields = values.clone();
            fields["year"] = json!(values["releaseDate"]
                .as_str()
                .and_then(|v| v.get(..4))
                .and_then(|v| v.parse::<i64>().ok()));
            let now = chrono::Utc::now().to_rfc3339();
            // Pending shell, as in normal authority-backed work creation.
            tx.execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",params![work,name,work_type,now]).map_err(super::collection::map_duplicate_name)?;
            let mut create = json!({"workId":work,"type":work_type,"name":name,"legacyKind":null,"fields":fields,"binding":{"provider":provider,"externalId":binding.external_id,"config":null,"snapshot":snapshot,"values":values,"details":provider_details(provider,&snapshot)}});
            // Leave envelope room and use the normal bind/snapshot commands below
            // for large imports. Even without a publisher, the shell can be created.
            if create.to_string().len() + 512 > COMMAND_BYTES_CLIENT {
                create["binding"] = Value::Null;
                create["fields"] = json!({});
            }
            enqueue_collection_command(&tx, &status, "createWork", work, create)?;
        } else {
            let collection = super::collection::collection_by_id(&tx, work)?;
            if (work_type == "movie"
                && collection.collection_type != super::models::CollectionType::Movie)
                || (work_type == "game"
                    && collection.collection_type != super::models::CollectionType::Game)
            {
                return Err(LibraryError::InvalidCollectionType);
            }
        }
        let mut retained = std::collections::BTreeSet::new();
        for (art, image) in &prepared {
            let id = enqueue_artwork(
                &tx, &status, work, provider, art.image, art.kind, None, image,
            )?;
            if id == image.id {
                retained.insert(id.clone());
            }
            if art.select {
                enqueue_artwork_selection(&tx, &status, work, art.kind, Some(&id))?;
            }
            if let (Some(season), Some(binding)) = (art.season, input.as_mut()) {
                let mut snapshot: Value =
                    serde_json::from_str(binding.provider_data_json.as_deref().unwrap())
                        .map_err(|_| LibraryError::InvalidExternalBinding)?;
                if let Some(seasons) = snapshot["series"]["seasons"].as_array_mut() {
                    for row in seasons {
                        if row["id"] == season {
                            row["posterArtworkId"] = json!(id);
                        }
                    }
                }
                binding.provider_data_json = Some(snapshot.to_string());
            }
        }
        for kind in clears {
            enqueue_artwork_selection(&tx, &status, work, kind, None)?;
        }
        if let Some(input) = &input {
            enqueue_provider_snapshot(&tx, &status, work, input)?;
        }
        let mut result = super::collection::collection_by_id(&tx, work)?;
        result.skipped_provider_artwork = skipped;
        tx.commit()?;
        for (_, image) in prepared {
            if retained.contains(&image.id) {
                image.commit();
            }
        }
        Ok(result)
    }
}

pub(crate) fn enqueue_release_event(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    work: &str,
    provider: &str,
    kind: &str,
    volume: i64,
    previous: Option<&str>,
    current: Option<&str>,
    detected: &str,
) -> Result<(), LibraryError> {
    let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_authority_outbox WHERE command_type='recordReleaseEvent' AND entity_key=?1 AND state IN ('pending','blocked') AND json_extract(payload,'$.provider')=?2 AND json_extract(payload,'$.kind')=?3 AND json_extract(payload,'$.volumeNumber')=?4 AND json_extract(payload,'$.previousValue') IS ?5 AND json_extract(payload,'$.currentValue') IS ?6)",params![work,provider,kind,volume,previous,current],|r|r.get(0))?;
    if duplicate {
        return Ok(());
    }
    enqueue_collection_command(
        tx,
        status,
        "recordReleaseEvent",
        work,
        json!({"workId":work,"eventId":uuid::Uuid::new_v4().to_string(),"provider":provider,"kind":kind,"volumeNumber":volume,"previousValue":previous,"currentValue":current,"detectedAt":detected}),
    )?;
    Ok(())
}

/// FIFO projection for ownership CAS, including count replacement before individual edits.
pub(crate) fn pending_ownership(
    db: &Connection,
    work: &str,
    edition: u8,
) -> Result<(bool, std::collections::BTreeMap<i64, (bool, bool, i64)>), LibraryError> {
    let mut tracked: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM collection_ownership_tracking WHERE collection_id=?1 AND edition_index=?2)",params![work,edition],|r|r.get(0))?;
    let mut rows = std::collections::BTreeMap::new();
    let confirmed=db.prepare("SELECT payload FROM collection_authority_revisions WHERE section='ownership' AND work_id=?1")?.query_map([work],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in confirmed {
        let v: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if v["editionIndex"] == edition {
            rows.insert(
                integer(&v, "volumeNumber")?,
                (
                    boolean(&v, "physical")?,
                    boolean(&v, "digital")?,
                    integer(&v, "entityRevision")?,
                ),
            );
        }
    }
    let pending=db.prepare("SELECT payload FROM collection_authority_outbox WHERE command_type IN ('setOwnershipTracking','setVolumeOwnership') AND state IN ('pending','blocked') ORDER BY seq")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in pending {
        let v: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if v["workId"] != work || v["editionIndex"] != edition {
            continue;
        }
        tracked = true;
        if v["commandType"] == "setOwnershipTracking" {
            let count = integer(&v, "count")?;
            for n in 1..=count {
                rows.entry(n).or_insert((false, false, 0));
            }
            for (&n, row) in rows.iter_mut() {
                let p = n <= count;
                if row.0 != p || row.1 {
                    row.2 += 1;
                }
                row.0 = p;
                row.1 = false;
            }
        } else {
            let row = rows
                .entry(integer(&v, "volumeNumber")?)
                .or_insert((false, false, 0));
            let p = boolean(&v, "physical")?;
            let d = boolean(&v, "digital")?;
            if (row.0, row.1) != (p, d) {
                row.2 += 1;
            }
            row.0 = p;
            row.1 = d;
        }
    }
    Ok((tracked, rows))
}

pub(crate) fn enqueue_release_ack(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    work: &str,
    ids: &[String],
) -> Result<(), LibraryError> {
    let mut desired: std::collections::BTreeSet<_> = ids.iter().cloned().collect();
    let pending=tx.prepare("SELECT payload FROM collection_authority_outbox WHERE command_type='acknowledgeReleaseEvents' AND entity_key=?1 AND state IN ('pending','blocked')")?.query_map([work],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in pending {
        let v: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        for id in v["eventIds"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?
        {
            if let Some(id) = id.as_str() {
                desired.remove(id);
            }
        }
    }
    let ids: Vec<_> = desired.into_iter().collect();
    for ids in ids.chunks(500) {
        enqueue_collection_command(
            tx,
            status,
            "acknowledgeReleaseEvents",
            work,
            json!({"workId":work,"eventIds":ids}),
        )?;
    }
    Ok(())
}

/// Read stored values, not summary fallback covers, for field-level compare-and-set.
pub(crate) fn editable_work(db: &Connection, work: &str) -> Result<Value, LibraryError> {
    db.query_row("SELECT name,description,cover_asset_id,year,original_title,runtime_minutes,author,director,developer,publisher,platforms,production_company,release_date,external_score,my_score,genres,overview,showcase,p.status,p.owned_platform FROM collections c LEFT JOIN collection_pc_records p ON p.collection_id=c.id WHERE c.id=?1", [work], |r| {
        Ok(json!({"name":r.get::<_,String>(0)?,"description":r.get::<_,Option<String>>(1)?,"coverAssetId":r.get::<_,Option<String>>(2)?,"year":r.get::<_,Option<i64>>(3)?,"originalTitle":r.get::<_,Option<String>>(4)?,"runtimeMinutes":r.get::<_,Option<i64>>(5)?,"author":r.get::<_,Option<String>>(6)?,"director":r.get::<_,Option<String>>(7)?,"developer":r.get::<_,Option<String>>(8)?,"publisher":r.get::<_,Option<String>>(9)?,"platforms":r.get::<_,Option<String>>(10)?,"productionCompany":r.get::<_,Option<String>>(11)?,"releaseDate":r.get::<_,Option<String>>(12)?,"externalScore":r.get::<_,Option<i64>>(13)?,"myScore":r.get::<_,Option<f64>>(14)?,"genres":r.get::<_,Option<String>>(15)?,"overview":r.get::<_,Option<String>>(16)?,"showcase":r.get::<_,bool>(17)?,"status":r.get::<_,Option<String>>(18)?,"ownedPlatform":r.get::<_,Option<String>>(19)?}))
    }).optional()?.ok_or(LibraryError::CollectionNotFound)
}

pub(crate) fn artwork_identity(provider: &str, kind: &str, image: &str, sha: &str) -> String {
    if provider == "local" {
        format!("sha256:{kind}:{sha}")
    } else if matches!(provider, "tmdb" | "igdb") {
        // A screenshot promoted to hero, or new bytes at the same provider path,
        // need another immutable record rather than changing the old kind/blob.
        format!("{image}:{kind}:{sha}")
    } else {
        image.to_owned()
    }
}

pub(crate) fn local_artwork_by_hash(
    db: &Connection,
    work: &str,
    kind: &str,
    sha: &str,
) -> Result<Option<String>, LibraryError> {
    let image = artwork_identity("local", kind, "", sha);
    db.query_row("SELECT a.id FROM collection_work_artworks a WHERE a.collection_id=?1 AND a.provider='local' AND a.kind=?2 AND (a.provider_image_id=?3 OR EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='artworks' AND r.deleted=0 AND json_extract(r.payload,'$.artworkId')=a.id AND json_extract(r.payload,'$.original.sha256')=?4)) ORDER BY a.id LIMIT 1",params![work,kind,image,sha],|r|r.get(0)).optional().map_err(Into::into)
}

pub(crate) fn enqueue_artwork(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    work: &str,
    provider: &str,
    image: &str,
    kind: &str,
    language: Option<&str>,
    prepared: &super::work_artwork::PreparedWorkArtwork,
) -> Result<String, LibraryError> {
    if prepared.original.size_bytes > 16 * 1024 * 1024 {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    if provider == "local" {
        if let Some(id) = local_artwork_by_hash(tx, work, kind, &prepared.original.sha256)? {
            return Ok(id);
        }
    }
    let image = artwork_identity(provider, kind, image, &prepared.original.sha256);
    let existing: Option<String> = tx.query_row(
        "SELECT id FROM collection_work_artworks WHERE collection_id=?1 AND provider=?2 AND provider_image_id=?3",
        params![work, provider, image], |r| r.get(0),
    ).optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,language,selected,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?11)",
        params![prepared.id,work,provider,image,kind,prepared.relative_path,prepared.mime_type,prepared.width,prepared.height,language,now])?;
    enqueue_collection_command(
        tx,
        status,
        "addArtwork",
        &prepared.id,
        json!({
            "workId":work,"artworkId":prepared.id,"kind":kind,"provider":provider,
            "providerImageId":image,"width":prepared.width,"height":prepared.height,
            "language":language,"original":prepared.original,"thumbnail":null
        }),
    )?;
    Ok(prepared.id.clone())
}

fn selection_slot(kind: &str) -> Result<&str, LibraryError> {
    match kind {
        "cover" | "volume_cover" => Ok("work"),
        "hero" | "backdrop" | "spine" | "back" => Ok(kind),
        _ => Err(LibraryError::InvalidWorkArtwork),
    }
}

fn artwork_slot(db: &Connection, work: &str, slot: &str) -> Result<Option<String>, LibraryError> {
    db.query_row("SELECT id FROM collection_work_artworks WHERE collection_id=?1 AND selected=1 AND (kind=?2 OR (?2='work' AND kind IN ('cover','volume_cover'))) ORDER BY id LIMIT 1",params![work,slot],|r|r.get(0)).optional().map_err(Into::into)
}

fn project_selection(
    tx: &Transaction<'_>,
    work: &str,
    slot: &str,
    art: Option<&str>,
) -> Result<(), LibraryError> {
    tx.execute("UPDATE collection_work_artworks SET selected=(id IS ?3) WHERE collection_id=?1 AND (kind=?2 OR (?2='work' AND kind IN ('cover','volume_cover')))",params![work,slot,art])?;
    Ok(())
}

pub(crate) fn enqueue_artwork_selection(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    work: &str,
    kind: &str,
    art: Option<&str>,
) -> Result<(), LibraryError> {
    let slot = selection_slot(kind)?;
    if let Some(art) = art {
        let belongs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collection_work_artworks WHERE id=?1 AND collection_id=?2 AND kind=?3)",params![art,work,kind],|r|r.get(0))?;
        if !belongs {
            return Err(LibraryError::InvalidWorkArtwork);
        }
    }
    let current = artwork_slot(tx, work, slot)?;
    if current.as_deref() == art {
        return Ok(());
    }
    enqueue_collection_command(
        tx,
        status,
        "selectArtwork",
        work,
        json!({"workId":work,"slot":slot,"artworkId":art,"expectedArtworkId":current}),
    )?;
    project_selection(tx, work, slot, art)
}

pub(crate) fn volume_state(db: &Connection, id: &str) -> Result<Value, LibraryError> {
    Ok(db.query_row("SELECT id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,source_provider,source_cover_id FROM collection_volumes WHERE id=?1",[id],|r| {
        let n: i64 = r.get(2)?;
        let e: i64 = r.get(3)?;
        Ok(json!({"volumeId":r.get::<_,String>(0)?,"workId":r.get::<_,String>(1)?,"volumeNumber":n,"editionIndex":e,"sortOrder":r.get::<_,i64>(4)?,"displayLabel":if e==0 {n.to_string()} else {format!("{n}.{e}")},"coverArtworkId":r.get::<_,Option<String>>(5)?,"sourceProvider":r.get::<_,Option<String>>(6)?,"sourceCoverId":r.get::<_,Option<String>>(7)?,"deleted":false}))
    }).optional()?.unwrap_or(Value::Null))
}

pub(crate) fn volume_slot_state(
    db: &Connection,
    work: &str,
    number: i64,
    edition: u8,
) -> Result<Value, LibraryError> {
    let id: Option<String> = db.query_row("SELECT id FROM collection_volumes WHERE collection_id=?1 AND volume_number=?2 AND edition_index=?3",params![work,number,edition],|r|r.get(0)).optional()?;
    match id {
        Some(id) => volume_state(db, &id),
        None => Ok(Value::Null),
    }
}

pub(crate) fn enqueue_volume_changes(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    before: &Value,
    after: Value,
) -> Result<(), LibraryError> {
    if status.active && *before != after {
        let id = text(&after, "volumeId")?.to_owned();
        let mut body = after;
        body["expectedRevision"] = json!(predicted_collection_revision(
            tx,
            "volumes",
            &json!([id]).to_string()
        )?);
        enqueue_collection_command(tx, status, "upsertVolume", &id, body)?;
    }
    Ok(())
}

pub(crate) fn expected_volume_range(db: &Connection, work: &str) -> Result<Value, LibraryError> {
    let raw: Option<String> = db.query_row(
        "SELECT payload FROM collection_authority_revisions WHERE section='works' AND work_id=?1",
        [work], |r| r.get(0),
    ).optional()?;
    let confirmed: Value = raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| LibraryError::InvalidCloudResponse)?
        .unwrap_or(Value::Null);
    let mut expected = confirmed["derived"]
        .get("volumeRange")
        .cloned()
        .unwrap_or(json!({"minVolume":null,"maxVolume":null,"hideConnectionPrompt":false}));
    let pending: Option<String> = db.query_row(
        "SELECT payload FROM collection_authority_outbox WHERE state='pending' AND command_type='setVolumeRange' AND json_extract(payload,'$.workId')=?1 ORDER BY seq DESC LIMIT 1",
        [work], |r| r.get(0),
    ).optional()?;
    if let Some(raw) = pending {
        let body: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        for field in ["minVolume", "maxVolume", "hideConnectionPrompt"] {
            expected[field] = body[field].clone();
        }
    }
    Ok(expected)
}

pub(crate) fn project_volume_range(
    tx: &Transaction<'_>,
    work: &str,
    range: &Value,
    now: &str,
) -> Result<(), LibraryError> {
    if range["minVolume"].is_null()
        && range["maxVolume"].is_null()
        && range["hideConnectionPrompt"] == false
    {
        tx.execute(
            "DELETE FROM collection_volume_ranges WHERE collection_id=?1",
            [work],
        )?;
    } else {
        tx.execute("INSERT INTO collection_volume_ranges(collection_id,min_volume,max_volume,hide_connection_prompt,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(collection_id) DO UPDATE SET min_volume=excluded.min_volume,max_volume=excluded.max_volume,hide_connection_prompt=excluded.hide_connection_prompt,updated_at=excluded.updated_at",params![work,sql_value(&range["minVolume"])?,sql_value(&range["maxVolume"])?,boolean(range,"hideConnectionPrompt")?,now])?;
    }
    Ok(())
}

pub(crate) fn volume_source_state(
    db: &Connection,
    work: &str,
    number: i64,
    provider: &str,
) -> Result<Value, LibraryError> {
    let row: Option<(Value,String)> = db.query_row("SELECT provider_item_id,title,author,publisher,isbn13,publication_date,item_url,provider_data_json FROM collection_volume_sources WHERE collection_id=?1 AND volume_number=?2 AND provider=?3",params![work,number,provider],|r| {
        Ok((json!({"workId":work,"volumeNumber":number,"provider":provider,"providerItemId":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"author":r.get::<_,Option<String>>(2)?,"publisher":r.get::<_,Option<String>>(3)?,"isbn13":r.get::<_,Option<String>>(4)?,"publicationDate":r.get::<_,Option<String>>(5)?,"itemUrl":r.get::<_,Option<String>>(6)?,"deleted":false}),r.get(7)?))
    }).optional()?;
    if let Some((mut value, raw)) = row {
        value["data"] =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCollectionMetadata)?;
        Ok(value)
    } else {
        Ok(Value::Null)
    }
}

pub(crate) fn enqueue_volume_source_changes(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    before: &Value,
    mut after: Value,
) -> Result<(), LibraryError> {
    if status.active && *before != after {
        let entity_key = key("volumeSources", &after)?;
        after["expectedRevision"] = json!(predicted_collection_revision(
            tx,
            "volumeSources",
            &entity_key
        )?);
        enqueue_collection_command(tx, status, "upsertVolumeSource", &entity_key, after)?;
    }
    Ok(())
}

pub(crate) fn enqueue_work_changes(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    work: &str,
    before: &Value,
) -> Result<(), LibraryError> {
    if !status.active {
        return Ok(());
    }
    let after = editable_work(tx, work)?;
    let mut changes = serde_json::Map::new();
    let mut expected = serde_json::Map::new();
    for (field, value) in after.as_object().unwrap() {
        if before[field] != *value {
            changes.insert(field.clone(), value.clone());
            expected.insert(field.clone(), before[field].clone());
        }
    }
    if !changes.is_empty() {
        enqueue_collection_command(
            tx,
            status,
            "updateWork",
            work,
            json!({"workId":work,"changes":changes,"expected":expected,"expectedRevision":null}),
        )?;
    }
    Ok(())
}

/// Predict only revision-CAS commands; field updates use expected values instead.
pub(crate) fn predicted_collection_revision(
    db: &Connection,
    section: &str,
    entity_key: &str,
) -> Result<i64, LibraryError> {
    let revision: i64 = db.query_row("SELECT entity_revision FROM collection_authority_revisions WHERE section=?1 AND entity_key=?2", params![section,entity_key], |r| r.get(0)).optional()?.unwrap_or(0);
    let pending = db
        .prepare(
            "SELECT payload FROM collection_authority_outbox WHERE state='pending' ORDER BY seq",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let confirmed: Option<String> = db
        .query_row(
            "SELECT payload FROM collection_authority_revisions WHERE section=?1 AND entity_key=?2",
            params![section, entity_key],
            |r| r.get(0),
        )
        .optional()?;
    let mut state: Value = confirmed
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| LibraryError::InvalidCloudResponse)?
        .unwrap_or(Value::Null);
    let work: Option<String> = serde_json::from_str::<Vec<String>>(entity_key)
        .ok()
        .and_then(|v| v.first().cloned());
    let mut predicted = revision;
    let mut orders = std::collections::BTreeMap::<String, Value>::new();
    if section == "works" {
        let rows = db.prepare("SELECT payload FROM collection_authority_revisions WHERE section='works' AND deleted=0")?.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        for raw in rows {
            let value: Value =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            orders.insert(text(&value, "workId")?.to_owned(), value);
        }
    }
    for raw in pending {
        let body: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let command = body["commandType"].as_str().unwrap_or("");
        if section == "works" {
            if command == "createWork" {
                orders.insert(
                    text(&body, "workId")?.to_owned(),
                    json!({"type":body["type"],"showcase":false,"showcaseOrder":null}),
                );
            } else if command == "updateWork" {
                if let (Some(desired), Some(current)) = (
                    body["changes"]["showcase"].as_bool(),
                    orders.get(text(&body, "workId")?).cloned(),
                ) {
                    let order = if !desired {
                        Value::Null
                    } else if current["showcase"] == true {
                        current["showcaseOrder"].clone()
                    } else {
                        json!(orders
                            .values()
                            .filter(|v| v["type"] == current["type"])
                            .filter_map(|v| v["showcaseOrder"].as_i64())
                            .max()
                            .map_or(0, |n| n + 1))
                    };
                    let target = orders.get_mut(text(&body, "workId")?).unwrap();
                    target["showcase"] = json!(desired);
                    target["showcaseOrder"] = order;
                }
            } else if command == "deleteWork" {
                orders.remove(text(&body, "workId")?);
            }
        }
        if section == "works" && command == "setShowcaseOrder" {
            if let Some(order) = body["workIds"]
                .as_array()
                .and_then(|ids| ids.iter().position(|id| id.as_str() == work.as_deref()))
            {
                if state["showcaseOrder"] != json!(order) {
                    predicted += 1;
                    state["showcaseOrder"] = json!(order);
                }
            }
            for (order, id) in body["workIds"]
                .as_array()
                .ok_or(LibraryError::InvalidCloudResponse)?
                .iter()
                .enumerate()
            {
                if let Some(target) = id.as_str().and_then(|id| orders.get_mut(id)) {
                    target["showcaseOrder"] = json!(order);
                }
            }
        } else if section == "works"
            && matches!(command, "createWork" | "updateWork" | "deleteWork")
            && key("works", &body)? == entity_key
        {
            match command {
                "createWork" => {
                    predicted += 1;
                    state = json!({"fields":body["fields"],"name":body["name"],"showcase":false,"showcaseOrder":null,"lifecycle":"live"});
                }
                "updateWork" => {
                    let mut changed = false;
                    for (field, value) in body["changes"]
                        .as_object()
                        .ok_or(LibraryError::InvalidCloudResponse)?
                    {
                        let target = if matches!(field.as_str(), "name" | "showcase") {
                            &mut state[field]
                        } else {
                            &mut state["fields"][field]
                        };
                        changed |= *target != *value;
                        *target = value.clone();
                    }
                    if changed {
                        predicted += 1;
                    }
                    if body["changes"].get("showcase").is_some() {
                        state["showcaseOrder"] = orders
                            .get(text(&body, "workId")?)
                            .map_or(Value::Null, |v| v["showcaseOrder"].clone());
                    }
                }
                "deleteWork" => {
                    if state["lifecycle"] != "trashed" {
                        predicted += 1;
                        state["lifecycle"] = json!("trashed");
                    }
                }
                _ => {}
            }
        } else if section == "volumeSources"
            && command == "upsertVolumeSource"
            && key("volumeSources", &body)? == entity_key
        {
            let fields = [
                "providerItemId",
                "title",
                "author",
                "publisher",
                "isbn13",
                "publicationDate",
                "itemUrl",
                "data",
                "deleted",
            ];
            if fields.iter().any(|f| state[*f] != body[*f]) {
                predicted += 1;
            }
            state = body.clone();
        } else if section == "volumes"
            && command == "upsertVolume"
            && key("volumes", &body)? == entity_key
        {
            let fields = [
                "volumeNumber",
                "editionIndex",
                "sortOrder",
                "displayLabel",
                "coverArtworkId",
                "sourceProvider",
                "sourceCoverId",
                "deleted",
            ];
            if fields.iter().any(|f| state[*f] != body[*f]) {
                predicted += 1;
            }
            state = body.clone();
        } else if section == "memberships"
            && command == "setMembership"
            && key("memberships", &body)? == entity_key
        {
            if state["desiredState"].as_bool().unwrap_or(false)
                != body["desiredState"]
                    .as_bool()
                    .ok_or(LibraryError::InvalidCloudResponse)?
            {
                predicted += 1;
            }
            state = json!({"desiredState":body["desiredState"]});
        }
    }
    Ok(predicted)
}

pub(crate) fn optimistic_collection_trash(
    tx: &Transaction<'_>,
    work: &str,
) -> Result<(), LibraryError> {
    let payload: Option<String> = tx.query_row("SELECT payload FROM collection_authority_revisions WHERE section='works' AND work_id=?1",[work],|r|r.get(0)).optional()?;
    let mut value: Value = payload
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| LibraryError::InvalidCloudResponse)?
        .unwrap_or(json!({"workId":work}));
    let now = chrono::Utc::now().to_rfc3339();
    value["trashedAt"] = json!(now);
    value["lifecycle"] = json!("trashed");
    mark_trash(tx, &value, "trashed", &now)
}

fn mark_trash(
    tx: &Transaction<'_>,
    v: &Value,
    lifecycle: &str,
    now: &str,
) -> Result<(), LibraryError> {
    let at = v["trashedAt"].as_str().unwrap_or(now);
    let date =
        chrono::DateTime::parse_from_rfc3339(at).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let work = text(v, "workId")?;
    let snapshot = archive_local_work(tx, work)?;
    tx.execute("INSERT INTO collection_authority_trash(work_id,lifecycle,trashed_at,retain_until,payload,local_snapshot) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(work_id) DO UPDATE SET lifecycle=excluded.lifecycle,trashed_at=excluded.trashed_at,retain_until=excluded.retain_until,payload=excluded.payload",
        params![work,lifecycle,at,(date+chrono::Duration::days(30)).to_rfc3339(),v.to_string(),snapshot.to_string()])?;
    // SQLite cascades affect only the archived work's live projection. Library
    // Assets, other works, people and local files remain untouched.
    tx.execute("DELETE FROM collections WHERE id=?1", [work])?;
    Ok(())
}

// Capture every schema-owned Collection child, including local columns/worker
// tables, instead of maintaining a lossy hand-picked trash payload. BLOBs (person
// portraits) carry an explicit tag so SQLite types survive round trips.
fn archive_local_work(tx: &Transaction<'_>, work: &str) -> Result<Value, LibraryError> {
    use rusqlite::types::ValueRef;
    let tables=tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'collection_authority_%' ORDER BY name")?
        .query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    let mut snapshot = serde_json::Map::new();
    for table in tables {
        if !table
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let columns = tx
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let condition = if table == "collections" {
            "id=?1"
        } else if columns.iter().any(|c| c == "collection_id") {
            "collection_id=?1"
        } else if table == "collection_volume_cover_focus" {
            "volume_id IN (SELECT id FROM collection_volumes WHERE collection_id=?1)"
        } else if table == "collection_person_portraits" {
            "artwork_id IN (SELECT id FROM collection_work_artworks WHERE collection_id=?1)"
        } else {
            continue;
        };
        let mut statement = tx.prepare(&format!("SELECT * FROM {table} WHERE {condition}"))?;
        let mut rows = statement.query([work])?;
        let mut captured = Vec::new();
        while let Some(row) = rows.next()? {
            let mut values = serde_json::Map::new();
            for (i, column) in columns.iter().enumerate() {
                let value =
                    match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(std::str::from_utf8(s)
                            .map_err(|_| LibraryError::InvalidCloudResponse)?),
                        ValueRef::Blob(b) => json!({"blob":b}),
                    };
                values.insert(column.clone(), value);
            }
            captured.push(Value::Object(values));
        }
        if !captured.is_empty() {
            snapshot.insert(table, json!(captured));
        }
    }
    Ok(Value::Object(snapshot))
}

fn restore_local_work(tx: &Transaction<'_>, work: &str, name: &str) -> Result<(), LibraryError> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT local_snapshot FROM collection_authority_trash WHERE work_id=?1",
            [work],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let mut snapshot: Value =
        serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
    if let Some(rows) = snapshot
        .get_mut("collections")
        .and_then(Value::as_array_mut)
    {
        for row in rows {
            row["name"] = json!(name);
        }
    }
    let daily = tx
        .prepare("SELECT local_date,open_count FROM activity_daily WHERE entity_kind='collection'")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut remaining = snapshot
        .as_object()
        .cloned()
        .ok_or(LibraryError::InvalidCloudResponse)?;
    // Topological ordering from actual FKs restores bindings before subscriptions,
    // artworks before volumes/portraits, volumes before focus, and work before all.
    while !remaining.is_empty() {
        let names: Vec<_> = remaining.keys().cloned().collect();
        let mut progressed = false;
        for table in names {
            if !table
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err(LibraryError::InvalidCloudResponse);
            }
            let parents = tx
                .prepare(&format!("PRAGMA foreign_key_list({table})"))?
                .query_map([], |r| r.get::<_, String>(2))?
                .collect::<Result<Vec<_>, _>>()?;
            if parents
                .iter()
                .any(|p| p != &table && remaining.contains_key(p))
            {
                continue;
            }
            let rows = remaining.remove(&table).unwrap();
            for row in rows.as_array().ok_or(LibraryError::InvalidCloudResponse)? {
                let fields = row.as_object().ok_or(LibraryError::InvalidCloudResponse)?;
                let columns = fields.keys().cloned().collect::<Vec<_>>();
                if columns
                    .iter()
                    .any(|c| !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                let values = fields
                    .values()
                    .map(|v| {
                        if let Some(bytes) = v.get("blob").and_then(Value::as_array) {
                            Ok(rusqlite::types::Value::Blob(
                                bytes
                                    .iter()
                                    .map(|b| {
                                        b.as_u64()
                                            .filter(|n| *n <= 255)
                                            .map(|n| n as u8)
                                            .ok_or(LibraryError::InvalidCloudResponse)
                                    })
                                    .collect::<Result<Vec<_>, _>>()?,
                            ))
                        } else {
                            sql_value(v)
                        }
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                tx.execute(
                    &format!(
                        "INSERT INTO {table}({}) VALUES({})",
                        columns.join(","),
                        vec!["?"; columns.len()].join(",")
                    ),
                    rusqlite::params_from_iter(values),
                )?;
            }
            progressed = true;
        }
        if !progressed {
            return Err(LibraryError::InvalidCloudResponse);
        }
    }
    // Restoring a saved counter is not a new deliberate open. Undo only the
    // telemetry inserts caused by restore's activity rows in this transaction.
    tx.execute(
        "DELETE FROM activity_daily WHERE entity_kind='collection'",
        [],
    )?;
    for (date, count) in daily {
        tx.execute("INSERT INTO activity_daily(local_date,entity_kind,open_count) VALUES(?1,'collection',?2)",params![date,count])?;
    }
    tx.execute(
        "DELETE FROM collection_authority_trash WHERE work_id=?1",
        [work],
    )?;
    Ok(())
}

fn apply_work(tx: &Transaction<'_>, v: &Value, now: &str) -> Result<(), LibraryError> {
    let id = text(v, "workId")?;
    let lifecycle = text(v, "lifecycle")?;
    if !matches!(lifecycle, "live" | "trashed" | "tombstoned") {
        return Err(LibraryError::InvalidCloudResponse);
    }
    if lifecycle == "live" {
        restore_local_work(tx, id, text(v, "name")?)?;
    } else {
        return mark_trash(tx, v, lifecycle, now);
    }
    tx.execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,updated_at=excluded.updated_at",
        params![id,text(v,"name")?,text(v,"type")?,text(v,"createdAt")?,text(v,"updatedAt")?])?;
    // Only server-owned columns. Paths, thumbnails, activity, worker state and
    // computed values are deliberately absent from this map.
    const FIELDS: &[(&str, &str)] = &[
        ("description", "description"),
        ("year", "year"),
        ("originalTitle", "original_title"),
        ("runtimeMinutes", "runtime_minutes"),
        ("author", "author"),
        ("director", "director"),
        ("developer", "developer"),
        ("publisher", "publisher"),
        ("platforms", "platforms"),
        ("productionCompany", "production_company"),
        ("releaseDate", "release_date"),
        ("externalScore", "external_score"),
        ("myScore", "my_score"),
        ("genres", "genres"),
        ("overview", "overview"),
    ];
    let fields = v["fields"]
        .as_object()
        .ok_or(LibraryError::InvalidCloudResponse)?;
    for (field, column) in FIELDS {
        if let Some(value) = fields.get(*field) {
            tx.execute(
                &format!("UPDATE collections SET {column}=?2 WHERE id=?1"),
                params![id, sql_value(value)?],
            )?;
        }
    }
    // Assets may arrive on another lane later. The full desired cover is retained
    // in the revision payload and rematerialized on every active pass.
    tx.execute("UPDATE collections SET legacy_kind=?2,showcase=?3,showcase_order=?4,cover_asset_id=(SELECT id FROM assets WHERE id=?5) WHERE id=?1",
        params![id,sql_value(&v["legacyKind"])?,boolean(v,"showcase")?,sql_value(&v["showcaseOrder"])?,sql_value(&v["fields"]["coverAssetId"]) ?])?;
    if fields.contains_key("status") || fields.contains_key("ownedPlatform") {
        tx.execute("INSERT INTO collection_pc_records(collection_id,status,owned_platform) VALUES(?1,?2,?3) ON CONFLICT(collection_id) DO UPDATE SET status=excluded.status,owned_platform=excluded.owned_platform",
            params![id,sql_value(&v["fields"]["status"])?,sql_value(&v["fields"]["ownedPlatform"]) ?])?;
    }
    apply_av(tx, v, now)?;
    if let Some(range) = v["derived"].get("volumeRange") {
        project_volume_range(tx, id, range, now)?;
    }
    if let Some(counts) = v["derived"]["ownedVolumes"].as_array() {
        tx.execute(
            "DELETE FROM collection_ownership_tracking WHERE collection_id=?1",
            [id],
        )?;
        for count in counts {
            tx.execute("INSERT INTO collection_ownership_tracking(collection_id,edition_index) VALUES(?1,?2)",params![id,integer(count,"editionIndex")?])?;
        }
    }
    if let Some(watch) = v["derived"]["releaseWatch"].as_object() {
        if watch.get("enabled").and_then(Value::as_bool) == Some(false) {
            tx.execute(
                "DELETE FROM release_watch_subscriptions WHERE collection_id=?1",
                [id],
            )?;
        } else if watch.get("enabled").and_then(Value::as_bool) == Some(true) {
            // Preserve local check time. Binding receipt/feed chooses Kakao over Aladin.
            tx.execute("INSERT OR IGNORE INTO release_watch_subscriptions(collection_id,provider) SELECT ?1,provider FROM collection_external_bindings WHERE collection_id=?1 AND provider IN ('kakao','aladin') ORDER BY CASE provider WHEN 'kakao' THEN 0 ELSE 1 END LIMIT 1",[id])?;
        }
    }
    if let Some(events) = v["derived"]["releaseEvents"].as_array() {
        tx.execute(
            "DELETE FROM release_watch_events WHERE collection_id=?1",
            [id],
        )?;
        for event in events {
            tx.execute("INSERT INTO release_watch_events(id,collection_id,provider,event_kind,volume_number,previous_value,current_value,detected_at,read_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![text(event,"eventId")?,id,text(event,"provider")?,text(event,"kind")?,integer(event,"volumeNumber")?,sql_value(&event["previousValue"])?,sql_value(&event["currentValue"])?,text(event,"detectedAt")?,sql_value(&event["readAt"]) ?])?;
        }
    }
    Ok(())
}

fn apply_av(tx: &Transaction<'_>, v: &Value, now: &str) -> Result<(), LibraryError> {
    let av = &v["details"]["av"];
    if av.is_null() {
        return Ok(());
    }
    tx.execute("INSERT INTO collection_av_details(collection_id,product_code,title_ja,maker,label,series,genres_json,release_date) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(collection_id) DO UPDATE SET product_code=excluded.product_code,title_ja=excluded.title_ja,maker=excluded.maker,label=excluded.label,series=excluded.series,genres_json=excluded.genres_json,release_date=excluded.release_date",
        params![text(v,"workId")?,sql_value(&av["productCode"])?,sql_value(&av["titleJa"])?,sql_value(&av["maker"])?,sql_value(&av["label"])?,sql_value(&av["series"])?,av["genres"].to_string(),sql_value(&av["releaseDate"]) ?])?;
    // The feed has credits but no people section. Preserve existing person-local
    // metadata and retain every received credit in the raw work projection.
    if let Some(credits) = v["avCredits"].as_array() {
        let work = text(v, "workId")?;
        // A credit's `name` is the person's display name, not the per-work credit
        // name. AV editing is fenced while active, so the local credit name is still
        // the confirmed one; new credits have none.
        let credit_names: std::collections::HashMap<(String, String), Option<String>> = tx
            .prepare("SELECT person_id,role,credit_name FROM collection_person_relations WHERE collection_id=?1")?
            .query_map([work], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        tx.execute(
            "DELETE FROM collection_person_relations WHERE collection_id=?1",
            [work],
        )?;
        for c in credits {
            let (person, role) = (text(c, "personId")?, text(c, "role")?);
            tx.execute("INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,name_ja=excluded.name_ja",
                params![person,text(c,"name")?,sql_value(&c["nameJa"])?,now])?;
            let credit_name = credit_names
                .get(&(person.to_owned(), role.to_owned()))
                .cloned()
                .flatten();
            tx.execute("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES(?1,?2,?3,?4,?5)",
                params![work,person,role,integer(c,"order")?,credit_name])?;
        }
    }
    Ok(())
}

fn apply_entity(
    tx: &Transaction<'_>,
    section: &str,
    v: &Value,
    generation: &str,
    now: &str,
) -> Result<bool, LibraryError> {
    let entity_key = key(section, v)?;
    let rev = integer(v, "entityRevision")?;
    if rev < 1 {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let existing:Option<(i64,String)>=tx.query_row("SELECT entity_revision,generation FROM collection_authority_revisions WHERE section=?1 AND entity_key=?2",params![section,entity_key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if existing.is_some_and(|(r, g)| g == generation && r >= rev) {
        return Ok(false);
    }
    let work = text(v, "workId")?;
    let deleted = match section {
        "works" => v["lifecycle"] != "live",
        "bindings" => !boolean(v, "bound")?,
        "memberships" => !boolean(v, "desiredState")?,
        _ => v["deleted"].as_bool().unwrap_or(false),
    };
    let trashed = section != "works"
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_authority_trash WHERE work_id=?1)",
            [work],
            |r| r.get::<_, bool>(0),
        )?;
    let restoring = section == "works"
        && !deleted
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_authority_trash WHERE work_id=?1)",
            [work],
            |r| r.get::<_, bool>(0),
        )?;
    if !trashed {
        match section {
            "works" => apply_work(tx, v, now)?,
            "bindings" => {
                if deleted {
                    tx.execute("DELETE FROM collection_external_bindings WHERE collection_id=?1 AND provider=?2",params![work,text(v,"provider")?])?;
                } else {
                    tx.execute("INSERT INTO collection_external_bindings(collection_id,provider,external_id,provider_data_json,provider_config_json,last_synced_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(collection_id,provider) DO UPDATE SET external_id=excluded.external_id,provider_data_json=excluded.provider_data_json,provider_config_json=excluded.provider_config_json,last_synced_at=excluded.last_synced_at,updated_at=excluded.updated_at",
                params![work,text(v,"provider")?,text(v,"externalId")?,optional_json(&v["snapshot"]),optional_json(&v["config"]),sql_value(&v["lastSyncedAt"])?,now])?;
                }
            }
            "artworks" => {
                let art = safe_id(text(v, "artworkId")?)?;
                safe_id(work)?;
                let blob = &v["original"];
                let sha = text(blob, "sha256")?;
                if sha.len() != 64
                    || !sha
                        .bytes()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                let size = integer(blob, "sizeBytes")?;
                if !(1..=16 * 1024 * 1024).contains(&size) {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                let mime = text(blob, "contentType")?;
                let extension = match mime {
                    "image/jpeg" => "jpg",
                    "image/png" => "png",
                    "image/webp" => "webp",
                    _ => return Err(LibraryError::InvalidCloudResponse),
                };
                let target = format!("work-artwork/authority/{work}/{art}-{sha}.{extension}");
                tx.execute("INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,language,selected,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,mime_type=excluded.mime_type,width=excluded.width,height=excluded.height,language=excluded.language,updated_at=excluded.updated_at",
                params![art,work,v["provider"].as_str().unwrap_or("authority"),v["providerImageId"].as_str().unwrap_or(art),text(v,"kind")?,target,mime,v["width"].as_i64().unwrap_or(1).max(1),v["height"].as_i64().unwrap_or(1).max(1),sql_value(&v["language"])?,text(v,"createdAt")?,now])?;
                // Existing PC paths/thumbnails stay intact. Only newly received art gets
                // a managed destination; the worker never overwrites source/local files.
                let path: String = tx.query_row(
                    "SELECT relative_path FROM collection_work_artworks WHERE id=?1",
                    [art],
                    |r| r.get(0),
                )?;
                if path == target {
                    tx.execute("INSERT INTO collection_authority_materialization(artwork_id,work_id,blob_sha256,size_bytes,mime_type,target_path,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(artwork_id) DO NOTHING",params![art,work,sha,size,mime,target,now])?;
                }
            }
            "volumes" => {
                if deleted {
                    tx.execute(
                        "DELETE FROM collection_volumes WHERE id=?1",
                        [text(v, "volumeId")?],
                    )?;
                } else {
                    tx.execute("INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,cover_artwork_id,source_provider,source_cover_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,(SELECT id FROM collection_work_artworks WHERE id=?6),?7,?8,?9,?9) ON CONFLICT(id) DO UPDATE SET volume_number=excluded.volume_number,edition_index=excluded.edition_index,sort_order=excluded.sort_order,cover_artwork_id=excluded.cover_artwork_id,source_provider=excluded.source_provider,source_cover_id=excluded.source_cover_id,updated_at=excluded.updated_at",
                params![text(v,"volumeId")?,work,integer(v,"volumeNumber")?,integer(v,"editionIndex")?,integer(v,"sortOrder")?,sql_value(&v["coverArtworkId"])?,sql_value(&v["sourceProvider"])?,sql_value(&v["sourceCoverId"])?,now])?;
                }
            }
            "volumeSources" => {
                if deleted {
                    tx.execute("DELETE FROM collection_volume_sources WHERE collection_id=?1 AND volume_number=?2 AND provider=?3",params![work,integer(v,"volumeNumber")?,text(v,"provider")?])?;
                } else {
                    tx.execute("INSERT INTO collection_volume_sources(collection_id,volume_number,provider,provider_item_id,title,author,publisher,isbn13,publication_date,item_url,provider_data_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12) ON CONFLICT(collection_id,volume_number,provider) DO UPDATE SET provider_item_id=excluded.provider_item_id,title=excluded.title,author=excluded.author,publisher=excluded.publisher,isbn13=excluded.isbn13,publication_date=excluded.publication_date,item_url=excluded.item_url,provider_data_json=excluded.provider_data_json,updated_at=excluded.updated_at",
                params![work,integer(v,"volumeNumber")?,text(v,"provider")?,text(v,"providerItemId")?,text(v,"title")?,sql_value(&v["author"])?,sql_value(&v["publisher"])?,sql_value(&v["isbn13"])?,sql_value(&v["publicationDate"])?,sql_value(&v["itemUrl"])?,v["data"].to_string(),now])?;
                }
            }
            "ownership" => {
                tx.execute("INSERT INTO collection_volume_ownership(collection_id,volume_number,edition_index,physical,digital) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(collection_id,volume_number,edition_index) DO UPDATE SET physical=excluded.physical,digital=excluded.digital",
            params![work,integer(v,"volumeNumber")?,integer(v,"editionIndex")?,boolean(v,"physical")?,boolean(v,"digital")?])?;
            }
            "memberships" => {
                if deleted {
                    tx.execute(
                        "DELETE FROM collection_assets WHERE collection_id=?1 AND asset_id=?2",
                        params![work, text(v, "assetId")?],
                    )?;
                } else {
                    tx.execute("INSERT INTO collection_assets(collection_id,asset_id,added_at) SELECT ?1,id,?3 FROM assets WHERE id=?2 ON CONFLICT(collection_id,asset_id) DO UPDATE SET added_at=excluded.added_at",params![work,text(v,"assetId")?,text(v,"addedAt")?])?;
                }
            }
            _ => return Err(LibraryError::InvalidCloudResponse),
        }
    }
    tx.execute("INSERT INTO collection_authority_revisions(section,entity_key,work_id,entity_revision,deleted,payload,generation,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(section,entity_key) DO UPDATE SET entity_revision=excluded.entity_revision,deleted=excluded.deleted,payload=excluded.payload,generation=excluded.generation,updated_at=excluded.updated_at",
        params![section,entity_key,work,rev,deleted,v.to_string(),generation,now])?;
    if restoring {
        // Children may have changed while their work was in trash. Restore local
        // columns first, then project their latest confirmed state in dependency order.
        for child_section in &SECTIONS[1..] {
            let children=tx.prepare("SELECT entity_key,payload,generation FROM collection_authority_revisions WHERE section=?1 AND work_id=?2")?
                .query_map(params![child_section,work],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
            for (child_key, raw, child_generation) in children {
                tx.execute(
                    "DELETE FROM collection_authority_revisions WHERE section=?1 AND entity_key=?2",
                    params![child_section, child_key],
                )?;
                let child: Value =
                    serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
                apply_entity(tx, child_section, &child, &child_generation, now)?;
            }
        }
    }
    Ok(true)
}

fn selections(tx: &Transaction<'_>) -> Result<(), LibraryError> {
    // Work slots can precede artwork pages. Derive only after those rows exist.
    // Do not clear local candidates of kinds the feed cannot express (e.g. AV back).
    let works=tx.prepare("SELECT payload FROM collection_authority_revisions WHERE section='works' AND deleted=0")?
        .query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for raw in works {
        let w: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if w["derived"]["releaseWatch"]["enabled"] == true && w["lifecycle"] == "live" {
            let work = text(&w, "workId")?;
            let provider:Option<String>=tx.query_row("SELECT provider FROM collection_external_bindings WHERE collection_id=?1 AND provider IN ('kakao','aladin') ORDER BY CASE provider WHEN 'kakao' THEN 0 ELSE 1 END LIMIT 1",[work],|r|r.get(0)).optional()?;
            if let Some(provider) = provider {
                let checked:Option<String>=tx.query_row("SELECT last_checked_at FROM release_watch_subscriptions WHERE collection_id=?1 ORDER BY last_checked_at DESC LIMIT 1",[work],|r|r.get(0)).optional()?.flatten();
                tx.execute("INSERT OR IGNORE INTO release_watch_subscriptions(collection_id,provider,last_checked_at) VALUES(?1,?2,?3)",params![work,provider,checked])?;
                tx.execute("DELETE FROM release_watch_subscriptions WHERE collection_id=?1 AND provider<>?2",params![work,provider])?;
            }
        }
        for slot in ["work", "hero", "backdrop", "spine", "back"] {
            if let Some(selected) = w["selection"].get(slot) {
                project_selection(tx, text(&w, "workId")?, slot, selected.as_str())?;
            }
        }
        tx.execute(
            "UPDATE collections SET cover_asset_id=(SELECT id FROM assets WHERE id=?2) WHERE id=?1",
            params![
                text(&w, "workId")?,
                sql_value(&w["fields"]["coverAssetId"])?
            ],
        )?;
    }
    tx.execute("INSERT INTO collection_assets(collection_id,asset_id,added_at) SELECT r.work_id,json_extract(r.payload,'$.assetId'),json_extract(r.payload,'$.addedAt') FROM collection_authority_revisions r JOIN assets a ON a.id=json_extract(r.payload,'$.assetId') JOIN collections c ON c.id=r.work_id WHERE r.section='memberships' AND r.deleted=0 AND NOT EXISTS(SELECT 1 FROM collection_authority_trash t WHERE t.work_id=r.work_id) ON CONFLICT(collection_id,asset_id) DO NOTHING",[])?;
    tx.execute("UPDATE collection_volumes SET cover_artwork_id=(SELECT a.id FROM collection_work_artworks a WHERE a.id=json_extract(r.payload,'$.coverArtworkId')) FROM collection_authority_revisions r WHERE r.section='volumes' AND r.deleted=0 AND collection_volumes.id=json_extract(r.payload,'$.volumeId')",[])?;
    Ok(())
}

fn finish_baseline_projection(tx: &Transaction<'_>, generation: &str) -> Result<(), LibraryError> {
    // A baseline is the full desired shared state, not a merge with old PC links.
    // Local artwork candidates and local worker state on retained bindings stay.
    tx.execute("DELETE FROM collection_assets WHERE NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='memberships' AND r.generation=?1 AND r.deleted=0 AND r.work_id=collection_assets.collection_id AND json_extract(r.payload,'$.assetId')=collection_assets.asset_id)",[generation])?;
    tx.execute("DELETE FROM collection_external_bindings WHERE NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='bindings' AND r.generation=?1 AND r.deleted=0 AND r.work_id=collection_external_bindings.collection_id AND json_extract(r.payload,'$.provider')=collection_external_bindings.provider)",[generation])?;
    tx.execute("DELETE FROM collection_volumes WHERE NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='volumes' AND r.generation=?1 AND r.deleted=0 AND json_extract(r.payload,'$.volumeId')=collection_volumes.id)",[generation])?;
    tx.execute("DELETE FROM collection_volume_sources WHERE NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='volumeSources' AND r.generation=?1 AND r.deleted=0 AND r.work_id=collection_volume_sources.collection_id AND json_extract(r.payload,'$.volumeNumber')=collection_volume_sources.volume_number AND json_extract(r.payload,'$.provider')=collection_volume_sources.provider)",[generation])?;
    tx.execute("DELETE FROM collection_volume_ownership WHERE NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='ownership' AND r.generation=?1 AND r.work_id=collection_volume_ownership.collection_id AND json_extract(r.payload,'$.volumeNumber')=collection_volume_ownership.volume_number AND json_extract(r.payload,'$.editionIndex')=collection_volume_ownership.edition_index)",[generation])?;
    Ok(())
}

impl Library {
    fn begin_collection_baseline(
        &self,
        status: &CollectionAuthorityStatus,
        manifest: &Value,
    ) -> Result<(), LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let id = status
            .identity(&tx)?
            .ok_or(LibraryError::CollectionAuthorityMismatch)?;
        envelope(manifest, &id)?;
        let cursor = integer(manifest, "snapshotCursor")?;
        if cursor < 0 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let sections = manifest["sections"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        if sections.len() != SECTIONS.len()
            || sections.iter().zip(SECTIONS).any(|(s, k)| {
                s["section"] != *k
                    || s["count"]
                        .as_i64()
                        .is_none_or(|n| !(0..=500_000).contains(&n))
            })
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_authority_outbox WHERE state='pending')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(LibraryError::CollectionAuthorityMismatch);
        }
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute("INSERT INTO collection_authority_sync(singleton,library_id,epoch,contract_version,cursor,adopted,snapshot_cursor,manifest,generation,updated_at) VALUES(1,?1,?2,?3,0,0,?4,?5,?6,?7) ON CONFLICT(singleton) DO UPDATE SET library_id=excluded.library_id,epoch=excluded.epoch,contract_version=excluded.contract_version,adopted=0,adopted_at=NULL,snapshot_cursor=excluded.snapshot_cursor,baseline_section=0,baseline_after=NULL,baseline_count=0,manifest=excluded.manifest,generation=excluded.generation,updated_at=excluded.updated_at",
            params![id.library,id.epoch,id.version,cursor,manifest.to_string(),uuid::Uuid::new_v4().to_string(),now])?;
        tx.commit()?;
        Ok(())
    }

    fn apply_collection_baseline_page(&self, page: &Value) -> Result<bool, LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let l = local(&tx)?.ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
        if l.adopted || l.section >= SECTIONS.len() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        envelope(page, &l.id)?;
        if page["snapshotCursor"] != l.snapshot.unwrap_or(-1)
            || page["section"] != SECTIONS[l.section]
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let section = SECTIONS[l.section];
        let items = page["items"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let more = boolean(page, "hasMore")?;
        let complete = boolean(page, "complete")?;
        let next = page["nextAfter"].as_str();
        if more && (items.is_empty() || next.is_none() || next == l.after.as_deref()) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if more
            && next
                != items
                    .last()
                    .map(|v| key(section, v))
                    .transpose()?
                    .as_deref()
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let expected_next = if more {
            None
        } else {
            SECTIONS.get(l.section + 1).copied()
        };
        if page["nextSection"].as_str() != expected_next {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if complete != (!more && l.section + 1 == SECTIONS.len())
            || (!more && !page["nextAfter"].is_null())
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let now = chrono::Utc::now().to_rfc3339();
        for v in items {
            if !apply_entity(&tx, section, v, &l.generation, &now)? {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        let count = l.count + items.len() as i64;
        let expected = integer(&l.manifest["sections"][l.section], "count")?;
        if count > expected || (!more && count != expected) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        tx.execute("UPDATE collection_authority_sync SET baseline_section=?1,baseline_after=?2,baseline_count=?3,cursor=?4,adopted=?5,adopted_at=?6,updated_at=?7 WHERE singleton=1",
            params![(if more{l.section}else{l.section+1}) as i64,next,if more{count}else{0},l.snapshot,complete,if complete{Some(&now)}else{None},now])?;
        if complete {
            // Local works absent from the baseline are salvage-only, never republished
            // or physically purged. Retain their original local subtree.
            let missing=tx.prepare("SELECT id FROM collections WHERE NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='works' AND r.work_id=collections.id AND r.generation=?1)")?
                .query_map([&l.generation],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            for work in missing {
                mark_trash(&tx, &json!({"workId":work}), "absent", &now)?;
            }
            finish_baseline_projection(&tx, &l.generation)?;
            tx.execute(
                "DELETE FROM collection_authority_revisions WHERE generation<>?1",
                [&l.generation],
            )?;
            selections(&tx)?;
        }
        tx.commit()?;
        Ok(complete)
    }

    fn apply_collection_changes(&self, page: &Value) -> Result<usize, LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let l = local(&tx)?
            .filter(|l| l.adopted)
            .ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
        envelope(page, &l.id)?;
        let ceiling = integer(page, "cursor")?;
        let next = integer(page, "nextAfter")?;
        if ceiling < 0 || next < 0 || next > ceiling {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if ceiling < l.id.cursor {
            return Ok(0);
        }
        let mut cursor = l.id.cursor;
        let mut previous = -1;
        let mut applied = 0;
        let now = chrono::Utc::now().to_rfc3339();
        for change in page["items"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?
        {
            let seq = integer(change, "sequence")?;
            if seq <= previous || change["authorityCursor"] != seq || seq > ceiling {
                return Err(LibraryError::InvalidCloudResponse);
            }
            previous = seq;
            if seq <= cursor {
                continue;
            }
            if seq != cursor + 1 {
                return Err(LibraryError::InvalidCloudResponse);
            }
            applied += apply_entities(&tx, &change["entities"], &l.generation, &now)?;
            cursor = seq;
        }
        if next > cursor
            || (next >= l.id.cursor && next != cursor)
            || boolean(page, "hasMore")? != (next < ceiling)
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        selections(&tx)?;
        tx.execute(
            "UPDATE collection_authority_sync SET cursor=?1,updated_at=?2 WHERE singleton=1",
            params![cursor, now],
        )?;
        tx.commit()?;
        Ok(applied)
    }

    /// Called only when aggregate status advertises Collections. No Collection
    /// endpoint, replica write, or file work occurs on an inactive pass.
    pub(crate) fn sync_collection_authority(
        &self,
        client: &CloudClient,
        token: &str,
        publisher: Option<&str>,
        aggregate: &SyncStatus,
        held: bool,
    ) -> Result<(bool, bool), LibraryError> {
        if !aggregate.domains.iter().any(|d| d.domain == "collections") {
            return Ok((false, false));
        }
        let value = client.collection_authority_read("/v1/collections/authority/status", token)?;
        let status: CollectionAuthorityStatus =
            serde_json::from_value(value).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let Some(id) = status.identity(&*self.connection()?)? else {
            return Ok((false, false));
        };
        // Fence immediately after observing activation, even if fetching the baseline fails.
        self.observe_collection_authority(&status)?;
        let initial = local(&*self.connection()?)?;
        let needs_baseline = initial
            .as_ref()
            .is_none_or(|l| !same(&l.id, &id) || l.id.cursor > id.cursor || l.manifest.is_null());
        if needs_baseline {
            let manifest =
                client.collection_authority_read(&url_path("baseline", &id, &[]), token)?;
            self.begin_collection_baseline(&status, &manifest)?;
        }
        let mut changed = false;
        for _ in 0..PAGE_BUDGET {
            let l =
                local(&*self.connection()?)?.ok_or(LibraryError::CollectionAuthorityNotAdopted)?;
            if l.adopted {
                break;
            }
            let mut query = vec![
                ("snapshot", l.snapshot.unwrap_or(0).to_string()),
                ("section", SECTIONS[l.section].into()),
                ("limit", "500".into()),
            ];
            if let Some(after) = l.after {
                query.push(("after", after));
            }
            let page =
                client.collection_authority_read(&url_path("baseline", &id, &query), token)?;
            if page["detail"]["code"] == "baselineChanged" {
                let manifest =
                    client.collection_authority_read(&url_path("baseline", &id, &[]), token)?;
                self.begin_collection_baseline(&status, &manifest)?;
                return Ok((false, false));
            }
            changed |= self.apply_collection_baseline_page(&page)?;
        }
        let l = local(&*self.connection()?)?.unwrap();
        if !l.adopted {
            return Ok((changed, false));
        }
        let sent = if held {
            false
        } else {
            self.flush_collection_outbox_with(
                &status,
                &|body| {
                    if body["commandType"] == "addArtwork" {
                        self.upload_collection_command_artwork(client, token, body)?;
                    }
                    let credential = command_credential(body, token, publisher)?;
                    if body.to_string().len() > command_byte_limit(body, publisher.is_some()) {
                        return Ok(CollectionDelivery::Dropped(
                            json!({"code":"collectionCommandTooLarge"}),
                        ));
                    }
                    client.collection_authority_send(body, credential)
                },
                chrono::Utc::now().timestamp(),
            )?
        };
        // A receipt or settled refusal can change the local projection even when
        // the subsequent feed only repeats revisions already received here.
        changed |= sent;
        // Flush-first: unresolved optimistic effects must not be overwritten.
        if self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_authority_outbox WHERE state='pending')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Ok((changed, sent));
        }
        for _ in 0..PAGE_BUDGET {
            let l = local(&*self.connection()?)?.unwrap();
            if !sent && l.id.cursor == id.cursor {
                break;
            }
            let page = client.collection_authority_read(
                &url_path(
                    "changes",
                    &id,
                    &[("after", l.id.cursor.to_string()), ("limit", "100".into())],
                ),
                token,
            )?;
            if matches!(
                page["detail"]["code"].as_str(),
                Some("cursorExpired" | "cursorAhead")
            ) {
                let manifest =
                    client.collection_authority_read(&url_path("baseline", &id, &[]), token)?;
                self.begin_collection_baseline(&status, &manifest)?;
                return Ok((changed, sent));
            }
            changed |= self.apply_collection_changes(&page)? > 0;
            if !boolean(&page, "hasMore")? {
                break;
            }
        }
        {
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            selections(&tx)?;
            tx.commit()?;
        }
        // Drain originals in small batches within a bounded time per cadence, so a
        // fresh adoption (hundreds of covers) fills in within minutes, not hours.
        let deadline = std::time::Instant::now() + MATERIALIZE_BUDGET;
        loop {
            let done = self.materialize_collection_artwork_until(
                &status,
                &|w, a, sha, size, mime, path| {
                    client.download_collection_artwork(w, a, sha, size, mime, path, token)
                },
                chrono::Utc::now().timestamp(),
                MATERIALIZE_BATCH,
                Some(deadline),
            )?;
            changed |= done > 0;
            if done < MATERIALIZE_BATCH || std::time::Instant::now() >= deadline {
                break;
            }
        }
        Ok((changed, sent))
    }
}

const MATERIALIZE_BATCH: usize = 8;
const MATERIALIZE_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

fn apply_entities(
    tx: &Transaction<'_>,
    entities: &Value,
    generation: &str,
    now: &str,
) -> Result<usize, LibraryError> {
    let map = entities
        .as_object()
        .ok_or(LibraryError::InvalidCloudResponse)?;
    if map.keys().any(|s| !SECTIONS.contains(&s.as_str())) {
        return Err(LibraryError::InvalidCloudResponse);
    }
    let mut count = 0;
    for section in SECTIONS {
        if let Some(rows) = map.get(*section) {
            for v in rows.as_array().ok_or(LibraryError::InvalidCloudResponse)? {
                count += usize::from(apply_entity(tx, section, v, generation, now)?);
            }
        }
    }
    Ok(count)
}
fn url_path(route: &str, id: &Identity, extra: &[(&str, String)]) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query
        .append_pair("libraryId", &id.library)
        .append_pair("epoch", &id.epoch.to_string());
    for (k, v) in extra {
        query.append_pair(k, v);
    }
    format!("/v1/collections/authority/{route}?{}", query.finish())
}
fn publisher_command(command: &str) -> bool {
    matches!(
        command,
        "purgeWork"
            | "purgeExpiredTrash"
            | "bindProvider"
            | "unbindProvider"
            | "applyProviderSnapshot"
            | "upsertVolume"
            | "upsertVolumeSource"
            | "setVolumeOwnership"
            | "recordReleaseEvent"
    )
}

// Keep these in sync with collection_authority.py's role and JSON limits.
const COMMAND_BYTES_CLIENT: usize = 64 * 1024;
const COMMAND_BYTES_PUBLISHER: usize = 8 * 1024 * 1024;
const SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const DETAIL_BYTES: usize = 3 * 1024 * 1024;
const CONFIG_BYTES: usize = 64 * 1024;

fn provider_command(body: &Value) -> bool {
    matches!(
        body["commandType"].as_str(),
        Some("bindProvider" | "applyProviderSnapshot")
    ) || (body["commandType"] == "createWork" && body["binding"].is_object())
}

fn command_credential<'a>(
    body: &Value,
    client: &'a str,
    publisher: Option<&'a str>,
) -> Result<&'a str, LibraryError> {
    if publisher_command(text(body, "commandType")?) {
        publisher.ok_or(LibraryError::CloudCredentialNotConfigured)
    } else if provider_command(body) {
        Ok(publisher.unwrap_or(client))
    } else {
        Ok(client)
    }
}

fn command_byte_limit(body: &Value, publisher_available: bool) -> usize {
    if publisher_command(body["commandType"].as_str().unwrap_or_default())
        || (publisher_available && provider_command(body))
    {
        COMMAND_BYTES_PUBLISHER
    } else {
        COMMAND_BYTES_CLIENT
    }
}

/// Enqueue inside the optimistic-write transaction. Retries keep the stored payload and ID.
pub(crate) fn enqueue_collection_command(
    tx: &Transaction<'_>,
    status: &CollectionAuthorityStatus,
    command: &str,
    entity_key: &str,
    entity: Value,
) -> Result<String, LibraryError> {
    if !ensure_collection_write_ready(tx, status)? || !COMMANDS.contains(&command) {
        return Err(LibraryError::CollectionAuthorityMismatch);
    }
    let id = status.identity(tx)?.unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let mut body = entity
        .as_object()
        .cloned()
        .ok_or(LibraryError::InvalidCloudResponse)?;
    for (k, v) in [
        ("libraryId", json!(id.library)),
        ("epoch", json!(id.epoch)),
        ("contractVersion", json!(id.version)),
        ("operationId", json!(operation)),
        ("commandType", json!(command)),
    ] {
        if body.insert(k.into(), v).is_some() {
            return Err(LibraryError::InvalidCloudResponse);
        }
    }
    let mut payload = Value::Object(body);
    let mut omission = None;
    let provider = if command == "createWork" {
        &mut payload["binding"]
    } else {
        &mut payload
    };
    if matches!(command, "createWork" | "applyProviderSnapshot") && provider.is_object() {
        if provider["details"].to_string().len() > DETAIL_BYTES {
            provider["details"] = Value::Null;
            omission = Some("providerDetailsTooLarge");
        }
        if provider["snapshot"].to_string().len() > SNAPSHOT_BYTES {
            if let Some(snapshot) = provider["snapshot"].as_object_mut() {
                snapshot.remove("series");
                snapshot.remove("film");
            }
            omission = Some("providerSnapshotDetailsTooLarge");
        }
        if provider["snapshot"].to_string().len() > SNAPSHOT_BYTES {
            return Err(LibraryError::InvalidExternalBinding);
        }
    }
    let config = if command == "createWork" {
        &payload["binding"]["config"]
    } else {
        &payload["config"]
    };
    if matches!(command, "createWork" | "bindProvider") && config.to_string().len() > CONFIG_BYTES {
        return Err(LibraryError::InvalidExternalBinding);
    }
    // Provider creates fit the publisher envelope. Client-only delivery is checked
    // again against its smaller limit before sending an immutable queued command.
    let limit = command_byte_limit(&payload, true);
    if payload.to_string().len() > limit {
        return Err(LibraryError::InvalidExternalBinding);
    }
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute("INSERT INTO collection_authority_outbox(operation_id,library_id,epoch,contract_version,command_type,entity_key,payload,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",params![operation,id.library,id.epoch,id.version,command,entity_key,payload.to_string(),now])?;
    if let Some(reason) = omission {
        tx.execute(
            "UPDATE collection_authority_outbox SET conflict_detail=?2 WHERE operation_id=?1",
            params![operation, json!({"code":reason}).to_string()],
        )?;
    }
    super::authority_pass::note_local_work();
    Ok(operation)
}

fn backoff(attempts: i64) -> i64 {
    (5_i64.saturating_mul(1_i64 << attempts.clamp(0, 10))).min(3600)
}

fn core_command(command: &str) -> bool {
    matches!(
        command,
        "createWork" | "updateWork" | "deleteWork" | "setShowcaseOrder" | "setMembership"
    )
}

/// A receipt confirms earlier commands, but must not erase newer optimistic core
/// edits while their immutable payloads wait for delivery. Never change revision caches.
fn reapply_pending_core_edits(tx: &Transaction<'_>) -> Result<(), LibraryError> {
    let rows=tx.prepare("SELECT payload,created_at FROM collection_authority_outbox WHERE state='pending' ORDER BY seq")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    for (raw, created_at) in rows {
        let body: Value =
            serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
        match body["commandType"].as_str() {
            Some("selectArtwork") => project_selection(
                tx,
                text(&body, "workId")?,
                text(&body, "slot")?,
                body["artworkId"].as_str(),
            )?,
            Some("setVolumeRange") => {
                project_volume_range(tx, text(&body, "workId")?, &body, &created_at)?
            }
            Some("upsertVolume") => {
                tx.execute("UPDATE collection_volumes SET cover_artwork_id=?2,source_provider=?3,source_cover_id=?4,sort_order=?5 WHERE id=?1",params![text(&body,"volumeId")?,sql_value(&body["coverArtworkId"])?,sql_value(&body["sourceProvider"])?,sql_value(&body["sourceCoverId"])?,integer(&body,"sortOrder")?])?;
            }
            Some("upsertVolumeSource") => {
                tx.execute("UPDATE collection_volume_sources SET provider_item_id=?4,title=?5,author=?6,publisher=?7,isbn13=?8,publication_date=?9,item_url=?10,provider_data_json=?11 WHERE collection_id=?1 AND volume_number=?2 AND provider=?3",params![text(&body,"workId")?,integer(&body,"volumeNumber")?,text(&body,"provider")?,text(&body,"providerItemId")?,text(&body,"title")?,sql_value(&body["author"])?,sql_value(&body["publisher"])?,sql_value(&body["isbn13"])?,sql_value(&body["publicationDate"])?,sql_value(&body["itemUrl"])?,body["data"].to_string()])?;
            }
            Some("updateWork") => {
                if let Some(changes) = body["changes"].as_object() {
                    for (field, value) in changes {
                        let work = text(&body, "workId")?;
                        match field.as_str() {
                            "status" | "ownedPlatform" => {
                                let column = if field == "status" {
                                    "status"
                                } else {
                                    "owned_platform"
                                };
                                tx.execute(&format!("INSERT INTO collection_pc_records(collection_id,{column}) SELECT id,?2 FROM collections WHERE id=?1 ON CONFLICT(collection_id) DO UPDATE SET {column}=excluded.{column}"),params![work,sql_value(value)?])?;
                            }
                            "showcase" => {
                                tx.execute("UPDATE collections SET showcase=?2,showcase_order=CASE WHEN ?2=0 THEN NULL WHEN showcase=1 AND showcase_order IS NOT NULL THEN showcase_order ELSE (SELECT COALESCE(MAX(showcase_order)+1,0) FROM collections other WHERE other.type=collections.type AND other.id<>collections.id AND (other.legacy_kind IS NULL OR other.legacy_kind<>'gacha')) END WHERE id=?1",params![work,sql_value(value)?])?;
                            }
                            "coverAssetId" => {
                                tx.execute("UPDATE collections SET cover_asset_id=(SELECT id FROM assets WHERE id=?2) WHERE id=?1",params![work,sql_value(value)?])?;
                            }
                            _ => {
                                let column = match field.as_str() {
                                    "name" => "name",
                                    "description" => "description",
                                    "year" => "year",
                                    "originalTitle" => "original_title",
                                    "runtimeMinutes" => "runtime_minutes",
                                    "author" => "author",
                                    "director" => "director",
                                    "developer" => "developer",
                                    "publisher" => "publisher",
                                    "platforms" => "platforms",
                                    "productionCompany" => "production_company",
                                    "releaseDate" => "release_date",
                                    "externalScore" => "external_score",
                                    "myScore" => "my_score",
                                    "genres" => "genres",
                                    "overview" => "overview",
                                    _ => return Err(LibraryError::InvalidCloudResponse),
                                };
                                tx.execute(
                                    &format!("UPDATE collections SET {column}=?2 WHERE id=?1"),
                                    params![work, sql_value(value)?],
                                )?;
                            }
                        }
                    }
                }
            }
            Some("setMembership") => {
                if boolean(&body, "desiredState")? {
                    tx.execute("INSERT INTO collection_assets(collection_id,asset_id,added_at) SELECT c.id,a.id,?3 FROM collections c,assets a WHERE c.id=?1 AND a.id=?2 ON CONFLICT(collection_id,asset_id) DO NOTHING",params![text(&body,"workId")?,text(&body,"assetId")?,created_at])?;
                } else {
                    tx.execute(
                        "DELETE FROM collection_assets WHERE collection_id=?1 AND asset_id=?2",
                        params![text(&body, "workId")?, text(&body, "assetId")?],
                    )?;
                }
            }
            Some("setShowcaseOrder") => {
                for (order, work) in body["workIds"]
                    .as_array()
                    .ok_or(LibraryError::InvalidCloudResponse)?
                    .iter()
                    .enumerate()
                {
                    tx.execute(
                        "UPDATE collections SET showcase_order=?2 WHERE id=?1",
                        params![
                            work.as_str().ok_or(LibraryError::InvalidCloudResponse)?,
                            order as i64
                        ],
                    )?;
                }
            }
            Some("deleteWork") => {
                let work = text(&body, "workId")?;
                if tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
                    [work],
                    |r| r.get::<_, bool>(0),
                )? {
                    optimistic_collection_trash(tx, work)?;
                }
            }
            _ => {}
        }
    }
    project_pending_provider_fields(tx)?;
    Ok(())
}

/// Rebuild provider effects from confirmed rows, then replay every pending field
/// change in FIFO order. Replaying against the already optimistic SQL rows would
/// mistake our own previous projection for a user override on the next refresh.
fn project_pending_provider_fields(tx: &Transaction<'_>) -> Result<(), LibraryError> {
    let works = tx.prepare("SELECT DISTINCT json_extract(payload,'$.workId') FROM collection_authority_outbox WHERE state='pending' AND (command_type='applyProviderSnapshot' OR (command_type='createWork' AND json_type(payload,'$.binding')='object'))")?
        .query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    for work in works {
        let confirmed: Option<String> = tx.query_row("SELECT payload FROM collection_authority_revisions WHERE section='works' AND work_id=?1", [&work], |r| r.get(0)).optional()?;
        let mut fields = confirmed
            .map(|raw| serde_json::from_str::<Value>(&raw))
            .transpose()
            .map_err(|_| LibraryError::InvalidCloudResponse)?
            .map(|v| v["fields"].clone())
            .unwrap_or(json!({}));
        let bindings = tx.prepare("SELECT payload FROM collection_authority_revisions WHERE section='bindings' AND work_id=?1")?
            .query_map([&work], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        let mut bases = std::collections::BTreeMap::new();
        for raw in bindings {
            let binding: Value =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            if binding["bound"] == true {
                bases.insert(text(&binding, "provider")?.to_owned(), binding);
            }
        }
        let pending = tx.prepare("SELECT payload FROM collection_authority_outbox WHERE state='pending' AND json_extract(payload,'$.workId')=?1 ORDER BY seq")?
            .query_map([&work], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        let mut projected = std::collections::BTreeSet::new();
        for raw in pending {
            let body: Value =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            let snapshot = match body["commandType"].as_str() {
                Some("createWork") => {
                    fields = body["fields"].clone();
                    body["binding"].as_object().map(|_| &body["binding"])
                }
                Some("updateWork") => {
                    for (field, value) in body["changes"]
                        .as_object()
                        .ok_or(LibraryError::InvalidCloudResponse)?
                    {
                        fields[field] = value.clone();
                    }
                    None
                }
                Some("unbindProvider") => {
                    bases.remove(text(&body, "provider")?);
                    None
                }
                Some("applyProviderSnapshot") => Some(&body),
                _ => None,
            };
            if let Some(snapshot) = snapshot {
                let provider = text(snapshot, "provider")?;
                let base = bases.get(provider).cloned().unwrap_or(Value::Null);
                let connect = base["snapshotExternalId"] != snapshot["externalId"];
                let previous = &base["values"];
                let values = &snapshot["values"];
                let blank = |value: &Value| {
                    value.is_null() || value.as_str().is_some_and(|v| v.trim().is_empty())
                };
                let normalized = |value: &Value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned)
                };
                for (field, value) in values
                    .as_object()
                    .ok_or(LibraryError::InvalidCloudResponse)?
                {
                    let allowed = match provider {
                        "tmdb" => {
                            if value.is_string()
                                || fields[field].is_string()
                                || previous[field].is_string()
                            {
                                normalized(&fields[field]) == normalized(&previous[field])
                            } else {
                                fields[field] == previous[field]
                            }
                        }
                        "igdb" => blank(&fields[field]) && blank(&previous[field]),
                        "mangadex" if field == "year" => {
                            fields[field].is_null() || fields[field] == previous[field]
                        }
                        "mangadex" => blank(&fields[field]) || fields[field] == previous[field],
                        _ => false,
                    };
                    if allowed {
                        fields[field] = value.clone();
                    }
                    projected.insert(field.clone());
                }
                let year = |value: &Value| {
                    value
                        .as_str()
                        .and_then(|v| v.get(..4))
                        .and_then(|v| v.parse::<i64>().ok())
                        .map_or(Value::Null, |v| json!(v))
                };
                if connect
                    && ((provider == "tmdb" && fields["year"] == year(&previous["releaseDate"]))
                        || (provider == "igdb" && fields["year"].is_null()))
                {
                    fields["year"] = year(&values["releaseDate"]);
                    projected.insert("year".into());
                }
                bases.insert(
                    provider.to_owned(),
                    json!({"values":values,"snapshotExternalId":snapshot["externalId"]}),
                );
            }
        }
        for field in projected {
            let column = match field.as_str() {
                "year" => "year",
                "originalTitle" => "original_title",
                "runtimeMinutes" => "runtime_minutes",
                "author" => "author",
                "director" => "director",
                "developer" => "developer",
                "publisher" => "publisher",
                "platforms" => "platforms",
                "productionCompany" => "production_company",
                "releaseDate" => "release_date",
                "externalScore" => "external_score",
                "genres" => "genres",
                "overview" => "overview",
                _ => return Err(LibraryError::InvalidCloudResponse),
            };
            tx.execute(
                &format!("UPDATE collections SET {column}=?2 WHERE id=?1"),
                params![work, sql_value(&fields[&field])?],
            )?;
        }
    }
    Ok(())
}

/// Settle refused core edits without blocking unrelated writes. Reproject confirmed
/// feed rows even at the same revision: optimistic state never increments that cache.
fn drop_core_intent(
    tx: &Transaction<'_>,
    seq: i64,
    body: &Value,
    detail: &Value,
    now: &str,
) -> Result<(), LibraryError> {
    let reason = text(detail, "code")?;
    tx.execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason=?2,conflict_code=?2,conflict_detail=?3,updated_at=?4 WHERE seq=?1",params![seq,reason,detail.to_string(),now])?;
    let works: Vec<String> = if let Some(work) = body["workId"].as_str() {
        vec![work.to_owned()]
    } else {
        body["workIds"]
            .as_array()
            .ok_or(LibraryError::InvalidCloudResponse)?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or(LibraryError::InvalidCloudResponse)
            })
            .collect::<Result<_, _>>()?
    };
    let generation = local(tx)?
        .ok_or(LibraryError::CollectionAuthorityNotAdopted)?
        .generation;
    for work in &works {
        // Later edits composed against this optimistic state cannot be sent safely.
        tx.execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason='dependencyDropped',updated_at=?2 WHERE state='pending' AND seq>?3 AND (json_extract(payload,'$.workId')=?1 OR (command_type='setShowcaseOrder' AND EXISTS(SELECT 1 FROM json_each(payload,'$.workIds') WHERE value=?1)))",params![work,now,seq])?;
        let rows = tx.prepare("SELECT section,entity_key,payload FROM collection_authority_revisions WHERE work_id=?1 AND section IN ('works','memberships') ORDER BY CASE section WHEN 'works' THEN 0 ELSE 1 END")?.query_map([work],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
        if !rows.iter().any(|r| r.0 == "works") {
            // A refused optimistic create has no server work to restore. Archive its
            // local subtree without deleting any files or Library Assets.
            optimistic_collection_trash(tx, work)?;
            tx.execute(
                "UPDATE collection_authority_trash SET lifecycle='absent' WHERE work_id=?1",
                [work],
            )?;
        }
        for (section, entity_key, raw) in rows {
            let value: Value =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            tx.execute(
                "DELETE FROM collection_authority_revisions WHERE section=?1 AND entity_key=?2",
                params![section, entity_key],
            )?;
            apply_entity(tx, &section, &value, &generation, now)?;
        }
        // Remove optimistic new memberships that have no confirmed feed row.
        tx.execute("DELETE FROM collection_assets WHERE collection_id=?1 AND NOT EXISTS(SELECT 1 FROM collection_authority_revisions r WHERE r.section='memberships' AND r.work_id=?1 AND json_extract(r.payload,'$.assetId')=collection_assets.asset_id AND r.deleted=0)",[work])?;
    }
    // Revision conflicts carry a full current entity; receive it through batch-1
    // apply, then the regular changes feed catches up without advancing its cursor here.
    let current = &detail["current"];
    if let Some(work) = current.get("work") {
        apply_entity(tx, "works", work, &generation, now)?;
    }
    if let Some(membership) = current
        .get("membership")
        .filter(|v| v["entityRevision"].as_i64().is_some_and(|r| r > 0))
    {
        apply_entity(tx, "memberships", membership, &generation, now)?;
    }
    if matches!(reason, "workDeleted" | "workNotFound") {
        for work in &works {
            optimistic_collection_trash(tx, work)?;
            tx.execute(
                "UPDATE collection_authority_trash SET lifecycle='absent' WHERE work_id=?1",
                [work],
            )?;
        }
    }
    selections(tx)?;
    Ok(())
}

impl Library {
    fn upload_collection_command_artwork(
        &self,
        client: &CloudClient,
        token: &str,
        body: &Value,
    ) -> Result<(), LibraryError> {
        self.upload_collection_command_artwork_with(
            body,
            &|blob, bytes| {
                client
                    .upload_collection_artwork(blob, bytes, token)
                    .map(|_| ())
            },
            &|blob| {
                client
                    .missing_collection_artworks(&[blob], token)
                    .map(|missing| missing.is_empty())
            },
        )
    }

    fn upload_collection_command_artwork_with(
        &self,
        body: &Value,
        upload: &dyn Fn(&crate::cloud::collections::ArtworkBlob, &[u8]) -> Result<(), LibraryError>,
        confirmed: &dyn Fn(&crate::cloud::collections::ArtworkBlob) -> Result<bool, LibraryError>,
    ) -> Result<(), LibraryError> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let blob: crate::cloud::collections::ArtworkBlob =
            serde_json::from_value(body["original"].clone())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if blob.size_bytes > 16 * 1024 * 1024 {
            return Err(LibraryError::InvalidWorkArtwork);
        }
        let mut media = self.resolve_work_artwork(text(body, "artworkId")?)?;
        let mut bytes = Vec::new();
        media
            .file
            .by_ref()
            .take(blob.size_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| LibraryError::ReadMedia {
                path: self.root().to_path_buf(),
                source,
            })?;
        if bytes.len() as u64 != blob.size_bytes
            || Sha256::digest(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                != blob.sha256
        {
            return Err(LibraryError::InvalidWorkArtwork);
        }
        upload(&blob, &bytes)?;
        if !confirmed(&blob)? {
            return Err(LibraryError::CloudRequestUnavailable);
        }
        Ok(())
    }

    fn observe_collection_authority(
        &self,
        status: &CollectionAuthorityStatus,
    ) -> Result<(), LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let id = status
            .identity(&tx)?
            .ok_or(LibraryError::CollectionAuthorityMismatch)?;
        match local(&tx)? {
            None => {
                tx.execute("INSERT INTO collection_authority_sync(singleton,library_id,epoch,contract_version,generation,updated_at) VALUES(1,?1,?2,?3,?4,?5)",params![id.library,id.epoch,id.version,uuid::Uuid::new_v4().to_string(),chrono::Utc::now().to_rfc3339()])?;
            }
            Some(l) if !same(&l.id, &id) => {
                tx.execute(
                    "UPDATE collection_authority_sync SET adopted=0 WHERE singleton=1",
                    [],
                )?;
            }
            _ => {}
        }
        tx.commit()?;
        Ok(())
    }

    fn flush_collection_outbox_with(
        &self,
        status: &CollectionAuthorityStatus,
        send: &dyn Fn(&Value) -> Result<CollectionDelivery, LibraryError>,
        now: i64,
    ) -> Result<bool, LibraryError> {
        self.flush_collection_outbox_with_refresh(status, send, now, &|body| {
            let work = text(body, "workId")?;
            match text(body, "provider")? {
                "tmdb" => self.refresh_tmdb_movie(work).map(|_| ()),
                "igdb" => self.refresh_igdb_game(work).map(|_| ()),
                "mangadex" => self.refresh_mangadex(work).map(|_| ()),
                "kakao" => super::credential::read_kakao_key()
                    .and_then(|key| self.refresh_kakao(&key, work).map(|_| ())),
                "aladin" => super::credential::read_aladin_key()
                    .and_then(|key| self.refresh_aladin(&key, work).map(|_| ())),
                _ => Err(LibraryError::InvalidExternalBinding),
            }
        })
    }

    fn flush_collection_outbox_with_refresh(
        &self,
        status: &CollectionAuthorityStatus,
        send: &dyn Fn(&Value) -> Result<CollectionDelivery, LibraryError>,
        now: i64,
        refresh: &dyn Fn(&Value) -> Result<(), LibraryError>,
    ) -> Result<bool, LibraryError> {
        if !status.active {
            return Ok(false);
        }
        ensure_collection_write_ready(&*self.connection()?, status)?;
        let mut sent = false;
        for _ in 0..50 {
            let row=self.connection()?.query_row("SELECT seq,payload,attempts,retry_at,state FROM collection_authority_outbox WHERE state IN ('pending','blocked') ORDER BY seq LIMIT 1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?))).optional()?;
            let Some((seq, raw, attempts, retry_at, state)) = row else {
                break;
            };
            if state == "blocked" || retry_at > now {
                break;
            }
            let body: Value =
                serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse)?;
            let id = status.identity(&*self.connection()?)?.unwrap();
            envelope(&body, &id)?;
            // Count the attempt durably before leaving the DB for transport.
            self.connection()?.execute("UPDATE collection_authority_outbox SET attempts=attempts+1,updated_at=?2 WHERE seq=?1",params![seq,chrono::Utc::now().to_rfc3339()])?;
            let result = send(&body);
            if let Ok(CollectionDelivery::Conflict(detail)) = &result {
                if body["commandType"] == "applyProviderSnapshot"
                    && detail["code"] == "providerSnapshotStale"
                {
                    let already_retried: bool = self.connection()?.query_row("SELECT conflict_code='providerSnapshotRetry' FROM collection_authority_outbox WHERE seq=?1",[seq],|r|Ok(r.get::<_,Option<bool>>(0)?.unwrap_or(false)))?;
                    {
                        let mut db = self.connection()?;
                        let tx = db.transaction()?;
                        let timestamp = chrono::Utc::now().to_rfc3339();
                        let l = local(&tx)?.unwrap();
                        if !detail["current"]["binding"].is_null() {
                            apply_entity(
                                &tx,
                                "bindings",
                                &detail["current"]["binding"],
                                &l.generation,
                                &timestamp,
                            )?;
                        }
                        tx.execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason='providerSnapshotStale',conflict_detail=?2,updated_at=?3 WHERE seq=?1",params![seq,detail.to_string(),timestamp])?;
                        if !already_retried {
                            let retry_key = format!(
                                "collectionProviderRetry:{}",
                                json!([body["workId"], body["provider"]])
                            );
                            tx.execute("INSERT INTO notes_state(key,value) VALUES(?1,'1') ON CONFLICT(key) DO UPDATE SET value='1'",[retry_key])?;
                        }
                        tx.commit()?;
                    }
                    if !already_retried {
                        // Refetch outside the library lock. The retry is a new immutable operation,
                        // bound to the newly received merge base, and gets exactly one attempt.
                        let work = text(&body, "workId")?;
                        let refetched = refresh(&body);
                        self.connection()?.execute(
                            "DELETE FROM notes_state WHERE key=?1",
                            [format!(
                                "collectionProviderRetry:{}",
                                json!([work, body["provider"]])
                            )],
                        )?;
                        if refetched.is_err() {
                            self.connection()?.execute("UPDATE collection_authority_outbox SET last_error='providerSnapshotRefetchFailed' WHERE seq=?1",[seq])?;
                        }
                    }
                    sent = true;
                    continue;
                }
            }
            let mut db = self.connection()?;
            let tx = db.transaction()?;
            let timestamp = chrono::Utc::now().to_rfc3339();
            match result {
                Ok(CollectionDelivery::Accepted(receipt)) => {
                    envelope(&receipt, &id)?;
                    if receipt["operationId"] != body["operationId"]
                        || receipt["commandType"] != body["commandType"]
                        || receipt["changed"].as_bool().is_none()
                        || receipt["authorityCursor"].as_i64().is_none()
                    {
                        return Err(LibraryError::InvalidCloudResponse);
                    }
                    // Apply confirmed states but do not jump the feed cursor: unrelated
                    // remote rows before this receipt still have to be received.
                    let l = local(&tx)?.unwrap();
                    apply_entities(&tx, &receipt["entities"], &l.generation, &timestamp)?;
                    selections(&tx)?;
                    tx.execute("UPDATE collection_authority_outbox SET state='accepted',receipt=?2,last_error=NULL,updated_at=?3 WHERE seq=?1",params![seq,receipt.to_string(),timestamp])?;
                    sent = true;
                }
                Ok(CollectionDelivery::Conflict(detail)) => {
                    if core_command(text(&body, "commandType")?) {
                        drop_core_intent(&tx, seq, &body, &detail, &timestamp)?;
                        sent = true;
                    } else {
                        tx.execute("UPDATE collection_authority_outbox SET state='blocked',conflict_code=?2,conflict_detail=?3,updated_at=?4 WHERE seq=?1",params![seq,text(&detail,"code")?,detail.to_string(),timestamp])?;
                    }
                }
                Ok(CollectionDelivery::Dropped(detail)) => {
                    if core_command(text(&body, "commandType")?) {
                        drop_core_intent(&tx, seq, &body, &detail, &timestamp)?;
                        sent = true;
                    } else {
                        tx.execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason=?2,conflict_detail=?3,updated_at=?4 WHERE seq=?1",params![seq,text(&detail,"code")?,detail.to_string(),timestamp])?;
                    }
                }
                Ok(CollectionDelivery::Retry)
                | Err(LibraryError::CloudRequestUnavailable)
                | Err(LibraryError::CloudRequestTimedOut) => {
                    tx.execute("UPDATE collection_authority_outbox SET retry_at=?2,last_error='transportUnavailable',updated_at=?3 WHERE seq=?1",params![seq,now+backoff(attempts),timestamp])?;
                    tx.commit()?;
                    break;
                }
                Err(error) => return Err(error),
            }
            reapply_pending_core_edits(&tx)?;
            tx.commit()?;
        }
        Ok(sent)
    }

    #[cfg(test)]
    fn materialize_collection_artwork_with(
        &self,
        status: &CollectionAuthorityStatus,
        download: &dyn Fn(&str, &str, &str, u64, &str, &Path) -> Result<(), LibraryError>,
        now: i64,
        limit: usize,
    ) -> Result<usize, LibraryError> {
        self.materialize_collection_artwork_until(status, download, now, limit, None)
    }

    fn materialize_collection_artwork_until(
        &self,
        status: &CollectionAuthorityStatus,
        download: &dyn Fn(&str, &str, &str, u64, &str, &Path) -> Result<(), LibraryError>,
        now: i64,
        limit: usize,
        deadline: Option<std::time::Instant>,
    ) -> Result<usize, LibraryError> {
        if !status.active {
            return Ok(0);
        }
        ensure_collection_write_ready(&*self.connection()?, status)?;
        let rows=self.connection()?.prepare("SELECT q.artwork_id,q.work_id,q.blob_sha256,q.size_bytes,q.mime_type,q.target_path,q.attempts FROM collection_authority_materialization q WHERE q.state='pending' AND q.retry_at<=?1 AND NOT EXISTS(SELECT 1 FROM collection_authority_trash t WHERE t.work_id=q.work_id) ORDER BY q.created_at,q.artwork_id LIMIT ?2")?
            .query_map(params![now,limit as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)? as u64,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,i64>(6)?)))?.collect::<Result<Vec<_>,_>>()?;
        let mut count = 0;
        for (art, work, sha, size, mime, target, attempts) in rows {
            if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                break;
            }
            // Target is generated by apply, never a source path. Check canonical
            // ancestors too, so a symlink cannot redirect the worker outside root.
            let result = (|| {
                if !target.starts_with("work-artwork/authority/")
                    || Path::new(&target)
                        .components()
                        .any(|c| !matches!(c, Component::Normal(_)))
                {
                    return Err(LibraryError::InvalidWorkArtwork);
                }
                let root = self
                    .root()
                    .canonicalize()
                    .map_err(|_| LibraryError::InvalidWorkArtwork)?;
                let path = root.join(&target);
                let parent = path.parent().unwrap();
                let mut ancestor = parent;
                while !ancestor.exists() {
                    ancestor = ancestor.parent().ok_or(LibraryError::InvalidWorkArtwork)?;
                }
                if !ancestor
                    .canonicalize()
                    .map_err(|_| LibraryError::InvalidWorkArtwork)?
                    .starts_with(&root)
                {
                    return Err(LibraryError::InvalidWorkArtwork);
                }
                std::fs::create_dir_all(parent).map_err(|_| LibraryError::InvalidWorkArtwork)?;
                if !parent
                    .canonicalize()
                    .map_err(|_| LibraryError::InvalidWorkArtwork)?
                    .starts_with(&root)
                {
                    return Err(LibraryError::InvalidWorkArtwork);
                }
                if path.exists() {
                    return verify_blob(&path, &sha, size);
                }
                let temporary = path.with_extension(format!("{art}.part"));
                if temporary.exists()
                    && std::fs::symlink_metadata(&temporary)
                        .map_err(|_| LibraryError::InvalidWorkArtwork)?
                        .file_type()
                        .is_symlink()
                {
                    return Err(LibraryError::InvalidWorkArtwork);
                }
                download(&work, &art, &sha, size, &mime, &temporary)?;
                verify_blob(&temporary, &sha, size)?;
                std::fs::rename(&temporary, &path).map_err(|_| LibraryError::InvalidWorkArtwork)?;
                Ok(())
            })();
            let timestamp = chrono::Utc::now().to_rfc3339();
            self.connection()?.execute("UPDATE collection_authority_materialization SET state=?2,attempts=attempts+1,retry_at=?3,last_error=?4,updated_at=?5 WHERE artwork_id=?1",params![art,if result.is_ok(){"complete"}else{"pending"},if result.is_ok(){0}else{now+backoff(attempts)},if result.is_ok(){None}else{Some("materializationFailed")},timestamp])?;
            if matches!(result, Err(LibraryError::CloudUnauthorized)) {
                return Err(LibraryError::CloudUnauthorized);
            }
            if result.is_ok() {
                count += 1;
            }
        }
        Ok(count)
    }
}

fn verify_blob(path: &Path, sha: &str, size: u64) -> Result<(), LibraryError> {
    use sha2::{Digest, Sha256};
    if std::fs::symlink_metadata(path)
        .map_err(|_| LibraryError::InvalidWorkArtwork)?
        .file_type()
        .is_symlink()
    {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    if std::fs::metadata(path)
        .map_err(|_| LibraryError::InvalidWorkArtwork)?
        .len()
        != size
        || size > 16 * 1024 * 1024
    {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    let bytes = std::fs::read(path).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if bytes.len() as u64 != size
        || Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            != sha
    {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    Ok(())
}

#[cfg(test)]
#[path = "collection_authority_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
mod collection_trash_tests {
    use super::tests::{adopt, fixture, work};
    use super::*;

    fn trashed() -> Value {
        let mut value = work("w", 2);
        value["lifecycle"] = json!("trashed");
        value["trashedAt"] = json!("2026-10-06T00:00:00Z");
        value
    }

    #[test]
    fn collection_trash_restore_is_durable_deduplicated_and_projects_on_receipt() {
        let (_temp, library, status) = fixture();
        adopt(&library, &status, json!({"works":[trashed()]}));
        let id = status.library_id.as_deref().unwrap();
        library.restore_collection_work("w", 2, id, 1).unwrap();
        library.restore_collection_work("w", 2, id, 1).unwrap();
        assert!(library.get_collection("w").is_err());
        let (count, raw): (i64, String) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*),payload FROM collection_authority_outbox",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        let body: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(body["commandType"], "restoreWork");
        assert_eq!(body["expectedRevision"], 2);
        assert!(pending_restore(&library.connection().unwrap(), "w", 2).unwrap());
        library
            .flush_collection_outbox_with(
                &status,
                &|command| {
                    Ok(CollectionDelivery::Accepted(json!({
                        "libraryId":id,"epoch":1,"contractVersion":1,
                        "operationId":command["operationId"],"commandType":"restoreWork",
                        "changed":true,"authorityCursor":1,"entities":{"works":[work("w",3)]}
                    })))
                },
                0,
            )
            .unwrap();
        assert_eq!(library.get_collection("w").unwrap().name, "Work w");
        // A stale UI click after acceptance still reuses the completed request.
        library.restore_collection_work("w", 2, id, 1).unwrap();
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM collection_authority_outbox",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn collection_trash_restore_fences_inactive_unadopted_and_wrong_identity() {
        let (_temp, library, status) = fixture();
        let id = status.library_id.as_deref().unwrap();
        assert!(matches!(
            library.restore_collection_work("w", 2, id, 1),
            Err(LibraryError::CollectionAuthorityNotAdopted)
        ));
        library.observe_collection_authority(&status).unwrap();
        assert!(matches!(
            library.restore_collection_work("w", 2, id, 1),
            Err(LibraryError::CollectionAuthorityNotAdopted)
        ));
        adopt(&library, &status, json!({"works":[trashed()]}));
        assert!(matches!(
            library.restore_collection_work("w", 2, "other", 1),
            Err(LibraryError::CollectionAuthorityMismatch)
        ));
        assert!(matches!(
            library.restore_collection_work("w", 2, id, 2),
            Err(LibraryError::CollectionAuthorityMismatch)
        ));
        assert!(library.restore_collection_work("w", 0, id, 1).is_err());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM collection_authority_outbox",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        library.restore_collection_work("w", 2, id, 1).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collection_authority_outbox SET epoch=2,state='accepted'",
                [],
            )
            .unwrap();
        assert!(!pending_restore(&library.connection().unwrap(), "w", 2).unwrap());
        library.restore_collection_work("w", 2, id, 1).unwrap();
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM collection_authority_outbox",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn collection_trash_read_uses_authority_identity_client_token_and_pending_outbox() {
        let (temp, library, status) = fixture();
        let mut value = trashed();
        value["selection"]["work"] = json!("cover");
        adopt(&library, &status, json!({"works":[value]}));
        let cover = temp.path().join("work-artwork-thumbnails/w/cover.webp");
        std::fs::create_dir_all(cover.parent().unwrap()).unwrap();
        std::fs::write(&cover, b"cached cover").unwrap();
        let id = status.library_id.as_deref().unwrap();
        library.restore_collection_work("w", 2, id, 1).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let reply = json!({"libraryId":id,"epoch":1,"contractVersion":1,"hasMore":false,"items":[{
            "workId":"w","type":"manga","name":"Work w","trashedAt":"2026-10-06T00:00:00Z","purgeAt":"2026-11-05T00:00:00Z","entityRevision":2
        }]});
        let expected_id = id.to_owned();
        let handle = std::thread::spawn(move || {
            for epoch in [1, 2] {
                let request = server
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.method(), &tiny_http::Method::Get);
                assert!(request
                    .url()
                    .starts_with("/v1/collections/authority/trash?"));
                assert!(request.url().contains(&format!("libraryId={expected_id}")));
                assert!(request.url().contains("epoch=1"));
                assert!(request
                    .headers()
                    .iter()
                    .any(|header| header.field.equiv("Authorization")
                        && header.value.as_str() == "Bearer client-token"));
                let mut value = reply.clone();
                value["epoch"] = json!(epoch);
                request
                    .respond(tiny_http::Response::from_string(value.to_string()))
                    .unwrap();
            }
        });
        let page = library
            .list_collection_trash_with(&client, "client-token")
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].restore_pending);
        assert_eq!(
            library.collection_trash_cover("w").unwrap().unwrap(),
            b"cached cover"
        );
        assert_eq!(std::fs::read(cover).unwrap(), b"cached cover");
        assert!(matches!(
            library.list_collection_trash_with(&client, "client-token"),
            Err(LibraryError::CollectionAuthorityMismatch)
        ));
        handle.join().unwrap();
    }
}
