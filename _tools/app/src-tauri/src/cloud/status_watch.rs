//! One shared view of `/v1/sync/status` for every idle poller on this PC.
//!
//! Design: `docs/research/perf-all-longpoll-design-20260926.md` §3 (D1 fold, D2 long-poll).
//!
//! * The **hub** keeps, per endpoint, the latest status document this process read (by the
//!   coordinated authority pass or by the watcher), when the server last confirmed it, and
//!   whether a watcher is currently holding long-polls for it. A change raises wake flags the
//!   native owner loop (`workload.rs`) consumes: the authority pass, the publication lanes and
//!   the capture poll.
//! * [`log_due`] is the one rule every publication lane uses to decide whether its log is worth
//!   reading: the log's head (from `publisherLogs`) moved past the lane's cursor, or the
//!   30-minute safety interval passed. Without a trusted head it is the old 60-second cadence.
//! * The **watcher** holds `GET /v1/sync/status?wait=50` on its own thread and agent; the
//!   pure [`WatchState`] decides what it does after each answer.
//!
//! Every head is a wake-up hint, never a correctness cursor (ADR-0037): each lane still
//! validates its own log, and a missed hint costs at most the safety interval.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use super::client::{BindingsHead, CloudClient, PublisherLogs, StatusWatchReply, SyncStatus};
use crate::library::credential::{self, CredentialTarget};
use crate::library::error::LibraryError;
use crate::library::Library;

/// A lane without a trusted head reads its log at most this often (the pre-fold cadence).
pub(crate) const LEGACY_INTERVAL: i64 = 60;
/// A lane whose head says nothing moved still reads its log this often.
pub(crate) const SAFETY_INTERVAL: i64 = 30 * 60;
/// A status document older than this (not re-confirmed by a read or a watcher `304`) no
/// longer vouches for its heads. Above the 60 s idle pass and the 50 s watcher cycle.
const TRUST_WINDOW: i64 = 180;

static PUBLICATION_WAKE: AtomicBool = AtomicBool::new(false);
static AUTHORITY_WAKE: AtomicBool = AtomicBool::new(false);
static CAPTURES_SIGNAL: AtomicBool = AtomicBool::new(false);

/// A publisher log head moved: the publication lanes should run now instead of on their
/// next 10 s tick.
pub(crate) fn take_publication_wake() -> bool {
    PUBLICATION_WAKE.swap(false, Ordering::AcqRel)
}

/// Ask for the publication lanes on the next owner-loop tick.
pub(crate) fn wake_publications() {
    PUBLICATION_WAKE.store(true, Ordering::Release);
}

/// The watcher saw the authority domains move, or its liveness changed: run a pass now.
pub(crate) fn take_authority_wake() -> bool {
    AUTHORITY_WAKE.swap(false, Ordering::AcqRel)
}

/// The capture inbox head or the signal liveness changed: `cloud://captures-pending`.
pub(crate) fn take_captures_signal() -> bool {
    CAPTURES_SIGNAL.swap(false, Ordering::AcqRel)
}

pub(crate) fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The hub key: the endpoint as `CloudClient` normalizes it, so the lanes (which hold the
/// configured string) and the pass (which holds the parsed client) agree.
pub(crate) fn endpoint_key(endpoint: &str) -> String {
    url::Url::parse(endpoint.trim())
        .map(|url| url.to_string())
        .unwrap_or_else(|_| endpoint.trim().to_owned())
}

/// The publisher logs a lane can gate on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum LogKind {
    CharacterExclusions,
    CharacterReviewDecisions,
    SimilarityDecisions,
    CatalogDuplicateDecisions,
    ReleaseReads,
    Bindings,
    PersonalEdits,
}

/// What a lane knows about its own place in a log. `cursor: None` means the lane has not
/// adopted the log yet, so a head cannot tell whether adoption is due.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct LogPosition<'a> {
    pub cursor: Option<i64>,
    /// The bindings log's `logEpoch` the cursor belongs to.
    pub epoch: Option<&'a str>,
}

impl LogPosition<'_> {
    pub(crate) fn cursor(cursor: Option<i64>) -> Self {
        Self {
            cursor,
            epoch: None,
        }
    }
}

/// One log's head as `publisherLogs` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Head {
    Sequence(i64),
    Reads { last: i64, pruned_through: i64 },
    Bindings(BindingsHead),
}

impl Head {
    fn of(kind: LogKind, logs: &PublisherLogs) -> Option<Self> {
        Some(match kind {
            LogKind::CharacterExclusions => Self::Sequence(logs.character_exclusions?),
            LogKind::CharacterReviewDecisions => Self::Sequence(logs.character_review_decisions?),
            LogKind::SimilarityDecisions => Self::Sequence(logs.similarity_decisions?),
            LogKind::CatalogDuplicateDecisions => Self::Sequence(logs.catalog_duplicate_decisions?),
            LogKind::PersonalEdits => Self::Sequence(logs.personal_edits?),
            LogKind::ReleaseReads => {
                let head = logs.release_reads?;
                Self::Reads {
                    last: head.last,
                    pruned_through: head.pruned_through,
                }
            }
            LogKind::Bindings => Self::Bindings(logs.bindings.clone()?),
        })
    }

    /// Whether reading the log could change anything for a lane at `position`. A cursor
    /// *ahead* of the head counts too: that is a restarted log the lane must re-read.
    fn moved(&self, position: LogPosition) -> bool {
        let Some(cursor) = position.cursor else {
            return true;
        };
        match self {
            Self::Sequence(last) => *last != cursor,
            Self::Reads {
                last,
                pruned_through,
            } => *last != cursor || *pruned_through > cursor,
            Self::Bindings(head) => {
                let replaced = matches!((head.log_epoch.as_deref(), position.epoch),
                    (Some(server), Some(local)) if server != local);
                replaced
                    || head.last != cursor
                    || head.oldest_pending.is_some_and(|oldest| oldest <= cursor)
            }
        }
    }
}

/// The pure due rule behind [`log_due`].
///
/// * never checked: due;
/// * a `last_checked` in the future is a backoff the lane recorded: not due;
/// * no trusted head, or a lane that has not adopted the log: the legacy 60 s cadence;
/// * the head moved past the cursor: due at once when this head was not already acted on,
///   otherwise (a lane that could not catch up) the legacy cadence, so a head that never
///   matches degrades to the old behavior instead of a hot loop;
/// * nothing moved: the 30-minute safety interval.
pub(crate) fn decide(
    head: Option<&Head>,
    position: LogPosition,
    last_checked: Option<i64>,
    checked_head: Option<&Head>,
    now: i64,
) -> bool {
    let elapsed = match last_checked {
        None => return true,
        Some(last) if last > now => return false,
        Some(last) => now - last,
    };
    let Some(head) = head.filter(|_| position.cursor.is_some()) else {
        return elapsed >= LEGACY_INTERVAL;
    };
    if head.moved(position) {
        checked_head != Some(head) || elapsed >= LEGACY_INTERVAL
    } else {
        elapsed >= SAFETY_INTERVAL
    }
}

/// What a newly observed document changed compared with the previous one.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Changes {
    pub domains: bool,
    pub logs: bool,
    pub captures: bool,
}

fn diff(previous: Option<&SyncStatus>, next: &SyncStatus) -> Changes {
    let Some(previous) = previous else {
        return Changes {
            domains: true,
            logs: true,
            captures: true,
        };
    };
    let without_captures = |status: &SyncStatus| {
        status.publisher_logs.clone().map(|mut logs| {
            logs.captures = None;
            logs
        })
    };
    let captures = |status: &SyncStatus| {
        status
            .publisher_logs
            .as_ref()
            .and_then(|logs| logs.captures)
    };
    Changes {
        domains: previous.active != next.active
            || previous.library_id != next.library_id
            || previous.domains != next.domains,
        logs: without_captures(previous) != without_captures(next),
        captures: captures(previous) != captures(next),
    }
}

/// Who read a document. The pass is already running when it reads one, so its reads never
/// wake the pass again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Pass,
    Watcher,
}

#[derive(Default)]
struct Entry {
    status: Option<SyncStatus>,
    confirmed_at: i64,
    revision: u64,
    /// The watcher currently holding long-polls for this endpoint, if any.
    live_owner: Option<u64>,
    /// Per log: the head at, and the time of, the last "due" answer.
    checked: HashMap<LogKind, (Option<Head>, i64)>,
    /// Digest of a publisher credential this endpoint refused for the status read.
    rejected_publisher: Option<String>,
}

impl Entry {
    fn trusted_logs(&self, now: i64) -> Option<&PublisherLogs> {
        if now - self.confirmed_at > TRUST_WINDOW {
            return None;
        }
        self.status.as_ref()?.publisher_logs.as_ref()
    }
}

fn hub() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    static HUB: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    HUB.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record a document read from `endpoint` and raise the wakes its changes call for.
pub(crate) fn observe(endpoint: &str, status: &SyncStatus, now: i64, source: Source) -> Changes {
    observe_if_current(endpoint, status, now, source, None).0
}

fn observe_if_current(
    endpoint: &str,
    status: &SyncStatus,
    now: i64,
    source: Source,
    revision: Option<u64>,
) -> (Changes, SyncStatus) {
    let changes = {
        let mut hub = hub();
        let entry = hub.entry(endpoint_key(endpoint)).or_default();
        // A response from a pass started before a newer observation must not roll the hub
        // back, even if that response finished later. Compare and publish under one lock.
        if revision.is_some_and(|revision| revision != entry.revision) {
            return (
                Changes::default(),
                entry.status.clone().unwrap_or_else(|| status.clone()),
            );
        }
        let changes = diff(entry.status.as_ref(), status);
        entry.revision += 1;
        entry.status = Some(status.clone());
        entry.confirmed_at = now;
        changes
    };
    if changes.domains && source == Source::Watcher {
        AUTHORITY_WAKE.store(true, Ordering::Release);
    }
    if changes.logs {
        PUBLICATION_WAKE.store(true, Ordering::Release);
    }
    if changes.captures {
        CAPTURES_SIGNAL.store(true, Ordering::Release);
    }
    (changes, status.clone())
}

/// Revision before a pass starts its status request.
fn status_revision(endpoint: &str) -> u64 {
    hub().entry(endpoint_key(endpoint)).or_default().revision
}

fn observe_pass(endpoint: &str, status: &SyncStatus, now: i64, revision: u64) -> SyncStatus {
    observe_if_current(endpoint, status, now, Source::Pass, Some(revision)).1
}

/// The validator and document belong to the same credential variant.
struct WatchDocument {
    scope: String,
    etag: String,
    status: SyncStatus,
}

impl WatchDocument {
    fn confirm(&self, endpoint: &str, now: i64) {
        // A 304 confirms this ETag's document, never whichever document a pass left in the hub.
        observe(endpoint, &self.status, now, Source::Watcher);
    }
}

/// Mark whether watcher `owner` is live for `endpoint`. Only the owner may clear it, so a
/// stopping watcher never clears its successor's liveness.
pub(crate) fn set_live(endpoint: &str, owner: u64, live: bool) {
    let changed = {
        let mut hub = hub();
        let entry = hub.entry(endpoint_key(endpoint)).or_default();
        let was = entry.live_owner.is_some();
        if live {
            entry.live_owner = Some(owner);
        } else if entry.live_owner == Some(owner) {
            entry.live_owner = None;
        }
        was != entry.live_owner.is_some()
    };
    if changed {
        // Gaining a watcher lets the pass relax to its long idle delay; losing one must bring
        // the pass (and the capture poll) back to their own cadence right away.
        AUTHORITY_WAKE.store(true, Ordering::Release);
        CAPTURES_SIGNAL.store(true, Ordering::Release);
    }
}

/// Whether a watcher currently holds long-polls for `endpoint`.
pub(crate) fn is_live(endpoint: &str) -> bool {
    hub()
        .get(&endpoint_key(endpoint))
        .is_some_and(|entry| entry.live_owner.is_some())
}

/// The watcher's current document, when a live watcher vouches for it. The authority pass
/// uses it instead of reading the status itself.
pub(crate) fn live_status(endpoint: &str, now: i64) -> Option<SyncStatus> {
    let hub = hub();
    let entry = hub.get(&endpoint_key(endpoint))?;
    if entry.live_owner.is_none() || now - entry.confirmed_at > TRUST_WINDOW {
        return None;
    }
    entry.status.clone()
}

/// The capture inbox is empty and a live watcher will signal the next capture: the capture
/// poll may rest until `cloud://captures-pending`.
pub(crate) fn captures_quiet(endpoint: &str, now: i64) -> bool {
    let hub = hub();
    let Some(entry) = hub.get(&endpoint_key(endpoint)) else {
        return false;
    };
    entry.live_owner.is_some()
        && entry
            .trusted_logs(now)
            .and_then(|logs| logs.captures)
            .is_some_and(|captures| captures.pending == 0)
}

/// Whether a publication lane should read its log now (see [`decide`]). `last_checked` is
/// the lane's durable check time; `None` for a lane that keeps none, which then uses the
/// hub's own record of its last "due" answer. A "due" answer is recorded with the head it
/// was given, so the same head does not make the lane due again before the legacy cadence.
pub(crate) fn log_due(
    endpoint: &str,
    kind: LogKind,
    position: LogPosition,
    last_checked: Option<i64>,
    now: i64,
) -> bool {
    let mut hub = hub();
    let entry = hub.entry(endpoint_key(endpoint)).or_default();
    let head = entry
        .trusted_logs(now)
        .and_then(|logs| Head::of(kind, logs));
    let (checked_head, checked_at) = match entry.checked.get(&kind) {
        Some((head, at)) => (head.clone(), Some(*at)),
        None => (None, None),
    };
    let due = decide(
        head.as_ref(),
        position,
        last_checked.or(checked_at),
        checked_head.as_ref(),
        now,
    );
    if due {
        entry.checked.insert(kind, (head, now));
    }
    due
}

fn credential_digest(token: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(token.trim().as_bytes())
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether the status may be read with this publisher credential (it was not refused here).
fn publisher_usable(endpoint: &str, token: &str) -> bool {
    let digest = credential_digest(token);
    hub()
        .get(&endpoint_key(endpoint))
        .is_none_or(|entry| entry.rejected_publisher.as_deref() != Some(digest.as_str()))
}

/// The endpoint refused this publisher credential: stop presenting it for the status read
/// (a replaced credential is tried again) and drop the cached copy so the store is re-read.
fn publisher_rejected(endpoint: &str, token: &str) {
    hub()
        .entry(endpoint_key(endpoint))
        .or_default()
        .rejected_publisher = Some(credential_digest(token));
    crate::library::credential_broker::broker().invalidate(CredentialTarget::CloudPublisher);
}

/// The authority pass's status read: with the publisher credential when one is configured
/// (that variant carries `publisherLogs`), falling back to the client credential when the
/// server refuses it. The client credential's own refusal is returned as is, so the caller
/// invalidates that one. A successful read feeds the hub.
pub(crate) fn read_status(
    client: &CloudClient,
    client_token: &str,
    publisher: Option<&str>,
) -> Result<SyncStatus, LibraryError> {
    let endpoint = client.base();
    let revision = status_revision(endpoint);
    let mut result = None;
    if let Some(publisher) = publisher.filter(|token| publisher_usable(endpoint, token)) {
        match client.sync_status_conditional(publisher) {
            Err(LibraryError::CloudUnauthorized) => publisher_rejected(endpoint, publisher),
            other => result = Some(other),
        }
    }
    let status = match result {
        Some(result) => result?,
        None => client.sync_status_conditional(client_token)?,
    };
    Ok(observe_pass(endpoint, &status, unix_now(), revision))
}

// --- The watcher ------------------------------------------------------------------------

/// The longest hold this client asks for (the server clamps to its own maximum too).
pub(crate) const MAX_WAIT: u64 = 50;
/// The held request's response deadline is the wait plus this.
const RECV_SLACK: u64 = 20;
/// Pause after a transport or server failure, by consecutive failure count.
const ERROR_BACKOFF: [u64; 3] = [5, 15, 60];
/// Pause after a `304` the server did not hold (for example over its waiter cap).
const HOT_LOOP_BACKOFF: [u64; 3] = [5, 15, 60];
/// A server without long-poll is asked again this often, in case it was upgraded.
const REPROBE: Duration = Duration::from_secs(30 * 60);
/// Spacing after a `200`, so a document that keeps changing cannot drive a tight loop.
const CHANGE_SPACING: Duration = Duration::from_secs(1);
/// Upper bound of the random pause before re-issuing after a held `304`.
const REISSUE_JITTER: Duration = Duration::from_secs(2);
/// A request that overran its own deadline by this much means the machine slept.
const SLEEP_THRESHOLD: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// No answer yet.
    Probing,
    /// The server holds requests (`Lakomics-Status-Wait` seen).
    Live,
    /// The server answered without the header: no long-poll; re-probe later.
    Dormant,
}

/// One answer, as the watcher state machine needs it.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Outcome {
    Changed {
        advertised: Option<u64>,
    },
    NotModified {
        advertised: Option<u64>,
        held: Duration,
    },
    Failed {
        slept: bool,
    },
}

/// The watcher's pure state: which request to send next and how long to pause first.
#[derive(Debug, Clone)]
pub(crate) struct WatchState {
    mode: Mode,
    wait: u64,
    failures: usize,
    quick: usize,
}

impl WatchState {
    pub(crate) fn new() -> Self {
        Self {
            mode: Mode::Probing,
            wait: MAX_WAIT,
            failures: 0,
            quick: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn mode(&self) -> Mode {
        self.mode
    }

    /// The `?wait=` to send. An older server ignores it, which is how it is detected.
    pub(crate) fn wait(&self) -> u64 {
        self.wait
    }

    /// The watcher vouches for the hub's document: long-poll works and the last request
    /// succeeded.
    pub(crate) fn live(&self) -> bool {
        self.mode == Mode::Live && self.failures == 0
    }

    /// Record one answer; returns the pause before the next request. `jitter` is in `0..1`.
    pub(crate) fn next(&mut self, outcome: Outcome, jitter: f64) -> Duration {
        let jitter = jitter.clamp(0.0, 1.0);
        let advertised = match outcome {
            Outcome::Failed { slept: true } => return CHANGE_SPACING,
            Outcome::Failed { slept: false } => {
                self.failures += 1;
                let step = ERROR_BACKOFF[(self.failures - 1).min(ERROR_BACKOFF.len() - 1)];
                return Duration::from_secs(step).mul_f64(1.0 + jitter / 2.0);
            }
            Outcome::Changed { advertised } | Outcome::NotModified { advertised, .. } => advertised,
        };
        self.failures = 0;
        let Some(advertised) = advertised else {
            self.mode = Mode::Dormant;
            self.quick = 0;
            return REPROBE;
        };
        self.mode = Mode::Live;
        self.wait = advertised.clamp(1, MAX_WAIT);
        match outcome {
            Outcome::NotModified { held, .. } if held < Duration::from_secs(self.wait) / 2 => {
                // Answered without being held: the server is over its waiter cap (or a proxy
                // is not holding). Re-issuing at once would be a hot loop.
                self.quick += 1;
                Duration::from_secs(
                    HOT_LOOP_BACKOFF[(self.quick - 1).min(HOT_LOOP_BACKOFF.len() - 1)],
                )
            }
            Outcome::NotModified { .. } => {
                self.quick = 0;
                REISSUE_JITTER.mul_f64(jitter)
            }
            _ => {
                self.quick = 0;
                CHANGE_SPACING
            }
        }
    }
}

/// The credentials a watcher request may use.
pub(crate) struct Tokens {
    pub client: Option<String>,
    pub publisher: Option<String>,
}

fn os_tokens() -> Tokens {
    Tokens {
        client: credential::read_cloud_api_token_os()
            .ok()
            .map(|token| token.expose().to_owned()),
        publisher: credential::read_cloud_publisher_token_os()
            .ok()
            .map(|token| token.expose().to_owned()),
    }
}

fn jitter() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or(0);
    f64::from(nanos % 1000) / 1000.0
}

/// Pause for `delay` in short slices; true when `stop` was raised meanwhile.
fn pause(delay: Duration, stop: &AtomicBool) -> bool {
    let deadline = Instant::now() + delay;
    loop {
        if stop.load(Ordering::Acquire) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(250)));
    }
}

/// The watcher loop for one endpoint, until `stop`. `tokens` is read before every request
/// so a replaced credential takes effect on the next one.
pub(crate) fn watch(endpoint: &str, owner: u64, stop: &AtomicBool, tokens: &dyn Fn() -> Tokens) {
    let Ok(client) =
        CloudClient::for_status_watch(endpoint, Duration::from_secs(MAX_WAIT + RECV_SLACK))
    else {
        return;
    };
    let mut state = WatchState::new();
    // The ETag belongs to the credential variant that received it.
    let mut document: Option<WatchDocument> = None;
    while !stop.load(Ordering::Acquire) {
        let Tokens {
            client: api,
            publisher,
        } = tokens();
        let publisher = publisher.filter(|token| publisher_usable(endpoint, token));
        let (token, is_publisher) = match (publisher, api) {
            (Some(token), _) => (token, true),
            (None, Some(token)) => (token, false),
            (None, None) => {
                set_live(endpoint, owner, false);
                if pause(Duration::from_secs(60), stop) {
                    break;
                }
                continue;
            }
        };
        let scope = credential_digest(&token);
        let tag = document
            .as_ref()
            .filter(|document| document.scope == scope)
            .map(|document| document.etag.as_str());
        let started = Instant::now();
        let wall = SystemTime::now();
        let reply = client.watch_sync_status(&token, tag, state.wait());
        let held = started.elapsed();
        if stop.load(Ordering::Acquire) {
            break;
        }
        let now = unix_now();
        let outcome = match reply {
            Ok(StatusWatchReply::Changed {
                status,
                etag: tag,
                advertised,
            }) => {
                document = tag.map(|etag| WatchDocument {
                    scope: scope.clone(),
                    etag,
                    status: status.clone(),
                });
                observe(endpoint, &status, now, Source::Watcher);
                Outcome::Changed { advertised }
            }
            Ok(StatusWatchReply::NotModified { advertised }) => {
                if let Some(document) = document
                    .as_ref()
                    .filter(|document| document.scope == scope)
                {
                    document.confirm(endpoint, now);
                    Outcome::NotModified { advertised, held }
                } else {
                    // An unsolicited 304 cannot vouch for a document we never received.
                    document = None;
                    Outcome::Failed { slept: false }
                }
            }
            Err(LibraryError::CloudUnauthorized) if is_publisher => {
                // Fall back to the client credential at once; this one is not tried again.
                publisher_rejected(endpoint, &token);
                continue;
            }
            Err(error) => {
                if matches!(error, LibraryError::CloudUnauthorized) {
                    crate::library::credential_broker::broker()
                        .invalidate(CredentialTarget::CloudApi);
                }
                // A held request across a laptop sleep overruns its own deadline; the network
                // is usually back a moment later, so retry promptly and refresh the pass.
                let wall_elapsed = wall.elapsed().unwrap_or_default();
                let deadline = Duration::from_secs(state.wait() + RECV_SLACK);
                let slept =
                    wall_elapsed > held + SLEEP_THRESHOLD || held > deadline + SLEEP_THRESHOLD;
                if slept {
                    AUTHORITY_WAKE.store(true, Ordering::Release);
                }
                Outcome::Failed { slept }
            }
        };
        let delay = state.next(outcome, jitter());
        set_live(endpoint, owner, state.live());
        if pause(delay, stop) {
            break;
        }
    }
    set_live(endpoint, owner, false);
}

struct Running {
    root: PathBuf,
    endpoint: String,
    owner: u64,
    stop: Arc<AtomicBool>,
}

/// Starts and stops the watcher from the native owner loop: one watcher for the open
/// library's configured endpoint while cloud sync is enabled; none otherwise. The watcher is
/// the cheap path, so lightweight mode keeps it.
#[derive(Default)]
pub(crate) struct Supervisor {
    running: Option<Running>,
    seen_root: Option<PathBuf>,
    checked: Option<Instant>,
}

/// How often the supervisor re-reads the cloud configuration.
const SUPERVISOR_RECHECK: Duration = Duration::from_secs(10);

impl Supervisor {
    pub(crate) fn tick(&mut self, library: Option<&Library>, now: Instant) {
        let Some(library) = library else {
            self.stop();
            self.seen_root = None;
            return;
        };
        let switched = self.seen_root.as_deref() != Some(library.root());
        if !switched
            && self
                .checked
                .is_some_and(|at| now.duration_since(at) < SUPERVISOR_RECHECK)
        {
            return;
        }
        self.seen_root = Some(library.root().to_path_buf());
        self.checked = Some(now);
        let desired = library
            .cloud_sync_config()
            .ok()
            .filter(|config| config.enabled)
            .and_then(|config| config.api_base_url)
            .filter(|endpoint| !endpoint.trim().is_empty());
        let Some(endpoint) = desired else {
            self.stop();
            return;
        };
        if self
            .running
            .as_ref()
            .is_some_and(|running| running.root == library.root() && running.endpoint == endpoint)
        {
            return;
        }
        self.stop();
        static OWNERS: AtomicU64 = AtomicU64::new(1);
        let owner = OWNERS.fetch_add(1, Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_stop, thread_endpoint) = (stop.clone(), endpoint.clone());
        let spawned = std::thread::Builder::new()
            .name("status-watch".into())
            .spawn(move || watch(&thread_endpoint, owner, &thread_stop, &os_tokens));
        if spawned.is_ok() {
            self.running = Some(Running {
                root: library.root().to_path_buf(),
                endpoint,
                owner,
                stop,
            });
        }
    }

    fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.stop.store(true, Ordering::Release);
            // Not live from now on, even while its last held request drains.
            set_live(&running.endpoint, running.owner, false);
        }
    }
}

#[cfg(test)]
#[path = "status_watch_tests.rs"]
pub(crate) mod tests;
