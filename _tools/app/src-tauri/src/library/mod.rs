pub(crate) mod aladin;
mod aladin_flow;
mod album;
pub(crate) mod album_authority;
#[cfg(test)]
#[path = "album_authority_tests.rs"]
mod album_authority_tests;
pub(crate) mod album_reconciliation;
#[cfg(test)]
#[path = "album_reconciliation_tests.rs"]
mod album_reconciliation_tests;
pub(crate) mod asset_authority;
mod asset_metadata;
pub(crate) mod authority_pass;
pub(crate) mod av_artwork;
pub(crate) mod av_collection;
pub(crate) mod av_models;
mod backup;
pub mod book_migration;
pub(crate) mod bookmark_outbox;
#[cfg(test)]
#[path = "bookmark_outbox_tests.rs"]
mod bookmark_outbox_tests;
pub(crate) mod bookmark_reconciliation;
#[cfg(test)]
#[path = "bookmark_reconciliation_tests.rs"]
mod bookmark_reconciliation_tests;
pub(crate) mod catalog_checkpoint;
#[cfg(test)]
mod catalog_count_fixture_tests;
#[cfg(test)]
mod catalog_count_gate_tests;
mod catalog_counts;
mod catalog_group_api;
mod catalog_group_identity;
mod catalog_group_query;
mod catalog_groups;
mod catalog_lineage;
mod catalog_preparation;
pub(crate) mod catalog_provider;
mod catalog_query;
pub(crate) mod catalog_review;
pub(crate) mod catalog_duplicate_sync;
mod catalog_revision;
pub(crate) mod catalog_update;
mod catalog_visibility;
mod character_augmentation;
pub mod character_autotag;
pub mod character_conversion;
pub(crate) mod character_exclusions;
#[cfg(test)]
#[path = "character_exclusions_tests.rs"]
mod character_exclusions_tests;
pub mod character_folders;
pub mod character_groups;
pub mod character_hub;
pub mod character_incremental;
pub mod character_reference_candidates;
mod character_reference_curation;
pub mod character_reference_refresh;
#[cfg(test)]
mod character_reference_refresh_bench;
pub mod character_reference_regions;
pub(crate) mod character_review_feed;
pub(crate) mod character_review_sync;
pub mod character_scan;
mod character_scope;
pub mod character_series_move;
mod character_shadow;
pub mod character_shadow_backfill;
pub mod character_shadow_review;
mod character_sources;
mod character_training;
pub(crate) mod character_worker;
pub mod character_workflow;
pub mod characters;
mod classification;
pub(crate) use classification::list_classifications_in;
pub(crate) mod classification_authority;
#[cfg(test)]
#[path = "classification_authority_tests.rs"]
mod classification_authority_tests;
pub(crate) mod classification_reconciliation;
#[cfg(test)]
#[path = "classification_reconciliation_tests.rs"]
mod classification_reconciliation_tests;
pub mod cloud_preflight;
pub(crate) mod collection;
pub(crate) mod collection_personal_edits;
pub(crate) mod collection_binding_sync;
pub(crate) mod collection_release_sync;
pub(crate) mod collection_source;
mod collection_volume;
pub(crate) mod credential;
pub(crate) mod credential_broker;
mod db;
pub(crate) mod dev_guard;
pub(crate) use db::is_valid_library_id;
mod drag_out;
pub(crate) mod kakao_books;
#[cfg(target_os = "linux")]
mod linux_fs;
pub(crate) mod notes;
#[cfg(target_os = "linux")]
pub(crate) use drag_out::PreparedAssetDrag;
pub mod collection_tracking;
pub(crate) mod collection_updates;
pub mod error;
mod external_binding;
pub(crate) mod external_vault;
mod favorite;
mod folder_appearance;
pub(crate) mod igdb;
mod igdb_flow;
mod image_fingerprint;
pub(crate) mod ingestion;
pub mod legacy_migration;
pub mod legacy_package_migration;
mod lock;
pub(crate) mod machine_settings;
mod manga;
pub(crate) mod mangadex;
mod mangadex_flow;
pub mod metadata_import;
pub(crate) mod mobile_catalog;
#[cfg(test)]
mod mobile_catalog_tests;
pub mod models;
mod online_catalog;
mod provider_requests;
mod query;
mod release_watch;
pub(crate) mod release_calendar;
pub(crate) mod artists;
#[cfg(test)]
mod artists_tests;
pub(crate) mod release_wishlist;
pub(crate) use release_watch::release_status_at;
pub(crate) mod remote_gallery;
pub(crate) mod remote_media;
pub(crate) mod remote_progress;
pub(crate) mod restore_guard;
mod revisit;
mod revisit_color;
mod similarity;
pub(crate) mod similarity_review_sync;
mod similarity_scan;
mod source_group;
pub mod statistics;
pub mod thumbnail_maintenance;
pub(crate) mod tmdb;
mod tmdb_flow;
mod trash;
mod video_media;
pub(crate) mod video_similarity;
mod work_artwork;

use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File},
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, RwLock},
};

use error::LibraryError;
pub(crate) use ingestion::MAX_IMAGE_BYTES;
use lock::LibraryLease;
use models::{
    LibrarySummary, MangaCatalogRecoveryApplyResult, MangaCatalogRecoveryPreview,
    MangaCatalogRecoverySelection, MangaSeries, TrashPolicy,
};
use rusqlite::{Connection, OptionalExtension};
pub(crate) use video_media::VideoProbe;
pub(crate) use work_artwork::MAX_WORK_ARTWORK_BYTES;

#[derive(Debug, Clone, Copy)]
pub enum MediaVariant {
    TrashThumbnail,
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
    canonical_root: PathBuf,
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
    // One outbox delivery pass per authority domain at a time.
    //
    // Single-flight belongs *here* rather than in any one caller. Several independent callers
    // deliver the same domain — a mutation-triggered kick, the periodic React sync hook, and a
    // focus or online event — and coalescing only the mutation-triggered ones still let a kick
    // overlap a running background pass. Two overlapping passes read the same queue and would
    // both send the same row; the server's operation-id receipt makes that idempotent, but it is
    // wasted network work and it races on retiring the row.
    //
    // One lock per domain, deliberately not one shared lock: Album and Classification are
    // independent authorities, and serializing them against each other would couple two
    // unrelated sync lanes for no safety benefit. The gate is held across its own pass — that
    // is the point, since the overlap being excluded is two concurrent passes — but the pass
    // acquires and releases database connections *inside* it, and no caller holds the database
    // lock while entering a flush, so the two locks are never taken in both orders.
    // See [`Library::flush_outbox_single_flight`].
    asset_sync_lock: Arc<Mutex<()>>,
    album_flush_lock: Arc<Mutex<()>>,
    classification_flush_lock: Arc<Mutex<()>>,
    // Long catalog reads share this lock; only file replacement is exclusive.
    catalog_file_lock: Arc<RwLock<()>>,
    catalog_preparation: Arc<Mutex<catalog_preparation::PreparationState>>,
    catalog_lookup_cache: Arc<Mutex<Option<online_catalog::CatalogLookupCache>>>,
    collection_artwork_scan_cache: Arc<Mutex<HashMap<String, u128>>>,
    revisit_color_cache: Arc<Mutex<revisit_color::ColorCache>>,
    revisit_color_lock: Arc<Mutex<()>>,
    character_scan: Arc<Mutex<character_scan::ScanState>>,
    character_incremental: Arc<Mutex<character_incremental::Engine>>,
    character_wake: Arc<character_incremental::Wake>,
    character_worker_pool: Arc<character_worker::Pool>,
    character_shadow_backfill: Arc<Mutex<character_shadow_backfill::State>>,
    video_similarity_scan: Arc<Mutex<video_similarity::ScanState>>,
    igdb_token_cache: igdb::IgdbTokenCache,
    igdb_request_limiter: igdb::IgdbRequestLimiter,
    // Machine-local settings file (app config dir) for per-computer values such as
    // the manga root. None keeps the legacy shared-database behaviour (tests, tools).
    machine_settings_path: Arc<RwLock<Option<PathBuf>>>,
    pub(crate) new_ingests: Arc<Mutex<std::collections::BTreeSet<String>>>,
    pub(crate) replication_lock: Arc<Mutex<()>>,
    pub(crate) collection_publication_defer: Arc<Mutex<crate::cloud::auto_publication::Deferral>>,
    // Encrypted Private Vault (ADR-0039): lock state, decrypted index and write serialization.
    encrypted_vault: Arc<external_vault::EncryptedVaultRuntime>,
}

/// The durable library identity read through a connection the caller already holds.
pub(crate) fn library_id_on(connection: &Connection) -> Result<String, LibraryError> {
    let value: Option<String> = connection.query_row(
        "SELECT library_id FROM library_settings WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    match value {
        Some(value) if db::is_valid_library_id(&value) => Ok(value),
        _ => Err(LibraryError::Database(rusqlite::Error::InvalidQuery)),
    }
}

pub(crate) struct LockedConnection<'a> {
    connection: Connection,
    /// Set by the connection's update hook when a character queue row changed.
    character_queue_changed: Arc<std::sync::atomic::AtomicBool>,
    character_wake: &'a character_incremental::Wake,
    _guard: MutexGuard<'a, ()>,
}

impl Drop for LockedConnection<'_> {
    fn drop(&mut self) {
        // Any transaction has ended (it borrows the connection), and the database lock is
        // still held, so the woken owner reads the committed rows.
        if self
            .character_queue_changed
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            self.character_wake.queue_changed();
        }
    }
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
        let canonical_root = fs::canonicalize(&root).map_err(|source| LibraryError::ReadMedia {
            path: root.clone(),
            source,
        })?;
        let lease = Arc::new(LibraryLease::acquire(&root)?);
        backup::check_interrupted_restore(&root)?;
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
            canonical_root,
            lease,
            ingestion_lock: Arc::new(Mutex::new(())),
            trash_lock: Arc::new(Mutex::new(())),
            video_lock: Arc::new(Mutex::new(())),
            backup_lock: Arc::new(Mutex::new(())),
            release_watch_lock: Arc::new(Mutex::new(())),
            manga_scan_lock: Arc::new(Mutex::new(())),
            volume_import_lock: Arc::new(Mutex::new(())),
            database_lock: Arc::new(Mutex::new(())),
            asset_sync_lock: Arc::new(Mutex::new(())),
            album_flush_lock: Arc::new(Mutex::new(())),
            classification_flush_lock: Arc::new(Mutex::new(())),
            catalog_file_lock: Arc::default(),
            catalog_preparation: Arc::default(),
            catalog_lookup_cache: Arc::new(Mutex::new(None)),
            collection_artwork_scan_cache: Arc::new(Mutex::new(HashMap::new())),
            revisit_color_cache: Arc::default(),
            revisit_color_lock: Arc::default(),
            character_scan: Arc::default(),
            character_incremental: Arc::default(),
            character_wake: Arc::default(),
            character_shadow_backfill: Arc::default(),
            character_worker_pool: Arc::default(),
            video_similarity_scan: Arc::default(),
            igdb_token_cache: igdb::IgdbTokenCache::default(),
            igdb_request_limiter: igdb::IgdbRequestLimiter::default(),
            machine_settings_path: Arc::default(),
            new_ingests: Arc::default(),
            replication_lock: Arc::default(),
            collection_publication_defer: Arc::default(),
            encrypted_vault: Arc::default(),
        };
        library.backfill_legacy_collection_kinds()?;
        library.normalize_showcase_orders()?;
        library.cleanup_stale_asset_drags()?;
        library.cleanup_resolving_similarity_reviews()?;
        library.requeue_interrupted_video_preparation()?;
        library.recover_video_similarity_scans()?;
        library.recover_character_autotag()?;
        library.requeue_interrupted_cloud_sync()?;
        // Best effort: a locked or read-only orphan (antivirus, a sync client, a viewer)
        // must not stop the library from opening; the next open retries (review M3).
        if let Err(error) = library.cleanup_unreferenced_work_artwork() {
            eprintln!("work artwork cleanup skipped: {error}");
        }
        library.start_work_artwork_thumbnail_backfill();
        library.request_catalog_preparation();
        Ok(library)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Store per-computer values (the manga root) in this machine's settings file
    /// instead of the shared library database.
    pub fn use_machine_settings(&self, path: PathBuf) {
        if let Ok(id) = self.library_id() {
            match machine_settings::new_ingests(&path, &id) {
                Ok(ids) => *self.new_ingests.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = ids,
                Err(error) => eprintln!("new ingest settings: {error}"),
            }
        }
        *self
            .machine_settings_path
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
    }

    pub(crate) fn remember_new_ingest(&self, id: &str, pending: bool) {
        let mut ids = self.new_ingests.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending { ids.insert(id.to_owned()); } else { ids.remove(id); }
        if let (Some(path), Ok(library_id)) = (self.machine_settings_path(), self.library_id()) {
            if let Err(error) = machine_settings::set_new_ingests(&path, &library_id, ids.clone()) {
                eprintln!("new ingest settings: {error}");
            }
        }
    }
    pub(crate) fn new_ingest_json(&self) -> String {
        serde_json::to_string(&*self.new_ingests.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).unwrap_or_else(|_| "[]".into())
    }

    pub(crate) fn machine_settings_path(&self) -> Option<PathBuf> {
        self.machine_settings_path
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn igdb_client(&self) -> igdb::IgdbClient {
        igdb::IgdbClient::with_cache_and_limiter(
            self.igdb_token_cache.clone(),
            self.igdb_request_limiter.clone(),
        )
    }

    /// Run one outbox delivery pass under its domain's single-flight gate.
    ///
    /// The gate makes "at most one active pass per domain" a property of the *domain*, not of a
    /// caller: every entry point — a mutation kick, the periodic sync hook, a focus or online
    /// event, or any future direct caller — goes through this, so none of them can overlap
    /// another. Without it two passes read the same queue and both send the same row, which the
    /// server's operation-id receipt makes idempotent but does not make free.
    ///
    /// The gate is held across the pass but never across the *database* lock in a way that
    /// inverts the order: the pass acquires and releases database connections inside itself, and
    /// no code path takes the database lock and then this one. Holding it during HTTP is
    /// deliberate and safe — it serializes delivery, not database access — and it cannot
    /// deadlock, because nothing under the database lock ever waits for a flush gate.
    ///
    /// A failure releases the gate like any other exit, so a transport error can never suppress
    /// later retries; the pass simply returns its typed error and the next caller runs cleanly.
    pub(crate) fn flush_outbox_single_flight<T>(
        &self,
        gate: &Mutex<()>,
        pass: impl FnOnce() -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let _guard = gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pass()
    }

    pub(crate) fn connection(&self) -> Result<LockedConnection<'_>, LibraryError> {
        let guard = self
            .database_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let connection = self.unlocked_connection()?;
        #[cfg(test)]
        self.character_wake.connection_opened();
        // Every writer of the character queue goes through here, so the idle native owner
        // can block until one of them commits instead of polling the queue.
        let character_queue_changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changed = character_queue_changed.clone();
        connection.update_hook(Some(
            move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                if character_incremental::is_queue_table(table) {
                    changed.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            },
        ))?;
        Ok(LockedConnection {
            connection,
            character_queue_changed,
            character_wake: &self.character_wake,
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

    /// Durable identity minted by migration 0079. Read-only by design: a library
    /// never mints or repairs its identity outside that migration transaction.
    pub(crate) fn library_id(&self) -> Result<String, LibraryError> {
        library_id_on(&*self.connection()?)
    }

    pub fn manga_root(&self) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        manga::manga_root(self, &connection)
    }

    pub fn set_manga_root(&self, path: Option<&str>) -> Result<(), LibraryError> {
        let connection = self.connection()?;
        manga::set_manga_root(self, &connection, path)
    }

    /// The shared-database manga root when it is not usable on this computer
    /// (typically saved by the other OS), shown as a hint while this PC is unset.
    pub fn other_machine_manga_root(&self) -> Result<Option<String>, LibraryError> {
        let connection = self.connection()?;
        manga::other_machine_manga_root(self, &connection)
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
        let root = manga::manga_root(self, &connection)?.ok_or(LibraryError::MangaRootNotSet)?;
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
        let root = manga::manga_root(self, &connection)?.ok_or(LibraryError::MangaRootNotSet)?;
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
        self.resolve_media_with_revision(asset_id, variant)
            .map(|(media, _)| media)
    }

    /// [`Self::resolve_media`] plus the Asset's current [`models::thumbnail_revision`] for
    /// the thumbnail and scrub-frame variants (`None` for other variants), read in the same
    /// query, so the media protocol can tell whether a revisioned URL is still current.
    pub fn resolve_media_with_revision(
        &self,
        asset_id: &str,
        variant: MediaVariant,
    ) -> Result<(MediaResponse, Option<String>), LibraryError> {
        let unrevisioned =
            |media: Result<MediaResponse, LibraryError>| media.map(|media| (media, None));
        match variant {
            MediaVariant::MangaCover => return unrevisioned(self.manga_cover(asset_id)),
            MediaVariant::MangaPage(page_index) => {
                return unrevisioned(self.manga_page(asset_id, page_index))
            }
            MediaVariant::WorkArtwork => return unrevisioned(self.resolve_work_artwork(asset_id)),
            MediaVariant::WorkArtworkThumbnail => {
                return unrevisioned(self.resolve_work_artwork_thumbnail(asset_id))
            }
            _ => {}
        }
        let mut thumbnail_path = None;
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
            MediaVariant::TrashThumbnail => self
                .connection()?
                .query_row(
                    "SELECT thumbnail_relative_path FROM assets WHERE id = ?1 AND status = 'trash'",
                    [asset_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten(),
            MediaVariant::Thumbnail => {
                thumbnail_path = self
                    .connection()?
                    .query_row(
                        "SELECT thumbnail_relative_path FROM assets
                         WHERE id = ?1 AND status IN ('normal', 'review')",
                        [asset_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten();
                thumbnail_path.clone()
            }
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
                    "SELECT video.scrub_relative_dir, video.scrub_frame_count,
                            asset.thumbnail_relative_path
                     FROM assets AS asset
                     JOIN video_assets AS video ON video.asset_id = asset.id
                     WHERE asset.id = ?1 AND asset.status = 'normal'
                       AND video.preparation_state = 'ready'",
                    [asset_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?
                .and_then(|(directory, count, thumbnail)| {
                    thumbnail_path = thumbnail;
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
        match relative_path {
            Some(relative_path) => Ok((
                self.open_library_media(&relative_path)?,
                thumbnail_path.as_deref().map(models::thumbnail_revision),
            )),
            None => Err(LibraryError::AssetNotFound),
        }
    }

    pub(crate) fn open_library_media(
        &self,
        relative_path: &str,
    ) -> Result<MediaResponse, LibraryError> {
        let requested_path = self.canonical_root.join(relative_path);
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
        if !canonical_path.starts_with(&self.canonical_root) {
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

    #[cfg(unix)]
    #[test]
    fn media_opens_remain_bound_to_the_library_root_canonicalized_at_open() {
        use std::io::Read;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original");
        let replacement = temp.path().join("replacement");
        fs::create_dir(&original).unwrap();
        fs::create_dir_all(replacement.join("assets")).unwrap();
        let selected = temp.path().join("selected");
        symlink(&original, &selected).unwrap();
        let library = Library::open(&selected).unwrap();
        fs::write(original.join("assets/source.png"), b"original").unwrap();
        fs::write(replacement.join("assets/source.png"), b"replacement").unwrap();

        fs::remove_file(&selected).unwrap();
        symlink(&replacement, &selected).unwrap();

        let mut bytes = Vec::new();
        library
            .open_library_media("assets/source.png")
            .unwrap()
            .file
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"original");
    }
}
