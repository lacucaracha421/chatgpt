//! PC 2B regression coverage: the Album receive half (baseline and change replay).
//!
//! These tests exercise the production apply paths (`install_album_baseline`,
//! `apply_album_page`) and the real durable rows. The transport is covered by the
//! send-half tests, which drive the real `CloudClient` over a real socket.
//!
//! `Library::connection()` takes a non-reentrant database mutex, so no assertion block
//! below calls a second accessor while it holds a connection guard.

use rusqlite::Connection;

use crate::cloud::client::{AlbumChange, AlbumMembershipProjection, AlbumProjection};
use crate::library::error::LibraryError;
use crate::library::models::{AssetAlbumPatch, CreateAlbum};
use crate::library::Library;

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
/// A second, unrelated library identity, for wrong-library refusals.
const OTHER_LIBRARY: &str = "0f1e2d3c4b5a69788796a5b4c5d3e2f1";

fn open() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

/// Pin this library's identity so a remote authority can legitimately match it.
///
/// Migration 0079 mints a random identity and the reconciliation refuses a remote authority
/// whose library id differs, so any test that drives a real `/status` response over a socket
/// has to state the identity it is matching.
fn pin_library_id(library: &Library) {
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE library_settings SET library_id = ?1 WHERE singleton = 1",
            [LIBRARY],
        )
        .unwrap();
}

fn insert_asset(library: &Library, id: &str) {
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, collected_at
             ) VALUES (?1, ?2, 'image', 'asset.png', ?3, ?4, 1, 1, 1,
                '2026-08-12T00:00:00Z')",
            rusqlite::params![
                id,
                format!("hash-{id}"),
                format!("assets/{id}.png"),
                format!("thumbnails/{id}.webp"),
            ],
        )
        .unwrap();
}

fn album(id: &str, name: &str, parent: Option<&str>, revision: i64) -> AlbumProjection {
    AlbumProjection {
        id: id.to_owned(),
        name: name.to_owned(),
        parent_id: parent.map(str::to_owned),
        icon_key: None,
        color_key: None,
        deleted: false,
        entity_revision: revision,
    }
}

fn membership(album_id: &str, asset_id: &str, desired: bool, revision: i64) -> AlbumMembershipProjection {
    AlbumMembershipProjection {
        album_id: album_id.to_owned(),
        asset_id: asset_id.to_owned(),
        desired_state: desired,
        entity_revision: revision,
    }
}

fn album_change(sequence: i64, album: AlbumProjection) -> AlbumChange {
    AlbumChange {
        sequence,
        authority_cursor: sequence,
        command_type: "renameAlbum".to_owned(),
        operation_id: format!("op-{sequence}"),
        changed_at: "2026-09-15T00:00:00Z".to_owned(),
        album: Some(album),
        membership: None,
    }
}

fn membership_change(sequence: i64, membership: AlbumMembershipProjection) -> AlbumChange {
    AlbumChange {
        sequence,
        authority_cursor: sequence,
        command_type: "setAlbumMembership".to_owned(),
        operation_id: format!("op-{sequence}"),
        changed_at: "2026-09-15T00:00:00Z".to_owned(),
        album: None,
        membership: Some(membership),
    }
}

fn albums(connection: &Connection) -> Vec<(String, String, Option<String>)> {
    let mut statement = connection
        .prepare("SELECT id, name, parent_id FROM albums ORDER BY id")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn memberships(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare("SELECT album_id, asset_id FROM asset_albums ORDER BY album_id, asset_id")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn outbox_len(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM album_authority_outbox", [], |row| {
            row.get(0)
        })
        .unwrap()
}

/// Every row of a revision cache as text, ordered, so a refusal can prove it is untouched.
///
/// The two caches have different key columns (`album_id`, and `album_id,asset_id`), so rows
/// are stringified generically instead of through one fixed tuple shape. Only equality across
/// a call is asserted, so the rendering never has to be meaningful on its own.
fn revision_rows(connection: &Connection, table: &str) -> Vec<String> {
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
        .unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            let mut parts = Vec::with_capacity(columns);
            for index in 0..columns {
                parts.push(match row.get_ref(index)? {
                    rusqlite::types::ValueRef::Null => "NULL".to_owned(),
                    rusqlite::types::ValueRef::Integer(value) => value.to_string(),
                    rusqlite::types::ValueRef::Real(value) => value.to_string(),
                    rusqlite::types::ValueRef::Text(value) => {
                        String::from_utf8_lossy(value).into_owned()
                    }
                    rusqlite::types::ValueRef::Blob(value) => format!("blob:{}", value.len()),
                });
            }
            Ok(parts.join("|"))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn authority(connection: &Connection) -> Option<(String, i64, i64, i64)> {
    connection
        .query_row(
            "SELECT library_id, epoch, contract_version, cursor FROM album_authority_sync WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()
}

/// Adopting a baseline materializes live Albums and memberships, caches every row's
/// revision — tombstones included — and records the cursor.
///
/// The tombstone cache is the point: a relation someone already removed must be
/// composable, or a fresh client could present only revision 0 and produce a false
/// conflict against a revision legitimately reached before it existed.
#[test]
fn a_baseline_materializes_live_state_and_caches_tombstones() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    insert_asset(&library, "asset-2");
    library
        .install_album_baseline_for_test(
            &[
                album("album-a", "여행", None, 3),
                album("album-b", "업무", Some("album-a"), 1),
            ],
            &[
                membership("album-a", "asset-1", true, 2),
                membership("album-a", "asset-2", false, 5),
            ],
            LIBRARY,
            1,
            1,
            9,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        albums(&connection),
        [
            ("album-a".to_owned(), "여행".to_owned(), None),
            (
                "album-b".to_owned(),
                "업무".to_owned(),
                Some("album-a".to_owned())
            ),
        ]
    );
    // Only the live relation is visible membership.
    assert_eq!(
        memberships(&connection),
        [("album-a".to_owned(), "asset-1".to_owned())]
    );
    let removed: (i64, i64) = connection
        .query_row(
            "SELECT desired_state, entity_revision FROM album_authority_membership_revisions
             WHERE album_id='album-a' AND asset_id='asset-2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(removed, (0, 5), "a removed relation keeps its revision");
    let album_revision: i64 = connection
        .query_row(
            "SELECT entity_revision FROM album_authority_revisions WHERE album_id='album-b'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(album_revision, 1);
    assert_eq!(
        authority(&connection),
        Some((LIBRARY.to_owned(), 1, 1, 9))
    );
    // Installing a baseline is a receive-side operation and must create no work.
    assert_eq!(outbox_len(&connection), 0);
}

/// A change page is applied with its cursor in one transaction, and creates no work.
///
/// This is the property that makes the two halves non-circular: a remote apply writes
/// the replica and the caches, never the queue.
#[test]
fn applied_changes_and_cursor_commit_together_without_enqueueing() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap();

    library
        .apply_album_page_for_test(
            &[
                membership_change(5, membership("album-a", "asset-1", true, 1)),
                album_change(6, album("album-a", "여행 사진", None, 2)),
            ],
            6,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        albums(&connection),
        [("album-a".to_owned(), "여행 사진".to_owned(), None)]
    );
    assert_eq!(
        memberships(&connection),
        [("album-a".to_owned(), "asset-1".to_owned())]
    );
    assert_eq!(authority(&connection).unwrap().3, 6);
    assert_eq!(outbox_len(&connection), 0, "a remote apply must not enqueue");
}

/// A membership tombstone removes the visible relation while keeping its revision.
#[test]
fn a_membership_tombstone_clears_visibility_but_keeps_the_revision() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[membership("album-a", "asset-1", true, 1)],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    library
        .apply_album_page_for_test(
            &[membership_change(3, membership("album-a", "asset-1", false, 2))],
            3,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(memberships(&connection).is_empty());
    let (desired, revision): (i64, i64) = connection
        .query_row(
            "SELECT desired_state, entity_revision FROM album_authority_membership_revisions
             WHERE album_id='album-a' AND asset_id='asset-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired, revision), (0, 2));
}

/// Deleting an Album removes it and its visible memberships, and the tombstone is
/// retained with the Album's own revision.
///
/// The membership cache is marked non-live without inventing a new membership
/// revision: the relation was not independently edited, and a bump would create
/// revision state no replay of the delete row could reproduce.
#[test]
fn an_album_tombstone_removes_state_without_bumping_membership_revisions() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[membership("album-a", "asset-1", true, 4)],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    let mut deleted = album("album-a", "여행", None, 2);
    deleted.deleted = true;
    library
        .apply_album_page_for_test(&[album_change(3, deleted)], 3)
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(albums(&connection).is_empty());
    assert!(memberships(&connection).is_empty());
    let (album_deleted, album_revision): (i64, i64) = connection
        .query_row(
            "SELECT deleted, entity_revision FROM album_authority_revisions WHERE album_id='album-a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((album_deleted, album_revision), (1, 2));
    let (desired, revision): (i64, i64) = connection
        .query_row(
            "SELECT desired_state, entity_revision FROM album_authority_membership_revisions
             WHERE album_id='album-a' AND asset_id='asset-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (desired, revision),
        (0, 4),
        "the relation's revision survives the Album's deletion"
    );
}

/// A non-ascending change page is rejected before anything is written.
///
/// Sequence order is what makes the outcome correct, so a gap or a repeat must not be
/// applied as though it were ordered.
#[test]
fn a_non_ascending_page_is_rejected_atomically() {
    let (_temp, library) = open();
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            4,
        )
        .unwrap();

    // A page starting at 6 while the local cursor is 4 leaves a gap.
    let error = library
        .apply_album_page_for_test(&[album_change(6, album("album-a", "새 이름", None, 2))], 6)
        .unwrap_err();
    assert!(matches!(error, LibraryError::InvalidCloudResponse));

    let connection = library.connection().unwrap();
    assert_eq!(
        albums(&connection),
        [("album-a".to_owned(), "여행".to_owned(), None)]
    );
    assert_eq!(authority(&connection).unwrap().3, 4);
}

/// A membership whose Asset is not materialized locally still converges.
///
/// The authority can describe a relation to an Asset this PC does not hold — the server
/// accepts assets from more than one ingest route, and a fresh PC rebuilds Albums before
/// it reconnects local media. Failing the page would stop the domain cursor forever on
/// a relation that is correct, so the confirmed revision must land and the visible row
/// must simply wait for its Asset.
#[test]
fn a_membership_for_an_unmaterialized_asset_records_its_revision() {
    let (_temp, library) = open();
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    library
        .apply_album_page_for_test(
            &[membership_change(3, membership("album-a", "not-local", true, 1))],
            3,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(
        memberships(&connection).is_empty(),
        "a relation cannot be visible without its Asset"
    );
    let (desired, revision): (i64, i64) = connection
        .query_row(
            "SELECT desired_state, entity_revision FROM album_authority_membership_revisions
             WHERE album_id='album-a' AND asset_id='not-local'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired, revision), (1, 1));
    assert_eq!(
        authority(&connection).unwrap().3,
        3,
        "the cursor must advance past a correct relation"
    );
}

/// A first adoption compares only relations this PC can materialize.
///
/// Activation ran from this PC's own staged snapshot, so every relation it staged named
/// an Asset that existed here. A baseline relation to an Asset absent locally is
/// therefore a genuine divergence and must still be refused.
#[test]
fn a_first_adoption_still_refuses_a_relation_to_an_unknown_asset() {
    let (_temp, library) = open();
    let error = library
        .require_first_adoption_match_for_test(
            &[album("album-a", "여행", None, 1)],
            &[membership("album-a", "not-local", true, 1)],
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::AlbumFirstAdoptionMismatch));
}

/// A relation to a trashed Asset stays visible, because the PC retains it on purpose.
///
/// Restoring a trashed Asset must return it to its Albums, which is why the local table
/// keeps those relations and why the adoption comparison must not filter by status.
#[test]
fn a_membership_of_a_trashed_asset_is_materialized() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status = 'trash' WHERE id = 'asset-1'", [])
        .unwrap();
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[membership("album-a", "asset-1", true, 1)],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        memberships(&connection),
        [("album-a".to_owned(), "asset-1".to_owned())]
    );
}

/// Re-adopting replaces the replica and the caches together.
#[test]
fn re_adopting_replaces_identity_and_state_together() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("old", "예전", None, 1)],
            &[membership("old", "asset-1", true, 1)],
            LIBRARY,
            1,
            1,
            5,
        )
        .unwrap();
    // The authority moved to a new epoch with different Albums.
    library
        .install_album_baseline_for_test(
            &[album("new", "새 것", None, 1)],
            &[],
            LIBRARY,
            2,
            1,
            0,
        )
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        albums(&connection),
        [("new".to_owned(), "새 것".to_owned(), None)]
    );
    assert!(memberships(&connection).is_empty());
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 2, 1, 0)));
    let stale: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM album_authority_revisions WHERE album_id='old'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0, "a replaced replica keeps no revision from before");
}

/// Restart preserves the adopted identity, cursor, replica and queue.
#[test]
fn restart_preserves_the_adopted_state() {
    let (temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[membership("album-a", "asset-1", true, 1)],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    let created = library
        .create_album(CreateAlbum {
            name: "오프라인".into(),
            parent_id: None,
        })
        .unwrap();
    drop(library);

    let reopened = Library::open(temp.path()).unwrap();
    let connection = reopened.connection().unwrap();
    assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 2)));
    assert_eq!(
        memberships(&connection),
        [("album-a".to_owned(), "asset-1".to_owned())]
    );
    assert_eq!(outbox_len(&connection), 1);
    assert!(albums(&connection)
        .iter()
        .any(|(id, _, _)| id == &created.id));
}

/// A local mutation accepted while the queue is non-empty still receives its own
/// revision expectation from the queue, not from confirmed state alone.
///
/// This is what makes offline structural editing work: the queued operations are the
/// user's intent, and each dependent command presents the revision the server will
/// report once the queue drains.
#[test]
fn offline_structural_edits_chain_their_expectations() {
    let (_temp, library) = open();
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 4)],
            &[],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    library.rename_album("album-a", "여행1").unwrap();
    library.rename_album("album-a", "여행2").unwrap();
    library.rename_album("album-a", "여행3").unwrap();

    let connection = library.connection().unwrap();
    let mut statement = connection
        .prepare(
            "SELECT payload FROM album_authority_outbox WHERE command_type='renameAlbum' ORDER BY seq",
        )
        .unwrap();
    let expected: Vec<i64> = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|payload| {
            serde_json::from_str::<serde_json::Value>(&payload.unwrap()).unwrap()
                ["expectedRevision"]
                .as_i64()
                .unwrap()
        })
        .collect();
    // The first rename presents the confirmed revision 4, and each following rename
    // presents the revision the queue ahead of it implies.
    assert_eq!(expected, [4, 5, 6]);
}

/// A rejected membership command keeps the relation's revision lineage in the queue.
///
/// The patch path is the only writer of membership intents, and it must not read the
/// Album entity revision: the two lineages answer different questions.
#[test]
fn membership_intents_do_not_borrow_the_album_revision() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 9)],
            &[membership("album-a", "asset-1", true, 3)],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    library
        .patch_asset_albums(AssetAlbumPatch {
            asset_ids: vec!["asset-1".to_owned()],
            add_album_ids: Vec::new(),
            remove_album_ids: vec!["album-a".to_owned()],
        })
        .unwrap();

    let connection = library.connection().unwrap();
    let expected: i64 = connection
        .query_row(
            "SELECT payload FROM album_authority_outbox WHERE command_type='setAlbumMembership'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|payload| {
            serde_json::from_str::<serde_json::Value>(&payload).unwrap()["expectedRevision"]
                .as_i64()
                .unwrap()
        })
        .unwrap();
    assert_eq!(expected, 3, "not the Album's revision 9");
}

// ---------------------------------------------------------------------------
// Multi-page catch-up and deferred rematerialization, against a real HTTP server
// ---------------------------------------------------------------------------

mod integration {
    use super::*;
    use crate::cloud::client::CloudClient;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use tiny_http::{Header, Response, Server};

    /// Changes per page the stub serves, matching the client's `CATCH_UP_LIMIT`.
    const PAGE: i64 = 100;

    /// Total ordered changes the stub holds: one full page plus a second partial page, so
    /// the catch-up cannot succeed without a second request.
    const TOTAL: i64 = 101;

    fn json_response(value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    /// Every change is a rename of one Album, so each row carries a self-contained Album
    /// projection and the replica converges to the last name.
    fn change_row(sequence: i64) -> serde_json::Value {
        serde_json::json!({
            "sequence": sequence,
            "authorityCursor": sequence,
            "commandType": "renameAlbum",
            "operationId": format!("00000000-0000-4000-8000-{sequence:012}"),
            "changedAt": "2026-09-15T00:00:00Z",
            "album": {
                "id": "album-a",
                "name": format!("이름 {sequence}"),
                "parentId": null,
                "iconKey": null,
                "colorKey": null,
                "deleted": false,
                "entityRevision": sequence
            }
        })
    }

    /// A real `/status` + `/changes` server holding `TOTAL` ordered changes.
    ///
    /// The change requests are recorded so the test can prove a second page was
    /// requested rather than the first page being mistaken for the whole log.
    fn paging_server() -> (
        String,
        Arc<Mutex<Vec<String>>>,
        thread::JoinHandle<()>,
    ) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            // `/status` advertises an active `albums` domain at the final cursor.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "albums",
                        "libraryId": LIBRARY,
                        "epoch": 1,
                        "contractVersion": 1,
                        "cursor": TOTAL
                    }]
                })))
                .unwrap();

            // Serve `/changes` pages until the caller stops asking.
            loop {
                let Some(request) =
                    server.recv_timeout(std::time::Duration::from_secs(5)).unwrap()
                else {
                    return;
                };
                let url = request.url().to_string();
                log.lock().unwrap().push(url.clone());
                assert!(url.contains("/albums/changes"), "{url}");
                let after = url
                    .split("after=")
                    .nth(1)
                    .and_then(|rest| rest.split('&').next())
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                let items: Vec<serde_json::Value> = (after + 1..=(after + PAGE).min(TOTAL))
                    .map(change_row)
                    .collect();
                let next_after = items
                    .last()
                    .and_then(|item| item["sequence"].as_i64())
                    .unwrap_or(after);
                request
                    .respond(json_response(serde_json::json!({
                        "libraryId": LIBRARY,
                        "epoch": 1,
                        "contractVersion": 1,
                        "cursor": TOTAL,
                        "items": items,
                        "nextAfter": next_after,
                        "hasMore": next_after < TOTAL
                    })))
                    .unwrap();
            }
        });
        (base, seen, handle)
    }

    /// A catch-up longer than one page converges instead of failing after page 1.
    ///
    /// Progress must be measured against the cursor a page was *requested* from. Comparing
    /// a freshly assigned cursor against itself can never fail, so the previous code
    /// reported a protocol error for every honest `hasMore`, capping catch-up at 100
    /// changes and leaving the local cursor behind permanently.
    #[test]
    fn a_catch_up_longer_than_one_page_converges() {
        let (_temp, library) = open();
        pin_library_id(&library);
        library
            .install_album_baseline_for_test(
                &[album("album-a", "시작", None, 1)],
                &[],
                LIBRARY,
                1,
                1,
                0,
            )
            .unwrap();

        let (base, seen, handle) = paging_server();
        let client = CloudClient::new(&base).unwrap();
        let report = library.reconcile_album_authority(&client, "test-token").unwrap();
        handle.join().unwrap();

        assert_eq!(report.applied_changes, TOTAL as u32);
        assert_eq!(report.local_cursor, Some(TOTAL));
        assert_eq!(report.server_cursor, Some(TOTAL));
        assert_eq!(report.behind_by, 0);
        assert!(!report.deferred_to_outbox);

        let connection = library.connection().unwrap();
        assert_eq!(authority(&connection).unwrap().3, TOTAL);
        assert_eq!(
            albums(&connection),
            [(
                "album-a".to_owned(),
                format!("이름 {TOTAL}"),
                None
            )],
            "the replica must converge to the last change"
        );
        // A second request really happened, proving the first page was not mistaken for
        // the whole log.
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2, "{requests:?}");
        assert!(requests[0].contains("after=0"), "{}", requests[0]);
        assert!(requests[1].contains("after=100"), "{}", requests[1]);
    }

    /// A page that claims more work without advancing is still rejected.
    #[test]
    fn a_non_progressing_continuation_is_rejected() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "albums",
                        "libraryId": LIBRARY,
                        "epoch": 1,
                        "contractVersion": 1,
                        "cursor": 5
                    }]
                })))
                .unwrap();
            // One change, but `hasMore` with a `nextAfter` that does not advance.
            let request = server.recv().unwrap();
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 5,
                    "items": [change_row(1)],
                    "nextAfter": 0,
                    "hasMore": true
                })))
                .unwrap();
        });

        let (_temp, library) = open();
        pin_library_id(&library);
        library
            .install_album_baseline_for_test(
                &[album("album-a", "시작", None, 1)],
                &[],
                LIBRARY,
                1,
                1,
                0,
            )
            .unwrap();
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .reconcile_album_authority(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));
    }

    /// A remote baseline for a *different* library is refused before anything is written.
    ///
    /// The epoch and library comparisons used to share one branch, so a wrong-library
    /// response took the re-adoption path: this library's Albums, memberships and cached
    /// revisions were deleted and replaced with a foreign library's. An epoch change for the
    /// *same* library is the designed restart path and must still replace state (covered by
    /// `re_adopting_replaces_identity_and_state_together`); a different `library_id` is an
    /// identity problem, and the only safe answer is to refuse it and keep local state.
    #[test]
    fn a_wrong_library_baseline_is_refused_without_touching_local_state() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // A real adopted replica of *this* library, with a relation, so the assertion covers
        // memberships and their cached revisions as well as the Album rows.
        library
            .install_album_baseline_for_test(
                &[album("mine", "내 앨범", None, 1)],
                &[membership("mine", "asset-1", true, 1)],
                LIBRARY,
                1,
                1,
                5,
            )
            .unwrap();
        let before = {
            let connection = library.connection().unwrap();
            (
                albums(&connection),
                memberships(&connection),
                authority(&connection),
                revision_rows(&connection, "album_authority_revisions"),
                revision_rows(&connection, "album_authority_membership_revisions"),
            )
        };

        // `/status` claims an active `albums` domain for a different library at a later
        // cursor with a different epoch, so every re-adoption trigger is present at once.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            let request = server.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": OTHER_LIBRARY,
                    "domains": [{
                        "domain": "albums",
                        "libraryId": OTHER_LIBRARY,
                        "epoch": 2,
                        "contractVersion": 1,
                        "cursor": 9
                    }]
                })))
                .unwrap();
        });
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .reconcile_album_authority(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();

        assert!(
            matches!(error, LibraryError::AlbumAuthorityMismatch),
            "a wrong-library response is an identity refusal, got {error:?}"
        );
        let connection = library.connection().unwrap();
        let after = (
            albums(&connection),
            memberships(&connection),
            authority(&connection),
            revision_rows(&connection, "album_authority_revisions"),
            revision_rows(&connection, "album_authority_membership_revisions"),
        );
        assert_eq!(
            before, after,
            "nothing may change: rows, caches and the authority identity all stay put"
        );
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 5)),
            "the identity is still this library's at its own epoch and cursor"
        );
        assert!(
            albums(&connection).iter().any(|(id, _, _)| id == "mine"),
            "the local Album is still present rather than replaced by the foreign library's"
        );
    }

    /// A local Album edit committed while `/changes` is in flight is never overwritten.
    ///
    /// The receive half reads the queue *before* it issues the request, so that read cannot
    /// authorize a write that lands after it. The server here holds its response until a local
    /// membership edit has been durably committed, which is exactly the window the
    /// pre-request check cannot see. The page must be abandoned: the optimistic local state
    /// survives, the intent stays queued, and the cursor does not advance.
    #[test]
    fn a_local_album_edit_during_the_request_is_never_overwritten() {
        use std::sync::mpsc;

        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // A real adopted replica of this library with one live membership.
        library
            .install_album_baseline_for_test(
                &[album("album-a", "여행", None, 1)],
                &[membership("album-a", "asset-1", true, 1)],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            // 1. `/status` advertises cursor 5.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "albums",
                        "libraryId": LIBRARY,
                        "epoch": 1,
                        "contractVersion": 1,
                        "cursor": 5
                    }]
                })))
                .unwrap();
            // 2. Hold `/changes` until the local edit is committed.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/changes"), "{}", request.url());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY,
                    "epoch": 1,
                    "contractVersion": 1,
                    "cursor": 5,
                    "items": [{
                        "sequence": 5,
                        "authorityCursor": 5,
                        "commandType": "setAlbumMembership",
                        "operationId": "00000000-0000-4000-8000-000000000005",
                        "changedAt": "2026-09-15T00:00:00Z",
                        "membership": {
                            "albumId": "album-a",
                            "assetId": "asset-1",
                            "desiredState": true,
                            "entityRevision": 9
                        }
                    }],
                    "nextAfter": 5,
                    "hasMore": false
                })))
                .unwrap();
            let _ = server.recv_timeout(Duration::from_millis(500));
        });

        let shared = std::sync::Arc::new(library);
        let worker = std::sync::Arc::clone(&shared);
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            // The user removes asset-1 from album-a while the response is in flight.
            worker
                .patch_asset_albums(AssetAlbumPatch {
                    asset_ids: vec!["asset-1".to_owned()],
                    add_album_ids: Vec::new(),
                    remove_album_ids: vec!["album-a".to_owned()],
                })
                .unwrap();
            let _ = release_tx.send(());
        });

        let client = CloudClient::new(&base).unwrap();
        let result = shared
            .reconcile_album_authority(&client, "token")
            .expect("a mid-flight local edit is a deferral, not an error");
        release.join().unwrap();
        handle.join().unwrap();

        assert!(
            result.deferred_to_outbox,
            "the pass must report the intent as taking precedence this cycle"
        );
        assert_eq!(result.applied_changes, 0, "no change row was applied");
        assert_eq!(result.local_cursor, Some(4), "the cursor did not advance");
        let connection = shared.connection().unwrap();
        assert_eq!(authority(&connection), Some((LIBRARY.to_owned(), 1, 1, 4)));
        assert!(
            memberships(&connection).is_empty(),
            "the user's removal is still the visible state"
        );
        assert!(outbox_len(&connection) > 0, "the intent is still queued");
    }

    /// A stored authority for a *different* library is never treated as an incremental predecessor.
    ///
    /// An earlier version of the wrong-library guard compared the stored identity against the
    /// remote one and re-adopted on a difference, which was unsafe. Splitting that comparison so
    /// only the epoch gates re-adoption left the opposite hole: a database already corrupted by
    /// the old bug holds a foreign library at *some* epoch, and if the server's correct library
    /// happens to report the same epoch, the dispatch sees no trigger at all and walks the
    /// foreign identity's change log as if it were this library's continuation.
    ///
    /// Both identities must therefore be validated independently: the remote one against this
    /// database's canonical library, and the *stored* one against the same canonical library.
    #[test]
    fn a_stored_foreign_library_authority_is_never_continued_incrementally() {
        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // Exactly the state the old bug could leave behind: a foreign library adopted at the
        // same epoch the correct library now reports.
        library
            .install_album_baseline_for_test(
                &[album("foreign", "남의 앨범", None, 1)],
                &[],
                OTHER_LIBRARY,
                1,
                1,
                5,
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            // `/status` reports *this* library at the same epoch as the corrupted row.
            let request = server.recv().unwrap();
            log.lock().unwrap().push(request.url().to_owned());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "albums",
                        "libraryId": LIBRARY,
                        "epoch": 1,
                        "contractVersion": 1,
                        "cursor": 6
                    }]
                })))
                .unwrap();
            // Anything further is a request the corrupted identity must never have produced.
            while let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(400)) {
                log.lock().unwrap().push(request.url().to_owned());
                let _ = request.respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                    "snapshotCursor": 6, "section": "albums",
                    "items": [], "nextAfter": null, "hasMore": false, "complete": false
                })));
            }
        });
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .reconcile_album_authority(&client, "token")
            .unwrap_err();
        handle.join().unwrap();

        assert!(
            matches!(error, LibraryError::AlbumAuthorityMismatch),
            "a stored foreign identity must be an explicit refusal, got {error:?}"
        );
        let paths = seen.lock().unwrap();
        assert!(
            !paths.iter().any(|path| path.contains("/changes")),
            "no incremental path may be attempted against the foreign identity: {paths:?}"
        );
        let connection = library.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((OTHER_LIBRARY.to_owned(), 1, 1, 5)),
            "the refusal must not silently rewrite the stored identity"
        );
    }

    /// A stale Album baseline install must not overwrite newer authority state.
    ///
    /// The shared receive precondition re-asserts the outbox *and* the authority identity
    /// inside the installing transaction. The outbox alone is not enough: two receives can read
    /// the same stored authority and both begin a walk from it, so B can complete and install a
    /// newer baseline (say the epoch was re-activated) before A returns with a clean queue and
    /// replaces B's newer state with the stale baseline it started from. The cursor would move
    /// backwards and the replica would describe an authority identity the server no longer has.
    #[test]
    fn a_stale_album_baseline_install_is_refused_when_a_newer_one_landed_first() {
        use std::sync::mpsc;

        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        // Every receive starts from this stored authority.
        library
            .install_album_baseline_for_test(
                &[album("album-a", "여행", None, 1)],
                &[],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();

        // Server A advertises epoch 2 and parks on the first baseline page.
        let server_a = Server::http("127.0.0.1:0").unwrap();
        let base_a = format!("http://{}/v1", server_a.server_addr());
        let (parked_tx, parked_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle_a = thread::spawn(move || {
            let request = server_a.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1, "active": true, "libraryId": LIBRARY,
                    "domains": [{"domain": "albums", "libraryId": LIBRARY,
                                 "epoch": 2, "contractVersion": 1, "cursor": 1}]
                })))
                .unwrap();
            // The first baseline page is held until B has installed its newer state, so A's
            // walk provably spans B's install rather than racing it on timing.
            let request = server_a.recv().unwrap();
            assert!(request.url().contains("/baseline"), "{}", request.url());
            let _ = parked_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 2, "contractVersion": 1,
                    "snapshotCursor": 1, "section": "albums",
                    "items": [{"id": "album-a", "name": "여행", "parentId": null,
                               "iconKey": null, "colorKey": null, "deleted": false,
                               "entityRevision": 1}],
                    "nextAfter": null, "hasMore": false, "complete": false
                })))
                .unwrap();
            // A's remaining pages, should it ignore the refusal and keep walking.
            while let Ok(Some(request)) = server_a.recv_timeout(Duration::from_millis(400)) {
                let _ = request.respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 2, "contractVersion": 1,
                    "snapshotCursor": 1, "section": "memberships",
                    "items": [], "nextAfter": null, "hasMore": false, "complete": true
                })));
            }
        });

        // Server B advertises epoch 3 at cursor 9 and installs that newer baseline.
        let server_b = Server::http("127.0.0.1:0").unwrap();
        let base_b = format!("http://{}/v1", server_b.server_addr());
        let handle_b = thread::spawn(move || {
            let request = server_b.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1, "active": true, "libraryId": LIBRARY,
                    "domains": [{"domain": "albums", "libraryId": LIBRARY,
                                 "epoch": 3, "contractVersion": 1, "cursor": 9}]
                })))
                .unwrap();
            for (section, items, complete) in [
                (
                    "albums",
                    serde_json::json!([{"id": "album-a", "name": "여행", "parentId": null,
                                        "iconKey": null, "colorKey": null, "deleted": false,
                                        "entityRevision": 1}]),
                    false,
                ),
                ("memberships", serde_json::json!([]), true),
            ] {
                let request = server_b.recv().unwrap();
                assert!(request.url().contains("/baseline"), "{}", request.url());
                request
                    .respond(json_response(serde_json::json!({
                        "libraryId": LIBRARY, "epoch": 3, "contractVersion": 1,
                        "snapshotCursor": 9, "section": section,
                        "items": items, "nextAfter": null, "hasMore": false, "complete": complete
                    })))
                    .unwrap();
            }
            let _ = server_b.recv_timeout(Duration::from_millis(300));
        });

        let shared = std::sync::Arc::new(library);
        let worker_a = std::sync::Arc::clone(&shared);
        let client_a = CloudClient::new(&base_a).unwrap();
        let received_a =
            thread::spawn(move || worker_a.reconcile_album_authority(&client_a, "token"));

        // Only once A is genuinely parked mid-walk does B install the newer baseline.
        parked_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let worker_b = std::sync::Arc::clone(&shared);
        let client_b = CloudClient::new(&base_b).unwrap();
        let received_b =
            thread::spawn(move || worker_b.reconcile_album_authority(&client_b, "token"));
        let result_b = received_b.join().unwrap().expect("B adopts the newer baseline");
        assert!(result_b.adopted && result_b.adopted_baseline);

        // A's response arrives afterwards, against the state B has already replaced.
        let _ = release_tx.send(());
        let result_a = received_a.join().unwrap();
        handle_a.join().unwrap();
        handle_b.join().unwrap();

        // The refusal is the same class of condition as a mid-walk local edit — the state the
        // request was based on is gone — so it becomes the usual "nothing applied this cycle"
        // deferral rather than an error the user sees. The next pass re-reads `/status`.
        assert!(
            result_a
                .as_ref()
                .is_ok_and(|result| result.deferred_to_outbox && !result.adopted_baseline),
            "a stale baseline install must be refused, got {result_a:?}"
        );
        let connection = shared.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 3, 1, 9)),
            "B's newer authority state must remain installed"
        );
        assert_eq!(
            albums(&connection),
            [("album-a".to_owned(), "여행".to_owned(), None)],
            "the newer baseline's product state must remain installed"
        );
    }

    /// A local Album edit committed during a baseline walk is never replaced by it.
    ///
    /// The re-adoption path replaces every Album, membership and cached revision, so it is the
    /// one receive that can destroy the most local state. A baseline walk is several requests,
    /// so a user edit committed mid-download must abort the whole install rather than be
    /// replaced by the pre-edit state the baseline describes.
    #[test]
    fn a_local_album_edit_during_a_baseline_walk_is_never_replaced() {
        use std::sync::mpsc;

        let (_temp, library) = open();
        pin_library_id(&library);
        insert_asset(&library, "asset-1");
        library
            .install_album_baseline_for_test(
                &[album("album-a", "여행", None, 1)],
                &[membership("album-a", "asset-1", true, 1)],
                LIBRARY,
                1,
                1,
                4,
            )
            .unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            // 1. `/status` advertises a new epoch, which is what makes the pass re-adopt.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/sync/status"), "{}", request.url());
            request
                .respond(json_response(serde_json::json!({
                    "protocolVersion": 1,
                    "active": true,
                    "libraryId": LIBRARY,
                    "domains": [{
                        "domain": "albums",
                        "libraryId": LIBRARY,
                        "epoch": 2,
                        "contractVersion": 1,
                        "cursor": 1
                    }]
                })))
                .unwrap();
            // 2. Hold the first baseline page until the local edit has committed.
            let request = server.recv().unwrap();
            assert!(request.url().contains("/baseline"), "{}", request.url());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 2, "contractVersion": 1,
                    "snapshotCursor": 1, "section": "albums",
                    "items": [{
                        "id": "album-b", "name": "새 앨범", "parentId": null,
                        "iconKey": null, "colorKey": null,
                        "deleted": false, "entityRevision": 1
                    }],
                    "nextAfter": null, "hasMore": false, "complete": false
                })))
                .unwrap();
            // 3. The membership section, whose `complete` is the adoption point.
            let request = server.recv().unwrap();
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": LIBRARY, "epoch": 2, "contractVersion": 1,
                    "snapshotCursor": 1, "section": "memberships",
                    "items": [], "nextAfter": null, "hasMore": false, "complete": true
                })))
                .unwrap();
            let _ = server.recv_timeout(Duration::from_millis(500));
        });

        let shared = std::sync::Arc::new(library);
        let worker = std::sync::Arc::clone(&shared);
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            // The user removes asset-1 from album-a while the baseline is downloading. This is
            // a real state change, so it durably queues an intent — unlike re-adding a
            // membership that is already there, which the store correctly treats as a no-op.
            worker
                .patch_asset_albums(AssetAlbumPatch {
                    asset_ids: vec!["asset-1".to_owned()],
                    add_album_ids: Vec::new(),
                    remove_album_ids: vec!["album-a".to_owned()],
                })
                .unwrap();
            let _ = release_tx.send(());
        });

        let client = CloudClient::new(&base).unwrap();
        let result = shared
            .reconcile_album_authority(&client, "token")
            .expect("a mid-baseline local edit is a deferral, not an error");
        release.join().unwrap();
        handle.join().unwrap();

        assert!(
            result.deferred_to_outbox,
            "the pass must report the intent as taking precedence this cycle"
        );
        let connection = shared.connection().unwrap();
        assert_eq!(
            authority(&connection),
            Some((LIBRARY.to_owned(), 1, 1, 4)),
            "the refused install must not change the authority identity or cursor"
        );
        assert!(
            albums(&connection).iter().any(|(id, _, _)| id == "album-a"),
            "the local Album survives rather than being replaced by the baseline's"
        );
        assert!(
            !albums(&connection).iter().any(|(id, _, _)| id == "album-b"),
            "the baseline's Albums must not have been installed"
        );
        assert!(outbox_len(&connection) > 0, "the durable intent is still queued");
    }

    /// A first adoption compares and installs in one transaction.
    ///
    /// `install_album_baseline_for_test` deliberately skips the comparison, so the production
    /// decision lives in `install_album_baseline`'s `compare_local` flag. This proves the two
    /// halves cannot be separated: the install refuses a baseline that does not match local
    /// state, which is only possible if the comparison ran inside the installing transaction.
    #[test]
    fn a_first_adoption_compares_and_installs_together() {
        let (_temp, library) = open();
        library
            .connection()
            .unwrap()
            .execute_batch(
                "INSERT INTO albums (id, name, parent_id, created_at)
                 VALUES ('mine', '내 앨범', NULL, '2026-09-16T00:00:00Z');",
            )
            .unwrap();
        // The baseline describes a *different* Album, so a first adoption must refuse it
        // rather than overwrite the local one.
        let error = library
            .adopt_album_baseline_for_test(
                &[album("theirs", "남의 앨범", None, 1)],
                &[],
                LIBRARY,
                1,
                1,
                1,
            )
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::AlbumFirstAdoptionMismatch),
            "a mismatched first adoption must be refused, got {error:?}"
        );
        let connection = library.connection().unwrap();
        assert_eq!(
            albums(&connection).iter().map(|(id, _, _)| id.clone()).collect::<Vec<_>>(),
            ["mine"],
            "the local Album is untouched by the refused adoption"
        );
        assert_eq!(authority(&connection), None, "nothing was adopted");
    }
}

// ---------------------------------------------------------------------------
// Deferred membership rematerialization
// ---------------------------------------------------------------------------

/// A withheld relation is completed by an ordinary clean reconcile once its Asset exists.
///
/// The epoch and cursor stay valid, so no baseline is ever required again: without this
/// local projection step the authoritative relation would stay missing from
/// `asset_albums` indefinitely.
#[test]
fn a_deferred_membership_is_materialized_by_a_clean_reconcile() {
    let (_temp, library) = open();
    // No local Asset yet, so the relation can only be recorded, not shown.
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_album_page_for_test(
            &[membership_change(2, membership("album-a", "late-asset", true, 1))],
            2,
        )
        .unwrap();

    {
        let connection = library.connection().unwrap();
        assert!(
            memberships(&connection).is_empty(),
            "a relation cannot be visible before its Asset exists"
        );
        let (desired, revision): (i64, i64) = connection
            .query_row(
                "SELECT desired_state, entity_revision FROM album_authority_membership_revisions
                 WHERE album_id='album-a' AND asset_id='late-asset'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((desired, revision), (1, 1), "the revision is already confirmed");
    }

    // The Asset appears through an unrelated local path, and the Album authority state
    // does not change at all.
    insert_asset(&library, "late-asset");

    let completed = library.materialize_deferred_album_memberships().unwrap();
    assert_eq!(completed, 1);

    let connection = library.connection().unwrap();
    assert_eq!(
        memberships(&connection),
        [("album-a".to_owned(), "late-asset".to_owned())]
    );
    // Local projection only: the cursor, the revision and the queue are untouched.
    assert_eq!(authority(&connection).unwrap().3, 2);
    assert_eq!(outbox_len(&connection), 0);
    let (desired, revision): (i64, i64) = connection
        .query_row(
            "SELECT desired_state, entity_revision FROM album_authority_membership_revisions
             WHERE album_id='album-a' AND asset_id='late-asset'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired, revision), (1, 1), "no synthetic revision is invented");

    // Idempotent: a second pass has nothing left to insert.
    drop(connection);
    assert_eq!(library.materialize_deferred_album_memberships().unwrap(), 0);
}

/// Rematerialization must not run while unresolved intent exists.
///
/// A queued membership intent is the user's current intent, so confirmed state must not be
/// projected over it — the same reason receive itself defers.
#[test]
fn rematerialization_is_skipped_while_the_queue_is_not_clean() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    // A confirmed live relation, and separately a queued local removal of it.
    library
        .apply_album_page_for_test(
            &[membership_change(2, membership("album-a", "asset-1", true, 1))],
            2,
        )
        .unwrap();
    library
        .patch_asset_albums(AssetAlbumPatch {
            asset_ids: vec!["asset-1".to_owned()],
            add_album_ids: Vec::new(),
            remove_album_ids: vec!["album-a".to_owned()],
        })
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(memberships(&connection).is_empty(), "the local removal is the intent");
    assert!(outbox_len(&connection) > 0);
    drop(connection);

    assert_eq!(library.materialize_deferred_album_memberships().unwrap(), 0);
    assert!(
        memberships(&library.connection().unwrap()).is_empty(),
        "confirmed state must not overwrite the user's pending removal"
    );
}

/// Tombstones and deleted Albums are never rematerialized.
#[test]
fn rematerialization_respects_tombstones_and_deleted_albums() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    insert_asset(&library, "asset-2");
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1), album("album-b", "업무", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            2,
        )
        .unwrap();
    // One removed relation, and one live relation on an Album that is then deleted.
    library
        .apply_album_page_for_test(
            &[
                membership_change(3, membership("album-a", "asset-1", false, 5)),
                membership_change(4, membership("album-b", "asset-2", true, 1)),
            ],
            4,
        )
        .unwrap();
    let mut deleted = album("album-b", "업무", None, 2);
    deleted.deleted = true;
    library
        .apply_album_page_for_test(&[album_change(5, deleted)], 5)
        .unwrap();

    assert_eq!(library.materialize_deferred_album_memberships().unwrap(), 0);
    assert!(memberships(&library.connection().unwrap()).is_empty());
}

/// A relation to a trashed Asset is materialized, matching the trash/restore contract.
#[test]
fn rematerialization_includes_a_trashed_asset() {
    let (_temp, library) = open();
    insert_asset(&library, "asset-1");
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status = 'trash' WHERE id = 'asset-1'", [])
        .unwrap();
    library
        .install_album_baseline_for_test(
            &[album("album-a", "여행", None, 1)],
            &[],
            LIBRARY,
            1,
            1,
            1,
        )
        .unwrap();
    library
        .apply_album_page_for_test(
            &[membership_change(2, membership("album-a", "asset-1", true, 1))],
            2,
        )
        .unwrap();

    assert_eq!(library.materialize_deferred_album_memberships().unwrap(), 0);
    let connection = library.connection().unwrap();
    assert_eq!(
        memberships(&connection),
        [("album-a".to_owned(), "asset-1".to_owned())],
        "the relation was projected on accept, and trash must not hide it"
    );
}

/// A membership waiting for its Asset's upload does not defer a baseline, and the
/// baseline's wholesale replace keeps the waiting relation visible: it is the user's
/// current intent for an Asset the authority cannot describe yet.
#[test]
fn a_baseline_keeps_a_membership_waiting_for_its_asset_upload() {
    let (_temp, library) = open();
    library
        .install_album_baseline_for_test(&[album("album-a", "여행", None, 1)], &[], LIBRARY, 1, 1, 1)
        .unwrap();
    insert_asset(&library, "fresh");
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO cloud_sync_queue
                (id, entity_type, entity_id, operation, status, revision, updated_at)
             VALUES ('queue-fresh', 'asset', 'fresh', 'upsert', 'pending', 1, '2026-09-25T00:00:00Z')",
            [],
        )
        .unwrap();
    library
        .patch_asset_albums(AssetAlbumPatch {
            asset_ids: vec!["fresh".into()],
            add_album_ids: vec!["album-a".into()],
            remove_album_ids: Vec::new(),
        })
        .unwrap();
    assert_eq!(outbox_len(&library.connection().unwrap()), 1);

    library
        .install_album_baseline_for_test(&[album("album-a", "여행", None, 1)], &[], LIBRARY, 1, 1, 4)
        .unwrap();

    let connection = library.connection().unwrap();
    assert_eq!(
        memberships(&connection),
        vec![("album-a".to_owned(), "fresh".to_owned())]
    );
    assert_eq!(outbox_len(&connection), 1, "the waiting intent is untouched");
}
