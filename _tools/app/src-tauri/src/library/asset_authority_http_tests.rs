    use super::*;
    #[test]
    #[ignore = "requires the isolated tests/asset_pc_fixture.py HTTP process, never production"]
    fn real_server_materialization_response_loss_and_lifecycle_converge_without_duplicate_upload() {
        let endpoint = std::env::var("LAKOMICS_ASSET_TEST_API").unwrap();
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        let publisher = std::env::var("LAKOMICS_ASSET_TEST_PUBLISHER").unwrap();
        let client = CloudClient::new(&endpoint).unwrap();
        let token = "asset-fixture-client";
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .connection()
            .unwrap()
            .execute("UPDATE library_settings SET library_id=?", ["e".repeat(32)])
            .unwrap();
        library
            .set_cloud_settings(
                crate::cloud::models::CloudSyncConfig {
                    enabled: true,
                    api_base_url: Some(endpoint),
                },
                true,
            )
            .unwrap();
        let first = library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        assert_eq!(first.materialized, 1);
        assert!(first.adopted);
        let id = library
            .connection()
            .unwrap()
            .query_row("SELECT asset_id FROM asset_authority_state", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        {
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT id FROM assets", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                id
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            db.execute("CREATE TABLE fixture_saved AS SELECT * FROM assets", [])
                .unwrap();
        }
        library.trash_assets(&[id.clone()]).unwrap();
        // The server accepted the immutable operation, but the PC lost the response.
        let body = {
            let db = library.connection().unwrap();
            let (op, rev): (String, i64) = db
                .query_row(
                    "SELECT operation_id,expected_revision FROM asset_lifecycle_outbox",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            db.execute("UPDATE asset_lifecycle_outbox SET status='sending'", [])
                .unwrap();
            json!({"libraryId":"e".repeat(32),"epoch":1,"contractVersion":1,"operationId":op,"commandType":"trashAsset","assetId":id,"expectedEntityRevision":rev})
        };
        client
            .asset_request("/v1/assets/authority/commands", Some(&body), &publisher)
            .unwrap();
        assert_eq!(
            library
                .sync_assets_with(&client, token, Some(&publisher), false)
                .unwrap()
                .flushed,
            1
        );
        let list = client
            .asset_request("/v1/library/assets", None, token)
            .unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 0);
        assert_eq!(
            client
                .asset_request(
                    &format!("/v1/assets/authority/status?libraryId={}", "e".repeat(32)),
                    None,
                    token
                )
                .unwrap()["cursor"],
            2
        );
        library.restore_assets(&[id.clone()]).unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        assert_eq!(
            client
                .asset_request("/v1/library/assets", None, token)
                .unwrap()["items"][0]["id"],
            id
        );
        library.trash_assets(&[id.clone()]).unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        library.empty_trash().unwrap();
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        client
            .asset_request("/_fixture/prune", Some(&json!({})), token)
            .unwrap();
        // Simulate recovery of a previously-known stale normal Asset after history expired.
        {
            let db = library.connection().unwrap();
            db.execute("INSERT INTO assets SELECT * FROM fixture_saved", [])
                .unwrap();
            db.execute("UPDATE asset_authority SET cursor=0", [])
                .unwrap();
        }
        library
            .sync_assets_with(&client, token, Some(&publisher), false)
            .unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            projection(&db, &id).unwrap().unwrap().lifecycle,
            "tombstoned"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
