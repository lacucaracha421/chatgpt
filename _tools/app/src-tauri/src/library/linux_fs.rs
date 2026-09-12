//! Linux managed-file primitives. Resolve each component through a pinned directory
//! descriptor without following symlinks. Claim deletion targets in a private sibling
//! directory before checking identity; never unlink a subsequently replaced public name.
use std::{
    ffi::{CString, OsStr},
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};

fn cstr(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))
}
fn result(value: i32) -> io::Result<i32> {
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(value)
    }
}
fn open_at(parent: &File, name: &OsStr, flags: i32) -> io::Result<File> {
    let name = cstr(name)?;
    // SAFETY: all-zero open_how is valid; every field used by openat2 is set below.
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (flags | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64;
    how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_XDEV;
    // SAFETY: valid parent, string, and sized open_how buffer. Fail closed on old kernels.
    let fd = result(unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of_val(&how),
        ) as i32
    })?;
    // SAFETY: successful openat2 returned a fresh owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn rename_at(from_dir: i32, from: &OsStr, to_dir: i32, to: &OsStr) -> io::Result<()> {
    let (from, to) = (cstr(from)?, cstr(to)?);
    // SAFETY: valid strings and descriptors for the duration of this atomic syscall.
    result(unsafe {
        libc::renameat2(
            from_dir,
            from.as_ptr(),
            to_dir,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    })
    .map(|_| ())
}
pub(super) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    // Unsupported kernels/filesystems fail closed; never emulate with overwrite-prone rename.
    rename_at(
        libc::AT_FDCWD,
        from.as_os_str(),
        libc::AT_FDCWD,
        to.as_os_str(),
    )
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct FileIdentity {
    device: u64,
    inode: u64,
}
impl FileIdentity {
    pub(super) fn from_file(file: &File) -> io::Result<Self> {
        let m = file.metadata()?;
        Ok(Self {
            device: m.dev(),
            inode: m.ino(),
        })
    }
    pub(super) fn matches_path(&self, path: &Path) -> bool {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .and_then(|f| Self::from_file(&f))
            .is_ok_and(|id| id == *self)
    }
}
fn unlink_at(parent: &File, name: &OsStr, directory: bool) -> io::Result<()> {
    let name = cstr(name)?;
    // SAFETY: pinned parent and valid single-component name.
    result(unsafe {
        libc::unlinkat(
            parent.as_raw_fd(),
            name.as_ptr(),
            if directory { libc::AT_REMOVEDIR } else { 0 },
        )
    })
    .map(|_| ())
}
pub(super) fn delete_managed(root: &Path, relative: &Path, directory: bool) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut parent = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)?;
    let parts: Vec<_> = relative
        .components()
        .map(|c| match c {
            Component::Normal(name) => Ok(name),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid managed path",
            )),
        })
        .collect::<io::Result<_>>()?;
    let (name, ancestors) = parts
        .split_last()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty managed path"))?;
    for ancestor in ancestors {
        parent = match open_at(&parent, ancestor, libc::O_RDONLY | libc::O_DIRECTORY) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            other => other?,
        };
    }
    delete_entry(&parent, name, directory)
}
fn delete_entry(parent: &File, name: &OsStr, directory: bool) -> io::Result<()> {
    let target = match open_at(parent, name, libc::O_PATH) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        other => other?,
    };
    let metadata = target.metadata()?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unexpected managed file type",
        ));
    }
    let identity = FileIdentity::from_file(&target)?;
    #[cfg(test)]
    BEFORE_CLAIM.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let quarantine = format!(".{}.delete", uuid::Uuid::new_v4());
    let qname = OsStr::new(&quarantine);
    let c = cstr(qname)?;
    // SAFETY: valid parent and string. An existing directory is never reused.
    result(unsafe { libc::mkdirat(parent.as_raw_fd(), c.as_ptr(), 0o700) })?;
    let qdir = open_at(parent, qname, libc::O_RDONLY | libc::O_DIRECTORY)?;
    let claimed = OsStr::new("claimed");
    let outcome = (|| {
        rename_at(parent.as_raw_fd(), name, qdir.as_raw_fd(), claimed)?;
        let moved = open_at(&qdir, claimed, libc::O_PATH)?;
        if FileIdentity::from_file(&moved)? != identity {
            // Restore only into an empty name. On conflict preserve the quarantine for recovery.
            rename_at(qdir.as_raw_fd(), claimed, parent.as_raw_fd(), name)?;
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "managed path replaced",
            ));
        }
        if directory {
            let dir = open_at(&qdir, claimed, libc::O_RDONLY | libc::O_DIRECTORY)?;
            // /proc resolves this owned fd, not a mutable user-supplied path.
            for entry in fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))? {
                let entry = entry?;
                let child = open_at(&dir, &entry.file_name(), libc::O_PATH)?;
                let m = child.metadata()?;
                if !m.is_file() && !m.is_dir() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unsafe derivative entry",
                    ));
                }
                delete_entry(&dir, &entry.file_name(), m.is_dir())?;
            }
        }
        unlink_at(&qdir, claimed, directory)
    })();
    if outcome.is_err() {
        // A partially cleaned tree is still recoverable/retryable under its original name.
        let _ = rename_at(qdir.as_raw_fd(), claimed, parent.as_raw_fd(), name);
    }
    let _ = unlink_at(parent, qname, true);
    outcome
}

#[cfg(test)]
thread_local! {
    static BEFORE_CLAIM: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rename_never_overwrites_and_identity_rejects_replacement_and_symlink() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        let b = t.path().join("b");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let file = File::open(&a).unwrap();
        let id = FileIdentity::from_file(&file).unwrap();
        assert_eq!(
            rename_no_replace(&a, &b).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&b).unwrap(), b"b");
        fs::remove_file(&a).unwrap();
        std::os::unix::fs::symlink(&b, &a).unwrap();
        assert!(!id.matches_path(&a));
    }
    #[test]
    fn deletion_rejects_escape_and_symlinks_and_cleans_nested_derivatives() {
        let t = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), b"safe").unwrap();
        std::os::unix::fs::symlink(outside.path(), t.path().join("link")).unwrap();
        assert!(delete_managed(t.path(), Path::new("link/keep"), false).is_err());
        assert!(delete_managed(t.path(), Path::new("../keep"), false).is_err());
        assert!(delete_managed(t.path(), Path::new("link"), true).is_err());
        fs::create_dir_all(t.path().join("video/scrub")).unwrap();
        fs::write(t.path().join("video/scrub/0.webp"), b"frame").unwrap();
        delete_managed(t.path(), Path::new("video"), true).unwrap();
        assert!(!t.path().join("video").exists());
        assert!(outside.path().join("keep").exists());
    }
    #[test]
    fn deletion_preserves_a_replacement_between_open_and_claim() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("original");
        fs::write(&path, b"original").unwrap();
        let raced = path.clone();
        BEFORE_CLAIM.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::rename(&raced, raced.with_extension("saved")).unwrap();
                fs::write(&raced, b"replacement").unwrap();
            }))
        });
        assert!(delete_managed(t.path(), Path::new("original"), false).is_err());
        assert_eq!(fs::read(path).unwrap(), b"replacement");
        assert_eq!(
            fs::read(t.path().join("original.saved")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn deletion_does_not_follow_a_swapped_parent() {
        let t = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("parent")).unwrap();
        fs::write(t.path().join("parent/file"), b"managed").unwrap();
        fs::write(outside.path().join("file"), b"outside").unwrap();
        let root = t.path().to_owned();
        let other = outside.path().to_owned();
        BEFORE_CLAIM.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::rename(root.join("parent"), root.join("saved")).unwrap();
                std::os::unix::fs::symlink(other, root.join("parent")).unwrap();
            }))
        });
        delete_managed(t.path(), Path::new("parent/file"), false).unwrap();
        assert_eq!(fs::read(outside.path().join("file")).unwrap(), b"outside");
        assert!(!t.path().join("saved/file").exists());
    }
}
