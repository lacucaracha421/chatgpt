use rusqlite::{params, OptionalExtension, Transaction};

use super::{
    collection::{collection_by_id, map_duplicate_name, normalized_name, require_collection},
    credential,
    error::LibraryError,
    external_binding::upsert_external_binding,
    models::{
        CollectionSummary, ExternalBindingInput, TmdbApplyRequest, TmdbApplyTarget,
        TmdbArtworkDecision, TmdbArtworkReplaceRequest, TmdbConnection, TmdbImageCandidate,
        TmdbImageRef, TmdbMoviePreview, TmdbRemoteMovie, TmdbSearchResult,
    },
    tmdb::{TmdbClient, TmdbImageSize},
    work_artwork::{PreparedWorkArtwork, WorkArtworkKind},
    Library,
};

const PROVIDER: &str = "tmdb";

struct MovieImportFlow<'a> {
    library: &'a Library,
    client: TmdbClient,
}

impl<'a> MovieImportFlow<'a> {
    fn new(library: &'a Library) -> Self {
        Self {
            library,
            client: TmdbClient::new(),
        }
    }

    fn search(&self, query: &str) -> Result<Vec<TmdbSearchResult>, LibraryError> {
        let credentials = credential::read_tmdb_token_os()?;
        self.client.search(&credentials, query)
    }

    fn preview(&self, movie_id: i64) -> Result<TmdbMoviePreview, LibraryError> {
        let credentials = credential::read_tmdb_token_os()?;
        let fetched = self.client.movie(&credentials, movie_id)?;
        Ok(movie_preview(&fetched))
    }

    fn apply(&self, request: TmdbApplyRequest) -> Result<CollectionSummary, LibraryError> {
        let credentials = credential::read_tmdb_token_os()?;
        let fetched = self.client.movie(&credentials, request.movie_id)?;
        let (poster, backdrop) = validated_selection(&request, &fetched)?;
        let poster_bytes = poster
            .map(|candidate| self.client.download_original(&candidate.file_path))
            .transpose()?;
        let backdrop_bytes = backdrop
            .map(|candidate| self.client.download_original(&candidate.file_path))
            .transpose()?;
        self.library.apply_fetched_tmdb_movie(
            request,
            fetched,
            poster_bytes.as_deref(),
            backdrop_bytes.as_deref(),
        )
    }

    fn refresh(&self, collection_id: &str) -> Result<CollectionSummary, LibraryError> {
        let movie_id = self
            .library
            .get_tmdb_connection(collection_id)?
            .ok_or(LibraryError::InvalidTmdbIdentity)?
            .movie_id;
        let credentials = credential::read_tmdb_token_os()?;
        let fetched = self.client.movie(&credentials, movie_id)?;
        self.library
            .refresh_fetched_tmdb_movie(collection_id, fetched)
    }

    fn replace_artwork(
        &self,
        request: TmdbArtworkReplaceRequest,
    ) -> Result<CollectionSummary, LibraryError> {
        let movie_id = self
            .library
            .get_tmdb_connection(&request.collection_id)?
            .ok_or(LibraryError::InvalidTmdbIdentity)?
            .movie_id;
        let credentials = credential::read_tmdb_token_os()?;
        let fetched = self.client.movie(&credentials, movie_id)?;
        let (poster, backdrop) = validated_artwork_decisions(&request, &fetched)?;
        let poster_bytes = poster
            .map(|candidate| self.client.download_original(&candidate.file_path))
            .transpose()?;
        let backdrop_bytes = backdrop
            .map(|candidate| self.client.download_original(&candidate.file_path))
            .transpose()?;
        self.library.replace_fetched_tmdb_movie_artwork(
            request,
            fetched,
            poster_bytes.as_deref(),
            backdrop_bytes.as_deref(),
        )
    }
}

impl Library {
    pub fn search_tmdb_movies(&self, query: &str) -> Result<Vec<TmdbSearchResult>, LibraryError> {
        MovieImportFlow::new(self).search(query)
    }

    pub fn preview_tmdb_movie(&self, movie_id: i64) -> Result<TmdbMoviePreview, LibraryError> {
        MovieImportFlow::new(self).preview(movie_id)
    }

    pub fn apply_tmdb_movie(
        &self,
        request: TmdbApplyRequest,
    ) -> Result<CollectionSummary, LibraryError> {
        MovieImportFlow::new(self).apply(request)
    }

    pub fn refresh_tmdb_movie(
        &self,
        collection_id: &str,
    ) -> Result<CollectionSummary, LibraryError> {
        MovieImportFlow::new(self).refresh(collection_id)
    }

    pub fn get_tmdb_connection(
        &self,
        collection_id: &str,
    ) -> Result<Option<TmdbConnection>, LibraryError> {
        let connection = self.connection()?;
        require_collection(&connection, collection_id)?;
        let collection_type: String = connection.query_row(
            "SELECT type FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )?;
        if collection_type != "movie" {
            return Err(LibraryError::InvalidCollectionType);
        }
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
                let movie_id = external_id
                    .parse::<i64>()
                    .ok()
                    .filter(|id| *id > 0)
                    .ok_or(LibraryError::InvalidTmdbIdentity)?;
                Ok(TmdbConnection {
                    movie_id,
                    last_synced_at,
                })
            })
            .transpose()
    }

    pub fn replace_tmdb_movie_artwork(
        &self,
        request: TmdbArtworkReplaceRequest,
    ) -> Result<CollectionSummary, LibraryError> {
        MovieImportFlow::new(self).replace_artwork(request)
    }

    pub(crate) fn apply_fetched_tmdb_movie(
        &self,
        request: TmdbApplyRequest,
        fetched: TmdbRemoteMovie,
        poster_bytes: Option<&[u8]>,
        backdrop_bytes: Option<&[u8]>,
    ) -> Result<CollectionSummary, LibraryError> {
        let (poster_candidate, backdrop_candidate) = validated_selection(&request, &fetched)?;
        let snapshot_json = normalized_snapshot(&fetched.snapshot_json)?;
        let name = normalized_name(fetched.title.clone())?;
        let original_title = normalized_optional(fetched.original_title.as_deref());
        let director = joined(&fetched.directors);
        let production_company = joined(&fetched.production_companies);
        let release_date = normalized_optional(fetched.release_date.as_deref());
        let runtime_minutes = fetched.runtime_minutes.filter(|minutes| *minutes > 0);
        let genres = joined(&fetched.genres);
        let overview = normalized_optional(fetched.overview.as_deref());
        let year = year_from_date(release_date.as_deref());

        let collection_id = match &request.target {
            TmdbApplyTarget::New => uuid::Uuid::new_v4().to_string(),
            TmdbApplyTarget::Existing { collection_id } => collection_id.clone(),
        };
        let poster =
            prepare_selected_artwork(self, &collection_id, poster_candidate, poster_bytes)?;
        let backdrop =
            prepare_selected_artwork(self, &collection_id, backdrop_candidate, backdrop_bytes)?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        match &request.target {
            TmdbApplyTarget::New => {
                ensure_identity_available(&transaction, fetched.id)?;
                transaction
                    .execute(
                        "INSERT INTO collections (
                            id, name, description, type, cover_asset_id,
                            year, original_title, runtime_minutes, author, director, developer,
                            publisher, platforms, production_company, release_date,
                            external_score, my_score, genres, overview, showcase,
                            created_at, updated_at
                         ) VALUES (?1, ?2, NULL, 'movie', NULL,
                            ?3, ?4, ?5, NULL, ?6, NULL,
                            NULL, NULL, ?7, ?8, ?9, NULL, ?10, ?11, 0, ?12, ?12)",
                        params![
                            collection_id,
                            name,
                            year,
                            original_title,
                            runtime_minutes,
                            director,
                            production_company,
                            release_date,
                            fetched.external_score,
                            genres,
                            overview,
                            chrono::Utc::now().to_rfc3339(),
                        ],
                    )
                    .map_err(map_duplicate_name)?;
            }
            TmdbApplyTarget::Existing { collection_id } => {
                require_movie_without_tmdb_binding(&transaction, collection_id)?;
                ensure_identity_available(&transaction, fetched.id)?;
                transaction.execute(
                    "UPDATE collections
                     SET year = CASE WHEN year IS NULL THEN ?1 ELSE year END,
                         original_title = CASE WHEN original_title IS NULL OR trim(original_title) = '' THEN ?2 ELSE original_title END,
                         runtime_minutes = COALESCE(runtime_minutes, ?3),
                         director = CASE WHEN director IS NULL OR trim(director) = '' THEN ?4 ELSE director END,
                         production_company = CASE WHEN production_company IS NULL OR trim(production_company) = '' THEN ?5 ELSE production_company END,
                         release_date = CASE WHEN release_date IS NULL OR trim(release_date) = '' THEN ?6 ELSE release_date END,
                         external_score = COALESCE(external_score, ?7),
                         genres = CASE WHEN genres IS NULL OR trim(genres) = '' THEN ?8 ELSE genres END,
                         overview = CASE WHEN overview IS NULL OR trim(overview) = '' THEN ?9 ELSE overview END,
                         updated_at = ?10
                     WHERE id = ?11",
                    params![
                        year,
                        original_title,
                        runtime_minutes,
                        director,
                        production_company,
                        release_date,
                        fetched.external_score,
                        genres,
                        overview,
                        chrono::Utc::now().to_rfc3339(),
                        collection_id,
                    ],
                )?;
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
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
        if let Some((candidate, prepared)) = poster.as_ref() {
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection_id,
                PROVIDER,
                candidate,
                WorkArtworkKind::Cover,
                None,
                prepared,
            )?;
        }
        if let Some((candidate, prepared)) = backdrop.as_ref() {
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection_id,
                PROVIDER,
                candidate,
                WorkArtworkKind::Backdrop,
                None,
                prepared,
            )?;
        }
        let summary = collection_by_id(&transaction, &collection_id)?;
        transaction.commit()?;
        if let Some((_, prepared)) = poster {
            prepared.commit();
        }
        if let Some((_, prepared)) = backdrop {
            prepared.commit();
        }
        drop(connection);
        let _ = self.cleanup_unreferenced_work_artwork();
        Ok(summary)
    }

    pub(crate) fn refresh_fetched_tmdb_movie(
        &self,
        collection_id: &str,
        fetched: TmdbRemoteMovie,
    ) -> Result<CollectionSummary, LibraryError> {
        let snapshot_json = normalized_snapshot(&fetched.snapshot_json)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let (collection_type, external_id, previous_snapshot): (String, String, Option<String>) =
            transaction
                .query_row(
                    "SELECT collections.type, binding.external_id, binding.provider_data_json
                     FROM collections
                     JOIN collection_external_bindings AS binding
                       ON binding.collection_id = collections.id
                     WHERE collections.id = ?1 AND binding.provider = ?2",
                    params![collection_id, PROVIDER],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or(LibraryError::InvalidTmdbIdentity)?;
        if collection_type != "movie" {
            return Err(LibraryError::InvalidCollectionType);
        }
        let movie_id = external_id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or(LibraryError::InvalidTmdbIdentity)?;
        validate_movie_identity(movie_id, &fetched)?;
        let previous = provider_snapshot(previous_snapshot.as_deref())?;
        let (
            current_original_title,
            current_director,
            current_production_company,
            current_release_date,
            current_runtime_minutes,
            current_genres,
            current_overview,
            current_external_score,
        ): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<i64>,
        ) = transaction.query_row(
            "SELECT original_title, director, production_company, release_date,
                    runtime_minutes, genres, overview, external_score
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
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )?;
        let original_title = normalized_optional(fetched.original_title.as_deref());
        let director = joined(&fetched.directors);
        let production_company = joined(&fetched.production_companies);
        let release_date = normalized_optional(fetched.release_date.as_deref());
        let runtime_minutes = fetched.runtime_minutes.filter(|minutes| *minutes > 0);
        let genres = joined(&fetched.genres);
        let overview = normalized_optional(fetched.overview.as_deref());
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE collections
             SET original_title = CASE WHEN ?1 THEN ?2 ELSE original_title END,
                 director = CASE WHEN ?3 THEN ?4 ELSE director END,
                 production_company = CASE WHEN ?5 THEN ?6 ELSE production_company END,
                 release_date = CASE WHEN ?7 THEN ?8 ELSE release_date END,
                 runtime_minutes = CASE WHEN ?9 THEN ?10 ELSE runtime_minutes END,
                 genres = CASE WHEN ?11 THEN ?12 ELSE genres END,
                 overview = CASE WHEN ?13 THEN ?14 ELSE overview END,
                 external_score = CASE WHEN ?15 THEN ?16 ELSE external_score END,
                 updated_at = ?17
             WHERE id = ?18",
            params![
                can_refresh_text(
                    current_original_title.as_deref(),
                    previous.original_title.as_deref()
                ),
                original_title,
                can_refresh_text(current_director.as_deref(), previous.director.as_deref()),
                director,
                can_refresh_text(
                    current_production_company.as_deref(),
                    previous.production_company.as_deref(),
                ),
                production_company,
                can_refresh_text(
                    current_release_date.as_deref(),
                    previous.release_date.as_deref()
                ),
                release_date,
                can_refresh_option(current_runtime_minutes, previous.runtime_minutes),
                runtime_minutes,
                can_refresh_text(current_genres.as_deref(), previous.genres.as_deref()),
                genres,
                can_refresh_text(current_overview.as_deref(), previous.overview.as_deref()),
                overview,
                can_refresh_option(current_external_score, previous.external_score),
                fetched.external_score,
                now,
                collection_id,
            ],
        )?;
        transaction.execute(
            "UPDATE collection_external_bindings
             SET provider_data_json = ?1, last_synced_at = ?2, updated_at = ?2
             WHERE collection_id = ?3 AND provider = ?4",
            params![snapshot_json, now, collection_id, PROVIDER],
        )?;
        let summary = collection_by_id(&transaction, collection_id)?;
        transaction.commit()?;
        Ok(summary)
    }

    pub(crate) fn replace_fetched_tmdb_movie_artwork(
        &self,
        request: TmdbArtworkReplaceRequest,
        fetched: TmdbRemoteMovie,
        poster_bytes: Option<&[u8]>,
        backdrop_bytes: Option<&[u8]>,
    ) -> Result<CollectionSummary, LibraryError> {
        let snapshot_json = normalized_snapshot(&fetched.snapshot_json)?;
        let (poster_candidate, backdrop_candidate) =
            validated_artwork_decisions(&request, &fetched)?;
        let movie_id = self.tmdb_binding_id(&request.collection_id)?;
        validate_movie_identity(movie_id, &fetched)?;
        let poster =
            prepare_selected_artwork(self, &request.collection_id, poster_candidate, poster_bytes)?;
        let backdrop = prepare_selected_artwork(
            self,
            &request.collection_id,
            backdrop_candidate,
            backdrop_bytes,
        )?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let transaction_movie_id =
            tmdb_binding_id_in_transaction(&transaction, &request.collection_id)?;
        validate_movie_identity(transaction_movie_id, &fetched)?;
        apply_artwork_decision(
            &transaction,
            &request.collection_id,
            &request.poster,
            WorkArtworkKind::Cover,
            poster.as_ref(),
        )?;
        apply_artwork_decision(
            &transaction,
            &request.collection_id,
            &request.backdrop,
            WorkArtworkKind::Backdrop,
            backdrop.as_ref(),
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE collection_external_bindings
             SET provider_data_json = ?1, last_synced_at = ?2, updated_at = ?2
             WHERE collection_id = ?3 AND provider = ?4",
            params![snapshot_json, now, request.collection_id, PROVIDER],
        )?;
        let summary = collection_by_id(&transaction, &request.collection_id)?;
        transaction.commit()?;
        if let Some((_, prepared)) = poster {
            prepared.commit();
        }
        if let Some((_, prepared)) = backdrop {
            prepared.commit();
        }
        drop(connection);
        let _ = self.cleanup_unreferenced_work_artwork();
        Ok(summary)
    }

    fn tmdb_binding_id(&self, collection_id: &str) -> Result<i64, LibraryError> {
        let connection = self.connection()?;
        let collection_type: String = connection
            .query_row(
                "SELECT type FROM collections WHERE id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        if collection_type != "movie" {
            return Err(LibraryError::InvalidCollectionType);
        }
        let external_id: String = connection
            .query_row(
                "SELECT external_id FROM collection_external_bindings
                 WHERE collection_id = ?1 AND provider = ?2",
                params![collection_id, PROVIDER],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(LibraryError::InvalidTmdbIdentity)?;
        external_id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or(LibraryError::InvalidTmdbIdentity)
    }
}

fn validate_movie_identity(movie_id: i64, fetched: &TmdbRemoteMovie) -> Result<(), LibraryError> {
    if movie_id <= 0 || fetched.id <= 0 || movie_id != fetched.id {
        return Err(LibraryError::InvalidTmdbIdentity);
    }
    Ok(())
}

fn validated_selection<'a>(
    request: &TmdbApplyRequest,
    fetched: &'a TmdbRemoteMovie,
) -> Result<(Option<&'a TmdbImageRef>, Option<&'a TmdbImageRef>), LibraryError> {
    validate_movie_identity(request.movie_id, fetched)?;
    let poster = request
        .poster_path
        .as_deref()
        .map(|path| selected_candidate(path, &fetched.posters))
        .transpose()?;
    let backdrop = request
        .backdrop_path
        .as_deref()
        .map(|path| selected_candidate(path, &fetched.backdrops))
        .transpose()?;
    Ok((poster, backdrop))
}

fn validated_artwork_decisions<'a>(
    request: &TmdbArtworkReplaceRequest,
    fetched: &'a TmdbRemoteMovie,
) -> Result<(Option<&'a TmdbImageRef>, Option<&'a TmdbImageRef>), LibraryError> {
    if fetched.id <= 0 {
        return Err(LibraryError::InvalidTmdbIdentity);
    }
    let poster = artwork_decision_candidate(&request.poster, &fetched.posters)?;
    let backdrop = artwork_decision_candidate(&request.backdrop, &fetched.backdrops)?;
    Ok((poster, backdrop))
}

fn selected_candidate<'a>(
    path: &str,
    candidates: &'a [TmdbImageRef],
) -> Result<&'a TmdbImageRef, LibraryError> {
    TmdbClient::image_url(path, TmdbImageSize::Original)?;
    candidates
        .iter()
        .find(|candidate| candidate.file_path == path)
        .ok_or(LibraryError::InvalidTmdbIdentity)
}

fn artwork_decision_candidate<'a>(
    decision: &TmdbArtworkDecision,
    candidates: &'a [TmdbImageRef],
) -> Result<Option<&'a TmdbImageRef>, LibraryError> {
    match decision {
        TmdbArtworkDecision::Keep | TmdbArtworkDecision::Clear => Ok(None),
        TmdbArtworkDecision::Select { file_path } => {
            selected_candidate(file_path, candidates).map(Some)
        }
    }
}

fn prepare_selected_artwork(
    library: &Library,
    collection_id: &str,
    candidate: Option<&TmdbImageRef>,
    bytes: Option<&[u8]>,
) -> Result<Option<(String, PreparedWorkArtwork)>, LibraryError> {
    match (candidate, bytes) {
        (Some(candidate), Some(bytes)) => Ok(Some((
            candidate.file_path.clone(),
            library.prepare_work_artwork(collection_id, bytes)?,
        ))),
        (None, None) => Ok(None),
        _ => Err(LibraryError::InvalidTmdbIdentity),
    }
}

fn apply_artwork_decision(
    transaction: &Transaction<'_>,
    collection_id: &str,
    decision: &TmdbArtworkDecision,
    kind: WorkArtworkKind,
    prepared: Option<&(String, PreparedWorkArtwork)>,
) -> Result<(), LibraryError> {
    match decision {
        TmdbArtworkDecision::Keep => Ok(()),
        TmdbArtworkDecision::Clear => {
            Library::clear_work_artwork_kind_in_transaction(transaction, collection_id, kind)?;
            transaction.execute(
                "DELETE FROM collection_work_artworks
                 WHERE collection_id = ?1 AND provider = ?2 AND kind = ?3",
                params![collection_id, PROVIDER, kind.as_str()],
            )?;
            Ok(())
        }
        TmdbArtworkDecision::Select { .. } => {
            let (file_path, prepared) = prepared.ok_or(LibraryError::InvalidTmdbIdentity)?;
            Library::insert_work_artwork_in_transaction(
                transaction,
                collection_id,
                PROVIDER,
                file_path,
                kind,
                None,
                prepared,
            )?;
            transaction.execute(
                "DELETE FROM collection_work_artworks
                 WHERE collection_id = ?1 AND provider = ?2 AND kind = ?3 AND selected = 0",
                params![collection_id, PROVIDER, kind.as_str()],
            )?;
            Ok(())
        }
    }
}

fn ensure_identity_available(
    connection: &rusqlite::Connection,
    movie_id: i64,
) -> Result<(), LibraryError> {
    let owner: Option<String> = connection
        .query_row(
            "SELECT collection_id FROM collection_external_bindings
             WHERE provider = ?1 AND external_id = ?2 LIMIT 1",
            params![PROVIDER, movie_id.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    if owner.is_some() {
        Err(LibraryError::DuplicateProviderBinding)
    } else {
        Ok(())
    }
}

fn require_movie_without_tmdb_binding(
    connection: &rusqlite::Connection,
    collection_id: &str,
) -> Result<(), LibraryError> {
    let collection_type: String = connection
        .query_row(
            "SELECT type FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(LibraryError::CollectionNotFound)?;
    if collection_type != "movie" {
        return Err(LibraryError::InvalidCollectionType);
    }
    let has_binding: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM collection_external_bindings
            WHERE collection_id = ?1 AND provider = ?2
        )",
        params![collection_id, PROVIDER],
        |row| row.get(0),
    )?;
    if has_binding {
        return Err(LibraryError::DuplicateProviderBinding);
    }
    Ok(())
}

fn tmdb_binding_id_in_transaction(
    transaction: &Transaction<'_>,
    collection_id: &str,
) -> Result<i64, LibraryError> {
    let collection_type: String = transaction
        .query_row(
            "SELECT type FROM collections WHERE id = ?1",
            [collection_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(LibraryError::CollectionNotFound)?;
    if collection_type != "movie" {
        return Err(LibraryError::InvalidCollectionType);
    }
    let external_id: String = transaction
        .query_row(
            "SELECT external_id FROM collection_external_bindings
             WHERE collection_id = ?1 AND provider = ?2",
            params![collection_id, PROVIDER],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(LibraryError::InvalidTmdbIdentity)?;
    external_id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or(LibraryError::InvalidTmdbIdentity)
}

fn movie_preview(movie: &TmdbRemoteMovie) -> TmdbMoviePreview {
    TmdbMoviePreview {
        movie_id: movie.id,
        proposed_title: movie.title.clone(),
        original_title: movie.original_title.clone(),
        release_date: movie.release_date.clone(),
        runtime_minutes: movie.runtime_minutes,
        director: joined(&movie.directors),
        production_company: joined(&movie.production_companies),
        genres: joined(&movie.genres),
        overview: movie.overview.clone(),
        external_score: movie.external_score,
        posters: movie.posters.iter().cloned().map(image_candidate).collect(),
        backdrops: movie
            .backdrops
            .iter()
            .cloned()
            .map(image_candidate)
            .collect(),
    }
}

fn image_candidate(image: TmdbImageRef) -> TmdbImageCandidate {
    TmdbImageCandidate {
        file_path: image.file_path,
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

fn year_from_date(date: Option<&str>) -> Option<i64> {
    date.and_then(|date| date.get(..4))
        .and_then(|year| year.parse::<i64>().ok())
}

fn normalized_snapshot(snapshot_json: &str) -> Result<String, LibraryError> {
    let value: serde_json::Value =
        serde_json::from_str(snapshot_json).map_err(|_| LibraryError::TmdbInvalidResponse)?;
    serde_json::to_string(&value).map_err(|_| LibraryError::TmdbInvalidResponse)
}

#[derive(Default)]
struct ProviderSnapshot {
    original_title: Option<String>,
    director: Option<String>,
    production_company: Option<String>,
    release_date: Option<String>,
    runtime_minutes: Option<i64>,
    genres: Option<String>,
    overview: Option<String>,
    external_score: Option<i64>,
}

fn provider_snapshot(json: Option<&str>) -> Result<ProviderSnapshot, LibraryError> {
    let Some(json) = json else {
        return Ok(ProviderSnapshot::default());
    };
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| LibraryError::TmdbInvalidResponse)?;
    Ok(ProviderSnapshot {
        original_title: snapshot_text(&value, "original_title"),
        director: snapshot_text_list(&value, "directors")
            .or_else(|| snapshot_text(&value, "director")),
        production_company: snapshot_text_list(&value, "production_companies")
            .or_else(|| snapshot_text(&value, "production_company")),
        release_date: snapshot_text(&value, "release_date"),
        runtime_minutes: value
            .get("runtime_minutes")
            .and_then(serde_json::Value::as_i64)
            .filter(|minutes| *minutes > 0),
        genres: snapshot_text_list(&value, "genres"),
        overview: snapshot_text(&value, "overview"),
        external_score: value
            .get("external_score")
            .and_then(serde_json::Value::as_i64),
    })
}

fn snapshot_text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
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
        .filter_map(|value| value.as_str())
        .filter_map(|value| normalized_optional(Some(value)))
        .collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(" · "))
}

fn can_refresh_text(current: Option<&str>, previous: Option<&str>) -> bool {
    let current = normalized_optional(current);
    let previous = normalized_optional(previous);
    current == previous || (current.is_none() && previous.is_none())
}

fn can_refresh_option<T: PartialEq>(current: Option<T>, previous: Option<T>) -> bool {
    current == previous || (current.is_none() && previous.is_none())
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Cursor};

    use image::{DynamicImage, ImageFormat};

    use crate::library::{
        error::LibraryError,
        models::{
            CollectionType, CreateCollection, TmdbApplyRequest, TmdbApplyTarget,
            TmdbArtworkDecision, TmdbArtworkReplaceRequest, TmdbImageRef, TmdbRemoteMovie,
        },
        Library,
    };

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    fn movie() -> TmdbRemoteMovie {
        let mut movie = TmdbRemoteMovie {
            id: 10494,
            title: "Perfect Blue".into(),
            original_title: Some("Perfect Blue".into()),
            overview: Some("A singer becomes an actress.".into()),
            release_date: Some("1998-02-28".into()),
            runtime_minutes: Some(81),
            genres: vec!["Animation".into(), "Thriller".into()],
            directors: vec!["곤 사토시".into()],
            production_companies: vec!["매드하우스".into(), "Rex Entertainment".into()],
            external_score: Some(87),
            poster_path: Some("/perfect-blue-poster.jpg".into()),
            backdrop_path: Some("/perfect-blue-backdrop.jpg".into()),
            posters: vec![TmdbImageRef {
                file_path: "/perfect-blue-poster.jpg".into(),
                width: Some(1000),
                height: Some(1500),
            }],
            backdrops: vec![TmdbImageRef {
                file_path: "/perfect-blue-backdrop.jpg".into(),
                width: Some(1920),
                height: Some(1080),
            }],
            snapshot_json: String::new(),
        };
        movie.snapshot_json = snapshot(&movie);
        movie
    }

    fn snapshot(movie: &TmdbRemoteMovie) -> String {
        serde_json::json!({
            "id": movie.id,
            "title": movie.title,
            "original_title": movie.original_title,
            "overview": movie.overview,
            "release_date": movie.release_date,
            "runtime_minutes": movie.runtime_minutes,
            "genres": movie.genres,
            "directors": movie.directors,
            "production_companies": movie.production_companies,
            "external_score": movie.external_score,
            "poster_path": movie.poster_path,
            "backdrop_path": movie.backdrop_path,
            "posters": movie.posters,
            "backdrops": movie.backdrops,
        })
        .to_string()
    }

    fn apply_movie(
        library: &Library,
        movie: TmdbRemoteMovie,
        poster_path: Option<&str>,
        backdrop_path: Option<&str>,
        poster_bytes: Option<&[u8]>,
        backdrop_bytes: Option<&[u8]>,
    ) -> crate::library::models::CollectionSummary {
        library
            .apply_fetched_tmdb_movie(
                TmdbApplyRequest {
                    target: TmdbApplyTarget::New,
                    movie_id: movie.id,
                    poster_path: poster_path.map(str::to_owned),
                    backdrop_path: backdrop_path.map(str::to_owned),
                },
                movie,
                poster_bytes,
                backdrop_bytes,
            )
            .unwrap()
    }

    fn artwork_rows(library: &Library, collection_id: &str) -> Vec<(String, String, i64)> {
        library
            .connection()
            .unwrap()
            .prepare(
                "SELECT kind, provider_image_id, selected
                 FROM collection_work_artworks
                 WHERE collection_id = ?1 ORDER BY kind",
            )
            .unwrap()
            .query_map([collection_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn imports_movie_binding_poster_and_backdrop_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let created = library
            .apply_fetched_tmdb_movie(
                TmdbApplyRequest {
                    target: TmdbApplyTarget::New,
                    movie_id: 10494,
                    poster_path: Some("/perfect-blue-poster.jpg".into()),
                    backdrop_path: Some("/perfect-blue-backdrop.jpg".into()),
                },
                movie(),
                Some(&png_bytes(2, 3)),
                Some(&png_bytes(16, 9)),
            )
            .unwrap();

        assert_eq!(created.collection_type, CollectionType::Movie);
        assert_eq!(created.original_title.as_deref(), Some("Perfect Blue"));
        assert_eq!(created.director.as_deref(), Some("곤 사토시"));
        assert_eq!(
            created.production_company.as_deref(),
            Some("매드하우스 · Rex Entertainment")
        );
        assert_eq!(created.runtime_minutes, Some(81));
        assert!(created.selected_work_artwork_id.is_some());
        assert!(created.selected_backdrop_artwork_id.is_some());

        let binding = library
            .list_collection_external_bindings(&created.id)
            .unwrap()
            .into_iter()
            .find(|binding| binding.provider == "tmdb")
            .unwrap();
        assert_eq!(binding.external_id, "10494");
    }

    #[test]
    fn imports_movie_without_either_image() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let created = apply_movie(&library, movie(), None, None, None, None);

        assert!(created.selected_work_artwork_id.is_none());
        assert!(created.selected_backdrop_artwork_id.is_none());
        assert!(artwork_rows(&library, &created.id).is_empty());
    }

    #[test]
    fn rejects_image_outside_fresh_preview_before_file_preparation() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let request = TmdbApplyRequest {
            target: TmdbApplyTarget::New,
            movie_id: 10494,
            poster_path: Some("/not-in-preview.jpg".into()),
            backdrop_path: None,
        };

        assert!(matches!(
            library.apply_fetched_tmdb_movie(request, movie(), Some(&png_bytes(2, 3)), None,),
            Err(LibraryError::InvalidTmdbIdentity)
        ));
        let files = fs::read_dir(library.root().join("work-artwork"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn rejects_duplicate_tmdb_identity() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        apply_movie(&library, movie(), None, None, None, None);

        let duplicate = library.apply_fetched_tmdb_movie(
            TmdbApplyRequest {
                target: TmdbApplyTarget::New,
                movie_id: 10494,
                poster_path: None,
                backdrop_path: None,
            },
            movie(),
            None,
            None,
        );

        assert!(matches!(
            duplicate,
            Err(LibraryError::DuplicateProviderBinding)
        ));
        let count: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collections WHERE type = 'movie'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn connects_existing_manual_movie_without_overwriting_user_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let manual = library
            .create_collection(CreateCollection {
                name: "My title".into(),
                description: Some("My description".into()),
                collection_type: CollectionType::Movie,
            })
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET my_score = 4.5 WHERE id = ?1",
                [&manual.id],
            )
            .unwrap();
        let mut fetched = movie();
        fetched.original_title = Some("Original Blue".into());
        fetched.snapshot_json = snapshot(&fetched);

        let connected = library
            .apply_fetched_tmdb_movie(
                TmdbApplyRequest {
                    target: TmdbApplyTarget::Existing {
                        collection_id: manual.id.clone(),
                    },
                    movie_id: fetched.id,
                    poster_path: None,
                    backdrop_path: None,
                },
                fetched,
                None,
                None,
            )
            .unwrap();

        assert_eq!(connected.name, "My title");
        assert_eq!(connected.description.as_deref(), Some("My description"));
        assert_eq!(connected.my_score, Some(4.5));
        assert_eq!(connected.original_title.as_deref(), Some("Original Blue"));
        assert_eq!(connected.director.as_deref(), Some("곤 사토시"));
        assert_eq!(
            connected.production_company.as_deref(),
            Some("매드하우스 · Rex Entertainment")
        );
        assert_eq!(connected.release_date.as_deref(), Some("1998-02-28"));
        assert_eq!(connected.runtime_minutes, Some(81));
        assert_eq!(connected.genres.as_deref(), Some("Animation · Thriller"));
        assert_eq!(
            connected.overview.as_deref(),
            Some("A singer becomes an actress.")
        );
        assert_eq!(
            library
                .get_tmdb_connection(&manual.id)
                .unwrap()
                .unwrap()
                .movie_id,
            10494
        );
    }

    #[test]
    fn refresh_preserves_user_values_and_explicit_clear() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = apply_movie(&library, movie(), None, None, None, None);
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections
                 SET name = 'My title', description = 'My description', my_score = 3.5,
                     director = NULL, overview = 'My overview'
                 WHERE id = ?1",
                [&created.id],
            )
            .unwrap();

        let mut updated = movie();
        updated.original_title = Some("Perfect Blue (Updated)".into());
        updated.release_date = Some("1998-03-01".into());
        updated.runtime_minutes = Some(82);
        updated.directors = vec!["새 감독".into()];
        updated.production_companies = vec!["새 제작사".into()];
        updated.genres = vec!["Drama".into()];
        updated.overview = Some("Updated overview".into());
        updated.external_score = Some(90);
        updated.snapshot_json = snapshot(&updated);

        let refreshed = library
            .refresh_fetched_tmdb_movie(&created.id, updated)
            .unwrap();

        assert_eq!(refreshed.name, "My title");
        assert_eq!(refreshed.description.as_deref(), Some("My description"));
        assert_eq!(refreshed.my_score, Some(3.5));
        assert_eq!(
            refreshed.original_title.as_deref(),
            Some("Perfect Blue (Updated)")
        );
        assert!(refreshed.director.is_none());
        assert_eq!(refreshed.production_company.as_deref(), Some("새 제작사"));
        assert_eq!(refreshed.release_date.as_deref(), Some("1998-03-01"));
        assert_eq!(refreshed.runtime_minutes, Some(82));
        assert_eq!(refreshed.genres.as_deref(), Some("Drama"));
        assert_eq!(refreshed.overview.as_deref(), Some("My overview"));
        assert_eq!(refreshed.external_score, Some(90));
    }

    #[test]
    fn refresh_never_writes_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = apply_movie(
            &library,
            movie(),
            Some("/perfect-blue-poster.jpg"),
            Some("/perfect-blue-backdrop.jpg"),
            Some(&png_bytes(2, 3)),
            Some(&png_bytes(16, 9)),
        );
        let before = artwork_rows(&library, &created.id);
        let mut updated = movie();
        updated.poster_path = Some("/new-poster.jpg".into());
        updated.backdrop_path = Some("/new-backdrop.jpg".into());
        updated.posters.push(TmdbImageRef {
            file_path: "/new-poster.jpg".into(),
            width: Some(1000),
            height: Some(1500),
        });
        updated.backdrops.push(TmdbImageRef {
            file_path: "/new-backdrop.jpg".into(),
            width: Some(1920),
            height: Some(1080),
        });
        updated.snapshot_json = snapshot(&updated);

        let refreshed = library
            .refresh_fetched_tmdb_movie(&created.id, updated)
            .unwrap();

        assert_eq!(
            refreshed.selected_work_artwork_id,
            created.selected_work_artwork_id
        );
        assert_eq!(
            refreshed.selected_backdrop_artwork_id,
            created.selected_backdrop_artwork_id
        );
        assert_eq!(artwork_rows(&library, &created.id), before);
    }

    #[test]
    fn clearing_backdrop_preserves_selected_poster() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = apply_movie(
            &library,
            movie(),
            Some("/perfect-blue-poster.jpg"),
            Some("/perfect-blue-backdrop.jpg"),
            Some(&png_bytes(2, 3)),
            Some(&png_bytes(16, 9)),
        );

        let replaced = library
            .replace_fetched_tmdb_movie_artwork(
                TmdbArtworkReplaceRequest {
                    collection_id: created.id.clone(),
                    poster: TmdbArtworkDecision::Keep,
                    backdrop: TmdbArtworkDecision::Clear,
                },
                movie(),
                None,
                None,
            )
            .unwrap();

        assert_eq!(
            replaced.selected_work_artwork_id,
            created.selected_work_artwork_id
        );
        assert!(replaced.selected_backdrop_artwork_id.is_none());
        assert_eq!(
            artwork_rows(&library, &created.id),
            vec![("cover".into(), "/perfect-blue-poster.jpg".into(), 1)]
        );
    }

    #[test]
    fn failed_transaction_removes_newly_prepared_files() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let game = library
            .create_collection(CreateCollection {
                name: "Not a movie".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        let artwork_directory = library.root().join("work-artwork").join(&game.id);
        let result = library.apply_fetched_tmdb_movie(
            TmdbApplyRequest {
                target: TmdbApplyTarget::Existing {
                    collection_id: game.id,
                },
                movie_id: 10494,
                poster_path: Some("/perfect-blue-poster.jpg".into()),
                backdrop_path: None,
            },
            movie(),
            Some(&png_bytes(2, 3)),
            None,
        );

        assert!(matches!(result, Err(LibraryError::InvalidCollectionType)));
        let files = fs::read_dir(artwork_directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn post_commit_cleanup_failure_does_not_turn_success_into_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = apply_movie(
            &library,
            movie(),
            Some("/perfect-blue-poster.jpg"),
            Some("/perfect-blue-backdrop.jpg"),
            Some(&png_bytes(2, 3)),
            Some(&png_bytes(16, 9)),
        );
        let artwork_root = library.root().join("work-artwork");
        let hidden_root = library.root().join("work-artwork-hidden");
        fs::rename(&artwork_root, &hidden_root).unwrap();
        fs::write(&artwork_root, b"not a directory").unwrap();

        let result = library.replace_fetched_tmdb_movie_artwork(
            TmdbArtworkReplaceRequest {
                collection_id: created.id.clone(),
                poster: TmdbArtworkDecision::Keep,
                backdrop: TmdbArtworkDecision::Clear,
            },
            movie(),
            None,
            None,
        );

        assert!(result.is_ok());
        fs::remove_file(&artwork_root).unwrap();
        fs::rename(hidden_root, artwork_root).unwrap();
    }
}
