use std::{
    fs::{File, OpenOptions},
    path::Path,
};

use super::error::LibraryError;

#[derive(Debug)]
pub(crate) struct LibraryLease {
    _file: File,
}

impl LibraryLease {
    pub(crate) fn acquire(root: &Path) -> Result<Self, LibraryError> {
        let path = root.join(".lakomics.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::share_mode(&mut options, 0);

        let file = options
            .open(&path)
            .map_err(|source| map_lock_error(&path, source))?;
        Ok(Self { _file: file })
    }
}

fn map_lock_error(path: &Path, source: std::io::Error) -> LibraryError {
    if matches!(
        source.kind(),
        std::io::ErrorKind::AlreadyExists
            | std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::WouldBlock
    ) || source.raw_os_error() == Some(32)
    {
        LibraryError::LibraryInUse
    } else {
        LibraryError::LibraryLock {
            path: path.to_path_buf(),
            source,
        }
    }
}
