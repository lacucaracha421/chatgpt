//! Restart-safe derived descriptors for Collection publication.
use super::{blob_for, read_existing_image, ArtworkBlob, LibraryError};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    identity: Vec<u64>,
}
fn stamp(file: &File) -> Result<Stamp, LibraryError> {
    let m = file
        .metadata()
        .map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if !m.is_file() {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        vec![m.dev(), m.ino(), m.ctime() as u64, m.ctime_nsec() as u64]
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
            BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO,
        };
        let mut id: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut id) } == 0
            || unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileBasicInfo,
                    &mut basic as *mut _ as *mut _,
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            } == 0
        {
            return Err(LibraryError::InvalidWorkArtwork);
        }
        vec![
            id.dwVolumeSerialNumber as u64,
            id.nFileIndexHigh as u64,
            id.nFileIndexLow as u64,
            basic.ChangeTime as u64,
        ]
    };
    Ok(Stamp {
        size: m.len(),
        modified: m.modified().map_err(|_| LibraryError::InvalidWorkArtwork)?,
        identity,
    })
}
type Descriptors = BTreeMap<PathBuf, (Stamp, ArtworkBlob)>;
static DESCRIPTORS: OnceLock<Mutex<Descriptors>> = OnceLock::new();

fn persistent_path(root: &Path, path: &Path, stamp: &Stamp) -> Result<PathBuf, LibraryError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| LibraryError::InvalidWorkArtwork)?;
    let modified = stamp
        .modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let identity = stamp
        .identity
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(":");
    let key = format!(
        "{}\0{}\0{}\0{}",
        relative.to_string_lossy().replace('\\', "/"),
        stamp.size,
        modified,
        identity
    );
    let hash = Sha256::digest(key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(root
        .join(".cache/mobile-collections/descriptors")
        .join(format!("{hash}.json")))
}

fn valid_cached_blob(blob: &ArtworkBlob, size: u64) -> bool {
    blob.size_bytes == size
        && blob.sha256.len() == 64
        && blob.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        && blob.object_key == format!("work-artwork/mobile/{}", blob.sha256)
        && matches!(
            blob.content_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
}

fn write_persistent(path: &Path, blob: &ArtworkBlob) -> Result<(), LibraryError> {
    let parent = path.parent().ok_or(LibraryError::InvalidWorkArtwork)?;
    std::fs::create_dir_all(parent).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(blob).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    std::fs::write(&temporary, bytes).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        if !path.exists() {
            let _ = error;
            return Err(LibraryError::InvalidWorkArtwork);
        }
    }
    Ok(())
}

#[cfg(test)]
static HASHED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

pub(super) fn descriptor(
    root: &Path,
    path: &Path,
    limit: u64,
) -> Result<Option<ArtworkBlob>, LibraryError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LibraryError::InvalidWorkArtwork),
    };
    let before = stamp(&file)?;
    if before.size > limit {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    if before.size == 0 {
        return Ok(None);
    }
    let cache = DESCRIPTORS.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Some((cached, blob)) = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(path)
    {
        if *cached == before {
            return Ok(Some(blob.clone()));
        }
    }
    let persistent = persistent_path(root, path, &before)?;
    if let Ok(bytes) = std::fs::read(&persistent) {
        if let Ok(blob) = serde_json::from_slice::<ArtworkBlob>(&bytes) {
            if valid_cached_blob(&blob, before.size) {
                cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(path.to_owned(), (before, blob.clone()));
                return Ok(Some(blob));
            }
        }
    }
    #[cfg(test)]
    HASHED.lock().unwrap().push(path.to_owned());
    let Some(bytes) = read_existing_image(path, limit)? else {
        return Ok(None);
    };
    let blob = blob_for(&bytes)?;
    let current = File::open(path).map_err(|_| LibraryError::InvalidWorkArtwork)?;
    if before != stamp(&file)? || before != stamp(&current)? {
        return Err(LibraryError::InvalidWorkArtwork);
    }
    let mut cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if cache.len() >= super::MAX_FILES {
        cache.pop_first();
    }
    cache.insert(path.to_owned(), (before, blob.clone()));
    write_persistent(&persistent, &blob)?;
    Ok(Some(blob))
}
pub(super) static THUMBNAIL_WRITE: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn warm_descriptor_reused_and_same_size_replacement_invalidates_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        let first = b"\x89PNG\r\n\x1a\nfirst";
        let second = b"\x89PNG\r\n\x1a\nother";
        std::fs::write(&path, first).unwrap();
        let original = descriptor(dir.path(), &path, 100).unwrap().unwrap();
        assert_eq!(
            descriptor(dir.path(), &path, 100).unwrap().unwrap(),
            original
        );
        assert!(descriptor(dir.path(), &path, 1).is_err());
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, second).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_ne!(
            descriptor(dir.path(), &path, 100).unwrap().unwrap(),
            original
        );
        std::fs::remove_file(&path).unwrap();
        assert!(descriptor(dir.path(), &path, 100).unwrap().is_none());
    }

    #[test]
    fn descriptor_survives_process_memory_cache_loss() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\npersisted").unwrap();
        let first = descriptor(dir.path(), &path, 100).unwrap().unwrap();
        DESCRIPTORS.get().unwrap().lock().unwrap().remove(&path);
        let before = HASHED
            .lock()
            .unwrap()
            .iter()
            .filter(|item| *item == &path)
            .count();
        assert_eq!(descriptor(dir.path(), &path, 100).unwrap().unwrap(), first);
        let after = HASHED
            .lock()
            .unwrap()
            .iter()
            .filter(|item| *item == &path)
            .count();
        assert_eq!(after, before);
    }
}
