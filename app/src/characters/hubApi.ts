import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
export type CharacterSeries = { classificationId: string; heroAssetId: string | null; autoClassify: boolean };
// referenceTargetId selects eligible reference/thumbnail images; an empty ID denotes an unsaved character.
// Pair it with the same targetId to restrict candidates to that character folder.
export type CharacterBrowseQuery = { seriesId: string; targetId: string | null; referenceTargetId?: string; after: string | null; limit: number; all: boolean };
export type CharacterBrowsePage = { items: AssetSummary[]; nextCursor: string | null; totalCount: number };
export type CharacterSeriesSuggestion = { asset: AssetSummary; seriesId: string; seriesName: string; targetId: string; targetName: string; targetCount: number; matchedReferences: number };
export type CharacterSeriesSuggestionPage = { items: CharacterSeriesSuggestion[]; unscannedCount: number; pendingCount: number };
export const characterHubApi = {
  series: (): Promise<CharacterSeries[]> => invoke("character_series"),
  saveSeries: (request: CharacterSeries): Promise<CharacterSeries> => invoke("save_character_series", { request }),
  browse: (query: CharacterBrowseQuery): Promise<CharacterBrowsePage> => invoke("browse_character_assets", { query }),
  suggestions: (rootId: string, limit = 100): Promise<CharacterSeriesSuggestionPage> => invoke("character_series_suggestions", { rootId, limit }),
  queueDiscovery: (rootId: string): Promise<number> => invoke("queue_character_series_discovery", { rootId }),
  dismissSuggestion: (rootId: string, assetId: string, seriesId: string): Promise<void> => invoke("dismiss_character_series_suggestion", { rootId, assetId, seriesId }),
  acceptSuggestion: (rootId: string, assetId: string, seriesId: string): Promise<void> => invoke("accept_character_series_suggestion", { rootId, assetId, seriesId }),
};
export type CharacterHubApi = Pick<typeof characterHubApi, "series" | "saveSeries" | "browse">;
export type CharacterSuggestionApi = Pick<typeof characterHubApi, "suggestions" | "queueDiscovery" | "dismissSuggestion" | "acceptSuggestion">;
