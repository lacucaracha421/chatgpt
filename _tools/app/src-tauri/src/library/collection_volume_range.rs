use rusqlite::{Connection, OptionalExtension, Transaction};

use super::{
    collection::{collection_by_id, require_collection},
    collection_personal_edits::bump_collections_generation,
    error::LibraryError,
    models::CollectionSummary,
    Library,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct CollectionVolumeRange {
    pub(crate) min_volume: Option<i64>,
    pub(crate) max_volume: Option<i64>,
    pub(crate) hide_connection_prompt: bool,
}

impl CollectionVolumeRange {
    pub(crate) fn contains(self, volume_number: i64) -> bool {
        self.min_volume.is_none_or(|min| volume_number >= min)
            && self.max_volume.is_none_or(|max| volume_number <= max)
    }
}

pub(crate) fn load(
    connection: &Connection,
    collection_id: &str,
) -> Result<CollectionVolumeRange, LibraryError> {
    connection
        .query_row(
            "SELECT min_volume, max_volume, hide_connection_prompt
             FROM collection_volume_ranges WHERE collection_id = ?1",
            [collection_id],
            |row| {
                Ok(CollectionVolumeRange {
                    min_volume: row.get(0)?,
                    max_volume: row.get(1)?,
                    hide_connection_prompt: row.get::<_, i64>(2)? != 0,
                })
            },
        )
        .optional()
        .map(|range| range.unwrap_or_default())
        .map_err(Into::into)
}

pub(crate) fn load_transaction(
    transaction: &Transaction<'_>,
    collection_id: &str,
) -> Result<CollectionVolumeRange, LibraryError> {
    load(transaction, collection_id)
}

fn validate(min_volume: Option<i64>, max_volume: Option<i64>) -> Result<(), LibraryError> {
    if min_volume.is_some_and(|value| !(0..=9999).contains(&value))
        || max_volume.is_some_and(|value| !(0..=9999).contains(&value))
        || matches!((min_volume, max_volume), (Some(min), Some(max)) if max < min)
    {
        return Err(LibraryError::InvalidCollectionMetadata);
    }
    Ok(())
}

impl Library {
    pub fn set_collection_volume_range(
        &self,
        collection_id: &str,
        min_volume: Option<i64>,
        max_volume: Option<i64>,
        hide_connection_prompt: bool,
    ) -> Result<CollectionSummary, LibraryError> {
        validate(min_volume, max_volume)?;
        let mut connection = self.connection()?;
        let authority = super::collection_authority::collection_write_status(&connection)?;
        require_collection(&connection, collection_id)?;
        let collection_type: String = connection.query_row(
            "SELECT type FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        if collection_type != "manga" {
            return Err(LibraryError::InvalidCollectionType);
        }

        let current = load(&connection, collection_id)?;
        let desired = CollectionVolumeRange {
            min_volume,
            max_volume,
            hide_connection_prompt,
        };
        let row_exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_volume_ranges WHERE collection_id = ?1)",
            [collection_id],
            |row| row.get(0),
        )?;
        if current == desired && (desired != CollectionVolumeRange::default() || !row_exists) {
            return collection_by_id(&connection, collection_id);
        }

        let transaction = connection.transaction()?;
        if authority.active {
            if current != desired {
                super::collection_authority::enqueue_collection_command(
                    &transaction,
                    &authority,
                    "setVolumeRange",
                    collection_id,
                    serde_json::json!({
                        "workId":collection_id,"minVolume":min_volume,"maxVolume":max_volume,"hideConnectionPrompt":hide_connection_prompt,
                        "expectedRange":super::collection_authority::expected_volume_range(&transaction,collection_id)?,"expectedRevision":null
                    }),
                )?;
            }
        }
        if desired == CollectionVolumeRange::default() {
            transaction.execute(
                "DELETE FROM collection_volume_ranges WHERE collection_id = ?1",
                [collection_id],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO collection_volume_ranges(
                    collection_id, min_volume, max_volume, hide_connection_prompt, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(collection_id) DO UPDATE SET
                    min_volume = excluded.min_volume,
                    max_volume = excluded.max_volume,
                    hide_connection_prompt = excluded.hide_connection_prompt,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    collection_id,
                    desired.min_volume,
                    desired.max_volume,
                    desired.hide_connection_prompt as i64,
                    chrono::Utc::now().to_rfc3339(),
                ],
            )?;
        }
        bump_collections_generation(&transaction)?;
        transaction.commit()?;
        collection_by_id(&connection, collection_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        models::{CollectionType, CreateCollection},
        Library,
    };

    fn library_with_collections() -> (tempfile::TempDir, Library, String, String) {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let first = library
            .create_collection(CreateCollection {
                name: "Part 1".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap()
            .id;
        let second = library
            .create_collection(CreateCollection {
                name: "Part 2".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap()
            .id;
        {
            let connection = library.connection().unwrap();
            for collection_id in [&first, &second] {
                connection.execute(
                    "INSERT INTO collection_mangadex_baselines(collection_id,manga_id)
                     VALUES(?1,'550e8400-e29b-41d4-a716-446655440000')",
                    [collection_id],
                ).unwrap();
                for volume in [1, 12, 23] {
                    connection.execute(
                        "INSERT INTO collection_volumes(
                            id,collection_id,volume_number,edition_index,sort_order,created_at,updated_at
                         ) VALUES(?1,?2,?3,0,?3,'t','t')",
                        rusqlite::params![format!("{collection_id}-{volume}"), collection_id, volume],
                    ).unwrap();
                }
            }
        }
        (temp, library, first, second)
    }

    #[test]
    fn range_is_per_collection_and_clearing_restores_hidden_volumes() {
        let (_temp, library, first, second) = library_with_collections();
        let before_generation: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='collections'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let summary = library
            .set_collection_volume_range(&first, Some(1), Some(11), true)
            .unwrap();
        assert_eq!(summary.min_volume, Some(1));
        assert_eq!(summary.max_volume, Some(11));
        assert!(summary.hide_connection_prompt);
        assert_eq!(
            library
                .list_collection_volumes(&first)
                .unwrap()
                .iter()
                .map(|v| v.volume_number)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            library
                .list_collection_volumes(&second)
                .unwrap()
                .iter()
                .map(|v| v.volume_number)
                .collect::<Vec<_>>(),
            vec![1, 12, 23]
        );
        let after_generation: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='collections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_generation, before_generation + 1);

        library
            .set_collection_volume_range(&first, None, None, false)
            .unwrap();
        assert_eq!(
            library
                .list_collection_volumes(&first)
                .unwrap()
                .iter()
                .map(|v| v.volume_number)
                .collect::<Vec<_>>(),
            vec![1, 12, 23]
        );
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM collection_volume_ranges WHERE collection_id=?1",
                    [&first],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn non_manga_collections_cannot_store_a_volume_range() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let game = library
            .create_collection(CreateCollection {
                name: "Game".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        assert!(matches!(
            library.set_collection_volume_range(&game.id, Some(1), Some(2), false),
            Err(LibraryError::InvalidCollectionType)
        ));
    }
}
