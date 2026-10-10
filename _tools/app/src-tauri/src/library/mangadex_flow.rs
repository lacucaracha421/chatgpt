use rusqlite::{params, OptionalExtension};

use super::{
    collection::{collection_by_id, map_duplicate_name, normalized_name, require_collection},
    collection_binding_sync::CommitCheck,
    collection_volume::materialize_mangadex_volumes,
    error::LibraryError,
    external_binding::upsert_external_binding,
    mangadex::{self, MangaDexFetchedWork},
    models::{
        CollectionSummary, ExternalBindingInput, MangaDexApplyRequest, MangaDexApplyTarget,
        MangaDexConnection, MangaDexCoverCandidate, MangaDexSearchResult, MangaDexWorkPreview,
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
        self.apply_mangadex_checked(request, None)
    }

    /// [`Self::apply_mangadex`] with `check` run inside the transaction that writes the
    /// binding (a tablet request's precondition, `collection_binding_sync.rs`); the MangaDex
    /// requests run before it without the library lock.
    pub(crate) fn apply_mangadex_checked(
        &self,
        request: MangaDexApplyRequest,
        check: Option<CommitCheck<'_>>,
    ) -> Result<CollectionSummary, LibraryError> {
        super::collection_authority::collection_write_status(&*self.connection()?)?;
        let fetched = mangadex::fetch_work(&request.manga_id)?;
        let bytes = representative_japanese_cover(&fetched.preview.covers)
            .map(|cover| mangadex::download_cover(&request.manga_id, &cover.file_name))
            .transpose()?;
        self.apply_fetched_mangadex_checked(request, fetched, bytes.as_deref(), check)
    }

    #[cfg(test)]
    pub(crate) fn apply_fetched_mangadex(
        &self,
        request: MangaDexApplyRequest,
        fetched: MangaDexFetchedWork,
        cover_bytes: Option<&[u8]>,
    ) -> Result<CollectionSummary, LibraryError> {
        self.apply_fetched_mangadex_checked(request, fetched, cover_bytes, None)
    }

    pub(crate) fn apply_fetched_mangadex_checked(
        &self,
        request: MangaDexApplyRequest,
        fetched: MangaDexFetchedWork,
        cover_bytes: Option<&[u8]>,
        check: Option<CommitCheck<'_>>,
    ) -> Result<CollectionSummary, LibraryError> {
        if request.manga_id != fetched.preview.manga_id {
            return Err(LibraryError::InvalidMangaDexIdentity);
        }
        let MangaDexFetchedWork {
            preview,
            snapshot_json,
        } = fetched;
        let cover = representative_japanese_cover(&preview.covers);
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
        let prepared = match (cover, cover_bytes) {
            (Some(cover), Some(bytes)) => {
                mangadex::validate_cover_identity(&request.manga_id, &cover.file_name)?;
                Some(self.prepare_work_artwork(&collection_id, bytes)?)
            }
            (None, None) => None,
            _ => return Err(LibraryError::InvalidMangaDexIdentity),
        };
        {
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            let authority = super::collection_authority::collection_write_status(&transaction)?;
            if let Some(check) = check {
                check(&transaction)?;
            }
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
                            genres, overview, showcase, created_at, updated_at, original_title
                         ) VALUES (?1, ?2, NULL, 'manga', NULL,
                            ?3, ?4, NULL, NULL, NULL, ?5, ?6, 0, ?7, ?7, ?8)",
                        params![
                            collection_id,
                            name,
                            if authority.active { None } else { preview.year },
                            if authority.active {
                                None
                            } else {
                                preview.author.clone()
                            },
                            if authority.active {
                                None
                            } else {
                                preview.genres.clone()
                            },
                            if authority.active {
                                None
                            } else {
                                preview.overview.clone()
                            },
                            now,
                            if authority.active {
                                None
                            } else {
                                preview.japanese_title.clone()
                            },
                        ],
                    )
                    .map_err(map_duplicate_name)?;
                if authority.active {
                    super::collection_authority::enqueue_collection_command(
                        &transaction,
                        &authority,
                        "createWork",
                        &collection_id,
                        serde_json::json!({"workId":collection_id,"type":"manga","name":name,"legacyKind":null,"fields":{},"binding":null}),
                    )?;
                }
            } else if !authority.active {
                refresh_provider_fields(&transaction, &collection_id, &preview, &now)?;
            }
            let binding_input = ExternalBindingInput {
                provider: PROVIDER.into(),
                external_id: request.manga_id.clone(),
                provider_config_json: None,
                provider_data_json: Some(snapshot_json),
                last_synced_at: Some(now.clone()),
            };
            if authority.active {
                super::collection_authority::enqueue_provider_snapshot(
                    &transaction,
                    &authority,
                    &collection_id,
                    &binding_input,
                )?;
            } else {
                upsert_external_binding(&transaction, &collection_id, binding_input, &now)?;
            }
            let representative_artwork =
                if let (Some(cover), Some(prepared)) = (cover, prepared.as_ref()) {
                    Some((
                        cover.cover_id.as_str(),
                        Library::select_work_artwork_in_transaction(
                            &transaction,
                            &collection_id,
                            PROVIDER,
                            &cover.cover_id,
                            cover.language.as_deref(),
                            prepared,
                        )?,
                    ))
                } else {
                    None
                };
            super::collection_updates::reconcile_mangadex_volumes(
                &transaction,
                &collection_id,
                &request.manga_id,
                &preview.covers,
            )?;
            materialize_mangadex_volumes(
                &transaction,
                &collection_id,
                &preview.covers,
                representative_artwork
                    .as_ref()
                    .map(|(cover_id, artwork_id)| (*cover_id, artwork_id.as_str())),
            )?;
            transaction.commit()?;
        }
        if let Some(prepared) = prepared {
            prepared.commit();
        }
        let connection = self.connection()?;
        collection_by_id(&connection, &collection_id)
    }

    pub fn refresh_mangadex(&self, collection_id: &str) -> Result<CollectionSummary, LibraryError> {
        let connection = self
            .get_mangadex_connection(collection_id)?
            .ok_or(LibraryError::InvalidMangaDexIdentity)?;
        super::collection_authority::collection_write_status(&*self.connection()?)?;
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
            let authority = super::collection_authority::collection_write_status(&transaction)?;
            let now = chrono::Utc::now().to_rfc3339();
            if !authority.active {
                refresh_provider_fields(&transaction, collection_id, &fetched.preview, &now)?;
            }
            super::collection_updates::reconcile_mangadex_volumes(
                &transaction,
                collection_id,
                &fetched.preview.manga_id,
                &fetched.preview.covers,
            )?;
            let binding_input = ExternalBindingInput {
                provider: PROVIDER.into(),
                external_id: fetched.preview.manga_id,
                provider_config_json: None,
                provider_data_json: Some(fetched.snapshot_json),
                last_synced_at: Some(now.clone()),
            };
            if authority.active {
                super::collection_authority::enqueue_provider_snapshot(
                    &transaction,
                    &authority,
                    collection_id,
                    &binding_input,
                )?;
            } else {
                upsert_external_binding(&transaction, collection_id, binding_input, &now)?;
            }
            transaction.commit()?;
        }
        let connection = self.connection()?;
        collection_by_id(&connection, collection_id)
    }
}

fn representative_japanese_cover(
    covers: &[MangaDexCoverCandidate],
) -> Option<&MangaDexCoverCandidate> {
    covers
        .iter()
        .find(|cover| {
            cover.language.as_deref() == Some("ja") && cover.volume.as_deref() == Some("1")
        })
        .or_else(|| {
            covers
                .iter()
                .find(|cover| cover.language.as_deref() == Some("ja"))
        })
}

fn refresh_provider_fields(
    connection: &rusqlite::Connection,
    collection_id: &str,
    preview: &MangaDexWorkPreview,
    now: &str,
) -> Result<(), LibraryError> {
    super::collection_authority::fence_collection_operation(connection)?;
    // Read before replacing the binding snapshot, including on reconnect. Only values
    // still matching that provider response belong to MangaDex; differing local values
    // (and values with no usable previous snapshot) must retain their precedence.
    let stored: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT external_id, provider_data_json FROM collection_external_bindings
             WHERE collection_id = ?1 AND provider = ?2",
            params![collection_id, PROVIDER],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let previous = stored.and_then(|(manga_id, snapshot)| {
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot?).ok()?;
        // Covers do not affect these fields. Use the same metadata/localization parser
        // as fetch_work, without requiring the old snapshot's cover data to be valid.
        let previous = mangadex::parse_work_preview(
            &snapshot.get("detail")?.to_string(),
            r#"{"result":"ok","data":[]}"#,
        )
        .ok()?;
        (previous.manga_id == manga_id).then_some(previous)
    });
    connection.execute(
        "UPDATE collections SET
            year = CASE WHEN year IS NULL OR year = ?8 THEN ?1 ELSE year END,
            author = CASE WHEN author IS NULL OR trim(author) = '' OR author = ?9 THEN ?2 ELSE author END,
            genres = CASE WHEN genres IS NULL OR trim(genres) = '' OR genres = ?10 THEN ?3 ELSE genres END,
            overview = CASE WHEN overview IS NULL OR trim(overview) = '' OR overview = ?11 THEN ?4 ELSE overview END,
            original_title = CASE WHEN original_title IS NULL OR trim(original_title) = '' OR original_title = ?12 THEN ?7 ELSE original_title END,
            updated_at = ?5
         WHERE id = ?6",
        params![
            preview.year,
            preview.author,
            preview.genres,
            preview.overview,
            now,
            collection_id,
            preview.japanese_title,
            previous.as_ref().and_then(|previous| previous.year),
            previous.as_ref().and_then(|previous| previous.author.as_deref()),
            previous.as_ref().and_then(|previous| previous.genres.as_deref()),
            previous.as_ref().and_then(|previous| previous.overview.as_deref()),
            previous.as_ref().and_then(|previous| previous.japanese_title.as_deref()),
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, ImageFormat};

    use super::representative_japanese_cover;

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

    fn request(name: &str) -> MangaDexApplyRequest {
        MangaDexApplyRequest {
            target: MangaDexApplyTarget::New { name: name.into() },
            manga_id: MANGA_ID.into(),
            title: None,
        }
    }

    #[test]
    fn representative_cover_prefers_japanese_volume_one() {
        let mut covers = fetched("snapshot").preview.covers;
        let mut japanese_volume_two = covers[0].clone();
        japanese_volume_two.cover_id = "33333333-3333-4333-8333-333333333333".into();
        japanese_volume_two.volume = Some("2".into());
        covers.insert(0, japanese_volume_two);

        let selected = representative_japanese_cover(&covers).unwrap();

        assert_eq!(selected.cover_id, COVER_ID);
        assert_eq!(selected.language.as_deref(), Some("ja"));
        assert_eq!(selected.volume.as_deref(), Some("1"));
    }

    #[test]
    fn new_apply_without_a_japanese_cover_commits_without_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let mut work = fetched("snapshot-v1");
        work.preview
            .covers
            .retain(|cover| cover.language.as_deref() != Some("ja"));

        let created = library
            .apply_fetched_mangadex(request("던전밥"), work, None)
            .unwrap();

        assert_eq!(created.name, "던전밥");
        assert!(created.selected_work_artwork_id.is_none());
        assert!(library
            .get_mangadex_connection(&created.id)
            .unwrap()
            .is_some());
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
                    title: None,
                },
                fetched("snapshot-v1"),
                Some(&cover_bytes()),
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
    fn new_apply_links_the_selected_artwork_to_volume_one() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();

        let created = library
            .apply_fetched_mangadex(
                request("던전밥"),
                fetched("snapshot-v1"),
                Some(&cover_bytes()),
            )
            .unwrap();

        let stored: (i64, u8, Option<String>) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT volume_number, edition_index, cover_artwork_id
                 FROM collection_volumes WHERE collection_id = ?1",
                [&created.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored.0, 1);
        assert_eq!(stored.1, 0);
        assert_eq!(stored.2, created.selected_work_artwork_id);
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
                    title: None,
                },
                fetched("snapshot-v1"),
                Some(&cover_bytes()),
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
        library
            .apply_fetched_mangadex(
                request("첫 Work"),
                fetched("snapshot-v1"),
                Some(&cover_bytes()),
            )
            .unwrap();
        let files_before = artwork_file_count(&library);

        let duplicate = library.apply_fetched_mangadex(
            request("중복 Work"),
            fetched("snapshot-v2"),
            Some(&cover_bytes()),
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
                    title: None,
                },
                fetched("snapshot-v1"),
                Some(&cover_bytes()),
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

    fn original_title(library: &Library, id: &str) -> Option<String> {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT original_title FROM collections WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn existing_manga(library: &Library, original: Option<&str>) -> String {
        let existing = library
            .create_collection(CreateCollection {
                name: "던전밥".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET original_title = ?1 WHERE id = ?2",
                rusqlite::params![original, existing.id],
            )
            .unwrap();
        existing.id
    }

    fn apply_existing(library: &Library, id: &str, work: MangaDexFetchedWork) {
        library
            .apply_fetched_mangadex(
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::Existing {
                        collection_id: id.into(),
                    },
                    manga_id: MANGA_ID.into(),
                    title: None,
                },
                work,
                Some(&cover_bytes()),
            )
            .unwrap();
    }

    fn mark_published(library: &Library) {
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE mobile_publication_state SET published_generation=generation",
                [],
            )
            .unwrap();
    }

    fn collections_dirty(library: &Library) -> bool {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT generation>published_generation FROM mobile_publication_state WHERE kind='collections'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn apply_fills_a_blank_original_title_with_the_japanese_title() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(
                request("던전밥"),
                fetched("snapshot-v1"),
                Some(&cover_bytes()),
            )
            .unwrap();
        assert_eq!(created.original_title.as_deref(), Some("ダンジョン飯"));
    }

    #[test]
    fn existing_apply_fills_a_whitespace_original_title_and_marks_the_publication_dirty() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let blank = existing_manga(&library, Some("  "));
        mark_published(&library);
        apply_existing(&library, &blank, fetched("snapshot-v1"));
        assert_eq!(
            original_title(&library, &blank).as_deref(),
            Some("ダンジョン飯")
        );
        assert!(
            collections_dirty(&library),
            "the new original title must reach the tablet"
        );
    }

    #[test]
    fn apply_never_overwrites_a_user_original_title() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = existing_manga(&library, Some("내가 쓴 원제"));
        apply_existing(&library, &id, fetched("snapshot-v1"));
        assert_eq!(
            original_title(&library, &id).as_deref(),
            Some("내가 쓴 원제")
        );
    }

    #[test]
    fn apply_without_a_japanese_title_leaves_original_title_empty() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = existing_manga(&library, None);
        let mut work = fetched("snapshot-v1");
        work.preview.japanese_title = None;
        apply_existing(&library, &id, work);
        assert_eq!(original_title(&library, &id), None);
    }

    #[test]
    fn refresh_backfills_only_a_blank_original_title_and_marks_the_publication_dirty() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let id = existing_manga(&library, None);
        let mut work = fetched("snapshot-v1");
        work.preview.japanese_title = None;
        apply_existing(&library, &id, work);
        assert_eq!(original_title(&library, &id), None);
        mark_published(&library);

        library
            .refresh_fetched_mangadex(&id, fetched("snapshot-v2"))
            .unwrap();
        assert_eq!(
            original_title(&library, &id).as_deref(),
            Some("ダンジョン飯")
        );
        assert!(collections_dirty(&library));

        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET original_title = '고친 원제' WHERE id = ?1",
                [&id],
            )
            .unwrap();
        library
            .refresh_fetched_mangadex(&id, fetched("snapshot-v3"))
            .unwrap();
        assert_eq!(original_title(&library, &id).as_deref(), Some("고친 원제"));
    }

    fn provider_work(manga_id: &str, revision: &str) -> MangaDexFetchedWork {
        let mut detail: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/mangadex_detail.json")).unwrap();
        detail["data"]["id"] = manga_id.into();
        let attributes = &mut detail["data"]["attributes"];
        attributes["altTitles"] = serde_json::json!([{ "ja": format!("Title {revision}") }]);
        attributes["description"] = serde_json::json!({ "en": format!("Overview {revision}") });
        attributes["year"] = if revision == "old" { 2014 } else { 2022 }.into();
        attributes["tags"] = serde_json::json!([{
            "id": "tag", "type": "tag", "attributes": { "name": { "en": format!("Genre {revision}") } }
        }]);
        detail["data"]["relationships"][0]["attributes"]["name"] =
            format!("Author {revision}").into();
        detail["data"]["relationships"][1]["attributes"]["name"] =
            format!("Author {revision}").into();
        let covers = serde_json::json!({ "result": "ok", "data": [] });
        MangaDexFetchedWork {
            preview: parse_work_preview(&detail.to_string(), &covers.to_string()).unwrap(),
            snapshot_json: serde_json::json!({ "detail": detail, "covers": covers }).to_string(),
        }
    }

    fn assert_provider_fields(
        collection: &crate::library::models::CollectionSummary,
        revision: &str,
    ) {
        assert_eq!(collection.overview, Some(format!("Overview {revision}")));
        assert_eq!(collection.author, Some(format!("Author {revision}")));
        assert_eq!(collection.genres, Some(format!("Genre {revision}")));
        assert_eq!(collection.original_title, Some(format!("Title {revision}")));
        assert_eq!(
            collection.year,
            Some(if revision == "old" { 2014 } else { 2022 })
        );
    }

    #[test]
    fn reconnect_mangadex_replaces_previous_provider_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(request("Local title"), provider_work(MANGA_ID, "old"), None)
            .unwrap();
        let new_id = "22222222-2222-4222-8222-222222222222";
        mark_published(&library);
        let updated = library
            .apply_fetched_mangadex(
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::Existing {
                        collection_id: created.id.clone(),
                    },
                    manga_id: new_id.into(),
                    title: None,
                },
                provider_work(new_id, "new"),
                None,
            )
            .unwrap();
        assert_provider_fields(&updated, "new");
        assert_eq!(updated.name, "Local title");
        assert_eq!(
            library
                .get_mangadex_connection(&created.id)
                .unwrap()
                .unwrap()
                .manga_id,
            new_id
        );
        assert!(collections_dirty(&library));
        assert_provider_fields(&library.list_collections().unwrap()[0], "new");
    }

    #[test]
    fn refresh_mangadex_replaces_previous_provider_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(request("Local title"), provider_work(MANGA_ID, "old"), None)
            .unwrap();
        mark_published(&library);
        let updated = library
            .refresh_fetched_mangadex(&created.id, provider_work(MANGA_ID, "new"))
            .unwrap();
        assert_provider_fields(&updated, "new");
        assert!(collections_dirty(&library));
    }

    #[test]
    fn reconnect_and_refresh_mangadex_preserve_manual_fields_and_memo() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(request("Local title"), provider_work(MANGA_ID, "old"), None)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET overview = 'Manual overview', author = 'Manual author',
             original_title = 'Manual title', genres = 'Manual genres', year = 1999,
             description = 'Personal memo', my_score = 4.5 WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        let new_id = "22222222-2222-4222-8222-222222222222";
        let reconnected = library
            .apply_fetched_mangadex(
                MangaDexApplyRequest {
                    target: MangaDexApplyTarget::Existing {
                        collection_id: created.id.clone(),
                    },
                    manga_id: new_id.into(),
                    title: None,
                },
                provider_work(new_id, "new"),
                None,
            )
            .unwrap();
        let refreshed = library
            .refresh_fetched_mangadex(&created.id, provider_work(new_id, "latest"))
            .unwrap();
        for updated in [reconnected, refreshed] {
            assert_eq!(updated.overview.as_deref(), Some("Manual overview"));
            assert_eq!(updated.author.as_deref(), Some("Manual author"));
            assert_eq!(updated.original_title.as_deref(), Some("Manual title"));
            assert_eq!(updated.genres.as_deref(), Some("Manual genres"));
            assert_eq!(updated.year, Some(1999));
            assert_eq!(updated.description.as_deref(), Some("Personal memo"));
            assert_eq!(updated.my_score, Some(4.5));
        }
    }

    #[test]
    fn refresh_mangadex_preserves_manual_overview_while_updating_other_provider_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(request("Local title"), provider_work(MANGA_ID, "old"), None)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET overview = 'Manual overview' WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        let updated = library
            .refresh_fetched_mangadex(&created.id, provider_work(MANGA_ID, "new"))
            .unwrap();
        assert_eq!(updated.overview.as_deref(), Some("Manual overview"));
        assert_eq!(updated.author.as_deref(), Some("Author new"));
        assert_eq!(updated.genres.as_deref(), Some("Genre new"));
        assert_eq!(updated.original_title.as_deref(), Some("Title new"));
        assert_eq!(updated.year, Some(2022));
    }

    #[test]
    fn refresh_mangadex_clears_removed_provider_fields() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let created = library
            .apply_fetched_mangadex(request("Local title"), provider_work(MANGA_ID, "old"), None)
            .unwrap();
        let mut removed = provider_work(MANGA_ID, "new");
        removed.preview.overview = None;
        removed.preview.author = None;
        removed.preview.genres = None;
        removed.preview.japanese_title = None;
        removed.preview.year = None;
        let updated = library
            .refresh_fetched_mangadex(&created.id, removed)
            .unwrap();
        assert_eq!(updated.overview, None);
        assert_eq!(updated.author, None);
        assert_eq!(updated.genres, None);
        assert_eq!(updated.original_title, None);
        assert_eq!(updated.year, None);
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
