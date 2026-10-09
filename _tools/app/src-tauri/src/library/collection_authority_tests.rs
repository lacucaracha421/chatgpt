use super::*;
use std::cell::{Cell, RefCell};

fn av_details_fixture() -> (tempfile::TempDir, Library, CollectionAuthorityStatus, Value) {
    let (temp, library, status) = fixture();
    seed_av(&library);
    let mut server = work("av", 1);
    server["type"] = json!("av");
    server["name"] = json!("AV Work");
    server["fields"]["status"] = Value::Null;
    server["details"]["av"] = json!({"productCode":"ABC-001","titleJa":"原題","maker":"Maker","label":"Label","series":null,"genres":["g"],"releaseDate":"2026-01-02"});
    server["avCredits"] = json!([{"personId":"p","name":"ignored credit display","nameJa":null,"role":"performer","order":0,"creditName":"Alias","portraitCrop":null}]);
    server["avPeople"] = json!([{"personId":"p","displayName":"Display","nameJa":"表示","memo":"remote memo","profile":null,"portrait":null}]);
    adopt(&library, &status, json!({"works":[server.clone()]}));
    (temp, library, status, server)
}

fn av_draft(library: &Library) -> super::super::av_models::SaveAvDetails {
    use super::super::av_models::*;
    let details = library.get_av_details("av").unwrap();
    SaveAvDetails {
        expected_revision: details.revision,
        product_code: details.product_code,
        label: details.label,
        series: details.series,
        people: details
            .people
            .into_iter()
            .map(|p| AvPersonInput {
                person: AvPersonChoice::Existing { id: p.id },
                role: p.role,
                credit_name: p.credit_name,
            })
            .collect(),
    }
}

#[test]
fn collection_authority_av_details_queue_projection_receipts_and_reopen() {
    use super::super::av_models::*;
    let (temp, library, status, server) = av_details_fixture();
    let mut draft = av_draft(&library);
    draft.product_code = Some(" NEW-1 ".into());
    draft.people.push(AvPersonInput {
        person: AvPersonChoice::New {
            display_name: "New person".into(),
        },
        role: AvPersonRole::Director,
        credit_name: Some("Credit one".into()),
    });
    let saved = library.save_av_details("av", draft).unwrap();
    let added = saved
        .people
        .iter()
        .find(|p| p.role == AvPersonRole::Director)
        .unwrap()
        .id
        .clone();
    assert_eq!(saved.product_code.as_deref(), Some("NEW-1"));
    let mut draft = av_draft(&library);
    draft.label = Some("New label".into());
    draft
        .people
        .iter_mut()
        .find(|p| p.role == AvPersonRole::Director)
        .unwrap()
        .credit_name = Some("Credit two".into());
    library.save_av_details("av", draft).unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands.len(), 4);
    assert_eq!(commands[0]["commandType"], "setAvDetails");
    assert_eq!(commands[0]["changes"], json!({"productCode":"NEW-1"}));
    assert_eq!(commands[0]["expected"], json!({"productCode":"ABC-001"}));
    assert_eq!(commands[1]["commandType"], "setAvCredits");
    assert_eq!(commands[1]["expectedRevision"], 2);
    assert_eq!(
        commands[1]["people"],
        json!([{"personId":added,"displayName":"New person","nameJa":null}])
    );
    assert_eq!(commands[3]["expectedRevision"], 4);
    assert_eq!(commands[3]["people"], json!([]));
    library.save_av_details("av", av_draft(&library)).unwrap();
    assert_eq!(provider_commands(&library).len(), 4);
    drop(library);
    let library = Library::open(temp.path()).unwrap();
    assert_eq!(
        library.get_av_details("av").unwrap().label.as_deref(),
        Some("New label")
    );
    let server = RefCell::new(server);
    let sent = Cell::new(0);
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                let local = library.get_av_details("av").unwrap();
                assert_eq!(local.label.as_deref(), Some("New label"));
                assert_eq!(
                    local
                        .people
                        .iter()
                        .find(|p| p.id == added)
                        .unwrap()
                        .credit_name
                        .as_deref(),
                    Some("Credit two")
                );
                let mut server = server.borrow_mut();
                match body["commandType"].as_str().unwrap() {
                    "setAvDetails" => {
                        for (field, value) in body["changes"].as_object().unwrap() {
                            assert_eq!(body["expected"][field], server["details"]["av"][field]);
                            server["details"]["av"][field] = value.clone();
                        }
                    }
                    "setAvCredits" => {
                        assert_eq!(body["expectedRevision"], server["entityRevision"]);
                        for person in body["people"].as_array().unwrap() {
                            server["avPeople"]
                                .as_array_mut()
                                .unwrap()
                                .push(person.clone());
                        }
                        server["avCredits"] = body["credits"].clone();
                    }
                    other => panic!("unexpected {other}"),
                }
                server["entityRevision"] = json!(server["entityRevision"].as_i64().unwrap() + 1);
                sent.set(sent.get() + 1);
                let mut receipt = envelope(&status);
                receipt["operationId"] = body["operationId"].clone();
                receipt["commandType"] = body["commandType"].clone();
                receipt["changed"] = json!(true);
                receipt["authorityCursor"] = json!(sent.get());
                receipt["entities"] = json!({"works":[server.clone()]});
                Ok(CollectionDelivery::Accepted(receipt))
            },
            0,
        )
        .unwrap();
    assert_eq!(sent.get(), 4);
    let db = library.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM collection_authority_outbox WHERE state='accepted'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
    assert_eq!(local(&db).unwrap().unwrap().id.cursor, 0);
    drop(db);
    let details = library.get_av_details("av").unwrap();
    assert_eq!(details.title_ja.as_deref(), Some("原題"));
    assert_eq!(details.maker.as_deref(), Some("Maker"));
    assert_eq!(details.genres, vec!["g"]);
    assert_eq!(details.people[0].display_name, "Display");
    assert_eq!(
        library
            .get_av_performer("p")
            .unwrap()
            .person
            .memo
            .as_deref(),
        Some("local memo")
    );
    assert_eq!(library.list_av_favorites().unwrap().len(), 1);
    assert!(library
        .get_av_performer("p")
        .unwrap()
        .person
        .portrait
        .is_some());
    assert_eq!(
        library
            .get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("stash-p")
    );
}

#[test]
fn collection_authority_av_details_fifo_expected_values_and_revision_noops() {
    let (_temp, library, status, _) = av_details_fixture();
    for code in ["First", "Second"] {
        let mut draft = av_draft(&library);
        draft.product_code = Some(code.into());
        library.save_av_details("av", draft).unwrap();
    }
    let mut draft = av_draft(&library);
    draft.people[0].credit_name = Some("Changed".into());
    library.save_av_details("av", draft).unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands[1]["expected"], json!({"productCode":"First"}));
    assert_eq!(commands[2]["expectedRevision"], 3);
    assert_eq!(
        predicted_collection_revision(
            &library.connection().unwrap(),
            "works",
            &json!(["av"]).to_string()
        )
        .unwrap(),
        4
    );
    assert_eq!(
        command_credential(&commands[0], "client", Some("publisher")).unwrap(),
        "client"
    );
    assert_eq!(status.contract_version, Some(1));
}

#[test]
fn collection_authority_av_details_revision_counts_pending_artwork_and_normalized_noops() {
    let (_temp, library, status, mut server) = av_details_fixture();
    server["details"]["av"]["label"] = json!(" Label ");
    server["entityRevision"] = json!(2);
    library
        .apply_collection_changes(&changes(
            &status,
            1,
            json!([change(1, json!({"works":[server]}))]),
        ))
        .unwrap();
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    enqueue_collection_command(
        &tx,
        &status,
        "setAvDetails",
        "av",
        json!({"workId":"av","changes":{"label":"Label"},"expected":{"label":" Label "}}),
    )
    .unwrap();
    enqueue_collection_command(
        &tx,
        &status,
        "selectArtwork",
        "av",
        json!({"workId":"av","slot":"back","artworkId":"back","expectedArtworkId":null}),
    )
    .unwrap();
    assert_eq!(
        predicted_collection_revision(&tx, "works", &json!(["av"]).to_string()).unwrap(),
        3
    );
    tx.commit().unwrap();
    drop(db);
    let mut draft = av_draft(&library);
    draft.people[0].credit_name = Some("Changed".into());
    library.save_av_details("av", draft).unwrap();
    assert_eq!(
        provider_commands(&library).last().unwrap()["expectedRevision"],
        3
    );
}

#[test]
fn collection_authority_av_details_reusing_unlinked_confirmed_person_queues_no_people() {
    use super::super::av_models::*;
    let (_temp, library, status, mut server) = av_details_fixture();
    let mut draft = av_draft(&library);
    draft.people.clear();
    library.save_av_details("av", draft).unwrap();
    server["avCredits"] = json!([]);
    server["avPeople"] = json!([]);
    server["entityRevision"] = json!(2);
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                let mut receipt = envelope(&status);
                receipt["operationId"] = body["operationId"].clone();
                receipt["commandType"] = body["commandType"].clone();
                receipt["changed"] = json!(true);
                receipt["authorityCursor"] = json!(1);
                receipt["entities"] = json!({"works":[server]});
                Ok(CollectionDelivery::Accepted(receipt))
            },
            0,
        )
        .unwrap();
    let mut draft = av_draft(&library);
    draft.people.push(AvPersonInput {
        person: AvPersonChoice::Existing { id: "p".into() },
        role: AvPersonRole::Director,
        credit_name: Some("Director credit".into()),
    });
    library.save_av_details("av", draft).unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands.last().unwrap()["people"], json!([]));
    assert_eq!(commands.last().unwrap()["expectedRevision"], 2);
}

#[test]
fn collection_authority_av_details_credit_revision_conflict_reaches_queue_health() {
    let (_temp, library, status, server) = av_details_fixture();
    let mut draft = av_draft(&library);
    draft.people[0].credit_name = Some("Local credit".into());
    library.save_av_details("av", draft).unwrap();
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                assert_eq!(body["commandType"], "setAvCredits");
                Ok(CollectionDelivery::Conflict(
                    json!({"code":"revisionConflict","current":{"work":server}}),
                ))
            },
            0,
        )
        .unwrap();
    assert_eq!(
        library
            .authority_sync_health()
            .unwrap()
            .collections
            .blocked_count,
        1
    );
    assert_eq!(provider_commands(&library).len(), 1);
}

#[test]
fn collection_authority_av_details_accepts_maximum_credit_count() {
    use super::super::av_models::*;
    let (_temp, library, _, _) = av_details_fixture();
    let mut draft = av_draft(&library);
    draft.people = (0..av_limit("credits"))
        .map(|index| AvPersonInput {
            person: AvPersonChoice::New {
                display_name: format!("Person {index}"),
            },
            role: AvPersonRole::Performer,
            credit_name: None,
        })
        .collect();
    assert_eq!(
        library.save_av_details("av", draft).unwrap().people.len(),
        64
    );
    let commands = provider_commands(&library);
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0]["credits"].as_array().unwrap().len(), 64);
    assert_eq!(commands[0]["people"].as_array().unwrap().len(), 64);
    assert_eq!(commands[0]["expectedRevision"], 1);
}

#[test]
fn collection_authority_av_details_conflict_surfaces_without_mutating_confirmed_state() {
    let (_temp, library, status, mut server) = av_details_fixture();
    let mut draft = av_draft(&library);
    draft.label = Some("Local label".into());
    library.save_av_details("av", draft).unwrap();
    server["details"]["av"]["label"] = json!("Remote label");
    server["entityRevision"] = json!(2);
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                assert_eq!(body["expected"]["label"], "Label");
                Ok(CollectionDelivery::Conflict(
                    json!({"code":"revisionConflict","current":{"work":server}}),
                ))
            },
            0,
        )
        .unwrap();
    let db = library.connection().unwrap();
    let (state, code, detail): (String, String, String) = db
        .query_row(
            "SELECT state,conflict_code,conflict_detail FROM collection_authority_outbox",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (state.as_str(), code.as_str()),
        ("blocked", "revisionConflict")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&detail).unwrap()["current"]["work"]["details"]["av"]
            ["label"],
        "Remote label"
    );
    assert_eq!(db.query_row("SELECT entity_revision FROM collection_authority_revisions WHERE section='works' AND work_id='av'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn collection_authority_av_details_atomic_rollback_and_server_limits() {
    use super::super::av_models::*;
    let (_temp, library, _, _) = av_details_fixture();
    let before = editable_av(&library.connection().unwrap(), "av").unwrap();
    let revision = library.get_av_details("av").unwrap().revision;
    library.connection().unwrap().execute_batch("CREATE TRIGGER reject_av_credits BEFORE INSERT ON collection_authority_outbox WHEN NEW.command_type='setAvCredits' BEGIN SELECT RAISE(ABORT,'credits failure'); END;").unwrap();
    let mut draft = av_draft(&library);
    draft.product_code = Some("Queued first".into());
    draft.people.push(AvPersonInput {
        person: AvPersonChoice::New {
            display_name: "Rolled back".into(),
        },
        role: AvPersonRole::Director,
        credit_name: None,
    });
    assert!(library.save_av_details("av", draft).is_err());
    assert_eq!(
        editable_av(&library.connection().unwrap(), "av").unwrap(),
        before
    );
    assert_eq!(library.get_av_details("av").unwrap().revision, revision);
    assert!(library.search_av_people("Rolled back").unwrap().is_empty());
    assert!(provider_commands(&library).is_empty());
    library
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_av_credits")
        .unwrap();
    for key in ["productCode", "titleJa", "maker", "label", "series"] {
        let mut changes = json!({});
        changes[key] = json!("字".repeat(av_limit(key)));
        validate_av_changes(&changes).unwrap();
        changes[key] = json!("字".repeat(av_limit(key) + 1));
        assert!(validate_av_changes(&changes).is_err());
    }
    validate_av_changes(&json!({"genres":vec!["字".repeat(100);64],"releaseDate":"2024-02-29"}))
        .unwrap();
    for value in [
        json!({"genres":vec!["g";65]}),
        json!({"genres":["字".repeat(101)]}),
        json!({"genres":null}),
        json!({"releaseDate":"2026-02-30"}),
        json!({"releaseDate":"2026-1-01"}),
    ] {
        assert!(validate_av_changes(&value).is_err());
    }
    for key in ["code", "label", "series", "name", "credit", "people"] {
        let mut draft = av_draft(&library);
        match key {
            "code" => draft.product_code = Some("x".repeat(65)),
            "label" => draft.label = Some("x".repeat(501)),
            "series" => draft.series = Some("x".repeat(501)),
            "name" => draft.people.push(AvPersonInput {
                person: AvPersonChoice::New {
                    display_name: "x".repeat(501),
                },
                role: AvPersonRole::Director,
                credit_name: None,
            }),
            "credit" => draft.people[0].credit_name = Some("x".repeat(501)),
            "people" => draft.people = vec![draft.people[0].clone(); 65],
            _ => unreachable!(),
        }
        assert!(library.save_av_details("av", draft).is_err(), "{key}");
        assert!(provider_commands(&library).is_empty());
    }
    let mut draft = av_draft(&library);
    draft.product_code = Some("x".repeat(64));
    draft.label = Some("x".repeat(500));
    draft.series = Some("x".repeat(500));
    draft.people.push(AvPersonInput {
        person: AvPersonChoice::New {
            display_name: "字".repeat(500),
        },
        role: AvPersonRole::Director,
        credit_name: Some("字".repeat(500)),
    });
    library.save_av_details("av", draft).unwrap();
}

#[test]
fn collection_authority_av_details_oversize_body_and_stale_remote_edit_are_rejected() {
    use super::super::av_models::*;
    let (_temp, library, status, mut server) = av_details_fixture();
    let old = av_draft(&library);
    let mut oversized = av_draft(&library);
    oversized.people = (0..64)
        .map(|_| AvPersonInput {
            person: AvPersonChoice::New {
                display_name: "字".repeat(500),
            },
            role: AvPersonRole::Performer,
            credit_name: Some("字".repeat(500)),
        })
        .collect();
    assert!(library.save_av_details("av", oversized).is_err());
    assert!(provider_commands(&library).is_empty());
    assert_eq!(library.get_av_details("av").unwrap().people.len(), 1);
    server["details"]["av"]["maker"] = json!("Remote maker");
    server["entityRevision"] = json!(2);
    let mut feed = envelope(&status);
    feed["items"] = json!([{"sequence":1,"authorityCursor":1,"entities":{"works":[server]}}]);
    feed["cursor"] = json!(1);
    feed["nextAfter"] = json!(1);
    feed["hasMore"] = json!(false);
    library.apply_collection_changes(&feed).unwrap();
    assert!(matches!(
        library.save_av_details("av", old),
        Err(AvError::Stale)
    ));
    assert!(provider_commands(&library).is_empty());
}

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

#[test]
fn kakao_review_dismissal_queues_authority_config_and_projects_fifo_undo() {
    let (_temp, library, mut status) = fixture();
    status.features = vec!["kakaoReview".into()];
    let mut kakao = binding();
    kakao["provider"] = json!("kakao");
    kakao["config"] = json!({"version":1,"query":"던전밥","groupFingerprint":"f","knownItemIds":["one","three"]});
    kakao["snapshot"] = json!({"volumes":[{"volumeNumber":1},{"volumeNumber":3}]});
    adopt(&library, &status, json!({"works":[work("w",1)],"bindings":[kakao]}));
    store_profile_features_status(&library.connection().unwrap(), &status).unwrap();
    library.set_kakao_partial_dismissed("w", true).unwrap();
    assert!(library.list_kakao_reviews().unwrap()[0].partial_dismissed);
    let items = [("one", 1), ("three", 3)].into_iter().map(|(id, volume)| super::super::aladin::AladinItem {
        item_id:id.into(), title:format!("던전밥 {volume}"), author:None, publisher:Some("출판".into()), isbn13:None,
        publication_date:None, item_url:None, volume_number:volume, base_title:"던전밥".into(), snapshot_json:"{}".into(),
    }).collect();
    library.book_flow().refresh_aladin_items_at("w",items,NOW).unwrap();
    assert!(library.list_kakao_reviews().unwrap()[0].partial_dismissed);
    library.set_kakao_partial_dismissed("w", false).unwrap();
    assert!(!library.list_kakao_reviews().unwrap()[0].partial_dismissed);
    let commands = provider_commands(&library);
    let binds: Vec<_> = commands.iter().filter(|c| c["commandType"] == "setKakaoPartialDismissed").collect();
    assert_eq!(binds.len(), 2);
    assert_eq!(binds[0]["expectedVolumes"], json!([1,3]));
    assert_eq!(binds[0]["dismissed"], true);
    assert_eq!(binds[1]["dismissed"], false);
}

fn kakao_review_fixture(supported: bool) -> (tempfile::TempDir, Library, CollectionAuthorityStatus) {
    let (temp, library, mut status) = fixture();
    if supported { status.features.push("kakaoReview".into()); }
    let mut kakao = binding();
    kakao["provider"] = json!("kakao");
    kakao["config"] = json!({"query":"던전밥","groupFingerprint":"f"});
    kakao["snapshot"] = json!({"volumes":[{"volumeNumber":1},{"volumeNumber":3}]});
    adopt(&library, &status, json!({"works":[work("w",1)],"bindings":[kakao]}));
    store_profile_features_status(&library.connection().unwrap(), &status).unwrap();
    (temp, library, status)
}

#[test]
fn kakao_review_bind_behind_dismiss_predicts_binding_revision() {
    let (_temp, library, status) = kakao_review_fixture(true);
    library.set_kakao_partial_dismissed("w", true).unwrap();
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    let input = super::super::models::ExternalBindingInput {
        provider:"kakao".into(), external_id:"provider-work".into(),
        provider_config_json:Some(json!({"query":"던전밥","groupFingerprint":"new"}).to_string()),
        provider_data_json:None, last_synced_at:None,
    };
    enqueue_provider_snapshot(&tx, &status, "w", &input).unwrap();
    let raw: String = tx.query_row("SELECT payload FROM collection_authority_outbox WHERE command_type='bindProvider'", [], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["expectedRevision"], 2);
}

#[test]
fn kakao_review_older_server_cannot_queue_or_receive_dismissal() {
    let (_temp, library, mut status) = kakao_review_fixture(false);
    assert!(!library.list_kakao_reviews().unwrap()[0].dismissal_supported);
    assert!(matches!(library.set_kakao_partial_dismissed("w", true), Err(LibraryError::CollectionAuthorityOperationUnavailable)));
    assert!(provider_commands(&library).is_empty());
    status.features.push("kakaoReview".into());
    store_profile_features_status(&library.connection().unwrap(), &status).unwrap();
    library.set_kakao_partial_dismissed("w", true).unwrap();
    status.features.clear();
    library.flush_collection_outbox_with(&status, &|_| panic!("old server must not receive the command"), 0).unwrap();
    let db = library.connection().unwrap();
    let state: String = db.query_row("SELECT state FROM collection_authority_outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(state, "dropped");
}

#[test]
fn kakao_review_conflicts_resolve_outbox_head() {
    for code in ["kakaoNotBound", "workTrashed", "revisionConflict", "unsupportedCollectionCommand"] {
        let (_temp, library, status) = kakao_review_fixture(true);
        library.set_kakao_partial_dismissed("w", true).unwrap();
        library.flush_collection_outbox_with(&status, &|_| Ok(CollectionDelivery::Conflict(json!({"code":code}))), 0).unwrap();
        let db = library.connection().unwrap();
        let state: String = db.query_row("SELECT state FROM collection_authority_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "dropped", "{code}");
        db.execute("UPDATE collection_authority_outbox SET state='blocked',conflict_code=?1", [code]).unwrap();
        drop(db);
        assert!(library.flush_collection_outbox_with(&status, &|_| panic!("a legacy blocked review must be resolved without transport"), 0).unwrap());
        let state: String = library.connection().unwrap().query_row("SELECT state FROM collection_authority_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "dropped");
    }
}

#[test]
fn kakao_review_undo_after_pending_unbind_does_not_panic() {
    let (_temp, library, status) = kakao_review_fixture(true);
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    enqueue_collection_command(&tx, &status, "unbindProvider", &json!(["w","kakao"]).to_string(),
        json!({"workId":"w","provider":"kakao","expectedRevision":1})).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert!(matches!(library.set_kakao_partial_dismissed("w", false), Err(LibraryError::InvalidExternalBinding)));
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
    for (kind, provider, external) in [
        ("manga", "kakao", "book-1"),
        ("movie", "tmdb", "42"),
        ("game", "igdb", "42"),
    ] {
        let (_temp, l, s) = fixture();
        let mut initial = work("w", 1);
        initial["type"] = json!(kind);
        adopt(&l, &s, json!({"works":[initial]}));
        let input = super::super::models::ExternalBindingInput {
            provider: provider.into(),
            external_id: external.into(),
            provider_config_json: Some("{}".into()),
            provider_data_json: Some(
                json!({"id":42,"title":"old","film":{"cast":[],"releases":[],"related":null}})
                    .to_string(),
            ),
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
            assert_eq!(body["details"].is_object(), provider == "tmdb");
            if provider == "tmdb" {
                assert!(body["details"]["film"].is_object());
            }
            Ok(CollectionDelivery::Conflict(
                json!({"code":"providerSnapshotStale","current":{"binding":null}}),
            ))
        };
        let refresh = |_body: &Value| {
            refetches.set(refetches.get() + 1);
            let mut input = input.clone();
            let mut snapshot: Value =
                serde_json::from_str(input.provider_data_json.as_deref().unwrap()).unwrap();
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
        features: vec![],
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
    l.connection().unwrap().execute("UPDATE collection_person_portraits SET image_bytes=?1 WHERE person_id='p'", [provider_png()]).unwrap();
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

fn av_artwork_fixture() -> (
    tempfile::TempDir,
    Library,
    CollectionAuthorityStatus,
    String,
    Value,
    String,
) {
    let (temp, library, status) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let mut value = work(&id, 1);
    value["type"] = json!("av");
    value["selection"]["back"] = Value::Null;
    adopt(&library, &status, json!({"works":[value.clone()]}));
    let path = temp.path().join("jacket.png");
    std::fs::write(&path, provider_png()).unwrap();
    (
        temp,
        library,
        status,
        id,
        value,
        path.to_str().unwrap().into(),
    )
}

fn av_artwork_choice(library: &Library, path: &str) -> super::super::av_models::ArtworkDecision {
    use super::super::av_models::{ArtworkDecision, CoverSurface};
    let preview = library
        .preview_av_artwork(path, CoverSurface::Front)
        .unwrap();
    ArtworkDecision::Local {
        path: path.into(),
        sha256: preview.sha256,
    }
}

fn av_artwork_request(
    library: &Library,
    id: &str,
    front: super::super::av_models::ArtworkDecision,
    spine: super::super::av_models::ArtworkDecision,
    back: super::super::av_models::ArtworkDecision,
) -> super::super::av_models::ApplyAvArtwork {
    super::super::av_models::ApplyAvArtwork {
        expected_revision: library.get_av_cover_set(id).unwrap().revision,
        front,
        spine,
        back,
    }
}

#[test]
fn collection_authority_av_artwork_slots_are_immediate_idempotent_and_survive_receipts() {
    use super::super::av_models::ArtworkDecision::{Clear, Keep};
    let (_temp, library, status, id, server, path) = av_artwork_fixture();
    let choice = av_artwork_choice(&library, &path);
    let saved = library
        .apply_av_artwork(
            &id,
            av_artwork_request(
                &library,
                &id,
                choice.clone(),
                choice.clone(),
                choice.clone(),
            ),
        )
        .unwrap();
    let ids = [
        saved.front_id.clone().unwrap(),
        saved.spine_id.clone().unwrap(),
        saved.back_id.clone().unwrap(),
    ];
    assert_ne!(ids[0], ids[1]);
    assert_ne!(ids[0], ids[2]);
    assert_ne!(ids[1], ids[2]);
    let commands = core_bodies(&library);
    assert_eq!(commands.len(), 6);
    let mut paths = Vec::new();
    for (index, (kind, slot)) in [("cover", "work"), ("spine", "spine"), ("back", "back")]
        .iter()
        .enumerate()
    {
        let add = &commands[index * 2];
        let select = &commands[index * 2 + 1];
        assert_eq!(add["commandType"], "addArtwork");
        assert_eq!(add["provider"], "local-manual");
        assert_eq!(add["kind"], *kind);
        assert_eq!(add["artworkId"], ids[index]);
        assert_eq!(
            add["providerImageId"],
            format!(
                "sha256:{kind}:{}",
                add["original"]["sha256"].as_str().unwrap()
            )
        );
        assert_eq!(select["commandType"], "selectArtwork");
        assert_eq!(select["slot"], *slot);
        assert_eq!(select["artworkId"], ids[index]);
        assert!(select["expectedArtworkId"].is_null());
        assert_eq!(
            artwork_slot(&*library.connection().unwrap(), &id, slot).unwrap(),
            Some(ids[index].clone())
        );
        let relative: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT relative_path FROM collection_work_artworks WHERE id=?1",
                [&ids[index]],
                |row| row.get(0),
            )
            .unwrap();
        assert!(relative.starts_with(&format!("work-artwork/{id}/")));
        assert_eq!(
            std::fs::read(library.root().join(&relative)).unwrap(),
            std::fs::read(&path).unwrap()
        );
        assert!(library.resolve_work_artwork_thumbnail(&ids[index]).is_ok());
        paths.push(relative);
    }
    assert_eq!(library.connection().unwrap().query_row(
        "SELECT entity_revision FROM collection_authority_revisions WHERE section='works' AND work_id=?1",
        [&id], |row| row.get::<_, i64>(0),
    ).unwrap(), 1);
    library
        .apply_av_artwork(
            &id,
            av_artwork_request(
                &library,
                &id,
                choice.clone(),
                choice.clone(),
                choice.clone(),
            ),
        )
        .unwrap();
    assert_eq!(core_bodies(&library), commands);
    assert_eq!(count(&library, "collection_work_artworks"), 3);
    assert_eq!(
        std::fs::read_dir(library.root().join("work-artwork").join(&id))
            .unwrap()
            .count(),
        3
    );

    let server = RefCell::new(server);
    let delivered = Cell::new(0);
    let deliver = |body: &Value| {
        // Even earlier add/selection receipts must preserve all queued surfaces.
        for (index, slot) in ["work", "spine", "back"].iter().enumerate() {
            assert_eq!(
                artwork_slot(&*library.connection().unwrap(), &id, slot).unwrap(),
                if delivered.get() < 6 {
                    Some(ids[index].clone())
                } else if index == 0 {
                    Some(ids[0].clone())
                } else {
                    None
                }
            );
        }
        let mut entities = json!({});
        match body["commandType"].as_str().unwrap() {
            "addArtwork" => {
                library.upload_collection_command_artwork_with(
                    body,
                    &|blob, bytes| {
                        assert_eq!(bytes, std::fs::read(&path).unwrap());
                        assert_eq!(blob.size_bytes, bytes.len() as u64);
                        Ok(())
                    },
                    &|_| Ok(true),
                )?;
                let mut artwork = body.clone();
                artwork["createdAt"] = json!(NOW);
                artwork["entityRevision"] = json!(1);
                entities["artworks"] = json!([artwork]);
            }
            "selectArtwork" => {
                let mut work = server.borrow_mut();
                let slot = body["slot"].as_str().unwrap();
                assert_eq!(body["expectedArtworkId"], work["selection"][slot]);
                work["selection"][slot] = body["artworkId"].clone();
                work["entityRevision"] = json!(work["entityRevision"].as_i64().unwrap() + 1);
                entities["works"] = json!([work.clone()]);
            }
            other => panic!("unexpected command: {other}"),
        }
        delivered.set(delivered.get() + 1);
        let mut receipt = envelope(&status);
        receipt["operationId"] = body["operationId"].clone();
        receipt["commandType"] = body["commandType"].clone();
        receipt["changed"] = json!(true);
        receipt["authorityCursor"] = json!(delivered.get());
        receipt["entities"] = entities;
        Ok(CollectionDelivery::Accepted(receipt))
    };
    library
        .flush_collection_outbox_with(&status, &deliver, 0)
        .unwrap();
    assert_eq!(delivered.get(), 6);
    let received = library.get_av_cover_set(&id).unwrap();
    assert_eq!(
        [received.front_id, received.spine_id, received.back_id],
        ids.clone().map(Some)
    );
    for (artwork, relative) in ids.iter().zip(paths) {
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT relative_path FROM collection_work_artworks WHERE id=?1",
                    [artwork],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            relative
        );
        assert!(library.resolve_work_artwork(artwork).is_ok());
    }
    assert_eq!(count(&library, "collection_authority_materialization"), 0);
    library
        .apply_av_artwork(
            &id,
            av_artwork_request(&library, &id, choice.clone(), choice.clone(), choice),
        )
        .unwrap();
    assert_eq!(core_bodies(&library), commands);
    let cleared = library
        .apply_av_artwork(&id, av_artwork_request(&library, &id, Keep, Clear, Clear))
        .unwrap();
    assert_eq!(cleared.front_id, Some(ids[0].clone()));
    assert!(cleared.spine_id.is_none() && cleared.back_id.is_none());
    assert_eq!(count(&library, "collection_authority_outbox"), 8);
    library
        .apply_av_artwork(&id, av_artwork_request(&library, &id, Keep, Clear, Clear))
        .unwrap();
    assert_eq!(count(&library, "collection_authority_outbox"), 8);
    library
        .flush_collection_outbox_with(&status, &deliver, 0)
        .unwrap();
    assert_eq!(delivered.get(), 8);
    let received = library.get_av_cover_set(&id).unwrap();
    assert_eq!(received.front_id, Some(ids[0].clone()));
    assert!(received.spine_id.is_none() && received.back_id.is_none());
    assert_eq!(count(&library, "collection_work_artworks"), 3);
}

#[test]
fn collection_authority_av_artwork_reuses_local_import_and_manual_content_in_both_directions() {
    use super::super::{av_models::ArtworkDecision::Keep, work_artwork::WorkArtworkKind};
    for provider in ["local", "local-manual"] {
        let (_temp, library, status, id, _server, path) = av_artwork_fixture();
        let prepared = library
            .prepare_work_artwork(&id, &std::fs::read(&path).unwrap())
            .unwrap();
        let first_id = prepared.id.clone();
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        Library::insert_work_artwork_in_transaction(
            &tx,
            &id,
            provider,
            "source-path",
            WorkArtworkKind::Cover,
            None,
            &prepared,
        )
        .unwrap();
        tx.commit().unwrap();
        drop(db);
        prepared.commit();
        let before = core_bodies(&library);
        let saved = library
            .apply_av_artwork(
                &id,
                av_artwork_request(
                    &library,
                    &id,
                    av_artwork_choice(&library, &path),
                    Keep,
                    Keep,
                ),
            )
            .unwrap();
        assert_eq!(saved.front_id, Some(first_id.clone()));
        let redundant = library
            .prepare_work_artwork(&id, &std::fs::read(&path).unwrap())
            .unwrap();
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(
            enqueue_artwork(
                &tx,
                &status,
                &id,
                "local",
                "renamed-source",
                "cover",
                None,
                &redundant
            )
            .unwrap(),
            first_id
        );
        tx.commit().unwrap();
        drop(db);
        drop(redundant);
        assert_eq!(core_bodies(&library), before);
        assert_eq!(count(&library, "collection_work_artworks"), 1);
        assert_eq!(
            std::fs::read_dir(library.root().join("work-artwork").join(&id))
                .unwrap()
                .count(),
            1
        );
    }
}

#[test]
fn collection_authority_av_artwork_reuses_confirmed_legacy_manual_identity_and_blob_hash() {
    use super::super::av_models::{ArtworkDecision::Keep, CoverSurface};
    for legacy_identity in [true, false] {
        let (_temp, library, status, id, mut server, path) = av_artwork_fixture();
        let preview = library
            .preview_av_artwork(&path, CoverSurface::Front)
            .unwrap();
        let mut artwork = art();
        artwork["workId"] = json!(id);
        artwork["provider"] = json!("local-manual");
        artwork["providerImageId"] = json!(if legacy_identity {
            format!("cover/{}", preview.sha256)
        } else {
            "old-provider-key".into()
        });
        artwork["original"]["sha256"] = json!(preview.sha256);
        artwork["original"]["sizeBytes"] = json!(std::fs::read(&path).unwrap().len());
        server["entityRevision"] = json!(2);
        library
            .apply_collection_changes(&changes(
                &status,
                1,
                json!([change(1, json!({"works":[server],"artworks":[artwork]}))]),
            ))
            .unwrap();
        let saved = library
            .apply_av_artwork(
                &id,
                av_artwork_request(
                    &library,
                    &id,
                    av_artwork_choice(&library, &path),
                    Keep,
                    Keep,
                ),
            )
            .unwrap();
        assert_eq!(saved.front_id.as_deref(), Some("art"));
        let commands = core_bodies(&library);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["commandType"], "selectArtwork");
        assert_eq!(commands[0]["artworkId"], "art");
        assert_eq!(count(&library, "collection_work_artworks"), 1);
        assert_eq!(
            std::fs::read_dir(library.root().join("work-artwork").join(&id))
                .unwrap()
                .count(),
            0
        );
    }
}

#[test]
fn collection_authority_av_artwork_transaction_failure_rolls_back_every_slot_and_file() {
    use super::super::av_models::ArtworkDecision::Keep;
    let (_temp, library, _status, id, _server, path) = av_artwork_fixture();
    library.connection().unwrap().execute_batch(
        "CREATE TRIGGER reject_av_back BEFORE INSERT ON collection_authority_outbox WHEN NEW.command_type='selectArtwork' AND json_extract(NEW.payload,'$.slot')='back' BEGIN SELECT RAISE(ABORT,'reject back selection'); END;",
    ).unwrap();
    let before = library.get_av_cover_set(&id).unwrap();
    let choice = av_artwork_choice(&library, &path);
    assert!(library
        .apply_av_artwork(
            &id,
            av_artwork_request(&library, &id, choice.clone(), Keep, choice)
        )
        .is_err());
    assert_eq!(
        library.get_av_cover_set(&id).unwrap().revision,
        before.revision
    );
    assert_eq!(count(&library, "collection_authority_outbox"), 0);
    assert_eq!(count(&library, "collection_work_artworks"), 0);
    for folder in ["work-artwork", "work-artwork-thumbnails"] {
        assert_eq!(
            std::fs::read_dir(library.root().join(folder).join(&id))
                .unwrap()
                .count(),
            0
        );
    }
}

#[test]
fn collection_authority_av_artwork_rejects_stale_images_and_unready_identity() {
    use super::super::av_models::{ArtworkDecision, AvError};
    let (_temp, library, _status, id, _server, path) = av_artwork_fixture();
    let choice = av_artwork_choice(&library, &path);
    let mut stale = av_artwork_request(
        &library,
        &id,
        choice.clone(),
        ArtworkDecision::Keep,
        ArtworkDecision::Keep,
    );
    stale.expected_revision = "stale".into();
    assert!(matches!(
        library.apply_av_artwork(&id, stale),
        Err(AvError::Stale)
    ));
    let before = library.get_av_cover_set(&id).unwrap().revision;
    let wrong = ArtworkDecision::Local {
        path: path.clone(),
        sha256: "changed".into(),
    };
    assert!(matches!(
        library.apply_av_artwork(
            &id,
            av_artwork_request(&library, &id, choice, ArtworkDecision::Keep, wrong)
        ),
        Err(AvError::Image)
    ));
    assert_eq!(library.get_av_cover_set(&id).unwrap().revision, before);
    assert_eq!(count(&library, "collection_authority_outbox"), 0);
    assert_eq!(count(&library, "collection_work_artworks"), 0);
    assert_eq!(
        std::fs::read_dir(library.root().join("work-artwork").join(&id))
            .unwrap()
            .count(),
        0
    );
    let missing = ArtworkDecision::Local {
        path: "missing.png".into(),
        sha256: "missing".into(),
    };
    let input = av_artwork_request(
        &library,
        &id,
        missing,
        ArtworkDecision::Keep,
        ArtworkDecision::Keep,
    );
    library
        .connection()
        .unwrap()
        .execute("UPDATE collection_authority_sync SET adopted=0", [])
        .unwrap();
    assert!(matches!(
        library.apply_av_artwork(&id, input.clone()),
        Err(AvError::Library(
            LibraryError::CollectionAuthorityNotAdopted
        ))
    ));
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_authority_sync SET adopted=1,library_id='wrong-library'",
            [],
        )
        .unwrap();
    assert!(matches!(
        library.apply_av_artwork(&id, input),
        Err(AvError::Library(LibraryError::CollectionAuthorityMismatch))
    ));
}

#[test]
fn collection_authority_batch5_av_edits_are_fenced_and_automatic_profile_refresh_is_quiet() {
    use super::super::{
        av_link::models::ApplyRequest, av_models::*, av_stashdb::AvProfileState,
    };
    for adopted in [false, true] {
        let (_temp, l, s) = fixture();
        seed_av(&l);
        l.observe_collection_authority(&s).unwrap();
        if adopted {
            let mut av = work("av", 1);
            av["type"] = json!("av");
            adopt(&l, &s, json!({"works":[av]}));
        }
        let before = av_local_state(&l);
        let details: SaveAvDetails = serde_json::from_value(json!({"expectedRevision":3,"productCode":"NEW-1","label":null,"series":null,"people":[{"person":{"kind":"new","displayName":"New"},"role":"performer","creditName":null}]})).unwrap();
        if !adopted {
            assert!(matches!(l.save_av_details("av", details), Err(AvError::Library(LibraryError::CollectionAuthorityNotAdopted))));
        }
        let artwork: ApplyAvArtwork = serde_json::from_value(json!({"expectedRevision":"any","front":{"kind":"clear"},"spine":{"kind":"keep"},"back":{"kind":"keep"}})).unwrap();
        let result = l.apply_av_artwork("av", artwork);
        if adopted {
            assert!(matches!(result, Err(AvError::Stale)));
        } else {
            assert!(matches!(
                result,
                Err(AvError::Library(
                    LibraryError::CollectionAuthorityNotAdopted
                ))
            ));
        }
        let link: ApplyRequest = serde_json::from_value(json!({"collectionId":null,"newCollectionName":"New AV","expectedRevision":null,"split":{"x1":0,"x2":0},"surfaces":{"front":"keep","spine":"keep","back":"keep"},"fields":{},"performers":[],"directors":[]})).unwrap();
        assert_fenced(l.apply_av_link("inbox", link));
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
        assert_eq!(av_local_state(&l), before);
        assert_eq!(count(&l, "collection_authority_outbox"), 0);
        // Reads stay available.
        assert_eq!(l.get_av_details("av").unwrap().people.len(), 1);
        assert_eq!(
            l.get_av_performer("p").unwrap().person.memo.as_deref(),
            Some("local memo")
        );
    }
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
        (4, Some("ABC-001"), Some("Maker"), vec!["g".to_owned()])
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
    // An old feed has no confirmed person revision yet, so person edits wait.
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

// AV step 3a: person memo, favorite and portrait commands plus the one-time reconcile.
fn people_fixture(reconciled: bool) -> (tempfile::TempDir, Library, CollectionAuthorityStatus) {
    let (temp, l, s) = fixture();
    seed_av(&l);
    let mut av = work("av", 1);
    av["type"] = json!("av");
    av["name"] = json!("AV Work");
    av["selection"]["work"] = json!("art");
    av["details"]["av"] = json!({"productCode":"ABC-001","titleJa":"原題","maker":null,"label":"Label","series":null,"genres":[],"releaseDate":null});
    av["avCredits"] = json!([{"personId":"p","name":"Display","nameJa":"表示","role":"performer","order":0,"creditName":"Alias","portraitCrop":null}]);
    av["avPeople"] = json!([server_person(1, "remote memo")]);
    let mut artwork = art();
    artwork["workId"] = json!("av");
    adopt(&l, &s, json!({"works":[av],"artworks":[artwork]}));
    if reconciled {
        l.connection()
            .unwrap()
            .execute("UPDATE collection_authority_people_reconcile SET queued=1", [])
            .unwrap();
    }
    (temp, l, s)
}

fn server_person(revision: i64, memo: &str) -> Value {
    json!({"id":"p","personId":"p","displayName":"Display","nameJa":"表示","memo":memo,"favorite":false,"profile":null,"portrait":null,"portraitSelection":null,"portraitImage":null,"entityRevision":revision})
}

fn person_receipt(s: &CollectionAuthorityStatus, body: &Value, person: Value, cursor: i64) -> Value {
    let mut receipt = envelope(s);
    receipt["operationId"] = body["operationId"].clone();
    receipt["commandType"] = body["commandType"].clone();
    receipt["changed"] = json!(true);
    receipt["authorityCursor"] = json!(cursor);
    receipt["entities"] = json!({});
    receipt["person"] = person;
    receipt
}

fn local_person(l: &Library) -> (Option<String>, usize, Option<String>) {
    let favorites = l.list_av_favorites().unwrap().len();
    let db = l.connection().unwrap();
    (
        db.query_row("SELECT memo FROM collection_people WHERE id='p'", [], |r| r.get(0)).unwrap(),
        favorites,
        db.query_row("SELECT kind FROM collection_person_portraits WHERE person_id='p'", [], |r| r.get(0)).optional().unwrap(),
    )
}

#[test]
fn collection_authority_people_adoption_projects_server_person_after_capturing_pc_values() {
    let (_temp, l, _s) = people_fixture(false);
    // The server person replaces local values, but the PC values were captured first.
    assert_eq!(local_person(&l), (Some("remote memo".into()), 0, None));
    let captured: Value = l.connection().unwrap().query_row("SELECT local_payload FROM collection_authority_people_reconcile WHERE person_id='p'", [], |r| r.get::<_, String>(0)).map(|s| serde_json::from_str(&s).unwrap()).unwrap();
    assert_eq!((captured["memo"].as_str(), captured["favorite"].as_bool()), (Some("local memo"), Some(true)));
    assert_eq!(captured["portraitSelection"]["kind"], "image");
    assert_eq!(captured["portraitSelection"]["attribution"]["source"], "commons");
    // Capture runs once per library/epoch: later local changes do not replace it.
    l.connection().unwrap().execute("UPDATE collection_people SET memo='later' WHERE id='p'", []).unwrap();
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        capture_people_reconcile(&tx).unwrap();
        tx.commit().unwrap();
    }
    let again: String = l.connection().unwrap().query_row("SELECT local_payload FROM collection_authority_people_reconcile WHERE person_id='p'", [], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&again).unwrap(), captured);
}

#[test]
fn collection_authority_people_memo_favorite_portrait_queue_projection_receipts_and_conflict() {
    use super::super::av_models::AvPortraitRect;
    let (temp, l, s) = people_fixture(true);
    l.save_av_person_memo("p", Some("new memo".into())).unwrap();
    l.set_av_favorite("p", true).unwrap();
    l.set_av_portrait_crop("p", "art", AvPortraitRect { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }).unwrap();
    // Unchanged saves queue nothing.
    l.save_av_person_memo("p", Some("new memo".into())).unwrap();
    l.set_av_favorite("p", true).unwrap();
    let commands = provider_commands(&l);
    assert_eq!(commands.len(), 3);
    assert_eq!((commands[0]["changes"].clone(), commands[0]["expected"].clone()), (json!({"memo":"new memo"}), json!({"memo":"remote memo"})));
    assert_eq!((commands[1]["changes"].clone(), commands[1]["expected"].clone()), (json!({"favorite":true}), json!({"favorite":false})));
    assert_eq!(commands[2]["commandType"], "setPersonPortrait");
    assert_eq!(commands[2]["portrait"], json!({"kind":"crop","artworkId":"art","rect":{"x":0.1,"y":0.2,"w":0.3,"h":0.4}}));
    assert_eq!(commands[2]["expectedRevision"], 3);
    // Each accepted person command republishes the work: later work CAS accounts for it.
    assert_eq!(predicted_collection_revision(&*l.connection().unwrap(), "works", &json!(["av"]).to_string()).unwrap(), 4);
    assert_eq!(local_person(&l), (Some("new memo".into()), 1, Some("crop".into())));
    // Optimistic state survives reopening and a re-projection of confirmed state.
    drop(l);
    let l = Library::open(temp.path()).unwrap();
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        selections(&tx).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(local_person(&l), (Some("new memo".into()), 1, Some("crop".into())));
    let server = RefCell::new(server_person(1, "remote memo"));
    let sent = Cell::new(0);
    l.flush_collection_outbox_with(&s, &|body| {
        let mut server = server.borrow_mut();
        match body["commandType"].as_str().unwrap() {
            "setPerson" => for (field, value) in body["changes"].as_object().unwrap() {
                assert_eq!(body["expected"][field], server[field]);
                server[field] = value.clone();
            },
            "setPersonPortrait" => {
                assert_eq!(body["expectedRevision"], server["entityRevision"]);
                server["portraitSelection"] = body["portrait"].clone();
                server["portrait"] = json!({"source":"cover"});
            }
            other => panic!("unexpected {other}"),
        }
        server["entityRevision"] = json!(server["entityRevision"].as_i64().unwrap() + 1);
        sent.set(sent.get() + 1);
        Ok(CollectionDelivery::Accepted(person_receipt(&s, body, server.clone(), sent.get())))
    }, 0).unwrap();
    assert_eq!(sent.get(), 3);
    assert_eq!(local_person(&l), (Some("new memo".into()), 1, Some("crop".into())));
    let cached: i64 = l.connection().unwrap().query_row("SELECT revision FROM collection_authority_people_cache WHERE person_id='p'", [], |r| r.get(0)).unwrap();
    assert_eq!(cached, 4);
    // A stale receipt for an older revision never rolls the confirmed person back.
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &server_person(2, "older"), NOW).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(local_person(&l).0.as_deref(), Some("new memo"));
    // Clearing queues null; a conflict blocks it like other AV intents.
    l.clear_av_portrait("p").unwrap();
    let body = provider_commands(&l).pop().unwrap();
    assert_eq!((body["portrait"].clone(), body["expectedRevision"].clone()), (Value::Null, json!(4)));
    assert_eq!(local_person(&l).2, None);
    l.flush_collection_outbox_with(&s, &|_| {
        Ok(CollectionDelivery::Conflict(json!({"code":"revisionConflict","current":{"person":server_person(5, "remote")}})))
    }, 0).unwrap();
    assert_eq!(l.connection().unwrap().query_row("SELECT state FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap(), "blocked");
    assert_eq!(l.authority_sync_health().unwrap().collections.blocked_count, 1);
}

#[test]
fn collection_authority_people_image_portrait_is_reencoded_uploaded_and_downloaded_by_hash() {
    let (_temp, l, s) = people_fixture(true);
    let mut big = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2000, 1000).write_to(&mut big, image::ImageFormat::Png).unwrap();
    l.connection().unwrap().execute("INSERT INTO collection_person_portraits(person_id,kind,image_bytes,mime,width,height,file_name,source_url,license,author,updated_at) VALUES('p','commons',?1,'image/png',2000,1000,'p.png','https://commons.wikimedia.org/p','CC BY 4.0','Author','now')", [big.into_inner()]).unwrap();
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        let status = collection_write_status(&tx).unwrap();
        enqueue_stored_person_portrait(&tx, &status, "p").unwrap();
        tx.commit().unwrap();
    }
    let body = provider_commands(&l).pop().unwrap();
    let portrait = &body["portrait"];
    assert_eq!((portrait["kind"].as_str(), portrait["width"].as_i64(), portrait["height"].as_i64()), (Some("image"), Some(1600), Some(800)));
    assert_eq!(portrait["original"]["contentType"], "image/jpeg");
    assert_eq!(portrait["attribution"], json!({"source":"commons","sourceUrl":"https://commons.wikimedia.org/p","license":"CC BY 4.0","author":"Author"}));
    let uploaded = RefCell::new(Vec::new());
    l.upload_collection_command_artwork_with(&body, &|blob, bytes| {
        assert_eq!(portrait_digest(bytes), blob.sha256);
        uploaded.borrow_mut().push(blob.sha256.clone());
        Ok(())
    }, &|_| Ok(true)).unwrap();
    assert_eq!(uploaded.borrow().as_slice(), [portrait["original"]["sha256"].as_str().unwrap().to_owned()]);
    // Another device's image arrives as a confirmed selection; bytes are verified by hash.
    let jpeg: Vec<u8> = l.connection().unwrap().query_row("SELECT bytes FROM collection_authority_portrait_blobs WHERE sha256=?1", [portrait["original"]["sha256"].as_str().unwrap()], |r| r.get(0)).unwrap();
    l.connection().unwrap().execute("DELETE FROM collection_authority_portrait_blobs", []).unwrap();
    l.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='accepted'", []).unwrap();
    let mut remote = server_person(2, "remote memo");
    remote["portraitSelection"] = portrait.clone();
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &remote, NOW).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(l.materialize_person_portraits_with(&s, &|_| Ok(b"tampered".to_vec())).unwrap(), 0);
    assert_eq!(count(&l, "collection_authority_portrait_blobs"), 0);
    assert_eq!(l.materialize_person_portraits_with(&s, &|_| Err(LibraryError::CloudRequestUnavailable)).unwrap(), 0);
    assert_eq!(l.materialize_person_portraits_with(&s, &|_| Ok(jpeg.clone())).unwrap(), 1);
    let stored: (String, Vec<u8>) = l.connection().unwrap().query_row("SELECT kind,image_bytes FROM collection_person_portraits WHERE person_id='p'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((stored.0.as_str(), stored.1 == jpeg), ("commons", true));
}

#[test]
fn collection_authority_people_reconcile_rules() {
    let crop = json!({"kind":"crop","artworkId":"a","rect":{"x":0,"y":0,"w":0.5,"h":0.5}});
    let other = json!({"kind":"crop","artworkId":"b","rect":{"x":0,"y":0,"w":0.5,"h":0.5}});
    let image = |sha: &str, source: &str| json!({"kind":"image","original":{"sha256":sha},"attribution":{"source":source,"sourceUrl":null,"license":null,"author":null}});
    let empty = json!({"memo":null,"favorite":false,"portraitSelection":null});
    let case = |pc: Value, server: Value| reconcile_person_changes(&pc, &server);
    // Fill empty server values.
    assert_eq!(case(json!({"memo":"pc","favorite":true,"portraitSelection":crop}), empty.clone()), (json!({"memo":"pc","favorite":true}), Some(crop.clone())));
    // Never send a PC null/false/blank, so nothing is ever cleared.
    let full = json!({"memo":"server","favorite":true,"portraitSelection":crop});
    assert_eq!(case(json!({"memo":null,"favorite":false,"portraitSelection":null}), full.clone()), (json!({}), None));
    assert_eq!(case(json!({"memo":"  ","favorite":false,"portraitSelection":null}), full.clone()), (json!({}), None));
    // Both nonempty and different: PC wins for memo and portrait.
    assert_eq!(case(json!({"memo":"pc","favorite":true,"portraitSelection":other}), full.clone()), (json!({"memo":"pc"}), Some(other.clone())));
    // Equal values queue nothing; a re-encoded image with the same source is the same picture.
    assert_eq!(case(json!({"memo":" server ","favorite":true,"portraitSelection":crop}), full), (json!({}), None));
    assert_eq!(case(json!({"memo":null,"favorite":false,"portraitSelection":image("a","commons")}), json!({"portraitSelection":image("b","commons")})), (json!({}), None));
    assert_eq!(case(json!({"memo":null,"favorite":false,"portraitSelection":image("a","commons")}), json!({"portraitSelection":image("b","stashdb")})).1, Some(image("a","commons")));
}

#[test]
fn collection_authority_people_reconcile_runs_once_resumes_and_waits_for_missing_people() {
    let (_temp, l, s) = people_fixture(false);
    l.connection().unwrap().execute_batch("INSERT INTO collection_people(id,display_name,memo,created_at,updated_at) VALUES('q','Local only','q memo','old','old');
        INSERT INTO collection_authority_people_reconcile(library_id,epoch,person_id,local_payload) SELECT library_id,epoch,'q','{\"memo\":\"q memo\",\"favorite\":false,\"portraitSelection\":null}' FROM collection_authority_people_reconcile WHERE person_id='p'").unwrap();
    let reads = RefCell::new(Vec::new());
    // An interrupted read changes nothing and is retried later.
    assert_eq!(l.reconcile_av_people_with(&s, &|_| Err(LibraryError::CloudRequestUnavailable)).unwrap(), 0);
    assert_eq!(count(&l, "collection_authority_outbox"), 0);
    let read = |person: &str| -> Result<Option<Value>, LibraryError> {
        reads.borrow_mut().push(person.to_owned());
        Ok((person == "p").then(|| json!({"person":server_person(1, "remote memo")})))
    };
    assert_eq!(l.reconcile_av_people_with(&s, &read).unwrap(), 1);
    let commands = provider_commands(&l);
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["changes"], json!({"memo":"local memo","favorite":true}));
    assert_eq!(commands[0]["expected"], json!({"memo":"remote memo","favorite":false}));
    assert_eq!((commands[1]["commandType"].as_str(), commands[1]["portrait"]["kind"].as_str(), commands[1]["expectedRevision"].as_i64()), (Some("setPersonPortrait"), Some("image"), Some(2)));
    assert_eq!(local_person(&l), (Some("local memo".into()), 1, Some("commons".into())));
    assert_eq!(reads.borrow().as_slice(), ["p", "q"]);
    // Completed rows never repeat; a missing person waits for a confirmed row.
    assert_eq!(l.reconcile_av_people_with(&s, &read).unwrap(), 0);
    assert_eq!(reads.borrow().len(), 2);
    assert_eq!(count(&l, "collection_authority_outbox"), 2);
    assert_eq!(l.connection().unwrap().query_row("SELECT memo FROM collection_people WHERE id='q'", [], |r| r.get::<_, String>(0)).unwrap(), "q memo");
    // An older server without person revisions is not reconciled against.
    l.connection().unwrap().execute("UPDATE collection_authority_people_reconcile SET missing=0 WHERE person_id='q'", []).unwrap();
    assert_eq!(l.reconcile_av_people_with(&s, &|_| Ok(Some(json!({"person":{"id":"q","memo":null}})))).unwrap(), 0);
    assert_eq!(count(&l, "collection_authority_outbox"), 2);
}

fn stashdb_person(revision: i64, id: Option<&str>) -> Value {
    let mut person = server_person(revision, "remote memo");
    person["stashdbId"] = json!(id);
    if id.is_some() {
        person["profile"] = json!({"source":"stashdb","name":"Provider Name","aliases":["Alias"],"birthDate":"2000-01","heightCm":165,"bandIn":34,"waistIn":23,"hipIn":33,"cup":"E","breastType":"NATURAL","careerStart":2020,"careerEnd":null,"urls":[{"url":"https://example.com","site":"Studio"}]});
    }
    person
}
#[test]
fn collection_authority_stashdb_profile_fifo_receipt_feed_and_clear_projection() {
    let (_dir, l, s) = people_fixture(true);
    l.save_av_person_memo("p", Some("queued memo".into()))
        .unwrap();
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        let status = collection_write_status(&tx).unwrap();
        enqueue_person_profile(&tx, &status, "p", Some("stash-one")).unwrap();
        enqueue_person_profile(&tx, &status, "p", Some("stash-one")).unwrap();
        enqueue_person_portrait(
            &tx,
            &status,
            "p",
            json!({"kind":"crop","artworkId":"art","rect":{"x":0.1,"y":0.1,"w":0.5,"h":0.5}}),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let bodies = provider_commands(&l);
    assert_eq!(bodies[1]["expectedRevision"], 2);
    assert_eq!(bodies[2]["expectedRevision"], 3);
    assert_eq!(bodies[3]["expectedRevision"], 4);
    assert_eq!(
        predicted_collection_revision(
            &l.connection().unwrap(),
            "works",
            &json!(["av"]).to_string()
        )
        .unwrap(),
        5
    );
    assert_eq!(
        l.get_av_performer_profile("p").unwrap().unwrap().status,
        "matched"
    );
    let before = provider_commands(&l);
    l.flush_collection_outbox_with(&s, &|_| Ok(CollectionDelivery::Retry), 0)
        .unwrap();
    assert_eq!(provider_commands(&l), before);
    l.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='accepted' WHERE command_type='setPerson'",[]).unwrap();
    l.flush_collection_outbox_with(
        &s,
        &|body| {
            Ok(CollectionDelivery::Accepted(person_receipt(
                &s,
                body,
                stashdb_person(
                    body["expectedRevision"].as_i64().unwrap() + 1,
                    Some("stash-one"),
                ),
                1,
            )))
        },
        5000,
    )
    .unwrap();
    let p = l.get_av_performer_profile("p").unwrap().unwrap();
    assert_eq!(p.stashdb_id.as_deref(), Some("stash-one"));
    assert_eq!(p.height_cm, Some(165));
    assert_eq!(p.urls[0].site.name, "Studio");
    assert!(p.images.is_empty());
    let mut av = work("av", 20);
    av["type"] = json!("av");
    av["details"]["av"] = json!({"genres":[]});
    av["avPeople"] = json!([stashdb_person(20, Some("stash-two"))]);
    av["avCredits"] = json!([{"personId":"p","name":"Display","nameJa":null,"role":"performer","order":0,"creditName":null,"portraitCrop":null}]);
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        let generation = local(&tx).unwrap().unwrap().generation;
        apply_entities(&tx, &json!({"works":[av]}), &generation, NOW).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        l.get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("stash-two")
    );
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &stashdb_person(1, Some("stale")), NOW).unwrap();
        enqueue_person_profile(&tx, &s, "p", None).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        l.get_av_performer_profile("p")
            .unwrap()
            .unwrap()
            .stashdb_id
            .as_deref(),
        Some("stash-two")
    );
    l.flush_collection_outbox_with(
        &s,
        &|body| {
            Ok(CollectionDelivery::Accepted(person_receipt(
                &s,
                body,
                stashdb_person(21, None),
                2,
            )))
        },
        9000,
    )
    .unwrap();
    assert!(l.get_av_performer_profile("p").unwrap().is_none());
}
#[test]
fn collection_authority_stashdb_manifest_queues_portrait_without_upload() {
    let (_dir, l, s) = people_fixture(true);
    let portrait = json!({"kind":"image","original":{"sha256":"a".repeat(64),"sizeBytes":42,"contentType":"image/jpeg"},"width":1200,"height":1600,"attribution":{"source":"stashdb","sourceUrl":"https://stashdb.org/images/photo","license":null,"author":null}});
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        enqueue_person_profile(&tx, &s, "p", Some("one")).unwrap();
        enqueue_relay_person_portrait(&tx, &s, "p", portrait.clone(), None).unwrap();
        tx.commit().unwrap();
    }
    let body = provider_commands(&l).pop().unwrap();
    assert_eq!(body["commandType"], "setPersonPortrait");
    assert_eq!(body["portrait"], portrait);
    assert_eq!(body["expectedRevision"], 2);
    assert_eq!(body.as_object().unwrap().len(), 8);
    l.upload_collection_command_artwork_with(
        &body,
        &|_, _| panic!("relay portrait must not upload"),
        &|_| panic!("relay blob was already confirmed"),
    )
    .unwrap();
    let mut invalid = portrait;
    invalid["width"] = json!(1601);
    let mut db = l.connection().unwrap();
    let tx = db.transaction().unwrap();
    assert!(enqueue_relay_person_portrait(&tx, &s, "p", invalid, None).is_err());
}

#[test]
fn collection_authority_stashdb_optimistic_portrait_survives_prior_receipt_and_downloads_confirmed_bytes(
) {
    let (_dir, l, s) = people_fixture(true);
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &stashdb_person(1, Some("one")), NOW).unwrap();
        tx.commit().unwrap();
    }
    l.save_av_person_memo("p", Some("queued memo".into()))
        .unwrap();
    let image = image::DynamicImage::new_rgb8(2, 3);
    let mut preview = Vec::new();
    let mut confirmed = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut preview, 88)
        .encode_image(&image)
        .unwrap();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut confirmed, 95)
        .encode_image(&image)
        .unwrap();
    assert_ne!(preview, confirmed);
    let portrait = json!({"kind":"image","original":{"sha256":portrait_digest(&confirmed),"sizeBytes":confirmed.len(),"contentType":"image/jpeg"},"width":2,"height":3,"attribution":{"source":"stashdb","sourceUrl":"https://stashdb.org/images/photo","license":null,"author":null}});
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        enqueue_relay_person_portrait(&tx, &s, "p", portrait.clone(), Some(&preview)).unwrap();
        receive_person(&tx, &stashdb_person(2, Some("one")), NOW).unwrap();
        reapply_pending_core_edits(&tx).unwrap();
        tx.commit().unwrap();
    }
    let read = || {
        l.connection()
            .unwrap()
            .query_row(
                "SELECT image_bytes FROM collection_person_portraits WHERE person_id='p'",
                [],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .unwrap()
    };
    assert_eq!(read(), preview);
    let mut remote = stashdb_person(3, Some("one"));
    remote["portraitSelection"] = portrait;
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &remote, NOW).unwrap();
        tx.execute(
            "UPDATE collection_authority_outbox SET state='accepted'",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(read(), preview);
    assert_eq!(
        l.materialize_person_portraits_with(&s, &|_| Ok(confirmed.clone()))
            .unwrap(),
        1
    );
    assert_eq!(read(), confirmed);
}
#[test]
fn collection_authority_stashdb_profile_conflict_retains_text_and_reports_sync_issue() {
    let (_dir, l, s) = people_fixture(true);
    {
        let mut db = l.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &stashdb_person(1, Some("one")), NOW).unwrap();
        enqueue_person_profile(&tx, &s, "p", Some("two")).unwrap();
        tx.commit().unwrap();
    }
    l.flush_collection_outbox_with(&s,&|_|Ok(CollectionDelivery::Conflict(json!({"code":"revisionConflict","current":{"person":stashdb_person(2,Some("remote"))}}))),0).unwrap();
    let profile = l.get_av_performer_profile("p").unwrap().unwrap();
    assert_eq!(profile.stashdb_id.as_deref(), Some("one"));
    assert!(profile.sync_issue);
    assert!(!profile.pending);
}

#[test]
fn collection_authority_stashdb_empty_clear_is_a_fifo_noop() {
    let (_dir, library, status) = people_fixture(true);
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    enqueue_person_profile(&tx, &status, "p", None).unwrap();
    enqueue_person_portrait(
        &tx,
        &status,
        "p",
        json!({"kind":"crop","artworkId":"art","rect":{"x":0.1,"y":0.1,"w":0.5,"h":0.5}}),
    )
    .unwrap();
    assert_eq!(predicted_person(&tx, "p").unwrap()["entityRevision"], 2);
    assert_eq!(
        predicted_collection_revision(&tx, "works", &json!(["av"]).to_string()).unwrap(),
        2
    );
    tx.commit().unwrap();
    drop(db);
    assert_eq!(provider_commands(&library)[1]["expectedRevision"], 1);
}

#[test]
fn collection_authority_stashdb_staged_text_without_identity_stays_readable() {
    let (_dir, library, _) = people_fixture(true);
    let mut staged = stashdb_person(2, Some("one"));
    staged["stashdbId"] = Value::Null;
    {
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &staged, NOW).unwrap();
        tx.commit().unwrap();
    }
    let profile = library.get_av_performer_profile("p").unwrap().unwrap();
    assert_eq!(profile.status, "matched");
    assert_eq!(profile.height_cm, Some(165));
    assert!(profile.stashdb_id.is_none());
    assert!(library
        .connection()
        .unwrap()
        .query_row(
            "SELECT stashdb_id FROM collection_person_profiles WHERE person_id='p'",
            [],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap()
        .is_none());
}

#[test]
fn collection_authority_stashdb_unchanged_refresh_does_not_break_the_next_portrait_cas() {
    let (_dir, library, status) = people_fixture(true);
    let confirmed = stashdb_person(1, Some("one"));
    {
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        receive_person(&tx, &confirmed, NOW).unwrap();
        enqueue_person_profile_snapshot(
            &tx,
            &status,
            "p",
            Some("one"),
            Some(&confirmed["profile"]),
        )
        .unwrap();
        enqueue_person_portrait(
            &tx,
            &status,
            "p",
            json!({"kind":"crop","artworkId":"art","rect":{"x":0.1,"y":0.1,"w":0.5,"h":0.5}}),
        )
        .unwrap();
        assert_eq!(predicted_person(&tx, "p").unwrap()["entityRevision"], 2);
        assert_eq!(
            predicted_collection_revision(&tx, "works", &json!(["av"]).to_string()).unwrap(),
            2
        );
        tx.commit().unwrap();
    }
    let commands = provider_commands(&library);
    assert_eq!(commands[1]["expectedRevision"], 1);
    assert!(commands[0].get("profile").is_none());
    library
        .flush_collection_outbox_with(
            &status,
            &|body| {
                let mut person = confirmed.clone();
                let mut receipt = person_receipt(&status, body, person.clone(), 1);
                if body["commandType"] == "setPersonProfile" {
                    receipt["changed"] = json!(false);
                } else {
                    person["entityRevision"] = json!(2);
                    person["portraitSelection"] = body["portrait"].clone();
                    receipt["person"] = person;
                }
                Ok(CollectionDelivery::Accepted(receipt))
            },
            0,
        )
        .unwrap();
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM notes_state WHERE key LIKE 'stashdbProfilePrediction:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn collection_authority_stashdb_noop_refresh_after_new_credits_uses_the_confirmed_person() {
    let (_dir, library, status) = people_fixture(true);
    let confirmed = stashdb_person(1, Some("one"));
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    receive_person(&tx, &confirmed, NOW).unwrap();
    tx.execute("UPDATE collection_authority_revisions SET payload=json_set(payload,'$.avCredits',json('[]'),'$.avPeople',json('[]')) WHERE section='works' AND work_id='av'",[]).unwrap();
    enqueue_collection_command(&tx, &status, "setAvCredits", "av", json!({"workId":"av","expectedRevision":1,"people":[],"credits":[{"personId":"p","role":"performer","creditName":null,"order":0}]})).unwrap();
    enqueue_person_profile_snapshot(&tx, &status, "p", Some("one"), Some(&confirmed["profile"]))
        .unwrap();
    assert_eq!(predicted_person(&tx, "p").unwrap()["entityRevision"], 1);
    assert_eq!(
        predicted_collection_revision(&tx, "works", &json!(["av"]).to_string()).unwrap(),
        2
    );
    tx.commit().unwrap();
}


#[test]
fn collection_authority_stashdb_old_server_person_preserves_local_profile_bytes() {
    let (_dir, library, _) = people_fixture(true);
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    receive_person(&tx, &stashdb_person(1, Some("local-choice")), NOW).unwrap();
    // Include local photos/candidates and raw JSON whitespace, not just identity.
    tx.execute("UPDATE collection_person_profiles SET aliases_json='[ \"Local alias\" ]',images_json='[ {\"id\":\"photo\",\"url\":\"https://stashdb.org/images/photo\",\"width\":10,\"height\":20} ]',candidates_json='[ {\"stashdbId\":\"candidate\",\"name\":\"Local candidate\",\"aliases\":[],\"birthDate\":null,\"imageUrl\":null} ]',fetched_at='local timestamp' WHERE person_id='p'", []).unwrap();
    let snapshot = |db: &Connection| {
        db.query_row("SELECT * FROM collection_person_profiles WHERE person_id='p'", [], |r| {
            (0..r.as_ref().column_count()).map(|i| r.get::<_, rusqlite::types::Value>(i)).collect::<Result<Vec<_>, _>>()
        }).unwrap()
    };
    let before = snapshot(&tx);
    let mut old = server_person(2, "tablet memo");
    assert!(old.get("stashdbId").is_none());
    receive_person(&tx, &old, "new timestamp").unwrap();
    assert_eq!(snapshot(&tx), before);
    old["entityRevision"] = json!(3);
    old["profile"] = stashdb_person(3, Some("staged"))["profile"].clone();
    receive_person(&tx, &old, "another timestamp").unwrap();
    assert_eq!(snapshot(&tx), before);
    tx.commit().unwrap();
}

#[test]
fn collection_authority_stashdb_new_server_set_and_clear_project_identity() {
    let (_dir, library, _) = people_fixture(true);
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    receive_person(&tx, &stashdb_person(2, Some("chosen")), NOW).unwrap();
    let row: (String, String, i64, String, String) = tx.query_row(
        "SELECT stashdb_id,status,height_cm,images_json,candidates_json FROM collection_person_profiles WHERE person_id='p'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).unwrap();
    assert_eq!(row, ("chosen".into(), "matched".into(), 165, "[]".into(), "[]".into()));
    receive_person(&tx, &stashdb_person(3, None), NOW).unwrap();
    assert_eq!(tx.query_row("SELECT count(*) FROM collection_person_profiles WHERE person_id='p'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    tx.commit().unwrap();
    drop(db);
    assert!(library.get_av_performer_profile("p").unwrap().is_none());
}

#[test]
fn collection_authority_stashdb_profile_bumps_trashed_work_before_restore() {
    let (_dir, library, status) = people_fixture(true);
    {
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        let raw: String = tx.query_row("SELECT payload FROM collection_authority_revisions WHERE section='works' AND work_id='av'", [], |r| r.get(0)).unwrap();
        let mut av: Value = serde_json::from_str(&raw).unwrap();
        av["entityRevision"] = json!(7);
        av["lifecycle"] = json!("trashed");
        av["trashedAt"] = json!(NOW);
        let generation = local(&tx).unwrap().unwrap().generation;
        apply_entities(&tx, &json!({"works":[av]}), &generation, NOW).unwrap();
        enqueue_person_profile(&tx, &status, "p", Some("chosen")).unwrap();
        assert_eq!(predicted_collection_revision(&tx, "works", &json!(["av"]).to_string()).unwrap(), 8);
        tx.commit().unwrap();
    }
    library.restore_collection_work("av", 7, status.library_id.as_deref().unwrap(), 1).unwrap();
    library.restore_collection_work("av", 7, status.library_id.as_deref().unwrap(), 1).unwrap();
    let commands = provider_commands(&library);
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["commandType"], "setPersonProfile");
    assert_eq!(commands[1]["commandType"], "restoreWork");
    assert_eq!(commands[1]["expectedRevision"], 8);
    // Acceptance must still deduplicate a stale click from the same trash list.
    library.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='accepted'", []).unwrap();
    library.restore_collection_work("av", 7, status.library_id.as_deref().unwrap(), 1).unwrap();
    assert_eq!(provider_commands(&library).len(), 2);
}

#[test]
fn collection_authority_stashdb_profile_predictions_are_pruned_after_drop_or_discard() {
    for disposition in ["serverDrop", "userDiscard", "blockedDiscard"] {
        let (_dir, library, status) = people_fixture(true);
        let confirmed = stashdb_person(1, Some("one"));
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            receive_person(&tx, &confirmed, NOW).unwrap();
            enqueue_person_profile_snapshot(&tx, &status, "p", Some("one"), Some(&confirmed["profile"])).unwrap();
            tx.execute("INSERT INTO notes_state(key,value) VALUES('unrelatedPrediction','keep')", []).unwrap();
            tx.commit().unwrap();
        }
        let hints = || library.connection().unwrap().query_row("SELECT count(*) FROM notes_state WHERE key GLOB 'stashdbProfilePrediction:*'", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(hints(), 1);
        if disposition == "serverDrop" {
            library.flush_collection_outbox_with(&status, &|_| Ok(CollectionDelivery::Dropped(json!({"code":"personNotFound"}))), 0).unwrap();
        } else {
            if disposition == "blockedDiscard" {
                library.flush_collection_outbox_with(&status, &|_| Ok(CollectionDelivery::Conflict(json!({"code":"revisionConflict"}))), 0).unwrap();
                assert_eq!(hints(), 1, "blocked intents may still be retried");
            }
            library.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='dropped',drop_reason='userDiscarded'", []).unwrap();
            library.flush_collection_outbox_with(&status, &|_| panic!("discarded intent must not be sent"), 0).unwrap();
        }
        assert_eq!(hints(), 0, "{disposition}");
        assert_eq!(library.connection().unwrap().query_row("SELECT value FROM notes_state WHERE key='unrelatedPrediction'", [], |r| r.get::<_, String>(0)).unwrap(), "keep");
    }
}

#[test]
fn collection_authority_av_inbox_artwork_has_nothing_to_upload() {
    let (_temp, library, _) = fixture();
    let body = json!({"commandType":"addArtwork","operationId":"op-inbox","workId":"w","artworkId":"art",
        "original":{"sha256":"a".repeat(64),"sizeBytes":5,"contentType":"image/jpeg"}});
    let never_upload = |_: &crate::cloud::collections::ArtworkBlob, _: &[u8]| -> Result<(), LibraryError> {
        panic!("server-prepared artwork is never uploaded")
    };
    let never_confirm = |_: &crate::cloud::collections::ArtworkBlob| -> Result<bool, LibraryError> {
        panic!("server-prepared artwork is already confirmed")
    };
    // An ordinary local artwork without a file still fails the upload.
    assert!(library
        .upload_collection_command_artwork_with(&body, &never_upload, &never_confirm)
        .is_err());
    library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO notes_state(key,value) VALUES(?1,'inbox')",
            [av_inbox_operation_key("op-inbox")],
        )
        .unwrap();
    library
        .upload_collection_command_artwork_with(&body, &never_upload, &never_confirm)
        .unwrap();
}

fn manual_profile_fixture() -> (tempfile::TempDir, Library, CollectionAuthorityStatus) {
    let (temp, library, mut status) = people_fixture(false);
    status.features = vec!["personProfileFields".into()];
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    let profile = json!({"source":"stashdb","name":"Roman Name","aliases":[],"birthDate":"1990","heightCm":160,"bandIn":32,"waistIn":24,"hipIn":34,"cup":"C","breastType":"NATURAL","careerStart":2010,"careerEnd":null,"urls":[]});
    let mut person = server_person(1, "remote memo");
    person["stashdbId"] = json!("stash");
    person["profile"] = profile.clone(); person["stashdbProfile"] = profile;
    person["profileOverrides"] = json!({});
    receive_person(&tx, &person, NOW).unwrap();
    tx.execute("INSERT INTO notes_state(key,value) VALUES('personProfileFieldsStatus',?1)",[json!({"active":true,"libraryId":status.library_id,"epoch":1,"features":["personProfileFields"]}).to_string()]).unwrap();
    tx.commit().unwrap(); drop(db);
    (temp,library,status)
}
#[test]
fn collection_authority_manual_profile_fields_fifo_tokens_and_work_revision() {
    let (_temp, library, _status)=manual_profile_fixture();
    edit_profile(&library,json!({"bandIn":33,"cup":null})).unwrap();
    edit_profile(&library,json!({"bandIn":34})).unwrap();
    let db=library.connection().unwrap();
    let bodies=db.prepare("SELECT payload FROM collection_authority_outbox WHERE command_type='setPersonProfileFields' ORDER BY seq").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().map(|r|serde_json::from_str::<Value>(&r.unwrap()).unwrap()).collect::<Vec<_>>();
    assert_eq!(bodies[0]["expected"]["bandIn"],json!({"value":32,"overridden":false}));
    assert_eq!(bodies[1]["expected"]["bandIn"],json!({"value":33,"overridden":true}));
    assert_eq!(bodies[0]["changes"].as_object().unwrap().len(),2);
    let person=predicted_person(&db,"p").unwrap();
    assert_eq!(person["profile"]["bandIn"],34);
    assert!(person["profileOverrides"].get("cup").is_some());
    assert!(person["profile"]["cup"].is_null());
    assert_eq!(person["stashdbProfile"]["cup"],"C");
    assert_eq!(confirmed_person(&db,"p").unwrap().unwrap()["entityRevision"],1);
    assert_eq!(person["entityRevision"],3);
    assert_eq!(predicted_collection_revision(&db,"works",&json!(["av"]).to_string()).unwrap(),3);
}
#[test]
fn collection_authority_manual_profile_receipts_metadata_and_old_revision_guard() {
    let (_temp,library,status)=manual_profile_fixture();
    edit_profile(&library,json!({"heightCm":170,"displayName":"한국 이름"})).unwrap();
    library.flush_collection_outbox_with(&status,&|body| {
        let mut person=predicted_person(&*library.connection().unwrap(),"p").unwrap();
        person["entityRevision"]=json!(2);
        Ok(CollectionDelivery::Accepted(person_receipt(&status,body,person,1)))
    },0).unwrap();
    let mut db=library.connection().unwrap();let tx=db.transaction().unwrap();
    let mut older=server_person(1,"old");older["profile"]=Value::Null;
    receive_person(&tx,&older,NOW).unwrap();
    let confirmed=confirmed_person(&tx,"p").unwrap().unwrap();
    assert_eq!(confirmed["displayName"],"한국 이름");
    assert_eq!(confirmed["profileBaseNames"]["displayName"],"Display");
    assert_eq!(confirmed["stashdbProfile"]["heightCm"],160);
    assert_eq!(confirmed["profileOverrides"]["heightCm"],170);
    tx.commit().unwrap();drop(db);
    let state=library.av_person_profile_state("p").unwrap();
    assert_eq!(state["profileFieldsSupported"],true);
    assert_eq!(library.get_av_performer("p").unwrap().person.display_name,"한국 이름");
}
#[test]
fn collection_authority_manual_profile_group_reset_follows_source_and_clear_keeps_manual() {
    let (_temp,library,status)=manual_profile_fixture();
    edit_profile(&library,json!({"bandIn":33,"careerEnd":2020})).unwrap();
    {
        let mut db=library.connection().unwrap();let tx=db.transaction().unwrap();
        let mut person=predicted_person(&tx,"p").unwrap();person["entityRevision"]=json!(3);
        person["stashdbProfile"]["bandIn"]=json!(35);
        receive_person(&tx,&person,NOW).unwrap();
        tx.execute("UPDATE collection_authority_outbox SET state='accepted'",[]).unwrap();
        tx.commit().unwrap();
    }
    edit_profile(&library,json!({"bandIn":{"reset":true},"waistIn":{"reset":true},"hipIn":{"reset":true}})).unwrap();
    let state=library.av_person_profile_state("p").unwrap();assert_eq!(state["profile"]["bandIn"],35);assert!(state["profileOverrides"].get("bandIn").is_none());
    let mut db=library.connection().unwrap();let tx=db.transaction().unwrap();
    enqueue_person_profile(&tx,&status,"p",None).unwrap();
    let state=predicted_person(&tx,"p").unwrap();
    assert_eq!(state["profile"]["careerEnd"],2020);assert!(state["stashdbProfile"].is_null());
    tx.commit().unwrap();
}
#[test]
fn collection_authority_manual_profile_gate_conflict_and_new_operation_id() {
    let (_temp,library,status)=manual_profile_fixture();
    edit_profile(&library,json!({"heightCm":170})).unwrap();
    let original: String=library.connection().unwrap().query_row("SELECT operation_id FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1",[],|r|r.get(0)).unwrap();
    let mut current=confirmed_person(&*library.connection().unwrap(),"p").unwrap().unwrap();current["profileOverrides"]["heightCm"]=json!(180);current["profile"]["heightCm"]=json!(180);current["entityRevision"]=json!(2);
    library.flush_collection_outbox_with(&status,&|_|Ok(CollectionDelivery::Conflict(json!({"code":"revisionConflict","current":{"person":current}}))),0).unwrap();
    assert!(edit_profile(&library,json!({"cup":"D"})).is_err());
    library.resolve_av_person_profile_conflict("p",&original,true).unwrap();
    let body:Value=library.connection().unwrap().query_row("SELECT payload FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1",[],|r|r.get::<_,String>(0)).map(|v|serde_json::from_str(&v).unwrap()).unwrap();
    assert_ne!(body["operationId"],original);assert_eq!(body["expected"]["heightCm"],json!({"value":180,"overridden":true}));
    assert_eq!(library.av_person_profile_state("p").unwrap()["profile"]["heightCm"],170);
    library.connection().unwrap().execute("UPDATE notes_state SET value='{}' WHERE key='personProfileFieldsStatus'",[]).unwrap();
    assert!(edit_profile(&library,json!({"cup":"D"})).is_err());
}

#[test]
fn collection_authority_manual_profile_empty_links_cas_and_unsupported_draft() {
    let (_temp,library,status)=manual_profile_fixture();
    {
        let mut db=library.connection().unwrap();let tx=db.transaction().unwrap();
        let mut person=confirmed_person(&tx,"p").unwrap().unwrap();person["entityRevision"]=json!(2);person["profile"]=Value::Null;person["stashdbProfile"]=Value::Null;person["stashdbId"]=Value::Null;
        receive_person(&tx,&person,NOW).unwrap();tx.commit().unwrap();
    }
    edit_profile(&library,json!({"urls":null})).unwrap();
    let body:Value=library.connection().unwrap().query_row("SELECT payload FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1",[],|r|r.get::<_,String>(0)).map(|v|serde_json::from_str(&v).unwrap()).unwrap();
    assert_eq!(body["expected"]["urls"],json!({"value":null,"overridden":false}));
    library.flush_collection_outbox_with(&status,&|_|Ok(CollectionDelivery::Dropped(json!({"code":"unsupportedCollectionCommand"}))),0).unwrap();
    assert_eq!(library.av_person_profile_state("p").unwrap()["profileMessage"],"서버가 아직 프로필 편집을 지원하지 않습니다.");
    assert_eq!(library.av_person_profile_state("p").unwrap()["profileConflicts"],json!([]));
    assert_eq!(library.connection().unwrap().query_row("SELECT payload FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1",[],|r|r.get::<_,String>(0)).unwrap(),body.to_string());
    assert!(validate_profile_fields(&json!({"birthDate":"1990-ab"})).is_err());
}
#[test]
fn collection_authority_manual_profile_authority_read_preserves_newer_state_and_unknown_features() {
    let (_temp,library,status)=manual_profile_fixture();
    let mut current=confirmed_person(&*library.connection().unwrap(),"p").unwrap().unwrap();current["entityRevision"]=json!(2);current["profileOverrides"]["heightCm"]=json!(170);current["profile"]["heightCm"]=json!(170);
    let advertised=json!({"active":true,"libraryId":status.library_id,"epoch":1,"contractVersion":1,"cursor":0,"features":["futureFeature","personProfileFields"]});
    library.refresh_profile_person_with("p",&||Ok(advertised.clone()),&||Ok(Some(json!({"person":current})))).unwrap();
    let old=server_person(1,"old");
    let state=library.refresh_profile_person_with("p",&||Ok(advertised.clone()),&||Ok(Some(json!({"person":old})))).unwrap();assert_eq!(state["profileOverrides"]["heightCm"],170);
    let state=library.refresh_profile_person_with("p",&||Ok(json!({"active":false,"features":["personProfileFields"]})),&||panic!("inactive authority must not read a person")).unwrap();assert_eq!(state["profileFieldsSupported"],false);
}

#[test]
fn collection_authority_manual_profile_waits_for_unknown_provider_source() {
    let (_temp, library, status) = manual_profile_fixture();
    let mut db = library.connection().unwrap();
    let tx = db.transaction().unwrap();
    enqueue_person_profile(&tx, &status, "p", Some("new-source")).unwrap();
    let operation: String = tx.query_row("SELECT operation_id FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert!(edit_profile(&library, json!({"heightCm":170})).is_err());
    let db = library.connection().unwrap();
    let mut source = confirmed_person(&db, "p").unwrap().unwrap()["stashdbProfile"].clone();
    source["heightCm"] = json!(165);
    db.execute("INSERT INTO notes_state(key,value) VALUES(?1,?2)", params![profile_prediction_key(&operation), source.to_string()]).unwrap();
    drop(db);
    edit_profile(&library, json!({"heightCm":170})).unwrap();
    let body: String = library.connection().unwrap().query_row("SELECT payload FROM collection_authority_outbox ORDER BY seq DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["expected"]["heightCm"], json!({"value":165,"overridden":false}));
}

fn edit_profile(library: &Library, changes: Value) -> Result<Value, LibraryError> {
    let initial = library.av_person_profile_state("p")?;
    let expected = changes.as_object().unwrap().keys().map(|field| (field.clone(), profile_field_token(&initial, field))).collect::<serde_json::Map<_, _>>();
    library.set_av_person_profile_fields("p", changes, Value::Object(expected))
}

#[test]
fn collection_authority_manual_profile_discard_without_current_reprojects_names_and_profile() {
    let (_temp, library, status) = manual_profile_fixture();
    edit_profile(&library, json!({"displayName":"discarded","nameJa":"discarded ja","heightCm":170})).unwrap();
    let operation: String = library.connection().unwrap().query_row("SELECT operation_id FROM collection_authority_outbox ORDER BY seq LIMIT 1", [], |r| r.get(0)).unwrap();
    // A legacy blocked row has no current.person in its definitive refusal.
    library.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='blocked',conflict_code='unsupportedCollectionCommand',conflict_detail='{\"code\":\"unsupportedCollectionCommand\"}'", []).unwrap();
    // Simulate a later FIFO intent; discard must retain this prediction.
    {
        let mut db = library.connection().unwrap(); let tx = db.transaction().unwrap();
        enqueue_collection_command(&tx, &status, "setPersonProfileFields", "p", json!({"personId":"p","changes":{"cup":"D"},"expected":{"cup":{"value":"C","overridden":false}}})).unwrap();
        tx.commit().unwrap();
    }
    library.resolve_av_person_profile_conflict("p", &operation, false).unwrap();
    let db = library.connection().unwrap();
    let names: (String, Option<String>) = db.query_row("SELECT display_name,name_ja FROM collection_people WHERE id='p'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    let confirmed = confirmed_person(&db,"p").unwrap().unwrap();
    assert_eq!(names.0, confirmed["displayName"].as_str().unwrap());
    assert_eq!(names.1.as_deref(), confirmed["nameJa"].as_str());
    let fields: (i64, String) = db.query_row("SELECT height_cm,cup FROM collection_person_profiles WHERE person_id='p'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(fields, (160,"D".into()));
}
#[test]
fn collection_authority_manual_profile_unsupported_drops_and_allows_next_person_intent() {
    let (_temp, library, status) = manual_profile_fixture();
    edit_profile(&library,json!({"displayName":"discarded","heightCm":170})).unwrap();
    library.save_av_person_memo("p",Some("next memo".into())).unwrap();
    let mut delivered = Vec::new();
    library.flush_collection_outbox_with(&status,&|body| {
        if body["commandType"] == "setPersonProfileFields" { return Ok(CollectionDelivery::Dropped(json!({"code":"unsupportedCollectionCommand"}))); }
        let state=predicted_person(&*library.connection().unwrap(),"p").unwrap();
        Ok(CollectionDelivery::Accepted(person_receipt(&status,body,state,1)))
    },0).unwrap();
    let db=library.connection().unwrap();
    delivered.extend(db.prepare("SELECT state FROM collection_authority_outbox ORDER BY seq").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().map(Result::unwrap));
    assert_eq!(delivered, ["dropped","accepted"]);
    assert_eq!(db.query_row("SELECT height_cm FROM collection_person_profiles WHERE person_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),160);
    drop(db);
    assert_eq!(library.get_av_performer("p").unwrap().person.display_name,"Display");
    assert_eq!(library.av_person_profile_state("p").unwrap()["profileMessage"],"서버가 아직 프로필 편집을 지원하지 않습니다.");
}
#[test]
fn collection_authority_manual_profile_tokens_remain_frozen_after_confirmed_change() {
    let (_temp, library, status)=manual_profile_fixture();
    let initial=library.av_person_profile_state("p").unwrap();
    let expected=json!({"heightCm":profile_field_token(&initial,"heightCm")});
    {
        let mut db=library.connection().unwrap();let tx=db.transaction().unwrap();
        let mut newer=confirmed_person(&tx,"p").unwrap().unwrap();
        newer["entityRevision"]=json!(2);newer["profile"]["heightCm"]=json!(180);newer["profileOverrides"]["heightCm"]=json!(180);
        receive_person(&tx,&newer,NOW).unwrap();tx.commit().unwrap();
    }
    library.set_av_person_profile_fields("p",json!({"heightCm":170}),expected.clone()).unwrap();
    let body:String=library.connection().unwrap().query_row("SELECT payload FROM collection_authority_outbox ORDER BY seq LIMIT 1",[],|r|r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["expected"],expected);
    library.flush_collection_outbox_with(&status,&|body| {
        let current=confirmed_person(&*library.connection().unwrap(),"p").unwrap().unwrap();
        assert_ne!(body["expected"]["heightCm"],profile_field_token(&current,"heightCm"));
        Ok(CollectionDelivery::Conflict(json!({"code":"revisionConflict","current":{"person":current}})))
    },0).unwrap();
    assert_eq!(library.av_person_profile_state("p").unwrap()["profileConflicts"][0]["code"],"revisionConflict");
}
#[test]
fn collection_authority_manual_profile_status_noop_does_not_fire_notes_hook() {
    let (_temp,library,status)=manual_profile_fixture();
    let db=library.connection().unwrap();
    db.execute_batch("CREATE TEMP TABLE status_wakes(count INTEGER); INSERT INTO status_wakes VALUES(0); CREATE TEMP TRIGGER profile_status_wake AFTER UPDATE ON main.notes_state WHEN NEW.key='personProfileFieldsStatus' BEGIN UPDATE status_wakes SET count=count+1; END;").unwrap();
    store_profile_features_status(&db,&status).unwrap();
    store_profile_features_status(&db,&status).unwrap();
    assert_eq!(db.query_row("SELECT count FROM status_wakes",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let mut changed=status.clone();changed.features.push("future".into());
    store_profile_features_status(&db,&changed).unwrap();
    assert_eq!(db.query_row("SELECT count FROM status_wakes",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
#[test]
fn collection_authority_manual_profile_conflicts_exclude_other_person_commands() {
    let (_temp,library,_status)=manual_profile_fixture();
    edit_profile(&library,json!({"heightCm":170})).unwrap();
    library.save_av_person_memo("p",Some("memo".into())).unwrap();
    library.connection().unwrap().execute("UPDATE collection_authority_outbox SET state='blocked',conflict_code='revisionConflict',conflict_detail='{}'",[]).unwrap();
    let state=library.av_person_profile_state("p").unwrap();
    assert_eq!(state["profileConflicts"].as_array().unwrap().len(),1);
    assert_eq!(library.connection().unwrap().query_row("SELECT COUNT(*) FROM collection_authority_outbox WHERE state='blocked'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
}

#[test]
fn collection_authority_person_metadata_reads_pending_intents_once_per_list() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    let (_temp,library,_status)=manual_profile_fixture();
    edit_profile(&library,json!({"heightCm":170})).unwrap();
    let db=library.connection().unwrap();
    let reads=Arc::new(AtomicUsize::new(0)); let counted=reads.clone();
    db.authorizer(Some(move |context: AuthContext<'_>| {
        if matches!(context.action,AuthAction::Read{table_name:"collection_authority_outbox",column_name:"payload"}) { counted.fetch_add(1,Ordering::Relaxed); }
        Authorization::Allow
    })).unwrap();
    // Three independent projections used to perform three scans of the entire outbox.
    for _ in 0..3 { person_display_metadata(&db,"p").unwrap(); }
    assert_eq!(reads.load(Ordering::Relaxed),3);
    reads.store(0,Ordering::Relaxed);
    let metadata=PersonDisplayMetadata::read(&db).unwrap();
    for _ in 0..3 { assert_eq!(metadata.person(&db,"p").unwrap()["profile"]["heightCm"],170); }
    assert_eq!(reads.load(Ordering::Relaxed),1);
    reads.store(0,Ordering::Relaxed);
    super::super::av_collection::details(&db,"av").unwrap();
    assert_eq!(reads.load(Ordering::Relaxed),1);
}

#[test]
fn collection_authority_manual_profile_unsupported_conflict_is_a_definitive_refusal() {
    let (_temp,library,status)=manual_profile_fixture();
    edit_profile(&library,json!({"heightCm":170})).unwrap();
    library.flush_collection_outbox_with(&status,&|_| Ok(CollectionDelivery::Conflict(json!({"code":"unsupportedCollectionCommand"}))),0).unwrap();
    assert_eq!(library.connection().unwrap().query_row("SELECT state FROM collection_authority_outbox ORDER BY seq LIMIT 1",[],|r|r.get::<_,String>(0)).unwrap(),"dropped");
    assert_eq!(library.av_person_profile_state("p").unwrap()["profile"]["heightCm"],160);
}
