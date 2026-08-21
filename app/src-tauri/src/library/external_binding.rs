use rusqlite::{params, Connection};

use super::{
    error::LibraryError,
    models::{ExternalBinding, ExternalBindingInput},
    Library,
};

impl Library {
    pub fn list_collection_external_bindings(
        &self,
        collection_id: &str,
    ) -> Result<Vec<ExternalBinding>, LibraryError> {
        let connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let mut statement = connection.prepare(
            "SELECT provider, external_id, provider_data_json, last_synced_at,
                    created_at, updated_at
             FROM collection_external_bindings
             WHERE collection_id = ?1
             ORDER BY provider COLLATE NOCASE",
        )?;
        let bindings = statement
            .query_map([collection_id], binding_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(bindings)
    }

    pub fn upsert_collection_external_binding(
        &self,
        collection_id: &str,
        input: ExternalBindingInput,
    ) -> Result<ExternalBinding, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        let connection = self.connection()?;
        upsert_external_binding(&connection, collection_id, input, &now)
    }
}

pub(crate) fn upsert_external_binding(
    connection: &Connection,
    collection_id: &str,
    input: ExternalBindingInput,
    now: &str,
) -> Result<ExternalBinding, LibraryError> {
    super::collection::require_collection(connection, collection_id)?;
    let provider = input.provider.trim().to_ascii_lowercase();
    let external_id = input.external_id.trim().to_owned();
    if provider.is_empty() || external_id.is_empty() {
        return Err(LibraryError::InvalidExternalBinding);
    }
    connection.execute(
        "INSERT INTO collection_external_bindings (
            collection_id, provider, external_id, provider_data_json,
            last_synced_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(collection_id, provider) DO UPDATE SET
            external_id = excluded.external_id,
            provider_data_json = excluded.provider_data_json,
            last_synced_at = excluded.last_synced_at,
            updated_at = excluded.updated_at",
        params![
            collection_id,
            provider,
            external_id,
            input.provider_data_json,
            input.last_synced_at,
            now
        ],
    )?;
    binding_by_provider(connection, collection_id, &provider)
}

fn binding_by_provider(
    connection: &Connection,
    collection_id: &str,
    provider: &str,
) -> Result<ExternalBinding, LibraryError> {
    Ok(connection.query_row(
        "SELECT provider, external_id, provider_data_json, last_synced_at,
                created_at, updated_at
         FROM collection_external_bindings
         WHERE collection_id = ?1 AND provider = ?2",
        params![collection_id, provider],
        binding_from_row,
    )?)
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExternalBinding> {
    Ok(ExternalBinding {
        provider: row.get(0)?,
        external_id: row.get(1)?,
        provider_data_json: row.get(2)?,
        last_synced_at: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use crate::library::{
        error::LibraryError,
        models::{CollectionType, CreateCollection, ExternalBindingInput},
        Library,
    };

    fn create_manga(library: &Library, name: &str) -> String {
        library
            .create_collection(CreateCollection {
                name: name.into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap()
            .id
    }

    fn binding(provider: &str, external_id: &str) -> ExternalBindingInput {
        ExternalBindingInput {
            provider: provider.into(),
            external_id: external_id.into(),
            provider_data_json: None,
            last_synced_at: None,
        }
    }

    #[test]
    fn stores_multiple_normalized_bindings_and_replaces_one_provider() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_manga(&library, "Dungeon Meshi");

        library
            .upsert_collection_external_binding(
                &work_id,
                ExternalBindingInput {
                    provider: " MangaDex ".into(),
                    external_id: " md-1 ".into(),
                    provider_data_json: Some("{\"title\":\"Dungeon Meshi\"}".into()),
                    last_synced_at: Some("2026-08-20T01:00:00Z".into()),
                },
            )
            .unwrap();
        library
            .upsert_collection_external_binding(&work_id, binding("aladin", "item-1"))
            .unwrap();
        library
            .upsert_collection_external_binding(
                &work_id,
                ExternalBindingInput {
                    provider: "MANGADEX".into(),
                    external_id: "md-2".into(),
                    provider_data_json: Some("{\"title\":\"Delicious in Dungeon\"}".into()),
                    last_synced_at: Some("2026-08-20T02:00:00Z".into()),
                },
            )
            .unwrap();

        let bindings = library.list_collection_external_bindings(&work_id).unwrap();
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].provider, "aladin");
        assert_eq!(bindings[1].provider, "mangadex");
        assert_eq!(bindings[1].external_id, "md-2");
        assert_eq!(
            bindings[1].provider_data_json.as_deref(),
            Some("{\"title\":\"Delicious in Dungeon\"}")
        );
        assert_eq!(
            bindings[1].last_synced_at.as_deref(),
            Some("2026-08-20T02:00:00Z")
        );
    }

    #[test]
    fn rejects_blank_provider_or_external_id() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_manga(&library, "Witch Hat Atelier");

        for input in [binding("  ", "id"), binding("mangadex", "  ")] {
            assert!(matches!(
                library.upsert_collection_external_binding(&work_id, input),
                Err(LibraryError::InvalidExternalBinding)
            ));
        }
        assert!(library
            .list_collection_external_bindings(&work_id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_bindings_for_a_missing_collection() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        assert!(matches!(
            library.upsert_collection_external_binding("missing", binding("mangadex", "md-1")),
            Err(LibraryError::CollectionNotFound)
        ));
        assert!(matches!(
            library.list_collection_external_bindings("missing"),
            Err(LibraryError::CollectionNotFound)
        ));
    }

    #[test]
    fn deleting_a_collection_cascades_its_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work_id = create_manga(&library, "Land of the Lustrous");
        library
            .upsert_collection_external_binding(&work_id, binding("mangadex", "md-1"))
            .unwrap();

        library.delete_collection(&work_id).unwrap();

        let count: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_external_bindings WHERE collection_id = ?1",
                [&work_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
