use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;

use super::{error::LibraryError, Library};

const DRAG_ROOT: &str = ".drag-out";

pub struct PreparedAssetDrag {
    pub files: Vec<PathBuf>,
    pub preview: PathBuf,
    cleanup_root: PathBuf,
}

impl Drop for PreparedAssetDrag {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.cleanup_root);
    }
}

impl Library {
    pub fn prepare_asset_drag(
        &self,
        asset_ids: &[String],
    ) -> Result<PreparedAssetDrag, LibraryError> {
        let ids = unique_ids(asset_ids)?;
        let canonical_root = fs::canonicalize(&self.root).map_err(drag_error)?;
        let connection = self.connection()?;
        let mut sources = Vec::with_capacity(ids.len());
        for id in ids {
            let row: Option<(String, String, String)> = connection.query_row(
                "SELECT original_name, relative_path, thumbnail_relative_path FROM assets WHERE id = ?1 AND status = 'normal'",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional()?;
            let (original_name, asset_path, thumbnail_path) =
                row.ok_or(LibraryError::InvalidAssetSelection)?;
            sources.push((
                safe_original_name(&original_name, id),
                canonical_managed_path(&canonical_root, &asset_path)?,
                canonical_managed_path(&canonical_root, &thumbnail_path)?,
            ));
        }
        drop(connection);

        let drag_root = canonical_root.join(DRAG_ROOT);
        fs::create_dir_all(&drag_root).map_err(drag_error)?;
        let staging = drag_root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&staging).map_err(drag_error)?;
        let result = stage_sources(&staging, &sources);
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result.map(|(files, preview)| PreparedAssetDrag {
            files,
            preview,
            cleanup_root: staging,
        })
    }

    pub fn cleanup_stale_asset_drags(&self) -> Result<(), LibraryError> {
        let canonical_root = fs::canonicalize(&self.root).map_err(drag_error)?;
        let drag_root = canonical_root.join(DRAG_ROOT);
        if !drag_root.exists() {
            return Ok(());
        }
        let canonical_drag_root = fs::canonicalize(&drag_root).map_err(drag_error)?;
        if canonical_drag_root.parent() != Some(canonical_root.as_path()) {
            return Err(LibraryError::UnsafeMediaPath);
        }
        for child in fs::read_dir(&canonical_drag_root).map_err(drag_error)? {
            let child = child.map_err(drag_error)?.path();
            if child.parent() != Some(canonical_drag_root.as_path()) {
                return Err(LibraryError::UnsafeMediaPath);
            }
            if child.is_dir() {
                fs::remove_dir_all(child).map_err(drag_error)?;
            } else {
                fs::remove_file(child).map_err(drag_error)?;
            }
        }
        Ok(())
    }
}

fn unique_ids(asset_ids: &[String]) -> Result<Vec<&str>, LibraryError> {
    if asset_ids.is_empty() {
        return Err(LibraryError::InvalidAssetSelection);
    }
    let mut seen = BTreeSet::new();
    Ok(asset_ids
        .iter()
        .map(String::as_str)
        .filter(|id| seen.insert((*id).to_owned()))
        .collect())
}

fn canonical_managed_path(root: &Path, relative: &str) -> Result<PathBuf, LibraryError> {
    let path = fs::canonicalize(root.join(relative)).map_err(drag_error)?;
    if !path.starts_with(root) {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(path)
}

fn safe_original_name(original_name: &str, asset_id: &str) -> String {
    Path::new(original_name)
        .file_name()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("{asset_id}.bin"))
}

fn stage_sources(
    staging: &Path,
    sources: &[(String, PathBuf, PathBuf)],
) -> Result<(Vec<PathBuf>, PathBuf), LibraryError> {
    let mut used_names = BTreeSet::new();
    let mut files = Vec::with_capacity(sources.len());
    for (name, source, _) in sources {
        let destination = staging.join(unique_file_name(name, &mut used_names));
        link_or_copy(source, &destination)?;
        files.push(destination);
    }
    let preview = staging
        .join(".preview")
        .with_extension(sources[0].2.extension().unwrap_or_default());
    link_or_copy(&sources[0].2, &preview)?;
    Ok((files, preview))
}

fn unique_file_name(name: &str, used: &mut BTreeSet<String>) -> String {
    if used.insert(name.to_lowercase()) {
        return name.to_owned();
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path.extension().map(|value| value.to_string_lossy());
    let mut index = 2;
    loop {
        let candidate = match &extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
        index += 1;
    }
}

fn link_or_copy(source: &Path, destination: &Path) -> Result<(), LibraryError> {
    if fs::hard_link(source, destination).is_err() {
        fs::copy(source, destination).map_err(drag_error)?;
    }
    Ok(())
}

fn drag_error(source: std::io::Error) -> LibraryError {
    LibraryError::AssetDragFailed { source }
}

#[test]
fn drag_out_preparation_preserves_names_deduplicates_and_cleans_up() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    insert_asset(
        &library,
        "a",
        "image.png",
        "assets/a.png",
        "thumbnails/a.webp",
        "normal",
    );
    insert_asset(
        &library,
        "b",
        "IMAGE.PNG",
        "assets/b.png",
        "thumbnails/b.webp",
        "normal",
    );
    std::fs::write(temp.path().join("assets/a.png"), b"a").unwrap();
    std::fs::write(temp.path().join("assets/b.png"), b"b").unwrap();
    std::fs::write(temp.path().join("thumbnails/a.webp"), b"preview").unwrap();
    std::fs::write(temp.path().join("thumbnails/b.webp"), b"preview").unwrap();

    let prepared = library
        .prepare_asset_drag(&["a".into(), "b".into()])
        .unwrap();
    let names: Vec<_> = prepared
        .files
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["image.png", "IMAGE (2).PNG"]);
    assert!(prepared.files.iter().all(|path| path.exists()));
    assert!(prepared.preview.exists());
    let staging_directory = prepared.files[0].parent().unwrap().to_path_buf();
    drop(prepared);
    assert!(!staging_directory.exists());
}

#[test]
fn drag_out_rejects_empty_missing_and_trashed_selections_without_partial_staging() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    insert_asset(
        &library,
        "trash",
        "trash.png",
        "assets/trash.png",
        "thumbnails/trash.webp",
        "trash",
    );

    assert!(library.prepare_asset_drag(&[]).is_err());
    assert!(library.prepare_asset_drag(&["missing".into()]).is_err());
    assert!(library.prepare_asset_drag(&["trash".into()]).is_err());
    assert!(!temp.path().join(".drag-out").exists());
}

#[test]
fn library_open_removes_stale_drag_directories() {
    let temp = tempfile::tempdir().unwrap();
    {
        let library = Library::open(temp.path()).unwrap();
        drop(library);
    }
    let stale = temp.path().join(".drag-out/stale");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("old.png"), b"old").unwrap();

    let library = Library::open(temp.path()).unwrap();
    assert!(temp
        .path()
        .join(".drag-out")
        .read_dir()
        .unwrap()
        .next()
        .is_none());
    drop(library);
}

#[cfg(test)]
fn insert_asset(
    library: &Library,
    id: &str,
    original_name: &str,
    relative_path: &str,
    thumbnail_path: &str,
    status: &str,
) {
    let allowed: BTreeSet<_> = ["normal", "trash"].into_iter().collect();
    assert!(allowed.contains(status));
    library.connection().unwrap().execute(
        "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path, byte_size, width, height, collected_at, status) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1, '2026-08-08T00:00:00Z', ?6)",
        rusqlite::params![id, format!("hash-{id}"), original_name, relative_path, thumbnail_path, status],
    ).unwrap();
}
