use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use rusqlite::{Connection, OpenFlags};
use thiserror::Error;
use uuid::Uuid;

use super::{error::LibraryError, ingestion::encode_thumbnail_webp, lock::LibraryLease};

const DATABASE_NAME: &str = "library.sqlite";
const TEMP_MARKER: &str = ".lakomics-recompress-";

#[derive(Debug, Clone, Copy)]
pub struct ThumbnailRecompressOptions {
    pub apply: bool,
    pub limit: Option<usize>,
    pub all: bool,
}

impl ThumbnailRecompressOptions {
    pub fn dry_run() -> Self {
        Self {
            apply: false,
            limit: None,
            all: false,
        }
    }
}
#[derive(Debug, Default)]
pub struct ThumbnailRecompressReport {
    pub scanned: usize,
    pub scan_complete: bool,
    pub lossless: usize,
    pub lossy: usize,
    pub missing: usize,
    pub unknown: usize,
    pub thumbnail_bytes: u64,
    pub stale_temp_removed: usize,
    pub attempted: usize,
    pub recompressed: usize,
    pub skipped_not_smaller: usize,
    pub failed: usize,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub scan_ms: f64,
    pub apply_ms: f64,
    pub failures: Vec<String>,
}

impl ThumbnailRecompressReport {
    pub fn bytes_saved(&self) -> u64 {
        self.bytes_before.saturating_sub(self.bytes_after)
    }
}

#[derive(Debug, Error)]
pub enum ThumbnailMaintenanceError {
    #[error("invalid thumbnail recompression options: {0}")]
    InvalidOptions(&'static str),
    #[error(transparent)]
    Library(#[from] LibraryError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error("thumbnail maintenance I/O failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone)]
struct ThumbnailCandidate {
    id: String,
    relative_path: PathBuf,
    thumbnail_relative_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThumbnailFormat {
    Lossless,
    Lossy,
    Missing,
    Unknown,
}

#[derive(Debug)]
struct ScannedThumbnail {
    candidate: ThumbnailCandidate,
    format: ThumbnailFormat,
    bytes: u64,
}

#[derive(Debug)]
enum RecompressOutcome {
    Recompressed { before: u64, after: u64 },
    NotSmaller { before: u64 },
}
pub fn recompress_thumbnails(
    root: &Path,
    options: ThumbnailRecompressOptions,
) -> Result<ThumbnailRecompressReport, ThumbnailMaintenanceError> {
    validate_options(options)?;
    let _lease = if options.apply {
        Some(LibraryLease::acquire(root)?)
    } else {
        None
    };

    let mut report = ThumbnailRecompressReport::default();
    if options.apply {
        report.stale_temp_removed = cleanup_stale_temp_files(&root.join("thumbnails"))?;
    }

    let scan_started = Instant::now();
    let candidates = load_candidates(root)?;
    let candidate_count = candidates.len();
    let max_selected = options.limit.unwrap_or(usize::MAX);
    let mut selected_lossless = 0usize;
    let mut scanned = Vec::with_capacity(if options.apply {
        max_selected.min(candidate_count)
    } else {
        candidate_count
    });
    for candidate in candidates {
        let path = root.join(&candidate.thumbnail_relative_path);
        let (format, bytes) = inspect_thumbnail(&path)?;
        report.scanned += 1;
        report.thumbnail_bytes = report.thumbnail_bytes.saturating_add(bytes);
        match format {
            ThumbnailFormat::Lossless => {
                report.lossless += 1;
                selected_lossless += 1;
            }
            ThumbnailFormat::Lossy => report.lossy += 1,
            ThumbnailFormat::Missing => report.missing += 1,
            ThumbnailFormat::Unknown => report.unknown += 1,
        }
        scanned.push(ScannedThumbnail {
            candidate,
            format,
            bytes,
        });
        if options.apply && !options.all && selected_lossless >= max_selected {
            break;
        }
    }
    report.scan_complete = report.scanned == candidate_count;
    report.scan_ms = scan_started.elapsed().as_secs_f64() * 1000.0;
    if !options.apply {
        return Ok(report);
    }

    let apply_started = Instant::now();
    for item in scanned
        .into_iter()
        .filter(|item| item.format == ThumbnailFormat::Lossless)
    {
        report.attempted += 1;
        match recompress_one(root, &item) {
            Ok(RecompressOutcome::Recompressed { before, after }) => {
                report.recompressed += 1;
                report.bytes_before = report.bytes_before.saturating_add(before);
                report.bytes_after = report.bytes_after.saturating_add(after);
            }
            Ok(RecompressOutcome::NotSmaller { before }) => {
                report.skipped_not_smaller += 1;
                report.bytes_before = report.bytes_before.saturating_add(before);
                report.bytes_after = report.bytes_after.saturating_add(before);
            }
            Err(error) => {
                report.failed += 1;
                report
                    .failures
                    .push(format!("{}: {error}", item.candidate.id));
            }
        }
    }
    report.apply_ms = apply_started.elapsed().as_secs_f64() * 1000.0;
    Ok(report)
}

fn validate_options(options: ThumbnailRecompressOptions) -> Result<(), ThumbnailMaintenanceError> {
    if options.apply && options.limit.is_none() && !options.all {
        return Err(ThumbnailMaintenanceError::InvalidOptions(
            "--apply requires --limit N or --all",
        ));
    }
    if !options.apply && (options.limit.is_some() || options.all) {
        return Err(ThumbnailMaintenanceError::InvalidOptions(
            "--limit/--all require --apply",
        ));
    }
    if options.limit == Some(0) {
        return Err(ThumbnailMaintenanceError::InvalidOptions(
            "--limit must be greater than zero",
        ));
    }
    if options.limit.is_some() && options.all {
        return Err(ThumbnailMaintenanceError::InvalidOptions(
            "choose either --limit N or --all",
        ));
    }
    Ok(())
}

fn load_candidates(root: &Path) -> Result<Vec<ThumbnailCandidate>, ThumbnailMaintenanceError> {
    let database = root.join(DATABASE_NAME);
    let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement = connection.prepare(
        "SELECT id, relative_path, thumbnail_relative_path
         FROM assets
         WHERE media_kind IN ('image', 'gif')
           AND thumbnail_relative_path IS NOT NULL
         ORDER BY id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ThumbnailCandidate {
            id: row.get(0)?,
            relative_path: PathBuf::from(row.get::<_, String>(1)?),
            thumbnail_relative_path: PathBuf::from(row.get::<_, String>(2)?),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn inspect_thumbnail(path: &Path) -> Result<(ThumbnailFormat, u64), ThumbnailMaintenanceError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok((ThumbnailFormat::Missing, 0));
        }
        Err(source) => return Err(io_error(path, source)),
    };
    let mut file = File::open(path).map_err(|source| io_error(path, source))?;
    let mut header = vec![0u8; 4096.min(metadata.len() as usize)];
    file.read_exact(&mut header)
        .map_err(|source| io_error(path, source))?;
    let mut format = classify_webp(&header);
    if format == ThumbnailFormat::Unknown && metadata.len() as usize > header.len() {
        let bytes = fs::read(path).map_err(|source| io_error(path, source))?;
        format = classify_webp(&bytes);
    }
    Ok((format, metadata.len()))
}

fn classify_webp(bytes: &[u8]) -> ThumbnailFormat {
    webp::BitstreamFeatures::new(bytes)
        .and_then(|features| features.format())
        .map(|format| match format {
            webp::BitstreamFormat::Lossless => ThumbnailFormat::Lossless,
            webp::BitstreamFormat::Lossy => ThumbnailFormat::Lossy,
            webp::BitstreamFormat::Undefined => ThumbnailFormat::Unknown,
        })
        .unwrap_or(ThumbnailFormat::Unknown)
}

fn recompress_one(root: &Path, item: &ScannedThumbnail) -> Result<RecompressOutcome, String> {
    let original_path = root.join(&item.candidate.relative_path);
    let thumbnail_path = root.join(&item.candidate.thumbnail_relative_path);
    let reader = image::ImageReader::open(&original_path)
        .map_err(|error| format!("open original {}: {error}", original_path.display()))?
        .with_guessed_format()
        .map_err(|error| format!("inspect original {}: {error}", original_path.display()))?;
    let image = reader
        .decode()
        .map_err(|error| format!("decode original {}: {error}", original_path.display()))?;
    let encoded = encode_thumbnail_webp(&image).map_err(|error| error.to_string())?;
    validate_encoded_thumbnail(&encoded)?;
    let before = item.bytes;
    let after = encoded.len() as u64;
    if after >= before {
        return Ok(RecompressOutcome::NotSmaller { before });
    }

    let parent = thumbnail_path
        .parent()
        .ok_or_else(|| format!("thumbnail has no parent: {}", thumbnail_path.display()))?;
    let file_name = thumbnail_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("thumbnail.webp");
    let temp_path = parent.join(format!(".{file_name}{TEMP_MARKER}{}.tmp", Uuid::new_v4()));

    let replace_result = write_and_replace(&temp_path, &thumbnail_path, &encoded);
    if replace_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    replace_result.map_err(|error| format!("replace {}: {error}", thumbnail_path.display()))?;
    Ok(RecompressOutcome::Recompressed { before, after })
}

fn validate_encoded_thumbnail(encoded: &[u8]) -> Result<(), String> {
    let features = webp::BitstreamFeatures::new(encoded)
        .ok_or_else(|| "encoded thumbnail has invalid WebP features".to_owned())?;
    if !matches!(features.format(), Some(webp::BitstreamFormat::Lossy)) {
        return Err("encoded thumbnail is not lossy WebP".to_owned());
    }
    let decoded = image::load_from_memory_with_format(encoded, image::ImageFormat::WebP)
        .map_err(|error| format!("encoded thumbnail cannot be decoded: {error}"))?;
    if decoded.width() == 0
        || decoded.height() == 0
        || decoded.width() > 360
        || decoded.height() > 360
    {
        return Err(format!(
            "encoded thumbnail has invalid dimensions {}x{}",
            decoded.width(),
            decoded.height()
        ));
    }
    Ok(())
}

fn write_and_replace(temp_path: &Path, destination: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temp = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temp_path)?;
    temp.write_all(bytes)?;
    temp.sync_all()?;
    drop(temp);
    replace_file(temp_path, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            source.as_ptr(),
            ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn cleanup_stale_temp_files(root: &Path) -> Result<usize, ThumbnailMaintenanceError> {
    if !root.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|source| io_error(&directory, source))? {
            let entry = entry.map_err(|source| io_error(&directory, source))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|source| io_error(&path, source))?;
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.contains(TEMP_MARKER) && name.ends_with(".tmp") {
                fs::remove_file(&path).map_err(|source| io_error(&path, source))?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn io_error(path: &Path, source: std::io::Error) -> ThumbnailMaintenanceError {
    ThumbnailMaintenanceError::Io {
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb, Rgba};
    use rusqlite::params;
    use tempfile::TempDir;

    use super::*;

    struct Fixture {
        _temp: TempDir,
        root: PathBuf,
        connection: Connection,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("library");
            fs::create_dir_all(root.join("assets/aa")).unwrap();
            fs::create_dir_all(root.join("thumbnails/aa")).unwrap();
            let connection = Connection::open(root.join(DATABASE_NAME)).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE assets (
                        id TEXT PRIMARY KEY,
                        media_kind TEXT NOT NULL,
                        relative_path TEXT NOT NULL,
                        thumbnail_relative_path TEXT
                    );",
                )
                .unwrap();
            Self {
                _temp: temp,
                root,
                connection,
            }
        }

        fn add_lossless(&self, id: &str, seed: u32) {
            let relative = format!("assets/aa/{id}.png");
            let thumbnail = format!("thumbnails/aa/{id}.webp");
            let image = detailed_image(720, 480, seed);
            image
                .save_with_format(self.root.join(&relative), ImageFormat::Png)
                .unwrap();
            let thumb = image.thumbnail(360, 360);
            let mut cursor = std::io::Cursor::new(Vec::new());
            thumb.write_to(&mut cursor, ImageFormat::WebP).unwrap();
            fs::write(self.root.join(&thumbnail), cursor.into_inner()).unwrap();
            self.connection
                .execute(
                    "INSERT INTO assets (id, media_kind, relative_path, thumbnail_relative_path)
                     VALUES (?1, 'image', ?2, ?3)",
                    params![id, relative, thumbnail],
                )
                .unwrap();
        }
    }

    fn detailed_image(width: u32, height: u32, seed: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            let value = x.wrapping_mul(1_664_525)
                ^ y.wrapping_mul(1_013_904_223)
                ^ seed.wrapping_mul(2_654_435_761);
            Rgb([(value >> 16) as u8, (value >> 8) as u8, value as u8])
        }))
    }
    #[test]
    fn dry_run_reports_lossless_without_mutation() {
        let fixture = Fixture::new();
        fixture.add_lossless("one", 1);
        let before = fs::read(fixture.root.join("thumbnails/aa/one.webp")).unwrap();

        let report =
            recompress_thumbnails(&fixture.root, ThumbnailRecompressOptions::dry_run()).unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.lossless, 1);
        assert_eq!(report.lossy, 0);
        assert_eq!(report.attempted, 0);
        assert_eq!(
            fs::read(fixture.root.join("thumbnails/aa/one.webp")).unwrap(),
            before
        );
    }

    #[test]
    fn apply_limit_is_resumable_and_skips_completed_files() {
        let fixture = Fixture::new();
        fixture.add_lossless("one", 1);
        fixture.add_lossless("two", 2);
        drop(fixture.connection);

        let first = recompress_thumbnails(
            &fixture.root,
            ThumbnailRecompressOptions {
                apply: true,
                limit: Some(1),
                all: false,
            },
        )
        .unwrap();
        assert_eq!(first.recompressed, 1);
        assert!(!first.scan_complete);
        assert_eq!(first.failed, 0);

        let middle =
            recompress_thumbnails(&fixture.root, ThumbnailRecompressOptions::dry_run()).unwrap();
        assert_eq!(middle.lossless, 1);
        assert_eq!(middle.lossy, 1);
        let second = recompress_thumbnails(
            &fixture.root,
            ThumbnailRecompressOptions {
                apply: true,
                limit: None,
                all: true,
            },
        )
        .unwrap();
        assert_eq!(second.recompressed, 1);
        assert_eq!(second.failed, 0);

        let final_report =
            recompress_thumbnails(&fixture.root, ThumbnailRecompressOptions::dry_run()).unwrap();
        assert_eq!(final_report.lossless, 0);
        assert_eq!(final_report.lossy, 2);
    }

    #[test]
    fn inspect_thumbnail_recognizes_large_lossy_alpha_webp() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("alpha.webp");
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(360, 360, |x, y| {
            let seed = x
                .wrapping_mul(1_664_525)
                .wrapping_add(y.wrapping_mul(1_013_904_223))
                .wrapping_add((x ^ y).wrapping_mul(2_654_435_761));
            Rgba([
                (seed >> 16) as u8,
                (seed >> 8) as u8,
                seed as u8,
                seed.rotate_left(7) as u8,
            ])
        }));
        let encoded = encode_thumbnail_webp(&image).unwrap();
        assert!(encoded.len() > 4096);
        fs::write(&path, &encoded).unwrap();

        let (format, bytes) = inspect_thumbnail(&path).unwrap();

        assert_eq!(format, ThumbnailFormat::Lossy);
        assert_eq!(bytes, encoded.len() as u64);
    }

    #[cfg(windows)]
    #[test]
    fn apply_refuses_an_active_library_lease() {
        let fixture = Fixture::new();
        fixture.add_lossless("one", 1);
        drop(fixture.connection);
        let _lease = LibraryLease::acquire(&fixture.root).unwrap();

        let error = recompress_thumbnails(
            &fixture.root,
            ThumbnailRecompressOptions {
                apply: true,
                limit: Some(1),
                all: false,
            },
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ThumbnailMaintenanceError::Library(LibraryError::LibraryInUse)
        ));
    }
}
