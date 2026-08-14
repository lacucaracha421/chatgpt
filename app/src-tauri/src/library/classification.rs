use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    error::LibraryError,
    folder_appearance,
    models::{
        AssetClassificationPatch, ClassificationEntry, ClassificationKind, CreateClassification,
        SetAssetClassification,
    },
    validated_asset_ids, Library,
};

impl Library {
    pub fn create_classification(
        &self,
        request: CreateClassification,
    ) -> Result<ClassificationEntry, LibraryError> {
        let name = normalized_name(request.name)?;
        let connection = self.connection()?;
        let parent = find_parent(&connection, request.parent_id.as_deref())?;
        validate_parent(&request.kind, parent.as_ref())?;

        let entry = ClassificationEntry {
            id: uuid::Uuid::new_v4().to_string(),
            kind: request.kind,
            name,
            parent_id: request.parent_id,
            icon_key: None,
            color_key: None,
        };
        connection
            .execute(
                "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    entry.id,
                    kind_name(&entry.kind),
                    entry.name,
                    entry.parent_id,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .map_err(map_duplicate_name)?;
        Ok(entry)
    }

    pub fn move_classification(
        &self,
        id: &str,
        parent_id: Option<&str>,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let entry =
            find_classification(&transaction, id)?.ok_or(LibraryError::ClassificationNotFound)?;
        let parent = find_parent(&transaction, parent_id)?;
        let next_kind = match (&entry.kind, parent.as_ref()) {
            (ClassificationKind::Root, Some(_)) => ClassificationKind::Tag,
            (ClassificationKind::Tag, None) => ClassificationKind::Root,
            _ => entry.kind.clone(),
        };
        validate_parent(&next_kind, parent.as_ref())?;

        if let Some(parent_id) = parent_id {
            let is_descendant: bool = transaction.query_row(
                "WITH RECURSIVE descendants(id) AS (
                     SELECT id FROM classification_entries WHERE id = ?1
                     UNION ALL
                     SELECT child.id
                     FROM classification_entries AS child
                     JOIN descendants ON child.parent_id = descendants.id
                 )
                 SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
                params![id, parent_id],
                |row| row.get(0),
            )?;
            if is_descendant {
                return Err(LibraryError::ClassificationCycle);
            }
        }

        transaction
            .execute(
                "UPDATE classification_entries SET kind = ?1, parent_id = ?2 WHERE id = ?3",
                params![kind_name(&next_kind), parent_id, id],
            )
            .map_err(map_duplicate_name)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn rename_classification(&self, id: &str, name: &str) -> Result<(), LibraryError> {
        let name = normalized_name(name.to_owned())?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE classification_entries SET name = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(map_duplicate_name)?;
        if changed == 0 {
            return Err(LibraryError::ClassificationNotFound);
        }
        Ok(())
    }

    pub fn update_classification_appearance(
        &self,
        id: &str,
        icon_key: Option<&str>,
        color_key: Option<&str>,
    ) -> Result<(), LibraryError> {
        if !folder_appearance::validate(icon_key, color_key) {
            return Err(LibraryError::InvalidClassificationAppearance);
        }
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE classification_entries
             SET icon_key = ?1, color_key = ?2
             WHERE id = ?3",
            params![icon_key, color_key, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::ClassificationNotFound);
        }
        Ok(())
    }

    pub fn list_classifications(&self) -> Result<Vec<ClassificationEntry>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, name, parent_id, icon_key, color_key
             FROM classification_entries
             ORDER BY parent_id, name COLLATE NOCASE, id",
        )?;
        read_entries(&mut statement, [])
    }

    pub fn delete_classification(&self, id: &str) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let entry =
            find_classification(&transaction, id)?.ok_or(LibraryError::ClassificationNotFound)?;
        let has_children: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE parent_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if has_children {
            return Err(LibraryError::ClassificationHasChildren);
        }

        if let Some(parent_id) = entry.parent_id {
            transaction.execute(
                "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id)
                 SELECT asset_id, ?2 FROM asset_classifications WHERE classification_id = ?1",
                params![id, parent_id],
            )?;
        }
        transaction.execute(
            "DELETE FROM asset_classifications WHERE classification_id = ?1",
            [id],
        )?;
        transaction.execute("DELETE FROM classification_entries WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn patch_asset_classifications(
        &self,
        patch: AssetClassificationPatch,
    ) -> Result<(), LibraryError> {
        self.change_asset_classifications(
            &patch.asset_ids,
            &patch.add_classification_ids,
            &patch.remove_classification_ids,
        )
    }

    pub fn set_asset_classification(
        &self,
        request: SetAssetClassification,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_ids = validated_asset_ids(&transaction, &request.asset_ids)?;
        if let Some(classification_id) = request.classification_id.as_deref() {
            if find_classification(&transaction, classification_id)?.is_none() {
                return Err(LibraryError::ClassificationNotFound);
            }
        }
        for asset_id in asset_ids {
            transaction.execute(
                "DELETE FROM asset_classifications WHERE asset_id = ?1",
                [asset_id],
            )?;
            if let Some(classification_id) = request.classification_id.as_deref() {
                transaction.execute(
                    "INSERT INTO asset_classifications (asset_id, classification_id)
                     VALUES (?1, ?2)",
                    params![asset_id, classification_id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn get_asset_classifications(
        &self,
        asset_id: &str,
    ) -> Result<Vec<ClassificationEntry>, LibraryError> {
        let connection = self.connection()?;
        classifications_for_asset(&connection, asset_id)
    }

    fn change_asset_classifications(
        &self,
        asset_ids: &[String],
        add_ids: &[String],
        remove_ids: &[String],
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_ids = validated_asset_ids(&transaction, asset_ids)?;
        let add_ids: BTreeSet<_> = add_ids.iter().map(String::as_str).collect();
        let remove_ids: BTreeSet<_> = remove_ids.iter().map(String::as_str).collect();
        for classification_id in add_ids.iter().chain(remove_ids.iter()) {
            if find_classification(&transaction, classification_id)?.is_none() {
                return Err(LibraryError::ClassificationNotFound);
            }
        }
        for asset_id in asset_ids {
            for classification_id in &remove_ids {
                transaction.execute(
                    "DELETE FROM asset_classifications WHERE asset_id = ?1 AND classification_id = ?2",
                    params![asset_id, classification_id],
                )?;
            }
            for classification_id in &add_ids {
                transaction.execute(
                    "INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                    params![asset_id, classification_id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

pub(crate) fn classifications_for_asset(
    connection: &Connection,
    asset_id: &str,
) -> Result<Vec<ClassificationEntry>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT entry.id, entry.kind, entry.name, entry.parent_id, entry.icon_key, entry.color_key
         FROM classification_entries AS entry
         JOIN asset_classifications AS link ON link.classification_id = entry.id
         WHERE link.asset_id = ?1
         ORDER BY entry.name COLLATE NOCASE, entry.id",
    )?;
    read_entries(&mut statement, [asset_id])
}

fn normalized_name(name: String) -> Result<String, LibraryError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(LibraryError::EmptyClassificationName);
    }
    Ok(name)
}

fn find_parent(
    connection: &Connection,
    parent_id: Option<&str>,
) -> Result<Option<ClassificationEntry>, LibraryError> {
    parent_id
        .map(|parent_id| {
            find_classification(connection, parent_id)?.ok_or(LibraryError::ClassificationNotFound)
        })
        .transpose()
}

fn find_classification(
    connection: &Connection,
    id: &str,
) -> Result<Option<ClassificationEntry>, LibraryError> {
    let values = connection
        .query_row(
            "SELECT id, kind, name, parent_id, icon_key, color_key
             FROM classification_entries WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    values.map(entry_from_values).transpose()
}

fn read_entries<P>(
    statement: &mut rusqlite::Statement<'_>,
    parameters: P,
) -> Result<Vec<ClassificationEntry>, LibraryError>
where
    P: rusqlite::Params,
{
    let mut rows = statement.query(parameters)?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        entries.push(entry_from_values((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
        ))?);
    }
    Ok(entries)
}

fn entry_from_values(
    (id, kind, name, parent_id, icon_key, color_key): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
) -> Result<ClassificationEntry, LibraryError> {
    let kind = match kind.as_str() {
        "root" => ClassificationKind::Root,
        "work" => ClassificationKind::Work,
        "tag" => ClassificationKind::Tag,
        _ => return Err(rusqlite::Error::InvalidQuery.into()),
    };
    Ok(ClassificationEntry {
        id,
        kind,
        name,
        parent_id,
        icon_key,
        color_key,
    })
}

fn validate_parent(
    kind: &ClassificationKind,
    parent: Option<&ClassificationEntry>,
) -> Result<(), LibraryError> {
    let valid = match kind {
        ClassificationKind::Root => parent.is_none(),
        ClassificationKind::Work => matches!(
            parent,
            Some(ClassificationEntry {
                kind: ClassificationKind::Root,
                ..
            })
        ),
        ClassificationKind::Tag => parent.is_some(),
    };
    if valid {
        Ok(())
    } else {
        Err(LibraryError::InvalidClassificationParent)
    }
}

fn kind_name(kind: &ClassificationKind) -> &'static str {
    match kind {
        ClassificationKind::Root => "root",
        ClassificationKind::Work => "work",
        ClassificationKind::Tag => "tag",
    }
}

fn map_duplicate_name(error: rusqlite::Error) -> LibraryError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            LibraryError::DuplicateClassificationName
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::library::{
        error::LibraryError,
        models::{
            AssetClassificationPatch, ClassificationKind, CreateClassification,
            SetAssetClassification,
        },
        Library,
    };

    struct ClassificationFixture {
        _temp: TempDir,
        library: Library,
        root: crate::library::models::ClassificationEntry,
        parent_tag: crate::library::models::ClassificationEntry,
        child_tag: crate::library::models::ClassificationEntry,
    }

    impl ClassificationFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            let root = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Root,
                    name: "Games".into(),
                    parent_id: None,
                })
                .unwrap();
            let work = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Work,
                    name: "Blue Archive".into(),
                    parent_id: Some(root.id.clone()),
                })
                .unwrap();
            let parent_tag = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Tag,
                    name: "Student".into(),
                    parent_id: Some(work.id.clone()),
                })
                .unwrap();
            let child_tag = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Tag,
                    name: "Aru".into(),
                    parent_id: Some(parent_tag.id.clone()),
                })
                .unwrap();

            Self {
                _temp: temp,
                library,
                root,
                parent_tag,
                child_tag,
            }
        }
    }

    #[test]
    fn work_requires_a_root_parent_and_tag_can_nest_under_a_work() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        let work = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "Blue Archive".into(),
                parent_id: Some(root.id.clone()),
            })
            .unwrap();
        let tag = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Aru".into(),
                parent_id: Some(work.id.clone()),
            })
            .unwrap();

        assert_eq!(tag.parent_id, Some(work.id));
    }

    #[test]
    fn moving_a_tag_below_its_descendant_is_rejected() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .move_classification(&fixture.parent_tag.id, Some(&fixture.child_tag.id))
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationCycle));
    }

    #[test]
    fn moving_a_tag_to_a_root_persists_its_new_parent() {
        let fixture = ClassificationFixture::new();

        fixture
            .library
            .move_classification(&fixture.child_tag.id, Some(&fixture.root.id))
            .unwrap();

        let moved = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(moved.parent_id, Some(fixture.root.id));
    }

    #[test]
    fn moving_a_root_below_another_root_demotes_it_without_moving_contents() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let destination = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        let moving = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Reverse".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Character".into(),
                parent_id: Some(moving.id.clone()),
            })
            .unwrap();
        insert_asset(&library, "asset-a");
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(moving.id.clone()),
            })
            .unwrap();

        library
            .move_classification(&moving.id, Some(&destination.id))
            .unwrap();

        let entries = library.list_classifications().unwrap();
        let moved = entries.iter().find(|entry| entry.id == moving.id).unwrap();
        let preserved_child = entries.iter().find(|entry| entry.id == child.id).unwrap();
        assert_eq!(moved.kind, ClassificationKind::Tag);
        assert_eq!(moved.parent_id, Some(destination.id));
        assert_eq!(preserved_child.parent_id, Some(moved.id.clone()));
        assert_eq!(
            library.get_asset_classifications("asset-a").unwrap(),
            vec![moved.clone()]
        );
    }

    #[test]
    fn moving_a_tag_to_the_top_level_promotes_it_without_moving_contents() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let destination = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        let moving = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Reverse".into(),
                parent_id: None,
            })
            .unwrap();
        let child = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Character".into(),
                parent_id: Some(moving.id.clone()),
            })
            .unwrap();
        insert_asset(&library, "asset-a");
        library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(moving.id.clone()),
            })
            .unwrap();
        library
            .move_classification(&moving.id, Some(&destination.id))
            .unwrap();

        library.move_classification(&moving.id, None).unwrap();

        let entries = library.list_classifications().unwrap();
        let moved = entries.iter().find(|entry| entry.id == moving.id).unwrap();
        let preserved_child = entries.iter().find(|entry| entry.id == child.id).unwrap();
        assert_eq!(moved.kind, ClassificationKind::Root);
        assert_eq!(moved.parent_id, None);
        assert_eq!(preserved_child.parent_id, Some(moved.id.clone()));
        assert_eq!(
            library.get_asset_classifications("asset-a").unwrap(),
            vec![moved.clone()]
        );
    }

    #[test]
    fn deleting_a_classification_with_children_is_rejected() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .delete_classification(&fixture.root.id)
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationHasChildren));
    }

    #[test]
    fn a_root_cannot_have_a_parent() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Comics".into(),
                parent_id: Some(fixture.root.id.clone()),
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidClassificationParent));
    }

    #[test]
    fn a_work_cannot_have_a_tag_parent() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Work,
                name: "Arknights".into(),
                parent_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidClassificationParent));
    }

    #[test]
    fn a_tag_requires_a_parent() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let error = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Aru".into(),
                parent_id: None,
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::InvalidClassificationParent));
    }

    #[test]
    fn a_classification_name_cannot_be_blank() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let error = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: " \t ".into(),
                parent_id: None,
            })
            .unwrap_err();

        assert!(matches!(error, LibraryError::EmptyClassificationName));
    }

    #[test]
    fn deleting_a_leaf_moves_every_asset_state_to_its_parent_once() {
        let fixture = ClassificationFixture::new();
        for (id, status) in [
            ("asset-normal", "normal"),
            ("asset-review", "review"),
            ("asset-trash", "trash"),
        ] {
            insert_asset(&fixture.library, id);
            fixture
                .library
                .connection()
                .unwrap()
                .execute("UPDATE assets SET status = ?1 WHERE id = ?2", [status, id])
                .unwrap();
        }
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec![
                    "asset-normal".into(),
                    "asset-review".into(),
                    "asset-trash".into(),
                ],
                add_classification_ids: vec![fixture.child_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-normal".into()],
                add_classification_ids: vec![fixture.parent_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        fixture
            .library
            .delete_classification(&fixture.child_tag.id)
            .unwrap();

        for id in ["asset-normal", "asset-review", "asset-trash"] {
            assert_eq!(
                fixture.library.get_asset_classifications(id).unwrap(),
                vec![fixture.parent_tag.clone()],
            );
        }
        assert!(!fixture
            .library
            .list_classifications()
            .unwrap()
            .iter()
            .any(|entry| entry.id == fixture.child_tag.id));
    }

    #[test]
    fn deleting_an_asset_linked_root_preserves_the_asset_without_that_folder() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Games".into(),
                parent_id: None,
            })
            .unwrap();
        insert_asset(&library, "asset-1");
        library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-1".into()],
                add_classification_ids: vec![root.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        library.delete_classification(&root.id).unwrap();

        assert_eq!(library.get_asset("asset-1").unwrap().id, "asset-1");
        assert!(library.get_asset_classifications("asset-1").unwrap().is_empty());
        assert!(library.list_classifications().unwrap().is_empty());
    }

    #[test]
    fn deleting_an_empty_root_removes_it() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let root = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "Unused".into(),
                parent_id: None,
            })
            .unwrap();

        library.delete_classification(&root.id).unwrap();

        assert!(library.list_classifications().unwrap().is_empty());
    }

    #[test]
    fn renaming_trims_the_name_and_rejects_a_duplicate_sibling() {
        let fixture = ClassificationFixture::new();

        fixture
            .library
            .rename_classification(&fixture.child_tag.id, "  Problem Solver  ")
            .unwrap();
        let renamed = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(renamed.name, "Problem Solver");

        fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Tag,
                name: "Student".into(),
                parent_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap();

        let error = fixture
            .library
            .rename_classification(&fixture.child_tag.id, " Student ")
            .unwrap_err();
        assert!(matches!(error, LibraryError::DuplicateClassificationName));
    }

    #[test]
    fn classification_appearance_updates_and_resets() {
        let fixture = ClassificationFixture::new();

        fixture
            .library
            .update_classification_appearance(
                &fixture.child_tag.id,
                Some("photo"),
                Some("pink"),
            )
            .unwrap();
        let changed = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!(changed.icon_key.as_deref(), Some("photo"));
        assert_eq!(changed.color_key.as_deref(), Some("pink"));

        fixture
            .library
            .update_classification_appearance(&fixture.child_tag.id, None, None)
            .unwrap();
        let reset = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!((reset.icon_key, reset.color_key), (None, None));
    }

    #[test]
    fn classification_appearance_rejects_unknown_keys_without_changing_it() {
        let fixture = ClassificationFixture::new();

        assert!(matches!(
            fixture.library.update_classification_appearance(
                &fixture.child_tag.id,
                Some("uploaded-svg"),
                Some("#ffffff"),
            ),
            Err(LibraryError::InvalidClassificationAppearance)
        ));
        let entry = fixture
            .library
            .list_classifications()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == fixture.child_tag.id)
            .unwrap();
        assert_eq!((entry.icon_key, entry.color_key), (None, None));
        assert!(matches!(
            fixture.library.update_classification_appearance(
                "missing-folder",
                Some("folder"),
                Some("blue"),
            ),
            Err(LibraryError::ClassificationNotFound)
        ));
    }

    #[test]
    fn list_classifications_returns_persisted_entries() {
        let fixture = ClassificationFixture::new();

        let entries = fixture.library.list_classifications().unwrap();
        let ids: Vec<_> = entries.into_iter().map(|entry| entry.id).collect();

        assert_eq!(ids.len(), 4);
        assert!(ids.contains(&fixture.root.id));
        assert!(ids.contains(&fixture.parent_tag.id));
        assert!(ids.contains(&fixture.child_tag.id));
    }

    #[test]
    fn batch_classification_patch_is_additive_selective_and_atomic() {
        let fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        insert_asset(&fixture.library, "asset-b");
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into()],
                add_classification_ids: vec![fixture.child_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();

        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into(), "asset-b".into()],
                add_classification_ids: vec![fixture.parent_tag.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-b")
                .unwrap(),
            vec![fixture.parent_tag.clone()]
        );

        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into()],
                add_classification_ids: vec![],
                remove_classification_ids: vec![fixture.child_tag.id.clone()],
            })
            .unwrap();
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.parent_tag.clone()]
        );

        let error = fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into(), "missing".into()],
                add_classification_ids: vec![fixture.root.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap_err();
        assert!(matches!(error, LibraryError::AssetNotFound));
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.parent_tag.clone()]
        );
    }

    #[test]
    fn setting_a_folder_replaces_all_direct_links_atomically() {
        let fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec!["asset-a".into()],
                add_classification_ids: vec![
                    fixture.root.id.clone(),
                    fixture.child_tag.id.clone(),
                ],
                remove_classification_ids: Vec::new(),
            })
            .unwrap();

        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(fixture.parent_tag.id.clone()),
            })
            .unwrap();

        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.parent_tag]
        );
    }

    #[test]
    fn setting_a_folder_can_unsort_and_rejects_partial_batches() {
        let fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-a");
        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: Some(fixture.root.id.clone()),
            })
            .unwrap();

        let error = fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into(), "missing".into()],
                classification_id: Some(fixture.child_tag.id),
            })
            .unwrap_err();
        assert!(matches!(error, LibraryError::AssetNotFound));
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-a")
                .unwrap(),
            vec![fixture.root]
        );

        fixture
            .library
            .set_asset_classification(SetAssetClassification {
                asset_ids: vec!["asset-a".into()],
                classification_id: None,
            })
            .unwrap();
        assert!(fixture
            .library
            .get_asset_classifications("asset-a")
            .unwrap()
            .is_empty());
    }

    fn insert_asset(library: &Library, id: &str) {
        let connection = library.connection().unwrap();
        connection
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', 'asset.png', ?3, ?4, 1, 1, 1, '2026-07-30T00:00:00Z')",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.png"),
                ],
            )
            .unwrap();
    }
}
