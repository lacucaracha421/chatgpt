//! Album authority receive: baseline adoption and ordered change replay.
//!
//! Sync order for this domain is **flush-first**:
//!
//! ```text
//! flush pending intents -> only when clean, receive authority changes
//! ```
//!
//! The bookmark pilot deliberately uses `receive -> flush -> receive`. Albums are
//! structural, so a received page must never replace a local structural edit the
//! server has not yet accepted or explicitly rejected. A local rename is the user's
//! current intent; letting an unrelated remote page overwrite it would discard that
//! intent silently. [`super::album_authority`] owns the send half and the queue; this
//! module only reads the queue to decide whether it may run.
//!
//! Two invariants carry correctness:
//!
//! 1. **Remote apply never enqueues.** Applying a baseline or a change page writes the
//!    local materialization and the revision caches, and creates no outgoing work.
//! 2. **The cursor advances only with the data it describes.** One transaction applies
//!    a page's changes and moves the cursor, so an interruption re-applies the page
//!    instead of skipping past it.

use rusqlite::{params, Transaction};

use crate::cloud::client::{
    AlbumBaselinePage, AlbumChange, AlbumMembershipProjection, AlbumProjection, CloudClient,
    ALBUM_BASELINE_ALBUMS_SECTION, ALBUM_BASELINE_MEMBERSHIPS_SECTION,
};

use super::album_authority::{
    read_authority, read_outbox, write_album_revision, write_authority,
    write_membership_revision, AlbumAuthority, ALBUM_CONTRACT_VERSION, ALBUM_DOMAIN,
};
use super::error::LibraryError;
use super::Library;

/// Page size for catch-up. The server bounds `limit` to 1..=500.
const CATCH_UP_LIMIT: u32 = 100;

/// Safety valve: refuse an unbounded baseline or catch-up rather than loop forever
/// against a server that reports `hasMore` without advancing.
const MAX_PAGES: usize = 100_000;

/// Attempts at one frozen baseline walk before deferring to the poll loop.
const BASELINE_ATTEMPTS: u32 = 3;

/// Outcome of one Album reconciliation pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumReconciliation {
    pub adopted: bool,
    pub adopted_baseline: bool,
    pub applied_changes: u32,
    pub server_cursor: Option<i64>,
    pub local_cursor: Option<i64>,
    pub behind_by: i64,
    /// Confirmed relations whose Asset appeared locally and were projected into
    /// `asset_albums` by this pass. Local projection only: it implies no server change.
    pub rematerialized_memberships: u32,
    /// True when the queue was not clean, so no receive was attempted.
    pub deferred_to_outbox: bool,
}

/// The complete Album state a baseline describes, accumulated across pages.
#[derive(Default)]
struct Baseline {
    albums: Vec<AlbumProjection>,
    memberships: Vec<AlbumMembershipProjection>,
    cursor: i64,
}

impl Library {
    /// Adopt or catch up with the Album authority using the configured cloud endpoint.
    ///
    /// The counterpart of `flush_album_outbox`: the orchestration layer calls this to
    /// receive, and the send half runs first because a pending structural edit must not
    /// be overwritten by an unrelated remote page.
    pub fn reconcile_albums(&self) -> Result<AlbumReconciliation, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Err(LibraryError::InvalidCloudSyncConfig);
        }
        let endpoint = config
            .api_base_url
            .as_deref()
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(endpoint)?;
        self.reconcile_album_authority(&client, &token)
    }

    /// Adopt or catch up with the Album authority.
    ///
    /// Refuses to receive while any local intent is unresolved: `deferred_to_outbox`
    /// is the documented "the user's intent takes precedence this cycle" state, not an
    /// error to retry blindly.
    pub(crate) fn reconcile_album_authority(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<AlbumReconciliation, LibraryError> {
        // The guard is scoped to the reads it protects: holding it across the network
        // round trip below would block every other database caller, and the helpers
        // this function calls take the same non-reentrant lock themselves.
        let (outbox_clean, local) = {
            let connection = self.connection()?;
            (
                read_outbox(&connection)?.is_empty(),
                read_authority(&connection)?,
            )
        };
        if !outbox_clean {
            return Ok(AlbumReconciliation {
                adopted: local.is_some(),
                deferred_to_outbox: true,
                local_cursor: local.as_ref().map(|value| value.cursor),
                ..Default::default()
            });
        }
        // Complete any confirmed relation whose Asset has since appeared locally. This is
        // a local projection step, not a synchronization step: it produces no server
        // revision, no outbox row and no cursor movement, so it is safe on every clean
        // cycle and is the only recovery for a withheld relation when the client never
        // needs another baseline.
        let rematerialized = self.materialize_deferred_album_memberships()?;
        let status = client.sync_status(token)?;
        let remote = status
            .domains
            .iter()
            .find(|domain| domain.domain == ALBUM_DOMAIN);
        let Some(remote) = remote else {
            // No active `albums` authority: the domain is still PC-owned, so the
            // legacy publication path remains responsible and nothing is adopted.
            return Ok(AlbumReconciliation {
                local_cursor: local.as_ref().map(|value| value.cursor),
                rematerialized_memberships: rematerialized,
                ..Default::default()
            });
        };
        if remote.contract_version != ALBUM_CONTRACT_VERSION {
            return Err(LibraryError::AlbumContractUnsupported);
        }
        match local {
            None => self.adopt_album_baseline(client, token, remote, false),
            Some(authority)
                if authority.library_id != remote.library_id || authority.epoch != remote.epoch =>
            {
                // A different library or epoch is a new authority, so the stored cursor
                // and caches describe something else. Re-adopting is the only correct
                // response; there is no meaningful incremental path across identities.
                self.adopt_album_baseline(client, token, remote, true)
            }
            Some(authority) => {
                match self.apply_album_changes(client, token, &authority) {
                    Ok((applied, cursor)) => Ok(AlbumReconciliation {
                        adopted: true,
                        applied_changes: applied,
                        server_cursor: Some(remote.cursor),
                        local_cursor: Some(cursor),
                        behind_by: remote.cursor - cursor,
                        rematerialized_memberships: rematerialized,
                        ..Default::default()
                    }),
                    Err(LibraryError::AlbumCursorExpired | LibraryError::AlbumCursorAhead) => {
                        // The change log cannot be continued: expiry means retained history
                        // no longer covers this cursor, and a cursor ahead of the server
                        // means the identity is skewed. Both recover the same way — a fresh
                        // baseline replaces only the confirmed replica — because there is no
                        // pending intent to preserve here: this domain receives only when
                        // the outbox is empty, so the replica is already identical to what
                        // the server confirmed.
                        self.adopt_album_baseline(client, token, remote, true)
                    }
                    Err(error) => Err(error),
                }
            }
        }
    }

    /// Walk every baseline page against one frozen cursor, then adopt atomically.
    ///
    /// Nothing local changes until the final membership page reports `complete`, so a
    /// failure or an intervening mutation leaves the existing replica untouched.
    fn adopt_album_baseline(
        &self,
        client: &CloudClient,
        token: &str,
        remote: &crate::cloud::client::SyncAuthorityDomain,
        replace_existing: bool,
    ) -> Result<AlbumReconciliation, LibraryError> {
        // Any Album command advances the cursor, so a concurrent change during a
        // multi-page walk invalidates the frozen snapshot. Retrying inside this pass
        // converges once the domain is briefly quiet; the poll loop is the retry of
        // last resort, so this stays bounded rather than spinning.
        let mut attempt = 0;
        let baseline = loop {
            attempt += 1;
            match self.fetch_album_baseline(client, token, remote) {
                Ok(baseline) => break baseline,
                Err(LibraryError::AlbumBaselineChanged) if attempt < BASELINE_ATTEMPTS => continue,
                Err(error) => return Err(error),
            }
        };
        if !replace_existing {
            // First adoption on the main PC: the authority was activated from this PC's
            // own staged snapshot, so the server baseline must describe exactly the
            // Album state already here. A difference means the activation raced the PC
            // or something else changed underneath, and overwriting local state would
            // destroy user data rather than converge it.
            self.require_first_adoption_match(&baseline)?;
        }
        let local_cursor = self.install_album_baseline(&baseline, remote)?;
        Ok(AlbumReconciliation {
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
    fn fetch_album_baseline(
        &self,
        client: &CloudClient,
        token: &str,
        remote: &crate::cloud::client::SyncAuthorityDomain,
    ) -> Result<Baseline, LibraryError> {
        let mut baseline = Baseline::default();
        let mut snapshot: Option<i64> = None;
        let mut section = ALBUM_BASELINE_ALBUMS_SECTION;
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let page: AlbumBaselinePage = client.album_baseline_page(
                &remote.library_id,
                remote.epoch,
                snapshot,
                snapshot.map(|_| section),
                after.as_deref(),
                token,
            )?;
            if page.library_id != remote.library_id
                || page.epoch != remote.epoch
                || page.contract_version != ALBUM_CONTRACT_VERSION
            {
                return Err(LibraryError::AlbumAuthorityMismatch);
            }
            match snapshot {
                None => snapshot = Some(page.snapshot_cursor),
                // Pages that describe different materialized states cannot be combined
                // into one baseline.
                Some(frozen) if page.snapshot_cursor != frozen => {
                    return Err(LibraryError::AlbumBaselineChanged)
                }
                Some(_) => {}
            }
            if page.section != section {
                return Err(LibraryError::InvalidCloudResponse);
            }
            let (albums, memberships) = page.decode()?;
            baseline.albums.extend(albums);
            baseline.memberships.extend(memberships);
            if page.has_more {
                match page.next_after {
                    Some(next) => after = Some(next),
                    None => return Err(LibraryError::InvalidCloudResponse),
                }
                continue;
            }
            if section == ALBUM_BASELINE_ALBUMS_SECTION {
                section = ALBUM_BASELINE_MEMBERSHIPS_SECTION;
                after = None;
                continue;
            }
            if !page.complete {
                return Err(LibraryError::InvalidCloudResponse);
            }
            baseline.cursor = page.snapshot_cursor;
            return Ok(baseline);
        }
        Err(LibraryError::AlbumBaselineChanged)
    }

    /// Refuse a first adoption whose baseline differs from the local Album state.
    fn require_first_adoption_match(&self, baseline: &Baseline) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, parent_id, icon_key, color_key FROM albums ORDER BY id",
        )?;
        let local_albums = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ),
                ))
            })?
            .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
        let remote_albums = baseline
            .albums
            .iter()
            .filter(|album| !album.deleted)
            .map(|album| {
                (
                    album.id.clone(),
                    (
                        album.name.clone(),
                        album.parent_id.clone(),
                        album.icon_key.clone(),
                        album.color_key.clone(),
                    ),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        if local_albums != remote_albums {
            return Err(LibraryError::AlbumFirstAdoptionMismatch);
        }
        // Relations to trashed Assets are deliberately retained locally, so this
        // compares against the local table directly rather than filtering by status.
        //
        // The authority's live set is compared for the Assets this PC actually holds:
        // a relation to an unmaterialized Asset cannot appear locally, and activation
        // ran from this PC's own staged snapshot, so every relation it staged named an
        // Asset that existed here. A baseline relation this PC cannot materialize is
        // therefore a real divergence, not a pending download.
        let mut statement = connection.prepare(
            "SELECT link.album_id, link.asset_id FROM asset_albums link
             JOIN assets asset ON asset.id = link.asset_id
             ORDER BY link.album_id, link.asset_id",
        )?;
        let live: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut expected: Vec<(String, String)> = baseline
            .memberships
            .iter()
            .filter(|membership| membership.desired_state)
            .map(|membership| (membership.album_id.clone(), membership.asset_id.clone()))
            .collect();
        expected.sort();
        expected.dedup();
        if live != expected {
            return Err(LibraryError::AlbumFirstAdoptionMismatch);
        }
        Ok(())
    }

    /// Replace the local replica and the caches, then record the adoption.
    ///
    /// One transaction, so an interruption cannot leave a half-adopted replica whose
    /// cursor claims state it does not have.
    fn install_album_baseline(
        &self,
        baseline: &Baseline,
        remote: &crate::cloud::client::SyncAuthorityDomain,
    ) -> Result<i64, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // `albums.parent_id` is `ON DELETE RESTRICT` and the self-reference is
        // immediate, so a wholesale replace would trip on its own intermediate states:
        // clearing the table violates RESTRICT for every parent, and pages arrive in
        // id order rather than parent-before-child order. Deferring moves every check
        // to COMMIT, where the transaction must be consistent — a genuinely dangling
        // parent is still refused.
        transaction.pragma_update(None, "defer_foreign_keys", "ON")?;
        // Materialization is replaced wholesale: the baseline is the authority's
        // complete live state, so merging would leave behind rows the server removed.
        transaction.execute("DELETE FROM asset_albums", [])?;
        transaction.execute("DELETE FROM albums", [])?;
        transaction.execute("DELETE FROM album_authority_revisions", [])?;
        transaction.execute("DELETE FROM album_authority_membership_revisions", [])?;
        for album in baseline.albums.iter().filter(|album| !album.deleted) {
            insert_album(&transaction, album, &now)?;
        }
        for album in &baseline.albums {
            // Tombstones reach the cache too, so a later command against a deleted
            // Album presents its real revision instead of a fabricated one.
            write_album_revision(
                &transaction,
                &album.id,
                album.entity_revision,
                album.deleted,
                &now,
            )?;
        }
        for membership in &baseline.memberships {
            write_membership_revision(
                &transaction,
                &membership.album_id,
                &membership.asset_id,
                membership.desired_state,
                membership.entity_revision,
                &now,
            )?;
            if membership.desired_state {
                materialize_membership(&transaction, &membership.album_id, &membership.asset_id)?;
            }
        }
        let authority = AlbumAuthority {
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
    fn apply_album_changes(
        &self,
        client: &CloudClient,
        token: &str,
        authority: &AlbumAuthority,
    ) -> Result<(u32, i64), LibraryError> {
        let mut applied = 0u32;
        let mut cursor = authority.cursor;
        for _ in 0..MAX_PAGES {
            // The cursor this page was requested from, kept before the page's own
            // `next_after` replaces it. Progress must be measured against the *requested*
            // value: comparing the freshly assigned cursor against itself can never fail,
            // which would make every catch-up longer than one page report a protocol
            // error as soon as the server honestly said `hasMore`.
            let requested = cursor;
            let page = client.album_changes(
                &authority.library_id,
                authority.epoch,
                requested,
                CATCH_UP_LIMIT,
                token,
            )?;
            if !page.items.is_empty() {
                // The page's changes and the cursor that describes them commit together,
                // and the ordering check happens inside that same transaction.
                self.apply_album_page(&page.items, page.next_after)?;
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
        Err(LibraryError::AlbumCursorExpired)
    }

    /// Apply one change page and advance the cursor in the same transaction.
    fn apply_album_page(&self, items: &[AlbumChange], cursor: i64) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // One page can delete a parent before its child, and `albums.parent_id` is
        // `ON DELETE RESTRICT` with an immediate check. Deferring keeps the ordering
        // that the log provides from being read as a referential error, while a page
        // that genuinely leaves a dangling parent is still refused at COMMIT.
        transaction.pragma_update(None, "defer_foreign_keys", "ON")?;
        let mut current = read_authority(&transaction)?
            .ok_or(LibraryError::AlbumAuthorityInactive)?
            .cursor;
        for change in items {
            // Sequence order is what makes the outcome correct, so a gap or a repeated row
            // is a malformed page rather than something to apply. Checking here — rather
            // than in the caller — is what keeps the cursor from ever advancing over a
            // change that was not applied.
            if change.sequence != current + 1 {
                return Err(LibraryError::InvalidCloudResponse);
            }
            current = change.sequence;
            let (album, membership) = change.delta()?;
            if let Some(album) = album {
                apply_album_projection(&transaction, album, &now)?;
            }
            if let Some(membership) = membership {
                write_membership_revision(
                    &transaction,
                    &membership.album_id,
                    &membership.asset_id,
                    membership.desired_state,
                    membership.entity_revision,
                    &now,
                )?;
                if membership.desired_state {
                    materialize_membership(
                        &transaction,
                        &membership.album_id,
                        &membership.asset_id,
                    )?;
                } else {
                    transaction.execute(
                        "DELETE FROM asset_albums WHERE album_id = ?1 AND asset_id = ?2",
                        params![membership.album_id, membership.asset_id],
                    )?;
                }
            }
        }
        // A page that stops short of the cursor it reports would leave the local replica
        // claiming state the log has not delivered.
        if current != cursor && !items.is_empty() {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let mut authority = read_authority(&transaction)?
            .ok_or(LibraryError::AlbumAuthorityInactive)?;
        authority.cursor = cursor;
        write_authority(&transaction, &authority, &now)?;
        transaction.commit()?;
        Ok(())
    }

    /// Materialize confirmed memberships whose Asset has since appeared locally.
    ///
    /// A confirmed relation to an Asset this PC had not materialized is recorded in
    /// `album_authority_membership_revisions` while its visible `asset_albums` row is
    /// deliberately withheld. Waiting for "the next baseline" is not a real recovery: a
    /// client whose epoch and cursor stay valid can reconcile incrementally forever and
    /// never adopt another baseline, so the relation would stay invisible indefinitely.
    ///
    /// This closes that gap without coupling Album authority to any ingest path. It
    /// creates no server revision, writes no outbox row and advances no cursor: the
    /// authority's state is already known and unchanged, and only the local projection of
    /// it is being completed.
    ///
    /// It is safe only when no unresolved optimistic intent exists, which is exactly the
    /// precondition `reconcile_album_authority` already enforces — a queued membership
    /// intent is the user's current intent and must keep winning over confirmed state.
    pub(crate) fn materialize_deferred_album_memberships(&self) -> Result<u32, LibraryError> {
        let connection = self.connection()?;
        if !read_outbox(&connection)?.is_empty() {
            return Ok(0);
        }
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO asset_albums (asset_id, album_id)
             SELECT revision.asset_id, revision.album_id
             FROM album_authority_membership_revisions revision
             JOIN assets asset ON asset.id = revision.asset_id
             JOIN albums album ON album.id = revision.album_id
             WHERE revision.desired_state = 1",
            [],
        )?;
        Ok(u32::try_from(inserted).unwrap_or(u32::MAX))
    }
}

/// Insert one live Album from an authoritative projection.
fn insert_album(
    transaction: &Transaction<'_>,
    album: &AlbumProjection,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO albums (id, name, parent_id, icon_key, color_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id,
             icon_key = excluded.icon_key, color_key = excluded.color_key",
        params![
            album.id,
            album.name,
            album.parent_id,
            album.icon_key,
            album.color_key,
            now
        ],
    )?;
    Ok(())
}

/// Apply one Album projection from the change log.
///
/// A deletion removes the live local Album and its memberships while the tombstone and
/// its revision stay in the cache. The cached membership relations of that Album are
/// marked non-live without inventing a new membership revision: the relation was not
/// independently edited, so bumping it would create state no replay could reproduce.
fn apply_album_projection(
    transaction: &Transaction<'_>,
    album: &AlbumProjection,
    now: &str,
) -> Result<(), LibraryError> {
    write_album_revision(
        transaction,
        &album.id,
        album.entity_revision,
        album.deleted,
        now,
    )?;
    if album.deleted {
        transaction.execute("DELETE FROM asset_albums WHERE album_id = ?1", [&album.id])?;
        transaction.execute("DELETE FROM albums WHERE id = ?1", [&album.id])?;
        transaction.execute(
            "UPDATE album_authority_membership_revisions SET desired_state = 0, updated_at = ?2
             WHERE album_id = ?1 AND desired_state = 1",
            params![album.id, now],
        )?;
        return Ok(());
    }
    insert_album(transaction, album, now)
}

/// Materialize one live membership relation when its Asset exists locally.
///
/// The authority can legitimately describe a relation to an Asset this PC has not
/// materialized yet — the server accepts assets from more than one ingest route, and a
/// fresh PC rebuilds Albums before it reconnects its local media. Treating that as an
/// error would stop the cursor forever on a relation that is correct, and refusing to
/// skip would leave the replica unable to converge at all.
///
/// So the confirmed relation revision is always recorded by the caller, and only the
/// *visible* row is conditional here. The withheld relation is completed by
/// [`Library::materialize_deferred_album_memberships`], which runs on every clean
/// reconciliation cycle — a client can catch up incrementally for a long time without
/// ever adopting another baseline, so a baseline-only recovery would leave the relation
/// invisible indefinitely.
fn materialize_membership(
    transaction: &Transaction<'_>,
    album_id: &str,
    asset_id: &str,
) -> Result<(), LibraryError> {
    let known: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
        [asset_id],
        |row| row.get(0),
    )?;
    if !known {
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO asset_albums (asset_id, album_id) VALUES (?1, ?2)
         ON CONFLICT(asset_id, album_id) DO NOTHING",
        params![asset_id, album_id],
    )?;
    Ok(())
}

#[cfg(test)]
impl Library {
    /// Test seam: adopt an Album authority exactly as `reconcile_album_authority` does.
    ///
    /// Writes only the durable identity row, which is what every receive and send path
    /// reads to decide whether the domain is server-authoritative.
    pub(crate) fn adopt_album_authority_for_test(
        &self,
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
    ) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        write_authority(
            &transaction,
            &AlbumAuthority {
                library_id: library_id.to_owned(),
                epoch,
                contract_version,
                cursor,
            },
            &now,
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Test seam: apply one change page through the production apply path.
    pub(crate) fn apply_album_page_for_test(
        &self,
        items: &[AlbumChange],
        cursor: i64,
    ) -> Result<(), LibraryError> {
        self.apply_album_page(items, cursor)
    }

    /// Test seam: run the first-adoption comparison against a candidate baseline.
    ///
    /// `install_album_baseline_for_test` deliberately installs without the comparison,
    /// because re-adoption (a new epoch) must replace state rather than refuse it.
    pub(crate) fn require_first_adoption_match_for_test(
        &self,
        albums: &[AlbumProjection],
        memberships: &[AlbumMembershipProjection],
    ) -> Result<(), LibraryError> {
        self.require_first_adoption_match(&Baseline {
            albums: albums.to_vec(),
            memberships: memberships.to_vec(),
            cursor: 0,
        })
    }

    /// Test seam: install a baseline through the production install path.
    pub(crate) fn install_album_baseline_for_test(
        &self,
        albums: &[AlbumProjection],
        memberships: &[AlbumMembershipProjection],
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
    ) -> Result<(), LibraryError> {
        let baseline = Baseline {
            albums: albums.to_vec(),
            memberships: memberships.to_vec(),
            cursor,
        };
        let remote = crate::cloud::client::SyncAuthorityDomain {
            domain: ALBUM_DOMAIN.to_owned(),
            library_id: library_id.to_owned(),
            epoch,
            contract_version,
            cursor,
        };
        self.install_album_baseline(&baseline, &remote).map(|_| ())
    }
}
