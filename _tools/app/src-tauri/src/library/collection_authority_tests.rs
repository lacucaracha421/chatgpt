use super::*;
use std::cell::{Cell, RefCell};

const NOW: &str = "2026-10-06T00:00:00Z";

fn provider_edit_before_delivery(new_import: bool) {
    let (_temp, library, status) = fixture();
    let mut confirmed = work("w", 1);
    confirmed["type"] = json!("movie");
    confirmed["fields"]["status"] = Value::Null;
    confirmed["fields"]["overview"] = json!("A");
    let mut base = binding();
    base["provider"] = json!("tmdb");
    base["externalId"] = json!("42");
    base["snapshotExternalId"] = json!("42");
    base["config"] = Value::Null;
    base["snapshot"] = json!({"id":42,"overview":"A"});
    base["values"] = provider_snapshot_values("tmdb", &base["snapshot"]).unwrap();
    base["snapshotDigest"] = snapshot_digest(&base["snapshot"]);
    adopt(
        &library,
        &status,
        if new_import {
            json!({})
        } else {
            json!({"works":[confirmed.clone()],"bindings":[base.clone()]})
        },
    );
    let input = super::super::models::ExternalBindingInput {
        provider: "tmdb".into(),
        external_id: "42".into(),
        provider_config_json: None,
        provider_data_json: Some(json!({"id":42,"overview":"B"}).to_string()),
        last_synced_at: None,
    };
    library
        .queue_provider_operation(
            "w",
            new_import.then_some("Imported"),
            "movie",
            Some(input),
            &[],
            &[],
        )
        .unwrap();
    assert_eq!(
        library.get_collection("w").unwrap().overview.as_deref(),
        Some("B")
    );
    // Use the same optimistic-write transaction and expectation builder as core edits.
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    let before = editable_work(&tx, "w").unwrap();
    tx.execute(
        "UPDATE collections SET overview=NULL,description='my memo' WHERE id='w'",
        [],
    )
    .unwrap();
    enqueue_work_changes(&tx, &status, "w", &before).unwrap();
    tx.commit().unwrap();
    drop(db);
    let commands = provider_commands(&library);
    let edit = commands.last().unwrap();
    assert_eq!(edit["expected"]["overview"], "B");
    assert_eq!(edit["changes"]["overview"], Value::Null);
    assert_eq!(edit["changes"]["description"], "my memo");
    let server = RefCell::new(confirmed);
    let deliveries = Cell::new(0);
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                let mut server = server.borrow_mut();
                deliveries.set(deliveries.get() + 1);
                server["entityRevision"] = json!(deliveries.get() + 1);
                let entities = match body["commandType"].as_str().unwrap() {
                    "createWork" | "applyProviderSnapshot" => {
                        server["fields"]["overview"] = json!("B");
                        if new_import {
                            server["name"] = json!("Imported");
                            server["fields"]["description"] = Value::Null;
                        }
                        let mut base = base.clone();
                        base["values"] =
                            provider_snapshot_values("tmdb", &json!({"id":42,"overview":"B"}))?;
                        base["snapshot"] = json!({"id":42,"overview":"B"});
                        base["snapshotDigest"] = snapshot_digest(&base["snapshot"]);
                        base["entityRevision"] = json!(2);
                        json!({"works":[server.clone()],"bindings":[base.clone()]})
                    }
                    "updateWork" => {
                        // Exercise the server's field CAS: mismatches must fail the test.
                        for (field, value) in body["changes"].as_object().unwrap() {
                            assert_eq!(body["expected"][field], server["fields"][field]);
                            server["fields"][field] = value.clone();
                        }
                        json!({"works":[server.clone()]})
                    }
                    other => panic!("unexpected command: {other}"),
                };
                let mut receipt = envelope(&status);
                receipt["operationId"] = body["operationId"].clone();
                receipt["commandType"] = body["commandType"].clone();
                receipt["changed"] = json!(true);
                receipt["authorityCursor"] = json!(deliveries.get());
                receipt["entities"] = entities;
                Ok(CollectionDelivery::Accepted(receipt))
            },
            0,
        )
        .unwrap();
    assert_eq!(deliveries.get(), 2);
    let final_work = library.get_collection("w").unwrap();
    assert_eq!(final_work.overview, None);
    assert_eq!(final_work.description.as_deref(), Some("my memo"));
    assert_eq!(server.borrow()["fields"]["overview"], Value::Null);
    assert_eq!(server.borrow()["fields"]["description"], "my memo");
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_authority_outbox WHERE state='accepted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
}

#[test]
fn collection_authority_refresh_then_clear_and_memo_before_delivery_survive() {
    provider_edit_before_delivery(false);
}

#[test]
fn collection_authority_new_import_then_immediate_clear_and_memo_survive() {
    provider_edit_before_delivery(true);
}

#[test]
fn collection_authority_provider_credentials_follow_role_and_body_limits() {
    for command in ["createWork", "bindProvider", "applyProviderSnapshot"] {
        let body = json!({"commandType":command,"binding":{"provider":"tmdb"}});
        assert_eq!(
            command_credential(&body, "client", Some("publisher")).unwrap(),
            "publisher"
        );
        assert_eq!(command_byte_limit(&body, true), COMMAND_BYTES_PUBLISHER);
        if command == "createWork" {
            assert_eq!(command_credential(&body, "client", None).unwrap(), "client");
            assert_eq!(command_byte_limit(&body, false), COMMAND_BYTES_CLIENT);
        } else {
            assert!(matches!(
                command_credential(&body, "client", None),
                Err(LibraryError::CloudCredentialNotConfigured)
            ));
        }
    }
    assert_eq!(
        command_credential(
            &json!({"commandType":"updateWork"}),
            "client",
            Some("publisher")
        )
        .unwrap(),
        "client"
    );
}

#[test]
fn collection_authority_definitive_provider_refusal_does_not_stall_unrelated_edits() {
    let (_temp, library, status) = fixture();
    adopt(&library, &status, json!({"works":[work("w",1)]}));
    let refused = enqueue(&library, &status, "bindProvider");
    let next = enqueue(&library, &status, "addArtwork");
    let calls = Cell::new(0);
    assert!(library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                calls.set(calls.get() + 1);
                if body["operationId"] == refused {
                    Ok(CollectionDelivery::Dropped(
                        json!({"code":"invalidCollectionCommand"}),
                    ))
                } else {
                    assert_eq!(body["operationId"], next);
                    let mut receipt = envelope(&status);
                    receipt["operationId"] = body["operationId"].clone();
                    receipt["commandType"] = body["commandType"].clone();
                    receipt["changed"] = json!(false);
                    receipt["authorityCursor"] = json!(0);
                    receipt["entities"] = json!({});
                    Ok(CollectionDelivery::Accepted(receipt))
                }
            },
            0
        )
        .unwrap());
    assert_eq!(calls.get(), 2);
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT state FROM collection_authority_outbox WHERE operation_id=?1",
                [&refused],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "dropped"
    );
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT drop_reason FROM collection_authority_outbox WHERE operation_id=?1",
                [&refused],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "invalidCollectionCommand"
    );
}

#[test]
fn collection_authority_large_import_splits_and_records_omitted_details() {
    let (_temp, library, status) = fixture();
    adopt(&library, &status, json!({}));
    let input = super::super::models::ExternalBindingInput {
        provider: "tmdb".into(), external_id: "42".into(), provider_config_json: None,
        provider_data_json: Some(json!({"id":42,"overview":"B","film":{"cast":[{"name":"n".repeat(DETAIL_BYTES+1),"character":""}],"releases":[],"related":null}}).to_string()),
        last_synced_at: None,
    };
    library
        .queue_provider_operation("w", Some("Imported"), "movie", Some(input), &[], &[])
        .unwrap();
    let commands = provider_commands(&library);
    assert_eq!(
        commands
            .iter()
            .map(|v| v["commandType"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["createWork", "bindProvider", "applyProviderSnapshot"]
    );
    assert!(commands[0].to_string().len() < COMMAND_BYTES_CLIENT);
    assert_eq!(commands[0]["binding"], Value::Null);
    assert!(commands[2]["snapshot"].to_string().len() <= SNAPSHOT_BYTES);
    assert_eq!(commands[2]["details"], Value::Null);
    assert_eq!(commands[2]["values"]["overview"], "B");
    assert!(library.connection().unwrap().query_row("SELECT conflict_detail FROM collection_authority_outbox WHERE command_type='applyProviderSnapshot'", [], |r| r.get::<_, String>(0)).unwrap().contains("TooLarge"));
}

#[test]
fn collection_authority_materialization_deadline_stops_between_items_and_keeps_count_cap() {
    let (_temp, library, status) = fixture();
    let mut second = art();
    second["artworkId"] = json!("art2");
    adopt(
        &library,
        &status,
        json!({"works":[work("w",1)],"artworks":[art(),second]}),
    );
    let calls = Cell::new(0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    let slow = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        calls.set(calls.get() + 1);
        std::fs::write(path, b"image").unwrap();
        std::thread::sleep(
            deadline.saturating_duration_since(std::time::Instant::now())
                + std::time::Duration::from_millis(5),
        );
        Ok(())
    };
    assert_eq!(
        library
            .materialize_collection_artwork_until(&status, &slow, 0, 8, Some(deadline))
            .unwrap(),
        1
    );
    assert_eq!(calls.get(), 1);
    assert_eq!(
        library
            .materialize_collection_artwork_until(
                &status,
                &|_, _, _, _, _, _| panic!("expired deadline"),
                0,
                8,
                Some(deadline)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        library
            .materialize_collection_artwork_with(
                &status,
                &|_, _, _, _, _, path| {
                    std::fs::write(path, b"image").unwrap();
                    Ok(())
                },
                0,
                0
            )
            .unwrap(),
        0
    );
    assert_eq!(
        library
            .materialize_collection_artwork_with(
                &status,
                &|_, _, _, _, _, path| {
                    std::fs::write(path, b"image").unwrap();
                    Ok(())
                },
                0,
                1
            )
            .unwrap(),
        1
    );
}

#[test]
fn collection_authority_provider_download_limit_skips_even_above_legacy_maximum() {
    let bytes = vec![1; 32 * 1024 * 1024 + 1];
    let mut reader = std::io::Cursor::new(&bytes);
    let downloaded = read_provider_artwork(&mut reader).unwrap();
    assert_eq!(downloaded.len(), 16 * 1024 * 1024 + 1);
    assert_eq!(reader.position(), downloaded.len() as u64);
    let (_temp, library, id) = provider_fixture("game", None, "42", json!({}));
    let result = library
        .queue_provider_operation(
            &id,
            None,
            "game",
            None,
            &[ProviderArtwork {
                image: "oversized",
                kind: "hero",
                bytes: &downloaded,
                select: true,
                season: None,
            }],
            &[],
        )
        .unwrap();
    assert_eq!(result.skipped_provider_artwork, ["oversized"]);
    assert_eq!(
        serde_json::to_value(&result).unwrap()["skippedProviderArtwork"],
        json!(["oversized"])
    );
    assert!(provider_commands(&library).is_empty());
}

pub(crate) fn provider_fixture(
    kind: &str,
    provider: Option<&str>,
    external: &str,
    snapshot: Value,
) -> (tempfile::TempDir, Library, String) {
    let (temp, library, status) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let mut initial = work(&id, 1);
    initial["type"] = json!(kind);
    initial["fields"]["status"] = json!(if kind == "game" {
        "unplayed"
    } else {
        "unwatched"
    });
    let bindings = provider
        .map(|provider| {
            let mut binding = binding();
            binding["workId"] = json!(id);
            binding["provider"] = json!(provider);
            binding["externalId"] = json!(external);
            binding["snapshotExternalId"] = json!(external);
            binding["config"] = Value::Null;
            binding["snapshot"] = snapshot.clone();
            binding["values"] = crate::cloud::collections::collection_baseline::provider_values(
                provider, &snapshot,
            )
            .unwrap();
            binding["snapshotDigest"] = snapshot_digest(&snapshot);
            vec![binding]
        })
        .unwrap_or_default();
    adopt(
        &library,
        &status,
        json!({"works":[initial],"bindings":bindings}),
    );
    // Bindings stay confirmed; optimistic metadata is owned by the outbox projector.
    library.connection().unwrap().execute_batch("CREATE TRIGGER reject_provider_binding_insert BEFORE INSERT ON collection_external_bindings BEGIN SELECT RAISE(ABORT,'legacy binding insert'); END;
        CREATE TRIGGER reject_provider_binding_update BEFORE UPDATE ON collection_external_bindings BEGIN SELECT RAISE(ABORT,'legacy binding update'); END;
        CREATE TRIGGER reject_provider_binding_delete BEFORE DELETE ON collection_external_bindings BEGIN SELECT RAISE(ABORT,'legacy binding delete'); END;
        CREATE TRIGGER reject_provider_art_delete BEFORE DELETE ON collection_work_artworks BEGIN SELECT RAISE(ABORT,'legacy artwork delete'); END;
        CREATE TRIGGER reject_provider_art_kind BEFORE UPDATE OF kind ON collection_work_artworks BEGIN SELECT RAISE(ABORT,'legacy artwork mutation'); END;").unwrap();
    (temp, library, id)
}

pub(crate) fn provider_commands(library: &Library) -> Vec<Value> {
    library
        .connection()
        .unwrap()
        .prepare("SELECT payload FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| serde_json::from_str(&r.unwrap()).unwrap())
        .collect()
}

pub(crate) fn provider_png() -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 4)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

#[test]
fn collection_authority_provider_artwork_upload_confirm_add_select_are_fifo_and_retryable() {
    let (temp, library, id) = provider_fixture("game", None, "42", json!({}));
    let png = provider_png();
    library
        .queue_provider_operation(
            &id,
            None,
            "game",
            None,
            &[ProviderArtwork {
                image: "image",
                kind: "hero",
                bytes: &png,
                select: true,
                season: None,
            }],
            &[],
        )
        .unwrap();
    let trace = RefCell::new(Vec::new());
    let status = collection_write_status(&*library.connection().unwrap()).unwrap();
    let upload = |_: &crate::cloud::collections::ArtworkBlob, bytes: &[u8]| {
        assert_eq!(bytes, png);
        trace.borrow_mut().push("upload");
        Ok(())
    };
    let missing = |_: &crate::cloud::collections::ArtworkBlob| {
        trace.borrow_mut().push("confirm");
        Ok(false)
    };
    // No confirmation means no add command reaches the server; retry stays pending.
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                library.upload_collection_command_artwork_with(body, &upload, &missing)?;
                panic!("must not send unconfirmed artwork");
            },
            0,
        )
        .unwrap();
    assert_eq!(*trace.borrow(), ["upload", "confirm"]);
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["commandType"], "addArtwork");
    assert_eq!(commands[1]["commandType"], "selectArtwork");
    let trace = RefCell::new(Vec::new());
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                if body["commandType"] == "addArtwork" {
                    library.upload_collection_command_artwork_with(
                        body,
                        &|_, bytes| {
                            assert_eq!(bytes, png);
                            trace.borrow_mut().push("upload");
                            Ok(())
                        },
                        &|_| {
                            trace.borrow_mut().push("confirm");
                            Ok(true)
                        },
                    )?;
                    trace.borrow_mut().push("addArtwork");
                } else {
                    trace.borrow_mut().push("selectArtwork");
                }
                let mut receipt = envelope(&status);
                receipt["operationId"] = body["operationId"].clone();
                receipt["commandType"] = body["commandType"].clone();
                receipt["changed"] = json!(true);
                receipt["authorityCursor"] = json!(1);
                receipt["entities"] = json!({});
                Ok(CollectionDelivery::Accepted(receipt))
            },
            100,
        )
        .unwrap();
    assert_eq!(
        *trace.borrow(),
        ["upload", "confirm", "addArtwork", "selectArtwork"]
    );
}

#[test]
fn collection_authority_steam_binding_survives_baseline_and_changes() {
    let (_temp, library, status) = fixture();
    let mut game = work("w", 1);
    game["type"] = json!("game");
    game["fields"]["status"] = json!("unplayed");
    let mut steam = binding();
    steam["provider"] = json!("steam");
    steam["externalId"] = json!("570");
    steam["snapshot"] = Value::Null;
    steam["values"] = Value::Null;
    adopt(
        &library,
        &status,
        json!({"works":[game],"bindings":[steam]}),
    );
    let db = library.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT external_id FROM collection_external_bindings WHERE provider='steam'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "570"
    );
    drop(db);
    steam["externalId"] = json!("730");
    steam["entityRevision"] = json!(2);
    library
        .apply_collection_changes(&changes(
            &status,
            1,
            json!([change(1, json!({"bindings":[steam]}))]),
        ))
        .unwrap();
    let db = library.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT external_id FROM collection_external_bindings WHERE provider='steam'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "730"
    );
}

#[test]
fn collection_authority_tracking_is_queued_and_zero_is_projected_from_feed() {
    let (_temp, l, s) = fixture();
    let mut initial = work("w", 1);
    initial["derived"]["ownedVolumes"] = json!([{"editionIndex":0,"count":1}]);
    adopt(&l, &s, json!({"works":[initial],"ownership":[ownership()]}));
    l.set_owned_volume_count("w", 0, 0).unwrap();
    l.set_owned_volume_count("w", 0, 0).unwrap();
    let c = l.connection().unwrap();
    let raw: String = c
        .query_row("SELECT payload FROM collection_authority_outbox", [], |r| {
            r.get(0)
        })
        .unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["commandType"], "setOwnershipTracking");
    assert_eq!(body["count"], 0);
    assert_eq!(body["expectedCount"], 1);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_authority_outbox",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(c);
    assert!(l.list_volume_ownership("w").unwrap()[0].physical);
    let mut w = work("w", 2);
    w["derived"]["ownedVolumes"] = json!([{"editionIndex":0,"count":0}]);
    let mut o = ownership();
    o["physical"] = json!(false);
    o["entityRevision"] = json!(2);
    l.apply_collection_changes(&changes(
        &s,
        1,
        json!([change(1, json!({"works":[w],"ownership":[o]}))]),
    ))
    .unwrap();
    assert_eq!(l.list_ownership_tracking("w").unwrap(), vec![0]);
    assert!(!l.list_volume_ownership("w").unwrap()[0].physical);
}

#[test]
fn collection_authority_count_then_individual_ownership_predicts_fifo_revision() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    l.set_owned_volume_count("w", 0, 2).unwrap();
    l.set_volume_ownership("w", 0, vec![1], "digital", true)
        .unwrap();
    l.set_volume_ownership("w", 0, vec![1], "physical", false)
        .unwrap();
    let c = l.connection().unwrap();
    let rows = c
        .prepare("SELECT payload FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| serde_json::from_str::<Value>(&r.unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1]["expectedRevision"], 1);
    assert_eq!(rows[1]["physical"], true);
    assert_eq!(rows[2]["expectedRevision"], 2);
    assert_eq!(rows[2]["physical"], false);
    assert_eq!(rows[2]["digital"], true);
}

#[test]
fn collection_authority_provider_snapshot_is_deduplicated_without_local_merge() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    let input = super::super::models::ExternalBindingInput {
        provider: "kakao".into(),
        external_id: "book-1".into(),
        provider_config_json: Some("{}".into()),
        provider_data_json: Some("{\"title\":\"Fetched\"}".into()),
        last_synced_at: Some(NOW.into()),
    };
    for _ in 0..2 {
        let mut c = l.connection().unwrap();
        let tx = c.transaction().unwrap();
        enqueue_provider_snapshot(&tx, &s, "w", &input).unwrap();
        tx.commit().unwrap();
    }
    let c = l.connection().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_authority_outbox",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_external_bindings",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT description FROM collections WHERE id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "server memo"
    );
    let raw:String=c.query_row("SELECT payload FROM collection_authority_outbox WHERE command_type='applyProviderSnapshot'",[],|r|r.get(0)).unwrap();
    let b: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(b["values"], json!({}));
    assert_eq!(b["baseSnapshotDigest"], Value::Null);
}

#[test]
fn collection_authority_release_ack_is_shared_and_deduplicated() {
    let (_temp, l, s) = fixture();
    let mut w = work("w", 1);
    w["derived"]["releaseEvents"] = json!([{"eventId":"e","provider":"mangadex","kind":"new_volume","volumeNumber":2,"previousValue":null,"currentValue":null,"detectedAt":NOW,"readAt":null}]);
    adopt(&l, &s, json!({"works":[w.clone()]}));
    l.take_unread_release_changes("w").unwrap();
    l.acknowledge_release_events("w", vec!["e".into()]).unwrap();
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_authority_outbox",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(l.list_unread_release_changes().unwrap().len(), 1);
    w["entityRevision"] = json!(2);
    w["derived"]["releaseEvents"][0]["readAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 1, json!([change(1, json!({"works":[w]}))])))
        .unwrap();
    assert!(l.list_unread_release_changes().unwrap().is_empty());
}

#[test]
fn collection_authority_provider_rebind_uses_zero_for_tombstone_cas() {
    let (_temp, l, s) = fixture();
    let binding = json!({"workId":"w","provider":"kakao","externalId":"book-1","config":null,"snapshot":null,"values":null,"snapshotDigest":null,"bound":false,"entityRevision":7,"createdAt":NOW,"updatedAt":NOW,"lastSyncedAt":null});
    adopt(&l, &s, json!({"works":[work("w",1)],"bindings":[binding]}));
    let input = super::super::models::ExternalBindingInput {
        provider: "kakao".into(),
        external_id: "book-1".into(),
        provider_config_json: None,
        provider_data_json: Some("{}".into()),
        last_synced_at: None,
    };
    let mut connection = l.connection().unwrap();
    let tx = connection.transaction().unwrap();
    enqueue_provider_snapshot(&tx, &s, "w", &input).unwrap();
    enqueue_provider_snapshot(&tx, &s, "w", &input).unwrap();
    let raw: String = tx
        .query_row(
            "SELECT payload FROM collection_authority_outbox WHERE command_type='bindProvider'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let command: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(command["expectedRevision"], 0);
    assert_eq!(
        tx.query_row(
            "SELECT COUNT(*) FROM collection_authority_outbox",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    tx.commit().unwrap();
}

#[test]
fn collection_authority_batch4_operations_fence_unadopted_and_rare_imports() {
    let (_temp, l, s) = fixture();
    l.observe_collection_authority(&s).unwrap();
    assert!(matches!(
        l.set_owned_volume_count("missing", 0, 0),
        Err(LibraryError::CollectionNotFound) | Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
    assert!(matches!(
        l.import_book_collections("nonexistent"),
        Err(LibraryError::CollectionAuthorityOperationUnavailable)
    ));
    assert!(matches!(
        l.connect_igdb_game("missing", 42),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
}

#[test]
fn collection_authority_provider_stale_refetches_once_then_records_drop() {
    for (kind,provider,external) in [("manga","kakao","book-1"),("movie","tmdb","42"),("game","igdb","42")] {
    let (_temp, l, s) = fixture();
    let mut initial = work("w",1);
    initial["type"] = json!(kind);
    adopt(&l, &s, json!({"works":[initial]}));
    let input = super::super::models::ExternalBindingInput {
        provider: provider.into(),
        external_id: external.into(),
        provider_config_json: Some("{}".into()),
        provider_data_json: Some(json!({"id":42,"title":"old","film":{"cast":[],"releases":[],"related":null}}).to_string()),
        last_synced_at: None,
    };
    {
        let mut c = l.connection().unwrap();
        let tx = c.transaction().unwrap();
        enqueue_provider_snapshot(&tx, &s, "w", &input).unwrap();
        tx.execute("UPDATE collection_authority_outbox SET state='accepted' WHERE command_type='bindProvider'",[]).unwrap();
        tx.commit().unwrap();
    }
    let refetches = Cell::new(0);
    let send = |body: &Value| {
        assert_eq!(body["details"].is_object(),provider=="tmdb");
        if provider == "tmdb" { assert!(body["details"]["film"].is_object()); }
        Ok(CollectionDelivery::Conflict(
            json!({"code":"providerSnapshotStale","current":{"binding":null}}),
        ))
    };
    let refresh = |_body: &Value| {
        refetches.set(refetches.get() + 1);
        let mut input = input.clone();
        let mut snapshot: Value = serde_json::from_str(input.provider_data_json.as_deref().unwrap()).unwrap();
        snapshot["title"] = json!("fresh");
        input.provider_data_json = Some(snapshot.to_string());
        let mut c = l.connection()?;
        let tx = c.transaction()?;
        enqueue_provider_snapshot(&tx, &s, "w", &input)?;
        tx.execute("UPDATE collection_authority_outbox SET state='accepted' WHERE command_type='bindProvider'",[])?;
        tx.commit()?;
        Ok(())
    };
    assert!(l
        .flush_collection_outbox_with_refresh(&s, &send, 0, &refresh)
        .unwrap());
    assert_eq!(refetches.get(), 1);
    assert_eq!(l.connection().unwrap().query_row("SELECT COUNT(*) FROM collection_authority_outbox WHERE command_type='applyProviderSnapshot' AND state='dropped' AND drop_reason='providerSnapshotStale'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert!(!l
        .flush_collection_outbox_with_refresh(&s, &send, 0, &refresh)
        .unwrap());
    }
}

#[test]
fn collection_authority_mangadex_apply_defers_fields_and_projects_original_title() {
    use super::super::{
        mangadex,
        models::{MangaDexApplyRequest, MangaDexApplyTarget},
    };
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    let detail: Value =
        serde_json::from_str(include_str!("fixtures/mangadex_detail.json")).unwrap();
    let covers: Value =
        serde_json::from_str(include_str!("fixtures/mangadex_covers.json")).unwrap();
    let mut preview =
        mangadex::parse_work_preview(&detail.to_string(), &covers.to_string()).unwrap();
    let original = preview.japanese_title.clone();
    let manga_id = preview.manga_id.clone();
    preview.covers.clear();
    let fetched = mangadex::MangaDexFetchedWork {
        preview,
        snapshot_json: json!({"detail":detail,"covers":covers}).to_string(),
    };
    l.apply_fetched_mangadex(
        MangaDexApplyRequest {
            target: MangaDexApplyTarget::Existing {
                collection_id: "w".into(),
            },
            manga_id,
        },
        fetched,
        None,
    )
    .unwrap();
    let c = l.connection().unwrap();
    assert_eq!(
        c.query_row("SELECT year FROM collections WHERE id='w'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2026
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM collection_external_bindings",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let raw:String=c.query_row("SELECT payload FROM collection_authority_outbox WHERE command_type='applyProviderSnapshot'",[],|r|r.get(0)).unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["values"]["originalTitle"], json!(original));
}

#[test]
fn collection_authority_personal_replay_only_advances_local_receipts_and_cursor() {
    use super::super::collection_personal_edits::PersonalEditEntry;
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    let endpoint = "https://fixture.invalid";
    let library = l.library_id().unwrap();
    l.adopt_collection_personal_edit_library(endpoint, &library)
        .unwrap();
    let item = PersonalEditEntry {
        sequence: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        collection_id: "w".into(),
        field: "myScore".into(),
        value: json!(1.0),
        previous: json!(4.5),
        created_at: NOW.into(),
    };
    let outcome = l
        .apply_collection_personal_edit_page(endpoint, &library, &[item.clone()])
        .unwrap();
    assert_eq!(outcome.changed, 0);
    assert_eq!(outcome.skipped, 1);
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row("SELECT my_score FROM collections WHERE id='w'", [], |r| r
                .get::<_, f64>(
                0
            ))
            .unwrap(),
        4.5
    );
    assert_eq!(l.connection().unwrap().query_row("SELECT received_cursor FROM mobile_collection_personal_edit_sync WHERE endpoint=?1",[endpoint],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(
        l.apply_collection_personal_edit_page(endpoint, &library, &[item])
            .unwrap()
            .already_consumed,
        1
    );
}

#[test]
fn collection_authority_release_read_replay_keeps_feed_owned_state_and_local_cursor() {
    use crate::cloud::collection_releases::ReadEntry;
    let (_temp, l, s) = fixture();
    let mut w = work("w", 1);
    w["derived"]["releaseEvents"] = json!([{"eventId":"e","provider":"mangadex","kind":"new_volume","volumeNumber":2,"previousValue":null,"currentValue":null,"detectedAt":NOW,"readAt":null}]);
    adopt(&l, &s, json!({"works":[w]}));
    let item = ReadEntry {
        sequence: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        collection_id: "w".into(),
        event_id: "e".into(),
        created_at: NOW.into(),
    };
    assert_eq!(
        l.apply_collection_release_reads("https://fixture.invalid", 0, &[item], 1)
            .unwrap(),
        0
    );
    assert_eq!(l.list_unread_release_changes().unwrap().len(), 1);
    let raw:String=l.connection().unwrap().query_row("SELECT value FROM notes_state WHERE key='collectionReleaseSync:https://fixture.invalid'",[],|r|r.get(0)).unwrap();
    let state: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(state["readCursor"], 1);
}
pub(crate) fn fixture() -> (tempfile::TempDir, Library, CollectionAuthorityStatus) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let status = CollectionAuthorityStatus {
        active: true,
        library_id: Some(library.library_id().unwrap()),
        epoch: Some(1),
        contract_version: Some(1),
        cursor: Some(0),
    };
    (temp, library, status)
}
pub(crate) fn work(id: &str, rev: i64) -> Value {
    json!({"workId":id,"type":"manga","legacyKind":null,"name":format!("Work {id}"),"fields":{"description":"server memo","coverAssetId":null,"year":2026,"myScore":4.5,"status":"collecting","ownedPlatform":null},"showcase":false,"showcaseOrder":null,"selection":{"work":null,"hero":null,"backdrop":null,"spine":null},"details":{"series":null,"film":null,"av":null},"derived":{"unreadReleaseCount":99},"avCredits":[],"lifecycle":"live","trashedAt":null,"entityRevision":rev,"createdAt":NOW,"updatedAt":NOW})
}
fn art() -> Value {
    use sha2::{Digest, Sha256};
    json!({"artworkId":"art","workId":"w","kind":"cover","provider":null,"providerImageId":null,"width":10,"height":20,"language":null,"original":{"sha256":Sha256::digest(b"image").iter().map(|b| format!("{b:02x}")).collect::<String>(),"sizeBytes":5,"contentType":"image/png","objectKey":"unused"},"thumbnail":null,"createdAt":NOW,"entityRevision":1})
}
fn volume() -> Value {
    json!({"volumeId":"v","workId":"w","volumeNumber":1,"editionIndex":0,"sortOrder":3,"displayLabel":"1","coverArtworkId":"art","sourceProvider":null,"sourceCoverId":null,"deleted":false,"entityRevision":1})
}
pub(crate) fn binding() -> Value {
    json!({"workId":"w","provider":"mangadex","externalId":"provider-work","config":{"language":"ja"},"snapshot":{"title":"server"},"values":{},"snapshotDigest":"digest","snapshotExternalId":"provider-work","lastSyncedAt":NOW,"bound":true,"entityRevision":1})
}
fn source() -> Value {
    json!({"workId":"w","volumeNumber":1,"provider":"kakao","providerItemId":"isbn","title":"Volume","author":null,"publisher":null,"isbn13":"123","publicationDate":"2026-10-06","itemUrl":null,"data":{},"deleted":false,"entityRevision":1})
}
fn membership(asset: &str, rev: i64, desired: bool) -> Value {
    json!({"workId":"w","assetId":asset,"desiredState":desired,"entityRevision":rev,"addedAt":NOW})
}
fn ownership() -> Value {
    json!({"workId":"w","volumeNumber":1,"editionIndex":0,"physical":true,"digital":false,"entityRevision":1})
}
fn envelope(status: &CollectionAuthorityStatus) -> Value {
    json!({"libraryId":status.library_id,"epoch":status.epoch,"contractVersion":status.contract_version})
}
fn manifest(status: &CollectionAuthorityStatus, entities: &Value) -> Value {
    let mut v = envelope(status);
    v["snapshotCursor"] = json!(status.cursor.unwrap());
    v["sections"] = json!(SECTIONS
        .iter()
        .map(|s| json!({"section":s,"count":entities[*s].as_array().map_or(0,Vec::len)}))
        .collect::<Vec<_>>());
    v
}
fn page(status: &CollectionAuthorityStatus, section: usize, items: Value) -> Value {
    let mut v = envelope(status);
    v["snapshotCursor"] = json!(status.cursor.unwrap());
    v["section"] = json!(SECTIONS[section]);
    v["items"] = items;
    v["nextAfter"] = Value::Null;
    v["hasMore"] = json!(false);
    v["complete"] = json!(section == 6);
    v["nextSection"] = json!(SECTIONS.get(section + 1));
    v
}
pub(crate) fn adopt(l: &Library, s: &CollectionAuthorityStatus, entities: Value) {
    l.begin_collection_baseline(s, &manifest(s, &entities))
        .unwrap();
    for (i, section) in SECTIONS.iter().enumerate() {
        assert_eq!(
            l.apply_collection_baseline_page(&page(
                s,
                i,
                entities[*section]
                    .as_array()
                    .map(|v| json!(v))
                    .unwrap_or(json!([]))
            ))
            .unwrap(),
            i == 6
        );
    }
}
fn changes(s: &CollectionAuthorityStatus, cursor: i64, items: Value) -> Value {
    let mut v = envelope(s);
    v["cursor"] = json!(cursor);
    v["nextAfter"] = json!(cursor);
    v["hasMore"] = json!(false);
    v["items"] = items;
    v
}
fn change(seq: i64, entities: Value) -> Value {
    json!({"sequence":seq,"authorityCursor":seq,"commandType":"updateWork","operationId":format!("op{seq}"),"changedAt":NOW,"entities":entities})
}
fn asset(l: &Library, id: &str) {
    l.connection().unwrap().execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES(?1,?1,'image',?1,?1,'thumb',1,10,20,'now')",[id]).unwrap();
}
fn count(l: &Library, table: &str) -> i64 {
    l.connection()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn core_bodies(l: &Library) -> Vec<Value> {
    l.connection()
        .unwrap()
        .prepare("SELECT payload FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|raw| serde_json::from_str(&raw.unwrap()).unwrap())
        .collect()
}
fn core_create(l: &Library, name: &str) -> super::super::models::CollectionSummary {
    l.create_collection(super::super::models::CreateCollection {
        name: name.into(),
        description: Some("memo".into()),
        collection_type: super::super::models::CollectionType::Game,
    })
    .unwrap()
}
fn core_edit(kind: &str, name: &str) -> super::super::models::UpdateCollection {
    serde_json::from_value(json!({"type":kind,"name":name,"description":"new memo","year":2025,"originalTitle":"Original","runtimeMinutes":null,"author":null,"director":null,"developer":"Developer","publisher":"Publisher","platforms":"PC","productionCompany":null,"releaseDate":"2025-01-01","externalScore":80,"myScore":4.0})).unwrap()
}

#[test]
fn collection_authority_core_crud_and_records_use_exact_commands_and_atomic_local_state() {
    use super::super::collection_pc::WorkRecordEdit;
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({}));
    let created = core_create(&l, "Game");
    let body = core_bodies(&l).remove(0);
    assert_eq!(
        body,
        json!({"libraryId":s.library_id,"epoch":1,"contractVersion":1,"operationId":body["operationId"],"commandType":"createWork","workId":created.id,"type":"game","name":"Game","legacyKind":null,"fields":{"description":"memo"},"binding":null})
    );
    assert_eq!(
        uuid::Uuid::parse_str(body["operationId"].as_str().unwrap())
            .unwrap()
            .to_string(),
        body["operationId"]
    );
    l.update_collection(&created.id, core_edit("game", "Renamed"))
        .unwrap();
    let update = core_bodies(&l).remove(1);
    assert_eq!(update["commandType"], "updateWork");
    assert_eq!(update["expectedRevision"], Value::Null);
    assert_eq!(update["changes"]["name"], "Renamed");
    assert_eq!(update["expected"]["name"], "Game");
    assert_eq!(update["expected"]["description"], "memo");
    assert_eq!(update.as_object().unwrap().len(), 9);
    assert_eq!(
        update["changes"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        update["expected"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>()
    );
    for edit in [
        WorkRecordEdit::Status {
            value: Some("playing".into()),
        },
        WorkRecordEdit::OwnedPlatform {
            value: Some("  Switch  ".into()),
        },
        WorkRecordEdit::MyScore { value: Some(4.5) },
        WorkRecordEdit::Memo {
            value: Some("  personal  ".into()),
        },
    ] {
        l.save_collection_work_record(&created.id, edit).unwrap();
    }
    let record = l.collection_work_record(&created.id).unwrap();
    assert_eq!(record.status.as_deref(), Some("playing"));
    assert_eq!(record.owned_platform.as_deref(), Some("Switch"));
    assert_eq!(record.my_score, Some(4.5));
    assert_eq!(record.memo.as_deref(), Some("personal"));
    for (body, field, value, expected) in core_bodies(&l)[2..]
        .iter()
        .zip([
            ("status", json!("playing"), Value::Null),
            ("ownedPlatform", json!("Switch"), Value::Null),
            ("myScore", json!(4.5), json!(4.0)),
            ("description", json!("personal"), json!("new memo")),
        ])
        .map(|(body, (field, value, expected))| (body, field, value, expected))
    {
        assert_eq!(body["changes"], json!({field:value}));
        assert_eq!(body["expected"], json!({field:expected}));
    }
    l.save_collection_work_record(
        &created.id,
        WorkRecordEdit::Status {
            value: Some("playing".into()),
        },
    )
    .unwrap();
    assert_eq!(core_bodies(&l).len(), 6);
    l.delete_collection(&created.id).unwrap();
    assert!(matches!(
        l.get_collection(&created.id),
        Err(LibraryError::CollectionNotFound)
    ));
    assert_eq!(count(&l, "collection_authority_trash"), 1);
    let deleted = core_bodies(&l).pop().unwrap();
    assert_eq!(deleted["commandType"], "deleteWork");
    assert_eq!(deleted["expectedRevision"], 6);
    let db = l.connection().unwrap();
    let snapshot: String = db
        .query_row(
            "SELECT local_snapshot FROM collection_authority_trash",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["collections"][0]["name"], "Renamed");
    assert_eq!(
        snapshot["collection_pc_records"][0]["owned_platform"],
        "Switch"
    );
}

#[test]
fn collection_authority_core_membership_cover_showcase_and_order_commands() {
    use super::super::models::{AssetCollectionPatch, CollectionType};
    let (_temp, l, s) = fixture();
    let mut game = work("g", 3);
    game["type"] = json!("game");
    game["fields"]["status"] = Value::Null;
    let mut second = game.clone();
    second["workId"] = json!("h");
    second["name"] = json!("Other");
    adopt(&l, &s, json!({"works":[game,second]}));
    asset(&l, "a");
    let patch = |add: bool| AssetCollectionPatch {
        asset_ids: vec!["a".into()],
        add_collection_ids: if add { vec!["g".into()] } else { vec![] },
        remove_collection_ids: if add { vec![] } else { vec!["g".into()] },
    };
    l.patch_asset_collections(patch(true)).unwrap();
    l.patch_asset_collections(patch(true)).unwrap();
    l.set_collection_cover("g", Some("a")).unwrap();
    l.set_collection_showcase("g", true).unwrap();
    l.set_collection_showcase("h", true).unwrap();
    l.set_collection_showcase_order(CollectionType::Game, vec!["h".into(), "g".into()])
        .unwrap();
    assert_eq!(l.get_collection("g").unwrap().showcase_order, Some(1));
    assert_eq!(l.get_collection("h").unwrap().showcase_order, Some(0));
    let bodies = core_bodies(&l);
    assert_eq!(bodies[0]["commandType"], "setMembership");
    assert_eq!(bodies[0]["desiredState"], true);
    assert_eq!(bodies[0]["expectedRevision"], 0);
    assert_eq!(bodies[0].as_object().unwrap().len(), 9);
    assert_eq!(bodies[1]["changes"], json!({"coverAssetId":"a"}));
    assert_eq!(bodies[1]["expected"], json!({"coverAssetId":null}));
    assert_eq!(bodies[2]["changes"], json!({"showcase":true}));
    assert_eq!(bodies[4]["commandType"], "setShowcaseOrder");
    assert_eq!(bodies[4]["type"], "game");
    assert_eq!(bodies[4]["workIds"], json!(["h", "g"]));
    assert_eq!(bodies[4].as_object().unwrap().len(), 7);
    l.patch_asset_collections(patch(false)).unwrap();
    let bodies = core_bodies(&l);
    assert_eq!(bodies[5]["changes"], json!({"coverAssetId":null}));
    assert_eq!(bodies[6]["desiredState"], false);
    assert_eq!(bodies[6]["expectedRevision"], 1);
    assert_eq!(count(&l, "collection_assets"), 0);
    assert_eq!(l.get_collection("g").unwrap().cover_asset_id, None);
}

#[test]
fn collection_authority_core_fences_every_unadopted_write_and_active_type_change() {
    use super::super::{
        collection_pc::WorkRecordEdit,
        models::{AssetCollectionPatch, CollectionType},
    };
    let (_temp, l, s) = fixture();
    let created = core_create(&l, "Legacy");
    l.observe_collection_authority(&s).unwrap();
    let refused = vec![
        l.create_collection(super::super::models::CreateCollection {
            name: "new".into(),
            description: None,
            collection_type: CollectionType::Game,
        })
        .map(|_| ()),
        l.update_collection(&created.id, core_edit("game", "rename"))
            .map(|_| ()),
        l.delete_collection(&created.id),
        l.set_collection_cover(&created.id, None).map(|_| ()),
        l.set_collection_showcase(&created.id, true).map(|_| ()),
        l.set_collection_showcase_order(CollectionType::Game, vec![]),
        l.patch_asset_collections(AssetCollectionPatch {
            asset_ids: vec![],
            add_collection_ids: vec![],
            remove_collection_ids: vec![],
        }),
        l.save_collection_work_record(&created.id, WorkRecordEdit::Memo { value: None })
            .map(|_| ()),
    ];
    for result in refused {
        assert!(matches!(
            result,
            Err(LibraryError::CollectionAuthorityNotAdopted)
        ));
    }
    assert_eq!(l.get_collection(&created.id).unwrap().name, "Legacy");
    assert!(core_bodies(&l).is_empty());
    let mut game = work(&created.id, 1);
    game["type"] = json!("game");
    game["fields"]["status"] = Value::Null;
    adopt(&l, &s, json!({"works":[game]}));
    assert!(matches!(
        l.update_collection(&created.id, core_edit("movie", "rename")),
        Err(LibraryError::CollectionAuthorityTypeChangeUnavailable)
    ));
    assert!(core_bodies(&l).is_empty());
}

#[test]
fn collection_authority_core_conflict_restores_feed_state_and_records_nonblocking_drop() {
    use super::super::collection_pc::WorkRecordEdit;
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    l.save_collection_work_record(
        "w",
        WorkRecordEdit::Memo {
            value: Some("optimistic".into()),
        },
    )
    .unwrap();
    l.save_collection_work_record("w", WorkRecordEdit::MyScore { value: Some(3.0) })
        .unwrap();
    // Equal-revision confirmed rows must also replace an optimistic projection.
    assert!(l
        .flush_collection_outbox_with(
            &s,
            &|_| Ok(CollectionDelivery::Conflict(
                json!({"code":"revisionConflict","current":{"work":work("w",1)}})
            )),
            0
        )
        .unwrap());
    assert_eq!(
        l.collection_work_record("w").unwrap().memo.as_deref(),
        Some("server memo")
    );
    assert_eq!(l.collection_work_record("w").unwrap().my_score, Some(4.5));
    let mut remote = work("w", 2);
    remote["fields"]["description"] = json!("remote wins");
    l.apply_collection_changes(&changes(
        &s,
        1,
        json!([change(1, json!({"works":[remote]}))]),
    ))
    .unwrap();
    assert_eq!(
        l.collection_work_record("w").unwrap().memo.as_deref(),
        Some("remote wins")
    );
    let health = l.authority_sync_health().unwrap();
    assert_eq!(health.collections.dropped_count, 2);
    assert_eq!(health.collections.blocked_count, 0);
    assert!(matches!(
        health.collections.last_drop_reason.as_deref(),
        Some("dependencyDropped" | "revisionConflict")
    ));
    assert!(!l
        .flush_collection_outbox_with(&s, &|_| panic!("settled conflict retried"), 100)
        .unwrap());
}

#[test]
fn collection_authority_core_delete_conflict_restores_archived_children_without_file_cleanup() {
    let (temp, l, s) = fixture();
    asset(&l, "asset");
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"memberships":[membership("asset",1,true)]}),
    );
    let path = temp.path().join("collection-thumbnails/w");
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("keep"), b"image").unwrap();
    l.delete_collection("w").unwrap();
    assert!(path.join("keep").exists());
    l.flush_collection_outbox_with(
        &s,
        &|_| {
            Ok(CollectionDelivery::Conflict(
                json!({"code":"revisionConflict","current":{"work":work("w",2)}}),
            ))
        },
        0,
    )
    .unwrap();
    assert!(l.get_collection("w").is_ok());
    assert_eq!(l.get_asset_collections("asset").unwrap(), vec!["w"]);
    assert_eq!(count(&l, "collection_authority_trash"), 0);
    assert!(path.join("keep").exists());
}

#[test]
fn collection_authority_core_delete_retains_archived_artwork_on_cleanup_and_reopen() {
    let (temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)],"artworks":[art()]}));
    let relative: String = l
        .connection()
        .unwrap()
        .query_row(
            "SELECT relative_path FROM collection_work_artworks WHERE id='art'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let original = temp.path().join(relative);
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, b"image").unwrap();
    l.delete_collection("w").unwrap();
    l.cleanup_unreferenced_work_artwork().unwrap();
    assert!(original.exists());
    drop(l);
    let reopened = Library::open(temp.path()).unwrap();
    assert!(original.exists());
    assert_eq!(count(&reopened, "collection_authority_trash"), 1);
}

#[test]
fn collection_authority_core_outbox_failure_rolls_back_local_writes() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    l.connection().unwrap().execute_batch("CREATE TRIGGER refuse_collection_outbox BEFORE INSERT ON collection_authority_outbox BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END").unwrap();
    assert!(l
        .update_collection("w", core_edit("manga", "must roll back"))
        .is_err());
    assert_eq!(l.get_collection("w").unwrap().name, "Work w");
    assert_eq!(
        l.collection_work_record("w").unwrap().memo.as_deref(),
        Some("server memo")
    );
    assert!(l
        .create_collection(super::super::models::CreateCollection {
            name: "new".into(),
            description: None,
            collection_type: super::super::models::CollectionType::Game
        })
        .is_err());
    assert_eq!(count(&l, "collections"), 1);
    assert_eq!(count(&l, "collection_authority_outbox"), 0);
}

#[test]
fn collection_authority_core_dropped_receipt_hides_deleted_work_then_applies_feed() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    l.save_collection_work_record(
        "w",
        super::super::collection_pc::WorkRecordEdit::Memo {
            value: Some("optimistic".into()),
        },
    )
    .unwrap();
    l.flush_collection_outbox_with(
        &s,
        &|_| Ok(CollectionDelivery::Dropped(json!({"code":"workDeleted"}))),
        0,
    )
    .unwrap();
    assert!(matches!(
        l.get_collection("w"),
        Err(LibraryError::CollectionNotFound)
    ));
    let mut deleted = work("w", 2);
    deleted["lifecycle"] = json!("tombstoned");
    deleted["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(
        &s,
        1,
        json!([change(1, json!({"works":[deleted]}))]),
    ))
    .unwrap();
    assert_eq!(
        l.authority_sync_health().unwrap().collections.dropped_count,
        1
    );
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row(
                "SELECT lifecycle FROM collection_authority_trash WHERE work_id='w'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "tombstoned"
    );
}

#[test]
fn collection_authority_core_receipt_keeps_newer_optimistic_record_pending_on_retry() {
    use super::super::collection_pc::WorkRecordEdit;
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    l.save_collection_work_record(
        "w",
        WorkRecordEdit::Memo {
            value: Some("first".into()),
        },
    )
    .unwrap();
    l.save_collection_work_record(
        "w",
        WorkRecordEdit::Memo {
            value: Some("second".into()),
        },
    )
    .unwrap();
    let calls = Cell::new(0);
    l.flush_collection_outbox_with(
        &s,
        &|body| {
            calls.set(calls.get() + 1);
            if calls.get() > 1 {
                return Ok(CollectionDelivery::Retry);
            }
            let mut receipt = envelope(&s);
            receipt["operationId"] = body["operationId"].clone();
            receipt["commandType"] = body["commandType"].clone();
            receipt["changed"] = json!(true);
            receipt["authorityCursor"] = json!(1);
            let mut confirmed = work("w", 2);
            confirmed["fields"]["description"] = json!("first");
            receipt["entities"] = json!({"works":[confirmed]});
            Ok(CollectionDelivery::Accepted(receipt))
        },
        0,
    )
    .unwrap();
    assert_eq!(
        l.collection_work_record("w").unwrap().memo.as_deref(),
        Some("second")
    );
    let db = l.connection().unwrap();
    let cached: String = db
        .query_row(
            "SELECT payload FROM collection_authority_revisions WHERE section='works'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&cached).unwrap()["fields"]["description"],
        "first"
    );
    drop(db);
    assert_eq!(
        core_bodies(&l)[1]["expected"],
        json!({"description":"first"})
    );
}

#[test]
fn collection_authority_core_delete_revision_tracks_showcase_append_and_unchanged_reorder_rank() {
    use super::super::models::CollectionType;
    let (_temp, l, s) = fixture();
    let mut g = work("g", 3);
    let mut h = work("h", 3);
    h["showcase"] = json!(true);
    h["showcaseOrder"] = json!(0);
    let mut x = work("x", 3);
    x["showcase"] = json!(true);
    x["showcaseOrder"] = json!(1);
    for value in [&mut g, &mut h, &mut x] {
        value["type"] = json!("game");
        value["fields"]["status"] = Value::Null;
    }
    adopt(&l, &s, json!({"works":[g,h,x]}));
    l.set_collection_showcase("g", true).unwrap();
    l.set_collection_showcase_order(
        CollectionType::Game,
        vec!["x".into(), "h".into(), "g".into()],
    )
    .unwrap();
    l.delete_collection("g").unwrap();
    // g was appended at rank 2; the reorder only changes the other two ranks.
    assert_eq!(core_bodies(&l).last().unwrap()["expectedRevision"], 4);
}

#[test]
fn collection_authority_empty_adoption_projects_all_seven_sections() {
    let (_temp, l, s) = fixture();
    asset(&l, "asset");
    let mut w = work("w", 1);
    w["selection"]["work"] = json!("art");
    adopt(
        &l,
        &s,
        json!({"works":[w],"bindings":[binding()],"artworks":[art()],"volumes":[volume()],"volumeSources":[source()],"ownership":[ownership()],"memberships":[membership("asset",1,true)]}),
    );
    assert!(ensure_collection_write_ready(&*l.connection().unwrap(), &s).unwrap());
    for table in [
        "collections",
        "collection_external_bindings",
        "collection_work_artworks",
        "collection_volumes",
        "collection_volume_sources",
        "collection_volume_ownership",
        "collection_assets",
        "collection_authority_materialization",
    ] {
        assert_eq!(count(&l, table), 1, "{table}");
    }
    assert_eq!(count(&l, "collection_authority_revisions"), 7);
    let db = l.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT selected FROM collection_work_artworks WHERE id='art'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT status FROM collection_pc_records WHERE collection_id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "collecting"
    );
    assert_eq!(
        db.query_row("SELECT cover_artwork_id FROM collection_volumes", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "art"
    );
}

#[test]
fn collection_authority_populated_adoption_preserves_local_paths_thumbnails_activity_workers_and_focus(
) {
    let (temp, l, s) = fixture();
    l.connection().unwrap().execute_batch("INSERT INTO collections(id,name,type,source_path,created_at,updated_at) VALUES('w','Old','manga','source folder','old','old'),('orphan','Local only','manga',NULL,'old','old');
        INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,created_at,updated_at) VALUES('art','w','local','art','cover','local/original.png','image/png',10,20,'old','old');
        INSERT INTO collection_volumes(id,collection_id,volume_number,edition_index,sort_order,source_file_name,created_at,updated_at) VALUES('v','w',1,0,1,'local volume.png','old','old');
        INSERT INTO collection_volume_cover_focus VALUES('v','art',0.25,'head');
        INSERT INTO collection_external_bindings(collection_id,provider,external_id,created_at,updated_at) VALUES('w','mangadex','old','old','old');
        INSERT INTO collection_update_attempts VALUES('w','mangadex','later');
        INSERT INTO collection_activity(collection_id,open_count,last_opened_at) VALUES('w',7,'old');
        INSERT INTO collection_ownership_tracking VALUES('w',0);").unwrap();
    std::fs::create_dir_all(temp.path().join("local")).unwrap();
    std::fs::write(temp.path().join("local/original.png"), b"local").unwrap();
    std::fs::write(temp.path().join("local/thumb.webp"), b"thumbnail").unwrap();
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"bindings":[binding()],"artworks":[art()],"volumes":[volume()],"ownership":[ownership()]}),
    );
    let db = l.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT name,source_path FROM collections WHERE id='w'",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        )
        .unwrap(),
        ("Work w".into(), "source folder".into())
    );
    assert_eq!(
        db.query_row(
            "SELECT relative_path FROM collection_work_artworks",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "local/original.png"
    );
    assert_eq!(
        db.query_row("SELECT source_file_name FROM collection_volumes", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "local volume.png"
    );
    assert_eq!(
        db.query_row("SELECT open_count FROM collection_activity", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        db.query_row("SELECT retry_at FROM collection_update_attempts", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "later"
    );
    assert_eq!(
        db.query_row(
            "SELECT focus_x FROM collection_volume_cover_focus",
            [],
            |r| r.get::<_, f64>(0)
        )
        .unwrap(),
        0.25
    );
    assert_eq!(
        db.query_row(
            "SELECT lifecycle FROM collection_authority_trash WHERE work_id='orphan'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "absent"
    );
    drop(db);
    assert_eq!(count(&l, "collection_authority_materialization"), 0);
    assert_eq!(count(&l, "collection_ownership_tracking"), 1);
    assert_eq!(
        std::fs::read(temp.path().join("local/original.png")).unwrap(),
        b"local"
    );
    assert_eq!(
        std::fs::read(temp.path().join("local/thumb.webp")).unwrap(),
        b"thumbnail"
    );
}

#[test]
fn collection_authority_pages_are_transactional_resumable_counted_and_fenced_until_complete() {
    let (_temp, l, s) = fixture();
    let entities = json!({"works":[work("w",1),work("x",1)]});
    l.begin_collection_baseline(&s, &manifest(&s, &entities))
        .unwrap();
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &s),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
    let mut first = page(&s, 0, json!([work("w", 1)]));
    first["hasMore"] = json!(true);
    first["nextAfter"] = json!("[\"w\"]");
    first["nextSection"] = Value::Null;
    l.apply_collection_baseline_page(&first).unwrap();
    assert_eq!(
        local(&*l.connection().unwrap())
            .unwrap()
            .unwrap()
            .after
            .as_deref(),
        Some("[\"w\"]")
    );
    assert!(l.apply_collection_baseline_page(&first).is_err());
    assert_eq!(count(&l, "collections"), 1);
    let mut invalid = page(&s, 0, json!([work("x", 1)]));
    invalid["complete"] = json!(true);
    assert!(l.apply_collection_baseline_page(&invalid).is_err());
    assert_eq!(count(&l, "collections"), 1);
    l.apply_collection_baseline_page(&page(&s, 0, json!([work("x", 1)])))
        .unwrap();
    for i in 1..7 {
        l.apply_collection_baseline_page(&page(&s, i, json!([])))
            .unwrap();
    }
    assert!(local(&*l.connection().unwrap()).unwrap().unwrap().adopted);
}

#[test]
fn collection_authority_changes_are_idempotent_revision_checked_ordered_and_atomic() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    asset(&l, "a");
    let mut w = work("w", 2);
    w["name"] = json!("Updated");
    w["selection"]["work"] = json!("art");
    let p = changes(
        &s,
        1,
        json!([change(
            1,
            json!({"works":[w],"bindings":[binding()],"artworks":[art()],"volumes":[volume()],"volumeSources":[source()],"ownership":[ownership()],"memberships":[membership("a",1,true)]})
        )]),
    );
    assert_eq!(l.apply_collection_changes(&p).unwrap(), 7);
    assert_eq!(l.apply_collection_changes(&p).unwrap(), 0);
    assert_eq!(
        local(&*l.connection().unwrap()).unwrap().unwrap().id.cursor,
        1
    );
    let stale = changes(&s, 2, json!([change(2, json!({"works":[work("w",1)]}))]));
    assert_eq!(l.apply_collection_changes(&stale).unwrap(), 0);
    assert_eq!(l.apply_collection_changes(&p).unwrap(), 0);
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row("SELECT name FROM collections WHERE id='w'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Updated"
    );
    let gap = changes(&s, 4, json!([change(4, json!({"works":[work("w",3)]}))]));
    assert!(l.apply_collection_changes(&gap).is_err());
    let reversed = changes(&s, 4, json!([change(4, json!({})), change(3, json!({}))]));
    assert!(l.apply_collection_changes(&reversed).is_err());
    let malformed = changes(
        &s,
        3,
        json!([change(
            3,
            json!({"works":[work("w",3)],"bindings":[{"workId":"w"}]})
        )]),
    );
    assert!(l.apply_collection_changes(&malformed).is_err());
    assert_eq!(
        local(&*l.connection().unwrap()).unwrap().unwrap().id.cursor,
        2
    );
    let mut b = binding();
    b["bound"] = json!(false);
    b["entityRevision"] = json!(2);
    let mut v = volume();
    v["deleted"] = json!(true);
    v["entityRevision"] = json!(2);
    l.apply_collection_changes(&changes(
        &s,
        3,
        json!([change(
            3,
            json!({"bindings":[b],"volumes":[v],"memberships":[membership("a",2,false)]})
        )]),
    ))
    .unwrap();
    assert_eq!(count(&l, "collection_assets"), 0);
    assert_eq!(count(&l, "collection_external_bindings"), 0);
    assert_eq!(count(&l, "collection_volumes"), 0);
    assert_eq!(count(&l, "assets"), 1);
}

#[test]
fn collection_authority_trash_tombstone_and_restore_preserve_files_assets_and_local_subtree() {
    let (temp, l, s) = fixture();
    asset(&l, "a");
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"artworks":[art()],"volumes":[volume()],"memberships":[membership("a",1,true)]}),
    );
    std::fs::write(temp.path().join("keep.png"), b"keep").unwrap();
    let mut w = work("w", 2);
    w["lifecycle"] = json!("trashed");
    w["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 1, json!([change(1, json!({"works":[w]}))])))
        .unwrap();
    let retain: String = l
        .connection()
        .unwrap()
        .query_row(
            "SELECT retain_until FROM collection_authority_trash",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(retain.starts_with("2026-11-05"));
    let mut w = work("w", 3);
    w["lifecycle"] = json!("tombstoned");
    w["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 2, json!([change(2, json!({"works":[w]}))])))
        .unwrap();
    assert_eq!(count(&l, "assets"), 1);
    assert_eq!(count(&l, "collection_work_artworks"), 0);
    assert_eq!(count(&l, "collection_volumes"), 0);
    assert!(temp.path().join("keep.png").exists());
    assert_eq!(count(&l, "collections"), 0);
    l.apply_collection_changes(&changes(
        &s,
        3,
        json!([change(3, json!({"works":[work("w",4)]}))]),
    ))
    .unwrap();
    assert_eq!(count(&l, "collection_authority_trash"), 0);
    assert_eq!(count(&l, "collection_work_artworks"), 1);
    assert_eq!(count(&l, "collection_volumes"), 1);
}

#[test]
fn collection_authority_missing_assets_materialize_later_without_advancing_cursor() {
    let (_temp, l, s) = fixture();
    let mut w = work("w", 1);
    w["fields"]["coverAssetId"] = json!("later");
    adopt(
        &l,
        &s,
        json!({"works":[w],"memberships":[membership("later",1,true)]}),
    );
    assert_eq!(count(&l, "collection_assets"), 0);
    asset(&l, "later");
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    selections(&tx).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert_eq!(count(&l, "collection_assets"), 1);
    assert_eq!(
        local(&*l.connection().unwrap()).unwrap().unwrap().id.cursor,
        0
    );
}

fn enqueue(l: &Library, s: &CollectionAuthorityStatus, command: &str) -> String {
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    let id = enqueue_collection_command(&tx, s, command, "w", json!({"workId":"w"})).unwrap();
    tx.commit().unwrap();
    id
}
#[test]
fn collection_authority_outbox_fifo_receipts_conflicts_drops_and_backoff() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    // Later-batch commands keep the explicit blocked-head behavior; core writes
    // instead settle conflicts non-blockingly (covered below).
    let ids: Vec<_> = ["updateWork", "bindProvider", "addArtwork", "updateWork"]
        .iter()
        .map(|command| enqueue(&l, &s, command))
        .collect();
    let calls = RefCell::new(Vec::new());
    let retry = Cell::new(true);
    let send = |body: &Value| -> Result<CollectionDelivery, LibraryError> {
        let op = text(body, "operationId")?.to_owned();
        calls.borrow_mut().push(body.clone());
        Ok(if op == ids[0] {
            let mut receipt = envelope(&s);
            receipt["commandType"] = body["commandType"].clone();
            receipt["operationId"] = body["operationId"].clone();
            receipt["changed"] = json!(true);
            receipt["authorityCursor"] = json!(1);
            receipt["entities"] = json!({"works":[work("w",2)]});
            CollectionDelivery::Accepted(receipt)
        } else if op == ids[1] {
            CollectionDelivery::Conflict(
                json!({"code":"revisionConflict","current":{"works":[work("w",2)]}}),
            )
        } else if op == ids[2] {
            CollectionDelivery::Dropped(json!({"code":"workDeleted"}))
        } else if retry.get() {
            CollectionDelivery::Retry
        } else {
            let mut receipt = envelope(&s);
            receipt["commandType"] = body["commandType"].clone();
            receipt["operationId"] = body["operationId"].clone();
            receipt["changed"] = json!(false);
            receipt["authorityCursor"] = json!(1);
            receipt["entities"] = json!({});
            CollectionDelivery::Accepted(receipt)
        })
    };
    assert!(l.flush_collection_outbox_with(&s, &send, 100).unwrap());
    assert_eq!(calls.borrow().len(), 2);
    assert!(!l.flush_collection_outbox_with(&s, &send, 100).unwrap());
    assert_eq!(calls.borrow().len(), 2);
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row(
                "SELECT state FROM collection_authority_outbox WHERE operation_id=?1",
                [&ids[1]],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "blocked"
    );
    // Simulate an explicit conflict dismissal by a later batch's UI. Until that
    // decision, no dependent command is allowed to overtake the blocked head.
    l.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason='userDiscarded' WHERE operation_id=?1",[&ids[1]]).unwrap();
    assert!(!l.flush_collection_outbox_with(&s, &send, 100).unwrap());
    assert_eq!(calls.borrow().len(), 4);
    assert!(!l.flush_collection_outbox_with(&s, &send, 104).unwrap());
    assert_eq!(calls.borrow().len(), 4);
    retry.set(false);
    assert!(l.flush_collection_outbox_with(&s, &send, 105).unwrap());
    assert_eq!(calls.borrow()[3], calls.borrow()[4]);
    let db = l.connection().unwrap();
    let states: Vec<String> = db
        .prepare("SELECT state FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(states, ["accepted", "dropped", "dropped", "accepted"]);
    assert_eq!(
        db.query_row(
            "SELECT drop_reason FROM collection_authority_outbox WHERE operation_id=?1",
            [&ids[2]],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "workDeleted"
    );
    assert_eq!(local(&db).unwrap().unwrap().id.cursor, 0);
}

#[test]
fn collection_authority_rejects_mismatched_receipt_and_keeps_intent() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    enqueue(&l, &s, "updateWork");
    assert!(l
        .flush_collection_outbox_with(
            &s,
            &|_| Ok(CollectionDelivery::Accepted(json!({"libraryId":"wrong"}))),
            0
        )
        .is_err());
    assert_eq!(
        l.connection()
            .unwrap()
            .query_row("SELECT state FROM collection_authority_outbox", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "pending"
    );
}

#[test]
fn collection_authority_inactive_gate_does_no_transport_database_or_file_work() {
    let (_temp, l, s) = fixture();
    let mut inactive = s.clone();
    inactive.active = false;
    assert!(!ensure_collection_write_ready(&*l.connection().unwrap(), &inactive).unwrap());
    assert!(!l
        .flush_collection_outbox_with(&inactive, &|_| panic!("inactive delivery"), 0)
        .unwrap());
    assert_eq!(
        l.materialize_collection_artwork_with(
            &inactive,
            &|_, _, _, _, _, _| panic!("inactive download"),
            0,
            2
        )
        .unwrap(),
        0
    );
    let (client, requests) = CloudClient::home_test_client(vec![]);
    let aggregate = SyncStatus {
        protocol_version: 1,
        active: false,
        library_id: None,
        domains: vec![],
        publisher_logs: None,
    };
    let before = l.connection().unwrap().total_changes();
    assert_eq!(
        l.sync_collection_authority(&client, "token", None, &aggregate, false)
            .unwrap(),
        (false, false)
    );
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(l.connection().unwrap().total_changes(), before);
    assert_eq!(count(&l, "collection_authority_sync"), 0);
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &s),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
    let mut other = s.clone();
    other.library_id = Some("another".into());
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &other),
        Err(LibraryError::CollectionAuthorityMismatch)
    ));
}

#[test]
fn collection_authority_materialization_resumes_validates_hash_and_recovers_after_rename() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)],"artworks":[art()]}));
    let calls = Cell::new(0);
    let fail = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        calls.set(calls.get() + 1);
        std::fs::write(path, b"part").unwrap();
        Err(LibraryError::CloudRequestUnavailable)
    };
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &fail, 100, 2)
            .unwrap(),
        0
    );
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &fail, 104, 2)
            .unwrap(),
        0
    );
    assert_eq!(calls.get(), 1);
    let bad = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        std::fs::write(path, b"wrong").unwrap();
        Ok(())
    };
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &bad, 105, 2)
            .unwrap(),
        0
    );
    let good = |_: &str, _: &str, _: &str, _: u64, _: &str, path: &Path| {
        std::fs::write(path, b"image").unwrap();
        Ok(())
    };
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &good, 115, 2)
            .unwrap(),
        1
    );
    l.connection()
        .unwrap()
        .execute(
            "UPDATE collection_authority_materialization SET state='pending'",
            [],
        )
        .unwrap();
    assert_eq!(
        l.materialize_collection_artwork_with(
            &s,
            &|_, _, _, _, _, _| panic!("valid file already present"),
            200,
            2
        )
        .unwrap(),
        1
    );
    assert_eq!(
        l.materialize_collection_artwork_with(&s, &good, 201, 2)
            .unwrap(),
        0
    );
}

#[test]
fn collection_authority_trash_frees_names_and_restores_latest_children_and_local_state() {
    let (_temp, l, s) = fixture();
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"bindings":[binding()],"artworks":[art()],"volumes":[volume()]}),
    );
    l.connection().unwrap().execute_batch("UPDATE collections SET source_path='keep';INSERT INTO collection_activity VALUES('w','before',7);INSERT INTO collection_update_attempts VALUES('w','mangadex','later');").unwrap();
    let mut w = work("w", 2);
    w["lifecycle"] = json!("trashed");
    w["trashedAt"] = json!(NOW);
    l.apply_collection_changes(&changes(&s, 1, json!([change(1, json!({"works":[w]}))])))
        .unwrap();
    let mut x = work("x", 1);
    x["name"] = json!("Work w");
    let mut b = binding();
    b["externalId"] = json!("changed while trashed");
    b["entityRevision"] = json!(2);
    l.apply_collection_changes(&changes(
        &s,
        2,
        json!([change(2, json!({"works":[x],"bindings":[b]}))]),
    ))
    .unwrap();
    let mut restored = work("w", 3);
    restored["name"] = json!("Restored");
    l.apply_collection_changes(&changes(
        &s,
        3,
        json!([change(3, json!({"works":[restored]}))]),
    ))
    .unwrap();
    let db = l.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT source_path FROM collections WHERE id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "keep"
    );
    assert_eq!(
        db.query_row(
            "SELECT external_id FROM collection_external_bindings WHERE collection_id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "changed while trashed"
    );
    assert_eq!(
        db.query_row(
            "SELECT open_count FROM collection_activity WHERE collection_id='w'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
    assert_eq!(
        db.query_row(
            "SELECT retry_at FROM collection_update_attempts WHERE collection_id='w'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "later"
    );
}

#[test]
fn collection_authority_baseline_removes_stale_shared_rows_and_can_restart_at_lower_revisions() {
    let (_temp, l, s) = fixture();
    asset(&l, "a");
    adopt(
        &l,
        &s,
        json!({"works":[work("w",5)],"bindings":[binding()],"volumes":[volume()],"volumeSources":[source()],"ownership":[ownership()],"memberships":[membership("a",1,true)]}),
    );
    // A fresh epoch adopts lower entity revisions instead of reusing old lineage.
    let mut next = s.clone();
    next.epoch = Some(2);
    adopt(&l, &next, json!({"works":[work("w",1)]}));
    for table in [
        "collection_external_bindings",
        "collection_volumes",
        "collection_volume_sources",
        "collection_volume_ownership",
        "collection_assets",
    ] {
        assert_eq!(count(&l, table), 0, "{table}");
    }
    assert_eq!(count(&l, "assets"), 1);
    assert_eq!(count(&l, "collection_authority_revisions"), 1);
    assert!(ensure_collection_write_ready(&*l.connection().unwrap(), &next).unwrap());
    assert!(matches!(
        ensure_collection_write_ready(&*l.connection().unwrap(), &s),
        Err(LibraryError::CollectionAuthorityNotAdopted)
    ));
}

#[path = "collection_authority_writer_guard.rs"]
mod writer_guard;

#[test]
fn collection_authority_artwork_auto_import_is_content_idempotent_and_clear_is_null() {
    use crate::library::work_artwork::WorkArtworkKind;
    let (_temp, l, s) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let mut w = work(&id, 1);
    w["type"] = json!("game");
    adopt(&l, &s, json!({"works":[w]}));
    let source = l.root().join("collection-sources");
    let covers = source.join("game/covers");
    std::fs::create_dir_all(&covers).unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12, 18)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    std::fs::write(covers.join("first.png"), bytes.get_ref()).unwrap();
    l.set_collection_source_root(Some(source.to_str().unwrap()))
        .unwrap();
    l.connection()
        .unwrap()
        .execute(
            "UPDATE collections SET source_path='game' WHERE id=?1",
            [&id],
        )
        .unwrap();
    assert_eq!(l.import_local_collection_artworks(&id).unwrap(), 1);
    assert_eq!(count(&l, "collection_authority_outbox"), 2);
    std::fs::write(covers.join("same-content.png"), bytes.get_ref()).unwrap();
    l.collection_artwork_scan_cache.lock().unwrap().clear();
    assert_eq!(l.import_local_collection_artworks(&id).unwrap(), 0);
    assert_eq!(count(&l, "collection_work_artworks"), 1);
    assert_eq!(count(&l, "collection_authority_outbox"), 2);
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    Library::clear_work_artwork_kind_in_transaction(&tx, &id, WorkArtworkKind::Cover).unwrap();
    let raw: String = tx
        .query_row(
            "SELECT payload FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["commandType"], "selectArtwork");
    assert!(body["artworkId"].is_null());
    assert!(body["expectedArtworkId"].is_string());
    tx.commit().unwrap();
    drop(db);
    l.collection_artwork_scan_cache.lock().unwrap().clear();
    assert_eq!(l.import_local_collection_artworks(&id).unwrap(), 0);
    assert_eq!(count(&l, "collection_authority_outbox"), 3);
}

#[test]
fn collection_authority_volume_view_only_enqueues_shared_changes_and_keeps_filenames_local() {
    let (_temp, l, s) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    adopt(&l, &s, json!({"works":[work(&id,1)]}));
    let source = l.root().join("collection-sources");
    let covers = source.join("manga/covers");
    std::fs::create_dir_all(&covers).unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12, 18)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    std::fs::write(covers.join("vol_1_original.png"), bytes.get_ref()).unwrap();
    l.set_collection_source_root(Some(source.to_str().unwrap()))
        .unwrap();
    l.connection()
        .unwrap()
        .execute(
            "UPDATE collections SET source_path='manga' WHERE id=?1",
            [&id],
        )
        .unwrap();
    let first = l.list_collection_volumes(&id).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(count(&l, "collection_authority_outbox"), 2);
    assert_eq!(l.list_collection_volumes(&id).unwrap()[0].id, first[0].id);
    assert_eq!(count(&l, "collection_authority_outbox"), 2);
    let db = l.connection().unwrap();
    let payloads = db
        .prepare("SELECT payload FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(payloads
        .iter()
        .all(|p| !p.contains("vol_1_original.png") && !p.contains("relativePath")));
    let volume: Value = serde_json::from_str(&payloads[1]).unwrap();
    assert_eq!(volume["commandType"], "upsertVolume");
    assert_eq!(volume["expectedRevision"], 0);
    let file: String = db
        .query_row("SELECT source_file_name FROM collection_volumes", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(file, "vol_1_original.png");
}

#[test]
fn collection_authority_range_round_trip_and_active_fences() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    l.set_collection_volume_range("w", Some(2), Some(4), true)
        .unwrap();
    l.set_collection_volume_range("w", Some(2), Some(4), true)
        .unwrap();
    assert_eq!(count(&l, "collection_authority_outbox"), 1);
    let mut w = work("w", 2);
    w["derived"]["volumeRange"] = json!({"minVolume":3,"maxVolume":5,"hideConnectionPrompt":false});
    l.apply_collection_changes(&changes(&s, 1, json!([change(1, json!({"works":[w]}))])))
        .unwrap();
    let range =
        crate::library::collection_volume_range::load(&*l.connection().unwrap(), "w").unwrap();
    assert_eq!(range.min_volume, Some(3));
    assert_eq!(range.max_volume, Some(5));
    assert!(matches!(
        fence_collection_operation(&*l.connection().unwrap()),
        Err(LibraryError::CollectionAuthorityOperationUnavailable)
    ));
}

#[test]
fn collection_authority_source_changes_are_semantic_and_predict_pending_revisions() {
    let (_temp, l, s) = fixture();
    adopt(
        &l,
        &s,
        json!({"works":[work("w",1)],"volumeSources":[source()]}),
    );
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    let before = volume_source_state(&tx, "w", 1, "kakao").unwrap();
    tx.execute(
        "UPDATE collection_volume_sources SET provider_data_json=' { } ',updated_at='new'",
        [],
    )
    .unwrap();
    let unchanged = volume_source_state(&tx, "w", 1, "kakao").unwrap();
    enqueue_volume_source_changes(&tx, &s, &before, unchanged.clone()).unwrap();
    assert_eq!(
        tx.query_row(
            "SELECT COUNT(*) FROM collection_authority_outbox",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    tx.execute("UPDATE collection_volume_sources SET title='New title'", [])
        .unwrap();
    let changed = volume_source_state(&tx, "w", 1, "kakao").unwrap();
    enqueue_volume_source_changes(&tx, &s, &unchanged, changed.clone()).unwrap();
    tx.execute(
        "UPDATE collection_volume_sources SET publisher='New publisher'",
        [],
    )
    .unwrap();
    let changed_again = volume_source_state(&tx, "w", 1, "kakao").unwrap();
    enqueue_volume_source_changes(&tx, &s, &changed, changed_again).unwrap();
    let revisions=tx.prepare("SELECT json_extract(payload,'$.expectedRevision') FROM collection_authority_outbox ORDER BY seq").unwrap().query_map([],|r|r.get::<_,i64>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    assert_eq!(revisions, vec![1, 2]);
    tx.commit().unwrap();
}

#[test]
fn collection_authority_newer_artwork_selection_survives_an_earlier_receipt() {
    use crate::library::work_artwork::WorkArtworkKind;
    let (_temp, l, s) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let mut w = work(&id, 1);
    w["type"] = json!("game");
    adopt(&l, &s, json!({"works":[w]}));
    let mut ids = Vec::new();
    for width in [12, 13] {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, 18)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let prepared = l.prepare_work_artwork(&id, bytes.get_ref()).unwrap();
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        ids.push(
            Library::insert_work_artwork_in_transaction(
                &tx,
                &id,
                "local",
                "image",
                WorkArtworkKind::Cover,
                None,
                &prepared,
            )
            .unwrap(),
        );
        tx.commit().unwrap();
        prepared.commit();
    }
    let calls = Cell::new(0);
    l.flush_collection_outbox_with(
        &s,
        &|body| {
            calls.set(calls.get() + 1);
            if calls.get() > 1 {
                return Ok(CollectionDelivery::Retry);
            }
            let mut artwork = body.clone();
            artwork["createdAt"] = json!(NOW);
            artwork["entityRevision"] = json!(1);
            let mut receipt = envelope(&s);
            receipt["operationId"] = body["operationId"].clone();
            receipt["commandType"] = body["commandType"].clone();
            receipt["changed"] = json!(true);
            receipt["authorityCursor"] = json!(1);
            receipt["entities"] = json!({"artworks":[artwork]});
            Ok(CollectionDelivery::Accepted(receipt))
        },
        0,
    )
    .unwrap();
    assert_eq!(
        artwork_slot(&*l.connection().unwrap(), &id, "work").unwrap(),
        Some(ids[1].clone())
    );
}

#[test]
fn collection_authority_range_expectation_uses_confirmed_and_pending_state() {
    let (_temp, l, s) = fixture();
    adopt(&l, &s, json!({"works":[work("w",1)]}));
    // An older baseline has no range; retained inactive PC settings are local state.
    l.connection()
        .unwrap()
        .execute(
            "INSERT INTO collection_volume_ranges VALUES('w',1,9,1,'before')",
            [],
        )
        .unwrap();
    l.set_collection_volume_range("w", Some(2), Some(8), true)
        .unwrap();
    l.set_collection_volume_range("w", Some(3), Some(7), false)
        .unwrap();
    let db = l.connection().unwrap();
    let payloads = db
        .prepare("SELECT payload FROM collection_authority_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let first: Value = serde_json::from_str(&payloads[0]).unwrap();
    let second: Value = serde_json::from_str(&payloads[1]).unwrap();
    assert_eq!(
        first["expectedRange"],
        json!({"minVolume":null,"maxVolume":null,"hideConnectionPrompt":false})
    );
    assert_eq!(
        second["expectedRange"],
        json!({"minVolume":2,"maxVolume":8,"hideConnectionPrompt":true})
    );
}

// Batch 5: AV reading stays local/feed-owned while AV editing is fenced (1B §4).
struct NoNetwork;
impl super::super::av_link::provider::HttpClient for NoNetwork {
    fn get(
        &self,
        _: &str,
        _: Option<&str>,
        _: usize,
    ) -> Result<super::super::av_link::provider::HttpResponse, LibraryError> {
        panic!("a fenced AV operation contacted the network")
    }
    fn post_json(
        &self,
        _: &str,
        _: &str,
        _: &[u8],
        _: usize,
    ) -> Result<super::super::av_link::provider::HttpResponse, LibraryError> {
        panic!("a fenced AV operation contacted StashDB")
    }
}

fn seed_av(l: &Library) {
    l.connection().unwrap().execute_batch("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('av','AV Work','av','old','old');
        INSERT INTO collection_av_details(collection_id,product_code,title_ja,label,revision) VALUES('av','ABC-001','原題','Label',3);
        INSERT INTO collection_people(id,display_name,name_ja,memo,created_at,updated_at) VALUES('p','Display','表示','local memo','old','old');
        INSERT INTO collection_person_relations(collection_id,person_id,role,sort_order,credit_name) VALUES('av','p','performer',0,'Alias');
        INSERT INTO collection_work_artworks(id,collection_id,provider,provider_image_id,kind,relative_path,mime_type,width,height,selected,created_at,updated_at) VALUES('art','av','local','art','cover','local/av.png','image/png',10,20,1,'old','old');
        INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,updated_at) VALUES('p','commons',X'01','image/png',1,1,'p.png','https://commons.wikimedia.org/p','old');
        INSERT INTO collection_person_profiles(person_id,source,status,stashdb_id,name,fetched_at) VALUES('p','stashdb','matched','stash-p','Display','2000-01-01T00:00:00Z');
        INSERT INTO av_favorite_performers(person_id,created_at) VALUES('p','old');").unwrap();
}

fn av_local_state(l: &Library) -> Value {
    let db = l.connection().unwrap();
    db.query_row("SELECT json_array((SELECT memo FROM collection_people WHERE id='p'),(SELECT credit_name FROM collection_person_relations WHERE person_id='p'),(SELECT kind FROM collection_person_portraits WHERE person_id='p'),(SELECT status||':'||fetched_at FROM collection_person_profiles WHERE person_id='p'),(SELECT count(*) FROM av_favorite_performers),(SELECT label||':'||revision FROM collection_av_details WHERE collection_id='av'),(SELECT count(*) FROM collections WHERE type='av'))",[],|r|r.get::<_,String>(0)).map(|s| serde_json::from_str(&s).unwrap()).unwrap()
}

fn assert_fenced<T: std::fmt::Debug>(result: Result<T, super::super::av_models::AvError>) {
    assert!(
        matches!(
            result,
            Err(super::super::av_models::AvError::Library(
                LibraryError::CollectionAuthorityOperationUnavailable
            ))
        ),
        "{result:?}"
    );
}

#[test]
fn collection_authority_batch5_av_edits_are_fenced_and_automatic_profile_refresh_is_quiet() {
    use super::super::{
        av_link::models::ApplyRequest, av_models::*, av_portrait::AvPortraitState,
        av_stashdb::AvProfileState, home_data::HomeDataError,
    };
    let (_temp, l, s) = fixture();
    seed_av(&l);
    let before = av_local_state(&l);
    l.observe_collection_authority(&s).unwrap();
    let details: SaveAvDetails = serde_json::from_value(json!({"expectedRevision":3,"productCode":"NEW-1","label":null,"series":null,"people":[{"person":{"kind":"new","displayName":"New"},"role":"performer","creditName":null}]})).unwrap();
    assert_fenced(l.save_av_details("av", details));
    let artwork: ApplyAvArtwork = serde_json::from_value(json!({"expectedRevision":"any","front":{"kind":"clear"},"spine":{"kind":"keep"},"back":{"kind":"keep"}})).unwrap();
    assert_fenced(l.apply_av_artwork("av", artwork));
    let link: ApplyRequest = serde_json::from_value(json!({"collectionId":null,"newCollectionName":"New AV","expectedRevision":null,"split":{"x1":0,"x2":0},"surfaces":{"front":"keep","spine":"keep","back":"keep"},"fields":{},"performers":[],"directors":[]})).unwrap();
    assert_fenced(l.apply_av_link("inbox", link));
    assert_fenced(l.save_av_person_memo("p", Some("new memo".into())));
    let rect = AvPortraitRect {
        x: 0.0,
        y: 0.0,
        w: 0.5,
        h: 0.5,
    };
    assert_fenced(l.set_av_portrait_crop("p", "art", rect));
    assert_fenced(l.clear_av_portrait("p"));
    let portraits = AvPortraitState::default();
    assert_fenced(l.preview_av_commons_portrait_with("p", &portraits, &NoNetwork));
    assert_fenced(l.use_av_commons_portrait("p", &portraits));
    assert_fenced(l.preview_av_stashdb_portrait_with("p", "image", &portraits, &NoNetwork));
    assert_fenced(l.use_av_stashdb_portrait("p", &portraits));
    let profiles = AvProfileState::default();
    // Opening a performer page (force=false) keeps the stored stale profile quietly.
    let quiet = l
        .refresh_av_performer_profile_with("p", false, &profiles, &NoNetwork, Some("key"))
        .unwrap()
        .unwrap();
    assert_eq!(
        (quiet.status.as_str(), quiet.fetched_at.as_str()),
        ("matched", "2000-01-01T00:00:00Z")
    );
    assert_fenced(l.refresh_av_performer_profile_with(
        "p",
        true,
        &profiles,
        &NoNetwork,
        Some("key"),
    ));
    assert_fenced(l.search_av_performer_profile_with("p", &NoNetwork, Some("key")));
    assert_fenced(l.choose_av_performer_profile_with(
        "p",
        "stash-q",
        &profiles,
        &NoNetwork,
        Some("key"),
    ));
    assert_fenced(l.dismiss_av_performer_profile("p", &profiles));
    assert_fenced(l.clear_av_performer_profile("p", &profiles));
    for favorite in [true, false] {
        assert!(matches!(
            l.set_av_favorite("p", favorite),
            Err(HomeDataError::Library(
                LibraryError::CollectionAuthorityOperationUnavailable
            ))
        ));
    }
    assert_eq!(av_local_state(&l), before);
    assert_eq!(count(&l, "collection_authority_outbox"), 0);
    // Reads stay available.
    assert_eq!(l.get_av_details("av").unwrap().people.len(), 1);
    assert_eq!(
        l.get_av_performer("p").unwrap().person.memo.as_deref(),
        Some("local memo")
    );
}

#[test]
fn collection_authority_batch5_adoption_keeps_av_details_people_portraits_and_credit_names() {
    let (_temp, l, s) = fixture();
    seed_av(&l);
    let mut av = work("av", 1);
    av["type"] = json!("av");
    av["name"] = json!("AV Work");
    av["selection"]["work"] = json!("art");
    av["details"]["av"] = json!({"productCode":"ABC-001","titleJa":"原題","maker":"Maker","label":"Label","series":null,"genres":["g"],"releaseDate":"2026-01-02"});
    av["avCredits"] = json!([
        {"personId":"p","name":"Display","nameJa":"表示","role":"performer","order":0,"portraitCrop":null},
        {"personId":"d","name":"Director","nameJa":null,"role":"director","order":0,"portraitCrop":null}
    ]);
    let mut artwork = art();
    artwork["workId"] = json!("av");
    adopt(&l, &s, json!({"works":[av],"artworks":[artwork]}));
    let details = l.get_av_details("av").unwrap();
    assert_eq!(
        (
            details.revision,
            details.product_code.as_deref(),
            details.maker.as_deref(),
            details.genres.clone()
        ),
        (3, Some("ABC-001"), Some("Maker"), vec!["g".to_owned()])
    );
    let credits: Vec<_> = details
        .people
        .iter()
        .map(|p| {
            (
                p.id.as_str(),
                p.display_name.as_str(),
                p.credit_name.as_deref(),
            )
        })
        .collect();
    // The local per-work credit name survives; a new credit has none (not its display name).
    assert_eq!(
        credits,
        vec![("p", "Display", Some("Alias")), ("d", "Director", None)]
    );
    let page = l.get_av_performer("p").unwrap();
    assert_eq!(page.person.memo.as_deref(), Some("local memo"));
    assert!(matches!(
        page.person.portrait,
        Some(super::super::av_models::AvPortrait::Commons { .. })
    ));
    assert_eq!(page.works.len(), 1);
    assert_eq!(
        l.get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("stash-p")
    );
    assert_eq!(l.list_av_favorites().unwrap().len(), 1);
    // Adopted: editing stays fenced and nothing is queued.
    assert_fenced(l.save_av_person_memo("p", None));
    assert_eq!(count(&l, "collection_authority_outbox"), 0);
}

#[test]
fn collection_authority_similarity_replacement_moves_membership_and_cover_through_commands() {
    use super::super::models::{SimilarityDecision, SimilarityDecisionRequest};
    let (_temp, l, s) = fixture();
    let mut game = work("g", 3);
    game["type"] = json!("game");
    game["fields"]["status"] = Value::Null;
    adopt(&l, &s, json!({"works":[game]}));
    asset(&l, "old");
    l.connection()
        .unwrap()
        .execute_batch(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                 VALUES('new','new','image','new','new','thumb-new',1,10,20,'now','review');
             INSERT INTO collection_assets(collection_id,asset_id,added_at) VALUES('g','old','now');
             UPDATE collections SET cover_asset_id='old' WHERE id='g';
             INSERT INTO similarity_reviews
                 (id,existing_asset_id,candidate_asset_id,distance,fingerprint_kind,status,created_at)
             VALUES ('review','old','new',1,'pdq-v1','open','2026-10-06T00:00:00Z');",
        )
        .unwrap();
    l.decide_similarity_review(SimilarityDecisionRequest {
        review_id: "review".into(),
        decision: SimilarityDecision::ReplaceExisting,
    })
    .unwrap();
    let bodies = core_bodies(&l);
    let membership = bodies
        .iter()
        .find(|b| b["commandType"] == "setMembership")
        .expect("membership command");
    assert_eq!(membership["assetId"], "new");
    assert_eq!(membership["desiredState"], true);
    let cover = bodies
        .iter()
        .find(|b| b["commandType"] == "updateWork")
        .expect("cover command");
    assert_eq!(cover["changes"], json!({"coverAssetId":"new"}));
    assert_eq!(cover["expected"], json!({"coverAssetId":"old"}));
    assert_eq!(
        l.get_collection("g").unwrap().cover_asset_id.as_deref(),
        Some("new")
    );
}

#[test]
fn collection_authority_startup_normalizers_leave_server_owned_fields_alone() {
    let (_temp, l, s) = fixture();
    let mut game = work("g", 3);
    game["type"] = json!("game");
    game["fields"]["status"] = Value::Null;
    game["showcase"] = json!(true);
    game["showcaseOrder"] = json!(7);
    adopt(&l, &s, json!({"works":[game]}));
    l.normalize_showcase_orders().unwrap();
    assert_eq!(l.backfill_legacy_collection_kinds().unwrap(), 0);
    assert_eq!(l.get_collection("g").unwrap().showcase_order, Some(7));
    assert!(core_bodies(&l).is_empty());
}
