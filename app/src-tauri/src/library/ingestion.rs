use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "linux")]
use std::{ffi::CString, os::unix::ffi::OsStrExt};

use image::{ImageFormat, ImageReader};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};

use super::{
    error::LibraryError,
    models::{AssetSummary, IngestImageRequest, IngestOutcome},
    Library,
};

const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 200_000_000;

impl Library {
    pub fn ingest_image(&self, request: IngestImageRequest) -> Result<IngestOutcome, LibraryError> {
        let _ingestion_guard = self
            .ingestion_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let source_metadata = fs::metadata(&request.source_path)
            .map_err(|source| read_source_error(&request.source_path, source))?;
        if !source_metadata.is_file() {
            return Err(read_source_error(
                &request.source_path,
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "source path is not a regular file",
                ),
            ));
        }
        if source_metadata.len() > MAX_IMAGE_BYTES {
            return Err(LibraryError::UnsupportedImage);
        }

        self.validate_classification(request.classification_id.as_deref())?;

        let staging_directory = self.root().join("assets").join(".staging");
        fs::create_dir_all(&staging_directory).map_err(|source| LibraryError::WriteAsset {
            path: staging_directory.clone(),
            source,
        })?;
        let staging_path = staging_directory.join(format!("{}.part", uuid::Uuid::new_v4()));
        let mut pending = PendingFiles::new();
        let (content_hash, byte_size) =
            copy_and_hash(&request.source_path, &staging_path, &mut pending)?;
        run_staging_hook(&staging_path);

        let (format, width, height) = inspect_image(pending.owned_file(&staging_path)?)?;
        let existing_asset_id = self.find_asset_by_hash(&content_hash)?;
        if let Some(existing_asset_id) = existing_asset_id {
            return Ok(IngestOutcome::ExactDuplicate { existing_asset_id });
        }
        run_after_duplicate_hook(self.root());

        let prefix = &content_hash[..2];
        let thumbnail_relative_path = format!("thumbnails/{prefix}/{content_hash}.webp");
        let thumbnail_path = self.root().join(&thumbnail_relative_path);
        create_parent_directory(&thumbnail_path)?;
        let thumbnail_file = create_new_asset_file(&thumbnail_path)?;
        pending.track_created(thumbnail_path.clone(), &thumbnail_file)?;
        write_thumbnail(pending.owned_file(&staging_path)?, thumbnail_file)?;

        let relative_path = format!(
            "assets/{prefix}/{content_hash}.{}",
            extension_for(format).expect("inspect_image only returns supported formats")
        );
        let asset_path = self.root().join(&relative_path);
        create_parent_directory(&asset_path)?;
        install_staged_asset(&staging_path, &asset_path, &mut pending)?;

        let asset = AssetSummary {
            id: uuid::Uuid::new_v4().to_string(),
            title: None,
            original_name: original_name(&request.source_path),
            relative_path,
            thumbnail_relative_path,
            byte_size,
            width,
            height,
            collected_at: chrono::Utc::now().to_rfc3339(),
            favorite: false,
            source_url: request.source_url.clone(),
        };
        self.register_asset(
            &asset,
            &content_hash,
            format,
            request.classification_id.as_deref(),
            request.source_url,
        )?;

        pending.commit();
        Ok(IngestOutcome::Added { asset })
    }

    fn validate_classification(&self, classification_id: Option<&str>) -> Result<(), LibraryError> {
        let Some(classification_id) = classification_id else {
            return Ok(());
        };
        let connection = self.connection()?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
            [classification_id],
            |row| row.get(0),
        )?;
        if exists {
            Ok(())
        } else {
            Err(LibraryError::ClassificationNotFound)
        }
    }

    fn find_asset_by_hash(&self, content_hash: &str) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id FROM assets WHERE content_hash = ?1",
                [content_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn register_asset(
        &self,
        asset: &AssetSummary,
        content_hash: &str,
        format: ImageFormat,
        classification_id: Option<&str>,
        source_url: Option<String>,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, title, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, source_url,
                collected_at, favorite, status
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'normal'
            )",
            params![
                asset.id,
                content_hash,
                media_kind(format),
                asset.title,
                asset.original_name,
                asset.relative_path,
                asset.thumbnail_relative_path,
                asset.byte_size as i64,
                asset.width as i64,
                asset.height as i64,
                source_url,
                asset.collected_at,
                i64::from(asset.favorite),
            ],
        )?;
        if let Some(classification_id) = classification_id {
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                params![asset.id, classification_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

fn copy_and_hash(
    source_path: &Path,
    staging_path: &Path,
    pending: &mut PendingFiles,
) -> Result<(String, u64), LibraryError> {
    let mut source =
        File::open(source_path).map_err(|source| read_source_error(source_path, source))?;
    let mut staging = create_new_asset_file(staging_path)?;
    pending.track_staging(staging_path.to_path_buf(), &staging)?;
    let mut hasher = Sha256::new();
    let mut byte_size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|source| read_source_error(source_path, source))?;
        if read == 0 {
            break;
        }
        byte_size = byte_size
            .checked_add(read as u64)
            .ok_or(LibraryError::UnsupportedImage)?;
        if byte_size > MAX_IMAGE_BYTES {
            return Err(LibraryError::UnsupportedImage);
        }
        staging
            .write_all(&buffer[..read])
            .map_err(|source| LibraryError::WriteAsset {
                path: staging_path.to_path_buf(),
                source,
            })?;
        hasher.update(&buffer[..read]);
    }
    staging.flush().map_err(|source| LibraryError::WriteAsset {
        path: staging_path.to_path_buf(),
        source,
    })?;

    Ok((hex::encode(hasher.finalize()), byte_size))
}

fn inspect_image(staging: File) -> Result<(ImageFormat, u32, u32), LibraryError> {
    let reader = staging_image_reader(staging)?;
    let format = reader
        .format()
        .filter(|format| extension_for(*format).is_some())
        .ok_or(LibraryError::UnsupportedImage)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(LibraryError::UnsupportedImage)?;
    if pixels > MAX_IMAGE_PIXELS {
        return Err(LibraryError::UnsupportedImage);
    }
    Ok((format, width, height))
}

fn write_thumbnail(staging: File, mut thumbnail_file: File) -> Result<(), LibraryError> {
    let reader = staging_image_reader(staging)?;
    let image = reader
        .decode()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    image
        .thumbnail(360, 360)
        .write_to(&mut thumbnail_file, ImageFormat::WebP)
        .map_err(|_| LibraryError::UnsupportedImage)
}

fn staging_image_reader(mut staging: File) -> Result<ImageReader<BufReader<File>>, LibraryError> {
    staging
        .seek(SeekFrom::Start(0))
        .map_err(|_| LibraryError::UnsupportedImage)?;
    ImageReader::new(BufReader::new(staging))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)
}

fn create_parent_directory(path: &Path) -> Result<(), LibraryError> {
    let parent = path
        .parent()
        .expect("library asset paths have a parent directory");
    fs::create_dir_all(parent).map_err(|source| LibraryError::WriteAsset {
        path: parent.to_path_buf(),
        source,
    })
}

fn create_new_asset_file(path: &Path) -> Result<File, LibraryError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| LibraryError::WriteAsset {
            path: path.to_path_buf(),
            source,
        })
}

fn install_staged_asset(
    staging_path: &Path,
    asset_path: &Path,
    pending: &mut PendingFiles,
) -> Result<(), LibraryError> {
    let mut staging = pending.owned_file(staging_path)?;
    staging
        .seek(SeekFrom::Start(0))
        .map_err(|source| LibraryError::WriteAsset {
            path: staging_path.to_path_buf(),
            source,
        })?;
    let mut asset = create_new_asset_file(asset_path)?;
    pending.track_created(asset_path.to_path_buf(), &asset)?;
    io::copy(&mut staging, &mut asset).map_err(|source| LibraryError::WriteAsset {
        path: asset_path.to_path_buf(),
        source,
    })?;
    asset.flush().map_err(|source| LibraryError::WriteAsset {
        path: asset_path.to_path_buf(),
        source,
    })?;
    drop(asset);
    drop(staging);
    pending.remove_owned(staging_path)
}

fn extension_for(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Jpeg => Some("jpg"),
        ImageFormat::Png => Some("png"),
        ImageFormat::Gif => Some("gif"),
        ImageFormat::WebP => Some("webp"),
        _ => None,
    }
}

fn media_kind(format: ImageFormat) -> &'static str {
    if format == ImageFormat::Gif {
        "gif"
    } else {
        "image"
    }
}

fn original_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn read_source_error(path: &Path, source: io::Error) -> LibraryError {
    LibraryError::ReadSource {
        path: path.to_path_buf(),
        source,
    }
}

struct PendingFiles {
    files: Vec<PendingFile>,
    committed: bool,
}

impl PendingFiles {
    fn new() -> Self {
        Self {
            files: Vec::new(),
            committed: false,
        }
    }

    fn track_created(&mut self, path: PathBuf, file: &File) -> Result<(), LibraryError> {
        let identity =
            FileIdentity::from_file(file).map_err(|source| LibraryError::WriteAsset {
                path: path.clone(),
                source,
            })?;
        self.files.push(PendingFile {
            path,
            identity,
            file: None,
        });
        Ok(())
    }

    fn track_staging(&mut self, path: PathBuf, file: &File) -> Result<(), LibraryError> {
        let identity =
            FileIdentity::from_file(file).map_err(|source| LibraryError::WriteAsset {
                path: path.clone(),
                source,
            })?;
        let file = file
            .try_clone()
            .map_err(|source| LibraryError::WriteAsset {
                path: path.clone(),
                source,
            })?;
        self.files.push(PendingFile {
            path,
            identity,
            file: Some(file),
        });
        Ok(())
    }

    fn owned_file(&self, path: &Path) -> Result<File, LibraryError> {
        let pending_file = self
            .files
            .iter()
            .find(|pending_file| pending_file.path == path)
            .ok_or_else(|| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::NotFound, "owned pending file not found"),
            })?;
        pending_file
            .file
            .as_ref()
            .ok_or_else(|| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::NotFound, "owned pending file is closed"),
            })?
            .try_clone()
            .map_err(|source| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source,
            })
    }

    fn remove_owned(&mut self, path: &Path) -> Result<(), LibraryError> {
        let index = self
            .files
            .iter()
            .position(|pending_file| pending_file.path == path)
            .ok_or_else(|| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::NotFound, "owned pending file not found"),
            })?;
        remove_pending_file(&mut self.files[index]).map_err(|source| LibraryError::WriteAsset {
            path: path.to_path_buf(),
            source,
        })?;
        self.files.remove(index);
        Ok(())
    }

    #[cfg(test)]
    fn track(&mut self, path: PathBuf) {
        let file = File::open(&path).unwrap();
        self.track_staging(path, &file).unwrap();
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PendingFiles {
    fn drop(&mut self) {
        if !self.committed {
            for pending_file in self.files.iter_mut().rev() {
                let _ = remove_pending_file(pending_file);
            }
        }
    }
}

struct PendingFile {
    path: PathBuf,
    identity: FileIdentity,
    file: Option<File>,
}

fn remove_pending_file(pending_file: &mut PendingFile) -> io::Result<()> {
    drop(pending_file.file.take());
    let Some(quarantine_path) = claim_path(&pending_file.path)? else {
        return Ok(());
    };
    if !pending_file.identity.matches_path(&quarantine_path) {
        restore_unverified_file(&quarantine_path, &pending_file.path)?;
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "pending path was replaced before cleanup",
        ));
    }
    // Lakomics ingests for this Library are serialized. This identity check is
    // defense in depth, not an atomic conditional unlink against external writers.
    fs::remove_file(quarantine_path)
}

fn claim_path(path: &Path) -> io::Result<Option<PathBuf>> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "pending path has no parent directory",
        )
    })?;
    let quarantine_path = parent.join(format!(".{}.cleanup", uuid::Uuid::new_v4()));
    match rename_no_replace(path, &quarantine_path) {
        Ok(()) => Ok(Some(quarantine_path)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(source),
    }
}

fn restore_unverified_file(quarantine_path: &Path, original_path: &Path) -> io::Result<()> {
    rename_no_replace(quarantine_path, original_path)
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    // SAFETY: both C strings are NUL-terminated and remain valid for the call.
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "safe pending-file cleanup is supported on Windows and Linux",
    ))
}

#[cfg(test)]
type StagingHook = Box<dyn FnOnce(&Path)>;

#[cfg(test)]
thread_local! {
    static STAGING_HOOK: std::cell::RefCell<Option<StagingHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_staging_hook(hook: impl FnOnce(&Path) + 'static) {
    STAGING_HOOK.with(|staging_hook| *staging_hook.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_staging_hook(path: &Path) {
    STAGING_HOOK.with(|staging_hook| {
        if let Some(hook) = staging_hook.borrow_mut().take() {
            hook(path);
        }
    });
}

#[cfg(not(test))]
fn run_staging_hook(_path: &Path) {}

#[cfg(test)]
type AfterDuplicateHook = std::sync::Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
static AFTER_DUPLICATE_HOOK: std::sync::Mutex<Option<(PathBuf, AfterDuplicateHook)>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
fn set_after_duplicate_hook(root: PathBuf, hook: impl Fn() + Send + Sync + 'static) {
    *AFTER_DUPLICATE_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((root, std::sync::Arc::new(hook)));
}

#[cfg(test)]
fn clear_after_duplicate_hook() {
    AFTER_DUPLICATE_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
}

#[cfg(test)]
fn run_after_duplicate_hook(root: &Path) {
    let hook = AFTER_DUPLICATE_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(hook_root, _)| hook_root == root)
        .map(|(_, hook)| std::sync::Arc::clone(hook));
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(not(test))]
fn run_after_duplicate_hook(_root: &Path) {}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl FileIdentity {
    fn from_file(file: &File) -> io::Result<Self> {
        use std::os::unix::fs::MetadataExt;

        let metadata = file.metadata()?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    fn matches_path(&self, path: &Path) -> bool {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
            _ => return false,
        };
        use std::os::unix::fs::MetadataExt;

        self.device == metadata.dev() && self.inode == metadata.ino()
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume_serial_number: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
impl FileIdentity {
    fn from_file(file: &File) -> io::Result<Self> {
        let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        // SAFETY: the file handle is valid for this call, and the API initializes the buffer on success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetFileInformationByHandle reported success above.
        let information = unsafe { information.assume_init() };
        Ok(Self {
            volume_serial_number: information.dwVolumeSerialNumber,
            file_index_high: information.nFileIndexHigh,
            file_index_low: information.nFileIndexLow,
        })
    }

    fn matches_path(&self, path: &Path) -> bool {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {}
            _ => return false,
        }
        let file = match File::open(path) {
            Ok(file) => file,
            Err(_) => return false,
        };
        Self::from_file(&file).is_ok_and(|identity| identity == *self)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        time::Duration,
    };

    use tempfile::TempDir;

    use super::{
        clear_after_duplicate_hook, copy_and_hash, install_staged_asset, set_after_duplicate_hook,
        set_staging_hook, LibraryError, PendingFiles,
    };
    use crate::library::{
        models::{ClassificationKind, CreateClassification, IngestImageRequest, IngestOutcome},
        Library,
    };

    struct IngestionFixture {
        _temp: TempDir,
        library: Library,
        source: PathBuf,
    }

    impl IngestionFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source.png");
            write_test_png(&source, [10, 20, 30]);
            let library = Library::open(temp.path().join("library")).unwrap();

            Self {
                _temp: temp,
                library,
                source,
            }
        }

        fn ingest(&self) -> IngestOutcome {
            self.library
                .ingest_image(IngestImageRequest {
                    source_path: self.source.clone(),
                    classification_id: None,
                    source_url: None,
                })
                .unwrap()
        }
    }

    fn write_test_png(path: &Path, rgb: [u8; 3]) {
        let image = image::RgbImage::from_pixel(8, 6, image::Rgb(rgb));
        image
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    #[test]
    fn ingest_copies_the_image_and_keeps_the_user_source() {
        let fixture = IngestionFixture::new();

        let outcome = fixture.ingest();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert!(fixture.source.is_file());
        assert!(fixture.library.root().join(&asset.relative_path).is_file());
        assert!(fixture
            .library
            .root()
            .join(&asset.thumbnail_relative_path)
            .is_file());
    }

    #[test]
    fn ingesting_the_same_bytes_twice_returns_the_existing_asset() {
        let fixture = IngestionFixture::new();
        let first = fixture.ingest();
        let second = fixture.ingest();

        let IngestOutcome::Added { asset } = first else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(
            second,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id,
            },
        );
        assert_eq!(fixture.library.summary().unwrap().asset_count, 1);
    }

    #[test]
    fn exact_duplicate_keeps_the_existing_asset_classifications() {
        let fixture = IngestionFixture::new();
        let original_classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "original".into(),
                parent_id: None,
            })
            .unwrap();
        let duplicate_classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "duplicate".into(),
                parent_id: None,
            })
            .unwrap();
        let IngestOutcome::Added { asset } = fixture.ingest() else {
            panic!("first ingest must add an asset");
        };
        fixture
            .library
            .set_asset_classifications(&asset.id, std::slice::from_ref(&original_classification.id))
            .unwrap();

        let outcome = fixture
            .library
            .ingest_image(IngestImageRequest {
                source_path: fixture.source.clone(),
                classification_id: Some(duplicate_classification.id),
                source_url: Some("https://example.test/duplicate".into()),
            })
            .unwrap();

        assert_eq!(
            outcome,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id.clone(),
            },
        );
        assert_eq!(
            fixture
                .library
                .get_asset_classifications(&asset.id)
                .unwrap(),
            vec![original_classification],
        );
    }

    #[test]
    fn failed_ingest_keeps_source_and_does_not_leave_a_registered_file() {
        let fixture = IngestionFixture::new();

        let result = fixture.library.ingest_image(IngestImageRequest {
            source_path: fixture.source.clone(),
            classification_id: Some("missing-classification".into()),
            source_url: None,
        });

        assert!(result.is_err());
        assert!(fixture.source.is_file());
        assert_eq!(fixture.library.summary().unwrap().asset_count, 0);
    }

    #[test]
    fn unsupported_image_removes_the_staged_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("not-an-image.bin");
        std::fs::write(&source, b"not an image").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();

        let result = library.ingest_image(IngestImageRequest {
            source_path: source.clone(),
            classification_id: None,
            source_url: None,
        });

        assert!(result.is_err());
        assert!(source.is_file());
        assert!(library
            .root()
            .join("assets/.staging")
            .read_dir()
            .unwrap()
            .next()
            .is_none());
        assert_eq!(library.summary().unwrap().asset_count, 0);
    }

    #[test]
    fn existing_staging_file_is_never_truncated_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.bin");
        let staging = temp.path().join("foreign.part");
        std::fs::write(&source, b"new source bytes").unwrap();
        std::fs::write(&staging, b"foreign staging bytes").unwrap();

        let mut pending = PendingFiles::new();
        let result = copy_and_hash(&source, &staging, &mut pending);

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign staging bytes");
    }

    #[test]
    fn existing_asset_destination_is_never_overwritten_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("owned.part");
        let asset = temp.path().join("foreign.png");
        std::fs::write(&staging, b"owned staging bytes").unwrap();
        std::fs::write(&asset, b"foreign asset bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(staging.clone());

        let result = install_staged_asset(&staging, &asset, &mut pending);

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(&asset).unwrap(), b"foreign asset bytes");
        assert_eq!(std::fs::read(&staging).unwrap(), b"owned staging bytes");
    }

    #[test]
    fn cleanup_keeps_a_file_replaced_after_it_was_tracked() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owned.part");
        std::fs::write(&path, b"owned bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(path.clone());

        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"foreign replacement").unwrap();
        drop(pending);

        assert_eq!(std::fs::read(&path).unwrap(), b"foreign replacement");
    }

    #[test]
    fn staging_replacement_before_install_is_never_copied_or_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("owned.part");
        let asset = temp.path().join("asset.png");
        std::fs::write(&staging, b"owned staging bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(staging.clone());

        std::fs::remove_file(&staging).unwrap();
        std::fs::write(&staging, b"foreign replacement").unwrap();
        let result = install_staged_asset(&staging, &asset, &mut pending);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign replacement");
        drop(pending);
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign replacement");
        assert!(!asset.exists());
    }

    #[test]
    fn staging_replacement_is_never_inspected_or_thumbnail_copied() {
        let fixture = IngestionFixture::new();
        let replacement = b"foreign invalid image".to_vec();
        let replaced_path = Arc::new(Mutex::new(None));
        let replaced_path_for_hook = Arc::clone(&replaced_path);
        set_staging_hook(move |staging_path| {
            std::fs::remove_file(staging_path).unwrap();
            std::fs::write(staging_path, &replacement).unwrap();
            *replaced_path_for_hook.lock().unwrap() = Some(staging_path.to_path_buf());
        });

        let error = fixture
            .library
            .ingest_image(IngestImageRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: None,
            })
            .unwrap_err();

        assert!(
            matches!(error, LibraryError::WriteAsset { .. }),
            "the retained valid image should reach identity-bound cleanup: {error:?}"
        );
        let replaced_path = replaced_path.lock().unwrap().take().unwrap();
        assert_eq!(
            std::fs::read(replaced_path).unwrap(),
            b"foreign invalid image"
        );
        assert_eq!(fixture.library.summary().unwrap().asset_count, 0);
    }

    #[test]
    fn library_clones_serialize_ingests_for_one_open_library() {
        let fixture = IngestionFixture::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_hook = Arc::clone(&calls);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let release_rx_for_hook = Arc::clone(&release_rx);
        set_after_duplicate_hook(fixture.library.root().to_path_buf(), move || {
            let call = calls_for_hook.fetch_add(1, Ordering::SeqCst);
            entered_tx.send(call).unwrap();
            if call == 0 {
                release_rx_for_hook.lock().unwrap().recv().unwrap();
            }
        });

        let first_library = fixture.library.clone();
        let first_source = fixture.source.clone();
        let first = std::thread::spawn(move || {
            first_library.ingest_image(IngestImageRequest {
                source_path: first_source,
                classification_id: None,
                source_url: None,
            })
        });
        let second_library = fixture.library.clone();
        let second_source = fixture.source.clone();
        let second = std::thread::spawn(move || {
            second_library.ingest_image(IngestImageRequest {
                source_path: second_source,
                classification_id: None,
                source_url: None,
            })
        });

        let first_entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let overlapped = entered_rx.recv_timeout(Duration::from_millis(250)).is_ok();
        release_tx.send(()).unwrap();
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        clear_after_duplicate_hook();

        assert!(
            first_entered,
            "neither ingest reached the duplicate boundary"
        );
        assert!(
            !overlapped,
            "two Library clones entered one library ingest concurrently"
        );
        let mut added = 0;
        let mut duplicate = 0;
        for outcome in [first.unwrap(), second.unwrap()] {
            match outcome {
                IngestOutcome::Added { .. } => added += 1,
                IngestOutcome::ExactDuplicate { .. } => duplicate += 1,
            }
        }
        assert_eq!((added, duplicate), (1, 1));
    }
}
