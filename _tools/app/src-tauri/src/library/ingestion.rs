#[cfg(target_os = "linux")]
use super::linux_fs::{FileIdentity, rename_no_replace};
use std::{
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use chrono::{DateTime, SecondsFormat, Utc};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
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
    similarity::{decode_image_for_fingerprint, perceptual_hash_from_image},
    video_media::{probe_video, VideoProbe},
    Library,
};

pub(crate) const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 200_000_000;
const THUMBNAIL_BOUND: u32 = 360;
const THUMBNAIL_WEBP_QUALITY: f32 = 85.0;

mod thumbnail_decode;

#[cfg(test)]
mod concurrency_tests;
#[cfg(test)]
pub(super) mod performance;
#[cfg(test)]
mod shared_decode_tests;

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
        request: IngestMediaRequest,
    ) -> Result<IngestOutcome, LibraryError> {
        let mut activity = crate::activities::Job::start(format!("ingest:{}", uuid::Uuid::new_v4()), "ingestion", "파일 가져오기", None);
        let result = self.ingest_media_with_identity(request, None);
        activity.complete(&result);
        result
    }

    pub(crate) fn ingest_media_with_identity(
        &self, mut request: IngestMediaRequest,
        identity: Option<&super::asset_authority::MaterializationIdentity>,
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
        // Direct drops can prepare private staging files independently. Cloud
        // materialization and the other import paths retain their original gate.
        let _ingestion_guard =
            (identity.is_some() || request.import_source != ImportSource::Direct).then(|| {
                self.ingestion_lock
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
            });
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
        #[cfg(test)]
        let phase = performance::Phase::start("copy_hash");
        let (content_hash, byte_size) = copy_and_hash(
            &request.source_path,
            &staging_path,
            &mut pending,
            maximum_bytes,
        )?;
        #[cfg(test)]
        drop(phase);
        if let Some(identity) = identity {
            if identity.sha256 != content_hash || identity.size_bytes != byte_size {
                // Bytes differ from the replica's identity: an integrity mismatch, retried
                // a bounded number of times by the materialization pass.
                return Err(LibraryError::DuplicateOriginalCorrupt);
            }
        }
        if identity.is_none() && request.import_source == ImportSource::BrowserExtension {
            // A legacy inbox replay is not a new user save. Deleted server-owned
            // content can only return through a newer normal authority projection.
            let deleted: bool = self.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM asset_authority_state WHERE sha256=? AND lifecycle<>'normal')",
                [&content_hash],
                |row| row.get(0),
            )?;
            if deleted {
                return Err(LibraryError::AssetAuthorityRejected {
                    status: 409,
                    code: "captureRequiresExplicitSave".into(),
                });
            }
        }
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
                identity,
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
                identity,
            ),
        }
    }

    fn ingest_image(
        &self,
        request: IngestMediaRequest,
        staging_path: PathBuf,
        content_hash: String,
        byte_size: u64,
        pending: PendingFiles,
        original_modified_at: Option<String>,
        collected_at: String,
        identity: Option<&super::asset_authority::MaterializationIdentity>,
    ) -> Result<IngestOutcome, LibraryError> {
        #[cfg(test)]
        let phase = performance::Phase::start("inspect");
        let (format, _, _) = inspect_image(pending.owned_file(&staging_path)?)?;
        #[cfg(test)]
        drop(phase);
        let parallel_preparation =
            identity.is_none() && request.import_source == ImportSource::Direct;
        let ingestion_guard = parallel_preparation.then(|| {
            self.ingestion_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        });
        // Pending files must roll back before releasing the publication gate.
        let pending = pending;
        #[cfg(test)]
        let phase = performance::Phase::start("exact_lookup");
        let existing_asset_id = self.find_asset_by_hash(&content_hash)?;
        #[cfg(test)]
        drop(phase);
        if let Some(existing_asset_id) = existing_asset_id {
            if let Some(identity) = identity {
                if existing_asset_id != identity.asset_id { return Err(LibraryError::InvalidCloudResponse); }
                let path:String=self.connection()?.query_row("SELECT relative_path FROM assets WHERE id=?",[&existing_asset_id],|r|r.get(0))?;
                let mut original=self.open_library_media(&path)?.file;
                let mut hasher=Sha256::new();let mut buffer=[0u8;64*1024];
                loop {let size=original.read(&mut buffer).map_err(|source|read_source_error(&self.root().join(&path),source))?;if size==0{break;}hasher.update(&buffer[..size]);}
                if hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>()!=identity.sha256 {return Err(LibraryError::DuplicateOriginalCorrupt);}
                let mut db=self.connection()?;let tx=db.transaction()?;
                super::asset_authority::mark_materialized(&tx, &existing_asset_id)?;tx.commit()?;
                return Ok(IngestOutcome::ExactDuplicate {existing_asset_id,classification_changed:false,metadata_changed:false});
            }
            return self.finish_exact_duplicate(existing_asset_id, &request);
        }
        run_after_duplicate_hook(self.root());
        drop(ingestion_guard);
        let skip_similarity =
            identity.is_some() || request.import_source == ImportSource::LegacyLakomics;
        let (image, perceptual_hash) = if skip_similarity {
            (
                decode_staging_image(staging_image_reader(pending.owned_file(&staging_path)?)?)?,
                None,
            )
        } else {
            decode_and_fingerprint(pending.owned_file(&staging_path)?)?
        };
        let (width, height) = (image.width(), image.height());

        #[cfg(test)]
        let phase = performance::Phase::start("thumbnail_prepare");
        let encoded = encode_thumbnail_webp(&image)?;
        drop(image);
        #[cfg(test)]
        drop(phase);

        let _ingestion_guard = parallel_preparation.then(|| {
            self.ingestion_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        });
        let mut pending = pending;
        // Another prepared file may have committed while decoding. Keep this
        // decision, similarity lookup and publication in the same critical section
        // so identical bytes cannot publish twice and batch neighbours see each other.
        if parallel_preparation {
            #[cfg(test)]
            let phase = performance::Phase::start("exact_lookup");
            let existing_asset_id = self.find_asset_by_hash(&content_hash)?;
            #[cfg(test)]
            drop(phase);
            if let Some(existing_asset_id) = existing_asset_id {
                return self.finish_exact_duplicate(existing_asset_id, &request);
            }
        }
        #[cfg(test)]
        let phase = performance::Phase::start("similarity_lookup");
        let similar = perceptual_hash
            .as_ref()
            .map(|fingerprint| self.find_similar_asset(fingerprint, (width, height)))
            .transpose()?
            .flatten();
        #[cfg(test)]
        drop(phase);

        let prefix = &content_hash[..2];
        let thumbnail_relative_path = format!("thumbnails/{prefix}/{content_hash}.webp");
        let thumbnail_path = self.root().join(&thumbnail_relative_path);
        create_parent_directory(&thumbnail_path)?;
        #[cfg(test)]
        let phase = performance::Phase::start("thumbnail_install");
        self.install_thumbnail(
            &encoded,
            &thumbnail_path,
            &thumbnail_relative_path,
            &mut pending,
        )?;
        #[cfg(test)]
        drop(phase);

        let relative_path = format!(
            "assets/{prefix}/{content_hash}.{}",
            extension_for(format).expect("inspect_image only returns supported formats")
        );
        let asset_path = self.root().join(&relative_path);
        create_parent_directory(&asset_path)?;
        #[cfg(test)]
        let phase = performance::Phase::start("install");
        install_staged_asset(&staging_path, &asset_path, &mut pending)?;
        #[cfg(test)]
        drop(phase);

        let asset = AssetSummary {
            content_rating: None,
            id: identity.map(|value| value.asset_id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
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
        #[cfg(test)]
        let phase = performance::Phase::start("register");
        let auto_kept = self.register_asset(
            &asset,
            &content_hash,
            perceptual_hash,
            format,
            request.classification_id.as_deref(),
            &registration,
            identity.is_some(),
        )?;
        #[cfg(test)]
        drop(phase);

        pending.commit();
        if let Some(kept) = auto_kept {
            return Ok(IngestOutcome::Added {
                asset: self.get_asset(&kept)?,
            });
        }
        Ok(match registration {
            Registration::Normal => IngestOutcome::Added { asset },
            Registration::Review { review_id, .. } => IngestOutcome::ReviewPending { review_id },
        })
    }

    fn install_thumbnail(
        &self,
        encoded: &[u8],
        path: &Path,
        relative: &str,
        pending: &mut PendingFiles,
    ) -> Result<(), LibraryError> {
        // Never expose the final name before decoding/encoding and disk writes finish.
        let error = |source| LibraryError::WriteAsset {
            path: path.to_path_buf(),
            source,
        };
        let mut temporary =
            tempfile::NamedTempFile::new_in(path.parent().expect("thumbnail parent"))
                .map_err(error)?;
        temporary.write_all(encoded).map_err(error)?;
        temporary.as_file().sync_all().map_err(error)?;

        if let Ok(metadata) = fs::symlink_metadata(path) {
            // A crash after publication but before DB commit can leave a complete
            // thumbnail. Reuse only an exact match; never overwrite foreign bytes.
            if metadata.file_type().is_file() && metadata.len() == encoded.len() as u64
                && fs::read(path).map_err(error)? == encoded {
                return Ok(());
            }
            if metadata.file_type().is_file() && metadata.len() == 0 {
                // Recover only an unregistered, empty artifact from an interrupted old
                // writer. Preserve the artifact and verify its identity after claiming it.
                let referenced: bool = self.connection()?.query_row(
                    "SELECT EXISTS(SELECT 1 FROM assets WHERE thumbnail_relative_path = ?1)",
                    [relative], |row| row.get(0),
                )?;
                if !referenced {
                    let file = File::open(path).map_err(error)?;
                    let identity = FileIdentity::from_file(&file).map_err(error)?;
                    drop(file);
                    let quarantine = path.with_file_name(format!(".{}.orphan", uuid::Uuid::new_v4()));
                    rename_no_replace(path, &quarantine).map_err(error)?;
                    if !identity.matches_path(&quarantine) || fs::metadata(&quarantine).map_err(error)?.len() != 0 {
                        restore_unverified_file(&quarantine, path).map_err(error)?;
                        return Err(error(io::Error::new(io::ErrorKind::AlreadyExists, "thumbnail changed during recovery")));
                    }
                }
            }
        }
        let file = temporary.persist_noclobber(path).map_err(|failure| error(failure.error))?;
        pending.track_created(path.to_path_buf(), &file)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // Mirrors the image path; a context type would only move these one-shot values.
    fn ingest_video(
        &self,
        request: IngestMediaRequest,
        staging_path: PathBuf,
        content_hash: String,
        byte_size: u64,
        pending: PendingFiles,
        extension: &'static str,
        original_modified_at: Option<String>,
        collected_at: String,
        identity: Option<&super::asset_authority::MaterializationIdentity>,
    ) -> Result<IngestOutcome, LibraryError> {
        let _ingestion_guard =
            (identity.is_none() && request.import_source == ImportSource::Direct).then(|| {
                self.ingestion_lock
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
            });
        let mut pending = pending;
        if let Some(existing_asset_id) = self.find_asset_by_hash(&content_hash)? {
            if let Some(identity) = identity {
                if existing_asset_id != identity.asset_id { return Err(LibraryError::InvalidCloudResponse); }
                let path:String=self.connection()?.query_row("SELECT relative_path FROM assets WHERE id=?",[&existing_asset_id],|r|r.get(0))?;
                let mut original=self.open_library_media(&path)?.file;
                let mut hasher=Sha256::new();let mut buffer=[0u8;64*1024];
                loop {let size=original.read(&mut buffer).map_err(|source|read_source_error(&self.root().join(&path),source))?;if size==0{break;}hasher.update(&buffer[..size]);}
                if hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>()!=identity.sha256 {return Err(LibraryError::DuplicateOriginalCorrupt);}
                let mut db=self.connection()?;let tx=db.transaction()?;
                super::asset_authority::mark_materialized(&tx, &existing_asset_id)?;tx.commit()?;
                return Ok(IngestOutcome::ExactDuplicate {existing_asset_id,classification_changed:false,metadata_changed:false});
            }
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
            content_rating: None,
            id: identity.map(|value| value.asset_id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
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
            identity.is_some(),
        )?;

        pending.commit();
        Ok(IngestOutcome::Added { asset })
    }

    fn finish_exact_duplicate(
        &self,
        existing_asset_id: String,
        request: &IngestMediaRequest,
    ) -> Result<IngestOutcome, LibraryError> {
        let (status, path) = self.connection()?.query_row(
            "SELECT status,relative_path FROM assets WHERE id=?1", [&existing_asset_id],
            |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?)))?;
        if status == "review" {
            let review_id = self.connection()?.query_row(
                "SELECT id FROM similarity_reviews WHERE candidate_asset_id=?1 AND status='open'",
                [&existing_asset_id], |row| row.get(0)).optional()?;
            return review_id.map(|review_id| IngestOutcome::ReviewPending { review_id })
                .ok_or(LibraryError::InvalidAssetSelection);
        }
        if status == "trash" { return Err(LibraryError::DuplicateInTrash); }
        if status != "normal" { return Err(LibraryError::InvalidAssetSelection); }
        // A DB hash does not prove a usable managed original. Missing/corrupt media
        // must be recovered explicitly before acknowledging an incoming capture.
        let mut original = self.open_library_media(&path)?.file;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = original.read(&mut buffer)
                .map_err(|source| read_source_error(&self.root.join(&path), source))?;
            if count == 0 { break; }
            hasher.update(&buffer[..count]);
        }
        let mut actual = String::with_capacity(64);
        for byte in hasher.finalize() {
            write!(&mut actual, "{byte:02x}").expect("writing to a String cannot fail");
        }
        let expected: String = self.connection()?.query_row("SELECT content_hash FROM assets WHERE id=?1", [&existing_asset_id], |r| r.get(0))?;
        if actual != expected { return Err(LibraryError::DuplicateOriginalCorrupt); }
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
        materialized: bool,
    ) -> Result<Option<String>, LibraryError> {
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
            super::character_autotag::enqueue(&transaction,&asset.id,super::character_autotag::Cause::Ingestion)?;
            // Same rule as the video path: a locally-created Asset's assignment intent
            // travels in the ingest transaction, and a materialized (server-created) Asset
            // instead applies server-owned state through `mark_materialized` below.
            if !materialized {
                Library::enqueue_classification_assignment_intent(
                    &transaction, &asset.id, classification_id)?;
            }
            if !materialized { enqueue_asset_upsert(&transaction, &asset.id, &asset.collected_at)?; }
        }
        if materialized { super::asset_authority::mark_materialized(&transaction, &asset.id)?; }
        if matches!(registration, Registration::Normal) {
            super::artists::fill_ingested_artist(&transaction, &asset.id, &asset.collected_at)?;
        }
        let auto_kept = if let Registration::Review {
            existing_asset_id,
            review_id,
            distance,
        } = registration
        {
            super::similarity::auto_resolve_repost(
                &transaction,
                review_id,
                existing_asset_id,
                &asset.id,
                *distance,
            )?
        } else {
            None
        };
        transaction.commit()?;
        self.publication_inputs.signal(&[10, 11]);
        drop(connection);
        if !materialized {
            self.remember_new_ingest(auto_kept.as_deref().unwrap_or(&asset.id), true);
        }
        Ok(auto_kept)
    }

    fn register_video_asset(
        &self,
        asset: &AssetSummary,
        content_hash: &str,
        probe: &VideoProbe,
        classification_id: Option<&str>,
        materialized: bool,
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
        // Same rule as the image path: a locally-created Asset's assignment intent travels
        // in the ingest transaction. Materialization instead applies server-owned state via
        // `mark_materialized`, so it must not manufacture a local command.
        if !materialized {
            Library::enqueue_classification_assignment_intent(
                &transaction, &asset.id, classification_id)?;
        }
        if !materialized { enqueue_asset_upsert(&transaction, &asset.id, &asset.collected_at)?; }
        if materialized { super::asset_authority::mark_materialized(&transaction, &asset.id)?; }
        super::artists::fill_ingested_artist(&transaction, &asset.id, &asset.collected_at)?;
        transaction.commit()?;
        self.publication_inputs.signal(&[10, 11]);
        drop(connection);
        if !materialized { self.remember_new_ingest(&asset.id, true); }
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
    let format = reader.format().filter(|format| extension_for(*format).is_some()).ok_or(LibraryError::UnsupportedImage)?;
    let mut decoder = reader.into_decoder().map_err(|_| LibraryError::UnsupportedImage)?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let (raw_width, raw_height) = decoder.dimensions();
    let pixels = u64::from(raw_width).checked_mul(u64::from(raw_height)).ok_or(LibraryError::UnsupportedImage)?;
    if pixels > MAX_IMAGE_PIXELS { return Err(LibraryError::UnsupportedImage); }
    let (width, height) = match orientation {
        image::metadata::Orientation::Rotate90 | image::metadata::Orientation::Rotate270
        | image::metadata::Orientation::Rotate90FlipH | image::metadata::Orientation::Rotate270FlipH => (raw_height, raw_width),
        _ => (raw_width, raw_height),
    };
    Ok((format, width, height))
}

pub(super) fn encode_thumbnail_webp(image: &image::DynamicImage) -> Result<Vec<u8>, LibraryError> {
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

fn decode_and_fingerprint(
    file: File,
) -> Result<(DynamicImage, Option<ImageFingerprint>), LibraryError> {
    // Use the fingerprint decoder's pixels, not a different WebP decoder's approximation:
    // existing assets must keep exactly the same stored bits. A rejected decode can still
    // succeed through the thumbnail-only WebP path, without gaining a fingerprint.
    let image = match decode_image_for_fingerprint(
        file.try_clone()
            .map_err(|_| LibraryError::UnsupportedImage)?,
    ) {
        Ok(image) => image,
        Err(LibraryError::UnsupportedImage) => {
            return decode_staging_image(staging_image_reader(file)?).map(|image| (image, None));
        }
        Err(error) => return Err(error),
    };
    let fingerprint = match perceptual_hash_from_image(&image) {
        Ok(result) => Some(result.fingerprint),
        Err(LibraryError::UnsupportedImage) => None,
        Err(error) => return Err(error),
    };
    Ok((image, fingerprint))
}

/// An image file of the library decoded with its EXIF orientation applied, within the same
/// pixel bound ingestion enforces. For model inputs (the Claude judgment encodes from it).
pub(super) fn decode_oriented_image(file: File) -> Result<DynamicImage, LibraryError> {
    inspect_image(file.try_clone().map_err(|_| LibraryError::UnsupportedImage)?)?;
    decode_staging_image(staging_image_reader(file)?)
}

fn decode_staging_image(reader: ImageReader<BufReader<File>>) -> Result<DynamicImage, LibraryError> {
    #[cfg(test)]
    let _decode_phase = performance::Phase::start("thumbnail_decode");
    if reader.format() == Some(ImageFormat::WebP) {
        return thumbnail_decode::decode_webp(reader.into_inner());
    }
    let mut decoder = reader.into_decoder().map_err(|_| LibraryError::UnsupportedImage)?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| LibraryError::UnsupportedImage)?;
    image.apply_orientation(orientation);
    Ok(image)
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
    let mut asset = tempfile::NamedTempFile::new_in(asset_path.parent().expect("asset parent"))
        .map_err(|source| LibraryError::WriteAsset { path: asset_path.to_path_buf(), source })?;
    io::copy(&mut staging, &mut asset).map_err(|source| LibraryError::WriteAsset {
        path: asset_path.to_path_buf(),
        source,
    })?;
    asset.as_file().sync_all().map_err(|source| LibraryError::WriteAsset {
        path: asset_path.to_path_buf(),
        source,
    })?;
    // A complete unregistered original from an interrupted DB commit is safe to
    // reuse only if every byte matches the owned staged input.
    let identical = fs::symlink_metadata(asset_path).ok().filter(|metadata| metadata.file_type().is_file())
        .is_some_and(|metadata| metadata.len() == asset.as_file().metadata().map(|m| m.len()).unwrap_or(u64::MAX))
        && same_file_contents(asset.as_file(), asset_path)?;
    if !identical {
        let asset = asset.persist_noclobber(asset_path).map_err(|error| LibraryError::WriteAsset {
            path: asset_path.to_path_buf(), source: error.error,
        })?;
        pending.track_created(asset_path.to_path_buf(), &asset)?;
    }
    drop(staging);
    pending.remove_owned(staging_path)
}

fn same_file_contents(expected: &File, path: &Path) -> Result<bool, LibraryError> {
    let compare = || -> io::Result<bool> {
        let mut expected = expected.try_clone()?;
        expected.seek(SeekFrom::Start(0))?;
        let mut actual = File::open(path)?;
        let mut left = [0u8; 65536];
        let mut right = [0u8; 65536];
        loop {
            let count = expected.read(&mut left)?;
            if count == 0 { return Ok(actual.read(&mut right)? == 0); }
            match actual.read_exact(&mut right[..count]) {
                Ok(()) if left[..count] == right[..count] => {},
                Ok(()) => return Ok(false),
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(false),
                Err(error) => return Err(error),
            }
        }
    };
    compare().map_err(|source| LibraryError::WriteAsset { path: path.to_path_buf(), source })
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
#[path = "ingestion_tests.rs"]
mod tests;
