use super::*;
use std::cell::RefCell;

fn setup() -> (tempfile::TempDir, Library, SyncAuthorityDomain) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let domain = SyncAuthorityDomain {
        domain: DOMAIN.into(),
        library_id: library.library_id().unwrap(),
        epoch: 1,
        contract_version: 1,
        cursor: 0,
    };
    (temp, library, domain)
}
fn identity(namespace: &str, value: &str) -> MangaIndexIdentity {
    MangaIndexIdentity {
        kind: if namespace == "artist" {
            "artist"
        } else {
            "tag"
        }
        .into(),
        namespace: namespace.into(),
        value: value.into(),
        label: value.into(),
    }
}
fn row(namespace: &str, value: &str, desired: bool, revision: i64) -> PinState {
    PinState {
        identity: identity(namespace, value),
        desired_state: desired,
        entity_revision: revision,
        created_at: Some("2026-10-02T00:00:00Z".into()),
        updated_at: Some("2026-10-02T00:00:00Z".into()),
    }
}
fn snapshot(domain: &SyncAuthorityDomain, revision: i64, items: Vec<PinState>) -> PinSnapshot {
    PinSnapshot {
        library_id: domain.library_id.clone(),
        epoch: domain.epoch,
        contract_version: 1,
        revision,
        items,
    }
}
fn pending(library: &Library) -> Vec<Intent> {
    let c = library.connection().unwrap();
    entries(&c).unwrap()
}
fn applied(domain: &SyncAuthorityDomain, state: PinState, revision: i64) -> PinReply {
    PinReply::Applied(PinResult {
        library_id: domain.library_id.clone(),
        epoch: domain.epoch,
        contract_version: 1,
        revision,
        state,
    })
}

#[test]
fn manga_pins_pull_overlays_unsent_changes_and_never_enqueues_remote_pins() {
    let (_temp, library, domain) = setup();
    library
        .add_manga_index_pin(identity("female", "local"))
        .unwrap();
    library
        .remove_manga_index_pin(identity("artist", "removed"))
        .unwrap();
    let before = pending(&library);
    library
        .apply_pin_snapshot(
            &snapshot(
                &domain,
                2,
                vec![
                    row("artist", "remote", true, 1),
                    row("artist", "removed", true, 1),
                ],
            ),
            &domain.library_id,
            1,
        )
        .unwrap();
    let pins = library.list_manga_index_pins().unwrap();
    assert_eq!(pins.len(), 2);
    assert!(pins.iter().any(|p| p.value == "local"));
    assert!(pins.iter().any(|p| p.value == "remote"));
    assert_eq!(
        pending(&library)
            .iter()
            .map(|i| &i.operation)
            .collect::<Vec<_>>(),
        before.iter().map(|i| &i.operation).collect::<Vec<_>>()
    );
}
#[test]
fn manga_pins_confirm_and_pull_remote_delete_without_resurrection() {
    let (_temp, library, domain) = setup();
    library
        .add_manga_index_pin(identity("female", "tag"))
        .unwrap();
    let reads = RefCell::new(0);
    let outcome = library
        .sync_pins_using(
            &domain,
            || {
                *reads.borrow_mut() += 1;
                Ok(if *reads.borrow() == 1 {
                    snapshot(&domain, 0, vec![])
                } else {
                    snapshot(&domain, 2, vec![row("female", "tag", false, 2)])
                })
            },
            |_, command| {
                assert_eq!(command["expectedRevision"], 0);
                Ok(applied(&domain, row("female", "tag", true, 1), 1))
            },
        )
        .unwrap();
    assert!(outcome.sent && outcome.changed);
    assert!(pending(&library).is_empty());
    assert!(library.list_manga_index_pins().unwrap().is_empty());
}
#[test]
fn manga_pins_transport_retry_keeps_operation_and_durable_local_intent() {
    let (temp, library, domain) = setup();
    library
        .add_manga_index_pin(identity("female", "tag"))
        .unwrap();
    let operation = RefCell::new(String::new());
    let error = library.sync_pins_using(
        &domain,
        || Ok(snapshot(&domain, 0, vec![])),
        |_, command| {
            *operation.borrow_mut() = command["operationId"].as_str().unwrap().into();
            Err(LibraryError::CloudRequestUnavailable)
        },
    );
    assert!(error.is_err());
    assert_eq!(pending(&library)[0].operation, *operation.borrow());
    drop(library);
    let library = Library::open(temp.path().join("library")).unwrap();
    library
        .sync_pins_using(
            &domain,
            || Ok(snapshot(&domain, 1, vec![row("female", "tag", true, 1)])),
            |_, command| {
                assert_eq!(command["operationId"], operation.borrow().as_str());
                Ok(applied(&domain, row("female", "tag", true, 1), 1))
            },
        )
        .unwrap();
    assert!(pending(&library).is_empty());
}
#[test]
fn manga_pins_conflict_rebases_user_intent_with_a_new_receipt_id() {
    let (_temp, library, domain) = setup();
    library
        .add_manga_index_pin(identity("female", "tag"))
        .unwrap();
    let calls = RefCell::new(vec![]);
    library
        .sync_pins_using(
            &domain,
            || Ok(snapshot(&domain, 3, vec![row("female", "tag", true, 3)])),
            |_, command| {
                calls.borrow_mut().push(command.clone());
                if calls.borrow().len() == 1 {
                    Ok(PinReply::Conflict(row("female", "tag", false, 2)))
                } else {
                    Ok(applied(&domain, row("female", "tag", true, 3), 3))
                }
            },
        )
        .unwrap();
    assert_eq!(calls.borrow()[1]["expectedRevision"], 2);
    assert_ne!(
        calls.borrow()[0]["operationId"],
        calls.borrow()[1]["operationId"]
    );
    assert!(pending(&library).is_empty());
}
#[test]
fn manga_pins_confirmation_does_not_retire_superseding_user_action() {
    let (_temp, library, domain) = setup();
    library
        .add_manga_index_pin(identity("female", "tag"))
        .unwrap();
    library
        .sync_pins_using(
            &domain,
            || Ok(snapshot(&domain, 1, vec![row("female", "tag", true, 1)])),
            |_, _| {
                library
                    .remove_manga_index_pin(identity("female", "tag"))
                    .unwrap();
                Ok(applied(&domain, row("female", "tag", true, 1), 1))
            },
        )
        .unwrap();
    assert_eq!(pending(&library).len(), 1);
    assert!(!pending(&library)[0].desired);
    assert!(library.list_manga_index_pins().unwrap().is_empty());
}
#[test]
fn manga_pins_malformed_cross_library_and_stale_snapshots_are_inert() {
    let (_temp, library, domain) = setup();
    library
        .apply_pin_snapshot(
            &snapshot(&domain, 2, vec![row("female", "tag", true, 2)]),
            &domain.library_id,
            1,
        )
        .unwrap();
    assert!(!library
        .apply_pin_snapshot(&snapshot(&domain, 1, vec![]), &domain.library_id, 1)
        .unwrap());
    let mut other = snapshot(&domain, 3, vec![]);
    other.library_id = "b".repeat(32);
    assert!(library
        .apply_pin_snapshot(&other, &domain.library_id, 1)
        .is_err());
    let duplicate = snapshot(
        &domain,
        3,
        vec![row("female", "tag", true, 2), row("female", "tag", true, 2)],
    );
    assert!(library
        .apply_pin_snapshot(&duplicate, &domain.library_id, 1)
        .is_err());
    assert_eq!(library.list_manga_index_pins().unwrap().len(), 1);
    let mut other_domain = domain.clone();
    other_domain.library_id = "b".repeat(32);
    assert!(library
        .sync_pins_using(
            &other_domain,
            || panic!("must fence before reading"),
            |_, _| panic!("must not send")
        )
        .is_err());
}
#[test]
fn manga_pins_failed_final_read_cannot_leave_a_retired_overlay_at_an_equal_cursor() {
    let (_temp, library, mut domain) = setup();
    domain.cursor = 2;
    library
        .add_manga_index_pin(identity("female", "tag"))
        .unwrap();
    // The original command was sent at epoch 1 / revision 0 and its response
    // was lost; its receipt may now predate another device's deletion.
    library
        .connection()
        .unwrap()
        .execute("UPDATE manga_index_pin_outbox SET epoch=1", [])
        .unwrap();
    let reads = RefCell::new(0);
    let result = library.sync_pins_using(
        &domain,
        || {
            *reads.borrow_mut() += 1;
            if *reads.borrow() == 1 {
                Ok(snapshot(&domain, 2, vec![row("female", "tag", false, 2)]))
            } else {
                Err(LibraryError::CloudRequestUnavailable)
            }
        },
        |_, _| Ok(applied(&domain, row("female", "tag", true, 1), 1)),
    );
    assert!(result.is_err());
    assert!(pending(&library).is_empty());
    library
        .sync_pins_using(
            &domain,
            || Ok(snapshot(&domain, 2, vec![row("female", "tag", false, 2)])),
            |_, _| panic!("receipt already retired"),
        )
        .unwrap();
    assert!(library.list_manga_index_pins().unwrap().is_empty());
}
#[test]
fn manga_pins_old_server_does_not_destroy_local_pins_or_the_queue() {
    let (_temp, library, domain) = setup();
    library
        .add_manga_index_pin(identity("female", "tag"))
        .unwrap();
    let operation = pending(&library)[0].operation.clone();
    library
        .sync_pins_using(
            &domain,
            || Err(LibraryError::CatalogBookmarkSyncRejected(404)),
            |_, _| panic!("old server must never receive pins"),
        )
        .unwrap();
    assert_eq!(pending(&library)[0].operation, operation);
    assert_eq!(library.list_manga_index_pins().unwrap().len(), 1);
}
#[test]
fn manga_pins_upgrade_118_keeps_existing_pins_as_outgoing_intent() {
    let temp = tempfile::tempdir().unwrap();
    let mut c = Connection::open(temp.path().join("test.sqlite")).unwrap();
    c.execute_batch(include_str!("../../migrations/0118_manga_index_pins.sql"))
        .unwrap();
    c.execute(
        "INSERT INTO manga_index_pins VALUES('tag','female','tag','label','now')",
        [],
    )
    .unwrap();
    c.execute_batch(include_str!(
        "../../migrations/0119_manga_index_pin_sync.sql"
    ))
    .unwrap();
    assert_eq!(entries(&c).unwrap().len(), 1);
    assert!(uuid::Uuid::parse_str(&entries(&c).unwrap()[0].operation).is_ok());
    assert_eq!(
        c.query_row("SELECT label FROM manga_index_pins", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "label"
    );
    assert_eq!(
        c.pragma_query_value(None, "quick_check", |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    // No write from a pull may cause an unsafe whole-database restore later.
    let (_temp, library, domain) = setup();
    library
        .apply_pin_snapshot(&snapshot(&domain, 0, vec![]), &domain.library_id, 1)
        .unwrap();
    assert!(
        super::super::restore_guard::adopted_domains(&library.connection().unwrap())
            .unwrap()
            .contains(&DOMAIN)
    );
}
