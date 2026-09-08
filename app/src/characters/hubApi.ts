import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
export type CharacterSeries = { classificationId: string; heroAssetId: string | null; autoClassify: boolean };
export type CharacterBrowseQuery = { seriesId: string; targetId: string | null; referenceTargetId?: string; after: string | null; limit: number; all: boolean };
export type CharacterBrowsePage = { items: AssetSummary[]; nextCursor: string | null; totalCount: number };
export const characterHubApi = {
  series: (): Promise<CharacterSeries[]> => invoke("character_series"),
  saveSeries: (request: CharacterSeries): Promise<CharacterSeries> => invoke("save_character_series", { request }),
  browse: (query: CharacterBrowseQuery): Promise<CharacterBrowsePage> => invoke("browse_character_assets", { query }),
};
export type CharacterHubApi = typeof characterHubApi;
