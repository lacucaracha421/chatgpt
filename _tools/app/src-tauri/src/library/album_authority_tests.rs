//! PC 2B regression coverage: the Album send half (durable state, outbox, flush).
//!
//! The queue, the mutation/enqueue boundary and the confirmation transaction run
//! against a real library database. The send pass runs against a real HTTP server, so
//! it executes the production code path end to end.
//!
//! `Library::connection()` takes a non-reentrant database mutex, so no assertion block
//! below calls a second accessor while it holds a connection guard.

use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use std::thread;

use tiny_http::{Header, Method, Response, Server};

use crate::cloud::client::CloudClient;
use crate::library::error::LibraryError;
use crate::library::models::{AssetAlbumPatch, CreateAlbum};
use crate::library::Library;

const LIBRARY: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn open() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    (temp, library)
}

/// Adopt an Album authority so local mutations start queueing.
fn adopt(library: &Library, epoch: i64, cursor: i64) {
    library
        .adopt_album_authority_for_test(LIBRARY, epoch, 1, cursor)
        .unwrap();
}

fn outbox(connection: &Connection) -> Vec<(String, String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, command_type, payload FROM album_authority_outbox ORDER BY seq",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

/// One committed Asset, which is what a membership may reference.
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

/// A library that never adopted Album authority must behave exactly as before.
///
/// This is the compatibility half of the whole batch: an unsynchronized library's
/// Album mutations must not acquire a queue, a revision expectation or a new failure
/// mode merely because the Album authority now exists.
#[test]
fn album_mutations_are_unchanged_while_no_authority_is_adopted() {
    let (_temp, library) = open();
    let created = library
        .create_album(CreateAlbum {
            name: "여행".into(),
            parent_id: None,
        })
        .unwrap();
    library.rename_album(&created.id, "여행 사진").unwrap();
    library.move_album(&created.id, None).unwrap();
    library
        .update_album_appearance(&created.id, Some("folder"), Some("blue"))
        .unwrap();

    let connection = library.connection().unwrap();
    assert!(outbox(&connection).is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM albums WHERE id = ?1",
                [&created.id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "여행 사진"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM album_authority_sync",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

/// Every accepted structural mutation appends one ordered intent, and a later
/// dependent command presents the revision the queue implies.
///
/// This is the reason the Album queue cannot coalesce: `create` must reach the server
/// before the `rename` that depends on it, and the rename must present revision 1,
/// which only exists because the create is ahead of it.
#[test]
fn structural_mutations_queue_in_order_with_dependent_revisions() {
    let (_temp, library) = open();
    adopt(&library, 3, 41);
    let created = library
        .create_album(CreateAlbum {
            name: "여행".into(),
            parent_id: None,
        })
        .unwrap();
    library.rename_album(&created.id, "여행 사진").unwrap();
    library.move_album(&created.id, None).unwrap();

    let connection = library.connection().unwrap();
    let entries = outbox(&connection);
    assert_eq!(
        entries.iter().map(|(_, kind, _)| kind.as_str()).collect::<Vec<_>>(),
        ["createAlbum", "renameAlbum", "moveAlbum"]
    );
    // Distinct logical intents, so each carries its own operation id.
    let mut ids: Vec<_> = entries.iter().map(|(id, _, _)| id.clone()).collect();
    let count = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), count, "each intent needs its own operation id");

    let create: serde_json::Value = serde_json::from_str(&entries[0].2).unwrap();
    assert_eq!(create["libraryId"], LIBRARY);
    assert_eq!(create["epoch"], 3);
    assert_eq!(create["contractVersion"], 1);
    assert_eq!(create["commandType"], "createAlbum");
    assert_eq!(create["name"], "여행");
    assert_eq!(create["parentId"], serde_json::Value::Null);
    assert_eq!(create["iconKey"], serde_json::Value::Null);
    assert_eq!(create["operationId"], entries[0].0);
    // A create introduces the Album, so it has no prior revision to compare against
    // and the server rejects an unexpected key.
    assert!(create.get("expectedRevision").is_none());

    let rename: serde_json::Value = serde_json::from_str(&entries[1].2).unwrap();
    assert_eq!(rename["name"], "여행 사진");
    assert_eq!(rename["expectedRevision"], 1);
    let moved: serde_json::Value = serde_json::from_str(&entries[2].2).unwrap();
    assert_eq!(moved["expectedRevision"], 2);
}

/// A relation change is its own command, and its revision lineage is separate from
/// the Album's.
///
/// An Album rename increments the Album revision. A membership compare-and-set must
/// not observe that increment, or a membership edit would be rejected for a reason
/// that has nothing to do with the relation.
#[test]
fn membership_intents_use_their_own_revision_lineage() {
    let (_temp, library) = open();
    adopt(&library, 1, 7);
    let album = library
        .create_album(CreateAlbum {
            name: "여행".into(),
            parent_id: None,
        })
        .unwrap();
    library.rename_album(&album.id, "여행2").unwrap();
    insert_asset(&library, "asset-1");
    let asset_id = "asset-1".to_owned();
    library
        .patch_asset_albums(AssetAlbumPatch {
            asset_ids: vec![asset_id.clone()],
            add_album_ids: vec![album.id.clone()],
            remove_album_ids: Vec::new(),
        })
        .unwrap();
    library
        .patch_asset_albums(AssetAlbumPatch {
            asset_ids: vec![asset_id.clone()],
            add_album_ids: Vec::new(),
            remove_album_ids: vec![album.id.clone()],
        })
        .unwrap();

    let connection = library.connection().unwrap();
    let entries = outbox(&connection);
    let memberships: Vec<serde_json::Value> = entries
        .iter()
        .filter(|(_, kind, _)| kind == "setAlbumMembership")
        .map(|(_, _, payload)| serde_json::from_str(payload).unwrap())
        .collect();
    assert_eq!(memberships.len(), 2);
    assert_eq!(memberships[0]["desiredState"], true);
    assert_eq!(memberships[0]["expectedRevision"], 0);
    assert_eq!(memberships[0]["assetId"], asset_id);
    // The second relation change continues the membership lineage, untouched by the
    // two Album structural commands queued ahead of it.
    assert_eq!(memberships[1]["desiredState"], false);
    assert_eq!(memberships[1]["expectedRevision"], 1);
}

/// A relation change that changes nothing must not queue an intent.
///
/// Adding an Asset to an Album it already belongs to is not a state change, and
/// queueing it would send a command whose only possible result is a no-op.
#[test]
fn a_membership_patch_that_changes_no_relation_queues_nothing() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    let album = library
        .create_album(CreateAlbum {
            name: "여행".into(),
            parent_id: None,
        })
        .unwrap();
    insert_asset(&library, "asset-1");
    let asset_id = "asset-1".to_owned();
    let add = |remove: bool| AssetAlbumPatch {
        asset_ids: vec![asset_id.clone()],
        add_album_ids: if remove { Vec::new() } else { vec![album.id.clone()] },
        remove_album_ids: if remove { vec![album.id.clone()] } else { Vec::new() },
    };
    library.patch_asset_albums(add(false)).unwrap();
    library.patch_asset_albums(add(false)).unwrap();
    library.patch_asset_albums(add(true)).unwrap();
    library.patch_asset_albums(add(true)).unwrap();

    let connection = library.connection().unwrap();
    let memberships = outbox(&connection)
        .iter()
        .filter(|(_, kind, _)| kind == "setAlbumMembership")
        .count();
    assert_eq!(memberships, 2, "one add and one remove, not four attempts");
}

/// The local effect and its queued intent commit together, or neither does.
///
/// A crash cannot be simulated here, but a rejected local mutation can: a rename to a
/// sibling's name fails, and the failure must leave no intent behind.
#[test]
fn a_rejected_local_mutation_leaves_no_intent() {
    let (_temp, library) = open();
    adopt(&library, 1, 0);
    library
        .create_album(CreateAlbum {
            name: "여행".into(),
            parent_id: None,
        })
        .unwrap();
    let second = library
        .create_album(CreateAlbum {
            name: "업무".into(),
            parent_id: None,
        })
        .unwrap();
    let error = library.rename_album(&second.id, "여행").unwrap_err();
    assert!(matches!(error, LibraryError::DuplicateAlbumName));

    let connection = library.connection().unwrap();
    assert_eq!(
        outbox(&connection)
            .iter()
            .filter(|(_, kind, _)| kind == "renameAlbum")
            .count(),
        0
    );
}

/// The durable status reports what the authority has confirmed and what is queued.
#[test]
fn sync_status_separates_pending_from_confirmed() {
    let (_temp, library) = open();
    let status = library.album_sync_status().unwrap();
    assert!(!status.adopted);
    assert_eq!(status.pending_count, 0);

    adopt(&library, 2, 12);
    let album = library
        .create_album(CreateAlbum {
            name: "여행".into(),
            parent_id: None,
        })
        .unwrap();
    library.rename_album(&album.id, "여행2").unwrap();

    let status = library.album_sync_status().unwrap();
    assert!(status.adopted);
    assert_eq!(status.library_id.as_deref(), Some(LIBRARY));
    assert_eq!(status.epoch, Some(2));
    assert_eq!(status.cursor, Some(12));
    assert_eq!(status.pending_count, 2);
    assert_eq!(status.blocked_count, 0);
    assert_eq!(
        status.oldest_pending_operation_id.as_deref(),
        Some(outbox(&library.connection().unwrap())[0].0.as_str())
    );
}

/// A flush with an empty queue is a no-op, and must not require an authority.
///
/// The queue is the only thing that can make a send meaningful, so a library with no
/// adopted Album authority and nothing queued reports that plainly instead of asking
/// the server about a domain it does not track.
#[test]
fn an_empty_queue_needs_no_authority_to_flush() {
    let (_temp, library) = open();
    let server = Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", server.server_addr());
    let handle = thread::spawn(move || {
        // No request may arrive: with nothing queued there is nothing to send.
        let _ = server.recv_timeout(std::time::Duration::from_millis(300));
    });
    let client = CloudClient::new(&base).unwrap();
    let report = library
        .flush_album_outbox_with(&client, "test-token")
        .unwrap();
    handle.join().unwrap();
    assert_eq!(report.pending, 0);
    assert_eq!(report.sent, 0);
    assert!(!report.stopped);
}

// ---------------------------------------------------------------------------
// The send pass against a real HTTP server
// ---------------------------------------------------------------------------

mod integration {
    use super::*;

    fn json_response(value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
        Response::from_data(serde_json::to_vec(&value).unwrap())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
    }

    fn read_body(request: &mut tiny_http::Request) -> serde_json::Value {
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        serde_json::from_str(&body).unwrap()
    }

    /// A server that accepts every command with the result the command implies.
    ///
    /// Each accepted command is recorded with its request body, so the assertions can
    /// check the exact bytes that were sent rather than only the resulting local state.
    fn accepting_server(
        library_id: String,
    ) -> (String, Arc<Mutex<Vec<serde_json::Value>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            for sequence in 1..=3 {
                let mut request = server.recv().unwrap();
                assert_eq!(request.method(), &Method::Put);
                let body = read_body(&mut request);
                let command = body["commandType"].as_str().unwrap().to_owned();
                let album_id = body["albumId"].as_str().unwrap().to_owned();
                let album = if command == "setAlbumMembership" {
                    None
                } else {
                    let deleted = command == "deleteAlbum";
                    Some(serde_json::json!({
                        "id": album_id,
                        "name": body.get("name").and_then(|value| value.as_str())
                            .unwrap_or("여행 사진"),
                        "parentId": body.get("parentId").cloned().unwrap_or(serde_json::Value::Null),
                        "iconKey": body.get("iconKey").cloned().unwrap_or(serde_json::Value::Null),
                        "colorKey": body.get("colorKey").cloned().unwrap_or(serde_json::Value::Null),
                        "deleted": deleted,
                        "entityRevision": sequence
                    }))
                };
                let membership = if command == "setAlbumMembership" {
                    Some(serde_json::json!({
                        "albumId": album_id,
                        "assetId": body["assetId"],
                        "desiredState": body["desiredState"],
                        "entityRevision": sequence
                    }))
                } else {
                    None
                };
                log.lock().unwrap().push(body.clone());
                request
                    .respond(json_response(serde_json::json!({
                        "libraryId": library_id,
                        "epoch": 1,
                        "contractVersion": 1,
                        "commandType": command,
                        "operationId": body["operationId"],
                        "changed": true,
                        "changeSequence": sequence,
                        "authorityCursor": sequence,
                        "album": album,
                        "membership": membership,
                        "updatedAt": "2026-09-15T00:00:00Z"
                    })))
                    .unwrap();
            }
        });
        (base, seen, handle)
    }

    /// A server that answers 200 with a result describing a *different* operation.
    ///
    /// The queue row is keyed by the stored operation id, so an echo naming another one
    /// would retire the wrong intent and record a revision belonging to something else.
    fn mismatched_acceptance_server(
        library_id: String,
        wrong_album_id: String,
    ) -> (String, Arc<Mutex<Vec<serde_json::Value>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let body = read_body(&mut request);
            log.lock().unwrap().push(body.clone());
            request
                .respond(json_response(serde_json::json!({
                    "libraryId": library_id,
                    "epoch": 1,
                    "contractVersion": 1,
                    "commandType": "renameAlbum",
                    "operationId": "00000000-0000-4000-8000-0000000000ff",
                    "changed": true,
                    "changeSequence": 9,
                    "authorityCursor": 9,
                    "album": {
                        "id": wrong_album_id,
                        "name": "다른 앨범",
                        "parentId": null,
                        "iconKey": null,
                        "colorKey": null,
                        "deleted": false,
                        "entityRevision": 9
                    },
                    "membership": null,
                    "updatedAt": "2026-09-15T00:00:00Z"
                })))
                .unwrap();
        });
        (base, seen, handle)
    }

    /// A server that answers one command with a specific coded rejection.
    fn coded_rejection_server(
        code: &'static str,
        status: u16,
    ) -> (String, Arc<Mutex<Vec<serde_json::Value>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let body = read_body(&mut request);
            log.lock().unwrap().push(body.clone());
            request
                .respond(
                    json_response(serde_json::json!({
                        "detail": { "code": code, "authorityCursor": 4 }
                    }))
                    .with_status_code(status),
                )
                .unwrap();
        });
        (base, seen, handle)
    }

    /// A server that rejects the first command with a coded structural conflict.
    fn conflicting_server() -> (String, Arc<Mutex<Vec<serde_json::Value>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let body = read_body(&mut request);
            log.lock().unwrap().push(body.clone());
            request
                .respond(json_response(serde_json::json!({
                    "detail": {
                        "code": "revisionConflict",
                        "authorityCursor": 6,
                        "current": {
                            "albumId": body["albumId"],
                            "name": "서버 이름",
                            "parentId": null,
                            "iconKey": null,
                            "colorKey": null,
                            "entityRevision": 5
                        }
                    }
                })).with_status_code(409))
                .unwrap();
        });
        (base, seen, handle)
    }

    /// The full send path: one queued intent per local mutation, sent oldest-first,
    /// with each retry presenting the same operation id and the same stored bytes.
    #[test]
    fn a_flush_sends_every_intent_in_order_and_retires_it() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let album = library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();
        insert_asset(&library, "asset-1");
    let asset_id = "asset-1".to_owned();
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec![asset_id.clone()],
                add_album_ids: vec![album.id.clone()],
                remove_album_ids: Vec::new(),
            })
            .unwrap();
        library.rename_album(&album.id, "여행 사진").unwrap();

        let queued = outbox(&library.connection().unwrap());
        assert_eq!(
            queued
                .iter()
                .map(|(_, kind, _)| kind.as_str())
                .collect::<Vec<_>>(),
            ["createAlbum", "setAlbumMembership", "renameAlbum"]
        );
        let (base, seen, handle) = accepting_server(LIBRARY.to_owned());
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 3);
        assert_eq!(report.pending, 0);
        assert!(!report.stopped);
        // The queue is drained and no intent survives an accepted result.
        assert!(outbox(&library.connection().unwrap()).is_empty());

        let sent = seen.lock().unwrap();
        assert_eq!(
            sent.iter()
                .map(|body| body["commandType"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["createAlbum", "setAlbumMembership", "renameAlbum"]
        );
        // The bytes sent are the bytes stored, operation id included, which is what
        // makes a lost response resolvable instead of a second logical write.
        for (body, (operation_id, _, payload)) in sent.iter().zip(queued.iter()) {
            assert_eq!(body["operationId"].as_str().unwrap(), operation_id);
            let stored: serde_json::Value = serde_json::from_str(payload).unwrap();
            assert_eq!(body, &stored);
        }

        // Only the confirmed revision cache is updated by the send half; the visible
        // Album materialization is the receive half's job.
        let connection = library.connection().unwrap();
        let (revision, deleted) = connection
            .query_row(
                "SELECT entity_revision, deleted FROM album_authority_revisions WHERE album_id = ?1",
                [&album.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .unwrap();
        // The rename is the last command the server accepted, so its result is the
        // Album's confirmed revision.
        assert_eq!((revision, deleted), (3, false));
    }

    /// A structural conflict preserves the intent instead of discarding or rebasing it.
    ///
    /// Selecting a winner for a rename is a user decision. What must hold now is that
    /// the conflict is durable and observable, that the optimistic local effect stays
    /// visible, and that delivery stops rather than sending a dependent command over it.
    #[test]
    fn a_structural_conflict_blocks_the_queue_and_keeps_the_local_edit() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let album = library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();
        library.rename_album(&album.id, "여행 사진").unwrap();

        let queued = outbox(&library.connection().unwrap());
        // Clear the create so the rename is the intent that meets the conflict.
        library
            .connection()
            .unwrap()
            .execute(
                "DELETE FROM album_authority_outbox WHERE command_type = 'createAlbum'",
                [],
            )
            .unwrap();

        let (base, seen, handle) = conflicting_server();
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.blocked, 1);
        assert!(report.stopped);
        assert_eq!(seen.lock().unwrap().len(), 1, "a blocked queue sends nothing more");

        let connection = library.connection().unwrap();
        // The intent survives with its original identity and payload.
        let (state, code, payload, operation_id) = connection
            .query_row(
                "SELECT state, conflict_code, payload, operation_id FROM album_authority_outbox",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(state, "blocked");
        assert_eq!(code, "revisionConflict");
        assert_eq!(operation_id, queued[1].0);
        assert_eq!(payload, queued[1].2);
        // The user's rename is still what they see.
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM albums WHERE id = ?1",
                    [&album.id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "여행 사진"
        );
    }

    /// Repeating a flush after a lost response sends the same bytes again.
    ///
    /// This is the property that makes a retry safe: the operation id and payload are
    /// read from the queue row, not re-derived, so the server's receipt resolves the
    /// retry rather than recording a second logical write.
    #[test]
    fn a_retried_flush_resends_identical_bytes() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();
        let queued = outbox(&library.connection().unwrap());

        // A server that never answers, so the intent stays pending.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            for _ in 0..2 {
                let mut request = server.recv().unwrap();
                let body = read_body(&mut request);
                log.lock().unwrap().push(body);
                // A transport failure the client must treat as unresolved.
                request.respond(Response::empty(500)).unwrap();
            }
        });

        let client = CloudClient::new(&base).unwrap();
        assert!(library
            .flush_album_outbox_with(&client, "test-token")
            .is_err());
        assert!(library
            .flush_album_outbox_with(&client, "test-token")
            .is_err());
        handle.join().unwrap();

        let sent = seen.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], sent[1], "a retry must resend the stored bytes");
        assert_eq!(sent[0]["operationId"].as_str().unwrap(), queued[0].0);
        // The intent is still pending, not lost.
        let connection = library.connection().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM album_authority_outbox",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
    }

    /// An intent composed under another epoch is blocked, never silently re-pointed.
    ///
    /// Revisions are only comparable inside one epoch. Guessing a cross-epoch mapping
    /// is precisely the implicit rebase this domain forbids for structural edits.
    #[test]
    fn an_epoch_mismatch_blocks_rather_than_rebasing() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();
        // The authority moved to a new epoch.
        library.adopt_album_authority_for_test(LIBRARY, 2, 1, 0).unwrap();

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let handle = thread::spawn(move || {
            // No request may arrive: the mismatch is decided from local state.
            let _ = server.recv_timeout(std::time::Duration::from_millis(300));
        });
        let client = CloudClient::new(&base).unwrap();
        let report = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap();
        handle.join().unwrap();

        assert_eq!(report.blocked, 1);
        assert!(report.stopped);
        let connection = library.connection().unwrap();
        let (state, code, epoch) = connection
            .query_row(
                "SELECT state, conflict_code, epoch FROM album_authority_outbox",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(state, "blocked");
        assert_eq!(code, "epochMismatch");
        assert_eq!(epoch, 1, "the stored intent keeps the epoch it was composed in");
    }

    /// A 200 describing another operation is a protocol failure, not an acceptance.
    ///
    /// The row must stay durable: retiring it would delete an intent the authority never
    /// confirmed, and writing the echo's revision would poison the confirmed cache with
    /// state belonging to a different entity.
    #[test]
    fn an_acceptance_for_another_operation_is_refused_and_the_intent_survives() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let album = library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "DELETE FROM album_authority_outbox WHERE command_type = 'createAlbum'",
                [],
            )
            .unwrap();
        library.rename_album(&album.id, "여행 사진").unwrap();
        let queued = outbox(&library.connection().unwrap());
        assert_eq!(queued.len(), 1);

        let (base, _seen, handle) = mismatched_acceptance_server(
            LIBRARY.to_owned(),
            "00000000-0000-4000-8000-00000000dead".to_owned(),
        );
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::InvalidCloudResponse));

        let connection = library.connection().unwrap();
        let (state, operation_id) = connection
            .query_row(
                "SELECT state, operation_id FROM album_authority_outbox",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending", "the intent must stay deliverable");
        assert_eq!(operation_id, queued[0].0);
        // No revision from the mismatched echo may reach the confirmed cache.
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM album_authority_revisions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    /// An authority mismatch is a typed error, never a stored user conflict.
    ///
    /// Blocking the row here would tell the user to resolve a conflict that does not
    /// exist, and would hide a real identity problem behind a queue that never drains.
    #[test]
    fn an_authority_mismatch_is_not_stored_as_a_structural_conflict() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();

        let (base, _seen, handle) = coded_rejection_server("authorityLibraryMismatch", 409);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::AlbumAuthorityMismatch));

        let connection = library.connection().unwrap();
        let (state, code): (String, Option<String>) = connection
            .query_row(
                "SELECT state, conflict_code FROM album_authority_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending", "an identity problem is not a user conflict");
        assert_eq!(code, None);
    }

    /// `operationConflict` is a data-integrity failure, not a user-visible conflict.
    ///
    /// One operation id was reused with different content, which no user action caused
    /// and no rebase can resolve.
    #[test]
    fn an_operation_conflict_is_an_integrity_error_not_a_user_conflict() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();

        let (base, _seen, handle) = coded_rejection_server("operationConflict", 409);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::AlbumOperationConflict));

        let connection = library.connection().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT conflict_code FROM album_authority_outbox",
                    [],
                    |row| row.get::<_, Option<String>>(0)
                )
                .unwrap(),
            None
        );
    }

    /// A semantic structural rejection durably blocks the intent.
    ///
    /// `invalidAlbumParent` and a concurrent `albumNotFound` are things the user can
    /// resolve; retrying them forever would spin, and reporting them as a contract
    /// upgrade would be wrong.
    #[test]
    fn semantic_structural_rejections_block_the_intent_durably() {
        for (code, status) in [
            ("invalidAlbumParent", 422u16),
            ("albumNotFound", 404),
            ("duplicateAlbumName", 409),
            ("albumCycle", 422),
            ("albumHasChildren", 409),
            ("albumExists", 409),
            ("invalidAlbumMembership", 422),
        ] {
            let (_temp, library) = open();
            adopt(&library, 1, 0);
            library
                .create_album(CreateAlbum {
                    name: "여행".into(),
                    parent_id: None,
                })
                .unwrap();

            let (base, _seen, handle) = coded_rejection_server(code, status);
            let client = CloudClient::new(&base).unwrap();
            let report = library
                .flush_album_outbox_with(&client, "test-token")
                .unwrap();
            handle.join().unwrap();

            assert_eq!(report.blocked, 1, "{code} must block, not retry");
            assert!(report.stopped, "{code} must stop the FIFO pass");
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT conflict_code FROM album_authority_outbox",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                code
            );
        }
    }

    /// An uncoded rejection stays retryable rather than becoming a contract upgrade.
    ///
    /// The server uses 422 for semantic refusals as well as an unknown contract, so a 422
    /// that names no known code must not be read as "upgrade the client": that would
    /// strand a deliverable intent behind a version skew that does not exist.
    #[test]
    fn an_unrecognized_rejection_stays_retryable() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();

        let (base, _seen, handle) = coded_rejection_server("somethingNew", 422);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::AlbumCommandOutcomeUnknown));

        let connection = library.connection().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM album_authority_outbox",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
    }

    /// A malformed command is reported as its own state, not as a contract upgrade.
    ///
    /// This build speaks the negotiated contract, so telling the user to upgrade would be
    /// wrong; the intent also stays deliverable rather than being blocked as their fault.
    #[test]
    fn a_malformed_command_is_distinct_from_a_contract_upgrade() {
        for code in [
            "invalidAlbumCommand",
            "invalidAlbumRevision",
            "emptyAlbumName",
            "invalidAlbumAppearance",
            "albumNameTooLong",
        ] {
            let (_temp, library) = open();
            adopt(&library, 1, 0);
            library
                .create_album(CreateAlbum {
                    name: "여행".into(),
                    parent_id: None,
                })
                .unwrap();

            let (base, _seen, handle) = coded_rejection_server(code, 422);
            let client = CloudClient::new(&base).unwrap();
            let error = library
                .flush_album_outbox_with(&client, "test-token")
                .unwrap_err();
            handle.join().unwrap();
            match error {
                LibraryError::AlbumCommandRejected { code: rejected } => assert_eq!(rejected, code),
                other => panic!("{code} mapped to {other:?}"),
            }
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT state FROM album_authority_outbox",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "pending",
                "{code} must leave the intent deliverable"
            );
        }
    }

    /// An activation-only code reaching the command route is not the user's conflict.
    #[test]
    fn an_activation_only_code_does_not_block_the_intent() {
        let (_temp, library) = open();
        adopt(&library, 1, 0);
        library
            .create_album(CreateAlbum {
                name: "여행".into(),
                parent_id: None,
            })
            .unwrap();

        let (base, _seen, handle) = coded_rejection_server("albumSnapshotNotAuthorityReady", 422);
        let client = CloudClient::new(&base).unwrap();
        let error = library
            .flush_album_outbox_with(&client, "test-token")
            .unwrap_err();
        handle.join().unwrap();
        assert!(matches!(error, LibraryError::AlbumCommandOutcomeUnknown));

        let connection = library.connection().unwrap();
        let (state, code): (String, Option<String>) = connection
            .query_row(
                "SELECT state, conflict_code FROM album_authority_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending");
        assert_eq!(code, None);
    }

    /// Concurrent Album delivery callers share one pass for the domain.
    ///
    /// The Album lane has the same multi-caller shape as Classification — a mutation kick, the
    /// periodic sync hook and focus/online events — so its single-flight gate has to sit on the
    /// domain rather than on one caller. This holds the first pass inside its HTTP response,
    /// starts a second caller while it is held, and proves only one delivery occurred for the
    /// one queued row.
    #[test]
    fn concurrent_album_delivery_callers_never_double_send_one_row() {
        use std::sync::Barrier;
        use std::sync::atomic::{AtomicU32, Ordering};

        let (_temp, library) = open();
        adopt(&library, 1, 0);
        let album = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        insert_asset(&library, "asset-1");
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM album_authority_outbox", [])
            .unwrap();
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["asset-1".into()],
                add_album_ids: vec![album.id.clone()],
                remove_album_ids: Vec::new(),
            })
            .unwrap();
        assert_eq!(outbox(&library.connection().unwrap()).len(), 1);

        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let deliveries = Arc::new(AtomicU32::new(0));
        let count = Arc::clone(&deliveries);
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let handle = thread::spawn(move || loop {
            let Ok(Some(mut request)) = server.recv_timeout(std::time::Duration::from_millis(600))
            else {
                return;
            };
            count.fetch_add(1, Ordering::SeqCst);
            let body = read_body(&mut request);
            if count.load(Ordering::SeqCst) == 1 {
                let _ = release_rx.recv_timeout(std::time::Duration::from_secs(10));
            }
            let _ = request.respond(json_response(serde_json::json!({
                "libraryId": LIBRARY,
                "epoch": 1,
                "contractVersion": 1,
                "commandType": body["commandType"],
                "operationId": body["operationId"],
                "changed": true,
                "changeSequence": 1,
                "authorityCursor": 1,
                "album": null,
                "membership": {
                    "albumId": body["albumId"],
                    "assetId": body["assetId"],
                    "desiredState": body["desiredState"],
                    "entityRevision": 5
                },
                "updatedAt": "2026-09-17T00:00:00Z"
            })));
        });

        let shared = Arc::new(library);
        let client = Arc::new(CloudClient::new(&base).unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let spawn_caller = || {
            let shared = Arc::clone(&shared);
            let client = Arc::clone(&client);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                shared.flush_album_outbox_with(&client, "token").map(|r| r.sent)
            })
        };
        let first = spawn_caller();
        let second = spawn_caller();
        thread::sleep(std::time::Duration::from_millis(400));
        let _ = release_tx.send(());
        let a = first.join().unwrap();
        let b = second.join().unwrap();
        handle.join().unwrap();

        assert_eq!(
            deliveries.load(Ordering::SeqCst),
            1,
            "two Album callers must not each send the same queued row"
        );
        assert_eq!(a.unwrap_or(0) + b.unwrap_or(0), 1, "exactly one caller sends");
        assert!(outbox(&shared.connection().unwrap()).is_empty());
    }
}

/// H1 coverage: a membership for an Asset whose upload has not committed waits for it.
///
/// The server refuses to add a relation to an Asset it has not committed, so sending the
/// intent early would be rejected, and blocking on that rejection would stop every later
/// Album intent and the receive half.
mod waiting_for_asset_upload {
    use super::*;
    use crate::cloud::client::{SyncAuthorityDomain, SyncStatus};

    fn read_body(request: &mut tiny_http::Request) -> serde_json::Value {
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        serde_json::from_str(&body).unwrap()
    }

    /// Accepts every membership command it receives until the flush goes quiet.
    fn accepting_server() -> (String, Arc<Mutex<Vec<serde_json::Value>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            for sequence in 1..=8i64 {
                let Ok(Some(mut request)) =
                    server.recv_timeout(std::time::Duration::from_millis(400))
                else {
                    return;
                };
                assert_eq!(request.method(), &Method::Put);
                let body = read_body(&mut request);
                assert_eq!(body["commandType"], "setAlbumMembership");
                log.lock().unwrap().push(body.clone());
                let result = serde_json::json!({
                    "libraryId": body["libraryId"],
                    "epoch": body["epoch"],
                    "contractVersion": 1,
                    "commandType": "setAlbumMembership",
                    "operationId": body["operationId"],
                    "changed": true,
                    "changeSequence": sequence,
                    "authorityCursor": sequence,
                    "album": null,
                    "membership": {
                        "albumId": body["albumId"],
                        "assetId": body["assetId"],
                        "desiredState": body["desiredState"],
                        "entityRevision": 1
                    },
                    "updatedAt": "2026-09-25T00:00:00Z"
                });
                request
                    .respond(
                        Response::from_data(serde_json::to_vec(&result).unwrap()).with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        ),
                    )
                    .unwrap();
            }
        });
        (base, seen, handle)
    }

    fn upload(library: &Library, asset_id: &str, status: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO cloud_sync_queue
                    (id, entity_type, entity_id, operation, status, revision, updated_at)
                 VALUES (?1, 'asset', ?2, 'upsert', ?3, 1, '2026-09-25T00:00:00Z')",
                rusqlite::params![format!("queue-{asset_id}"), asset_id, status],
            )
            .unwrap();
    }

    fn add(library: &Library, asset_id: &str, album_id: &str) {
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec![asset_id.to_owned()],
                add_album_ids: vec![album_id.to_owned()],
                remove_album_ids: Vec::new(),
            })
            .unwrap();
    }

    fn album(library: &Library, name: &str) -> String {
        library
            .create_album(CreateAlbum {
                name: name.into(),
                parent_id: None,
            })
            .unwrap()
            .id
    }

    /// Albums created before adoption queue nothing, so the queue holds only memberships.
    fn setup() -> (tempfile::TempDir, Library, String, String) {
        let (temp, library) = open();
        let first = album(&library, "새로 가져옴");
        let second = album(&library, "예전 자료");
        let library_id = library.library_id().unwrap();
        library
            .adopt_album_authority_for_test(&library_id, 1, 1, 0)
            .unwrap();
        (temp, library, first, second)
    }

    fn drops(library: &Library) -> Option<(i64, String)> {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT dropped_count, last_reason FROM authority_intent_drops WHERE domain = 'albums'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    }

    fn receive_is_not_deferred(library: &Library, client: &CloudClient) {
        let status = SyncStatus {
            protocol_version: 1,
            active: true,
            library_id: Some(library.library_id().unwrap()),
            domains: vec![SyncAuthorityDomain {
                domain: "albums".into(),
                library_id: library.library_id().unwrap(),
                epoch: 1,
                contract_version: 1,
                cursor: 0,
            }],
        };
        let received = library
            .reconcile_album_authority_with_status(client, "token", &|| Ok(status.clone()), true)
            .unwrap();
        assert!(
            !received.deferred_to_outbox,
            "a membership waiting for its Asset must not stop receive"
        );
    }

    #[test]
    fn a_membership_for_an_uncommitted_asset_waits_without_blocking_others() {
        let (_temp, library, first, second) = setup();
        insert_asset(&library, "fresh");
        upload(&library, "fresh", "pending");
        insert_asset(&library, "old");
        upload(&library, "old", "synced");
        // The fresh import is added first, so a strict FIFO would stop behind it.
        add(&library, "fresh", &first);
        add(&library, "old", &second);

        let (base, seen, handle) = accepting_server();
        let client = CloudClient::new(&base).unwrap();
        let report = library.flush_album_outbox_with(&client, "token").unwrap();
        handle.join().unwrap();

        assert_eq!(report.sent, 1);
        assert_eq!(report.waiting, 1);
        assert_eq!(report.blocked, 0);
        assert!(!report.stopped, "a waiting membership must not stop the pass");
        {
            let sent = seen.lock().unwrap();
            assert_eq!(sent.len(), 1, "the waiting intent is not sent early");
            assert_eq!(sent[0]["assetId"], "old");
        }
        let status = library.album_sync_status().unwrap();
        assert_eq!((status.pending_count, status.waiting_count, status.blocked_count), (1, 1, 0));
        receive_is_not_deferred(&library, &client);
        // The optimistic membership stays visible while it waits.
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM asset_albums WHERE asset_id = 'fresh' AND album_id = ?1",
                    [&first],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        // Once the upload commits, the membership is sent normally.
        library
            .connection()
            .unwrap()
            .execute("UPDATE cloud_sync_queue SET status = 'synced' WHERE entity_id = 'fresh'", [])
            .unwrap();
        let (base, seen, handle) = accepting_server();
        let client = CloudClient::new(&base).unwrap();
        let report = library.flush_album_outbox_with(&client, "token").unwrap();
        handle.join().unwrap();
        assert_eq!((report.sent, report.waiting, report.dropped), (1, 0, 0));
        assert_eq!(seen.lock().unwrap()[0]["assetId"], "fresh");
        assert!(outbox(&library.connection().unwrap()).is_empty());
        assert_eq!(drops(&library), None);
    }

    #[test]
    fn a_membership_is_dropped_when_its_asset_is_trashed_before_upload() {
        let (_temp, library, first, _) = setup();
        insert_asset(&library, "fresh");
        upload(&library, "fresh", "pending");
        add(&library, "fresh", &first);
        library.trash_assets(&["fresh".to_owned()]).unwrap();

        // No request can be made: the intent is retired before anything is sent.
        let client = CloudClient::new("http://127.0.0.1:9/v1").unwrap();
        let report = library.flush_album_outbox_with(&client, "token").unwrap();
        assert_eq!((report.dropped, report.waiting, report.pending), (1, 0, 0));
        assert!(!report.stopped);
        assert!(outbox(&library.connection().unwrap()).is_empty());
        assert_eq!(drops(&library), Some((1, "assetTrashedBeforeUpload".to_owned())));
        let status = library.album_sync_status().unwrap();
        assert_eq!(status.dropped_count, 1);
        assert_eq!(status.last_drop_reason.as_deref(), Some("assetTrashedBeforeUpload"));

        // Restoring resumes the upload, so the relation the Asset still holds is queued
        // again and waits for that upload.
        library.restore_assets(&["fresh".to_owned()]).unwrap();
        let queued = outbox(&library.connection().unwrap());
        assert_eq!(queued.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&queued[0].2).unwrap();
        assert_eq!(payload["assetId"], "fresh");
        assert_eq!(payload["albumId"], first.as_str());
        assert_eq!(payload["desiredState"], true);
        assert_eq!(library.album_sync_status().unwrap().waiting_count, 1);
    }

    #[test]
    fn a_waiting_membership_whose_album_was_deleted_is_dropped_not_blocked() {
        let (_temp, library, first, _) = setup();
        insert_asset(&library, "fresh");
        upload(&library, "fresh", "pending");
        add(&library, "fresh", &first);
        // The Album's delete reached the server while the membership waited.
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO album_authority_revisions (album_id, entity_revision, deleted, updated_at)
                 VALUES (?1, 2, 1, '2026-09-25T00:00:00Z')",
                [&first],
            )
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute("UPDATE cloud_sync_queue SET status = 'synced' WHERE entity_id = 'fresh'", [])
            .unwrap();

        let client = CloudClient::new("http://127.0.0.1:9/v1").unwrap();
        let report = library.flush_album_outbox_with(&client, "token").unwrap();
        assert_eq!((report.dropped, report.blocked), (1, 0));
        assert!(!report.stopped);
        assert_eq!(drops(&library), Some((1, "albumDeleted".to_owned())));
    }

    /// Readiness is decided once per Asset per pass: if the upload commits mid-pass, a
    /// later remove for the same relation must not overtake the add that already waited.
    #[test]
    fn an_upload_committing_mid_pass_does_not_reorder_one_relation() {
        let (temp, library, first, second) = setup();
        insert_asset(&library, "fresh");
        upload(&library, "fresh", "pending");
        insert_asset(&library, "old");
        upload(&library, "old", "synced");
        add(&library, "fresh", &first);
        add(&library, "old", &second);
        library
            .patch_asset_albums(AssetAlbumPatch {
                asset_ids: vec!["fresh".into()],
                add_album_ids: Vec::new(),
                remove_album_ids: vec![first.clone()],
            })
            .unwrap();

        // The server commits the fresh upload while it handles the other Asset's command.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.server_addr());
        let database = temp.path().join("library.sqlite");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            while let Ok(Some(mut request)) =
                server.recv_timeout(std::time::Duration::from_millis(400))
            {
                let body = read_body(&mut request);
                rusqlite::Connection::open(&database)
                    .unwrap()
                    .execute(
                        "UPDATE cloud_sync_queue SET status = 'synced' WHERE entity_id = 'fresh'",
                        [],
                    )
                    .unwrap();
                log.lock().unwrap().push(body.clone());
                let result = serde_json::json!({
                    "libraryId": body["libraryId"],
                    "epoch": body["epoch"],
                    "contractVersion": 1,
                    "commandType": "setAlbumMembership",
                    "operationId": body["operationId"],
                    "changed": true,
                    "changeSequence": 1,
                    "authorityCursor": 1,
                    "album": null,
                    "membership": {
                        "albumId": body["albumId"],
                        "assetId": body["assetId"],
                        "desiredState": body["desiredState"],
                        "entityRevision": 1
                    },
                    "updatedAt": "2026-09-25T00:00:00Z"
                });
                request
                    .respond(
                        Response::from_data(serde_json::to_vec(&result).unwrap()).with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        ),
                    )
                    .unwrap();
            }
        });
        let client = CloudClient::new(&base).unwrap();
        let report = library.flush_album_outbox_with(&client, "token").unwrap();
        handle.join().unwrap();
        {
            let sent = seen.lock().unwrap();
            assert_eq!(sent.len(), 1, "the fresh Asset's intents stay held for this pass");
            assert_eq!(sent[0]["assetId"], "old");
        }
        assert_eq!((report.sent, report.waiting), (1, 2));

        // Next pass: add, then remove, in queue order.
        let (base, seen, handle) = accepting_server();
        let client = CloudClient::new(&base).unwrap();
        library.flush_album_outbox_with(&client, "token").unwrap();
        handle.join().unwrap();
        let sent = seen.lock().unwrap();
        assert_eq!(
            sent.iter().map(|body| body["desiredState"].as_bool().unwrap()).collect::<Vec<_>>(),
            [true, false]
        );
    }
}
