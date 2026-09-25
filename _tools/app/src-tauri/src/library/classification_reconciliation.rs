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
    assignments_naming, has_unresolved_intents, read_authority, read_classification_revision,
    preapplied_delete_covers, read_preapplied_delete,
    retire_preapplied_delete, write_assignment_revision, PreappliedDelete,
    write_authority, write_classification_revision, write_role, ClassificationAuthority,
    ClassificationReconciliation, ASSIGNMENT, CLASSIFICATION_CONTRACT_VERSION,
    CLASSIFICATION_DOMAIN, ORIGINALS_ROLE,
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
        let token = token.expose();
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
        self.reconcile_classification_authority_with_status(
            client,
            token,
            &|| client.sync_status(token),
            false,
        )
    }

    /// The receive half against a caller-supplied `/v1/sync/status` read.
    ///
    /// The coordinated authority pass shares one status read across every domain and
    /// sets `skip_unchanged`: a domain whose stored cursor already equals the reported
    /// one then skips its change feed. Explicit reconciliation passes `false` and still
    /// reads and validates the feed.
    pub(crate) fn reconcile_classification_authority_with_status(
        &self,
        client: &CloudClient,
        token: &str,
        read_status: &dyn Fn() -> Result<crate::cloud::client::SyncStatus, LibraryError>,
        skip_unchanged: bool,
    ) -> Result<ClassificationReconciliation, LibraryError> {
        // The guard is scoped to the reads it protects: holding it across the network
        // round trip below would block every other database caller, and the helpers this
        // function calls take the same non-reentrant lock themselves.
        let (outbox_clean, local) = {
            let connection = self.connection()?;
            (
                !has_unresolved_intents(&connection)?,
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
        let status = read_status()?;
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
        // The *stored* identity is validated independently, against the same canonical library.
        //
        // The remote check above cannot cover this: a database already corrupted by the older
        // guard holds a foreign library's authority row, and if that foreign library happens to
        // have the epoch the correct one now reports, no re-adoption trigger fires and the
        // dispatch walks the foreign identity's change log as if it continued this library's.
        // That is not a recoverable convergence — the two logs describe different libraries, and
        // the cursor comparison is meaningless across them.
        //
        // Refusing is the safe answer rather than silently re-adopting: a re-adoption would
        // replace this library's Classification replica with state derived from the foreign
        // identity, and the corrupted row is evidence this database's replica is not
        // trustworthy. Reporting it lets a later, deliberate repair decide what to keep. Album
        // carries the equivalent guard, so both domains fail closed the same way.
        if let Some(authority) = &local {
            if authority.library_id != remote.library_id {
                return Err(LibraryError::ClassificationAuthorityMismatch);
            }
        }
        match self.receive_classification_authority(
            client,
            token,
            remote,
            local.as_ref(),
            skip_unchanged,
            rematerialized,
        ) {
            // A local intent that appeared while a request was in flight — a change page or a
            // baseline walk — is the same condition: the intent is the user's current intent,
            // so nothing is applied, the cursor does not move, and the next pass flushes it
            // first. Converting it here keeps one meaning for the state instead of two
            // near-identical ones that differ only by which half of the receive produced it.
            Err(LibraryError::AuthorityReceivePreconditionChanged { .. }) => {
                Ok(ClassificationReconciliation {
                    adopted: true,
                    deferred_to_outbox: true,
                    server_cursor: Some(remote.cursor),
                    local_cursor: local.as_ref().map(|value| value.cursor),
                    behind_by: local
                        .as_ref()
                        .map_or(0, |authority| remote.cursor - authority.cursor),
                    ..Default::default()
                })
            }
            other => other,
        }
    }

    /// The adopt-versus-catch-up dispatch, with the deferral condition left to the caller.
    fn receive_classification_authority(
        &self,
        client: &CloudClient,
        token: &str,
        remote: &crate::cloud::client::SyncAuthorityDomain,
        local: Option<&ClassificationAuthority>,
        skip_unchanged: bool,
        rematerialized: u32,
    ) -> Result<ClassificationReconciliation, LibraryError> {
        match local {
            None => self.adopt_classification_baseline(client, token, remote, false, None),
            Some(authority) if authority.epoch != remote.epoch => {
                // A different epoch is a new authority for the *same* library (the guard
                // above already refused a different one), so the stored cursor and caches
                // describe something else. Re-adopting is the only correct response; there
                // is no meaningful incremental path across epochs.
                self.adopt_classification_baseline(client, token, remote, true, Some(authority))
            }
            // Coordinated poll only: the shared status proves nothing moved since the
            // stored cursor, so the change feed would be empty.
            Some(authority) if skip_unchanged && authority.cursor == remote.cursor => {
                Ok(ClassificationReconciliation {
                    adopted: true,
                    server_cursor: Some(remote.cursor),
                    local_cursor: Some(authority.cursor),
                    rematerialized_assignments: rematerialized,
                    ..Default::default()
                })
            }
            Some(authority) => match self.apply_classification_changes(client, token, authority) {
                Ok((applied, cursor)) => Ok(ClassificationReconciliation {
                    adopted: true,
                    applied_changes: applied,
                    server_cursor: Some(remote.cursor),
                    local_cursor: Some(cursor),
                    behind_by: remote.cursor - cursor,
                    rematerialized_assignments: rematerialized,
                    ..Default::default()
                }),
                Err(
                    LibraryError::ClassificationCursorExpired
                    | LibraryError::ClassificationCursorAhead,
                ) => {
                    // The change log cannot be continued: expiry means retained history
                    // no longer covers this cursor, and a cursor ahead of the server
                    // means the identity is skewed. Both recover the same way — a fresh
                    // baseline replaces the confirmed replica.
                    self.adopt_classification_baseline(client, token, remote, true, Some(authority))
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
        observed: Option<&ClassificationAuthority>,
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
        let local_cursor = self
            .commit_classification_baseline(&baseline, remote, replace_existing, observed)?;
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
        observed: Option<&ClassificationAuthority>,
    ) -> Result<i64, LibraryError> {
        if replace_existing {
            self.install_classification_baseline(baseline, remote, observed)
        } else {
            self.adopt_first_classification_baseline(baseline, remote, observed)
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
        observed: Option<&ClassificationAuthority>,
    ) -> Result<i64, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // The comparison and the install share this transaction, so no local mutation can
        // slip between them, and the baseline walk's preconditions are re-checked here for
        // the same reason as the re-adoption path.
        require_clean_baseline_receive(&transaction, &remote.library_id, observed)?;
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
    ///
    /// The transaction begins by re-asserting the receive preconditions. The caller read the
    /// outbox and the authority *before* its network walk, so that read cannot authorize a
    /// write that lands after the round trip: a local Classification edit can be durably
    /// committed while the baseline pages are being downloaded. Installing then would replace
    /// the user's current intent with the pre-edit state the server described, so the whole
    /// install is refused and the intent survives to be delivered first.
    fn install_classification_baseline(
        &self,
        baseline: &Baseline,
        remote: &crate::cloud::client::SyncAuthorityDomain,
        observed: Option<&ClassificationAuthority>,
    ) -> Result<i64, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_clean_baseline_receive(&transaction, &remote.library_id, observed)?;
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
                ProjectionContext {
                    epoch: remote.epoch,
                    sequence: None,
                },
            )?;
        }
        // Assignments waiting for their Asset's upload are the user's current intent and
        // the authority cannot describe those Assets yet, so the wholesale clear above must
        // not erase them.
        reapply_waiting_assignments(&transaction)?;
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
                // The page's changes and the cursor that describes them commit together, and
                // the ordering check happens inside that same transaction. The requested
                // cursor is passed in so the transaction can prove the page still continues
                // the *stored* log, rather than assuming the pre-request read still holds.
                self.apply_classification_page_guarded(&page.items, page.next_after, Some(requested))?;
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
    ///
    /// # Authority states this function keeps distinct
    ///
    /// * **remote change cursor** — how far this replica has replayed the server's ordered
    ///   log. It is the only thing `authority.cursor` means.
    /// * **confirmed state at that cursor** — the revision caches, which must describe the
    ///   authority exactly as far as the cursor claims.
    /// * **command receipt / confirmed command result** — what `flush` recorded for an
    ///   accepted command. A result can be *ahead* of the cursor (see below).
    /// * **optimistic local projection** — `classification_entries` /
    ///   `asset_classifications` as the user's own unsent edits leave them.
    /// * **deferred authoritative assignment** — a cached assignment whose Asset is not
    ///   local yet, so only its revision is recorded.
    ///
    /// # Why the preconditions are re-checked here
    ///
    /// The caller reads the outbox and the authority *before* its network request, so that
    /// read cannot authorize a write that lands after the round trip: a user edit can be
    /// durably committed while the response is in flight. The page is therefore only applied
    /// if the same preconditions still hold inside this transaction — no intent has appeared
    /// — and the page still continues from the cursor that is stored *now* rather than the
    /// one the request was issued with.
    fn apply_classification_page(
        &self,
        items: &[ClassificationChange],
        cursor: i64,
    ) -> Result<(), LibraryError> {
        self.apply_classification_page_guarded(items, cursor, None)
    }

    /// Apply one change page, optionally requiring the stored cursor and a clean queue.
    ///
    /// `expected_cursor` is the cursor the page was requested from when called from the
    /// receive loop; `None` keeps the historical behaviour of deriving it from stored state.
    fn apply_classification_page_guarded(
        &self,
        items: &[ClassificationChange],
        cursor: i64,
        expected_cursor: Option<i64>,
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
        // Re-assert the receive preconditions. An intent that appeared during the request
        // means the local state this page would overwrite is now the user's current intent.
        let stored = read_authority(&transaction)?
            .ok_or(LibraryError::ClassificationAuthorityInactive)?;
        require_clean_receive(
            &transaction,
            |transaction| Ok(!has_unresolved_intents(transaction)?),
            &stored.library_id,
            stored.cursor,
        )?;
        let mut current = stored.cursor;
        // The page was composed against the cursor the caller requested from. If the stored
        // cursor no longer matches, this page does not continue the stored log and applying
        // it would skip or replay changes.
        if let Some(expected) = expected_cursor {
            if current != expected {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
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
                    ProjectionContext {
                        epoch: stored.epoch,
                        sequence: Some(change.sequence),
                    },
                )?;
            }
            if let Some(transition) = transition {
                // The pre-application comes from durable state keyed by this change's own
                // operation id — never from the tombstone, which this same iteration just
                // wrote. `None` means nothing was applied ahead of this change, so the whole
                // transition is outstanding and the cache must account for all of it.
                let preapplied = read_preapplied_delete(
                    &transaction,
                    &change.operation_id,
                    stored.epoch,
                    transition,
                )?;
                apply_assignment_transition(
                    &transaction,
                    transition,
                    &now,
                    stored.epoch,
                    change.sequence,
                    preapplied,
                )?;
                // The change is now behind the cursor, so its record has served its purpose.
                retire_preapplied_delete(&transaction, &change.operation_id, stored.epoch)?;
                // An Asset the authority does not know yet (its assignment waits for the
                // upload) can still name the deleted Classification locally. It follows the
                // same transition the authority applied to the Assets it knows; otherwise
                // the `RESTRICT` relation would refuse this page forever.
                move_unconfirmed_assignments(
                    &transaction,
                    transition,
                    stored.epoch,
                    change.sequence,
                )?;
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
        if has_unresolved_intents(&connection)? {
            return Ok(0);
        }
        // A projection with no ordering claim still has to attribute its target check to the
        // authority identity the cached assignments belong to: a confirmed delete records the
        // epoch it was confirmed under, and only that epoch's records may excuse an assignment
        // to an absent Classification.
        //
        // `0` is the correct attribution when no authority row exists. Records are constrained
        // to `epoch >= 1`, so this matches none of them — which is right, because a replica
        // with cached assignments and no adoption has no confirmed delete to appeal to, and a
        // corrupt cache row must still be refused rather than skipped.
        let epoch = read_authority(&connection)?
            .map(|authority| authority.epoch)
            .unwrap_or(0);
        let transaction = connection.transaction()?;
        // Only lineages that can actually produce a write are visited, through one set-based
        // candidate query rather than a per-row sweep. The sweep was three point queries per
        // cached Asset — roughly 24k statements for 8k assignments — even when nothing had
        // changed; this avoids those Rust-side N+1 queries and keeps an unchanged pass to a
        // single statement. The query still begins from the cache, so it can still scan the
        // confirmed rows inside SQLite; see `deferred_assignment_candidates` for what that
        // does and does not claim.
        let candidates = deferred_assignment_candidates(&transaction)?;
        let mut changed = 0u32;
        for (asset_id, classification_id) in &candidates {
            // `project_assignment` re-checks and is the only writer, so the selection can
            // stay a superset without duplicating the fail-closed corruption check or the
            // Character enqueue in two places.
            if project_assignment(
                &transaction,
                asset_id,
                classification_id.as_deref(),
                ProjectionContext {
                    epoch,
                    sequence: None,
                },
            )? {
                changed += 1;
            }
        }
        transaction.commit()?;
        Ok(changed)
    }
}

/// The confirmed assignments whose visible projection is not already correct.
///
/// This is the whole no-op path of [`Library::materialize_deferred_classification_assignments`]:
/// one set-based candidate query instead of a row-by-row sweep, which avoids the Rust-side N+1
/// point queries and keeps an unchanged pass to a single SQL statement. It returns exactly the
/// rows that [`project_assignment`] would write, plus the rows it would refuse as corruption, so
/// selecting a row is the same decision as visiting it — only made in SQL.
///
/// # What this does and does not claim about cost
///
/// The statement still starts from the assignment revision cache, so it can still scan the
/// confirmed rows *inside* SQLite. The improvement is that the per-row work moved out of Rust
/// and into one query — measured at roughly 24,000 point statements and 45ms before, versus one
/// statement and about 8ms for 8k assignments — not that the pass became proportional to
/// outstanding work alone. A strictly proportional no-op path would need tracked deferred work,
/// which this deliberately does not add.
///
/// A row qualifies in two cases, and the two must stay distinct:
///
/// * **The authority names a Classification this PC does not have.** A locally materialized
///   Asset pointing at an absent Classification is replica corruption (`project_assignment`
///   refuses it), and it is detectable *before* the visible comparison, exactly as that
///   function checks it even when the visible value already agrees.
/// * **The visible relation is not exactly the authoritative value.** Assignment is
///   single-valued, so the desired visible set is either empty (`NULL`, authoritative
///   unassigned) or one row. `asset_classifications` is nonetheless a relation table, so the
///   comparison is exact set equality — a row carrying the desired value *and* a stale second
///   row is a disagreement, not a match.
///
/// An Asset with no cache row is never returned: it was never described by the authority, so
/// its local relations are pre-adoption state that must not be touched. An Asset the authority
/// described but which is not materialized locally is likewise excluded — that withholding is
/// the deferred state itself, and it is completed when the Asset appears.
fn deferred_assignment_candidates(
    connection: &Connection,
) -> Result<Vec<(String, Option<String>)>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT r.asset_id, r.classification_id
           FROM classification_authority_assignment_revisions r
          WHERE EXISTS (SELECT 1 FROM assets a WHERE a.id = r.asset_id)
            AND (
                 (r.classification_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM classification_entries c
                                   WHERE c.id = r.classification_id))
              OR NOT (
                   (SELECT COUNT(*) FROM asset_classifications ac
                     WHERE ac.asset_id = r.asset_id) = (r.classification_id IS NOT NULL)
                   AND NOT EXISTS (SELECT 1 FROM asset_classifications ac
                                    WHERE ac.asset_id = r.asset_id
                                      AND (r.classification_id IS NULL
                                           OR ac.classification_id IS NOT r.classification_id))
                 )
            )
          ORDER BY r.asset_id",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
impl Library {
    /// Test seam: how many assignments the deferred-materialization selection would visit.
    ///
    /// The point of the set-based no-op path is that this scales with *outstanding* work, not
    /// with the number of Assets the authority has ever described, so this is what a test
    /// measures: a fully converged replica must report zero however large it is, and a single
    /// newly-appeared or diverged Asset must report exactly one.
    pub(crate) fn deferred_assignment_work_for_test(&self) -> Result<usize, LibraryError> {
        let connection = self.connection()?;
        Ok(deferred_assignment_candidates(&connection)?.len())
    }
}

/// Re-assert, inside the baseline install transaction, that the receive may still proceed.
///
/// The receive half reads the outbox *before* its network walk, so that read cannot authorize
/// a write that lands after the round trip. A baseline walk can span several requests, which
/// makes the window much wider than the incremental path's: a user edit committed at any point
/// during the download must not be replaced by the pre-edit state the baseline describes.
///
/// This runs in the same transaction that installs the baseline, so either the queue is still
/// clean and the install lands, or the whole install is abandoned with the intent intact. The
/// caller turns the refusal into the usual "the intent takes precedence this cycle" state: the
/// next pass flushes that intent before it receives again.
fn require_clean_baseline_receive(
    transaction: &Transaction<'_>,
    library_id: &str,
    observed: Option<&ClassificationAuthority>,
) -> Result<(), LibraryError> {
    // The cursor a refusal reports is the one the replica stood at when the refusal was
    // decided: nothing was written, so it still stands exactly there. Reading it first also
    // lets the identity check below compare against the same row the install would replace.
    let stored = read_authority(transaction)?;
    let refused = |library_id: &str, cursor: i64| LibraryError::AuthorityReceivePreconditionChanged {
        library_id: library_id.to_owned(),
        cursor,
    };
    if has_unresolved_intents(transaction)? {
        return Err(refused(
            library_id,
            stored.as_ref().map(|authority| authority.cursor).unwrap_or(0),
        ));
    }
    // A clean queue is not sufficient. The caller read this authority state *before* its
    // network walk, so that read cannot authorize an install that lands after the round trip:
    // another receive can complete in the meantime and install a newer baseline — most
    // sharply after an epoch re-activation, where the domain legitimately has more than one
    // in-flight walk against the same library. Installing the older baseline then would move
    // the cursor backwards and describe an authority identity the server no longer has, so
    // the install must prove the state it was requested against has not moved.
    //
    // The comparison is the whole identity the install depends on, not just the cursor: an
    // unchanged cursor under a different epoch or contract describes a different authority,
    // and a *newly* adopted row where the caller observed none is the same class of change.
    let unchanged = match (observed, &stored) {
        (None, None) => true,
        (Some(observed), Some(stored)) => {
            observed.library_id == stored.library_id
                && observed.epoch == stored.epoch
                && observed.contract_version == stored.contract_version
                && observed.cursor == stored.cursor
        }
        _ => false,
    };
    if !unchanged {
        let cursor = stored.as_ref().map(|authority| authority.cursor).unwrap_or(0);
        let library_id = stored
            .as_ref()
            .map(|authority| authority.library_id.clone())
            .unwrap_or_else(|| library_id.to_owned());
        return Err(refused(&library_id, cursor));
    }
    Ok(())
}

/// Re-assert, inside the writing transaction, that a receive's preconditions still hold.
///
/// The receive half reads the queue *before* its network request, so that read cannot
/// authorize a write that lands after the round trip: a local mutation can be durably
/// committed while a response is in flight, and applying the response then would overwrite
/// the user's current intent with state the server confirmed before that intent existed.
///
/// This runs in the same transaction that writes the page, so either the queue is still clean
/// and the page lands, or the whole page is abandoned with the intent intact. The caller turns
/// the refusal back into "the user's intent takes precedence this cycle" rather than an error
/// the user sees, because the very next pass flushes that intent first.
fn require_clean_receive(
    transaction: &Transaction<'_>,
    outbox: fn(&Transaction<'_>) -> Result<bool, LibraryError>,
    library_id: &str,
    cursor: i64,
) -> Result<(), LibraryError> {
    if !outbox(transaction)? {
        return Err(LibraryError::AuthorityReceivePreconditionChanged {
            library_id: library_id.to_owned(),
            cursor,
        });
    }
    Ok(())
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
    // A baseline replaces the very cache a pre-applied delete moved, so a record can no
    // longer account for anything: the change it belonged to is either behind the baseline
    // cursor or superseded by it. Keeping one would risk it matching a later delete that
    // reused the operation id.
    transaction.execute(
        "DELETE FROM classification_authority_preapplied_deletes",
        [],
    )?;
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
/// Every cached lineage naming the deleted Classification moves to the transition's
/// destination (its parent, or unassigned for a root), with each revision incrementing by
/// exactly one — which is what the server did, so the replica reproduces the same numbers.
///
/// # How the transition is verified
///
/// The transition is checked against the **authority assignment cache**, not against
/// `asset_classifications`: the authority legitimately holds assignments for Assets this PC
/// has not materialized, so a visible-row count would be smaller than the server's own
/// `affectsAssignments` for reasons that are not divergence.
///
/// The count cannot be verified by recomputing it locally. This replica may hold lineages the
/// server's delete never counted — a change the server ordered *earlier* that this replica had
/// not replayed yet can move a lineage out of the deleted Classification again, and this PC's
/// own confirmed delete can already have moved lineages it held. Neither is reproducible from
/// the cache at replay time, so a local recount would reject valid history.
///
/// What *is* falsifiable is the authority's own durable statement. When this PC confirmed the
/// delete it recorded the `affectsAssignments` the authority reported (see
/// [`record_preapplied_delete`]), so replay requires:
///
/// * the change must claim **exactly** the count the authority reported for this operation —
///   a page disagreeing with durable state is malformed;
/// * and no more lineages may still name the deleted Classification than that count, because
///   a replica holding *more* than the authority's own delete accounted for is missing the
///   history that removed them.
///
/// When no such row exists — every delete this PC did not itself confirm — nothing can explain
/// a shortfall, so exactly `affectsAssignments` lineages must still be here.
///
/// The accounting is deliberately keyed by the change's own operation id and never inferred
/// from the tombstone: this same replay writes the tombstone, so reading it back would make
/// the verification unfalsifiable.
///
/// A record is consumed by the replay it accounts for, so it cannot excuse a later delete.
fn apply_assignment_transition(
    transaction: &Transaction<'_>,
    transition: &ClassificationAssignmentTransition,
    now: &str,
    epoch: i64,
    sequence: i64,
    preapplied: Option<PreappliedDelete>,
) -> Result<(), LibraryError> {
    // Only the lineages still naming `from` are moved, and they are read *after* every earlier
    // change in the page has run, so a superseding change has already removed its own lineage
    // from this remainder.
    let affected = assignments_naming(transaction, &transition.from_classification_id)?;
    let still_naming =
        i64::try_from(affected.len()).map_err(|_| LibraryError::InvalidCloudResponse)?;
    match &preapplied {
        Some(preapplied) => {
            // A record describing a different amount of work than the change claims means the
            // response and the durable state disagree about one operation, which the
            // operation-id keying cannot otherwise have produced.
            // The record and the change are two statements about one operation, so they must
            // agree on the sequence the authority assigned it as well as the count it used.
            // Equality — not merely "not later" — is the right check: the operation id is
            // unique to the change the accept described, so any difference means the row and
            // the record are not describing the same thing.
            if preapplied.change_sequence != sequence
                || preapplied.affects_assignments != transition.affects_assignments
            {
                return Err(LibraryError::InvalidCloudResponse);
            }
            // The authority's delete saw `affectsAssignments` lineages. Locally those are the
            // pre-applied lineages that *survive* — a change the authority ordered earlier may
            // have superseded some — plus the ones still naming `from`. The survivors cannot
            // outnumber what was pre-applied, so the remainder has to land in
            // `[0, preapplied_moved]`.
            //
            // Both ends catch real divergence. A negative remainder means this replica is
            // holding lineages the authority's own delete never accounted for, and one above
            // `preapplied_moved` means it is missing the history that moved lineages away.
            let unexplained = transition.affects_assignments - still_naming;
            if unexplained < 0 || unexplained > preapplied.preapplied_moved {
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
        None => {
            if still_naming != transition.affects_assignments {
                // Nothing was pre-applied, so nothing can explain a shortfall or a surplus:
                // every lineage the transition claims has to still be here to move.
                return Err(LibraryError::InvalidCloudResponse);
            }
        }
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
            ProjectionContext {
                epoch,
                sequence: Some(sequence),
            },
        )?;
    }
    Ok(())
}

/// Move local relations still naming a deleted Classification that no cached lineage
/// covered, exactly as the authority's delete moved the lineages it knows.
fn move_unconfirmed_assignments(
    transaction: &Transaction<'_>,
    transition: &ClassificationAssignmentTransition,
    epoch: i64,
    sequence: i64,
) -> Result<(), LibraryError> {
    let remaining: Vec<String> = transaction
        .prepare("SELECT asset_id FROM asset_classifications WHERE classification_id = ?1")?
        .query_map([&transition.from_classification_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for asset_id in &remaining {
        materialize_assignment(
            transaction,
            asset_id,
            transition.to_classification_id.as_deref(),
            ProjectionContext {
                epoch,
                sequence: Some(sequence),
            },
        )?;
    }
    Ok(())
}

/// Re-apply the optimistic effect of assignment intents still waiting for their Asset.
///
/// A baseline rebuilds `asset_classifications` from authority state, which cannot describe
/// an Asset whose upload has not committed. The newest waiting intent per Asset is the
/// user's current choice, so it is written back; a target the baseline no longer carries
/// leaves the Asset unassigned rather than failing the install on the `RESTRICT` relation.
fn reapply_waiting_assignments(transaction: &Transaction<'_>) -> Result<(), LibraryError> {
    let rows: Vec<(String, String)> = transaction
        .prepare(&format!(
            "SELECT o.asset_id, o.payload FROM classification_authority_outbox o
             WHERE o.state = 'pending' AND o.command_type = '{ASSIGNMENT}' AND {waiting}
             ORDER BY o.seq",
            waiting = crate::library::album_authority::asset_waiting_sql("o.asset_id"),
        ))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut desired: std::collections::BTreeMap<String, Option<String>> =
        std::collections::BTreeMap::new();
    for (asset_id, payload) in rows {
        let Ok(body) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        let target = body
            .get("classificationId")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        desired.insert(asset_id, target);
    }
    for (asset_id, target) in desired {
        transaction.execute(
            "DELETE FROM asset_classifications WHERE asset_id = ?1",
            [&asset_id],
        )?;
        if let Some(target) = target {
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id)
                 SELECT ?1, id FROM classification_entries WHERE id = ?2",
                params![asset_id, target],
            )?;
        }
    }
    Ok(())
}

/// Where a projection's target check is coming from.
///
/// A projection may only point at a Classification that is absent from
/// `classification_entries` when this replica has evidence the absence is authoritative
/// rather than corruption. What counts as evidence depends on the caller, so it is passed
/// explicitly instead of inferred.
///
/// * `sequence: Some(n)` — the caller is replaying the change log at sequence `n`, so the
///   evidence is a confirmed delete that removed the target *after* `n`. A change the
///   authority ordered earlier than that delete legitimately names a node the delete has
///   since removed, and this replica is simply replaying history.
/// * `sequence: None` — the caller makes no ordering claim (deferred materialization, a
///   baseline install). Any confirmed delete naming the target then counts, which is the
///   narrowest reading available without an ordering.
struct ProjectionContext {
    epoch: i64,
    sequence: Option<i64>,
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
    context: ProjectionContext,
) -> Result<(), LibraryError> {
    project_assignment(transaction, asset_id, classification_id, context)?;
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
    context: ProjectionContext,
) -> Result<(), LibraryError> {
    project_assignment_impl(transaction, asset_id, classification_id, false, context)?;
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
    context: ProjectionContext,
) -> Result<bool, LibraryError> {
    project_assignment_impl(transaction, asset_id, classification_id, true, context)
}

/// The single projection body, with the Character decision optionally suppressed.
fn project_assignment_impl(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
    enqueue: bool,
    context: ProjectionContext,
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
    if let Some(classification_id) = classification_id {
        let materializable: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
            [classification_id],
            |row| row.get(0),
        )?;
        if !materializable {
            // A missing *Asset* is a legitimate deferred projection; a missing
            // *Classification* is not — with one exception that is itself authoritative
            // state rather than corruption.
            //
            // The server cannot produce a *new* assignment to a Classification that does
            // not exist: ordinary commands validate the target, staging validates every
            // assignment target, and a delete moves its Assets away atomically. So a
            // locally materialized Asset pointing at an absent Classification it never
            // deleted means this replica is corrupt, and caching-and-advancing would hide
            // that behind a relation that silently never appears.
            //
            // But a replica may legitimately be *ahead* of its cursor: confirming a delete
            // applies that delete locally, while changes the server ordered *before* it may
            // not have been replayed yet. Such a change can name the just-deleted
            // Classification perfectly correctly, and only its revision is recorded — the
            // visible row is withheld, which the schema requires anyway, because
            // `asset_classifications.classification_id` references `classification_entries`
            // and no relation to a removed row can exist.
            //
            // The evidence is *durable ordering*, not the tombstone: the tombstone alone
            // cannot distinguish a historical assignment from one the server could never
            // have produced. The server validates every assignment target, so an assignment
            // to an already-deleted Classification can only be one the authority ordered
            // *before* that delete. A confirmed delete covering this projection at a later
            // sequence says exactly that; without it the page is corruption and refusing it
            // is what keeps the cursor from advancing over a state the authority does not
            // describe. Trusting the tombstone instead would be circular, because this same
            // replay writes it.
            if !classification_is_tombstoned(transaction, classification_id)? {
                return Err(LibraryError::InvalidCloudResponse);
            }
            if !preapplied_delete_covers(
                transaction,
                context.epoch,
                classification_id,
                context.sequence,
            )? {
                return Err(LibraryError::InvalidCloudResponse);
            }
            return Ok(false);
        }
    }
    // A confirmed value that already matches the local relation needs no write. Writing
    // it anyway (DELETE + INSERT, since assignment is single-valued) would be invisible
    // in the end state but not free: it rewrites the row and fires the table's triggers
    // for every confirmed assignment on every receive pass. Skipping it is what keeps a
    // clean pass read-only, so it is part of the projection's contract rather than an
    // optimization — an unchanged projection must not create derived work.
    let desired: Vec<String> = classification_id
        .map(|classification_id| vec![classification_id.to_owned()])
        .unwrap_or_default();
    if before != desired {
        // Assignment is single-valued, so the new relation replaces any other.
        transaction.execute(
            "DELETE FROM asset_classifications WHERE asset_id = ?1",
            [asset_id],
        )?;
        if let Some(classification_id) = classification_id {
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                params![asset_id, classification_id],
            )?;
        }
    }
    if before == desired {
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

/// Whether the confirmed revision cache records this Classification as deleted.
///
/// A tombstone is authority state that no command can invent: it means the server deleted
/// the Classification. Its presence explains why a live local row is absent, so an
/// assignment naming it is historical rather than corrupt.
fn classification_is_tombstoned(
    transaction: &Transaction<'_>,
    classification_id: &str,
) -> Result<bool, LibraryError> {
    let deleted: Option<bool> = transaction
        .query_row(
            "SELECT deleted FROM classification_authority_revisions WHERE classification_id = ?1",
            [classification_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(deleted == Some(true))
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
        let observed = {
            let connection = self.connection().unwrap();
            read_authority(&connection).unwrap()
        };
        self.commit_classification_baseline(&baseline, &remote, replace_existing, observed.as_ref())
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
        let observed = {
            let connection = self.connection().unwrap();
            read_authority(&connection).unwrap()
        };
        self.install_classification_baseline(&baseline, &remote, observed.as_ref())
            .map(|_| ())
    }

    /// Test seam: apply one change page through the production apply path.
    pub(crate) fn apply_classification_page_for_test(
        &self,
        items: &[ClassificationChange],
        cursor: i64,
    ) -> Result<(), LibraryError> {
        self.apply_classification_page(items, cursor)
    }

    /// Test seam: queue one local assignment intent through the production mutation path.
    ///
    /// The mid-flight race test needs a *real* local edit — one that commits optimistic state
    /// and a durable outbox row in one transaction, exactly as the UI does — rather than a
    /// hand-written row, so the precondition guard is exercised against the same state a user
    /// edit produces.
    pub(crate) fn queue_local_assignment_for_test(&self, asset_id: &str, classification_id: &str) {
        let mut connection = self.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "DELETE FROM asset_classifications WHERE asset_id = ?1",
                [asset_id],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                rusqlite::params![asset_id, classification_id],
            )
            .unwrap();
        Self::enqueue_classification_assignment_intent(
            &transaction,
            asset_id,
            Some(classification_id),
        )
        .unwrap();
        transaction.commit().unwrap();
    }
}
