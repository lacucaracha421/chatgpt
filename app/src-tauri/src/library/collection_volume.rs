use std::{collections::BTreeMap, io::Read};

use rusqlite::{params, OptionalExtension, Transaction};

use super::{
    error::LibraryError,
    mangadex,
    models::{CollectionVolume, MangaDexCoverCandidate, MangaDexVolumeSyncResult},
    work_artwork::MAX_WORK_ARTWORK_BYTES,
    Library,
};

pub(crate) fn parse_volume_slot(value: &str) -> Option<(i64, u8)> {
    let (number, edition_index) = match value.split_once('.') {
        None => (value, 0),
        Some((number, "1")) => (number, 1),
        Some((number, "2")) => (number, 2),
        Some((number, "3")) => (number, 3),
        Some(_) => return None,
    };
    if number.is_empty() {
        return None;
    }
    let volume_number = number.parse::<i64>().ok()?;
    (volume_number > 0 && volume_number <= i64::MAX / 10).then_some((volume_number, edition_index))
}

fn display_label(volume_number: i64, edition_index: u8) -> String {
    if edition_index == 0 {
        volume_number.to_string()
    } else {
        format!("{volume_number}.{edition_index}")
    }
}

pub(crate) fn materialize_mangadex_volumes(
    transaction: &Transaction<'_>,
    collection_id: &str,
    covers: &[MangaDexCoverCandidate],
    representative: Option<(&str, &str)>,
) -> Result<(), LibraryError> {
    let mut slots = BTreeMap::new();
    for cover in covers
        .iter()
        .filter(|cover| cover.language.as_deref() == Some("ja"))
    {
        let Some(slot) = cover.volume.as_deref().and_then(parse_volume_slot) else {
            continue;
        };
        slots.entry(slot).or_insert(cover);
    }

    let now = chrono::Utc::now().to_rfc3339();
    for ((volume_number, edition_index), cover) in slots {
        let cover_artwork_id = representative
            .filter(|(cover_id, _)| *cover_id == cover.cover_id)
            .map(|(_, artwork_id)| artwork_id);
        transaction.execute(
            "INSERT INTO collection_volumes (
                id, collection_id, volume_number, edition_index, sort_order,
                cover_artwork_id, source_provider, source_cover_id, source_file_name,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'mangadex', ?7, ?8, ?9, ?9)
             ON CONFLICT(collection_id, volume_number, edition_index) DO UPDATE SET
                cover_artwork_id = COALESCE(collection_volumes.cover_artwork_id, excluded.cover_artwork_id),
                source_provider = excluded.source_provider,
                source_cover_id = excluded.source_cover_id,
                source_file_name = excluded.source_file_name,
                updated_at = excluded.updated_at
             WHERE collection_volumes.source_provider IS NULL
                OR collection_volumes.source_provider = 'mangadex'",
            params![
                uuid::Uuid::new_v4().to_string(),
                collection_id,
                volume_number,
                edition_index,
                volume_number * 10 + i64::from(edition_index),
                cover_artwork_id,
                cover.cover_id,
                cover.file_name,
                now,
            ],
        )?;
    }
    Ok(())
}

impl Library {
    pub fn list_collection_volumes(
        &self,
        collection_id: &str,
    ) -> Result<Vec<CollectionVolume>, LibraryError> {
        let binding = {
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
            connection
                .query_row(
                    "SELECT external_id, provider_data_json
                     FROM collection_external_bindings
                     WHERE collection_id = ?1 AND provider = 'mangadex'",
                    [collection_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()?
        };

        if let Some((manga_id, Some(snapshot))) = binding {
            let covers = mangadex::parse_snapshot_covers(&snapshot, &manga_id)?;
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            materialize_mangadex_volumes(&transaction, collection_id, &covers, None)?;
            transaction.commit()?;
        }

        let legacy_covers = match self.list_collection_covers(collection_id) {
            Ok(covers) => covers,
            Err(
                LibraryError::CollectionSourceRootNotSet
                | LibraryError::CollectionSourcePathNotSet,
            ) => Vec::new(),
            Err(error) => return Err(error),
        };
        let mut local_slots = BTreeMap::new();
        for cover in legacy_covers {
            if let Some(slot) = cover
                .volume_label
                .strip_prefix("vol.")
                .and_then(parse_volume_slot)
            {
                local_slots.entry(slot).or_insert(cover.file_name);
            }
        }
        for ((volume_number, edition_index), file_name) in local_slots {
            if self.local_volume_artwork(collection_id, volume_number, edition_index)?.is_some() {
                continue;
            }
            let existing_artwork = self
                .connection()?
                .query_row(
                    "SELECT id FROM collection_work_artworks
                     WHERE collection_id = ?1 AND provider = 'local' AND provider_image_id = ?2",
                    params![collection_id, file_name],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let artwork_id = if let Some(artwork_id) = existing_artwork {
                artwork_id
            } else {
                let mut media = self.collection_cover_media(collection_id, &file_name)?;
                if media.length > MAX_WORK_ARTWORK_BYTES as u64 {
                    return Err(LibraryError::InvalidWorkArtwork);
                }
                let mut bytes = Vec::with_capacity(media.length as usize);
                media.file.read_to_end(&mut bytes).map_err(|source| {
                    LibraryError::ReadMedia {
                        path: std::path::PathBuf::from(&file_name),
                        source,
                    }
                })?;
                let prepared = self.prepare_work_artwork(collection_id, &bytes)?;
                let artwork_id = {
                    let mut connection = self.connection()?;
                    let transaction = connection.transaction()?;
                    let artwork_id = Library::insert_volume_work_artwork_in_transaction(
                        &transaction,
                        collection_id,
                        "local",
                        &file_name,
                        None,
                        &prepared,
                    )?;
                    set_local_volume(
                        &transaction,
                        collection_id,
                        volume_number,
                        edition_index,
                        &file_name,
                        &artwork_id,
                    )?;
                    transaction.commit()?;
                    artwork_id
                };
                prepared.commit();
                artwork_id
            };
            if self.local_volume_artwork(collection_id, volume_number, edition_index)?.is_none() {
                let mut connection = self.connection()?;
                let transaction = connection.transaction()?;
                set_local_volume(
                    &transaction,
                    collection_id,
                    volume_number,
                    edition_index,
                    &file_name,
                    &artwork_id,
                )?;
                transaction.commit()?;
            }
        }

        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, volume_number, edition_index, cover_artwork_id
             FROM collection_volumes
             WHERE collection_id = ?1
             ORDER BY edition_index, sort_order, volume_number",
        )?;
        let volumes = statement
            .query_map([collection_id], |row| {
                let volume_number = row.get(1)?;
                let edition_index = row.get(2)?;
                Ok(CollectionVolume {
                    id: row.get(0)?,
                    volume_number,
                    edition_index,
                    display_label: display_label(volume_number, edition_index),
                    cover_artwork_id: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(volumes)
    }

    pub fn sync_mangadex_volume_covers(
        &self,
        collection_id: &str,
    ) -> Result<MangaDexVolumeSyncResult, LibraryError> {
        self.sync_mangadex_volume_covers_with(collection_id, |manga_id, file_name| {
            mangadex::download_cover(manga_id, file_name)
        })
    }

    fn sync_mangadex_volume_covers_with<F>(
        &self,
        collection_id: &str,
        mut download: F,
    ) -> Result<MangaDexVolumeSyncResult, LibraryError>
    where
        F: FnMut(&str, &str) -> Result<Vec<u8>, LibraryError>,
    {
        let (collection_type, manga_id) = self
            .connection()?
            .query_row(
                "SELECT c.type, b.external_id
                 FROM collections c
                 LEFT JOIN collection_external_bindings b
                   ON b.collection_id = c.id AND b.provider = 'mangadex'
                 WHERE c.id = ?1",
                [collection_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::CollectionNotFound)?;
        if collection_type != "manga" {
            return Err(LibraryError::InvalidCollectionType);
        }
        let manga_id = manga_id.ok_or(LibraryError::InvalidMangaDexIdentity)?;
        let rows = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id, source_provider, source_cover_id, source_file_name, cover_artwork_id
                 FROM collection_volumes
                 WHERE collection_id = ?1
                 ORDER BY volume_number, edition_index",
            )?;
            let rows = statement
                .query_map([collection_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut result = MangaDexVolumeSyncResult {
            completed: 0,
            skipped: 0,
            failed: 0,
        };

        for (volume_id, source_provider, source_cover_id, source_file_name, artwork_id) in rows {
            if source_provider.as_deref() != Some("mangadex") || artwork_id.is_some() {
                result.skipped += 1;
                continue;
            }
            let (Some(cover_id), Some(file_name)) = (source_cover_id, source_file_name) else {
                result.failed += 1;
                continue;
            };
            let existing_artwork = self
                .connection()?
                .query_row(
                    "SELECT id FROM collection_work_artworks
                     WHERE collection_id = ?1 AND provider = 'mangadex' AND provider_image_id = ?2",
                    params![collection_id, cover_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(existing_artwork) = existing_artwork {
                if self.attach_volume_artwork(&volume_id, &existing_artwork)? {
                    result.completed += 1;
                } else {
                    result.skipped += 1;
                }
                continue;
            }

            let item_result = (|| -> Result<bool, LibraryError> {
                let bytes = download(&manga_id, &file_name)?;
                let prepared = self.prepare_work_artwork(collection_id, &bytes)?;
                let attached = {
                    let mut connection = self.connection()?;
                    let transaction = connection.transaction()?;
                    let artwork_id = Library::insert_volume_work_artwork_in_transaction(
                        &transaction,
                        collection_id,
                        "mangadex",
                        &cover_id,
                        Some("ja"),
                        &prepared,
                    )?;
                    let attached = transaction.execute(
                        "UPDATE collection_volumes SET cover_artwork_id = ?1, updated_at = ?2
                         WHERE id = ?3 AND cover_artwork_id IS NULL
                           AND source_provider = 'mangadex'",
                        params![artwork_id, chrono::Utc::now().to_rfc3339(), volume_id],
                    )? == 1;
                    if attached {
                        transaction.commit()?;
                    } else {
                        transaction.rollback()?;
                    }
                    attached
                };
                if attached {
                    prepared.commit();
                }
                Ok(attached)
            })();
            match item_result {
                Ok(true) => result.completed += 1,
                Ok(false) => result.skipped += 1,
                Err(_) => result.failed += 1,
            }
        }
        Ok(result)
    }

    fn attach_volume_artwork(
        &self,
        volume_id: &str,
        artwork_id: &str,
    ) -> Result<bool, LibraryError> {
        Ok(self.connection()?.execute(
            "UPDATE collection_volumes SET cover_artwork_id = ?1, updated_at = ?2
             WHERE id = ?3 AND cover_artwork_id IS NULL AND source_provider = 'mangadex'",
            params![artwork_id, chrono::Utc::now().to_rfc3339(), volume_id],
        )? == 1)
    }

    fn local_volume_artwork(
        &self,
        collection_id: &str,
        volume_number: i64,
        edition_index: u8,
    ) -> Result<Option<String>, LibraryError> {
        self.connection()?
            .query_row(
                "SELECT cover_artwork_id FROM collection_volumes
                 WHERE collection_id = ?1 AND volume_number = ?2 AND edition_index = ?3
                   AND source_provider = 'local'",
                params![collection_id, volume_number, edition_index],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }
}

fn set_local_volume(
    transaction: &Transaction<'_>,
    collection_id: &str,
    volume_number: i64,
    edition_index: u8,
    file_name: &str,
    artwork_id: &str,
) -> Result<(), LibraryError> {
    let now = chrono::Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO collection_volumes (
            id, collection_id, volume_number, edition_index, sort_order,
            cover_artwork_id, source_provider, source_cover_id, source_file_name,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'local', NULL, ?7, ?8, ?8)
         ON CONFLICT(collection_id, volume_number, edition_index) DO UPDATE SET
            cover_artwork_id = excluded.cover_artwork_id,
            source_provider = 'local',
            source_cover_id = NULL,
            source_file_name = excluded.source_file_name,
            updated_at = excluded.updated_at
         WHERE collection_volumes.source_provider IS NULL
            OR collection_volumes.source_provider != 'local'",
        params![
            uuid::Uuid::new_v4().to_string(),
            collection_id,
            volume_number,
            edition_index,
            volume_number * 10 + i64::from(edition_index),
            artwork_id,
            file_name,
            now,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Cursor};

    use image::{DynamicImage, ImageFormat};

    use super::{materialize_mangadex_volumes, parse_volume_slot};
    use crate::library::{
        models::{
            CollectionType, CreateCollection, ExternalBindingInput, MangaDexCoverCandidate,
        },
        Library,
    };

    const MANGA_ID: &str = "d1a9fdeb-f713-407f-960c-8326b586e6fd";

    fn candidate(
        cover_id: &str,
        file_name: &str,
        volume: &str,
        language: &str,
    ) -> MangaDexCoverCandidate {
        MangaDexCoverCandidate {
            cover_id: cover_id.into(),
            file_name: file_name.into(),
            volume: Some(volume.into()),
            language: Some(language.into()),
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
    fn parses_only_supported_volume_slots() {
        assert_eq!(parse_volume_slot("1"), Some((1, 0)));
        assert_eq!(parse_volume_slot("12.1"), Some((12, 1)));
        assert_eq!(parse_volume_slot("12.2"), Some((12, 2)));
        assert_eq!(parse_volume_slot("12.3"), Some((12, 3)));
        assert_eq!(parse_volume_slot("01"), Some((1, 0)));
        for value in ["0", "1.01", "1.4", "1.5", ".1", "special", " 1 "] {
            assert_eq!(parse_volume_slot(value), None, "{value}");
        }
    }

    #[test]
    fn materialization_keeps_first_japanese_cover_per_slot_in_numeric_order() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work = library
            .create_collection(CreateCollection {
                name: "Work".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let covers = vec![
            candidate("cover-10", "ten.jpg", "10", "ja"),
            candidate("cover-2", "two.jpg", "2", "ja"),
            candidate("cover-2-later", "two-later.jpg", "2", "ja"),
            candidate("cover-1-2", "one-small.jpg", "1.2", "ja"),
            candidate("cover-ko", "ko.jpg", "1", "ko"),
            candidate("cover-unsupported", "half.jpg", "1.5", "ja"),
        ];
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();

        materialize_mangadex_volumes(&transaction, &work.id, &covers, None).unwrap();

        let stored = {
            let mut statement = transaction
                .prepare(
                    "SELECT volume_number, edition_index, source_cover_id
                     FROM collection_volumes
                     WHERE collection_id = ?1
                     ORDER BY volume_number, edition_index",
                )
                .unwrap();
            statement
                .query_map([&work.id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, u8>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            stored,
            vec![
                (1, 2, "cover-1-2".into()),
                (2, 0, "cover-2".into()),
                (10, 0, "cover-10".into()),
            ]
        );
    }

    #[test]
    fn list_volumes_imports_local_first_covers_once_without_touching_originals() {
        let temp = tempfile::tempdir().unwrap();
        let library_root = temp.path().join("library");
        let source_root = temp.path().join("source");
        let covers_dir = source_root.join("manga/work/covers");
        fs::create_dir_all(&covers_dir).unwrap();
        for file_name in [
            "vol_1_local.png",
            "vol_1_second.png",
            "vol_2.3_local.png",
            "vol_3.5_unsupported.png",
        ] {
            fs::write(covers_dir.join(file_name), cover_bytes()).unwrap();
        }
        let library = Library::open(&library_root).unwrap();
        library
            .set_collection_source_root(Some(source_root.to_str().unwrap()))
            .unwrap();
        let work = library
            .create_collection(CreateCollection {
                name: "Work".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE collections SET source_path = 'manga/work' WHERE id = ?1",
                [&work.id],
            )
            .unwrap();
        let snapshot = serde_json::json!({
            "covers": {
                "result": "ok",
                "data": [
                    {
                        "id": "11111111-1111-4111-8111-111111111111",
                        "attributes": { "volume": "1", "fileName": "provider.jpg", "locale": "ja" },
                        "relationships": [{ "id": MANGA_ID, "type": "manga" }]
                    },
                    {
                        "id": "not-a-uuid",
                        "attributes": { "volume": "2", "fileName": "bad.jpg", "locale": "ja" },
                        "relationships": [{ "id": MANGA_ID, "type": "manga" }]
                    }
                ]
            }
        })
        .to_string();
        library
            .upsert_collection_external_binding(
                &work.id,
                ExternalBindingInput {
                    provider: "mangadex".into(),
                    external_id: MANGA_ID.into(),
                    provider_data_json: Some(snapshot),
                    last_synced_at: None,
                },
            )
            .unwrap();

        let volumes = library.list_collection_volumes(&work.id).unwrap();

        assert_eq!(
            volumes
                .iter()
                .map(|volume| (volume.display_label.clone(), volume.cover_artwork_id.is_some()))
                .collect::<Vec<_>>(),
            vec![("1".into(), true), ("2.3".into(), true)]
        );
        let source: (Option<String>, Option<String>) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT source_provider, source_file_name FROM collection_volumes
                 WHERE collection_id = ?1 AND volume_number = 1 AND edition_index = 0",
                [&work.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(source, (Some("local".into()), Some("vol_1_local.png".into())));
        let counts_before: (i64, i64) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM collection_volumes WHERE collection_id = ?1),
                    (SELECT COUNT(*) FROM collection_work_artworks WHERE collection_id = ?1)",
                [&work.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        library.list_collection_volumes(&work.id).unwrap();

        let counts_after: (i64, i64) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM collection_volumes WHERE collection_id = ?1),
                    (SELECT COUNT(*) FROM collection_work_artworks WHERE collection_id = ?1)",
                [&work.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts_after, counts_before);
        for file_name in [
            "vol_1_local.png",
            "vol_1_second.png",
            "vol_2.3_local.png",
            "vol_3.5_unsupported.png",
        ] {
            assert!(covers_dir.join(file_name).is_file());
        }
    }

    #[test]
    fn sync_continues_after_failure_and_retries_only_missing_volumes() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let work = library
            .create_collection(CreateCollection {
                name: "Work".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        library
            .upsert_collection_external_binding(
                &work.id,
                ExternalBindingInput {
                    provider: "mangadex".into(),
                    external_id: MANGA_ID.into(),
                    provider_data_json: None,
                    last_synced_at: None,
                },
            )
            .unwrap();
        let covers = vec![
            candidate("11111111-1111-4111-8111-111111111111", "one.jpg", "1", "ja"),
            candidate("22222222-2222-4222-8222-222222222222", "two.jpg", "2", "ja"),
            candidate("33333333-3333-4333-8333-333333333333", "three.jpg", "3", "ja"),
        ];
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            materialize_mangadex_volumes(&transaction, &work.id, &covers, None).unwrap();
            transaction
                .execute(
                    "INSERT INTO collection_work_artworks (
                        id, collection_id, provider, provider_image_id, kind, relative_path,
                        mime_type, width, height, language, selected, created_at, updated_at
                     ) VALUES (
                        'art-one', ?1, 'mangadex', ?2, 'volume_cover',
                        'work-artwork/existing-one.jpg', 'image/jpeg', 100, 150,
                        'ja', 0, 't', 't'
                     )",
                    rusqlite::params![work.id, covers[0].cover_id],
                )
                .unwrap();
            transaction
                .execute(
                    "UPDATE collection_volumes SET cover_artwork_id = 'art-one'
                     WHERE collection_id = ?1 AND volume_number = 1 AND edition_index = 0",
                    [&work.id],
                )
                .unwrap();
            transaction.commit().unwrap();
        }
        let mut first_calls = Vec::new();

        let first = library
            .sync_mangadex_volume_covers_with(&work.id, |manga_id, file_name| {
                first_calls.push((manga_id.to_owned(), file_name.to_owned()));
                if file_name == "two.jpg" {
                    Err(crate::library::error::LibraryError::MangaDexUnavailable)
                } else {
                    Ok(cover_bytes())
                }
            })
            .unwrap();

        assert_eq!(
            first,
            crate::library::models::MangaDexVolumeSyncResult {
                completed: 1,
                skipped: 1,
                failed: 1,
            }
        );
        assert_eq!(
            first_calls,
            vec![
                (MANGA_ID.into(), "two.jpg".into()),
                (MANGA_ID.into(), "three.jpg".into()),
            ]
        );
        let mut second_calls = Vec::new();

        let second = library
            .sync_mangadex_volume_covers_with(&work.id, |manga_id, file_name| {
                second_calls.push((manga_id.to_owned(), file_name.to_owned()));
                Ok(cover_bytes())
            })
            .unwrap();

        assert_eq!(
            second,
            crate::library::models::MangaDexVolumeSyncResult {
                completed: 1,
                skipped: 2,
                failed: 0,
            }
        );
        assert_eq!(second_calls, vec![(MANGA_ID.into(), "two.jpg".into())]);
    }
}
