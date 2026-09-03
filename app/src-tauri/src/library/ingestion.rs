use std::{
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use chrono::{DateTime, SecondsFormat, Utc};
use image::{ImageFormat, ImageReader};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};

use crate::cloud::queue::enqueue_asset_upsert;

use super::{
    asset_metadata::normalize_source_metadata,
    error::LibraryError,
    image_fingerprint::ImageFingerprint,
    models::{
        AssetSummary, ImportSource, IngestMediaRequest, IngestOutcome, MediaSummary,
        SetAssetClassification, VideoPreparationState,
    },
    similarity::perceptual_hash_from_file,
    video_media::{probe_video, VideoProbe},
    Library,
};

pub(crate) const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 200_000_000;
const THUMBNAIL_BOUND: u32 = 360;
const THUMBNAIL_WEBP_QUALITY: f32 = 85.0;

fn normalize_collected_at(value: Option<&str>) -> Result<String, LibraryError> {
    let timestamp = match value {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .map_err(|_| LibraryError::InvalidCollectedAt)?
            .with_timezone(&Utc),
        None => Utc::now(),
    };
    Ok(timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

impl Library {
    pub fn ingest_media(
        &self,
        mut request: IngestMediaRequest,
    ) -> Result<IngestOutcome, LibraryError> {
        uuid::Uuid::parse_str(&request.import_batch_id)
            .map_err(|_| LibraryError::InvalidImportBatchId)?;
        let normalized = normalize_source_metadata(
            request.source_published_at,
            request.creator_name,
            request.creator_handle,
            request.creator_url,
        )?;
        request.source_published_at = normalized.published_at;
        request.creator_name = normalized.creator_name;
        request.creator_handle = normalized.creator_handle;
        request.creator_url = normalized.creator_url;
        let collected_at = normalize_collected_at(request.collected_at.as_deref())?;
        request.collected_at = Some(collected_at.clone());
        let _ingestion_guard = self
            .ingestion_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let kind = ingest_kind(&request.source_path)?;
        let source_metadata = fs::metadata(&request.source_path)
            .map_err(|source| read_source_error(&request.source_path, source))?;
        if !source_metadata.is_file() {
            return Err(read_source_error(
                &request.source_path,
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "source path is not a regular file",
                ),
            ));
        }
        if matches!(kind, IngestKind::Image) && source_metadata.len() > MAX_IMAGE_BYTES {
            return Err(LibraryError::UnsupportedImage);
        }
        let original_modified_at = if request.import_source == ImportSource::BrowserExtension {
            None
        } else {
            source_metadata
                .modified()
                .ok()
                .map(chrono::DateTime::<chrono::Utc>::from)
                .map(|value| value.to_rfc3339())
        };

        self.validate_classification(request.classification_id.as_deref())?;

        let staging_directory = self.root().join("assets").join(".staging");
        fs::create_dir_all(&staging_directory).map_err(|source| LibraryError::WriteAsset {
            path: staging_directory.clone(),
            source,
        })?;
        let staging_path = staging_directory.join(format!("{}.part", uuid::Uuid::new_v4()));
        let mut pending = PendingFiles::new();
        let maximum_bytes = matches!(kind, IngestKind::Image).then_some(MAX_IMAGE_BYTES);
        let (content_hash, byte_size) = copy_and_hash(
            &request.source_path,
            &staging_path,
            &mut pending,
            maximum_bytes,
        )?;
        run_staging_hook(&staging_path);

        match kind {
            IngestKind::Image => self.ingest_image(
                request,
                staging_path,
                content_hash,
                byte_size,
                pending,
                original_modified_at,
                collected_at,
            ),
            IngestKind::Video(extension) => self.ingest_video(
                request,
                staging_path,
                content_hash,
                byte_size,
                pending,
                extension,
                original_modified_at,
                collected_at,
            ),
        }
    }

    fn ingest_image(
        &self,
        request: IngestMediaRequest,
        staging_path: PathBuf,
        content_hash: String,
        byte_size: u64,
        mut pending: PendingFiles,
        original_modified_at: Option<String>,
        collected_at: String,
    ) -> Result<IngestOutcome, LibraryError> {
        let (format, width, height) = inspect_image(pending.owned_file(&staging_path)?)?;
        let existing_asset_id = self.find_asset_by_hash(&content_hash)?;
        if let Some(existing_asset_id) = existing_asset_id {
            return self.finish_exact_duplicate(existing_asset_id, &request);
        }
        run_after_duplicate_hook(self.root());
        let skip_similarity = request.import_source == ImportSource::LegacyLakomics;
        let (perceptual_hash, similar) = if skip_similarity {
            (None, None)
        } else {
            match perceptual_hash_from_file(pending.owned_file(&staging_path)?) {
                Ok(fingerprint) => {
                    let similar = self.find_similar_asset(&fingerprint, (width, height))?;
                    (Some(fingerprint), similar)
                }
                Err(LibraryError::UnsupportedImage) => (None, None),
                Err(error) => return Err(error),
            }
        };

        let prefix = &content_hash[..2];
        let thumbnail_relative_path = format!("thumbnails/{prefix}/{content_hash}.webp");
        let thumbnail_path = self.root().join(&thumbnail_relative_path);
        create_parent_directory(&thumbnail_path)?;
        let thumbnail_file = create_new_asset_file(&thumbnail_path)?;
        pending.track_created(thumbnail_path.clone(), &thumbnail_file)?;
        write_thumbnail(pending.owned_file(&staging_path)?, thumbnail_file)?;

        let relative_path = format!(
            "assets/{prefix}/{content_hash}.{}",
            extension_for(format).expect("inspect_image only returns supported formats")
        );
        let asset_path = self.root().join(&relative_path);
        create_parent_directory(&asset_path)?;
        install_staged_asset(&staging_path, &asset_path, &mut pending)?;

        let asset = AssetSummary {
            id: uuid::Uuid::new_v4().to_string(),
            title: None,
            original_name: original_name(&request.source_path),
            relative_path,
            thumbnail_relative_path: Some(thumbnail_relative_path),
            byte_size,
            width,
            height,
            collected_at,
            favorite: false,
            source_url: request.source_url.clone(),
            source_published_at: request.source_published_at.clone(),
            creator_name: request.creator_name.clone(),
            creator_handle: request.creator_handle.clone(),
            creator_url: request.creator_url.clone(),
            import_source: Some(request.import_source),
            import_batch_id: Some(request.import_batch_id.clone()),
            original_modified_at,
            media: if format == ImageFormat::Gif {
                MediaSummary::Gif
            } else {
                MediaSummary::Image
            },
        };
        let registration = similar.map_or(Registration::Normal, |candidate| Registration::Review {
            existing_asset_id: candidate.asset_id,
            distance: candidate.distance,
            review_id: uuid::Uuid::new_v4().to_string(),
        });
        self.register_asset(
            &asset,
            &content_hash,
            perceptual_hash,
            format,
            request.classification_id.as_deref(),
            &registration,
        )?;

        pending.commit();
        Ok(match registration {
            Registration::Normal => IngestOutcome::Added { asset },
            Registration::Review { review_id, .. } => IngestOutcome::ReviewPending { review_id },
        })
    }

    #[allow(clippy::too_many_arguments)] // Mirrors the image path; a context type would only move these one-shot values.
    fn ingest_video(
        &self,
        request: IngestMediaRequest,
        staging_path: PathBuf,
        content_hash: String,
        byte_size: u64,
        mut pending: PendingFiles,
        extension: &'static str,
        original_modified_at: Option<String>,
        collected_at: String,
    ) -> Result<IngestOutcome, LibraryError> {
        if let Some(existing_asset_id) = self.find_asset_by_hash(&content_hash)? {
            return self.finish_exact_duplicate(existing_asset_id, &request);
        }
        run_after_duplicate_hook(self.root());
        let probe = run_video_probe(&staging_path, extension)?;
        let prefix = &content_hash[..2];
        let relative_path = format!("assets/{prefix}/{content_hash}.{extension}");
        let asset_path = self.root().join(&relative_path);
        create_parent_directory(&asset_path)?;
        install_staged_asset(&staging_path, &asset_path, &mut pending)?;

        let asset = AssetSummary {
            id: uuid::Uuid::new_v4().to_string(),
            title: None,
            original_name: original_name(&request.source_path),
            relative_path,
            thumbnail_relative_path: None,
            byte_size,
            width: probe.width,
            height: probe.height,
            collected_at,
            favorite: false,
            source_url: request.source_url.clone(),
            source_published_at: request.source_published_at.clone(),
            creator_name: request.creator_name.clone(),
            creator_handle: request.creator_handle.clone(),
            creator_url: request.creator_url.clone(),
            import_source: Some(request.import_source),
            import_batch_id: Some(request.import_batch_id.clone()),
            original_modified_at,
            media: MediaSummary::Video {
                duration_ms: probe.duration_ms,
                preparation_state: VideoPreparationState::Pending,
                scrub_frame_count: 0,
            },
        };
        self.register_video_asset(
            &asset,
            &content_hash,
            &probe,
            request.classification_id.as_deref(),
        )?;

        pending.commit();
        Ok(IngestOutcome::Added { asset })
    }

    fn finish_exact_duplicate(
        &self,
        existing_asset_id: String,
        request: &IngestMediaRequest,
    ) -> Result<IngestOutcome, LibraryError> {
        let current_ids = self
            .get_asset_classifications(&existing_asset_id)?
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        let classification_changed = match request.classification_id.as_deref() {
            Some(requested_id) => current_ids.as_slice() != [requested_id],
            None => !current_ids.is_empty(),
        };
        if classification_changed {
            self.set_asset_classification(SetAssetClassification {
                asset_ids: vec![existing_asset_id.clone()],
                classification_id: request.classification_id.clone(),
            })?;
        }
        let metadata_changed = if request.replace_duplicate_metadata {
            self.connection()?.execute(
                "UPDATE assets
                 SET source_url = COALESCE(?2, source_url),
                     collected_at = COALESCE(?3, collected_at),
                     source_published_at = COALESCE(?4, source_published_at),
                     creator_name = COALESCE(?5, creator_name),
                     creator_handle = COALESCE(?6, creator_handle),
                     creator_url = COALESCE(?7, creator_url)
                 WHERE id = ?1
                   AND ((?2 IS NOT NULL AND source_url IS NOT ?2)
                     OR (?3 IS NOT NULL AND collected_at IS NOT ?3)
                     OR (?4 IS NOT NULL AND source_published_at IS NOT ?4)
                     OR (?5 IS NOT NULL AND creator_name IS NOT ?5)
                     OR (?6 IS NOT NULL AND creator_handle IS NOT ?6)
                     OR (?7 IS NOT NULL AND creator_url IS NOT ?7))",
                params![
                    existing_asset_id,
                    request.source_url.as_deref(),
                    request.collected_at.as_deref(),
                    request.source_published_at.as_deref(),
                    request.creator_name.as_deref(),
                    request.creator_handle.as_deref(),
                    request.creator_url.as_deref(),
                ],
            )? > 0
        } else {
            false
        };
        Ok(IngestOutcome::ExactDuplicate {
            existing_asset_id,
            classification_changed,
            metadata_changed,
        })
    }

    fn validate_classification(&self, classification_id: Option<&str>) -> Result<(), LibraryError> {
        let Some(classification_id) = classification_id else {
            return Ok(());
        };
        let connection = self.connection()?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM classification_entries WHERE id = ?1)",
            [classification_id],
            |row| row.get(0),
        )?;
        if exists {
            Ok(())
        } else {
            Err(LibraryError::ClassificationNotFound)
        }
    }

    fn find_asset_by_hash(&self, content_hash: &str) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id FROM assets WHERE content_hash = ?1",
                [content_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn register_asset(
        &self,
        asset: &AssetSummary,
        content_hash: &str,
        perceptual_hash: Option<ImageFingerprint>,
        format: ImageFormat,
        classification_id: Option<&str>,
        registration: &Registration,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let status = match registration {
            Registration::Normal => "normal",
            Registration::Review { .. } => "review",
        };
        transaction.execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, title, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, source_url,
                collected_at, favorite, status, perceptual_hash, perceptual_hash_quality,
                source_published_at,
                creator_name, creator_handle, creator_url, import_source, import_batch_id,
                original_modified_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
            )",
            params![
                asset.id,
                content_hash,
                media_kind(format),
                asset.title,
                asset.original_name,
                asset.relative_path,
                asset.thumbnail_relative_path,
                asset.byte_size as i64,
                asset.width as i64,
                asset.height as i64,
                asset.source_url.as_deref(),
                asset.collected_at,
                i64::from(asset.favorite),
                status,
                perceptual_hash.map(|fingerprint| fingerprint.to_stored_bytes().to_vec()),
                perceptual_hash.map(|fingerprint| fingerprint.quality),
                asset.source_published_at.as_deref(),
                asset.creator_name.as_deref(),
                asset.creator_handle.as_deref(),
                asset.creator_url.as_deref(),
                asset.import_source.map(ImportSource::as_str),
                asset.import_batch_id.as_deref(),
                asset.original_modified_at.as_deref(),
            ],
        )?;
        if let Some(classification_id) = classification_id {
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                params![asset.id, classification_id],
            )?;
        }
        if let Registration::Review {
            existing_asset_id,
            distance,
            review_id,
        } = registration
        {
            transaction.execute(
                "INSERT INTO similarity_reviews (
                    id, existing_asset_id, candidate_asset_id, distance,
                    fingerprint_kind, status, created_at
                 ) VALUES (?1, ?2, ?3, ?4, 'pdq-v1', 'open', ?5)",
                params![
                    review_id,
                    existing_asset_id,
                    asset.id,
                    distance,
                    asset.collected_at
                ],
            )?;
        }
        if matches!(registration, Registration::Normal) {
            enqueue_asset_upsert(&transaction, &asset.id, &asset.collected_at)?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn register_video_asset(
        &self,
        asset: &AssetSummary,
        content_hash: &str,
        probe: &VideoProbe,
        classification_id: Option<&str>,
    ) -> Result<(), LibraryError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO assets (
                id, content_hash, media_kind, title, original_name, relative_path,
                thumbnail_relative_path, byte_size, width, height, source_url,
                collected_at, favorite, status, perceptual_hash, source_published_at,
                creator_name, creator_handle, creator_url, import_source, import_batch_id,
                original_modified_at
            ) VALUES (
                ?1, ?2, 'video', ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11,
                'normal', NULL, ?12, ?13, ?14, ?15, ?16, ?17, ?18
            )",
            params![
                asset.id,
                content_hash,
                asset.title,
                asset.original_name,
                asset.relative_path,
                asset.byte_size as i64,
                asset.width as i64,
                asset.height as i64,
                asset.source_url.as_deref(),
                asset.collected_at,
                i64::from(asset.favorite),
                asset.source_published_at.as_deref(),
                asset.creator_name.as_deref(),
                asset.creator_handle.as_deref(),
                asset.creator_url.as_deref(),
                asset.import_source.map(ImportSource::as_str),
                asset.import_batch_id.as_deref(),
                asset.original_modified_at.as_deref(),
            ],
        )?;
        transaction.execute(
            "INSERT INTO video_assets (
                asset_id, duration_ms, container, video_codec, audio_codec, preparation_state
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
            params![
                asset.id,
                probe.duration_ms as i64,
                probe.container,
                probe.video_codec,
                probe.audio_codec.as_deref(),
            ],
        )?;
        if let Some(classification_id) = classification_id {
            transaction.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2)",
                params![asset.id, classification_id],
            )?;
        }
        enqueue_asset_upsert(&transaction, &asset.id, &asset.collected_at)?;
        transaction.commit()?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum IngestKind {
    Image,
    Video(&'static str),
}

fn ingest_kind(path: &Path) -> Result<IngestKind, LibraryError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "jpg" | "jpeg" | "jfif" | "png" | "gif" | "webp" => Ok(IngestKind::Image),
        "mp4" => Ok(IngestKind::Video("mp4")),
        "webm" => Ok(IngestKind::Video("webm")),
        "mov" => Ok(IngestKind::Video("mov")),
        "mkv" | "avi" | "m4v" | "wmv" | "flv" | "mpeg" | "mpg" => {
            Err(LibraryError::UnsupportedVideo)
        }
        _ => Err(LibraryError::UnsupportedImage),
    }
}

enum Registration {
    Normal,
    Review {
        existing_asset_id: String,
        distance: u32,
        review_id: String,
    },
}

fn copy_and_hash(
    source_path: &Path,
    staging_path: &Path,
    pending: &mut PendingFiles,
    maximum_bytes: Option<u64>,
) -> Result<(String, u64), LibraryError> {
    let mut source =
        File::open(source_path).map_err(|source| read_source_error(source_path, source))?;
    let mut staging = create_new_asset_file(staging_path)?;
    pending.track_staging(staging_path.to_path_buf(), &staging)?;
    let mut hasher = Sha256::new();
    let mut byte_size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|source| read_source_error(source_path, source))?;
        if read == 0 {
            break;
        }
        byte_size = byte_size
            .checked_add(read as u64)
            .ok_or(LibraryError::UnsupportedImage)?;
        if maximum_bytes.is_some_and(|maximum| byte_size > maximum) {
            return Err(LibraryError::UnsupportedImage);
        }
        staging
            .write_all(&buffer[..read])
            .map_err(|source| LibraryError::WriteAsset {
                path: staging_path.to_path_buf(),
                source,
            })?;
        hasher.update(&buffer[..read]);
    }
    staging.flush().map_err(|source| LibraryError::WriteAsset {
        path: staging_path.to_path_buf(),
        source,
    })?;

    let mut content_hash = String::with_capacity(64);
    for byte in hasher.finalize() {
        write!(&mut content_hash, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok((content_hash, byte_size))
}

fn inspect_image(staging: File) -> Result<(ImageFormat, u32, u32), LibraryError> {
    let reader = staging_image_reader(staging)?;
    let format = reader
        .format()
        .filter(|format| extension_for(*format).is_some())
        .ok_or(LibraryError::UnsupportedImage)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(LibraryError::UnsupportedImage)?;
    if pixels > MAX_IMAGE_PIXELS {
        return Err(LibraryError::UnsupportedImage);
    }
    Ok((format, width, height))
}

fn write_thumbnail(staging: File, mut thumbnail_file: File) -> Result<(), LibraryError> {
    let reader = staging_image_reader(staging)?;
    let image = reader
        .decode()
        .map_err(|_| LibraryError::UnsupportedImage)?;
    let encoded = encode_thumbnail_webp(&image)?;
    thumbnail_file
        .write_all(&encoded)
        .map_err(|_| LibraryError::UnsupportedImage)
}

fn encode_thumbnail_webp(image: &image::DynamicImage) -> Result<Vec<u8>, LibraryError> {
    let thumbnail = image.thumbnail(THUMBNAIL_BOUND, THUMBNAIL_BOUND).to_rgba8();
    let mut config = webp::WebPConfig::new().map_err(|_| LibraryError::UnsupportedImage)?;
    config.lossless = 0;
    config.quality = THUMBNAIL_WEBP_QUALITY;
    config.method = 1;
    config.alpha_compression = 1;
    config.alpha_filtering = 0;
    config.alpha_quality = 100;
    config.exact = 1;
    webp::Encoder::from_rgba(thumbnail.as_raw(), thumbnail.width(), thumbnail.height())
        .encode_advanced(&config)
        .map(|encoded| encoded.to_vec())
        .map_err(|_| LibraryError::UnsupportedImage)
}

fn staging_image_reader(mut staging: File) -> Result<ImageReader<BufReader<File>>, LibraryError> {
    staging
        .seek(SeekFrom::Start(0))
        .map_err(|_| LibraryError::UnsupportedImage)?;
    ImageReader::new(BufReader::new(staging))
        .with_guessed_format()
        .map_err(|_| LibraryError::UnsupportedImage)
}

fn create_parent_directory(path: &Path) -> Result<(), LibraryError> {
    let parent = path
        .parent()
        .expect("library asset paths have a parent directory");
    fs::create_dir_all(parent).map_err(|source| LibraryError::WriteAsset {
        path: parent.to_path_buf(),
        source,
    })
}

fn create_new_asset_file(path: &Path) -> Result<File, LibraryError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| LibraryError::WriteAsset {
            path: path.to_path_buf(),
            source,
        })
}

fn install_staged_asset(
    staging_path: &Path,
    asset_path: &Path,
    pending: &mut PendingFiles,
) -> Result<(), LibraryError> {
    let mut staging = pending.owned_file(staging_path)?;
    staging
        .seek(SeekFrom::Start(0))
        .map_err(|source| LibraryError::WriteAsset {
            path: staging_path.to_path_buf(),
            source,
        })?;
    let mut asset = create_new_asset_file(asset_path)?;
    pending.track_created(asset_path.to_path_buf(), &asset)?;
    io::copy(&mut staging, &mut asset).map_err(|source| LibraryError::WriteAsset {
        path: asset_path.to_path_buf(),
        source,
    })?;
    asset.flush().map_err(|source| LibraryError::WriteAsset {
        path: asset_path.to_path_buf(),
        source,
    })?;
    drop(asset);
    drop(staging);
    pending.remove_owned(staging_path)
}

fn extension_for(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Jpeg => Some("jpg"),
        ImageFormat::Png => Some("png"),
        ImageFormat::Gif => Some("gif"),
        ImageFormat::WebP => Some("webp"),
        _ => None,
    }
}

fn media_kind(format: ImageFormat) -> &'static str {
    if format == ImageFormat::Gif {
        "gif"
    } else {
        "image"
    }
}

fn original_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn read_source_error(path: &Path, source: io::Error) -> LibraryError {
    LibraryError::ReadSource {
        path: path.to_path_buf(),
        source,
    }
}

struct PendingFiles {
    files: Vec<PendingFile>,
    committed: bool,
}

impl PendingFiles {
    fn new() -> Self {
        Self {
            files: Vec::new(),
            committed: false,
        }
    }

    fn track_created(&mut self, path: PathBuf, file: &File) -> Result<(), LibraryError> {
        let identity =
            FileIdentity::from_file(file).map_err(|source| LibraryError::WriteAsset {
                path: path.clone(),
                source,
            })?;
        self.files.push(PendingFile {
            path,
            identity,
            file: None,
        });
        Ok(())
    }

    fn track_staging(&mut self, path: PathBuf, file: &File) -> Result<(), LibraryError> {
        let identity =
            FileIdentity::from_file(file).map_err(|source| LibraryError::WriteAsset {
                path: path.clone(),
                source,
            })?;
        let file = file
            .try_clone()
            .map_err(|source| LibraryError::WriteAsset {
                path: path.clone(),
                source,
            })?;
        self.files.push(PendingFile {
            path,
            identity,
            file: Some(file),
        });
        Ok(())
    }

    fn owned_file(&self, path: &Path) -> Result<File, LibraryError> {
        let pending_file = self
            .files
            .iter()
            .find(|pending_file| pending_file.path == path)
            .ok_or_else(|| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::NotFound, "owned pending file not found"),
            })?;
        pending_file
            .file
            .as_ref()
            .ok_or_else(|| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::NotFound, "owned pending file is closed"),
            })?
            .try_clone()
            .map_err(|source| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source,
            })
    }

    fn remove_owned(&mut self, path: &Path) -> Result<(), LibraryError> {
        let index = self
            .files
            .iter()
            .position(|pending_file| pending_file.path == path)
            .ok_or_else(|| LibraryError::WriteAsset {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::NotFound, "owned pending file not found"),
            })?;
        remove_pending_file(&mut self.files[index]).map_err(|source| LibraryError::WriteAsset {
            path: path.to_path_buf(),
            source,
        })?;
        self.files.remove(index);
        Ok(())
    }

    #[cfg(test)]
    fn track(&mut self, path: PathBuf) {
        let file = File::open(&path).unwrap();
        self.track_staging(path, &file).unwrap();
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PendingFiles {
    fn drop(&mut self) {
        if !self.committed {
            for pending_file in self.files.iter_mut().rev() {
                let _ = remove_pending_file(pending_file);
            }
        }
    }
}

struct PendingFile {
    path: PathBuf,
    identity: FileIdentity,
    file: Option<File>,
}

fn remove_pending_file(pending_file: &mut PendingFile) -> io::Result<()> {
    drop(pending_file.file.take());
    let Some(quarantine_path) = claim_path(&pending_file.path)? else {
        return Ok(());
    };
    if !pending_file.identity.matches_path(&quarantine_path) {
        restore_unverified_file(&quarantine_path, &pending_file.path)?;
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "pending path was replaced before cleanup",
        ));
    }
    // Lakomics ingests for this Library are serialized. This identity check is
    // defense in depth, not an atomic conditional unlink against external writers.
    fs::remove_file(quarantine_path)
}

fn claim_path(path: &Path) -> io::Result<Option<PathBuf>> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "pending path has no parent directory",
        )
    })?;
    let quarantine_path = parent.join(format!(".{}.cleanup", uuid::Uuid::new_v4()));
    match rename_no_replace(path, &quarantine_path) {
        Ok(()) => Ok(Some(quarantine_path)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(source),
    }
}

fn restore_unverified_file(quarantine_path: &Path, original_path: &Path) -> io::Result<()> {
    rename_no_replace(quarantine_path, original_path)
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(test)]
type StagingHook = Box<dyn FnOnce(&Path)>;

#[cfg(test)]
thread_local! {
    static STAGING_HOOK: std::cell::RefCell<Option<StagingHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_staging_hook(hook: impl FnOnce(&Path) + 'static) {
    STAGING_HOOK.with(|staging_hook| *staging_hook.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_staging_hook(path: &Path) {
    STAGING_HOOK.with(|staging_hook| {
        if let Some(hook) = staging_hook.borrow_mut().take() {
            hook(path);
        }
    });
}

#[cfg(not(test))]
fn run_staging_hook(_path: &Path) {}

#[cfg(test)]
type AfterDuplicateHook = std::sync::Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
static AFTER_DUPLICATE_HOOK: std::sync::Mutex<Option<(PathBuf, AfterDuplicateHook)>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
fn set_after_duplicate_hook(root: PathBuf, hook: impl Fn() + Send + Sync + 'static) {
    *AFTER_DUPLICATE_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((root, std::sync::Arc::new(hook)));
}

#[cfg(test)]
fn clear_after_duplicate_hook() {
    AFTER_DUPLICATE_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
}

#[cfg(test)]
fn run_after_duplicate_hook(root: &Path) {
    let hook = AFTER_DUPLICATE_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(hook_root, _)| hook_root == root)
        .map(|(_, hook)| std::sync::Arc::clone(hook));
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(not(test))]
fn run_after_duplicate_hook(_root: &Path) {}

#[cfg(test)]
type VideoProbeHook = Box<dyn Fn(&Path, &str) -> Result<VideoProbe, LibraryError>>;

#[cfg(test)]
thread_local! {
    static VIDEO_PROBE_HOOK: std::cell::RefCell<Option<VideoProbeHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_video_probe_hook(hook: impl Fn(&Path, &str) -> Result<VideoProbe, LibraryError> + 'static) {
    VIDEO_PROBE_HOOK.with(|video_probe_hook| {
        *video_probe_hook.borrow_mut() = Some(Box::new(hook));
    });
}

#[cfg(test)]
fn run_video_probe(path: &Path, extension: &str) -> Result<VideoProbe, LibraryError> {
    VIDEO_PROBE_HOOK.with(|video_probe_hook| {
        video_probe_hook.borrow().as_ref().map_or_else(
            || probe_video(path, extension),
            |hook| hook(path, extension),
        )
    })
}

#[cfg(not(test))]
fn run_video_probe(path: &Path, extension: &str) -> Result<VideoProbe, LibraryError> {
    probe_video(path, extension)
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume_serial_number: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
impl FileIdentity {
    fn from_file(file: &File) -> io::Result<Self> {
        let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        // SAFETY: the file handle is valid for this call, and the API initializes the buffer on success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetFileInformationByHandle reported success above.
        let information = unsafe { information.assume_init() };
        Ok(Self {
            volume_serial_number: information.dwVolumeSerialNumber,
            file_index_high: information.nFileIndexHigh,
            file_index_low: information.nFileIndexLow,
        })
    }

    fn matches_path(&self, path: &Path) -> bool {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {}
            _ => return false,
        }
        let file = match File::open(path) {
            Ok(file) => file,
            Err(_) => return false,
        };
        Self::from_file(&file).is_ok_and(|identity| identity == *self)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        time::Duration,
    };

    use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageBuffer, Rgb};
    use tempfile::TempDir;

    use super::{
        clear_after_duplicate_hook, copy_and_hash, encode_thumbnail_webp, install_staged_asset,
        set_after_duplicate_hook, set_staging_hook, set_video_probe_hook, LibraryError,
        PendingFiles, MAX_IMAGE_BYTES,
    };
    use crate::library::{
        models::{
            AssetClassificationPatch, AssetQuery, AssetSort, AssetSummary, ClassificationKind,
            CreateClassification, ImportSource, IngestMediaRequest, IngestOutcome, MediaSummary,
            VideoPreparationState,
        },
        video_media::VideoProbe,
        Library,
    };

    struct IngestionFixture {
        _temp: TempDir,
        library: Library,
        source: PathBuf,
    }

    struct SimilarityIngestionFixture {
        _temp: TempDir,
        library: Library,
        input: PathBuf,
        tag_id: String,
    }

    impl IngestionFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source.png");
            write_test_png(&source, [10, 20, 30]);
            let library = Library::open(temp.path().join("library")).unwrap();

            Self {
                _temp: temp,
                library,
                source,
            }
        }

        fn ingest(&self) -> IngestOutcome {
            self.library
                .ingest_media(IngestMediaRequest {
                    source_path: self.source.clone(),
                    classification_id: None,
                    source_url: None,
                    collected_at: None,
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::Direct,
                    import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                })
                .unwrap()
        }
    }

    impl SimilarityIngestionFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let input = temp.path().join("input");
            std::fs::create_dir(&input).unwrap();
            let library = Library::open(temp.path().join("library")).unwrap();
            let tag_id = library
                .create_classification(CreateClassification {
                    kind: ClassificationKind::Root,
                    name: "게임".into(),
                    parent_id: None,
                })
                .unwrap()
                .id;
            Self {
                _temp: temp,
                library,
                input,
                tag_id,
            }
        }

        fn write_png(&self, name: &str, image: &DynamicImage) -> PathBuf {
            let path = self.input.join(name);
            image
                .save_with_format(&path, image::ImageFormat::Png)
                .unwrap();
            path
        }

        fn write_jpeg(&self, name: &str, image: &DynamicImage, quality: u8) -> PathBuf {
            let path = self.input.join(name);
            JpegEncoder::new_with_quality(File::create(&path).unwrap(), quality)
                .encode_image(image)
                .unwrap();
            path
        }

        fn ingest(
            &self,
            path: &Path,
            classification_id: Option<String>,
            source_url: Option<String>,
        ) -> IngestOutcome {
            self.library
                .ingest_media(IngestMediaRequest {
                    source_path: path.to_path_buf(),
                    classification_id,
                    source_url,
                    collected_at: None,
                    replace_duplicate_metadata: false,
                    source_published_at: None,
                    creator_name: None,
                    creator_handle: None,
                    creator_url: None,
                    import_source: ImportSource::Direct,
                    import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                })
                .unwrap()
        }

        fn all_assets(&self) -> Vec<AssetSummary> {
            self.library
                .list_assets(AssetQuery {
                    classification_id: None,
                    album_id: None,
                    collection_id: None,
                    direct_only: false,
                    favorite_only: false,
                    unclassified_only: false,
                    sort: AssetSort::Newest,
                    random_pivot: None,
                    after: None,
                    limit: 100,
                    ..Default::default()
                })
                .unwrap()
                .items
        }

        fn review_candidate_id(&self) -> String {
            self.library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT candidate_asset_id FROM similarity_reviews WHERE status = 'open'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        }

        fn review_count(&self) -> i64 {
            self.library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM similarity_reviews", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
    }

    fn write_test_png(path: &Path, rgb: [u8; 3]) {
        let image = image::RgbImage::from_pixel(8, 6, image::Rgb(rgb));
        image
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    #[test]
    fn thumbnail_webp_is_bounded_and_decodable() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(1200, 800, |x, y| {
            Rgb([
                ((x + y) % 251) as u8,
                ((x * 3) % 253) as u8,
                ((y * 5) % 247) as u8,
            ])
        }));
        let encoded = encode_thumbnail_webp(&image).unwrap();
        let decoded =
            image::load_from_memory_with_format(&encoded, image::ImageFormat::WebP).unwrap();

        assert_eq!((decoded.width(), decoded.height()), (360, 240));
    }

    #[test]
    fn thumbnail_webp_preserves_alpha_channel() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(360, 240, |x, _| {
            let alpha = if x < 120 {
                0
            } else if x < 240 {
                128
            } else {
                255
            };
            image::Rgba([220, 80, 40, alpha])
        }));
        let encoded = encode_thumbnail_webp(&image).unwrap();
        let decoded = image::load_from_memory_with_format(&encoded, image::ImageFormat::WebP)
            .unwrap()
            .to_rgba8();

        assert_eq!(decoded.get_pixel(40, 120)[3], 0);
        assert_eq!(decoded.get_pixel(180, 120)[3], 128);
        assert_eq!(decoded.get_pixel(320, 120)[3], 255);
    }

    #[test]
    fn thumbnail_webp_is_materially_smaller_than_lossless_webp_for_detailed_art() {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(360, 360, |x, y| {
            let seed = x
                .wrapping_mul(1_664_525)
                .wrapping_add(y.wrapping_mul(1_013_904_223))
                .wrapping_add((x ^ y).wrapping_mul(2_654_435_761));
            Rgb([(seed >> 16) as u8, (seed >> 8) as u8, seed as u8])
        }));
        let lossy = encode_thumbnail_webp(&image).unwrap();
        let mut lossless = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut lossless, image::ImageFormat::WebP)
            .unwrap();
        let lossless = lossless.into_inner();

        assert!(
            lossy.len() * 5 < lossless.len() * 3,
            "lossy={} lossless={}",
            lossy.len(),
            lossless.len()
        );
    }

    fn stub_video_probe() {
        set_video_probe_hook(|_, extension| {
            Ok(VideoProbe {
                container: extension.to_owned(),
                video_codec: "vp9".into(),
                audio_codec: Some("opus".into()),
                duration_ms: 12_345,
                width: 1280,
                height: 720,
            })
        });
    }

    fn vertical_stripes(width: u32, height: u32) -> DynamicImage {
        scene_fixture(width, height, true)
    }

    fn horizontal_stripes(width: u32, height: u32) -> DynamicImage {
        scene_fixture(width, height, false)
    }

    fn scene_fixture(width: u32, height: u32, vertical: bool) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            let nx = x as f32 / width as f32;
            let ny = y as f32 / height as f32;
            let mut color = [
                (35.0 + nx * 90.0) as u8,
                (45.0 + ny * 100.0) as u8,
                (170.0 - nx * 55.0) as u8,
            ];
            let featured = if vertical {
                (0.18..0.43).contains(&nx) && (0.12..0.88).contains(&ny)
            } else {
                (0.12..0.88).contains(&nx) && (0.18..0.43).contains(&ny)
            };
            if featured {
                color = [235, 75, 35];
            }
            if (0.55..0.90).contains(&nx) && (0.08..0.20).contains(&ny) {
                color = [245, 205, 35];
            }
            if (nx - 0.72).powi(2) + (ny - 0.68).powi(2) < 0.085 {
                color = [25, 215, 135];
            }
            Rgb(color)
        }))
    }

    #[test]
    fn successful_asset_commit_creates_one_pending_cloud_upsert() {
        let fixture = IngestionFixture::new();
        let IngestOutcome::Added { asset } = fixture.ingest() else {
            panic!("expected added asset");
        };

        let count = || {
            fixture
                .library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM cloud_sync_queue
                     WHERE entity_type = 'asset' AND entity_id = ?1
                       AND operation = 'upsert' AND status = 'pending' AND revision = 1",
                    [&asset.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(count(), 1);

        assert!(matches!(
            fixture.ingest(),
            IngestOutcome::ExactDuplicate { .. }
        ));
        assert_eq!(count(), 1);
    }

    #[test]
    fn ingest_copies_the_image_and_keeps_the_user_source() {
        let fixture = IngestionFixture::new();

        let outcome = fixture.ingest();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert!(fixture.source.is_file());
        assert!(fixture.library.root().join(&asset.relative_path).is_file());
        assert!(fixture
            .library
            .root()
            .join(asset.thumbnail_relative_path.as_deref().unwrap())
            .is_file());
    }

    #[test]
    fn video_ingest_registers_original_and_pending_job_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.webm");
        std::fs::write(&source, b"valid-video-fixture").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let classification = library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "video".into(),
                parent_id: None,
            })
            .unwrap();
        stub_video_probe();

        let outcome = library
            .ingest_media(IngestMediaRequest {
                source_path: source.clone(),
                classification_id: Some(classification.id.clone()),
                source_url: Some("https://example.test/post".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();

        let IngestOutcome::Added { asset } = outcome else {
            panic!("video ingest must add an asset");
        };
        assert_eq!(
            asset.media,
            MediaSummary::Video {
                duration_ms: 12_345,
                preparation_state: VideoPreparationState::Pending,
                scrub_frame_count: 0,
            }
        );
        assert_eq!(asset.width, 1280);
        assert_eq!(asset.height, 720);
        assert!(source.is_file());
        assert!(library.root().join(&asset.relative_path).is_file());
        let mut expected_classification = classification;
        expected_classification.asset_count = 1;
        assert_eq!(
            library.get_asset_classifications(&asset.id).unwrap(),
            vec![expected_classification]
        );
        let pending_jobs: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM video_assets WHERE asset_id = ?1 AND preparation_state = 'pending'",
                [&asset.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_jobs, 1);
    }

    #[test]
    fn exact_duplicate_video_creates_no_second_asset_or_job() {
        let temp = tempfile::tempdir().unwrap();
        let first_source = temp.path().join("first.webm");
        let second_source = temp.path().join("second.webm");
        std::fs::write(&first_source, b"same-video-bytes").unwrap();
        std::fs::write(&second_source, b"same-video-bytes").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        stub_video_probe();
        let first = library
            .ingest_media(IngestMediaRequest {
                source_path: first_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = first else {
            panic!("first video ingest must add an asset");
        };

        let second = library
            .ingest_media(IngestMediaRequest {
                source_path: second_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();

        assert_eq!(
            second,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id,
                classification_changed: false,
                metadata_changed: false,
            }
        );
        let counts: (i64, i64) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM assets), (SELECT COUNT(*) FROM video_assets)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1));
    }

    #[test]
    fn video_ingest_never_creates_a_similarity_review() {
        let temp = tempfile::tempdir().unwrap();
        let first_source = temp.path().join("first.webm");
        let second_source = temp.path().join("second.webm");
        std::fs::write(&first_source, b"video-a").unwrap();
        std::fs::write(&second_source, b"video-b").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        stub_video_probe();

        for source_path in [first_source, second_source] {
            assert!(matches!(
                library
                    .ingest_media(IngestMediaRequest {
                        source_path,
                        classification_id: None,
                        source_url: None,
                        collected_at: None,
                        replace_duplicate_metadata: false,
                        source_published_at: None,
                        creator_name: None,
                        creator_handle: None,
                        creator_url: None,
                        import_source: ImportSource::Direct,
                        import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                    })
                    .unwrap(),
                IngestOutcome::Added { .. }
            ));
        }

        let review_count: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM similarity_reviews", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(review_count, 0);
    }

    #[test]
    fn unsupported_media_extension_leaves_no_managed_file_or_database_row() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.mkv");
        std::fs::write(&source, b"unsupported-video-fixture").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();

        let result = library.ingest_media(IngestMediaRequest {
            source_path: source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });

        assert!(matches!(result, Err(LibraryError::UnsupportedVideo)));
        assert!(source.is_file());
        assert!(library
            .root()
            .join("assets/.staging")
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
    }

    #[test]
    fn existing_image_ingest_and_similarity_behavior_is_unchanged() {
        let fixture = SimilarityIngestionFixture::new();
        let base = vertical_stripes(900, 600);
        let original = fixture.write_png("original.png", &base);
        let similar = fixture.write_jpeg(
            "similar.jpg",
            &base.resize_exact(450, 300, FilterType::Triangle),
            70,
        );

        assert!(matches!(
            fixture.ingest(&original, None, None),
            IngestOutcome::Added { .. }
        ));
        assert!(matches!(
            fixture.ingest(&similar, None, None),
            IngestOutcome::ReviewPending { .. }
        ));
        assert_eq!(fixture.review_count(), 1);
    }

    #[test]
    fn ingesting_the_same_bytes_twice_returns_the_existing_asset() {
        let fixture = IngestionFixture::new();
        let first = fixture.ingest();
        let second = fixture.ingest();

        let IngestOutcome::Added { asset } = first else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(
            second,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id,
                classification_changed: false,
                metadata_changed: false,
            },
        );
    }

    #[test]
    fn similar_image_becomes_review_pending_without_entering_normal_queries() {
        let fixture = SimilarityIngestionFixture::new();
        let base = vertical_stripes(900, 600);
        let existing_path = fixture.write_png("existing.png", &base);
        let existing = match fixture.ingest(&existing_path, None, None) {
            IngestOutcome::Added { asset } => asset,
            other => panic!("expected added asset, got {other:?}"),
        };
        let variant_path = fixture.write_jpeg(
            "variant.jpg",
            &base.resize_exact(450, 300, FilterType::Triangle),
            70,
        );

        let outcome = fixture.ingest(
            &variant_path,
            Some(fixture.tag_id.clone()),
            Some("https://example.com/new".into()),
        );

        let review_id = match outcome {
            IngestOutcome::ReviewPending { review_id } => review_id,
            other => panic!("expected review pending, got {other:?}"),
        };
        assert_eq!(
            fixture
                .all_assets()
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec![existing.id]
        );
        let candidate_id = fixture.review_candidate_id();
        let connection = fixture.library.connection().unwrap();
        let stored: (String, String, Option<String>, i64) = connection
            .query_row(
                "SELECT reviews.id, assets.status, assets.source_url,
                        length(assets.perceptual_hash)
                 FROM similarity_reviews AS reviews
                 JOIN assets ON assets.id = reviews.candidate_asset_id
                 WHERE reviews.id = ?1",
                [&review_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let queued_candidate_count = connection
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_queue WHERE entity_id = ?1",
                [&candidate_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            stored,
            (
                review_id,
                "review".into(),
                Some("https://example.com/new".into()),
                64
            )
        );
        assert_eq!(
            fixture
                .library
                .get_asset_classifications(&candidate_id)
                .unwrap()[0]
                .id,
            fixture.tag_id
        );
        assert_eq!(queued_candidate_count, 0);
        assert!(existing_path.is_file());
        assert!(variant_path.is_file());
    }

    #[test]
    fn exact_duplicate_wins_before_similarity_and_does_not_create_review() {
        let fixture = SimilarityIngestionFixture::new();
        let path = fixture.write_png("same.png", &vertical_stripes(900, 600));
        let existing = match fixture.ingest(&path, None, None) {
            IngestOutcome::Added { asset } => asset,
            other => panic!("expected added asset, got {other:?}"),
        };

        let outcome = fixture.ingest(&path, None, None);

        assert_eq!(
            outcome,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: existing.id,
                classification_changed: false,
                metadata_changed: false,
            }
        );
        assert_eq!(fixture.review_count(), 0);
    }

    #[test]
    fn unrelated_image_is_added_normally() {
        let fixture = SimilarityIngestionFixture::new();
        let vertical = fixture.write_png("vertical.png", &vertical_stripes(900, 600));
        let horizontal = fixture.write_png("horizontal.png", &horizontal_stripes(900, 600));
        assert!(matches!(
            fixture.ingest(&vertical, None, None),
            IngestOutcome::Added { .. }
        ));

        let outcome = fixture.ingest(&horizontal, None, None);

        assert!(matches!(outcome, IngestOutcome::Added { .. }));
        assert_eq!(fixture.all_assets().len(), 2);
        assert_eq!(fixture.review_count(), 0);
    }

    #[test]
    fn exact_duplicate_moves_the_existing_asset_to_the_requested_folder() {
        let fixture = IngestionFixture::new();
        let original_classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "original".into(),
                parent_id: None,
            })
            .unwrap();
        let duplicate_classification = fixture
            .library
            .create_classification(CreateClassification {
                kind: ClassificationKind::Root,
                name: "duplicate".into(),
                parent_id: None,
            })
            .unwrap();
        let IngestOutcome::Added { asset } = fixture.ingest() else {
            panic!("first ingest must add an asset");
        };
        fixture
            .library
            .patch_asset_classifications(AssetClassificationPatch {
                asset_ids: vec![asset.id.clone()],
                add_classification_ids: vec![original_classification.id.clone()],
                remove_classification_ids: vec![],
            })
            .unwrap();
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET title = 'keep me', favorite = 1 WHERE id = ?1",
                [&asset.id],
            )
            .unwrap();

        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: Some(duplicate_classification.id.clone()),
                source_url: Some("https://example.test/duplicate".into()),
                collected_at: Some("2026-08-13T13:44:55+09:00".into()),
                replace_duplicate_metadata: true,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();

        assert_eq!(
            outcome,
            IngestOutcome::ExactDuplicate {
                existing_asset_id: asset.id.clone(),
                classification_changed: true,
                metadata_changed: true,
            },
        );
        let mut expected_classification = duplicate_classification;
        expected_classification.asset_count = 1;
        assert_eq!(
            fixture
                .library
                .get_asset_classifications(&asset.id)
                .unwrap(),
            vec![expected_classification],
        );
        assert_eq!(
            fixture
                .library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let stored: (Option<String>, String, i64, Option<String>) = fixture
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT source_url, collected_at, favorite, title FROM assets WHERE id = ?1",
                [&asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                Some("https://example.test/duplicate".into()),
                "2026-08-13T04:44:55.000Z".into(),
                1,
                Some("keep me".into()),
            )
        );
    }

    #[test]
    fn added_asset_normalizes_requested_collection_time_and_rejects_invalid_time() {
        let fixture = IngestionFixture::new();
        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: None,
                collected_at: Some("2026-08-13T13:44:55+09:00".into()),
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(asset.collected_at, "2026-08-13T04:44:55.000Z");

        let invalid = fixture.library.ingest_media(IngestMediaRequest {
            source_path: fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: Some("yesterday".into()),
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });
        assert!(matches!(invalid, Err(LibraryError::InvalidCollectedAt)));
    }

    #[test]
    fn jfif_ingestion_keeps_the_original_name_and_stores_jpeg_bytes_as_jpg() {
        let fixture = SimilarityIngestionFixture::new();
        let image = DynamicImage::new_rgb8(4, 4);
        let source = fixture.write_jpeg("portrait.jfif", &image, 90);

        let IngestOutcome::Added { asset } = fixture.ingest(&source, None, None) else {
            panic!("first JFIF ingest must add an asset");
        };

        assert_eq!(asset.original_name, "portrait.jfif");
        assert!(asset.relative_path.ends_with(".jpg"));
    }

    #[test]
    fn ingestion_records_source_metadata_and_preserves_first_provenance_on_duplicates() {
        let fixture = IngestionFixture::new();
        let first_batch = "31d1f90c-214b-41e2-9d84-f9d964bb5bc3";
        let outcome = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/example/status/1".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: Some("2026-08-01T10:20:30Z".into()),
                creator_name: Some("Example Artist".into()),
                creator_handle: Some("example".into()),
                creator_url: Some("https://x.com/example".into()),
                import_source: ImportSource::Direct,
                import_batch_id: first_batch.into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = outcome else {
            panic!("first ingest must add an asset");
        };
        assert_eq!(asset.import_source, Some(ImportSource::Direct));
        assert_eq!(asset.import_batch_id.as_deref(), Some(first_batch));
        assert!(asset.original_modified_at.is_some());
        let original_modified_at = asset.original_modified_at.clone();

        let duplicate = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/changed/status/2".into()),
                collected_at: None,
                replace_duplicate_metadata: true,
                source_published_at: Some("2026-08-02T10:20:30Z".into()),
                creator_name: Some("Changed Artist".into()),
                creator_handle: Some("changed".into()),
                creator_url: Some("https://x.com/changed".into()),
                import_source: ImportSource::MetadataImport,
                import_batch_id: "fe6dbf94-f018-45c8-814b-79d1962ed377".into(),
            })
            .unwrap();
        assert!(matches!(
            duplicate,
            IngestOutcome::ExactDuplicate {
                metadata_changed: true,
                ..
            }
        ));
        let stored = fixture.library.get_asset(&asset.id).unwrap();
        assert_eq!(stored.creator_name.as_deref(), Some("Changed Artist"));
        assert_eq!(stored.import_source, Some(ImportSource::Direct));
        assert_eq!(stored.import_batch_id.as_deref(), Some(first_batch));
        assert_eq!(stored.original_modified_at, original_modified_at);
    }

    #[test]
    fn ingestion_rejects_invalid_batch_ids_and_omits_extension_file_times() {
        let invalid_fixture = IngestionFixture::new();
        let invalid = invalid_fixture.library.ingest_media(IngestMediaRequest {
            source_path: invalid_fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "not-a-uuid".into(),
        });
        assert!(matches!(invalid, Err(LibraryError::InvalidImportBatchId)));

        let invalid_url = invalid_fixture.library.ingest_media(IngestMediaRequest {
            source_path: invalid_fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: Some("javascript:alert(1)".into()),
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000005".into(),
        });
        assert!(matches!(invalid_url, Err(LibraryError::InvalidCreatorUrl)));

        let invalid_time = invalid_fixture.library.ingest_media(IngestMediaRequest {
            source_path: invalid_fixture.source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: Some("not-a-time".into()),
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000005".into(),
        });
        assert!(matches!(
            invalid_time,
            Err(LibraryError::InvalidSourcePublishedAt)
        ));

        let extension_fixture = IngestionFixture::new();
        let outcome = extension_fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: extension_fixture.source.clone(),
                classification_id: None,
                source_url: Some("https://x.com/example/status/1".into()),
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: Some("example".into()),
                creator_url: Some("https://x.com/example".into()),
                import_source: ImportSource::BrowserExtension,
                import_batch_id: "1be16707-c772-46c7-85b5-ae9be71211a4".into(),
            })
            .unwrap();
        let IngestOutcome::Added { asset } = outcome else {
            panic!("extension ingest must add an asset");
        };
        assert_eq!(asset.original_modified_at, None);
    }

    #[test]
    fn failed_ingest_keeps_source_and_does_not_leave_a_registered_file() {
        let fixture = IngestionFixture::new();

        let result = fixture.library.ingest_media(IngestMediaRequest {
            source_path: fixture.source.clone(),
            classification_id: Some("missing-classification".into()),
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });

        assert!(result.is_err());
        assert!(fixture.source.is_file());
    }

    #[test]
    fn unsupported_image_removes_the_staged_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("not-an-image.bin");
        std::fs::write(&source, b"not an image").unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();

        let result = library.ingest_media(IngestMediaRequest {
            source_path: source.clone(),
            classification_id: None,
            source_url: None,
            collected_at: None,
            replace_duplicate_metadata: false,
            source_published_at: None,
            creator_name: None,
            creator_handle: None,
            creator_url: None,
            import_source: ImportSource::Direct,
            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
        });

        assert!(result.is_err());
        assert!(source.is_file());
        assert!(library
            .root()
            .join("assets/.staging")
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
    }

    #[test]
    fn content_hash_is_lowercase_sha256() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.bin");
        let staging = temp.path().join("staging.part");
        std::fs::write(&source, b"hash me").unwrap();
        let mut pending = PendingFiles::new();

        let (content_hash, _) = copy_and_hash(&source, &staging, &mut pending, None).unwrap();

        assert_eq!(content_hash.len(), 64);
        assert!(content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn existing_staging_file_is_never_truncated_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.bin");
        let staging = temp.path().join("foreign.part");
        std::fs::write(&source, b"new source bytes").unwrap();
        std::fs::write(&staging, b"foreign staging bytes").unwrap();

        let mut pending = PendingFiles::new();
        let result = copy_and_hash(&source, &staging, &mut pending, Some(MAX_IMAGE_BYTES));

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign staging bytes");
    }

    #[test]
    fn existing_asset_destination_is_never_overwritten_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("owned.part");
        let asset = temp.path().join("foreign.png");
        std::fs::write(&staging, b"owned staging bytes").unwrap();
        std::fs::write(&asset, b"foreign asset bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(staging.clone());

        let result = install_staged_asset(&staging, &asset, &mut pending);

        assert!(matches!(result, Err(LibraryError::WriteAsset { .. })));
        assert_eq!(std::fs::read(&asset).unwrap(), b"foreign asset bytes");
        assert_eq!(std::fs::read(&staging).unwrap(), b"owned staging bytes");
    }

    #[test]
    fn cleanup_keeps_a_file_replaced_after_it_was_tracked() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owned.part");
        std::fs::write(&path, b"owned bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(path.clone());

        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"foreign replacement").unwrap();
        drop(pending);

        assert_eq!(std::fs::read(&path).unwrap(), b"foreign replacement");
    }

    #[test]
    fn staging_replacement_before_install_is_never_copied_or_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("owned.part");
        let asset = temp.path().join("asset.png");
        std::fs::write(&staging, b"owned staging bytes").unwrap();
        let mut pending = PendingFiles::new();
        pending.track(staging.clone());

        std::fs::remove_file(&staging).unwrap();
        std::fs::write(&staging, b"foreign replacement").unwrap();
        let result = install_staged_asset(&staging, &asset, &mut pending);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign replacement");
        drop(pending);
        assert_eq!(std::fs::read(&staging).unwrap(), b"foreign replacement");
        assert!(!asset.exists());
    }

    #[test]
    fn staging_replacement_is_never_inspected_or_thumbnail_copied() {
        let fixture = IngestionFixture::new();
        let replacement = b"foreign invalid image".to_vec();
        let replaced_path = Arc::new(Mutex::new(None));
        let replaced_path_for_hook = Arc::clone(&replaced_path);
        set_staging_hook(move |staging_path| {
            std::fs::remove_file(staging_path).unwrap();
            std::fs::write(staging_path, &replacement).unwrap();
            *replaced_path_for_hook.lock().unwrap() = Some(staging_path.to_path_buf());
        });

        let error = fixture
            .library
            .ingest_media(IngestMediaRequest {
                source_path: fixture.source.clone(),
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap_err();

        assert!(
            matches!(error, LibraryError::WriteAsset { .. }),
            "the retained valid image should reach identity-bound cleanup: {error:?}"
        );
        let replaced_path = replaced_path.lock().unwrap().take().unwrap();
        assert_eq!(
            std::fs::read(replaced_path).unwrap(),
            b"foreign invalid image"
        );
    }

    #[test]
    fn library_clones_serialize_ingests_for_one_open_library() {
        let fixture = IngestionFixture::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_hook = Arc::clone(&calls);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let release_rx_for_hook = Arc::clone(&release_rx);
        set_after_duplicate_hook(fixture.library.root().to_path_buf(), move || {
            let call = calls_for_hook.fetch_add(1, Ordering::SeqCst);
            entered_tx.send(call).unwrap();
            if call == 0 {
                release_rx_for_hook.lock().unwrap().recv().unwrap();
            }
        });

        let first_library = fixture.library.clone();
        let first_source = fixture.source.clone();
        let first = std::thread::spawn(move || {
            first_library.ingest_media(IngestMediaRequest {
                source_path: first_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
        });
        let second_library = fixture.library.clone();
        let second_source = fixture.source.clone();
        let second = std::thread::spawn(move || {
            second_library.ingest_media(IngestMediaRequest {
                source_path: second_source,
                classification_id: None,
                source_url: None,
                collected_at: None,
                replace_duplicate_metadata: false,
                source_published_at: None,
                creator_name: None,
                creator_handle: None,
                creator_url: None,
                import_source: ImportSource::Direct,
                import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
            })
        });

        let first_entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let overlapped = entered_rx.recv_timeout(Duration::from_millis(250)).is_ok();
        release_tx.send(()).unwrap();
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        clear_after_duplicate_hook();

        assert!(
            first_entered,
            "neither ingest reached the duplicate boundary"
        );
        assert!(
            !overlapped,
            "two Library clones entered one library ingest concurrently"
        );
        let mut added = 0;
        let mut duplicate = 0;
        for outcome in [first.unwrap(), second.unwrap()] {
            match outcome {
                IngestOutcome::Added { .. } => added += 1,
                IngestOutcome::ExactDuplicate { .. } => duplicate += 1,
                IngestOutcome::ReviewPending { .. } => {
                    panic!("identical concurrent ingests cannot create a similarity review")
                }
            }
        }
        assert_eq!((added, duplicate), (1, 1));
    }
}
