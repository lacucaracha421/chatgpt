//! Tablet-requested MangaDex / Kakao connections (server contract:
//! `server/lakomics-api/collection_bindings.py`, decided 2026-09-26).
//!
//! The tablet searches on the server and files a bind request; this lane reads the request
//! log, applies each `pending` request with the PC's own apply code and reports the outcome:
//!
//! * MangaDex: [`Library::apply_mangadex`] with `target = existing collectionId` (the PC
//!   "MangaDex 연결" command). Kakao: [`Library::apply_requested_kakao`], the PC "Kakao 연결"
//!   search-and-apply of every picked group (`choice.groups`, or the legacy single
//!   `anchorItemId` + `groupFingerprint`); per group it also accepts the one group with the
//!   picked fingerprint when the picked anchor is no longer in a fresh search (a pick may
//!   be applied days later). The groups' volumes merge by volume number.
//!   Volumes, covers and publication dirty marking (the 0074 triggers) come from that code;
//!   an applied request refreshes the PC UI (`library://collections-changed`).
//! * Before applying: the Collection must exist and be manga; a request whose binding the
//!   PC already has is reported applied without applying again (a crash between applying and
//!   reporting); `expected.externalId` that differs from the PC's binding fails with
//!   `bindingChanged`.
//! * Outcomes: [`classify`] turns an apply error into a permanent failure (reported
//!   `failed` with a Korean message shown on the tablet) or a transient one (network, rate
//!   limit, locked credential store, local database/disk): the lane stops before that
//!   request, keeps its cursor and backs off; after [`MAX_TRANSIENT_ATTEMPTS`] passes on the
//!   same request it is reported failed.
//! * Log: `superseded` / resolved rows are skipped. The cursor advances per item only after
//!   the item is resolved, so no pending request is skipped; a cursor at or past
//!   `oldestPendingSequence` rewinds to just before it, `409 bindCursorRejected` or a changed
//!   `logEpoch` restarts from 0, `404` (older server) backs off for an hour.
//!
//! State lives per endpoint as one JSON value in the existing key/value table `notes_state`
//! (key `collectionBindingSync:<endpoint>`), so no schema migration is needed. No database
//! lock is held during network work (log, result, or the provider calls inside the apply).
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    aladin_flow::{bound_group_keys, MAX_BOUND_GROUPS},
    error::LibraryError,
    models::{
        AladinApplyRequest, AladinGroupSelection, MangaDexApplyRequest, MangaDexApplyTarget,
    },
    Library,
};
use crate::cloud::client::CloudClient;
use crate::cloud::collection_bindings::{
    BindReason, BindRequest, BindResult, LogRead, ResultOutcome, PAGE_LIMIT,
};
use crate::library::credential;

const STATE_PREFIX: &str = "collectionBindingSync:";
/// Log pages one pass may read.
const MAX_PAGES: usize = 5;
/// Pending requests one pass may apply (a Kakao apply can read up to 50 search pages).
const MAX_APPLIES: usize = 3;
/// Passes a request may fail transiently before it is reported failed.
pub(crate) const MAX_TRANSIENT_ATTEMPTS: u32 = 8;
const OLDER_SERVER_BACKOFF: i64 = 3600;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct BindingSyncState {
    /// Last request id resolved or skipped (exclusive `after` of the next read).
    pub cursor: i64,
    /// The server log's `logEpoch` the cursor belongs to.
    pub epoch: Option<String>,
    /// ETag of the (empty) page read at `etag_cursor`.
    pub etag: Option<String>,
    pub etag_cursor: i64,
    pub last_polled: i64,
    /// Unix seconds before which no pass runs (failure backoff).
    pub retry_after: i64,
    pub failures: u32,
    /// The request that last failed transiently and how many passes it has failed.
    pub stuck_request: i64,
    pub stuck_attempts: u32,
}

impl BindingSyncState {
    fn restart(&mut self) {
        self.cursor = 0;
        self.etag = None;
        self.etag_cursor = 0;
        self.epoch = None;
    }
}

/// How the lane applies a request; production is [`LiveApplier`], tests inject fixtures.
pub(crate) trait BindingApplier {
    fn mangadex(
        &self,
        library: &Library,
        request: MangaDexApplyRequest,
    ) -> Result<(), LibraryError>;
    fn kakao(&self, library: &Library, request: AladinApplyRequest) -> Result<(), LibraryError>;
}

/// The PC commands' own code (`commands.rs` `apply_mangadex` / `apply_kakao`).
pub(crate) struct LiveApplier;

impl BindingApplier for LiveApplier {
    fn mangadex(
        &self,
        library: &Library,
        request: MangaDexApplyRequest,
    ) -> Result<(), LibraryError> {
        library.apply_mangadex(request).map(|_| ())
    }
    fn kakao(&self, library: &Library, request: AladinApplyRequest) -> Result<(), LibraryError> {
        let key = credential::read_kakao_key()?;
        library.apply_requested_kakao(&key, request).map(|_| ())
    }
}

#[derive(Debug)]
pub(crate) enum Decision {
    Applied,
    Failed(BindReason),
    Retry(LibraryError),
}

enum Target {
    MangaDex(String),
    Kakao(AladinApplyRequest),
}

enum Pass {
    Done,
    More,
    Unsupported,
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn state_key(endpoint: &str) -> String {
    format!("{STATE_PREFIX}{endpoint}")
}

fn read_state(c: &Connection, endpoint: &str) -> Result<BindingSyncState, LibraryError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT value FROM notes_state WHERE key=?1",
            [state_key(endpoint)],
            |r| r.get(0),
        )
        .optional()?;
    // A damaged value restarts from 0: resolved rows are skipped and a request already
    // bound on the PC is reported applied without applying again.
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

fn write_state(
    c: &Connection,
    endpoint: &str,
    state: &BindingSyncState,
) -> Result<(), LibraryError> {
    let value = serde_json::to_string(state).map_err(|_| LibraryError::InvalidCloudResponse)?;
    c.execute(
        "INSERT INTO notes_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![state_key(endpoint), value],
    )?;
    Ok(())
}

fn backoff(failures: u32) -> i64 {
    (60_i64 << failures.saturating_sub(1).min(5)).min(1800)
}

fn reason(code: &str, message: &str) -> BindReason {
    BindReason {
        code: code.into(),
        message: message.chars().take(500).collect(),
    }
}

fn invalid_choice() -> BindReason {
    reason(
        "invalidChoice",
        "연결 요청 내용을 확인할 수 없습니다. 다시 검색해 선택해 주세요.",
    )
}

/// Transient errors are retried on a later pass; every other error fails the request.
pub(crate) fn classify(error: LibraryError) -> Decision {
    use LibraryError as E;
    let failed = |code: &str, message: &str| Decision::Failed(reason(code, message));
    match error {
        E::CloudRequestTimedOut
        | E::CloudRequestUnavailable
        | E::MangaDexUnavailable
        | E::MangaDexTimedOut
        | E::MangaDexRateLimited
        | E::AladinUnavailable
        | E::AladinTimedOut
        | E::AladinRateLimited
        | E::CredentialStoreLocked
        | E::CredentialStoreFailed
        | E::Database(_)
        | E::WriteWorkArtwork { .. } => Decision::Retry(error),
        E::AladinCredentialNotConfigured
        | E::InvalidAladinCredentialValue
        | E::CredentialStoreUnavailable => failed(
            "kakaoCredentialMissing",
            "PC에 카카오 API 키가 설정되어 있지 않아 연결하지 못했습니다. PC 설정에서 키를 등록한 뒤 다시 요청해 주세요.",
        ),
        E::InvalidAladinCredential => failed(
            "kakaoCredentialRejected",
            "카카오가 PC의 API 키를 거부했습니다. PC 설정에서 키를 확인한 뒤 다시 요청해 주세요.",
        ),
        E::AmbiguousAladinBinding => failed(
            "ambiguousGroup",
            "선택한 시리즈를 카카오 검색 결과에서 확실하게 찾지 못했습니다. 다시 검색해 선택해 주세요.",
        ),
        E::InvalidAladinResponse => failed(
            "kakaoSearchFailed",
            "카카오 검색 결과를 끝까지 확인하지 못했습니다. 더 구체적인 제목으로 다시 검색해 주세요.",
        ),
        E::MangaDexNotFound => failed("mangadexNotFound", "MangaDex에서 이 작품을 찾을 수 없습니다."),
        E::InvalidMangaDexResponse => failed(
            "mangadexResponseInvalid",
            "MangaDex 응답을 처리하지 못했습니다. 잠시 후 다시 요청해 주세요.",
        ),
        E::InvalidMangaDexIdentity | E::InvalidMangaDexQuery | E::InvalidAladinQuery => {
            Decision::Failed(invalid_choice())
        }
        E::DuplicateProviderBinding | E::DuplicateAladinProviderItem => failed(
            "alreadyBoundElsewhere",
            "선택한 작품은 PC에서 이미 다른 작품에 연결되어 있습니다.",
        ),
        E::CollectionNotFound => failed("collectionNotFound", "PC에서 이 작품을 찾을 수 없습니다."),
        E::InvalidCollectionType => failed("collectionNotManga", "만화 작품만 연결할 수 있습니다."),
        other => Decision::Failed(reason(
            "applyFailed",
            &format!("PC에서 연결하지 못했습니다: {other}"),
        )),
    }
}

/// The failure reported once a request has failed transiently too many times.
fn exhausted(error: &LibraryError) -> BindReason {
    let message = match error {
        LibraryError::CredentialStoreLocked | LibraryError::CredentialStoreFailed => {
            "PC의 보안 자격 증명 저장소를 열지 못해 연결하지 못했습니다. PC에서 키링을 잠금 해제한 뒤 다시 요청해 주세요."
        }
        LibraryError::Database(_) | LibraryError::WriteWorkArtwork { .. } => {
            "PC에서 연결 정보를 저장하지 못했습니다. 잠시 후 다시 요청해 주세요."
        }
        _ => "연결할 서비스에 계속 접속하지 못했습니다. 잠시 후 다시 요청해 주세요.",
    };
    reason("providerUnavailable", message)
}

fn text<'a>(
    choice: &'a serde_json::Value,
    key: &str,
    lengths: std::ops::RangeInclusive<usize>,
) -> Option<&'a str> {
    choice
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|v| lengths.contains(&v.chars().count()))
}

fn target(item: &BindRequest) -> Result<Target, BindReason> {
    match item.provider.as_str() {
        "mangadex" => text(&item.choice, "mangaId", 1..=64)
            .map(|id| Target::MangaDex(id.to_owned()))
            .ok_or_else(invalid_choice),
        "kakao" => {
            let query = text(&item.choice, "query", 2..=100)
                .map(str::trim)
                .filter(|query| query.chars().count() >= 2)
                .ok_or_else(invalid_choice)?;
            let groups = kakao_groups(&item.choice).ok_or_else(invalid_choice)?;
            Ok(Target::Kakao(AladinApplyRequest {
                collection_id: item.collection_id.clone(),
                query: query.to_owned(),
                groups,
            }))
        }
        _ => Err(reason(
            "unsupportedProvider",
            "이 PC 버전은 요청한 연결 서비스를 지원하지 않습니다.",
        )),
    }
}

/// The picked groups of a Kakao choice: `groups` (1-10, unique by fingerprint), or the
/// legacy single `anchorItemId` + `groupFingerprint`.
fn kakao_groups(choice: &serde_json::Value) -> Option<Vec<AladinGroupSelection>> {
    fn group(value: &serde_json::Value) -> Option<AladinGroupSelection> {
        let anchor = text(value, "anchorItemId", 1..=128)?;
        let fingerprint = text(value, "groupFingerprint", 64..=64).filter(|f| {
            f.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })?;
        Some(AladinGroupSelection {
            anchor_item_id: anchor.to_owned(),
            group_fingerprint: fingerprint.to_owned(),
        })
    }
    let groups = match choice.get("groups") {
        Some(list) => list
            .as_array()?
            .iter()
            .map(group)
            .collect::<Option<Vec<_>>>()?,
        None => vec![group(choice)?],
    };
    let unique = groups.iter().enumerate().all(|(index, current)| {
        groups[..index]
            .iter()
            .all(|earlier| earlier.group_fingerprint != current.group_fingerprint)
    });
    ((1..=MAX_BOUND_GROUPS).contains(&groups.len()) && unique).then_some(groups)
}

/// `expected.externalId` when the request carries one (`Some(None)` = expected unbound).
fn expected_external_id(item: &BindRequest) -> Option<Option<String>> {
    let value = item.expected.as_ref()?.get("externalId")?;
    match value {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(id) => Some(Some(id.clone())),
        _ => None,
    }
}

impl Library {
    pub(crate) fn collection_binding_sync_state(
        &self,
        endpoint: &str,
    ) -> Result<BindingSyncState, LibraryError> {
        read_state(&*self.connection()?, endpoint)
    }

    /// Read, change and write the state under the library lock.
    fn update_binding_sync_state(
        &self,
        endpoint: &str,
        change: impl FnOnce(&mut BindingSyncState),
    ) -> Result<BindingSyncState, LibraryError> {
        let c = self.connection()?;
        let mut state = read_state(&c, endpoint)?;
        change(&mut state);
        write_state(&c, endpoint, &state)?;
        Ok(state)
    }

    /// The `bindings` publication lane.
    pub(crate) fn run_due_collection_bindings(&self, endpoint: &str) -> Result<(), LibraryError> {
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
        self.sync_collection_bindings_with(&client, publisher.expose(), endpoint, &LiveApplier)
    }

    /// One pass with an injected transport and applier, outside any failure backoff: when
    /// the request log's head in the shared status moved past the cursor (a tablet request
    /// is picked up within about a second of the watcher seeing it), every 30 minutes
    /// otherwise, and at most once a minute without a trusted head (sooner while work is
    /// left over). See `cloud::status_watch::log_due`.
    pub(crate) fn sync_collection_bindings_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
        applier: &dyn BindingApplier,
    ) -> Result<(), LibraryError> {
        use crate::cloud::status_watch::{log_due, LogKind, LogPosition};
        let now = unix_now();
        let state = self.collection_binding_sync_state(endpoint)?;
        if state.retry_after > now {
            return Ok(());
        }
        // The stored epoch is the log page's JSON text (`"…"` for the server's string);
        // the shared status carries the string itself.
        let epoch = state.epoch.as_deref().map(|text| {
            serde_json::from_str::<String>(text).unwrap_or_else(|_| text.to_owned())
        });
        let position = LogPosition {
            cursor: Some(state.cursor),
            epoch: epoch.as_deref(),
        };
        // Left-over work clears `last_polled` to 0, which is always due: the next tick
        // continues it.
        if !log_due(endpoint, LogKind::Bindings, position, Some(state.last_polled), now) {
            return Ok(());
        }
        self.update_binding_sync_state(endpoint, |s| s.last_polled = now)?;
        let mut applied = 0;
        let result = self.drain_collection_bindings(
            client,
            publisher_token,
            endpoint,
            applier,
            &mut applied,
        );
        if applied > 0 {
            super::collection_personal_edits::notify_collections_changed();
        }
        match result {
            Ok(pass) => {
                self.update_binding_sync_state(endpoint, |s| {
                    s.failures = 0;
                    s.retry_after = 0;
                    match pass {
                        Pass::Done => {}
                        // Continue on the next publication tick.
                        Pass::More => s.last_polled = 0,
                        Pass::Unsupported => s.retry_after = now + OLDER_SERVER_BACKOFF,
                    }
                })?;
                Ok(())
            }
            Err(error) => {
                self.update_binding_sync_state(endpoint, |s| {
                    s.failures = s.failures.saturating_add(1);
                    s.retry_after = now + backoff(s.failures);
                })?;
                Err(error)
            }
        }
    }

    fn drain_collection_bindings(
        &self,
        client: &CloudClient,
        token: &str,
        endpoint: &str,
        applier: &dyn BindingApplier,
        applied: &mut usize,
    ) -> Result<Pass, LibraryError> {
        let mut pages = 0;
        let mut applies = 0;
        let mut recoveries = 0;
        loop {
            if pages >= MAX_PAGES {
                return Ok(Pass::More);
            }
            let state = self.collection_binding_sync_state(endpoint)?;
            let etag = state
                .etag
                .as_deref()
                .filter(|_| state.etag_cursor == state.cursor);
            let read = match client.collection_binding_log(token, state.cursor, PAGE_LIMIT, etag) {
                // The server's log restarted behind this cursor: read it again from 0.
                Err(LibraryError::BindingCursorRejected) if recoveries < 2 => {
                    recoveries += 1;
                    eprintln!(
                        "collection bindings: the server request log restarted; reading it again"
                    );
                    self.update_binding_sync_state(endpoint, BindingSyncState::restart)?;
                    continue;
                }
                read => read?,
            };
            let (page, etag) = match read {
                LogRead::NotModified => return Ok(Pass::Done),
                LogRead::Unsupported => return Ok(Pass::Unsupported),
                LogRead::Page { page, etag } => (page, etag),
            };
            pages += 1;
            let epoch = page.log_epoch.as_ref().map(|v| v.to_string());
            if epoch.is_some() && state.epoch.is_some() && epoch != state.epoch && recoveries < 2 {
                recoveries += 1;
                eprintln!(
                    "collection bindings: the server request log was replaced; reading it again"
                );
                self.update_binding_sync_state(endpoint, |s| {
                    s.restart();
                    s.epoch = epoch;
                })?;
                continue;
            }
            // Never leave a pending request behind the cursor.
            if let Some(oldest) = page.oldest_pending_sequence {
                if oldest <= state.cursor && recoveries < 2 {
                    recoveries += 1;
                    self.update_binding_sync_state(endpoint, |s| {
                        s.cursor = oldest - 1;
                        s.etag = None;
                    })?;
                    continue;
                }
            }
            if epoch.is_some() && state.epoch.is_none() {
                self.update_binding_sync_state(endpoint, |s| s.epoch = epoch)?;
            }
            for item in &page.items {
                if item.state == "pending" {
                    if applies >= MAX_APPLIES {
                        return Ok(Pass::More);
                    }
                    applies += 1;
                    let result = match self.decide_binding_request(item, applier) {
                        Decision::Applied => {
                            *applied += 1;
                            BindResult {
                                version: 1,
                                state: "applied".into(),
                                reason: None,
                            }
                        }
                        Decision::Failed(reason) => BindResult {
                            version: 1,
                            state: "failed".into(),
                            reason: Some(reason),
                        },
                        Decision::Retry(error) => {
                            let attempts = self
                                .update_binding_sync_state(endpoint, |s| {
                                    if s.stuck_request == item.request_id {
                                        s.stuck_attempts = s.stuck_attempts.saturating_add(1);
                                    } else {
                                        s.stuck_request = item.request_id;
                                        s.stuck_attempts = 1;
                                    }
                                })?
                                .stuck_attempts;
                            if attempts < MAX_TRANSIENT_ATTEMPTS {
                                eprintln!(
                                    "collection bindings: request {} will be retried: {error}",
                                    item.request_id
                                );
                                return Err(error);
                            }
                            BindResult {
                                version: 1,
                                state: "failed".into(),
                                reason: Some(exhausted(&error)),
                            }
                        }
                    };
                    match client.report_collection_binding_result(
                        token,
                        item.request_id,
                        &result,
                    )? {
                        ResultOutcome::Unsupported => return Ok(Pass::Unsupported),
                        // Recorded, or already resolved / pruned on the server: done either way.
                        ResultOutcome::Recorded
                        | ResultOutcome::Conflict
                        | ResultOutcome::NotFound => {}
                    }
                }
                self.update_binding_sync_state(endpoint, |s| {
                    s.cursor = item.request_id;
                    s.etag = None;
                    if s.stuck_request == item.request_id {
                        s.stuck_request = 0;
                        s.stuck_attempts = 0;
                    }
                })?;
            }
            self.update_binding_sync_state(endpoint, |s| {
                s.cursor = page.next_cursor;
                // Only an empty page is unchanged by this pass, so only its tag is reusable.
                if page.items.is_empty() {
                    s.etag = etag;
                    s.etag_cursor = page.after;
                } else {
                    s.etag = None;
                }
            })?;
            if !page.has_more {
                return Ok(Pass::Done);
            }
        }
    }

    /// Check and apply one pending request. The checks hold the library lock briefly; the
    /// apply takes it itself around its database work, never during its provider calls.
    pub(crate) fn decide_binding_request(
        &self,
        item: &BindRequest,
        applier: &dyn BindingApplier,
    ) -> Decision {
        let target = match target(item) {
            Ok(target) => target,
            Err(reason) => return Decision::Failed(reason),
        };
        match self.binding_precheck(item, &target) {
            Ok(Some(decision)) => return decision,
            Ok(None) => {}
            Err(error) => return classify(error),
        }
        let result = match target {
            Target::MangaDex(manga_id) => applier.mangadex(
                self,
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::Existing {
                        collection_id: item.collection_id.clone(),
                    },
                    manga_id,
                },
            ),
            Target::Kakao(request) => applier.kakao(self, request),
        };
        match result {
            Ok(()) => Decision::Applied,
            Err(error) => classify(error),
        }
    }

    fn binding_precheck(
        &self,
        item: &BindRequest,
        target: &Target,
    ) -> Result<Option<Decision>, LibraryError> {
        let c = self.connection()?;
        let kind: Option<String> = c
            .query_row(
                "SELECT type FROM collections WHERE id=?1",
                [&item.collection_id],
                |r| r.get(0),
            )
            .optional()?;
        match kind.as_deref() {
            None => return Ok(Some(classify(LibraryError::CollectionNotFound))),
            Some("manga") => {}
            Some(_) => return Ok(Some(classify(LibraryError::InvalidCollectionType))),
        }
        let current: Option<(String, Option<String>)> = c
            .query_row(
                "SELECT external_id, provider_config_json FROM collection_external_bindings
                 WHERE collection_id=?1 AND provider=?2",
                params![item.collection_id, item.provider],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let already = current
            .as_ref()
            .is_some_and(|(external, config)| match target {
                Target::MangaDex(manga_id) => external == manga_id,
                Target::Kakao(request) => {
                    // Applied already when the binding holds exactly the picked groups
                    // (each matched by fingerprint, or by anchor for an unchanged pick).
                    bound_group_keys(config.as_deref(), external).is_some_and(|bound| {
                        bound.len() == request.groups.len()
                            && request.groups.iter().all(|picked| {
                                bound.iter().any(|(anchor, fingerprint)| {
                                    fingerprint == &picked.group_fingerprint
                                        || anchor == &picked.anchor_item_id
                                })
                            })
                    })
                }
            });
        if already {
            return Ok(Some(Decision::Applied));
        }
        if let Some(expected) = expected_external_id(item) {
            if current.map(|(external, _)| external) != expected {
                return Ok(Some(Decision::Failed(reason(
                    "bindingChanged",
                    "태블릿에서 확인한 뒤 PC의 연결이 바뀌었습니다. 현재 연결을 확인하고 다시 선택해 주세요.",
                ))));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
#[path = "collection_binding_sync_tests.rs"]
mod tests;
