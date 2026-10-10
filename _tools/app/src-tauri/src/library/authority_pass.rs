//! One coordinated receive/send pass over every shared authority domain.
//!
//! The desktop used to poll each domain on its own timer, and each loop read
//! `/v1/sync/status` and its change feed every five seconds whether or not anything
//! had moved. A pass now reads the aggregate status once (conditionally, so an
//! unchanged server answers `304`), shares it with the Asset, Album and Classification
//! lanes, and fetches a domain's change feed only when that domain's cursor moved or
//! this pass just wrote to it. Catalog bookmarks take their authority from the same
//! document's `catalog-bookmarks` row (an older server without the aggregate route
//! falls back to `/v1/mobile-catalog/status`). Explicit reconciliation (the Tauri
//! commands) keeps reading and validating every feed.
//!
//! The status is read with the publisher credential when one is configured, so it
//! carries `publisherLogs` for the publication lanes (`cloud::status_watch`). While the
//! status watcher is live the pass reads nothing itself: it uses the watcher's document.
//!
//! [`AuthoritySchedule`] decides when the next pass is due: five seconds after a pass
//! that changed something, then 15, 30 and 60 seconds while nothing changes (300 s while
//! a live watcher would wake it on any change), and immediately after a local write,
//! window focus, a watched change, or a wake that arrived mid-pass.
use rusqlite::OptionalExtension;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::classification_authority::{CredentialSource, OsCredentials};
use super::error::LibraryError;
use super::Library;
use crate::cloud::client::{CloudClient, SyncStatus};
use crate::cloud::failure::CloudFailureReason;
use crate::cloud::status_watch;

static LOCAL_WORK: AtomicBool = AtomicBool::new(false);

/// A local mutation queued an outgoing intent; the next scheduler tick runs a pass.
pub(crate) fn note_local_work() {
    LOCAL_WORK.store(true, Ordering::Release);
}

/// Consume the local-work signal.
pub(crate) fn take_local_work() -> bool {
    LOCAL_WORK.swap(false, Ordering::AcqRel)
}

/// Idle delays after an unchanged pass; a changed pass returns to the first.
pub(crate) const DELAYS: [Duration; 4] = [
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
];
/// The lightweight mode's minimum spacing between passes (the old Asset lane's value).
pub(crate) const RESTRICTED_FLOOR: Duration = Duration::from_secs(20);
/// Idle delay while the status watcher is live: every visible change wakes the pass, so
/// this is only a safety net.
pub(crate) const LIVE_IDLE: Duration = Duration::from_secs(300);

/// When the next coordinated pass is due. Pure state, so the backoff is testable.
#[derive(Debug)]
pub(crate) struct AuthoritySchedule {
    idle: usize,
    due: Instant,
    running: bool,
    woken_while_running: bool,
}

impl AuthoritySchedule {
    /// The first pass is due immediately.
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            idle: 0,
            due: now,
            running: false,
            woken_while_running: false,
        }
    }

    pub(crate) fn due(&self, now: Instant) -> bool {
        !self.running && now >= self.due
    }

    /// A local write, window focus or other foreground signal: run now and return to
    /// the fast interval. A wake during a pass is owed and honoured when it finishes,
    /// because that pass may already have read the state the wake is about.
    pub(crate) fn wake(&mut self, now: Instant) {
        self.idle = 0;
        self.due = now;
        if self.running {
            self.woken_while_running = true;
        }
    }

    /// Work outside a pass (the Asset lane) changed local state: return to the fast
    /// interval without forcing an immediate pass.
    pub(crate) fn changed_elsewhere(&mut self, now: Instant) {
        self.idle = 0;
        if !self.running {
            self.due = self.due.min(now + DELAYS[0]);
        }
    }

    pub(crate) fn begin(&mut self) {
        self.running = true;
        self.woken_while_running = false;
    }

    /// Record a finished pass and return the delay until the next one. `live`: the status
    /// watcher is live and this pass failed nowhere, so an unchanged pass may rest for
    /// [`LIVE_IDLE`]; a failing pass keeps the ordinary backoff.
    pub(crate) fn finished(
        &mut self,
        changed: bool,
        restricted: bool,
        live: bool,
        now: Instant,
    ) -> Duration {
        self.running = false;
        if self.woken_while_running {
            self.woken_while_running = false;
            self.idle = 0;
            self.due = now;
            return Duration::ZERO;
        }
        self.idle = if changed {
            0
        } else {
            (self.idle + 1).min(DELAYS.len() - 1)
        };
        let mut delay = DELAYS[self.idle];
        if live && !changed {
            delay = LIVE_IDLE;
        }
        if restricted {
            delay = delay.max(RESTRICTED_FLOOR);
        }
        self.due = now + delay;
        delay
    }
}

/// What one pass changed, per domain, for UI invalidation and backoff.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AuthorityPassOutcome {
    /// The Album replica visibly changed.
    pub albums: bool,
    /// The Classification replica visibly changed.
    pub classifications: bool,
    /// The dormant Collections replica changed after a confirmed active epoch.
    pub collections: bool,
    /// Catalog bookmarks visibly changed.
    pub bookmarks: bool,
    /// The Asset replica was re-baselined ahead of the relation lanes.
    pub assets: bool,
    /// An outgoing intent was delivered; the authority moved because of this PC.
    pub sent: bool,
    /// Some lane was refused for credentials, so the cached token must be dropped.
    pub unauthorized: bool,
    /// Why the first failing lane failed, as a closed [`CloudFailureReason`] code. Lanes
    /// still fail independently; this only keeps the failure observable.
    pub failure: Option<&'static str>,
    /// A live status watcher vouched for the status this pass used.
    pub live: bool,
    pub held: bool,
}

impl AuthorityPassOutcome {
    fn failed(&mut self, error: &LibraryError) {
        if matches!(error, LibraryError::CloudSyncHeld) {
            self.held = true;
            return;
        }
        self.unauthorized |= matches!(error, LibraryError::CloudUnauthorized);
        self.failure
            .get_or_insert(CloudFailureReason::from_error(error).code());
    }
}

/// What one Asset lane run did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AssetLaneOutcome {
    /// Local Asset state changed.
    pub changed: bool,
    /// The lifecycle queue stopped at a head intent the server neither accepted nor
    /// definitively refused; it is retried on the next pass.
    pub stopped: bool,
    pub held: bool,
    pub materialization_failures: u32,
    pub lifecycle_failures: Vec<super::asset_authority::LifecycleIntentFailure>,
}

impl AuthorityPassOutcome {
    pub(crate) fn changed(&self) -> bool {
        self.albums
            || self.classifications
            || self.collections
            || self.bookmarks
            || self.assets
            || self.sent
    }
}

impl Library {
    /// One coordinated metadata pass with the configured endpoint and OS credentials.
    /// Returns the status it read so the Asset lane can reuse it.
    pub(crate) fn run_authority_pass(
        &self,
    ) -> Result<(AuthorityPassOutcome, Option<SyncStatus>), LibraryError> {
        let Some((client, token)) = self.authority_client()? else {
            return Ok((AuthorityPassOutcome::default(), None));
        };
        let (outcome, status) = self.authority_pass_with(&client, token.expose(), &OsCredentials);
        if outcome.unauthorized {
            super::credential_broker::broker()
                .invalidate(super::credential::CredentialTarget::CloudApi);
        }
        Ok((outcome, status))
    }

    /// The Asset lane against the status a metadata pass just read.
    ///
    /// It runs on its own single-flight thread because materialization may download
    /// media for minutes; the metadata lanes must keep converging meanwhile.
    pub(crate) fn run_asset_lane(
        &self,
        status: &SyncStatus,
        restricted: bool,
    ) -> Result<AssetLaneOutcome, LibraryError> {
        let Some((client, token)) = self.authority_client()? else {
            return Ok(AssetLaneOutcome::default());
        };
        let result = self.asset_lane_with(&client, token.expose(), None, restricted, status);
        if matches!(result, Err(LibraryError::CloudUnauthorized)) {
            super::credential_broker::broker()
                .invalidate(super::credential::CredentialTarget::CloudApi);
        }
        result
    }

    pub(super) fn authority_client(
        &self,
    ) -> Result<Option<(CloudClient, super::credential::CloudCredential)>, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(None);
        }
        let client = self.cloud_client(
            config
                .api_base_url
                .as_deref()
                .ok_or(LibraryError::InvalidCloudSyncConfig)?,
        )?;
        Ok(Some((
            client,
            super::credential::read_cloud_api_token_os()?,
        )))
    }

    pub(super) fn asset_lane_with(
        &self,
        client: &CloudClient,
        token: &str,
        publisher: Option<&str>,
        restricted: bool,
        status: &SyncStatus,
    ) -> Result<AssetLaneOutcome, LibraryError> {
        let result = self.sync_assets_with_status(
            client,
            token,
            publisher,
            restricted,
            &|| Ok(status.clone()),
            true,
        )?;
        Ok(AssetLaneOutcome {
            changed: result.applied_changes > 0 || result.materialized > 0 || result.flushed > 0,
            stopped: result.stopped,
            held: result.held,
            materialization_failures: result.materialization_failures,
            lifecycle_failures: result.lifecycle_failures,
        })
    }

    /// The pass against explicit transport and credentials. Every lane is independent:
    /// one lane's failure is left for the next pass and never blocks the others.
    pub(super) fn authority_pass_with(
        &self,
        client: &CloudClient,
        token: &str,
        credentials: &dyn CredentialSource,
    ) -> (AuthorityPassOutcome, Option<SyncStatus>) {
        let held = self.sync_held(client.base()) || client.held();
        let mut outcome = AuthorityPassOutcome::default();
        // One status per pass, shared by every lane (and handed to the Asset lane
        // afterwards): the live watcher's document when there is one, otherwise one
        // conditional read. The error is not `Clone`, so lanes after a failed read see its
        // kind: a credential failure, an unknown authority state, or a transport failure.
        let status: std::cell::OnceCell<Result<SyncStatus, StatusFailure>> =
            std::cell::OnceCell::new();
        let read_status = || -> Result<SyncStatus, LibraryError> {
            match status.get_or_init(|| {
                if let Some(status) =
                    status_watch::live_status(client.base(), status_watch::unix_now())
                {
                    return Ok(status);
                }
                let publisher = credentials.publisher().ok();
                status_watch::read_status(client, token, publisher.as_deref())
                    .map_err(|error| match error {
                        LibraryError::CloudUnauthorized => StatusFailure::Unauthorized,
                        LibraryError::RestoreAuthorityUnknown => StatusFailure::Unknown,
                        _ => StatusFailure::Unavailable,
                    })
            }) {
                Ok(value) => Ok(value.clone()),
                Err(StatusFailure::Unauthorized) => Err(LibraryError::CloudUnauthorized),
                Err(StatusFailure::Unknown) => Err(LibraryError::RestoreAuthorityUnknown),
                Err(StatusFailure::Unavailable) => Err(LibraryError::CloudRequestUnavailable),
            }
        };

        // After a server authority restore the Asset replica is re-baselined first: the
        // Album and Classification baselines replace their relation tables wholesale and
        // can keep a lost Asset's relations only once the Asset re-baseline has released
        // it back to local (review follow-up). Until then both lanes wait; their flushes
        // too, since a lost Asset would otherwise still look uploaded to them.
        let relations_ready = match read_status() {
            Ok(status) => match self.settle_asset_identity_with_status(client, token, &status) {
                Ok(Some(changed)) => {
                    outcome.assets = changed;
                    true
                }
                Ok(None) => false,
                Err(error) => {
                    outcome.failed(&error);
                    false
                }
            },
            // The lanes below meet the same status failure and record it themselves.
            Err(_) => true,
        };

        // Albums: flush first; receive only over a clean queue. A domain this pass
        // just wrote to is not skipped, because the shared status predates the write.
        if relations_ready {
            match if held { Ok(super::album_authority::AlbumOutboxFlush::default()) } else { self.flush_album_outbox_with(client, token) } {
                Ok(flush) => {
                    let wrote = flush.sent > 0 || flush.no_op > 0;
                    outcome.sent |= wrote;
                    if !flush.stopped {
                        match self.reconcile_album_authority_with_status(
                            client,
                            token,
                            &read_status,
                            !wrote,
                        ) {
                            Ok(received) => {
                                outcome.albums = received.applied_changes > 0
                                    || received.adopted_baseline
                                    || received.rematerialized_memberships > 0;
                            }
                            Err(error) => outcome.failed(&error),
                        }
                    }
                }
                Err(error) => outcome.failed(&error),
            }

            match if held { Ok(super::classification_authority::ClassificationOutboxFlush::default()) } else { self.flush_classification_outbox_with_source(client, credentials) } {
                Ok(flush) => {
                    let wrote = flush.sent > 0 || flush.no_op > 0 || flush.rebased > 0;
                    outcome.sent |= wrote;
                    if !flush.stopped {
                        match self.reconcile_classification_authority_with_status(
                            client,
                            token,
                            &read_status,
                            !wrote,
                        ) {
                            Ok(received) => {
                                outcome.classifications = received.applied_changes > 0
                                    || received.adopted_baseline
                                    || received.rematerialized_assignments > 0;
                            }
                            Err(error) => outcome.failed(&error),
                        }
                    }
                }
                Err(error) => outcome.failed(&error),
            }
        }

        // Bookmarks: receive, then deliver queued intents, then receive again after a
        // delivery (the order the bookmark loop always used). The send pass is skipped
        // entirely when there is nothing to send.
        let bookmarks = (|| -> Result<(bool, bool), LibraryError> {
            let authority = match read_status() {
                Ok(status) => status.bookmark_authority(),
                // A server without the aggregate route still reports bookmarks on its own.
                Err(LibraryError::RestoreAuthorityUnknown) => {
                    client.mobile_catalog_authority_conditional(token)?
                }
                Err(error) => return Err(error),
            };
            let received = self.reconcile_catalog_bookmarks_from(client, token, authority, true)?;
            let mut changed = received.applied_changes > 0 || received.adopted_baseline;
            let mut sent = false;
            if !held && self.pending_intent_count()? > 0 {
                let flushed = self.flush_catalog_bookmark_outbox_with(client, token)?;
                if flushed.sent > 0 || flushed.already_current > 0 || flushed.rebased {
                    sent = true;
                    let again = self.reconcile_catalog_bookmarks_with(client, token)?;
                    changed |= again.applied_changes > 0 || again.adopted_baseline;
                }
            }
            Ok((changed, sent))
        })();
        match bookmarks {
            Ok((changed, sent)) => {
                outcome.bookmarks = changed;
                outcome.sent |= sent;
            }
            Err(error) => outcome.failed(&error),
        }

        // An old server without this domain leaves PC pins and its queue untouched.
        if let Ok(status) = read_status() {
            if let Some(domain) = status.domains.iter().find(|d| d.domain == super::manga_index_sync::DOMAIN) {
                match self.sync_manga_index_pins_with(client, token, domain) {
                    Ok(pins) => {
                        // The index listens to the catalog invalidation event.
                        outcome.bookmarks |= pins.changed;
                        outcome.sent |= pins.sent;
                    }
                    Err(error) => outcome.failed(&error),
                }
            }
        }

        // Always read once, even when every lane above deferred, so the Asset lane
        // has a status to work from.
        let status = match read_status() {
            Ok(status) => Some(status),
            Err(error) => {
                outcome.failed(&error);
                None
            }
        };
        if let Some(status) = &status {
            if status.domains.iter().any(|domain| domain.domain == "collections") {
                let publisher = credentials.publisher().ok();
                match self.sync_collection_authority(client, token, publisher.as_deref(), status, held) {
                    Ok((changed, sent)) => {
                        outcome.collections = changed;
                        outcome.sent |= sent;
                    }
                    Err(error) => outcome.failed(&error),
                }
            }
        }
        // A deferred relation lane keeps the ordinary backoff rather than the live rest.
        outcome.live = relations_ready && status_watch::is_live(client.base());
        (outcome, status)
    }
}

/// Why the shared status read failed, kept so every lane sees the same kind.
#[derive(Debug, Clone, Copy)]
enum StatusFailure {
    Unauthorized,
    Unknown,
    Unavailable,
}

/// One Album or Classification domain's delivery health, read from the local database.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DomainSyncHealth {
    /// Intents the authority refused on structural grounds; they need a user decision.
    pub blocked_count: u32,
    /// Asset-subject intents held until their Asset's upload commits.
    pub waiting_count: u32,
    /// Intents retired without delivery since this library began recording them.
    pub dropped_count: u32,
    /// Closed code of the most recent drop.
    pub last_drop_reason: Option<String>,
    pub last_dropped_at: Option<String>,
}

/// The Asset lifecycle lane's health.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetSyncHealth {
    /// Lifecycle intents the server state overrode (`lifecycleRejected:*`).
    pub rejected_count: u32,
    /// The most common rejection code among them.
    pub rejected_reason: Option<String>,
    /// The last lane run stopped at an unresolved head intent (runtime state).
    pub stopped: bool,
    pub held: bool,
    pub rejected_assets: Vec<AssetIntentRejection>,
    pub materialization_failures: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetIntentRejection {
    pub asset_id: String,
    pub name: String,
    pub reason: String,
}

/// Mobile character exclusions this PC consumed without applying (durable receipts).
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CharacterExclusionHealth {
    pub skipped_count: u32,
    /// Closed code of the most recent skip (`targetMissing`, `assetMissing`, ...).
    pub last_skip_reason: Option<String>,
    pub last_skipped_at: Option<String>,
}

/// The latest failure of a background lane, as a closed code (runtime state).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaneFailure {
    pub code: &'static str,
    pub at: String,
}

/// Local-only view of silent authority-sync trouble for the status panel.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthoritySyncHealth {
    pub albums: DomainSyncHealth,
    pub classifications: DomainSyncHealth,
    pub collections: DomainSyncHealth,
    pub assets: AssetSyncHealth,
    pub character_exclusions: CharacterExclusionHealth,
    pub authority_pass_failure: Option<LaneFailure>,
    pub asset_lane_failure: Option<LaneFailure>,
    pub sync_hold: Option<super::sync_hold::Status>,
    pub authority_held: bool,
}

impl Library {
    /// The database half of [`AuthoritySyncHealth`]: a few local counts, no network.
    /// The runtime fields (lane failures, `assets.stopped`) are left for the caller.
    pub(crate) fn authority_sync_health(&self) -> Result<AuthoritySyncHealth, LibraryError> {
        let config = self.cloud_sync_config()?;
        let sync_hold = config
            .api_base_url
            .as_deref()
            .filter(|_| config.enabled)
            .map(|endpoint| self.cloud_sync_hold(endpoint))
            .transpose()?;
        let albums = self.album_sync_status()?;
        let classifications = self.classification_sync_status()?;
        let mut health = AuthoritySyncHealth {
            sync_hold,
            albums: DomainSyncHealth {
                blocked_count: albums.blocked_count,
                waiting_count: albums.waiting_count,
                ..Default::default()
            },
            classifications: DomainSyncHealth {
                blocked_count: classifications.blocked_count,
                waiting_count: classifications.waiting_count,
                ..Default::default()
            },
            ..Default::default()
        };
        let connection = self.connection()?;
        health.collections.blocked_count = connection.query_row("SELECT COUNT(*) FROM collection_authority_outbox WHERE state='blocked'",[],|r|r.get(0))?;
        // Batch 1 keeps Collection drop evidence in its durable outbox; the shared
        // intent-drop table intentionally only accepts Albums and Classifications.
        health.collections.dropped_count = connection.query_row("SELECT COUNT(*) FROM collection_authority_outbox WHERE state='dropped'",[],|r|r.get(0))?;
        if let Some((reason, at)) = connection.query_row("SELECT drop_reason,updated_at FROM collection_authority_outbox WHERE state='dropped' ORDER BY updated_at DESC,seq DESC LIMIT 1",[],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?))).optional()? {
            health.collections.last_drop_reason = reason;
            health.collections.last_dropped_at = at;
        }
        let mut drops = connection.prepare(
            "SELECT domain, dropped_count, last_reason, last_dropped_at FROM authority_intent_drops",
        )?;
        let rows = drops.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows {
            let (domain, count, reason, at) = row?;
            let target = match domain.as_str() {
                "albums" => &mut health.albums,
                "classifications" => &mut health.classifications,
                _ => continue,
            };
            target.dropped_count = u32::try_from(count).unwrap_or(u32::MAX);
            target.last_drop_reason = reason;
            target.last_dropped_at = at;
        }
        let mut rejected = connection.prepare(
            "SELECT last_error, COUNT(*) FROM asset_authority_state
             WHERE last_error LIKE 'lifecycleRejected:%' GROUP BY last_error",
        )?;
        let rows = rejected.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut most = 0;
        for row in rows {
            let (error, count) = row?;
            let count = u32::try_from(count).unwrap_or(u32::MAX);
            health.assets.rejected_count = health.assets.rejected_count.saturating_add(count);
            if count > most {
                most = count;
                health.assets.rejected_reason = error
                    .strip_prefix(super::asset_authority::LIFECYCLE_REJECTED)
                    .map(str::to_owned);
            }
        }
        drop(rejected);
        // Keep the panel short; the total above includes all rejected Assets.
        health.assets.rejected_assets = connection.prepare(
            "SELECT s.asset_id, COALESCE(a.original_name, s.asset_id), s.last_error
             FROM asset_authority_state s LEFT JOIN assets a ON a.id = s.asset_id
             WHERE s.last_error LIKE 'lifecycleRejected:%'
             ORDER BY s.asset_id LIMIT 5",
        )?.query_map([], |row| {
            let error: String = row.get(2)?;
            Ok(AssetIntentRejection {
                asset_id: row.get(0)?, name: row.get(1)?,
                reason: error.strip_prefix(super::asset_authority::LIFECYCLE_REJECTED)
                    .unwrap_or(&error).to_owned(),
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        health.assets.materialization_failures = connection.query_row(
            "SELECT COUNT(*) FROM asset_authority_state WHERE materialization IN ('pending','conflict')
             AND json_valid(last_error) AND lifecycle = 'normal'", [], |row| row.get(0),
        )?;
        let (skipped, last): (i64, Option<(String, String)>) = (
            connection.query_row(
                "SELECT COUNT(*) FROM mobile_character_exclusion_receipts WHERE skip_reason IS NOT NULL",
                [],
                |row| row.get(0),
            )?,
            connection
                .query_row(
                    "SELECT skip_reason, created_at FROM mobile_character_exclusion_receipts
                     WHERE skip_reason IS NOT NULL ORDER BY created_at DESC, sequence DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?,
        );
        health.character_exclusions = CharacterExclusionHealth {
            skipped_count: u32::try_from(skipped).unwrap_or(u32::MAX),
            last_skip_reason: last.as_ref().map(|(reason, _)| reason.clone()),
            last_skipped_at: last.map(|(_, at)| at),
        };
        Ok(health)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::classification_authority::FixedCredentials;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    const LIB: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const TOKEN: &str = "client-token";

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Seen {
        path: String,
        if_none_match: bool,
    }

    /// Server-side cursors; a test moves one to simulate a remote change.
    struct Cursors {
        assets: i64,
        albums: i64,
        classifications: i64,
        bookmarks: i64,
    }

    /// A fake Cloud API: status documents with (or without) ETag/304, empty feeds,
    /// and a log of every request path and whether it was conditional.
    struct Fake {
        base: String,
        seen: Arc<Mutex<Vec<Seen>>>,
        /// The credential of each `/v1/sync/status` request.
        status_auth: Arc<Mutex<Vec<String>>>,
        /// Answer `/v1/sync/status` with 401 for the publisher credential.
        refuse_publisher: Arc<std::sync::atomic::AtomicBool>,
        cursors: Arc<Mutex<Cursors>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl Fake {
        fn start(etags: bool) -> Self {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://{}", server.server_addr());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let cursors = Arc::new(Mutex::new(Cursors {
                assets: 3,
                albums: 5,
                classifications: 7,
                bookmarks: 9,
            }));
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let status_auth = Arc::new(Mutex::new(Vec::new()));
            let refuse_publisher = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (log, state, halt) = (seen.clone(), cursors.clone(), stop.clone());
            let (auths, refuse) = (status_auth.clone(), refuse_publisher.clone());
            let worker = std::thread::spawn(move || {
                while !halt.load(Ordering::Acquire) {
                    let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(20)) else {
                        continue;
                    };
                    let url = request.url().to_owned();
                    let path = url.split('?').next().unwrap().to_owned();
                    let tag = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("If-None-Match"))
                        .map(|h| h.value.as_str().to_owned());
                    log.lock().unwrap().push(Seen {
                        path: path.clone(),
                        if_none_match: tag.is_some(),
                    });
                    if path == "/v1/sync/status" {
                        let auth = request
                            .headers()
                            .iter()
                            .find(|h| h.field.equiv("Authorization"))
                            .map(|h| h.value.as_str().to_owned())
                            .unwrap_or_default();
                        let refused = refuse.load(Ordering::Acquire)
                            && auth == "Bearer publisher-token";
                        auths.lock().unwrap().push(auth);
                        if refused {
                            let _ = request.respond(
                                tiny_http::Response::from_string("{}").with_status_code(401),
                            );
                            continue;
                        }
                    }
                    let c = state.lock().unwrap();
                    let domain = |name: &str, cursor: i64| json!({"domain":name,"libraryId":LIB,"epoch":1,"contractVersion":1,"cursor":cursor});
                    let body: Value = match path.as_str() {
                        "/v1/sync/status" => {
                            json!({"protocolVersion":1,"active":true,"libraryId":LIB,"domains":[
                            domain("albums", c.albums), domain("assets", c.assets),
                            domain("catalog-bookmarks", c.bookmarks), domain("classifications", c.classifications)]})
                        }
                        "/v1/mobile-catalog/status" => {
                            json!({"ready":true,"authorityLibraryId":LIB,"authorityEpoch":1,
                            "authorityContractVersion":1,"authorityCursor":c.bookmarks,"capabilities":{"bookmarkWrite":true}})
                        }
                        _ if path.ends_with("/changes") => {
                            let after: i64 = url
                                .split("after=")
                                .nth(1)
                                .and_then(|v| v.split('&').next())
                                .unwrap()
                                .parse()
                                .unwrap();
                            json!({"libraryId":LIB,"epoch":1,"contractVersion":1,"cursor":after,"items":[],"nextAfter":after,"hasMore":false})
                        }
                        _ => json!({"detail":"unexpected"}),
                    };
                    drop(c);
                    let text = body.to_string();
                    let etag = {
                        use sha2::Digest;
                        let digest = sha2::Sha256::digest(text.as_bytes());
                        format!(
                            "\"{}\"",
                            digest
                                .iter()
                                .take(8)
                                .map(|b| format!("{b:02x}"))
                                .collect::<String>()
                        )
                    };
                    let mut response = if etags && tag.as_deref() == Some(etag.as_str()) {
                        tiny_http::Response::from_string(String::new()).with_status_code(304)
                    } else {
                        tiny_http::Response::from_string(text).with_header(
                            "Content-Type: application/json"
                                .parse::<tiny_http::Header>()
                                .unwrap(),
                        )
                    };
                    if etags {
                        response = response.with_header(
                            format!("ETag: {etag}")
                                .parse::<tiny_http::Header>()
                                .unwrap(),
                        );
                    }
                    let _ = request.respond(response);
                }
            });
            Self {
                base,
                seen,
                status_auth,
                refuse_publisher,
                cursors,
                stop,
                worker: Some(worker),
            }
        }
        fn client(&self) -> CloudClient {
            CloudClient::new(&self.base).unwrap()
        }
        fn take(&self) -> Vec<Seen> {
            std::mem::take(&mut *self.seen.lock().unwrap())
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    /// A library that already adopted every domain at the fake server's cursors.
    fn adopted() -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let db = library.connection().unwrap();
        db.execute(
            "UPDATE library_settings SET library_id=?1 WHERE singleton=1",
            [LIB],
        )
        .unwrap();
        db.execute("INSERT INTO asset_authority VALUES(1,?1,1,1,3)", [LIB])
            .unwrap();
        for (table, cursor) in [
            ("album_authority_sync", 5),
            ("classification_authority_sync", 7),
            ("catalog_bookmark_sync", 9),
        ] {
            db.execute(
                &format!("INSERT INTO {table}(singleton,library_id,epoch,contract_version,cursor,updated_at) VALUES(1,?1,1,1,?2,'2026-09-24T00:00:00Z')"),
                rusqlite::params![LIB, cursor],
            )
            .unwrap();
        }
        drop(db);
        (temp, library)
    }

    /// A metadata pass, then the Asset lane on its status, as the scheduler runs them.
    fn pass(library: &Library, client: &CloudClient) -> AuthorityPassOutcome {
        let credentials = FixedCredentials {
            client_token: TOKEN,
            publisher_token: "publisher-token",
        };
        let (mut outcome, status) = library.authority_pass_with(client, TOKEN, &credentials);
        let assets = library
            .asset_lane_with(
                client,
                TOKEN,
                Some("publisher-token"),
                false,
                &status.unwrap(),
            )
            .unwrap();
        outcome.sent |= assets.changed;
        outcome
    }

    fn feeds(seen: &[Seen]) -> Vec<&str> {
        seen.iter()
            .filter(|s| s.path.ends_with("/changes"))
            .map(|s| s.path.as_str())
            .collect()
    }

    /// One status read per pass: bookmarks take their authority from the same document.
    fn status_reads(conditional: bool) -> Vec<Seen> {
        vec![Seen {
            path: "/v1/sync/status".into(),
            if_none_match: conditional,
        }]
    }

    #[test]
    fn an_unchanged_server_costs_one_conditional_status_read_and_no_feed() {
        let fake = Fake::start(true);
        let (_temp, library) = adopted();
        let client = fake.client();
        // The first pass fills the ETag cache; every domain is already at its cursor.
        assert!(!pass(&library, &client).changed());
        assert_eq!(fake.take(), status_reads(false));
        for _ in 0..3 {
            assert_eq!(pass(&library, &client), AuthorityPassOutcome::default());
            // One conditional /v1/sync/status shared by the Asset, Album,
            // Classification and bookmark lanes, and no feed.
            assert_eq!(fake.take(), status_reads(true));
        }
    }

    #[test]
    fn the_status_is_read_with_the_publisher_credential_and_falls_back_on_refusal() {
        let fake = Fake::start(true);
        let (_temp, library) = adopted();
        let client = fake.client();
        assert!(!pass(&library, &client).changed());
        assert_eq!(
            std::mem::take(&mut *fake.status_auth.lock().unwrap()),
            vec!["Bearer publisher-token"]
        );
        fake.refuse_publisher.store(true, Ordering::Release);
        // Refused: the same pass reads with the client credential and nothing is marked
        // unauthorized (the client credential is fine and must not be dropped).
        let outcome = pass(&library, &client);
        assert!(!outcome.unauthorized, "{outcome:?}");
        assert_eq!(outcome.failure, None);
        // Later passes do not present the refused credential again.
        pass(&library, &client);
        assert_eq!(
            std::mem::take(&mut *fake.status_auth.lock().unwrap()),
            vec!["Bearer publisher-token", "Bearer client-token", "Bearer client-token"]
        );
        assert!(feeds(&fake.take()).is_empty());
    }

    #[test]
    fn a_live_watcher_document_replaces_the_status_read() {
        let fake = Fake::start(true);
        let (_temp, library) = adopted();
        let client = fake.client();
        pass(&library, &client);
        fake.take();
        // A live watcher for this endpoint holds the same (current) document.
        let status = client.sync_status("client-token").unwrap();
        fake.take();
        let endpoint = client.base().to_owned();
        crate::cloud::status_watch::observe(
            &endpoint,
            &status,
            crate::cloud::status_watch::unix_now(),
            crate::cloud::status_watch::Source::Watcher,
        );
        crate::cloud::status_watch::set_live(&endpoint, 9001, true);
        for _ in 0..3 {
            let outcome = pass(&library, &client);
            assert!(outcome.live && !outcome.changed(), "{outcome:?}");
            // No request at all: the idle pass costs nothing while the watcher is live.
            assert_eq!(fake.take(), Vec::new());
        }
        // A watched change is picked up from the document, reading only the moved feed.
        fake.cursors.lock().unwrap().albums = 6;
        let moved = client.sync_status("client-token").unwrap();
        fake.take();
        crate::cloud::status_watch::observe(
            &endpoint,
            &moved,
            crate::cloud::status_watch::unix_now(),
            crate::cloud::status_watch::Source::Watcher,
        );
        pass(&library, &client);
        assert_eq!(feeds(&fake.take()), vec!["/v1/albums/changes"]);
        crate::cloud::status_watch::set_live(&endpoint, 9001, false);
        pass(&library, &client);
        assert_eq!(fake.take()[0].path, "/v1/sync/status");
    }

    #[test]
    fn a_server_without_etags_still_skips_unchanged_feeds() {
        let fake = Fake::start(false);
        let (_temp, library) = adopted();
        let client = fake.client();
        for _ in 0..2 {
            assert!(!pass(&library, &client).changed());
            assert_eq!(fake.take(), status_reads(false));
        }
    }

    #[test]
    fn a_moved_cursor_fetches_only_that_domains_feed() {
        let fake = Fake::start(true);
        let (_temp, library) = adopted();
        let client = fake.client();
        pass(&library, &client);
        fake.take();
        fake.cursors.lock().unwrap().albums = 6;
        pass(&library, &client);
        let seen = fake.take();
        assert_eq!(feeds(&seen), vec!["/v1/albums/changes"], "{seen:?}");
        // The moved status is a new document: read in full, then conditional again.
        assert_eq!(
            seen[0],
            Seen {
                path: "/v1/sync/status".into(),
                if_none_match: true
            }
        );
        fake.cursors.lock().unwrap().bookmarks = 10;
        pass(&library, &client);
        let seen = fake.take();
        // The Album feed answered with no rows, so its cursor is still behind and read again.
        assert_eq!(
            feeds(&seen),
            vec!["/v1/albums/changes", "/v1/mobile-catalog/bookmarks/changes"],
            "{seen:?}"
        );
        {
            let mut cursors = fake.cursors.lock().unwrap();
            cursors.albums = 5;
            cursors.bookmarks = 9;
            cursors.classifications = 8;
            cursors.assets = 4;
        }
        pass(&library, &client);
        let seen = fake.take();
        assert_eq!(
            feeds(&seen),
            vec![
                "/v1/classifications/authority/changes",
                "/v1/assets/authority/changes"
            ],
            "{seen:?}"
        );
    }

    #[test]
    fn explicit_reconciliation_still_validates_every_feed() {
        let fake = Fake::start(true);
        let (_temp, library) = adopted();
        let client = fake.client();
        pass(&library, &client);
        fake.take();
        library.reconcile_album_authority(&client, TOKEN).unwrap();
        library
            .reconcile_classification_authority(&client, TOKEN)
            .unwrap();
        library
            .reconcile_catalog_bookmarks_with(&client, TOKEN)
            .unwrap();
        library
            .sync_assets_with(&client, TOKEN, Some("publisher-token"), false)
            .unwrap();
        let seen = fake.take();
        assert_eq!(
            feeds(&seen),
            vec![
                "/v1/albums/changes",
                "/v1/classifications/authority/changes",
                "/v1/mobile-catalog/bookmarks/changes",
                "/v1/assets/authority/changes",
            ],
            "{seen:?}"
        );
        // Explicit reads never depend on the poll's ETag cache.
        assert!(seen.iter().all(|s| !s.if_none_match), "{seen:?}");
    }

    #[test]
    fn conditional_reads_are_scoped_to_the_credential() {
        let fake = Fake::start(true);
        let client = fake.client();
        client.sync_status_conditional(TOKEN).unwrap();
        let cached = client.sync_status_conditional(TOKEN).unwrap();
        // Another account on the same endpoint never presents the first one's tag, and
        // replaces that account's entries.
        assert_eq!(
            client.sync_status_conditional("other-account").unwrap(),
            cached
        );
        client.sync_status_conditional(TOKEN).unwrap();
        let seen: Vec<bool> = fake.take().into_iter().map(|s| s.if_none_match).collect();
        assert_eq!(seen, vec![false, true, false, false]);
    }

    #[test]
    fn sync_health_reports_pending_and_parked_materialization_failures_only() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        {
            let db = library.connection().unwrap();
            for (id, lifecycle, state, error) in [
                ("retry", "normal", "pending", Some(r#"{"code":"materializationRetry"}"#)),
                ("parked", "normal", "conflict", Some(r#"{"code":"identityOrIntegrityConflict"}"#)),
                ("done", "normal", "complete", Some(r#"{"code":"materializationRetry"}"#)),
                ("trash", "trash", "pending", Some(r#"{"code":"materializationRetry"}"#)),
                ("clean", "normal", "pending", None),
                ("rejected", "normal", "pending", Some("lifecycleRejected:operationConflict")),
            ] {
                db.execute("INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection,materialization,last_error) VALUES(?1,?2,1,'{}',?3,?4)",
                    rusqlite::params![id, lifecycle, state, error]).unwrap();
            }
        }
        let health = library.authority_sync_health().unwrap();
        assert_eq!(health.assets.materialization_failures, 2);
        assert_eq!(health.assets.rejected_count, 1);
    }

    #[test]
    fn sync_health_counts_blocked_waiting_dropped_and_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        assert_eq!(
            library.authority_sync_health().unwrap(),
            AuthoritySyncHealth::default()
        );
        let db = library.connection().unwrap();
        for (seq, state) in [(1, "blocked"), (2, "blocked"), (3, "pending")] {
            db.execute(
                "INSERT INTO album_authority_outbox(operation_id,command_type,album_id,epoch,payload,state,created_at)
                 VALUES(?1,'renameAlbum','album-1',1,'{}',?2,'2026-09-25T00:00:00Z')",
                rusqlite::params![format!("op-{seq}"), state],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO authority_intent_drops VALUES('classifications',3,'assetDeleted','op-9','2026-09-25T01:00:00Z')",
            [],
        )
        .unwrap();
        for (id, error) in [
            ("a1", Some("lifecycleRejected:assetTombstoned")),
            ("a2", Some("lifecycleRejected:assetTombstoned")),
            ("a3", Some("lifecycleRejected:operationConflict")),
            ("a4", None),
        ] {
            db.execute(
                "INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection,last_error)
                 VALUES(?1,'normal',1,'{}',?2)",
                rusqlite::params![id, error],
            )
            .unwrap();
        }
        drop(db);
        let health = library.authority_sync_health().unwrap();
        assert_eq!(health.albums.blocked_count, 2);
        assert_eq!(health.albums.dropped_count, 0);
        assert_eq!(health.classifications.blocked_count, 0);
        assert_eq!(health.classifications.dropped_count, 3);
        assert_eq!(
            health.classifications.last_drop_reason.as_deref(),
            Some("assetDeleted")
        );
        assert_eq!(
            health.classifications.last_dropped_at.as_deref(),
            Some("2026-09-25T01:00:00Z")
        );
        assert_eq!(health.assets.rejected_count, 3);
        assert_eq!(health.assets.rejected_assets.len(), 3);
        assert_eq!(health.assets.rejected_assets[0], AssetIntentRejection {
            asset_id: "a1".into(), name: "a1".into(), reason: "assetTombstoned".into(),
        });
        assert_eq!(health.assets.rejected_assets[2].reason, "operationConflict");
        assert_eq!(
            health.assets.rejected_reason.as_deref(),
            Some("assetTombstoned")
        );
        assert!(!health.assets.stopped);
        assert!(health.authority_pass_failure.is_none());
    }

    #[test]
    fn a_failing_lane_keeps_its_first_failure_code() {
        let mut outcome = AuthorityPassOutcome::default();
        outcome.failed(&LibraryError::CredentialStoreLocked);
        outcome.failed(&LibraryError::CloudUnauthorized);
        assert_eq!(outcome.failure, Some("credential_store_locked"));
        assert!(outcome.unauthorized);
    }

    #[test]
    fn backoff_steps_to_a_minute_and_returns_on_change_or_wake() {
        let t0 = Instant::now();
        let mut schedule = AuthoritySchedule::new(t0);
        assert!(schedule.due(t0));
        let mut delays = Vec::new();
        for _ in 0..5 {
            schedule.begin();
            delays.push(schedule.finished(false, false, false, t0).as_secs());
        }
        assert_eq!(delays, vec![15, 30, 60, 60, 60]);
        assert!(!schedule.due(t0 + Duration::from_secs(59)));
        assert!(schedule.due(t0 + Duration::from_secs(60)));
        schedule.begin();
        assert_eq!(schedule.finished(true, false, false, t0), Duration::from_secs(5));
        schedule.begin();
        assert_eq!(schedule.finished(false, false, false, t0), Duration::from_secs(15));
        // A local write or focus runs now and resets the backoff.
        schedule.wake(t0);
        assert!(schedule.due(t0));
        schedule.begin();
        assert!(!schedule.due(t0), "single flight");
        assert_eq!(schedule.finished(false, false, false, t0), Duration::from_secs(15));
        // A wake that lands mid-pass is owed, not lost.
        schedule.begin();
        schedule.wake(t0);
        assert_eq!(schedule.finished(false, false, false, t0), Duration::ZERO);
        assert!(schedule.due(t0));
        // An Asset-lane change outside a pass returns to the fast interval.
        schedule.begin();
        assert_eq!(schedule.finished(false, false, false, t0), Duration::from_secs(15));
        schedule.changed_elsewhere(t0);
        assert!(!schedule.due(t0 + Duration::from_secs(4)));
        assert!(schedule.due(t0 + Duration::from_secs(5)));
        // Lightweight mode keeps at least the old 20 s Asset spacing.
        schedule.begin();
        assert_eq!(schedule.finished(true, true, false, t0), RESTRICTED_FLOOR);
        // A live watcher wakes the pass on any change: an unchanged pass rests five
        // minutes, a changed one still follows up after five seconds.
        schedule.begin();
        assert_eq!(schedule.finished(false, false, true, t0), LIVE_IDLE);
        schedule.begin();
        assert_eq!(schedule.finished(true, false, true, t0), Duration::from_secs(5));
    }
    #[test]
    fn held_authority_pass_receives_bookmarks_and_pins_without_sending_pending_intents() {
        let (temp, library) = adopted();
        let endpoint = "http://127.0.0.1";
        library.use_machine_settings(temp.path().join("machine.json"));
        library.set_cloud_sync_hold(endpoint, true).unwrap();
        library
            .add_manga_index_pin(super::super::manga_index::MangaIndexIdentity {
                kind: "tag".into(),
                namespace: "female".into(),
                value: "local".into(),
                label: "Local".into(),
            })
            .unwrap();
        library.connection().unwrap().execute_batch("INSERT INTO catalog_bookmark_outbox(operation_id,provider,work_id,desired_state,epoch,base_revision,created_at) VALUES('local-bookmark','khentai','remote',0,1,0,'now');").unwrap();
        let pin_before: String = library
            .connection()
            .unwrap()
            .query_row("SELECT operation_id FROM manga_index_pin_outbox", [], |r| {
                r.get(0)
            })
            .unwrap();
        let domain = |name, cursor| json!({"domain":name,"libraryId":LIB,"epoch":1,"contractVersion":1,"cursor":cursor});
        let (client, requests) = CloudClient::home_test_client(vec![
            json!({"protocolVersion":1,"active":true,"libraryId":LIB,"domains":[domain("assets",3),domain("albums",5),domain("classifications",7),domain("catalog-bookmarks",10),domain("manga-index-pins",1)]}),
            json!({"libraryId":LIB,"epoch":1,"contractVersion":1,"cursor":10,"nextAfter":10,"hasMore":false,"items":[{"sequence":10,"provider":"khentai","workId":"remote","desiredState":true,"entityRevision":1,"createdAt":"2026-10-04T00:00:00Z"}]}),
            json!({"libraryId":LIB,"epoch":1,"contractVersion":1,"revision":1,"items":[]}),
        ]);
        let credentials = FixedCredentials {
            client_token: TOKEN,
            publisher_token: "publisher",
        };
        let (outcome, _) = library.authority_pass_with(&client, TOKEN, &credentials);
        assert_eq!(outcome.failure, None, "{outcome:?}");
        assert!(outcome.bookmarks && !outcome.sent);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT cursor FROM catalog_bookmark_sync", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM online_catalog_bookmarks WHERE work_id='remote'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0,
            "pending removal overlays received bookmark"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM catalog_bookmark_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT operation_id FROM manga_index_pin_outbox", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            pin_before
        );
        drop(db);
        assert_eq!(library.list_manga_index_pins().unwrap().len(), 1);
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|r| r.starts_with(b"GET ")));
    }

    #[test]
    fn held_asset_baseline_marks_relation_lanes_waiting_without_failure() {
        let (temp, library) = adopted();
        let endpoint = "http://127.0.0.1";
        library.use_machine_settings(temp.path().join("machine.json"));
        library.set_cloud_sync_hold(endpoint, true).unwrap();
        library.connection().unwrap().execute("INSERT INTO asset_lifecycle_outbox(operation_id,library_id,epoch,contract_version,asset_id,desired,expected_revision,created_at) VALUES('queued',?1,1,1,'a','trash',1,'now')", [LIB]).unwrap();
        let domain = |name, epoch, cursor| json!({"domain":name,"libraryId":LIB,"epoch":epoch,"contractVersion":1,"cursor":cursor});
        let (client, requests) = CloudClient::home_test_client(vec![
            json!({"protocolVersion":1,"active":true,"libraryId":LIB,"domains":[domain("assets",2,0),domain("albums",1,5),domain("classifications",1,7),domain("catalog-bookmarks",1,9)]}),
        ]);
        let credentials = FixedCredentials {
            client_token: TOKEN,
            publisher_token: "publisher",
        };
        let (outcome, status) = library.authority_pass_with(&client, TOKEN, &credentials);
        assert!(outcome.held);
        assert_eq!(outcome.failure, None);
        assert!(!outcome.albums && !outcome.classifications && !outcome.sent);
        let assets = library
            .asset_lane_with(&client, TOKEN, None, false, &status.unwrap())
            .unwrap();
        assert!(assets.held && !assets.stopped);
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}
