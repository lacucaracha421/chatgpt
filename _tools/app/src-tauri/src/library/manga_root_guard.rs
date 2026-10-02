//! A readable mount point is not proof that the indexed disk is still present.
use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{error::LibraryError, machine_settings, Library};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RootIdentity {
    path: PathBuf,
    platform: String,
    volume: u64,
    directory: u64,
}

impl RootIdentity {
    pub(crate) fn read(root: &Path) -> Result<Self, LibraryError> {
        let unavailable = |_| {
            LibraryError::UnsafeMangaRoot(
                "루트 폴더에 접근할 수 없습니다. 원래 드라이브가 연결되어 있는지 확인하세요.",
            )
        };
        let metadata = fs::metadata(root).map_err(unavailable)?;
        if !metadata.is_dir() {
            return Err(LibraryError::UnsafeMangaRoot(
                "루트 경로가 폴더가 아닙니다. 원래 드라이브를 연결하세요.",
            ));
        }
        #[cfg(unix)]
        let (volume, directory) = {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        };
        #[cfg(windows)]
        let (volume, directory) = {
            use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
            };
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(root)
                .map_err(unavailable)?;
            let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
            // SAFETY: the live directory handle and writable output buffer are valid.
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
                return Err(unavailable(std::io::Error::last_os_error()));
            }
            // SAFETY: the successful call initialized the output buffer.
            let info = unsafe { info.assume_init() };
            (
                u64::from(info.dwVolumeSerialNumber),
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            )
        };
        #[cfg(not(any(unix, windows)))]
        return Err(LibraryError::UnsafeMangaRoot(
            "이 운영체제에서는 루트 드라이브를 확인할 수 없습니다.",
        ));
        #[cfg(any(unix, windows))]
        Ok(Self {
            path: root.to_path_buf(),
            platform: std::env::consts::OS.into(),
            volume,
            directory,
        })
    }

    pub(crate) fn verify(&self, c: &Connection) -> Result<(), LibraryError> {
        if Self::read(&self.path)? != *self {
            return Err(LibraryError::UnsafeMangaRoot(
                "루트 폴더 또는 드라이브가 이전과 다릅니다. 원래 드라이브를 연결하거나 설정에서 폴더를 다시 지정하세요."));
        }
        require_nonempty_if_indexed(c, &self.path)
    }

    pub(crate) fn verify_before_purge_commit(&self, c: &Connection) -> Result<(), LibraryError> {
        self.verify(c)?;
        // The transaction may have deleted the last indexed row. That must not
        // disable the empty-root guard before the deletion is committed.
        require_source_entry(&self.path)
    }
}

fn require_source_entry(root: &Path) -> Result<(), LibraryError> {
    let entries = fs::read_dir(root).map_err(|_| {
        LibraryError::UnsafeMangaRoot(
            "루트 폴더를 읽을 수 없습니다. 드라이브 연결 상태를 확인하세요.",
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|_| {
            LibraryError::UnsafeMangaRoot(
                "루트 폴더를 읽을 수 없습니다. 드라이브 연결 상태를 확인하세요.",
            )
        })?;
        if entry.file_name() != ".lakomics-thumbs" {
            return Ok(());
        }
    }
    Err(LibraryError::UnsafeMangaRoot(
        "저장된 작품이 있지만 루트 폴더가 비어 있습니다. 드라이브가 마운트되어 있는지 확인하세요. 작품 정보는 지우지 않았습니다."))
}

fn require_nonempty_if_indexed(c: &Connection, root: &Path) -> Result<(), LibraryError> {
    let indexed: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM manga_series) OR EXISTS(SELECT 1 FROM manga_catalog_recovery_links WHERE source_relative_path IS NOT NULL)",
        [], |row| row.get(0))?;
    if indexed {
        require_source_entry(root)?;
    }
    Ok(())
}

/// `adopt`: a root never checked on this PC (no recorded identity, e.g. right after the update that added this
/// guard) is accepted and recorded once it passes the non-empty check, so scanning keeps working. Purging
/// vanished folders passes `false` and still needs an identity recorded by an earlier scan or index read.
pub(crate) fn require(
    library: &Library,
    c: &Connection,
    root: &Path,
    adopt: bool,
) -> Result<RootIdentity, LibraryError> {
    let current = RootIdentity::read(root)?;
    let recorded = if let Some(settings) = library.machine_settings_path() {
        machine_settings::entry(&settings, &super::library_id_on(c)?)?
            .and_then(|entry| entry.manga_root_identity)
    } else {
        library
            .manga_root_identity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    };
    require_nonempty_if_indexed(c, root)?;
    match recorded {
        Some(recorded) if recorded != current => return Err(LibraryError::UnsafeMangaRoot(
            "루트 폴더 또는 드라이브가 이전과 다릅니다. 원래 드라이브를 연결하거나 설정에서 폴더를 다시 지정하세요.")),
        None if adopt => record(library, c, current.clone())?,
        None => return Err(LibraryError::UnsafeMangaRoot(
            "이 PC에서 루트 드라이브를 아직 확인하지 않았습니다. 망가 목록을 한 번 새로 고친 뒤 다시 시도하세요.")),
        _ => {}
    }
    Ok(current)
}

pub(crate) fn record(
    library: &Library,
    c: &Connection,
    identity: RootIdentity,
) -> Result<(), LibraryError> {
    if let Some(settings) = library.machine_settings_path() {
        machine_settings::set_manga_root_identity(
            &settings,
            &super::library_id_on(c)?,
            identity.clone(),
        )?;
    }
    *library
        .manga_root_identity
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(identity);
    Ok(())
}
