//! Hash immutable inference snapshots outside the DB lock. Keep the original
//! identity and check it again at the final metadata transaction boundary.
use super::{
    characters::{Error, Result},
    Library,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
};

#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    length: u64,
    modified: std::time::SystemTime,
    identity: Vec<u64>,
}
/// A file's identity from its metadata alone (no read handle). Used for the reference
/// availability cache; [`stamp`] (with the Windows file index) guards inference snapshots.
#[cfg(unix)]
fn metadata_stamp(m: &std::fs::Metadata) -> Result<Stamp> {
    use std::os::unix::fs::MetadataExt;
    Ok(Stamp {
        length: m.len(),
        modified: m.modified()?,
        identity: vec![m.dev(), m.ino(), m.ctime() as u64, m.ctime_nsec() as u64],
    })
}
/// Stable std exposes no file index from path metadata on Windows: size, last write and
/// creation time (a replaced file is a new file with its own creation time) identify it.
#[cfg(windows)]
fn metadata_stamp(m: &std::fs::Metadata) -> Result<Stamp> {
    use std::os::windows::fs::MetadataExt;
    Ok(Stamp {
        length: m.file_size(),
        modified: m.modified()?,
        identity: vec![m.creation_time(), m.last_write_time()],
    })
}
fn stamp(file: &File) -> Result<Stamp> {
    let m = file.metadata()?;
    #[cfg(unix)]
    {
        metadata_stamp(&m)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Stamp {
            length: m.len(),
            modified: m.modified()?,
            identity: vec![
                info.dwVolumeSerialNumber as u64,
                info.nFileIndexHigh as u64,
                info.nFileIndexLow as u64,
            ],
        })
    }
}

/// Availability is independent of scoring. Keep successful opens while both the
/// content key and filesystem identity match; missing/unreadable files are retried.
#[derive(Debug, Default)]
pub(super) struct ReferenceFiles {
    files: std::collections::HashMap<String, (String, Stamp)>,
}

#[cfg(test)]
impl ReferenceFiles {
    pub(super) fn clear(&mut self) {
        self.files.clear();
    }
}

#[cfg(test)]
thread_local! {
    /// Reference availability checks on this thread: (all, made while the library's
    /// database lock was held, files opened to confirm an uncached identity).
    pub(super) static REFERENCE_CHECKS: std::cell::Cell<(usize, usize, usize)> =
        const { std::cell::Cell::new((0, 0, 0)) };
}

impl Library {
    /// True when `relative` is a readable library file whose identity was confirmed for
    /// `hash`. A cached identity costs one metadata read; a new or changed file (other
    /// size, times or file identity) is opened once to confirm it. Call it without the
    /// database lock: on a cold disk cache every uncached check is a disk access.
    pub(super) fn character_reference_available(&self, relative: &str, hash: &str) -> bool {
        #[cfg(test)]
        REFERENCE_CHECKS.with(|checks| {
            let (all, locked, opened) = checks.get();
            let held = matches!(
                self.database_lock.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
            checks.set((all + 1, locked + usize::from(held), opened));
        });
        let current = self
            .library_media_path(relative)
            .ok()
            .and_then(|path| std::fs::metadata(path).ok())
            .filter(|m| m.is_file())
            .and_then(|m| metadata_stamp(&m).ok());
        let mut cache = self
            .character_reference_files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(identity) = current {
            if cache
                .files
                .get(relative)
                .is_some_and(|(cached_hash, cached_identity)| {
                    cached_hash == hash && cached_identity == &identity
                })
            {
                return true;
            }
            #[cfg(test)]
            REFERENCE_CHECKS.with(|checks| {
                let (all, locked, opened) = checks.get();
                checks.set((all, locked, opened + 1));
            });
            if let Ok(media) = self.open_library_media(relative) {
                if media
                    .file
                    .metadata()
                    .ok()
                    .and_then(|m| metadata_stamp(&m).ok())
                    .is_some_and(|opened| opened == identity)
                {
                    if cache.files.len() >= 4096 {
                        cache.files.clear();
                    }
                    cache.files.insert(relative.into(), (hash.into(), identity));
                    return true;
                }
            }
        }
        cache.files.remove(relative);
        false
    }
}

#[cfg(test)]
thread_local! {
    pub(super) static ORIGINAL_OPENS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn hash_copy(file: &mut File, mut copy: Option<&mut File>) -> Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        if let Some(out) = copy.as_deref_mut() {
            out.write_all(&buffer[..n])?;
        }
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
#[derive(Debug)]
pub(super) struct Source {
    relative: String,
    hash: String,
    original: File,
    identity: Stamp,
    snapshot: tempfile::NamedTempFile,
}
impl Source {
    pub(super) fn capture(library: &Library, relative: &str, hash: &str) -> Result<Self> {
        let mut original = library.open_library_media(relative)?.file;
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let pinned = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(library.root.join(relative))?;
            if stamp(&pinned)? != stamp(&original)? {
                return Err(Error::Stale);
            }
            original = pinned;
        }
        let identity = stamp(&original)?;
        let mut snapshot = tempfile::Builder::new()
            .prefix("lakomics-character-")
            .tempfile()?;
        if hash_copy(&mut original, Some(snapshot.as_file_mut()))? != hash
            || stamp(&original)? != identity
        {
            return Err(Error::Stale);
        }
        snapshot.flush()?;
        Ok(Self {
            relative: relative.into(),
            hash: hash.into(),
            original,
            identity,
            snapshot,
        })
    }
    pub(super) fn path(&self) -> PathBuf {
        self.snapshot.path().to_owned()
    }
    pub(super) fn verify(&self, library: &Library) -> Result<()> {
        let mut current = library.open_library_media(&self.relative)?.file;
        if stamp(&current)? != self.identity
            || hash_copy(&mut current, None)? != self.hash
            || stamp(&current)? != self.identity
        {
            return Err(Error::Stale);
        }
        Ok(())
    }
    pub(super) fn check_identity(&self, library: &Library) -> Result<()> {
        #[cfg(unix)]
        let current = metadata_stamp(&std::fs::metadata(
            library.library_media_path(&self.relative)?,
        )?)?;
        #[cfg(windows)]
        let current = stamp(&library.open_library_media(&self.relative)?.file)?;
        if current != self.identity || stamp(&self.original)? != self.identity {
            return Err(Error::Stale);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::characters::tests::Fixture;
    #[test]
    fn snapshots_retain_inference_bytes_and_reject_external_replacement() {
        let f = Fixture::new();
        let hash: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT content_hash FROM assets WHERE id='asset-5'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let source = Source::capture(&f.library, "assets/asset-5.png", &hash).unwrap();
        source.verify(&f.library).unwrap();
        source.check_identity(&f.library).unwrap();
        #[cfg(unix)]
        {
            let changed = f.temp.path().join("replacement");
            std::fs::write(&changed, b"changed").unwrap();
            std::fs::rename(changed, f.temp.path().join("assets/asset-5.png")).unwrap();
            assert_eq!(std::fs::read(source.path()).unwrap(), b"asset-5");
            assert!(source.verify(&f.library).is_err());
            assert!(source.check_identity(&f.library).is_err());
        }
        #[cfg(windows)]
        assert!(std::fs::write(f.temp.path().join("assets/asset-5.png"), b"changed").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unchanged_reference_sets_and_snapshots_reopen_no_originals() {
        let f = Fixture::new();
        let target = f.ready("Cached");
        let c = f.library.connection().unwrap();
        let source = Source::capture(
            &f.library,
            "assets/asset-0.png",
            &target.references[0].asset_hash,
        )
        .unwrap();
        ORIGINAL_OPENS.with(|n| n.set(0));
        for _ in 0..32 {
            let current = f.library.read_character_target(&c, &target.id).unwrap();
            assert_eq!(current.fingerprint, target.fingerprint);
            source.check_identity(&f.library).unwrap();
        }
        assert_eq!(ORIGINAL_OPENS.with(|n| n.get()), 0);
        let replacement = f.temp.path().join("replacement");
        std::fs::write(&replacement, b"replacement bytes").unwrap();
        std::fs::rename(&replacement, f.temp.path().join("assets/asset-0.png")).unwrap();
        assert!(source.check_identity(&f.library).is_err());
        assert!(f
            .library
            .character_reference_available("assets/asset-0.png", &target.references[0].asset_hash));
        assert_eq!(
            ORIGINAL_OPENS.with(|n| n.get()),
            1,
            "replacement must reopen, even if the DB hash has not changed"
        );
        std::fs::remove_file(f.temp.path().join("assets/asset-0.png")).unwrap();
        assert!(!f
            .library
            .character_reference_available("assets/asset-0.png", &target.references[0].asset_hash));
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), f.temp.path().join("assets/asset-0.png"))
            .unwrap();
        assert!(!f
            .library
            .character_reference_available("assets/asset-0.png", &target.references[0].asset_hash));
        assert!(source.check_identity(&f.library).is_err());
    }

    #[test]
    #[ignore = "explicit local reference lifecycle benchmark"]
    fn benchmark_prepared_reference_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        std::fs::create_dir(temp.path().join("references")).unwrap();
        let references = (0..18)
            .map(|index| {
                let relative = format!("references/{index}.bin");
                let bytes = vec![index as u8; 421_000];
                std::fs::write(temp.path().join(&relative), &bytes).unwrap();
                let hash = Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                (relative, hash)
            })
            .collect::<Vec<_>>();
        let candidates = 20;

        let old_started = std::time::Instant::now();
        for _ in 0..candidates {
            for (path, hash) in &references {
                let source = Source::capture(&library, path, hash).unwrap();
                source.verify(&library).unwrap();
            }
        }
        let old = old_started.elapsed();

        let prepared_started = std::time::Instant::now();
        let prepared = references
            .iter()
            .map(|(path, hash)| Source::capture(&library, path, hash).unwrap())
            .collect::<Vec<_>>();
        for _ in 0..candidates {
            for source in &prepared {
                source.check_identity(&library).unwrap();
            }
        }
        let prepared_time = prepared_started.elapsed();
        eprintln!("reference_lifecycle before_assets_per_sec={:.2} after_assets_per_sec={:.2} before_ms_per_asset={:.2} after_ms_per_asset={:.2}",
            candidates as f64 / old.as_secs_f64(), candidates as f64 / prepared_time.as_secs_f64(),
            old.as_secs_f64() * 1000.0 / candidates as f64, prepared_time.as_secs_f64() * 1000.0 / candidates as f64);
    }

    fn checks() -> (usize, usize, usize) {
        REFERENCE_CHECKS.with(|checks| checks.get())
    }

    #[test]
    fn reference_availability_is_cached_until_the_file_metadata_changes() {
        let f = Fixture::new();
        let target = f.ready("Cached");
        f.library.character_reference_files.lock().unwrap().clear();
        let hash = &target.references[0].asset_hash;
        let available = || {
            f.library
                .character_reference_available("assets/asset-0.png", hash)
        };
        REFERENCE_CHECKS.with(|checks| checks.set((0, 0, 0)));
        assert!(available());
        assert!(available());
        assert!(available());
        // The first check opens the file once; the rest are metadata reads.
        assert_eq!(checks(), (3, 0, 1));
        std::fs::write(f.temp.path().join("assets/asset-0.png"), b"edited in place").unwrap();
        assert!(available());
        assert_eq!(checks().2, 2, "a changed file is confirmed again");
        assert!(available());
        assert_eq!(checks().2, 2);
        // A different content key is never answered from the cache.
        assert!(f
            .library
            .character_reference_available("assets/asset-0.png", "other-hash"));
        assert_eq!(checks().2, 3);
        std::fs::remove_file(f.temp.path().join("assets/asset-0.png")).unwrap();
        assert!(!available());
        assert_eq!(checks().2, 3, "a missing file is not opened");
    }

    #[test]
    fn reference_statuses_match_between_locked_and_unlocked_reads() {
        let f = Fixture::new();
        let target = f.ready("Statuses");
        let slot_of = |asset: &str| {
            target
                .references
                .iter()
                .position(|r| r.asset_id.as_deref() == Some(asset))
                .unwrap()
        };
        std::fs::remove_file(f.temp.path().join("assets/asset-1.png")).unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash='changed' WHERE id='asset-2'",
                [],
            )
            .unwrap();
        let locked = {
            let c = f.library.connection().unwrap();
            f.library.read_character_target(&c, &target.id).unwrap()
        };
        let unlocked = f.library.get_character_target(&target.id).unwrap();
        let listed = f
            .library
            .list_character_targets()
            .unwrap()
            .into_iter()
            .find(|t| t.id == target.id)
            .unwrap();
        let statuses = |t: &super::super::characters::Target| {
            t.references.iter().map(|r| r.status).collect::<Vec<_>>()
        };
        let mut expected = vec!["ready"; 5];
        expected[slot_of("asset-1")] = "missing_file";
        expected[slot_of("asset-2")] = "changed_content";
        assert_eq!(statuses(&locked), expected);
        assert_eq!(statuses(&unlocked), expected);
        assert_eq!(statuses(&listed), expected);
        assert_eq!(locked.fingerprint, unlocked.fingerprint);
        assert_eq!(locked.fingerprint, listed.fingerprint);
        assert!(!listed.ready);
    }

    #[test]
    fn listing_and_review_reads_check_reference_files_without_the_database_lock() {
        let f = Fixture::new();
        f.ready("A");
        let b = f.ready("B");
        REFERENCE_CHECKS.with(|checks| checks.set((0, 0, 0)));
        assert_eq!(f.library.list_character_targets().unwrap().len(), 2);
        f.library.get_character_target(&b.id).unwrap();
        f.library.character_review_pending_map().unwrap();
        f.library.b36_recommended_pairs().unwrap();
        f.library.shadow_review_items(None).unwrap();
        let (all, locked, _) = checks();
        assert!(all >= 30, "{all}");
        assert_eq!(locked, 0);
        // The hook does see a check made under the lock (transactional callers keep it).
        let c = f.library.connection().unwrap();
        f.library.read_character_target(&c, &b.id).unwrap();
        assert_eq!(checks().1, 5);
    }
}
