use std::{
    fs,
    fs::File,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use uuid::Uuid;

use super::client::{CloudClient, RestoreMediaTicket};
use crate::library::{credential, error::LibraryError, Library};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLibraryRestoreReport {
    pub metadata_byte_size: u64,
    pub total_assets: u64,
    pub originals_restored: u64,
    pub thumbnails_restored: u64,
    pub files_skipped: u64,
    pub files_unavailable: u64,
    pub bytes_downloaded: u64,
}

#[derive(Debug, Clone)]
struct RestoreTarget {
    asset_id: String,
    variant: &'static str,
    relative_path: String,
    expected_size: Option<u64>,
}

impl Library {
    pub(crate) fn push_cloud_metadata_backup(&self) -> Result<u64, LibraryError> {
        let (client, token) = self.metadata_backup_client()?;
        let staging = self.metadata_backup_staging_path("upload");
        let result = (|| {
            let byte_size = self.create_cloud_metadata_snapshot(&staging)?;
            let source = File::open(&staging).map_err(|source| LibraryError::Backup {
                path: staging.clone(),
                source,
            })?;
            client.upload_metadata_backup(source, &token)?;
            Ok(byte_size)
        })();
        cleanup_staging(&staging);
        result
    }

    pub(crate) fn restore_cloud_library_from_server(
        &self,
    ) -> Result<CloudLibraryRestoreReport, LibraryError> {
        let (client, token) = self.metadata_backup_client()?;
        let staging = self.metadata_backup_staging_path("download");
        let result = (|| {
            let metadata_byte_size = client.download_metadata_backup(&staging, &token)?;
            self.restore_cloud_metadata_snapshot(&staging)?;
            let mut report = CloudLibraryRestoreReport {
                metadata_byte_size,
                ..Default::default()
            };
            self.restore_managed_media(&client, &token, &mut report)?;
            // Video poster/scrub/proxy files are derived from the restored original.
            // A metadata snapshot can say "ready" while a new PC has none of those
            // derivatives yet, so reset those rows to the normal pending pipeline.
            self.requeue_interrupted_video_preparation()?;
            Ok(report)
        })();
        cleanup_staging(&staging);
        result
    }

    fn restore_managed_media(
        &self,
        client: &CloudClient,
        token: &str,
        report: &mut CloudLibraryRestoreReport,
    ) -> Result<(), LibraryError> {
        let targets = self.cloud_restore_targets()?;
        report.total_assets = targets
            .iter()
            .filter(|target| target.variant == "original")
            .count() as u64;

        for chunk in targets.chunks(50) {
            let requests = chunk
                .iter()
                .map(|target| (target.asset_id.as_str(), target.variant))
                .collect::<Vec<_>>();
            let tickets = client.restore_media_tickets(&requests, token)?;
            for target in chunk {
                let ticket = tickets.iter().find(|ticket| {
                    ticket.asset_id == target.asset_id && ticket.variant == target.variant
                });
                let Some(ticket) = ticket else {
                    report.files_unavailable += 1;
                    continue;
                };
                self.restore_one_managed_file(client, target, ticket, report)?;
            }
        }
        Ok(())
    }

    fn cloud_restore_targets(&self) -> Result<Vec<RestoreTarget>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, media_kind, relative_path, thumbnail_relative_path, byte_size
             FROM assets
             WHERE status IN ('normal', 'trash')
             ORDER BY collected_at, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?.max(0) as u64,
            ))
        })?;
        let mut targets = Vec::new();
        for row in rows {
            let (asset_id, media_kind, relative_path, thumbnail_relative_path, byte_size) = row?;
            targets.push(RestoreTarget {
                asset_id: asset_id.clone(),
                variant: "original",
                relative_path,
                expected_size: Some(byte_size),
            });
            // Video thumbnails are derived poster files. Restoring just the original
            // lets the normal video preparation rebuild poster/scrub/proxy coherently.
            if media_kind != "video" {
                if let Some(relative_path) = thumbnail_relative_path {
                    targets.push(RestoreTarget {
                        asset_id,
                        variant: "thumbnail",
                        relative_path,
                        expected_size: None,
                    });
                }
            }
        }
        Ok(targets)
    }

    fn restore_one_managed_file(
        &self,
        client: &CloudClient,
        target: &RestoreTarget,
        ticket: &RestoreMediaTicket,
        report: &mut CloudLibraryRestoreReport,
    ) -> Result<(), LibraryError> {
        if ticket.url.is_none() || ticket.error.is_some() {
            report.files_unavailable += 1;
            return Ok(());
        }
        if let (Some(local), Some(remote)) = (target.expected_size, ticket.size_bytes) {
            if local != remote {
                report.files_unavailable += 1;
                return Ok(());
            }
        }
        let destination = managed_restore_path(self.root(), &target.relative_path, target.variant)?;
        if existing_file_is_usable(&destination, target.expected_size) {
            report.files_skipped += 1;
            return Ok(());
        }
        let parent = destination.parent().ok_or(LibraryError::UnsafeMediaPath)?;
        fs::create_dir_all(parent).map_err(|source| LibraryError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
        let temporary = parent.join(format!(".lakomics-restore-{}.part", Uuid::new_v4()));
        let downloaded = match client.download_restore_media(ticket, &temporary) {
            Ok(downloaded) => downloaded,
            Err(_) => {
                cleanup_staging(&temporary);
                report.files_unavailable += 1;
                return Ok(());
            }
        };
        if target
            .expected_size
            .is_some_and(|expected| expected != downloaded)
        {
            cleanup_staging(&temporary);
            report.files_unavailable += 1;
            return Ok(());
        }
        install_restored_file(&temporary, &destination)?;
        report.bytes_downloaded += downloaded;
        if target.variant == "original" {
            report.originals_restored += 1;
        } else {
            report.thumbnails_restored += 1;
        }
        Ok(())
    }

    fn metadata_backup_client(&self) -> Result<(CloudClient, String), LibraryError> {
        let config = self.cloud_sync_config()?;
        let base_url = config
            .api_base_url
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = credential::read_cloud_api_token_os()?;
        Ok((CloudClient::new(&base_url)?, token))
    }

    fn metadata_backup_staging_path(&self, operation: &str) -> PathBuf {
        self.root().join("backups").join(format!(
            "cloud-metadata-{operation}-{}.sqlite",
            Uuid::new_v4()
        ))
    }
}

fn managed_restore_path(
    root: &Path,
    relative_path: &str,
    variant: &str,
) -> Result<PathBuf, LibraryError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let expected_root = if variant == "original" {
        "assets"
    } else {
        "thumbnails"
    };
    if !matches!(relative.components().next(), Some(Component::Normal(first)) if first == expected_root)
    {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(root.join(relative))
}

fn existing_file_is_usable(path: &Path, expected_size: Option<u64>) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() > 0
        && expected_size.is_none_or(|expected| metadata.len() == expected)
}

fn install_restored_file(temporary: &Path, destination: &Path) -> Result<(), LibraryError> {
    let displaced = destination.with_extension(format!(
        "{}.restore-old-{}",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file"),
        Uuid::new_v4()
    ));
    let had_existing = destination.exists();
    if had_existing {
        fs::rename(destination, &displaced).map_err(|source| LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        })?;
    }
    if let Err(source) = fs::rename(temporary, destination) {
        if had_existing {
            let _ = fs::rename(&displaced, destination);
        }
        return Err(LibraryError::Backup {
            path: destination.to_path_buf(),
            source,
        });
    }
    if had_existing {
        cleanup_staging(&displaced);
    }
    Ok(())
}

fn cleanup_staging(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("cloud restore staging cleanup failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{existing_file_is_usable, managed_restore_path};
    use crate::library::Library;
    use std::fs;

    #[test]
    fn restore_paths_are_limited_to_managed_asset_roots() {
        let temp = tempfile::tempdir().unwrap();
        assert!(managed_restore_path(temp.path(), "assets/aa/file.png", "original").is_ok());
        assert!(managed_restore_path(temp.path(), "thumbnails/aa/file.webp", "thumbnail").is_ok());
        assert!(managed_restore_path(temp.path(), "../outside.png", "original").is_err());
        assert!(managed_restore_path(temp.path(), "work-artwork/file.png", "original").is_err());
        assert!(managed_restore_path(temp.path(), "assets/file.png", "thumbnail").is_err());
    }

    #[test]
    fn existing_restore_file_requires_the_recorded_size_when_known() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("image.bin");
        fs::write(&path, b"1234").unwrap();
        assert!(existing_file_is_usable(&path, Some(4)));
        assert!(!existing_file_is_usable(&path, Some(5)));
        assert!(existing_file_is_usable(&path, None));
    }


    #[test]
    fn restore_plan_includes_managed_originals_and_skips_video_derivatives() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        connection.execute(
            "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path, byte_size, width, height, collected_at, status) VALUES ('image-1', 'hash-image', 'image', 'image.png', 'assets/aa/image.png', 'thumbnails/aa/image.webp', 4, 1, 1, '2026-09-04T00:00:00Z', 'normal')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path, byte_size, width, height, collected_at, status) VALUES ('video-1', 'hash-video', 'video', 'video.mp4', 'assets/bb/video.mp4', 'video-media/video-1/poster.webp', 5, 1, 1, '2026-09-04T00:00:01Z', 'trash')",
            [],
        ).unwrap();
        drop(connection);

        let targets = library.cloud_restore_targets().unwrap();
        assert_eq!(targets.len(), 3);
        assert!(targets.iter().any(|target| target.asset_id == "image-1" && target.variant == "original" && target.relative_path == "assets/aa/image.png"));
        assert!(targets.iter().any(|target| target.asset_id == "image-1" && target.variant == "thumbnail" && target.relative_path == "thumbnails/aa/image.webp"));
        assert!(targets.iter().any(|target| target.asset_id == "video-1" && target.variant == "original" && target.relative_path == "assets/bb/video.mp4"));
        assert!(!targets.iter().any(|target| target.asset_id == "video-1" && target.variant == "thumbnail"));
    }
}
