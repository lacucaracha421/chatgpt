import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CatalogReviewPage,
  KakaoApplyRequest,
  BookConnection,
  KakaoCredentialStatus,
  KakaoSeriesCandidate,
  KakaoSyncResult,
  AlbumEntry,
  CharacterSidebarCounts,
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
  CreatedEncryptedVault,
  EncryptedVaultExportJob,
  EncryptedVaultExportProgress,
  EncryptedVaultImportJob,
  EncryptedVaultImportProgress,
  EncryptedVaultImportReport,
  EncryptedVaultItemPage,
  EncryptedVaultSidecarCleanupPreview,
  EncryptedVaultSidecarCleanupResult,
  EncryptedVaultStatus,
  ImageSimilarityScan,
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
  CatalogGroupedSearchEvent,
  CatalogGroupEditionsPage,
  CatalogSearchQuery,
  CatalogBlockedTag,
  CatalogVisibilityPolicy,
  CatalogStatus,
  CatalogSuggestion,
  CatalogUpdateResult,
  CloudCaptureSyncResult,
  CloudCaptureSettings,
  CloudCredentialStatus,
  CloudCaptureConnectionStatus,
  ExtensionPairingLink,
  CloudMetadataBackupResult,
  BookmarkReconciliationResult,
  BookmarkOutboxFlushResult,
  AlbumReconciliationResult,
  ClassificationReconciliationResult,
  ClassificationOutboxFlushResult,
  ClassificationSyncStatus,
  AlbumOutboxFlushResult,
  AlbumSyncStatus,
  AuthoritySyncHealth,
  CloudCollectionsPublishResult,
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

/**
 * Wake one authority domain's outbox delivery.
 *
 * Delivery single-flight belongs to the *native* layer, not here (see
 * `Library::flush_outbox_single_flight`): several independent callers deliver the same
 * domain — this kick, the periodic sync hook, and focus/online events — so a coalescer in
 * this module could only ever serialize the kicks against each other, leaving a kick free
 * to overlap a running background pass. The native gate covers every caller, so this is a
 * plain fire-and-forget wake-up.
 *
 * Nothing here is awaited by the caller: the local mutation's optimistic write and its
 * outbox row commit together before this runs, so a successful edit must not wait on the
 * network. A failure is not the user's edit failing either — the durable outbox is the
 * retry mechanism, and the background loop resends the identical operation id.
 */
function kickOutboxDelivery(command: string): void {
  try {
    // `invoke` returns a promise in production; wrapping keeps this correct even for a
    // synchronous test double, without changing the fire-and-forget contract.
    void Promise.resolve(invoke(command)).catch(() => {
      // The durable outbox retries; a failed send here is not a lost edit.
    });
  } catch {
    // A synchronous throw is the same non-event as a rejected send.
  }
}

const kickAlbumOutbox = () => kickOutboxDelivery("flush_album_outbox");
const kickClassificationOutbox = () => kickOutboxDelivery("flush_classification_outbox");

/**
 * Run a local Album mutation and kick delivery of its durable intent.
 *
 * The mutation's optimistic write and its outbox row are one transaction on the native
 * side, so by the time this returns the edit is durable and offline-safe. Delivery is
 * kicked but never awaited: waiting would make a local structural edit as slow as the
 * network, and a failed send is not a lost edit — the background loop retries the
 * identical operation id. Kicking only shortens the window where another device sees the
 * old structure.
 */
async function albumMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = await run();
  kickAlbumOutbox();
  return result;
}

/**
 * Run a local Classification mutation and kick delivery of its durable intent.
 *
 * The same contract as `albumMutation`, and deliberately after the mutation rather than
 * around it: the optimistic local write and its durable intent are already committed by
 * the time this returns, so a failed send must never fail the user's edit.
 *
 * Every path that can create a Classification authority intent goes through this, so a
 * mutation cannot be added later that queues work nothing attempts to deliver.
 */
async function classificationMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = await run();
  kickClassificationOutbox();
  return result;
}

export const libraryGateway: LibraryGateway = {
  getLibraryStatistics: () => invoke("get_library_statistics"),
  getHomeOverview: (todayStart, weekStart) => invoke("get_home_overview", { todayStart, weekStart }),
  measureLibraryDerivativeStorage: () => invoke("measure_library_derivative_storage"),
  recordCollectionOpened: (collectionId, openedAt) => invoke("record_collection_opened", { collectionId, openedAt }),
  artists: {
    overview: () => invoke("get_artist_overview"),
    list: (query) => invoke("list_artists", { query }),
    detail: (artistId, localDate, offsetMinutes) => invoke("get_artist", { artistId, localDate, offsetMinutes }),
    today: (localDate, offsetMinutes, seed, excluded) => invoke("get_artist_today", { localDate, offsetMinutes, seed, excluded }),
    mergeSuggestions: () => invoke("list_artist_merge_suggestions"),
    sourceFillPreview: () => invoke("preview_artist_source_fill"),
    applySourceFill: () => invoke("apply_artist_source_fill"),
    captionLabels: () => invoke("get_artist_caption_labels"),
    setDisplayName: (artistId, displayName) => invoke("set_artist_display_name", { artistId, displayName }),
    setFlags: (artistId, flags) => invoke("set_artist_flags", { artistId, pinned: flags.pinned ?? null, hidden: flags.hidden ?? null }),
    merge: (targetId, sourceIds, displayName) => invoke("merge_artists", { targetId, sourceIds, displayName }),
    detachMember: (artistId, creatorKey) => invoke("detach_artist_member", { artistId, creatorKey }),
    detachAssignments: (artistId, source) => invoke("detach_artist_assignments", { artistId, source }),
    dismissSuggestion: (keyA, keyB) => invoke("dismiss_artist_merge_suggestion", { keyA, keyB }),
    assignAssets: (assetIds, target) => invoke("assign_assets_to_artist", "artistId" in target
      ? { assetIds, artistId: target.artistId, newName: null }
      : { assetIds, artistId: null, newName: target.newName }),
    setSettings: (settings) => invoke("set_artist_settings", { settings }),
  },
  releaseCalendar: {
    calendar: () => invoke("get_release_calendar"),
    refresh: (force) => invoke("refresh_release_calendar", { force }),
    wishlist: () => invoke("list_release_wishlist"),
    add: (id) => invoke("add_release_wishlist_item", { id }),
    remove: (id) => invoke("remove_release_wishlist_item", { id }),
    setMuted: (id, muted) => invoke("set_release_wishlist_muted", { id, muted }),
    acknowledge: (eventIds) => invoke("acknowledge_release_wishlist_events", { eventIds }),
    runDue: () => invoke("run_due_release_wishlist"),
  },
  collectionTracking: {
    runUpdates: (provider) => invoke("run_collection_updates", { provider }),
    updateStatus: (provider) => invoke("get_collection_update_status", { provider }),
    ownershipTracking: (collectionId) => invoke("list_ownership_tracking", { collectionId }),
    setOwnedCount: (collectionId, editionIndex, count) => invoke("set_owned_volume_count", { collectionId, editionIndex, count }),
    listOwnership: (collectionId) => invoke("list_volume_ownership", { collectionId }),
    setOwnership: (collectionId, editionIndex, volumeNumbers, format, owned) => invoke("set_volume_ownership", { collectionId, editionIndex, volumeNumbers, format, owned }),
    listInbox: () => invoke("list_release_inbox"),
    releaseBoard: () => invoke("list_release_board"),
    acknowledge: (collectionId, eventIds) => invoke("acknowledge_release_events", { collectionId, eventIds }),
  },
  openLibrary: (path) => invoke<LibrarySummary>("open_library", { path }),
  importVckCatalog: (vckRoot) =>
    invoke<CatalogStatus>("import_vck_catalog", { vckRoot }),
  getOnlineCatalogStatus: () =>
    invoke<CatalogStatus>("get_online_catalog_status"),
  getCatalogVisibilityPolicy: () =>
    invoke<CatalogVisibilityPolicy>("get_catalog_visibility_policy"),
  setCatalogCategoryHidden: (category, hidden) =>
    invoke<CatalogVisibilityPolicy>("set_catalog_category_hidden", { category, hidden }),
  setCatalogTagBlocked: (tag: CatalogBlockedTag, blocked) =>
    invoke<CatalogVisibilityPolicy>("set_catalog_tag_blocked", { tag, blocked }),
  cancelCatalogSearch: () => invoke<void>("cancel_catalog_search"),
  searchCatalogGroups: (query, onEvent) => {
    const channel = new Channel<CatalogGroupedSearchEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("search_catalog_groups", { query, onEvent: channel });
  },
  getCatalogGroupEditions: (query) => invoke<CatalogGroupEditionsPage>("get_catalog_group_editions", { query }),
  setCatalogGroupRepresentative: (query) => invoke<void>("set_catalog_group_representative", { query }),
  listCatalogReview: () => invoke<CatalogReviewPage>("list_catalog_review"),
  generateCatalogReview: () => invoke<CatalogReviewPage>("generate_catalog_review"),
  decideCatalogReview: (query) => invoke<void>("decide_catalog_review", { query }),
  searchOnlineCatalog: (query: CatalogSearchQuery) =>
    invoke<CatalogSearchPage>("search_online_catalog", { query }),
  suggestOnlineCatalog: (text, limit) =>
    invoke<CatalogSuggestion[]>("suggest_online_catalog", { text, limit }),
  getOnlineCatalogWorkDetail: (identity) =>
    invoke<CatalogWorkDetail>("get_online_catalog_work_detail", { identity }),
  setOnlineCatalogBookmark: async (identity, bookmarked) => {
    await invoke("set_online_catalog_bookmark", { identity, bookmarked });
    try { await invoke("flush_catalog_bookmark_outbox"); } catch { /* durable outbox retries in background */ }
  },
  reconcileCatalogBookmarks: () =>
    invoke<BookmarkReconciliationResult>("reconcile_catalog_bookmarks"),
  flushCatalogBookmarkOutbox: () =>
    invoke<BookmarkOutboxFlushResult>("flush_catalog_bookmark_outbox"),
  syncAssetAuthority: () => invoke("sync_asset_authority"),
  reconcileAlbumAuthority: () =>
    invoke<AlbumReconciliationResult>("reconcile_album_authority"),
  // Flush-first, like Album: a pending Classification intent must be delivered, or
  // explicitly deferred, before a received page may touch the same state.
  reconcileClassificationAuthority: () =>
    invoke<ClassificationReconciliationResult>("reconcile_classification_authority"),
  flushClassificationOutbox: () =>
    invoke<ClassificationOutboxFlushResult>("flush_classification_outbox"),
  classificationSyncStatus: () =>
    invoke<ClassificationSyncStatus>("classification_sync_status"),
  flushAlbumOutbox: () => invoke<AlbumOutboxFlushResult>("flush_album_outbox"),
  albumSyncStatus: () => invoke<AlbumSyncStatus>("album_sync_status"),
  authoritySyncHealth: () => invoke<AuthoritySyncHealth>("authority_sync_health"),
  updateOnlineCatalog: (language, maxPages) =>
    language === undefined && maxPages === undefined
      ? invoke<CatalogUpdateResult>("update_online_catalog")
      : invoke<CatalogUpdateResult>("update_online_catalog", {
        ...(language === undefined ? {} : { language }),
        ...(maxPages === undefined ? {} : { maxPages }),
      }),
  resetJapaneseCatalogCheckpoint: () =>
    invoke<CatalogStatus>("reset_japanese_catalog_checkpoint"),
  setOnlineCatalogUpdateSettings: (enabled, intervalSeconds) =>
    invoke<CatalogStatus>("set_online_catalog_update_settings", { enabled, intervalSeconds }),
  runDueOnlineCatalogUpdate: (language) =>
    language === undefined
      ? invoke<CatalogUpdateResult | null>("run_due_online_catalog_update")
      : invoke<CatalogUpdateResult | null>("run_due_online_catalog_update", { language }),
  getCloudCaptureSettings: () =>
    invoke<CloudCaptureSettings>("get_cloud_capture_settings"),
  setCloudCaptureSettings: (enabled, apiBaseUrl, captureEnabled) =>
    invoke<CloudCaptureSettings>("set_cloud_capture_settings", { enabled, apiBaseUrl, ...(captureEnabled === undefined ? {} : { captureEnabled }) }),
  setCloudApiToken: (token) =>
    invoke<CloudCredentialStatus>("set_cloud_api_token", { token }),
  deleteCloudApiToken: () =>
    invoke<CloudCredentialStatus>("delete_cloud_api_token"),
  testCloudCaptureConnection: () =>
    invoke<CloudCaptureConnectionStatus>("test_cloud_capture_connection"),
  createExtensionPairing: () =>
    invoke<ExtensionPairingLink>("create_extension_pairing"),
  pushCloudMetadataBackup: () =>
    invoke<CloudMetadataBackupResult>("push_cloud_metadata_backup"),
  pushCloudCollections: (onProgress) => {
    const channel = new Channel<import("./publicationJobs").PublishProgress>();
    channel.onmessage = (value) => onProgress?.(value);
    return invoke<CloudCollectionsPublishResult>("push_cloud_collections", { onProgress: channel });
  },
  runDueMobilePublications: (orderIds) => invoke<void>("run_due_mobile_publications", {orderIds}),
  subscribeCollectionsChanged: (handler) => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen("library://collections-changed", () => handler())
      .then((stop) => { if (stopped) stop(); else unlisten = stop; })
      .catch(() => {});
    return () => { stopped = true; unlisten?.(); };
  },
  pushCloudCharacters: (onProgress) => {
    const channel = new Channel<import("./publicationJobs").PublishProgress>();
    channel.onmessage = (value) => onProgress?.(value);
    return invoke<{revision: string; nodes: number}>("push_cloud_characters", { onProgress: channel });
  },
  restoreCloudMetadataBackup: () =>
    invoke<CloudLibraryRestoreReport>("restore_cloud_metadata_backup"),
  runDueCloudCaptureSync: (onProgress) => {
    const channel = new Channel<IngestOutcome>();
    channel.onmessage = value => onProgress?.(value);
    return invoke<CloudCaptureSyncResult>("run_due_cloud_capture_sync", { onProgress: channel });
  },
  subscribeCloudCapturesPending: (handler) => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen("cloud://captures-pending", () => handler())
      .then((stop) => { if (stopped) stop(); else unlisten = stop; })
      .catch(() => {});
    return () => { stopped = true; unlisten?.(); };
  },
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
  characterSidebarCounts: () =>
    invoke<CharacterSidebarCounts>("character_sidebar_counts"),
  createClassification: (request: CreateClassification) =>
    classificationMutation(() => invoke<ClassificationEntry>("create_classification", { request })),
  renameClassification: (id, name) =>
    classificationMutation(() => invoke("rename_classification", { id, name })),
  moveClassification: (id, parentId) =>
    classificationMutation(() => invoke("move_classification", { id, parentId })),
  updateClassificationAppearance: (id, iconKey, colorKey) =>
    classificationMutation(() => invoke("update_classification_appearance", { id, iconKey, colorKey })),
  deleteClassification: (id) => classificationMutation(() => invoke("delete_classification", { id })),
  listAlbums: () => invoke<AlbumEntry[]>("list_albums"),
  createAlbum: (request: CreateAlbum) =>
    albumMutation(() => invoke<AlbumEntry>("create_album", { request })),
  renameAlbum: (id, name) => albumMutation(() => invoke("rename_album", { id, name })),
  moveAlbum: (id, parentId) => albumMutation(() => invoke("move_album", { id, parentId })),
  updateAlbumAppearance: (id, iconKey, colorKey) =>
    albumMutation(() => invoke("update_album_appearance", { id, iconKey, colorKey })),
  deleteAlbum: (id) => albumMutation(() => invoke("delete_album", { id })),
  listAssets: (query: AssetQuery) =>
    invoke<AssetPage>("list_assets", { query }),
  refreshAssets: (query, assetIds) => invoke<AssetSummary[]>("refresh_assets", { query, assetIds }),
  listSourceGroupAssets: (assetId) =>
    invoke<AssetSummary[]>("list_source_group_assets", { assetId }),
  listAssetDateBuckets: (query: AssetDateBucketQuery) =>
    invoke<AssetDateBucket[]>("list_asset_date_buckets", { query }),
  listAssetCreators: (query: AssetQuery) =>
    invoke<AssetCreatorSummary[]>("list_asset_creators", { query }),
  getRevisitSlate: (localDate: string, nowUtc: string) =>
    invoke<RevisitSlate>("get_revisit_slate", { localDate, nowUtc }),
  prepareRevisitColorBundle: (localDate: string, nowUtc: string, expectedRevision: number) =>
    invoke<RevisitSlate | null>("prepare_revisit_color_bundle", { localDate, nowUtc, expectedRevision }),
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
  getImageSimilarityScan: () =>
    invoke<ImageSimilarityScan | null>("get_image_similarity_scan"),
  startImageSimilarityScan: () =>
    invoke<ImageSimilarityScan>("start_image_similarity_scan"),
  runImageSimilarityScanBatch: (scanId) =>
    invoke<ImageSimilarityScan>("run_image_similarity_scan_batch", { scanId }),
  listSimilarityReviews: ({ after, limit }) =>
    invoke<SimilarityReviewPage>("list_similarity_reviews", { after, limit }),
  decideSimilarityReview: (request) =>
    invoke("decide_similarity_review", { request }),
  similarityReviewInboundStatus: () =>
    invoke<{ applied: number }>("similarity_review_inbound_status"),
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
    classificationMutation(() => invoke("set_asset_classification", { request })),
  patchAssetAlbums: (patch: AssetAlbumPatch) =>
    albumMutation(() => invoke("patch_asset_albums", { patch })),
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
  searchTmdbMovies: (query, mediaType) =>
    invoke<TmdbSearchResult[]>("search_tmdb_movies", { query, ...(mediaType ? { mediaType } : {}) }),
  previewTmdbMovie: (movieId, mediaType) =>
    invoke<TmdbMoviePreview>("preview_tmdb_movie", { movieId, ...(mediaType ? { mediaType } : {}) }),
  applyTmdbMovie: (request: TmdbApplyRequest) =>
    invoke<CollectionSummary>("apply_tmdb_movie", { request }),
  refreshTmdbMovie: (collectionId) =>
    invoke<CollectionSummary>("refresh_tmdb_movie", { collectionId }),
  getTmdbConnection: (collectionId) =>
    invoke<TmdbConnection | null>("get_tmdb_connection", { collectionId }),
  replaceTmdbMovieArtwork: (request: TmdbArtworkReplaceRequest) =>
    invoke<CollectionSummary>("replace_tmdb_movie_artwork", { request }),
  getKakaoCredentialStatus: () =>
    invoke<KakaoCredentialStatus>("get_kakao_credential_status"),
  setKakaoApiKey: (apiKey) =>
    invoke<KakaoCredentialStatus>("set_kakao_api_key", { apiKey }),
  deleteKakaoApiKey: () =>
    invoke<KakaoCredentialStatus>("delete_kakao_api_key"),
  searchKakao: (query) =>
    invoke<KakaoSeriesCandidate[]>("search_kakao", { query }),
  applyKakao: (request: KakaoApplyRequest) =>
    invoke<KakaoSyncResult>("apply_kakao", { request }),
  refreshKakao: (collectionId) =>
    invoke<KakaoSyncResult>("refresh_kakao", { collectionId }),
  getBookConnection: (collectionId) =>
    invoke<BookConnection | null>("get_book_connection", { collectionId }),
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
  getEncryptedVaultStatus: () => invoke<EncryptedVaultStatus>("encrypted_vault_status"),
  createEncryptedVault: (root, password, remember) =>
    invoke<CreatedEncryptedVault>("create_encrypted_vault", { root, password, remember }),
  unlockEncryptedVault: (secret, remember) =>
    invoke<EncryptedVaultStatus>("unlock_encrypted_vault", { secret, remember }),
  lockEncryptedVault: () => invoke<EncryptedVaultStatus>("lock_encrypted_vault"),
  forgetEncryptedVaultKey: () => invoke<EncryptedVaultStatus>("forget_encrypted_vault_key"),
  changeEncryptedVaultPassword: (current, newPassword) =>
    invoke<void>("change_encrypted_vault_password", { current, newPassword }),
  importIntoEncryptedVault: (sourceFolder, onProgress) => {
    const channel = new Channel<EncryptedVaultImportProgress>();
    channel.onmessage = (progress) => onProgress?.(progress);
    return invoke<EncryptedVaultImportReport>("import_into_encrypted_vault", { sourceFolder, onProgress: channel });
  },
  getEncryptedVaultImportStatus: () => invoke<EncryptedVaultImportJob | null>("encrypted_vault_import_status"),
  importFilesIntoEncryptedVault: (files, onProgress) => {
    const channel = new Channel<EncryptedVaultImportProgress>();
    channel.onmessage = (progress) => onProgress?.(progress);
    return invoke<EncryptedVaultImportReport>("import_files_into_encrypted_vault", { files, onProgress: channel });
  },
  trashEncryptedVaultItems: (itemIds) => invoke<number>("trash_encrypted_vault_items", { itemIds }),
  restoreEncryptedVaultItems: (itemIds) => invoke<number>("restore_encrypted_vault_items", { itemIds }),
  deleteEncryptedVaultItems: (itemIds) => invoke<number>("delete_encrypted_vault_items", { itemIds }),
  emptyEncryptedVaultTrash: () => invoke<number>("empty_encrypted_vault_trash"),
  exportEncryptedVaultItems: (itemIds, destination, onProgress) => {
    const channel = new Channel<EncryptedVaultExportProgress>();
    channel.onmessage = (progress) => onProgress?.(progress);
    return invoke<EncryptedVaultExportProgress>("export_encrypted_vault_items", { itemIds, destination, onProgress: channel });
  },
  getEncryptedVaultExportStatus: () => invoke<EncryptedVaultExportJob | null>("encrypted_vault_export_status"),
  listEncryptedVaultItems: (query) => invoke<EncryptedVaultItemPage>("list_encrypted_vault_items", { query }),
  setEncryptedVaultTitle: (itemId, title) => invoke<void>("set_encrypted_vault_title", { itemId, title }),
  previewEncryptedVaultSidecarCleanup: () =>
    invoke<EncryptedVaultSidecarCleanupPreview>("preview_encrypted_vault_sidecar_cleanup"),
  applyEncryptedVaultSidecarCleanup: () =>
    invoke<EncryptedVaultSidecarCleanupResult>("apply_encrypted_vault_sidecar_cleanup"),
  getMangaRoot: () => invoke<string | null>("get_manga_root"),
  getOtherMachineMangaRoot: () => invoke<string | null>("get_other_machine_manga_root"),
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
    // The native command requires a channel even when progress is not displayed.
    const onProgressChannel = new Channel<VolumeImportProgress>();
    onProgressChannel.onmessage = (progress) => onProgress?.(progress);
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
