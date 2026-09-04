import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AladinApplyRequest,
  AladinConnection,
  AladinCredentialStatus,
  AladinSeriesCandidate,
  AladinSyncResult,
  AlbumEntry,
  AssetAlbumPatch,
  AssetCollectionPatch,
  AssetCreatorSummary,
  AssetDateBucket,
  RevisitFeedback,
  RevisitSlate,
  AssetDateBucketQuery,
  AssetMetadataPatch,
  AssetPage,
  AssetQuery,
  AssetSummary,
  ClassificationEntry,
  CollectionSummary,
  CreateAlbum,
  CreateClassification,
  CreateCollection,
  ExtensionConnection,
  IngestMediaInput,
  IngestOutcome,
  LibraryGateway,
  LibrarySummary,
  MangaDexApplyRequest,
  MangaDexConnection,
  MangaDexSearchResult,
  MangaDexWorkPreview,
  IgdbApplyRequest,
  IgdbArtworkReplaceRequest,
  IgdbConnection,
  IgdbCredentialStatus,
  IgdbGamePreview,
  IgdbSearchResult,
  TmdbApplyRequest,
  TmdbArtworkReplaceRequest,
  TmdbConnection,
  TmdbCredentialStatus,
  TmdbMoviePreview,
  TmdbSearchResult,
  MangaSeries,
  MangaCatalogRecoveryApplyResult,
  MangaCatalogRecoveryPreview,
  MangaCatalogRecoveryRemoteResult,
  MangaCatalogRecoverySelection,
  MetadataBackup,
  MetadataImportPlan,
  PurgeSummary,
  SimilarityIndexProgress,
  SimilarityReviewPage,
  TrashPage,
  TrashPolicy,
  UpdateCollection,
  VideoPreparationProgress,
  VolumeImportProgress,
  WorkArtworkSummary,
  BookImportPlan,
  BookMigrationReport,
  LegacyPackageMigrationPlan,
  LegacyPackageMigrationReport,
  CatalogSearchPage,
  CatalogSearchQuery,
  CatalogStatus,
  CatalogSuggestion,
  CatalogUpdateResult,
  CloudCaptureSyncResult,
  CloudCaptureSettings,
  CloudCredentialStatus,
  CloudCaptureConnectionStatus,
  CloudMetadataBackupResult,
  CloudLibraryRestoreReport,
  CatalogWorkDetail,
  CollectionCover,
  CollectionVolume,
  MangaDexVolumeSyncResult,
  ReleaseWatchEvent,
  ReleaseWatchRunResult,
  ReleaseWatchStatus,
  RemoteReadingProgress,
  ResolvedGallery,
  CloudBackfillPreflightReport,
  CloudBackfillSeedReport,
  CloudBackfillRunSummary,
  CloudBackfillProgress,
  CloudBackfillRetryReport,
  CloudBackfillControlState,
  CloudBackfillReconcileReport,
} from "./types";

export const libraryGateway: LibraryGateway = {
  openLibrary: (path) => invoke<LibrarySummary>("open_library", { path }),
  importVckCatalog: (vckRoot) =>
    invoke<CatalogStatus>("import_vck_catalog", { vckRoot }),
  getOnlineCatalogStatus: () =>
    invoke<CatalogStatus>("get_online_catalog_status"),
  searchOnlineCatalog: (query: CatalogSearchQuery) =>
    invoke<CatalogSearchPage>("search_online_catalog", { query }),
  suggestOnlineCatalog: (text, limit) =>
    invoke<CatalogSuggestion[]>("suggest_online_catalog", { text, limit }),
  getOnlineCatalogWorkDetail: (identity) =>
    invoke<CatalogWorkDetail>("get_online_catalog_work_detail", { identity }),
  setOnlineCatalogBookmark: (identity, bookmarked) =>
    invoke("set_online_catalog_bookmark", { identity, bookmarked }),
  updateOnlineCatalog: () =>
    invoke<CatalogUpdateResult>("update_online_catalog"),
  setOnlineCatalogUpdateSettings: (enabled, intervalSeconds) =>
    invoke<CatalogStatus>("set_online_catalog_update_settings", { enabled, intervalSeconds }),
  runDueOnlineCatalogUpdate: () =>
    invoke<CatalogUpdateResult | null>("run_due_online_catalog_update"),
  getCloudCaptureSettings: () =>
    invoke<CloudCaptureSettings>("get_cloud_capture_settings"),
  setCloudCaptureSettings: (enabled, apiBaseUrl) =>
    invoke<CloudCaptureSettings>("set_cloud_capture_settings", { enabled, apiBaseUrl }),
  setCloudApiToken: (token) =>
    invoke<CloudCredentialStatus>("set_cloud_api_token", { token }),
  deleteCloudApiToken: () =>
    invoke<CloudCredentialStatus>("delete_cloud_api_token"),
  testCloudCaptureConnection: () =>
    invoke<CloudCaptureConnectionStatus>("test_cloud_capture_connection"),
  pushCloudMetadataBackup: () =>
    invoke<CloudMetadataBackupResult>("push_cloud_metadata_backup"),
  restoreCloudMetadataBackup: () =>
    invoke<CloudLibraryRestoreReport>("restore_cloud_metadata_backup"),
  runDueCloudCaptureSync: () =>
    invoke<CloudCaptureSyncResult>("run_due_cloud_capture_sync"),
  cloudBackfillPreflight: () =>
    invoke<CloudBackfillPreflightReport>("cloud_backfill_preflight"),
  cloudBackfillSeed: () =>
    invoke<CloudBackfillSeedReport>("cloud_backfill_seed"),
  cloudBackfillRunCycle: () =>
    invoke<CloudBackfillRunSummary>("cloud_backfill_run_cycle"),
  cloudBackfillProgress: () =>
    invoke<CloudBackfillProgress>("cloud_backfill_progress"),
  cloudBackfillRetryFailed: () =>
    invoke<CloudBackfillRetryReport>("cloud_backfill_retry_failed"),
  cloudBackfillSetControlState: (state) =>
    invoke<CloudBackfillControlState>("cloud_backfill_set_control_state", { state }),
  cloudBackfillReconcile: () =>
    invoke<CloudBackfillReconcileReport>("cloud_backfill_reconcile"),
  resolveOnlineCatalogWork: (identity) =>
    invoke<ResolvedGallery>("resolve_online_catalog_work", { identity }),
  getRemoteReadingProgress: (identity) =>
    invoke<RemoteReadingProgress | null>("get_remote_reading_progress", { identity }),
  saveRemoteReadingProgress: (progress) =>
    invoke("save_remote_reading_progress", { progress }),
  clearRemoteMangaCache: () => invoke("clear_remote_manga_cache"),
  getExtensionConnection: () =>
    invoke<ExtensionConnection>("get_extension_connection"),
  listClassifications: () =>
    invoke<ClassificationEntry[]>("list_classifications"),
  createClassification: (request: CreateClassification) =>
    invoke<ClassificationEntry>("create_classification", { request }),
  renameClassification: (id, name) =>
    invoke("rename_classification", { id, name }),
  moveClassification: (id, parentId) =>
    invoke("move_classification", { id, parentId }),
  updateClassificationAppearance: (id, iconKey, colorKey) =>
    invoke("update_classification_appearance", { id, iconKey, colorKey }),
  deleteClassification: (id) => invoke("delete_classification", { id }),
  listAlbums: () => invoke<AlbumEntry[]>("list_albums"),
  createAlbum: (request: CreateAlbum) => invoke<AlbumEntry>("create_album", { request }),
  renameAlbum: (id, name) => invoke("rename_album", { id, name }),
  moveAlbum: (id, parentId) => invoke("move_album", { id, parentId }),
  updateAlbumAppearance: (id, iconKey, colorKey) =>
    invoke("update_album_appearance", { id, iconKey, colorKey }),
  deleteAlbum: (id) => invoke("delete_album", { id }),
  listAssets: (query: AssetQuery) =>
    invoke<AssetPage>("list_assets", { query }),
  listSourceGroupAssets: (assetId) =>
    invoke<AssetSummary[]>("list_source_group_assets", { assetId }),
  listAssetDateBuckets: (query: AssetDateBucketQuery) =>
    invoke<AssetDateBucket[]>("list_asset_date_buckets", { query }),
  listAssetCreators: (query: AssetQuery) =>
    invoke<AssetCreatorSummary[]>("list_asset_creators", { query }),
  getRevisitSlate: (localDate: string, nowUtc: string) =>
    invoke<RevisitSlate>("get_revisit_slate", { localDate, nowUtc }),
  reshuffleRevisitBundle: (localDate: string, bundleId: string) =>
    invoke<RevisitSlate>("reshuffle_revisit_bundle", { localDate, bundleId, nowUtc: new Date().toISOString() }),
  reshuffleRevisitSlate: (localDate: string) =>
    invoke<RevisitSlate>("reshuffle_revisit_slate", { localDate, nowUtc: new Date().toISOString() }),
  recordAssetOpened: (assetId: string, openedAt: string) =>
    invoke("record_asset_opened", { assetId, openedAt }),
  recordAssetsExposed: (assetIds: string[], exposedAt: string) =>
    invoke("record_assets_exposed", { assetIds, exposedAt }),
  setRevisitPreference: (feedback: RevisitFeedback) =>
    invoke("set_revisit_preference", { feedback }),
  indexMissingSimilarityHashes: () =>
    invoke<SimilarityIndexProgress>("index_missing_similarity_hashes"),
  listSimilarityReviews: ({ after, limit }) =>
    invoke<SimilarityReviewPage>("list_similarity_reviews", { after, limit }),
  decideSimilarityReview: (request) =>
    invoke("decide_similarity_review", { request }),
  getAsset: (assetId) => invoke<AssetSummary>("get_asset", { assetId }),
  updateAssetMetadata: (request: AssetMetadataPatch) =>
    invoke<AssetSummary>("update_asset_metadata", { request }),
  trashAssets: (assetIds) => invoke("trash_assets", { assetIds }),
  restoreAsset: (assetId) => invoke("restore_asset", { assetId }),
  restoreAssets: (assetIds) => invoke("restore_assets", { assetIds }),
  listTrash: ({ after, limit }) => invoke<TrashPage>("list_trash", { after, limit }),
  emptyTrash: () => invoke<PurgeSummary>("empty_trash"),
  getTrashPolicy: () => invoke<TrashPolicy>("get_trash_policy"),
  setTrashPolicy: (policy) => invoke("set_trash_policy", { policy }),
  ensureDailyBackup: () => invoke<MetadataBackup | null>("ensure_daily_backup"),
  listMetadataBackups: () => invoke<MetadataBackup[]>("list_metadata_backups"),
  restoreMetadataBackup: (backupId) => invoke("restore_metadata_backup", { backupId }),
  purgeExpiredTrash: () => invoke<PurgeSummary>("purge_expired_trash"),
  setAssetFavorite: (assetId, favorite) =>
    invoke("set_asset_favorite", { assetId, favorite }),
  setAssetsFavorite: (assetIds, favorite) =>
    invoke("set_assets_favorite", { assetIds, favorite }),
  getAssetClassifications: (assetId) =>
    invoke<string[]>("get_asset_classifications", { assetId }),
  setAssetClassification: (request) =>
    invoke("set_asset_classification", { request }),
  patchAssetAlbums: (patch: AssetAlbumPatch) => invoke("patch_asset_albums", { patch }),
  getAssetAlbums: (assetId) => invoke<string[]>("get_asset_albums", { assetId }),
  listCollections: () => invoke<CollectionSummary[]>("list_collections"),
  searchMangaDex: (query) =>
    invoke<MangaDexSearchResult[]>("search_mangadex", { query }),
  previewMangaDex: (mangaId) =>
    invoke<MangaDexWorkPreview>("preview_mangadex", { mangaId }),
  applyMangaDex: (request: MangaDexApplyRequest) =>
    invoke<CollectionSummary>("apply_mangadex", { request }),
  refreshMangaDex: (collectionId) =>
    invoke<CollectionSummary>("refresh_mangadex", { collectionId }),
  getMangaDexConnection: (collectionId) =>
    invoke<MangaDexConnection | null>("get_mangadex_connection", { collectionId }),
  getIgdbCredentialStatus: () =>
    invoke<IgdbCredentialStatus>("get_igdb_credential_status"),
  setIgdbCredentials: (input) =>
    invoke<IgdbCredentialStatus>("set_igdb_credentials", input),
  deleteIgdbCredentials: () =>
    invoke<IgdbCredentialStatus>("delete_igdb_credentials"),
  searchIgdbGames: (query) =>
    invoke<IgdbSearchResult[]>("search_igdb_games", { query }),
  previewIgdbGame: (gameId) =>
    invoke<IgdbGamePreview>("preview_igdb_game", { gameId }),
  applyIgdbGame: (request: IgdbApplyRequest) =>
    invoke<CollectionSummary>("apply_igdb_game", { request }),
  refreshIgdbGame: (collectionId) =>
    invoke<CollectionSummary>("refresh_igdb_game", { collectionId }),
  getIgdbConnection: (collectionId) =>
    invoke<IgdbConnection | null>("get_igdb_connection", { collectionId }),
  replaceIgdbGameArtwork: (request: IgdbArtworkReplaceRequest) =>
    invoke<CollectionSummary>("replace_igdb_game_artwork", { request }),
  getTmdbCredentialStatus: () =>
    invoke<TmdbCredentialStatus>("get_tmdb_credential_status"),
  setTmdbToken: (token) =>
    invoke<TmdbCredentialStatus>("set_tmdb_token", { token }),
  deleteTmdbToken: () =>
    invoke<TmdbCredentialStatus>("delete_tmdb_token"),
  searchTmdbMovies: (query) =>
    invoke<TmdbSearchResult[]>("search_tmdb_movies", { query }),
  previewTmdbMovie: (movieId) =>
    invoke<TmdbMoviePreview>("preview_tmdb_movie", { movieId }),
  applyTmdbMovie: (request: TmdbApplyRequest) =>
    invoke<CollectionSummary>("apply_tmdb_movie", { request }),
  refreshTmdbMovie: (collectionId) =>
    invoke<CollectionSummary>("refresh_tmdb_movie", { collectionId }),
  getTmdbConnection: (collectionId) =>
    invoke<TmdbConnection | null>("get_tmdb_connection", { collectionId }),
  replaceTmdbMovieArtwork: (request: TmdbArtworkReplaceRequest) =>
    invoke<CollectionSummary>("replace_tmdb_movie_artwork", { request }),
  getAladinCredentialStatus: () =>
    invoke<AladinCredentialStatus>("get_aladin_credential_status"),
  setAladinTtbKey: (ttbKey) =>
    invoke<AladinCredentialStatus>("set_aladin_ttb_key", { ttbKey }),
  deleteAladinTtbKey: () =>
    invoke<AladinCredentialStatus>("delete_aladin_ttb_key"),
  searchAladin: (query) =>
    invoke<AladinSeriesCandidate[]>("search_aladin", { query }),
  applyAladin: (request: AladinApplyRequest) =>
    invoke<AladinSyncResult>("apply_aladin", { request }),
  refreshAladin: (collectionId) =>
    invoke<AladinSyncResult>("refresh_aladin", { collectionId }),
  getAladinConnection: (collectionId) =>
    invoke<AladinConnection | null>("get_aladin_connection", { collectionId }),
  getReleaseWatchStatus: (collectionId) =>
    invoke<ReleaseWatchStatus>("get_release_watch_status", { collectionId }),
  setReleaseWatchEnabled: (collectionId, enabled) =>
    invoke<ReleaseWatchStatus>("set_release_watch_enabled", { collectionId, enabled }),
  takeUnreadReleaseChanges: (collectionId) =>
    invoke<ReleaseWatchEvent[]>("take_unread_release_changes", { collectionId }),
  listUnreadReleaseChanges: () =>
    invoke<ReleaseWatchEvent[]>("list_unread_release_changes"),
  runDueReleaseWatch: () =>
    invoke<ReleaseWatchRunResult>("run_due_release_watch"),
  createCollection: (input: CreateCollection) =>
    invoke<CollectionSummary>("create_collection", { request: input }),
  updateCollection: (id: string, input: UpdateCollection) =>
    invoke<CollectionSummary>("update_collection", { id, request: input }),
  deleteCollection: (id) => invoke<void>("delete_collection", { id }),
  setCollectionCover: (collectionId, assetId) =>
    invoke<CollectionSummary>("set_collection_cover", { collectionId, assetId }),
  setCollectionShowcase: (collectionId, showcase) =>
    invoke<CollectionSummary>("set_collection_showcase", { collectionId, showcase }),
  getAssetCollections: (assetId) =>
    invoke<string[]>("get_asset_collections", { assetId }),
  patchAssetCollections: (patch: AssetCollectionPatch) =>
    invoke<void>("patch_asset_collections", { patch }),
  getMangaRoot: () => invoke<string | null>("get_manga_root"),
  setMangaRoot: (path) => invoke("set_manga_root", { path }),
  scanManga: () => invoke<number>("scan_manga"),
  listMangaSeries: () => invoke<MangaSeries[]>("list_manga_series"),
  previewMangaCatalogRecovery: () =>
    invoke<MangaCatalogRecoveryPreview>("preview_manga_catalog_recovery"),
  refreshMangaCatalogRecoveryRemote: () =>
    invoke<MangaCatalogRecoveryRemoteResult>("refresh_manga_catalog_recovery_remote"),
  applyMangaCatalogRecovery: () =>
    invoke<MangaCatalogRecoveryApplyResult>("apply_manga_catalog_recovery"),
  applyMangaCatalogRecoverySelection: (selections: MangaCatalogRecoverySelection[]) =>
    invoke<MangaCatalogRecoveryApplyResult>("apply_manga_catalog_recovery_selection", { selections }),
  inspectBookImport: (root) => invoke<BookImportPlan>("inspect_book_import", { root }),
  importBookCollections: (root) => invoke<BookMigrationReport>("import_book_collections", { root }),
  inspectLegacyPackageMigration: (input) =>
    invoke<LegacyPackageMigrationPlan>("inspect_legacy_package_migration", input),
  executeLegacyPackageMigration: (input) =>
    invoke<LegacyPackageMigrationReport>("execute_legacy_package_migration", input),
  getCollectionSourceRoot: () => invoke<string | null>("get_collection_source_root"),
  setCollectionSourceRoot: (path) => invoke<number>("set_collection_source_root", { path }),
  listCollectionCovers: (collectionId) => invoke<CollectionCover[]>("list_collection_covers", { collectionId }),
  importCollectionArtworks: (collectionId) =>
    invoke<number>("import_collection_artworks", { collectionId }),
  listCollectionWorkArtworks: (collectionId) =>
    invoke<WorkArtworkSummary[]>("list_collection_work_artworks", { collectionId }),
  listCollectionVolumes: (collectionId, onProgress) => {
    if (!onProgress) {
      return invoke<CollectionVolume[]>("list_collection_volumes", { collectionId });
    }
    const onProgressChannel = new Channel<VolumeImportProgress>();
    onProgressChannel.onmessage = onProgress;
    return invoke<CollectionVolume[]>("list_collection_volumes", {
      collectionId,
      onProgress: onProgressChannel,
    });
  },
  syncMangaDexVolumeCovers: (collectionId) =>
    invoke<MangaDexVolumeSyncResult>("sync_mangadex_volume_covers", { collectionId }),
  inspectMetadataImport: (folder) =>
    invoke<MetadataImportPlan>("inspect_metadata_import", { folder }),
  ingestMedia: (request: IngestMediaInput) =>
    invoke<IngestOutcome>("ingest_media", { request }),
  preparePendingVideos: (limit) =>
    invoke<VideoPreparationProgress>("prepare_pending_videos", { limit }),
  retryVideoPreparation: (assetId) =>
    invoke("retry_video_preparation", { assetId }),
};
