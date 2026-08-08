use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    error::LibraryError,
    models::{ClassificationEntry, ClassificationKind, CreateClassification},
    Library,
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
        validate_parent(&entry.kind, parent.as_ref())?;

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
                "UPDATE classification_entries SET parent_id = ?1 WHERE id = ?2",
                params![parent_id, id],
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

    pub fn list_classifications(&self) -> Result<Vec<ClassificationEntry>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, name, parent_id
             FROM classification_entries
             ORDER BY parent_id, name COLLATE NOCASE, id",
        )?;
        read_entries(&mut statement, [])
    }

    pub fn delete_classification(&self, id: &str) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if find_classification(&transaction, id)?.is_none() {
            return Err(LibraryError::ClassificationNotFound);
        }
        let has_children_or_assets: bool = transaction.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM classification_entries WHERE parent_id = ?1
                 UNION ALL
                 SELECT 1 FROM asset_classifications WHERE classification_id = ?1
             )",
            [id],
            |row| row.get(0),
        )?;
        if has_children_or_assets {
            return Err(LibraryError::ClassificationNotEmpty);
        }
        transaction.execute("DELETE FROM classification_entries WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_asset_classifications(
        &self,
        asset_id: &str,
        classification_ids: &[String],
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
            [asset_id],
            |row| row.get(0),
        )?;
        if !asset_exists {
            return Err(LibraryError::AssetNotFound);
        }

        let classification_ids: BTreeSet<_> = classification_ids.iter().collect();
        for classification_id in &classification_ids {
            if find_classification(&transaction, classification_id)?.is_none() {
                return Err(LibraryError::ClassificationNotFound);
            }
        }

        transaction.execute(
            "DELETE FROM asset_classifications WHERE asset_id = ?1",
            [asset_id],
        )?;
        for classification_id in classification_ids {
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                params![asset_id, classification_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn get_asset_classifications(
        &self,
        asset_id: &str,
    ) -> Result<Vec<ClassificationEntry>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT entry.id, entry.kind, entry.name, entry.parent_id
             FROM classification_entries AS entry
             JOIN asset_classifications AS link ON link.classification_id = entry.id
             WHERE link.asset_id = ?1
             ORDER BY entry.name COLLATE NOCASE, entry.id",
        )?;
        read_entries(&mut statement, [asset_id])
    }
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
            "SELECT id, kind, name, parent_id FROM classification_entries WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
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
        ))?);
    }
    Ok(entries)
}

fn entry_from_values(
    (id, kind, name, parent_id): (String, String, String, Option<String>),
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
        models::{ClassificationKind, CreateClassification},
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
    fn deleting_a_non_empty_classification_is_rejected() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .delete_classification(&fixture.root.id)
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationNotEmpty));
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
    fn deleting_an_asset_linked_classification_is_rejected() {
        let fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-1");
        fixture
            .library
            .set_asset_classifications("asset-1", std::slice::from_ref(&fixture.child_tag.id))
            .unwrap();

        let error = fixture
            .library
            .delete_classification(&fixture.child_tag.id)
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationNotEmpty));
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
    fn setting_asset_classifications_replaces_direct_links_and_ignores_duplicate_ids() {
        let fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-1");

        fixture
            .library
            .set_asset_classifications(
                "asset-1",
                &[fixture.child_tag.id.clone(), fixture.child_tag.id.clone()],
            )
            .unwrap();

        let entries = fixture
            .library
            .get_asset_classifications("asset-1")
            .unwrap();
        assert_eq!(entries, vec![fixture.child_tag.clone()]);
    }

    #[test]
    fn setting_asset_classifications_rolls_back_when_a_classification_is_missing() {
        let fixture = ClassificationFixture::new();
        insert_asset(&fixture.library, "asset-1");
        fixture
            .library
            .set_asset_classifications("asset-1", std::slice::from_ref(&fixture.child_tag.id))
            .unwrap();

        let error = fixture
            .library
            .set_asset_classifications("asset-1", &["missing-classification".into()])
            .unwrap_err();

        assert!(matches!(error, LibraryError::ClassificationNotFound));
        assert_eq!(
            fixture
                .library
                .get_asset_classifications("asset-1")
                .unwrap(),
            vec![fixture.child_tag.clone()]
        );
    }

    #[test]
    fn setting_asset_classifications_rejects_a_missing_asset() {
        let fixture = ClassificationFixture::new();

        let error = fixture
            .library
            .set_asset_classifications("missing-asset", std::slice::from_ref(&fixture.child_tag.id))
            .unwrap_err();

        assert!(matches!(error, LibraryError::AssetNotFound));
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
