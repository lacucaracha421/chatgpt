mod backup;
mod classification;
mod db;
pub mod error;
mod favorite;
mod ingestion;
mod lock;
pub mod models;
mod query;
mod trash;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use error::LibraryError;
use lock::LibraryLease;
use models::{LibrarySummary, TrashPolicy};
use rusqlite::{Connection, OptionalExtension};

#[derive(Debug, Clone, Copy)]
pub enum MediaVariant {
    Asset,
    Thumbnail,
}

#[derive(Debug)]
pub struct MediaResponse {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// The library interface does not expose its SQLite connection.
///
/// ```compile_fail
/// fn direct_database_access(library: &app_lib::library::Library) {
///     let _ = library.connection();
/// }
/// ```
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
    #[allow(dead_code)] // Keeps the operating-system lease alive for all Library clones.
    lease: Arc<LibraryLease>,
    // ponytail: one lock per open Library; split by content hash only if ingest throughput demands it.
    ingestion_lock: Arc<Mutex<()>>,
    // ponytail: one lock per open Library; split by asset only if trash throughput demands it.
    trash_lock: Arc<Mutex<()>>,
}

impl Library {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, LibraryError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(|source| LibraryError::CreateDirectory {
            path: root.clone(),
            source,
        })?;
        let lease = Arc::new(LibraryLease::acquire(&root)?);
        for name in ["assets", "thumbnails", "backups"] {
            let path = root.join(name);
            fs::create_dir_all(&path)
                .map_err(|source| LibraryError::CreateDirectory { path, source })?;
        }
        db::open_database(&root.join("library.sqlite"))?;
        Ok(Self {
            root,
            lease,
            ingestion_lock: Arc::new(Mutex::new(())),
            trash_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn connection(&self) -> Result<Connection, LibraryError> {
        db::open_database(&self.root.join("library.sqlite"))
    }

    pub fn summary(&self) -> Result<LibrarySummary, LibraryError> {
        let connection = self.connection()?;
        let asset_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'normal'",
            [],
            |row| row.get(0),
        )?;
        Ok(LibrarySummary {
            root: self.root.to_string_lossy().into_owned(),
            asset_count: asset_count as u64,
        })
    }

    pub fn trash_policy(&self) -> Result<TrashPolicy, LibraryError> {
        let retention_days = self.connection()?.query_row(
            "SELECT trash_retention_days FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(TrashPolicy { retention_days })
    }

    pub fn set_trash_policy(&self, policy: TrashPolicy) -> Result<(), LibraryError> {
        if policy
            .retention_days
            .is_some_and(|days| !(1..=3650).contains(&days))
        {
            return Err(LibraryError::InvalidTrashRetention);
        }
        self.connection()?.execute(
            "UPDATE library_settings SET trash_retention_days = ?1 WHERE singleton = 1",
            [policy.retention_days],
        )?;
        Ok(())
    }

    pub fn resolve_media(
        &self,
        asset_id: &str,
        variant: MediaVariant,
    ) -> Result<MediaResponse, LibraryError> {
        let column = match variant {
            MediaVariant::Asset => "relative_path",
            MediaVariant::Thumbnail => "thumbnail_relative_path",
        };
        let relative_path: Option<String> = self
            .connection()?
            .query_row(
                &format!("SELECT {column} FROM assets WHERE id = ?1 AND status = 'normal'"),
                [asset_id],
                |row| row.get(0),
            )
            .optional()?;
        let relative_path = relative_path.ok_or(LibraryError::AssetNotFound)?;
        let canonical_root =
            fs::canonicalize(&self.root).map_err(|source| LibraryError::ReadMedia {
                path: self.root.clone(),
                source,
            })?;
        let requested_path = canonical_root.join(relative_path);
        let canonical_path = fs::canonicalize(&requested_path).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                LibraryError::MediaNotFound
            } else {
                LibraryError::ReadMedia {
                    path: requested_path.clone(),
                    source,
                }
            }
        })?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let mime = mime_for_path(&canonical_path);
        let bytes = fs::read(&canonical_path).map_err(|source| LibraryError::ReadMedia {
            path: canonical_path,
            source,
        })?;
        Ok(MediaResponse { bytes, mime })
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::Connection;

    use super::{error::LibraryError, Library};

    #[test]
    fn second_library_open_is_rejected_until_the_first_is_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let first = Library::open(temp.path()).unwrap();
        let removed_directory = temp.path().join("assets");
        fs::remove_dir(&removed_directory).unwrap();

        let error = Library::open(temp.path()).unwrap_err();
        assert!(matches!(error, LibraryError::LibraryInUse));
        assert!(
            !removed_directory.exists(),
            "a rejected opener recreated a layout directory"
        );

        drop(first);
        Library::open(temp.path()).unwrap();
    }

    #[test]
    fn open_creates_the_self_contained_library_layout_without_a_trash_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Lakomics Library");

        let library = Library::open(&root).unwrap();

        assert_eq!(library.root(), root.as_path());
        assert!(root.join("library.sqlite").is_file());
        for directory in ["assets", "thumbnails", "backups"] {
            assert!(root.join(directory).is_dir(), "{directory} was not created");
        }
        assert!(!root.join("trash").exists());
        let version: i64 = Connection::open(root.join("library.sqlite"))
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(library.summary().unwrap().asset_count, 0);
    }
}
