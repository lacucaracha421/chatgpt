use rusqlite::{params, OptionalExtension};

use super::{
    collection::{collection_by_id, map_duplicate_name, normalized_name, require_collection},
    error::LibraryError,
    external_binding::upsert_external_binding,
    mangadex::{self, MangaDexFetchedWork},
    models::{
        CollectionSummary, ExternalBindingInput, MangaDexApplyRequest, MangaDexApplyTarget,
        MangaDexConnection, MangaDexSearchResult, MangaDexWorkPreview,
    },
    Library,
};

const PROVIDER: &str = "mangadex";

impl Library {
    pub fn search_mangadex(&self, query: &str) -> Result<Vec<MangaDexSearchResult>, LibraryError> {
        mangadex::search(query)
    }

    pub fn preview_mangadex(&self, manga_id: &str) -> Result<MangaDexWorkPreview, LibraryError> {
        Ok(mangadex::fetch_work(manga_id)?.preview)
    }

    pub fn get_mangadex_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<MangaDexConnection>, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        connection
            .query_row(
                "SELECT external_id, last_synced_at
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, PROVIDER],
                |row| {
                    Ok(MangaDexConnection {
                        manga_id: row.get(0)?,
                        last_synced_at: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn apply_mangadex(
        &self,
        request: MangaDexApplyRequest,
    ) -> Result<CollectionSummary, LibraryError> {
        let fetched = mangadex::fetch_work(&request.manga_id)?;
        let cover = fetched
            .preview
            .covers
            .iter()
            .find(|cover| cover.cover_id == request.cover_id)
            .ok_or(LibraryError::InvalidMangaDexIdentity)?;
        let bytes = mangadex::download_cover(&request.manga_id, &cover.file_name)?;
        self.apply_fetched_mangadex(request, fetched, &bytes)
    }

    pub(crate) fn apply_fetched_mangadex(
        &self,
        request: MangaDexApplyRequest,
        fetched: MangaDexFetchedWork,
        cover_bytes: &[u8],
    ) -> Result<CollectionSummary, LibraryError> {
        if request.manga_id != fetched.preview.manga_id {
            return Err(LibraryError::InvalidMangaDexIdentity);
        }
        let cover = fetched
            .preview
            .covers
            .iter()
            .find(|cover| cover.cover_id == request.cover_id)
            .ok_or(LibraryError::InvalidMangaDexIdentity)?;
        let cover_file_name = cover.file_name.clone();
        let cover_language = cover.language.clone();
        let (collection_id, new_name) = match &request.target {
            MangaDexApplyTarget::New { name } => (
                uuid::Uuid::new_v4().to_string(),
                Some(normalized_name(name.clone())?),
            ),
            MangaDexApplyTarget::Existing { collection_id } => {
                let connection = self.connection()?;
                let collection_type: Option<String> = connection
                    .query_row(
                        "SELECT type FROM collections WHERE id = ?1",
                        [collection_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match collection_type.as_deref() {
                    Some("manga") => {}
                    Some(_) => return Err(LibraryError::InvalidCollectionType),
                    None => return Err(LibraryError::CollectionNotFound),
                }
                (collection_id.clone(), None)
            }
        };
        mangadex::validate_cover_identity(&request.manga_id, &cover_file_name)?;
        let prepared = self.prepare_work_artwork(&collection_id, cover_bytes)?;
        {
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            let owner: Option<String> = transaction
                .query_row(
                    "SELECT collection_id FROM collection_external_bindings
                     WHERE provider = ?1 AND external_id = ?2 AND collection_id != ?3
                     LIMIT 1",
                    params![PROVIDER, request.manga_id, collection_id],
                    |row| row.get(0),
                )
                .optional()?;
            if owner.is_some() {
                return Err(LibraryError::DuplicateProviderBinding);
            }
            let now = chrono::Utc::now().to_rfc3339();
            if let Some(name) = new_name {
                transaction
                    .execute(
                        "INSERT INTO collections (
                            id, name, description, type, cover_asset_id,
                            year, author, director, external_score, my_score,
                            genres, overview, showcase, created_at, updated_at
                         ) VALUES (?1, ?2, NULL, 'manga', NULL,
                            ?3, ?4, NULL, NULL, NULL, ?5, ?6, 0, ?7, ?7)",
                        params![
                            collection_id,
                            name,
                            fetched.preview.year,
                            fetched.preview.author,
                            fetched.preview.genres,
                            fetched.preview.overview,
                            now,
                        ],
                    )
                    .map_err(map_duplicate_name)?;
            } else {
                fill_blank_provider_fields(&transaction, &collection_id, &fetched.preview, &now)?;
            }
            upsert_external_binding(
                &transaction,
                &collection_id,
                ExternalBindingInput {
                    provider: PROVIDER.into(),
                    external_id: request.manga_id.clone(),
                    provider_data_json: Some(fetched.snapshot_json),
                    last_synced_at: Some(now.clone()),
                },
                &now,
            )?;
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection_id,
                PROVIDER,
                &request.cover_id,
                cover_language.as_deref(),
                &prepared,
            )?;
            transaction.commit()?;
        }
        prepared.commit();
        let connection = self.connection()?;
        collection_by_id(&connection, &collection_id)
    }

    pub fn refresh_mangadex(&self, collection_id: &str) -> Result<CollectionSummary, LibraryError> {
        let connection = self
            .get_mangadex_connection(collection_id)?
            .ok_or(LibraryError::InvalidMangaDexIdentity)?;
        let fetched = mangadex::fetch_work(&connection.manga_id)?;
        self.refresh_fetched_mangadex(collection_id, fetched)
    }

    pub(crate) fn refresh_fetched_mangadex(
        &self,
        collection_id: &str,
        fetched: MangaDexFetchedWork,
    ) -> Result<CollectionSummary, LibraryError> {
        let connection = self
            .get_mangadex_connection(collection_id)?
            .ok_or(LibraryError::InvalidMangaDexIdentity)?;
        if connection.manga_id != fetched.preview.manga_id {
            return Err(LibraryError::InvalidMangaDexIdentity);
        }
        {
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            let now = chrono::Utc::now().to_rfc3339();
            fill_blank_provider_fields(&transaction, collection_id, &fetched.preview, &now)?;
            upsert_external_binding(
                &transaction,
                collection_id,
                ExternalBindingInput {
                    provider: PROVIDER.into(),
                    external_id: fetched.preview.manga_id,
                    provider_data_json: Some(fetched.snapshot_json),
                    last_synced_at: Some(now.clone()),
                },
                &now,
            )?;
            transaction.commit()?;
        }
        let connection = self.connection()?;
        collection_by_id(&connection, collection_id)
    }
}

fn fill_blank_provider_fields(
    connection: &rusqlite::Connection,
    collection_id: &str,
    preview: &MangaDexWorkPreview,
    now: &str,
) -> Result<(), LibraryError> {
    connection.execute(
        "UPDATE collections SET
            year = CASE WHEN year IS NULL THEN ?1 ELSE year END,
            author = CASE WHEN author IS NULL OR trim(author) = '' THEN ?2 ELSE author END,
            genres = CASE WHEN genres IS NULL OR trim(genres) = '' THEN ?3 ELSE genres END,
            overview = CASE WHEN overview IS NULL OR trim(overview) = '' THEN ?4 ELSE overview END,
            updated_at = ?5
         WHERE id = ?6",
        params![
            preview.year,
            preview.author,
            preview.genres,
            preview.overview,
            now,
            collection_id,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, ImageFormat};

    use crate::library::{
        error::LibraryError,
        mangadex::{parse_work_preview, MangaDexFetchedWork},
        models::{CollectionType, CreateCollection, MangaDexApplyRequest, MangaDexApplyTarget},
        Library,
    };

    const MANGA_ID: &str = "d1a9fdeb-f713-407f-960c-8326b586e6fd";
    const COVER_ID: &str = "11111111-1111-4111-8111-111111111111";

    fn fetched(snapshot: &str) -> MangaDexFetchedWork {
        MangaDexFetchedWork {
            preview: parse_work_preview(
                include_str!("fixtures/mangadex_detail.json"),
                include_str!("fixtures/mangadex_covers.json"),
            )
            .unwrap(),
            snapshot_json: snapshot.into(),
        }
    }

    fn cover_bytes() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(120, 180)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn new_apply_commits_collection_binding_and_selected_artwork_together() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let created = library
            .apply_fetched_mangadex(
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::New {
                        name: "  던전밥 소장판  ".into(),
                    },
                    manga_id: MANGA_ID.into(),
                    cover_id: COVER_ID.into(),
                },
                fetched("snapshot-v1"),
                &cover_bytes(),
            )
            .unwrap();

        assert_eq!(created.name, "던전밥 소장판");
        assert_eq!(created.author.as_deref(), Some("Ryoko Kui"));
        assert_eq!(created.year, Some(2014));
        assert_eq!(created.genres.as_deref(), Some("Fantasy, 모험"));
        assert_eq!(
            created.overview.as_deref(),
            Some("던전을 탐험하며 마물을 요리하는 이야기.")
        );
        assert!(created.selected_work_artwork_id.is_some());
        let binding = library
            .get_mangadex_connection(&created.id)
            .unwrap()
            .unwrap();
        assert_eq!(binding.manga_id, MANGA_ID);
        assert!(binding.last_synced_at.is_some());
        let stored_snapshot: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT provider_data_json FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = 'mangadex'",
                [&created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_snapshot, "snapshot-v1");
        assert!(library
            .resolve_work_artwork(created.selected_work_artwork_id.as_deref().unwrap())
            .is_ok());
    }

    #[test]
    fn existing_apply_fills_only_blank_provider_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let existing = library
            .create_collection(CreateCollection {
                name: "내가 정한 제목".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections
                 SET year = 2020, author = '내 작가', genres = '   ', overview = NULL
                 WHERE id = ?1",
                [&existing.id],
            )
            .unwrap();

        let updated = library
            .apply_fetched_mangadex(
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::Existing {
                        collection_id: existing.id.clone(),
                    },
                    manga_id: MANGA_ID.into(),
                    cover_id: COVER_ID.into(),
                },
                fetched("snapshot-v1"),
                &cover_bytes(),
            )
            .unwrap();

        assert_eq!(updated.name, "내가 정한 제목");
        assert_eq!(updated.year, Some(2020));
        assert_eq!(updated.author.as_deref(), Some("내 작가"));
        assert_eq!(updated.genres.as_deref(), Some("Fantasy, 모험"));
        assert_eq!(
            updated.overview.as_deref(),
            Some("던전을 탐험하며 마물을 요리하는 이야기.")
        );
        assert!(updated.selected_work_artwork_id.is_some());
    }

    #[test]
    fn duplicate_provider_identity_rolls_back_and_removes_the_prepared_file() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let request = |name: &str| MangaDexApplyRequest {
            target: MangaDexApplyTarget::New { name: name.into() },
            manga_id: MANGA_ID.into(),
            cover_id: COVER_ID.into(),
        };
        library
            .apply_fetched_mangadex(request("첫 Work"), fetched("snapshot-v1"), &cover_bytes())
            .unwrap();
        let files_before = artwork_file_count(&library);

        let duplicate = library.apply_fetched_mangadex(
            request("중복 Work"),
            fetched("snapshot-v2"),
            &cover_bytes(),
        );

        assert!(matches!(
            duplicate,
            Err(LibraryError::DuplicateProviderBinding)
        ));
        assert_eq!(library.list_collections().unwrap().len(), 1);
        assert_eq!(artwork_file_count(&library), files_before);
    }

    #[test]
    fn refresh_updates_snapshot_and_blanks_without_touching_local_values_or_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::New {
                        name: "로컬 제목".into(),
                    },
                    manga_id: MANGA_ID.into(),
                    cover_id: COVER_ID.into(),
                },
                fetched("snapshot-v1"),
                &cover_bytes(),
            )
            .unwrap();
        let selected_artwork = created.selected_work_artwork_id.clone();
        let files_before = artwork_file_count(&library);
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections
                 SET year = 2020, author = '내 작가', genres = '', overview = NULL
                 WHERE id = ?1",
                [&created.id],
            )
            .unwrap();

        let refreshed = library
            .refresh_fetched_mangadex(&created.id, fetched("snapshot-v2"))
            .unwrap();

        assert_eq!(refreshed.name, "로컬 제목");
        assert_eq!(refreshed.year, Some(2020));
        assert_eq!(refreshed.author.as_deref(), Some("내 작가"));
        assert_eq!(refreshed.genres.as_deref(), Some("Fantasy, 모험"));
        assert_eq!(
            refreshed.overview.as_deref(),
            Some("던전을 탐험하며 마물을 요리하는 이야기.")
        );
        assert_eq!(refreshed.selected_work_artwork_id, selected_artwork);
        assert_eq!(artwork_file_count(&library), files_before);
        let snapshot: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT provider_data_json FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = 'mangadex'",
                [&created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot, "snapshot-v2");
    }

    fn artwork_file_count(library: &Library) -> usize {
        std::fs::read_dir(library.root().join("work-artwork"))
            .unwrap()
            .flatten()
            .filter_map(|entry| std::fs::read_dir(entry.path()).ok())
            .flat_map(Iterator::flatten)
            .filter(|entry| entry.path().is_file())
            .count()
    }
}
