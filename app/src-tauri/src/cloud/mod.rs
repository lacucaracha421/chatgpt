pub(crate) mod backfill;
#[cfg(test)]
mod backfill_tests;
#[cfg(test)]
mod capture_tests;
pub(crate) mod captures;
mod client;
pub(crate) mod models;
pub(crate) mod queue;
mod sync;

#[cfg(test)]
mod contract_tests;

#[cfg(test)]
mod tests {
    use super::models::{CloudSyncConfig, CloudSyncQueueItem};
    use crate::library::{error::LibraryError, Library};

    #[test]
    fn stores_and_loads_non_secret_cloud_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        assert_eq!(
            library.cloud_sync_config().unwrap(),
            CloudSyncConfig {
                enabled: false,
                api_base_url: None,
            },
        );

        let configured = CloudSyncConfig {
            enabled: true,
            api_base_url: Some("https://sync.example.test/v1".into()),
        };
        assert_eq!(
            library.set_cloud_sync_config(configured.clone()).unwrap(),
            configured,
        );
        assert_eq!(library.cloud_sync_config().unwrap(), configured);
    }

    #[test]
    fn rejects_credentials_embedded_in_cloud_api_url() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let error = library
            .set_cloud_sync_config(CloudSyncConfig {
                enabled: true,
                api_base_url: Some("https://user:secret@sync.example.test/v1".into()),
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidCloudSyncConfig));
        assert_eq!(
            library.cloud_sync_config().unwrap(),
            CloudSyncConfig {
                enabled: false,
                api_base_url: None,
            },
        );
    }

    #[test]
    fn loads_all_persisted_queue_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision,
                    retry_count, updated_at, synced_at, last_error
                 ) VALUES (?1, 'asset', ?2, 'upsert', 'failed', 3, 2, ?3, ?4, ?5)",
                (
                    "queue-1",
                    "00000000-0000-4000-8000-000000000001",
                    "2026-08-30T00:00:00Z",
                    "2026-08-30T00:00:01Z",
                    "temporary failure",
                ),
            )
            .unwrap();

        assert_eq!(
            library.cloud_sync_queue_item("queue-1").unwrap(),
            Some(CloudSyncQueueItem {
                id: "queue-1".into(),
                entity_type: "asset".into(),
                entity_id: "00000000-0000-4000-8000-000000000001".into(),
                operation: "upsert".into(),
                status: "failed".into(),
                revision: 3,
                retry_count: 2,
                updated_at: "2026-08-30T00:00:00Z".into(),
                synced_at: Some("2026-08-30T00:00:01Z".into()),
                last_error: Some("temporary failure".into()),
            }),
        );
    }

    #[test]
    fn atomically_claims_a_path_independent_image_upload_with_server_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let asset_id = "00000000-0000-4000-8000-000000000001";
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', 'mutable title.png', 'assets/local-title.png',
                           'thumbnails/local-title.webp', 1, 1, 1, ?3)",
                (asset_id, "hash-1", "2026-08-30T00:00:00Z"),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cloud_sync_queue (
                    id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES ('queue-1', 'asset', ?1, 'upsert', 'pending', 1, ?2)",
                (asset_id, "2026-08-30T00:00:00Z"),
            )
            .unwrap();
        drop(connection);

        let first = library.clone();
        let second = library.clone();
        let first_claim = std::thread::spawn(move || first.claim_next_asset_upload().unwrap());
        let second_claim = std::thread::spawn(move || second.claim_next_asset_upload().unwrap());
        let claimed = [first_claim.join().unwrap(), second_claim.join().unwrap()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(claimed.len(), 1);
        let prepared = &claimed[0];

        assert_eq!(prepared.queue.entity_id, asset_id);
        assert_eq!(prepared.queue.status, "processing");
        assert_eq!(prepared.object_key, format!("images/{asset_id}/original"));
        assert_eq!(prepared.kind, "image");
        assert_eq!(prepared.content_type, "image/png");
        assert_eq!(prepared.size_bytes, 1);
        assert_eq!(prepared.sha256, "hash-1");
        assert_eq!(prepared.source_relative_path, "assets/local-title.png");
        assert!(!prepared.object_key.contains("local-title"));
        assert!(!prepared
            .object_key
            .contains(&library.root().to_string_lossy().to_string()));
        assert!(library.claim_next_asset_upload().unwrap().is_none());
        assert_eq!(
            library
                .cloud_sync_queue_item("queue-1")
                .unwrap()
                .unwrap()
                .status,
            "processing"
        );
    }

    #[test]
    fn reopening_a_library_recovers_interrupted_processing_work() {
        let temp = tempfile::tempdir().unwrap();
        {
            let library = Library::open(temp.path()).unwrap();
            library
                .connection()
                .unwrap()
                .execute(
                    "INSERT INTO cloud_sync_queue (
                        id, entity_type, entity_id, operation, status, revision,
                        retry_count, updated_at, last_error
                     ) VALUES ('queue-1', 'asset', ?1, 'upsert', 'processing', 1, 2, ?2, NULL)",
                    (
                        "00000000-0000-4000-8000-000000000001",
                        "2026-08-30T00:00:00Z",
                    ),
                )
                .unwrap();
        }

        let reopened = Library::open(temp.path()).unwrap();
        let item = reopened.cloud_sync_queue_item("queue-1").unwrap().unwrap();
        assert_eq!(item.status, "pending");
        assert_eq!(item.retry_count, 2);
        assert_eq!(
            item.last_error.as_deref(),
            Some("interrupted before completion")
        );
    }
}
