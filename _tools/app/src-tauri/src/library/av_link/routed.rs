//! Server AV inbox routing.
//!
//! When the Collections authority is active and the server has `/v1/av-inbox`, the server
//! owns the inbox: it finds the candidates and keeps their jackets, and this PC only reads
//! them, lets the user choose, and applies the choice through the authority outbox. The local
//! LibreDMM/Wikidata worker and the `/v1/av-lookups` poll never run in that mode.
//!
//! * authority inactive -> `Route::Local`: today's local path, untouched.
//! * authority active, server without `/v1/av-inbox` (or not probed yet) -> `Route::OldServer`:
//!   the local inbox stays visible and apply stays fenced.
//! * authority active and the route confirmed -> `Route::Server`.
//!
//! Small durable state lives in `notes_state` (no schema change): the route probe, a mirror of
//! the server's actionable list (so the list, the Home count and offline reads need no network),
//! per-item apply progress and the one-time migration markers.
use super::{
    models::*,
    provider::{normalize_code, HttpResponse},
    *,
};
use crate::library::{
    collection_authority::collection_authority_active,
    credential::{CloudCredential, CredentialTarget},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Mutex, time::Duration};

pub(super) const MAX_LIST_BYTES: usize = 1024 * 1024;
const MAX_DETAIL_BYTES: usize = 3 * 1024 * 1024;
const ROUTE_KEY: &str = "avInbox:route";
const ROUTE_RECHECK_SECS: i64 = 600;
/// After a failed server contact the cycle waits before trying again, so an unreachable
/// server or locked credential store is not hit every second.
const RETRY_KEY: &str = "avInbox:retryAt";
const ITEM_PREFIX: &str = "avInbox:item:";
const MIRROR_AT_KEY: &str = "avInbox:mirrorAt";
const MAX_PAGES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    Local,
    Server,
    OldServer,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteState {
    endpoint: String,
    supported: bool,
    checked_at: i64,
}

// ---- small durable state ------------------------------------------------------------

pub(super) fn note(c: &Connection, key: &str) -> Result<Option<String>, AvError> {
    Ok(
        c.query_row("SELECT value FROM notes_state WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?,
    )
}
pub(super) fn set_note(c: &Connection, key: &str, value: &str) -> Result<(), AvError> {
    c.execute(
        "INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}
pub(super) fn note_json<T: serde::de::DeserializeOwned>(
    c: &Connection,
    key: &str,
) -> Result<Option<T>, AvError> {
    Ok(note(c, key)?.and_then(|v| serde_json::from_str(&v).ok()))
}
pub(super) fn set_note_json<T: Serialize>(
    c: &Connection,
    key: &str,
    value: &T,
) -> Result<(), AvError> {
    set_note(c, key, &json(value)?)
}

pub(super) fn configured_endpoint(c: &Connection) -> Result<Option<String>, AvError> {
    let value: Option<String> = c.query_row(
        "SELECT cloud_api_base_url FROM library_settings WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    Ok(value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()))
}

pub(super) fn route_on(c: &Connection) -> Result<Route, AvError> {
    if !collection_authority_active(c)? {
        return Ok(Route::Local);
    }
    let state: Option<RouteState> = note_json(c, ROUTE_KEY)?;
    Ok(match (state, configured_endpoint(c)?) {
        (Some(s), Some(endpoint)) if s.supported && s.endpoint == endpoint => Route::Server,
        _ => Route::OldServer,
    })
}

pub(super) fn retry_at(c: &Connection) -> i64 {
    note(c, RETRY_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}
pub(super) fn note_retry(c: &Connection, until: i64) {
    let _ = set_note(c, RETRY_KEY, &until.to_string());
}

/// When the route should be probed next: `None` when authority is inactive, no server is
/// configured, or the route is already confirmed (a later 404 flips it).
pub(super) fn route_probe_due_at(c: &Connection) -> Result<Option<i64>, AvError> {
    if !collection_authority_active(c)? {
        return Ok(None);
    }
    let Some(endpoint) = configured_endpoint(c)? else {
        return Ok(None);
    };
    Ok(match note_json::<RouteState>(c, ROUTE_KEY)? {
        Some(s) if s.endpoint == endpoint && s.supported => None,
        Some(s) if s.endpoint == endpoint => Some(s.checked_at + ROUTE_RECHECK_SECS),
        _ => Some(0),
    }
    .map(|due| due.max(retry_at(c))))
}

// ---- server transport -----------------------------------------------------------------

/// Everything the PC says to the server inbox goes through this seam, so tests use a mock.
pub(crate) trait InboxServer {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<HttpResponse, AvError>;
}
pub(crate) struct ServerSession {
    client: crate::cloud::client::CloudClient,
    token: CloudCredential,
}
impl InboxServer for ServerSession {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<HttpResponse, AvError> {
        let response =
            self.client
                .av_inbox_request(method, path, body, self.token.expose(), limit)?;
        if matches!(response.status, 401 | 403) {
            crate::library::credential_broker::broker().invalidate(CredentialTarget::CloudApi);
        }
        Ok(response)
    }
}

pub(super) fn refusal_code_of(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|v| v["detail"]["code"].as_str().map(str::to_owned))
}

/// A successful JSON body, or the user-facing error for the server's refusal.
pub(super) fn server_json(response: HttpResponse) -> Result<Value, AvError> {
    match response.status {
        200 => serde_json::from_slice(&response.bytes).map_err(|_| AvError::Invalid),
        401 | 403 => Err(LibraryError::CloudUnauthorized.into()),
        status => Err(refusal(status, refusal_code_of(&response.bytes).as_deref())),
    }
}
pub(super) fn refusal(status: u16, code: Option<&str>) -> AvError {
    match (status, code) {
        (404, Some("avInboxNotFound")) => AvError::Inbox(
            "av_inbox_missing",
            "서버의 받은 품번 목록에 없는 항목이에요. 목록을 새로 고쳐 주세요.",
        ),
        (404, _) => AvError::Inbox(
            "av_inbox_unsupported",
            "서버가 아직 받은 품번 목록을 지원하지 않아요.",
        ),
        (409, Some("avInboxStateConflict" | "avInboxCandidateUnavailable")) => AvError::Stale,
        (409, Some("avInboxWorkMismatch")) => AvError::Inbox(
            "av_inbox_work_mismatch",
            "서버에 같은 품번의 AV 컬렉션이 아직 없어요. 잠시 뒤 다시 시도해 주세요.",
        ),
        (422, _) => AvError::Invalid,
        (429, _) => AvError::Inbox(
            "av_inbox_busy",
            "서버가 다른 후보를 처리하고 있어요. 잠시 뒤 다시 시도해 주세요.",
        ),
        _ => AvError::Inbox(
            "av_inbox_unavailable",
            "서버에서 후보를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.",
        ),
    }
}

fn error_text(code: &str) -> &'static str {
    match code {
        "invalidProductCode" => "품번을 확인해 주세요",
        "avLookupReadyTimeout" => "LibreDMM이 아직 준비 중이에요",
        "providerImageInvalid"
        | "providerArtworkInvalid"
        | "providerArtworkMismatch"
        | "providerArtworkStorageUnavailable" => "재킷 이미지를 가져오지 못했어요",
        _ => "후보를 가져오지 못했어요 · 다시 시도해 주세요",
    }
}

impl Library {
    pub(crate) fn av_link_route(&self) -> Result<Route, AvError> {
        route_on(&*self.connection()?)
    }

    /// The signed-in API client; errors when no server or credential is configured.
    pub(crate) fn av_inbox_session(&self) -> Result<ServerSession, AvError> {
        let endpoint = configured_endpoint(&*self.connection()?)?
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let client = self.cloud_client(&endpoint)?;
        let token =
            crate::library::credential_broker::broker().credential(CredentialTarget::CloudApi)?;
        Ok(ServerSession { client, token })
    }

    /// Probe `/v1/av-inbox` when the route is unknown or an older server may have been
    /// upgraded. Transient failures keep the previous answer.
    pub(crate) fn refresh_av_route_with(
        &self,
        server: &impl InboxServer,
        now: i64,
    ) -> Result<(), AvError> {
        let endpoint = {
            let c = self.connection()?;
            if route_probe_due_at(&c)?.is_none_or(|due| due > now) {
                return Ok(());
            }
            configured_endpoint(&c)?
        };
        let Some(endpoint) = endpoint else {
            return Ok(());
        };
        let response = server.request("GET", "/v1/av-inbox?limit=1", None, MAX_LIST_BYTES)?;
        let supported = match response.status {
            200 => true,
            404 => false,
            401 | 403 => return Err(LibraryError::CloudUnauthorized.into()),
            _ => return Err(LibraryError::CloudRequestUnavailable.into()),
        };
        set_note_json(
            &*self.connection()?,
            ROUTE_KEY,
            &RouteState {
                endpoint,
                supported,
                checked_at: now,
            },
        )
    }

    fn mark_route_unsupported(&self, now: i64) -> Result<(), AvError> {
        let c = self.connection()?;
        if let Some(endpoint) = configured_endpoint(&c)? {
            set_note_json(
                &c,
                ROUTE_KEY,
                &RouteState {
                    endpoint,
                    supported: false,
                    checked_at: now,
                },
            )?;
        }
        Ok(())
    }
}

// ---- mirror of the server's actionable list -------------------------------------------

fn item_id(value: &Value) -> Option<&str> {
    value["requestId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
}
fn actionable_status(status: &str) -> bool {
    matches!(
        status,
        "queued" | "fetching" | "found" | "not_found" | "error"
    )
}

fn mirror_values(c: &Connection) -> Result<Vec<Value>, AvError> {
    let rows = c
        .prepare("SELECT value FROM notes_state WHERE key LIKE 'avInbox:item:%'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .iter()
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .collect())
}
fn store_item(c: &Connection, value: &Value) -> Result<(), AvError> {
    let Some(id) = item_id(value) else {
        return Err(AvError::Invalid);
    };
    let key = format!("{ITEM_PREFIX}{id}");
    if actionable_status(value["status"].as_str().unwrap_or("")) {
        set_note(c, &key, &value.to_string())
    } else {
        c.execute("DELETE FROM notes_state WHERE key=?1", [key])?;
        Ok(())
    }
}

/// Every page of the server list (newest first), or an error when it cannot be read
/// completely. Items with an unusable shape fail the whole read.
pub(super) fn fetch_server_list(
    server: &impl InboxServer,
    include_closed: bool,
) -> Result<Vec<Value>, AvError> {
    let mut items = Vec::new();
    let mut before: Option<i64> = None;
    for _ in 0..MAX_PAGES {
        let mut path = String::from("/v1/av-inbox?limit=100");
        if include_closed {
            path.push_str("&includeClosed=true");
        }
        if let Some(sequence) = before {
            path.push_str(&format!("&before={sequence}"));
        }
        let page = server_json(server.request("GET", &path, None, MAX_LIST_BYTES)?)?;
        let rows = page["items"].as_array().ok_or(AvError::Invalid)?;
        if rows.len() > 100 || rows.iter().any(|row| item_id(row).is_none()) {
            return Err(AvError::Invalid);
        }
        items.extend(rows.iter().cloned());
        if page["hasMore"] != true {
            return Ok(items);
        }
        before = Some(page["nextBefore"].as_i64().ok_or(AvError::Invalid)?);
    }
    Err(AvError::Invalid)
}

impl Library {
    /// Replace the mirror with the server's current actionable list. A failed read leaves
    /// the previous mirror (and the screen) untouched.
    pub(crate) fn refresh_av_mirror_with(
        &self,
        server: &impl InboxServer,
        now: i64,
    ) -> Result<(), AvError> {
        let items = match fetch_server_list(server, false) {
            Ok(items) => items,
            Err(AvError::Inbox("av_inbox_unsupported", _)) => {
                self.mark_route_unsupported(now)?;
                return Err(AvError::Inbox(
                    "av_inbox_unsupported",
                    "서버가 아직 받은 품번 목록을 지원하지 않아요.",
                ));
            }
            Err(error) => return Err(error),
        };
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM notes_state WHERE key LIKE 'avInbox:item:%'",
            [],
        )?;
        for item in &items {
            store_item(&tx, item)?;
        }
        set_note(&tx, MIRROR_AT_KEY, &now.to_string())?;
        tx.commit()?;
        Ok(())
    }

    /// When the mirror should be read again: soon while a candidate is still being found.
    pub(super) fn mirror_due_at(c: &Connection, restricted: bool) -> Result<i64, AvError> {
        let last: i64 = note(c, MIRROR_AT_KEY)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let searching = mirror_values(c)?
            .iter()
            .any(|v| matches!(v["status"].as_str(), Some("queued" | "fetching")));
        let interval = match (restricted, searching) {
            (true, _) => 60,
            (false, true) => 5,
            (false, false) => 15,
        };
        Ok(last + interval)
    }
}

// ---- local view -------------------------------------------------------------------------

fn local_matches(c: &Connection, code: Option<&str>) -> Result<Vec<InboxMatch>, AvError> {
    let Some(code) = code else {
        return Ok(vec![]);
    };
    matching_collections(c, code)?
        .into_iter()
        .map(|id| {
            let name: String =
                c.query_row("SELECT name FROM collections WHERE id=?1", [&id], |r| {
                    r.get(0)
                })?;
            Ok(InboxMatch {
                collection_id: id,
                name,
            })
        })
        .collect()
}

pub(super) fn item_from_server(
    c: &Connection,
    value: &Value,
    progress: Option<&routed_apply::Progress>,
) -> Result<Option<InboxItem>, AvError> {
    let Some(id) = item_id(value) else {
        return Ok(None);
    };
    let status = value["status"].as_str().unwrap_or("");
    if !actionable_status(status) {
        return Ok(None);
    }
    let apply_state = match progress.map(|p| p.state.as_str()) {
        Some("done") => return Ok(None),
        Some("preparing" | "queued" | "acking") => Some("applying"),
        Some("blocked") => Some("blocked"),
        Some("failed") => Some("failed"),
        _ => None,
    };
    let normalized = value["normalizedCode"].as_str().map(str::to_owned);
    let mut matches = local_matches(c, normalized.as_deref())?;
    let single = (matches.len() == 1).then(|| matches.remove(0));
    if single.is_some() {
        matches.clear();
    }
    Ok(Some(InboxItem {
        id: id.into(),
        request_id: id.into(),
        product_code: value["productCode"].as_str().unwrap_or("").into(),
        normalized_code: normalized,
        source_url: value["sourceUrl"].as_str().map(str::to_owned),
        received_at: value["receivedAt"].as_str().unwrap_or("").into(),
        status: status.into(),
        attempts: value["attempts"].as_i64().unwrap_or(0),
        last_error: value["lastError"]
            .as_str()
            .map(|code| error_text(code).to_owned()),
        fetched_at: value["fetchedAt"].as_str().map(str::to_owned),
        collection_id: single.as_ref().map(|m| m.collection_id.clone()),
        collection_name: single.map(|m| m.name),
        matches,
        apply_state: apply_state.map(str::to_owned),
    }))
}

impl Library {
    pub(crate) fn routed_list(&self) -> Result<Vec<InboxItem>, AvError> {
        let c = self.connection()?;
        let progress = routed_apply::all_progress(&c)?;
        let mut items = Vec::new();
        for value in mirror_values(&c)? {
            let id = item_id(&value).unwrap_or("").to_owned();
            if let Some(item) = item_from_server(&c, &value, progress.get(&id))? {
                items.push(item);
            }
        }
        items.sort_by(|a, b| (&a.received_at, &a.id).cmp(&(&b.received_at, &b.id)));
        Ok(items)
    }

    /// Actionable server items; ones whose choice is already being applied no longer count.
    pub(crate) fn routed_pending_count(&self) -> Result<i64, AvError> {
        let c = self.connection()?;
        let progress = routed_apply::all_progress(&c)?;
        Ok(mirror_values(&c)?
            .iter()
            .filter(|v| {
                let id = item_id(v).unwrap_or("");
                actionable_status(v["status"].as_str().unwrap_or(""))
                    && !matches!(
                        progress.get(id).map(|p| p.state.as_str()),
                        Some("preparing" | "queued" | "acking" | "done")
                    )
            })
            .count() as i64)
    }
}

// ---- candidate --------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerName {
    name_ja: String,
    #[serde(default)]
    name_ko: Option<String>,
    #[serde(default)]
    wikidata_id: Option<String>,
    #[serde(default)]
    fanza_actress_id: Option<String>,
}
impl From<ServerName> for NameMapping {
    fn from(n: ServerName) -> Self {
        Self {
            name_ja: n.name_ja,
            name_ko: n.name_ko,
            wikidata_id: n.wikidata_id,
            fanza_actress_id: n.fanza_actress_id,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerFields {
    title_ja: Option<String>,
    release_date: Option<String>,
    maker: Option<String>,
    label: Option<String>,
    series: Option<String>,
    genres: Option<Vec<String>>,
}
/// The server candidate, parsed once and shared by the chooser and the apply.
pub(super) struct ServerCandidate {
    pub inbox: Value,
    pub movie: Movie,
    pub fields: Fields,
    pub width: u32,
    pub height: u32,
    pub split: DefaultSplit,
    pub names: Vec<NameMapping>,
    pub matches: Vec<(String, String)>,
}

pub(super) fn parse_detail(detail: &Value) -> Result<ServerCandidate, AvError> {
    let candidate = detail["candidate"].as_object().ok_or(AvError::Inbox(
        "av_inbox_not_ready",
        "아직 확인할 후보가 없어요. 목록을 새로 고쳐 주세요.",
    ))?;
    if detail["inbox"]["status"] != "found" {
        return Err(AvError::Stale);
    }
    let movie: Movie =
        serde_json::from_value(candidate["metadata"].clone()).map_err(|_| AvError::Invalid)?;
    let fields: ServerFields =
        serde_json::from_value(candidate["fields"].clone()).map_err(|_| AvError::Invalid)?;
    let split: DefaultSplit =
        serde_json::from_value(candidate["defaultSplit"].clone()).map_err(|_| AvError::Invalid)?;
    let dimension = |key: &str| {
        candidate[key]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .ok_or(AvError::Invalid)
    };
    let mut names: Vec<NameMapping> = Vec::new();
    for key in ["performers", "directors"] {
        for entry in candidate[key].as_array().into_iter().flatten() {
            let name: ServerName =
                serde_json::from_value(entry.clone()).map_err(|_| AvError::Invalid)?;
            names.push(name.into());
        }
    }
    let matches = detail["matches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            Some((
                m["workId"].as_str()?.to_owned(),
                m["name"].as_str().unwrap_or("").to_owned(),
            ))
        })
        .collect();
    Ok(ServerCandidate {
        inbox: detail["inbox"].clone(),
        movie,
        fields: Fields {
            title_ja: fields.title_ja,
            release_date: fields.release_date,
            maker: fields.maker,
            label: fields.label,
            series: fields.series,
            genres: fields.genres,
        },
        width: dimension("jacketWidth")?,
        height: dimension("jacketHeight")?,
        split,
        names,
        matches,
    })
}

impl Library {
    pub(crate) fn routed_candidate(
        &self,
        server: &impl InboxServer,
        id: &str,
        collection_id: Option<&str>,
    ) -> Result<Candidate, AvError> {
        uuid::Uuid::parse_str(id).map_err(|_| AvError::Invalid)?;
        let detail = server_json(server.request(
            "GET",
            &format!("/v1/av-inbox/{id}"),
            None,
            MAX_DETAIL_BYTES,
        )?)?;
        let parsed = parse_detail(&detail)?;
        let c = self.connection()?;
        let progress = routed_apply::read_progress(&c, id)?;
        // Server matches that this PC already has, by the name it shows locally.
        let mut present: Vec<InboxMatch> = Vec::new();
        for (work, server_name) in &parsed.matches {
            let local: Option<String> = c
                .query_row(
                    "SELECT name FROM collections WHERE id=?1 AND type='av'",
                    [work],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(name) = local {
                present.push(InboxMatch {
                    collection_id: work.clone(),
                    name: if name.is_empty() {
                        server_name.clone()
                    } else {
                        name
                    },
                });
            }
        }
        if parsed.matches.is_empty() {
            present = local_matches(&c, parsed.inbox["normalizedCode"].as_str())?;
        }
        if !parsed.matches.is_empty() && present.is_empty() && collection_id.is_none() {
            return Err(AvError::Inbox(
                "av_inbox_work_syncing",
                "같은 품번의 컬렉션을 이 PC가 아직 받지 못했어요. 잠시 뒤 다시 열어 주세요.",
            ));
        }
        let mut item =
            item_from_server(&c, &parsed.inbox, progress.as_ref())?.ok_or(AvError::Stale)?;
        item.collection_id = (present.len() == 1).then(|| present[0].collection_id.clone());
        item.collection_name = (present.len() == 1).then(|| present[0].name.clone());
        item.matches = if present.len() > 1 {
            present.clone()
        } else {
            vec![]
        };
        let target = collection_id.or(item.collection_id.as_deref());
        let current = target.map(|id| current_collection(&c, id)).transpose()?;
        let mapping = |name: &str| {
            parsed
                .names
                .iter()
                .find(|m| m.name_ja == name)
                .cloned()
                .unwrap_or_else(|| NameMapping::japanese(name))
        };
        let performers = parsed
            .movie
            .actresses
            .iter()
            .map(|p| person_match(&c, mapping(&p.name), target, "performer"))
            .collect::<Result<_, _>>()?;
        let directors = parsed
            .movie
            .directors
            .iter()
            .map(|p| person_match(&c, mapping(p), target, "director"))
            .collect::<Result<_, _>>()?;
        Ok(Candidate {
            fields: parsed.fields,
            metadata: parsed.movie,
            jacket_url: format!("http://lakomics.localhost/av-link-jacket/{id}"),
            jacket_width: parsed.width,
            jacket_height: parsed.height,
            default_split: parsed.split,
            inbox: item,
            matches: present,
            current,
            performers,
            directors,
        })
    }

    // ---- actions ----------------------------------------------------------------------

    fn routed_action(
        &self,
        server: &impl InboxServer,
        id: &str,
        action: &str,
        body: Value,
    ) -> Result<(), AvError> {
        uuid::Uuid::parse_str(id).map_err(|_| AvError::Invalid)?;
        {
            let c = self.connection()?;
            if let Some(progress) = routed_apply::read_progress(&c, id)? {
                match progress.state.as_str() {
                    // A refused earlier apply may be retried, fixed or discarded.
                    "failed" => routed_apply::discard_progress(&c, &progress)?,
                    _ => {
                        return Err(AvError::Inbox(
                            "av_inbox_applying",
                            "적용 중인 품번은 지금 바꿀 수 없어요.",
                        ))
                    }
                }
            }
        }
        let detail = server_json(server.request(
            "POST",
            &format!("/v1/av-inbox/{id}/{action}"),
            Some(&body),
            MAX_DETAIL_BYTES,
        )?)?;
        let mut jackets = JACKETS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        jackets.retain(|(cached, _, _, _)| cached != id);
        drop(jackets);
        let c = self.connection()?;
        store_item(&c, &detail["inbox"])
    }

    pub(crate) fn routed_retry(&self, server: &impl InboxServer, id: &str) -> Result<(), AvError> {
        self.routed_action(server, id, "retry", json!({}))
    }
    pub(crate) fn routed_fix_code(
        &self,
        server: &impl InboxServer,
        id: &str,
        code: &str,
    ) -> Result<(), AvError> {
        let normalized = normalize_code(code).ok_or(AvError::Invalid)?;
        self.routed_action(server, id, "fix-code", json!({"productCode": normalized}))
    }
    pub(crate) fn routed_dismiss(
        &self,
        server: &impl InboxServer,
        id: &str,
    ) -> Result<(), AvError> {
        self.routed_action(server, id, "dismiss", json!({}))
    }
}

// ---- jacket -----------------------------------------------------------------------------

type JacketEntry = (String, Vec<u8>, &'static str, std::time::Instant);
static JACKETS: Mutex<Vec<JacketEntry>> = Mutex::new(Vec::new());
/// One jacket request at a time: the server admits one preview decode per process.
static JACKET_LANE: Mutex<()> = Mutex::new(());
const JACKET_TTL: Duration = Duration::from_secs(120);

fn jacket_mime(content_type: Option<&str>) -> Option<&'static str> {
    match content_type?.split(';').next()?.trim() {
        "image/jpeg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

impl Library {
    pub(crate) fn routed_jacket(
        &self,
        server: &impl InboxServer,
        id: &str,
    ) -> Result<(Vec<u8>, &'static str), AvError> {
        uuid::Uuid::parse_str(id).map_err(|_| AvError::Invalid)?;
        let _lane = JACKET_LANE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        {
            let mut cache = JACKETS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            cache.retain(|(_, _, _, at)| at.elapsed() < JACKET_TTL);
            if let Some((_, bytes, mime, _)) = cache.iter().find(|(cached, _, _, _)| cached == id) {
                return Ok((bytes.clone(), mime));
            }
        }
        let mut response = None;
        for attempt in 0..3 {
            let current = server.request(
                "GET",
                &format!("/v1/av-inbox/{id}/jacket"),
                None,
                MAX_JACKET_BYTES,
            )?;
            if current.status == 429 && attempt < 2 {
                std::thread::sleep(Duration::from_millis(400));
                continue;
            }
            response = Some(current);
            break;
        }
        let response = response.ok_or(AvError::Image)?;
        if response.status != 200 {
            return Err(refusal(
                response.status,
                refusal_code_of(&response.bytes).as_deref(),
            ));
        }
        let mime = jacket_mime(response.content_type.as_deref()).ok_or(AvError::Image)?;
        let format = image::guess_format(&response.bytes).map_err(|_| AvError::Image)?;
        if format.to_mime_type() != mime {
            return Err(AvError::Image);
        }
        let mut cache = JACKETS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.len() >= 4 {
            cache.remove(0);
        }
        cache.push((
            id.to_owned(),
            response.bytes.clone(),
            mime,
            std::time::Instant::now(),
        ));
        Ok((response.bytes, mime))
    }
}

/// Progress rows by inbox id, shared with the apply module.
pub(super) type ProgressMap = BTreeMap<String, routed_apply::Progress>;
