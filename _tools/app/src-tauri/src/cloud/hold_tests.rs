use super::client::CloudClient;
use crate::library::{error::LibraryError, home_publications::HomeTransport, Library};
use serde_json::json;

fn held<T>(result: Result<T, LibraryError>) {
    assert!(matches!(result, Err(LibraryError::CloudSyncHeld)));
}

fn fixture() -> (
    tempfile::TempDir,
    Library,
    CloudClient,
    std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    library.use_machine_settings(temp.path().join("machine.json"));
    library
        .set_cloud_sync_config(super::models::CloudSyncConfig {
            enabled: true,
            api_base_url: Some("http://127.0.0.1".into()),
        })
        .unwrap();
    library
        .set_cloud_sync_hold("http://127.0.0.1", true)
        .unwrap();
    let (mut client, requests) = CloudClient::home_test_client(vec![]);
    client.gate = library.sync_gate(client.base()).unwrap();
    (temp, library, client, requests)
}

#[test]
fn hold_fences_publications_signed_uploads_acknowledgements_and_commands() {
    let (temp, _library, client, requests) = fixture();
    let api = "fixture-api";
    let publisher = "fixture-publisher";
    held(client.publish_collections(b"{}", api));
    held(client.publish_characters(publisher, b"{}"));
    held(client.publish_character_review_feed(publisher, b"{}"));
    held(client.publish_similarity_review_feed(publisher, b"{}"));
    held(client.publish_catalog_duplicates(publisher, b"{}"));
    held(client.publish_release_unread(publisher, b"{}"));
    held(client.publish_catalog_visibility(&json!({}), api));
    held(client.publish_album_replica(api, &json!({})));
    held(client.publish_classification_snapshot(
        api,
        &super::models::ClassificationSnapshotPublish {
            snapshot_version: 1,
            entries: &[],
            assignments: &[],
            roles: &[],
            published_at: "now",
        },
    ));
    held(client.publish_saved_x_media_snapshot(
        api,
        &super::models::SavedXMediaSnapshotPublish { keys: &[] },
    ));
    held(client.acknowledge_capture_imported("capture", api, "2026-10-04T00:00:00Z"));
    held(client.create_extension_pairing(api));
    held(client.asset_request("/v1/assets/authority/commands", Some(&json!({})), publisher));
    held(client.asset_request(
        "/v1/library/assets/a/media-ticket/other",
        Some(&json!({})),
        api,
    ));
    held(client.publish("/v1/home/av-pick", None, publisher));
    held(client.publish("/v1/home/upcoming", Some(&json!({})), publisher));
    held(client.publish("/v1/library/artists", Some(&json!({})), publisher));
    held(client.publish("/v1/library/auto-tags", Some(&json!({})), publisher));
    held(client.upload_replication_variant("asset", "image/webp", vec![1], publisher));
    held(client.upload_metadata_backup(
        std::fs::File::create(temp.path().join("backup")).unwrap(),
        api,
    ));
    let blob = super::collections::ArtworkBlob {
        sha256: "a".repeat(64),
        content_type: "image/webp".into(),
        size_bytes: 1,
        object_key: "artwork".into(),
    };
    held(client.upload_collection_artwork(&blob, &[1], api));
    let prepared = super::thumbnail_upload::PreparedThumbnail {
        upload_id: "upload".into(),
        upload_url: Some("http://127.0.0.1/signed".into()),
        required_headers: Default::default(),
        asset_id: "asset".into(),
        thumbnail_key: "thumb".into(),
        committed: false,
    };
    held(client.put_thumbnail(&prepared, &[1]));
    held(client.report_collection_binding_result(
        publisher,
        1,
        &super::collection_bindings::BindResult {
            version: 1,
            state: "applied".into(),
            reason: None,
        },
    ));
    assert!(requests.lock().unwrap().is_empty());
}

#[test]
fn hold_manual_workers_leave_dirty_generations_and_queues_untouched() {
    let (_temp, library, client, requests) = fixture();
    library.connection().unwrap().execute_batch("
        INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at)
        VALUES('upload','asset','asset','upsert','pending',1,'now');
        INSERT INTO album_authority_outbox(operation_id,command_type,album_id,epoch,payload,created_at)
        VALUES('album','renameAlbum','album',1,'{}','now');
        INSERT INTO classification_authority_outbox(operation_id,command_type,classification_id,epoch,payload,created_at)
        VALUES('classification','renameClassification','classification',1,'{}','now');
        INSERT INTO catalog_bookmark_outbox(operation_id,provider,work_id,desired_state,epoch,base_revision,created_at)
        VALUES('bookmark','khentai','work',1,1,0,'now');
        INSERT INTO asset_lifecycle_outbox(operation_id,library_id,epoch,contract_version,asset_id,desired,expected_revision,created_at)
        VALUES('trash','library',1,1,'asset','trash',1,'now');
    ").unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE mobile_publication_state SET generation=7,published_generation=2",
            [],
        )
        .unwrap();
    let before = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT SUM(published_generation) FROM mobile_publication_state",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    held(library.push_cloud_collections_with(
        &client,
        client.base(),
        "api",
        Some("publisher"),
        &|_| {},
    ));
    held(library.push_cloud_characters_with(
        &client,
        client.base(),
        "api",
        Some("publisher"),
        None,
        &|_| {},
    ));
    held(library.push_cloud_collections(&|_| {}));
    held(library.push_cloud_characters(&|_| {}));
    held(library.push_cloud_catalog(&|_| {}));
    held(library.push_cloud_metadata_backup());
    held(library.run_cloud_backfill_cycle());
    held(library.sync_next_cloud_capture_with(&client, "api"));
    held(library.flush_album_outbox_with(&client, "api"));
    held(library.flush_catalog_bookmark_outbox_with(&client, "api"));
    held(library.flush_classification_outbox());
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT SUM(published_generation) FROM mobile_publication_state",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        before
    );
    assert!(library.cloud_backfill_progress().unwrap().sync_held);
    for (table, column) in [
        ("cloud_sync_queue", "status"),
        ("album_authority_outbox", "state"),
        ("classification_authority_outbox", "state"),
        ("asset_lifecycle_outbox", "status"),
    ] {
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(&format!("SELECT {column} FROM {table}"), [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "pending"
        );
    }
    assert_eq!(library.pending_intent_count().unwrap(), 1);
    let unread_status = || -> Result<super::client::SyncStatus, LibraryError> {
        panic!("unresolved outbox must defer receive")
    };
    assert!(
        library
            .reconcile_album_authority_with_status(&client, "api", &unread_status, false)
            .unwrap()
            .deferred_to_outbox
    );
    assert!(
        library
            .reconcile_classification_authority_with_status(&client, "api", &unread_status, false)
            .unwrap()
            .deferred_to_outbox
    );
    let status = super::client::SyncStatus {
        protocol_version: 1,
        active: true,
        library_id: Some(library.library_id().unwrap()),
        publisher_logs: None,
        domains: vec![super::client::SyncAuthorityDomain {
            domain: "assets".into(),
            library_id: library.library_id().unwrap(),
            epoch: 2,
            contract_version: 1,
            cursor: 0,
        }],
    };
    let received = library
        .sync_assets_with_status(
            &client,
            "api",
            Some("publisher"),
            false,
            &|| Ok(status.clone()),
            false,
        )
        .unwrap();
    assert!(!received.stopped);
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT operation_id FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "trash"
    );
    assert!(requests.lock().unwrap().is_empty());
}

#[test]
fn hold_receives_tablet_pages_without_publishing_and_restart_restores_sends() {
    let (_temp, library, _, _) = fixture();
    let endpoint = "http://127.0.0.1";
    let id = library.library_id().unwrap();
    library
        .adopt_collection_personal_edit_library(endpoint, &id)
        .unwrap();
    let page = |after, next, more| {
        json!({"version":1,"libraryId":id,"after":after,"nextCursor":next,"hasMore":more,
        "items":[{"sequence":next,"operationId":format!("op-{next}"),"collectionId":"missing","field":"showcase","value":true,"previous":false,"createdAt":"2026-10-04T00:00:00Z"}]})
    };
    let (mut client, requests) =
        CloudClient::home_test_client(vec![page(0, 1, true), page(1, 2, false)]);
    client.gate = library.sync_gate(endpoint).unwrap();
    assert_eq!(
        library
            .receive_collection_personal_edits_with(&client, "publisher", endpoint, 1)
            .unwrap(),
        Some(0)
    );
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM mobile_collection_personal_edit_receipts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests.iter().all(|r| r.starts_with(b"GET ")));
    drop(requests);
    let status = library.set_cloud_sync_hold(endpoint, false).unwrap();
    assert!(status.held && status.release_after_restart);
    held(client.publish("/v1/home/av-pick", None, "publisher"));
    // A fresh session reads the persisted release, as a fresh process would.
    let mut reopened = library.clone();
    reopened.simulate_sync_hold_restart();
    let (mut normal, requests) = CloudClient::home_test_client(vec![json!({"version":1})]);
    normal.gate = reopened.sync_gate(endpoint).unwrap();
    normal
        .publish("/v1/home/av-pick", None, "publisher")
        .unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[test]
fn hold_allows_status_and_required_download_ticket_post() {
    let (_temp, library, _, _) = fixture();
    let (mut client, requests) = CloudClient::home_test_client(vec![
        json!({"protocolVersion":1,"active":false,"libraryId":null,"domains":[]}),
        json!({"url":"https://media.invalid/original"}),
    ]);
    client.gate = library.sync_gate(client.base()).unwrap();
    assert!(!client.sync_status("api").unwrap().active);
    let ticket = client
        .asset_request(
            "/v1/library/assets/asset-id/media-ticket",
            Some(&json!({"variant":"original"})),
            "api",
        )
        .unwrap();
    assert_eq!(ticket["url"], "https://media.invalid/original");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with(b"GET /v1/sync/status "));
    assert!(requests[1].starts_with(b"POST /v1/library/assets/asset-id/media-ticket "));
}

#[test]
fn production_client_constructor_without_gate_fails_closed() {
    let client = CloudClient::new_unconfigured("http://127.0.0.1").unwrap();
    assert!(client.held());
    held(client.publish_collections(b"{}", "api"));
}

#[test]
fn held_logs_stop_before_missing_targets_and_keep_their_receipts_empty() {
    use crate::cloud::{characters::ExclusionEntry, similarity_review::DecisionEntry};
    use crate::library::character_review_sync::ReviewDecisionEntry;
    let (_temp, library, client, _) = fixture();
    let endpoint = client.base();
    let id = library.library_id().unwrap();
    library
        .adopt_character_exclusion_library(endpoint, &id)
        .unwrap();
    library
        .adopt_character_review_library(endpoint, &id)
        .unwrap();
    library
        .adopt_similarity_review_library(endpoint, &id)
        .unwrap();
    let value = json!({"sequence":1,"operationId":"op-1","targetId":"character-missing","assetId":"asset-missing", "assetSha256":"a".repeat(64),"createdAt":"2026-10-04T00:00:00Z","decision":"accepted","origin":"viewer","basis":null});
    let exclusion: ExclusionEntry = serde_json::from_value(value.clone()).unwrap();
    let review: ReviewDecisionEntry = serde_json::from_value(value).unwrap();
    let similarity: DecisionEntry = serde_json::from_value(json!({"sequence":1,"operationId":"op-1","reviewId":"pair-missing","decision":"keep_both","aAssetId":"a-missing","bAssetId":"b-missing","trashAssetId":null,"withdraws":null,"basis":{"feedRevision":"feed-1","aSha256":"a".repeat(64),"bSha256":"b".repeat(64)},"createdAt":"2026-10-04T00:00:00Z"})).unwrap();
    assert_eq!(
        library
            .apply_character_exclusion_page(endpoint, &id, std::slice::from_ref(&exclusion))
            .unwrap(),
        (0, 0, 0)
    );
    assert_eq!(
        library
            .apply_character_review_page(endpoint, &id, std::slice::from_ref(&review))
            .unwrap()
            .skipped,
        0
    );
    assert_eq!(
        library
            .apply_similarity_review_page(endpoint, &id, &[similarity], &Default::default())
            .unwrap()
            .skipped,
        0
    );
    for log in [
        "character_exclusion",
        "character_review",
        "similarity_review",
    ] {
        let db = library.connection().unwrap();
        let count: i64 = db
            .query_row(
                &format!("SELECT COUNT(*) FROM mobile_{log}_receipts"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        let cursor: i64 = db
            .query_row(
                &format!("SELECT received_cursor FROM mobile_{log}_sync"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((count, cursor), (0, 0), "{log}");
    }
    let status = library.cloud_sync_hold(endpoint).unwrap();
    assert_eq!(status.tablet_wait.count, 3);
    assert_eq!(
        status.tablet_wait.target_ids,
        [
            "a-missing",
            "asset-missing",
            "b-missing",
            "character-missing",
            "pair-missing"
        ]
    );
    assert_eq!(
        library
            .authority_sync_health()
            .unwrap()
            .sync_hold
            .unwrap()
            .tablet_wait,
        status.tablet_wait
    );
    library.connection().unwrap().execute("INSERT INTO character_targets(id,display_name,enabled,created_at,updated_at) VALUES('character-missing','Arrived',1,'now','now')", []).unwrap();
    assert_eq!(
        library
            .apply_character_exclusion_page(endpoint, &id, std::slice::from_ref(&exclusion))
            .unwrap(),
        (0, 0, 0)
    );
    assert_eq!(
        library
            .apply_character_review_page(endpoint, &id, std::slice::from_ref(&review))
            .unwrap()
            .skipped,
        0
    );
    let wait = library.cloud_sync_hold(endpoint).unwrap().tablet_wait;
    assert_eq!(wait.count, 3);
    assert!(wait.target_ids.contains(&"asset-missing".into()));
    assert!(!wait.target_ids.contains(&"character-missing".into()));
    assert_eq!(
        library
            .character_exclusion_adoption(endpoint)
            .unwrap()
            .unwrap()
            .1,
        0
    );
    assert_eq!(
        library
            .character_review_adoption(endpoint)
            .unwrap()
            .unwrap()
            .1,
        0
    );
}

#[test]
fn held_personal_edits_commit_only_the_prefix_then_resume_when_collection_arrives() {
    use crate::library::collection_personal_edits::PersonalEditEntry;
    let (_temp, library, client, _) = fixture();
    let endpoint = client.base();
    let id = library.library_id().unwrap();
    library
        .adopt_collection_personal_edit_library(endpoint, &id)
        .unwrap();
    library.connection().unwrap().execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('present','Present','game','now','now')", []).unwrap();
    let entries: Vec<PersonalEditEntry> = [(1,"present"),(2,"missing"),(3,"present")].into_iter().map(|(seq,target)| serde_json::from_value(json!({"sequence":seq,"operationId":format!("op-{seq}"),"collectionId":target,"field":"showcase","value":true,"previous":false,"createdAt":"2026-10-04T00:00:00Z"})).unwrap()).collect();
    let result = library
        .apply_collection_personal_edit_page(endpoint, &id, &entries)
        .unwrap();
    assert_eq!((result.changed, result.skipped), (1, 0));
    assert_eq!(
        library
            .collection_personal_edit_adoption(endpoint)
            .unwrap()
            .unwrap()
            .1,
        1
    );
    let wait = library.cloud_sync_hold(endpoint).unwrap().tablet_wait;
    assert_eq!(wait.count, 2);
    assert_eq!(wait.target_ids, ["missing"]);
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM mobile_collection_personal_edit_receipts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    library.connection().unwrap().execute("INSERT INTO collections(id,name,type,created_at,updated_at) VALUES('missing','Arrived','game','now','now')", []).unwrap();
    library
        .apply_collection_personal_edit_page(endpoint, &id, &entries)
        .unwrap();
    assert_eq!(
        library
            .collection_personal_edit_adoption(endpoint)
            .unwrap()
            .unwrap()
            .1,
        3
    );
    assert_eq!(
        library.cloud_sync_hold(endpoint).unwrap().tablet_wait.count,
        0
    );
}
