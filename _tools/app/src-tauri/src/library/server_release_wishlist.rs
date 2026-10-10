//! Sticky endpoint/library ownership, lossless one-shot seed and durable client intents.
//! Stored in the existing notes_state transport store; no domain-table migration.
use super::{
    error::LibraryError,
    release_wishlist::{WatchEvent, WatchItem},
    Library,
};
use crate::cloud::{client::WishlistReply, status_watch::endpoint_key};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Ownership {
    server: bool,
    seed: Option<Value>,
    display: Vec<WatchItem>,
    projection_revision: Option<i64>,
    outbox: Vec<Outgoing>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Outgoing {
    body: Value,
    title: Option<Value>,
    delivered: bool,
}

fn key(endpoint: &str, library: &str) -> String {
    format!(
        "serverReleaseWishlist:{}",
        json!([endpoint_key(endpoint), library])
    )
}

fn load(db: &Connection, key: &str) -> Result<Ownership, LibraryError> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM notes_state WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| LibraryError::InvalidCloudResponse))
        .unwrap_or_else(|| Ok(Ownership::default()))
}
fn save(db: &Connection, key: &str, state: &Ownership) -> Result<(), LibraryError> {
    db.execute("INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, serde_json::to_string(state).map_err(|_|LibraryError::InvalidCloudResponse)?])?;
    Ok(())
}

fn rows(db: &Connection, sql: &str) -> Result<Vec<Value>, LibraryError> {
    let mut statement = db.prepare(sql)?;
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    let values = statement
        .query_map([], |r| {
            let mut object = serde_json::Map::new();
            for (i, name) in columns.iter().enumerate() {
                let value = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Text(s) => {
                        json!(std::str::from_utf8(s).map_err(|_| rusqlite::Error::InvalidQuery)?)
                    }
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn snapshot(
    db: &Connection,
    endpoint: &str,
    library: &str,
    status: &Value,
) -> Result<Value, LibraryError> {
    let publication: Option<String> = db
        .query_row(
            "SELECT state_json FROM home_publication_state WHERE endpoint=?1 AND kind='upcoming'",
            [endpoint_key(endpoint)],
            |r| r.get(0),
        )
        .optional()?;
    let cursor = publication
        .map(|s| serde_json::from_str::<Value>(&s).map_err(|_| LibraryError::InvalidCloudResponse))
        .transpose()?
        .and_then(|s| s["cursor"].as_i64())
        .unwrap_or(0);
    let body = json!({"version":1,"operationId":uuid::Uuid::new_v4().to_string(),
        "expectedRevision":status["revision"],"expectedDigest":status["digest"],
        "libraryId":library,"endpoint":endpoint_key(endpoint),"intentCursor":cursor,
        "items":rows(db,"SELECT id,kind,provider,external_id,title,original_title,cover,platforms_json,tracked_platforms_json,source,added_at,muted,last_checked_at,next_check_at,released_at FROM release_watch_items ORDER BY id")?,
        "dates":rows(db,"SELECT item_id,region,platform,date,precision,checked_at FROM release_watch_dates ORDER BY item_id,region,platform")?,
        "events":rows(db,"SELECT id,item_id,event_kind,previous_value,current_value,detected_at,read_at FROM release_watch_item_events ORDER BY item_id,detected_at,id")?});
    if body["items"].as_array().unwrap().len() > 1000
        || body["dates"].as_array().unwrap().len() > 100000
        || body["events"].as_array().unwrap().len() > 100000
        || serde_json::to_vec(&body).unwrap().len() > 16 * 1024 * 1024
    {
        return Err(LibraryError::WishlistSeedTooLarge);
    }
    Ok(body)
}

fn observe(state: &mut Ownership, status: &Value) -> Result<(), LibraryError> {
    if status["version"] != 1 || !matches!(status["mode"].as_str(), Some("server" | "awaitingSeed"))
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    if status["mode"] == "server" {
        state.server = true;
    }
    Ok(())
}

fn enqueue(
    state: &mut Ownership,
    action: &str,
    item: &str,
    events: &[String],
    title: Option<Value>,
) {
    let family = |a: &str| match a {
        "add" | "remove" => 0,
        "mute" | "unmute" => 1,
        _ => 2,
    };
    if family(action) != 2 {
        if state
            .outbox
            .iter()
            .any(|p| p.body["itemId"] == item && p.body["action"] == action)
        {
            return;
        }
        state.outbox.retain(|p| {
            p.body["itemId"] != item
                || family(p.body["action"].as_str().unwrap_or("")) != family(action)
        });
    }
    let mut body = json!({"version":1,"operationId":uuid::Uuid::new_v4().to_string(),"action":action,"itemId":item});
    if action == "acknowledge" {
        body["eventIds"] = json!(events);
    }
    state.outbox.push(Outgoing {
        body,
        title,
        delivered: false,
    });
}

fn projected_item(public: &Value) -> Result<WatchItem, LibraryError> {
    let title =
        serde_json::from_value::<super::server_release_calendar::PublishedTitle>(public.clone())
            .map_err(|_| LibraryError::InvalidCloudResponse)?
            .into_title()?;
    let unread = public["events"]
        .as_array()
        .map(|events| {
            events
                .iter()
                .map(|e| {
                    Ok(WatchEvent {
                        id: e["id"]
                            .as_str()
                            .ok_or(LibraryError::InvalidCloudResponse)?
                            .into(),
                        item_id: title.id.clone(),
                        kind: e["kind"]
                            .as_str()
                            .ok_or(LibraryError::InvalidCloudResponse)?
                            .into(),
                        previous_value: e["previousValue"].as_str().map(str::to_owned),
                        current_value: e["currentValue"].as_str().map(str::to_owned),
                        detected_at: e["detectedAt"]
                            .as_str()
                            .ok_or(LibraryError::InvalidCloudResponse)?
                            .into(),
                        read_at: e["readAt"].as_str().map(str::to_owned),
                    })
                })
                .collect::<Result<Vec<_>, LibraryError>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(WatchItem {
        id: title.id,
        kind: title.kind,
        provider: title.provider,
        external_id: title.external_id,
        title: title.title,
        original_title: title.original_title,
        cover: title.cover,
        platforms: title.platforms,
        date: title.date,
        precision: title.precision,
        region: title.region,
        dates: title.dates,
        source: public["source"].as_str().unwrap_or("calendar").into(),
        added_at: public["addedAt"].as_str().unwrap_or("").into(),
        muted: public["muted"].as_bool().unwrap_or(false),
        last_checked_at: None,
        next_check_at: None,
        released: public["released"].as_bool().unwrap_or(false),
        unread,
    })
}

pub(super) fn validate_projection(document: &Value) -> Result<(), LibraryError> {
    let items = document["wishlist"]
        .as_array()
        .ok_or(LibraryError::InvalidCloudResponse)?;
    for item in items {
        projected_item(item)?;
    }
    Ok(())
}

fn overlay(mut items: Vec<WatchItem>, state: &Ownership) -> Result<Vec<WatchItem>, LibraryError> {
    for entry in &state.outbox {
        let id = entry.body["itemId"].as_str().unwrap_or("");
        match entry.body["action"].as_str().unwrap_or("") {
            "remove" => items.retain(|i| i.id != id),
            "add" if !items.iter().any(|i| i.id == id) => {
                if let Some(title) = &entry.title {
                    items.push(projected_item(title)?);
                }
            }
            "mute" | "unmute" => {
                if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                    item.muted = entry.body["action"] == "mute";
                }
            }
            "acknowledge" => {
                if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                    item.unread.retain(|e| {
                        !entry.body["eventIds"]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|v| v == &e.id))
                    });
                }
            }
            _ => {}
        }
    }
    items.sort_by(|a, b| {
        (a.date.is_none(), &a.date, &a.title, &a.id).cmp(&(
            b.date.is_none(),
            &b.date,
            &b.title,
            &b.id,
        ))
    });
    Ok(items)
}

fn reconcile(state: &mut Ownership, document: &Value) {
    let Some(items) = document["wishlist"].as_array() else {
        return;
    };
    state.outbox.retain(|p| {
        if !p.delivered {
            return true;
        }
        let item = items.iter().find(|i| i["id"] == p.body["itemId"]);
        let confirmed = match p.body["action"].as_str().unwrap_or("") {
            "add" => item.is_some(),
            "remove" => item.is_none(),
            "mute" | "unmute" => item.is_none_or(|i| i["muted"] == (p.body["action"] == "mute")),
            "acknowledge" => item.is_none_or(|i| {
                i["events"].as_array().is_some_and(|events| {
                    p.body["eventIds"].as_array().is_some_and(|ids| {
                        ids.iter().all(|id| !events.iter().any(|e| &e["id"] == id))
                    })
                })
            }),
            _ => false,
        };
        !confirmed
    });
}

impl Library {
    /// A definitive unowned rejection resumes edits queued after the seed snapshot.
    /// This is transport recovery before ownership, not a reverse handover/import.
    fn resume_local_wishlist_outbox(
        &self,
        key: &str,
        state: &mut Ownership,
    ) -> Result<(), LibraryError> {
        if state.server || state.seed.is_some() || state.outbox.is_empty() {
            return Ok(());
        }
        let now = chrono::Utc::now();
        let today = chrono::Local::now().date_naive();
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        for entry in &state.outbox {
            let id = entry.body["itemId"]
                .as_str()
                .ok_or(LibraryError::InvalidCloudResponse)?;
            match entry.body["action"].as_str() {
                Some("add") => {
                    let public = entry
                        .title
                        .clone()
                        .ok_or(LibraryError::InvalidCloudResponse)?;
                    let title = serde_json::from_value::<
                        super::server_release_calendar::PublishedTitle,
                    >(public)
                    .map_err(|_| LibraryError::InvalidCloudResponse)?
                    .into_title()?;
                    super::release_wishlist::insert_watch(&tx, &title, "calendar", now, today)?;
                }
                Some("remove") => super::release_wishlist::remove_watch(&tx, id)?,
                Some("mute" | "unmute") => {
                    super::release_wishlist::mute_watch(&tx, id, entry.body["action"] == "mute")?
                }
                Some("acknowledge") => {
                    let ids: Vec<String> = serde_json::from_value(entry.body["eventIds"].clone())
                        .map_err(|_| LibraryError::InvalidCloudResponse)?;
                    super::release_wishlist::acknowledge_watch(&tx, &ids)?;
                }
                _ => return Err(LibraryError::InvalidCloudResponse),
            }
        }
        state.outbox.clear();
        save(&tx, key, state)?;
        tx.commit()?;
        self.publication_inputs.signal(&[8]);
        Ok(())
    }

    /// Network failures keep durable edits queued. Only a definitive rejection is an edit error.
    pub(crate) fn flush_release_wishlist_edits(&self) -> Result<(), LibraryError> {
        match self.sync_server_release_wishlist() {
            Err(
                error @ (LibraryError::WishlistRequestRejected(_)
                | LibraryError::WishlistSeedTooLarge
                | LibraryError::WishlistManualUnavailable
                | LibraryError::InvalidCloudResponse
                | LibraryError::CloudUnauthorized),
            ) => Err(error),
            _ => Ok(()),
        }
    }

    pub(crate) fn refresh_release_wishlist(&self) -> Result<(), LibraryError> {
        self.flush_release_wishlist_edits()?;
        if self.server_release_wishlist_blocked()? {
            // Offline reads retain the previous disk projection plus pending edits.
            match self.refresh_server_calendar_cache(true) {
                Err(
                    error @ (LibraryError::InvalidCloudResponse | LibraryError::CloudUnauthorized),
                ) => return Err(error),
                _ => {}
            }
        }
        Ok(())
    }

    pub(super) fn wishlist_key(&self) -> Result<String, LibraryError> {
        Ok(key(
            self.cloud_sync_config()?
                .api_base_url
                .as_deref()
                .unwrap_or(""),
            &self.library_id()?,
        ))
    }

    /// Absence, OFF and transport failures never clear an observed server owner.
    pub fn server_release_wishlist_blocked(&self) -> Result<bool, LibraryError> {
        let key = self.wishlist_key()?;
        let db = self.connection()?;
        let state = load(&db, &key)?;
        Ok(state.server || state.seed.is_some())
    }

    /// Serialize with local commands, complete provider passes, intent application and PUTs.
    /// A persisted seed keeps those writers fenced across crashes and lost replies.
    pub(crate) fn sync_server_release_wishlist(&self) -> Result<(), LibraryError> {
        let Some((client, token)) = self.authority_client()? else {
            return Ok(());
        };
        let endpoint = self
            .cloud_sync_config()?
            .api_base_url
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        self.sync_wishlist_with(
            &endpoint,
            &|| client.calendar_read("/v1/home/upcoming/wishlist/status", token.expose()),
            &|body| {
                let publisher = super::credential::read_cloud_publisher_token_os()?;
                client.wishlist_send(true, body, publisher.expose())
            },
            &|body| client.wishlist_send(false, body, token.expose()),
        )
    }

    fn sync_wishlist_with(
        &self,
        endpoint: &str,
        read: &dyn Fn() -> Result<Value, LibraryError>,
        seed: &dyn Fn(&Value) -> Result<WishlistReply, LibraryError>,
        send: &dyn Fn(&Value) -> Result<WishlistReply, LibraryError>,
    ) -> Result<(), LibraryError> {
        let _guard = self
            .release_wishlist_authority
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let library = self.library_id()?;
        let key = key(endpoint, &library);
        let mut state = load(&*self.connection()?, &key)?;
        let mut status = read()?;
        observe(&mut state, &status)?;
        if state.server {
            // Persist status-confirmed ownership even if receipt recovery subsequently fails.
            save(&*self.connection()?, &key, &state)?;
        }
        // Recover the original receipt before discarding an uncertain seed payload.
        for _ in 0..3 {
            if state.seed.is_none() {
                observe(&mut state, &status)?;
                if state.server {
                    save(&*self.connection()?, &key, &state)?;
                }
                if state.server || status["enabled"] != true || status["mode"] != "awaitingSeed" {
                    break;
                }
                state.display = self.local_release_watch_items()?;
                let mut db = self.connection()?;
                let tx = db.transaction()?;
                let captured = snapshot(&tx, endpoint, &library, &status);
                if let Err(error) = captured {
                    drop(tx);
                    drop(db);
                    self.resume_local_wishlist_outbox(&key, &mut state)?;
                    return Err(error);
                }
                state.seed = Some(captured?);
                save(&tx, &key, &state)?;
                tx.commit()?;
            }
            let body = state.seed.as_ref().unwrap();
            match seed(body)? {
                WishlistReply::Accepted(receipt) => {
                    if receipt["version"] != 1
                        || receipt["mode"] != "server"
                        || receipt["operationId"] != body["operationId"]
                    {
                        return Err(LibraryError::InvalidCloudResponse);
                    }
                    state.server = true;
                    state.projection_revision = receipt["revision"].as_i64();
                    state.seed = None;
                    save(&*self.connection()?, &key, &state)?;
                    break;
                }
                WishlistReply::Rejected(_, code)
                    if code == "wishlistSeedConflict"
                        || code == "wishlistCursorConflict"
                        || code == "serverWishlistOwned"
                        || code == "releaseWishlistDisabled" =>
                {
                    status = read()?;
                    observe(&mut state, &status)?;
                    // Explicit unowned status after a rejection proves no seed was accepted.
                    if state.server || status["mode"] == "awaitingSeed" {
                        state.seed = None;
                    }
                    save(&*self.connection()?, &key, &state)?;
                    if state.server {
                        break;
                    }
                    if code == "releaseWishlistDisabled" && status["enabled"] != true {
                        break;
                    }
                    if code == "wishlistCursorConflict" || code == "releaseWishlistDisabled" {
                        self.resume_local_wishlist_outbox(&key, &mut state)?;
                        return Err(LibraryError::WishlistRequestRejected(code));
                    }
                }
                WishlistReply::Rejected(status, code) => {
                    if (400..500).contains(&status)
                        && status != 404
                        && status != 408
                        && status != 429
                    {
                        // These validation failures cannot commit a seed. Do not truncate the snapshot.
                        state.seed = None;
                        save(&*self.connection()?, &key, &state)?;
                        self.resume_local_wishlist_outbox(&key, &mut state)?;
                    }
                    return Err(if status >= 500 || status == 408 || status == 429 {
                        LibraryError::CloudRequestUnavailable
                    } else {
                        LibraryError::WishlistRequestRejected(code)
                    });
                }
            }
        }
        if state.seed.is_some() {
            return Err(LibraryError::WishlistHandoverPending);
        }
        if !state.server {
            self.resume_local_wishlist_outbox(&key, &mut state)?;
            return Ok(());
        }
        for i in 0..state.outbox.len() {
            match send(&state.outbox[i].body)? {
                WishlistReply::Accepted(reply)
                    if reply["version"] == 1
                        && reply["operationId"] == state.outbox[i].body["operationId"] =>
                {
                    state.outbox[i].delivered = true;
                    save(&*self.connection()?, &key, &state)?;
                }
                WishlistReply::Accepted(_) => return Err(LibraryError::InvalidCloudResponse),
                WishlistReply::Rejected(status, code) => {
                    if (400..500).contains(&status)
                        && status != 404
                        && status != 408
                        && status != 429
                    {
                        state.outbox.remove(i);
                        save(&*self.connection()?, &key, &state)?;
                    }
                    return Err(if status >= 500 || status == 408 || status == 429 {
                        LibraryError::CloudRequestUnavailable
                    } else {
                        LibraryError::WishlistRequestRejected(code)
                    });
                }
            }
        }
        Ok(())
    }

    pub(super) fn queue_wishlist_intent(
        &self,
        action: &str,
        id: &str,
        events: &[String],
    ) -> Result<(), LibraryError> {
        let key = self.wishlist_key()?;
        let mut state = load(&*self.connection()?, &key)?;
        let title = if action == "add" {
            self.server_calendar_document()?["entries"]
                .as_array()
                .and_then(|rows| rows.iter().find(|r| r["id"] == id))
                .cloned()
                .or_else(|| {
                    self.server_calendar_document().ok().and_then(|d| {
                        d["wishlist"]
                            .as_array()
                            .and_then(|rows| rows.iter().find(|r| r["id"] == id))
                            .cloned()
                    })
                })
                .or(if state.server {
                    None
                } else {
                    self.local_wishlist_public_title(id)?
                })
                .ok_or(LibraryError::WishlistManualUnavailable)
                .map(Some)?
        } else {
            None
        };
        let db = self.connection()?;
        enqueue(&mut state, action, id, events, title);
        save(&db, &key, &state)?;
        self.publication_inputs.signal(&[8]);
        Ok(())
    }

    pub(super) fn server_wishlist_items(&self) -> Result<Vec<WatchItem>, LibraryError> {
        let key = self.wishlist_key()?;
        let state = load(&*self.connection()?, &key)?;
        let items = if state.server {
            let document = self.server_calendar_document()?;
            if state.projection_revision.is_some_and(|minimum| {
                document["revision"]
                    .as_i64()
                    .is_none_or(|revision| revision < minimum)
            }) {
                state.display.clone()
            } else {
                document["wishlist"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .map(projected_item)
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?
                    .unwrap_or_else(|| state.display.clone())
            }
        } else {
            self.local_release_watch_items()?
        };
        overlay(items, &state)
    }

    pub(super) fn confirm_wishlist_projection_on(
        &self,
        db: &Connection,
        key: &str,
        document: &Value,
    ) -> Result<(), LibraryError> {
        let mut state = load(db, key)?;
        reconcile(&mut state, document);
        save(db, key, &state)
    }
}

#[cfg(test)]
#[path = "server_release_wishlist_tests.rs"]
mod tests;
