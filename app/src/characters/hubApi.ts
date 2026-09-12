import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
export type CharacterSeries = { classificationId: string; heroAssetId: string | null; autoClassify: boolean };
export type CharacterGroup = { id: string; seriesId: string; name: string; revision: number; targetIds: string[] };
// referenceTargetId selects eligible reference/thumbnail images; an empty ID denotes an unsaved character.
// Pair it with the same targetId to restrict candidates to that character folder.
export type SeriesGalleryFilter = "unclassified" | "needs_review" | "all";
export type CharacterBrowseQuery = { seriesId: string; targetId: string | null; groupId?: string | null; referenceTargetId?: string; seriesFilter?: SeriesGalleryFilter; after: string | null; limit: number; all: boolean };
export type CharacterBrowsePage = { items: AssetSummary[]; nextCursor: string | null; totalCount: number };
export type ManualCharacterRequest = { seriesId: string; displayName: string; assetIds: string[] };
export type SeriesAssetExclusionRequest = { seriesId: string; assetIds: string[]; excluded: boolean };
export type CharacterReviewCompletionRequest = { seriesId: string; assetIds: string[] };
export type ReferenceConfirmationMode = "initialize" | "add_learned";
export type ReferenceCandidateSet = {
  targetId: string; targetRevision: number; referenceSetHash: string; confirmationMode: ReferenceConfirmationMode;
  minimumSelection: number; items: AssetSummary[]; suggestedAssetIds: string[];
};
export type ConfirmReferenceBatch = {
  targetId: string; expectedRevision: number; expectedReferenceSetHash: string;
  confirmationMode: ReferenceConfirmationMode; assetIds: string[];
};
export type ReferenceRefreshReceipt = {
  targetId: string; requestRevision: number; state: "pending" | "running" | "failed" | "completed"; eligibleCount: number;
};
export const characterHubApi = {
  series: (): Promise<CharacterSeries[]> => invoke("character_series"),
  groups: async (seriesId: string): Promise<CharacterGroup[]> => (await invoke<Omit<CharacterGroup, "seriesId">[]>("character_groups", { seriesId })).map(group => ({ ...group, seriesId })),
  saveSeries: (request: CharacterSeries): Promise<CharacterSeries> => invoke("save_character_series", { request }),
  browse: (query: CharacterBrowseQuery): Promise<CharacterBrowsePage> => invoke("browse_character_assets", { query }),
  createManualCharacter: (request: ManualCharacterRequest): Promise<import("./api").CharacterTarget> => invoke("create_manual_character", { request }),
  completeReview: (request: CharacterReviewCompletionRequest): Promise<number> => invoke("complete_character_review", { request }),
  setSeriesAssetExcluded: (request: SeriesAssetExclusionRequest): Promise<number> => invoke("set_character_series_asset_excluded", { request }),
  excludedAssets: (seriesId: string, after: string | null, limit = 100): Promise<CharacterBrowsePage> => invoke("character_series_excluded_assets", { seriesId, after, limit }),
  referenceCandidates: (targetId: string, limit = 20): Promise<ReferenceCandidateSet> => invoke("reference_candidates", { targetId, limit }),
  confirmReferenceBatch: (request: ConfirmReferenceBatch): Promise<import("./api").CharacterTarget> => invoke("confirm_reference_batch", { request }),
  requestReferenceRefresh: (targetId: string, expectedRevision: number): Promise<ReferenceRefreshReceipt> => invoke("request_character_reference_refresh", { targetId, expectedRevision }),
};
export type CharacterHubApi = Pick<typeof characterHubApi, "series" | "saveSeries" | "browse" | "createManualCharacter" | "completeReview" | "setSeriesAssetExcluded" | "excludedAssets" | "referenceCandidates" | "confirmReferenceBatch" | "requestReferenceRefresh">;
export type ReferenceCandidateApi = Pick<typeof characterHubApi, "referenceCandidates" | "confirmReferenceBatch">;
