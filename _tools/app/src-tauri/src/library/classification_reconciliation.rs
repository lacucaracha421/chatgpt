//! Classification authority receive: baseline adoption, rebase and change replay.
//!
//! This is the PC side of the `classifications` domain. It is **receive only**: it
//! never sends a command, never mints an operation id and writes no outgoing work.
//! [`super::classification_authority`] owns the durable adopted state this module
//! installs.
//!
//! # Sync order
//!
//! There is no Classification outbox in this batch, so there is no flush-first step
//! to model. 2B.1 adds the queue together with the send path; until then this pass is
//! the whole loop.
//!
//! # Why Classification is not Album
//!
//! Three properties differ from the Album domain and each one changes the code:
//!
//! 1. **Assignment is single-valued** (`asset_id -> classification_id | null`), not
//!    N:N membership, so there is one relation per Asset to reconcile rather than a
//!    set of relations.
//! 2. **A baseline re-install must not start with `DELETE FROM
//!    classification_entries`.** That table is referenced by Character state with
//!    `CASCADE`, `SET NULL` and `RESTRICT`, so a wholesale delete would destroy
//!    Character rows tied to Classifications that are still live. The rebase instead
//!    removes only the ids the authority actually dropped.
//! 3. **A delete is one change carrying two parts** — a Classification tombstone and
//!    the assignment transition that moves its Assets — so the change decoder accepts
//!    that shape and the apply step treats it as indivisible.
//!
//! Two invariants carry correctness, exactly as in the Album receive half:
//!
//! 1. **Remote apply never enqueues.** Applying a baseline or a change page writes the
//!    local materialization and the revision caches, and creates no outgoing work.
//! 2. **The cursor advances only with the data it describes.** One transaction applies
//!    a page's changes and moves the cursor, so an interruption re-applies the page
//!    instead of skipping past it.

use rusqlite::{params, Transaction};

use crate::cloud::client::{
    ClassificationAssignmentProjection, ClassificationAssignmentTransition, ClassificationChange,
    ClassificationProjection, ClassificationRoleProjection, CloudClient,
    CLASSIFICATION_BASELINE_ASSIGNMENTS_SECTION, CLASSIFICATION_BASELINE_SECTIONS_SECTION,
};
use crate::library::classification_authority::{
    assignments_naming, read_authority, write_assignment_revision, write_authority,
    write_classification_revision, write_role, ClassificationAuthority,
    ClassificationReconciliation, CLASSIFICATION_CONTRACT_VERSION, CLASSIFICATION_DOMAIN,
    ORIGINALS_ROLE,
};
use crate::library::{credential, error::LibraryError, Library};

/// Page size for catch-up. The server bounds `limit` to 1..=500.
const CATCH_UP_LIMIT: u32 = 100;

/// Safety valve: refuse an unbounded baseline or catch-up rather than loop forever
/// against a server that reports `hasMore` without advancing.
const MAX_PAGES: usize = 100_000;

/// Attempts at one frozen baseline walk before deferring to the poll loop.
const BASELINE_ATTEMPTS: u32 = 3;

/// The complete Classification state a baseline describes, accumulated across pages.
#[derive(Default)]
struct Baseline {
    classifications: Vec<ClassificationProjection>,
    assignments: Vec<ClassificationAssignmentProjection>,
    roles: Vec<ClassificationRoleProjection>,
    cursor: i64,
}

impl Library {
    /// Adopt or catch up with the Classification authority using the configured
    /// cloud endpoint.
    pub fn reconcile_classifications(&self) -> Result<ClassificationReconciliation, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(endpoint)?;
        self.reconcile_classification_authority(&client, &token)
    }

    /// Adopt or catch up with the Classification authority.
    pub(crate) fn reconcile_classification_authority(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<ClassificationReconciliation, LibraryError> {
        // The guard is scoped to the reads it protects: holding it across the network
        // round trip below would block every other database caller, and the helpers
        // this function calls take the same non-reentrant lock themselves.
        let local = {
            let connection = self.connection()?;
            read_authority(&connection)?
        };
        // Complete any confirmed assignment whose Asset has since appeared locally.
        // This is a local projection step, not a synchronization step: it produces no
        // server revision and no cursor movement. It runs only after adoption, because
        // before adoption there is no confirmed server state to project.
        let rematerialized = if local.is_some() {
            self.materialize_deferred_classification_assignments()?
        } else {
            0
        };
        let status = client.sync_status(token)?;
        let remote = status
            .domains
            .iter()
            .find(|domain| domain.domain == CLASSIFICATION_DOMAIN);
        let Some(remote) = remote else {
            // No active `classifications` authority: the domain is still PC-owned, so
            // the legacy publication path remains responsible and nothing is adopted.
            // No local row is created and no Classification state is touched.
            return Ok(ClassificationReconciliation {
                local_cursor: local.as_ref().map(|value| value.cursor),
                rematerialized_assignments: rematerialized,
                ..Default::default()
            });
        };
        if remote.contract_version != CLASSIFICATION_CONTRACT_VERSION {
            return Err(LibraryError::ClassificationContractUnsupported);
        }
        // Never adopt another library into this database. A mismatch is an identity
        // problem, not something to converge by replacing the local identity.
        if remote.library_id != self.library_id()? {
            return Err(LibraryError::ClassificationAuthorityMismatch);
        }
        match local {
            None => self.adopt_classification_baseline(client, token, remote, false),
            Some(authority)
                if authority.library_id != remote.library_id || authority.epoch != remote.epoch =>
            {
                // A different epoch is a new authority, so the stored cursor and caches
                // describe something else. Re-adopting is the only correct response;
                // there is no meaningful incremental path across identities.
                self.adopt_classification_baseline(client, token, remote, true)
            }
            Some(authority) => match self.apply_classification_changes(client, token, &authority) {
                Ok((applied, cursor)) => Ok(ClassificationReconciliation {
                    adopted: true,
                    applied_changes: applied,
                    server_cursor: Some(remote.cursor),
                    local_cursor: Some(cursor),
                    behind_by: remote.cursor - cursor,
                    rematerialized_assignments: rematerialized,
                    ..Default::default()
                }),
                Err(LibraryError::ClassificationCursorExpired | LibraryError::ClassificationCursorAhead) => {
                    // The change log cannot be continued: expiry means retained history
                    // no longer covers this cursor, and a cursor ahead of the server
                    // means the identity is skewed. Both recover the same way — a fresh
                    // baseline replaces the confirmed replica.
                    self.adopt_classification_baseline(client, token, remote, true)
                }
                Err(error) => Err(error),
            },
        }
    }

    /// Walk every baseline page against one frozen cursor, then adopt atomically.
    ///
    /// Nothing local changes until the final assignment page reports `complete`, so a
    /// failure or an intervening mutation leaves the existing replica untouched.
    fn adopt_classification_baseline(
        &self,
        client: &CloudClient,
        token: &str,
        remote: &crate::cloud::client::SyncAuthorityDomain,
        replace_existing: bool,
    ) -> Result<ClassificationReconciliation, LibraryError> {
        // Any Classification command advances this domain's cursor, so a concurrent
        // change during a multi-page walk invalidates the frozen snapshot. Retrying
        // inside this pass converges once the domain is briefly quiet; the poll loop is
        // the retry of last resort, so this stays bounded rather than spinning.
        let mut attempt = 0;
        let baseline = loop {
            attempt += 1;
            match self.fetch_classification_baseline(client, token, remote) {
                Ok(baseline) => break baseline,
                Err(LibraryError::ClassificationBaselineChanged) if attempt < BASELINE_ATTEMPTS => {
                    continue
                }
                Err(error) => return Err(error),
            }
        };
        if !replace_existing {
            // First adoption on the main PC: the authority was activated from this PC's
            // own staged snapshot, so the server baseline must describe exactly the
            // Classification state already here. A difference means activation raced
            // this PC or something changed underneath, and overwriting local state
            // would destroy user data rather than converge it.
            self.require_classification_first_adoption_match(&baseline)?;
        }
        let local_cursor = self.install_classification_baseline(&baseline, remote)?;
        Ok(ClassificationReconciliation {
            adopted: true,
            adopted_baseline: true,
            // The adopted cursor is the snapshot's, not the `/status` reading from
            // before the walk: only the former describes the state just installed.
            server_cursor: Some(local_cursor),
            local_cursor: Some(local_cursor),
            behind_by: 0,
            ..Default::default()
        })
    }

    /// Fetch every page of one frozen baseline.
    fn fetch_classification_baseline(
        &self,
        client: &CloudClient,
        token: &str,
        remote: &crate::cloud::client::SyncAuthorityDomain,
    ) -> Result<Baseline, LibraryError> {
        let mut baseline = Baseline::default();
        let mut snapshot: Option<i64> = None;
        let mut roles: Option<Vec<ClassificationRoleProjection>> = None;
        let mut section = CLASSIFICATION_BASELINE_SECTIONS_SECTION;
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let page = client.classification_baseline_page(
                &remote.library_id,
                remote.epoch,
                snapshot,
                snapshot.map(|_| section),
                after.as_deref(),
                token,
            )?;
            if page.library_id != remote.library_id
                || page.epoch != remote.epoch
                || page.contract_version != CLASSIFICATION_CONTRACT_VERSION
            {
                return Err(LibraryError::ClassificationAuthorityMismatch);
            }
            match snapshot {
                None => snapshot = Some(page.snapshot_cursor),
                // Pages that describe different materialized states cannot be combined
                // into one baseline.
                Some(frozen) if page.snapshot_cursor != frozen => {
                    return Err(LibraryError::ClassificationBaselineChanged)
                }
                Some(_) => {}
            }
            if page.snapshot_cursor < 0 {
                return Err(LibraryError::InvalidCloudResponse);
            }
            if page.section != section {
                return Err(LibraryError::InvalidCloudResponse);
            }
            // The role set is immutable authority state that no command can produce, so
            // it has no change row to be learned from. It rides on every page; a page
            // that disagreed would mean the walk combined two different role states.
            match &roles {
                None => roles = Some(page.roles.clone()),
                Some(expected) if *expected != page.roles => {
                    return Err(LibraryError::InvalidCloudResponse)
                }
                Some(_) => {}
            }
            let (classifications, assignments) = page.decode()?;
            baseline.classifications.extend(classifications);
            baseline.assignments.extend(assignments);
            if page.has_more {
                match page.next_after {
                    Some(next) if after.as_deref() != Some(next.as_str()) && !next.is_empty() => {
                        after = Some(next)
                    }
                    // A page claiming more work without advancing would ask the same
                    // question forever.
                    _ => return Err(LibraryError::InvalidCloudResponse),
                }
                continue;
            }
            if section == CLASSIFICATION_BASELINE_SECTIONS_SECTION {
                section = CLASSIFICATION_BASELINE_ASSIGNMENTS_SECTION;
                after = None;
                continue;
            }
            // `complete` is valid only on the final assignment page: it is the single
            // point at which a client may adopt the baseline.
            if !page.complete {
                return Err(LibraryError::InvalidCloudResponse);
            }
            baseline.roles = roles.unwrap_or_default();
            baseline.cursor = page.snapshot_cursor;
            return Ok(baseline);
        }
        Err(LibraryError::ClassificationBaselineChanged)
    }

    /// Refuse a first adoption whose baseline differs from the local state.
    ///
    /// Compares canonical state only — structure, effective assignment and the
    /// immutable role — never display metadata such as a computed asset count, which is
    /// presentation rather than authority.
    fn require_classification_first_adoption_match(&self, baseline: &Baseline) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, name, parent_id, icon_key, color_key
             FROM classification_entries ORDER BY id",
        )?;
        let local_classifications = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ),
                ))
            })?
            .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
        let remote_classifications = baseline
            .classifications
            .iter()
            .filter(|classification| !classification.deleted)
            .map(|classification| {
                (
                    classification.id.clone(),
                    (
                        classification.kind.clone(),
                        classification.name.trim().to_owned(),
                        classification.parent_id.clone(),
                        classification.icon_key.clone(),
                        classification.color_key.clone(),
                    ),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        if local_classifications != remote_classifications {
            return Err(LibraryError::ClassificationFirstAdoptionMismatch);
        }
        // Assignment is compared against the local table directly, with no Asset-status
        // predicate: a Classification assignment deliberately survives local trash, so
        // filtering by `status = 'normal'` would report a false mismatch for every
        // trashed Asset that still holds its assignment.
        let mut statement = connection.prepare(
            "SELECT asset_id, classification_id FROM asset_classifications
             ORDER BY asset_id, classification_id",
        )?;
        let local: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        // The authority's live set is compared for the Assets this PC actually holds.
        // An assignment naming an Asset this PC cannot materialize is not local state
        // being overwritten — it is authority state that is simply not projectable yet,
        // and the deferred step completes it once the Asset appears. Restricting the
        // comparison to locally known Assets keeps the direction that matters: a local
        // assignment the authority does not carry is still a mismatch.
        let mut expected: Vec<(String, String)> = baseline
            .assignments
            .iter()
            .filter_map(|assignment| {
                assignment.classification_id.as_ref().map(|classification_id| {
                    (assignment.asset_id.clone(), classification_id.clone())
                })
            })
            .collect();
        expected.sort();
        expected.dedup();
        let known: std::collections::BTreeSet<String> = {
            let mut statement = connection.prepare("SELECT id FROM assets")?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
            ids
        };
        let expected_set: std::collections::BTreeSet<(String, String)> = expected
            .into_iter()
            .filter(|(asset_id, _)| known.contains(asset_id))
            .collect();
        let local_set: std::collections::BTreeSet<(String, String)> =
            local.into_iter().collect();
        if local_set != expected_set {
            return Err(LibraryError::ClassificationFirstAdoptionMismatch);
        }
        // The role binding is authority state with no command behind it, so a
        // difference here could only be a different activation.
        let mut statement =
            connection.prepare("SELECT role, classification_id FROM classification_roles ORDER BY role")?;
        let local_roles: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut expected_roles: Vec<(String, String)> = baseline
            .roles
            .iter()
            .map(|role| (role.role.clone(), role.classification_id.clone()))
            .collect();
        expected_roles.sort();
        expected_roles.dedup();
        if local_roles != expected_roles {
            return Err(LibraryError::ClassificationFirstAdoptionMismatch);
        }
        Ok(())
    }

    /// Replace the local replica and the caches, then record the adoption.
    ///
    /// One transaction, so an interruption cannot leave a half-adopted replica whose
    /// cursor claims state it does not have.
    fn install_classification_baseline(
        &self,
        baseline: &Baseline,
        remote: &crate::cloud::client::SyncAuthorityDomain,
    ) -> Result<i64, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // `classification_entries.parent_id`, `asset_classifications.classification_id`
        // and `classification_roles.classification_id` are all `ON DELETE RESTRICT`
        // with immediate checks, and pages arrive in id order rather than
        // parent-before-child order. Deferring moves every check to COMMIT, where the
        // transaction must be consistent — so a genuinely dangling parent or a relation
        // to a Classification the baseline does not carry is still refused.
        transaction.pragma_update(None, "defer_foreign_keys", "ON")?;
        // A valid server history can end at a name arrangement that cannot be reached
        // by applying the final rows one at a time: if a sibling was renamed away from a
        // name and another node now holds that name, inserting the new holder before
        // the rename would collide on `classification_unique_sibling_name`. Parking
        // every live name behind a per-id prefix first makes the final assignment
        // order-independent, which is what keeps a valid baseline re-installable rather
        // than merely usually re-installable.
        park_classification_names(&transaction)?;
        // The role binding is rewritten before any Classification row is removed: it
        // references `classification_entries` with `RESTRICT`, so a role still pointing
        // at a dropped id would otherwise block the removal below.
        for role in &baseline.roles {
            write_role(&transaction, &role.role, &role.classification_id)?;
        }
        if baseline.roles.iter().all(|role| role.role != ORIGINALS_ROLE) {
            // v1 always carries the role; adopting a baseline without it would import a
            // state the contract says cannot exist.
            return Err(LibraryError::InvalidCloudResponse);
        }
        // The materialized assignment view is rebuilt from authority state, so it must be
        // cleared before any Classification is removed: `asset_classifications
        // .classification_id` is `ON DELETE RESTRICT`, and a stale relation to a dropped
        // Classification would block that removal.
        transaction.execute("DELETE FROM asset_classifications", [])?;
        let live_ids: std::collections::BTreeSet<&str> = baseline
            .classifications
            .iter()
            .filter(|classification| !classification.deleted)
            .map(|classification| classification.id.as_str())
            .collect();
        // Only the ids the authority actually dropped are removed. A wholesale
        // `DELETE FROM classification_entries` would take Character state with it:
        // `character_series`, `character_reference_refreshes` and
        // `character_folder_exclusions` cascade, `character_targets` is set to NULL and
        // `classification_roles` is restricted. Those rows belong to Classifications
        // that are still live, so deleting them would destroy still-valid Character
        // state merely to simplify the rebase.
        let obsolete: Vec<String> = transaction
            .prepare("SELECT id FROM classification_entries")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|id| !live_ids.contains(id.as_str()))
            .collect();
        for id in &obsolete {
            transaction.execute("DELETE FROM classification_entries WHERE id = ?1", [id])?;
        }
        for classification in baseline
            .classifications
            .iter()
            .filter(|classification| !classification.deleted)
        {
            upsert_classification(&transaction, classification, &now)?;
        }
        // The revision caches are replaced with exactly the baseline state: a row the
        // authority no longer lists has no revision this PC can justify presenting.
        transaction.execute("DELETE FROM classification_authority_revisions", [])?;
        transaction.execute("DELETE FROM classification_authority_assignment_revisions", [])?;
        for classification in &baseline.classifications {
            write_classification_revision(
                &transaction,
                &classification.id,
                classification.entity_revision,
                classification.deleted,
                &now,
            )?;
        }
        for assignment in &baseline.assignments {
            // Every row is cached, including `classification_id = NULL` (an
            // authoritative unassigned state at a real revision) and rows naming Assets
            // this PC has not materialized: both are revision state a later command
            // needs, and neither can be reconstructed from `asset_classifications`.
            write_assignment_revision(
                &transaction,
                &assignment.asset_id,
                assignment.classification_id.as_deref(),
                assignment.entity_revision,
                &now,
            )?;
            materialize_assignment(
                &transaction,
                &assignment.asset_id,
                assignment.classification_id.as_deref(),
            )?;
        }
        let authority = ClassificationAuthority {
            library_id: remote.library_id.clone(),
            epoch: remote.epoch,
            contract_version: remote.contract_version,
            cursor: baseline.cursor,
        };
        write_authority(&transaction, &authority, &now)?;
        transaction.commit()?;
        Ok(baseline.cursor)
    }

    /// Apply the ordered change log until it is exhausted.
    ///
    /// Returns `(applied, cursor)`.
    fn apply_classification_changes(
        &self,
        client: &CloudClient,
        token: &str,
        authority: &ClassificationAuthority,
    ) -> Result<(u32, i64), LibraryError> {
        let mut applied = 0u32;
        let mut cursor = authority.cursor;
        for _ in 0..MAX_PAGES {
            // The cursor this page was requested from, kept before the page's own
            // `next_after` replaces it. Progress must be measured against the *requested*
            // value: comparing the freshly assigned cursor against itself can never fail.
            let requested = cursor;
            let page = client.classification_changes(
                &authority.library_id,
                authority.epoch,
                requested,
                CATCH_UP_LIMIT,
                token,
            )?;
            if !page.items.is_empty() {
                // The page's changes and the cursor that describes them commit together,
                // and the ordering check happens inside that same transaction.
                self.apply_classification_page(&page.items, page.next_after)?;
                applied += page.items.len() as u32;
                cursor = page.next_after;
            }
            if !page.has_more {
                return Ok((applied, cursor));
            }
            // A page claiming more work must have advanced past the cursor it was asked
            // for, or the next request would ask the same question forever.
            if page.next_after <= requested {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        Err(LibraryError::ClassificationCursorExpired)
    }

    /// Apply one change page and advance the cursor in the same transaction.
    fn apply_classification_page(
        &self,
        items: &[ClassificationChange],
        cursor: i64,
    ) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // A page can delete a Classification before a later change reparents a child
        // onto a different live node, and `parent_id` is `ON DELETE RESTRICT` with an
        // immediate check. Deferring keeps the ordering the log provides from being read
        // as a referential error, while a page that genuinely leaves a dangling parent
        // is still refused at COMMIT.
        transaction.pragma_update(None, "defer_foreign_keys", "ON")?;
        let mut current = read_authority(&transaction)?
            .ok_or(LibraryError::ClassificationAuthorityInactive)?
            .cursor;
        for change in items {
            // Sequence order is what makes the outcome correct, so a gap, a repeat or a
            // backwards step is a malformed page rather than something to apply.
            // Checking here — rather than in the caller — is what keeps the cursor from
            // ever advancing over a change that was not applied.
            if change.sequence != current + 1 {
                return Err(LibraryError::InvalidCloudResponse);
            }
            current = change.sequence;
            let (classification, assignment, transition) = change.delta()?;
            if let Some(classification) = classification {
                apply_classification_projection(&transaction, classification, &now)?;
            }
            if let Some(assignment) = assignment {
                write_assignment_revision(
                    &transaction,
                    &assignment.asset_id,
                    assignment.classification_id.as_deref(),
                    assignment.entity_revision,
                    &now,
                )?;
                materialize_assignment(
                    &transaction,
                    &assignment.asset_id,
                    assignment.classification_id.as_deref(),
                )?;
            }
            if let Some(transition) = transition {
                // The tombstone has already been recorded above; the transition and the
                // removal of the local row are the rest of the same indivisible change.
                apply_assignment_transition(&transaction, transition, &now)?;
                transaction.execute(
                    "DELETE FROM classification_entries WHERE id = ?1",
                    [&transition.from_classification_id],
                )?;
            }
        }
        // A page that stops short of the cursor it reports would leave the local replica
        // claiming state the log has not delivered.
        if current != cursor && !items.is_empty() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut authority = read_authority(&transaction)?
            .ok_or(LibraryError::ClassificationAuthorityInactive)?;
        authority.cursor = cursor;
        write_authority(&transaction, &authority, &now)?;
        transaction.commit()?;
        Ok(())
    }

    /// Materialize confirmed assignments whose Asset has since appeared locally.
    ///
    /// A confirmed assignment to an Asset this PC had not materialized is recorded in
    /// `classification_authority_assignment_revisions` while its visible
    /// `asset_classifications` row is deliberately withheld. Waiting for "the next
    /// baseline" is not a real recovery: a client whose epoch and cursor stay valid can
    /// reconcile incrementally forever and never adopt another baseline, so the
    /// assignment would stay invisible indefinitely.
    ///
    /// This creates no server command, changes no authority revision, advances no
    /// cursor and writes no outbox row: the authority's state is already known and
    /// unchanged, and only the local projection of it is being completed.
    pub(crate) fn materialize_deferred_classification_assignments(
        &self,
    ) -> Result<u32, LibraryError> {
        let connection = self.connection()?;
        // Only lineages the authority has actually described are touched. An Asset with
        // no cache row was never mentioned by the authority, so its local relations are
        // pre-adoption state and removing them would destroy user data.
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id)
             SELECT revision.asset_id, revision.classification_id
             FROM classification_authority_assignment_revisions revision
             JOIN assets asset ON asset.id = revision.asset_id
             JOIN classification_entries entry ON entry.id = revision.classification_id
             WHERE revision.classification_id IS NOT NULL",
            [],
        )?;
        // An authoritative *unassigned* row must also clear a projection that is
        // currently wrong: the confirmed value is "no assignment", so any relation for
        // that Asset is stale. Relations for a different Classification are removed
        // too, because assignment is single-valued.
        let removed = connection.execute(
            "DELETE FROM asset_classifications
             WHERE EXISTS (
                 SELECT 1 FROM classification_authority_assignment_revisions revision
                 WHERE revision.asset_id = asset_classifications.asset_id
                   AND (revision.classification_id IS NULL
                        OR revision.classification_id <> asset_classifications.classification_id)
             )",
            [],
        )?;
        Ok(u32::try_from(inserted + removed).unwrap_or(u32::MAX))
    }
}

/// Park every live Classification name behind a per-id prefix.
///
/// The sibling-name unique index is `(COALESCE(parent_id, ''), name COLLATE NOCASE)`,
/// so a final name arrangement is only reachable if the names that a row is about to
/// take are free *when* it takes them. Parking first makes every later name assignment
/// colliding-free regardless of the order the baseline lists rows in, which is what
/// keeps a valid baseline re-installable instead of order-dependent.
///
/// The prefix is chosen so it cannot already be in use, and the id suffix keeps the
/// parked values unique within each parent.
fn park_classification_names(transaction: &Transaction<'_>) -> Result<(), LibraryError> {
    let mut prefix = "\u{1}".to_owned();
    loop {
        let clashes: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE name GLOB ?1 || '*')",
            [&prefix],
            |row| row.get(0),
        )?;
        if !clashes {
            break;
        }
        prefix.push('\u{1}');
    }
    transaction.execute(
        "UPDATE classification_entries SET name = ?1 || id WHERE name NOT GLOB ?1 || '*'",
        [&prefix],
    )?;
    Ok(())
}

/// Insert or update one live Classification from an authoritative projection.
fn upsert_classification(
    transaction: &Transaction<'_>,
    classification: &ClassificationProjection,
    now: &str,
) -> Result<(), LibraryError> {
    // The name is stored trimmed because that is the local invariant
    // (`normalized_name`); the authority already guarantees a trimmed value, so this
    // only keeps the two tables byte-comparable for a later comparison.
    transaction.execute(
        "INSERT INTO classification_entries (id, kind, name, parent_id, icon_key, color_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
             parent_id = excluded.parent_id, icon_key = excluded.icon_key,
             color_key = excluded.color_key",
        params![
            classification.id,
            classification.kind,
            classification.name.trim(),
            classification.parent_id,
            classification.icon_key,
            classification.color_key,
            now
        ],
    )?;
    Ok(())
}

/// Apply one Classification projection from the change log.
///
/// A tombstone records the confirmed revision and removes the live local row. The
/// assignment effects a delete carries are applied separately by
/// [`apply_assignment_transition`] and always in the same transaction, so the local
/// replica can never observe a deleted Classification whose assignments have not moved.
fn apply_classification_projection(
    transaction: &Transaction<'_>,
    classification: &ClassificationProjection,
    now: &str,
) -> Result<(), LibraryError> {
    write_classification_revision(
        transaction,
        &classification.id,
        classification.entity_revision,
        classification.deleted,
        now,
    )?;
    if classification.deleted {
        return Ok(());
    }
    upsert_classification(transaction, classification, now)
}

/// Apply the assignment transition a delete change carries, and verify it.
///
/// Every cached lineage naming the deleted Classification moves to its parent (or to
/// unassigned for a root), with each revision incrementing by exactly one — which is
/// what the server did, so the replica reproduces the same numbers.
///
/// The count is verified against the **authority assignment cache**, not against
/// `asset_classifications`: the authority legitimately holds assignments for Assets
/// this PC has not materialized, so a visible-row count would be smaller than the
/// server's own `affectsAssignments` for reasons that are not divergence. A cache
/// count that disagrees is real replica divergence or protocol corruption, and failing
/// the page is what keeps the cursor from advancing over it.
fn apply_assignment_transition(
    transaction: &Transaction<'_>,
    transition: &ClassificationAssignmentTransition,
    now: &str,
) -> Result<(), LibraryError> {
    let affected = assignments_naming(transaction, &transition.from_classification_id)?;
    if affected.len() as i64 != transition.affects_assignments {
        return Err(LibraryError::InvalidCloudResponse);
    }
    for (asset_id, revision) in &affected {
        write_assignment_revision(
            transaction,
            asset_id,
            transition.to_classification_id.as_deref(),
            revision + 1,
            now,
        )?;
        materialize_assignment(
            transaction,
            asset_id,
            transition.to_classification_id.as_deref(),
        )?;
    }
    Ok(())
}

/// Project one authoritative assignment value onto the local relation table.
///
/// The authority can legitimately describe an assignment for an Asset this PC has not
/// materialized yet, and for a Classification the local table cannot reference. Treating
/// either as an error would stop the cursor forever on state that is correct: the
/// confirmed revision is always recorded by the caller, and only the *visible* row is
/// conditional here. [`Library::materialize_deferred_classification_assignments`]
/// completes the withheld projection on a later pass.
fn materialize_assignment(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
) -> Result<(), LibraryError> {
    let known: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
        [asset_id],
        |row| row.get(0),
    )?;
    if !known {
        return Ok(());
    }
    match classification_id {
        None => {
            // Absent is absent: the authority says this Asset holds no Classification,
            // so any local relation for it is stale.
            transaction.execute(
                "DELETE FROM asset_classifications WHERE asset_id = ?1",
                [asset_id],
            )?;
        }
        Some(classification_id) => {
            let materializable: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
                [classification_id],
                |row| row.get(0),
            )?;
            if !materializable {
                return Ok(());
            }
            // Assignment is single-valued, so the new relation replaces any other.
            transaction.execute(
                "DELETE FROM asset_classifications WHERE asset_id = ?1",
                [asset_id],
            )?;
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                params![asset_id, classification_id],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
impl Library {
    /// Test seam: run the first-adoption comparison against a candidate baseline.
    pub(crate) fn require_classification_first_adoption_match_for_test(
        &self,
        classifications: &[ClassificationProjection],
        assignments: &[ClassificationAssignmentProjection],
        roles: &[ClassificationRoleProjection],
    ) -> Result<(), LibraryError> {
        self.require_classification_first_adoption_match(&Baseline {
            classifications: classifications.to_vec(),
            assignments: assignments.to_vec(),
            roles: roles.to_vec(),
            cursor: 0,
        })
    }

    /// Test seam: install a baseline through the production install path.
    pub(crate) fn install_classification_baseline_for_test(
        &self,
        classifications: &[ClassificationProjection],
        assignments: &[ClassificationAssignmentProjection],
        roles: &[ClassificationRoleProjection],
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
    ) -> Result<(), LibraryError> {
        let baseline = Baseline {
            classifications: classifications.to_vec(),
            assignments: assignments.to_vec(),
            roles: roles.to_vec(),
            cursor,
        };
        let remote = crate::cloud::client::SyncAuthorityDomain {
            domain: CLASSIFICATION_DOMAIN.to_owned(),
            library_id: library_id.to_owned(),
            epoch,
            contract_version,
            cursor,
        };
        self.install_classification_baseline(&baseline, &remote).map(|_| ())
    }

    /// Test seam: apply one change page through the production apply path.
    pub(crate) fn apply_classification_page_for_test(
        &self,
        items: &[ClassificationChange],
        cursor: i64,
    ) -> Result<(), LibraryError> {
        self.apply_classification_page(items, cursor)
    }
}
