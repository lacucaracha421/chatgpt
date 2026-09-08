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

        #[cfg(target_os = "linux")]
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);

        let file = options
            .open(&path)
            .map_err(|source| map_lock_error(&path, source))?;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: valid owned descriptor. The lock lives until this lease is dropped.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(map_lock_error(&path, std::io::Error::last_os_error()));
            }
        }
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn linux_lease_excludes_another_opener_until_drop() {
        let t = tempfile::tempdir().unwrap();
        let lease = LibraryLease::acquire(t.path()).unwrap();
        assert!(matches!(LibraryLease::acquire(t.path()), Err(LibraryError::LibraryInUse)));
        drop(lease);
        assert!(LibraryLease::acquire(t.path()).is_ok());
    }
}
