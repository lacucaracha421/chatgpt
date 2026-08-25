use chrono::TimeZone;
use rusqlite::{params, OptionalExtension};

use super::{
    collection::{collection_by_id, map_duplicate_name, normalized_name, require_collection},
    credential,
    error::LibraryError,
    external_binding::upsert_external_binding,
    igdb::{self, IgdbImageSize},
    models::{
        CollectionSummary, ExternalBindingInput, IgdbApplyRequest, IgdbArtworkDecision,
        IgdbArtworkReplaceRequest, IgdbConnection, IgdbGamePreview, IgdbImageCandidate,
        IgdbImageRef, IgdbRemoteGame, IgdbSearchResult,
    },
    work_artwork::{PreparedWorkArtwork, WorkArtworkKind},
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

    pub fn refresh_igdb_game(
        &self,
        collection_id: &str,
    ) -> Result<CollectionSummary, LibraryError> {
        let game_id = self
            .get_igdb_connection(collection_id)?
            .ok_or(LibraryError::InvalidIgdbIdentity)?
            .game_id;
        let credentials = credential::read_igdb_credentials_os()?;
        let fetched = self.igdb_client().game(&credentials, game_id)?;
        self.refresh_fetched_igdb_game(collection_id, fetched)
    }

    pub fn replace_igdb_game_artwork(
        &self,
        request: IgdbArtworkReplaceRequest,
    ) -> Result<CollectionSummary, LibraryError> {
        let game_id = self
            .get_igdb_connection(&request.collection_id)?
            .ok_or(LibraryError::InvalidIgdbIdentity)?
            .game_id;
        let credentials = credential::read_igdb_credentials_os()?;
        let client = self.igdb_client();
        let fetched = client.game(&credentials, game_id)?;
        validate_game_identity(game_id, &fetched)?;
        let (cover, hero) = validated_artwork_decisions(&request, &fetched)?;
        let cover_bytes = cover
            .map(|candidate| client.download_original(&candidate.image_id))
            .transpose()?;
        let hero_bytes = hero
            .map(|candidate| client.download_original(&candidate.image_id))
            .transpose()?;
        self.replace_fetched_igdb_game_artwork(
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

    pub(crate) fn refresh_fetched_igdb_game(
        &self,
        collection_id: &str,
        fetched: IgdbRemoteGame,
    ) -> Result<CollectionSummary, LibraryError> {
        let snapshot_json = normalized_snapshot(&fetched.snapshot_json)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let (external_id, previous_snapshot): (String, Option<String>) = transaction
            .query_row(
                "SELECT external_id, provider_data_json
                 FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, PROVIDER],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::InvalidIgdbIdentity)?;
        let game_id = external_id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or(LibraryError::InvalidIgdbIdentity)?;
        validate_game_identity(game_id, &fetched)?;
        let previous = provider_snapshot(previous_snapshot.as_deref())?;
        let (
            current_developer,
            current_publisher,
            current_release_date,
            current_platforms,
            current_genres,
            current_overview,
        ): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = transaction.query_row(
            "SELECT developer, publisher, release_date, platforms, genres, overview
             FROM collections WHERE id = ?1",
            [collection_id],
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
        )?;
        let developer = fill_provider_value(
            current_developer,
            normalized_optional(fetched.developer.as_deref()),
            previous.developer.as_deref(),
        );
        let publisher = fill_provider_value(
            current_publisher,
            normalized_optional(fetched.publisher.as_deref()),
            previous.publisher.as_deref(),
        );
        let release_date = fill_provider_value(
            current_release_date,
            normalized_optional(fetched.release_date.as_deref()),
            previous.release_date.as_deref(),
        );
        let platforms = fill_provider_value(
            current_platforms,
            joined(&fetched.platforms),
            previous.platforms.as_deref(),
        );
        let genres = fill_provider_value(
            current_genres,
            joined(&fetched.genres),
            previous.genres.as_deref(),
        );
        let overview = fill_provider_value(
            current_overview,
            normalized_optional(fetched.summary.as_deref()),
            previous.overview.as_deref(),
        );
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE collections
             SET developer = ?1, publisher = ?2, platforms = ?3,
                 release_date = ?4, genres = ?5, overview = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                developer,
                publisher,
                platforms,
                release_date,
                genres,
                overview,
                now,
                collection_id
            ],
        )?;
        transaction.execute(
            "UPDATE collection_external_bindings
             SET provider_data_json = ?1, last_synced_at = ?2, updated_at = ?2
             WHERE collection_id = ?3 AND provider = ?4",
            params![snapshot_json, now, collection_id, PROVIDER],
        )?;
        transaction.commit()?;
        drop(connection);
        let connection = self.connection()?;
        collection_by_id(&connection, collection_id)
    }

    pub(crate) fn replace_fetched_igdb_game_artwork(
        &self,
        request: IgdbArtworkReplaceRequest,
        fetched: IgdbRemoteGame,
        cover_bytes: Option<&[u8]>,
        hero_bytes: Option<&[u8]>,
    ) -> Result<CollectionSummary, LibraryError> {
        let snapshot_json = normalized_snapshot(&fetched.snapshot_json)?;
        let (cover_candidate, hero_candidate) = validated_artwork_decisions(&request, &fetched)?;
        let game_id = {
            let connection = self.connection()?;
            let external_id: String = connection
                .query_row(
                    "SELECT external_id FROM collection_external_bindings
                     WHERE collection_id = ?1 AND provider = ?2",
                    params![request.collection_id, PROVIDER],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(LibraryError::InvalidIgdbIdentity)?;
            external_id
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0)
                .ok_or(LibraryError::InvalidIgdbIdentity)?
        };
        validate_game_identity(game_id, &fetched)?;
        let cover =
            prepare_selected_artwork(self, &request.collection_id, cover_candidate, cover_bytes)?;
        let hero =
            prepare_selected_artwork(self, &request.collection_id, hero_candidate, hero_bytes)?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let external_id: String = transaction
            .query_row(
                "SELECT external_id FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![request.collection_id, PROVIDER],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::InvalidIgdbIdentity)?;
        let game_id = external_id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or(LibraryError::InvalidIgdbIdentity)?;
        validate_game_identity(game_id, &fetched)?;

        apply_artwork_decision(
            &transaction,
            &request.collection_id,
            PROVIDER,
            &request.cover,
            WorkArtworkKind::Cover,
            cover.as_ref(),
        )?;
        apply_artwork_decision(
            &transaction,
            &request.collection_id,
            PROVIDER,
            &request.hero,
            WorkArtworkKind::Hero,
            hero.as_ref(),
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE collection_external_bindings
             SET provider_data_json = ?1, last_synced_at = ?2, updated_at = ?2
             WHERE collection_id = ?3 AND provider = ?4",
            params![snapshot_json, now, request.collection_id, PROVIDER],
        )?;
        transaction.commit()?;
        if let Some((_, prepared)) = cover {
            prepared.commit();
        }
        if let Some((_, prepared)) = hero {
            prepared.commit();
        }
        drop(connection);
        self.cleanup_unreferenced_work_artwork()?;
        let connection = self.connection()?;
        collection_by_id(&connection, &request.collection_id)
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

fn validate_game_identity(game_id: i64, fetched: &IgdbRemoteGame) -> Result<(), LibraryError> {
    if game_id <= 0 || fetched.id <= 0 || game_id != fetched.id {
        return Err(LibraryError::InvalidIgdbIdentity);
    }
    Ok(())
}

fn validated_artwork_decisions<'a>(
    request: &IgdbArtworkReplaceRequest,
    fetched: &'a IgdbRemoteGame,
) -> Result<(Option<&'a IgdbImageRef>, Option<&'a IgdbImageRef>), LibraryError> {
    if fetched.id <= 0 {
        return Err(LibraryError::InvalidIgdbIdentity);
    }
    let cover = artwork_decision_candidate(&request.cover, fetched.cover.as_ref())?;
    let hero_candidates = if fetched.artworks.is_empty() {
        &fetched.screenshots
    } else {
        &fetched.artworks
    };
    let hero = match &request.hero {
        IgdbArtworkDecision::Select { image_id } => {
            igdb::IgdbClient::image_url(image_id, IgdbImageSize::Original)?;
            Some(
                hero_candidates
                    .iter()
                    .find(|candidate| candidate.image_id == *image_id)
                    .ok_or(LibraryError::InvalidIgdbIdentity)?,
            )
        }
        IgdbArtworkDecision::Keep | IgdbArtworkDecision::Clear => None,
    };
    Ok((cover, hero))
}

fn artwork_decision_candidate<'a>(
    decision: &IgdbArtworkDecision,
    candidate: Option<&'a IgdbImageRef>,
) -> Result<Option<&'a IgdbImageRef>, LibraryError> {
    match decision {
        IgdbArtworkDecision::Keep | IgdbArtworkDecision::Clear => Ok(None),
        IgdbArtworkDecision::Select { image_id } => {
            igdb::IgdbClient::image_url(image_id, IgdbImageSize::Original)?;
            candidate
                .filter(|candidate| candidate.image_id == *image_id)
                .ok_or(LibraryError::InvalidIgdbIdentity)
                .map(Some)
        }
    }
}

fn prepare_selected_artwork(
    library: &Library,
    collection_id: &str,
    candidate: Option<&IgdbImageRef>,
    bytes: Option<&[u8]>,
) -> Result<Option<(String, PreparedWorkArtwork)>, LibraryError> {
    match (candidate, bytes) {
        (Some(candidate), Some(bytes)) => Ok(Some((
            candidate.image_id.clone(),
            library.prepare_work_artwork(collection_id, bytes)?,
        ))),
        (None, None) => Ok(None),
        _ => Err(LibraryError::InvalidIgdbIdentity),
    }
}

fn apply_artwork_decision(
    transaction: &rusqlite::Transaction<'_>,
    collection_id: &str,
    provider: &str,
    decision: &IgdbArtworkDecision,
    kind: WorkArtworkKind,
    prepared: Option<&(String, PreparedWorkArtwork)>,
) -> Result<(), LibraryError> {
    match decision {
        IgdbArtworkDecision::Keep => Ok(()),
        IgdbArtworkDecision::Clear => {
            Library::clear_work_artwork_kind_in_transaction(transaction, collection_id, kind)?;
            transaction.execute(
                "DELETE FROM collection_work_artworks
                 WHERE collection_id = ?1 AND provider = ?2 AND kind = ?3",
                params![collection_id, provider, kind.as_str()],
            )?;
            Ok(())
        }
        IgdbArtworkDecision::Select { .. } => {
            let (image_id, prepared) = prepared.ok_or(LibraryError::InvalidIgdbIdentity)?;
            Library::insert_work_artwork_in_transaction(
                transaction,
                collection_id,
                provider,
                image_id,
                kind,
                None,
                prepared,
            )?;
            transaction.execute(
                "DELETE FROM collection_work_artworks
                 WHERE collection_id = ?1 AND provider = ?2 AND kind = ?3 AND selected = 0",
                params![collection_id, provider, kind.as_str()],
            )?;
            Ok(())
        }
    }
}

fn fill_provider_value(
    current: Option<String>,
    fresh: Option<String>,
    previous_provider: Option<&str>,
) -> Option<String> {
    if may_fill_from_provider(current.as_deref(), previous_provider) {
        fresh
    } else {
        current
    }
}

fn may_fill_from_provider(current: Option<&str>, previous_provider: Option<&str>) -> bool {
    current.map_or(true, |value| value.trim().is_empty())
        && previous_provider.map_or(true, |value| value.trim().is_empty())
}

#[derive(Default)]
struct ProviderSnapshot {
    developer: Option<String>,
    publisher: Option<String>,
    release_date: Option<String>,
    platforms: Option<String>,
    genres: Option<String>,
    overview: Option<String>,
}

fn provider_snapshot(json: Option<&str>) -> Result<ProviderSnapshot, LibraryError> {
    let Some(json) = json else {
        return Ok(ProviderSnapshot::default());
    };
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| LibraryError::IgdbInvalidResponse)?;
    let developer =
        snapshot_text(&value, "developer").or_else(|| snapshot_companies(&value, "developer"));
    let publisher =
        snapshot_text(&value, "publisher").or_else(|| snapshot_companies(&value, "publisher"));
    let release_date = snapshot_text(&value, "release_date").or_else(|| snapshot_date(&value));
    let platforms = snapshot_text_list(&value, "platforms").or_else(|| {
        value
            .get("release_dates")
            .and_then(snapshot_release_date_platforms)
    });
    let genres = snapshot_text_list(&value, "genres");
    let overview = snapshot_text(&value, "overview").or_else(|| snapshot_text(&value, "summary"));
    Ok(ProviderSnapshot {
        developer,
        publisher,
        release_date,
        platforms,
        genres,
        overview,
    })
}

fn snapshot_text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .and_then(|value| normalized_optional(Some(value)))
}

fn snapshot_text_list(value: &serde_json::Value, key: &str) -> Option<String> {
    let raw = value.get(key)?;
    if let Some(value) = raw.as_str() {
        return normalized_optional(Some(value));
    }
    let values = raw.as_array()?;
    let names = values
        .iter()
        .filter_map(|value| value.as_str().or_else(|| value.get("name")?.as_str()))
        .filter_map(|value| normalized_optional(Some(value)))
        .collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(" · "))
}

fn snapshot_companies(value: &serde_json::Value, role: &str) -> Option<String> {
    let companies = value.get("involved_companies")?.as_array()?;
    let names = companies
        .iter()
        .filter(|company| company.get(role).and_then(|value| value.as_bool()) == Some(true))
        .filter_map(|company| company.get("company")?.get("name")?.as_str())
        .filter_map(|name| normalized_optional(Some(name)))
        .collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(" · "))
}

fn snapshot_date(value: &serde_json::Value) -> Option<String> {
    let mut dates = Vec::new();
    if let Some(timestamp) = value
        .get("first_release_date")
        .and_then(|value| value.as_i64())
    {
        dates.push(timestamp);
    }
    if let Some(releases) = value
        .get("release_dates")
        .and_then(|value| value.as_array())
    {
        dates.extend(
            releases
                .iter()
                .filter_map(|release| release.get("date")?.as_i64()),
        );
    }
    dates.into_iter().min().and_then(|timestamp| {
        chrono::Utc
            .timestamp_opt(timestamp, 0)
            .single()
            .map(|date| date.format("%Y-%m-%d").to_string())
    })
}

fn snapshot_release_date_platforms(value: &serde_json::Value) -> Option<String> {
    let names = value
        .as_array()?
        .iter()
        .filter_map(|release| release.get("platform")?.get("name")?.as_str())
        .filter_map(|name| normalized_optional(Some(name)))
        .collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(" · "))
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
            CollectionType, CreateCollection, IgdbApplyRequest, IgdbArtworkDecision,
            IgdbArtworkReplaceRequest, IgdbImageRef, IgdbRemoteGame, UpdateCollection,
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

    fn artwork_request(
        collection_id: &str,
        cover: IgdbArtworkDecision,
        hero: IgdbArtworkDecision,
    ) -> IgdbArtworkReplaceRequest {
        IgdbArtworkReplaceRequest {
            collection_id: collection_id.into(),
            cover,
            hero,
        }
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

    #[test]
    fn refresh_fills_blank_provider_metadata_but_preserves_local_title_rating_and_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let mut initial = remote();
        initial.summary = None;
        initial.release_date = None;
        initial.genres.clear();
        initial.platforms.clear();
        initial.developer = None;
        initial.publisher = None;
        let cover = image_bytes(264, 374);
        let hero = image_bytes(1920, 1080);
        let created = library
            .apply_fetched_igdb_game(
                request(Some("cover-1"), Some("artwork-1")),
                initial,
                Some(&cover),
                Some(&hero),
            )
            .unwrap();
        let updated = library
            .update_collection(
                &created.id,
                UpdateCollection {
                    name: "My Jet Set Radio".into(),
                    description: None,
                    collection_type: CollectionType::Game,
                    year: None,
                    author: None,
                    director: None,
                    developer: None,
                    publisher: None,
                    platforms: None,
                    production_company: None,
                    release_date: None,
                    external_score: None,
                    my_score: Some(4.5),
                },
            )
            .unwrap();

        let refreshed = library
            .refresh_fetched_igdb_game(&created.id, remote())
            .unwrap();

        assert_eq!(refreshed.name, updated.name);
        assert_eq!(refreshed.my_score, Some(4.5));
        assert_eq!(refreshed.developer.as_deref(), Some("Smilebit"));
        assert_eq!(refreshed.publisher.as_deref(), Some("Sega"));
        assert_eq!(refreshed.release_date.as_deref(), Some("1999-06-01"));
        assert_eq!(refreshed.platforms.as_deref(), Some("Dreamcast · Windows"));
        assert_eq!(refreshed.genres.as_deref(), Some("Action · Music"));
        assert_eq!(
            refreshed.overview.as_deref(),
            Some("A stylish skating game.")
        );
        assert_eq!(
            refreshed.selected_work_artwork_id,
            updated.selected_work_artwork_id
        );
        assert_eq!(
            refreshed.selected_hero_artwork_id,
            updated.selected_hero_artwork_id
        );
    }

    #[test]
    fn refresh_preserves_an_explicitly_cleared_provider_field_from_old_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let mut initial = remote();
        initial.snapshot_json = r#"{"id":42,"publisher":"Old Publisher"}"#.into();
        let created = library
            .apply_fetched_igdb_game(request(None, None), initial, None, None)
            .unwrap();
        library
            .update_collection(
                &created.id,
                UpdateCollection {
                    name: created.name.clone(),
                    description: created.description.clone(),
                    collection_type: CollectionType::Game,
                    year: created.year,
                    author: created.author.clone(),
                    director: created.director.clone(),
                    developer: created.developer.clone(),
                    publisher: None,
                    platforms: created.platforms.clone(),
                    production_company: created.production_company.clone(),
                    release_date: created.release_date.clone(),
                    external_score: created.external_score,
                    my_score: created.my_score,
                },
            )
            .unwrap();

        let refreshed = library
            .refresh_fetched_igdb_game(&created.id, remote())
            .unwrap();

        assert_eq!(refreshed.publisher, None);
    }

    #[test]
    fn refresh_does_not_download_or_write_artwork() {
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
        let before = artwork_file_count(&library);
        library
            .refresh_fetched_igdb_game(&created.id, remote())
            .unwrap();

        assert_eq!(artwork_file_count(&library), before);
    }

    #[test]
    fn replacing_artwork_can_clear_hero_without_clearing_cover() {
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

        let replaced = library
            .replace_fetched_igdb_game_artwork(
                artwork_request(
                    &created.id,
                    IgdbArtworkDecision::Keep,
                    IgdbArtworkDecision::Clear,
                ),
                remote(),
                None,
                None,
            )
            .unwrap();

        assert_eq!(
            replaced.selected_work_artwork_id,
            created.selected_work_artwork_id
        );
        assert_eq!(replaced.selected_hero_artwork_id, None);
    }

    #[test]
    fn keeping_both_artwork_kinds_does_not_change_artwork_rows() {
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
        let before: Vec<(String, String, String, i64)> = library
            .connection()
            .unwrap()
            .prepare(
                "SELECT id, provider_image_id, kind, selected
                 FROM collection_work_artworks WHERE collection_id = ?1 ORDER BY kind",
            )
            .unwrap()
            .query_map([&created.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        library
            .replace_fetched_igdb_game_artwork(
                artwork_request(
                    &created.id,
                    IgdbArtworkDecision::Keep,
                    IgdbArtworkDecision::Keep,
                ),
                remote(),
                None,
                None,
            )
            .unwrap();

        let after: Vec<(String, String, String, i64)> = library
            .connection()
            .unwrap()
            .prepare(
                "SELECT id, provider_image_id, kind, selected
                 FROM collection_work_artworks WHERE collection_id = ?1 ORDER BY kind",
            )
            .unwrap()
            .query_map([&created.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(after, before);
    }

    #[test]
    fn invalid_new_artwork_id_fails_before_preparation_and_preserves_prior_selection() {
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
        let before_files = artwork_file_count(&library);
        let before = library.get_collection(&created.id).unwrap();

        let result = library.replace_fetched_igdb_game_artwork(
            artwork_request(
                &created.id,
                IgdbArtworkDecision::Select {
                    image_id: "not-a-cover".into(),
                },
                IgdbArtworkDecision::Keep,
            ),
            remote(),
            None,
            None,
        );

        assert!(matches!(result, Err(LibraryError::InvalidIgdbIdentity)));
        assert_eq!(artwork_file_count(&library), before_files);
        assert_eq!(library.get_collection(&created.id).unwrap(), before);
    }
}
