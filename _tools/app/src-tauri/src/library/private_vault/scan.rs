//! Walks a plaintext source folder for files the encrypted vault can import.

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use crate::library::error::LibraryError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum VaultMediaKind {
    Image,
    Gif,
    Video,
}

pub(super) fn media_files(root: &Path) -> Result<(Vec<(PathBuf, String, VaultMediaKind)>, u64), LibraryError> {
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

/// Individually chosen files as import entries, each keyed by its file name. Folders,
/// symlinks, unreadable or unsupported files and names that are not UTF-8 are counted in
/// the second value instead (the user picked them, so they are reported as failed).
pub(super) fn chosen_media_files(
    paths: &[PathBuf],
) -> (Vec<(PathBuf, String, VaultMediaKind)>, u64) {
    let mut files = Vec::new();
    let mut rejected = 0_u64;
    for path in paths {
        let entry = fs::symlink_metadata(path)
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|_| {
                let name = path.file_name()?.to_str()?.to_owned();
                Some((path.clone(), name, media_kind(path)?))
            });
        match entry {
            Some(entry) => files.push(entry),
            None => rejected += 1,
        }
    }
    files.sort_by(|left, right| left.1.cmp(&right.1));
    (files, rejected)
}

fn ignored_directory(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else { return true; };
    name == ".lakomics"
        || name == ".lakomics-vault"
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{chosen_media_files, media_files, VaultMediaKind};

    #[test]
    fn media_files_skip_metadata_trash_and_unsupported_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for directory in [".Trash-1000/files", ".lakomics", ".lakomics-vault", "nested"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        fs::write(root.join("nested/a.png"), b"image").unwrap();
        fs::write(root.join("clip.MP4"), b"video").unwrap();
        fs::write(root.join("anim.gif"), b"gif").unwrap();
        fs::write(root.join("notes.txt"), b"text").unwrap();
        fs::write(root.join(".Trash-1000/files/deleted.png"), b"trash").unwrap();
        fs::write(root.join(".lakomics/ignored.png"), b"ignored").unwrap();
        fs::write(root.join(".lakomics-vault/ignored.png"), b"ignored").unwrap();

        let (files, unreadable) = media_files(root).unwrap();

        assert_eq!(unreadable, 0);
        let found = files
            .iter()
            .map(|(_, relative, kind)| (relative.as_str(), *kind))
            .collect::<Vec<_>>();
        assert_eq!(
            found,
            vec![
                ("anim.gif", VaultMediaKind::Gif),
                ("clip.MP4", VaultMediaKind::Video),
                ("nested/a.png", VaultMediaKind::Image),
            ]
        );
    }

    #[test]
    fn chosen_files_are_keyed_by_file_name_and_unsupported_ones_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("x/y")).unwrap();
        fs::write(root.join("x/y/b.PNG"), b"image").unwrap();
        fs::write(root.join("a.mp4"), b"video").unwrap();
        fs::write(root.join("notes.txt"), b"text").unwrap();
        let (files, rejected) = chosen_media_files(&[
            root.join("x/y/b.PNG"),
            root.join("a.mp4"),
            root.join("notes.txt"),
            root.join("x"),
            root.join("missing.png"),
        ]);
        assert_eq!(rejected, 3);
        let found = files
            .iter()
            .map(|(_, relative, kind)| (relative.as_str(), *kind))
            .collect::<Vec<_>>();
        assert_eq!(
            found,
            vec![
                ("a.mp4", VaultMediaKind::Video),
                ("b.PNG", VaultMediaKind::Image)
            ]
        );
    }
}
