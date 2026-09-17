//! Classification authority on the PC: the durable adopted state and revision caches.
//!
//! This module owns what the PC *knows* about the server's Classification authority.
//! The receive half lives in [`super::classification_reconciliation`].
//!
//! * `classification_authority_sync` — the adopted authority identity and cursor;
//! * `classification_authority_revisions` — confirmed Classification revisions and
//!   tombstones;
//! * `classification_authority_assignment_revisions` — confirmed assignment lineage
//!   state, including authoritative *unassigned* rows.
//!
//! # Receive-only
//!
//! This batch (2B) teaches the PC to receive. There is deliberately **no outbox
//! table and no send path here**: the durable outgoing queue, its operation-id
//! minting and its conflict states belong to 2B.1, together with the local mutation
//! rewiring that would give it work to do. Until then every local Classification
//! mutation keeps writing `classification_entries` and `asset_classifications`
//! directly, and the legacy publication triggers keep publishing them.
//!
//! # Two states that must stay distinct
//!
//! An assignment lineage has three possible local representations, and the difference
//! between the last two is load-bearing:
//!
//! * no cache row — this PC has never been told about that Asset (revision 0);
//! * a row with `classification_id = NULL` — an authoritative *unassigned* state at a
//!   real revision 1+;
//! * a row with a Classification id — an authoritative live assignment.
//!
//! Collapsing the middle case into the first would make a cleared assignment look like
//! one the authority never mentioned, so a later command would present revision 0 for a
//! lineage that had legitimately advanced.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::error::LibraryError;

/// The shared domain name the server reports Classification authority under.
pub(crate) const CLASSIFICATION_DOMAIN: &str = "classifications";

/// The Classification domain contract this build speaks.
pub(crate) const CLASSIFICATION_CONTRACT_VERSION: i64 = 1;

/// The `originals` role v1 carries. Immutable authority state: no command produces it,
/// so the only way a replica learns it is from a baseline.
pub(crate) const ORIGINALS_ROLE: &str = "originals";

/// The adopted Classification authority, or `None` while the domain is still PC-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClassificationAuthority {
    pub(crate) library_id: String,
    pub(crate) epoch: i64,
    pub(crate) contract_version: i64,
    pub(crate) cursor: i64,
}

/// Outcome of one Classification reconciliation pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationReconciliation {
    /// True once a Classification authority has been adopted locally.
    pub adopted: bool,
    /// True when this pass adopted or re-based a full baseline.
    pub adopted_baseline: bool,
    /// Change rows applied during this pass.
    pub applied_changes: u32,
    /// Authority cursor the server reported at the start of this pass.
    pub server_cursor: Option<i64>,
    /// Cursor durably applied locally at the end of this pass.
    pub local_cursor: Option<i64>,
    /// How far behind the authority the local replica still is.
    pub behind_by: i64,
    /// Confirmed assignments projected into `asset_classifications` by this pass whose
    /// Asset had not been materialized when the assignment was first confirmed.
    pub rematerialized_assignments: u32,
}

// ---------------------------------------------------------------------------
// Local durable state
// ---------------------------------------------------------------------------

/// The singleton adoption row, or `None` before any baseline is adopted.
///
/// Its presence *is* the adoption marker: migration 0083 documents that an empty
/// table means Classification authority was never adopted, and the restore guard reads
/// exactly this.
pub(super) fn read_authority(
    connection: &Connection,
) -> Result<Option<ClassificationAuthority>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor
             FROM classification_authority_sync WHERE singleton = 1",
            [],
            |row| {
                Ok(ClassificationAuthority {
                    library_id: row.get(0)?,
                    epoch: row.get(1)?,
                    contract_version: row.get(2)?,
                    cursor: row.get(3)?,
                })
            },
        )
        .optional()?)
}

pub(super) fn write_authority(
    transaction: &Transaction<'_>,
    authority: &ClassificationAuthority,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO classification_authority_sync
            (singleton, library_id, epoch, contract_version, cursor, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(singleton) DO UPDATE SET library_id = excluded.library_id,
             epoch = excluded.epoch, contract_version = excluded.contract_version,
             cursor = excluded.cursor, updated_at = excluded.updated_at",
        params![
            authority.library_id,
            authority.epoch,
            authority.contract_version,
            authority.cursor,
            now
        ],
    )?;
    Ok(())
}

/// The confirmed Classification revision and tombstone flag, or `None` when the
/// authority has never told this PC about that Classification.
pub(super) fn read_classification_revision(
    connection: &Connection,
    classification_id: &str,
) -> Result<Option<(i64, bool)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT entity_revision, deleted FROM classification_authority_revisions
             WHERE classification_id = ?1",
            [classification_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(super) fn write_classification_revision(
    transaction: &Transaction<'_>,
    classification_id: &str,
    revision: i64,
    deleted: bool,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO classification_authority_revisions
            (classification_id, entity_revision, deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(classification_id) DO UPDATE SET
             entity_revision = excluded.entity_revision, deleted = excluded.deleted,
             updated_at = excluded.updated_at",
        params![classification_id, revision, i64::from(deleted), now],
    )?;
    Ok(())
}

/// The confirmed assignment lineage state, or `None` when this PC has never been told
/// about that Asset.
///
/// `Some((None, revision))` is the authoritative unassigned state, which is not the
/// same as `None`: see the module docs.
pub(super) fn read_assignment_revision(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<(Option<String>, i64)>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT classification_id, entity_revision
             FROM classification_authority_assignment_revisions WHERE asset_id = ?1",
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(super) fn write_assignment_revision(
    transaction: &Transaction<'_>,
    asset_id: &str,
    classification_id: Option<&str>,
    revision: i64,
    now: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO classification_authority_assignment_revisions
            (asset_id, classification_id, entity_revision, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(asset_id) DO UPDATE SET
             classification_id = excluded.classification_id,
             entity_revision = excluded.entity_revision, updated_at = excluded.updated_at",
        params![asset_id, classification_id, revision, now],
    )?;
    Ok(())
}

/// Every cached assignment whose lineage currently names this Classification.
///
/// This reads the *authority cache*, not `asset_classifications`, because the authority
/// legitimately holds assignments for Assets this PC has not materialized. The count it
/// returns is what a delete transition is verified against.
pub(super) fn assignments_naming(
    connection: &Connection,
    classification_id: &str,
) -> Result<Vec<(String, i64)>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT asset_id, entity_revision FROM classification_authority_assignment_revisions
         WHERE classification_id = ?1 ORDER BY asset_id",
    )?;
    let rows = statement.query_map([classification_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The role binding this PC has adopted, or `None` before adoption.
///
/// Roles are not stored in a new table: `classification_roles` (migration 0060) is the
/// existing product table and already *is* the local materialization of the immutable
/// role. A second copy would be a second source of truth for the same authority state.
pub(super) fn read_role(
    connection: &Connection,
    role: &str,
) -> Result<Option<String>, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT classification_id FROM classification_roles WHERE role = ?1",
            [role],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn write_role(
    transaction: &Transaction<'_>,
    role: &str,
    classification_id: &str,
) -> Result<(), LibraryError> {
    // `classification_id` is `UNIQUE` across roles, so a role that moved to a different
    // Classification must not leave the old binding behind: clearing first keeps the
    // table's own constraint satisfied while the row is replaced.
    transaction.execute("DELETE FROM classification_roles WHERE role = ?1", [role])?;
    transaction.execute(
        "INSERT INTO classification_roles (role, classification_id) VALUES (?1, ?2)",
        params![role, classification_id],
    )?;
    Ok(())
}

#[cfg(test)]
impl super::Library {
    /// Test seam: write the adoption row exactly as a completed baseline adoption does.
    pub(crate) fn adopt_classification_authority_for_test(
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
            &ClassificationAuthority {
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
}
