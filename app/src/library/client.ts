import { invoke } from "@tauri-apps/api/core";
import type {
  AssetPage,
  AssetQuery,
  ClassificationEntry,
  CreateClassification,
  IngestImageInput,
  IngestOutcome,
  LibraryGateway,
  LibrarySummary,
  MetadataBackup,
  PurgeSummary,
  TrashPage,
  TrashPolicy,
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
  trashAsset: (assetId) => invoke("trash_asset", { assetId }),
  restoreAsset: (assetId) => invoke("restore_asset", { assetId }),
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
  setAssetClassifications: (assetId, classificationIds) =>
    invoke("set_asset_classifications", { assetId, classificationIds }),
  getAssetClassifications: (assetId) =>
    invoke<string[]>("get_asset_classifications", { assetId }),
  ingestImage: (request: IngestImageInput) =>
    invoke<IngestOutcome>("ingest_image", { request }),
};
