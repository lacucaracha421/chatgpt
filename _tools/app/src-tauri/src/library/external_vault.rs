#[path = "private_vault/discovery.rs"]
mod discovery;
#[path = "private_vault/index.rs"]
mod index;
#[path = "private_vault/scan.rs"]
mod scan;
#[path = "private_vault/player.rs"]
mod player;

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use image::ImageDecoder;
use serde::{Deserialize, Serialize};

use super::{
    error::LibraryError,
    models::{
        PrivateVaultAssetPage, PrivateVaultQuery, PrivateVaultScanReport, PrivateVaultStatus,
        PrivateVaultThumbnailCandidate,
    },
    Library, MediaResponse,
};

const METADATA_DIR: &str = ".lakomics";
const MARKER_FILE: &str = "vault.json";
const MARKER_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultMarker {
    version: u32,
    vault_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrivateVaultMediaVariant {
    Asset,
    Thumbnail,
    Playback,
}

impl Library {
    pub fn register_private_vault(&self, root: &Path) -> Result<PrivateVaultStatus, LibraryError> {
        let canonical = canonical_vault_root(self, root)?;
        let metadata_dir = canonical.join(METADATA_DIR);
        ensure_metadata_dir(&canonical, &metadata_dir)?;
        let marker_path = metadata_dir.join(MARKER_FILE);
        let marker = if marker_path.exists() {
            read_marker(&marker_path)?
        } else {
            let marker = VaultMarker {
                version: MARKER_VERSION,
                vault_id: uuid::Uuid::new_v4().to_string(),
            };
            write_marker(&marker_path, &marker)?;
            marker
        };
        validate_marker(&marker)?;
        index::initialize_index(&metadata_dir.join("index.sqlite"))?;
        let root_string = canonical.to_string_lossy().into_owned();
        self.connection()?.execute(
            "UPDATE library_settings SET private_vault_id=?1, private_vault_last_root=?2 WHERE singleton=1",
            rusqlite::params![marker.vault_id, root_string],
        )?;
        self.private_vault_status()
    }

    pub fn unregister_private_vault(&self) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE library_settings SET private_vault_id=NULL, private_vault_last_root=NULL WHERE singleton=1",
            [],
        )?;
        Ok(())
    }

    pub fn scan_private_vault(&self) -> Result<PrivateVaultScanReport, LibraryError> {
        let root = self.available_private_vault_root()?;
        scan::scan(&root)
    }

    pub fn list_private_vault_assets(
        &self,
        query: PrivateVaultQuery,
    ) -> Result<PrivateVaultAssetPage, LibraryError> {
        let root = self.available_private_vault_root()?;
        index::list_assets(&root.join(METADATA_DIR).join("index.sqlite"), query)
    }

    pub fn play_private_vault_video(&self, asset_id: &str) -> Result<(), LibraryError> {
        let root = self.available_private_vault_root()?;
        let source = vault_original_video_path(&root, asset_id)?;
        player::launch(&root, &source)
    }

    pub fn set_private_vault_title(&self, asset_id: &str, title: Option<&str>) -> Result<(), LibraryError> {
        let root = self.available_private_vault_root()?;
        let _ = vault_original_video_path(&root, asset_id)?;
        let normalized = title.map(str::trim).filter(|value| !value.is_empty());
        if normalized.is_some_and(|value| value.chars().count() > 200) {
            return Err(LibraryError::InvalidPrivateVaultTitle);
        }
        index::set_title(&root.join(METADATA_DIR).join("index.sqlite"), asset_id, normalized)
    }

    pub fn private_vault_thumbnail_candidates(
        &self,
        asset_id: &str,
    ) -> Result<Vec<PrivateVaultThumbnailCandidate>, LibraryError> {
        let root = self.available_private_vault_root()?;
        let source = vault_original_video_path(&root, asset_id)?;
        let database = root.join(METADATA_DIR).join("index.sqlite");
        let asset = index::find_by_id(&database, asset_id)?.ok_or(LibraryError::AssetNotFound)?;
        let duration_ms = asset.duration_ms.unwrap_or_default();
        thumbnail_candidate_timestamps(duration_ms)
            .into_iter()
            .map(|timestamp_ms| {
                Ok(PrivateVaultThumbnailCandidate {
                    timestamp_ms,
                    image_bytes: crate::library::video_media::render_video_frame_webp(&source, timestamp_ms)?,
                })
            })
            .collect()
    }

    pub fn set_private_vault_thumbnail_from_frame(
        &self,
        asset_id: &str,
        timestamp_ms: u64,
    ) -> Result<(), LibraryError> {
        let root = self.available_private_vault_root()?;
        let source = vault_original_video_path(&root, asset_id)?;
        let database = root.join(METADATA_DIR).join("index.sqlite");
        let asset = index::find_by_id(&database, asset_id)?.ok_or(LibraryError::AssetNotFound)?;
        let duration_ms = asset.duration_ms.unwrap_or_default();
        if duration_ms == 0 || timestamp_ms >= duration_ms {
            return Err(LibraryError::VideoPreparationFailed);
        }
        let (relative, destination, temporary) = custom_thumbnail_paths(&root, asset_id)?;
        if let Err(error) = crate::library::video_media::create_video_poster(&source, timestamp_ms, &temporary) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = install_custom_thumbnail(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        index::set_custom_thumbnail(&database, asset_id, Some(&relative))
    }

    pub fn set_private_vault_thumbnail_from_file(
        &self,
        asset_id: &str,
        source_path: &Path,
    ) -> Result<(), LibraryError> {
        let root = self.available_private_vault_root()?;
        let _ = vault_original_video_path(&root, asset_id)?;
        let metadata = fs::symlink_metadata(source_path).map_err(|source| LibraryError::ReadMedia { path: source_path.to_path_buf(), source })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let reader = image::ImageReader::open(source_path)
            .map_err(|source| LibraryError::ReadMedia { path: source_path.to_path_buf(), source })?
            .with_guessed_format()
            .map_err(|_| LibraryError::UnsupportedImage)?;
        let mut decoder = reader.into_decoder().map_err(|_| LibraryError::UnsupportedImage)?;
        let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
        let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| LibraryError::UnsupportedImage)?;
        image.apply_orientation(orientation);
        let encoded = crate::library::ingestion::encode_thumbnail_webp(&image)?;
        let (relative, destination, temporary) = custom_thumbnail_paths(&root, asset_id)?;
        fs::write(&temporary, encoded).map_err(|source| LibraryError::WriteAsset { path: temporary.clone(), source })?;
        if let Err(error) = install_custom_thumbnail(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        index::set_custom_thumbnail(&root.join(METADATA_DIR).join("index.sqlite"), asset_id, Some(&relative))
    }

    pub fn reset_private_vault_thumbnail(&self, asset_id: &str) -> Result<(), LibraryError> {
        let root = self.available_private_vault_root()?;
        let _ = vault_original_video_path(&root, asset_id)?;
        let database = root.join(METADATA_DIR).join("index.sqlite");
        index::set_custom_thumbnail(&database, asset_id, None)?;
        let path = root.join(METADATA_DIR).join("custom-thumbnails").join(format!("{asset_id}.webp"));
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(LibraryError::WriteAsset { path: root.join(METADATA_DIR).join("custom-thumbnails").join(format!("{asset_id}.webp")), source: error }),
        }
    }

    pub(crate) fn resolve_private_vault_media(
        &self,
        vault_id: &str,
        asset_id: &str,
        variant: PrivateVaultMediaVariant,
    ) -> Result<MediaResponse, LibraryError> {
        let status = self.private_vault_status()?;
        if !status.available || status.vault_id.as_deref() != Some(vault_id) {
            return Err(LibraryError::AssetNotFound);
        }
        let root = status
            .root
            .map(PathBuf::from)
            .ok_or(LibraryError::MediaNotFound)?;
        let requested = vault_media_path(&root, asset_id, variant)?;
        self.open_manga_media(&root, requested)
    }

    fn available_private_vault_root(&self) -> Result<PathBuf, LibraryError> {
        self.private_vault_status()?
            .root
            .map(PathBuf::from)
            .ok_or(LibraryError::MediaNotFound)
    }
    pub fn private_vault_status(&self) -> Result<PrivateVaultStatus, LibraryError> {
        let (vault_id, last_root) = self.connection()?.query_row(
            "SELECT private_vault_id, private_vault_last_root FROM library_settings WHERE singleton=1",
            [],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )?;
        let Some(vault_id) = vault_id else {
            return Ok(unregistered_status());
        };
        let available_root =
            discovery::discover_registered_vault(&vault_id, last_root.as_deref().map(Path::new));
        if let Some(root) = &available_root {
            let resolved = root.to_string_lossy().into_owned();
            if last_root.as_deref() != Some(resolved.as_str()) {
                self.connection()?.execute(
                    "UPDATE library_settings SET private_vault_last_root=?1 WHERE singleton=1",
                    [&resolved],
                )?;
            }
        }
        let read_only = available_root.as_ref().is_some_and(|root| {
            fs::metadata(root).is_ok_and(|metadata| metadata.permissions().readonly())
        });
        if let Some(root) = &available_root {
            index::initialize_index(&root.join(METADATA_DIR).join("index.sqlite"))?;
        }
        let asset_count = available_root
            .as_ref()
            .map(|root| index::asset_count(&root.join(METADATA_DIR).join("index.sqlite")))
            .transpose()?
            .unwrap_or(0);
        Ok(PrivateVaultStatus {
            registered: true,
            available: available_root.is_some(),
            vault_id: Some(vault_id),
            root: available_root.map(|root| root.to_string_lossy().into_owned()),
            asset_count,
            read_only,
        })
    }
}
fn unregistered_status() -> PrivateVaultStatus {
    PrivateVaultStatus {
        registered: false,
        available: false,
        vault_id: None,
        root: None,
        asset_count: 0,
        read_only: false,
    }
}

fn vault_original_video_path(root: &Path, asset_id: &str) -> Result<PathBuf, LibraryError> {
    if uuid::Uuid::parse_str(asset_id).is_err() {
        return Err(LibraryError::AssetNotFound);
    }
    let database = root.join(METADATA_DIR).join("index.sqlite");
    let asset = index::find_by_id(&database, asset_id)?.ok_or(LibraryError::AssetNotFound)?;
    if asset.media_kind != "video" {
        return Err(LibraryError::AssetNotFound);
    }
    Ok(root.join(validated_relative(&asset.relative_path)?))
}

fn vault_media_path(
    root: &Path,
    asset_id: &str,
    variant: PrivateVaultMediaVariant,
) -> Result<PathBuf, LibraryError> {
    if uuid::Uuid::parse_str(asset_id).is_err() {
        return Err(LibraryError::AssetNotFound);
    }
    let metadata_root = root.join(METADATA_DIR);
    let database = metadata_root.join("index.sqlite");
    let asset = index::find_by_id(&database, asset_id)?.ok_or(LibraryError::AssetNotFound)?;
    // media path selection continues below.
    match variant {
        PrivateVaultMediaVariant::Asset => Ok(root.join(validated_relative(&asset.relative_path)?)),
        PrivateVaultMediaVariant::Thumbnail => {
            let relative = asset
                .custom_thumbnail_relative_path
                .as_deref()
                .or(asset.thumbnail_relative_path.as_deref())
                .ok_or(LibraryError::AssetNotFound)?;
            Ok(metadata_root.join(validated_relative(relative)?))
        }
        PrivateVaultMediaVariant::Playback => {
            if asset.media_kind != "video" {
                return Err(LibraryError::AssetNotFound);
            }
            Ok(match asset.playback_relative_path.as_deref() {
                Some(relative) => metadata_root.join(validated_relative(relative)?),
                None => root.join(validated_relative(&asset.relative_path)?),
            })
        }
    }
}

fn thumbnail_candidate_timestamps(duration_ms: u64) -> Vec<u64> {
    if duration_ms == 0 {
        return Vec::new();
    }
    (1_u128..=6)
        .map(|index| ((duration_ms as u128 * index) / 7) as u64)
        .collect()
}

fn custom_thumbnail_paths(root: &Path, asset_id: &str) -> Result<(String, PathBuf, PathBuf), LibraryError> {
    if uuid::Uuid::parse_str(asset_id).is_err() {
        return Err(LibraryError::AssetNotFound);
    }
    let directory = root.join(METADATA_DIR).join("custom-thumbnails");
    fs::create_dir_all(&directory).map_err(|source| LibraryError::CreateDirectory { path: directory.clone(), source })?;
    let relative = format!("custom-thumbnails/{asset_id}.webp");
    let destination = directory.join(format!("{asset_id}.webp"));
    let temporary = directory.join(format!(".{asset_id}-{}.tmp.webp", uuid::Uuid::new_v4()));
    Ok((relative, destination, temporary))
}

fn install_custom_thumbnail(temporary: &Path, destination: &Path) -> Result<(), LibraryError> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|source| LibraryError::WriteAsset { path: destination.to_path_buf(), source })?;
    }
    fs::rename(temporary, destination).map_err(|source| LibraryError::WriteAsset { path: destination.to_path_buf(), source })
}

fn validated_relative(value: &str) -> Result<PathBuf, LibraryError> {
    let path = Path::new(value);
    if path.is_absolute() || value.is_empty() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(LibraryError::UnsafeMediaPath);
        };
        clean.push(part);
    }
    if clean.as_os_str().is_empty() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(clean)
}
fn canonical_vault_root(library: &Library, root: &Path) -> Result<PathBuf, LibraryError> {
    let canonical = fs::canonicalize(root).map_err(|source| LibraryError::ReadMedia {
        path: root.to_path_buf(),
        source,
    })?;
    if !canonical.is_dir() {
        return Err(LibraryError::MediaNotFound);
    }
    let library_root =
        fs::canonicalize(library.root()).map_err(|source| LibraryError::ReadMedia {
            path: library.root().to_path_buf(),
            source,
        })?;
    if canonical.starts_with(&library_root) || library_root.starts_with(&canonical) {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(canonical)
}

fn ensure_metadata_dir(root: &Path, metadata_dir: &Path) -> Result<(), LibraryError> {
    match fs::symlink_metadata(metadata_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(LibraryError::UnsafeMediaPath);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(metadata_dir).map_err(|source| LibraryError::CreateDirectory {
                path: metadata_dir.to_path_buf(),
                source,
            })?;
        }
        Err(source) => {
            return Err(LibraryError::ReadMedia {
                path: metadata_dir.to_path_buf(),
                source,
            })
        }
    }
    let canonical = fs::canonicalize(metadata_dir).map_err(|source| LibraryError::ReadMedia {
        path: metadata_dir.to_path_buf(),
        source,
    })?;
    if canonical.parent() != Some(root) {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(())
}

pub(super) fn matching_root(root: &Path, vault_id: &str) -> Result<Option<PathBuf>, LibraryError> {
    let canonical = match fs::canonicalize(root) {
        Ok(path) if path.is_dir() => path,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(LibraryError::ReadMedia {
                path: root.to_path_buf(),
                source,
            })
        }
    };
    let marker_path = canonical.join(METADATA_DIR).join(MARKER_FILE);
    let marker = match read_marker(&marker_path) {
        Ok(marker) => marker,
        Err(LibraryError::MediaNotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    validate_marker(&marker)?;
    Ok((marker.vault_id == vault_id).then_some(canonical))
}
fn read_marker(path: &Path) -> Result<VaultMarker, LibraryError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            LibraryError::MediaNotFound
        } else {
            LibraryError::ReadMedia {
                path: path.to_path_buf(),
                source,
            }
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let bytes = fs::read(path).map_err(|source| LibraryError::ReadMedia {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|_| LibraryError::UnsafeMediaPath)
}

fn validate_marker(marker: &VaultMarker) -> Result<(), LibraryError> {
    if marker.version != MARKER_VERSION || uuid::Uuid::parse_str(&marker.vault_id).is_err() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(())
}

fn write_marker(path: &Path, marker: &VaultMarker) -> Result<(), LibraryError> {
    let parent = path.parent().ok_or(LibraryError::UnsafeMediaPath)?;
    let temp = parent.join(format!(".vault-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(marker).map_err(|_| LibraryError::UnsafeMediaPath)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|source| LibraryError::WriteAsset {
                path: temp.clone(),
                source,
            })?;
        file.write_all(&bytes)
            .map_err(|source| LibraryError::WriteAsset {
                path: temp.clone(),
                source,
            })?;
        file.sync_all().map_err(|source| LibraryError::WriteAsset {
            path: temp.clone(),
            source,
        })?;
        drop(file);
        fs::rename(&temp, path).map_err(|source| LibraryError::WriteAsset {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod thumbnail_edit_tests {
    use std::{fs, io::Read};

    use super::{index, thumbnail_candidate_timestamps, PrivateVaultMediaVariant};
    use crate::library::Library;

    #[test]
    fn thumbnail_candidates_avoid_video_edges() {
        let timestamps = thumbnail_candidate_timestamps(70_000);
        assert_eq!(timestamps.len(), 6);
        assert!(timestamps.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(timestamps[0] > 0);
        assert!(timestamps[5] < 70_000);
    }

    #[test]
    fn custom_title_and_image_thumbnail_roundtrip_inside_vault() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let status = library.register_private_vault(&vault).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        fs::write(vault.join("clip.mp4"), b"video").unwrap();
        let database = vault.join(".lakomics/index.sqlite");
        rusqlite::Connection::open(&database).unwrap().execute(
            "INSERT INTO vault_assets(
                id,relative_path,media_kind,original_name,byte_size,modified_ns,modified_at,
                width,height,duration_ms,container,video_codec,scrub_frame_count
             ) VALUES(?1,'clip.mp4','video','clip.mp4',5,1,'2026-09-13T00:00:00Z',
                1920,1080,70000,'mp4','h264',0)",
            [&id],
        ).unwrap();
        let cover = temp.path().join("cover.png");
        image::RgbImage::from_pixel(120, 68, image::Rgb([12, 34, 56])).save(&cover).unwrap();

        library.set_private_vault_title(&id, Some("  내 영상  ")).unwrap();
        library.set_private_vault_thumbnail_from_file(&id, &cover).unwrap();

        let stored = index::find_by_id(&database, &id).unwrap().unwrap();
        assert_eq!(stored.title.as_deref(), Some("내 영상"));
        let expected_thumbnail = format!("custom-thumbnails/{id}.webp");
        assert_eq!(stored.custom_thumbnail_relative_path.as_deref(), Some(expected_thumbnail.as_str()));
        let custom = vault.join(".lakomics/custom-thumbnails").join(format!("{id}.webp"));
        assert!(custom.is_file());
        let mut media = library.resolve_private_vault_media(
            status.vault_id.as_deref().unwrap(),
            &id,
            PrivateVaultMediaVariant::Thumbnail,
        ).unwrap();
        assert_eq!(media.mime, "image/webp");
        let mut bytes = Vec::new();
        media.file.read_to_end(&mut bytes).unwrap();
        assert!(!bytes.is_empty());

        library.reset_private_vault_thumbnail(&id).unwrap();
        let stored = index::find_by_id(&database, &id).unwrap().unwrap();
        assert!(stored.custom_thumbnail_relative_path.is_none());
        assert!(!custom.exists());
    }
}

#[cfg(test)]
mod tests {
    use crate::library::Library;
    use std::fs;

    #[test]
    fn registration_preserves_vault_identity_and_unregister_keeps_vault_files() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();

        let first = library.register_private_vault(&vault).unwrap();
        assert!(first.registered && first.available);
        let vault_id = first.vault_id.clone().expect("registered vault id");
        let marker = vault.join(".lakomics/vault.json");
        assert!(marker.is_file());

        let second = library.register_private_vault(&vault).unwrap();
        assert_eq!(second.vault_id.as_deref(), Some(vault_id.as_str()));
        library.unregister_private_vault().unwrap();
        let status = library.private_vault_status().unwrap();
        assert!(!status.registered && !status.available);
        assert!(marker.is_file());
    }
}

#[cfg(test)]
mod isolation_tests {
    use crate::library::Library;

    #[test]
    fn scanning_external_vault_does_not_create_main_assets_or_cloud_queue_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        image::RgbImage::from_pixel(8, 6, image::Rgb([10, 20, 30]))
            .save(vault.join("secret.png"))
            .unwrap();

        library.register_private_vault(&vault).unwrap();
        let report = library.scan_private_vault().unwrap();
        assert_eq!(report.added, 1);

        let connection = library.connection().unwrap();
        let assets: i64 = connection
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .unwrap();
        let queued: i64 = connection
            .query_row("SELECT COUNT(*) FROM cloud_sync_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((assets, queued), (0, 0));
    }
}

#[cfg(test)]
mod root_boundary_tests {
    use crate::library::{error::LibraryError, Library};

    #[test]
    fn registration_rejects_roots_that_contain_or_are_inside_the_main_library() {
        let temp = tempfile::tempdir().unwrap();
        let library_root = temp.path().join("parent/library");
        let library = Library::open(&library_root).unwrap();
        let nested = library_root.join("external");
        std::fs::create_dir(&nested).unwrap();

        let nested_error = library.register_private_vault(&nested).unwrap_err();
        assert!(matches!(nested_error, LibraryError::UnsafeMediaPath));

        let parent_error = library
            .register_private_vault(temp.path().join("parent").as_path())
            .unwrap_err();
        assert!(matches!(parent_error, LibraryError::UnsafeMediaPath));
    }
}
