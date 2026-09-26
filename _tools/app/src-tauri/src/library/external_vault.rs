//! Encrypted Private Vault (ADR-0039). The old plaintext vault format survives only as an
//! import source (`encrypted_runtime::read_legacy_index`).
#[path = "private_vault/discovery.rs"]
mod discovery;
#[cfg(test)]
#[path = "private_vault/index.rs"]
mod index;
#[path = "private_vault/scan.rs"]
mod scan;
#[path = "private_vault/crypto.rs"]
mod crypto;
#[path = "private_vault/encrypted_store.rs"]
mod encrypted_store;
#[path = "private_vault/encrypted_runtime.rs"]
mod encrypted_runtime;
#[path = "private_vault/watch.rs"]
mod watch;

pub(crate) use encrypted_runtime::{
    EncryptedVaultMedia, EncryptedVaultMediaVariant, EncryptedVaultRuntime,
};
pub(crate) use watch::{start_mount_watcher, stop_mount_watcher, VAULT_MOUNTS_CHANGED_EVENT};

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use super::{error::LibraryError, Library};

fn validated_relative(value: &str) -> Result<PathBuf, LibraryError> {
    let path = Path::new(value);
    if path.is_absolute() || value.is_empty() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(LibraryError::UnsafeMediaPath);
        };
        clean.push(part);
    }
    if clean.as_os_str().is_empty() {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(clean)
}

fn canonical_vault_root(library: &Library, root: &Path) -> Result<PathBuf, LibraryError> {
    let canonical = fs::canonicalize(root).map_err(|source| LibraryError::ReadMedia {
        path: root.to_path_buf(),
        source,
    })?;
    if !canonical.is_dir() {
        return Err(LibraryError::MediaNotFound);
    }
    let library_root =
        fs::canonicalize(library.root()).map_err(|source| LibraryError::ReadMedia {
            path: library.root().to_path_buf(),
            source,
        })?;
    if canonical.starts_with(&library_root) || library_root.starts_with(&canonical) {
        return Err(LibraryError::UnsafeMediaPath);
    }
    Ok(canonical)
}

#[cfg(test)]
mod root_boundary_tests {
    use crate::library::{error::LibraryError, Library};

    #[test]
    fn vault_roots_must_not_contain_or_sit_inside_the_main_library() {
        let temp = tempfile::tempdir().unwrap();
        let library_root = temp.path().join("parent/library");
        let library = Library::open(&library_root).unwrap();
        let nested = library_root.join("external");
        std::fs::create_dir(&nested).unwrap();

        let nested_error = super::canonical_vault_root(&library, &nested).unwrap_err();
        assert!(matches!(nested_error, LibraryError::UnsafeMediaPath));

        let parent_error =
            super::canonical_vault_root(&library, temp.path().join("parent").as_path())
                .unwrap_err();
        assert!(matches!(parent_error, LibraryError::UnsafeMediaPath));

        let outside = temp.path().join("vault");
        std::fs::create_dir(&outside).unwrap();
        assert!(super::canonical_vault_root(&library, &outside).is_ok());
    }
}
