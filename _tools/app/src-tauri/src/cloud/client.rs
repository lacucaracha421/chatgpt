use std::{fs::File, io::Read, time::Duration};

use super::models::{
    AcknowledgeCaptureRequest, ClassificationSnapshotPublish, PreparedAssetUpload,
    ExtensionPairingResponse, PresignUploadRequest, PresignUploadResponse, RegisterAssetRequest, RemoteCaptureDownloadTicket,
    RemoteCapturePage, RemoteCapturePayload, SavedXMediaSnapshotPublish,
};
use crate::library::error::LibraryError;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const METADATA_BACKUP_OBJECT_KEY: &str = "backups/library-metadata.sqlite";
const MAX_METADATA_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
const SHORT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(serde::Serialize)]
struct MediaTicketBatchRequest<'a> {
    items: Vec<MediaTicketBatchItem<'a>>,
}

#[derive(serde::Serialize)]
struct MediaTicketBatchItem<'a> {
    asset_id: &'a str,
    variant: &'a str,
}

#[derive(serde::Deserialize)]
struct MediaTicketBatchResponse {
    items: Vec<MediaTicketBatchResponseItem>,
}

#[derive(serde::Deserialize)]
struct MediaTicketBatchResponseItem {
    asset_id: String,
    variant: String,
    ok: bool,
    url: Option<String>,
    size_bytes: Option<u64>,
    error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct RestoreMediaTicket {
    pub asset_id: String,
    pub variant: String,
    pub url: Option<String>,
    pub size_bytes: Option<u64>,
    pub error: Option<String>,
}

/// Authority metadata from `/status`. All fields are `None` until the bookmark
/// domain stops being PC-owned, so "absent" is a normal state, not an error.
///
/// `bookmark_write` is the advertised capability, not the authority identity: a
/// server can hold an authority and still advertise writes as unsupported. B6
/// sends nothing unless that capability is true.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct MobileCatalogAuthority {
    pub library_id: Option<String>,
    pub epoch: Option<i64>,
    pub contract_version: Option<i64>,
    pub cursor: Option<i64>,
    pub bookmark_write: bool,
}

/// One materialized bookmark row from the authoritative snapshot.
///
/// The bookmark table itself stores presence only, but `entity_revision` is
/// carried into the local authority-revision cache: a B6 command must present the
/// revision its intent was composed against, and re-bookmarking a tombstone means
/// presenting *that tombstone's* revision. `updatedAt` is still not stored.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileCatalogBookmarkItem {
    pub provider: String,
    pub work_id: String,
    pub desired_state: bool,
    pub entity_revision: i64,
    pub created_at: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileCatalogBookmarkSnapshot {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub cursor: i64,
    pub items: Vec<MobileCatalogBookmarkItem>,
}

/// One ordered change-log row. `sequence` is validated for ordering;
/// `entity_revision` feeds the local authority-revision cache for the same reason
/// it does on a snapshot item.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileCatalogChange {
    pub sequence: i64,
    pub provider: String,
    pub work_id: String,
    pub desired_state: bool,
    pub entity_revision: i64,
    pub created_at: Option<String>,
}

/// One desired-state bookmark command: exactly the landed B4 payload shape, and
/// the whole payload this PC stores for an operation.
///
/// `operation_id` is minted once when the *local mutation* is accepted and is
/// reused verbatim on every transport retry, so the server's receipt resolves a
/// lost response instead of recording a second logical write.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileCatalogBookmarkCommand {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub operation_id: String,
    pub expected_revision: i64,
    pub desired_state: bool,
}

/// The server's recorded result for one command.
///
/// `changed` is false when the desired state was already authoritative: the
/// command is still accepted and receipted, so a retry stays idempotent and no
/// second logical write is manufactured.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileCatalogBookmarkCommandResult {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub provider: String,
    pub work_id: String,
    pub desired_state: bool,
    pub entity_revision: i64,
    pub changed: bool,
    pub created_at: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileCatalogBookmarkChanges {
    pub cursor: i64,
    pub items: Vec<MobileCatalogChange>,
    pub next_after: i64,
    pub has_more: bool,
}


#[derive(serde::Deserialize)]
struct MetadataBackupTicket {
    download_url: String,
    required_headers: std::collections::BTreeMap<String, String>,
    size_bytes: Option<u64>,
}

/// One active authority domain as reported by `GET /v1/sync/status`.
///
/// Per-domain epoch/cursor is the correctness contract; the aggregate response
/// only reports them so a client can decide which domain loops to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyncAuthorityDomain {
    pub domain: String,
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub cursor: i64,
}

/// Aggregate authority discovery. `active` is false while every shared domain is
/// still PC-owned, which is the expected state before a domain cut-over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyncStatus {
    pub protocol_version: i64,
    pub active: bool,
    pub library_id: Option<String>,
    pub domains: Vec<SyncAuthorityDomain>,
    /// `publisherLogs`, present only when the document was read with a publisher
    /// credential. A wake-up hint for the publication lanes, never a correctness cursor:
    /// it takes no part in [`Self::is_consistent`] or the restore guard, and a missing or
    /// malformed block (or head) only means "no trusted head" (see `cloud::status_watch`).
    pub publisher_logs: Option<PublisherLogs>,
}

/// `publisherLogs.releaseReads`: the read log's `lastSequence` and `prunedThrough`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReleaseReadsHead {
    pub last: i64,
    pub pruned_through: i64,
}

/// `publisherLogs.bindings`: the request log's `logEpoch`, `lastSequence` and
/// `oldestPendingSequence`, exactly as `GET …/bindings/log` reports them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindingsHead {
    pub log_epoch: Option<String>,
    pub last: i64,
    pub oldest_pending: Option<i64>,
}

/// `publisherLogs.captures`: the pending count and the newest capture's row number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CapturesHead {
    pub pending: i64,
    pub latest: Option<i64>,
}

/// The head of every log the publication lanes poll. Each head is parsed on its own:
/// one a future server renames or reshapes is `None` while the others stay usable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PublisherLogs {
    pub character_exclusions: Option<i64>,
    pub character_review_decisions: Option<i64>,
    pub similarity_decisions: Option<i64>,
    pub catalog_duplicate_decisions: Option<i64>,
    pub release_reads: Option<ReleaseReadsHead>,
    pub bindings: Option<BindingsHead>,
    pub personal_edits: Option<i64>,
    pub captures: Option<CapturesHead>,
}

impl PublisherLogs {
    /// Lenient parse of the `publisherLogs` value: never an error, only absent heads.
    pub(crate) fn parse(value: &serde_json::Value) -> Option<Self> {
        let block = value.as_object()?;
        let sequence = |value: Option<&serde_json::Value>| {
            value.and_then(serde_json::Value::as_i64).filter(|value| *value >= 0)
        };
        let head = |key: &str| sequence(block.get(key));
        let release_reads = block.get("releaseReads").and_then(|value| {
            Some(ReleaseReadsHead {
                last: sequence(value.get("last"))?,
                pruned_through: sequence(value.get("prunedThrough"))?,
            })
        });
        let bindings = block.get("bindings").and_then(|value| {
            let log_epoch = match value.get("logEpoch") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(epoch)) => Some(epoch.clone()),
                Some(_) => return None,
            };
            let oldest_pending = match value.get("oldestPending") {
                None | Some(serde_json::Value::Null) => None,
                other => Some(sequence(other)?),
            };
            Some(BindingsHead {
                log_epoch,
                last: sequence(value.get("last"))?,
                oldest_pending,
            })
        });
        let captures = block.get("captures").and_then(|value| {
            let latest = match value.get("latest") {
                None | Some(serde_json::Value::Null) => None,
                other => Some(sequence(other)?),
            };
            Some(CapturesHead {
                pending: sequence(value.get("pending"))?,
                latest,
            })
        });
        Some(Self {
            character_exclusions: head("characterExclusions"),
            character_review_decisions: head("characterReviewDecisions"),
            similarity_decisions: head("similarityDecisions"),
            catalog_duplicate_decisions: head("catalogDuplicateDecisions"),
            release_reads,
            bindings,
            personal_edits: head("personalEdits"),
            captures,
        })
    }
}

/// The server's domain name for catalog bookmarks (`catalog_bookmarks.DOMAIN`).
pub(crate) const CATALOG_BOOKMARKS_DOMAIN: &str = "catalog-bookmarks";

impl SyncStatus {
    /// The bookmark authority as `/v1/mobile-catalog/status` reports it, from this
    /// document's `catalog-bookmarks` row: both read the same `authority_domains` row, and
    /// the server advertises `bookmarkWrite` exactly when that row exists.
    pub(crate) fn bookmark_authority(&self) -> MobileCatalogAuthority {
        match self
            .domains
            .iter()
            .find(|domain| domain.domain == CATALOG_BOOKMARKS_DOMAIN)
        {
            Some(domain) => MobileCatalogAuthority {
                library_id: Some(domain.library_id.clone()),
                epoch: Some(domain.epoch),
                contract_version: Some(domain.contract_version),
                cursor: Some(domain.cursor),
                bookmark_write: true,
            },
            None => MobileCatalogAuthority::default(),
        }
    }

    /// The domain names this server reports as server-authoritative, in order.
    pub(crate) fn active_domain_names(&self) -> Vec<&str> {
        self.domains.iter().map(|domain| domain.domain.as_str()).collect()
    }

    /// Whether this response is self-consistent enough to act on.
    ///
    /// The restore guard treats `!active` as proof that no shared domain has moved
    /// to server authority, so an inconsistent envelope must never reach it. Each
    /// rule below closes a way a broken or hostile server could claim "nothing is
    /// active" while actually reporting an active domain:
    ///
    /// * `active` must agree with the domain list, so neither field alone decides;
    /// * an inactive response may not name a library or a domain;
    /// * an active response must identify its library;
    /// * every domain must belong to the same library as the envelope, so two
    ///   libraries cannot be reported through one document;
    /// * domain names must be non-empty and unique, so counting and lookup agree;
    /// * epoch/contract must be positive and the cursor may not be negative, since
    ///   those are the fields a domain loop would replay from.
    ///
    /// Identifiers use the same 32-lowercase-hex invariant the server enforces, so
    /// a placeholder value cannot be mistaken for a library identity.
    pub(crate) fn is_consistent(&self) -> bool {
        if self.active != !self.domains.is_empty() {
            return false;
        }
        if self.active {
            if !self.library_id.as_deref().is_some_and(crate::library::is_valid_library_id) {
                return false;
            }
        } else if self.library_id.is_some() {
            // An inactive envelope names no library. Reporting one while claiming
            // nothing is active is the contradiction that must not be trusted.
            return false;
        }
        let mut seen = std::collections::BTreeSet::new();
        for domain in &self.domains {
            if domain.domain.trim().is_empty()
                || !seen.insert(domain.domain.as_str())
                || !crate::library::is_valid_library_id(&domain.library_id)
                || Some(domain.library_id.as_str()) != self.library_id.as_deref()
                || domain.epoch < 1
                || domain.contract_version < 1
                || domain.cursor < 0
            {
                return false;
            }
        }
        true
    }
}

/// The header a long-poll capable server sends on every `/v1/sync/status` answer.
pub(crate) const STATUS_WAIT_HEADER: &str = "lakomics-status-wait";

/// One answer to [`CloudClient::watch_sync_status`]. `advertised` is the server's
/// `Lakomics-Status-Wait` (seconds), absent on a server without long-poll.
#[derive(Debug)]
pub(crate) enum StatusWatchReply {
    Changed {
        status: SyncStatus,
        etag: Option<String>,
        advertised: Option<u64>,
    },
    NotModified {
        advertised: Option<u64>,
    },
}

/// The aggregate contract version this build understands.
///
/// A future version may redefine what `active` or a domain row means, so it must
/// never be interpreted by this client's field expectations. One supported
/// version also keeps "inactive" provable: the envelope is fully validated before
/// any caller may read it as evidence that nothing has been migrated.
const SYNC_PROTOCOL_VERSION: i64 = 1;

/// One Album page or change payload, as the server encodes it.
pub(crate) const ALBUM_BASELINE_ALBUMS_SECTION: &str = "albums";
pub(crate) const ALBUM_BASELINE_MEMBERSHIPS_SECTION: &str = "memberships";

/// Maximum encoded Album response accepted from the server.
///
/// The server bounds one baseline page at 2 MiB and one change page by its item
/// count, so this leaves room for the envelope without accepting an unbounded body.
const MAX_ALBUM_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// One authoritative Album projection carried by a change row or baseline page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlbumProjection {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon_key: Option<String>,
    pub color_key: Option<String>,
    pub deleted: bool,
    pub entity_revision: i64,
}

/// One authoritative membership projection. `desired_state` is the authoritative
/// value for *this relation*, so a tombstone is representable and is not the same
/// as "the relation was never seen".
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlbumMembershipProjection {
    pub album_id: String,
    pub asset_id: String,
    pub desired_state: bool,
    pub entity_revision: i64,
}

/// A baseline page. `complete` is true only on the final membership page, so a
/// client can never adopt a subset it mistook for the whole domain.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlbumBaselinePage {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub snapshot_cursor: i64,
    pub section: String,
    pub items: serde_json::Value,
    pub next_after: Option<String>,
    pub has_more: bool,
    pub complete: bool,
}

impl AlbumBaselinePage {
    /// Decode this page's items for its declared section.
    ///
    /// A page whose section does not match its item shape is a malformed response,
    /// not something to interpret leniently.
    pub(crate) fn decode(
        &self,
    ) -> Result<(Vec<AlbumProjection>, Vec<AlbumMembershipProjection>), LibraryError> {
        match self.section.as_str() {
            ALBUM_BASELINE_ALBUMS_SECTION => Ok((
                serde_json::from_value(self.items.clone())
                    .map_err(|_| LibraryError::InvalidCloudResponse)?,
                Vec::new(),
            )),
            ALBUM_BASELINE_MEMBERSHIPS_SECTION => Ok((
                Vec::new(),
                serde_json::from_value(self.items.clone())
                    .map_err(|_| LibraryError::InvalidCloudResponse)?,
            )),
            _ => Err(LibraryError::InvalidCloudResponse),
        }
    }
}

/// One ordered, self-contained change row.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlbumChange {
    pub sequence: i64,
    pub authority_cursor: i64,
    pub command_type: String,
    pub operation_id: String,
    pub changed_at: String,
    #[serde(default)]
    pub album: Option<AlbumProjection>,
    #[serde(default)]
    pub membership: Option<AlbumMembershipProjection>,
}

impl AlbumChange {
    /// The single canonical delta this change carries.
    ///
    /// Exactly one of the two must be present: accepting a row with both, or with
    /// neither, would let a malformed server silently desynchronize a replica.
    pub(crate) fn delta(
        &self,
    ) -> Result<(Option<&AlbumProjection>, Option<&AlbumMembershipProjection>), LibraryError> {
        match (&self.album, &self.membership) {
            (Some(album), None) => Ok((Some(album), None)),
            (None, Some(membership)) => Ok((None, Some(membership))),
            _ => Err(LibraryError::InvalidCloudResponse),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlbumChanges {
    pub cursor: i64,
    pub items: Vec<AlbumChange>,
    pub next_after: i64,
    pub has_more: bool,
}

/// The accepted result of one Album command.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlbumCommandResult {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub command_type: String,
    pub operation_id: String,
    pub changed: bool,
    pub change_sequence: Option<i64>,
    pub authority_cursor: i64,
    #[serde(default)]
    pub album: Option<AlbumProjection>,
    #[serde(default)]
    pub membership: Option<AlbumMembershipProjection>,
}

/// A coded rejection the caller must treat as a structural conflict, not a retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AlbumConflict {
    /// The server's coded reason (for example `revisionConflict`).
    pub code: String,
    /// The current authoritative state the server reported, as raw JSON.
    pub detail: serde_json::Value,
}

/// The outcome of sending one Album command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AlbumCommandOutcome {
    /// The authority accepted the command; the result is durable and replayable.
    Accepted(Box<AlbumCommandResult>),
    /// The authority rejected the command on structural grounds. The intent must be
    /// preserved rather than rebased automatically.
    Conflict(AlbumConflict),
    /// The Asset the command names is tombstoned (`assetTombstoned`). The intent can never
    /// apply, so it is dropped rather than blocking the queue behind it.
    Dropped,
}

/// Maximum domains accepted in one aggregate response. A bounded list keeps a
/// hostile or broken server from forcing unbounded work in the restore guard.
const MAX_SYNC_DOMAINS: usize = 512;

/// The shared domain name the server reports Classification authority under.
pub(crate) const CLASSIFICATION_DOMAIN: &str = "classifications";

/// The Classification domain contract this build speaks.
pub(crate) const CLASSIFICATION_CONTRACT_VERSION: i64 = 1;

/// Baseline sections, in the order the server emits them.
pub(crate) const CLASSIFICATION_BASELINE_SECTIONS_SECTION: &str = "classifications";
pub(crate) const CLASSIFICATION_BASELINE_ASSIGNMENTS_SECTION: &str = "assignments";

/// Maximum encoded Classification response accepted from the server.
///
/// The server bounds one baseline page at 2 MiB and one change page by its item
/// count, so this leaves room for the envelope without accepting an unbounded body.
/// It matches the Album bound deliberately: both domains stream the same shape of
/// bounded page, and a smaller Classification-specific bound would only risk
/// rejecting a legal page.
const MAX_CLASSIFICATION_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Maximum encoded Classification command accepted for sending.
///
/// The server bounds this route's request body at 16 KiB, so a body this client would
/// not be allowed to deliver is refused before the request rather than reported as a
/// transport failure.
const MAX_CLASSIFICATION_COMMAND_BYTES: usize = 16 * 1024;

/// One Classification projection carried by a baseline page or a change row.
///
/// `deleted` is present on live rows too (always false) so one type describes both
/// a live node and the tombstone a delete change carries.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationProjection {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon_key: Option<String>,
    pub color_key: Option<String>,
    pub deleted: bool,
    pub entity_revision: i64,
}

/// One Asset assignment projection.
///
/// `classification_id` is nullable by contract: `None` is the authoritative
/// *unassigned* state at `entity_revision >= 1`, which is not the same as this PC
/// never having been told about the Asset.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationAssignmentProjection {
    pub asset_id: String,
    pub classification_id: Option<String>,
    pub entity_revision: i64,
}

/// One immutable role binding. v1 has exactly the `originals` role, and it is
/// carried on *every* baseline page because no command can produce it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationRoleProjection {
    pub role: String,
    pub classification_id: String,
}

/// The deterministic assignment transition a delete change carries.
///
/// `affects_assignments` is the server's own count of assignments that named the
/// deleted Classification, which is what lets a replica prove its cached lineage is
/// complete before applying the move.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationAssignmentTransition {
    pub from_classification_id: String,
    pub to_classification_id: Option<String>,
    pub affects_assignments: i64,
}

/// A baseline page.
///
/// `complete` is true only on the final assignment page, so a client can never adopt
/// a subset it mistook for the whole domain.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationBaselinePage {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub snapshot_cursor: i64,
    pub section: String,
    pub roles: Vec<ClassificationRoleProjection>,
    pub items: serde_json::Value,
    pub next_after: Option<String>,
    pub has_more: bool,
    pub complete: bool,
}

impl ClassificationBaselinePage {
    /// Decode this page's items for its declared section.
    ///
    /// A page whose section does not match its item shape is a malformed response,
    /// not something to interpret leniently.
    pub(crate) fn decode(
        &self,
    ) -> Result<
        (
            Vec<ClassificationProjection>,
            Vec<ClassificationAssignmentProjection>,
        ),
        LibraryError,
    > {
        match self.section.as_str() {
            CLASSIFICATION_BASELINE_SECTIONS_SECTION => Ok((
                serde_json::from_value(self.items.clone())
                    .map_err(|_| LibraryError::InvalidCloudResponse)?,
                Vec::new(),
            )),
            CLASSIFICATION_BASELINE_ASSIGNMENTS_SECTION => Ok((
                Vec::new(),
                serde_json::from_value(self.items.clone())
                    .map_err(|_| LibraryError::InvalidCloudResponse)?,
            )),
            _ => Err(LibraryError::InvalidCloudResponse),
        }
    }
}

/// One ordered, self-contained change row.
///
/// A normal change carries exactly one delta; a delete change deliberately carries
/// **two** related parts — the Classification tombstone and the assignment
/// transition — because the server expresses a delete as one indivisible change.
/// [`ClassificationChange::delta`] is the single place that shape is interpreted.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationChange {
    pub sequence: i64,
    pub authority_cursor: i64,
    pub command_type: String,
    pub operation_id: String,
    pub changed_at: String,
    #[serde(default)]
    pub classification: Option<ClassificationProjection>,
    #[serde(default)]
    pub assignment: Option<ClassificationAssignmentProjection>,
    #[serde(default)]
    pub assignment_transition: Option<ClassificationAssignmentTransition>,
}

/// Command names, matching the server's exactly. Each one fixes which payload shape is
/// legal, so a row whose payload disagrees with its label is malformed rather than
/// merely surprising.
pub(crate) const CLASSIFICATION_CREATE: &str = "createClassification";
pub(crate) const CLASSIFICATION_RENAME: &str = "renameClassification";
pub(crate) const CLASSIFICATION_MOVE: &str = "moveClassification";
pub(crate) const CLASSIFICATION_APPEARANCE: &str = "updateClassificationAppearance";
pub(crate) const CLASSIFICATION_DELETE: &str = "deleteClassification";
pub(crate) const CLASSIFICATION_ASSIGNMENT: &str = "setAssetClassification";

impl ClassificationChange {
    /// The canonical delta this change carries.
    ///
    /// Three shapes are valid and nothing else:
    ///
    /// * one live Classification projection alone (create/rename/move/appearance);
    /// * one assignment projection alone (`setAssetClassification`);
    /// * a Classification tombstone plus its assignment transition (`deleteClassification`).
    ///
    /// The delete shape is *not* a malformed multi-delta row: it is the one change
    /// the server emits to make a delete unobservable as two states. Everything else is
    /// refused rather than guessed at, including a payload that disagrees with its own
    /// `commandType` — a row labelled `renameClassification` that actually carries an
    /// assignment would otherwise be applied as whatever its payload claimed.
    ///
    /// `authorityCursor` is required to equal `sequence`: the server emits that identity
    /// for every row, so a disagreement means the row is not the change it claims to be.
    pub(crate) fn delta(
        &self,
    ) -> Result<
        (
            Option<&ClassificationProjection>,
            Option<&ClassificationAssignmentProjection>,
            Option<&ClassificationAssignmentTransition>,
        ),
        LibraryError,
    > {
        if self.authority_cursor != self.sequence {
            return Err(LibraryError::InvalidCloudResponse);
        }
        match (
            self.command_type.as_str(),
            &self.classification,
            &self.assignment,
            &self.assignment_transition,
        ) {
            // A structural command carries exactly one live Classification.
            (
                CLASSIFICATION_CREATE | CLASSIFICATION_RENAME | CLASSIFICATION_MOVE
                | CLASSIFICATION_APPEARANCE,
                Some(classification),
                None,
                None,
            ) => {
                if classification.deleted {
                    // A tombstone is only ever emitted together with the transition
                    // that moves its assignments, so a bare tombstone would leave the
                    // replica unable to resolve the lineage it describes.
                    return Err(LibraryError::InvalidCloudResponse);
                }
                Ok((Some(classification), None, None))
            }
            // Assignment is its own lineage and carries no Classification projection.
            (CLASSIFICATION_ASSIGNMENT, None, Some(assignment), None) => {
                if assignment.entity_revision < 1 {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                Ok((None, Some(assignment), None))
            }
            // A delete is the tombstone *and* the transition, together.
            (CLASSIFICATION_DELETE, Some(classification), None, Some(transition)) => {
                if !classification.deleted {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                if transition.from_classification_id != classification.id {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                if transition.affects_assignments < 0 {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                Ok((Some(classification), None, Some(transition)))
            }
            _ => Err(LibraryError::InvalidCloudResponse),
        }
    }
}

/// One page of the ordered Classification change log.
///
/// The identity fields are carried so a replica can prove a page belongs to the authority
/// it asked for: without them a response from another library, epoch or contract would be
/// applied as if it were this replica's own.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationChanges {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub cursor: i64,
    pub items: Vec<ClassificationChange>,
    pub next_after: i64,
    pub has_more: bool,
}

impl ClassificationChanges {
    /// Validate this page against the authority it was requested from, and against the
    /// server's own cursor envelope.
    ///
    /// Fails closed on every malformed field rather than normalizing: `after` is the
    /// cursor the request was made from, and the server defines the envelope exactly as
    /// `nextAfter = last item sequence, or requested after when items is empty` and
    /// `hasMore = nextAfter < cursor`.
    pub(crate) fn validate(
        &self,
        authority_library_id: &str,
        authority_epoch: i64,
        requested_after: i64,
    ) -> Result<(), LibraryError> {
        if self.library_id != authority_library_id
            || self.epoch != authority_epoch
            || self.contract_version != CLASSIFICATION_CONTRACT_VERSION
        {
            return Err(LibraryError::ClassificationAuthorityMismatch);
        }
        if self.cursor < 0 || self.next_after < 0 || requested_after < 0 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // The page can neither reach past the authority nor move behind the cursor the
        // request was made from.
        if self.next_after > self.cursor || self.next_after < requested_after {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // `hasMore` is derived from the same two numbers, so a disagreement means the
        // page describes a progression it does not actually have.
        if self.has_more != (self.next_after < self.cursor) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        match self.items.last() {
            // An empty page may not advance: the only honest cursor is the requested one.
            None => {
                if self.next_after != requested_after {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
            // A non-empty page advances exactly to its final row's sequence.
            Some(last) => {
                if last.sequence != self.next_after {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
        }
        Ok(())
    }
}

/// The accepted result of one Classification command, exactly as the server encodes it.
///
/// The identity fields are carried so the caller can prove a 200 is an acceptance of
/// *its* intent before retiring a durable queue row. `assignmentTransition` is present
/// only on a delete, where it describes the whole aggregate reassignment the server
/// performed in one change.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassificationCommandResult {
    pub library_id: String,
    pub epoch: i64,
    pub contract_version: i64,
    pub command_type: String,
    pub operation_id: String,
    pub changed: bool,
    pub change_sequence: Option<i64>,
    pub authority_cursor: i64,
    #[serde(default)]
    pub classification: Option<ClassificationProjection>,
    #[serde(default)]
    pub assignments: Vec<ClassificationAssignmentProjection>,
    #[serde(default)]
    pub assignment_transition: Option<ClassificationAssignmentTransition>,
    pub updated_at: String,
}

/// A coded rejection the caller must treat as a structural conflict, not a retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClassificationConflict {
    /// The server's coded reason (for example `revisionConflict`).
    pub code: String,
    /// The current authoritative state the server reported, as raw JSON.
    pub detail: serde_json::Value,
}

/// The outcome of sending one Classification command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClassificationCommandOutcome {
    /// The authority accepted the command; the result is durable and replayable.
    Accepted(Box<ClassificationCommandResult>),
    /// The authority rejected the command. The intent is preserved: a structural
    /// rejection becomes a durable blocked row, and an assignment `revisionConflict` is
    /// rebased onto the authority's current revision.
    Conflict(ClassificationConflict),
    /// The Asset the command names is tombstoned (`assetTombstoned`). The intent can never
    /// apply, so it is dropped rather than blocking the queue behind it.
    Dropped,
}

impl ClassificationCommandResult {
    /// Prove this accepted result describes the command that was sent.
    ///
    /// The caller retires the queue row keyed by the *stored* operation id and writes the
    /// returned revision into the confirmed caches. An echo that names another operation,
    /// entity, epoch or contract would therefore retire the wrong intent and record state
    /// belonging to something else — corrupting confirmation rather than merely losing a
    /// response. Every identity field must agree exactly, and the projections must be
    /// exactly the shape the declared command produces.
    pub(crate) fn validate_against(&self, command: &serde_json::Value) -> Result<(), LibraryError> {
        let field = |key: &str| command.get(key).and_then(|value| value.as_str());
        let number = |key: &str| command.get(key).and_then(|value| value.as_i64());
        if field("libraryId") != Some(self.library_id.as_str())
            || field("operationId") != Some(self.operation_id.as_str())
            || field("commandType") != Some(self.command_type.as_str())
            || number("epoch") != Some(self.epoch)
            || number("contractVersion") != Some(self.contract_version)
            || self.contract_version != CLASSIFICATION_CONTRACT_VERSION
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // The cursor the authority reports after acceptance can never regress past the
        // sequence this change occupies, and a changed command occupies exactly one.
        if self.authority_cursor < 0 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        match self.command_type.as_str() {
            // A structural create/rename/move/appearance answers with exactly one live
            // Classification projection of its own target, and no assignment state: it
            // touched the Classification's own revision lineage, not any Asset's.
            CLASSIFICATION_CREATE | CLASSIFICATION_RENAME | CLASSIFICATION_MOVE
            | CLASSIFICATION_APPEARANCE => {
                let target = field("classificationId").ok_or(LibraryError::InvalidCloudResponse)?;
                let classification = self
                    .classification
                    .as_ref()
                    .ok_or(LibraryError::InvalidCloudResponse)?;
                if classification.deleted
                    || classification.id != target
                    || !self.assignments.is_empty()
                    || self.assignment_transition.is_some()
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
            CLASSIFICATION_DELETE => {
                let target = field("classificationId").ok_or(LibraryError::InvalidCloudResponse)?;
                let classification = self
                    .classification
                    .as_ref()
                    .ok_or(LibraryError::InvalidCloudResponse)?;
                let transition = self
                    .assignment_transition
                    .as_ref()
                    .ok_or(LibraryError::InvalidCloudResponse)?;
                // A delete is one atomic change describing a tombstone *and* the
                // aggregate reassignment it performed. An ordinary assignment list here
                // would be fake transition state: it could not describe Assets this PC
                // has never materialized, and the delete response carries only the
                // aggregate count, never each lineage's new revision.
                if !classification.deleted
                    || classification.id != target
                    || transition.from_classification_id != target
                    || transition.affects_assignments < 0
                    || !self.assignments.is_empty()
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
            CLASSIFICATION_ASSIGNMENT => {
                let asset_id = field("assetId").ok_or(LibraryError::InvalidCloudResponse)?;
                let desired = command
                    .get("classificationId")
                    .ok_or(LibraryError::InvalidCloudResponse)?;
                if self.classification.is_some()
                    || self.assignments.len() != 1
                    || self.assignment_transition.is_some()
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
                let assignment = &self.assignments[0];
                if assignment.asset_id != asset_id
                    || assignment.classification_id.as_deref() != desired.as_str()
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
            _ => return Err(LibraryError::InvalidCloudResponse),
        }
        Ok(())
    }
}

pub(crate) struct CloudClient {
    agent: ureq::Agent,
    base_url: url::Url,
}

impl CloudClient {
    /// Aggregate sync status: which domains are server-authoritative right now.
    ///
    /// Fails closed in every direction, because the only current caller decides
    /// whether a destructive whole-database restore may proceed:
    ///
    /// * an older server without the route (404) cannot report its authority
    ///   state, so it is `RestoreAuthorityUnknown`, never "no authority";
    /// * a credential failure stays a credential failure, because that is
    ///   actionable and is not evidence about authority;
    /// * an unsupported protocol version is `SyncProtocolUnsupported`;
    /// * a syntactically valid but semantically inconsistent envelope is
    ///   `RestoreAuthorityUnknown`, since the client cannot tell whether a domain
    ///   it failed to parse is in fact active.
    pub(crate) fn sync_status(&self, token: &str) -> Result<SyncStatus, LibraryError> {
        let mut response = self
            .agent
            .get(self.endpoint("/v1/sync/status")?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_sync_status_error)?;
        let bytes = read_body_bounded(&mut response, MAX_RESPONSE_BYTES)
            .map_err(|_| LibraryError::RestoreAuthorityUnknown)?;
        parse_sync_status(&bytes)
    }

    /// The same document as [`Self::sync_status`], read with `If-None-Match`.
    ///
    /// Only the coordinated authority poll uses this. A `304` returns the body this
    /// process last received for the same endpoint and credential, which the server's
    /// tag (a hash of the body) proves is still current; a server without ETags keeps
    /// answering `200` and simply costs a full read. The restore guard keeps the
    /// unconditional read.
    pub(crate) fn sync_status_conditional(&self, token: &str) -> Result<SyncStatus, LibraryError> {
        let bytes = self.conditional_get("/v1/sync/status", token, map_sync_status_error)?;
        parse_sync_status(&bytes)
    }

    /// A client for the status watcher's held requests: the response may take up to the
    /// requested wait, so it is allowed `recv_response` instead of the usual 30 s.
    pub(crate) fn for_status_watch(base_url: &str, recv_response: Duration) -> Result<Self, LibraryError> {
        let mut client = Self::new(base_url)?;
        client.agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .timeout_connect(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_request(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_recv_response(Some(recv_response))
                .timeout_recv_body(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        Ok(client)
    }

    /// The endpoint this client talks to, normalized (the key `cloud::status_watch` uses).
    pub(crate) fn base(&self) -> &str {
        self.base_url.as_str()
    }

    /// `GET /v1/sync/status?wait=<wait>` with the watcher's own ETag.
    ///
    /// The server holds the request only when `etag` still matches, until the caller's
    /// document changes (`Changed`) or the wait ends (`NotModified`). An older server
    /// ignores `wait` and answers at once; either way the advertised
    /// `Lakomics-Status-Wait` header is returned so the caller can tell the two apart.
    pub(crate) fn watch_sync_status(
        &self,
        token: &str,
        etag: Option<&str>,
        wait: u64,
    ) -> Result<StatusWatchReply, LibraryError> {
        let mut url = url::Url::parse(&self.endpoint("/v1/sync/status")?)
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        url.query_pairs_mut().append_pair("wait", &wait.to_string());
        let mut request = self
            .agent
            .get(url.as_str())
            .header("Authorization", bearer(token)?);
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let mut response = request.call().map_err(map_sync_status_error)?;
        let advertised = response
            .headers()
            .get(STATUS_WAIT_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 1.0)
            .map(|value| value as u64);
        if response.status().as_u16() == 304 {
            // Only meaningful against the tag this watcher sent.
            return match etag {
                Some(_) => Ok(StatusWatchReply::NotModified { advertised }),
                None => Err(LibraryError::InvalidCloudResponse),
            };
        }
        if !response.status().is_success() {
            return Err(map_sync_status_error(ureq::Error::StatusCode(
                response.status().as_u16(),
            )));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 256)
            .map(str::to_owned);
        let body = read_body_bounded(&mut response, MAX_RESPONSE_BYTES)?;
        Ok(StatusWatchReply::Changed {
            status: parse_sync_status(&body)?,
            etag,
            advertised,
        })
    }

    /// A small JSON GET with a process-wide ETag cache (see [`ConditionalCache`]).
    fn conditional_get(
        &self,
        path: &str,
        token: &str,
        map_error: fn(ureq::Error) -> LibraryError,
    ) -> Result<Vec<u8>, LibraryError> {
        let scope = conditional_scope(&self.base_url, token);
        let cached = conditional_cache().lookup(&scope, path);
        let mut request = self
            .agent
            .get(self.endpoint(path)?)
            .header("Authorization", bearer(token)?);
        if let Some((etag, _)) = &cached {
            request = request.header("If-None-Match", etag.as_str());
        }
        let mut response = request.call().map_err(map_error)?;
        if response.status().as_u16() == 304 {
            // A 304 is only meaningful against the body its tag describes. Without one
            // (evicted, or a server answering 304 unprompted) it is not a document.
            return cached
                .map(|(_, body)| body)
                .ok_or(LibraryError::InvalidCloudResponse);
        }
        if !response.status().is_success() {
            return Err(map_error(ureq::Error::StatusCode(
                response.status().as_u16(),
            )));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = read_body_bounded(&mut response, MAX_RESPONSE_BYTES)?;
        conditional_cache().store(&scope, path, etag, &body);
        Ok(body)
    }

    /// One Album baseline page against a frozen snapshot cursor.
    ///
    /// The first request omits `snapshot` and establishes the cursor; every later
    /// page supplies the same value, which is what makes the pages describe one
    /// materialized state. `after` walks the deterministic order inside a section and
    /// is never a synchronization cursor.
    pub(crate) fn album_baseline_page(
        &self,
        library_id: &str,
        epoch: i64,
        snapshot: Option<i64>,
        section: Option<&str>,
        after: Option<&str>,
        token: &str,
    ) -> Result<AlbumBaselinePage, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || epoch < 1 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if let Some(section) = section {
            if !matches!(section, ALBUM_BASELINE_ALBUMS_SECTION | ALBUM_BASELINE_MEMBERSHIPS_SECTION) {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        let mut url = url::Url::parse(&self.endpoint("/v1/albums/baseline")?)
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("libraryId", library_id);
            query.append_pair("epoch", &epoch.to_string());
            if let Some(snapshot) = snapshot {
                query.append_pair("snapshot", &snapshot.to_string());
            }
            if let Some(section) = section {
                query.append_pair("section", section);
            }
            if let Some(after) = after {
                query.append_pair("after", after);
            }
        }
        // `http_status_as_error` is disabled for this request so the coded 409 body
        // survives: the route returns `baselineChanged` when a mutation landed between
        // pages, and the authority codes when the identity/epoch/contract no longer
        // matches. Those demand different recovery, and collapsing them into one
        // generic rejection would make a retryable re-base look like a fatal error.
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent
            .get(url.as_str())
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|error| map_album_read_error(error, LibraryError::AlbumSyncRejected(409)))?;
        let status = response.status().as_u16();
        if status != 200 {
            if status == 409 {
                return Err(match read_json::<AlbumCodedConflict>(&mut response) {
                    Ok(body) => {
                        album_conflict_error(body.detail, LibraryError::AlbumBaselineChanged)
                    }
                    // An unreadable body is still evidence the request was refused; the
                    // conservative reading is a changed baseline, which recovers by
                    // re-reading every page from a fresh snapshot.
                    Err(_) => LibraryError::AlbumBaselineChanged,
                });
            }
            return Err(map_album_status(status));
        }
        read_json_bounded::<AlbumBaselinePage>(&mut response, MAX_ALBUM_RESPONSE_BYTES)
    }

    /// One page of the ordered Album change log, ascending by sequence.
    pub(crate) fn album_changes(
        &self,
        library_id: &str,
        epoch: i64,
        after: i64,
        limit: u32,
        token: &str,
    ) -> Result<AlbumChanges, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || epoch < 1 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if after < 0 || !(1..=500).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // `http_status_as_error` is disabled for this request so the coded 409 body
        // survives: an expired cursor and a cursor ahead of the server share a status
        // but demand different recovery, and neither may be read as "no changes".
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut url = url::Url::parse(&self.endpoint("/v1/albums/changes")?)
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("libraryId", library_id);
            query.append_pair("epoch", &epoch.to_string());
            query.append_pair("after", &after.to_string());
            query.append_pair("limit", &limit.to_string());
        }
        let mut response = agent
            .get(url.as_str())
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|error| map_album_read_error(error, LibraryError::AlbumCursorAhead))?;
        let status = response.status().as_u16();
        if status != 200 {
            if status == 409 {
                return Err(match read_json::<AlbumCodedConflict>(&mut response) {
                    Ok(body) => album_conflict_error(body.detail, LibraryError::AlbumCursorAhead),
                    Err(_) => LibraryError::AlbumCursorAhead,
                });
            }
            return Err(map_album_status(status));
        }
        read_json_bounded::<AlbumChanges>(&mut response, MAX_ALBUM_RESPONSE_BYTES)
    }

    /// One Classification baseline page against a frozen snapshot cursor.
    ///
    /// The first request omits `snapshot` and establishes the cursor; every later
    /// page supplies the same value, which is what makes the pages describe one
    /// materialized state. `after` walks the deterministic order inside a section and
    /// is never a synchronization cursor.
    pub(crate) fn classification_baseline_page(
        &self,
        library_id: &str,
        epoch: i64,
        snapshot: Option<i64>,
        section: Option<&str>,
        after: Option<&str>,
        token: &str,
    ) -> Result<ClassificationBaselinePage, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || epoch < 1 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if let Some(section) = section {
            if !matches!(
                section,
                CLASSIFICATION_BASELINE_SECTIONS_SECTION
                    | CLASSIFICATION_BASELINE_ASSIGNMENTS_SECTION
            ) {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        if let Some(snapshot) = snapshot {
            if snapshot < 0 {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        let mut url =
            url::Url::parse(&self.endpoint("/v1/classifications/authority/baseline")?)
                .map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("libraryId", library_id);
            query.append_pair("epoch", &epoch.to_string());
            if let Some(snapshot) = snapshot {
                query.append_pair("snapshot", &snapshot.to_string());
            }
            if let Some(section) = section {
                query.append_pair("section", section);
            }
            if let Some(after) = after {
                query.append_pair("after", after);
            }
        }
        // `http_status_as_error` is disabled for this request so the coded 409 body
        // survives: the route returns `baselineChanged` when a mutation landed between
        // pages, and the shared authority codes when the identity/epoch/contract no
        // longer matches. Those demand different recovery, and collapsing them into one
        // generic rejection would make a retryable re-base look like a fatal error.
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent
            .get(url.as_str())
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|error| {
                map_classification_read_error(error, LibraryError::ClassificationSyncRejected(409))
            })?;
        let status = response.status().as_u16();
        if status != 200 {
            if status == 409 {
                return Err(match read_json::<AlbumCodedConflict>(&mut response) {
                    Ok(body) => classification_conflict_error(
                        body.detail,
                        LibraryError::ClassificationBaselineChanged,
                    ),
                    // An unreadable body is still evidence the request was refused; the
                    // conservative reading is a changed baseline, which recovers by
                    // re-reading every page from a fresh snapshot.
                    Err(_) => LibraryError::ClassificationBaselineChanged,
                });
            }
            return Err(map_classification_status(status));
        }
        read_json_bounded::<ClassificationBaselinePage>(
            &mut response,
            MAX_CLASSIFICATION_RESPONSE_BYTES,
        )
    }

    /// One page of the ordered Classification change log, ascending by sequence.
    pub(crate) fn classification_changes(
        &self,
        library_id: &str,
        epoch: i64,
        after: i64,
        limit: u32,
        token: &str,
    ) -> Result<ClassificationChanges, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || epoch < 1 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if after < 0 || !(1..=500).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // `http_status_as_error` is disabled for this request so the coded 409 body
        // survives: an expired cursor, a cursor ahead of the server and a changed
        // baseline share a status but demand different recovery, and none may be read
        // as "no changes".
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut url = url::Url::parse(&self.endpoint("/v1/classifications/authority/changes")?)
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("libraryId", library_id);
            query.append_pair("epoch", &epoch.to_string());
            query.append_pair("after", &after.to_string());
            query.append_pair("limit", &limit.to_string());
        }
        let mut response = agent
            .get(url.as_str())
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|error| {
                map_classification_read_error(error, LibraryError::ClassificationCursorAhead)
            })?;
        let status = response.status().as_u16();
        if status != 200 {
            if status == 409 {
                return Err(match read_json::<AlbumCodedConflict>(&mut response) {
                    Ok(body) => classification_conflict_error(
                        body.detail,
                        LibraryError::ClassificationCursorAhead,
                    ),
                    Err(_) => LibraryError::ClassificationCursorAhead,
                });
            }
            return Err(map_classification_status(status));
        }
        read_json_bounded::<ClassificationChanges>(
            &mut response,
            MAX_CLASSIFICATION_RESPONSE_BYTES,
        )
    }

    /// Send one Album command.
    ///
    /// The caller retries with the *same* encoded payload and operation id, so the
    /// server's receipt resolves a lost response instead of applying the intent
    /// twice. A structural rejection is returned as a coded conflict rather than an
    /// error, because it is state the caller must preserve, not retry away.
    pub(crate) fn album_command(
        &self,
        body: &serde_json::Value,
        token: &str,
    ) -> Result<AlbumCommandOutcome, LibraryError> {
        let bytes = serde_json::to_vec(body).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if bytes.len() > 16 * 1024 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent
            .put(self.endpoint("/v1/albums/commands")?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send(&bytes)
            .map_err(|_| LibraryError::AlbumCommandOutcomeUnknown)?;
        let status = response.status().as_u16();
        if status == 200 {
            let result = read_json_bounded::<AlbumCommandResult>(&mut response, MAX_ALBUM_RESPONSE_BYTES)?;
            // A 200 is only an acceptance of *this* command if it says so. The caller
            // deletes the queue row identified by the stored operation id and writes the
            // returned revision into the confirmed caches, so an echo describing another
            // operation, entity or contract would retire the wrong intent and record a
            // revision that belongs to something else. A malformed 200 is therefore a
            // protocol-integrity failure, not an acceptance.
            result.validate_against(body)?;
            return Ok(AlbumCommandOutcome::Accepted(Box::new(result)));
        }
        // Coded rejections are read from a bounded structured body and mapped by code,
        // never by status alone: the route uses one status for an authority identity
        // failure, a compare-and-set conflict and a semantic structural rejection, and
        // those demand different handling.
        let detail = read_json::<AlbumCodedConflict>(&mut response)
            .map(|body| body.detail)
            .unwrap_or(serde_json::Value::Null);
        let code = detail
            .get("code")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match classify_album_rejection(code) {
            AlbumRejection::Authority(error) => Err(error),
            AlbumRejection::Structural(rejected) => Ok(AlbumCommandOutcome::Conflict(AlbumConflict {
                code: rejected.to_owned(),
                detail,
            })),
            AlbumRejection::Dropped => Ok(AlbumCommandOutcome::Dropped),
            // An unrecognized code keeps the intent and retries with the identical
            // operation id. It must **not** fall through to a status-based mapping: doing
            // so would report an uncoded semantic 422 as `AlbumContractUnsupported` and
            // strand a perfectly deliverable intent behind a false version skew, which is
            // the second unsafe direction this mapping exists to remove. Credentials stay
            // typed because they are actionable and are not evidence about the intent.
            AlbumRejection::Retryable => match status {
                401 | 403 => Err(LibraryError::CloudUnauthorized),
                _ => Err(LibraryError::AlbumCommandOutcomeUnknown),
            },
        }
    }

    /// Send one Classification command.
    ///
    /// The caller retries with the *same* encoded payload and operation id, so the
    /// server's receipt resolves a lost response instead of applying the intent twice.
    /// A rejection is returned as a coded conflict rather than an error, because it is
    /// state the caller must preserve, not retry away.
    ///
    /// The credential is supplied by the caller rather than chosen here: the server
    /// authorizes structural commands and assignments with different roles, and this
    /// client must not be the place that decides which one an intent needs.
    pub(crate) fn classification_command(
        &self,
        body: &serde_json::Value,
        token: &str,
    ) -> Result<ClassificationCommandOutcome, LibraryError> {
        let bytes = serde_json::to_vec(body).map_err(|_| LibraryError::InvalidCloudResponse)?;
        // The server bounds the route body at 16 KiB; refusing here keeps a local
        // representation error from being reported as a transport failure.
        if bytes.len() > MAX_CLASSIFICATION_COMMAND_BYTES {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // `http_status_as_error` is disabled for this request so the coded rejection body
        // survives: the route uses one status for an authority identity failure, a
        // compare-and-set conflict and a semantic structural rejection, and those demand
        // different handling. Collapsing them would make an automatic rebase impossible.
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent
            .put(self.endpoint("/v1/classifications/authority/commands")?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send(&bytes)
            .map_err(|_| LibraryError::ClassificationCommandOutcomeUnknown)?;
        let status = response.status().as_u16();
        if status == 200 {
            let result = read_json_bounded::<ClassificationCommandResult>(
                &mut response,
                MAX_CLASSIFICATION_RESPONSE_BYTES,
            )?;
            result.validate_against(body)?;
            return Ok(ClassificationCommandOutcome::Accepted(Box::new(result)));
        }
        // Coded rejections are read from a bounded structured body and mapped by code,
        // never by status alone.
        let detail = read_json::<AlbumCodedConflict>(&mut response)
            .map(|body| body.detail)
            .unwrap_or(serde_json::Value::Null);
        let code = detail
            .get("code")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match classify_classification_rejection(code) {
            ClassificationRejection::Authority(error) => Err(error),
            ClassificationRejection::Structural(rejected) => {
                Ok(ClassificationCommandOutcome::Conflict(ClassificationConflict {
                    code: rejected.to_owned(),
                    detail,
                }))
            }
            ClassificationRejection::Dropped => Ok(ClassificationCommandOutcome::Dropped),
            // An unrecognized code keeps the intent and retries with the identical
            // operation id and payload. It must **not** fall through to a status-based
            // mapping: doing so would report an uncoded semantic 422 as a contract
            // upgrade and strand a deliverable intent behind a version skew that does
            // not exist. Credentials stay typed because they are actionable and are not
            // evidence about the intent.
            ClassificationRejection::Retryable => match status {
                401 | 403 => Err(LibraryError::CloudUnauthorized),
                _ => Err(LibraryError::ClassificationCommandOutcomeUnknown),
            },
        }
    }

    pub(crate) fn publish_catalog_visibility(&self,body:&serde_json::Value,token:&str)->Result<(),LibraryError>{
        let bytes=serde_json::to_vec(body).map_err(|_|LibraryError::InvalidCloudResponse)?;
        if bytes.len()>crate::library::mobile_catalog::MAX_USERS{return Err(LibraryError::InvalidCloudResponse)}
        let agent=crate::http_agent::agent(ureq::Agent::config_builder().max_redirects(0).timeout_global(Some(UPLOAD_BODY_TIMEOUT)).build());
        let mut response=agent.put(self.endpoint("/v1/mobile-catalog/visibility")?).header("Authorization",bearer(token)?).content_type("application/json").send(&bytes).map_err(map_registration_error)?;
        let value:serde_json::Value=read_json(&mut response)?;
        if value["publicationRevision"].as_str().is_none(){return Err(LibraryError::InvalidCloudResponse)} Ok(())
    }
    pub(crate) fn mobile_catalog_revision(&self, token:&str)->Result<Option<String>,LibraryError>{
        #[derive(serde::Deserialize)] #[serde(rename_all="camelCase")] struct Status { publication_revision:Option<String> }
        let mut response=self.agent.get(self.endpoint("/v1/mobile-catalog/status")?).header("Authorization",bearer(token)?).call().map_err(map_registration_error)?;
        Ok(read_json::<Status>(&mut response)?.publication_revision)
    }
    pub(crate) fn upload_mobile_catalog(&self,digest:&str,file:File,token:&str,progress: super::publication::Reporter<'_>)->Result<(),LibraryError>{
        if digest.len()!=64 || !digest.bytes().all(|b|b.is_ascii_hexdigit()) || file.metadata().map_err(|_|LibraryError::InvalidOnlineCatalog)?.len()>crate::library::mobile_catalog::MAX_CONTENT {return Err(LibraryError::InvalidOnlineCatalog);}
        let agent=crate::http_agent::agent(ureq::Agent::config_builder().max_redirects(0).timeout_global(Some(UPLOAD_BODY_TIMEOUT)).build());
        let total = file.metadata().map_err(|_|LibraryError::InvalidOnlineCatalog)?.len();
        let mut reader = PublicationReader { file, progress, total, completed: 0, reported: 0 };
        let mut response=agent.put(self.endpoint(&format!("/v1/mobile-catalog/replicas/{digest}"))?).header("Authorization",bearer(token)?).content_type("application/x-ndjson").header("Content-Length", total.to_string()).send(ureq::SendBody::from_reader(&mut reader)).map_err(map_registration_error)?;
        let body:serde_json::Value=read_json(&mut response)?;
        if body["contentDigest"].as_str()!=Some(digest) || body["ready"]!=true {return Err(LibraryError::InvalidCloudResponse);} Ok(())
    }
    pub(crate) fn publish_mobile_catalog(&self,body:&serde_json::Value,token:&str,library_id:&str)->Result<(String,String),LibraryError>{
        if !crate::library::is_valid_library_id(library_id) {return Err(LibraryError::InvalidCloudResponse);}
        let bytes=serde_json::to_vec(body).map_err(|_|LibraryError::InvalidCloudResponse)?;
        if bytes.len()>crate::library::mobile_catalog::MAX_USERS+4096 {return Err(LibraryError::InvalidCloudResponse);}
        let agent=crate::http_agent::agent(ureq::Agent::config_builder().max_redirects(0).timeout_global(Some(UPLOAD_BODY_TIMEOUT)).build());
        let mut response=agent.put(self.endpoint("/v1/mobile-catalog/publication")?).header("Authorization",bearer(token)?).header("X-Lakomics-Library-Id",library_id).content_type("application/json").send(&bytes).map_err(map_registration_error)?;
        let value:serde_json::Value=read_json(&mut response)?;
        let revision=value["publicationRevision"].as_str().filter(|s|s.len()==64).ok_or(LibraryError::InvalidCloudResponse)?;
        let published=value["publishedAt"].as_str().ok_or(LibraryError::InvalidCloudResponse)?;
        Ok((revision.to_owned(),published.to_owned()))
    }
    /// Authority metadata advertised by `/status` (B3 added it for PC sync).
    /// Every authority field is `None` while the bookmark domain is still
    /// PC-owned.
    pub(crate) fn mobile_catalog_authority(
        &self,
        token: &str,
    ) -> Result<MobileCatalogAuthority, LibraryError> {
        let mut response = self
            .agent
            .get(self.endpoint("/v1/mobile-catalog/status")?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(map_bookmark_status_error)?;
        parse_mobile_catalog_authority(&read_body_bounded(&mut response, MAX_RESPONSE_BYTES)?)
    }

    /// [`Self::mobile_catalog_authority`] read with `If-None-Match`, for the
    /// coordinated authority poll. A `304` reuses the body the tag describes.
    pub(crate) fn mobile_catalog_authority_conditional(
        &self,
        token: &str,
    ) -> Result<MobileCatalogAuthority, LibraryError> {
        let bytes = self.conditional_get(
            "/v1/mobile-catalog/status",
            token,
            map_bookmark_status_error,
        )?;
        parse_mobile_catalog_authority(&bytes)
    }

    /// Full authoritative baseline. Used for the initial adoption and for an
    /// explicit re-base after the change cursor proves stale.
    pub(crate) fn mobile_catalog_bookmark_snapshot(
        &self,
        library_id: &str,
        epoch: i64,
        token: &str,
    ) -> Result<MobileCatalogBookmarkSnapshot, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut response = self
            .agent
            .get(self.endpoint(&format!(
                "/v1/mobile-catalog/bookmarks?libraryId={library_id}&epoch={epoch}"
            ))?)
            .header("Authorization", bearer(token)?)
            .call()
            // Params come from validated authority state, so a 409 here is an
            // identity/contract mismatch rather than a cursor problem.
            .map_err(|error| {
                map_bookmark_read_error(error, LibraryError::CatalogBookmarkAuthorityMismatch)
            })?;
        let snapshot = read_json_bounded::<MobileCatalogBookmarkSnapshot>(
            &mut response,
            crate::library::mobile_catalog::MAX_USERS,
        )?;
        Ok(snapshot)
    }

    /// One page of the ordered change log, ascending by sequence.
    pub(crate) fn mobile_catalog_bookmark_changes(
        &self,
        library_id: &str,
        epoch: i64,
        after: i64,
        limit: u32,
        token: &str,
    ) -> Result<MobileCatalogBookmarkChanges, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if after < 0 || !(1..=500).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // `http_status_as_error` is disabled for this one request so the coded 409
        // body survives: the route distinguishes a cursor *ahead* of the server
        // from a cursor whose history has expired, and the two share a status.
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent
            .get(self.endpoint(&format!("/v1/mobile-catalog/bookmarks/changes?libraryId={library_id}&epoch={epoch}&after={after}&limit={limit}"))?)
            .header("Authorization", bearer(token)?)
            .call()
            .map_err(|error| map_bookmark_read_error(error, LibraryError::CatalogBookmarkCursorAhead))?;
        let status = response.status().as_u16();
        if status != 200 {
            if status == 409 {
                // Both outcomes mean "adopt a fresh baseline"; they differ only in
                // the reason reported to the user, and neither may be read as
                // "no changes".
                return Err(match read_json::<ChangesConflictBody>(&mut response) {
                    Ok(body) => match body.detail {
                        ChangesConflictDetail::CursorExpired => {
                            LibraryError::CatalogBookmarkCursorExpired
                        }
                        ChangesConflictDetail::Other => LibraryError::CatalogBookmarkCursorAhead,
                    },
                    Err(_) => LibraryError::CatalogBookmarkCursorAhead,
                });
            }
            return Err(map_bookmark_read_error(
                ureq::Error::StatusCode(status),
                LibraryError::CatalogBookmarkCursorAhead,
            ));
        }
        let changes =
            read_json_bounded::<MobileCatalogBookmarkChanges>(&mut response, 1024 * 1024)?;
        Ok(changes)
    }

    /// Send one bookmark command. The caller retries with the *same* command
    /// value, so `operationId` is stable and the server's receipt resolves a lost
    /// response instead of applying the intent twice.
    ///
    /// Status mapping keeps each failure a distinct recoverable state:
    ///
    /// * 401/403 → authorization (the credential, not the intent, is wrong);
    /// * 409 with `revisionConflict` → the PC's `expectedRevision` is stale, and
    ///   the body carries the current authoritative entity state;
    /// * any other 409 → identity/epoch/contract skew, which only a receive-side
    ///   re-base can resolve;
    /// * 422 → the server speaks another contract, which no retry can fix.
    ///
    /// `http_status_as_error` is disabled for this one request so the 409 body
    /// survives to be read; a conflict without its detail is treated as identity
    /// skew rather than guessed at.
    pub(crate) fn mobile_catalog_bookmark_command(
        &self,
        provider: &str,
        work_id: &str,
        command: &MobileCatalogBookmarkCommand,
        token: &str,
    ) -> Result<MobileCatalogBookmarkCommandResult, LibraryError> {
        if !matches!(provider, "kHentai" | "heliotrope") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if work_id.is_empty() || work_id.len() > 65536 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        if !crate::library::is_valid_library_id(&command.library_id)
            || command.epoch < 1
            || command.contract_version < 1
            || uuid::Uuid::parse_str(&command.operation_id).is_err()
            || command.expected_revision < 0
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let body = serde_json::to_vec(command).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if body.len() > 4096 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // The path is built from a validated provider and the exact stored work id.
        // Segment encoding is the URL parser's job; concatenating a raw id into a
        // path could produce a different entity than the one the intent names.
        let mut url = self
            .base_url
            .join("/v1/mobile-catalog/bookmarks")
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        url.path_segments_mut()
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)?
            .pop_if_empty()
            .extend([provider, work_id]);
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent
            .put(url.as_str())
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send(&body)
            .map_err(map_bookmark_command_error)?;
        let status = response.status().as_u16();
        if status != 200 {
            if status == 409 {
                return Err(match read_json::<ConflictBody>(&mut response) {
                    Ok(body) => match body.detail {
                        ConflictDetail::Revision { current } => {
                            LibraryError::CatalogBookmarkRevisionConflict {
                                current_revision: current.entity_revision,
                                current_desired_state: current.desired_state,
                            }
                        }
                        ConflictDetail::Other => LibraryError::CatalogBookmarkAuthorityMismatch,
                    },
                    Err(_) => LibraryError::CatalogBookmarkAuthorityMismatch,
                });
            }
            return Err(match status {
                422 => LibraryError::CatalogBookmarkContractUnsupported,
                401 | 403 => LibraryError::CloudUnauthorized,
                other => LibraryError::CatalogBookmarkSyncRejected(other),
            });
        }
        let result = read_json::<MobileCatalogBookmarkCommandResult>(&mut response)?;
        if result.library_id != command.library_id
            || result.epoch != command.epoch
            || result.contract_version != command.contract_version
            || result.provider != provider
            || result.work_id != work_id
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(result)
    }

    pub(crate) fn notes_list(&self, vault: &str, cursor:i64, token:&str) -> crate::library::notes::Result<crate::library::notes::Page> {
        let agent=crate::http_agent::agent(ureq::Agent::config_builder().max_redirects(0).timeout_global(Some(Duration::from_secs(30))).build());
        let mut response=agent.get(self.endpoint(&format!("/v1/notes/{vault}?after={cursor}&limit=10"))?)
            .header("Authorization",bearer(token)?).call()
            .map_err(|_|crate::library::notes::Error::Message("메모 서버에 연결하지 못했습니다. PC 저장 내용은 유지됩니다."))?;
        Ok(read_json_bounded(&mut response,8*1024*1024)?)
    }
    pub(crate) fn notes_put(&self,vault:&str,id:&str,revision:i64,operation:&str,payload:&crate::library::notes::Envelope,token:&str)->crate::library::notes::Result<crate::library::notes::Remote> {
        let body=serde_json::to_vec(&serde_json::json!({"expectedRevision":revision,"operationId":operation,"payload":payload}))?;
        let agent=crate::http_agent::agent(ureq::Agent::config_builder().max_redirects(0).timeout_global(Some(Duration::from_secs(30))).build());
        let mut response=agent.put(self.endpoint(&format!("/v1/notes/{vault}/{id}"))?).header("Authorization",bearer(token)?)
            .content_type("application/json").send(&body).map_err(|error|match error {
                ureq::Error::StatusCode(409)=>crate::library::notes::Error::Message("다른 기기에서 메모가 변경됐습니다. 다시 동기화해 두 버전을 확인해 주세요."),
                _=>crate::library::notes::Error::Message("메모를 서버에 보내지 못했습니다. PC 저장 내용은 유지됩니다.")
            })?;
        Ok(read_json_bounded(&mut response,1024*1024)?)
    }
    /// `/v1/collections/status`. A server without the personal-edit feature has no
    /// `capabilities` object (and a very old one no route: `404` reads as that too).
    pub(crate) fn collections_status(&self, token: &str) -> Result<CollectionsStatus, LibraryError> {
        let response = self.agent.get(self.endpoint("/v1/collections/status")?)
            .header("Authorization", bearer(token)?).call();
        let mut response = match response {
            Ok(response) => response,
            Err(ureq::Error::StatusCode(404)) => return Ok(CollectionsStatus::default()),
            Err(error) => return Err(map_registration_error(error)),
        };
        read_json_bounded(&mut response, 64 * 1024)
    }

    /// One page of the ordered personal-edit log (publisher token), or `None` when the
    /// route is absent. A coded `409` distinguishes "server library not linked"
    /// (`collectionPersonalEditUnsupported`) from a cursor/library rejection.
    pub(crate) fn collection_personal_edits(
        &self,
        token: &str,
        library_id: &str,
        after: i64,
        limit: i64,
    ) -> Result<Option<crate::library::collection_personal_edits::PersonalEditPage>, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || after < 0 || !(1..=100).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        // `editVersion=2`: this PC applies the manga tracking fields (an older server ignores it).
        let path = format!("/v1/collections/personal-edits?libraryId={library_id}&after={after}&limit={limit}&editVersion=2");
        let mut response = agent.get(self.endpoint(&path)?).header("Authorization", bearer(token)?).call()
            .map_err(|error| match error {
                ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
                _ => LibraryError::CloudRequestUnavailable,
            })?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            401 | 403 => return Err(LibraryError::CloudUnauthorized),
            409 => {
                #[derive(serde::Deserialize)]
                struct Coded { detail: CodedDetail }
                #[derive(serde::Deserialize)]
                struct CodedDetail { code: String }
                let code = read_json_bounded::<Coded>(&mut response, 16 * 1024).map(|body| body.detail.code);
                return Err(match code.as_deref() {
                    Ok("collectionPersonalEditUnsupported") => LibraryError::CollectionPersonalEditUnsupported,
                    _ => LibraryError::CollectionPersonalEditCursorRejected,
                });
            }
            status => return Err(LibraryError::CollectionPersonalEditSyncRejected(status)),
        }
        let page = read_json::<crate::library::collection_personal_edits::PersonalEditPage>(&mut response)?;
        crate::library::collection_personal_edits::validate_page(&page, library_id, after, limit)?;
        Ok(Some(page))
    }

    pub(crate) fn collections_revision(&self, token: &str) -> Result<Option<String>, LibraryError> {
        #[derive(serde::Deserialize)]
        struct State { revision: Option<String> }
        let mut response = self.agent.get(self.endpoint("/v1/collections?limit=1")?)
            .header("Authorization", bearer(token)?).call().map_err(map_registration_error)?;
        Ok(read_json_bounded::<State>(&mut response, super::collections::MAX_METADATA_BYTES)?.revision)
    }

    pub(crate) fn upload_collection_artwork(&self, blob: &super::collections::ArtworkBlob, bytes: &[u8], token: &str) -> Result<bool, LibraryError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Prepared { object_key: String, upload_url: Option<String>, required_headers: std::collections::BTreeMap<String, String> }
        let body = serde_json::to_vec(&serde_json::json!({ "sha256": blob.sha256, "sizeBytes": blob.size_bytes, "contentType": blob.content_type }))
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self.agent.post(self.endpoint("/v1/collections/artworks/prepare")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(&body).map_err(map_presign_error)?;
        let prepared: Prepared = read_json(&mut response)?;
        if prepared.object_key != blob.object_key || prepared.object_key != format!("work-artwork/mobile/{}", blob.sha256) || bytes.len() as u64 != blob.size_bytes {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let Some(upload_url) = prepared.upload_url else { return Ok(false); };
        let url = url::Url::parse(&upload_url).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        // Signed storage requests never carry the API token, cookies or follow redirects.
        let upload_agent = crate::http_agent::agent(ureq::Agent::config_builder().max_redirects(0)
            .timeout_global(Some(UPLOAD_BODY_TIMEOUT)).build());
        let request = upload_agent.put(url.as_str()).content_type(&blob.content_type);
        for (name, value) in prepared.required_headers {
            if !name.eq_ignore_ascii_case("content-type") || value != blob.content_type { return Err(LibraryError::InvalidCloudResponse); }
            // content_type above already sets this signed header. ureq::header
            // appends values, so adding it again invalidates the storage signature.
        }
        let response = request.send(bytes).map_err(map_upload_error)?;
        if !response.status().is_success() { return Err(LibraryError::InvalidCloudResponse); }
        // Register a successful exact HEAD check before metadata publication. This
        // avoids a large snapshot commit having to HEAD every already verified object.
        let mut response = self.agent.post(self.endpoint("/v1/collections/artworks/prepare")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(&body).map_err(map_presign_error)?;
        let verified: Prepared = read_json(&mut response)?;
        if verified.object_key != blob.object_key || verified.upload_url.is_some() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(true)
    }

    pub(crate) fn missing_collection_artworks(&self, blobs: &[&super::collections::ArtworkBlob], token: &str) -> Result<std::collections::BTreeSet<String>, LibraryError> {
        #[derive(serde::Deserialize)]
        struct Checked { missing: Vec<String> }
        let mut missing=std::collections::BTreeSet::new();
        for chunk in blobs.chunks(256) {
            let body=serde_json::json!({"items":chunk.iter().map(|b|serde_json::json!({"sha256":b.sha256,"sizeBytes":b.size_bytes,"contentType":b.content_type})).collect::<Vec<_>>()});
            let bytes=serde_json::to_vec(&body).map_err(|_|LibraryError::InvalidCloudResponse)?;
            let response=self.agent.post(self.endpoint("/v1/collections/artworks/check")?).header("Authorization",bearer(token)?).content_type("application/json").send(&bytes);
            // Older servers retain the verified per-file path during a rolling upgrade.
            if matches!(&response,Err(ureq::Error::StatusCode(404))) {return Ok(blobs.iter().map(|b|b.sha256.clone()).collect())}
            let mut response=response.map_err(map_presign_error)?;
            let checked:Checked=read_json_bounded(&mut response,32*1024)?;
            for digest in checked.missing {
                if !chunk.iter().any(|b|b.sha256==digest)||!missing.insert(digest){return Err(LibraryError::InvalidCloudResponse)}
            }
        }
        Ok(missing)
    }

    pub(crate) fn publish_collections(&self, metadata: &[u8], token: &str) -> Result<String, LibraryError> {
        #[derive(serde::Deserialize)]
        struct Published { revision: String }
        if metadata.len() > super::collections::MAX_METADATA_BYTES { return Err(LibraryError::InvalidCloudResponse); }
        // Status codes are read here so a coded personal-edit 409 (e.g. the server library
        // is not linked) is distinguishable from a stale base revision.
        let agent = crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_connect(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_request(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_body(Some(UPLOAD_BODY_TIMEOUT))
                .timeout_recv_response(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_recv_body(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        );
        let mut response = agent.put(self.endpoint("/v1/collections/replica")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(metadata).map_err(map_registration_error)?;
        match response.status().as_u16() {
            200 => {}
            409 => {
                #[derive(serde::Deserialize)]
                struct Coded { detail: serde_json::Value }
                let code = read_json_bounded::<Coded>(&mut response, 16 * 1024).ok()
                    .and_then(|body| body.detail.get("code").and_then(|code| code.as_str()).map(str::to_owned));
                return Err(match code.as_deref() {
                    Some("collectionPersonalEditUnsupported") => LibraryError::CollectionPersonalEditUnsupported,
                    Some("collectionPersonalEditCursorRejected" | "libraryMismatch") => LibraryError::CollectionPersonalEditCursorRejected,
                    _ => LibraryError::CloudObjectKeyConflict,
                });
            }
            status => return Err(map_registration_error(ureq::Error::StatusCode(status))),
        }
        let result: Published = read_json(&mut response)?;
        if result.revision.is_empty() { return Err(LibraryError::InvalidCloudResponse); }
        Ok(result.revision)
    }

    pub(crate) fn new(base_url: &str) -> Result<Self, LibraryError> {
        let parsed =
            url::Url::parse(base_url.trim()).map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        Ok(Self {
            agent: crate::http_agent::agent(
                ureq::Agent::config_builder()
                    .timeout_connect(Some(SHORT_NETWORK_TIMEOUT))
                    .timeout_send_request(Some(SHORT_NETWORK_TIMEOUT))
                    .timeout_send_body(Some(UPLOAD_BODY_TIMEOUT))
                    .timeout_recv_response(Some(SHORT_NETWORK_TIMEOUT))
                    .timeout_recv_body(Some(SHORT_NETWORK_TIMEOUT))
                    .build(),
            ),
            base_url: parsed,
        })
    }

    pub(crate) fn upload_asset(
        &self,
        asset: &PreparedAssetUpload,
        source: File,
        token: &str,
    ) -> Result<(), LibraryError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(LibraryError::InvalidCloudCredentialValue);
        }
        let authorization = format!("Bearer {token}");
        let presign_body = serde_json::to_vec(&PresignUploadRequest {
            object_key: &asset.object_key,
            content_type: &asset.content_type,
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/uploads/presign")?)
            .header("Authorization", &authorization)
            .content_type("application/json")
            .send(&presign_body)
            .map_err(map_presign_error)?;
        let presign: PresignUploadResponse = read_json(&mut response)?;
        validate_presign(&presign, &asset.object_key)?;

        let mut request = self.agent.put(&presign.upload_url);
        for (name, value) in &presign.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        request.send(source).map_err(map_upload_error)?;

        // Server contract: this is an idempotent upsert by asset id. Reusing the same
        // object key from a different asset id returns 409 and must not be retried.
        let registration_body = serde_json::to_vec(&RegisterAssetRequest {
            id: &asset.queue.entity_id,
            kind: &asset.kind,
            object_key: &presign.object_key,
            thumbnail_key: None,
            content_type: Some(&asset.content_type),
            size_bytes: Some(asset.size_bytes),
            sha256: Some(&asset.sha256),
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .post(self.endpoint("/v1/assets")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&registration_body)
            .map_err(map_registration_error)?;
        Ok(())
    }
    /// 캡처 수신함의 pending capture 목록을 조회한다.
    pub(crate) fn list_pending_captures(
        &self,
        token: &str,
    ) -> Result<Vec<RemoteCapturePayload>, LibraryError> {
        self.list_pending_captures_after(token, None)
    }

    pub(crate) fn create_extension_pairing(&self, token: &str) -> Result<ExtensionPairingResponse, LibraryError> {
        let mut response = self.agent
            .post(self.endpoint("/v1/extension/pairings")?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json")
            .send("{}")
            .map_err(|error| map_api_error(error, LibraryError::CloudAssetRegistrationRejected))?;
        read_json(&mut response)
    }

    pub(crate) fn capture_endpoint(&self) -> &str { self.base_url.as_str() }

    pub(crate) fn list_pending_captures_after(&self, token: &str, after_id: Option<&str>) -> Result<Vec<RemoteCapturePayload>, LibraryError> {
        let mut endpoint = url::Url::parse(&self.endpoint("/v1/captures/pending")?).map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
        if let Some(id) = after_id { endpoint.query_pairs_mut().append_pair("after_id", id); }
        let authorization = bearer(token)?;
        let mut response = self
            .agent
            .get(endpoint.as_str())
            .header("Authorization", authorization)
            .call()
            .map_err(map_capture_list_error)?;
        let page: RemoteCapturePage = read_json(&mut response)?;
        Ok(page.captures)
    }

    /// 캡처 미디어 다운로드 URL 발급을 요청한다.
    pub(crate) fn capture_download_ticket(
        &self,
        capture_id: &str,
        token: &str,
    ) -> Result<RemoteCaptureDownloadTicket, LibraryError> {
        let authorization = bearer(token)?;
        let mut response = self
            .agent
            .get(self.endpoint(&format!("/v1/captures/{capture_id}/download"))?)
            .header("Authorization", authorization)
            .call()
            .map_err(map_capture_ticket_error)?;
        let ticket: RemoteCaptureDownloadTicket = read_json(&mut response)?;
        validate_download_ticket(&ticket)?;
        Ok(ticket)
    }

    /// 캡처 미디어를 staging 경로에 크기 경계를 두고 내려받는다.
    pub(crate) fn download_capture_media(
        &self,
        ticket: &RemoteCaptureDownloadTicket,
        destination: &std::path::Path,
        maximum_bytes: u64,
    ) -> Result<u64, LibraryError> {
        let download_url = url::Url::parse(&ticket.download_url)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if !matches!(download_url.scheme(), "http" | "https") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut request = self.agent.get(download_url.as_str());
        for (name, value) in &ticket.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        let mut response = request.call().map_err(map_capture_download_error)?;
        if !response.status().is_success() {
            return Err(LibraryError::CloudCaptureDownloadRejected(
                response.status().as_u16(),
            ));
        }
        let mut destination_file =
            File::create(destination).map_err(|_| LibraryError::CloudCaptureStagingFailed)?;
        let mut reader = response
            .body_mut()
            .as_reader()
            .take(maximum_bytes.saturating_add(1));
        let copied = std::io::copy(&mut reader, &mut destination_file)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if copied > maximum_bytes {
            return Err(LibraryError::CloudCaptureTooLarge);
        }
        Ok(copied)
    }

    /// 로컬 수집이 확정된 캡처를 imported로 표시한다.
    pub(crate) fn acknowledge_capture_imported(
        &self,
        capture_id: &str,
        token: &str,
        imported_at: &str,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(&AcknowledgeCaptureRequest {
            imported_at: imported_at.to_string(),
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .post(self.endpoint(&format!("/v1/captures/{capture_id}/acknowledge"))?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(map_capture_ack_error)?;
        Ok(())
    }

    /// Read the revision before publishing a replacement character projection.
    pub(crate) fn character_revision(&self, token: &str) -> Result<Option<String>, LibraryError> {
        let mut response = self.agent.get(self.endpoint("/v1/library/characters")?)
            .header("Authorization", bearer(token)?).call().map_err(|_| LibraryError::CloudRequestUnavailable)?;
        let bytes = response.body_mut().with_config().limit(8 * 1024 * 1024).read_to_vec().map_err(|_| LibraryError::InvalidCloudResponse)?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if value["version"] != 1 || value["authority"] != "pc" || value["authorityEpoch"] != 0 { return Err(LibraryError::InvalidCloudResponse); }
        serde_json::from_value(value["revision"].clone()).map_err(|_| LibraryError::InvalidCloudResponse)
    }

    pub(crate) fn publish_characters(&self, token: &str, body: &[u8]) -> Result<super::characters::CharacterPublishResult, LibraryError> {
        let mut response=self.agent.put(self.endpoint("/v1/library/characters/replica")?)
            .header("Authorization",bearer(token)?).content_type("application/json").send(body)
            .map_err(map_character_publication_error)?;
        let bytes=response.body_mut().with_config().limit(MAX_RESPONSE_BYTES as u64).read_to_vec().map_err(|_|LibraryError::InvalidCloudResponse)?;
        serde_json::from_slice(&bytes).map_err(|_|LibraryError::InvalidCloudResponse)
    }

    /// 분류 스냅샷을 VPS에 게시한다. PC 라이브러리가 분류의 원본이며 VPS는
    /// 모바일 확장용 최소 스냅샷만 저장한다.
    /// Read one page of the ordered manual-exclusion log, or report that the route is absent.
    ///
    /// This is the feature's only bootstrap signal and its steady-state read. The route exists
    /// even when the server holds no exclusions and has no active binding, and it answers with
    /// an empty page after validating the library, so a *successful* read is itself the proof
    /// that the server supports the feature. No separate capability flag is consulted, because
    /// a capability advertised before any feature-aware publication could not be true: the
    /// server cannot know this PC sends protected references until it has received one.
    ///
    /// `after` is exclusive and the response must be contiguous from it; that contiguity is what
    /// lets the caller advance a durable cursor without tracking holes.
    ///
    /// Only a definite `404` — the route not existing at all — is `Ok(None)`. An authorization
    /// failure, a `409` cursor/library rejection or a `5xx` is a real failure returned as an
    /// error, so a broken or misbound server is never mistaken for an older one and silently
    /// downgraded to a legacy publication.
    pub(crate) fn character_exclusions(
        &self,
        token: &str,
        library_id: &str,
        after: i64,
        limit: i64,
    ) -> Result<Option<super::characters::ExclusionPage>, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || after < 0 || !(1..=100).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = format!(
            "/v1/library/characters/exclusions?libraryId={library_id}&after={after}&limit={limit}"
        );
        let mut response = match self
            .agent
            .get(self.endpoint(&path)?)
            .header("Authorization", bearer(token)?)
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::StatusCode(404)) => return Ok(None),
            Err(error) => return Err(map_character_exclusion_read_error(error)),
        };
        let page = read_json::<super::characters::ExclusionPage>(&mut response)?;
        super::characters::validate_exclusion_page(&page, library_id, after, limit)?;
        Ok(Some(page))
    }

    /// One page of the ordered mobile character-review decision log (publisher token), or
    /// `None` when the route is absent (an older server). A coded `409`
    /// `characterReviewUnsupported` (server library not linked) is distinguished from a
    /// cursor/library rejection.
    pub(crate) fn character_review_decisions(
        &self,
        token: &str,
        library_id: &str,
        after: i64,
        limit: i64,
    ) -> Result<Option<crate::library::character_review_sync::ReviewDecisionPage>, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || after < 0 || !(1..=100).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = format!("/v1/library/characters/review/decisions?libraryId={library_id}&after={after}&limit={limit}");
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint(&path)?).header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(character_review_status_error(status, &mut response)),
        }
        let page = read_json::<crate::library::character_review_sync::ReviewDecisionPage>(&mut response)?;
        crate::library::character_review_sync::validate_page(&page, library_id, after, limit)?;
        Ok(Some(page))
    }

    /// Replace the server's candidate feed (publisher token). `None` when the route is
    /// absent. A stale base is `Err(CharacterPublicationConflict)` so the caller can re-read
    /// the server revision and retry.
    pub(crate) fn publish_character_review_feed(
        &self,
        token: &str,
        body: &[u8],
    ) -> Result<Option<CharacterReviewFeedResult>, LibraryError> {
        if body.len() > 8 * 1024 * 1024 {
            return Err(LibraryError::CharacterPublicationTooLarge);
        }
        let request = self.coded_agent()?.put(self.endpoint("/v1/library/characters/review/feed")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(body);
        let mut response = self.coded_request(request)?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            413 => return Err(LibraryError::CharacterPublicationTooLarge),
            status => return Err(character_review_status_error(status, &mut response)),
        }
        let result: CharacterReviewFeedResult = read_json_bounded(&mut response, 64 * 1024)?;
        if result.revision.len() != 64 || !result.revision.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(Some(result))
    }

    /// The server's current candidate-feed revision, read through the mobile route (shared
    /// token). `None` before adoption.
    pub(crate) fn character_review_feed_revision(&self, token: &str) -> Result<Option<String>, LibraryError> {
        #[derive(serde::Deserialize)]
        struct Feed { revision: Option<String> }
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint("/v1/library/characters/review?limit=1")?)
            .header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            status => return Err(character_review_status_error(status, &mut response)),
        }
        Ok(read_json_bounded::<Feed>(&mut response, 1024 * 1024)?.revision)
    }

    /// One page of the ordered mobile similarity-review decision log (publisher token), or
    /// `None` when the route is absent (an older server). Before adoption the server answers
    /// `200` with no items; a coded `409` `similarityReviewUnsupported` means the server
    /// library is not linked yet.
    pub(crate) fn similarity_review_decisions(
        &self,
        token: &str,
        library_id: &str,
        after: i64,
        limit: i64,
    ) -> Result<Option<super::similarity_review::DecisionPage>, LibraryError> {
        if !crate::library::is_valid_library_id(library_id) || after < 0 || !(1..=100).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = format!("/v1/library/similarity/review/decisions?libraryId={library_id}&after={after}&limit={limit}");
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint(&path)?).header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(similarity_review_status_error(status, &mut response)),
        }
        let page = read_json_bounded::<super::similarity_review::DecisionPage>(&mut response, 4 * 1024 * 1024)?;
        super::similarity_review::validate_page(&page, library_id, after, limit)?;
        Ok(Some(page))
    }

    /// Replace the server's similarity pair feed (publisher token). `None` when the route is
    /// absent. A stale base is `Err(SimilarityReviewFeedConflict)`.
    pub(crate) fn publish_similarity_review_feed(
        &self,
        token: &str,
        body: &[u8],
    ) -> Result<Option<super::similarity_review::FeedResult>, LibraryError> {
        if body.len() > 8 * 1024 * 1024 {
            return Err(LibraryError::SimilarityReviewSyncRejected(413));
        }
        let request = self.coded_agent()?.put(self.endpoint("/v1/library/similarity/review/feed")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(body);
        let mut response = self.coded_request(request)?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(similarity_review_status_error(status, &mut response)),
        }
        let result: super::similarity_review::FeedResult = read_json_bounded(&mut response, 64 * 1024)?;
        if !super::similarity_review::valid_sha256(&result.revision) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(Some(result))
    }

    /// The server's current pair-feed revision, read through the mobile route (shared token).
    /// `None` before adoption.
    pub(crate) fn similarity_review_feed_revision(&self, token: &str) -> Result<Option<String>, LibraryError> {
        #[derive(serde::Deserialize)]
        struct Feed { revision: Option<String> }
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint("/v1/library/similarity/review?limit=1")?)
            .header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            status => return Err(similarity_review_status_error(status, &mut response)),
        }
        Ok(read_json_bounded::<Feed>(&mut response, 4 * 1024 * 1024)?.revision)
    }

    /// Upload one chunk of the PC's duplicate-edition candidate set (publisher token).
    /// `None` when the route is absent (an older server).
    pub(crate) fn publish_catalog_duplicates(
        &self,
        token: &str,
        body: &[u8],
    ) -> Result<Option<super::catalog_duplicates::PublicationResult>, LibraryError> {
        if body.len() > 8 * 1024 * 1024 {
            return Err(LibraryError::CatalogDuplicateSyncRejected(413));
        }
        let request = self.coded_agent()?.put(self.endpoint("/v1/mobile-catalog/duplicates/candidates")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(body);
        let mut response = self.coded_request(request)?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(catalog_duplicate_status_error(status, &mut response).1),
        }
        Ok(Some(read_json_bounded(&mut response, 64 * 1024)?))
    }

    /// One page of the duplicate-edition decision log (publisher token), `after` exclusive.
    /// `None` when the route is absent.
    pub(crate) fn catalog_duplicate_decisions(
        &self,
        token: &str,
        after: i64,
        limit: i64,
    ) -> Result<Option<super::catalog_duplicates::DecisionPage>, LibraryError> {
        if !(0..=super::catalog_duplicates::MAX_CURSOR).contains(&after) || !(1..=200).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = format!("/v1/mobile-catalog/duplicates/decisions?after={after}&limit={limit}");
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint(&path)?).header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(catalog_duplicate_status_error(status, &mut response).1),
        }
        let page = read_json_bounded::<super::catalog_duplicates::DecisionPage>(&mut response, 4 * 1024 * 1024)?;
        super::catalog_duplicates::validate_page(&page, after, limit)?;
        Ok(Some(page))
    }

    /// Record one duplicate-edition decision the way a mobile device does (client token).
    pub(crate) fn decide_catalog_duplicate(
        &self,
        token: &str,
        command: &super::catalog_duplicates::DecisionCommand,
    ) -> Result<super::catalog_duplicates::CommandOutcome, LibraryError> {
        use super::catalog_duplicates::CommandOutcome;
        let body = serde_json::to_vec(command).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let request = self.coded_agent()?.post(self.endpoint("/v1/mobile-catalog/duplicates/decisions")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(&body);
        let mut response = self.coded_request(request)?;
        match response.status().as_u16() {
            200 => Ok(CommandOutcome::Recorded),
            404 => Ok(CommandOutcome::Unsupported),
            422 => Ok(CommandOutcome::Refused),
            status => match catalog_duplicate_status_error(status, &mut response) {
                (Some(code), _) if code == "duplicateCandidateMissing" => Ok(CommandOutcome::CandidateMissing),
                (Some(code), _) if code == "duplicateDecisionConflict" || code == "operationConflict" => {
                    Ok(CommandOutcome::Refused)
                }
                (_, error) => Err(error),
            },
        }
    }

    /// Upload one chunk of the PC's unread release events (publisher token). `None` when the
    /// route is absent (an older server).
    pub(crate) fn publish_release_unread(
        &self,
        token: &str,
        body: &[u8],
    ) -> Result<Option<super::collection_releases::ReleaseUploadResult>, LibraryError> {
        if body.len() > 4 * 1024 * 1024 {
            return Err(LibraryError::ReleaseSyncRejected(413));
        }
        let request = self.coded_agent()?.put(self.endpoint("/v1/collections/releases/unread")?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(body);
        let mut response = self.coded_request(request)?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(release_status_error(status, &mut response)),
        }
        Ok(Some(read_json_bounded(&mut response, 1024 * 1024)?))
    }

    /// One page of the release read log (publisher token), `after` exclusive. `None` when the
    /// route is absent.
    pub(crate) fn release_reads(
        &self,
        token: &str,
        after: i64,
        limit: i64,
    ) -> Result<Option<super::collection_releases::ReadPage>, LibraryError> {
        if !(0..=super::collection_releases::MAX_CURSOR).contains(&after) || !(1..=200).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = format!("/v1/collections/releases/reads?after={after}&limit={limit}");
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint(&path)?).header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            status => return Err(release_status_error(status, &mut response)),
        }
        let page = read_json_bounded::<super::collection_releases::ReadPage>(&mut response, 1024 * 1024)?;
        super::collection_releases::validate_read_page(&page, after, limit)?;
        Ok(Some(page))
    }

    /// The server's last completed release generation (read through the listing route, which
    /// also accepts the publisher role). `None` before the first complete upload.
    pub(crate) fn release_generation(&self, token: &str) -> Result<Option<i64>, LibraryError> {
        #[derive(serde::Deserialize)]
        struct Listing { generation: Option<String> }
        let mut response = self.coded_request(self.coded_agent()?.get(self.endpoint("/v1/collections/releases?limit=1")?)
            .header("Authorization", bearer(token)?).call())?;
        match response.status().as_u16() {
            200 => {}
            status => return Err(release_status_error(status, &mut response)),
        }
        read_json_bounded::<Listing>(&mut response, 1024 * 1024)?
            .generation
            .map(|value| value.parse::<i64>().map_err(|_| LibraryError::ReleaseSyncInvalid))
            .transpose()
    }

    /// One page of the bind-request log (publisher token), `after` exclusive. With `etag`
    /// (the tag of the page last read at this `after`) an unchanged log answers `NotModified`.
    pub(crate) fn collection_binding_log(
        &self,
        token: &str,
        after: i64,
        limit: i64,
        etag: Option<&str>,
    ) -> Result<super::collection_bindings::LogRead, LibraryError> {
        use super::collection_bindings::{validate_log_page, BindLogPage, LogRead, MAX_CURSOR};
        if !(0..=MAX_CURSOR).contains(&after) || !(1..=200).contains(&limit) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let path = format!("/v1/collections/bindings/log?after={after}&limit={limit}");
        let mut request = self.coded_agent()?.get(self.endpoint(&path)?).header("Authorization", bearer(token)?);
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let mut response = self.coded_request(request.call())?;
        match response.status().as_u16() {
            200 => {}
            304 if etag.is_some() => return Ok(LogRead::NotModified),
            404 => return Ok(LogRead::Unsupported),
            status => return Err(binding_status_error(status, &mut response)),
        }
        let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let page = read_json_bounded::<BindLogPage>(&mut response, 2 * 1024 * 1024)?;
        validate_log_page(&page, after, limit)?;
        Ok(LogRead::Page { page, etag })
    }

    /// Report the PC's outcome of one bind request (publisher token).
    pub(crate) fn report_collection_binding_result(
        &self,
        token: &str,
        request_id: i64,
        result: &super::collection_bindings::BindResult,
    ) -> Result<super::collection_bindings::ResultOutcome, LibraryError> {
        use super::collection_bindings::{ResultOutcome, MAX_CURSOR};
        if !(1..=MAX_CURSOR).contains(&request_id) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let body = serde_json::to_vec(result).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let path = format!("/v1/collections/bindings/requests/{request_id}/result");
        let request = self.coded_agent()?.post(self.endpoint(&path)?)
            .header("Authorization", bearer(token)?).content_type("application/json").send(&body);
        let mut response = self.coded_request(request)?;
        match response.status().as_u16() {
            200 => Ok(ResultOutcome::Recorded),
            status => {
                #[derive(serde::Deserialize)]
                struct Coded { detail: serde_json::Value }
                let code = if matches!(status, 404 | 409) {
                    read_json_bounded::<Coded>(&mut response, 16 * 1024).ok()
                        .and_then(|body| body.detail.get("code").and_then(|c| c.as_str()).map(str::to_owned))
                } else {
                    None
                };
                match (status, code.as_deref()) {
                    (409, Some("bindResultConflict")) => Ok(ResultOutcome::Conflict),
                    (404, Some("bindRequestNotFound")) => Ok(ResultOutcome::NotFound),
                    // A plain 404 is an older server without the route.
                    (404, _) => Ok(ResultOutcome::Unsupported),
                    (401 | 403, _) => Err(LibraryError::CloudUnauthorized),
                    (422, _) => Err(LibraryError::BindingSyncInvalid),
                    (status, _) => Err(LibraryError::BindingSyncRejected(status)),
                }
            }
        }
    }

    fn coded_agent(&self) -> Result<ureq::Agent, LibraryError> {
        Ok(crate::http_agent::agent(
            ureq::Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_connect(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_request(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_send_body(Some(UPLOAD_BODY_TIMEOUT))
                .timeout_recv_response(Some(SHORT_NETWORK_TIMEOUT))
                .timeout_recv_body(Some(SHORT_NETWORK_TIMEOUT))
                .build(),
        ))
    }

    fn coded_request(
        &self,
        response: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<ureq::http::Response<ureq::Body>, LibraryError> {
        response.map_err(|error| match error {
            ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
            _ => LibraryError::CloudRequestUnavailable,
        })
    }

    pub(crate) fn publish_album_replica(&self, token: &str, snapshot: &serde_json::Value) -> Result<(), LibraryError> {
        let body = serde_json::to_vec(snapshot).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent.put(self.endpoint("/v1/library/album-snapshot")?)
            .header("Authorization", bearer(token)?)
            .content_type("application/json").send(&body)
            .map_err(|error| match error {
                ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
                _ => LibraryError::CloudRequestUnavailable,
            })?;
        Ok(())
    }

    pub(crate) fn publish_classification_snapshot(
        &self,
        token: &str,
        snapshot: &ClassificationSnapshotPublish,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(snapshot).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .put(self.endpoint("/v1/classifications")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(|error| match error {
                ureq::Error::StatusCode(status) => {
                    LibraryError::CloudClassificationsPublishRejected(status)
                }
                ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
                _ => LibraryError::CloudRequestUnavailable,
            })?;
        Ok(())
    }

    pub(crate) fn publish_saved_x_media_snapshot(
        &self,
        token: &str,
        snapshot: &SavedXMediaSnapshotPublish,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(snapshot).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .put(self.endpoint("/v1/saved-x-media")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(|error| match error {
                ureq::Error::StatusCode(status) => {
                    LibraryError::CloudSavedXMediaPublishRejected(status)
                }
                ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
                _ => LibraryError::CloudRequestUnavailable,
            })?;
        Ok(())
    }

    /// CLOUD-006 복제 prepare. 멱등: 같은 asset_id 재호출은 같은 키를 돌려준다.
    pub(crate) fn replication_prepare(
        &self,
        request: super::models::ReplicationPrepareRequest<'_>,
        token: &str,
    ) -> Result<super::models::ReplicationPrepareResponse, LibraryError> {
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(&request).map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/replication/prepare")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(|error| map_api_error(error, LibraryError::CloudReplicationPrepareRejected))?;
        read_json(&mut response)
    }

    /// CLOUD-006 복제 commit. 원자적으로 메타데이터 + 분류 관계를 커밋한다.
    pub(crate) fn commit_replication(
        &self,
        request: &super::models::ReplicationCommitRequest,
        token: &str,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(request).map_err(|_| LibraryError::InvalidCloudResponse)?;
        self.agent
            .post(self.endpoint("/v1/replication/commit")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map(|_| ())
            .map_err(|error| map_api_error(error, LibraryError::CloudReplicationCommitRejected))
    }

    /// 복제 variant(썸네일 등) 업로드: presign → R2 PUT. 원본 업로드는
    /// upload_asset이 담당하고, 이 메서드는 임의 variant 하나를 올린다.
    pub(crate) fn upload_replication_variant(
        &self,
        object_key: &str,
        content_type: &str,
        bytes: Vec<u8>,
        sha256: &str,
        token: &str,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let presign_body = serde_json::to_vec(&PresignUploadRequest {
            object_key,
            content_type,
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/uploads/presign")?)
            .header("Authorization", &authorization)
            .content_type("application/json")
            .send(&presign_body)
            .map_err(map_presign_error)?;
        let presign: PresignUploadResponse = read_json(&mut response)?;
        validate_presign(&presign, object_key)?;

        let mut request = self.agent.put(&presign.upload_url);
        for (name, value) in &presign.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        request.send(&bytes[..]).map_err(map_upload_error)?;
        let _ = sha256;
        Ok(())
    }

    pub(crate) fn upload_metadata_backup(
        &self,
        source: File,
        token: &str,
    ) -> Result<(), LibraryError> {
        let authorization = bearer(token)?;
        let presign_body = serde_json::to_vec(&PresignUploadRequest {
            object_key: METADATA_BACKUP_OBJECT_KEY,
            content_type: "application/vnd.sqlite3",
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/uploads/presign")?)
            .header("Authorization", &authorization)
            .content_type("application/json")
            .send(&presign_body)
            .map_err(map_presign_error)?;
        let presign: PresignUploadResponse = read_json(&mut response)?;
        validate_presign(&presign, METADATA_BACKUP_OBJECT_KEY)?;
        let mut request = self.agent.put(&presign.upload_url);
        for (name, value) in &presign.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        request.send(source).map_err(map_upload_error)?;
        Ok(())
    }

    pub(crate) fn download_metadata_backup(
        &self,
        destination: &std::path::Path,
        token: &str,
    ) -> Result<u64, LibraryError> {
        let authorization = bearer(token)?;
        let mut response = self
            .agent
            .get(self.endpoint("/v1/library/metadata-backup")?)
            .header("Authorization", authorization)
            .call()
            .map_err(|error| match error {
                ureq::Error::StatusCode(404) => LibraryError::CloudMetadataBackupNotFound,
                other => map_api_error(other, |_| LibraryError::InvalidCloudResponse),
            })?;
        let ticket: MetadataBackupTicket = read_json(&mut response)?;
        if ticket
            .size_bytes
            .is_some_and(|size| size > MAX_METADATA_BACKUP_BYTES)
        {
            return Err(LibraryError::CloudMetadataBackupTooLarge);
        }
        let download_url = url::Url::parse(&ticket.download_url)
            .map_err(|_| LibraryError::InvalidCloudResponse)?;
        if !matches!(download_url.scheme(), "http" | "https") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut request = self.agent.get(download_url.as_str());
        for (name, value) in &ticket.required_headers {
            let name = ureq::http::header::HeaderName::try_from(name.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            let value = ureq::http::header::HeaderValue::try_from(value.as_str())
                .map_err(|_| LibraryError::InvalidCloudResponse)?;
            request = request.header(name, value);
        }
        let mut response = request
            .call()
            .map_err(|error| map_api_error(error, |_| LibraryError::CloudRequestUnavailable))?;
        let mut file = File::create(destination).map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        })?;
        let mut reader = response
            .body_mut()
            .as_reader()
            .take(MAX_METADATA_BACKUP_BYTES.saturating_add(1));
        let copied = std::io::copy(&mut reader, &mut file)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if copied > MAX_METADATA_BACKUP_BYTES {
            return Err(LibraryError::CloudMetadataBackupTooLarge);
        }
        Ok(copied)
    }

    pub(crate) fn restore_media_tickets(
        &self,
        items: &[(&str, &str)],
        token: &str,
    ) -> Result<Vec<RestoreMediaTicket>, LibraryError> {
        if items.len() > 50 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(&MediaTicketBatchRequest {
            items: items
                .iter()
                .map(|(asset_id, variant)| MediaTicketBatchItem { asset_id, variant })
                .collect(),
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/library/media-tickets")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(|error| map_api_error(error, |_| LibraryError::InvalidCloudResponse))?;
        let response: MediaTicketBatchResponse = read_json(&mut response)?;
        Ok(response
            .items
            .into_iter()
            .map(|item| RestoreMediaTicket {
                asset_id: item.asset_id,
                variant: item.variant,
                url: item.ok.then_some(item.url).flatten(),
                size_bytes: item.size_bytes,
                error: if item.ok {
                    None
                } else {
                    item.error.or(Some("unavailable".into()))
                },
            })
            .collect())
    }

    pub(crate) fn download_restore_media(
        &self,
        ticket: &RestoreMediaTicket,
        destination: &std::path::Path,
    ) -> Result<u64, LibraryError> {
        let url = ticket
            .url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        let parsed = url::Url::parse(url).map_err(|_| LibraryError::InvalidCloudResponse)?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut response = self
            .agent
            .get(parsed.as_str())
            .call()
            .map_err(|error| map_api_error(error, |_| LibraryError::CloudRequestUnavailable))?;
        let mut file = File::create(destination).map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        })?;
        let maximum = ticket.size_bytes.unwrap_or(16 * 1024 * 1024 * 1024);
        let mut reader = response
            .body_mut()
            .as_reader()
            .take(maximum.saturating_add(1));
        let copied = std::io::copy(&mut reader, &mut file)
            .map_err(|_| LibraryError::CloudRequestUnavailable)?;
        if copied > maximum || ticket.size_bytes.is_some_and(|expected| expected != copied) {
            return Err(LibraryError::InvalidCloudResponse);
        }
        Ok(copied)
    }

    pub(crate) fn thumbnail_remote_sizes(
        &self,
        asset_ids: &[String],
        token: &str,
    ) -> Result<Vec<(String, Result<u64, String>)>, LibraryError> {
        if asset_ids.len() > 50 {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let authorization = bearer(token)?;
        let body = serde_json::to_vec(&MediaTicketBatchRequest {
            items: asset_ids
                .iter()
                .map(|asset_id| MediaTicketBatchItem {
                    asset_id,
                    variant: "thumbnail",
                })
                .collect(),
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)?;
        let mut response = self
            .agent
            .post(self.endpoint("/v1/library/media-tickets")?)
            .header("Authorization", authorization)
            .content_type("application/json")
            .send(&body)
            .map_err(|error| map_api_error(error, |_| LibraryError::InvalidCloudResponse))?;
        let response: MediaTicketBatchResponse = read_json(&mut response)?;
        Ok(response
            .items
            .into_iter()
            .map(|item| {
                let result = if item.ok {
                    item.size_bytes
                        .ok_or_else(|| "missing size_bytes".to_owned())
                } else {
                    Err(item
                        .error
                        .unwrap_or_else(|| "remote unavailable".to_owned()))
                };
                (item.asset_id, result)
            })
            .collect())
    }

    fn endpoint(&self, path: &str) -> Result<String, LibraryError> {
        self.base_url
            .join(path)
            .map(|url| url.to_string())
            .map_err(|_| LibraryError::InvalidCloudSyncConfig)
    }
}

fn validate_presign(
    response: &PresignUploadResponse,
    requested_object_key: &str,
) -> Result<(), LibraryError> {
    let upload_url =
        url::Url::parse(&response.upload_url).map_err(|_| LibraryError::InvalidCloudResponse)?;
    if response.method != "PUT"
        || response.object_key != requested_object_key
        || response.expires_in == 0
        || !matches!(upload_url.scheme(), "http" | "https")
    {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<T, LibraryError> {
    read_json_bounded(response, MAX_RESPONSE_BYTES)
}

fn read_json_bounded<T: serde::de::DeserializeOwned>(
    response: &mut ureq::http::Response<ureq::Body>,
    limit: usize,
) -> Result<T, LibraryError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::CloudRequestUnavailable)?;
    if bytes.len() > limit {
        return Err(LibraryError::InvalidCloudResponse);
    }
    serde_json::from_slice(&bytes).map_err(|_| LibraryError::InvalidCloudResponse)
}

fn read_body_bounded(
    response: &mut ureq::http::Response<ureq::Body>,
    limit: usize,
) -> Result<Vec<u8>, LibraryError> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::CloudRequestUnavailable)?;
    if bytes.len() > limit {
        return Err(LibraryError::InvalidCloudResponse);
    }
    Ok(bytes)
}

/// `/v1/sync/status` failures, shared by the plain and the conditional read.
///
/// * an older server without the route (404) cannot report its authority state, so it
///   is `RestoreAuthorityUnknown`, never "no authority";
/// * authorization/transport problems are reported as themselves: a restore still
///   refuses, but the user gets an actionable reason instead of an authority error.
fn map_sync_status_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(404) => LibraryError::RestoreAuthorityUnknown,
        other => map_api_error(other, |_| LibraryError::InvalidCloudResponse),
    }
}

/// Parse and validate one `/v1/sync/status` document (see [`CloudClient::sync_status`]).
fn parse_sync_status(bytes: &[u8]) -> Result<SyncStatus, LibraryError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Domain {
        domain: String,
        library_id: String,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        protocol_version: i64,
        active: bool,
        library_id: Option<String>,
        domains: Vec<Domain>,
        // Any JSON value: a malformed block must not make the document unreadable.
        #[serde(default)]
        publisher_logs: Option<serde_json::Value>,
    }
    // A body this client cannot parse at all is an unreadable authority state.
    let status: Status =
        serde_json::from_slice(bytes).map_err(|_| LibraryError::RestoreAuthorityUnknown)?;
    if status.protocol_version != SYNC_PROTOCOL_VERSION {
        return Err(LibraryError::SyncProtocolUnsupported);
    }
    if status.domains.len() > MAX_SYNC_DOMAINS {
        return Err(LibraryError::RestoreAuthorityUnknown);
    }
    let domains = status
        .domains
        .into_iter()
        .map(|domain| SyncAuthorityDomain {
            domain: domain.domain,
            library_id: domain.library_id,
            epoch: domain.epoch,
            contract_version: domain.contract_version,
            cursor: domain.cursor,
        })
        .collect::<Vec<_>>();
    let status = SyncStatus {
        protocol_version: status.protocol_version,
        active: status.active,
        library_id: status.library_id,
        domains,
        publisher_logs: status.publisher_logs.as_ref().and_then(PublisherLogs::parse),
    };
    if !status.is_consistent() {
        return Err(LibraryError::RestoreAuthorityUnknown);
    }
    Ok(status)
}

/// Conditional-read scope: the endpoint base plus a digest of the credential, so a
/// cached body is never presented across an account or endpoint change. The raw token
/// is never kept.
fn conditional_scope(base_url: &url::Url, token: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(token.trim().as_bytes());
    let hex: String = digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{base_url}#{hex}")
}

/// Bounded, process-wide ETag cache for the small polled status documents.
///
/// `CloudClient` is built per call, so the cache cannot live on it. Entries are keyed
/// by [`conditional_scope`] and path; storing an entry under a new credential for the
/// same endpoint drops that endpoint's entries for every other credential, and the
/// oldest entries are evicted beyond a small bound. Correctness never depends on an
/// entry surviving: a missing entry just means an unconditional read.
pub(crate) struct ConditionalCache {
    entries: std::sync::Mutex<std::collections::VecDeque<ConditionalEntry>>,
}

struct ConditionalEntry {
    scope: String,
    path: String,
    etag: String,
    body: Vec<u8>,
}

const MAX_CONDITIONAL_ENTRIES: usize = 32;

impl ConditionalCache {
    fn lookup(&self, scope: &str, path: &str) -> Option<(String, Vec<u8>)> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries
            .iter()
            .find(|entry| entry.scope == scope && entry.path == path)
            .map(|entry| (entry.etag.clone(), entry.body.clone()))
    }

    fn store(&self, scope: &str, path: &str, etag: Option<String>, body: &[u8]) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let base = scope.rsplit_once('#').map_or(scope, |(base, _)| base);
        entries.retain(|entry| {
            let same_base = entry
                .scope
                .rsplit_once('#')
                .map_or(entry.scope.as_str(), |(b, _)| b)
                == base;
            !(entry.scope == scope && entry.path == path) && !(same_base && entry.scope != scope)
        });
        // A server that sends no tag (an older build) is read unconditionally every time.
        let Some(etag) = etag.filter(|etag| !etag.is_empty() && etag.len() <= 256) else {
            return;
        };
        entries.push_back(ConditionalEntry {
            scope: scope.to_owned(),
            path: path.to_owned(),
            etag,
            body: body.to_vec(),
        });
        while entries.len() > MAX_CONDITIONAL_ENTRIES {
            entries.pop_front();
        }
    }
}

fn conditional_cache() -> &'static ConditionalCache {
    static CACHE: std::sync::OnceLock<ConditionalCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| ConditionalCache {
        entries: std::sync::Mutex::new(std::collections::VecDeque::new()),
    })
}

fn map_bookmark_status_error(error: ureq::Error) -> LibraryError {
    map_bookmark_read_error(error, LibraryError::CatalogBookmarkSyncRejected(409))
}

fn parse_mobile_catalog_authority(bytes: &[u8]) -> Result<MobileCatalogAuthority, LibraryError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Capabilities {
        #[serde(default)]
        bookmark_write: bool,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        authority_library_id: Option<String>,
        authority_epoch: Option<i64>,
        authority_contract_version: Option<i64>,
        authority_cursor: Option<i64>,
        // A server older than the capability field advertises nothing, which is
        // read as "no write accepted" rather than as a malformed response.
        #[serde(default)]
        capabilities: Option<Capabilities>,
    }
    let status: Status =
        serde_json::from_slice(bytes).map_err(|_| LibraryError::InvalidCloudResponse)?;
    Ok(MobileCatalogAuthority {
        library_id: status.authority_library_id,
        epoch: status.authority_epoch,
        contract_version: status.authority_contract_version,
        cursor: status.authority_cursor,
        bookmark_write: status
            .capabilities
            .is_some_and(|capabilities| capabilities.bookmark_write),
    })
}

fn map_presign_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudPresignRejected)
}

fn map_registration_error(error: ureq::Error) -> LibraryError {
    if matches!(error, ureq::Error::StatusCode(409)) {
        return LibraryError::CloudObjectKeyConflict;
    }
    map_api_error(error, LibraryError::CloudAssetRegistrationRejected)
}

/// Bookmark reads distinguish *authority state* from transient transport failure.
///
/// 503 is the server's "authority ambiguous / unavailable" state, which is a
/// retryable authority problem, not a bad request. 409 and 422 mean the caller's
/// stored library/epoch/contract/cursor no longer describes the live authority,
/// so they surface as the documented recovery states rather than a generic
/// network error that a blind retry could never resolve.
/// Map an Album transport failure onto a distinguishable recovery state.
///
/// The Album domain keeps its states separate for the same reason the bookmark
/// domain does: "authority inactive", "stored identity no longer matches", "the
/// server speaks another contract" and "the transport failed" demand different
/// actions, and flattening them into one network error would leave a blind retry as
/// the only response to all four.
fn map_album_read_error(error: ureq::Error, conflict: LibraryError) -> LibraryError {
    match error {
        ureq::Error::StatusCode(409) => conflict,
        // The route rejects an unknown contractVersion with 422, and this client only
        // ever sends the version it was compiled against.
        ureq::Error::StatusCode(422) => LibraryError::AlbumContractUnsupported,
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(status) => LibraryError::AlbumSyncRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// Map a Character exclusion-log read failure onto a distinguishable recovery state.
///
/// `409` on this route means the PC's stored cursor is ahead of the server's log or the
/// server is bound to another library; both are identity/recovery states rather than
/// transport failures, so they are never collapsed into a blind retry.
fn map_character_exclusion_read_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(409) => LibraryError::CharacterExclusionCursorRejected,
        ureq::Error::StatusCode(422) => LibraryError::CharacterExclusionContractUnsupported,
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        // Only a definite absence of the route is a legacy server. Any other status is a
        // real failure and must stay visible instead of being read as "feature missing".
        ureq::Error::StatusCode(404) => LibraryError::CharacterExclusionUnsupported,
        ureq::Error::StatusCode(status) => LibraryError::CharacterExclusionSyncRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// Map a Character publication failure.
///
/// The route now requires the publisher credential. A `401`/`403` here is an authorization
/// outcome the caller must surface as a credential problem rather than as a retryable
/// transport fault, because retrying with the same shared token can never succeed.
fn map_character_publication_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(409) => LibraryError::CharacterPublicationConflict,
        ureq::Error::StatusCode(413) => LibraryError::CharacterPublicationTooLarge,
        ureq::Error::StatusCode(422) => LibraryError::InvalidCloudResponse,
        ureq::Error::StatusCode(503) => LibraryError::CloudRequestUnavailable,
        ureq::Error::StatusCode(status) => LibraryError::CharacterPublicationRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// Map a non-200 Album status that carried no coded body.
fn map_album_status(status: u16) -> LibraryError {
    match status {
        401 | 403 => LibraryError::CloudUnauthorized,
        422 => LibraryError::AlbumContractUnsupported,
        other => LibraryError::AlbumSyncRejected(other),
    }
}

/// Map a Classification transport failure onto a distinguishable recovery state.
///
/// The Classification domain keeps its states separate for the same reason Album and
/// Bookmark do: "authority inactive", "stored identity no longer matches", "the server
/// speaks another contract", a changed baseline, an expired cursor and "the transport
/// failed" demand different actions, and flattening them into one network error would
/// leave a blind retry as the only response to all of them.
fn map_classification_read_error(error: ureq::Error, conflict: LibraryError) -> LibraryError {
    match error {
        ureq::Error::StatusCode(409) => conflict,
        // The shared authority registry rejects an unsupported contract version with
        // 409 `authorityContractUnsupported` (handled by the coded-body mapping) while
        // the route's own validation uses 422; this client only ever sends the version
        // it was compiled against, so both mean the server moved on.
        ureq::Error::StatusCode(422) => LibraryError::ClassificationContractUnsupported,
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(status) => LibraryError::ClassificationSyncRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// Map a non-200 Classification status that carried no coded body.
fn map_classification_status(status: u16) -> LibraryError {
    match status {
        401 | 403 => LibraryError::CloudUnauthorized,
        422 => LibraryError::ClassificationContractUnsupported,
        // 503 is the shared registry's "authority ambiguous" state on the read routes,
        // which is a retryable authority problem rather than a malformed request.
        503 => LibraryError::ClassificationSyncRejected(503),
        other => LibraryError::ClassificationSyncRejected(other),
    }
}

/// Translate a coded Classification 409 body into the specific recovery state it names.
///
/// Every coded reason here shares status 409 and none is interchangeable: expiry needs
/// a fresh baseline, `cursorAhead` is identity skew, a changed baseline needs the pages
/// re-read from a fresh snapshot, and an inactive or mismatched authority is an identity
/// problem no retry can fix. `fallback` is the reading for an unrecognized code, which
/// each route chooses by what its own retry would cost: the changes route resumes from
/// its cursor, while the baseline route can only re-read.
fn classification_conflict_error(
    detail: serde_json::Value,
    fallback: LibraryError,
) -> LibraryError {
    let code = detail.get("code").and_then(|value| value.as_str()).unwrap_or("");
    match code {
        "cursorExpired" => LibraryError::ClassificationCursorExpired,
        "cursorAhead" => LibraryError::ClassificationCursorAhead,
        "baselineChanged" | "classificationBaselineChanged" => {
            LibraryError::ClassificationBaselineChanged
        }
        "authorityInactive" => LibraryError::ClassificationAuthorityInactive,
        "authorityLibraryMismatch" | "authorityAmbiguous" => {
            LibraryError::ClassificationAuthorityMismatch
        }
        "authorityContractUnsupported" => LibraryError::ClassificationContractUnsupported,
        _ => fallback,
    }
}

/// Translate a coded Album 409 body into the specific recovery state it names.
///
/// Every coded reason here shares status 409 and none is interchangeable: expiry needs
/// a fresh baseline, `cursorAhead` means the identity is skewed, a changed baseline
/// needs the pages re-read from a fresh snapshot, and an inactive or mismatched
/// authority is an identity problem no retry can fix. `fallback` is the reading for an
/// unrecognized code, which each route chooses by what its own retry would cost: the
/// changes route resumes from its cursor, while the baseline route can only re-read.
fn album_conflict_error(detail: serde_json::Value, fallback: LibraryError) -> LibraryError {
    let code = detail.get("code").and_then(|value| value.as_str()).unwrap_or("");
    match code {
        "cursorExpired" => LibraryError::AlbumCursorExpired,
        "cursorAhead" => LibraryError::AlbumCursorAhead,
        "baselineChanged" | "albumBaselineChanged" => LibraryError::AlbumBaselineChanged,
        "authorityInactive" => LibraryError::AlbumAuthorityInactive,
        "authorityLibraryMismatch" | "authorityAmbiguous" => LibraryError::AlbumAuthorityMismatch,
        "authorityContractUnsupported" => LibraryError::AlbumContractUnsupported,
        _ => fallback,
    }
}

/// What a coded Album rejection means for the intent that produced it.
///
/// The distinction is the whole point of reading the code: an authority or protocol
/// state is not a user conflict, and a semantic structural rejection is not a contract
/// upgrade. Conflating them either blocks a perfectly retryable intent behind a
/// misleading "conflict", or tells the user to upgrade a client that is already correct.
enum AlbumRejection {
    /// The stored library/epoch/contract no longer describes the live authority, or the
    /// server speaks a protocol this build cannot. Neither is recoverable by retrying
    /// the same intent, and neither is something the user resolved.
    Authority(LibraryError),
    /// The authority understood the command and refused its content. The intent is
    /// durable and the user must decide, so it becomes a blocked queue row.
    Structural(&'static str),
    /// No usable coded meaning: a lost or unknown result, which stays retryable with the
    /// identical operation id and payload so the server's receipt resolves it.
    Retryable,
    /// The named Asset is tombstoned; the intent is obsolete and is dropped.
    Dropped,
}

/// Map a coded Album rejection onto its handling.
///
/// The codes are the ones `server/lakomics-api/album_authority.py` actually returns.
/// `operationConflict` is deliberately an integrity failure rather than a user conflict:
/// it means one operation id was reused with different content, which is a bug in a
/// client, and reporting it as "another device changed this" would be a lie.
fn classify_album_rejection(code: &str) -> AlbumRejection {
    match code {
        // Authority identity and contract skew.
        "authorityInactive" => AlbumRejection::Authority(LibraryError::AlbumAuthorityInactive),
        "authorityLibraryMismatch" | "authorityAmbiguous" => {
            AlbumRejection::Authority(LibraryError::AlbumAuthorityMismatch)
        }
        "authorityContractUnsupported" | "unsupportedAlbumCommand" => {
            AlbumRejection::Authority(LibraryError::AlbumContractUnsupported)
        }
        // The server understood the transport but rejected the command's shape. Calling
        // this a contract *upgrade* would be wrong — this build speaks the negotiated
        // contract — so it gets its own error carrying the server's code, and the intent
        // stays deliverable rather than being discarded or blocked as the user's fault.
        "invalidAlbumCommand" | "invalidAlbumRevision" | "emptyAlbumName"
        | "albumNameTooLong" | "invalidAlbumAppearance" | "invalidAlbumBaseline" => {
            AlbumRejection::Authority(LibraryError::AlbumCommandRejected {
                code: code.to_owned(),
            })
        }
        "operationConflict" => AlbumRejection::Authority(LibraryError::AlbumOperationConflict),
        // `albumBaselineChanged` belongs to the baseline/activation routes, which never
        // reach this path; a command route returning it is an integrity failure, so the
        // intent is preserved rather than blocked.
        "albumBaselineChanged" => AlbumRejection::Retryable,
        // Meaningful entity/structure rejections: the user's intent is real, the content
        // was refused, and the intent must be preserved for a decision.
        "revisionConflict" => AlbumRejection::Structural("revisionConflict"),
        "duplicateAlbumName" => AlbumRejection::Structural("duplicateAlbumName"),
        "albumCycle" => AlbumRejection::Structural("albumCycle"),
        "albumHasChildren" => AlbumRejection::Structural("albumHasChildren"),
        "albumExists" => AlbumRejection::Structural("albumExists"),
        "albumNotFound" => AlbumRejection::Structural("albumNotFound"),
        "invalidAlbumParent" => AlbumRejection::Structural("invalidAlbumParent"),
        "invalidAlbumMembership" => AlbumRejection::Structural("invalidAlbumMembership"),
        // Definitive: a tombstoned Asset can never gain or lose membership, and retrying
        // would block every later Album intent behind this one.
        "assetTombstoned" => AlbumRejection::Dropped,
        // Activation-only codes. A command route returning one is an integrity failure, so
        // the intent is preserved rather than blocked on the user.
        "albumAuthorityActive" | "albumMembershipAssetsMissing" | "albumSnapshotNotAuthorityReady"
        | "albumReplicaUnavailable" | "baselineChanged" | "baselinePageTooLarge" => {
            AlbumRejection::Retryable
        }
        _ => AlbumRejection::Retryable,
    }
}

/// What a coded Classification rejection means for the intent that produced it.
///
/// The distinction is the whole point of reading the code: an authority or protocol
/// state is not a user conflict, a semantic structural rejection is not a contract
/// upgrade, and only a desired-state revision conflict may be rebased.
enum ClassificationRejection {
    /// The stored library/epoch/contract no longer describes the live authority, or the
    /// server speaks a protocol this build cannot. Neither is recoverable by retrying
    /// the same intent, and neither is something the user resolved.
    Authority(LibraryError),
    /// The authority understood the command and refused its content. The intent is
    /// durable and the user must decide, so it becomes a blocked queue row — except for
    /// an assignment `revisionConflict`, which the caller rebases.
    Structural(&'static str),
    /// No usable coded meaning, or a transient cross-domain state: the intent stays
    /// pending and retries with the identical operation id and payload.
    Retryable,
    /// The named Asset is tombstoned; the intent is obsolete and is dropped.
    Dropped,
}

/// Map a coded Classification rejection onto its handling.
///
/// The codes are the ones `server/lakomics-api/classification_authority.py` actually
/// returns. `operationConflict` is deliberately an integrity failure rather than a user
/// conflict: it means one operation id was reused with different content, which is a
/// client bug, and reporting it as "another device changed this" would be a lie.
fn classify_classification_rejection(code: &str) -> ClassificationRejection {
    match code {
        // Authority identity and contract skew.
        "authorityInactive" => {
            ClassificationRejection::Authority(LibraryError::ClassificationAuthorityInactive)
        }
        "authorityLibraryMismatch" | "authorityAmbiguous" => {
            ClassificationRejection::Authority(LibraryError::ClassificationAuthorityMismatch)
        }
        "authorityContractUnsupported" | "unsupportedClassificationCommand" => {
            ClassificationRejection::Authority(LibraryError::ClassificationContractUnsupported)
        }
        // The server understood the transport but rejected the command's shape. Calling
        // this a contract *upgrade* would be false — this build speaks the negotiated
        // contract — so it gets its own error carrying the server's code, and the intent
        // stays deliverable rather than being discarded or blocked as the user's fault.
        "invalidClassificationCommand" | "invalidClassificationRevision"
        | "invalidClassificationKind" | "invalidClassificationAppearance"
        | "invalidClassificationBaseline" => ClassificationRejection::Authority(
            LibraryError::ClassificationCommandRejected {
                code: code.to_owned(),
            },
        ),
        "operationConflict" => {
            ClassificationRejection::Authority(LibraryError::ClassificationOperationConflict)
        }
        // Meaningful entity/structure rejections: the user's intent is real, the content
        // was refused, and the intent must be preserved for a decision. `revisionConflict`
        // reaches here for structural commands; the assignment lineage rebases it instead.
        "revisionConflict" => ClassificationRejection::Structural("revisionConflict"),
        // Definitive: a tombstoned Asset can never be (re)assigned, and retrying would
        // block every later Classification intent behind this one.
        "assetTombstoned" => ClassificationRejection::Dropped,
        "duplicateClassificationName" => {
            ClassificationRejection::Structural("duplicateClassificationName")
        }
        "classificationCycle" => ClassificationRejection::Structural("classificationCycle"),
        "classificationHasChildren" => {
            ClassificationRejection::Structural("classificationHasChildren")
        }
        "classificationExists" => ClassificationRejection::Structural("classificationExists"),
        "classificationNotFound" => ClassificationRejection::Structural("classificationNotFound"),
        "invalidClassificationParent" => {
            ClassificationRejection::Structural("invalidClassificationParent")
        }
        "protectedClassification" => {
            ClassificationRejection::Structural("protectedClassification")
        }
        // Name refusals the user resolves by editing the name, so they block on the user
        // rather than retrying forever. The server's own code is what is stored, so the
        // conflict surface can report which rule was broken.
        "emptyClassificationName" => {
            ClassificationRejection::Structural("emptyClassificationName")
        }
        "classificationNameTooLong" => {
            ClassificationRejection::Structural("classificationNameTooLong")
        }
        // The server does not hold the named Asset as linkable (not committed yet, or
        // unknown). This is a cross-domain ordering state, not a user conflict, so it is
        // returned as a coded outcome and the send half decides per intent: an Asset whose
        // upload is still outstanding waits without holding up other intents, and an
        // assignment that can never apply is retired with a recorded reason.
        "invalidClassificationAssignment" => {
            ClassificationRejection::Structural("invalidClassificationAssignment")
        }
        // Everything else — the activation-only codes and any code this build does not
        // recognize — stays pending and retries with the identical operation id and
        // payload.
        _ => ClassificationRejection::Retryable,
    }
}

impl AlbumCommandResult {
    /// Prove this accepted result describes the command that was sent.
    ///
    /// The caller retires the queue row keyed by the *stored* operation id and writes the
    /// returned revision into the confirmed caches. An echo that names another operation,
    /// entity, epoch or contract would therefore retire the wrong intent and record state
    /// belonging to something else — corrupting the confirmation cache rather than merely
    /// losing a response. Every identity field must therefore agree exactly, and the
    /// projection must be the one kind the command targets.
    pub(crate) fn validate_against(&self, command: &serde_json::Value) -> Result<(), LibraryError> {
        let field = |key: &str| command.get(key).and_then(|value| value.as_str());
        let number = |key: &str| command.get(key).and_then(|value| value.as_i64());
        if field("libraryId") != Some(self.library_id.as_str())
            || field("operationId") != Some(self.operation_id.as_str())
            || field("commandType") != Some(self.command_type.as_str())
            || number("epoch") != Some(self.epoch)
            || number("contractVersion") != Some(self.contract_version)
            || self.contract_version != crate::library::album_authority::ALBUM_CONTRACT_VERSION
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let album_id = field("albumId").ok_or(LibraryError::InvalidCloudResponse)?;
        match (&self.album, &self.membership) {
            // A membership command answers with the relation it was asked about.
            (None, Some(membership)) => {
                if membership.album_id != album_id
                    || field("assetId") != Some(membership.asset_id.as_str())
                {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
            // A structural command answers with its own Album projection.
            (Some(album), None) => {
                if album.id != album_id {
                    return Err(LibraryError::InvalidCloudResponse);
                }
            }
            // Both or neither: the result does not describe one typed delta.
            _ => return Err(LibraryError::InvalidCloudResponse),
        }
        Ok(())
    }
}

/// The coded 409 envelope this client reads before deciding the recovery.
#[derive(serde::Deserialize)]
struct AlbumCodedConflict {
    detail: serde_json::Value,
}

fn map_bookmark_read_error(error: ureq::Error, conflict: LibraryError) -> LibraryError {
    match error {
        ureq::Error::StatusCode(409) => conflict,
        // The route rejects an unknown contractVersion with 422; this client only
        // ever sends the version it was compiled against, so a 422 means the
        // server moved to a contract this build cannot speak.
        ureq::Error::StatusCode(422) => LibraryError::CatalogBookmarkContractUnsupported,
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(503) => LibraryError::CatalogBookmarkSyncRejected(503),
        ureq::Error::StatusCode(status) => LibraryError::CatalogBookmarkSyncRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// A command rejection keeps the authority state the caller needs to recover.
///
/// The route reports a stale `expectedRevision` as 409 with `code:
/// revisionConflict` and the current entity state; that body is parsed by the
/// caller, which disables `http_status_as_error` for this one request so the
/// response survives. Any other 409 means the stored library/epoch/contract no
/// longer describes the live authority, and 422 means the server speaks a version
/// contract this build cannot. None of these is a generic network failure, so
/// none is flattened into one.
fn map_bookmark_command_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(409) => LibraryError::CatalogBookmarkAuthorityMismatch,
        ureq::Error::StatusCode(422) => LibraryError::CatalogBookmarkContractUnsupported,
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(503) => LibraryError::CatalogBookmarkSyncRejected(503),
        ureq::Error::StatusCode(status) => LibraryError::CatalogBookmarkSyncRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// The `revisionConflict` 409 body: the current authoritative entity state.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictCurrent {
    desired_state: bool,
    entity_revision: i64,
}

#[derive(serde::Deserialize)]
#[serde(tag = "code")]
enum ConflictDetail {
    #[serde(rename = "revisionConflict")]
    Revision { current: ConflictCurrent },
    #[serde(other)]
    Other,
}

#[derive(serde::Deserialize)]
struct ConflictBody {
    detail: ConflictDetail,
}

#[derive(serde::Deserialize)]
#[serde(tag = "code")]
enum ChangesConflictDetail {
    #[serde(rename = "cursorExpired")]
    CursorExpired,
    #[serde(other)]
    Other,
}

#[derive(serde::Deserialize)]
struct ChangesConflictBody {
    detail: ChangesConflictDetail,
}

fn map_api_error(error: ureq::Error, rejected: fn(u16) -> LibraryError) -> LibraryError {
    match error {
        ureq::Error::StatusCode(401 | 403) => LibraryError::CloudUnauthorized,
        ureq::Error::StatusCode(status) => rejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

fn map_upload_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => LibraryError::CloudUploadRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

/// `PUT /v1/library/characters/review/feed` receipt.
#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct CharacterReviewFeedResult {
    pub revision: String,
}

/// Map a non-success status of the character review routes, reading a coded `409`.
fn character_review_status_error(status: u16, response: &mut ureq::http::Response<ureq::Body>) -> LibraryError {
    match status {
        401 | 403 => LibraryError::CloudUnauthorized,
        409 => {
            #[derive(serde::Deserialize)]
            struct Coded { detail: serde_json::Value }
            let code = read_json_bounded::<Coded>(response, 16 * 1024).ok()
                .and_then(|body| body.detail.get("code").and_then(|code| code.as_str()).map(str::to_owned));
            match code.as_deref() {
                Some("characterReviewUnsupported") => LibraryError::CharacterReviewUnsupported,
                Some("characterReviewFeedChanged") => LibraryError::CharacterPublicationConflict,
                _ => LibraryError::CharacterReviewCursorRejected,
            }
        }
        422 => LibraryError::CharacterReviewInvalid,
        status => LibraryError::CharacterReviewSyncRejected(status),
    }
}

/// Map a non-success status of the similarity review routes, reading a coded `409`.
fn similarity_review_status_error(status: u16, response: &mut ureq::http::Response<ureq::Body>) -> LibraryError {
    match status {
        401 | 403 => LibraryError::CloudUnauthorized,
        409 => {
            #[derive(serde::Deserialize)]
            struct Coded { detail: serde_json::Value }
            let code = read_json_bounded::<Coded>(response, 16 * 1024).ok()
                .and_then(|body| body.detail.get("code").and_then(|code| code.as_str()).map(str::to_owned));
            match code.as_deref() {
                Some("similarityReviewUnsupported") => LibraryError::SimilarityReviewUnsupported,
                Some("similarityReviewFeedChanged") => LibraryError::SimilarityReviewFeedConflict,
                _ => LibraryError::SimilarityReviewCursorRejected,
            }
        }
        422 => LibraryError::SimilarityReviewInvalid,
        status => LibraryError::SimilarityReviewSyncRejected(status),
    }
}

/// The coded error of a duplicate-edition route: `(code, error)`.
fn catalog_duplicate_status_error(
    status: u16,
    response: &mut ureq::http::Response<ureq::Body>,
) -> (Option<String>, LibraryError) {
    match status {
        401 | 403 => (None, LibraryError::CloudUnauthorized),
        409 => {
            #[derive(serde::Deserialize)]
            struct Coded { detail: serde_json::Value }
            let code = read_json_bounded::<Coded>(response, 16 * 1024).ok()
                .and_then(|body| body.detail.get("code").and_then(|code| code.as_str()).map(str::to_owned));
            let error = match code.as_deref() {
                Some("duplicateCursorRejected") => LibraryError::CatalogDuplicateCursorRejected,
                _ => LibraryError::CatalogDuplicateSyncRejected(409),
            };
            (code, error)
        }
        422 => (None, LibraryError::CatalogDuplicateInvalid),
        status => (None, LibraryError::CatalogDuplicateSyncRejected(status)),
    }
}

/// Map a non-success status of the bind-request log, reading a coded `409`.
fn binding_status_error(status: u16, response: &mut ureq::http::Response<ureq::Body>) -> LibraryError {
    match status {
        401 | 403 => LibraryError::CloudUnauthorized,
        409 => {
            #[derive(serde::Deserialize)]
            struct Coded { detail: serde_json::Value }
            let code = read_json_bounded::<Coded>(response, 16 * 1024).ok()
                .and_then(|body| body.detail.get("code").and_then(|c| c.as_str()).map(str::to_owned));
            match code.as_deref() {
                Some("bindCursorRejected") => LibraryError::BindingCursorRejected,
                _ => LibraryError::BindingSyncRejected(409),
            }
        }
        422 => LibraryError::BindingSyncInvalid,
        status => LibraryError::BindingSyncRejected(status),
    }
}

/// Map a non-success status of the release routes, reading a coded `409`.
fn release_status_error(status: u16, response: &mut ureq::http::Response<ureq::Body>) -> LibraryError {
    match status {
        401 | 403 => LibraryError::CloudUnauthorized,
        409 => {
            #[derive(serde::Deserialize)]
            struct Coded { detail: serde_json::Value }
            let detail = read_json_bounded::<Coded>(response, 16 * 1024).ok().map(|body| body.detail);
            let code = detail.as_ref().and_then(|d| d.get("code")).and_then(|c| c.as_str());
            match code {
                Some("releaseReadCursorExpired") => {
                    match detail.as_ref().and_then(|d| d.get("lastSequence")).and_then(|v| v.as_i64()) {
                        Some(last) if (0..=super::collection_releases::MAX_CURSOR).contains(&last) => {
                            LibraryError::ReleaseReadCursorExpired(last)
                        }
                        _ => LibraryError::ReleaseSyncInvalid,
                    }
                }
                Some("releaseCursorRejected") => LibraryError::ReleaseCursorRejected,
                Some("releaseGenerationStale") => LibraryError::ReleaseGenerationStale,
                _ => LibraryError::ReleaseSyncRejected(409),
            }
        }
        422 => LibraryError::ReleaseSyncInvalid,
        status => LibraryError::ReleaseSyncRejected(status),
    }
}

/// The parts of `/v1/collections/status` the publisher uses.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionsStatus {
    #[serde(default)]
    pub capabilities: Option<CollectionsCapabilities>,
    #[serde(default)]
    pub library_id: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionsCapabilities {
    #[serde(default)]
    pub collection_personal_edit: bool,
    /// Present (either value) on a server that understands personal-edit version 2 (manga
    /// tracking fields); absent on an older one.
    #[serde(default)]
    pub collection_tracking_edit: Option<bool>,
}

fn bearer(token: &str) -> Result<String, LibraryError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(LibraryError::CloudCredentialNotConfigured);
    }
    Ok(format!("Bearer {token}"))
}

fn validate_download_ticket(ticket: &RemoteCaptureDownloadTicket) -> Result<(), LibraryError> {
    if ticket.method != "GET" {
        return Err(LibraryError::InvalidCloudResponse);
    }
    url::Url::parse(&ticket.download_url)
        .and_then(|url| {
            if matches!(url.scheme(), "http" | "https") {
                Ok(())
            } else {
                Err(url::ParseError::RelativeUrlWithoutBase)
            }
        })
        .map_err(|_| LibraryError::InvalidCloudResponse)
}

fn map_capture_list_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudCaptureListRejected)
}

fn map_capture_ticket_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudCaptureTicketRejected)
}

fn map_capture_download_error(error: ureq::Error) -> LibraryError {
    match error {
        ureq::Error::StatusCode(status) => LibraryError::CloudCaptureDownloadRejected(status),
        ureq::Error::Timeout(_) => LibraryError::CloudRequestTimedOut,
        _ => LibraryError::CloudRequestUnavailable,
    }
}

fn map_capture_ack_error(error: ureq::Error) -> LibraryError {
    map_api_error(error, LibraryError::CloudCaptureAcknowledgementRejected)
}

struct PublicationReader<'a> {
    file: File,
    progress: super::publication::Reporter<'a>,
    total: u64,
    completed: u64,
    reported: u64,
}
impl Read for PublicationReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.file.read(buffer)?;
        self.completed += count as u64;
        if self.completed - self.reported >= 1024 * 1024 || self.completed == self.total {
            super::publication::report(self.progress, "uploading", self.completed, Some(self.total), "bytes");
            self.reported = self.completed;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod asset_tombstoned_tests {
    use super::*;

    fn reject_once(code: &'static str) -> (CloudClient, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let worker = std::thread::spawn(move || {
            let request = server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            let body = serde_json::json!({"detail": {"code": code}}).to_string();
            request
                .respond(tiny_http::Response::from_string(body).with_status_code(409))
                .unwrap();
        });
        (client, worker)
    }

    #[test]
    fn a_classification_intent_for_a_tombstoned_asset_is_dropped_not_retried() {
        let (client, worker) = reject_once("assetTombstoned");
        let outcome = client
            .classification_command(&serde_json::json!({"commandType": "setAssetClassification"}), "t")
            .unwrap();
        worker.join().unwrap();
        assert!(matches!(outcome, ClassificationCommandOutcome::Dropped));
    }

    #[test]
    fn an_album_intent_for_a_tombstoned_asset_is_dropped_not_retried() {
        let (client, worker) = reject_once("assetTombstoned");
        let outcome = client
            .album_command(&serde_json::json!({"commandType": "setAlbumMembership"}), "t")
            .unwrap();
        worker.join().unwrap();
        assert!(matches!(outcome, AlbumCommandOutcome::Dropped));
    }

    #[test]
    fn other_codes_keep_their_existing_handling() {
        assert!(matches!(
            classify_classification_rejection("revisionConflict"),
            ClassificationRejection::Structural("revisionConflict")
        ));
        assert!(matches!(
            classify_album_rejection("unknownCode"),
            AlbumRejection::Retryable
        ));
    }
}

#[cfg(test)]
mod publication_progress_tests {
    use super::*;
    #[test]
    fn catalog_upload_preserves_body_and_reports_transferred_bytes() {
        use std::io::{Seek, Write};
        let mut file = tempfile::tempfile().unwrap();
        let data = vec![b'a'; 1024 * 1024 + 17];
        file.write_all(&data).unwrap();
        file.rewind().unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let digest = "a".repeat(64);
        let expected_digest = digest.clone();
        let worker = std::thread::spawn(move || {
            let mut request = server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.body_length(), Some(data.len()));
            let mut received = Vec::new();
            request.as_reader().read_to_end(&mut received).unwrap();
            assert_eq!(received, data);
            request.respond(tiny_http::Response::from_string(serde_json::json!({"contentDigest":expected_digest,"ready":true}).to_string())).unwrap();
        });
        let events = std::sync::Mutex::new(Vec::new());
        client.upload_mobile_catalog(&digest, file, "test-token", &|event| events.lock().unwrap().push(event)).unwrap();
        worker.join().unwrap();
        let events = events.into_inner().unwrap();
        assert!(!events.is_empty());
        assert!(events.windows(2).all(|pair| pair[0].completed <= pair[1].completed));
        assert_eq!(events.last().unwrap().completed, 1024 * 1024 + 17);
        assert_eq!(events.last().unwrap().unit, "bytes");
    }
}

impl CloudClient {
    pub(crate) fn asset_request(&self,path:&str,body:Option<&serde_json::Value>,token:&str)->Result<serde_json::Value,LibraryError>{
        let agent:ureq::Agent=ureq::Agent::config_builder().max_redirects(0).http_status_as_error(false).timeout_global(Some(SHORT_NETWORK_TIMEOUT)).build().into();
        let endpoint=self.endpoint(path)?;
        let authorization=bearer(token)?;
        let mut response=match body {
            Some(body) if path=="/v1/assets/authority/commands"=>agent.put(endpoint).header("Authorization",authorization).send_json(body),
            Some(body)=>agent.post(endpoint).header("Authorization",authorization).send_json(body),
            None=>agent.get(endpoint).header("Authorization",authorization).call(),
        }.map_err(|_|LibraryError::CloudRequestUnavailable)?;
        let status=response.status().as_u16();
        if status==401 || status==403 {return Err(LibraryError::CloudUnauthorized);}
        let value:serde_json::Value=read_json_bounded(&mut response,4*1024*1024)?;
        if status==200 {return Ok(value);}
        if status==409 && value["detail"]["code"]=="revisionConflict" {
            let detail=&value["detail"];
            let id=detail["assetId"].as_str().filter(|s| !s.is_empty() && s.len()<=128 && s.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'-' || c==b'_')).ok_or(LibraryError::InvalidCloudResponse)?;
            let revision=detail["currentEntityRevision"].as_i64().filter(|v|*v>0).ok_or(LibraryError::InvalidCloudResponse)?;
            let lifecycle=detail["lifecycle"].as_str().filter(|s|matches!(*s,"normal"|"trash"|"tombstoned")).ok_or(LibraryError::InvalidCloudResponse)?;
            return Err(LibraryError::AssetAuthorityConflict{asset_id:id.into(),current_revision:revision,lifecycle:lifecycle.into()});
        }
        if matches!(status,409|404|422) {
            let code=value["detail"]["code"].as_str().filter(|code|matches!(*code,"cursorExpired"|"cursorAhead"|"baselineChanged"|"authorityInactive"|"authorityLibraryMismatch"|"authorityContractUnsupported"|"revisionConflict"|"operationConflict"|"lifecycleTransitionRefused"|"assetNotFound" )).unwrap_or("assetAuthorityRejected");
            return Err(LibraryError::AssetAuthorityRejected{status,code:code.into()});
        }
        Err(LibraryError::CloudRequestUnavailable)
    }
}
