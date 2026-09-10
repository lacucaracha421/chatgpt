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
fn stamp(file: &File) -> Result<Stamp> {
    let m = file.metadata()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        vec![m.dev(), m.ino(), m.ctime() as u64, m.ctime_nsec() as u64]
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        vec![
            info.dwVolumeSerialNumber as u64,
            info.nFileIndexHigh as u64,
            info.nFileIndexLow as u64,
        ]
    };
    Ok(Stamp {
        length: m.len(),
        modified: m.modified()?,
        identity,
    })
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
        let current = library.open_library_media(&self.relative)?.file;
        if stamp(&current)? != self.identity || stamp(&self.original)? != self.identity {
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

    #[test]
    #[ignore = "explicit local reference lifecycle benchmark"]
    fn benchmark_prepared_reference_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        std::fs::create_dir(temp.path().join("references")).unwrap();
        let references = (0..18).map(|index| {
            let relative = format!("references/{index}.bin");
            let bytes = vec![index as u8; 421_000];
            std::fs::write(temp.path().join(&relative), &bytes).unwrap();
            let hash = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            (relative, hash)
        }).collect::<Vec<_>>();
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
        let prepared = references.iter().map(|(path, hash)| Source::capture(&library, path, hash).unwrap()).collect::<Vec<_>>();
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
}
