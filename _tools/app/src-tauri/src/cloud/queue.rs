use rusqlite::{params, OptionalExtension, Row, Transaction};

use super::models::{CloudSyncConfig, CloudSyncQueueItem};
use crate::library::{error::LibraryError, Library};

impl Library {
    pub(crate) fn cloud_sync_config(&self) -> Result<CloudSyncConfig, LibraryError> {
        self.connection()?
            .query_row(
                "SELECT cloud_sync_enabled, cloud_api_base_url
                 FROM library_settings WHERE singleton = 1",
                [],
                |row| {
                    Ok(CloudSyncConfig {
                        enabled: row.get::<_, i64>(0)? != 0,
                        api_base_url: row.get(1)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub(crate) fn set_cloud_sync_config(
        &self,
        config: CloudSyncConfig,
    ) -> Result<CloudSyncConfig, LibraryError> {
        let capture_enabled = config.enabled;
        self.set_cloud_settings(config, capture_enabled)
    }

    pub(crate) fn cloud_capture_enabled(&self) -> Result<bool, LibraryError> {
        Ok(self.connection()?.query_row("SELECT cloud_capture_enabled FROM library_settings WHERE singleton = 1", [], |row| row.get(0))?)
    }

    pub(crate) fn set_cloud_settings(&self, config: CloudSyncConfig, capture_enabled: bool) -> Result<CloudSyncConfig, LibraryError> {
        let config = validated_config(config)?;
        if capture_enabled && config.api_base_url.is_none() { return Err(LibraryError::InvalidCloudSyncConfig); }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE library_settings
             SET cloud_sync_enabled = ?1, cloud_api_base_url = ?2, cloud_capture_enabled = ?3
             WHERE singleton = 1",
            params![i64::from(config.enabled), config.api_base_url, i64::from(capture_enabled)],
        )?;
        if config.enabled {
            transaction.execute("UPDATE cloud_backfill_control SET state = 'idle' WHERE state = 'paused'", [])?;
        }
        transaction.commit()?;
        Ok(config)
    }

    pub(crate) fn cloud_sync_queue_item(
        &self,
        id: &str,
    ) -> Result<Option<CloudSyncQueueItem>, LibraryError> {
        self.connection()?
            .query_row(
                "SELECT id, entity_type, entity_id, operation, status, revision,
                        retry_count, updated_at, synced_at, last_error
                 FROM cloud_sync_queue WHERE id = ?1",
                [id],
                queue_item_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn mark_cloud_sync_synced(&self, id: &str) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let changed = self.connection()?.execute(
            "UPDATE cloud_sync_queue
             SET status = 'synced', updated_at = ?2, synced_at = ?2, last_error = NULL
             WHERE id = ?1 AND status IN ('processing', 'preparing', 'uploading', 'committing')",
            params![id, now],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(LibraryError::InvalidCloudSyncQueueItem)
        }
    }

    pub(crate) fn mark_cloud_sync_retry(
        &self,
        id: &str,
        last_error: &str,
    ) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let last_error = safe_last_error(last_error);
        let changed = self.connection()?.execute(
            "UPDATE cloud_sync_queue
             SET status = 'pending', retry_count = retry_count + 1,
                 updated_at = ?2, synced_at = NULL, last_error = ?3
             WHERE id = ?1 AND status IN ('processing', 'preparing', 'uploading', 'committing')",
            params![id, now, last_error],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(LibraryError::InvalidCloudSyncQueueItem)
        }
    }

    pub(crate) fn mark_cloud_sync_failed(
        &self,
        id: &str,
        last_error: &str,
    ) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let last_error = safe_last_error(last_error);
        let changed = self.connection()?.execute(
            "UPDATE cloud_sync_queue
             SET status = 'failed', retry_count = retry_count + 1,
                 updated_at = ?2, synced_at = NULL, last_error = ?3
             WHERE id = ?1 AND status IN ('processing', 'preparing', 'uploading', 'committing')",
            params![id, now, last_error],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(LibraryError::InvalidCloudSyncQueueItem)
        }
    }

    pub(crate) fn requeue_interrupted_cloud_sync(&self) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        self.connection()?.execute(
            "UPDATE cloud_sync_queue
             SET status = 'pending', updated_at = ?1,
                 last_error = COALESCE(last_error, 'interrupted before completion')
             WHERE status IN ('processing', 'preparing', 'uploading', 'committing')",
            [now],
        )?;
        Ok(())
    }
}

pub(crate) fn enqueue_asset_upsert(
    transaction: &Transaction<'_>,
    asset_id: &str,
    updated_at: &str,
) -> Result<(), LibraryError> {
    transaction.execute(
        "INSERT INTO cloud_sync_queue (
            id, entity_type, entity_id, operation, status, revision, updated_at
         ) VALUES (?1, 'asset', ?2, 'upsert', 'pending',
             (SELECT COALESCE(MAX(revision), 0) + 1 FROM cloud_sync_queue
              WHERE entity_type='asset' AND entity_id=?2 AND operation='upsert'), ?3)",
        params![uuid::Uuid::new_v4().to_string(), asset_id, updated_at],
    )?;
    Ok(())
}

pub(super) fn queue_item_from_row(row: &Row<'_>) -> rusqlite::Result<CloudSyncQueueItem> {
    Ok(CloudSyncQueueItem {
        id: row.get(0)?,
        entity_type: row.get(1)?,
        entity_id: row.get(2)?,
        operation: row.get(3)?,
        status: row.get(4)?,
        revision: row.get::<_, i64>(5)? as u64,
        retry_count: row.get::<_, i64>(6)? as u32,
        updated_at: row.get(7)?,
        synced_at: row.get(8)?,
        last_error: row.get(9)?,
    })
}

fn validated_config(config: CloudSyncConfig) -> Result<CloudSyncConfig, LibraryError> {
    let api_base_url = match config.api_base_url {
        Some(value) => {
            let value = value.trim();
            let parsed =
                url::Url::parse(value).map_err(|_| LibraryError::InvalidCloudSyncConfig)?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
            {
                return Err(LibraryError::InvalidCloudSyncConfig);
            }
            Some(value.to_owned())
        }
        None => None,
    };
    if config.enabled && api_base_url.is_none() {
        return Err(LibraryError::InvalidCloudSyncConfig);
    }
    Ok(CloudSyncConfig {
        enabled: config.enabled,
        api_base_url,
    })
}

fn safe_last_error(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character == '\r' || character == '\n' {
                ' '
            } else {
                character
            }
        })
        .take(500)
        .collect()
}
