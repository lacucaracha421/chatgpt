use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    error::LibraryError,
    models::{AssetCollectionPatch, CollectionSummary, CreateCollection, UpdateCollection},
    validated_asset_ids, Library,
};

const COLLECTION_SUMMARY_SQL: &str = "SELECT
    collection.id,
    collection.name,
    collection.description,
    COALESCE(
        CASE WHEN EXISTS (
            SELECT 1 FROM collection_assets AS explicit_link
            JOIN assets AS explicit_asset ON explicit_asset.id = explicit_link.asset_id
            WHERE explicit_link.collection_id = collection.id
              AND explicit_link.asset_id = collection.cover_asset_id
              AND explicit_asset.status = 'normal'
        ) THEN collection.cover_asset_id END,
        (
            SELECT fallback_link.asset_id
            FROM collection_assets AS fallback_link
            JOIN assets AS fallback_asset ON fallback_asset.id = fallback_link.asset_id
            WHERE fallback_link.collection_id = collection.id
              AND fallback_asset.status = 'normal'
            ORDER BY fallback_link.added_at, fallback_link.asset_id
            LIMIT 1
        )
    ),
    (
        SELECT COUNT(*)
        FROM collection_assets AS count_link
        JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
        WHERE count_link.collection_id = collection.id
          AND count_asset.status = 'normal'
    ),
    collection.created_at,
    collection.updated_at
FROM collections AS collection";

impl Library {
    pub fn list_collections(&self) -> Result<Vec<CollectionSummary>, LibraryError> {
        let connection = self.connection()?;
        let sql = format!(
            "{COLLECTION_SUMMARY_SQL} ORDER BY collection.updated_at DESC, collection.id DESC"
        );
        let mut statement = connection.prepare(&sql)?;
        let entries = statement
            .query_map([], collection_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn get_collection(&self, id: &str) -> Result<CollectionSummary, LibraryError> {
        let connection = self.connection()?;
        collection_by_id(&connection, id)
    }

    pub fn create_collection(
        &self,
        request: CreateCollection,
    ) -> Result<CollectionSummary, LibraryError> {
        let name = normalized_name(request.name)?;
        let description = normalized_description(request.description)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, cover_asset_id, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
                params![id, name, description, now],
            )
            .map_err(map_duplicate_name)?;
        collection_by_id(&connection, &id)
    }

    pub fn update_collection(
        &self,
        id: &str,
        request: UpdateCollection,
    ) -> Result<CollectionSummary, LibraryError> {
        let name = normalized_name(request.name)?;
        let description = normalized_description(request.description)?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE collections
                 SET name = ?1, description = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![name, description, chrono::Utc::now().to_rfc3339(), id],
            )
            .map_err(map_duplicate_name)?;
        if changed == 0 {
            return Err(LibraryError::CollectionNotFound);
        }
        collection_by_id(&connection, id)
    }

    pub fn delete_collection(&self, id: &str) -> Result<(), LibraryError> {
        let changed = self
            .connection()?
            .execute("DELETE FROM collections WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(LibraryError::CollectionNotFound);
        }
        Ok(())
    }

    pub fn set_collection_cover(
        &self,
        collection_id: &str,
        asset_id: Option<&str>,
    ) -> Result<CollectionSummary, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        if let Some(asset_id) = asset_id {
            let valid: bool = connection.query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM collection_assets AS link
                    JOIN assets AS asset ON asset.id = link.asset_id
                    WHERE link.collection_id = ?1 AND link.asset_id = ?2
                      AND asset.status = 'normal'
                 )",
                params![collection_id, asset_id],
                |row| row.get(0),
            )?;
            if !valid {
                return Err(LibraryError::CollectionCoverNotMember);
            }
        }
        connection.execute(
            "UPDATE collections SET cover_asset_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![asset_id, chrono::Utc::now().to_rfc3339(), collection_id],
        )?;
        collection_by_id(&connection, collection_id)
    }

    pub fn patch_asset_collections(&self, patch: AssetCollectionPatch) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let asset_ids = validated_asset_ids(&transaction, &patch.asset_ids)?;
        let add_ids: BTreeSet<_> = patch
            .add_collection_ids
            .iter()
            .map(String::as_str)
            .collect();
        let remove_ids: BTreeSet<_> = patch
            .remove_collection_ids
            .iter()
            .map(String::as_str)
            .collect();
        for collection_id in add_ids.iter().chain(remove_ids.iter()) {
            require_collection(&transaction, collection_id)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        for asset_id in asset_ids {
            for collection_id in &remove_ids {
                transaction.execute(
                    "UPDATE collections
                     SET cover_asset_id = NULL, updated_at = ?1
                     WHERE id = ?2 AND cover_asset_id = ?3",
                    params![now, collection_id, asset_id],
                )?;
                transaction.execute(
                    "DELETE FROM collection_assets
                     WHERE asset_id = ?1 AND collection_id = ?2",
                    params![asset_id, collection_id],
                )?;
            }
            for collection_id in &add_ids {
                transaction.execute(
                    "INSERT OR IGNORE INTO collection_assets (collection_id, asset_id, added_at)
                     VALUES (?1, ?2, ?3)",
                    params![collection_id, asset_id, now],
                )?;
            }
        }
        for collection_id in add_ids.iter().chain(remove_ids.iter()) {
            transaction.execute(
                "UPDATE collections SET updated_at = ?1 WHERE id = ?2",
                params![now, collection_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn get_asset_collections(&self, asset_id: &str) -> Result<Vec<String>, LibraryError> {
        let connection = self.connection()?;
        validated_asset_ids(&connection, &[asset_id.to_owned()])?;
        let mut statement = connection.prepare(
            "SELECT collection.id
             FROM collections AS collection
             JOIN collection_assets AS link ON link.collection_id = collection.id
             WHERE link.asset_id = ?1
             ORDER BY collection.name COLLATE NOCASE, collection.id",
        )?;
        let ids = statement
            .query_map([asset_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }
}

fn normalized_name(name: String) -> Result<String, LibraryError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(LibraryError::EmptyCollectionName);
    }
    if name.chars().count() > 120 {
        return Err(LibraryError::CollectionNameTooLong);
    }
    Ok(name)
}

fn normalized_description(description: Option<String>) -> Result<Option<String>, LibraryError> {
    let description = description
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if description
        .as_ref()
        .is_some_and(|value| value.chars().count() > 2000)
    {
        return Err(LibraryError::CollectionDescriptionTooLong);
    }
    Ok(description)
}

fn require_collection(connection: &Connection, id: &str) -> Result<(), LibraryError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(LibraryError::CollectionNotFound)
    }
}

fn collection_by_id(connection: &Connection, id: &str) -> Result<CollectionSummary, LibraryError> {
    let sql = format!("{COLLECTION_SUMMARY_SQL} WHERE collection.id = ?1");
    connection
        .query_row(&sql, [id], collection_from_row)
        .optional()?
        .ok_or(LibraryError::CollectionNotFound)
}

fn collection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionSummary> {
    Ok(CollectionSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        cover_asset_id: row.get(3)?,
        asset_count: u64::try_from(row.get::<_, i64>(4)?).unwrap_or(0),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn map_duplicate_name(error: rusqlite::Error) -> LibraryError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            LibraryError::DuplicateCollectionName
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use crate::library::{
        error::LibraryError,
        models::{AssetCollectionPatch, CreateCollection, UpdateCollection},
        Library,
    };

    #[test]
    fn creates_updates_lists_and_deletes_collection_without_deleting_assets() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-1", "normal");

        let created = library
            .create_collection(CreateCollection {
                name: "  Reference  ".into(),
                description: Some("  Covers and poses  ".into()),
            })
            .unwrap();
        assert_eq!(created.name, "Reference");
        assert_eq!(created.description.as_deref(), Some("Covers and poses"));
        assert_eq!(created.asset_count, 0);
        assert_eq!(created.cover_asset_id, None);

        let updated = library
            .update_collection(
                &created.id,
                UpdateCollection {
                    name: "Inspiration".into(),
                    description: Some("   ".into()),
                },
            )
            .unwrap();
        assert_eq!(updated.name, "Inspiration");
        assert_eq!(updated.description, None);
        assert_eq!(library.list_collections().unwrap(), vec![updated.clone()]);

        library.delete_collection(&created.id).unwrap();
        assert!(library.list_collections().unwrap().is_empty());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn validates_names_descriptions_and_duplicate_names() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
            })
            .unwrap();

        for name in ["", "   "] {
            assert!(matches!(
                library.create_collection(CreateCollection {
                    name: name.into(),
                    description: None,
                }),
                Err(LibraryError::EmptyCollectionName)
            ));
        }
        assert!(matches!(
            library.create_collection(CreateCollection {
                name: "R".repeat(121),
                description: None,
            }),
            Err(LibraryError::CollectionNameTooLong)
        ));
        assert!(matches!(
            library.create_collection(CreateCollection {
                name: "reference".into(),
                description: None,
            }),
            Err(LibraryError::DuplicateCollectionName)
        ));
        assert!(matches!(
            library.create_collection(CreateCollection {
                name: "Other".into(),
                description: Some("x".repeat(2001)),
            }),
            Err(LibraryError::CollectionDescriptionTooLong)
        ));
    }

    #[test]
    fn membership_is_many_to_many_idempotent_and_controls_cover() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-1", "normal");
        insert_asset(&library, "asset-2", "normal");
        let first = create(&library, "First");
        let second = create(&library, "Second");

        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["asset-1".into(), "asset-1".into()],
                add_collection_ids: vec![first.id.clone(), first.id.clone(), second.id.clone()],
                remove_collection_ids: vec![],
            })
            .unwrap();
        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["asset-2".into()],
                add_collection_ids: vec![first.id.clone()],
                remove_collection_ids: vec![],
            })
            .unwrap();

        assert_eq!(
            library.get_asset_collections("asset-1").unwrap(),
            vec![first.id.clone(), second.id.clone()]
        );
        let listed = library.list_collections().unwrap();
        assert_eq!(
            listed
                .iter()
                .find(|item| item.id == first.id)
                .unwrap()
                .asset_count,
            2
        );
        assert_eq!(
            listed
                .iter()
                .find(|item| item.id == second.id)
                .unwrap()
                .asset_count,
            1
        );

        library
            .set_collection_cover(&first.id, Some("asset-2"))
            .unwrap();
        assert_eq!(
            library
                .get_collection(&first.id)
                .unwrap()
                .cover_asset_id
                .as_deref(),
            Some("asset-2")
        );
        assert!(matches!(
            library.set_collection_cover(&second.id, Some("asset-2")),
            Err(LibraryError::CollectionCoverNotMember)
        ));

        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["asset-2".into()],
                add_collection_ids: vec![],
                remove_collection_ids: vec![first.id.clone()],
            })
            .unwrap();
        let after_remove = library.get_collection(&first.id).unwrap();
        assert_eq!(after_remove.asset_count, 1);
        assert_eq!(after_remove.cover_asset_id.as_deref(), Some("asset-1"));
    }

    #[test]
    fn rejects_missing_references_and_non_normal_cover() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "trash-asset", "trash");
        let collection = create(&library, "Reference");

        assert!(matches!(
            library.patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["missing".into()],
                add_collection_ids: vec![collection.id.clone()],
                remove_collection_ids: vec![],
            }),
            Err(LibraryError::AssetNotFound)
        ));
        assert!(matches!(
            library.patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["trash-asset".into()],
                add_collection_ids: vec!["missing".into()],
                remove_collection_ids: vec![],
            }),
            Err(LibraryError::CollectionNotFound)
        ));
        assert!(matches!(
            library.set_collection_cover(&collection.id, Some("trash-asset")),
            Err(LibraryError::CollectionCoverNotMember)
        ));
    }

    fn create(library: &Library, name: &str) -> crate::library::models::CollectionSummary {
        library
            .create_collection(CreateCollection {
                name: name.into(),
                description: None,
            })
            .unwrap()
    }

    fn insert_asset(library: &Library, id: &str, status: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, status
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 1, 1,
                    '2026-08-16T00:00:00Z', ?6)",
                rusqlite::params![
                    id,
                    format!("hash-{id}"),
                    format!("{id}.png"),
                    format!("assets/{id}.png"),
                    format!("thumbnails/{id}.webp"),
                    status,
                ],
            )
            .unwrap();
    }
}
