import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
export type CharacterSeries = { classificationId: string; heroAssetId: string | null; autoClassify: boolean };
export type CharacterGroup = { id: string; seriesId: string; name: string; revision: number; targetIds: string[] };
// referenceTargetId selects eligible reference/thumbnail images; an empty ID denotes an unsaved character.
// Pair it with the same targetId to restrict candidates to that character folder.
export type CharacterBrowseQuery = { seriesId: string; targetId: string | null; groupId?: string | null; referenceTargetId?: string; after: string | null; limit: number; all: boolean };
export type CharacterBrowsePage = { items: AssetSummary[]; nextCursor: string | null; totalCount: number };
export type CharacterSeriesSuggestion = { asset: AssetSummary; seriesId: string; seriesName: string; targetId: string; targetName: string; targetCount: number; matchedReferences: number };
export type CharacterSeriesSuggestionPage = { items: CharacterSeriesSuggestion[]; unscannedCount: number; pendingCount: number };
export type MixedFolderTargetCount = { targetId: string; count: number };
export type MixedFolderPreview = {
  folderId: string; folderName: string; seriesId: string; seriesName: string;
  totalCount: number; imageCount: number; otherMediaCount: number; childFolderCount: number; assetFingerprint: string;
  unscannedCount: number; pendingCount: number; resolvedCount: number; reviewCount: number; failedCount: number;
  targetCounts: MixedFolderTargetCount[]; groupedTargetIds: string[];
};
export type QueueMixedFolderRequest = { folderId: string; seriesId: string; expectedTotalCount: number; expectedImageCount: number; expectedAssetFingerprint: string };
export type FinalizeMixedFolderRequest = QueueMixedFolderRequest & { groupName: string; targetIds: string[] };
export type FinalizeMixedFolderResult = { seriesId: string; groupId: string; movedImageCount: number; retainedAssetCount: number; folderRemoved: boolean };
export type ManualCharacterRequest = { seriesId: string; displayName: string; assetIds: string[] };
export type SeriesAssetExclusionRequest = { seriesId: string; assetIds: string[]; excluded: boolean };
export const characterHubApi = {
  series: (): Promise<CharacterSeries[]> => invoke("character_series"),
  groups: async (seriesId: string): Promise<CharacterGroup[]> => (await invoke<Omit<CharacterGroup, "seriesId">[]>("character_groups", { seriesId })).map(group => ({ ...group, seriesId })),
  saveSeries: (request: CharacterSeries): Promise<CharacterSeries> => invoke("save_character_series", { request }),
  browse: (query: CharacterBrowseQuery): Promise<CharacterBrowsePage> => invoke("browse_character_assets", { query }),
  suggestions: (rootId: string, limit = 100): Promise<CharacterSeriesSuggestionPage> => invoke("character_series_suggestions", { rootId, limit }),
  queueDiscovery: (rootId: string): Promise<number> => invoke("queue_character_series_discovery", { rootId }),
  dismissSuggestion: (rootId: string, assetId: string, seriesId: string): Promise<void> => invoke("dismiss_character_series_suggestion", { rootId, assetId, seriesId }),
  acceptSuggestion: (rootId: string, assetId: string, seriesId: string): Promise<void> => invoke("accept_character_series_suggestion", { rootId, assetId, seriesId }),
  mixedFolderPreview: (folderId: string): Promise<MixedFolderPreview> => invoke("mixed_character_folder_preview", { folderId }),
  queueMixedFolder: (request: QueueMixedFolderRequest): Promise<number> => invoke("queue_mixed_character_folder", { request }),
  finalizeMixedFolder: (request: FinalizeMixedFolderRequest): Promise<FinalizeMixedFolderResult> => invoke("finalize_mixed_character_folder", { request }),
  createManualCharacter: (request: ManualCharacterRequest): Promise<import("./api").CharacterTarget> => invoke("create_manual_character", { request }),
  setSeriesAssetExcluded: (request: SeriesAssetExclusionRequest): Promise<number> => invoke("set_character_series_asset_excluded", { request }),
  excludedAssets: (seriesId: string, after: string | null, limit = 100): Promise<CharacterBrowsePage> => invoke("character_series_excluded_assets", { seriesId, after, limit }),
};
export type CharacterHubApi = Pick<typeof characterHubApi, "series" | "saveSeries" | "browse" | "createManualCharacter" | "setSeriesAssetExcluded" | "excludedAssets">;
export type CharacterSuggestionApi = Pick<typeof characterHubApi, "suggestions" | "queueDiscovery" | "dismissSuggestion" | "acceptSuggestion">;
export type CharacterFolderMigrationApi = Pick<typeof characterHubApi, "mixedFolderPreview" | "queueMixedFolder" | "finalizeMixedFolder">;
