//! User folders in the encrypted Private Vault (ADR-0039 2026-10-07 amendment).
//!
//! Folders live only inside the encrypted index (`VaultIndex::folders`), like titles: their
//! names never reach `vault.json`, the main library database or the cloud. They nest through
//! `parent_id`, and an item belongs to at most one folder (`VaultItem::folder_id`), matching
//! Assets folders (ADR-0013/0030). A folder lists its own items and its descendants' items.
//!
//! Every change follows the title pattern: write lock, `Session::writable`, change the
//! in-memory index, save, and put the previous index back if the save fails.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use uuid::Uuid;

use super::super::encrypted_store::{VaultFolder, VaultIndex};
use crate::library::{error::LibraryError, models::EncryptedVaultFolder, Library};

const MAX_FOLDER_NAME_CHARS: usize = 100;

fn normalized_folder_name(name: &str) -> Result<String, LibraryError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_FOLDER_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(LibraryError::InvalidEncryptedVaultFolderName);
    }
    Ok(name.to_owned())
}

fn folder_exists(index: &VaultIndex, folder_id: &str) -> bool {
    index.folders.iter().any(|folder| folder.id == folder_id)
}

fn ensure_unique_name(
    index: &VaultIndex,
    parent_id: Option<&str>,
    name: &str,
    except: Option<&str>,
) -> Result<(), LibraryError> {
    let wanted = name.to_lowercase();
    let clash = index.folders.iter().any(|folder| {
        folder.parent_id.as_deref() == parent_id
            && Some(folder.id.as_str()) != except
            && folder.name.to_lowercase() == wanted
    });
    if clash {
        return Err(LibraryError::DuplicateEncryptedVaultFolderName);
    }
    Ok(())
}

/// The folder and every folder below it.
pub(super) fn folder_with_descendants<'a>(
    index: &'a VaultIndex,
    folder_id: &'a str,
) -> HashSet<&'a str> {
    let mut found = HashSet::from([folder_id]);
    loop {
        let before = found.len();
        for folder in &index.folders {
            if folder
                .parent_id
                .as_deref()
                .is_some_and(|parent| found.contains(parent))
            {
                found.insert(folder.id.as_str());
            }
        }
        if found.len() == before {
            return found;
        }
    }
}

fn create_folder(
    index: &mut VaultIndex,
    name: &str,
    parent_id: Option<&str>,
) -> Result<VaultFolder, LibraryError> {
    let name = normalized_folder_name(name)?;
    if parent_id.is_some_and(|parent| !folder_exists(index, parent)) {
        return Err(LibraryError::EncryptedVaultFolderNotFound);
    }
    ensure_unique_name(index, parent_id, &name, None)?;
    let folder = VaultFolder {
        id: Uuid::new_v4().to_string(),
        name,
        parent_id: parent_id.map(str::to_owned),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    index.folders.push(folder.clone());
    Ok(folder)
}

fn rename_folder(index: &mut VaultIndex, folder_id: &str, name: &str) -> Result<(), LibraryError> {
    let name = normalized_folder_name(name)?;
    let parent_id = index
        .folders
        .iter()
        .find(|folder| folder.id == folder_id)
        .ok_or(LibraryError::EncryptedVaultFolderNotFound)?
        .parent_id
        .clone();
    ensure_unique_name(index, parent_id.as_deref(), &name, Some(folder_id))?;
    if let Some(folder) = index
        .folders
        .iter_mut()
        .find(|folder| folder.id == folder_id)
    {
        folder.name = name;
    }
    Ok(())
}

fn move_folder(
    index: &mut VaultIndex,
    folder_id: &str,
    parent_id: Option<&str>,
) -> Result<(), LibraryError> {
    let name = index
        .folders
        .iter()
        .find(|folder| folder.id == folder_id)
        .ok_or(LibraryError::EncryptedVaultFolderNotFound)?
        .name
        .clone();
    if let Some(parent) = parent_id {
        if !folder_exists(index, parent) {
            return Err(LibraryError::EncryptedVaultFolderNotFound);
        }
        if folder_with_descendants(index, folder_id).contains(parent) {
            return Err(LibraryError::EncryptedVaultFolderCycle);
        }
    }
    ensure_unique_name(index, parent_id, &name, Some(folder_id))?;
    if let Some(folder) = index
        .folders
        .iter_mut()
        .find(|folder| folder.id == folder_id)
    {
        folder.parent_id = parent_id.map(str::to_owned);
    }
    Ok(())
}

/// Refused while the folder has child folders. Its items move to its parent folder (or
/// become unfiled), like deleting an Assets folder.
fn delete_folder(index: &mut VaultIndex, folder_id: &str) -> Result<(), LibraryError> {
    let position = index
        .folders
        .iter()
        .position(|folder| folder.id == folder_id)
        .ok_or(LibraryError::EncryptedVaultFolderNotFound)?;
    if index
        .folders
        .iter()
        .any(|folder| folder.parent_id.as_deref() == Some(folder_id))
    {
        return Err(LibraryError::EncryptedVaultFolderHasChildren);
    }
    let removed = index.folders.remove(position);
    for item in &mut index.items {
        if item.folder_id.as_deref() == Some(folder_id) {
            item.folder_id.clone_from(&removed.parent_id);
        }
    }
    Ok(())
}

/// Puts the given items in `folder_id` (`None`: unfiled). Returns how many items changed;
/// unknown ids are ignored.
fn move_items(
    index: &mut VaultIndex,
    item_ids: &[String],
    folder_id: Option<&str>,
) -> Result<u64, LibraryError> {
    if folder_id.is_some_and(|folder| !folder_exists(index, folder)) {
        return Err(LibraryError::EncryptedVaultFolderNotFound);
    }
    let wanted = item_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut changed = 0;
    for item in index
        .items
        .iter_mut()
        .filter(|item| wanted.contains(item.id.as_str()))
    {
        if item.folder_id.as_deref() != folder_id {
            item.folder_id = folder_id.map(str::to_owned);
            changed += 1;
        }
    }
    Ok(changed)
}

fn summaries(index: &VaultIndex) -> Vec<EncryptedVaultFolder> {
    let mut direct = HashMap::<&str, u64>::new();
    for item in index.items.iter().filter(|item| item.trashed_at.is_none()) {
        if let Some(folder) = item.folder_id.as_deref() {
            *direct.entry(folder).or_default() += 1;
        }
    }
    index
        .folders
        .iter()
        .map(|folder| {
            let total = folder_with_descendants(index, &folder.id)
                .into_iter()
                .map(|id| direct.get(id).copied().unwrap_or(0))
                .sum();
            EncryptedVaultFolder {
                id: folder.id.clone(),
                name: folder.name.clone(),
                parent_id: folder.parent_id.clone(),
                created_at: folder.created_at.clone(),
                item_count: direct.get(folder.id.as_str()).copied().unwrap_or(0),
                total_item_count: total,
            }
        })
        .collect()
}

fn summary_of(index: &VaultIndex, folder_id: &str) -> Option<EncryptedVaultFolder> {
    summaries(index)
        .into_iter()
        .find(|folder| folder.id == folder_id)
}

impl Library {
    /// The vault's folders with direct and total (with descendants) item counts; trashed
    /// items are not counted.
    pub fn list_encrypted_vault_folders(&self) -> Result<Vec<EncryptedVaultFolder>, LibraryError> {
        let state = self.encrypted_vault.state();
        let session = state
            .session
            .as_ref()
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        Ok(summaries(&session.index))
    }

    pub fn create_encrypted_vault_folder(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<EncryptedVaultFolder, LibraryError> {
        let id = self.change_encrypted_vault_folders(|index| {
            create_folder(index, name, parent_id).map(|folder| folder.id)
        })?;
        let state = self.encrypted_vault.state();
        let session = state
            .session
            .as_ref()
            .ok_or(LibraryError::EncryptedVaultLocked)?;
        summary_of(&session.index, &id).ok_or(LibraryError::EncryptedVaultFolderNotFound)
    }

    pub fn rename_encrypted_vault_folder(
        &self,
        folder_id: &str,
        name: &str,
    ) -> Result<(), LibraryError> {
        self.change_encrypted_vault_folders(|index| rename_folder(index, folder_id, name))
    }

    pub fn move_encrypted_vault_folder(
        &self,
        folder_id: &str,
        parent_id: Option<&str>,
    ) -> Result<(), LibraryError> {
        self.change_encrypted_vault_folders(|index| move_folder(index, folder_id, parent_id))
    }

    pub fn delete_encrypted_vault_folder(&self, folder_id: &str) -> Result<(), LibraryError> {
        self.change_encrypted_vault_folders(|index| delete_folder(index, folder_id))
    }

    /// Moves items (trashed ones too, so a restore returns them to their folder) into a
    /// folder, or out of every folder with `None`. Returns how many items changed.
    pub fn move_encrypted_vault_items_to_folder(
        &self,
        item_ids: &[String],
        folder_id: Option<&str>,
    ) -> Result<u64, LibraryError> {
        self.change_encrypted_vault_folders(|index| move_items(index, item_ids, folder_id))
    }

    /// Applies `change` to the session index and saves it; on a failed save the previous
    /// folders and item folders are put back.
    fn change_encrypted_vault_folders<T>(
        &self,
        change: impl FnOnce(&mut VaultIndex) -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let _writes = self.encrypted_vault.writes();
        let (vault, generation, previous, result) = {
            let mut state = self.encrypted_vault.state();
            let session = state
                .session
                .as_mut()
                .ok_or(LibraryError::EncryptedVaultLocked)?;
            session.writable()?;
            let previous = (
                session.index.folders.clone(),
                session
                    .index
                    .items
                    .iter()
                    .map(|item| (item.id.clone(), item.folder_id.clone()))
                    .collect::<HashMap<_, _>>(),
            );
            let result = change(&mut session.index)?;
            (
                Arc::clone(&session.vault),
                session.generation,
                previous,
                result,
            )
        };
        if let Err(error) = self.persist_encrypted_index(&vault, generation) {
            let mut state = self.encrypted_vault.state();
            if let Some(session) = state.session_matching(generation) {
                let (folders, item_folders) = previous;
                session.index.folders = folders;
                for item in &mut session.index.items {
                    if let Some(folder) = item_folders.get(&item.id) {
                        item.folder_id.clone_from(folder);
                    }
                }
            }
            return Err(error);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::super::super::encrypted_store::{VaultIndex, VaultItem, VaultItemKind};
    use super::{
        create_folder, delete_folder, folder_with_descendants, move_folder, move_items,
        rename_folder, summaries,
    };
    use crate::library::{
        error::LibraryError,
        models::{EncryptedVaultQuery, EncryptedVaultSecretInput},
        Library,
    };

    fn index_with_items(count: usize) -> VaultIndex {
        VaultIndex {
            items: (0..count)
                .map(|index| VaultItem {
                    id: format!("item-{index}"),
                    object_id: format!("{index:032x}"),
                    original_relative_path: format!("{index}.png"),
                    original_file_name: format!("{index}.png"),
                    kind: VaultItemKind::Image,
                    byte_size: 1,
                    width: None,
                    height: None,
                    imported_at: "2026-10-07T00:00:00Z".into(),
                    title: None,
                    thumbnail_object_id: None,
                    poster_object_id: None,
                    trashed_at: None,
                    content_sha256: None,
                    thumbnail_sha256: None,
                    folder_id: None,
                    duration_ms: None,
                })
                .collect(),
            ..VaultIndex::default()
        }
    }

    fn item_ids(index: &VaultIndex) -> Vec<String> {
        index.items.iter().map(|item| item.id.clone()).collect()
    }

    #[test]
    fn folders_nest_validate_names_and_refuse_cycles() {
        let mut index = index_with_items(0);
        let parent = create_folder(&mut index, "  여행  ", None).unwrap();
        assert_eq!(parent.name, "여행");
        let child = create_folder(&mut index, "바다", Some(&parent.id)).unwrap();
        assert!(matches!(
            create_folder(&mut index, "여행", None),
            Err(LibraryError::DuplicateEncryptedVaultFolderName)
        ));
        create_folder(&mut index, "바다", None).unwrap();
        for bad in ["", "   ", "a\nb", &"가".repeat(101)] {
            assert!(matches!(
                create_folder(&mut index, bad, None),
                Err(LibraryError::InvalidEncryptedVaultFolderName)
            ));
        }
        assert!(matches!(
            create_folder(&mut index, "x", Some("missing")),
            Err(LibraryError::EncryptedVaultFolderNotFound)
        ));
        assert!(matches!(
            move_folder(&mut index, &parent.id, Some(&child.id)),
            Err(LibraryError::EncryptedVaultFolderCycle)
        ));
        assert!(matches!(
            move_folder(&mut index, &child.id, None),
            Err(LibraryError::DuplicateEncryptedVaultFolderName)
        ));
        rename_folder(&mut index, &child.id, "해변").unwrap();
        move_folder(&mut index, &child.id, None).unwrap();
        assert_eq!(folder_with_descendants(&index, &parent.id).len(), 1);
        assert!(matches!(
            rename_folder(&mut index, "missing", "x"),
            Err(LibraryError::EncryptedVaultFolderNotFound)
        ));
    }

    #[test]
    fn delete_moves_items_to_the_parent_and_refuses_folders_with_children() {
        let mut index = index_with_items(3);
        let ids = item_ids(&index);
        let parent = create_folder(&mut index, "부모", None).unwrap();
        let child = create_folder(&mut index, "자식", Some(&parent.id)).unwrap();
        assert_eq!(
            move_items(&mut index, &ids[..2], Some(&child.id)).unwrap(),
            2
        );
        assert_eq!(
            move_items(&mut index, &ids[..2], Some(&child.id)).unwrap(),
            0
        );
        move_items(&mut index, &ids[2..], Some(&parent.id)).unwrap();
        index.items[2].trashed_at = Some("2026-10-07T00:00:00Z".into());
        let counts = summaries(&index)
            .into_iter()
            .map(|folder| (folder.name, folder.item_count, folder.total_item_count))
            .collect::<Vec<_>>();
        assert_eq!(counts, [("부모".into(), 0, 2), ("자식".into(), 2, 2)]);
        assert!(matches!(
            delete_folder(&mut index, &parent.id),
            Err(LibraryError::EncryptedVaultFolderHasChildren)
        ));
        delete_folder(&mut index, &child.id).unwrap();
        assert!(index
            .items
            .iter()
            .all(|item| item.folder_id.as_deref() == Some(parent.id.as_str())));
        delete_folder(&mut index, &parent.id).unwrap();
        assert!(index.items.iter().all(|item| item.folder_id.is_none()));
        assert!(matches!(
            move_items(&mut index, &ids, Some("missing")),
            Err(LibraryError::EncryptedVaultFolderNotFound)
        ));
    }

    const PASSWORD: &str = "correct horse";

    fn query(folder_id: Option<String>, unfiled_only: bool) -> EncryptedVaultQuery {
        EncryptedVaultQuery {
            kind: None,
            offset: 0,
            limit: 100,
            trashed: false,
            folder_id,
            unfiled_only,
        }
    }

    fn names(library: &Library, query: EncryptedVaultQuery) -> Vec<String> {
        let mut names = library
            .list_encrypted_vault_items(query)
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.original_file_name)
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn write_png(path: &Path, width: u32) {
        image::RgbImage::from_pixel(width, 8, image::Rgb([200, 40, 90]))
            .save(path)
            .unwrap();
    }

    #[test]
    fn folders_survive_lock_and_filter_the_gallery() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        library
            .create_encrypted_vault(&vault, PASSWORD, false)
            .unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        for (index, name) in ["a.png", "b.png", "c.png"].into_iter().enumerate() {
            write_png(&source.join(name), 8 + index as u32);
        }
        library
            .import_into_encrypted_vault(&source, &mut |_| {})
            .unwrap();
        let id_of = |name: &str| {
            library
                .list_encrypted_vault_items(query(None, false))
                .unwrap()
                .items
                .into_iter()
                .find(|item| item.original_file_name == name)
                .unwrap()
                .id
        };
        let parent = library.create_encrypted_vault_folder("부모", None).unwrap();
        let child = library
            .create_encrypted_vault_folder("자식", Some(&parent.id))
            .unwrap();
        assert_eq!(
            library
                .move_encrypted_vault_items_to_folder(&[id_of("a.png")], Some(&child.id))
                .unwrap(),
            1
        );
        library
            .move_encrypted_vault_items_to_folder(&[id_of("b.png")], Some(&parent.id))
            .unwrap();

        library.lock_encrypted_vault();
        library
            .unlock_encrypted_vault(&EncryptedVaultSecretInput::Password(PASSWORD.into()), false)
            .unwrap();

        assert_eq!(
            names(&library, query(Some(parent.id.clone()), false)),
            ["a.png", "b.png"]
        );
        assert_eq!(
            names(&library, query(Some(child.id.clone()), false)),
            ["a.png"]
        );
        assert_eq!(names(&library, query(None, true)), ["c.png"]);
        let listed = library
            .list_encrypted_vault_items(query(Some(child.id.clone()), false))
            .unwrap();
        assert_eq!(
            listed.items[0].folder_id.as_deref(),
            Some(child.id.as_str())
        );
        let folders = library.list_encrypted_vault_folders().unwrap();
        assert_eq!(folders.len(), 2);

        library.delete_encrypted_vault_folder(&child.id).unwrap();
        library
            .rename_encrypted_vault_folder(&parent.id, "새 이름")
            .unwrap();
        assert_eq!(
            names(&library, query(Some(parent.id.clone()), false)),
            ["a.png", "b.png"]
        );
        library.delete_encrypted_vault_folder(&parent.id).unwrap();
        assert_eq!(
            names(&library, query(None, true)),
            ["a.png", "b.png", "c.png"]
        );
        assert!(library.list_encrypted_vault_folders().unwrap().is_empty());
    }

    #[test]
    fn folder_commands_need_an_unlocked_vault() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        assert!(matches!(
            library.list_encrypted_vault_folders(),
            Err(LibraryError::EncryptedVaultLocked)
        ));
        assert!(matches!(
            library.create_encrypted_vault_folder("x", None),
            Err(LibraryError::EncryptedVaultLocked)
        ));
    }
}
