pub(crate) mod aladin;
mod aladin_flow;
mod album;
mod asset_metadata;
mod backup;
pub mod book_migration;
pub(crate) mod catalog_checkpoint;
pub(crate) mod catalog_update;
mod classification;
mod collection;
mod collection_source;
mod collection_volume;
pub(crate) mod catalog_provider;
mod catalog_query;
mod catalog_visibility;
pub(crate) mod credential;
pub mod cloud_preflight;
mod db;
mod drag_out;
pub mod error;
mod external_binding;
mod favorite;
mod folder_appearance;
mod image_fingerprint;
pub(crate) mod igdb;
mod igdb_flow;
pub(crate) mod ingestion;
pub mod legacy_migration;
pub mod legacy_package_migration;
mod lock;
mod manga;
pub(crate) mod mangadex;
mod mangadex_flow;
pub mod metadata_import;
pub mod models;
mod online_catalog;
mod query;
mod release_watch;
pub(crate) mod remote_gallery;
pub(crate) mod remote_media;
pub(crate) mod remote_progress;
mod revisit;
mod similarity;
mod source_group;
mod tmdb_flow;
pub mod thumbnail_maintenance;
pub(crate) mod tmdb;
mod trash;
mod video_media;
mod work_artwork;

use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File},
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use error::LibraryError;
pub(crate) use ingestion::MAX_IMAGE_BYTES;
use lock::LibraryLease;
use models::{
    LibrarySummary, MangaCatalogRecoveryApplyResult, MangaCatalogRecoveryPreview,
    MangaCatalogRecoverySelection, MangaSeries, TrashPolicy,
};
use rusqlite::{Connection, OptionalExtension};
pub(crate) use work_artwork::MAX_WORK_ARTWORK_BYTES;
pub(crate) use video_media::VideoProbe;

#[derive(Debug, Clone, Copy)]
pub enum MediaVariant {
    Asset,
    Thumbnail,
    Playback,
    ScrubFrame(u32),
    MangaCover,
    MangaPage(u32),
    CollectionCover,
    CollectionCoverThumbnail,
    CollectionSourcePreview,
    CollectionSourceThumbnail,
    WorkArtwork,
    WorkArtworkThumbnail,
    MangaDexCoverPreview,
    IgdbImagePreviewCover,
    IgdbImagePreviewHero,
    TmdbImagePreviewPoster,
    TmdbImagePreviewBackdrop,
}

#[derive(Debug)]
pub struct MediaResponse {
    pub file: File,
    pub length: u64,
    pub mime: &'static str,
}

/// The library interface does not expose its SQLite connection.
///
/// ```compile_fail
/// fn direct_database_access(library: &app_lib::library::Library) {
///     let _ = library.connection();
/// }
/// ```
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
    #[allow(dead_code)] // Keeps the operating-system lease alive for all Library clones.
    lease: Arc<LibraryLease>,
    // ponytail: one lock per open Library; split by content hash only if ingest throughput demands it.
    ingestion_lock: Arc<Mutex<()>>,
    // ponytail: one lock per open Library; split by asset only if trash throughput demands it.
    trash_lock: Arc<Mutex<()>>,
    // ponytail: one video preparation at a time; add a bounded worker pool only if profiling needs it.
    video_lock: Arc<Mutex<()>>,
    // ponytail: one lock per open Library; split only if backup operations become a bottleneck.
    backup_lock: Arc<Mutex<()>>,
    // ponytail: one startup Release Watch run per Library; split only if provider latency demands it.
    release_watch_lock: Arc<Mutex<()>>,
    // ponytail: one manga scan per Library; concurrent scans only duplicate disk and image work.
    manga_scan_lock: Arc<Mutex<()>>,
    // ponytail: one volume import per Library; concurrent runs race on the same volume slots
    // (뷰어를 연속으로 열면 같은 컬렉션의 import가 겹쳐 UNIQUE 제약 위반이 난다).
    volume_import_lock: Arc<Mutex<()>>,
    // ponytail: one database handle at a time; use a read/write lock if reads become a bottleneck.
    database_lock: Arc<Mutex<()>>,
    catalog_lookup_cache: Arc<Mutex<Option<online_catalog::CatalogLookupCache>>>,
    collection_artwork_scan_cache: Arc<Mutex<HashMap<String, u128>>>,
    igdb_token_cache: igdb::IgdbTokenCache,
    igdb_request_limiter: igdb::IgdbRequestLimiter,
}

pub(crate) struct LockedConnection<'a> {
    connection: Connection,
    _guard: MutexGuard<'a, ()>,
}

impl Deref for LockedConnection<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl DerefMut for LockedConnection<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.connection
    }
}

impl Library {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, LibraryError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(|source| LibraryError::CreateDirectory {
            path: root.clone(),
            source,
        })?;
        let lease = Arc::new(LibraryLease::acquire(&root)?);
        for name in [
            "assets",
            "thumbnails",
            "backups",
            "video-media",
            "work-artwork",
        ] {
            let path = root.join(name);
            fs::create_dir_all(&path)
                .map_err(|source| LibraryError::CreateDirectory { path, source })?;
        }
        db::initialize_database(&root.join("library.sqlite"))?;
        let library = Self {
            root,
            lease,
            ingestion_lock: Arc::new(Mutex::new(())),
            trash_lock: Arc::new(Mutex::new(())),
            video_lock: Arc::new(Mutex::new(())),
            backup_lock: Arc::new(Mutex::new(())),
            release_watch_lock: Arc::new(Mutex::new(())),
            manga_scan_lock: Arc::new(Mutex::new(())),
            volume_import_lock: Arc::new(Mutex::new(())),
            database_lock: Arc::new(Mutex::new(())),
            catalog_lookup_cache: Arc::new(Mutex::new(None)),
            collection_artwork_scan_cache: Arc::new(Mutex::new(HashMap::new())),
            igdb_token_cache: igdb::IgdbTokenCache::default(),
            igdb_request_limiter: igdb::IgdbRequestLimiter::default(),
        };
        library.backfill_legacy_collection_kinds()?;
        library.normalize_showcase_orders()?;
        library.cleanup_stale_asset_drags()?;
        library.cleanup_resolving_similarity_reviews()?;
        library.requeue_interrupted_video_preparation()?;
        library.requeue_interrupted_cloud_sync()?;
        library.suspend_running_cloud_backfill_on_open()?;
        library.cleanup_unreferenced_work_artwork()?;
        library.start_work_artwork_thumbnail_backfill();
        Ok(library)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn igdb_client(&self) -> igdb::IgdbClient {
        igdb::IgdbClient::with_cache_and_limiter(
            self.igdb_token_cache.clone(),
            self.igdb_request_limiter.clone(),
        )
    }

    pub(crate) fn connection(&self) -> Result<LockedConnection<'_>, LibraryError> {
        let guard = self
            .database_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(LockedConnection {
            connection: self.unlocked_connection()?,
            _guard: guard,
        })
    }

    fn unlocked_connection(&self) -> Result<Connection, LibraryError> {
        db::open_database(&self.root.join("library.sqlite"))
    }

    pub fn summary(&self) -> Result<LibrarySummary, LibraryError> {
        Ok(LibrarySummary {
            root: self.root.to_string_lossy().into_owned(),
        })
    }

    pub fn trash_policy(&self) -> Result<TrashPolicy, LibraryError> {
        let retention_days = self.connection()?.query_row(
            "SELECT trash_retention_days FROM library_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(TrashPolicy { retention_days })
    }

    pub fn set_trash_policy(&self, policy: TrashPolicy) -> Result<(), LibraryError> {
        if policy
            .retention_days
            .is_some_and(|days| !(1..=3650).contains(&days))
        {
            return Err(LibraryError::InvalidTrashRetention);
        }
        self.connection()?.execute(
            "UPDATE library_settings SET trash_retention_days = ?1 WHERE singleton = 1",
            [policy.retention_days],
        )?;
        Ok(())
    }

    pub fn manga_root(&self) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        manga::manga_root(&connection)
    }

    pub fn set_manga_root(&self, path: Option<&str>) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        manga::set_manga_root(&connection, path)
    }

    pub fn scan_manga(&self) -> Result<u64, LibraryError> {
        manga::scan(self)
    }

    pub fn list_manga_series(&self) -> Result<Vec<MangaSeries>, LibraryError> {
        manga::repair_legacy_recovery_source_paths(self)?;
        let connection = self.connection()?;
        manga::list_series(&connection)
    }

    pub fn preview_manga_catalog_recovery(
        &self,
    ) -> Result<MangaCatalogRecoveryPreview, LibraryError> {
        manga::preview_catalog_recovery(self)
    }

    pub fn apply_manga_catalog_recovery(
        &self,
    ) -> Result<MangaCatalogRecoveryApplyResult, LibraryError> {
        manga::apply_exact_catalog_recovery(self)
    }

    pub fn missing_manga_catalog_recovery_gallery_ids(&self) -> Result<Vec<u64>, LibraryError> {
        manga::missing_catalog_recovery_gallery_ids(self)
    }

    pub fn apply_manga_catalog_recovery_selection(
        &self,
        selections: &[MangaCatalogRecoverySelection],
    ) -> Result<MangaCatalogRecoveryApplyResult, LibraryError> {
        manga::apply_selected_catalog_recovery(self, selections)
    }

    pub fn manga_cover(&self, series_id: &str) -> Result<MediaResponse, LibraryError> {
        let connection = self.connection()?;
        let root = manga::manga_root(&connection)?.ok_or(LibraryError::MangaRootNotSet)?;
        let thumb_relative: Option<String> = connection
            .query_row(
                "SELECT thumbnail_relative_path FROM manga_series WHERE id = ?1",
                [series_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let thumb_relative = thumb_relative.ok_or(LibraryError::MangaSeriesNotFound)?;
        let manga_root = Path::new(&root);
        self.open_manga_media(
            manga_root,
            manga_root.join(".lakomics-thumbs").join(thumb_relative),
        )
    }

    pub fn manga_page(
        &self,
        series_id: &str,
        page_index: u32,
    ) -> Result<MediaResponse, LibraryError> {
        let connection = self.connection()?;
        let root = manga::manga_root(&connection)?.ok_or(LibraryError::MangaRootNotSet)?;
        let (relative_path, page_count): (String, i64) = connection
            .query_row(
                "SELECT relative_path, page_count FROM manga_series WHERE id = ?1",
                [series_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::MangaSeriesNotFound)?;
        if page_index == 0 || page_index as i64 > page_count {
            return Err(LibraryError::MangaSeriesNotFound);
        }
        let manga_root = Path::new(&root);
        let folder = manga_root.join(relative_path);
        let pages = manga::list_page_files(&folder)?;
        let file_name = pages
            .get(page_index as usize - 1)
            .ok_or(LibraryError::MangaSeriesNotFound)?;
        self.open_manga_media(manga_root, folder.join(file_name))
    }

    pub(crate) fn open_manga_media(
        &self,
        manga_root: &Path,
        absolute_path: PathBuf,
    ) -> Result<MediaResponse, LibraryError> {
        let canonical_root =
            fs::canonicalize(manga_root).map_err(|source| LibraryError::ReadMedia {
                path: manga_root.to_path_buf(),
                source,
            })?;
        let requested = absolute_path;
        let canonical = fs::canonicalize(&requested).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                LibraryError::MediaNotFound
            } else {
                LibraryError::ReadMedia {
                    path: requested.clone(),
                    source,
                }
            }
        })?;
        if !canonical.starts_with(&canonical_root) {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let mime = mime_for_path(&canonical);
        let file = fs::File::open(&canonical).map_err(|source| LibraryError::ReadMedia {
            path: canonical.clone(),
            source,
        })?;
        let length = file
            .metadata()
            .map_err(|source| LibraryError::ReadMedia {
                path: canonical.clone(),
                source,
            })?
            .len();
        Ok(MediaResponse { file, length, mime })
    }

    pub fn resolve_media(
        &self,
        asset_id: &str,
        variant: MediaVariant,
    ) -> Result<MediaResponse, LibraryError> {
        match variant {
            MediaVariant::MangaCover => return self.manga_cover(asset_id),
            MediaVariant::MangaPage(page_index) => return self.manga_page(asset_id, page_index),
            MediaVariant::WorkArtwork => return self.resolve_work_artwork(asset_id),
            MediaVariant::WorkArtworkThumbnail => {
                return self.resolve_work_artwork_thumbnail(asset_id)
            }
            _ => {}
        }
        let relative_path = match variant {
            MediaVariant::Asset => self
                .connection()?
                .query_row(
                    "SELECT CASE WHEN media_kind != 'video' THEN relative_path END
                     FROM assets WHERE id = ?1 AND status IN ('normal', 'review')",
                    [asset_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten(),
            MediaVariant::Thumbnail => self
                .connection()?
                .query_row(
                    "SELECT thumbnail_relative_path FROM assets
                     WHERE id = ?1 AND status IN ('normal', 'review')",
                    [asset_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten(),
            MediaVariant::Playback => self
                .connection()?
                .query_row(
                    "SELECT CASE video.playback_kind
                        WHEN 'original' THEN asset.relative_path
                        WHEN 'proxy' THEN video.proxy_relative_path
                     END
                     FROM assets AS asset
                     JOIN video_assets AS video ON video.asset_id = asset.id
                     WHERE asset.id = ?1 AND asset.status = 'normal'
                       AND video.preparation_state = 'ready'",
                    [asset_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten(),
            MediaVariant::ScrubFrame(frame_index) => self
                .connection()?
                .query_row(
                    "SELECT video.scrub_relative_dir, video.scrub_frame_count
                     FROM assets AS asset
                     JOIN video_assets AS video ON video.asset_id = asset.id
                     WHERE asset.id = ?1 AND asset.status = 'normal'
                       AND video.preparation_state = 'ready'",
                    [asset_id],
                    |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?
                .and_then(|(directory, count)| {
                    let count = u32::try_from(count).ok()?;
                    (frame_index < count)
                        .then(|| directory.map(|path| format!("{path}/{frame_index:03}.webp")))
                        .flatten()
                }),
            MediaVariant::MangaCover
            | MediaVariant::MangaPage(_)
            | MediaVariant::CollectionCover
            | MediaVariant::CollectionCoverThumbnail
            | MediaVariant::CollectionSourcePreview
            | MediaVariant::CollectionSourceThumbnail
            | MediaVariant::WorkArtwork
            | MediaVariant::WorkArtworkThumbnail
            | MediaVariant::MangaDexCoverPreview
            | MediaVariant::IgdbImagePreviewCover
            | MediaVariant::IgdbImagePreviewHero
            | MediaVariant::TmdbImagePreviewPoster
            | MediaVariant::TmdbImagePreviewBackdrop => {
                unreachable!()
            }
        };
        let relative_path = relative_path.ok_or(LibraryError::AssetNotFound)?;
        self.open_library_media(&relative_path)
    }

    pub(crate) fn open_library_media(
        &self,
        relative_path: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let canonical_root =
            fs::canonicalize(&self.root).map_err(|source| LibraryError::ReadMedia {
                path: self.root.clone(),
                source,
            })?;
        let requested_path = canonical_root.join(relative_path);
        let canonical_path = fs::canonicalize(&requested_path).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                LibraryError::MediaNotFound
            } else {
                LibraryError::ReadMedia {
                    path: requested_path.clone(),
                    source,
                }
            }
        })?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(LibraryError::UnsafeMediaPath);
        }
        let mime = mime_for_path(&canonical_path);
        let file = File::open(&canonical_path).map_err(|source| LibraryError::ReadMedia {
            path: canonical_path.clone(),
            source,
        })?;
        let metadata = file.metadata().map_err(|source| LibraryError::ReadMedia {
            path: canonical_path,
            source,
        })?;
        if !metadata.is_file() {
            return Err(LibraryError::MediaNotFound);
        }
        Ok(MediaResponse {
            file,
            length: metadata.len(),
            mime,
        })
    }
}

pub(crate) fn validated_asset_ids<'a>(
    connection: &Connection,
    asset_ids: &'a [String],
) -> Result<BTreeSet<&'a str>, LibraryError> {
    let ids: BTreeSet<_> = asset_ids.iter().map(String::as_str).collect();
    if ids.is_empty() {
        return Err(LibraryError::EmptyAssetSelection);
    }
    for id in &ids {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(LibraryError::AssetNotFound);
        }
    }
    Ok(ids)
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::Connection;

    use super::{error::LibraryError, Library};

    #[test]
    fn second_library_open_is_rejected_until_the_first_is_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let first = Library::open(temp.path()).unwrap();
        let removed_directory = temp.path().join("assets");
        fs::remove_dir(&removed_directory).unwrap();

        let error = Library::open(temp.path()).unwrap_err();
        assert!(matches!(error, LibraryError::LibraryInUse));
        assert!(
            !removed_directory.exists(),
            "a rejected opener recreated a layout directory"
        );

        drop(first);
        Library::open(temp.path()).unwrap();
    }

    #[test]
    fn open_creates_the_self_contained_library_layout_without_a_trash_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Lakomics Library");

        let library = Library::open(&root).unwrap();

        assert_eq!(library.root(), root.as_path());
        assert!(root.join("library.sqlite").is_file());
        for directory in ["assets", "thumbnails", "backups"] {
            assert!(root.join(directory).is_dir(), "{directory} was not created");
        }
        assert!(!root.join("trash").exists());
        let version: i64 = Connection::open(root.join("library.sqlite"))
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, super::db::SCHEMA_VERSION);
    }
}
