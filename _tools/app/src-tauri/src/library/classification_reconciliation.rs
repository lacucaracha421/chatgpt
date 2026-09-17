//! Classification authority receive: baseline adoption, rebase and change replay.
//!
//! This is the PC side of the `classifications` domain. It never sends a command and
//! never mints an operation id; [`super::classification_authority`] owns the durable
//! adopted state and the outbox this module reads to decide whether it may run.
//!
//! # Sync order
//!
//! ```text
//! flush pending intents -> only when clean, receive authority changes
//! ```
//!
//! Classification is structural state, so a received page must never replace a local
//! edit the server has not yet accepted or explicitly rejected. A local rename or
//! hierarchy move *is* the user's current intent, and letting an unrelated remote page
//! overwrite it would discard that intent silently. The guard lives **here**, in the
//! native pass, not only in the UI hook: reconciliation can be driven from outside the
//! normal loop, and the protection must hold however it was called.
//!
//! A blocked queue stops receive indefinitely — until a later conflict-resolution batch
//! or user action resolves it — because a later command may depend on the blocked one.
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

use rusqlite::{params, Connection, Transaction};

use crate::cloud::client::{
    ClassificationAssignmentProjection, ClassificationAssignmentTransition, ClassificationChange,
    ClassificationProjection, ClassificationRoleProjection, CloudClient,
    CLASSIFICATION_BASELINE_ASSIGNMENTS_SECTION, CLASSIFICATION_BASELINE_SECTIONS_SECTION,
};
use crate::library::classification_authority::{
    assignments_naming, read_authority, read_outbox, write_assignment_revision, write_authority,
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

/// The local materialized assignment view: every Asset's current Classification set.
///
/// Assignment is single-valued on the server, but the local table's key is
/// `(asset_id, classification_id)`, so a set per Asset is what makes a comparison
/// correct rather than merely usually correct.
type AssignmentView = std::collections::BTreeMap<String, std::collections::BTreeSet<String>>;

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
    ///
    /// Refuses to receive while any local intent is unresolved: `deferred_to_outbox` is
    /// the documented "the user's intent takes precedence this cycle" state, not an error
    /// to retry blindly. The guard is enforced here rather than only in the UI loop,
    /// because reconciliation can be called from anywhere and the optimistic local state
    /// must be protected however it was reached.
    pub(crate) fn reconcile_classification_authority(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<ClassificationReconciliation, LibraryError> {
        // The guard is scoped to the reads it protects: holding it across the network
        // round trip below would block every other database caller, and the helpers this
        // function calls take the same non-reentrant lock themselves.
        let (outbox_clean, local) = {
            let connection = self.connection()?;
            (
                read_outbox(&connection)?.is_empty(),
                read_authority(&connection)?,
            )
        };
        if !outbox_clean {
            // Not merely "receiving is unsafe": every write below is unsafe over an
            // unresolved intent. A baseline rebase would replace optimistic state with
            // confirmed state the user has already moved past, and the deferred
            // assignment materialization would rewrite an Asset's Classification from
            // `classification_authority_assignment_revisions` — the value that is
            // deliberately *behind* the queue. A blocked row defers receive indefinitely
            // until a later conflict-resolution batch or user action clears it.
            return Ok(ClassificationReconciliation {
                adopted: local.is_some(),
                deferred_to_outbox: true,
                local_cursor: local.as_ref().map(|value| value.cursor),
                ..Default::default()
            });
        }
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
        let local_cursor = self.commit_classification_baseline(&baseline, remote, replace_existing)?;
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

    /// Commit a fully walked baseline, choosing the correct install for its situation.
    ///
    /// This is the one place that decides *how* a completed baseline is committed, shared
    /// by the production path and the test seam so the decision itself is exercised:
    ///
    /// * a **first** adoption compares and installs in one transaction, so no local
    ///   Classification mutation can slip between the safety check and the adoption, and
    ///   writes only the durable authority metadata because the product tables already
    ///   hold the state the baseline describes;
    /// * an **already-adopted** replica takes the rebase installer, because there the
    ///   server replaced local state rather than matching it.
    fn commit_classification_baseline(
        &self,
        baseline: &Baseline,
        remote: &crate::cloud::client::SyncAuthorityDomain,
        replace_existing: bool,
    ) -> Result<i64, LibraryError> {
        if replace_existing {
            self.install_classification_baseline(baseline, remote)
        } else {
            self.adopt_first_classification_baseline(baseline, remote)
        }
    }

    /// Adopt a first baseline: compare **and** install, in one transaction.
    ///
    /// A first adoption is the one write that must never "fix" the PC. The authority was
    /// activated from this PC's own staged snapshot, so the server baseline has to
    /// describe exactly the Classification state already here; a difference means
    /// activation raced this PC or something changed underneath, and overwriting local
    /// state would destroy user data rather than converge it.
    ///
    /// The comparison and the metadata write deliberately share one transaction. Done
    /// separately — compare on one connection, then open a transaction to install — a
    /// local Classification mutation could commit in between, so the check would approve
    /// a state that is no longer the state being adopted. Holding one transaction means
    /// no such window exists: either the local state still matches the baseline and the
    /// adoption row lands with it, or the whole thing rolls back.
    ///
    /// An exact first adoption writes **only** the three durable authority tables. The
    /// product tables already hold the state the baseline describes, so rewriting them
    /// would be pure risk — it could trip a sibling-name conflict, cascade Character
    /// state or churn the legacy publication generation — for no information gain. The
    /// rebase installer exists for the opposite situation (an already-adopted replica
    /// that must be replaced), and is not reused here merely because its final values
    /// would happen to be identical.
    fn adopt_first_classification_baseline(
        &self,
        baseline: &Baseline,
        remote: &crate::cloud::client::SyncAuthorityDomain,
    ) -> Result<i64, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_first_adoption_match(&transaction, baseline)?;
        let authority = ClassificationAuthority {
            library_id: remote.library_id.clone(),
            epoch: remote.epoch,
            contract_version: remote.contract_version,
            cursor: baseline.cursor,
        };
        write_authority(&transaction, &authority, &now)?;
        write_baseline_revision_caches(&transaction, baseline, &now)?;
        transaction.commit()?;
        Ok(baseline.cursor)
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
        // The complete effective assignment state *before* this rebase touches anything.
        // Reading it here is what makes the Character comparison below correct: the global
        // clear of `asset_classifications` further down would otherwise erase the local
        // side of the comparison, so `A -> null` would look like `null -> null` and
        // `A -> A` would look like `null -> A`.
        let before = local_assignment_view(&transaction)?;
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
        write_baseline_revision_caches(&transaction, baseline, &now)?;
        for assignment in &baseline.assignments {
            // Projection only: Character work is decided once, below, from the whole
            // before/after comparison. Enqueueing per row here would compare against a
            // table that has already been cleared.
            project_without_enqueue(
                &transaction,
                &assignment.asset_id,
                assignment.classification_id.as_deref(),
            )?;
        }
        // Character reconsideration is owed exactly for the locally materialized Assets
        // whose effective assignment this rebase actually changed. Comparing the whole
        // state once covers every transition — including an authoritative *absence* of a
        // row, which clears a local relation without appearing as a baseline assignment.
        enqueue_changed_assignments(&transaction, &before)?;
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
            // Prove the page belongs to this authority and advances the way the server's
            // own envelope says it does, before a single local write happens. A page from
            // another library/epoch/contract, or one whose cursor arithmetic disagrees
            // with itself, is not information this replica may act on.
            page.validate(&authority.library_id, authority.epoch, requested)?;
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
    /// unchanged, and only the local projection of it is being completed. It is a local
    /// derived-work step, so it may queue Character reconsideration for the Assets whose
    /// effective assignment it actually changed.
    ///
    /// The whole projection is one transaction. Assignment is single-valued, so a
    /// per-Asset reconcile that cleared and re-inserted outside one transaction could
    /// expose — or persist on failure — an Asset holding both its old Classification and
    /// the authoritative one. Committing together makes the intermediate state
    /// unobservable and makes a failure a rollback to the previous projection.
    pub(crate) fn materialize_deferred_classification_assignments(
        &self,
    ) -> Result<u32, LibraryError> {
        let mut connection = self.connection()?;
        // Confirmed state must never overwrite the user's pending edit. The caller
        // already defers on an unresolved queue, but this is a public entry point, so it
        // enforces the same precondition itself rather than trusting every caller.
        if !read_outbox(&connection)?.is_empty() {
            return Ok(0);
        }
        let transaction = connection.transaction()?;
        // Only lineages the authority has actually described are touched. An Asset with
        // no cache row was never mentioned by the authority, so its local relations are
        // pre-adoption state and removing them would destroy user data.
        let confirmed: Vec<(String, Option<String>)> = {
            let mut statement = transaction.prepare(
                "SELECT asset_id, classification_id
                 FROM classification_authority_assignment_revisions ORDER BY asset_id",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut changed = 0u32;
        for (asset_id, classification_id) in &confirmed {
            // `project_assignment` only touches Assets that exist locally, and it
            // replaces rather than merges, so each known Asset ends holding exactly the
            // authoritative value or nothing at all.
            if project_assignment(&transaction, asset_id, classification_id.as_deref())? {
                changed += 1;
            }
        }
        transaction.commit()?;
        Ok(changed)
    }
}

/// Refuse a first adoption whose baseline differs from the local canonical state.
///
/// Compares canonical state only — structure, effective assignment and the immutable
/// role — never display metadata such as a computed asset count, which is presentation
/// rather than authority. Runs on the caller's transaction so the comparison cannot be
/// separated from the adoption it authorizes.
fn require_first_adoption_match(
    transaction: &Transaction<'_>,
    baseline: &Baseline,
) -> Result<(), LibraryError> {
    let mut statement = transaction.prepare(
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
    // Assignment is compared exactly, with no relaxation on either side. In particular
    // the server side is *not* narrowed to the Assets this PC currently holds: the
    // authority was activated from this PC's own staged snapshot, so a baseline
    // assignment naming an Asset that is now absent locally means local canonical state
    // changed after staging. Skipping it would let that divergence be adopted silently,
    // and the same reasoning applies to `status`, because assignment deliberately
    // survives local trash — filtering by `status = 'normal'` would report a false
    // mismatch for every trashed Asset that still holds its assignment.
    let local = local_assignment_view(transaction)?;
    let expected = effective_assignment_view(baseline);
    if local != expected {
        return Err(LibraryError::ClassificationFirstAdoptionMismatch);
    }
    // The role binding is authority state with no command behind it, so a difference
    // here could only be a different activation.
    let mut statement =
        transaction.prepare("SELECT role, classification_id FROM classification_roles ORDER BY role")?;
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

/// Every materialized Classification relation, grouped by Asset.
fn local_assignment_view(connection: &Connection) -> Result<AssignmentView, LibraryError> {
    let mut statement = connection
        .prepare("SELECT asset_id, classification_id FROM asset_classifications ORDER BY asset_id")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut view = AssignmentView::new();
    for row in rows {
        let (asset_id, classification_id) = row?;
        view.entry(asset_id).or_default().insert(classification_id);
    }
    Ok(view)
}

/// The baseline's *effective* assignment view: only non-null values materialize.
///
/// An explicit `classificationId = null` row is authoritative unassigned state at a real
/// revision, so it is deliberately absent here rather than represented as an empty set:
/// it corresponds to no `asset_classifications` row.
fn effective_assignment_view(baseline: &Baseline) -> AssignmentView {
    let mut view = AssignmentView::new();
    for assignment in &baseline.assignments {
        if let Some(classification_id) = assignment.classification_id.as_ref() {
            view.entry(assignment.asset_id.clone())
                .or_default()
                .insert(classification_id.clone());
        }
    }
    view
}

/// Write exactly the baseline's revision caches, replacing whatever was cached.
///
/// Every row is cached, including `classification_id = NULL` (an authoritative
/// unassigned state at a real revision) and rows naming Assets this PC has not
/// materialized: both are revision state a later command needs, and neither can be
/// reconstructed from `asset_classifications`.
fn write_baseline_revision_caches(
    transaction: &Transaction<'_>,
    baseline: &Baseline,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute("DELETE FROM classification_authority_revisions", [])?;
    transaction.execute("DELETE FROM classification_authority_assignment_revisions", [])?;
    for classification in &baseline.classifications {
        write_classification_revision(
            transaction,
            &classification.id,
            classification.entity_revision,
            classification.deleted,
            now,
        )?;
    }
    for assignment in &baseline.assignments {
        write_assignment_revision(
            transaction,
            &assignment.asset_id,
            assignment.classification_id.as_deref(),
            assignment.entity_revision,
            now,
        )?;
    }
    Ok(())
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
    project_assignment(transaction, asset_id, classification_id)?;
    Ok(())
}

/// Project an authoritative assignment value without deciding Character work.
///
/// Used by the rebase, which compares the whole before/after state once at the end
/// instead of per row. Every other caller wants [`project_assignment`].
fn project_without_enqueue(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
) -> Result<(), LibraryError> {
    project_assignment_impl(transaction, asset_id, classification_id, false)?;
    Ok(())
}

/// Queue Character reconsideration for every locally materialized Asset whose effective
/// assignment differs from `before`.
///
/// The authority only describes the lineages it carries, so an Asset that was assigned
/// locally and has no authoritative row at all is *also* a change to nothing. Both sides
/// are read as the same complete view, which is what makes absence, unassignment and
/// re-assignment all fall out of one comparison.
fn enqueue_changed_assignments(
    transaction: &Transaction<'_>,
    before: &AssignmentView,
) -> Result<(), LibraryError> {
    let after = local_assignment_view(transaction)?;
    // An Asset present on either side may have changed; one present on neither did not.
    let mut candidates: std::collections::BTreeSet<&String> = before.keys().collect();
    candidates.extend(after.keys());
    for asset_id in candidates {
        let unchanged = before.get(asset_id) == after.get(asset_id);
        if unchanged {
            continue;
        }
        // Only a locally materialized Asset can owe Character work; the cache may also
        // describe Assets this PC has never seen.
        let known: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
            [asset_id],
            |row| row.get(0),
        )?;
        if !known {
            continue;
        }
        crate::library::character_autotag::enqueue(
            transaction,
            asset_id,
            crate::library::character_autotag::Cause::Classification,
        )?;
    }
    Ok(())
}

/// Project one authoritative assignment value onto the local relation table, and queue
/// Character reconsideration when that actually changed the Asset's assignment.
///
/// The authority can legitimately describe an assignment for an Asset this PC has not
/// materialized yet, and for a Classification the local table cannot reference. Treating
/// either as an error would stop the cursor forever on state that is correct: the
/// confirmed revision is always recorded by the caller, and only the *visible* row is
/// conditional here. [`Library::materialize_deferred_classification_assignments`]
/// completes the withheld projection on a later pass.
///
/// The enqueue is what keeps received assignment semantically equivalent to a local one:
/// every local Classification mutation queues Character reconsideration for the Asset it
/// changed, so a replica that applied the same change without it would leave recognition
/// inputs stale. It is a *local derived-work* enqueue only — no Classification command,
/// no outbox row and no legacy relation replication intent is created here.
fn project_assignment(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
) -> Result<bool, LibraryError> {
    project_assignment_impl(transaction, asset_id, classification_id, true)
}

/// The single projection body, with the Character decision optionally suppressed.
fn project_assignment_impl(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
    enqueue: bool,
) -> Result<bool, LibraryError> {
    let known: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
        [asset_id],
        |row| row.get(0),
    )?;
    if !known {
        return Ok(false);
    }
    let before = local_assignment_state(transaction, asset_id)?;
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
                // A missing *Asset* is a legitimate deferred projection; a missing
                // *Classification* is not. The server cannot produce a non-null
                // assignment to a Classification that does not exist: ordinary commands
                // validate the target, staging validates every assignment target, and a
                // delete moves its Assets away atomically. So a locally materialized
                // Asset pointing at an absent Classification means this replica is
                // corrupt, and caching-and-advancing would hide that behind a relation
                // that silently never appears.
                return Err(LibraryError::InvalidCloudResponse);
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
    let after = local_assignment_state(transaction, asset_id)?;
    if before == after {
        // An idempotent projection is not a change, so it must not create derived work.
        return Ok(false);
    }
    if !enqueue {
        return Ok(true);
    }
    crate::library::character_autotag::enqueue(
        transaction,
        asset_id,
        crate::library::character_autotag::Cause::Classification,
    )?;
    Ok(true)
}

/// The Asset's current Classification set, ordered so comparison is exact.
fn local_assignment_state(
    transaction: &Transaction<'_>,
    asset_id: &str,
) -> Result<Vec<String>, LibraryError> {
    let mut statement = transaction.prepare(
        "SELECT classification_id FROM asset_classifications WHERE asset_id = ?1
         ORDER BY classification_id",
    )?;
    let rows = statement.query_map([asset_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
impl Library {
    /// Test seam: commit a baseline through the production decision point.
    ///
    /// It routes through `commit_classification_baseline`, so a test can exercise the
    /// first-adoption-versus-rebase choice rather than a hand-picked installer.
    pub(crate) fn adopt_first_classification_baseline_for_test(
        &self,
        classifications: &[ClassificationProjection],
        assignments: &[ClassificationAssignmentProjection],
        roles: &[ClassificationRoleProjection],
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
    ) -> Result<(), LibraryError> {
        self.commit_classification_baseline_for_test(
            classifications,
            assignments,
            roles,
            library_id,
            epoch,
            contract_version,
            cursor,
            false,
        )
    }

    /// Test seam: commit a baseline, optionally as an already-adopted rebase.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn commit_classification_baseline_for_test(
        &self,
        classifications: &[ClassificationProjection],
        assignments: &[ClassificationAssignmentProjection],
        roles: &[ClassificationRoleProjection],
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
        replace_existing: bool,
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
        self.commit_classification_baseline(&baseline, &remote, replace_existing)
            .map(|_| ())
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
