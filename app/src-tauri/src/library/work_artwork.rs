use std::{
    collections::BTreeSet,
    fs,
    io::{BufReader, BufWriter},
    path::{Path, PathBuf},
};

use image::ImageFormat;
use rusqlite::{params, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

use super::{collection::require_collection, error::LibraryError, models::WorkArtworkSummary, Library, MediaResponse};

pub(crate) const MAX_WORK_ARTWORK_BYTES: usize = 32 * 1024 * 1024;
const WORK_ARTWORK_THUMBNAIL_BOUND: u32 = 360;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkArtworkKind {
    Cover,
    Hero,
    Backdrop,
    Screenshot,
}

impl WorkArtworkKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cover => "cover",
            Self::Hero => "hero",
            Self::Backdrop => "backdrop",
            Self::Screenshot => "screenshot",
        }
    }
}

pub(crate) struct PreparedWorkArtwork {
    pub id: String,
    pub relative_path: String,
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
    absolute_path: PathBuf,
    thumbnail_absolute_path: PathBuf,
    committed: bool,
}

impl Drop for PreparedWorkArtwork {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.absolute_path);
            let _ = fs::remove_file(&self.thumbnail_absolute_path);
        }
    }
}

impl PreparedWorkArtwork {
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

struct ReusableAssetFile {
    relative_path: String,
    thumbnail_relative_path: Option<String>,
    byte_size: i64,
    width: i64,
    height: i64,
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
        let thumbnail_relative_path = work_artwork_thumbnail_relative_path(collection_id, &id);
        let thumbnail_absolute_path = self.root().join(&thumbnail_relative_path);
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
        if let Err(error) = write_work_artwork_thumbnail(&image, &thumbnail_absolute_path) {
            let _ = fs::remove_file(&absolute_path);
            let _ = fs::remove_file(&thumbnail_absolute_path);
            return Err(error);
        }
        Ok(PreparedWorkArtwork {
            id,
            relative_path,
            mime_type,
            width: image.width(),
            height: image.height(),
            absolute_path,
            thumbnail_absolute_path,
            committed: false,
        })
    }

    /// 이미 중앙 라이브러리 에셋으로 존재하는 바이트를 작품 아트웍으로 재사용한다.
    ///
    /// Collection 전용 원본 복사·디코드·썸네일 인코딩 대신, 에셋 파일과 썸네일을
    /// 아트웍 전용 경로에 하드링크로 연결한다(실패하면 복사로 폴백). 각 아트웍 행은
    /// 여전히 고유한 `relative_path`를 가지므로 스키마·정리·삭제 경로가 그대로 동작하고,
    /// 에셋이 휴지통 비우기로 사라져도 링크가 바이트를 유지하므로 아트웍이 깨지지 않는다.
    /// 재사용할 에셋이 없으면 `Ok(None)`을 반환하고 호출자는 기존 prepare 경로를 쓴다.
    pub(crate) fn reuse_asset_artwork(
        &self,
        collection_id: &str,
        bytes: &[u8],
    ) -> Result<Option<PreparedWorkArtwork>, LibraryError> {
        if bytes.is_empty() || bytes.len() > MAX_WORK_ARTWORK_BYTES {
            return Ok(None);
        }
        uuid::Uuid::parse_str(collection_id).map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let asset: Option<ReusableAssetFile> = self
            .connection()?
            .query_row(
                "SELECT relative_path, thumbnail_relative_path, byte_size, width, height
                 FROM assets WHERE content_hash = ?1 AND media_kind = 'image'",
                [&content_hash],
                |row| {
                    Ok(ReusableAssetFile {
                        relative_path: row.get(0)?,
                        thumbnail_relative_path: row.get(1)?,
                        byte_size: row.get(2)?,
                        width: row.get(3)?,
                        height: row.get(4)?,
                    })
                },
            )
            .optional()?;
        let Some(asset) = asset else {
            return Ok(None);
        };
        if asset.width <= 0 || asset.height <= 0 || asset.byte_size > MAX_WORK_ARTWORK_BYTES as i64
        {
            return Ok(None);
        }
        let (extension, mime_type) = match asset
            .relative_path
            .rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("jpg") | Some("jpeg") => ("jpg", "image/jpeg"),
            Some("png") => ("png", "image/png"),
            Some("webp") => ("webp", "image/webp"),
            _ => return Ok(None),
        };
        let asset_absolute_path = self.root().join(&asset.relative_path);
        if !asset_absolute_path.is_file() {
            return Ok(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let relative_path = format!("work-artwork/{collection_id}/{id}.{extension}");
        let absolute_path = self.root().join(&relative_path);
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|source| LibraryError::WriteWorkArtwork {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        if fs::hard_link(&asset_absolute_path, &absolute_path).is_err() {
            if fs::copy(&asset_absolute_path, &absolute_path).is_err() {
                let _ = fs::remove_file(&absolute_path);
                return Ok(None);
            }
        }
        let thumbnail_relative_path = work_artwork_thumbnail_relative_path(collection_id, &id);
        let thumbnail_absolute_path = self.root().join(&thumbnail_relative_path);
        if let Some(asset_thumbnail) = asset.thumbnail_relative_path {
            let asset_thumbnail_absolute = self.root().join(&asset_thumbnail);
            if asset_thumbnail_absolute.is_file() {
                if let Some(parent) = thumbnail_absolute_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if fs::hard_link(&asset_thumbnail_absolute, &thumbnail_absolute_path).is_err() {
                    let _ = fs::copy(&asset_thumbnail_absolute, &thumbnail_absolute_path);
                }
            }
        }
        #[allow(clippy::cast_sign_loss)]
        let width = asset.width as u32;
        #[allow(clippy::cast_sign_loss)]
        let height = asset.height as u32;
        Ok(Some(PreparedWorkArtwork {
            id,
            relative_path,
            mime_type,
            width,
            height,
            absolute_path,
            thumbnail_absolute_path,
            committed: false,
        }))
    }

    pub(crate) fn select_work_artwork_in_transaction(
        transaction: &Transaction<'_>,
        collection_id: &str,
        provider: &str,
        provider_image_id: &str,
        language: Option<&str>,
        prepared: &PreparedWorkArtwork,
    ) -> Result<String, LibraryError> {
        Self::insert_work_artwork_in_transaction(
            transaction,
            collection_id,
            provider,
            provider_image_id,
            WorkArtworkKind::Cover,
            language,
            prepared,
        )
    }

    pub(crate) fn insert_work_artwork_in_transaction(
        transaction: &Transaction<'_>,
        collection_id: &str,
        provider: &str,
        provider_image_id: &str,
        kind: WorkArtworkKind,
        language: Option<&str>,
        prepared: &PreparedWorkArtwork,
    ) -> Result<String, LibraryError> {
        require_collection(transaction, collection_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO collection_work_artworks (
                id, collection_id, provider, provider_image_id, kind, relative_path,
                mime_type, width, height, language, selected, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11)
             ON CONFLICT(collection_id, provider, provider_image_id) DO UPDATE SET
                relative_path = excluded.relative_path,
                mime_type = excluded.mime_type,
                width = excluded.width,
                height = excluded.height,
                language = excluded.language,
                selected = 0,
                updated_at = excluded.updated_at",
            params![
                prepared.id,
                collection_id,
                provider,
                provider_image_id,
                kind.as_str(),
                prepared.relative_path,
                prepared.mime_type,
                prepared.width,
                prepared.height,
                language,
                now,
            ],
        )?;
        let artwork_id: String = transaction.query_row(
            "SELECT id FROM collection_work_artworks
             WHERE collection_id = ?1 AND provider = ?2 AND provider_image_id = ?3",
            params![collection_id, provider, provider_image_id],
            |row| row.get(0),
        )?;
        Self::select_work_artwork_kind_in_transaction(
            transaction,
            collection_id,
            &artwork_id,
            kind,
        )?;
        Ok(artwork_id)
    }

    pub(crate) fn select_work_artwork_kind_in_transaction(
        transaction: &Transaction<'_>,
        collection_id: &str,
        artwork_id: &str,
        kind: WorkArtworkKind,
    ) -> Result<(), LibraryError> {
        require_collection(transaction, collection_id)?;
        let belongs: bool = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM collection_work_artworks
                WHERE id = ?1 AND collection_id = ?2 AND kind = ?3
            )",
            params![artwork_id, collection_id, kind.as_str()],
            |row| row.get(0),
        )?;
        if !belongs {
            return Err(LibraryError::InvalidWorkArtwork);
        }
        let now = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE collection_work_artworks
             SET selected = 0, updated_at = ?1
             WHERE collection_id = ?2 AND kind = ?3 AND selected = 1",
            params![now, collection_id, kind.as_str()],
        )?;
        transaction.execute(
            "UPDATE collection_work_artworks
             SET selected = 1, updated_at = ?1
             WHERE id = ?2 AND collection_id = ?3 AND kind = ?4",
            params![now, artwork_id, collection_id, kind.as_str()],
        )?;
        Ok(())
    }

    pub(crate) fn clear_work_artwork_kind_in_transaction(
        transaction: &Transaction<'_>,
        collection_id: &str,
        kind: WorkArtworkKind,
    ) -> Result<(), LibraryError> {
        require_collection(transaction, collection_id)?;
        transaction.execute(
            "UPDATE collection_work_artworks
             SET selected = 0, updated_at = ?1
             WHERE collection_id = ?2 AND kind = ?3 AND selected = 1",
            params![
                chrono::Utc::now().to_rfc3339(),
                collection_id,
                kind.as_str()
            ],
        )?;
        Ok(())
    }

    pub(crate) fn insert_volume_work_artwork_in_transaction(
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
            "INSERT INTO collection_work_artworks (
                id, collection_id, provider, provider_image_id, kind, relative_path,
                mime_type, width, height, language, selected, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'volume_cover', ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
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
        Ok(prepared.id.clone())
    }

    // 컬렉션에 등록된 모든 Work 아트워크 목록. 뷰어의 스크린샷·아트웍 갤러리가 쓴다.
    pub fn list_collection_work_artworks(
        &self,
        collection_id: &str,
    ) -> Result<Vec<WorkArtworkSummary>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, selected FROM collection_work_artworks
             WHERE collection_id = ?1
             ORDER BY CASE kind WHEN 'cover' THEN 0 WHEN 'hero' THEN 1 ELSE 2 END,
                      selected DESC, created_at, id",
        )?;
        let artworks = statement
            .query_map([collection_id], |row| {
                Ok(WorkArtworkSummary {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    selected: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(artworks)
    }

    pub fn resolve_work_artwork(&self, artwork_id: &str) -> Result<MediaResponse, LibraryError> {
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

    pub fn resolve_work_artwork_thumbnail(
        &self,
        artwork_id: &str,
    ) -> Result<MediaResponse, LibraryError> {
        uuid::Uuid::parse_str(artwork_id).map_err(|_| LibraryError::MediaNotFound)?;
        let (collection_id, relative_path) = self
            .connection()?
            .query_row(
                "SELECT collection_id, relative_path
                 FROM collection_work_artworks WHERE id = ?1",
                [artwork_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::MediaNotFound)?;
        let thumbnail_relative_path =
            self.ensure_work_artwork_thumbnail(&collection_id, artwork_id, &relative_path)?;
        self.open_library_media(&thumbnail_relative_path)
    }

    pub(crate) fn backfill_missing_work_artwork_thumbnails(&self) -> Result<(), LibraryError> {
        let artworks = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id, collection_id, relative_path
                 FROM collection_work_artworks ORDER BY relative_path",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        for (artwork_id, collection_id, relative_path) in artworks {
            let _ = self.ensure_work_artwork_thumbnail(&collection_id, &artwork_id, &relative_path);
        }
        Ok(())
    }

    pub(crate) fn start_work_artwork_thumbnail_backfill(&self) {
        let has_artwork = self.connection().and_then(|connection| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM collection_work_artworks LIMIT 1)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(LibraryError::from)
        });
        if matches!(has_artwork, Ok(false)) {
            return;
        }

        let library = self.clone();
        let _ = std::thread::Builder::new()
            .name("work-artwork-thumbnail-backfill".into())
            .spawn(move || {
                let _ = library.backfill_missing_work_artwork_thumbnails();
            });
    }

    fn ensure_work_artwork_thumbnail(
        &self,
        collection_id: &str,
        artwork_id: &str,
        relative_path: &str,
    ) -> Result<String, LibraryError> {
        let thumbnail_relative_path =
            work_artwork_thumbnail_relative_path(collection_id, artwork_id);
        let thumbnail_path = self.root().join(&thumbnail_relative_path);
        if thumbnail_path.exists() {
            return Ok(thumbnail_relative_path);
        }

        let media = self.open_library_media(relative_path)?;
        let image = image::ImageReader::new(BufReader::new(media.file))
            .with_guessed_format()
            .map_err(|_| LibraryError::InvalidWorkArtwork)?
            .decode()
            .map_err(|_| LibraryError::InvalidWorkArtwork)?;
        let temporary_path = thumbnail_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        if let Err(error) = write_work_artwork_thumbnail(&image, &temporary_path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
        if let Err(source) = fs::rename(&temporary_path, &thumbnail_path) {
            let _ = fs::remove_file(&temporary_path);
            if !thumbnail_path.exists() {
                return Err(LibraryError::WriteWorkArtwork {
                    path: thumbnail_path,
                    source,
                });
            }
        }
        Ok(thumbnail_relative_path)
    }

    pub(crate) fn cleanup_unreferenced_work_artwork(&self) -> Result<(), LibraryError> {
        let (referenced_artwork, referenced_thumbnails) = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id, collection_id, relative_path
                 FROM collection_work_artworks ORDER BY relative_path",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let artwork = rows
                .iter()
                .map(|(_, _, path)| self.root().join(path))
                .collect();
            let thumbnails = rows
                .iter()
                .map(|(id, collection_id, _)| {
                    self.root()
                        .join(work_artwork_thumbnail_relative_path(collection_id, id))
                })
                .collect();
            (artwork, thumbnails)
        };
        cleanup_unreferenced_files(&self.root().join("work-artwork"), &referenced_artwork)?;
        cleanup_unreferenced_files(
            &self.root().join("work-artwork-thumbnails"),
            &referenced_thumbnails,
        )?;
        Ok(())
    }
}

fn work_artwork_thumbnail_relative_path(collection_id: &str, artwork_id: &str) -> String {
    format!("work-artwork-thumbnails/{collection_id}/{artwork_id}.webp")
}

fn write_work_artwork_thumbnail(
    image: &image::DynamicImage,
    path: &std::path::Path,
) -> Result<(), LibraryError> {
    let directory = path
        .parent()
        .expect("generated WorkArtwork thumbnail paths have a parent");
    fs::create_dir_all(directory).map_err(|source| LibraryError::WriteWorkArtwork {
        path: directory.to_path_buf(),
        source,
    })?;
    let file = fs::File::create(path).map_err(|source| LibraryError::WriteWorkArtwork {
        path: path.to_path_buf(),
        source,
    })?;
    image
        .thumbnail(WORK_ARTWORK_THUMBNAIL_BOUND, WORK_ARTWORK_THUMBNAIL_BOUND)
        .write_to(&mut BufWriter::new(file), ImageFormat::WebP)
        .map_err(|source| LibraryError::WriteWorkArtwork {
            path: path.to_path_buf(),
            source: std::io::Error::other(source),
        })
}

fn cleanup_unreferenced_files(
    root: &Path,
    referenced: &BTreeSet<PathBuf>,
) -> Result<(), LibraryError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(LibraryError::WriteWorkArtwork {
                path: root.to_path_buf(),
                source,
            })
        }
    };
    for directory_entry in entries {
        let directory_entry = directory_entry.map_err(|source| LibraryError::WriteWorkArtwork {
            path: root.to_path_buf(),
            source,
        })?;
        if !directory_entry
            .file_type()
            .map_err(|source| LibraryError::WriteWorkArtwork {
                path: directory_entry.path(),
                source,
            })?
            .is_dir()
        {
            continue;
        }
        let directory = directory_entry.path();
        for file_entry in
            fs::read_dir(&directory).map_err(|source| LibraryError::WriteWorkArtwork {
                path: directory.clone(),
                source,
            })?
        {
            let file_entry = file_entry.map_err(|source| LibraryError::WriteWorkArtwork {
                path: directory.clone(),
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
                fs::remove_file(&path).map_err(|source| LibraryError::WriteWorkArtwork {
                    path: path.clone(),
                    source,
                })?;
            }
        }
        if fs::read_dir(&directory)
            .map_err(|source| LibraryError::WriteWorkArtwork {
                path: directory.clone(),
                source,
            })?
            .next()
            .is_none()
        {
            fs::remove_dir(&directory).map_err(|source| LibraryError::WriteWorkArtwork {
                path: directory,
                source,
            })?;
        }
    }
    Ok(())
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

    use super::{WorkArtworkKind, MAX_WORK_ARTWORK_BYTES};

    fn png_bytes() -> Vec<u8> {
        png_bytes_at(12, 18)
    }

    fn png_bytes_at(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn list_collection_work_artorders_covers_before_hero_and_marks_selection() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Astral Chain".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        let insert = |library: &Library, id: &str, kind: &str, selected: bool| {
            library
                .connection()
                .unwrap()
                .execute(
                    "INSERT INTO collection_work_artworks (
                        id, collection_id, provider, provider_image_id, kind, relative_path,
                        mime_type, width, height, language, selected, created_at, updated_at
                     ) VALUES (?1, ?2, 'local', ?1, ?3, ?5, 'image/png', 10, 10, NULL, ?4, 't', 't')",
                    rusqlite::params![
                        id,
                        collection.id,
                        kind,
                        selected,
                        format!("work-artwork/{}/{}.jpg", collection.id, id)
                    ],
                )
                .unwrap();
        };
        insert(&library, "hero-1", "hero", false);
        insert(&library, "cover-1", "cover", false);
        insert(&library, "cover-2", "cover", true);
        insert(&library, "hero-2", "hero", false);
        insert(&library, "backdrop-1", "backdrop", false);

        let artworks = library.list_collection_work_artworks(&collection.id).unwrap();

        assert_eq!(
            artworks
                .iter()
                .map(|artwork| (artwork.id.as_str(), artwork.selected))
                .collect::<Vec<_>>(),
            [
                ("cover-2", true),
                ("cover-1", false),
                ("hero-1", false),
                ("hero-2", false),
                ("backdrop-1", false),
            ]
        );
    }

    #[test]
    fn prepared_artwork_writes_a_bounded_thumbnail_and_drop_removes_both() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();

        let prepared = library
            .prepare_work_artwork(&collection.id, &png_bytes_at(900, 1350))
            .unwrap();
        let original = library.root().join(&prepared.relative_path);
        let thumbnail = library.root().join(format!(
            "work-artwork-thumbnails/{}/{}.webp",
            collection.id, prepared.id
        ));
        let decoded = image::open(&thumbnail).unwrap();

        assert!(original.exists());
        assert!(decoded.width() <= 360);
        assert!(decoded.height() <= 360);
        assert_eq!(decoded.width() * 3, decoded.height() * 2);

        drop(prepared);
        assert!(!original.exists());
        assert!(!thumbnail.exists());
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
            format!("work-artwork/{}/{}.png", collection.id, prepared.id)
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
    fn selected_cover_and_hero_can_coexist_for_one_collection() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Example Game".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();

        let cover = library
            .prepare_work_artwork(&collection.id, &png_bytes())
            .unwrap();
        let cover_id = cover.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "cover-1",
                None,
                &cover,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        cover.commit();

        let hero = library
            .prepare_work_artwork(&collection.id, &png_bytes_at(16, 9))
            .unwrap();
        let hero_id = hero.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "hero-1",
                WorkArtworkKind::Hero,
                None,
                &hero,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        hero.commit();

        let selected: Vec<(String, String, i64)> = library
            .connection()
            .unwrap()
            .prepare(
                "SELECT id, kind, selected FROM collection_work_artworks
                 WHERE collection_id = ?1 ORDER BY kind",
            )
            .unwrap()
            .query_map([&collection.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(
            selected,
            vec![(cover_id, "cover".into(), 1), (hero_id, "hero".into(), 1)]
        );
    }

    #[test]
    fn selecting_a_second_hero_preserves_the_selected_cover() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Example Game".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();

        let cover = library
            .prepare_work_artwork(&collection.id, &png_bytes())
            .unwrap();
        let cover_id = cover.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "cover-1",
                None,
                &cover,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        cover.commit();

        let first_hero = library
            .prepare_work_artwork(&collection.id, &png_bytes_at(16, 9))
            .unwrap();
        let first_hero_id = first_hero.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "hero-1",
                WorkArtworkKind::Hero,
                None,
                &first_hero,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        first_hero.commit();

        let second_hero = library
            .prepare_work_artwork(&collection.id, &png_bytes_at(20, 11))
            .unwrap();
        let second_hero_id = second_hero.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "hero-2",
                WorkArtworkKind::Hero,
                None,
                &second_hero,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        second_hero.commit();

        let selected: Vec<(String, String, i64)> = library
            .connection()
            .unwrap()
            .prepare(
                "SELECT id, kind, selected FROM collection_work_artworks
                 WHERE collection_id = ?1 ORDER BY provider_image_id",
            )
            .unwrap()
            .query_map([&collection.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(
            selected,
            vec![
                (cover_id, "cover".into(), 1),
                (first_hero_id, "hero".into(), 0),
                (second_hero_id, "hero".into(), 1),
            ]
        );
    }

    #[test]
    fn selecting_artwork_under_the_wrong_kind_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Example Game".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        let cover = library
            .prepare_work_artwork(&collection.id, &png_bytes())
            .unwrap();
        let cover_id = cover.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "cover-1",
                None,
                &cover,
            )
            .unwrap();
            assert!(matches!(
                Library::select_work_artwork_kind_in_transaction(
                    &transaction,
                    &collection.id,
                    &cover_id,
                    WorkArtworkKind::Hero,
                ),
                Err(LibraryError::InvalidWorkArtwork)
            ));
            transaction.commit().unwrap();
        }
        cover.commit();
    }

    #[test]
    fn clearing_hero_preserves_the_selected_cover() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Example Game".into(),
                description: None,
                collection_type: CollectionType::Game,
            })
            .unwrap();
        let cover = library
            .prepare_work_artwork(&collection.id, &png_bytes())
            .unwrap();
        let cover_id = cover.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::select_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "cover-1",
                None,
                &cover,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        cover.commit();

        let hero = library
            .prepare_work_artwork(&collection.id, &png_bytes_at(16, 9))
            .unwrap();
        let hero_id = hero.id.clone();
        {
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            Library::insert_work_artwork_in_transaction(
                &transaction,
                &collection.id,
                "igdb",
                "hero-1",
                WorkArtworkKind::Hero,
                None,
                &hero,
            )
            .unwrap();
            Library::clear_work_artwork_kind_in_transaction(
                &transaction,
                &collection.id,
                WorkArtworkKind::Hero,
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        hero.commit();

        let selected: Vec<(String, String, i64)> = library
            .connection()
            .unwrap()
            .prepare(
                "SELECT id, kind, selected FROM collection_work_artworks
                 WHERE collection_id = ?1 ORDER BY kind",
            )
            .unwrap()
            .query_map([&collection.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(
            selected,
            vec![(cover_id, "cover".into(), 1), (hero_id, "hero".into(), 0)]
        );
    }

    #[test]
    fn thumbnail_resolver_backfills_missing_cache_and_returns_webp() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let prepared = library
            .prepare_work_artwork(&collection.id, &png_bytes_at(900, 1350))
            .unwrap();
        let artwork_id = prepared.id.clone();
        let thumbnail = library.root().join(format!(
            "work-artwork-thumbnails/{}/{}.webp",
            collection.id, artwork_id
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
        std::fs::remove_file(&thumbnail).unwrap();

        let mut media = library.resolve_work_artwork_thumbnail(&artwork_id).unwrap();
        let mut bytes = Vec::new();
        media.file.read_to_end(&mut bytes).unwrap();
        let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::WebP).unwrap();

        assert_eq!(media.mime, "image/webp");
        assert!(thumbnail.exists());
        assert_eq!((decoded.width(), decoded.height()), (240, 360));
    }

    #[test]
    fn backfill_creates_only_missing_thumbnails_and_continues_after_corrupt_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let collection = library
            .create_collection(CreateCollection {
                name: "Dungeon Meshi".into(),
                description: None,
                collection_type: CollectionType::Manga,
            })
            .unwrap();
        let artwork = [
            (
                "00000000-0000-0000-0000-000000000001",
                "cover-corrupt",
                "a-corrupt.png",
                b"not an image".to_vec(),
            ),
            (
                "00000000-0000-0000-0000-000000000002",
                "cover-valid",
                "b-valid.png",
                png_bytes_at(900, 1350),
            ),
            (
                "00000000-0000-0000-0000-000000000003",
                "cover-existing",
                "c-existing.png",
                png_bytes_at(900, 1350),
            ),
        ];

        for (id, provider_image_id, file_name, bytes) in &artwork {
            let relative_path = format!("work-artwork/{}/{file_name}", collection.id);
            let original_path = library.root().join(&relative_path);
            std::fs::create_dir_all(original_path.parent().unwrap()).unwrap();
            std::fs::write(original_path, bytes).unwrap();
            library
                .connection()
                .unwrap()
                .execute(
                    "INSERT INTO collection_work_artworks (
                        id, collection_id, provider, provider_image_id, kind, relative_path,
                        mime_type, width, height, language, selected, created_at, updated_at
                     ) VALUES (?1, ?2, 'test', ?3, 'cover', ?4,
                        'image/png', 900, 1350, 'ja', 0, ?5, ?5)",
                    rusqlite::params![
                        id,
                        collection.id,
                        provider_image_id,
                        relative_path,
                        "2026-08-22T00:00:00Z"
                    ],
                )
                .unwrap();
        }

        let corrupt_thumbnail = library.root().join(format!(
            "work-artwork-thumbnails/{}/{}.webp",
            collection.id, artwork[0].0
        ));
        let valid_thumbnail = library.root().join(format!(
            "work-artwork-thumbnails/{}/{}.webp",
            collection.id, artwork[1].0
        ));
        let existing_thumbnail = library.root().join(format!(
            "work-artwork-thumbnails/{}/{}.webp",
            collection.id, artwork[2].0
        ));
        std::fs::create_dir_all(existing_thumbnail.parent().unwrap()).unwrap();
        std::fs::write(&existing_thumbnail, b"keep me").unwrap();

        library.backfill_missing_work_artwork_thumbnails().unwrap();

        assert!(!corrupt_thumbnail.exists());
        assert!(valid_thumbnail.exists());
        assert_eq!(std::fs::read(existing_thumbnail).unwrap(), b"keep me");
        let decoded = image::open(valid_thumbnail).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (240, 360));
    }

    #[test]
    fn reopening_removes_only_unreferenced_artwork_files() {
        let temp = tempfile::tempdir().unwrap();
        let (stored_path, orphan_path, stored_thumbnail, orphan_thumbnail) = {
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
            let stored_thumbnail = library.root().join(format!(
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
                    None,
                    &prepared,
                )
                .unwrap();
                transaction.commit().unwrap();
            }
            prepared.commit();
            let orphan_path = stored_path.parent().unwrap().join("orphan.png");
            std::fs::write(&orphan_path, png_bytes()).unwrap();
            let orphan_thumbnail = stored_thumbnail.parent().unwrap().join("orphan.webp");
            std::fs::write(&orphan_thumbnail, b"orphan thumbnail").unwrap();
            (stored_path, orphan_path, stored_thumbnail, orphan_thumbnail)
        };

        let _reopened = Library::open(temp.path()).unwrap();

        assert!(stored_path.is_file());
        assert!(!orphan_path.exists());
        assert!(stored_thumbnail.is_file());
        assert!(!orphan_thumbnail.exists());
    }
}
