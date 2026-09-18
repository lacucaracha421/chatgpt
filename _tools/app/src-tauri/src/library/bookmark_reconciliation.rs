//! B5 — PC-side receive half of catalog-bookmark reconciliation.
//!
//! The server has owned accepted bookmark changes since B4. This module is the
//! client that adopts that authority:
//!
//! * `/status` tells the PC which authority exists (library, epoch, contract,
//!   cursor) and whether the domain is still PC-owned.
//! * The snapshot endpoint provides the baseline for first adoption and for a
//!   re-base once a stored cursor proves stale.
//! * The changes endpoint provides the ordered catch-up log.
//!
//! Two properties matter more than throughput here:
//!
//! 1. **Receiving a change must not become an outgoing change.** Applying a
//!    server change rewrites `online_catalog_bookmarks` directly and enqueues
//!    nothing: this module never writes `catalog_bookmark_outbox`, which B6 owns
//!    for the opposite direction. It does *read* that queue, for one narrow
//!    purpose — see property 2 — and that read cannot create work.
//! 2. **The cursor advances only with the data it describes.** One transaction
//!    writes a page's bookmarks, the cursor for that page, the authority
//!    revisions the page carries, and a re-assertion of any still-unconfirmed
//!    local intent. So an interruption re-applies the page instead of skipping
//!    past it, and an authority delivery cannot erase a change the user has made
//!    but this PC has not delivered yet.
//!
//! `bookmarkWrite` is advertised by the server contract, not by this client, so
//! no capability flag is flipped here.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::cloud::client::{CloudClient, MobileCatalogBookmarkItem, MobileCatalogChange};
use crate::library::{credential, error::LibraryError, Library};

/// The contract this build speaks. A server advertising another version is a
/// version-skew state, not a transient error.
pub(crate) const CONTRACT_VERSION: i64 = 1;

/// Page size for catch-up. The server bounds `limit` to 1..=500.
const CATCH_UP_LIMIT: u32 = 100;

/// Safety valve: refuse an unbounded catch-up rather than loop forever if a
/// server reported `hasMore` without advancing.
const MAX_PAGES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkReconciliation {
    /// Active authority this PC now tracks, or `None` while the domain is PC-owned.
    pub library_id: Option<String>,
    pub epoch: Option<i64>,
    pub contract_version: Option<i64>,
    /// Authority cursor the server reported at the end of this run.
    pub server_cursor: Option<i64>,
    /// Cursor durably applied locally.
    pub local_cursor: Option<i64>,
    /// How far behind the authority the local replica still is.
    pub behind_by: i64,
    /// Change rows applied during this run.
    pub applied_changes: usize,
    /// Whether a full baseline was adopted (first adoption or stale-cursor re-base).
    pub adopted_baseline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalSyncState {
    pub(super) library_id: String,
    pub(super) epoch: i64,
    pub(super) contract_version: i64,
    pub(super) cursor: i64,
}

/// The single durable sync row, or `None` before any baseline is adopted.
pub(super) fn read_state(connection: &Connection) -> Result<Option<LocalSyncState>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor FROM catalog_bookmark_sync WHERE singleton = 1",
            [],
            |row| {
                Ok(LocalSyncState {
                    library_id: row.get(0)?,
                    epoch: row.get(1)?,
                    contract_version: row.get(2)?,
                    cursor: row.get(3)?,
                })
            },
        )
        .optional()?)
}

fn write_state(transaction: &Transaction<'_>, state: &LocalSyncState) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO catalog_bookmark_sync (singleton, library_id, epoch, contract_version, cursor, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(singleton) DO UPDATE SET library_id = excluded.library_id, epoch = excluded.epoch,
             contract_version = excluded.contract_version, cursor = excluded.cursor, updated_at = excluded.updated_at",
        params![
            state.library_id,
            state.epoch,
            state.contract_version,
            state.cursor,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

/// Replace the whole local bookmark set with the authority baseline.
///
/// A full replacement rather than a merge: the snapshot is the authority's
/// complete materialized state (tombstones included), so merging would leave
/// behind any local row the server has since removed.
fn replace_with_baseline(
    transaction: &Transaction<'_>,
    items: &[MobileCatalogBookmarkItem],
) -> Result<(), LibraryError> {
    transaction.execute("DELETE FROM online_catalog_bookmarks", [])?;
    // A full replacement also replaces the revision cache: a row the authority no
    // longer lists has no live revision, and keeping a stale one would make the
    // next local mutation present a revision the server never had.
    transaction.execute("DELETE FROM catalog_bookmark_revisions", [])?;
    let mut insert = transaction.prepare(
        "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at) VALUES (?1, ?2, ?3)",
    )?;
    for item in items {
        // Revisions are recorded for tombstones too: re-bookmarking one must
        // present that tombstone's revision as its `expectedRevision`.
        super::bookmark_outbox::record_revision(
            transaction,
            &item.provider,
            &item.work_id,
            item.entity_revision,
        )?;
        if !item.desired_state {
            // A tombstone means "not bookmarked"; the local table stores presence
            // only, so absence is how that is represented.
            continue;
        }
        let created = item
            .created_at
            .clone()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        insert.execute(params![item.provider, item.work_id, created])?;
    }
    drop(insert);
    // An intent this PC has not delivered yet is not authority state, so a
    // baseline must not be allowed to erase it from view. This writes only the
    // bookmark table and enqueues nothing.
    super::bookmark_outbox::overlay_pending_intents(transaction)?;
    Ok(())
}

/// Apply one ordered change row locally.
///
/// `entity_revision` is not stored: the local table has no revision column and
/// the server remains the only writer of revisions. Ordering in the change log is
/// what makes the outcome correct.
fn apply_change(
    transaction: &Transaction<'_>,
    change: &MobileCatalogChange,
) -> Result<(), LibraryError> {
    // The revision is recorded for tombstones too: it is the revision a later
    // local re-bookmark must present as its `expectedRevision`.
    super::bookmark_outbox::record_revision(
        transaction,
        &change.provider,
        &change.work_id,
        change.entity_revision,
    )?;
    if change.desired_state {
        let created = change
            .created_at
            .clone()
            .ok_or(LibraryError::InvalidCloudResponse)?;
        // `created_at` is authority-owned, so a re-bookmark must take the server's
        // reset value rather than keep a stale local one.
        transaction.execute(
            "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(provider, work_id) DO UPDATE SET created_at = excluded.created_at",
            params![change.provider, change.work_id, created],
        )?;
    } else {
        transaction.execute(
            "DELETE FROM online_catalog_bookmarks WHERE provider = ?1 AND work_id = ?2",
            params![change.provider, change.work_id],
        )?;
    }
    Ok(())
}

impl Library {
    /// Durable local cursor, for callers that only want the stored state.
    pub fn catalog_bookmark_sync_state(
        &self,
    ) -> Result<Option<BookmarkReconciliation>, LibraryError> {
        let connection = self.connection()?;
        Ok(
            read_state(&connection)?.map(|state| BookmarkReconciliation {
                library_id: Some(state.library_id),
                epoch: Some(state.epoch),
                contract_version: Some(state.contract_version),
                server_cursor: None,
                local_cursor: Some(state.cursor),
                behind_by: 0,
                applied_changes: 0,
                adopted_baseline: false,
            }),
        )
    }

    fn local_cursor(&self) -> Result<Option<i64>, LibraryError> {
        let connection = self.connection()?;
        Ok(read_state(&connection)?.map(|state| state.cursor))
    }

    /// Adopt or catch up with the server bookmark authority.
    ///
    /// Adoption is explicit and server-driven: the PC only starts tracking an
    /// authority once the server advertises one. While the domain is still
    /// PC-owned this reports that and changes nothing.
    pub fn reconcile_catalog_bookmarks(&self) -> Result<BookmarkReconciliation, LibraryError> {
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
        self.reconcile_catalog_bookmarks_with(&client, &token)
    }

    /// The reconciliation itself, against an already-built client.
    ///
    /// Split out the way `notes_sync_with` is, so the orchestration can be
    /// exercised against a real server without going through credentials.
    pub(crate) fn reconcile_catalog_bookmarks_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<BookmarkReconciliation, LibraryError> {
        let authority = client.mobile_catalog_authority(token)?;
        let Some(server_library_id) = authority.library_id else {
            // Still PC-owned: nothing to receive, and no local state is invented.
            return Ok(BookmarkReconciliation {
                library_id: None,
                epoch: None,
                contract_version: None,
                server_cursor: authority.cursor,
                local_cursor: None,
                behind_by: 0,
                applied_changes: 0,
                adopted_baseline: false,
            });
        };
        let epoch = authority.epoch.ok_or(LibraryError::InvalidCloudResponse)?;
        let server_contract = authority
            .contract_version
            .ok_or(LibraryError::InvalidCloudResponse)?;
        if server_contract != CONTRACT_VERSION {
            return Err(LibraryError::CatalogBookmarkContractUnsupported);
        }
        // This PC may only receive for the library it actually is.
        if server_library_id != self.library_id()? {
            return Err(LibraryError::CatalogBookmarkAuthorityMismatch);
        }
        let server_cursor = authority.cursor.unwrap_or(0);

        let existing = {
            let connection = self.connection()?;
            read_state(&connection)?
        };

        // A stored identity that no longer matches the live authority cannot be
        // caught up incrementally: those sequences belong to a different
        // authority. A local cursor beyond the server's is the documented stale
        // case (server restored from an earlier state), whose recovery is a fresh
        // baseline. Both are handled by re-basing rather than by guessing.
        let needs_baseline = match &existing {
            None => true,
            Some(state) => {
                state.library_id != server_library_id
                    || state.epoch != epoch
                    || state.contract_version != server_contract
                    || state.cursor > server_cursor
            }
        };

        let mut adopted_baseline = false;
        if needs_baseline {
            self.adopt_fresh_baseline(client, &server_library_id, epoch, server_contract, token)?;
            adopted_baseline = true;
        }

        let mut applied = 0usize;
        for _ in 0..MAX_PAGES {
            let cursor = self.local_cursor()?.unwrap_or(0);
            let page = match client.mobile_catalog_bookmark_changes(
                &server_library_id,
                epoch,
                cursor,
                CATCH_UP_LIMIT,
                token,
            ) {
                Ok(page) => page,
                // History behind this cursor has been pruned, so an incremental
                // catch-up would silently skip those mutations. Take a fresh
                // baseline instead, once, and continue from its cursor.
                Err(LibraryError::CatalogBookmarkCursorExpired) if !adopted_baseline => {
                    self.adopt_fresh_baseline(client, &server_library_id, epoch, server_contract, token)?;
                    adopted_baseline = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            // Guard against a page that would move the cursor backwards.
            if page.cursor < cursor || page.next_after < cursor {
                return Err(LibraryError::InvalidCloudResponse);
            }
            if page.items.is_empty() {
                // `next_after` equals `after` for an empty page, so there is
                // nothing to advance and nothing to apply.
                break;
            }
            self.apply_page(
                &server_library_id,
                epoch,
                server_contract,
                &page.items,
                page.next_after,
            )?;
            applied += page.items.len();
            if !page.has_more {
                break;
            }
        }

        let local_cursor = self.local_cursor()?;
        Ok(BookmarkReconciliation {
            library_id: Some(server_library_id),
            epoch: Some(epoch),
            contract_version: Some(server_contract),
            server_cursor: Some(server_cursor),
            local_cursor,
            behind_by: server_cursor - local_cursor.unwrap_or(server_cursor),
            applied_changes: applied,
            adopted_baseline,
        })
    }

    /// Adopt the authority's full baseline, preserving undelivered local intents.
    ///
    /// Used for first adoption, identity re-base, and retention expiry. The
    /// pending-intent overlay lives in `replace_with_baseline`, so an intent this
    /// PC has not delivered survives and stays visible; a received baseline still
    /// enqueues nothing.
    fn adopt_fresh_baseline(
        &self,
        client: &CloudClient,
        server_library_id: &str,
        epoch: i64,
        server_contract: i64,
        token: &str,
    ) -> Result<(), LibraryError> {
        let snapshot = client.mobile_catalog_bookmark_snapshot(server_library_id, epoch, token)?;
        if snapshot.library_id != server_library_id
            || snapshot.epoch != epoch
            || snapshot.contract_version != server_contract
        {
            return Err(LibraryError::InvalidCloudResponse);
        }
        let connection = self.connection()?;
        let mut connection = connection;
        let transaction = connection.transaction()?;
        replace_with_baseline(&transaction, &snapshot.items)?;
        // The snapshot already contains every change accepted up to its cursor, so
        // that cursor is the correct starting position. Committed with the rows it
        // describes, so an interruption re-applies rather than skips.
        write_state(
            &transaction,
            &LocalSyncState {
                library_id: server_library_id.to_owned(),
                epoch,
                contract_version: server_contract,
                cursor: snapshot.cursor,
            },
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Apply a page and publish its cursor in one transaction.
    fn apply_page(
        &self,
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        items: &[MobileCatalogChange],
        next_after: i64,
    ) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        let mut connection = connection;
        let transaction = connection.transaction()?;
        let mut previous_sequence = i64::MIN;
        for change in items {
            // The change log is ordered; a page that is not strictly ascending
            // would make the local result depend on delivery order.
            if change.sequence <= previous_sequence {
                return Err(LibraryError::InvalidCloudResponse);
            }
            previous_sequence = change.sequence;
            apply_change(&transaction, change)?;
        }
        // An unconfirmed local intent outlives this page: the authority has not
        // accepted it yet, so it is not authority state and must stay visible.
        // Writes only the bookmark table and enqueues nothing.
        super::bookmark_outbox::overlay_pending_intents(&transaction)?;
        // Durability boundary: the changes and the cursor describing them commit
        // together, so an interruption re-applies rather than skips.
        write_state(
            &transaction,
            &LocalSyncState {
                library_id: library_id.to_owned(),
                epoch,
                contract_version,
                cursor: next_after,
            },
        )?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
impl Library {
    /// Test seam: adopt a baseline exactly as `reconcile_catalog_bookmarks` does.
    pub(crate) fn adopt_bookmark_baseline_for_test(
        &self,
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        cursor: i64,
        items: &[MobileCatalogBookmarkItem],
    ) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        let mut connection = connection;
        let transaction = connection.transaction()?;
        replace_with_baseline(&transaction, items)?;
        write_state(
            &transaction,
            &LocalSyncState {
                library_id: library_id.to_owned(),
                epoch,
                contract_version,
                cursor,
            },
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Test seam: apply one page through the production apply path.
    pub(crate) fn apply_bookmark_page_for_test(
        &self,
        library_id: &str,
        epoch: i64,
        contract_version: i64,
        items: &[MobileCatalogChange],
        next_after: i64,
    ) -> Result<(), LibraryError> {
        self.apply_page(library_id, epoch, contract_version, items, next_after)
    }
}
