//! Manga release notifications (신간 알림) shared with mobile (server contract:
//! `server/lakomics-api/collection_releases.py`, decided 2026-09-25).
//!
//! * **Upload** (`PUT …/releases/unread`, publisher): the PC's whole UNREAD set from
//!   `release_watch_events` (all three kinds, published Collection types only, newest
//!   `MAX_EVENTS`), chunked under one generation (Unix milliseconds at upload start, strictly
//!   above the last one this PC used), `final: true` on the last chunk, which retires what the
//!   PC no longer has unread. It runs whenever the set changed (fingerprint: new events, a
//!   local 확인, a rename), after a read-log recovery, and at least daily. Ids the server
//!   already holds as read (`alreadyRead`) are acknowledged locally at once.
//! * **Read log** (`GET …/releases/reads`, publisher, `after` exclusive): at most once a
//!   minute; each entry acknowledges the event locally (unknown/already read ids are no-ops),
//!   in one transaction with the cursor step. `releaseReadCursorExpired` resumes from the
//!   server's `lastSequence` and forces a complete upload, whose `alreadyRead` replies cover
//!   every still-relevant read event; a cursor ahead of a restarted log reads it again.
//! * Local acknowledgements from the server refresh the PC UI (`library://collections-changed`).
//!
//! State lives per endpoint as one JSON value in the existing key/value table `notes_state`
//! (key `collectionReleaseSync:<endpoint>`), so no schema migration is needed. Network work
//! holds no database lock; the lane runs on a publication worker thread.
use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{error::LibraryError, Library};
use crate::cloud::client::CloudClient;
use crate::cloud::collection_releases::{
    chunk_uploads, validate_upload_result, ReadEntry, ReleaseEvent, ReleaseUpload, MAX_EVENTS,
    PAGE_LIMIT,
};
use crate::library::credential;

const STATE_PREFIX: &str = "collectionReleaseSync:";
/// Read-log pages one pass may apply; the durable cursor drains a backlog across passes.
const MAX_PAGES: usize = 10;
/// A complete upload is repeated at least this often even when nothing changed.
const REFRESH_SECONDS: i64 = 24 * 60 * 60;
/// Sends of one chunk (the same body and operation id) before the pass gives up.
const CHUNK_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ReleaseSyncState {
    /// Last read-log sequence applied (exclusive `after` of the next read).
    pub read_cursor: i64,
    /// Fingerprint of the unread set of the last complete upload.
    pub uploaded: Option<String>,
    pub uploaded_at: i64,
    /// Highest generation this PC used; the next upload is strictly above it.
    pub generation: i64,
    /// Unix seconds before which no upload is attempted (failure backoff).
    pub retry_after: i64,
    pub last_polled: i64,
    /// A complete upload is required (read-log recovery).
    pub full_upload: bool,
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn state_key(endpoint: &str) -> String {
    format!("{STATE_PREFIX}{endpoint}")
}

fn read_state(c: &Connection, endpoint: &str) -> Result<ReleaseSyncState, LibraryError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT value FROM notes_state WHERE key=?1",
            [state_key(endpoint)],
            |r| r.get(0),
        )
        .optional()?;
    // A damaged value restarts from scratch: the read log is re-read (acks are idempotent)
    // and a complete upload follows.
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

fn write_state(
    c: &Connection,
    endpoint: &str,
    state: &ReleaseSyncState,
) -> Result<(), LibraryError> {
    let value = serde_json::to_string(state).map_err(|_| LibraryError::InvalidCloudResponse)?;
    c.execute(
        "INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![state_key(endpoint), value],
    )?;
    Ok(())
}

/// `detectedAt` as the server's ISO 8601 (UTC, milliseconds), or `None` when unparsable.
fn detected_at(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|t| {
            t.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
}

/// The unread set to upload (newest first, published Collection types only) and its
/// fingerprint, read in one snapshot. Events the server would refuse are left out.
pub(crate) fn unread_set(c: &Connection) -> Result<(Vec<ReleaseEvent>, String), LibraryError> {
    let mut statement = c.prepare(
        "SELECT e.id, e.collection_id, c.name, e.provider, e.event_kind, e.volume_number,
                e.previous_value, e.current_value, e.detected_at
         FROM release_watch_events e JOIN collections c ON c.id = e.collection_id
         WHERE e.read_at IS NULL AND c.type IN ('game','manga','movie')
           AND (c.legacy_kind IS NULL OR c.legacy_kind <> 'gacha')
         ORDER BY e.detected_at DESC, e.rowid DESC",
    )?;
    let mut rows = statement.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        if items.len() >= MAX_EVENTS {
            break;
        }
        let Some(detected) = detected_at(&row.get::<_, String>(8)?) else {
            continue;
        };
        let item = ReleaseEvent {
            event_id: row.get(0)?,
            collection_id: row.get(1)?,
            collection_name: row.get(2)?,
            provider: row.get(3)?,
            kind: row.get(4)?,
            volume_number: row.get(5)?,
            previous_value: row.get(6)?,
            current_value: row.get(7)?,
            detected_at: detected,
        };
        if item.valid() {
            items.push(item);
        }
    }
    let encoded = serde_json::to_vec(&items).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let fingerprint = Sha256::digest(&encoded)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((items, fingerprint))
}

impl Library {
    pub(crate) fn collection_release_sync_state(
        &self,
        endpoint: &str,
    ) -> Result<ReleaseSyncState, LibraryError> {
        read_state(&*self.connection()?, endpoint)
    }

    /// Read, change and write the state under the library lock.
    fn update_release_sync_state(
        &self,
        endpoint: &str,
        change: impl FnOnce(&mut ReleaseSyncState),
    ) -> Result<ReleaseSyncState, LibraryError> {
        let c = self.connection()?;
        let mut state = read_state(&c, endpoint)?;
        change(&mut state);
        write_state(&c, endpoint, &state)?;
        Ok(state)
    }

    /// The `releases` publication lane.
    pub(crate) fn run_due_collection_releases(&self, endpoint: &str) -> Result<(), LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        let client = CloudClient::new(endpoint)?;
        self.sync_collection_releases_with(&client, publisher.expose(), endpoint)
    }

    /// One pass with an injected transport: the read log (at most once a minute), then the
    /// upload when the unread set changed. A read-log failure does not stop the upload; the
    /// first error is returned.
    pub(crate) fn sync_collection_releases_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        let now = unix_now();
        let state = self.collection_release_sync_state(endpoint)?;
        let received = if state.last_polled <= now - 60 {
            self.update_release_sync_state(endpoint, |s| s.last_polled = now)?;
            match self.receive_collection_release_reads(client, publisher_token, endpoint) {
                Ok(true) => Ok(()),
                // An older server without the channel: look again in an hour.
                Ok(false) => {
                    self.update_release_sync_state(endpoint, |s| {
                        s.last_polled = now + 3600;
                        s.retry_after = s.retry_after.max(now + 3600);
                    })?;
                    return Ok(());
                }
                Err(error) => Err(error),
            }
        } else {
            Ok(())
        };
        let uploaded = self.upload_due_collection_releases(client, publisher_token, endpoint);
        received.and(uploaded)
    }

    /// Apply up to [`MAX_PAGES`] read-log pages. `Ok(false)` when the route is absent.
    pub(crate) fn receive_collection_release_reads(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<bool, LibraryError> {
        let mut changed = 0;
        let mut recoveries = 0;
        let mut pages = 0;
        let result = loop {
            if pages >= MAX_PAGES {
                break Ok(true);
            }
            let cursor = self.collection_release_sync_state(endpoint)?.read_cursor;
            let page = match client.release_reads(publisher_token, cursor, PAGE_LIMIT) {
                // Entries were pruned: resume at the server's end and upload the whole set,
                // whose `alreadyRead` replies cover every still-relevant read event.
                Err(LibraryError::ReleaseReadCursorExpired(last)) if recoveries < 2 => {
                    recoveries += 1;
                    eprintln!(
                        "collection releases: read log pruned past {cursor}; resuming at {last}"
                    );
                    self.update_release_sync_state(endpoint, |s| {
                        s.read_cursor = last;
                        s.full_upload = true;
                    })?;
                    continue;
                }
                // The server's log restarted behind this cursor: read it again from the start.
                Err(LibraryError::ReleaseCursorRejected) if cursor > 0 && recoveries < 2 => {
                    recoveries += 1;
                    eprintln!(
                        "collection releases: the server read log restarted; reading it again"
                    );
                    self.update_release_sync_state(endpoint, |s| {
                        s.read_cursor = 0;
                        s.full_upload = true;
                    })?;
                    continue;
                }
                Ok(None) => break Ok(false),
                Ok(Some(page)) => page,
                Err(error) => break Err(error),
            };
            pages += 1;
            changed += self.apply_collection_release_reads(
                endpoint,
                cursor,
                &page.items,
                page.next_cursor,
            )?;
            if !page.has_more || page.items.is_empty() {
                break Ok(true);
            }
        };
        if changed > 0 {
            super::collection_personal_edits::notify_collections_changed();
        }
        result
    }

    /// Acknowledge one page locally and advance the cursor in the same transaction. A page
    /// for a position other than the durable cursor (another pass moved it) is ignored.
    /// Returns how many local events changed.
    pub(crate) fn apply_collection_release_reads(
        &self,
        endpoint: &str,
        after: i64,
        items: &[ReadEntry],
        next_cursor: i64,
    ) -> Result<usize, LibraryError> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let mut state = read_state(&tx, endpoint)?;
        if state.read_cursor != after || next_cursor <= after {
            return Ok(0);
        }
        let now = chrono::Utc::now().to_rfc3339();
        let mut changed = 0;
        for item in items {
            changed += super::collection_tracking::acknowledge_release_events_in(
                &tx,
                &item.collection_id,
                std::slice::from_ref(&item.event_id),
                &now,
            )?;
        }
        state.read_cursor = next_cursor;
        write_state(&tx, endpoint, &state)?;
        tx.commit()?;
        Ok(changed)
    }

    /// Upload the unread set when it changed, a recovery requires it, or the daily refresh
    /// is due. A stale generation (another upload, or a clock that went backwards) starts
    /// once more above the server's generation.
    pub(crate) fn upload_due_collection_releases(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        let now = unix_now();
        let (state, items, fingerprint) = {
            let c = self.connection()?;
            let state = read_state(&c, endpoint)?;
            let (items, fingerprint) = unread_set(&c)?;
            (state, items, fingerprint)
        };
        let due = state.full_upload
            || state.uploaded.as_deref() != Some(fingerprint.as_str())
            || state.uploaded_at <= now - REFRESH_SECONDS;
        if !due || state.retry_after > now {
            return Ok(());
        }
        let mut floor = 0;
        for attempt in 0..2 {
            // Unix milliseconds at upload start, strictly above every generation used before.
            let state = self.update_release_sync_state(endpoint, |s| {
                s.generation = (chrono::Utc::now().timestamp_millis())
                    .max(s.generation + 1)
                    .max(floor + 1);
                s.retry_after = now + 300;
            })?;
            match self.upload_release_generation(client, publisher_token, &items, state.generation)
            {
                Ok(Some(acknowledged)) => {
                    self.update_release_sync_state(endpoint, |s| {
                        s.uploaded = Some(fingerprint.clone());
                        s.uploaded_at = now;
                        s.full_upload = false;
                        s.retry_after = 0;
                    })?;
                    if acknowledged > 0 {
                        super::collection_personal_edits::notify_collections_changed();
                    }
                    return Ok(());
                }
                Ok(None) => {
                    self.update_release_sync_state(endpoint, |s| s.retry_after = now + 3600)?;
                    return Ok(());
                }
                Err(LibraryError::ReleaseGenerationStale) if attempt == 0 => {
                    floor = client.release_generation(publisher_token)?.unwrap_or(0);
                }
                Err(error) => return Err(error),
            }
        }
        Err(LibraryError::ReleaseGenerationStale)
    }

    /// Send every chunk of one generation, acknowledging `alreadyRead` ids locally after
    /// each reply. `None` when the route is absent; otherwise how many events changed.
    fn upload_release_generation(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        items: &[ReleaseEvent],
        generation: i64,
    ) -> Result<Option<usize>, LibraryError> {
        let collections: HashMap<&str, &str> = items
            .iter()
            .map(|i| (i.event_id.as_str(), i.collection_id.as_str()))
            .collect();
        let mut acknowledged = 0;
        for upload in chunk_uploads(items.to_vec(), generation)? {
            let Some(result) = send_chunk(client, publisher_token, &upload)? else {
                return Ok(None);
            };
            validate_upload_result(&upload, &result)?;
            if !result.already_read.is_empty() {
                let mut c = self.connection()?;
                let tx = c.transaction()?;
                let now = chrono::Utc::now().to_rfc3339();
                for id in &result.already_read {
                    let collection = collections.get(id.as_str()).copied().unwrap_or_default();
                    acknowledged += super::collection_tracking::acknowledge_release_events_in(
                        &tx,
                        collection,
                        std::slice::from_ref(id),
                        &now,
                    )?;
                }
                tx.commit()?;
            }
        }
        Ok(Some(acknowledged))
    }
}

/// Send one chunk, retrying a lost request with the identical body and operation id (the
/// server replays its stored reply).
fn send_chunk(
    client: &CloudClient,
    token: &str,
    upload: &ReleaseUpload,
) -> Result<Option<crate::cloud::collection_releases::ReleaseUploadResult>, LibraryError> {
    let body = serde_json::to_vec(upload).map_err(|_| LibraryError::InvalidCloudResponse)?;
    let mut attempt = 0;
    loop {
        attempt += 1;
        match client.publish_release_unread(token, &body) {
            Err(LibraryError::CloudRequestTimedOut | LibraryError::CloudRequestUnavailable)
                if attempt < CHUNK_ATTEMPTS =>
            {
                std::thread::sleep(std::time::Duration::from_millis(500 * attempt as u64));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
#[path = "collection_release_sync_tests.rs"]
mod tests;
