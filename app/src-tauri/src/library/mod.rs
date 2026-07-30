mod classification;
mod db;
pub mod error;
mod ingestion;
pub mod models;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use error::LibraryError;
use models::LibrarySummary;
use rusqlite::Connection;

#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
    // ponytail: one lock per open Library; split by content hash only if ingest throughput demands it.
    ingestion_lock: Arc<Mutex<()>>,
}

impl Library {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, LibraryError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(|source| LibraryError::CreateDirectory {
            path: root.clone(),
            source,
        })?;
        for name in ["assets", "thumbnails", "trash", "backups"] {
            let path = root.join(name);
            fs::create_dir_all(&path)
                .map_err(|source| LibraryError::CreateDirectory { path, source })?;
        }
        db::open_database(&root.join("library.sqlite"))?;
        Ok(Self {
            root,
            ingestion_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn connection(&self) -> Result<Connection, LibraryError> {
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
}

#[cfg(test)]
mod tests {
    use super::Library;

    #[test]
    fn open_creates_the_self_contained_library_layout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Lakomics Library");

        let library = Library::open(&root).unwrap();

        assert_eq!(library.root(), root.as_path());
        assert!(root.join("library.sqlite").is_file());
        for directory in ["assets", "thumbnails", "trash", "backups"] {
            assert!(root.join(directory).is_dir(), "{directory} was not created");
        }
        assert_eq!(library.summary().unwrap().asset_count, 0);
    }
}
