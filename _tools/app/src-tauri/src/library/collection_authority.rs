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

/// Read stored values, not summary fallback covers, for field-level compare-and-set.
pub(crate) fn editable_work(db: &Connection, work: &str) -> Result<Value, LibraryError> {
    db.query_row("SELECT name,description,cover_asset_id,year,original_title,runtime_minutes,author,director,developer,publisher,platforms,production_company,release_date,external_score,my_score,genres,overview,showcase,p.status,p.owned_platform FROM collections c LEFT JOIN collection_pc_records p ON p.collection_id=c.id WHERE c.id=?1", [work], |r| {
        Ok(json!({"name":r.get::<_,String>(0)?,"description":r.get::<_,Option<String>>(1)?,"coverAssetId":r.get::<_,Option<String>>(2)?,"year":r.get::<_,Option<i64>>(3)?,"originalTitle":r.get::<_,Option<String>>(4)?,"runtimeMinutes":r.get::<_,Option<i64>>(5)?,"author":r.get::<_,Option<String>>(6)?,"director":r.get::<_,Option<String>>(7)?,"developer":r.get::<_,Option<String>>(8)?,"publisher":r.get::<_,Option<String>>(9)?,"platforms":r.get::<_,Option<String>>(10)?,"productionCompany":r.get::<_,Option<String>>(11)?,"releaseDate":r.get::<_,Option<String>>(12)?,"externalScore":r.get::<_,Option<i64>>(13)?,"myScore":r.get::<_,Option<f64>>(14)?,"genres":r.get::<_,Option<String>>(15)?,"overview":r.get::<_,Option<String>>(16)?,"showcase":r.get::<_,bool>(17)?,"status":r.get::<_,Option<String>>(18)?,"ownedPlatform":r.get::<_,Option<String>>(19)?}))
    }).optional()?.ok_or(LibraryError::CollectionNotFound)
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
    if let Some(rows) = snapshot["collections"].as_array_mut() {
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
        tx.execute(
            "DELETE FROM collection_person_relations WHERE collection_id=?1",
            [text(v, "workId")?],
        )?;
        for c in credits {
            tx.execute("INSERT INTO collection_people(id,display_name,name_ja,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,name_ja=excluded.name_ja",
                params![text(c,"personId")?,text(c,"name")?,sql_value(&c["nameJa"])?,now])?;
            tx.execute("INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES(?1,?2,?3,?4,?5)",
                params![text(v,"workId")?,text(c,"personId")?,text(c,"role")?,integer(c,"order")?,text(c,"name")?])?;
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
        for (slot, kind) in [
            ("work", "cover"),
            ("hero", "hero"),
            ("backdrop", "backdrop"),
            ("spine", "spine"),
        ] {
            if let Some(selected) = w["selection"].get(slot) {
                tx.execute("UPDATE collection_work_artworks SET selected=0 WHERE collection_id=?1 AND kind=?2 AND selected=1",params![text(&w,"workId")?,kind])?;
                tx.execute("UPDATE collection_work_artworks SET selected=1 WHERE collection_id=?1 AND kind=?2 AND id=?3",params![text(&w,"workId")?,kind,sql_value(selected)?])?;
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
                    let credential = if publisher_command(text(body, "commandType")?) {
                        publisher.ok_or(LibraryError::CloudCredentialNotConfigured)?
                    } else {
                        token
                    };
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
        // Skeleton is deliberately bounded to two originals per cadence.
        changed |= self.materialize_collection_artwork_with(
            &status,
            &|w, a, sha, size, mime, path| {
                client.download_collection_artwork(w, a, sha, size, mime, path, token)
            },
            chrono::Utc::now().timestamp(),
            2,
        )? > 0;
        Ok((changed, sent))
    }
}

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
    )
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
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute("INSERT INTO collection_authority_outbox(operation_id,library_id,epoch,contract_version,command_type,entity_key,payload,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",params![operation,id.library,id.epoch,id.version,command,entity_key,Value::Object(body).to_string(),now])?;
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

    fn materialize_collection_artwork_with(
        &self,
        status: &CollectionAuthorityStatus,
        download: &dyn Fn(&str, &str, &str, u64, &str, &Path) -> Result<(), LibraryError>,
        now: i64,
        limit: usize,
    ) -> Result<usize, LibraryError> {
        if !status.active {
            return Ok(0);
        }
        ensure_collection_write_ready(&*self.connection()?, status)?;
        let rows=self.connection()?.prepare("SELECT q.artwork_id,q.work_id,q.blob_sha256,q.size_bytes,q.mime_type,q.target_path,q.attempts FROM collection_authority_materialization q WHERE q.state='pending' AND q.retry_at<=?1 AND NOT EXISTS(SELECT 1 FROM collection_authority_trash t WHERE t.work_id=q.work_id) ORDER BY q.created_at,q.artwork_id LIMIT ?2")?
            .query_map(params![now,limit.min(2) as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)? as u64,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,i64>(6)?)))?.collect::<Result<Vec<_>,_>>()?;
        let mut count = 0;
        for (art, work, sha, size, mime, target, attempts) in rows {
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
mod tests;
