    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;
    const ID: &str = "80000000-0000-4000-8000-000000000001";

    #[test]
    fn materialization_accepts_mov_and_large_videos_but_keeps_image_bound() {
        let mut projection = asset(&media());
        projection.kind = Some("video".into());
        for (mime, extension, size) in [
            ("video/quicktime", "mov", 1024),
            (
                "video/mp4",
                "mp4",
                super::super::ingestion::MAX_IMAGE_BYTES + 1,
            ),
            (
                "video/webm",
                "webm",
                super::super::ingestion::MAX_IMAGE_BYTES + 1,
            ),
            (
                "video/quicktime",
                "mov",
                super::super::ingestion::MAX_IMAGE_BYTES + 1,
            ),
        ] {
            projection.content_type = Some(mime.into());
            projection.size_bytes = Some(size);
            projection.validate().unwrap();
            assert_eq!(
                projection.materialization_media().unwrap(),
                (size, extension)
            );
        }
        projection.kind = Some("image".into());
        projection.content_type = Some("image/png".into());
        assert!(projection.materialization_media().is_err());
        projection.size_bytes = Some(super::super::ingestion::MAX_IMAGE_BYTES);
        assert_eq!(
            projection.materialization_media().unwrap(),
            (super::super::ingestion::MAX_IMAGE_BYTES, "png")
        );
    }

    #[test]
    fn image_text_projection_defaults_false_and_accepts_future_fields() {
        let mut raw = serde_json::to_value(asset(&media())).unwrap();
        raw.as_object_mut().unwrap().remove("hasImageText");
        raw["future"] = json!(1);
        assert!(
            !serde_json::from_value::<AssetProjection>(raw.clone())
                .unwrap()
                .has_image_text
        );
        raw["hasImageText"] = json!(true);
        assert!(
            serde_json::from_value::<AssetProjection>(raw)
                .unwrap()
                .has_image_text
        );
    }

    #[test]
    fn image_text_projection_fetches_missing_cache_and_retries_next_pass() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        p.has_image_text = true;
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_authority_state SET projection=?1",
                [serde_json::to_string(&p).unwrap()],
            )
            .unwrap();
        let text =
            super::super::image_text::validate(&json!([{"original":"hello","korean":"안녕"}]))
                .unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}/v1", server.server_addr())).unwrap();
        let expected = text.clone();
        let worker = std::thread::spawn(move || {
            for status in [500, 200] {
                let request = server
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.url(), format!("/v1/library/assets/{ID}/image-text"));
                assert_eq!(request.method().as_str(), "GET");
                request
                    .respond(
                        tiny_http::Response::from_string(serde_json::to_string(&expected).unwrap())
                            .with_status_code(status),
                    )
                    .unwrap();
            }
            // A populated cache must not be fetched on every idle authority pass.
            assert!(server
                .recv_timeout(std::time::Duration::from_millis(300))
                .unwrap()
                .is_none());
        });
        library
            .materialize_candidates(&client, "test", &mut AssetSyncResult::default(), false)
            .unwrap();
        assert!(library.asset_image_text(ID).unwrap().is_none());
        library
            .materialize_candidates(&client, "test", &mut AssetSyncResult::default(), false)
            .unwrap();
        assert_eq!(library.asset_image_text(ID).unwrap(), Some(text));
        library
            .materialize_candidates(&client, "test", &mut AssetSyncResult::default(), false)
            .unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn image_text_new_materialization_fetches_after_media_ingest() {
        let (_temp, library, mut p) = setup();
        p.has_image_text = true;
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_authority_state SET projection=?1",
                [serde_json::to_string(&p).unwrap()],
            )
            .unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let client = CloudClient::new(&base).unwrap();
        let text =
            super::super::image_text::validate(&json!([{"original":"hello","korean":"안녕"}]))
                .unwrap();
        let expected = text.clone();
        let worker = std::thread::spawn(move || {
            for path in [
                format!("/v1/library/assets/{ID}/media-ticket"),
                "/original".into(),
                format!("/v1/library/assets/{ID}/image-text"),
            ] {
                let request = server
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.url(), path);
                let body = if path.ends_with("media-ticket") {
                    json!({"url":format!("{base}/original")})
                        .to_string()
                        .into_bytes()
                } else if path == "/original" {
                    media()
                } else {
                    serde_json::to_vec(&expected).unwrap()
                };
                request
                    .respond(tiny_http::Response::from_data(body))
                    .unwrap();
            }
        });
        let mut result = AssetSyncResult::default();
        library
            .materialize_candidates(&client, "test", &mut result, false)
            .unwrap();
        assert_eq!(result.materialized, 1);
        assert_eq!(result.materialization_failures, 0);
        assert_eq!(library.asset_image_text(ID).unwrap(), Some(text));
        worker.join().unwrap();
    }
    #[test]
    fn workload_materialization_cap_preserves_pending_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        for n in 0..30 {
            library.connection().unwrap().execute("INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection) VALUES(?1,'normal',1,'{}')", [format!("id-{n:02}")]).unwrap();
        }
        assert_eq!(library.pending_materializations(true).unwrap().len(), 5);
        assert_eq!(library.pending_materializations(false).unwrap().len(), 25);
        assert_eq!(library.connection().unwrap().query_row("SELECT count(*) FROM asset_authority_state WHERE materialization='pending'", [], |r| r.get::<_, i64>(0)).unwrap(), 30);
    }

    #[test]
    fn known_hash_identity_conflict_is_parked_without_a_ticket_or_download() {
        let (temp, library, p) = setup();
        library.connection().unwrap().execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at)
             VALUES('local',?1,'image','local.png','assets/local.png','thumbnails/local.webp',1,1,1,'2026')",
            [p.sha256.as_deref().unwrap()],
        ).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}",server.server_addr())).unwrap();
        let mut first = AssetSyncResult::default();
        library.materialize_candidates(&client,"test",&mut first,false).unwrap();
        assert_eq!(first.materialization_failures,1);
        assert!(library.pending_materializations(false).unwrap().is_empty());
        assert!(library.asset_materialization_recovery_failure().unwrap().is_some());
        drop(library);
        let reopened = Library::open(temp.path()).unwrap();
        // Persisted conflicts are still parked after app restart.
        let mut second = AssetSyncResult::default();
        reopened.materialize_candidates(&client,"test",&mut second,false).unwrap();
        assert_eq!(second.materialization_failures,0);
        assert!(reopened.asset_materialization_recovery_failure().unwrap().is_some());
        assert!(server.recv_timeout(std::time::Duration::from_millis(50)).unwrap().is_none());
        assert_eq!(count(&reopened,"SELECT count(*) FROM assets WHERE id='local'"),1);
    }

    #[test]
    fn downloaded_integrity_mismatch_is_retried_then_parked_and_not_downloaded_again() {
        let (_temp, library, p) = setup();
        let server = std::sync::Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let base = format!("http://{}",server.server_addr());
        let client = CloudClient::new(&base).unwrap();
        let serve_corrupt = || {
            let serving = server.clone();
            let base = base.clone();
            std::thread::spawn(move || {
                let ticket = serving.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
                assert!(ticket.url().ends_with("/media-ticket"));
                ticket.respond(tiny_http::Response::from_string(json!({"url":format!("{base}/original")}).to_string())).unwrap();
                let original = serving.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
                assert_eq!(original.url(),"/original");
                let mut corrupt = media();
                corrupt[0] ^= 1;
                original.respond(tiny_http::Response::from_data(corrupt)).unwrap();
            })
        };
        let state = |library: &Library| -> String {
            library.connection().unwrap().query_row("SELECT materialization FROM asset_authority_state WHERE asset_id=?",[ID],|r|r.get(0)).unwrap()
        };
        for attempt in 1..=3 {
            let worker = serve_corrupt();
            let mut pass = AssetSyncResult::default();
            library.materialize_candidates(&client,"test",&mut pass,false).unwrap();
            worker.join().unwrap();
            assert_eq!(pass.materialization_failures,1);
            if attempt < 3 {
                // Corrupted-but-sized bytes are retried with backoff, not parked yet.
                assert_eq!(state(&library),"pending");
                assert!(library.pending_materializations(false).unwrap().is_empty());
                assert!(library.asset_materialization_recovery_failure().unwrap().is_none());
                library.connection().unwrap().execute("UPDATE asset_authority_state SET last_error=json_set(last_error,'$.retryAt',0) WHERE asset_id=?",[ID]).unwrap();
            }
        }
        assert_eq!(state(&library),"conflict");
        assert_eq!(count(&library,"SELECT count(*) FROM assets"),0);
        // A changed lifecycle and a regressed baseline cannot restart the loop.
        let mut changed = p.clone();
        changed.entity_revision = 2;
        apply(&library.connection().unwrap(),&changed).unwrap();
        apply_baseline(&library.connection().unwrap(),&p).unwrap();
        let mut after = AssetSyncResult::default();
        library.materialize_candidates(&client,"test",&mut after,false).unwrap();
        assert_eq!(after.materialization_failures,0);
        assert!(server.recv_timeout(std::time::Duration::from_millis(50)).unwrap().is_none());
        assert_eq!(library.asset_materialization_recovery_failure().unwrap().unwrap().code,"identity_or_integrity_conflict");
    }

    #[test]
    fn parked_local_hash_conflict_is_requeued_after_the_local_duplicate_is_removed() {
        let (_temp, library, p) = setup();
        library.connection().unwrap().execute(
            "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at)
             VALUES('local',?1,'image','local.png','assets/local.png','thumbnails/local.webp',1,1,1,'2026')",
            [p.sha256.as_deref().unwrap()],
        ).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}",server.server_addr())).unwrap();
        let mut pass = AssetSyncResult::default();
        library.materialize_candidates(&client,"test",&mut pass,false).unwrap();
        assert_eq!(pass.materialization_failures,1);
        assert!(library.asset_materialization_recovery_failure().unwrap().is_some());
        // While the duplicate exists the park holds.
        library.materialize_candidates(&client,"test",&mut pass,false).unwrap();
        assert!(library.pending_materializations(false).unwrap().is_empty());
        library.connection().unwrap().execute("DELETE FROM assets WHERE id='local'",[]).unwrap();
        let worker = std::thread::spawn(move || {
            // The re-queued asset is attempted again: it reaches the ticket request.
            let request = server.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            assert!(request.is_some());
        });
        library.materialize_candidates(&client,"test",&mut pass,false).unwrap();
        worker.join().unwrap();
        assert!(library.asset_materialization_recovery_failure().unwrap().is_none());
    }

    #[test]
    fn transient_materialization_retry_is_persisted_exponential_and_bounded() {
        let (temp, library, p) = setup();
        let now = chrono::Utc::now();
        let server = std::sync::Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let client = CloudClient::new(&format!("http://{}",server.server_addr())).unwrap();
        let serving = server.clone();
        let worker = std::thread::spawn(move || {
            serving.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap()
                .respond(tiny_http::Response::from_string("{}").with_status_code(503)).unwrap();
        });
        let mut first = AssetSyncResult::default();
        library.materialize_candidates(&client,"test",&mut first,false).unwrap();
        worker.join().unwrap();
        assert_eq!(first.materialization_failures,1);
        assert!(library.pending_materializations(false).unwrap().is_empty());
        assert!(library.asset_materialization_recovery_failure().unwrap().is_none());
        drop(library);
        let library = Library::open(temp.path()).unwrap();
        assert!(library.pending_materializations(false).unwrap().is_empty());
        let retry = |library: &Library| {
            let raw: String = library.connection().unwrap().query_row("SELECT last_error FROM asset_authority_state WHERE asset_id=?",[ID],|r|r.get(0)).unwrap();
            serde_json::from_str::<MaterializationFailure>(&raw).unwrap()
        };
        assert_eq!(retry(&library).attempts,1);
        assert!(retry(&library).retry_at >= now.timestamp() + MATERIALIZATION_RETRY_BASE_SECONDS);
        library.record_materialization_failure(&p,&LibraryError::CloudRequestUnavailable,now).unwrap();
        assert_eq!(retry(&library).retry_at,now.timestamp()+60);
        for _ in 0..20 {
            library.record_materialization_failure(&p,&LibraryError::CloudRequestUnavailable,now).unwrap();
        }
        assert_eq!(retry(&library).retry_at,now.timestamp()+MATERIALIZATION_RETRY_MAX_SECONDS);
        let mut second = AssetSyncResult::default();
        library.materialize_candidates(&client,"test",&mut second,false).unwrap();
        assert_eq!(second.materialization_failures,0);
        assert!(server.recv_timeout(std::time::Duration::from_millis(50)).unwrap().is_none());
        // Once due, a row is selectable again; attempt count survives the wait.
        library.connection().unwrap().execute("UPDATE asset_authority_state SET last_error=json_set(last_error,'$.retryAt',0) WHERE asset_id=?",[ID]).unwrap();
        assert_eq!(library.pending_materializations(false).unwrap().len(),1);
        assert_eq!(retry(&library).attempts,22);
    }
    fn media() -> Vec<u8> {
        let mut data = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut data, image::ImageFormat::Png)
            .unwrap();
        data.into_inner()
    }
    fn asset(bytes: &[u8]) -> AssetProjection {
        AssetProjection {
            has_image_text: false,
            asset_id: ID.into(),
            lifecycle: "normal".into(),
            entity_revision: 1,
            kind: Some("image".into()),
            object_key: Some("cloud/original".into()),
            content_type: Some("image/png".into()),
            size_bytes: Some(bytes.len() as u64),
            sha256: Some(
                Sha256::digest(bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect(),
            ),
            source_url: None,
            creator_name: None,
            creator_handle: None,
            collected_at: Some("2026-09-18T00:00:00Z".into()),
            source_published_at: None,
            import_source: Some("capture".into()),
            created_at: "2026-09-18T00:00:00Z".into(),
            updated_at: "2026-09-18T00:00:00Z".into(),
        }
    }
    fn setup() -> (tempfile::TempDir, Library, AssetProjection) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .set_cloud_settings(
                crate::cloud::models::CloudSyncConfig {
                    enabled: true,
                    api_base_url: Some("http://127.0.0.1:32146".into()),
                },
                true,
            )
            .unwrap();
        let p = asset(&media()); // Resolve identity before taking the library's non-reentrant DB lock.
        let id = library.library_id().unwrap();
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO asset_authority VALUES(1,?,1,1,0)", [id])
            .unwrap();
        apply(&tx, &p).unwrap();
        tx.commit().unwrap();
        drop(db);
        (temp, library, p)
    }
    fn ingest(library: &Library, p: &AssetProjection, bytes: &[u8]) -> Result<(), LibraryError> {
        let path = library.root().join("incoming.png");
        fs::write(&path, bytes).unwrap();
        library
            .ingest_media_with_identity(
                IngestMediaRequest {
                    source_path: path,
                    classification_id: None,
                    source_url: None,
                    collected_at: p.collected_at.clone(),
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::BrowserExtension,
                    import_batch_id: uuid::Uuid::new_v4().to_string(),
                },
                Some(&MaterializationIdentity {
                    asset_id: p.asset_id.clone(),
                    sha256: p.sha256.clone().unwrap(),
                    size_bytes: p.size_bytes.unwrap(),
                }),
            )
            .map(|_| ())
    }
    #[test]
    fn canonical_materialization_keeps_server_id_and_never_enqueues_upload() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        ingest(&library, &p, &media()).unwrap();
        assert_eq!(library.seed_cloud_backfill_queue().unwrap().seeded, 0);
        assert_eq!(
            library
                .seed_bounded_cloud_backfill(&[ID.into()])
                .unwrap()
                .newly_queued,
            0
        );
        assert_eq!(
            library.reconcile_cloud_backfill().unwrap().seeded_missing,
            0
        );
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            crate::cloud::queue::enqueue_asset_upsert(&tx, ID, "2026").unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT id FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            ID
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT materialization FROM asset_authority_state",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "complete"
        );
    }
    #[test]
    fn materialization_projects_deferred_organization_and_restore_preserves_it() {
        let (_temp, library, p) = setup();
        {
            let db = library.connection().unwrap();
            db.execute("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('class','root','Class','2026')",[]).unwrap();
            db.execute("INSERT INTO classification_authority_assignment_revisions VALUES(?,'class',1,'2026')",[ID]).unwrap();
            db.execute(
                "INSERT INTO albums(id,name,created_at) VALUES('album','Album','2026')",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO album_authority_membership_revisions VALUES('album',?,1,1,'2026')",
                [ID],
            )
            .unwrap();
        }
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT classification_id FROM asset_classifications WHERE asset_id=?",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "class"
        );
        assert_eq!(
            db.query_row(
                "SELECT album_id FROM asset_albums WHERE asset_id=?",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "album"
        );
        assert_eq!(
            db.query_row("SELECT content_hash FROM assets WHERE id=?", [ID], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            p.sha256.unwrap()
        );
    }
    fn defer_character_series(library: &Library, auto_classify: bool) {
        let db = library.connection().unwrap();
        db.execute(
            "INSERT INTO classification_entries(id,kind,name,created_at) VALUES('series','root','Series','2026')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO character_series(classification_id,auto_classify) VALUES('series',?)",
            [auto_classify],
        )
        .unwrap();
        db.execute(
            "INSERT INTO classification_authority_assignment_revisions VALUES(?,'series',1,'2026')",
            [ID],
        )
        .unwrap();
    }

    #[test]
    fn materialization_enqueues_character_work_after_deferred_assignment_without_restarting_it() {
        let (_temp, library, p) = setup();
        defer_character_series(&library, true);
        ingest(&library, &p, &media()).unwrap();
        {
            let db = library.connection().unwrap();
            let job: (String, String, i64, String) = db
                .query_row(
                    "SELECT state,cause,generation,classification_ids FROM character_autotag_jobs WHERE asset_id=?",
                    [ID],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .expect("materialization must enqueue after projecting the series assignment");
            assert_eq!(job.0, "pending");
            assert_eq!(job.1, "ingestion");
            assert_eq!(job.2, 1);
            assert_eq!(
                serde_json::from_str::<Vec<String>>(&job.3).unwrap(),
                ["series"]
            );
            db.execute(
                "UPDATE character_autotag_jobs SET state='completed' WHERE asset_id=?",
                [ID],
            )
            .unwrap();
        }
        ingest(&library, &p, &media()).unwrap();
        let db = library.connection().unwrap();
        let job: (String, i64) = db
            .query_row(
                "SELECT state,generation FROM character_autotag_jobs WHERE asset_id=?",
                [ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(job, ("completed".into(), 1));
        for table in [
            "cloud_sync_queue",
            "classification_authority_outbox",
            "asset_lifecycle_outbox",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "materialization must not create outbound work in {table}"
            );
        }
    }

    #[test]
    fn materialization_retry_enqueues_character_work_when_assignment_arrives_after_bytes() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM character_autotag_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        defer_character_series(&library, true);
        ingest(&library, &p, &media()).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT state FROM character_autotag_jobs WHERE asset_id=?",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "pending"
        );
    }

    #[test]
    fn materialization_character_work_respects_series_opt_out_and_projected_trash() {
        for (auto_classify, lifecycle) in [(false, "normal"), (true, "trash")] {
            let (_temp, library, mut p) = setup();
            defer_character_series(&library, auto_classify);
            p.lifecycle = lifecycle.into();
            p.entity_revision = 2;
            apply(&library.connection().unwrap(), &p).unwrap();
            ingest(&library, &p, &media()).unwrap();
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT status FROM assets WHERE id=?", [ID], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                lifecycle
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM character_autotag_jobs", [], |r| r.get::<_, i64>(0)).unwrap(),
                0,
                "excluded images must not be queued: auto_classify={auto_classify}, lifecycle={lifecycle}"
            );
        }
    }

    #[test]
    fn invalid_materialization_is_not_half_registered_and_retries_safely() {
        let (_temp, library, mut p) = setup();
        p.sha256 = Some("f".repeat(64));
        assert!(ingest(&library, &p, &media()).is_err());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let p = asset(&media());
        ingest(&library, &p, &media()).unwrap();
    }
    #[test]
    fn trash_restore_and_logical_delete_keep_confirmed_revision_separate_from_intent() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(projection(&db, ID).unwrap().unwrap().entity_revision, 1);
        assert_eq!(projection(&db, ID).unwrap().unwrap().lifecycle, "normal");
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT status FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "normal"
        );
        drop(db);
        library.trash_assets(&[ID.into()]).unwrap();
        assert_eq!(library.empty_trash().unwrap().deleted_count, 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT desired FROM asset_lifecycle_outbox ORDER BY sequence DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "tombstoned"
        );
        // Two-phase purge: the row stays (hidden as purge pending) until acceptance.
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_purge_pending", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(projection(&db, ID).unwrap().is_some());
    }
    #[test]
    fn a_local_only_asset_trashes_without_authority_state_and_queues_no_command() {
        // The cutover case: authority is adopted but this Asset was never committed, so
        // it has no canonical projection. Trashing it is legitimate local intent, not an
        // error, and it must not fabricate a lifecycle command for a server that cannot
        // resolve the Asset.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_authority_state", [])
            .unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "trash"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "a server-unknown Asset must not emit a lifecycle command"
        );
    }

    /// A local-only Asset that never reached the server, as the production cutover has.
    fn insert_local_only(library: &Library, id: &str, status: &str, hash: char) {
        insert_local_only_from(library, id, status, hash, ID);
    }

    /// Clone a specific source row so the copy's unique identity columns differ.
    fn insert_local_only_from(library: &Library, id: &str, status: &str, hash: char, source_id: &str) {
        let db = library.connection().unwrap();
        let cols: Vec<String> = db
            .prepare("PRAGMA table_info(assets)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let select: Vec<String> = cols
            .iter()
            .map(|c| match c.as_str() {
                "id" => "? AS id".to_string(),
                "content_hash" => "? AS content_hash".to_string(),
                "relative_path" => "? AS relative_path".to_string(),
                "thumbnail_relative_path" => "? AS thumbnail_relative_path".to_string(),
                "status" => "? AS status".to_string(),
                _ => c.clone(),
            })
            .collect();
        db.execute(
            &format!(
                "INSERT INTO assets SELECT {} FROM assets WHERE id=?",
                select.join(",")
            ),
            params![id, hash.to_string().repeat(64), format!("assets/ff/{id}"),
                    format!("assets/ff/{id}-thumb"), status, source_id],
        )
        .unwrap();
    }

    #[test]
    fn a_local_only_trash_asset_restores_without_an_authority_command() {
        // Required case 1: restore must succeed locally and must not fail because the
        // server has no canonical row for the Asset.
        let (_temp, library, _) = setup();
        let id = "80000000-0000-4000-8000-0000000000cc";
        ingest(&library, &asset(&media()), &media()).unwrap();
        insert_local_only(&library, id, "trash", 'a');
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_authority_state WHERE asset_id<>?", [ID])
            .unwrap();
        library.restore_assets(&[id.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets WHERE id=?", [id], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "normal"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox WHERE asset_id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "no command may be sent for an Asset the server does not own"
        );
    }

    #[test]
    fn a_restored_local_only_asset_is_eligible_for_normal_replication() {
        // Required case 2: after restore it is an ordinary PC-created Asset again, so the
        // legacy upload lane must pick it up exactly as it would a fresh ingest.
        let (_temp, library, _) = setup();
        let id = "80000000-0000-4000-8000-0000000000dd";
        ingest(&library, &asset(&media()), &media()).unwrap();
        insert_local_only(&library, id, "trash", 'b');
        library.restore_assets(&[id.into()]).unwrap();
        assert!(library.seed_cloud_backfill_queue().unwrap().seeded >= 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT status FROM cloud_sync_queue WHERE entity_id=? AND operation='upsert'",
                [id], |r| r.get::<_, String>(0))
                .unwrap(),
            "pending"
        );
        assert!(!super::is_server_owned(&db, id).unwrap(),
                "the Asset is still locally owned until the server commits it");
    }

    #[test]
    fn a_local_only_trash_asset_purges_without_a_tombstone_command() {
        // Required cases 3 and 4: purge succeeds locally, and the queued upload work is
        // cancelled so the purged Asset cannot be published afterwards.
        let (_temp, library, _) = setup();
        let id = "80000000-0000-4000-8000-0000000000ee";
        ingest(&library, &asset(&media()), &media()).unwrap();
        insert_local_only(&library, id, "trash", 'c');
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES('q1','asset',?,'upsert','pending',1,'2026')",
                [id],
            )
            .unwrap();
        let purged = library.empty_trash().unwrap();
        assert!(purged.deleted_count >= 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets WHERE id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue WHERE entity_id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "queued upload work must be cancelled so purge cannot be undone"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox WHERE asset_id=?", [id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn a_trashed_asset_racing_its_own_upload_keeps_the_trash_intent() {
        // Required case 5/6: the Asset is trashed locally while its upload is in flight,
        // and canonical `normal` arrives with no command ever sent. Adopting `normal`
        // would silently resurrect the user's trash.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        {
            let db = library.connection().unwrap();
            db.execute("DELETE FROM asset_authority_state", []).unwrap();
        }
        library.trash_assets(&[ID.into()]).unwrap();
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            apply(&tx, &p).unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox WHERE asset_id=? AND desired='trash'", [ID], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1,
            "the local trash must survive the server committing the Asset as normal"
        );
    }

    #[test]
    fn a_server_side_trash_is_adopted_even_after_a_local_trash() {
        // The mirror case: the local row already had canonical state, so an arriving
        // `trash` is the server's decision and must be adopted without fighting it.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        {
            let mut db = library.connection().unwrap();
            let mut trashed = p.clone();
            trashed.lifecycle = "trash".into();
            trashed.entity_revision = p.entity_revision + 1;
            let tx = db.transaction().unwrap();
            apply(&tx, &trashed).unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "trash"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "the server's own trash needs no command back"
        );
    }

    #[test]
    fn an_already_queued_command_is_not_duplicated_when_canonical_state_arrives() {
        // Response-loss shape: the command was accepted server-side but its reply was
        // lost, then canonical state arrives. The queued intent must not be rewritten
        // into a second command.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let before: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, 1);
        {
            let mut db = library.connection().unwrap();
            let mut normal = p.clone();
            normal.entity_revision = p.entity_revision + 5;
            let tx = db.transaction().unwrap();
            apply(&tx, &normal).unwrap();
            tx.commit().unwrap();
        }
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM asset_lifecycle_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            before,
            "a queued command already carries the intent; do not re-send it"
        );
    }

    #[test]
    fn the_production_cutover_shape_restores_purges_and_mixes_safely() {
        // Mirrors the real production cutover: authority adopted locally, 21 local trash
        // Assets with no canonical row, plus server-known trash Assets in the same
        // library. Every operation must work, and a mixed batch must not half-apply.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let local_only: Vec<String> = (0..21)
            .map(|i| format!("90000000-0000-4000-8000-0000000000{i:02x}"))
            .collect();
        for (i, id) in local_only.iter().enumerate() {
            // `content_hash` is UNIQUE, so each cloned row needs its own digest.
            insert_local_only(&library, id, "trash", char::from(b'a' + i as u8));
        }
        {
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM asset_authority_state", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1,
                "only the server-known Asset has canonical state, as in production"
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM assets WHERE status='trash'", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                22
            );
        }

        // A mixed batch: server-known Asset first, then a local-only one.
        library
            .restore_assets(&[ID.into(), local_only[0].clone()])
            .unwrap();
        {
            let db = library.connection().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM assets WHERE status='normal'", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2,
                "the batch must apply to both Assets without aborting"
            );
            // No command may name a local-only Asset, at any revision.
            let queued: Vec<String> = db
                .prepare("SELECT DISTINCT asset_id FROM asset_lifecycle_outbox")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(queued, vec![ID.to_string()],
                       "only the server-known Asset may be named in a lifecycle command");
        }

        // Purge the remaining local-only trashes in one call. Their managed bytes must
        // actually go: the server will never run GC for an Asset it never committed, so
        // leaving the file behind would orphan it on disk permanently.
        let root = library.root().to_path_buf();
        let probe = root.join(format!("assets/ff/{}", local_only[1]));
        fs::create_dir_all(probe.parent().unwrap()).unwrap();
        fs::write(&probe, b"local-only-bytes").unwrap();
        let purged = library.empty_trash().unwrap();
        assert_eq!(purged.deleted_count, 20);
        assert!(purged.failed_asset_ids.is_empty());
        assert!(!probe.exists(),
                "a purged local-only Asset must not leave its bytes behind");
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue WHERE operation='upsert' AND status<>'synced'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "purged local-only Assets leave no upload work behind"
        );
    }

    #[test]
    fn a_server_owned_trash_asset_purge_keeps_sending_its_tombstone() {
        // The behaviour the mixed batch above must not regress: a server-known Asset
        // still retires through the authority outbox when purged.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox", [])
            .unwrap();
        let purged = library.empty_trash().unwrap();
        assert_eq!(purged.deleted_count, 1);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT desired FROM asset_lifecycle_outbox ORDER BY sequence DESC LIMIT 1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "tombstoned"
        );
    }

    #[test]
    fn a_mixed_batch_trashes_both_and_commands_only_the_server_known_asset() {
        // A batch that mixes a server-known Asset with a local-only one must not abort:
        // the old code failed the whole call on whichever Asset lacked a projection.
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let local_only = "80000000-0000-4000-8000-0000000000bb";
        {
            let db = library.connection().unwrap();
            // Clone the ingested row, overriding only identity columns, so every other NOT
            // NULL column comes from the real schema instead of a hand-written list that
            // silently rots as the table grows.
            let cols: Vec<String> = db
                .prepare("PRAGMA table_info(assets)")
                .unwrap()
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let select: Vec<String> = cols
                .iter()
                .map(|c| match c.as_str() {
                    "id" => "? AS id".to_string(),
                    "content_hash" => "? AS content_hash".to_string(),
                    // The unique identity columns must differ from the source row.
                    "relative_path" => "? AS relative_path".to_string(),
                    "thumbnail_relative_path" => "? AS thumbnail_relative_path".to_string(),
                    _ => c.clone(),
                })
                .collect();
            db.execute(
                &format!("INSERT INTO assets SELECT {} FROM assets WHERE id=?", select.join(",")),
                params![local_only, "f".repeat(64),
                        format!("assets/ff/{local_only}"), format!("assets/ff/{local_only}-thumb"),
                        ID],
            )
            .unwrap();
        }
        library.trash_assets(&[ID.into(), local_only.into()]).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM assets WHERE status='trash'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let queued: Vec<String> = db
            .prepare("SELECT asset_id FROM asset_lifecycle_outbox ORDER BY asset_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(queued, vec![ID.to_string()],
                   "only the server-known Asset gets a command");
    }
    /// Every enqueue path must respect server ownership, not just the observed one.
    ///
    /// The `enqueue_asset_upsert` helper and the backfill seeders already refuse a
    /// server-owned Asset. `set_asset_classification` has its own direct INSERT for the
    /// legacy relation-only lane, so it is a separate path that can independently break
    /// the invariant. This covers it explicitly rather than trusting that the helper is
    /// the only writer.
    #[test]
    fn a_classification_mutation_never_uploads_a_server_owned_asset() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        // Legacy lane: Classification authority is NOT adopted, so the relation-only
        // upsert branch is live. Asset authority *is* adopted and owns this Asset.
        let classification = library
            .create_classification(crate::library::models::CreateClassification {
                kind: crate::library::models::ClassificationKind::Root,
                name: "fixture".into(),
                parent_id: None,
            })
            .unwrap();
        library
            .set_asset_classification(crate::library::models::SetAssetClassification {
                asset_ids: vec![ID.into()],
                classification_id: Some(classification.id.clone()),
            })
            .unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "a server-owned Asset must never be queued for media replication by a local classification change"
        );
    }

    /// The same guarantee for the other local-analysis lanes that normalize metadata.
    #[test]
    fn derived_local_analysis_never_uploads_a_server_owned_asset() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        // Similarity resolution and character automation both funnel through
        // `enqueue_asset_upsert`; drive it directly so this test owns the invariant
        // rather than one caller's incidental behavior.
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            crate::cloud::queue::enqueue_asset_upsert(&tx, ID, "2026").unwrap();
            crate::library::character_autotag::enqueue(
                &tx, ID, crate::library::character_autotag::Cause::Restore,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(library.seed_cloud_backfill_queue().unwrap().seeded, 0);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    /// The counter-case: a genuinely new locally-created Asset must still replicate.
    ///
    /// Suppressing every enqueue would satisfy the no-reupload invariant trivially while
    /// breaking the ordinary PC-created path, so this pins that the rule is scoped to
    /// server-owned Assets and not to "Assets that exist".
    #[test]
    fn a_locally_created_asset_still_queues_normal_replication() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .set_cloud_settings(
                crate::cloud::models::CloudSyncConfig {
                    enabled: true,
                    api_base_url: Some("http://127.0.0.1:32146".into()),
                },
                true,
            )
            .unwrap();
        let path = library.root().join("local.png");
        fs::write(&path, media()).unwrap();
        // No MaterializationIdentity: this is an ordinary local ingest, not a
        // server-owned Asset being materialized.
        library
            .ingest_media(IngestMediaRequest {
                source_path: path,
                classification_id: None,
                source_url: None,
                collected_at: Some("2026-09-18T00:00:00Z".into()),
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1,
            "an ordinary local Asset must still be replicated"
        );
    }

    /// `/v1/replication/commit` owns immutable media identity and provenance metadata,
    /// not user-owned fields, so a local title/favorite change has nothing to republish.
    /// This documents that boundary rather than assuming it.
    #[test]
    fn the_replication_contract_does_not_own_user_metadata() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.set_asset_favorite(ID, true).unwrap();
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT favorite FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        // A favorite is local-only, so it must not create replication work for a
        // server-owned Asset.
        assert_eq!(
            db.query_row("SELECT count(*) FROM cloud_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    fn count(library: &Library, sql: &str) -> i64 {
        library
            .connection()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
    fn files(library: &Library) -> (std::path::PathBuf, std::path::PathBuf) {
        let db = library.connection().unwrap();
        let (original, thumbnail): (String, String) = db
            .query_row(
                "SELECT relative_path,thumbnail_relative_path FROM assets WHERE id=?",
                [ID],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        (library.root().join(original), library.root().join(thumbnail))
    }
    /// A server-known Asset whose trash the server already confirmed (revision 2).
    fn confirmed_trash(library: &Library, p: &AssetProjection) {
        let mut trashed = p.clone();
        trashed.lifecycle = "trash".into();
        trashed.entity_revision = 2;
        apply(&library.connection().unwrap(), &trashed).unwrap();
    }
    fn authority_of(library: &Library) -> Authority {
        authority(&library.connection().unwrap()).unwrap().unwrap()
    }
    /// Answer lifecycle commands in order; returns the command bodies received.
    fn command_server(
        responses: Vec<(u16, Value)>,
    ) -> (CloudClient, std::thread::JoinHandle<Vec<Value>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let worker = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for (status, body) in responses {
                let mut request = server
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.url(), "/v1/assets/authority/commands");
                let mut raw = String::new();
                request.as_reader().read_to_string(&mut raw).unwrap();
                let sent: Value = serde_json::from_str(&raw).unwrap();
                let body = if status == 200 {
                    let mut body = body;
                    body["operationId"] = sent["operationId"].clone();
                    body
                } else {
                    body
                };
                bodies.push(sent);
                request
                    .respond(
                        tiny_http::Response::from_string(body.to_string()).with_status_code(status),
                    )
                    .unwrap();
            }
            bodies
        });
        (client, worker)
    }
    fn accepted_tombstone(library: &Library, p: &AssetProjection, revision: i64) -> Value {
        let mut tombstoned = p.clone();
        tombstoned.lifecycle = "tombstoned".into();
        tombstoned.entity_revision = revision;
        json!({"libraryId":library.library_id().unwrap(),"epoch":1,"contractVersion":1,
               "commandType":"tombstoneAsset","changed":true,"asset":tombstoned})
    }
    fn revision_conflict(revision: i64, lifecycle: &str) -> Value {
        json!({"detail":{"code":"revisionConflict","assetId":ID,
               "currentEntityRevision":revision,"lifecycle":lifecycle}})
    }

    #[test]
    fn a_remote_trash_starts_the_retention_clock_at_adoption() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        // A stale timestamp on a normal row must never shorten the adopted retention.
        library
            .connection()
            .unwrap()
            .execute("UPDATE assets SET trashed_at='2020-01-01T00:00:00Z' WHERE id=?", [ID])
            .unwrap();
        let before = chrono::Utc::now();
        confirmed_trash(&library, &p);
        let trashed_at: String = library
            .connection()
            .unwrap()
            .query_row("SELECT trashed_at FROM assets WHERE id=?", [ID], |r| r.get(0))
            .unwrap();
        let adopted = chrono::DateTime::parse_from_rfc3339(&trashed_at).unwrap();
        assert!(adopted >= before - chrono::Duration::seconds(1));
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 1);
        // Default retention is 30 days, counted from adoption.
        let early = library
            .purge_expired_trash(before + chrono::Duration::days(29))
            .unwrap();
        assert_eq!(early.deleted_count, 0);
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 1);
        let due = library
            .purge_expired_trash(before + chrono::Duration::days(31))
            .unwrap();
        assert_eq!(due.deleted_count, 1);
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
        // Re-adopting the same trash keeps the first adoption time.
        confirmed_trash(&library, &p);
        let again: String = library
            .connection()
            .unwrap()
            .query_row("SELECT trashed_at FROM assets WHERE id=?", [ID], |r| r.get(0))
            .unwrap();
        assert_eq!(again, trashed_at);
    }

    #[test]
    fn a_remote_restore_restores_the_local_row() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        p.entity_revision = 3;
        apply(&library.connection().unwrap(), &p).unwrap();
        assert_eq!(
            count(&library, "SELECT count(*) FROM assets WHERE status='normal' AND trashed_at IS NULL"),
            1
        );
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
    }

    #[test]
    fn emptying_keeps_the_row_and_files_until_the_tombstone_is_accepted_then_deletes_both() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        assert!(original.is_file() && thumbnail.is_file());

        assert_eq!(library.empty_trash().unwrap().deleted_count, 1);
        // Hidden from the trash, but nothing is deleted before acceptance.
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NULL"), 1);
        assert!(original.is_file() && thumbnail.is_file());
        // A second empty/purge does not queue a second tombstone or restore the row.
        library.empty_trash().unwrap();
        assert!(library.restore_assets(&[ID.into()]).is_ok());
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"),
            1
        );
        // An unrelated sync touching the Asset before acceptance keeps it intact.
        confirmed_trash(&library, &p);
        assert!(original.is_file());
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 1);

        let (client, worker) = command_server(vec![(200, accepted_tombstone(&library, &p, 3))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent[0]["commandType"], "tombstoneAsset");
        assert_eq!(sent[0]["expectedEntityRevision"], 2);
        assert_eq!(result.flushed, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NOT NULL"), 1);

        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_crash_after_acceptance_finishes_file_deletion_on_the_next_start() {
        let (temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        library.empty_trash().unwrap();
        let (client, worker) = command_server(vec![(200, accepted_tombstone(&library, &p, 3))]);
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default())
            .unwrap();
        worker.join().unwrap();
        // "Crash": the process ends before the file step runs.
        drop(library);
        assert!(original.is_file() && thumbnail.is_file());
        let reopened = Library::open(temp.path()).unwrap();
        let summary = reopened.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert!(summary.failed_asset_ids.is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&reopened, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_crash_before_acceptance_leaves_the_asset_intact() {
        let (temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        library.empty_trash().unwrap();
        drop(library);
        let reopened = Library::open(temp.path()).unwrap();
        reopened.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert!(original.is_file() && thumbnail.is_file());
        assert_eq!(count(&reopened, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(
            count(&reopened, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"),
            1
        );
    }

    #[test]
    fn a_tombstone_that_loses_to_a_restore_is_dropped_and_the_asset_comes_back() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, _) = files(&library);
        library.empty_trash().unwrap();
        let (client, worker) = command_server(vec![(409, revision_conflict(3, "normal"))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 1, "the tombstone must not be re-sent");
        assert_eq!(result.applied_changes, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(
            count(&library, "SELECT count(*) FROM assets WHERE status='normal' AND trashed_at IS NULL"),
            1
        );
        assert!(original.is_file());
        assert_eq!(projection(&library.connection().unwrap(), ID).unwrap().unwrap().entity_revision, 3);
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(original.is_file());
    }

    #[test]
    fn a_restore_that_wins_after_an_old_build_removed_the_row_re_materializes_it() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        library.empty_trash().unwrap();
        // Older builds deleted the row as soon as the tombstone was queued.
        library
            .connection()
            .unwrap()
            .execute_batch("DELETE FROM asset_purge_pending; DELETE FROM assets;")
            .unwrap();
        let (client, worker) = command_server(vec![(409, revision_conflict(3, "normal"))]);
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default())
            .unwrap();
        worker.join().unwrap();
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_authority_state WHERE materialization='pending' AND lifecycle='normal'"),
            1
        );
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
    }

    #[test]
    fn a_tombstone_conflicting_with_a_newer_trash_rebases_and_then_purges() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, _) = files(&library);
        library.empty_trash().unwrap();
        let (client, worker) = command_server(vec![
            (409, revision_conflict(4, "trash")),
            (200, accepted_tombstone(&library, &p, 5)),
        ]);
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default())
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1]["commandType"], "tombstoneAsset");
        assert_eq!(sent[1]["expectedEntityRevision"], 4);
        assert_ne!(sent[0]["operationId"], sent[1]["operationId"]);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 0);
        library.delete_accepted_purge_files().unwrap();
        assert!(!original.exists());
    }

    fn remote_tombstone(library: &Library, p: &AssetProjection) {
        let mut tombstoned = p.clone();
        tombstoned.lifecycle = "tombstoned".into();
        tombstoned.entity_revision = 3;
        let mut db = library.connection().unwrap();
        let tx = db.transaction().unwrap();
        apply(&tx, &tombstoned).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn a_tombstone_issued_elsewhere_deletes_this_pcs_own_files() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        let (original, thumbnail) = files(&library);
        remote_tombstone(&library, &p);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 0);
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NOT NULL"),
            1
        );
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
    }

    #[test]
    fn a_tombstone_issued_elsewhere_keeps_a_file_another_asset_references() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let (original, thumbnail) = files(&library);
        let other = "80000000-0000-4000-8000-0000000000aa";
        insert_local_only(&library, other, "normal", 'e');
        let shared: String = library
            .connection()
            .unwrap()
            .query_row("SELECT thumbnail_relative_path FROM assets WHERE id=?", [ID], |r| r.get(0))
            .unwrap();
        remote_tombstone(&library, &p);
        // Another remaining Asset names the same thumbnail file.
        library
            .connection()
            .unwrap()
            .execute("UPDATE assets SET thumbnail_relative_path=? WHERE id=?", params![shared, other])
            .unwrap();
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists(), "the Asset's own original goes");
        assert!(thumbnail.is_file(), "a file another Asset still names is kept");
    }

    #[test]
    fn a_crash_between_a_remote_tombstone_and_file_deletion_recovers_on_start() {
        let (temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let (original, thumbnail) = files(&library);
        remote_tombstone(&library, &p);
        // "Crash" before the file step.
        drop(library);
        assert!(original.is_file() && thumbnail.is_file());
        let reopened = Library::open(temp.path()).unwrap();
        assert!(reopened
            .purge_expired_trash(chrono::Utc::now())
            .unwrap()
            .failed_asset_ids
            .is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(&reopened, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_purge_pending_asset_without_its_intent_is_settled_not_stranded() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        confirmed_trash(&library, &p);
        library.empty_trash().unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox", [])
            .unwrap();
        // Still trash on the server: the tombstone is re-queued, the row stays hidden.
        library.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"),
            1
        );
        assert_eq!(library.list_trash(None, 20).unwrap().total_count, 0);
        // Restored on the server with the intent gone: the Asset comes back.
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox", [])
            .unwrap();
        let mut normal = p.clone();
        normal.entity_revision = 3;
        apply(&library.connection().unwrap(), &normal).unwrap();
        library.purge_expired_trash(chrono::Utc::now()).unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
    }

    #[test]
    fn remote_trash_restore_tombstone_never_enqueue_and_old_receipt_replay_does_not_resurrect() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let mut db = library.connection().unwrap();
        for (revision, lifecycle) in [(2, "trash"), (3, "normal"), (4, "tombstoned")] {
            p.entity_revision = revision;
            p.lifecycle = lifecycle.into();
            let tx = db.transaction().unwrap();
            apply(&tx, &p).unwrap();
            tx.commit().unwrap();
        }
        p.entity_revision = 1;
        p.lifecycle = "normal".into();
        let tx = db.transaction().unwrap();
        apply(&tx, &p).unwrap();
        tx.commit().unwrap();
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
            projection(&db, ID).unwrap().unwrap().lifecycle,
            "tombstoned"
        );
    }

    #[test]
    fn explicit_save_revive_downloads_again_under_same_id_and_old_events_stay_inert() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let path: String = library.connection().unwrap().query_row(
            "SELECT relative_path FROM assets WHERE id=?", [ID], |row| row.get(0),
        ).unwrap();
        p.lifecycle = "tombstoned".into();
        p.entity_revision = 2;
        apply(&library.connection().unwrap(), &p).unwrap();
        library.delete_accepted_purge_files().unwrap();
        assert!(!library.root().join(&path).exists());
        // A replayed legacy capture cannot allocate another local identity.
        let source = library.root().join("old-capture.png");
        fs::write(&source, media()).unwrap();
        let request = IngestMediaRequest {
            source_path: source, classification_id: None, source_url: None,
            collected_at: p.collected_at.clone(), replace_duplicate_metadata: false,
            source_published_at: None, creator_name: None, creator_handle: None,
            creator_url: None, import_source: ImportSource::BrowserExtension,
            import_batch_id: uuid::Uuid::new_v4().to_string(),
        };
        assert!(matches!(library.ingest_media(request),
            Err(LibraryError::AssetAuthorityRejected { code, .. }) if code == "captureRequiresExplicitSave"));
        let mut replay = p.clone();
        replay.lifecycle = "normal".into();
        replay.entity_revision = 1;
        apply(&library.connection().unwrap(), &replay).unwrap();
        rebaseline(&library, 1, vec![replay.clone()]);
        assert!(library.pending_materializations(false).unwrap().is_empty());
        replay.entity_revision = 2;
        assert!(apply(&library.connection().unwrap(), &replay).is_err());

        // The server's explicit-save event is newer than the retained tombstone.
        p.lifecycle = "normal".into();
        p.entity_revision = 3;
        apply(&library.connection().unwrap(), &p).unwrap();
        let pending = library.pending_materializations(false).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(serde_json::from_str::<AssetProjection>(&pending[0]).unwrap().asset_id, ID);
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let client = CloudClient::new(&base).unwrap();
        let worker = std::thread::spawn(move || {
            for expected in [format!("/v1/library/assets/{ID}/media-ticket"), "/original".into()] {
                let request = server.recv_timeout(std::time::Duration::from_secs(10)).unwrap().unwrap();
                assert_eq!(request.url(), expected);
                let body = if expected == "/original" { media() } else {
                    serde_json::to_vec(&json!({"url":format!("{base}/original")})).unwrap()
                };
                request.respond(tiny_http::Response::from_data(body)).unwrap();
            }
        });
        let mut result = AssetSyncResult::default();
        library.materialize_candidates(&client, "test", &mut result, false).unwrap();
        worker.join().unwrap();
        assert_eq!(result.materialized, 1);
        assert_eq!(result.materialization_failures, 0);
        assert!(library.root().join(path).exists());
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE id='80000000-0000-4000-8000-000000000001' AND status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM cloud_sync_queue"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert!(library.pending_materializations(false).unwrap().is_empty());
        // Replaying the earlier tombstone after revival cannot delete it again.
        replay.lifecycle = "tombstoned".into();
        apply(&library.connection().unwrap(), &replay).unwrap();
        assert_eq!(projection(&library.connection().unwrap(), ID).unwrap().unwrap().lifecycle, "normal");
    }

    #[test]
    fn explicit_save_revive_from_trash_keeps_materialized_bytes() {
        let (_temp, library, mut p) = setup();
        ingest(&library, &p, &media()).unwrap();
        p.lifecycle = "trash".into();
        p.entity_revision = 2;
        apply(&library.connection().unwrap(), &p).unwrap();
        p.lifecycle = "normal".into();
        p.entity_revision = 3;
        apply(&library.connection().unwrap(), &p).unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
        assert!(library.pending_materializations(false).unwrap().is_empty());
    }

    const OTHER: &str = "80000000-0000-4000-8000-0000000000b2";
    /// A second server-known Asset (a clone of the ingested row with its own bytes).
    fn second_projection() -> AssetProjection {
        let mut other = asset(&media());
        other.asset_id = OTHER.into();
        other.sha256 = Some("b".repeat(64));
        other
    }
    fn second_asset(library: &Library, status: &str) -> AssetProjection {
        insert_local_only(library, OTHER, status, 'b');
        let mut other = second_projection();
        other.lifecycle = status.into();
        apply(&library.connection().unwrap(), &other).unwrap();
        other
    }
    /// Answer baseline reads with one complete page for `epoch`.
    fn baseline_server(
        library: &Library,
        epoch: i64,
        items: Vec<AssetProjection>,
    ) -> (CloudClient, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = CloudClient::new(&format!("http://{}", server.server_addr())).unwrap();
        let body = json!({"libraryId":library.library_id().unwrap(),"epoch":epoch,"contractVersion":1,
                          "cursor":7,"items":items,"hasMore":false});
        let worker = std::thread::spawn(move || {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
                .unwrap();
            assert!(request.url().starts_with("/v1/assets/authority/baseline?"));
            request
                .respond(tiny_http::Response::from_string(body.to_string()))
                .unwrap();
        });
        (client, worker)
    }
    fn rebaseline(library: &Library, epoch: i64, items: Vec<AssetProjection>) {
        let (client, worker) = baseline_server(library, epoch, items);
        let mut a = authority_of(library);
        a.epoch = epoch;
        library.install_asset_baseline(&client, "token", &a).unwrap();
        worker.join().unwrap();
    }
    fn trash_accepted(library: &Library, p: &AssetProjection, revision: i64) -> Value {
        let mut trashed = p.clone();
        trashed.lifecycle = "trash".into();
        trashed.entity_revision = revision;
        json!({"libraryId":library.library_id().unwrap(),"epoch":1,"contractVersion":1,
               "commandType":"trashAsset","changed":true,"asset":trashed})
    }

    #[test]
    fn a_rebaseline_keeps_local_assets_it_does_not_list_and_requeues_their_upload() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        second_asset(&library, "trash");
        {
            let db = library.connection().unwrap();
            db.execute("INSERT INTO albums(id,name,created_at) VALUES('album','Album','2026')", []).unwrap();
            db.execute("INSERT INTO asset_albums(asset_id,album_id) VALUES(?,'album')", [ID]).unwrap();
            db.execute("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('class','root','Class','2026')", []).unwrap();
            db.execute("INSERT OR IGNORE INTO asset_classifications(asset_id,classification_id) VALUES(?,'class')", [ID]).unwrap();
            // Both were replicated before: the old queue rows say `synced`.
            for (n, id) in [ID, OTHER].iter().enumerate() {
                db.execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES(?,'asset',?,'upsert','synced',1,'2026')", params![format!("q{n}"), id]).unwrap();
            }
        }
        library.trash_assets(&[OTHER.into()]).unwrap();
        // A restored server authority backup that predates both Assets.
        rebaseline(&library, 2, vec![]);
        assert_eq!(count(&library, "SELECT count(*) FROM assets"), 2, "no local Asset is deleted");
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE id='80000000-0000-4000-8000-000000000001' AND status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE id='80000000-0000-4000-8000-0000000000b2' AND status='trash'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_albums"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_classifications"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT epoch FROM asset_authority"), 2);
        assert_eq!(
            count(&library, "SELECT count(*) FROM cloud_sync_queue WHERE status='pending'"),
            2,
            "both get a fresh upload"
        );
        assert_eq!(
            count(&library, "SELECT count(*) FROM cloud_sync_queue WHERE status='synced'"),
            0,
            "no stale evidence that the server still holds them"
        );
        // Other domains now see the Asset as not yet on the server, so their relation
        // intents wait for the re-upload instead of being sent and refused.
        {
            use crate::library::album_authority::{asset_intent_readiness, AssetIntentReadiness};
            let db = library.connection().unwrap();
            assert!(asset_intent_readiness(&db, ID).unwrap() == AssetIntentReadiness::Wait);
        }
        // Only the normal Asset is uploadable; the trashed one waits until it is restored.
        let claimed = library.claim_next_backfill_for_test().unwrap().unwrap();
        assert_eq!(claimed.queue.entity_id, ID);
        assert!(library.claim_next_backfill_for_test().unwrap().is_none());
    }

    /// Review follow-up: after a server authority restore, the Asset re-baseline settles
    /// before the relation baselines, so a re-uploaded Asset keeps its Album and
    /// Classification relations and they are queued again for the server.
    #[test]
    fn a_server_restore_keeps_and_resends_the_relations_of_a_lost_asset() {
        use crate::cloud::client::{
            AlbumProjection, ClassificationProjection, ClassificationRoleProjection,
            SyncAuthorityDomain, SyncStatus,
        };
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let lib = library.library_id().unwrap();
        library
            .adopt_album_authority_for_test(&lib, 1, 1, 5)
            .unwrap();
        library
            .adopt_classification_authority_for_test(&lib, 1, 1, 5)
            .unwrap();
        {
            let db = library.connection().unwrap();
            db.execute(
                "INSERT INTO albums(id,name,created_at) VALUES('album','Album','2026')",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO asset_albums(asset_id,album_id) VALUES(?,'album')",
                [ID],
            )
            .unwrap();
            db.execute(
                "INSERT INTO album_authority_membership_revisions VALUES('album',?,1,1,'2026')",
                [ID],
            )
            .unwrap();
            db.execute("INSERT INTO classification_entries(id,kind,name,created_at) VALUES('class','root','Class','2026')", []).unwrap();
            db.execute("INSERT OR IGNORE INTO asset_classifications(asset_id,classification_id) VALUES(?,'class')", [ID]).unwrap();
            db.execute("INSERT INTO classification_authority_assignment_revisions VALUES(?,'class',2,'2026')", [ID]).unwrap();
            db.execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES('q','asset',?,'upsert','synced',1,'2026')", [ID]).unwrap();
        }
        let domain = |name: &str, epoch: i64, cursor: i64| SyncAuthorityDomain {
            domain: name.into(),
            library_id: lib.clone(),
            epoch,
            contract_version: 1,
            cursor,
        };
        // The restored server lost the Asset: its Asset authority moved to a new identity.
        let status = SyncStatus {
            protocol_version: 1,
            active: true,
            library_id: Some(lib.clone()),
            domains: vec![
                domain("assets", 2, 7),
                domain("albums", 1, 3),
                domain("classifications", 1, 3),
            ],
            publisher_logs: None,
        };
        let (client, worker) = baseline_server(&library, 2, vec![]);
        assert_eq!(
            library
                .settle_asset_identity_with_status(&client, "token", &status)
                .unwrap(),
            Some(true)
        );
        worker.join().unwrap();
        // Settled: a second call does nothing (no server is listening any more).
        assert_eq!(
            library
                .settle_asset_identity_with_status(&client, "token", &status)
                .unwrap(),
            Some(false)
        );
        // The relation baselines of the restored server do not know the Asset.
        let album = AlbumProjection {
            id: "album".into(),
            name: "Album".into(),
            parent_id: None,
            icon_key: None,
            color_key: None,
            deleted: false,
            entity_revision: 1,
        };
        library
            .install_album_baseline_for_test(&[album], &[], &lib, 1, 1, 3)
            .unwrap();
        let class = |id: &str| ClassificationProjection {
            id: id.into(),
            kind: "root".into(),
            name: id.into(),
            parent_id: None,
            icon_key: None,
            color_key: None,
            deleted: false,
            entity_revision: 1,
        };
        let originals = ClassificationRoleProjection {
            role: "originals".into(),
            classification_id: "lakomics-originals".into(),
        };
        library
            .install_classification_baseline_for_test(
                &[class("lakomics-originals"), class("class")],
                &[],
                &[originals],
                &lib,
                1,
                1,
                3,
            )
            .unwrap();
        assert_eq!(
            count(
                &library,
                "SELECT count(*) FROM asset_albums WHERE album_id='album'"
            ),
            1
        );
        assert_eq!(
            count(
                &library,
                "SELECT count(*) FROM asset_classifications WHERE classification_id='class'"
            ),
            1
        );
        let db = library.connection().unwrap();
        let (album_payload, album_epoch): (String, i64) = db
            .query_row(
                "SELECT payload,epoch FROM album_authority_outbox WHERE state='pending'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let album_body: Value = serde_json::from_str(&album_payload).unwrap();
        assert_eq!(
            (
                album_body["desiredState"].as_bool(),
                album_body["expectedRevision"].as_i64(),
                album_epoch
            ),
            (Some(true), Some(0), 1)
        );
        let class_payload: String = db
            .query_row(
                "SELECT payload FROM classification_authority_outbox WHERE state='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let class_body: Value = serde_json::from_str(&class_payload).unwrap();
        assert_eq!(
            (
                class_body["classificationId"].as_str(),
                class_body["expectedRevision"].as_i64()
            ),
            (Some("class"), Some(0))
        );
        // Both wait for the re-upload rather than being sent and refused.
        use crate::library::album_authority::{asset_intent_readiness, AssetIntentReadiness};
        assert!(asset_intent_readiness(&db, ID).unwrap() == AssetIntentReadiness::Wait);
    }

    #[test]
    fn a_new_epoch_rebases_or_drops_queued_intents_instead_of_failing_every_pass() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        // Epoch 1: ID's trash is confirmed at r2 and a restore is queued; OTHER is
        // trashed and emptied (the purge replaces its queued trash with a tombstone).
        confirmed_trash(&library, &p);
        library.restore_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        library.empty_trash().unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 2);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 1);
        let old_ops: Vec<String> = library.connection().unwrap()
            .prepare("SELECT operation_id FROM asset_lifecycle_outbox").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        // Epoch 2 comes from an older backup: ID is trash at r1 (lower than confirmed),
        // OTHER is trash at r1.
        let mut id_trash = p.clone();
        id_trash.lifecycle = "trash".into();
        let mut other_trash = other.clone();
        other_trash.lifecycle = "trash".into();
        rebaseline(&library, 2, vec![id_trash, other_trash]);
        let rows: Vec<(String, String, i64, i64, String)> = library.connection().unwrap()
            .prepare("SELECT asset_id,desired,epoch,expected_revision,operation_id FROM asset_lifecycle_outbox ORDER BY sequence").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        // ID's restore is re-issued against the new baseline revision.
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2, rows[0].3), (ID, "normal", 2, 1));
        // OTHER's purge is re-issued against its new trash revision.
        assert_eq!((rows[1].0.as_str(), rows[1].1.as_str(), rows[1].2, rows[1].3), (OTHER, "tombstoned", 2, 1));
        assert!(rows.iter().all(|r| !old_ops.contains(&r.4)), "re-issued intents get new operation ids");
        assert_eq!(projection(&library.connection().unwrap(), ID).unwrap().unwrap().entity_revision, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 1);

        // A purge against an Asset the new baseline has as `normal` is dropped (restore wins).
        library.connection().unwrap()
            .execute("UPDATE asset_lifecycle_outbox SET epoch=1", []).unwrap();
        library.connection().unwrap()
            .execute("DELETE FROM asset_lifecycle_outbox WHERE asset_id=?", [ID]).unwrap();
        library.connection().unwrap()
            .execute("UPDATE asset_authority SET epoch=1", []).unwrap();
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox WHERE desired='tombstoned'"), 1);
        let mut other_normal = asset(&media());
        other_normal.asset_id = OTHER.into();
        other_normal.sha256 = Some("b".repeat(64));
        let mut id_normal = p.clone();
        id_normal.entity_revision = 1;
        rebaseline(&library, 3, vec![id_normal, other_normal]);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_purge_pending"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 2);
        assert_eq!(
            count(&library, "SELECT count(*) FROM asset_authority_state WHERE last_error='lifecycleRejected:epochChanged'"),
            1
        );
    }

    #[test]
    fn a_tombstone_conflict_at_the_head_is_adopted_and_later_intents_still_flush() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        // An older build parked this row; it must not stop the queue any more.
        library.connection().unwrap()
            .execute("UPDATE asset_lifecycle_outbox SET status='conflict' WHERE asset_id=?", [ID]).unwrap();
        let (client, worker) = command_server(vec![
            (409, revision_conflict(3, "tombstoned")),
            (200, trash_accepted(&library, &other, 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1]["assetId"], OTHER);
        assert!(!result.stopped);
        assert_eq!(result.flushed, 1);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        let db = library.connection().unwrap();
        let state = projection(&db, ID).unwrap().unwrap();
        assert_eq!((state.lifecycle.as_str(), state.entity_revision), ("tombstoned", 3));
        assert_eq!(db.query_row("SELECT count(*) FROM assets WHERE id=?", [ID], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            db.query_row("SELECT last_error FROM asset_authority_state WHERE asset_id=?", [ID], |r| r.get::<_, String>(0)).unwrap(),
            "lifecycleRejected:assetTombstoned"
        );
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [OTHER], |r| r.get::<_, String>(0)).unwrap(), "trash");
    }

    #[test]
    fn a_refused_restore_keeps_asset_detail_in_the_result_and_status() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        let (client, worker) = command_server(vec![(200, trash_accepted(&library, &p, 2))]);
        library.flush_assets(&client, "publisher", &authority_of(&library), &mut AssetSyncResult::default()).unwrap();
        worker.join().unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let (client, worker) = command_server(vec![
            (409, json!({"detail":{"code":"lifecycleTransitionRefused","assetId":ID}})),
        ]);
        let mut result = AssetSyncResult::default();
        library.flush_assets(&client, "publisher", &authority_of(&library), &mut result).unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent[0]["commandType"], "restoreAsset");
        assert_eq!(result.lifecycle_failures, vec![LifecycleIntentFailure {
            asset_id: ID.into(), desired: "normal".into(), reason: "lifecycleTransitionRefused".into(),
        }]);
        let name: String = library.connection().unwrap().query_row(
            "SELECT original_name FROM assets WHERE id=?", [ID], |row| row.get(0),
        ).unwrap();
        let health = library.authority_sync_health().unwrap();
        assert_eq!(health.assets.rejected_assets[0].asset_id, ID);
        assert_eq!(health.assets.rejected_assets[0].name, name);
        assert_eq!(health.assets.rejected_assets[0].reason, "lifecycleTransitionRefused");
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 1);
    }

    #[test]
    fn a_refused_head_intent_falls_back_to_server_state_and_does_not_block() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        let (client, worker) = command_server(vec![
            (409, json!({"detail":{"code":"lifecycleTransitionRefused","assetId":ID}})),
            (200, trash_accepted(&library, &other, 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 2);
        assert!(!result.stopped);
        assert_eq!(result.lifecycle_failures, vec![LifecycleIntentFailure {
            asset_id: ID.into(), desired: "trash".into(), reason: "lifecycleTransitionRefused".into(),
        }]);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        let db = library.connection().unwrap();
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [ID], |r| r.get::<_, String>(0)).unwrap(), "normal",
                   "the confirmed server state wins over the refused trash");
        assert_eq!(
            db.query_row("SELECT last_error FROM asset_authority_state WHERE asset_id=?", [ID], |r| r.get::<_, String>(0)).unwrap(),
            "lifecycleRejected:lifecycleTransitionRefused"
        );
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [OTHER], |r| r.get::<_, String>(0)).unwrap(), "trash");
    }

    #[test]
    fn a_trash_refused_because_the_tablet_kept_the_asset_is_rolled_back_without_blocking() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        let other = second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        let (client, worker) = command_server(vec![
            (
                409,
                json!({"detail":{"code":"similarityKeptByTabletDecision","assetId":ID,"reviewId":"r1","lifecycle":"normal"}}),
            ),
            (200, trash_accepted(&library, &other, 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 2, "the queue behind the refusal still runs");
        assert!(!result.stopped);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        let db = library.connection().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM assets WHERE id=?", [ID], |r| r.get::<_, String>(0)).unwrap(),
            "normal",
            "the local trash is undone: the tablet's decision kept this image"
        );
        assert_eq!(
            db.query_row("SELECT last_error FROM asset_authority_state WHERE asset_id=?", [ID], |r| r.get::<_, String>(0)).unwrap(),
            "lifecycleRejected:similarityKeptByTabletDecision"
        );
        assert_eq!(db.query_row("SELECT status FROM assets WHERE id=?", [OTHER], |r| r.get::<_, String>(0)).unwrap(), "trash");
    }

    #[test]
    fn an_asset_the_server_no_longer_knows_is_requeued_for_upload_not_blocking() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        library.trash_assets(&[ID.into()]).unwrap();
        library.restore_assets(&[ID.into()]).unwrap();
        let (client, worker) = command_server(vec![(404, json!({"detail":{"code":"assetNotFound"}}))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap().len(), 1, "the restore behind it is dropped with the Asset's server state");
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state"), 0);
        assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='normal'"), 1);
        assert_eq!(count(&library, "SELECT count(*) FROM cloud_sync_queue WHERE status='pending'"), 1);
    }

    /// The user already emptied this Asset from the trash; only the server's answer is pending.
    fn purge_pending(library: &Library, p: &AssetProjection) -> (std::path::PathBuf, std::path::PathBuf) {
        ingest(library, p, &media()).unwrap();
        confirmed_trash(library, p);
        let paths = files(library);
        library.connection().unwrap()
            .execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES('q','asset',?,'upsert','synced',1,'2026')", [ID]).unwrap();
        library.empty_trash().unwrap();
        assert_eq!(count(library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NULL"), 1);
        paths
    }
    fn assert_purge_finished_locally(library: &Library, original: &std::path::Path, thumbnail: &std::path::Path) {
        assert_eq!(count(library, "SELECT count(*) FROM assets"), 0, "a purged Asset never comes back");
        assert_eq!(count(library, "SELECT count(*) FROM cloud_sync_queue"), 0, "and is never re-uploaded");
        assert_eq!(count(library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
        assert_eq!(count(library, "SELECT count(*) FROM asset_purge_pending WHERE accepted_at IS NULL"), 0);
        assert!(library.delete_accepted_purge_files().unwrap().is_empty());
        assert!(!original.exists() && !thumbnail.exists());
        assert_eq!(count(library, "SELECT count(*) FROM asset_purge_pending"), 0);
    }

    #[test]
    fn a_rebaseline_without_a_purge_pending_asset_finishes_the_purge_instead_of_uploading() {
        let (_temp, library, p) = setup();
        let (original, thumbnail) = purge_pending(&library, &p);
        rebaseline(&library, 2, vec![]);
        assert_purge_finished_locally(&library, &original, &thumbnail);
        // Once nothing local is left, a later baseline drops the stale state row.
        rebaseline(&library, 3, vec![]);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state"), 0);
    }

    #[test]
    fn asset_not_found_answering_a_purge_finishes_it_locally_instead_of_uploading() {
        let (_temp, library, p) = setup();
        let (original, thumbnail) = purge_pending(&library, &p);
        let (client, worker) = command_server(vec![(404, json!({"detail":{"code":"assetNotFound"}}))]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        assert_eq!(worker.join().unwrap()[0]["commandType"], "tombstoneAsset");
        assert!(!result.stopped);
        assert_purge_finished_locally(&library, &original, &thumbnail);
    }

    #[test]
    fn an_uncoded_or_unknown_rejection_keeps_the_intent_and_retries_it_next_pass() {
        let (_temp, library, p) = setup();
        ingest(&library, &p, &media()).unwrap();
        second_asset(&library, "normal");
        library.trash_assets(&[ID.into()]).unwrap();
        library.trash_assets(&[OTHER.into()]).unwrap();
        for response in [
            (404, json!({"detail":"Not Found"})),
            (422, json!({"detail":[{"loc":["body"],"msg":"field required"}]})),
            (409, json!({"detail":{"code":"someFutureCode"}})),
        ] {
            let (client, worker) = command_server(vec![response]);
            let mut result = AssetSyncResult::default();
            library
                .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
                .unwrap();
            assert_eq!(worker.join().unwrap().len(), 1, "the pass stops at the head");
            assert!(result.stopped);
            assert_eq!(result.lifecycle_failures.len(), 1);
            assert_eq!(result.lifecycle_failures[0].asset_id, ID);
            assert_eq!(result.lifecycle_failures[0].desired, "trash");
            assert!(!result.lifecycle_failures[0].reason.is_empty());
            assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 2);
            assert_eq!(count(&library, "SELECT count(*) FROM assets WHERE status='trash'"), 2,
                       "a server fault never undoes the user's trash");
            assert_eq!(count(&library, "SELECT count(*) FROM asset_authority_state WHERE last_error IS NOT NULL"), 0);
        }
        let operation: String = library.connection().unwrap()
            .query_row("SELECT operation_id FROM asset_lifecycle_outbox ORDER BY sequence LIMIT 1", [], |r| r.get(0)).unwrap();
        let (client, worker) = command_server(vec![
            (200, trash_accepted(&library, &p, 2)),
            (200, trash_accepted(&library, &second_projection(), 2)),
        ]);
        let mut result = AssetSyncResult::default();
        library
            .flush_assets(&client, "publisher", &authority_of(&library), &mut result)
            .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(sent[0]["operationId"], operation, "the retry presents the same operation");
        assert_eq!(result.flushed, 2);
        assert_eq!(count(&library, "SELECT count(*) FROM asset_lifecycle_outbox"), 0);
    }
