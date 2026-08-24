use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    error::LibraryError,
    models::{
        AssetCollectionPatch, CollectionSummary, CollectionType, CreateCollection, UpdateCollection,
    },
    validated_asset_ids, Library,
};

const COLLECTION_SUMMARY_SQL: &str = "SELECT
    collection.id,
    collection.name,
    collection.description,
    collection.type,
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
        SELECT artwork.id
        FROM collection_work_artworks AS artwork
        WHERE artwork.collection_id = collection.id
          AND artwork.kind = 'cover'
          AND artwork.selected = 1
        LIMIT 1
    ),
    (
        SELECT COUNT(*)
        FROM collection_assets AS count_link
        JOIN assets AS count_asset ON count_asset.id = count_link.asset_id
        WHERE count_link.collection_id = collection.id
          AND count_asset.status = 'normal'
    ),
    collection.year,
    collection.author,
    collection.director,
    collection.developer,
    collection.production_company,
    collection.release_date,
    collection.external_score,
    collection.my_score,
    collection.genres,
    collection.overview,
    collection.showcase,
    collection.showcase_order,
    collection.created_at,
    collection.updated_at,
    (
        SELECT COUNT(*)
        FROM release_watch_events AS release_event
        WHERE release_event.collection_id = collection.id
          AND release_event.read_at IS NULL
    ),
    collection.source_path
FROM collections AS collection";

impl Library {
    pub fn list_collections(&self) -> Result<Vec<CollectionSummary>, LibraryError> {
        let connection = self.connection()?;
        let sql = format!(
            "{COLLECTION_SUMMARY_SQL}
             WHERE collection.legacy_kind IS NULL OR collection.legacy_kind <> 'gacha'
             ORDER BY collection.updated_at DESC, collection.id DESC"
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
        let type_str = collection_type_str(request.collection_type);
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id,
                    year, author, director, developer, production_company, release_date,
                    external_score, my_score, showcase_order,
                    genres, overview, showcase, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, NULL,
                    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, 0, ?5, ?5)",
                params![id, name, description, type_str, now],
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
        let type_str = collection_type_str(request.collection_type);
        let author = normalized_optional_text(request.author);
        let director = normalized_optional_text(request.director);
        let developer = normalized_optional_text(request.developer);
        let production_company = normalized_optional_text(request.production_company);
        let release_date = normalized_release_date(request.release_date)?;
        let my_score = validated_personal_rating(request.my_score)?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE collections
                 SET name = ?1, description = ?2, type = ?3,
                     year = ?4, author = ?5, director = ?6,
                     developer = ?7, production_company = ?8, release_date = ?9,
                     external_score = ?10, my_score = ?11,
                     showcase_order = CASE
                         WHEN showcase = 1 AND type <> ?3 THEN (
                             SELECT COALESCE(MAX(other.showcase_order) + 1, 0)
                             FROM collections AS other
                            WHERE other.type = ?3
                              AND other.id <> ?13
                              AND (other.legacy_kind IS NULL OR other.legacy_kind <> 'gacha')
                         )
                         ELSE showcase_order
                     END,
                     updated_at = ?12
                 WHERE id = ?13",
                params![
                    name,
                    description,
                    type_str,
                    request.year,
                    author,
                    director,
                    developer,
                    production_company,
                    release_date,
                    request.external_score,
                    my_score,
                    chrono::Utc::now().to_rfc3339(),
                    id,
                ],
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
        self.cleanup_unreferenced_work_artwork()
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

    pub fn set_collection_showcase(
        &self,
        collection_id: &str,
        showcase: bool,
    ) -> Result<CollectionSummary, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        let changed = connection.execute(
            "UPDATE collections
             SET showcase = ?1,
                 showcase_order = CASE
                     WHEN ?1 = 0 THEN NULL
                     WHEN showcase = 1 AND showcase_order IS NOT NULL THEN showcase_order
                     ELSE (
                         SELECT COALESCE(MAX(other.showcase_order) + 1, 0)
                         FROM collections AS other
                         WHERE other.type = collections.type
                           AND other.id <> collections.id
                           AND (other.legacy_kind IS NULL OR other.legacy_kind <> 'gacha')
                     )
                 END,
                 updated_at = ?2
             WHERE id = ?3",
            params![
                if showcase { 1 } else { 0 },
                chrono::Utc::now().to_rfc3339(),
                collection_id
            ],
        )?;
        if changed == 0 {
            return Err(LibraryError::CollectionNotFound);
        }
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

pub(crate) fn normalized_name(name: String) -> Result<String, LibraryError> {
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

fn normalized_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn normalized_release_date(value: Option<String>) -> Result<Option<String>, LibraryError> {
    let value = normalized_optional_text(value);
    if value.as_ref().is_some_and(|value| {
        let bytes = value.as_bytes();
        bytes.len() != 10
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes
                .iter()
                .enumerate()
                .any(|(index, byte)| (index != 4 && index != 7) && !byte.is_ascii_digit())
            || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err()
    }) {
        return Err(LibraryError::InvalidCollectionReleaseDate);
    }
    Ok(value)
}

impl Library {
    pub(crate) fn normalize_showcase_orders(&self) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE collections
         SET showcase_order = NULL
         WHERE showcase = 1
           AND (legacy_kind IS NOT NULL AND legacy_kind = 'gacha')",
            [],
        )?;
        connection.execute(
            "WITH ranked AS (
                 SELECT id,
                        ROW_NUMBER() OVER (
                            PARTITION BY type
                            ORDER BY
                                CASE WHEN showcase_order IS NULL THEN 1 ELSE 0 END,
                                showcase_order,
                                created_at,
                                id
                        ) - 1 AS normalized_order
                 FROM collections
                 WHERE showcase = 1
                   AND (legacy_kind IS NULL OR legacy_kind <> 'gacha')
             )
             UPDATE collections
             SET showcase_order = (
                 SELECT normalized_order
                 FROM ranked
                 WHERE ranked.id = collections.id
             )
             WHERE id IN (SELECT id FROM ranked)",
            [],
        )?;
        Ok(())
    }
}

pub(crate) fn validated_personal_rating(value: Option<f64>) -> Result<Option<f64>, LibraryError> {
    if value.is_some_and(|value| {
        !value.is_finite() || !(0.0..=5.0).contains(&value) || (value * 2.0).fract() != 0.0
    }) {
        return Err(LibraryError::InvalidPersonalRating);
    }
    Ok(value)
}

pub(crate) fn require_collection(connection: &Connection, id: &str) -> Result<(), LibraryError> {
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

pub(crate) fn collection_by_id(
    connection: &Connection,
    id: &str,
) -> Result<CollectionSummary, LibraryError> {
    let sql = format!("{COLLECTION_SUMMARY_SQL} WHERE collection.id = ?1");
    connection
        .query_row(&sql, [id], collection_from_row)
        .optional()?
        .ok_or(LibraryError::CollectionNotFound)
}

fn collection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionSummary> {
    let type_str: String = row.get(3)?;
    let collection_type = match type_str.as_str() {
        "game" => CollectionType::Game,
        "movie" => CollectionType::Movie,
        _ => CollectionType::Manga,
    };
    let showcase_int: i64 = row.get(17)?;
    Ok(CollectionSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        collection_type,
        cover_asset_id: row.get(4)?,
        selected_work_artwork_id: row.get(5)?,
        asset_count: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
        unread_release_count: u64::try_from(row.get::<_, i64>(21)?).unwrap_or(0),
        year: row.get(7)?,
        author: row.get(8)?,
        director: row.get(9)?,
        developer: row.get(10)?,
        production_company: row.get(11)?,
        release_date: row.get(12)?,
        external_score: row.get(13)?,
        my_score: row.get(14)?,
        genres: row.get(15)?,
        overview: row.get(16)?,
        showcase: showcase_int != 0,
        showcase_order: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        source_path: row.get(22)?,
    })
}

pub(crate) fn collection_type_str(collection_type: CollectionType) -> &'static str {
    match collection_type {
        CollectionType::Game => "game",
        CollectionType::Manga => "manga",
        CollectionType::Movie => "movie",
    }
}

pub(crate) fn map_duplicate_name(error: rusqlite::Error) -> LibraryError {
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
    use std::io::Cursor;

    use image::{DynamicImage, ImageFormat};

    use crate::library::{
        error::LibraryError,
        models::{
            AssetCollectionPatch, CollectionSummary, CollectionType, CreateCollection,
            ExternalBindingInput, UpdateCollection,
        },
        Library,
    };

    #[test]
    fn list_collections_hides_only_proven_legacy_gacha() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let game = library
            .create_collection(CreateCollection {
                name: "Visible Game".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        let gacha = library
            .create_collection(CreateCollection {
                name: "Hidden Gacha".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET legacy_kind = 'gacha' WHERE id = ?1",
                [&gacha.id],
            )
            .unwrap();

        assert_eq!(library.get_collection(&gacha.id).unwrap().id, gacha.id);
        assert_eq!(
            library
                .list_collections()
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![game.id.as_str()]
        );
    }

    #[test]
    fn creates_updates_lists_and_deletes_collection_without_deleting_assets() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-1", "normal");

        let created = library
            .create_collection(CreateCollection {
                name: "  Reference  ".into(),
                description: Some("  Covers and poses  ".into()),
                collection_type: CollectionType::Manga,
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
                    collection_type: CollectionType::Manga,
                    year: None,
                    author: None,
                    director: None,
                    developer: None,
                    production_company: None,
                    release_date: None,
                    external_score: None,
                    my_score: None,
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
    fn deleting_collection_removes_managed_work_artwork_and_thumbnail() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(12, 18)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let prepared = library
            .prepare_work_artwork(&collection.id, &bytes.into_inner())
            .unwrap();
        let original = library.root().join(&prepared.relative_path);
        let thumbnail = library.root().join(format!(
            "work-artwork-thumbnails/{}/{}.webp",
            collection.id, prepared.id
        ));
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "mangadex",
                "cover-1",
                Some("ja"),
                &prepared,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        prepared.commit();

        library.delete_collection(&collection.id).unwrap();

        assert!(!original.exists());
        assert!(!thumbnail.exists());
    }

    #[test]
    fn validates_names_descriptions_and_duplicate_names() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .create_collection(CreateCollection {
                name: "Reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();

        for name in ["", "   "] {
            assert!(matches!(
                library.create_collection(CreateCollection {
                    name: name.into(),
                    description: None,
                    collection_type: CollectionType::Manga,
                }),
                Err(LibraryError::EmptyCollectionName)
            ));
        }
        assert!(matches!(
            library.create_collection(CreateCollection {
                name: "R".repeat(121),
                description: None,
                collection_type: CollectionType::Manga,
            }),
            Err(LibraryError::CollectionNameTooLong)
        ));
        assert!(matches!(
            library.create_collection(CreateCollection {
                name: "reference".into(),
                description: None,
                collection_type: CollectionType::Manga,
            }),
            Err(LibraryError::DuplicateCollectionName)
        ));
        assert!(matches!(
            library.create_collection(CreateCollection {
                name: "Other".into(),
                description: Some("x".repeat(2001)),
                collection_type: CollectionType::Manga,
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

    #[test]
    fn permanent_asset_delete_cascades_membership_and_clears_cover() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        insert_asset(&library, "asset-1", "normal");
        let collection = create(&library, "Reference");
        library
            .patch_asset_collections(AssetCollectionPatch {
                asset_ids: vec!["asset-1".into()],
                add_collection_ids: vec![collection.id.clone()],
                remove_collection_ids: vec![],
            })
            .unwrap();
        library
            .set_collection_cover(&collection.id, Some("asset-1"))
            .unwrap();

        library
            .connection()
            .unwrap()
            .execute("DELETE FROM assets WHERE id = 'asset-1'", [])
            .unwrap();

        let after = library.get_collection(&collection.id).unwrap();
        assert_eq!(after.asset_count, 0);
        assert_eq!(after.cover_asset_id, None);
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM collection_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn update_collection_persists_typed_metadata_and_showcase() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .create_collection(CreateCollection {
                name: "Astral Chain".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        assert_eq!(created.collection_type, CollectionType::Game);
        assert!(!created.showcase);

        let updated = library
            .update_collection(
                &created.id,
                UpdateCollection {
                    name: "Astral Chain".into(),
                    description: Some("액션 게임".into()),
                    collection_type: CollectionType::Game,
                    year: Some(2019),
                    author: Some("PlatinumGames".into()),
                    director: None,
                    developer: None,
                    production_company: None,
                    release_date: None,
                    external_score: Some(87),
                    my_score: Some(4.5),
                },
            )
            .unwrap();
        assert_eq!(updated.year, Some(2019));
        assert_eq!(updated.author.as_deref(), Some("PlatinumGames"));
        assert_eq!(updated.external_score, Some(87));

        let showcased = library.set_collection_showcase(&created.id, true).unwrap();
        assert!(showcased.showcase);
        assert!(library.list_collections().unwrap()[0].showcase);
    }

    #[test]
    fn update_collection_persists_typed_credits_date_and_half_star_rating() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .create_collection(CreateCollection {
                name: "Astral Chain".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();

        let updated = library
            .update_collection(
                &created.id,
                UpdateCollection {
                    name: "Astral Chain".into(),
                    description: None,
                    collection_type: CollectionType::Game,
                    year: Some(2019),
                    author: None,
                    director: None,
                    developer: Some("  PlatinumGames  ".into()),
                    production_company: None,
                    release_date: Some("2019-08-30".into()),
                    external_score: Some(87),
                    my_score: Some(4.5),
                },
            )
            .unwrap();

        assert_eq!(updated.developer.as_deref(), Some("PlatinumGames"));
        assert_eq!(updated.production_company, None);
        assert_eq!(updated.release_date.as_deref(), Some("2019-08-30"));
        assert_eq!(updated.my_score, Some(4.5));
    }

    #[test]
    fn update_collection_rejects_invalid_date_and_personal_rating() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = create(&library, "Invalid metadata");
        let request = |release_date: Option<&str>, my_score: Option<f64>| UpdateCollection {
            name: "Invalid metadata".into(),
            description: None,
            collection_type: CollectionType::Manga,
            year: None,
            author: None,
            director: None,
            developer: None,
            production_company: None,
            release_date: release_date.map(str::to_owned),
            external_score: None,
            my_score,
        };

        for date in ["2026-02-30", "2026-8-5", "+002026-01-01"] {
            assert!(matches!(
                library.update_collection(&created.id, request(Some(date), None)),
                Err(LibraryError::InvalidCollectionReleaseDate)
            ));
        }
        for score in [-0.5, 0.25, 5.5, f64::INFINITY] {
            assert!(matches!(
                library.update_collection(&created.id, request(None, Some(score))),
                Err(LibraryError::InvalidPersonalRating)
            ));
        }
    }

    #[test]
    fn showcase_membership_assigns_stable_order_per_type() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let first = create(&library, "First");
        let second = create(&library, "Second");

        assert_eq!(
            library
                .set_collection_showcase(&first.id, true)
                .unwrap()
                .showcase_order,
            Some(0)
        );
        assert_eq!(
            library
                .set_collection_showcase(&second.id, true)
                .unwrap()
                .showcase_order,
            Some(1)
        );
        assert_eq!(
            library
                .set_collection_showcase(&first.id, true)
                .unwrap()
                .showcase_order,
            Some(0)
        );
        let removed = library.set_collection_showcase(&first.id, false).unwrap();
        assert!(!removed.showcase);
        assert_eq!(removed.showcase_order, None);
    }

    #[test]
    fn showcase_order_ignores_hidden_gacha_rows() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let hidden = create(&library, "Hidden Gacha");
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET legacy_kind = 'gacha' WHERE id = ?1",
                [&hidden.id],
            )
            .unwrap();
        library.set_collection_showcase(&hidden.id, true).unwrap();

        let visible = create(&library, "Visible Game");
        let showcased = library.set_collection_showcase(&visible.id, true).unwrap();
        assert_eq!(showcased.showcase_order, Some(0));
    }

    #[test]
    fn reopening_preserves_manual_showcase_order_while_compacting_it() {
        let temp = tempfile::tempdir().unwrap();
        let first = {
            let library = Library::open(temp.path()).unwrap();
            let a = create(&library, "A");
            let b = create(&library, "B");
            library.set_collection_showcase(&a.id, true).unwrap();
            library.set_collection_showcase(&b.id, true).unwrap();
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE collections
                     SET showcase_order = CASE id WHEN ?1 THEN 4 WHEN ?2 THEN 9 END
                     WHERE id IN (?1, ?2)",
                    rusqlite::params![b.id, a.id],
                )
                .unwrap();
            (a.id, b.id)
        };

        let library = Library::open(temp.path()).unwrap();
        let listed = library.list_collections().unwrap();
        let order = |id: &str| {
            listed.iter().find(|item| item.id == id).unwrap().showcase_order
        };
        assert_eq!(order(&first.1), Some(0));
        assert_eq!(order(&first.0), Some(1));
    }

    #[test]
    fn ordinary_edit_preserves_imported_metadata_and_provider_identity() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = create(&library, "Imported Work");

        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections
                 SET year = 2024, author = 'Imported Author', genres = 'Fantasy',
                     overview = 'Imported overview'
                 WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        library
            .upsert_collection_external_binding(
                &created.id,
                ExternalBindingInput {
                    provider: "mangadex".into(),
                    external_id: "provider-42".into(),
                    provider_config_json: None,
                    provider_data_json: Some("{\"title\":\"Provider title\"}".into()),
                    last_synced_at: Some("2026-08-20T01:02:03Z".into()),
                },
            )
            .unwrap();
        let before = library
            .list_collection_external_bindings(&created.id)
            .unwrap();

        let updated = library
            .update_collection(
                &created.id,
                UpdateCollection {
                    name: "Renamed Work".into(),
                    description: None,
                    collection_type: CollectionType::Manga,
                    year: Some(2024),
                    author: Some("Imported Author".into()),
                    director: None,
                    developer: None,
                    production_company: None,
                    release_date: None,
                    external_score: None,
                    my_score: Some(4.5),
                },
            )
            .unwrap();

        assert_eq!(updated.name, "Renamed Work");
        assert_eq!(updated.my_score, Some(4.5));
        assert_eq!(updated.year, Some(2024));
        assert_eq!(updated.author.as_deref(), Some("Imported Author"));
        assert_eq!(updated.genres.as_deref(), Some("Fantasy"));
        assert_eq!(updated.overview.as_deref(), Some("Imported overview"));
        assert_eq!(
            library
                .list_collection_external_bindings(&created.id)
                .unwrap(),
            before
        );
    }

    #[test]
    fn summary_projects_selected_work_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = create(&library, "Dungeon Meshi");
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO collection_work_artworks (
                    id, collection_id, provider, provider_image_id, kind, relative_path,
                    mime_type, width, height, language, selected, created_at, updated_at
                 ) VALUES (
                    'art-1', ?1, 'mangadex', 'cover-1', 'cover',
                    'work-artwork/art-1.jpg', 'image/jpeg', 100, 150, 'ja', 0,
                    '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'
                 )",
                [&collection.id],
            )
            .unwrap();

        assert_eq!(
            library
                .get_collection(&collection.id)
                .unwrap()
                .selected_work_artwork_id,
            None
        );
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collection_work_artworks SET selected = 1 WHERE id = 'art-1'",
                [],
            )
            .unwrap();
        assert_eq!(
            library
                .get_collection(&collection.id)
                .unwrap()
                .selected_work_artwork_id
                .as_deref(),
            Some("art-1")
        );
    }

    #[test]
    fn collection_summary_counts_only_unread_release_events() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = create(&library, "Dungeon Meshi");
        let connection = library.connection().unwrap();
        for (id, read_at) in [
            ("event-1", None),
            ("event-2", None),
            ("event-3", Some("2026-08-22T01:00:00Z")),
        ] {
            connection
                .execute(
                    "INSERT INTO release_watch_events (
                        id, collection_id, event_kind, volume_number,
                        previous_value, current_value, detected_at, read_at
                     ) VALUES (?1, ?2, 'new_volume', 1, NULL, '2026-09-01',
                        '2026-08-22T00:00:00Z', ?3)",
                    rusqlite::params![id, collection.id, read_at],
                )
                .unwrap();
        }
        drop(connection);

        assert_eq!(
            library
                .get_collection(&collection.id)
                .unwrap()
                .unread_release_count,
            2
        );
    }

    fn create(library: &Library, name: &str) -> CollectionSummary {
        library
            .create_collection(CreateCollection {
                name: name.into(),
                description: None,
                collection_type: CollectionType::Manga,
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
