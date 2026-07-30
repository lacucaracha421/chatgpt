import { invoke } from "@tauri-apps/api/core";
import type {
  ClassificationEntry,
  CreateClassification,
  IngestImageInput,
  IngestOutcome,
  LibraryGateway,
  LibrarySummary,
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
  setAssetClassifications: (assetId, classificationIds) =>
    invoke("set_asset_classifications", { assetId, classificationIds }),
  getAssetClassifications: (assetId) =>
    invoke<string[]>("get_asset_classifications", { assetId }),
  ingestImage: (request: IngestImageInput) =>
    invoke<IngestOutcome>("ingest_image", { request }),
};
