//! Local copies of finished cutouts, keyed by asset id and model: `<root>/<model>/<id>.webp|png`.
//! The PC shows these through `/card-cutout/<assetId>` without asking the server for a ticket.
use crate::cloud::client::card_cutouts::{valid_id, UploadSpec, MAX_CUTOUT_BYTES, MODEL_ID};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Called once at startup; the media protocol serves from here.
pub(crate) fn set_root(root: PathBuf) {
    let _ = ROOT.set(root);
}

const FORMATS: [(&str, &str); 2] = [("webp", "image/webp"), ("png", "image/png")];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cached {
    pub path: PathBuf,
    pub content_type: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct Cache {
    root: PathBuf,
}

impl Cache {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn dir(&self) -> PathBuf {
        self.root.join(MODEL_ID)
    }

    /// Where the worker writes a result before it is stored: `<dir>/<id>` plus an extension.
    pub(crate) fn stem(&self, asset_id: &str) -> PathBuf {
        self.dir().join(asset_id)
    }

    pub(crate) fn find(&self, asset_id: &str) -> Option<Cached> {
        if !valid_id(asset_id) {
            return None;
        }
        FORMATS.iter().find_map(|(extension, content_type)| {
            let path = self.dir().join(format!("{asset_id}.{extension}"));
            let length = std::fs::metadata(&path).ok().filter(|m| m.is_file())?.len();
            (1..=MAX_CUTOUT_BYTES)
                .contains(&length)
                .then_some(Cached { path, content_type })
        })
    }

    /// The bytes and the exact upload description of a cached cutout.
    pub(crate) fn read(
        &self,
        asset_id: &str,
        cached: &Cached,
    ) -> io::Result<(UploadSpec, Vec<u8>)> {
        let bytes = std::fs::read(&cached.path)?;
        let spec = UploadSpec {
            asset_id: asset_id.to_owned(),
            sha256: hex(&Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
            content_type: cached.content_type.to_owned(),
        };
        Ok((spec, bytes))
    }

    /// Removes any other format of the same asset so a lookup never finds a stale one, then
    /// reports the stored file. The worker already wrote `<stem>.<ext>` atomically.
    pub(crate) fn adopt(&self, asset_id: &str, written: &Path) -> io::Result<Cached> {
        let extension = written
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        let (_, content_type) =
            *FORMATS
                .iter()
                .find(|(e, _)| *e == extension)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "unexpected cutout format")
                })?;
        if written != self.dir().join(format!("{asset_id}.{extension}")) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cutout outside the cache",
            ));
        }
        for (other, _) in FORMATS.iter().filter(|(e, _)| *e != extension) {
            let _ = std::fs::remove_file(self.dir().join(format!("{asset_id}.{other}")));
        }
        Ok(Cached {
            path: written.to_path_buf(),
            content_type,
        })
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The cached file for the media protocol, or `None`.
pub(crate) fn protocol_file(asset_id: &str) -> Option<(Vec<u8>, &'static str)> {
    let cache = Cache::new(ROOT.get()?.clone());
    let cached = cache.find(asset_id)?;
    Some((std::fs::read(&cached.path).ok()?, cached.content_type))
}

/// The URL the cards use for a locally cached cutout.
pub(crate) fn local_url(asset_id: &str) -> Option<String> {
    let cache = Cache::new(ROOT.get()?.clone());
    cache
        .find(asset_id)
        .map(|_| format!("http://lakomics.localhost/card-cutout/{asset_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> (tempfile::TempDir, Cache) {
        let root = tempfile::tempdir().unwrap();
        let cache = Cache::new(root.path().to_path_buf());
        std::fs::create_dir_all(cache.dir()).unwrap();
        (root, cache)
    }

    #[test]
    fn files_are_keyed_by_model_and_asset_id() {
        let (root, cache) = cache();
        assert_eq!(
            cache.stem("art-1"),
            root.path().join("toonout-1").join("art-1")
        );
        assert!(cache.find("art-1").is_none());
        std::fs::write(cache.dir().join("art-1.webp"), b"webp").unwrap();
        let found = cache.find("art-1").unwrap();
        assert_eq!(
            (found.content_type, found.path.file_name().unwrap()),
            ("image/webp", "art-1.webp".as_ref())
        );
        assert!(cache.find("art-2").is_none());
    }

    #[test]
    fn a_different_model_never_sees_these_files() {
        let (root, cache) = cache();
        std::fs::write(cache.dir().join("art-1.webp"), b"webp").unwrap();
        let other = Cache::new(root.path().join("other-root"));
        assert!(other.find("art-1").is_none());
        assert!(cache.dir().ends_with(MODEL_ID));
    }

    #[test]
    fn lookups_reject_bad_ids_empty_and_oversized_files() {
        let (_root, cache) = cache();
        for bad in ["", "../x", "a/b", "a b"] {
            assert!(cache.find(bad).is_none(), "{bad}");
        }
        std::fs::write(cache.dir().join("empty.webp"), b"").unwrap();
        assert!(cache.find("empty").is_none());
        std::fs::write(
            cache.dir().join("big.webp"),
            vec![0u8; MAX_CUTOUT_BYTES as usize + 1],
        )
        .unwrap();
        assert!(cache.find("big").is_none());
    }

    #[test]
    fn upload_description_hashes_the_stored_bytes() {
        let (_root, cache) = cache();
        std::fs::write(cache.dir().join("art-1.png"), b"hello").unwrap();
        let cached = cache.find("art-1").unwrap();
        let (spec, bytes) = cache.read("art-1", &cached).unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(
            (
                spec.sha256.as_str(),
                spec.size_bytes,
                spec.content_type.as_str()
            ),
            (
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                5,
                "image/png"
            )
        );
    }

    #[test]
    fn adopting_a_new_format_removes_the_stale_one_and_stays_inside_the_cache() {
        let (_root, cache) = cache();
        std::fs::write(cache.dir().join("art-1.png"), b"old").unwrap();
        std::fs::write(cache.dir().join("art-1.webp"), b"new").unwrap();
        let adopted = cache
            .adopt("art-1", &cache.dir().join("art-1.webp"))
            .unwrap();
        assert_eq!(adopted.content_type, "image/webp");
        assert!(!cache.dir().join("art-1.png").exists());
        assert!(cache
            .adopt("art-1", &cache.dir().join("elsewhere.webp"))
            .is_err());
        assert!(cache
            .adopt("art-1", &cache.dir().join("art-1.exe"))
            .is_err());
    }
}
