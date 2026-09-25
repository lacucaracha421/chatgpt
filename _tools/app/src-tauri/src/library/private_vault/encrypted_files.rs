//! Stage 3 of the encrypted Private Vault (ADR-0039): the vault trash, permanent deletion
//! and export of decrypted originals to a folder on the trusted PC.
//!
//! - Trash and restore only set or clear `VaultItem::trashed_at` (index save, write lock).
//! - Permanent deletion (selected trashed items, or the whole trash) is explicit only. The
//!   index without the items is saved first, then the objects no remaining item references
//!   are deleted; a crash in between leaves orphans for the next unlock's cleanup. It is
//!   refused while an import runs and in a session opened from the backup index.
//! - Export decrypts a bounded step at a time into a hidden temporary file in the chosen
//!   folder and renames it to the original file name (`_2`, `_3`… on collision). Folders
//!   inside the vault root (the USB) are refused, so plaintext never lands there.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use zeroize::Zeroize;

use super::{
    import_error_code, vault_present, EncryptedVault, EncryptedVaultRuntime, VaultItem,
    IMPORT_FAILED_CODE,
};
use crate::library::{
    error::LibraryError,
    models::{EncryptedVaultExportJob, EncryptedVaultExportProgress},
    Library,
};

/// Plaintext bytes decrypted and written per step of an export.
const EXPORT_STEP: u64 = 1024 * 1024;
const EXPORT_FAILED_CODE: &str = "encrypted_vault_export_failed";
const TEMP_PREFIX: &str = ".lakomics-export-";
const MAX_NAME_ATTEMPTS: u32 = 10_000;
const FALLBACK_NAME: &str = "vault-item";

/// Ends the running export even if it unwinds without recording a result.
struct ExportJobGuard<'a>(&'a EncryptedVaultRuntime);

impl Drop for ExportJobGuard<'_> {
    fn drop(&mut self) {
        if let Some(job) = self.0.export_job().as_mut().filter(|job| job.running) {
            job.running = false;
            job.error = Some(EXPORT_FAILED_CODE.to_owned());
        }
    }
}

/// Command error code of an export failure, kept in the job for a UI that reattaches.
fn export_error_code(error: &LibraryError) -> &'static str {
    match error {
        LibraryError::EncryptedVaultInvalidRoot => "encrypted_vault_invalid_root",
        error => match import_error_code(error) {
            IMPORT_FAILED_CODE => EXPORT_FAILED_CODE,
            code => code,
        },
    }
}

impl Library {
    /// Moves items to the vault trash (hidden from the gallery and its counts). Returns how
    /// many items changed; unknown or already trashed ids are ignored.
    pub fn trash_encrypted_vault_items(&self, item_ids: &[String]) -> Result<u64, LibraryError> {
        self.set_encrypted_vault_trashed(item_ids, Some(chrono::Utc::now().to_rfc3339()))
    }

    /// Takes items out of the vault trash. Returns how many items changed.
    pub fn restore_encrypted_vault_items(&self, item_ids: &[String]) -> Result<u64, LibraryError> {
        self.set_encrypted_vault_trashed(item_ids, None)
    }

    fn set_encrypted_vault_trashed(
        &self,
        item_ids: &[String],
        trashed_at: Option<String>,
    ) -> Result<u64, LibraryError> {
        let wanted = item_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        let _writes = self.encrypted_vault.writes();
        let (vault, generation, previous) = {
            let mut state = self.encrypted_vault.state();
            let session = state
                .session
                .as_mut()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            session.writable()?;
            let mut previous = HashMap::new();
            for item in session.index.items.iter_mut().filter(|item| {
                wanted.contains(item.id.as_str())
                    && item.trashed_at.is_some() != trashed_at.is_some()
            }) {
                let old = std::mem::replace(&mut item.trashed_at, trashed_at.clone());
                previous.insert(item.id.clone(), old);
            }
            (Arc::clone(&session.vault), session.generation, previous)
        };
        if previous.is_empty() {
            return Ok(0);
        }
        if let Err(error) = self.persist_encrypted_index(&vault, generation) {
            let mut state = self.encrypted_vault.state();
            if let Some(session) = state.session_matching(generation) {
                for item in &mut session.index.items {
                    if let Some(old) = previous.get(&item.id) {
                        item.trashed_at = old.clone();
                    }
                }
            }
            return Err(error);
        }
        Ok(previous.len() as u64)
    }

    /// Permanently deletes the given items; only items already in the vault trash qualify.
    pub fn delete_encrypted_vault_items(&self, item_ids: &[String]) -> Result<u64, LibraryError> {
        let wanted = item_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        self.purge_encrypted_vault_trash(Some(&wanted))
    }

    /// 휴지통 비우기: permanently deletes every trashed item.
    pub fn empty_encrypted_vault_trash(&self) -> Result<u64, LibraryError> {
        self.purge_encrypted_vault_trash(None)
    }

    fn purge_encrypted_vault_trash(
        &self,
        only: Option<&HashSet<&str>>,
    ) -> Result<u64, LibraryError> {
        let runtime = &*self.encrypted_vault;
        if runtime.import_running() {
            return Err(LibraryError::EncryptedVaultImportRunning);
        }
        let _writes = runtime.writes();
        // An import holds references (resume candidates, sidecar targets) that deletion
        // could invalidate; the flag is re-checked under the write lock.
        if runtime.import_running() {
            return Err(LibraryError::EncryptedVaultImportRunning);
        }
        let (vault, generation, mut index) = {
            let state = runtime.state();
            let session = state
                .session
                .as_ref()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            // A backup index does not know the newest objects, so it never drives deletion.
            session.writable()?;
            (
                Arc::clone(&session.vault),
                session.generation,
                session.index.clone(),
            )
        };
        let (dropped, kept): (Vec<VaultItem>, Vec<VaultItem>) = std::mem::take(&mut index.items)
            .into_iter()
            .partition(|item| {
                item.trashed_at.is_some()
                    && only.is_none_or(|wanted| wanted.contains(item.id.as_str()))
            });
        index.items = kept;
        if dropped.is_empty() {
            return Ok(0);
        }
        // The index goes first: after a crash the objects are merely orphans.
        vault
            .save_index(&mut index)
            .map_err(|error| self.vault_write_error(generation, error))?;
        {
            let mut state = runtime.state();
            let session = state
                .session_matching(generation)
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            session.index = index.clone();
        }
        // Objects can be shared (a sidecar image moved to a video's thumbnail keeps its
        // object), so only objects no remaining item references are deleted.
        let referenced = index.referenced_objects();
        let unreferenced = dropped
            .iter()
            .flat_map(|item| {
                [
                    Some(item.object_id.as_str()),
                    item.thumbnail_object_id.as_deref(),
                    item.poster_object_id.as_deref(),
                ]
            })
            .flatten()
            .filter(|object_id| !referenced.contains(object_id))
            .collect::<HashSet<_>>();
        // Best effort (verifies the vault UUID first); leftovers are removed as orphans.
        let _ = vault.remove_objects(unreferenced);
        Ok(dropped.len() as u64)
    }

    /// Decrypts the given items into `destination` (a folder on the trusted PC) under their
    /// original file names. Runs to completion on the calling thread; its state is kept as
    /// the app-level export job (`encrypted_vault_export_job`).
    pub fn export_encrypted_vault_items(
        &self,
        item_ids: &[String],
        destination: &Path,
        progress: &mut dyn FnMut(&EncryptedVaultExportProgress),
    ) -> Result<EncryptedVaultExportProgress, LibraryError> {
        let runtime = &*self.encrypted_vault;
        {
            let mut job = runtime.export_job();
            if job.as_ref().is_some_and(|job| job.running) {
                return Err(LibraryError::EncryptedVaultImportRunning);
            }
            let id = job.as_ref().map_or(1, |job| job.id + 1);
            *job = Some(EncryptedVaultExportJob {
                id,
                running: true,
                ..Default::default()
            });
        }
        let _job = ExportJobGuard(runtime);
        let result = self.run_encrypted_export(item_ids, destination, &mut |current| {
            if let Some(job) = runtime.export_job().as_mut().filter(|job| job.running) {
                job.progress = current.clone();
            }
            progress(current);
        });
        if let Some(job) = runtime.export_job().as_mut().filter(|job| job.running) {
            job.running = false;
            match &result {
                Ok(report) => job.progress = report.clone(),
                Err(error) => job.error = Some(export_error_code(error).to_owned()),
            }
        }
        result
    }

    /// The current or last export of this app session, if any.
    pub fn encrypted_vault_export_job(&self) -> Option<EncryptedVaultExportJob> {
        self.encrypted_vault.export_job().clone()
    }

    fn run_encrypted_export(
        &self,
        item_ids: &[String],
        destination: &Path,
        progress: &mut dyn FnMut(&EncryptedVaultExportProgress),
    ) -> Result<EncryptedVaultExportProgress, LibraryError> {
        let (vault, generation, root, entries) = {
            let state = self.encrypted_vault.state();
            let session = state
                .session
                .as_ref()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            let by_id = session
                .index
                .items
                .iter()
                .map(|item| (item.id.as_str(), item))
                .collect::<HashMap<_, _>>();
            let mut seen = HashSet::new();
            let entries = item_ids
                .iter()
                .filter(|id| seen.insert(id.as_str()))
                .map(|id| {
                    by_id
                        .get(id.as_str())
                        .map(|item| (item.object_id.clone(), item.original_file_name.clone()))
                })
                .collect::<Vec<_>>();
            (
                Arc::clone(&session.vault),
                session.generation,
                session.root.clone(),
                entries,
            )
        };
        let destination = export_destination(&root, destination)?;
        let mut report = EncryptedVaultExportProgress {
            total: entries.len() as u64,
            ..Default::default()
        };
        progress(&report);
        for entry in entries {
            // A lock (manual, USB removal, swapped vault) stops the export between files.
            if self
                .encrypted_vault
                .state()
                .session_matching(generation)
                .is_none()
            {
                return Err(LibraryError::EncryptedVaultLocked);
            }
            let exported = match &entry {
                Some((object_id, file_name)) => {
                    export_object(&vault, &destination, object_id, file_name)
                }
                None => Err(ExportFailure::Missing),
            };
            match exported {
                Ok(_) => report.exported += 1,
                Err(ExportFailure::Vault) if !vault_present(&root) => {
                    return Err(LibraryError::EncryptedVaultLocked)
                }
                Err(ExportFailure::Destination) if !destination.is_dir() => {
                    return Err(LibraryError::EncryptedVaultFolderUnavailable)
                }
                Err(_) => report.failed += 1,
            }
            report.processed += 1;
            progress(&report);
        }
        Ok(report)
    }
}

/// The canonical export folder: an existing folder outside the vault root. Anything on the
/// vault's drive under that root is refused, so plaintext never lands on the USB.
fn export_destination(vault_root: &Path, destination: &Path) -> Result<PathBuf, LibraryError> {
    let destination = fs::canonicalize(destination)
        .ok()
        .filter(|path| path.is_dir())
        .ok_or(LibraryError::EncryptedVaultFolderUnavailable)?;
    let root = fs::canonicalize(vault_root).map_err(|_| LibraryError::EncryptedVaultLocked)?;
    if destination.starts_with(&root) {
        return Err(LibraryError::EncryptedVaultInvalidRoot);
    }
    Ok(destination)
}

enum ExportFailure {
    /// The item is not in the vault (any more).
    Missing,
    /// The encrypted object could not be read or decrypted.
    Vault,
    /// The destination file could not be created or written.
    Destination,
}

/// Decrypts one object into `destination/<file name>` (collision-suffixed) through a hidden
/// temporary file, so a failure or crash never leaves a truncated file under the real name.
fn export_object(
    vault: &EncryptedVault,
    destination: &Path,
    object_id: &str,
    file_name: &str,
) -> Result<PathBuf, ExportFailure> {
    let mut reader = vault
        .open_object(object_id)
        .map_err(|_| ExportFailure::Vault)?;
    let temp = destination.join(format!(
        "{TEMP_PREFIX}{}.part",
        uuid::Uuid::new_v4().simple()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| ExportFailure::Destination)?;
    let written = (|| {
        let len = reader.len();
        let mut offset = 0;
        while offset < len {
            let mut step = reader
                .read_range(offset, EXPORT_STEP)
                .map_err(|_| ExportFailure::Vault)?;
            if step.is_empty() {
                return Err(ExportFailure::Vault);
            }
            let result = file.write_all(&step);
            offset += step.len() as u64;
            step.as_mut_slice().zeroize();
            result.map_err(|_| ExportFailure::Destination)?;
        }
        file.sync_all().map_err(|_| ExportFailure::Destination)
    })();
    drop(file);
    let finished = written.and_then(|()| {
        let (target, reserved) = reserve_name(destination, &export_file_name(file_name))
            .map_err(|_| ExportFailure::Destination)?;
        drop(reserved);
        fs::rename(&temp, &target).map_err(|_| {
            let _ = fs::remove_file(&target);
            ExportFailure::Destination
        })?;
        Ok(target)
    });
    if finished.is_err() {
        let _ = fs::remove_file(&temp);
    }
    finished
}

/// Creates `name`, or `<stem>_2<.ext>`, `<stem>_3<.ext>`… when taken, without replacing
/// anything (`create_new`). The empty file reserves the name until the rename.
fn reserve_name(destination: &Path, name: &str) -> io::Result<(PathBuf, File)> {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let candidate = if attempt == 1 {
            name.to_owned()
        } else {
            format!("{stem}_{attempt}{extension}")
        };
        let path = destination.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}

/// A file name safe on Windows and Linux: one path component, no reserved characters.
fn export_file_name(original: &str) -> String {
    let replaced = original
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>();
    let trimmed = replaced.trim_end_matches(['.', ' ']).trim_start();
    if trimmed.is_empty() || trimmed.starts_with(TEMP_PREFIX) {
        return FALLBACK_NAME.to_owned();
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use crate::library::{
        error::LibraryError,
        models::{EncryptedVaultItemKind, EncryptedVaultQuery, EncryptedVaultSecretInput},
        Library,
    };

    const PASSWORD: &str = "correct horse";

    fn setup() -> (tempfile::TempDir, Library, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        (temp, library, vault)
    }

    fn unlock(library: &Library) {
        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&EncryptedVaultSecretInput::Password(PASSWORD.into()), false)
            .unwrap();
    }

    fn write_png(path: &Path, width: u32) -> Vec<u8> {
        image::RgbImage::from_pixel(width, 8, image::Rgb([200, 40, 90]))
            .save(path)
            .unwrap();
        fs::read(path).unwrap()
    }

    fn video_bytes(len: usize) -> Vec<u8> {
        (0..len).map(|value| (value % 251) as u8).collect()
    }

    fn list(library: &Library, trashed: bool) -> Vec<(String, String)> {
        library
            .list_encrypted_vault_items(EncryptedVaultQuery {
                kind: None,
                offset: 0,
                limit: 100,
                trashed,
            })
            .unwrap()
            .items
            .into_iter()
            .map(|item| (item.original_file_name, item.id))
            .collect()
    }

    fn id_of(library: &Library, name: &str) -> String {
        list(library, false)
            .into_iter()
            .chain(list(library, true))
            .find(|(file_name, _)| file_name == name)
            .unwrap()
            .1
    }

    fn objects(vault: &Path) -> Vec<String> {
        let mut names = fs::read_dir(vault.join(".lakomics-vault/objects"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn counts(library: &Library) -> (Option<u64>, Option<u64>) {
        let status = library.encrypted_vault_status().unwrap();
        (status.item_count, status.trashed_count)
    }

    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut pending = vec![root.to_path_buf()];
        let mut files = Vec::new();
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    let bytes = fs::read(&path).unwrap();
                    files.push((path, bytes));
                }
            }
        }
        files.sort();
        files
    }

    /// Three images imported from a folder.
    fn three_images(temp: &Path, library: &Library) {
        let source = temp.join("source");
        fs::create_dir(&source).unwrap();
        for (index, name) in ["a.png", "b.png", "c.png"].into_iter().enumerate() {
            write_png(&source.join(name), 8 + index as u32);
        }
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
    }

    #[test]
    fn trash_hides_items_from_the_gallery_and_counts_and_restore_brings_them_back() {
        let (temp, library, vault) = setup();
        three_images(temp.path(), &library);
        let a = id_of(&library, "a.png");
        let b = id_of(&library, "b.png");
        let objects_before = objects(&vault);

        assert_eq!(
            library
                .trash_encrypted_vault_items(&[a.clone(), b.clone(), "unknown".into()])
                .unwrap(),
            2
        );
        // Trashing again changes nothing.
        assert_eq!(
            library.trash_encrypted_vault_items(&[a.clone()]).unwrap(),
            0
        );
        assert_eq!(counts(&library), (Some(1), Some(2)));
        let visible = list(&library, false);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].0, "c.png");
        let trashed = library
            .list_encrypted_vault_items(EncryptedVaultQuery {
                kind: Some(EncryptedVaultItemKind::Image),
                offset: 0,
                limit: 10,
                trashed: true,
            })
            .unwrap();
        assert_eq!(trashed.total_count, 2);
        assert!(trashed.items.iter().all(|item| item.trashed_at.is_some()));
        // Trashed items stay viewable from the trash, and nothing was deleted.
        assert!(library
            .encrypted_vault_media(&a, super::super::EncryptedVaultMediaVariant::Thumbnail)
            .is_ok());
        assert_eq!(objects(&vault), objects_before);

        // Saved: survives lock and unlock.
        unlock(&library);
        assert_eq!(counts(&library), (Some(1), Some(2)));
        assert_eq!(
            library.restore_encrypted_vault_items(&[a.clone()]).unwrap(),
            1
        );
        unlock(&library);
        assert_eq!(counts(&library), (Some(2), Some(1)));
        assert_eq!(list(&library, true)[0].1, b);
        assert!(list(&library, false).iter().all(|(_, id)| id != &b));
    }

    #[test]
    fn empty_trash_deletes_only_objects_no_remaining_item_references() {
        let (temp, library, vault) = setup();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("clip.mp4"), video_bytes(4096)).unwrap();
        let shared_bytes = write_png(&source.join("shared.png"), 8);
        write_png(&source.join("gone.png"), 9);
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        let shared = id_of(&library, "shared.png");
        let gone = id_of(&library, "gone.png");
        let clip = id_of(&library, "clip.mp4");
        // Content-addressed reuse: the video's thumbnail is the shared image's object.
        let (shared_object, shared_thumbnail, gone_objects) = {
            let mut state = library.encrypted_vault.state();
            let session = state.session.as_mut().unwrap();
            let find = |id: &str| {
                session
                    .index
                    .items
                    .iter()
                    .find(|item| item.id == id)
                    .unwrap()
                    .clone()
            };
            let shared_item = find(&shared);
            let gone_item = find(&gone);
            let video = session
                .index
                .items
                .iter_mut()
                .find(|item| item.id == clip)
                .unwrap();
            video.thumbnail_object_id = Some(shared_item.object_id.clone());
            let mut index = session.index.clone();
            session.vault.save_index(&mut index).unwrap();
            session.index.revision = index.revision;
            (
                shared_item.object_id,
                shared_item.thumbnail_object_id.unwrap(),
                [gone_item.object_id, gone_item.thumbnail_object_id.unwrap()],
            )
        };
        let before = objects(&vault);
        assert_eq!(before.len(), 6);

        library
            .trash_encrypted_vault_items(&[shared.clone(), gone.clone()])
            .unwrap();
        // Permanent deletion needs items to be in the trash first.
        assert_eq!(
            library
                .delete_encrypted_vault_items(&[clip.clone()])
                .unwrap(),
            0
        );
        assert_eq!(library.empty_encrypted_vault_trash().unwrap(), 2);
        assert_eq!(counts(&library), (Some(1), Some(0)));
        let after = objects(&vault);
        assert!(
            after.contains(&shared_object),
            "still the video's thumbnail"
        );
        assert!(!after.contains(&shared_thumbnail));
        for object in &gone_objects {
            assert!(!after.contains(object));
        }
        assert_eq!(after.len(), 3);
        let mut thumbnail = library
            .encrypted_vault_media(&clip, super::super::EncryptedVaultMediaVariant::Thumbnail)
            .unwrap();
        let len = thumbnail.len();
        assert_eq!(thumbnail.read_range(0, len).unwrap(), shared_bytes);
        // Saved before the objects went: the next unlock sees the same index.
        unlock(&library);
        assert_eq!(counts(&library), (Some(1), Some(0)));
        assert_eq!(objects(&vault), after);
        assert_eq!(library.empty_encrypted_vault_trash().unwrap(), 0);
    }

    #[test]
    fn permanent_delete_removes_only_the_selected_trashed_items() {
        let (temp, library, vault) = setup();
        three_images(temp.path(), &library);
        let [a, b, c] = ["a.png", "b.png", "c.png"].map(|name| id_of(&library, name));
        library
            .trash_encrypted_vault_items(&[a.clone(), b.clone()])
            .unwrap();
        let before = objects(&vault).len();
        assert_eq!(
            library
                .delete_encrypted_vault_items(&[a.clone(), c.clone()])
                .unwrap(),
            1
        );
        assert_eq!(objects(&vault).len(), before - 2);
        assert_eq!(counts(&library), (Some(1), Some(1)));
        assert_eq!(list(&library, true), [("b.png".to_owned(), b)]);
        assert!(matches!(
            library.encrypted_vault_media(&a, super::super::EncryptedVaultMediaVariant::Asset),
            Err(LibraryError::AssetNotFound)
        ));
    }

    #[test]
    fn deletion_is_refused_while_an_import_runs() {
        let (temp, library, _vault) = setup();
        three_images(temp.path(), &library);
        let a = id_of(&library, "a.png");
        library.trash_encrypted_vault_items(&[a.clone()]).unwrap();
        library.encrypted_vault.import_job().replace(
            crate::library::models::EncryptedVaultImportJob {
                id: 9,
                running: true,
                ..Default::default()
            },
        );
        assert!(matches!(
            library.empty_encrypted_vault_trash(),
            Err(LibraryError::EncryptedVaultImportRunning)
        ));
        library.encrypted_vault.import_job().take();
        assert_eq!(library.empty_encrypted_vault_trash().unwrap(), 1);
    }

    /// Sets every file under `root` to a modification time outside the orphan safety window.
    fn age_all_files(root: &Path) {
        let long_ago = std::time::SystemTime::now()
            - super::super::ORPHAN_SAFETY_WINDOW
            - std::time::Duration::from_secs(60);
        for (path, _) in snapshot(root) {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(long_ago)
                .unwrap();
        }
    }

    #[test]
    fn a_backup_index_session_is_read_only_and_the_next_unlock_deletes_nothing() {
        let (temp, library, vault) = setup();
        three_images(temp.path(), &library);
        let [a, b] = ["a.png", "b.png"].map(|name| id_of(&library, name));
        library.trash_encrypted_vault_items(&[a.clone()]).unwrap();
        // The newest generation references `d.png`; index.prev.bin does not know it.
        let newer = temp.path().join("newer");
        fs::create_dir(&newer).unwrap();
        write_png(&newer.join("d.png"), 20);
        library
            .import_into_encrypted_vault(&newer, &mut |_| {})
            .unwrap();
        let d = id_of(&library, "d.png");

        library.lock_encrypted_vault();
        let index = vault.join(".lakomics-vault/index.bin");
        let good = fs::read(&index).unwrap();
        let mut bytes = good.clone();
        bytes[60] ^= 1;
        fs::write(&index, bytes).unwrap();
        age_all_files(&vault);
        unlock(&library);
        assert!(library.encrypted_vault_status().unwrap().backup_index);
        assert_eq!(counts(&library), (Some(2), Some(1)));
        let before = snapshot(&vault);

        let read_only = |result: Result<_, LibraryError>| {
            matches!(result, Err(LibraryError::EncryptedVaultReadOnly))
        };
        assert!(read_only(library.empty_encrypted_vault_trash()));
        assert!(read_only(
            library.delete_encrypted_vault_items(&[a.clone()])
        ));
        assert!(read_only(library.trash_encrypted_vault_items(&[b.clone()])));
        assert!(read_only(
            library.restore_encrypted_vault_items(&[a.clone()])
        ));
        assert!(read_only(
            library
                .set_encrypted_vault_title(&b, Some("new title"))
                .map(|_| 0)
        ));
        assert!(read_only(
            library
                .import_into_encrypted_vault(&newer, &mut |_| {})
                .map(|_| 0)
        ));
        assert_eq!(
            library
                .encrypted_vault_import_job()
                .unwrap()
                .error
                .as_deref(),
            Some("encrypted_vault_read_only")
        );
        assert!(read_only(
            library.apply_encrypted_vault_sidecar_cleanup().map(|_| 0)
        ));
        // Nothing changed on disk or in the session.
        assert_eq!(snapshot(&vault), before);
        assert_eq!(counts(&library), (Some(2), Some(1)));
        assert_eq!(list(&library, true), [("a.png".to_owned(), a)]);

        // The next unlock still runs on the backup and deletes nothing.
        unlock(&library);
        assert!(library.encrypted_vault_status().unwrap().backup_index);
        assert_eq!(snapshot(&vault), before);

        // Once index.bin is readable again the newest generation is back, complete.
        fs::write(&index, good).unwrap();
        unlock(&library);
        assert!(!library.encrypted_vault_status().unwrap().backup_index);
        assert_eq!(counts(&library), (Some(3), Some(1)));
        let mut asset = library
            .encrypted_vault_media(&d, super::super::EncryptedVaultMediaVariant::Asset)
            .unwrap();
        let len = asset.len();
        assert_eq!(
            asset.read_range(0, len).unwrap(),
            fs::read(newer.join("d.png")).unwrap()
        );
    }

    #[test]
    fn trash_and_deletion_never_write_a_vault_swapped_under_the_session() {
        let (temp, library, vault) = setup();
        three_images(temp.path(), &library);
        let a = id_of(&library, "a.png");
        let b = id_of(&library, "b.png");
        library.trash_encrypted_vault_items(&[b.clone()]).unwrap();

        let other = Library::open(temp.path().join("other-library")).unwrap();
        let b_root = temp.path().join("b");
        fs::create_dir(&b_root).unwrap();
        other
            .create_encrypted_vault(&b_root, "other", false)
            .unwrap();
        let swap = |from: &Path, to: &Path| fs::rename(from, to).unwrap();
        swap(&vault, &temp.path().join("a-away"));
        swap(&b_root, &vault);
        let before = snapshot(&vault);

        assert!(matches!(
            library.trash_encrypted_vault_items(&[a.clone()]),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert_eq!(snapshot(&vault), before);
        // Reopen A, swap again, then try the permanent deletion.
        swap(&vault, &temp.path().join("b-away"));
        swap(&temp.path().join("a-away"), &vault);
        library.encrypted_vault_status().unwrap();
        unlock(&library);
        swap(&vault, &temp.path().join("a-away"));
        swap(&temp.path().join("b-away"), &vault);
        assert!(matches!(
            library.empty_encrypted_vault_trash(),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert_eq!(snapshot(&vault), before);
        // A's trashed item and its objects are intact.
        swap(&vault, &temp.path().join("b-away"));
        swap(&temp.path().join("a-away"), &vault);
        library.encrypted_vault_status().unwrap();
        unlock(&library);
        assert_eq!(counts(&library), (Some(2), Some(1)));
    }

    #[test]
    fn export_writes_decrypted_originals_with_original_names_and_suffixes() {
        let (temp, library, vault) = setup();
        let source = temp.path().join("source");
        fs::create_dir_all(source.join("one")).unwrap();
        fs::create_dir_all(source.join("two")).unwrap();
        let first = write_png(&source.join("one/same.png"), 8);
        let second = write_png(&source.join("two/same.png"), 12);
        // Several export steps, so the streaming loop is exercised.
        let video = video_bytes(2 * super::EXPORT_STEP as usize + 12_345);
        fs::write(source.join("clip.mp4"), &video).unwrap();
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        let ids = list(&library, false)
            .into_iter()
            .map(|(_, id)| id)
            .collect::<Vec<_>>();
        let destination = temp.path().join("export");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("clip.mp4"), b"already here").unwrap();

        let mut events = Vec::new();
        let mut request = ids.clone();
        request.push("unknown".into());
        let report = library
            .export_encrypted_vault_items(&request, &destination, &mut |progress| {
                events.push(progress.clone())
            })
            .unwrap();
        assert_eq!(
            (
                report.total,
                report.processed,
                report.exported,
                report.failed
            ),
            (4, 4, 3, 1)
        );
        assert_eq!(events.last(), Some(&report));
        assert_eq!(
            fs::read(destination.join("clip.mp4")).unwrap(),
            b"already here"
        );
        assert_eq!(fs::read(destination.join("clip_2.mp4")).unwrap(), video);
        let mut pngs = [
            fs::read(destination.join("same.png")).unwrap(),
            fs::read(destination.join("same_2.png")).unwrap(),
        ];
        pngs.sort();
        let mut expected = [first, second];
        expected.sort();
        assert_eq!(pngs, expected);
        let mut names = fs::read_dir(&destination)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["clip.mp4", "clip_2.mp4", "same.png", "same_2.png"]);
        let job = library.encrypted_vault_export_job().unwrap();
        assert_eq!((job.id, job.running, job.error), (1, false, None));
        assert_eq!(job.progress, report);

        // Never into the vault root (the USB), not even a subfolder of it.
        let before = snapshot(&vault);
        for target in [vault.clone(), vault.join(".lakomics-vault")] {
            assert!(matches!(
                library.export_encrypted_vault_items(&ids, &target, &mut |_| {}),
                Err(LibraryError::EncryptedVaultInvalidRoot)
            ));
        }
        let inside = vault.join("photos");
        fs::create_dir(&inside).unwrap();
        assert!(matches!(
            library.export_encrypted_vault_items(&ids, &inside, &mut |_| {}),
            Err(LibraryError::EncryptedVaultInvalidRoot)
        ));
        fs::remove_dir(&inside).unwrap();
        assert_eq!(snapshot(&vault), before);
        let job = library.encrypted_vault_export_job().unwrap();
        assert_eq!(job.error.as_deref(), Some("encrypted_vault_invalid_root"));
        assert!(matches!(
            library.export_encrypted_vault_items(&ids, &temp.path().join("missing"), &mut |_| {}),
            Err(LibraryError::EncryptedVaultFolderUnavailable)
        ));
        library.lock_encrypted_vault();
        assert!(matches!(
            library.export_encrypted_vault_items(&ids, &destination, &mut |_| {}),
            Err(LibraryError::EncryptedVaultLocked)
        ));
    }

    #[test]
    fn export_file_names_are_safe_and_suffixed_before_the_extension() {
        assert_eq!(super::export_file_name("a:b?.png"), "a_b_.png");
        assert_eq!(super::export_file_name("../x.png"), ".._x.png");
        assert_eq!(super::export_file_name("name. "), "name");
        assert_eq!(super::export_file_name(""), "vault-item");
        assert_eq!(super::export_file_name("con.jpg"), "_con.jpg");
        let temp = tempfile::tempdir().unwrap();
        for expected in [".hidden", ".hidden_2"] {
            let (path, _) = super::reserve_name(temp.path(), ".hidden").unwrap();
            assert_eq!(path.file_name().unwrap(), expected);
        }
        for expected in ["noext", "noext_2", "noext_3"] {
            let (path, _) = super::reserve_name(temp.path(), "noext").unwrap();
            assert_eq!(path.file_name().unwrap(), expected);
        }
    }

    #[test]
    fn add_files_dedupes_by_content_and_applies_sidecar_thumbnails() {
        let (temp, library, vault) = setup();
        let picked = temp.path().join("picked");
        fs::create_dir_all(picked.join("elsewhere")).unwrap();
        fs::write(picked.join("clip.mp4"), video_bytes(8192)).unwrap();
        let thumb = write_png(&picked.join("clip.mp4_thumb.png"), 16);
        write_png(&picked.join("elsewhere/photo.png"), 10);
        fs::write(picked.join("notes.txt"), b"not media").unwrap();
        let files = [
            picked.join("clip.mp4_thumb.png"),
            picked.join("elsewhere/photo.png"),
            picked.join("clip.mp4"),
            picked.join("notes.txt"),
        ];

        let report = library
            .import_files_into_encrypted_vault(&files, &mut |_| {})
            .unwrap();
        assert_eq!(
            (
                report.total,
                report.imported,
                report.sidecar_thumbnails,
                report.failed
            ),
            (3, 2, 1, 1)
        );
        let mut names = list(&library, false)
            .into_iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["clip.mp4", "photo.png"]);
        let clip = id_of(&library, "clip.mp4");
        let mut media = library
            .encrypted_vault_media(&clip, super::super::EncryptedVaultMediaVariant::Thumbnail)
            .unwrap();
        let len = media.len();
        assert_eq!(media.read_range(0, len).unwrap(), thumb);
        let objects_after_first = objects(&vault).len();

        // Adding the same files again stores nothing new.
        let again = library
            .import_files_into_encrypted_vault(&files[..3], &mut |_| {})
            .unwrap();
        assert_eq!(
            (again.imported, again.skipped, again.sidecar_thumbnails),
            (0, 3, 0)
        );
        assert_eq!(objects(&vault).len(), objects_after_first);
        assert_eq!(
            library.encrypted_vault_import_job().unwrap().report,
            Some(again)
        );

        // A trashed item does not count as present: adding it again brings it back.
        let photo = id_of(&library, "photo.png");
        library.trash_encrypted_vault_items(&[photo]).unwrap();
        let back = library
            .import_files_into_encrypted_vault(&files[1..2], &mut |_| {})
            .unwrap();
        assert_eq!((back.imported, back.skipped), (1, 0));
        assert_eq!(counts(&library), (Some(2), Some(1)));
    }
}
