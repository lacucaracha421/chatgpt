use std::io::{Read, Seek, SeekFrom};

use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use super::{
    client::CloudClient,
    models::{CloudSyncQueueItem, PreparedAssetUpload},
    queue::queue_item_from_row,
};
use crate::library::{error::LibraryError, Library};

impl Library {
    pub(crate) fn claim_next_asset_upload(
        &self,
    ) -> Result<Option<PreparedAssetUpload>, LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let pending = transaction
            .query_row(
                "SELECT queue.id, queue.entity_type, queue.entity_id, queue.operation,
                        queue.status, queue.revision, queue.retry_count, queue.updated_at,
                        queue.synced_at, queue.last_error, asset.media_kind, asset.relative_path,
                        asset.byte_size, asset.content_hash
                 FROM cloud_sync_queue AS queue
                 JOIN assets AS asset ON asset.id = queue.entity_id
                 WHERE queue.status = 'pending'
                   AND queue.entity_type = 'asset'
                   AND queue.operation = 'upsert'
                   AND asset.status = 'normal'
                 ORDER BY queue.updated_at, queue.id
                 LIMIT 1",
                [],
                |row| {
                    Ok((
                        queue_item_from_row(row)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, i64>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                },
            )
            .optional()?;
        let Some((mut queue, media_kind, relative_path, byte_size, sha256)) = pending else {
            return Ok(None);
        };

        let asset_id = uuid::Uuid::parse_str(&queue.entity_id)
            .map_err(|_| LibraryError::InvalidCloudSyncQueueItem)?;
        let object_key = match media_kind.as_str() {
            "image" | "gif" => format!("images/{asset_id}/original"),
            "video" => format!("videos/{asset_id}/original"),
            _ => return Err(LibraryError::InvalidCloudSyncQueueItem),
        };
        let content_type = content_type(&media_kind, &relative_path)?;
        let size_bytes =
            u64::try_from(byte_size).map_err(|_| LibraryError::InvalidCloudSyncQueueItem)?;
        if sha256.trim().is_empty() {
            return Err(LibraryError::InvalidCloudSyncQueueItem);
        }
        let claimed_at = chrono::Utc::now().to_rfc3339();
        let changed = transaction.execute(
            "UPDATE cloud_sync_queue
             SET status = 'processing', updated_at = ?2
             WHERE id = ?1 AND status = 'pending'",
            (&queue.id, &claimed_at),
        )?;
        if changed != 1 {
            return Err(LibraryError::InvalidCloudSyncQueueItem);
        }
        transaction.commit()?;
        queue.status = "processing".into();
        queue.updated_at = claimed_at;

        Ok(Some(PreparedAssetUpload {
            queue,
            object_key,
            source_relative_path: relative_path,
            kind: media_kind,
            content_type,
            size_bytes,
            sha256,
        }))
    }

    pub(crate) fn sync_next_cloud_asset(&self) -> Result<Option<CloudSyncQueueItem>, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(None);
        }
        let base_url = config
            .api_base_url
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(&base_url)?;
        self.sync_next_cloud_asset_with(&client, &token)
    }

    pub(super) fn sync_next_cloud_asset_with(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<Option<CloudSyncQueueItem>, LibraryError> {
        let Some(prepared) = self.claim_next_asset_upload()? else {
            return Ok(None);
        };
        let queue_id = prepared.queue.id.clone();
        let upload = self
            .open_validated_cloud_source(&prepared)
            .and_then(|source| client.upload_asset(&prepared, source, token));
        match upload {
            Ok(()) => self.mark_cloud_sync_synced(&queue_id)?,
            Err(error) => {
                if is_retryable_cloud_error(&error) {
                    self.mark_cloud_sync_retry(&queue_id, &error.to_string())?;
                } else {
                    self.mark_cloud_sync_failed(&queue_id, &error.to_string())?;
                }
                return Err(error);
            }
        }
        self.cloud_sync_queue_item(&queue_id)
    }

    pub(super) fn open_validated_cloud_source(
        &self,
        prepared: &PreparedAssetUpload,
    ) -> Result<std::fs::File, LibraryError> {
        let mut source = self
            .open_library_media(&prepared.source_relative_path)
            .map_err(|_| LibraryError::CloudSourceUnavailable)?;
        if source.length != prepared.size_bytes || source.mime != prepared.content_type {
            return Err(LibraryError::CloudSourceChanged);
        }
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = source
                .file
                .read(&mut buffer)
                .map_err(|_| LibraryError::CloudSourceUnavailable)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let digest = hasher.finalize();
        let actual_sha256 = hex_digest(&digest);
        if !actual_sha256.eq_ignore_ascii_case(&prepared.sha256) {
            return Err(LibraryError::CloudSourceChanged);
        }
        source
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|_| LibraryError::CloudSourceUnavailable)?;
        Ok(source.file)
    }
}

pub(super) fn content_type(media_kind: &str, relative_path: &str) -> Result<String, LibraryError> {
    let extension = std::path::Path::new(relative_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(LibraryError::InvalidCloudSyncQueueItem)?;
    let value = match (media_kind, extension.as_str()) {
        ("image", "jpg" | "jpeg" | "jfif") => "image/jpeg",
        ("image", "png") => "image/png",
        ("image", "webp") => "image/webp",
        ("gif", "gif") => "image/gif",
        ("video", "mp4") => "video/mp4",
        ("video", "webm") => "video/webm",
        ("video", "mov") => "video/quicktime",
        _ => return Err(LibraryError::InvalidCloudSyncQueueItem),
    };
    Ok(value.into())
}

pub(super) fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write;

    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

pub(super) fn is_retryable_cloud_error(error: &LibraryError) -> bool {
    match error {
        LibraryError::CloudRequestTimedOut | LibraryError::CloudRequestUnavailable => true,
        LibraryError::CloudPresignRejected(status)
        | LibraryError::CloudUploadRejected(status)
        | LibraryError::CloudAssetRegistrationRejected(status)
        | LibraryError::CloudReplicationPrepareRejected(status)
        | LibraryError::CloudReplicationCommitRejected(status) => {
            *status == 429 || (500..=599).contains(status)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_retryable_cloud_error;
    use crate::library::error::LibraryError;

    #[test]
    fn retries_only_network_timeout_rate_limit_and_server_errors() {
        for error in [
            LibraryError::CloudRequestUnavailable,
            LibraryError::CloudRequestTimedOut,
            LibraryError::CloudPresignRejected(429),
            LibraryError::CloudUploadRejected(500),
            LibraryError::CloudAssetRegistrationRejected(599),
        ] {
            assert!(is_retryable_cloud_error(&error), "{error}");
        }

        for error in [
            LibraryError::CloudPresignRejected(400),
            LibraryError::CloudUnauthorized,
            LibraryError::CloudAssetRegistrationRejected(404),
            LibraryError::CloudObjectKeyConflict,
            LibraryError::InvalidCloudResponse,
            LibraryError::CloudSourceChanged,
        ] {
            assert!(!is_retryable_cloud_error(&error), "{error}");
        }
    }
}
