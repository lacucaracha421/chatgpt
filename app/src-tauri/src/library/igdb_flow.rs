use rusqlite::{params, OptionalExtension};

use super::{
    collection::{collection_by_id, map_duplicate_name, normalized_name, require_collection},
    credential,
    error::LibraryError,
    external_binding::upsert_external_binding,
    igdb::{self, IgdbImageSize},
    models::{
        CollectionSummary, ExternalBindingInput, IgdbApplyRequest, IgdbConnection, IgdbGamePreview,
        IgdbImageCandidate, IgdbImageRef, IgdbRemoteGame, IgdbSearchResult,
    },
    work_artwork::WorkArtworkKind,
    Library,
};

const PROVIDER: &str = "igdb";

impl Library {
    pub fn search_igdb_games(&self, query: &str) -> Result<Vec<IgdbSearchResult>, LibraryError> {
        let credentials = credential::read_igdb_credentials_os()?;
        self.igdb_client()
            .search(&credentials, query)
            .map(|games| games.into_iter().map(search_result).collect())
    }

    pub fn preview_igdb_game(&self, game_id: i64) -> Result<IgdbGamePreview, LibraryError> {
        let credentials = credential::read_igdb_credentials_os()?;
        let game = self.igdb_client().game(&credentials, game_id)?;
        Ok(game_preview(&game))
    }

    pub fn apply_igdb_game(
        &self,
        request: IgdbApplyRequest,
    ) -> Result<CollectionSummary, LibraryError> {
        let credentials = credential::read_igdb_credentials_os()?;
        let client = self.igdb_client();
        let fetched = client.game(&credentials, request.game_id)?;
        let (cover, hero) = validated_selection(&request, &fetched)?;
        let cover_bytes = cover
            .map(|candidate| client.download_original(&candidate.image_id))
            .transpose()?;
        let hero_bytes = hero
            .map(|candidate| client.download_original(&candidate.image_id))
            .transpose()?;
        self.apply_fetched_igdb_game(
            request,
            fetched,
            cover_bytes.as_deref(),
            hero_bytes.as_deref(),
        )
    }

    pub fn get_igdb_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<IgdbConnection>, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        let binding: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT external_id, last_synced_at
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, PROVIDER],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        binding
            .map(|(external_id, last_synced_at)| {
                let game_id = external_id
                    .parse::<i64>()
                    .ok()
                    .filter(|id| *id > 0)
                    .ok_or(LibraryError::InvalidIgdbIdentity)?;
                Ok(IgdbConnection {
                    game_id,
                    last_synced_at,
                })
            })
            .transpose()
    }

    pub(crate) fn apply_fetched_igdb_game(
        &self,
        request: IgdbApplyRequest,
        fetched: IgdbRemoteGame,
        cover_bytes: Option<&[u8]>,
        hero_bytes: Option<&[u8]>,
    ) -> Result<CollectionSummary, LibraryError> {
        let (cover, hero) = validated_selection(&request, &fetched)?;
        let collection_id = uuid::Uuid::new_v4().to_string();
        let cover = match (cover, cover_bytes) {
            (Some(candidate), Some(bytes)) => {
                Some((candidate, self.prepare_work_artwork(&collection_id, bytes)?))
            }
            (None, None) => None,
            _ => return Err(LibraryError::InvalidIgdbIdentity),
        };
        let hero = match (hero, hero_bytes) {
            (Some(candidate), Some(bytes)) => {
                Some((candidate, self.prepare_work_artwork(&collection_id, bytes)?))
            }
            (None, None) => None,
            _ => return Err(LibraryError::InvalidIgdbIdentity),
        };
        let name = normalized_name(fetched.name.clone())?;
        let snapshot_json = normalized_snapshot(&fetched.snapshot_json)?;
        let year = fetched
            .release_date
            .as_deref()
            .and_then(|date| date.get(..4))
            .and_then(|year| year.parse::<i64>().ok());
        let developer = normalized_optional(fetched.developer.as_deref());
        let publisher = normalized_optional(fetched.publisher.as_deref());
        let platforms = joined(&fetched.platforms);
        let genres = joined(&fetched.genres);
        let now = chrono::Utc::now().to_rfc3339();

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let owner: Option<String> = transaction
            .query_row(
                "SELECT collection_id FROM collection_external_bindings
                 WHERE provider = ?1 AND external_id = ?2
                 LIMIT 1",
                params![PROVIDER, fetched.id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if owner.is_some() {
            return Err(LibraryError::DuplicateProviderBinding);
        }
        transaction
            .execute(
                "INSERT INTO collections (
                    id, name, description, type, cover_asset_id,
                    year, author, director, developer, publisher, platforms,
                    production_company, release_date, external_score, my_score,
                    genres, overview, showcase, created_at, updated_at
                 ) VALUES (?1, ?2, NULL, 'game', NULL,
                    ?3, NULL, NULL, ?4, ?5, ?6,
                    NULL, ?7, NULL, NULL, ?8, ?9, 0, ?10, ?10)",
                params![
                    collection_id,
                    name,
                    year,
                    developer,
                    publisher,
                    platforms,
                    fetched.release_date,
                    genres,
                    fetched.summary,
                    now,
                ],
            )
            .map_err(map_duplicate_name)?;
        upsert_external_binding(
            &transaction,
            &collection_id,
            ExternalBindingInput {
                provider: PROVIDER.into(),
                external_id: fetched.id.to_string(),
                provider_config_json: None,
                provider_data_json: Some(snapshot_json),
                last_synced_at: Some(now.clone()),
            },
            &now,
        )?;
        if let Some((candidate, prepared)) = cover.as_ref() {
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection_id,
                PROVIDER,
                &candidate.image_id,
                WorkArtworkKind::Cover,
                None,
                prepared,
            )?;
        }
        if let Some((candidate, prepared)) = hero.as_ref() {
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection_id,
                PROVIDER,
                &candidate.image_id,
                WorkArtworkKind::Hero,
                None,
                prepared,
            )?;
        }
        transaction.commit()?;
        if let Some((_, prepared)) = cover {
            prepared.commit();
        }
        if let Some((_, prepared)) = hero {
            prepared.commit();
        }
        drop(connection);
        let connection = self.connection()?;
        collection_by_id(&connection, &collection_id)
    }
}

fn validated_selection<'a>(
    request: &IgdbApplyRequest,
    fetched: &'a IgdbRemoteGame,
) -> Result<(Option<&'a IgdbImageRef>, Option<&'a IgdbImageRef>), LibraryError> {
    if request.game_id <= 0 || fetched.id <= 0 || request.game_id != fetched.id {
        return Err(LibraryError::InvalidIgdbIdentity);
    }
    let cover = request
        .cover_image_id
        .as_deref()
        .map(|image_id| {
            igdb::IgdbClient::image_url(image_id, IgdbImageSize::Original)?;
            fetched
                .cover
                .as_ref()
                .filter(|candidate| candidate.image_id == image_id)
                .ok_or(LibraryError::InvalidIgdbIdentity)
        })
        .transpose()?;
    let hero_candidates = if fetched.artworks.is_empty() {
        &fetched.screenshots
    } else {
        &fetched.artworks
    };
    let hero = request
        .hero_image_id
        .as_deref()
        .map(|image_id| {
            igdb::IgdbClient::image_url(image_id, IgdbImageSize::Original)?;
            hero_candidates
                .iter()
                .find(|candidate| candidate.image_id == image_id)
                .ok_or(LibraryError::InvalidIgdbIdentity)
        })
        .transpose()?;
    Ok((cover, hero))
}

fn search_result(game: IgdbRemoteGame) -> IgdbSearchResult {
    IgdbSearchResult {
        game_id: game.id,
        title: game.name,
        developer: game.developer,
        release_date: game.release_date,
        cover: game.cover.map(image_candidate),
    }
}

fn game_preview(game: &IgdbRemoteGame) -> IgdbGamePreview {
    IgdbGamePreview {
        game_id: game.id,
        proposed_title: game.name.clone(),
        developer: game.developer.clone(),
        publisher: game.publisher.clone(),
        release_date: game.release_date.clone(),
        platforms: game.platforms.clone(),
        genres: game.genres.clone(),
        overview: game.summary.clone(),
        covers: game
            .cover
            .clone()
            .into_iter()
            .map(image_candidate)
            .collect(),
        artworks: game.artworks.iter().cloned().map(image_candidate).collect(),
        screenshots: game
            .screenshots
            .iter()
            .cloned()
            .map(image_candidate)
            .collect(),
    }
}

fn image_candidate(image: IgdbImageRef) -> IgdbImageCandidate {
    IgdbImageCandidate {
        image_id: image.image_id,
        width: image.width,
        height: image.height,
    }
}

fn normalized_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn joined(values: &[String]) -> Option<String> {
    let values = values
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.join(" · "))
}

fn normalized_snapshot(snapshot_json: &str) -> Result<String, LibraryError> {
    let value: serde_json::Value =
        serde_json::from_str(snapshot_json).map_err(|_| LibraryError::IgdbInvalidResponse)?;
    serde_json::to_string(&value).map_err(|_| LibraryError::IgdbInvalidResponse)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, ImageFormat};

    use crate::library::{
        error::LibraryError,
        models::{
            CollectionType, CreateCollection, IgdbApplyRequest, IgdbImageRef, IgdbRemoteGame,
        },
        Library,
    };

    fn remote() -> IgdbRemoteGame {
        IgdbRemoteGame {
            id: 42,
            name: "Jet Set Radio".into(),
            summary: Some("A stylish skating game.".into()),
            release_date: Some("1999-06-01".into()),
            genres: vec!["Action".into(), "Music".into()],
            platforms: vec!["Dreamcast".into(), "Windows".into()],
            developer: Some("Smilebit".into()),
            publisher: Some("Sega".into()),
            cover: Some(IgdbImageRef {
                image_id: "cover-1".into(),
                width: Some(264),
                height: Some(374),
            }),
            artworks: vec![IgdbImageRef {
                image_id: "artwork-1".into(),
                width: Some(1920),
                height: Some(1080),
            }],
            screenshots: vec![IgdbImageRef {
                image_id: "screenshot-1".into(),
                width: Some(1280),
                height: Some(720),
            }],
            snapshot_json: "{\"id\":42}".into(),
        }
    }

    fn request(cover_image_id: Option<&str>, hero_image_id: Option<&str>) -> IgdbApplyRequest {
        IgdbApplyRequest {
            game_id: 42,
            cover_image_id: cover_image_id.map(str::to_owned),
            hero_image_id: hero_image_id.map(str::to_owned),
        }
    }

    fn image_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
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

    #[test]
    fn applies_game_binding_cover_and_hero_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let cover = image_bytes(264, 374);
        let hero = image_bytes(1920, 1080);

        let created = library
            .apply_fetched_igdb_game(
                request(Some("cover-1"), Some("artwork-1")),
                remote(),
                Some(&cover),
                Some(&hero),
            )
            .unwrap();

        assert_eq!(created.name, "Jet Set Radio");
        assert_eq!(created.developer.as_deref(), Some("Smilebit"));
        assert_eq!(created.publisher.as_deref(), Some("Sega"));
        assert_eq!(created.platforms.as_deref(), Some("Dreamcast · Windows"));
        assert_eq!(created.genres.as_deref(), Some("Action · Music"));
        assert_eq!(created.release_date.as_deref(), Some("1999-06-01"));
        assert_eq!(created.overview.as_deref(), Some("A stylish skating game."));
        assert_eq!(created.my_score, None);
        assert!(created.selected_work_artwork_id.is_some());
        assert!(created.selected_hero_artwork_id.is_some());

        let binding = library.get_igdb_connection(&created.id).unwrap().unwrap();
        assert_eq!(binding.game_id, 42);
        assert!(binding.last_synced_at.is_some());
        let stored_snapshot: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT provider_data_json FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = 'igdb'",
                [&created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_snapshot, "{\"id\":42}");
    }

    #[test]
    fn no_cover_or_hero_import_succeeds_without_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let created = library
            .apply_fetched_igdb_game(request(None, None), remote(), None, None)
            .unwrap();

        assert_eq!(created.name, "Jet Set Radio");
        assert!(created.selected_work_artwork_id.is_none());
        assert!(created.selected_hero_artwork_id.is_none());
        assert!(library.get_igdb_connection(&created.id).unwrap().is_some());
        assert_eq!(artwork_file_count(&library), 0);
    }

    #[test]
    fn invalid_cover_or_hero_candidate_is_rejected_before_preparation() {
        for (cover_id, hero_id) in [
            (Some("not-a-cover"), Some("artwork-1")),
            (Some("cover-1"), Some("not-an-artwork")),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let library = Library::open(temp.path()).unwrap();
            let cover = image_bytes(264, 374);
            let hero = image_bytes(1920, 1080);

            let result = library.apply_fetched_igdb_game(
                request(cover_id, hero_id),
                remote(),
                Some(&cover),
                Some(&hero),
            );

            assert!(matches!(result, Err(LibraryError::InvalidIgdbIdentity)));
            assert_eq!(library.list_collections().unwrap().len(), 0);
            assert_eq!(artwork_file_count(&library), 0);
        }
    }

    #[test]
    fn hero_uses_screenshot_candidates_when_no_artworks_exist() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let mut fetched = remote();
        fetched.artworks.clear();
        let hero = image_bytes(1280, 720);

        let created = library
            .apply_fetched_igdb_game(
                request(None, Some("screenshot-1")),
                fetched,
                None,
                Some(&hero),
            )
            .unwrap();

        assert!(created.selected_hero_artwork_id.is_some());
        let provider_image_id: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT provider_image_id FROM collection_work_artworks
                 WHERE collection_id = ?1 AND kind = 'hero'",
                [&created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(provider_image_id, "screenshot-1");
    }

    #[test]
    fn duplicate_binding_leaves_no_prepared_files() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let cover = image_bytes(264, 374);
        let hero = image_bytes(1920, 1080);
        library
            .apply_fetched_igdb_game(
                request(Some("cover-1"), Some("artwork-1")),
                remote(),
                Some(&cover),
                Some(&hero),
            )
            .unwrap();
        let files_before = artwork_file_count(&library);

        let duplicate = library.apply_fetched_igdb_game(
            request(Some("cover-1"), Some("artwork-1")),
            remote(),
            Some(&cover),
            Some(&hero),
        );

        assert!(matches!(
            duplicate,
            Err(LibraryError::DuplicateProviderBinding)
        ));
        assert_eq!(library.list_collections().unwrap().len(), 1);
        assert_eq!(artwork_file_count(&library), files_before);
    }

    #[test]
    fn transaction_failure_leaves_no_prepared_files() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        library
            .create_collection(CreateCollection {
                name: "Jet Set Radio".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        let cover = image_bytes(264, 374);
        let hero = image_bytes(1920, 1080);

        let result = library.apply_fetched_igdb_game(
            request(Some("cover-1"), Some("artwork-1")),
            remote(),
            Some(&cover),
            Some(&hero),
        );

        assert!(matches!(result, Err(LibraryError::DuplicateCollectionName)));
        assert_eq!(library.list_collections().unwrap().len(), 1);
        assert_eq!(artwork_file_count(&library), 0);
    }
}
