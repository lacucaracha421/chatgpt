use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use image::ImageDecoder;

use crate::library::{error::LibraryError, models::PrivateVaultScanReport};

use super::index::{self, IndexedVaultAsset};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum VaultMediaKind {
    Image,
    Gif,
    Video,
}

impl VaultMediaKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Gif => "gif",
            Self::Video => "video",
        }
    }
}

pub(super) struct PreparedMedia {
    pub width: u32,
    pub height: u32,
    pub duration_ms: Option<u64>,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub thumbnail_relative_path: Option<String>,
    pub playback_relative_path: Option<String>,
    pub scrub_relative_dir: Option<String>,
    pub scrub_frame_count: u32,
}

pub(super) trait MediaInspector {
    fn inspect(
        &self,
        source: &Path,
        kind: VaultMediaKind,
        asset_id: &str,
        metadata_root: &Path,
    ) -> Result<PreparedMedia, LibraryError>;
}

struct NativeMediaInspector;

impl MediaInspector for NativeMediaInspector {
    fn inspect(
        &self,
        source: &Path,
        kind: VaultMediaKind,
        asset_id: &str,
        metadata_root: &Path,
    ) -> Result<PreparedMedia, LibraryError> {
        match kind {
            VaultMediaKind::Image | VaultMediaKind::Gif => {
                prepare_image(source, asset_id, metadata_root)
            }
            VaultMediaKind::Video => prepare_video(source, asset_id, metadata_root),
        }
    }
}

pub(super) fn scan(root: &Path) -> Result<PrivateVaultScanReport, LibraryError> {
    scan_with_inspector(root, &NativeMediaInspector)
}

fn prepare_image(
    source: &Path,
    asset_id: &str,
    metadata_root: &Path,
) -> Result<PreparedMedia, LibraryError> {
    let reader = image::ImageReader::open(source)
        .map_err(|source_err| LibraryError::ReadMedia {
            path: source.to_path_buf(),
            source: source_err,
        })?
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| LibraryError::UnsupportedImage)?;
    image.apply_orientation(orientation);
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Err(LibraryError::UnsupportedImage);
    }
    let thumbnail_dir = metadata_root.join("thumbnails");
    fs::create_dir_all(&thumbnail_dir).map_err(|source_err| LibraryError::CreateDirectory {
        path: thumbnail_dir.clone(),
        source: source_err,
    })?;
    let thumbnail_name = format!("{asset_id}.webp");
    let thumbnail = thumbnail_dir.join(&thumbnail_name);
    let encoded = crate::library::ingestion::encode_thumbnail_webp(&image)?;
    fs::write(&thumbnail, encoded).map_err(|source_err| LibraryError::WriteAsset {
        path: thumbnail.clone(),
        source: source_err,
    })?;
    Ok(PreparedMedia {
        width,
        height,
        duration_ms: None,
        container: None,
        video_codec: None,
        audio_codec: None,
        thumbnail_relative_path: Some(format!("thumbnails/{thumbnail_name}")),
        playback_relative_path: None,
        scrub_relative_dir: None,
        scrub_frame_count: 0,
    })
}

fn prepare_video(
    source: &Path,
    asset_id: &str,
    metadata_root: &Path,
) -> Result<PreparedMedia, LibraryError> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or(LibraryError::UnsupportedVideo)?;
    let relative_dir = format!("media/{asset_id}");
    let destination = metadata_root.join(&relative_dir);
    let prepared =
        crate::library::video_media::prepare_external_video(source, extension, &destination)?;
    Ok(PreparedMedia {
        width: prepared.probe.width,
        height: prepared.probe.height,
        duration_ms: Some(prepared.probe.duration_ms),
        container: Some(prepared.probe.container),
        video_codec: Some(prepared.probe.video_codec),
        audio_codec: prepared.probe.audio_codec,
        thumbnail_relative_path: Some(format!("{relative_dir}/poster.webp")),
        playback_relative_path: prepared
            .uses_proxy
            .then(|| format!("{relative_dir}/playback.mp4")),
        scrub_relative_dir: Some(format!("{relative_dir}/scrub")),
        scrub_frame_count: prepared.scrub_frame_count,
    })
}

pub(super) fn scan_with_inspector(
    root: &Path,
    inspector: &impl MediaInspector,
) -> Result<PrivateVaultScanReport, LibraryError> {
    let metadata_root = root.join(".lakomics");
    fs::create_dir_all(&metadata_root).map_err(|source| LibraryError::CreateDirectory {
        path: metadata_root.clone(),
        source,
    })?;
    let database = metadata_root.join("index.sqlite");
    index::initialize_index(&database)?;
    let mut report = PrivateVaultScanReport::default();
    let mut seen = BTreeSet::new();

    let (files, unreadable) = media_files(root)?;
    report.failed += unreadable;
    for (source, relative_path, kind) in files {
        report.scanned += 1;
        seen.insert(relative_path.clone());
        let metadata = match source.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                report.failed += 1;
                continue;
            }
        };
        let byte_size = metadata.len();
        let (modified_ns, modified_at) = modified_stamp(&metadata);
        let existing = index::find_by_path(&database, &relative_path)?;
        if existing.as_ref().is_some_and(|row| {
            row.byte_size == byte_size && row.modified_ns == modified_ns && row.scan_error.is_none()
        }) {
            report.unchanged += 1;
            continue;
        }
        let id = existing
            .as_ref()
            .map(|row| row.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let original_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&relative_path)
            .to_owned();
        match inspector.inspect(&source, kind, &id, &metadata_root) {
            Ok(prepared) => {
                let asset = indexed_asset(
                    id,
                    relative_path,
                    kind,
                    original_name,
                    byte_size,
                    modified_ns,
                    modified_at,
                    prepared,
                    None,
                );
                index::upsert_asset(&database, &asset)?;
                if existing.is_some() {
                    report.updated += 1;
                } else {
                    report.added += 1;
                }
            }
            Err(error) => {
                report.failed += 1;
                let asset = indexed_asset(
                    id,
                    relative_path,
                    kind,
                    original_name,
                    byte_size,
                    modified_ns,
                    modified_at,
                    PreparedMedia::failed(),
                    Some(error.to_string()),
                );
                index::upsert_asset(&database, &asset)?;
            }
        }
    }

    for stale in index::all_assets(&database)?
        .into_iter()
        .filter(|asset| !seen.contains(&asset.relative_path))
    {
        cleanup_generated(&metadata_root, &stale.id);
        index::remove_indexed_asset(&database, &stale.id)?;
        report.removed += 1;
    }
    Ok(report)
}

fn indexed_asset(
    id: String,
    relative_path: String,
    kind: VaultMediaKind,
    original_name: String,
    byte_size: u64,
    modified_ns: i64,
    modified_at: String,
    prepared: PreparedMedia,
    scan_error: Option<String>,
) -> IndexedVaultAsset {
    IndexedVaultAsset {
        id,
        relative_path,
        media_kind: kind.as_str().into(),
        original_name,
        title: None,
        byte_size,
        modified_ns,
        modified_at,
        width: prepared.width.max(1),
        height: prepared.height.max(1),
        duration_ms: prepared.duration_ms,
        container: prepared.container,
        video_codec: prepared.video_codec,
        audio_codec: prepared.audio_codec,
        thumbnail_relative_path: prepared.thumbnail_relative_path,
        custom_thumbnail_relative_path: None,
        playback_relative_path: prepared.playback_relative_path,
        scrub_relative_dir: prepared.scrub_relative_dir,
        scrub_frame_count: prepared.scrub_frame_count,
        scan_error,
    }
}

impl PreparedMedia {
    fn failed() -> Self {
        Self {
            width: 1,
            height: 1,
            duration_ms: None,
            container: None,
            video_codec: None,
            audio_codec: None,
            thumbnail_relative_path: None,
            playback_relative_path: None,
            scrub_relative_dir: None,
            scrub_frame_count: 0,
        }
    }

    #[cfg(test)]
    fn fixture(kind: VaultMediaKind) -> Self {
        let video = kind == VaultMediaKind::Video;
        Self {
            width: 1280,
            height: 720,
            duration_ms: video.then_some(10_000),
            container: video.then(|| "mp4".into()),
            video_codec: video.then(|| "h264".into()),
            audio_codec: None,
            thumbnail_relative_path: Some("thumbnails/test.webp".into()),
            playback_relative_path: None,
            scrub_relative_dir: None,
            scrub_frame_count: 0,
        }
    }
}

fn media_files(root: &Path) -> Result<(Vec<(PathBuf, String, VaultMediaKind)>, u64), LibraryError> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut unreadable = 0_u64;
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(source) if directory == root => {
                return Err(LibraryError::ReadMedia { path: directory, source });
            }
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if !ignored_directory(&entry.file_name()) {
                    pending.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(kind) = media_kind(&path) else {
                continue;
            };
            let Some(relative_path) = relative_key(root, &path) else {
                continue;
            };
            files.push((path, relative_path, kind));
        }
    }
    files.sort_by(|left, right| left.1.cmp(&right.1));
    Ok((files, unreadable))
}

fn ignored_directory(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else { return true; };
    name == ".lakomics"
        || name.starts_with(".Trash-")
        || matches!(name, ".Trashes" | "$RECYCLE.BIN" | "System Volume Information" | "lost+found")
}

fn media_kind(path: &Path) -> Option<VaultMediaKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "gif" => Some(VaultMediaKind::Gif),
        "jpg" | "jpeg" | "jfif" | "png" | "webp" => Some(VaultMediaKind::Image),
        "mp4" | "webm" | "mov" => Some(VaultMediaKind::Video),
        _ => None,
    }
}

fn relative_key(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return None;
        };
        parts.push(value.to_str()?.to_owned());
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn modified_stamp(metadata: &fs::Metadata) -> (i64, String) {
    let duration = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .unwrap_or_default();
    let modified_ns = i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX);
    let modified_at =
        chrono::DateTime::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
            .unwrap_or(chrono::DateTime::UNIX_EPOCH)
            .to_rfc3339();
    (modified_ns, modified_at)
}

fn cleanup_generated(metadata_root: &Path, asset_id: &str) {
    if uuid::Uuid::parse_str(asset_id).is_err() {
        return;
    }
    let _ = fs::remove_file(
        metadata_root
            .join("thumbnails")
            .join(format!("{asset_id}.webp")),
    );
    let _ = fs::remove_file(
        metadata_root
            .join("custom-thumbnails")
            .join(format!("{asset_id}.webp")),
    );
    let _ = fs::remove_dir_all(metadata_root.join("media").join(asset_id));
}
#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{scan_with_inspector, MediaInspector, PreparedMedia, VaultMediaKind};
    use crate::library::error::LibraryError;
    use crate::library::models::{PrivateVaultQuery, PrivateVaultScanReport};

    #[derive(Default)]
    struct FakeInspector {
        calls: AtomicUsize,
    }

    impl MediaInspector for FakeInspector {
        fn inspect(
            &self,
            source: &std::path::Path,
            kind: VaultMediaKind,
            _asset_id: &str,
            _metadata_root: &std::path::Path,
        ) -> Result<PreparedMedia, LibraryError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if source.file_name().and_then(|name| name.to_str()) == Some("bad.png") {
                return Err(LibraryError::UnsupportedImage);
            }
            Ok(PreparedMedia::fixture(kind))
        }
    }

    #[test]
    fn scan_skips_desktop_trash_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".Trash-1000/files")).unwrap();
        fs::write(root.join("keep.png"), b"image").unwrap();
        fs::write(root.join(".Trash-1000/files/deleted.png"), b"trash").unwrap();
        let inspector = FakeInspector::default();

        let report = scan_with_inspector(root, &inspector).unwrap();

        assert_eq!(report.scanned, 1);
        let page = super::super::index::list_assets(
            &root.join(".lakomics/index.sqlite"),
            PrivateVaultQuery { media_kind: None, offset: 0, limit: 50 },
        ).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].original_name, "keep.png");
    }

    #[test]
    fn recursive_scan_is_incremental_skips_metadata_and_removes_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join(".lakomics")).unwrap();
        fs::write(root.join("nested/a.png"), b"image").unwrap();
        fs::write(root.join("clip.mp4"), b"video").unwrap();
        let inspector = FakeInspector::default();
        fs::write(root.join(".lakomics/ignored.png"), b"ignored").unwrap();

        let first = scan_with_inspector(root, &inspector).unwrap();
        assert_eq!((first.scanned, first.added, first.failed), (2, 2, 0));
        assert_eq!(inspector.calls.load(Ordering::SeqCst), 2);

        let second = scan_with_inspector(root, &inspector).unwrap();
        assert_eq!(second.unchanged, 2);
        assert_eq!(inspector.calls.load(Ordering::SeqCst), 2);

        fs::remove_file(root.join("clip.mp4")).unwrap();
        fs::write(root.join("bad.png"), b"bad").unwrap();
        let third: PrivateVaultScanReport = scan_with_inspector(root, &inspector).unwrap();
        assert_eq!(third.removed, 1);
        assert_eq!(third.failed, 1);

        let page = super::super::index::list_assets(
            &root.join(".lakomics/index.sqlite"),
            PrivateVaultQuery {
                media_kind: None,
                offset: 0,
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].original_name, "a.png");
    }
}
