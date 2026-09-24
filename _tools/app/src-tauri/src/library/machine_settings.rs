//! Library settings that belong to this computer rather than to the library.
//!
//! The library database is shared by every machine that opens it (Windows and
//! Linux, via sync), so an absolute path saved there on one OS is meaningless on
//! the other. Such values live in the app config directory instead, keyed by the
//! library's durable `library_id`.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::error::LibraryError;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineSettingsFile {
    #[serde(default)]
    workload: crate::workload::Settings,
    #[serde(default)]
    new_ingests: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    libraries: BTreeMap<String, LibraryEntry>,
}

/// A present entry is authoritative for this machine; `manga_root: None` means
/// the folder was explicitly cleared here and the shared value must not return.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryEntry {
    #[serde(default)]
    pub(crate) manga_root: Option<String>,
}

fn error(path: &Path, source: io::Error) -> LibraryError {
    LibraryError::MachineSettings {
        path: path.to_path_buf(),
        source,
    }
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn read_file(path: &Path) -> Result<MachineSettingsFile, LibraryError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|parse| error(path, io::Error::new(io::ErrorKind::InvalidData, parse))),
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            Ok(MachineSettingsFile::default())
        }
        Err(source) => Err(error(path, source)),
    }
}

pub(crate) fn entry(path: &Path, library_id: &str) -> Result<Option<LibraryEntry>, LibraryError> {
    Ok(read_file(path)?.libraries.get(library_id).cloned())
}

/// Read-modify-write of the whole file, published by atomic rename so a crash
/// never leaves a truncated file. A file that cannot be parsed is not overwritten.
pub(crate) fn set_entry(
    path: &Path,
    library_id: &str,
    value: LibraryEntry,
) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    file.libraries.insert(library_id.to_owned(), value);
    write_file(path, &file)
}

fn write_file(path: &Path, file: &MachineSettingsFile) -> Result<(), LibraryError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| error(path, source))?;
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|serialize| error(path, io::Error::new(io::ErrorKind::InvalidData, serialize)))?;
    let temporary: PathBuf = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("library-machine.json"),
        std::process::id()
    ));
    let written = fs::File::create(&temporary)
        .and_then(|mut handle| handle.write_all(&bytes).and_then(|()| handle.sync_all()))
        .and_then(|()| fs::rename(&temporary, path));
    if let Err(source) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error(path, source));
    }
    Ok(())
}

/// An absolute directory that exists on this machine. A Windows drive path is
/// not absolute on Linux (and a POSIX path is not absolute on Windows), so a
/// value saved by the other OS is never adopted here.
pub(crate) fn usable_directory(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute() && path.is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_kept_per_library_and_survive_rewrites() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config").join("library-machine.json");
        assert_eq!(entry(&path, "lib-a").unwrap(), None);
        set_entry(
            &path,
            "lib-a",
            LibraryEntry {
                manga_root: Some("/manga/a".into()),
            },
        )
        .unwrap();
        set_entry(&path, "lib-b", LibraryEntry { manga_root: None }).unwrap();
        assert_eq!(
            entry(&path, "lib-a")
                .unwrap()
                .unwrap()
                .manga_root
                .as_deref(),
            Some("/manga/a")
        );
        assert_eq!(
            entry(&path, "lib-b").unwrap(),
            Some(LibraryEntry { manga_root: None })
        );
    }

    #[test]
    fn an_unreadable_file_is_reported_and_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library-machine.json");
        fs::write(&path, b"{ not json").unwrap();
        assert!(matches!(
            entry(&path, "lib-a"),
            Err(LibraryError::MachineSettings { .. })
        ));
        assert!(set_entry(&path, "lib-a", LibraryEntry::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
    }

    #[test]
    fn only_absolute_existing_directories_of_this_os_are_usable() {
        let temp = tempfile::tempdir().unwrap();
        assert!(usable_directory(temp.path().to_str().unwrap()));
        assert!(!usable_directory(
            temp.path().join("missing").to_str().unwrap()
        ));
        assert!(!usable_directory("relative/manga"));
        #[cfg(unix)]
        assert!(!usable_directory(r"C:\lakomics\2군"));
        #[cfg(windows)]
        assert!(!usable_directory("/home/laku/manga"));
    }
}

pub(crate) fn workload(path: &Path) -> Result<crate::workload::Settings, LibraryError> {
    Ok(read_file(path)?.workload)
}
pub(crate) fn set_workload(path: &Path, settings: crate::workload::Settings) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    file.workload = settings;
    write_file(path, &file)
}
pub(crate) fn new_ingests(path: &Path, library: &str) -> Result<BTreeSet<String>, LibraryError> {
    Ok(read_file(path)?.new_ingests.remove(library).unwrap_or_default())
}
pub(crate) fn set_new_ingests(path: &Path, library: &str, ids: BTreeSet<String>) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    file.new_ingests.insert(library.to_owned(), ids);
    write_file(path, &file)
}

#[cfg(test)]
mod workload_tests {
    use super::*;
    #[test]
    fn workload_settings_and_new_ingests_survive_other_setting_writes() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("machine.json");
        let settings = crate::workload::Settings { lightweight: true, auto_enter_minutes: Some(15), close_to_tray: false };
        set_workload(&path, settings.clone()).unwrap();
        set_new_ingests(&path, "library", BTreeSet::from(["asset".into()])).unwrap();
        set_entry(&path, "library", LibraryEntry { manga_root: None }).unwrap();
        assert_eq!(workload(&path).unwrap(), settings);
        assert_eq!(new_ingests(&path, "library").unwrap(), BTreeSet::from(["asset".into()]));
        fs::write(&path, b"invalid").unwrap();
        assert!(set_workload(&path, crate::workload::Settings::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid");
    }
}
