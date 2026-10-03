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
    #[serde(default, deserialize_with = "present_value", skip_serializing_if = "Option::is_none")]
    performance: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    new_ingests: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    libraries: BTreeMap<String, LibraryEntry>,
    #[serde(default)]
    receive_only_holds: BTreeMap<String, BTreeMap<String, bool>>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

/// A present entry is authoritative for this machine; `manga_root: None` means
/// the folder was explicitly cleared here and the shared value must not return.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryEntry {
    #[serde(default)]
    pub(crate) manga_root: Option<String>,
    #[serde(default)]
    pub(crate) manga_root_identity: Option<super::manga_root_guard::RootIdentity>,
    #[serde(default)]
    pub(crate) auto_tag_inbox: super::auto_tag_inbox::Settings,
    #[serde(flatten)]
    pub(crate) extra: BTreeMap<String, serde_json::Value>,
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
    let mut value = value;
    if let Some(previous) = file.libraries.get(library_id) {
        value.auto_tag_inbox = previous.auto_tag_inbox.clone();
        value.extra = previous.extra.clone();
    }
    file.libraries.insert(library_id.to_owned(), value);
    write_file(path, &file)
}

pub(crate) fn receive_only_hold(path: &Path, library: &str, endpoint: &str) -> bool {
    read_file(path).map_or(true, |file| {
        file.receive_only_holds.get(library)
            .and_then(|holds| holds.get(endpoint)).copied().unwrap_or(false)
    })
}

pub(crate) fn set_receive_only_hold(
    path: &Path, library: &str, endpoint: &str, held: bool,
) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    file.receive_only_holds.entry(library.to_owned()).or_default()
        .insert(endpoint.to_owned(), held);
    write_file(path, &file)
}

/// Update the scan identity without replacing concurrently edited machine settings.
pub(crate) fn set_manga_root_identity(
    path: &Path,
    library_id: &str,
    identity: super::manga_root_guard::RootIdentity,
) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    let entry = file.libraries.entry(library_id.to_owned()).or_default();
    entry.manga_root_identity = Some(identity);
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
    fn receive_only_hold_and_unknown_fields_survive_machine_setting_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library-machine.json");
        let original = serde_json::json!({
            "receiveOnlyHolds": {"lib-a": {"https://cloud.invalid/": true}},
            "futureSetting": {"value": 7},
            "libraries": {"lib-a": {"mangaRoot": null, "futureLibrarySetting": true}}
        });
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        set_entry(&path, "lib-a", LibraryEntry::default()).unwrap();
        set_workload(&path, crate::workload::Settings::default()).unwrap();
        set_new_ingests(&path, "lib-a", BTreeSet::from(["asset".into()])).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["receiveOnlyHolds"], original["receiveOnlyHolds"]);
        assert_eq!(saved["futureSetting"], original["futureSetting"]);
        assert_eq!(saved["libraries"]["lib-a"]["futureLibrarySetting"], true);
    }

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
                ..Default::default()
            },
        )
        .unwrap();
        set_entry(&path, "lib-b", LibraryEntry { manga_root: None, ..Default::default() }).unwrap();
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
            Some(LibraryEntry { manga_root: None, ..Default::default() })
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
        set_entry(&path, "library", LibraryEntry { manga_root: None, ..Default::default() }).unwrap();
        assert_eq!(workload(&path).unwrap(), settings);
        assert_eq!(new_ingests(&path, "library").unwrap(), BTreeSet::from(["asset".into()]));
        fs::write(&path, b"invalid").unwrap();
        assert!(set_workload(&path, crate::workload::Settings::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid");
    }
}

/// Update only the inbox under the same file lock as all other machine settings.
pub(crate) fn set_auto_tag_inbox(
    path: &Path,
    library_id: &str,
    value: super::auto_tag_inbox::Settings,
) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    file.libraries.entry(library_id.to_owned()).or_default().auto_tag_inbox = value;
    write_file(path, &file)
}

/// Unknown versions/profiles remain opaque on unrelated writes.
pub(crate) fn performance(path: &Path) -> Result<crate::performance::Profile, LibraryError> {
    let value = read_file(path)?.performance;
    Ok(match value.as_ref() {
        Some(value) if value.get("version").and_then(serde_json::Value::as_u64) == Some(1)
            && value.get("profile").and_then(serde_json::Value::as_str) == Some("main") => crate::performance::Profile::Main,
        _ => crate::performance::Profile::Laptop,
    })
}
pub(crate) fn set_performance(path: &Path, profile: crate::performance::Profile) -> Result<(), LibraryError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read_file(path)?;
    file.performance = Some(serde_json::json!({ "version": 1, "profile": profile }));
    write_file(path, &file)
}

#[cfg(test)]
mod performance_tests {
    use super::*;
    use crate::performance::Profile;

    #[test]
    fn missing_and_unknown_profiles_are_conservative_without_startup_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("machine.json");
        assert_eq!(performance(&path).unwrap(), Profile::Laptop);
        assert!(!path.exists());
        for value in [serde_json::json!({}), serde_json::json!({"performance": null}),
            serde_json::json!({"performance": {"version": 2, "profile": "main", "future": true}}),
            serde_json::json!({"performance": {"version": 1, "profile": "future"}}),
            serde_json::json!({"performance": {"profile": "main"}}),
            serde_json::json!({"performance": "unknown"})] {
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert_eq!(performance(&path).unwrap(), Profile::Laptop);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            set_workload(&path, crate::workload::Settings::default()).unwrap();
            set_entry(&path, "a", LibraryEntry::default()).unwrap();
            set_new_ingests(&path, "a", BTreeSet::new()).unwrap();
            set_auto_tag_inbox(&path, "a", Default::default()).unwrap();
            let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(saved.get("performance"), value.get("performance"));
        }
    }

    #[test]
    fn performance_is_per_machine_and_preserves_saving_preferences_and_library_entries() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first/machine.json");
        let second = temp.path().join("second/machine.json");
        let workload_settings = crate::workload::Settings { lightweight: true, auto_enter_minutes: Some(15), close_to_tray: false };
        for path in [&first, &second] {
            set_entry(path, "same-library", LibraryEntry { manga_root: Some("/local/manga".into()), ..Default::default() }).unwrap();
            set_entry(path, "another-library", LibraryEntry::default()).unwrap();
            set_workload(path, workload_settings.clone()).unwrap();
        }
        set_performance(&first, Profile::Main).unwrap();
        assert_eq!(performance(&first).unwrap(), Profile::Main);
        assert_eq!(performance(&second).unwrap(), Profile::Laptop);
        assert_eq!(workload(&first).unwrap(), workload_settings);
        assert_eq!(entry(&first, "same-library").unwrap(), entry(&second, "same-library").unwrap());
        assert_eq!(entry(&first, "another-library").unwrap(), entry(&second, "another-library").unwrap());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&first).unwrap()).unwrap();
        assert_eq!(saved["performance"], serde_json::json!({"version": 1, "profile": "main"}));
        assert!(saved["libraries"]["same-library"].get("performance").is_none());
        fs::write(&first, b"invalid").unwrap();
        assert!(set_performance(&first, Profile::Laptop).is_err());
        assert_eq!(fs::read(&first).unwrap(), b"invalid");
    }
}
