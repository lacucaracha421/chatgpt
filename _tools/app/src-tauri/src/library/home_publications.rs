//! PC Home publishers: bounded, endpoint-scoped checkpoints; no provider refresh/backfill.
use super::{
    error::LibraryError,
    release_calendar::{self, ReleaseKind, ReleaseTitle},
    release_wishlist, Library,
};
use crate::cloud::{
    client::CloudClient,
    collections::ArtworkBlob,
    status_watch::{self, LogKind, LogPosition},
};
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;

// home_upcoming.py accepts anime (`tmdb:tv:<show>:s<season>`) from the 2026-09-27 server deploy on.
const PUBLISH_ANIME: bool = true;
fn supported(kind: ReleaseKind) -> bool {
    PUBLISH_ANIME || kind != ReleaseKind::Anime
}

struct ApiArtwork<'a> {
    client: &'a CloudClient,
    api: &'a str,
}
impl HomeTransport for ApiArtwork<'_> {
    fn publish(
        &self,
        path: &str,
        body: Option<&Value>,
        token: &str,
    ) -> Result<Value, LibraryError> {
        self.client.publish(path, body, token)
    }
    fn intents(&self, after: i64, token: &str) -> Result<Value, LibraryError> {
        self.client.intents(after, token)
    }
    fn artwork(
        &self,
        blob: &ArtworkBlob,
        bytes: &[u8],
        _publisher: &str,
    ) -> Result<(), LibraryError> {
        self.client.artwork(blob, bytes, self.api)
    }
}

pub(crate) trait HomeTransport {
    fn publish(&self, path: &str, body: Option<&Value>, token: &str)
        -> Result<Value, LibraryError>;
    fn intents(&self, after: i64, token: &str) -> Result<Value, LibraryError>;
    fn artwork(&self, blob: &ArtworkBlob, bytes: &[u8], token: &str) -> Result<(), LibraryError>;
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    published_digest: String,
    revision: Option<i64>,
    pending_digest: String,
    generated_at: String,
    cursor: i64,
    last_poll: Option<i64>,
    next_build: i64,
    retry_after: i64,
    failures: u32,
}
impl State {
    fn load(db: &Connection, endpoint: &str, kind: &str) -> Result<Self, LibraryError> {
        let raw: Option<String> = db
            .query_row(
                "SELECT state_json FROM home_publication_state WHERE endpoint=?1 AND kind=?2",
                params![endpoint, kind],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse))
            .unwrap_or_else(|| Ok(Self::default()))
    }
    fn save(&self, db: &Connection, endpoint: &str, kind: &str) -> Result<(), LibraryError> {
        db.execute(
            "INSERT INTO home_publication_state(endpoint,kind,state_json) VALUES(?1,?2,?3)
            ON CONFLICT(endpoint,kind) DO UPDATE SET state_json=excluded.state_json",
            params![
                endpoint,
                kind,
                serde_json::to_string(self).map_err(|_| LibraryError::InvalidCloudResponse)?
            ],
        )?;
        Ok(())
    }
}

fn text(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}
fn optional(value: Option<&str>, max: usize) -> Option<String> {
    value.map(|s| text(s, max)).filter(|s| !s.is_empty())
}
fn cover(kind: ReleaseKind, value: Option<&str>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let url = match kind {
        ReleaseKind::Game
            if !value.is_empty()
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_') =>
        {
            format!("https://images.igdb.com/igdb/image/upload/t_cover_big/{value}.jpg")
        }
        ReleaseKind::Movie | ReleaseKind::Anime
            if value.starts_with('/')
                && !value.contains("..")
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/_.-".contains(&c)) =>
        {
            format!("https://image.tmdb.org/t/p/w342{value}")
        }
        _ => return Value::Null,
    };
    if url.len() > 2048 {
        Value::Null
    } else {
        json!({"url":url})
    }
}
fn title(value: &ReleaseTitle) -> Value {
    json!({"id":value.id,"kind":value.kind,"title":text(&value.title,500),
        "originalTitle":optional(value.original_title.as_deref(),500),"date":value.date,"precision":value.precision,
        "region":optional(value.region.as_deref(),16),
        "platforms":value.platforms.iter().filter_map(|p| optional(Some(p),100)).take(32).collect::<Vec<_>>(),
        "releaseType":null,"cover":cover(value.kind,value.cover.as_deref()),
        "popularity":if value.popularity.is_finite() && value.popularity >= 0.0 {Some(value.popularity)} else {None},
        // Needs the server from 2026-09-28 (dcdf9210); older servers reject unknown keys.
        "port":value.port})
}

impl Library {
    pub(crate) fn run_due_home_publication(
        &self,
        kind: &str,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let token = match super::credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        // Cover uploads go through the Collections artwork route, which takes the device API
        // token (as the Collections replica does); the home PUT/intent routes take the publisher.
        let api = super::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(endpoint)?;
        self.run_home_with(
            &ApiArtwork {
                client: &client,
                api: api.expose(),
            },
            token.expose(),
            endpoint,
            kind,
            Utc::now(),
            chrono::Local::now().date_naive(),
            crate::workload::is_lightweight(),
        )
    }

    fn run_home_with(
        &self,
        client: &dyn HomeTransport,
        token: &str,
        endpoint: &str,
        kind: &str,
        now: DateTime<Utc>,
        today: NaiveDate,
        light: bool,
    ) -> Result<(), LibraryError> {
        let endpoint = status_watch::endpoint_key(endpoint);
        let mut state = State::load(&*self.connection()?, &endpoint, kind)?;
        let clock = now.timestamp();
        if state.retry_after > clock {
            return Ok(());
        }
        let poll = kind == "upcoming"
            && status_watch::log_due(
                &endpoint,
                LogKind::UpcomingIntents,
                LogPosition::cursor(Some(state.cursor)),
                Some(state.last_poll.unwrap_or(0)),
                clock,
            );
        if !poll && state.next_build > clock {
            return Ok(());
        }
        // Persist before I/O: a crash or a failing endpoint cannot create a tight retry loop.
        state.retry_after = clock + 60;
        state.save(&*self.connection()?, &endpoint, kind)?;
        let result = (|| {
            let previous_cursor = state.cursor;
            if poll {
                state.last_poll = Some(clock);
                state.save(&*self.connection()?, &endpoint, kind)?;
                for _ in 0..3 {
                    let page: IntentPage =
                        serde_json::from_value(client.intents(state.cursor, token)?)
                            .map_err(|_| LibraryError::InvalidCloudResponse)?;
                    page.validate(state.cursor)?;
                    self.apply_home_intents(&endpoint, &page, now, today)?;
                    state = State::load(&*self.connection()?, &endpoint, kind)?;
                    if !page.has_more {
                        break;
                    }
                }
            }
            if state.next_build > clock && state.cursor == previous_cursor {
                return Ok(());
            }
            let (path, mut body, artwork) = match kind {
                "upcoming" => (
                    "/v1/home/upcoming",
                    self.upcoming_body(now, today, state.cursor)?,
                    None,
                ),
                "artists" => {
                    let mut db = self.connection()?;
                    let tx = db.transaction()?;
                    let body = super::artists::home_publication(&tx, now)?;
                    tx.commit()?;
                    ("/v1/library/artists", body, None)
                }
                "avPick" => {
                    let (body, artwork) = self.av_pick_body(today)?;
                    ("/v1/home/av-pick", body, artwork)
                }
                _ => return Err(LibraryError::InvalidCloudResponse),
            };
            let digest = super::mobile_catalog::hash_json(&body)?;
            if digest != state.published_digest {
                if digest != state.pending_digest {
                    state.pending_digest = digest.clone();
                    state.generated_at = now.to_rfc3339();
                }
                state.save(&*self.connection()?, &endpoint, kind)?;
                if kind != "avPick" {
                    body["generatedAt"] = json!(state.generated_at);
                }
                if let Some((blob, bytes)) = artwork {
                    client.artwork(&blob, &bytes, token)?;
                }
                let reply =
                    client.publish(path, if body.is_null() { None } else { Some(&body) }, token)?;
                if reply["version"] != 1
                    || reply["changed"].as_bool().is_none()
                    || reply["revision"].as_i64().is_none_or(|n| n < 0)
                    || (kind == "upcoming"
                        && reply["acknowledgedThrough"]
                            .as_i64()
                            .is_none_or(|n| n < state.cursor))
                    || (kind == "avPick" && reply["active"].as_bool() != Some(!body.is_null()))
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                state.revision = reply["revision"].as_i64();
                state.published_digest = digest;
            }
            state.next_build = clock + if light { 300 } else { 60 };
            Ok(())
        })();
        if result.is_ok() {
            state.failures = 0;
            state.retry_after = 0;
        } else {
            state.failures = state.failures.saturating_add(1);
            state.retry_after =
                clock + (60_i64 * (1_i64 << state.failures.saturating_sub(1).min(6))).min(3600);
        }
        state.save(&*self.connection()?, &endpoint, kind)?;
        result
    }

    fn upcoming_body(
        &self,
        now: DateTime<Utc>,
        today: NaiveDate,
        cursor: i64,
    ) -> Result<Value, LibraryError> {
        let calendar = self.release_calendar_at(now, today)?;
        let entries: Vec<_> = calendar
            .entries
            .iter()
            .filter(|v| supported(v.title.kind))
            .map(|v| title(&v.title))
            .collect();
        let wishlist: Vec<_> = self.list_release_watch()?.into_iter().filter(|v|supported(v.kind)).map(|v| {
            let mut body = title(&ReleaseTitle {id:v.id, kind:v.kind,provider:v.provider,external_id:v.external_id,
                title:v.title,original_title:v.original_title,cover:v.cover,platforms:v.platforms,date:v.date,
                precision:v.precision,region:v.region,popularity:0.0,dates:v.dates,port:false});
            body["popularity"] = Value::Null;
            body["source"] = json!(v.source); body["addedAt"] = json!(v.added_at);
            body["muted"] = json!(v.muted); body["released"] = json!(v.released);
            body["events"] = json!(v.unread.iter().rev().take(50).rev().map(|e|json!({
                "id":e.id,"kind":e.kind,"previousValue":optional(e.previous_value.as_deref(),200),
                "currentValue":optional(e.current_value.as_deref(),200),"detectedAt":e.detected_at,"readAt":e.read_at
            })).collect::<Vec<_>>()); body
        }).collect();
        if entries.len() > 3000 || wishlist.len() > 1000 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(
            json!({"version":1,"rangeStart":calendar.range_start,"rangeEnd":calendar.range_end,
            "entries":entries,"wishlist":wishlist,"intentCursor":cursor,
            "sources":calendar.sources.iter().filter(|s|s.provider=="igdb"||s.provider=="tmdb")
                .map(|s|json!({"provider":s.provider,"fetchedAt":s.fetched_at,"errorCode":s.error_code})).collect::<Vec<_>>()}),
        )
    }

    fn av_pick_body(
        &self,
        today: NaiveDate,
    ) -> Result<(Value, Option<(ArtworkBlob, Vec<u8>)>), LibraryError> {
        let Some(pick) = self
            .home_av_performer(today)
            .map_err(|_| LibraryError::InvalidCloudResponse)?
        else {
            return Ok((Value::Null, None));
        };
        let mut artwork = None;
        if let Some(id) = &pick.latest_work.front_artwork_id {
            match self.resolve_work_artwork(id) {
                Ok(media) => {
                    let limit = 16 * 1024 * 1024;
                    if media.length > limit {
                        return Err(LibraryError::InvalidWorkArtwork);
                    }
                    let mut bytes = Vec::new();
                    media
                        .file
                        .take(limit + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| LibraryError::InvalidWorkArtwork)?;
                    if bytes.len() as u64 != media.length {
                        return Err(LibraryError::InvalidWorkArtwork);
                    }
                    artwork = Some((crate::cloud::collections::blob_for(&bytes)?, bytes));
                }
                Err(LibraryError::MediaNotFound) => {}
                Err(error) => return Err(error),
            }
        }
        let front = artwork.as_ref().map(|(blob,_)|json!({"sha256":blob.sha256,"sizeBytes":blob.size_bytes,"contentType":blob.content_type}));
        let latest = &pick.latest_work;
        Ok((
            json!({"version":1,"pick":{
                "date":today.to_string(),"personId":pick.id,"name":text(&pick.display_name,200),
                "aliases":optional(pick.original_name.as_deref(),200).into_iter().collect::<Vec<_>>(),
                "workCount":pick.owned_works,"latestWork":{"code":optional(latest.product_code.as_deref(),100),
                    "label":null,"series":null,"title":optional(Some(&latest.title),500),
                    "date":latest.release_date.as_deref().filter(|s|NaiveDate::parse_from_str(s,"%Y-%m-%d").is_ok()),
                    "collectionId":latest.collection_id},"cover":front
            }}),
            artwork,
        ))
    }

    fn apply_home_intents(
        &self,
        endpoint: &str,
        page: &IntentPage,
        now: DateTime<Utc>,
        today: NaiveDate,
    ) -> Result<(), LibraryError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let mut state = State::load(&tx, endpoint, "upcoming")?;
        // A page already committed before a lost response is not applied twice.
        if page.next_cursor <= state.cursor {
            return Ok(());
        }
        page.validate(state.cursor)?;
        for item in &page.items {
            let known: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM release_watch_items WHERE id=?1)",
                [&item.item_id],
                |r| r.get(0),
            )?;
            match item.action.as_str() {
                "add" => {
                    // Unknown/expired titles are a specified no-op; never make provider calls in this lane.
                    if let Some(title) = release_calendar::cached_title(&tx, &item.item_id, now)? {
                        if supported(title.kind) {
                            release_wishlist::insert_watch(&tx, &title, "calendar", now, today)?;
                        }
                    }
                }
                "remove" if known => release_wishlist::remove_watch(&tx, &item.item_id)?,
                "mute" | "unmute" if known => {
                    release_wishlist::mute_watch(&tx, &item.item_id, item.action == "mute")?
                }
                "acknowledge" => {
                    let mut ids = Vec::new();
                    for id in item.event_ids.as_deref().unwrap_or_default() {
                        let belongs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM release_watch_item_events WHERE id=?1 AND item_id=?2)",params![id,item.item_id],|r|r.get(0))?;
                        if belongs {
                            ids.push(id.clone());
                        }
                    }
                    release_wishlist::acknowledge_watch(&tx, &ids)?;
                }
                "remove" | "mute" | "unmute" => {}
                _ => return Err(LibraryError::InvalidCloudResponse),
            }
            state.cursor = item.sequence;
        }
        state.next_build = 0;
        state.save(&tx, endpoint, "upcoming")?;
        tx.commit()?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntentPage {
    version: u8,
    after: i64,
    last_sequence: i64,
    acknowledged_through: i64,
    pruned_through: i64,
    next_cursor: i64,
    has_more: bool,
    items: Vec<Intent>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    sequence: i64,
    operation_id: String,
    action: String,
    item_id: String,
    event_ids: Option<Vec<String>>,
    created_at: String,
}
impl IntentPage {
    fn validate(&self, after: i64) -> Result<(), LibraryError> {
        let mut cursor = after;
        if self.version != 1
            || self.after != after
            || after < 0
            || self.pruned_through < 0
            || self.pruned_through > after
            || self.acknowledged_through < self.pruned_through
            || self.acknowledged_through > self.last_sequence
            || self.items.len() > 200
            || self.last_sequence > 9_007_199_254_740_991
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut operations = std::collections::HashSet::new();
        for item in &self.items {
            // Same rule as the server's ItemId: `igdb:<id>`, `tmdb:<id>` or an anime season
            // `tmdb:tv:<show>:s<season>`.
            let simple = |id: &str| {
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            };
            let anime = |rest: &str| {
                rest.split_once(":s").is_some_and(|(show, season)| {
                    (1..=12).contains(&show.len())
                        && show.bytes().all(|c| c.is_ascii_digit())
                        && (1..=4).contains(&season.len())
                        && season.bytes().all(|c| c.is_ascii_digit())
                })
            };
            let valid_id = match item.item_id.split_once(':') {
                Some(("igdb", id)) => simple(id),
                Some(("tmdb", id)) => id.strip_prefix("tv:").map_or_else(|| simple(id), anime),
                _ => false,
            };
            let events = item.event_ids.as_deref().unwrap_or_default();
            if item.sequence != cursor + 1
                || !valid_id
                || uuid::Uuid::parse_str(&item.operation_id).is_err()
                || !operations.insert(&item.operation_id)
                || DateTime::parse_from_rfc3339(&item.created_at).is_err()
                || !matches!(
                    item.action.as_str(),
                    "add" | "remove" | "mute" | "unmute" | "acknowledge"
                )
                || (item.action == "acknowledge" && (events.is_empty() || events.len() > 100))
                || (item.action != "acknowledge" && item.event_ids.is_some())
            {
                return Err(LibraryError::InvalidCloudResponse);
            }
            cursor = item.sequence;
        }
        if self.next_cursor != cursor
            || cursor > self.last_sequence
            || self.has_more != (cursor < self.last_sequence)
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "home_publications_tests.rs"]
mod tests;
