//! One-time hand-over of the old local inbox to the server inbox (per library and server).
//!
//! Unresolved local items the server does not have are re-sent through `POST /v1/av-lookups`
//! with a migration request id that is fixed locally before the first send, so a repeated or
//! interrupted run never inserts twice. The server fetches the candidate again; no local
//! snapshot or choice is uploaded or reapplied. Items the user already applied or discarded
//! locally are never re-sent; if the server still lists them as open they are closed there.
use super::routed::{
    configured_endpoint, fetch_server_list, note, note_json, set_note, set_note_json, InboxServer,
    MAX_LIST_BYTES,
};
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

/// Server calls per run; the intake route allows 30 requests a minute per credential.
const BUDGET: usize = 20;
const RETRY_SECS: i64 = 60;
const RETRY_KEY: &str = "avInbox:migrationRetry";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationItem {
    request_id: String,
    /// `pending`, `sent`, `rejected` or `closed`.
    state: String,
    #[serde(default)]
    corrected_code: Option<String>,
}

struct LocalRow {
    id: String,
    request_id: String,
    product_code: String,
    normalized_code: Option<String>,
    source_url: Option<String>,
    status: String,
    collection_id: Option<String>,
}

#[derive(Default, Debug, PartialEq, Eq)]
pub(crate) struct MigrationCounts {
    pub on_server: usize,
    pub sent: usize,
    pub rejected: usize,
    pub closed: usize,
    pub skipped_closed: usize,
    pub remaining: usize,
}

fn marker_key(endpoint: &str) -> String {
    format!("avInbox:migrated:{endpoint}")
}
fn item_key(id: &str) -> String {
    format!("avInbox:mig:{id}")
}

pub(super) fn inbox_path(request_id: &str) -> Result<String, AvError> {
    uuid::Uuid::parse_str(request_id).map_err(|_| AvError::Invalid)?;
    Ok(format!("/v1/av-inbox/{request_id}"))
}

impl Library {
    /// Whether the one-time migration for the configured server still has work to do.
    pub(super) fn migration_due_at(c: &Connection) -> Result<Option<i64>, AvError> {
        let Some(endpoint) = configured_endpoint(c)? else {
            return Ok(None);
        };
        if note(c, &marker_key(&endpoint))?.is_some() {
            return Ok(None);
        }
        Ok(Some(
            note(c, RETRY_KEY)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        ))
    }

    pub(crate) fn migrate_local_av_inbox_with(
        &self,
        server: &impl InboxServer,
        now: i64,
    ) -> Result<Option<MigrationCounts>, AvError> {
        let (endpoint, rows) = {
            let c = self.connection()?;
            let Some(due) = Self::migration_due_at(&c)? else {
                return Ok(None);
            };
            if due > now {
                return Ok(None);
            }
            let endpoint = configured_endpoint(&c)?.ok_or(AvError::Invalid)?;
            let rows = c
                .prepare("SELECT id,request_id,product_code,normalized_code,source_url,status,collection_id FROM av_link_inbox ORDER BY received_at,id")?
                .query_map([], |r| {
                    Ok(LocalRow {
                        id: r.get(0)?,
                        request_id: r.get(1)?,
                        product_code: r.get(2)?,
                        normalized_code: r.get(3)?,
                        source_url: r.get(4)?,
                        status: r.get(5)?,
                        collection_id: r.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            (endpoint, rows)
        };
        // An incomplete server list is never trusted: absence would re-send known items.
        let listed = match fetch_server_list(server, true) {
            Ok(listed) => listed,
            Err(error) => {
                set_note(
                    &*self.connection()?,
                    RETRY_KEY,
                    &(now + RETRY_SECS).to_string(),
                )?;
                return Err(error);
            }
        };
        let on_server: BTreeMap<String, (String, Option<String>)> = listed
            .iter()
            .filter_map(|v| {
                Some((
                    v["requestId"].as_str()?.to_owned(),
                    (
                        v["status"].as_str()?.to_owned(),
                        v["normalizedCode"].as_str().map(str::to_owned),
                    ),
                ))
            })
            .collect();
        let mut counts = MigrationCounts::default();
        let mut budget = BUDGET;
        let mut stop: Option<AvError> = None;
        for row in &rows {
            if stop.is_some() {
                counts.remaining += 1;
                continue;
            }
            let unresolved = matches!(
                row.status.as_str(),
                "queued" | "fetching" | "found" | "not_found" | "error"
            );
            let closed_locally = matches!(row.status.as_str(), "dismissed" | "applied");
            if !unresolved && !closed_locally {
                continue;
            }
            let mut item: Option<MigrationItem> =
                note_json(&*self.connection()?, &item_key(&row.id))?;
            if unresolved {
                if let Some((status, server_code)) = on_server.get(&row.request_id) {
                    counts.on_server += 1;
                    let local_code = row
                        .normalized_code
                        .as_deref()
                        .and_then(provider::normalize_code);
                    if matches!(
                        status.as_str(),
                        "queued" | "fetching" | "found" | "not_found" | "error"
                    ) && local_code
                        .as_ref()
                        .is_some_and(|code| Some(code) != server_code.as_ref())
                        && item.as_ref().and_then(|i| i.corrected_code.as_ref())
                            != local_code.as_ref()
                    {
                        // Validate persisted ids before interpolating any action URL.
                        let Ok(path) = inbox_path(&row.request_id) else {
                            counts.rejected += 1;
                            continue;
                        };
                        if budget == 0 {
                            counts.remaining += 1;
                            continue;
                        }
                        budget -= 1;
                        let answer = server.request(
                            "POST",
                            &format!("{path}/fix-code"),
                            Some(&json!({"productCode":local_code})),
                            MAX_LIST_BYTES,
                        );
                        match answer {
                            Ok(r) if r.status == 200 => {
                                set_note_json(
                                    &*self.connection()?,
                                    &item_key(&row.id),
                                    &MigrationItem {
                                        request_id: row.request_id.clone(),
                                        state: "sent".into(),
                                        corrected_code: local_code,
                                    },
                                )?;
                                set_note(&*self.connection()?, "avInbox:mirrorAt", "0")?;
                            }
                            Ok(r) if matches!(r.status, 401 | 403) => {
                                counts.remaining += 1;
                                stop = Some(LibraryError::CloudUnauthorized.into());
                            }
                            _ => {
                                counts.remaining += 1;
                                stop = Some(LibraryError::CloudRequestUnavailable.into());
                            }
                        }
                    }
                    continue;
                }
                // Fix the request id before the first send so a retry reuses it.
                let mut mig = match item.take() {
                    Some(mig) => mig,
                    None => {
                        let mig = MigrationItem {
                            request_id: uuid::Uuid::new_v4().to_string(),
                            state: "pending".into(),
                            corrected_code: None,
                        };
                        set_note_json(&*self.connection()?, &item_key(&row.id), &mig)?;
                        mig
                    }
                };
                match mig.state.as_str() {
                    "sent" => {
                        counts.sent += 1;
                        continue;
                    }
                    "rejected" => {
                        counts.rejected += 1;
                        continue;
                    }
                    _ => {}
                }
                if on_server.contains_key(&mig.request_id) {
                    mig.state = "sent".into();
                    set_note_json(&*self.connection()?, &item_key(&row.id), &mig)?;
                    counts.sent += 1;
                    continue;
                }
                if budget == 0 {
                    counts.remaining += 1;
                    continue;
                }
                budget -= 1;
                let code = row
                    .normalized_code
                    .clone()
                    .unwrap_or_else(|| row.product_code.clone());
                let source = row
                    .source_url
                    .clone()
                    .filter(|u| u.starts_with("https://") && u.chars().count() <= 2048);
                let body =
                    json!({"requestId":mig.request_id,"productCode":code,"sourceUrl":source});
                let outcome = if code.trim().is_empty() || code.chars().count() > 40 {
                    Ok(Some("rejected"))
                } else {
                    match server.request("POST", "/v1/av-lookups", Some(&body), MAX_LIST_BYTES) {
                        Ok(r) if r.status == 200 || r.status == 409 => Ok(Some("sent")),
                        Ok(r) if matches!(r.status, 413 | 422) => Ok(Some("rejected")),
                        Ok(r) if matches!(r.status, 401 | 403) => {
                            Err(AvError::Library(LibraryError::CloudUnauthorized))
                        }
                        Ok(_) | Err(_) => Ok(None),
                    }
                };
                match outcome {
                    Ok(Some(state)) => {
                        mig.state = state.into();
                        set_note_json(&*self.connection()?, &item_key(&row.id), &mig)?;
                        if state == "sent" {
                            counts.sent += 1;
                        } else {
                            counts.rejected += 1;
                        }
                    }
                    Ok(None) => {
                        counts.remaining += 1;
                        stop = Some(AvError::Library(LibraryError::CloudRequestUnavailable));
                    }
                    Err(error) => {
                        counts.remaining += 1;
                        stop = Some(error);
                    }
                }
            } else {
                // Applied or discarded locally: never re-sent, never re-applied.
                counts.skipped_closed += 1;
                let Some((status, _)) = on_server.get(&row.request_id) else {
                    continue;
                };
                if !matches!(
                    status.as_str(),
                    "queued" | "fetching" | "found" | "not_found" | "error"
                ) || item.as_ref().is_some_and(|i| i.state == "closed")
                {
                    continue;
                }
                let Ok(path) = inbox_path(&row.request_id) else {
                    counts.rejected += 1;
                    continue;
                };
                if budget == 0 {
                    counts.remaining += 1;
                    continue;
                }
                budget -= 1;
                let mut closed = false;
                if row.status == "applied" && status == "found" {
                    if let Some(work) = &row.collection_id {
                        let answer = server.request(
                            "POST",
                            &format!("{path}/applied"),
                            Some(&json!({"workId": work})),
                            MAX_LIST_BYTES,
                        );
                        closed = matches!(answer, Ok(r) if r.status == 200);
                    }
                }
                if !closed {
                    match server.request(
                        "POST",
                        &format!("{path}/dismiss"),
                        Some(&json!({})),
                        MAX_LIST_BYTES,
                    ) {
                        Ok(r) if r.status == 200 => closed = true,
                        Ok(r) if matches!(r.status, 401 | 403) => {
                            counts.remaining += 1;
                            stop = Some(AvError::Library(LibraryError::CloudUnauthorized));
                            continue;
                        }
                        _ => {}
                    }
                }
                if closed {
                    counts.closed += 1;
                    set_note_json(
                        &*self.connection()?,
                        &item_key(&row.id),
                        &MigrationItem {
                            request_id: row.request_id.clone(),
                            state: "closed".into(),
                            corrected_code: None,
                        },
                    )?;
                } else {
                    counts.remaining += 1;
                }
            }
        }
        let c = self.connection()?;
        if counts.sent + counts.closed > 0 {
            // The mirror is read again on the next cycle so the screen shows the new state.
            set_note(&c, "avInbox:mirrorAt", "0")?;
        }
        if stop.is_none() && counts.remaining == 0 {
            set_note(&c, &marker_key(&endpoint), &now.to_string())?;
            eprintln!(
                "av-inbox migration done: onServer={} sent={} rejected={} closedOnServer={} skippedLocallyClosed={}",
                counts.on_server, counts.sent, counts.rejected, counts.closed, counts.skipped_closed
            );
        } else {
            set_note(&c, RETRY_KEY, &(now + RETRY_SECS).to_string())?;
            eprintln!(
                "av-inbox migration partial: sent={} rejected={} closedOnServer={} remaining={}",
                counts.sent, counts.rejected, counts.closed, counts.remaining
            );
        }
        match stop {
            Some(error) => Err(error),
            None => Ok(Some(counts)),
        }
    }
}
