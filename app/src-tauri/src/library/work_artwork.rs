use std::{collections::BTreeSet, fs, path::PathBuf};

use image::ImageFormat;
use rusqlite::{params, OptionalExtension, Transaction};

use super::{collection::require_collection, error::LibraryError, Library, MediaResponse};

const MAX_WORK_ARTWORK_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct PreparedWorkArtwork {
    pub id: String,
    pub relative_path: String,
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
    absolute_path: PathBuf,
    committed: bool,
}

impl Drop for PreparedWorkArtwork {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.absolute_path);
        }
    }
}

impl PreparedWorkArtwork {
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

impl Library {
    pub(crate) fn prepare_work_artwork(
        &self,
        collection_id: &str,
        bytes: &[u8],
    ) -> Result<PreparedWorkArtwork, LibraryError> {
        if bytes.is_empty() || bytes.len() > MAX_WORK_ARTWORK_BYTES {
            return Err(LibraryError::InvalidWorkArtwork);
        }
        uuid::Uuid::parse_str(collection_id).map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let format = image::guess_format(bytes).map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let (extension, mime_type) = match format {
            ImageFormat::Jpeg => ("jpg", "image/jpeg"),
            ImageFormat::Png => ("png", "image/png"),
            ImageFormat::WebP => ("webp", "image/webp"),
            _ => return Err(LibraryError::InvalidWorkArtwork),
        };
        let image = image::load_from_memory_with_format(bytes, format)
            .map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let id = uuid::Uuid::new_v4().to_string();
        let relative_path = format!("work-artwork/{collection_id}/{id}.{extension}");
        let absolute_path = self.root().join(&relative_path);
        let directory = absolute_path
            .parent()
            .expect("generated WorkArtwork paths have a parent");
        fs::create_dir_all(directory).map_err(|source| LibraryError::WriteWorkArtwork {
            path: directory.to_path_buf(),
            source,
        })?;
        if let Err(source) = fs::write(&absolute_path, bytes) {
            let _ = fs::remove_file(&absolute_path);
            return Err(LibraryError::WriteWorkArtwork {
                path: absolute_path,
                source,
            });
        }
        Ok(PreparedWorkArtwork {
            id,
            relative_path,
            mime_type,
            width: image.width(),
            height: image.height(),
            absolute_path,
            committed: false,
        })
    }

    pub(crate) fn select_work_artwork_in_transaction(
        transaction: &Transaction<'_>,
        collection_id: &str,
        provider: &str,
        provider_image_id: &str,
        language: Option<&str>,
        prepared: &PreparedWorkArtwork,
    ) -> Result<String, LibraryError> {
        require_collection(transaction, collection_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE collection_work_artworks
             SET selected = 0, updated_at = ?1
             WHERE collection_id = ?2 AND kind = 'cover' AND selected = 1",
            params![now, collection_id],
        )?;
        transaction.execute(
            "INSERT INTO collection_work_artworks (
                id, collection_id, provider, provider_image_id, kind, relative_path,
                mime_type, width, height, language, selected, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'cover', ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)
             ON CONFLICT(collection_id, provider, provider_image_id) DO UPDATE SET
                relative_path = excluded.relative_path,
                mime_type = excluded.mime_type,
                width = excluded.width,
                height = excluded.height,
                language = excluded.language,
                selected = 1,
                updated_at = excluded.updated_at",
            params![
                prepared.id,
                collection_id,
                provider,
                provider_image_id,
                prepared.relative_path,
                prepared.mime_type,
                prepared.width,
                prepared.height,
                language,
                now,
            ],
        )?;
        transaction
            .query_row(
                "SELECT id FROM collection_work_artworks
                 WHERE collection_id = ?1 AND provider = ?2 AND provider_image_id = ?3",
                params![collection_id, provider, provider_image_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn resolve_work_artwork(
        &self,
        artwork_id: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let relative_path = self
            .connection()?
            .query_row(
                "SELECT relative_path FROM collection_work_artworks WHERE id = ?1",
                [artwork_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(LibraryError::MediaNotFound)?;
        self.open_library_media(&relative_path)
    }

    pub(crate) fn cleanup_unreferenced_work_artwork(&self) -> Result<(), LibraryError> {
        let referenced = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT relative_path FROM collection_work_artworks ORDER BY relative_path",
            )?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|path| path.map(|path| self.root().join(path)))
                .collect::<Result<BTreeSet<_>, _>>()?;
            paths
        };
        let artwork_root = self.root().join("work-artwork");
        for collection_entry in fs::read_dir(&artwork_root).map_err(|source| {
            LibraryError::WriteWorkArtwork {
                path: artwork_root.clone(),
                source,
            }
        })? {
            let collection_entry = collection_entry.map_err(|source| {
                LibraryError::WriteWorkArtwork {
                    path: artwork_root.clone(),
                    source,
                }
            })?;
            if !collection_entry
                .file_type()
                .map_err(|source| LibraryError::WriteWorkArtwork {
                    path: collection_entry.path(),
                    source,
                })?
                .is_dir()
            {
                continue;
            }
            for file_entry in fs::read_dir(collection_entry.path()).map_err(|source| {
                LibraryError::WriteWorkArtwork {
                    path: collection_entry.path(),
                    source,
                }
            })? {
                let file_entry = file_entry.map_err(|source| LibraryError::WriteWorkArtwork {
                    path: collection_entry.path(),
                    source,
                })?;
                let path = file_entry.path();
                if file_entry
                    .file_type()
                    .map_err(|source| LibraryError::WriteWorkArtwork {
                        path: path.clone(),
                        source,
                    })?
                    .is_file()
                    && !referenced.contains(&path)
                {
                    fs::remove_file(&path).map_err(|source| {
                        LibraryError::WriteWorkArtwork {
                            path: path.clone(),
                            source,
                        }
                    })?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use image::{DynamicImage, ImageFormat};

    use crate::library::{
        error::LibraryError,
        models::{CollectionType, CreateCollection},
        Library,
    };

    use super::MAX_WORK_ARTWORK_BYTES;

    fn png_bytes() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(12, 18)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn prepared_artwork_is_validated_and_removed_until_committed() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();

        assert!(library
            .prepare_work_artwork(&collection.id, b"not an image")
            .is_err());

        let prepared = library
            .prepare_work_artwork(&collection.id, &png_bytes())
            .unwrap();
        assert_eq!((prepared.width, prepared.height), (12, 18));
        assert_eq!(prepared.mime_type, "image/png");
        assert_eq!(
            prepared.relative_path,
            format!(
                "work-artwork/{}/{}.png",
                collection.id, prepared.id
            )
        );
        let stored_path = library.root().join(&prepared.relative_path);
        assert!(stored_path.is_file());

        drop(prepared);

        assert!(!stored_path.exists());
    }

    #[test]
    fn artwork_larger_than_the_persistent_limit_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let mut bytes = png_bytes();
        bytes.resize(MAX_WORK_ARTWORK_BYTES + 1, 0);

        assert!(matches!(
            library.prepare_work_artwork(&collection.id, &bytes),
            Err(LibraryError::InvalidWorkArtwork)
        ));
    }

    #[test]
    fn selecting_artwork_switches_the_cover_and_resolves_it_by_id() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();

        let first = library
            .prepare_work_artwork(&collection.id, &png_bytes())
            .unwrap();
        let first_id = first.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "mangadex",
                "cover-1",
                Some("ja"),
                &first,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        first.commit();

        let second_bytes = png_bytes();
        let second = library
            .prepare_work_artwork(&collection.id, &second_bytes)
            .unwrap();
        let second_id = second.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "mangadex",
                "cover-2",
                None,
                &second,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        second.commit();

        let selected: Vec<(String, i64)> = {
            let connection = library.connection().unwrap();
            let mut statement = connection
                .prepare(
                    "SELECT id, selected FROM collection_work_artworks
                     WHERE collection_id = ?1 ORDER BY provider_image_id",
                )
                .unwrap();
            statement
                .query_map([&collection.id], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(selected, vec![(first_id, 0), (second_id.clone(), 1)]);

        let mut media = library.resolve_work_artwork(&second_id).unwrap();
        let mut served = Vec::new();
        media.file.read_to_end(&mut served).unwrap();
        assert_eq!(media.mime, "image/png");
        assert_eq!(served, second_bytes);
    }

    #[test]
    fn reopening_removes_only_unreferenced_artwork_files() {
        let temp = tempfile::tempdir().unwrap();
        let (stored_path, orphan_path) = {
            let library = Library::open(temp.path()).unwrap();
            let collection = library
                .create_collection(CreateCollection {
                    name: "Dungeon Meshi".into(),
                    description: None,
                    collection_type: CollectionType::Manga,
                })
                .unwrap();
            let prepared = library
                .prepare_work_artwork(&collection.id, &png_bytes())
                .unwrap();
            let stored_path = library.root().join(&prepared.relative_path);
            {
                let mut connection = library.connection().unwrap();
                let transaction = connection.transaction().unwrap();
                Library::select_work_artwork_in_transaction(
                    &transaction,
                    &collection.id,
                    "mangadex",
                    "cover-1",
                    None,
                    &prepared,
                )
                .unwrap();
                transaction.commit().unwrap();
            }
            prepared.commit();
            let orphan_path = stored_path.parent().unwrap().join("orphan.png");
            std::fs::write(&orphan_path, png_bytes()).unwrap();
            (stored_path, orphan_path)
        };

        let _reopened = Library::open(temp.path()).unwrap();

        assert!(stored_path.is_file());
        assert!(!orphan_path.exists());
    }
}
