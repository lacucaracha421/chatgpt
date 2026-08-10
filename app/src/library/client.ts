import { invoke } from "@tauri-apps/api/core";
import type {
  AssetPage,
  AssetClassificationPatch,
  AssetQuery,
  AssetSummary,
  ClassificationEntry,
  CreateClassification,
  IngestMediaInput,
  IngestOutcome,
  LibraryGateway,
  LibrarySummary,
  MangaSeries,
  MetadataBackup,
  PurgeSummary,
  SimilarityDecisionOutcome,
  SimilarityIndexProgress,
  SimilarityReviewPage,
  TrashPage,
  TrashPolicy,
  VideoPreparationProgress,
  VideoPreparationState,
} from "./types";

export const libraryGateway: LibraryGateway = {
  openLibrary: (path) => invoke<LibrarySummary>("open_library", { path }),
  currentLibrary: () => invoke<LibrarySummary | null>("current_library"),
  listClassifications: () =>
    invoke<ClassificationEntry[]>("list_classifications"),
  createClassification: (request: CreateClassification) =>
    invoke<ClassificationEntry>("create_classification", { request }),
  renameClassification: (id, name) =>
    invoke("rename_classification", { id, name }),
  moveClassification: (id, parentId) =>
    invoke("move_classification", { id, parentId }),
  deleteClassification: (id) => invoke("delete_classification", { id }),
  listAssets: (query: AssetQuery) =>
    invoke<AssetPage>("list_assets", { query }),
  indexMissingSimilarityHashes: () =>
    invoke<SimilarityIndexProgress>("index_missing_similarity_hashes"),
  listSimilarityReviews: ({ after, limit }) =>
    invoke<SimilarityReviewPage>("list_similarity_reviews", { after, limit }),
  decideSimilarityReview: (request) =>
    invoke<SimilarityDecisionOutcome>("decide_similarity_review", { request }),
  getAsset: (assetId) => invoke<AssetSummary>("get_asset", { assetId }),
  trashAsset: (assetId) => invoke("trash_asset", { assetId }),
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
  setAssetClassifications: (assetId, classificationIds) =>
    invoke("set_asset_classifications", { assetId, classificationIds }),
  patchAssetClassifications: (patch: AssetClassificationPatch) =>
    invoke("patch_asset_classifications", { patch }),
  getAssetClassifications: (assetId) =>
    invoke<string[]>("get_asset_classifications", { assetId }),
  getMangaRoot: () => invoke<string | null>("get_manga_root"),
  setMangaRoot: (path) => invoke("set_manga_root", { path }),
  scanManga: () => invoke<number>("scan_manga"),
  listMangaSeries: () => invoke<MangaSeries[]>("list_manga_series"),
  ingestMedia: (request: IngestMediaInput) =>
    invoke<IngestOutcome>("ingest_media", { request }),
  preparePendingVideos: (limit) =>
    invoke<VideoPreparationProgress>("prepare_pending_videos", { limit }),
  retryVideoPreparation: (assetId) =>
    invoke<VideoPreparationState>("retry_video_preparation", { assetId }),
};
