import { invoke } from "@tauri-apps/api/core";
import type {
  AladinApplyRequest,
  AladinConnection,
  AladinCredentialStatus,
  AladinSeriesCandidate,
  AladinSyncResult,
  AlbumEntry,
  AssetAlbumPatch,
  AssetCollectionPatch,
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
  MangaSeries,
  MetadataBackup,
  MetadataImportPlan,
  PurgeSummary,
  SimilarityIndexProgress,
  SimilarityReviewPage,
  TrashPage,
  TrashPolicy,
  UpdateCollection,
  VideoPreparationProgress,
  BookImportPlan,
  BookMigrationReport,
  CollectionCover,
  CollectionVolume,
  MangaDexVolumeSyncResult,
  ReleaseWatchEvent,
  ReleaseWatchRunResult,
  ReleaseWatchStatus,
} from "./types";

export const libraryGateway: LibraryGateway = {
  openLibrary: (path) => invoke<LibrarySummary>("open_library", { path }),
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
  inspectBookImport: (root) => invoke<BookImportPlan>("inspect_book_import", { root }),
  importBookCollections: (root) => invoke<BookMigrationReport>("import_book_collections", { root }),
  getCollectionSourceRoot: () => invoke<string | null>("get_collection_source_root"),
  setCollectionSourceRoot: (path) => invoke("set_collection_source_root", { path }),
  listCollectionCovers: (collectionId) => invoke<CollectionCover[]>("list_collection_covers", { collectionId }),
  listCollectionVolumes: (collectionId) =>
    invoke<CollectionVolume[]>("list_collection_volumes", { collectionId }),
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
