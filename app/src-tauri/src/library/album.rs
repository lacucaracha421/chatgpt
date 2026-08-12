use rusqlite::{params, Connection};

use super::{
    error::LibraryError,
    folder_appearance,
    models::{AlbumEntry, CreateAlbum},
    Library,
};

impl Library {
    pub fn create_album(&self, request: CreateAlbum) -> Result<AlbumEntry, LibraryError> {
        let name = normalized_name(request.name)?;
        let connection = self.connection()?;
        if let Some(parent_id) = request.parent_id.as_deref() {
            require_album(&connection, parent_id)?;
        }
        let entry = AlbumEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            parent_id: request.parent_id,
            icon_key: None,
            color_key: None,
        };
        connection
            .execute(
                "INSERT INTO albums (id, name, parent_id, icon_key, color_key, created_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4)",
                params![
                    entry.id,
                    entry.name,
                    entry.parent_id,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(map_duplicate_name)?;
        Ok(entry)
    }

    pub fn list_albums(&self) -> Result<Vec<AlbumEntry>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, parent_id, icon_key, color_key
             FROM albums
             ORDER BY parent_id, name COLLATE NOCASE, id",
        )?;
        let entries = statement
            .query_map([], album_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn rename_album(&self, id: &str, name: &str) -> Result<(), LibraryError> {
        let name = normalized_name(name.to_owned())?;
        let connection = self.connection()?;
        let changed = connection
            .execute("UPDATE albums SET name = ?1 WHERE id = ?2", params![name, id])
            .map_err(map_duplicate_name)?;
        if changed == 0 {
            return Err(LibraryError::AlbumNotFound);
        }
        Ok(())
    }

    pub fn move_album(&self, id: &str, parent_id: Option<&str>) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_album(&transaction, id)?;
        if let Some(parent_id) = parent_id {
            require_album(&transaction, parent_id)?;
            let creates_cycle: bool = transaction.query_row(
                "WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM albums WHERE id = ?1
                    UNION ALL
                    SELECT child.id FROM albums AS child
                    JOIN descendants ON child.parent_id = descendants.id
                 )
                 SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
                params![id, parent_id],
                |row| row.get(0),
            )?;
            if creates_cycle {
                return Err(LibraryError::AlbumCycle);
            }
        }
        transaction
            .execute(
                "UPDATE albums SET parent_id = ?1 WHERE id = ?2",
                params![parent_id, id],
            )
            .map_err(map_duplicate_name)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_album(&self, id: &str) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        require_album(&transaction, id)?;
        let has_children: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM albums WHERE parent_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if has_children {
            return Err(LibraryError::AlbumHasChildren);
        }
        transaction.execute("DELETE FROM albums WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn update_album_appearance(
        &self,
        id: &str,
        icon_key: Option<&str>,
        color_key: Option<&str>,
    ) -> Result<(), LibraryError> {
        if !folder_appearance::validate(icon_key, color_key) {
            return Err(LibraryError::InvalidAlbumAppearance);
        }
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE albums SET icon_key = ?1, color_key = ?2 WHERE id = ?3",
            params![icon_key, color_key, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::AlbumNotFound);
        }
        Ok(())
    }
}

fn normalized_name(name: String) -> Result<String, LibraryError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(LibraryError::EmptyAlbumName);
    }
    Ok(name)
}

fn require_album(connection: &Connection, id: &str) -> Result<(), LibraryError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(LibraryError::AlbumNotFound)
    }
}

fn album_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumEntry> {
    Ok(AlbumEntry {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        icon_key: row.get(3)?,
        color_key: row.get(4)?,
    })
}

fn map_duplicate_name(error: rusqlite::Error) -> LibraryError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            LibraryError::DuplicateAlbumName
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use crate::library::{
        error::LibraryError,
        models::{AlbumEntry, CreateAlbum},
        Library,
    };

    #[test]
    fn creates_lists_and_renames_nested_albums() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_album(CreateAlbum {
                name: "게임 표지".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();

        library.rename_album(&child.id, "  대표 표지  ").unwrap();

        assert_eq!(
            library.list_albums().unwrap(),
            vec![
                root,
                AlbumEntry {
                    id: child.id,
                    name: "대표 표지".into(),
                    parent_id: Some(child.parent_id.unwrap()),
                    icon_key: None,
                    color_key: None,
                },
            ]
        );
    }

    #[test]
    fn moves_an_album_but_rejects_self_and_descendant_cycles() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_album(CreateAlbum {
                name: "게임 표지".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let other_root = library
            .create_album(CreateAlbum {
                name: "참고".into(),
                parent_id: None,
            })
            .unwrap();

        library
            .move_album(&child.id, Some(&other_root.id))
            .unwrap();
        assert_eq!(
            library
                .list_albums()
                .unwrap()
                .into_iter()
                .find(|entry| entry.id == child.id)
                .unwrap()
                .parent_id,
            Some(other_root.id.clone())
        );

        assert!(matches!(
            library.move_album(&other_root.id, Some(&child.id)),
            Err(LibraryError::AlbumCycle)
        ));
        assert!(matches!(
            library.move_album(&other_root.id, Some(&other_root.id)),
            Err(LibraryError::AlbumCycle)
        ));
        assert_eq!(
            library
                .list_albums()
                .unwrap()
                .into_iter()
                .find(|entry| entry.id == other_root.id)
                .unwrap()
                .parent_id,
            None
        );
    }

    #[test]
    fn blocks_delete_with_children_and_deletes_a_leaf() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_album(CreateAlbum {
                name: "게임 표지".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();

        assert!(matches!(
            library.delete_album(&root.id),
            Err(LibraryError::AlbumHasChildren)
        ));
        library.delete_album(&child.id).unwrap();

        assert_eq!(library.list_albums().unwrap(), vec![root]);
    }

    #[test]
    fn album_appearance_uses_the_shared_catalog_and_rejects_unknown_keys() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let album = library
            .create_album(CreateAlbum {
                name: "표지".into(),
                parent_id: None,
            })
            .unwrap();

        library
            .update_album_appearance(&album.id, Some("photo"), Some("pink"))
            .unwrap();
        let changed = library.list_albums().unwrap().pop().unwrap();
        assert_eq!(changed.icon_key.as_deref(), Some("photo"));
        assert_eq!(changed.color_key.as_deref(), Some("pink"));

        assert!(matches!(
            library.update_album_appearance(
                &album.id,
                Some("uploaded-svg"),
                Some("#ffffff")
            ),
            Err(LibraryError::InvalidAlbumAppearance)
        ));
        let unchanged = library.list_albums().unwrap().pop().unwrap();
        assert_eq!(unchanged.icon_key.as_deref(), Some("photo"));
        assert_eq!(unchanged.color_key.as_deref(), Some("pink"));
    }

    #[test]
    fn rejects_duplicate_sibling_names_case_insensitively() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .create_album(CreateAlbum {
                name: "Covers".into(),
                parent_id: None,
            })
            .unwrap();

        assert!(matches!(
            library.create_album(CreateAlbum {
                name: "covers".into(),
                parent_id: None,
            }),
            Err(LibraryError::DuplicateAlbumName)
        ));
        assert_eq!(library.list_albums().unwrap().len(), 1);
    }
}
