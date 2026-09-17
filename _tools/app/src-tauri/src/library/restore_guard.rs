//! Refuse a whole-database swap while local client state is tied to a server authority.
//!
//! ADR-0037 decision 6: once a shared domain has moved to server authority, an old
//! PC `library.sqlite` can no longer be a canonical rollback. Replacing the file
//! would also replace the client-side synchronization machinery that lives in that
//! same database:
//!
//! * `catalog_bookmark_sync` — the adopted authority identity and replay cursor;
//! * `catalog_bookmark_outbox` — durable local intents the server has not accepted;
//! * `catalog_bookmark_revisions` — observed authoritative entity revisions;
//! * `album_authority_sync` / `album_authority_outbox` — the Album domain's adopted
//!   identity, cursor, revision caches and durable intents;
//! * `classification_authority_sync` / `classification_authority_revisions` /
//!   `classification_authority_assignment_revisions` — the Classification domain's
//!   adopted identity, cursor and revision caches (receive-only in 2B: this domain has
//!   no outbox until 2B.1 adds the send half);
//! * `library_settings.library_id` — the logical library this replica belongs to.
//!
//! Restoring an older snapshot of that file can therefore silently roll the replica
//! back to a different library or discard intent that must never be dropped. The
//! recovery path becomes server-state restoration plus a replica rebuild, which is
//! a later batch; this module only prevents the unsafe swap.
//!
//! # Extending this for a new domain
//!
//! A domain contributes one [`Probe`] to [`PROBES`]. A probe reads only the current
//! local database and reports whether that domain has *adopted* a server authority
//! locally. That keeps the guard honest in both directions:
//!
//! * a domain with no local adoption is invisible here, so nothing changes for a
//!   library that never cut over;
//! * a domain that has adopted one blocks the swap without the guard needing to
//!   know that domain's tables, conflict rules or UI.
//!
//! The probe list is deliberately data, not control flow. Adding a domain must not
//! require editing the restore path itself.

use rusqlite::{Connection, OptionalExtension};

use super::error::LibraryError;

/// A domain's local proof that it tracks a server authority.
pub(crate) struct Probe {
    /// Stable domain name, matching the server's `authority_domains.domain`.
    pub(crate) domain: &'static str,
    /// True when this database holds adopted client state for the domain.
    ///
    /// `Err` means the state could not be read, which the caller must treat as
    /// unsafe rather than as "not adopted".
    pub(crate) adopted: fn(&Connection) -> Result<bool, LibraryError>,
}

/// Every domain whose locally adopted state a whole-database swap would corrupt.
pub(crate) const PROBES: &[Probe] = &[
    Probe {
        domain: "catalog-bookmarks",
        adopted: catalog_bookmarks_adopted,
    },
    Probe {
        domain: "albums",
        adopted: albums_adopted,
    },
    Probe {
        domain: "classifications",
        adopted: classifications_adopted,
    },
];

/// The bookmark domain's adoption marker.
///
/// `catalog_bookmark_sync` gains its singleton row only when a full authoritative
/// baseline has been adopted, so the row's presence *is* the marker — migration
/// 0080 documents this and adds no separate flag. An absent table or an empty table
/// both mean "no authority adopted", which is the pre-authority state.
fn catalog_bookmarks_adopted(connection: &Connection) -> Result<bool, LibraryError> {
    // A pre-v80 database has no table at all. `Library::open` migrates an open
    // library to the current schema, but an explicit check keeps this probe correct
    // for a snapshot or fixture built at an older version.
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_bookmark_sync')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    Ok(connection
        .query_row(
            "SELECT 1 FROM catalog_bookmark_sync WHERE singleton = 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The Album domain's adoption marker.
///
/// `album_authority_sync` gains its singleton row only once a complete Album baseline
/// has been adopted, so the row's presence *is* the marker — migration 0082 documents
/// this and adds no separate flag. An absent table or an empty table both mean "no
/// Album authority adopted", which keeps every pre-adoption Album path unchanged.
fn albums_adopted(connection: &Connection) -> Result<bool, LibraryError> {
    // A pre-v82 database has no table at all; the explicit check keeps this probe
    // correct for a fixture built at an older schema version.
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='album_authority_sync')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    Ok(connection
        .query_row(
            "SELECT 1 FROM album_authority_sync WHERE singleton = 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The Classification domain's adoption marker.
///
/// `classification_authority_sync` gains its singleton row only once a complete
/// Classification baseline has been verified and adopted, so the row's presence *is*
/// the marker — migration 0083 documents this and adds no separate flag. An absent
/// table or an empty table both mean "no Classification authority adopted", which keeps
/// every pre-adoption Classification path unchanged.
fn classifications_adopted(connection: &Connection) -> Result<bool, LibraryError> {
    // A pre-v83 database has no table at all; the explicit check keeps this probe
    // correct for a fixture built at an older schema version.
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='classification_authority_sync')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    Ok(connection
        .query_row(
            "SELECT 1 FROM classification_authority_sync WHERE singleton = 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Domains that must block a whole-database restore on this database.
///
/// Returns the adopted domain names in `PROBES` order. An empty list means the
/// caller may proceed with the legacy behavior.
pub(crate) fn adopted_domains(connection: &Connection) -> Result<Vec<&'static str>, LibraryError> {
    let mut adopted = Vec::new();
    for probe in PROBES {
        if (probe.adopted)(connection)? {
            adopted.push(probe.domain);
        }
    }
    Ok(adopted)
}

#[cfg(test)]
mod tests {
    use super::{adopted_domains, PROBES};
    use crate::library::Library;

    fn open() -> (tempfile::TempDir, Library) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        (temp, library)
    }

    #[test]
    fn a_library_that_never_adopted_authority_reports_no_domains() {
        let (_temp, library) = open();
        let connection = library.connection().unwrap();
        assert!(adopted_domains(&connection).unwrap().is_empty());
    }

    #[test]
    fn an_adopted_baseline_reports_its_domain() {
        let (_temp, library) = open();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO catalog_bookmark_sync
                    (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1, ?1, 1, 1, 5, '2026-09-15T00:00:00Z')",
                ["a1b2c3d4e5f60718293a4b5c6d7e8f90"],
            )
            .unwrap();
        assert_eq!(adopted_domains(&connection).unwrap(), ["catalog-bookmarks"]);
    }

    #[test]
    fn an_adopted_album_baseline_reports_the_album_domain() {
        let (_temp, library) = open();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO album_authority_sync
                    (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1, ?1, 1, 1, 7, '2026-09-15T00:00:00Z')",
                ["a1b2c3d4e5f60718293a4b5c6d7e8f90"],
            )
            .unwrap();
        assert_eq!(adopted_domains(&connection).unwrap(), ["albums"]);
    }

    #[test]
    fn probes_cover_every_shipped_adoption_marker_once() {
        let mut names: Vec<_> = PROBES.iter().map(|probe| probe.domain).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "a domain must appear exactly once");
        assert!(names.contains(&"catalog-bookmarks"));
        assert!(names.contains(&"albums"));
        assert!(names.contains(&"classifications"));
    }

    #[test]
    fn an_adopted_classification_baseline_reports_the_classifications_domain() {
        let (_temp, library) = open();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO classification_authority_sync
                    (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1, ?1, 1, 1, 9, '2026-09-16T00:00:00Z')",
                ["a1b2c3d4e5f60718293a4b5c6d7e8f90"],
            )
            .unwrap();
        assert_eq!(adopted_domains(&connection).unwrap(), ["classifications"]);
    }

    /// A pending Classification outbox does not need a second restore guard.
    ///
    /// The adopted sync row already makes the domain participate in restore refusal, and
    /// the outbox lives in the same database a swap would replace. What matters is that
    /// the pre-existing marker keeps working while intent is queued, so a user with
    /// undelivered edits cannot silently lose them to an old whole-database snapshot.
    #[test]
    fn an_adopted_classification_with_pending_intent_still_blocks_a_restore() {
        let (_temp, library) = open();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO classification_authority_sync
                    (singleton, library_id, epoch, contract_version, cursor, updated_at)
                 VALUES (1, ?1, 1, 1, 9, '2026-09-17T00:00:00Z')",
                ["a1b2c3d4e5f60718293a4b5c6d7e8f90"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO classification_authority_outbox
                    (operation_id, command_type, classification_id, epoch, payload, state, created_at)
                 VALUES ('00000000-0000-4000-8000-0000000000aa', 'renameClassification',
                         'c1', 1, '{\"libraryId\":\"x\"}', 'pending', '2026-09-17T00:00:00Z')",
                [],
            )
            .unwrap();
        assert_eq!(adopted_domains(&connection).unwrap(), ["classifications"]);
    }

    #[test]
    fn classification_probe_is_absent_on_a_library_that_never_adopted_it() {
        let (_temp, library) = open();
        let connection = library.connection().unwrap();
        // The migration creates the table empty, so the marker must be the row and not
        // the table's existence.
        assert!(!adopted_domains(&connection)
            .unwrap()
            .contains(&"classifications"));
        connection
            .execute("DELETE FROM classification_authority_sync", [])
            .unwrap();
        assert!(!adopted_domains(&connection)
            .unwrap()
            .contains(&"classifications"));
    }
}
