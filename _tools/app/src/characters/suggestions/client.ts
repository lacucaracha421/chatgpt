import { invoke } from "@tauri-apps/api/core";
import { characterApi, type CharacterTarget } from "../api";
import { characterHubApi, type CharacterGroup } from "../hubApi";
import { libraryGateway } from "../../library/client";
import type { ClassificationEntry } from "../../library/types";
import dictionary from "./suggest-ko.json";

export const CHARACTER_SUGGESTIONS_CHANGED_EVENT = "lakomics-character-suggestions-changed";

export type Suggestion = {
  tag: string; imageCount: number; bothCount: number; pixaiCount: number; canaryCount: number;
  sampleAssetIds: string[]; seriesId: string | null; seriesName: string | null; insideCount: number;
  /** Current thumbnail revisions of the samples by id (absent: no thumbnail), for cacheable URLs. */
  sampleThumbnailRevisions?: Record<string, string>;
};
export type SuggestionImage = { assetId: string; assetHash: string; pixaiScore: number; canaryScore: number; insideSeries: boolean; solo: boolean };
export type SuggestionDetail = { images: SuggestionImage[]; previewToken: string; referenceIds: string[] };
export type IgnoredTag = { tag: string; ignoredAt: string };
export type SuggestionResult = { target: CharacterTarget; queuedCount: number };
export type RegisterSuggestion = {
  tag: string; seriesId: string; displayName: string; previewToken: string; referenceIds: string[];
  excludedAssetIds: string[]; includeOutside: boolean; linkTag: boolean;
  groupId: string | null; expectedGroupRevision: number | null;
};
export type MergeSuggestion = { tag: string; targetId: string; expectedFingerprint: string; previewToken: string; linkTag: boolean };
export type SuggestionContext = { targets: CharacterTarget[]; folders: ClassificationEntry[] };
export type SuggestionApi = {
  list(minimum: number): Promise<Suggestion[]>;
  detail(tag: string, seriesId: string | null): Promise<SuggestionDetail>;
  ignored(): Promise<IgnoredTag[]>;
  ignore(tag: string, ignored: boolean): Promise<void>;
  register(request: RegisterSuggestion): Promise<SuggestionResult>;
  merge(request: MergeSuggestion): Promise<SuggestionResult>;
  context(): Promise<SuggestionContext>;
  groups(seriesId: string): Promise<CharacterGroup[]>;
};
async function mutation(command: string, request: RegisterSuggestion | MergeSuggestion): Promise<SuggestionResult> {
  const result = await invoke<SuggestionResult>(command, { request });
  window.dispatchEvent(new Event(CHARACTER_SUGGESTIONS_CHANGED_EVENT));
  return result;
}
export const suggestionApi: SuggestionApi = {
  list: minimum => invoke("character_suggestions", { minimum }),
  detail: (tag, seriesId) => invoke("character_suggestion_detail", { tag, seriesId }),
  ignored: () => invoke("ignored_character_suggestions"),
  ignore: (tag, ignored) => invoke("set_character_suggestion_ignored", { tag, ignored }),
  register: request => mutation("register_character_suggestion", request),
  merge: request => mutation("merge_character_suggestion", request),
  context: async () => {
    const [targets, folders] = await Promise.all([characterApi.targets(), libraryGateway.listClassifications()]);
    return { targets, folders };
  },
  groups: seriesId => characterHubApi.groups(seriesId),
};
const names: Record<string, { ko: string; source: string; confidence: string }> = dictionary;
export const suggestionName = (tag: string) => names[tag]?.ko ?? tag.replace(/_/g, " ");
export function folderPath(id: string, folders: readonly ClassificationEntry[]): string {
  const parts: string[] = [], visited = new Set<string>();
  let current = folders.find(folder => folder.id === id);
  while (current && !visited.has(current.id)) {
    visited.add(current.id); parts.unshift(current.name);
    current = folders.find(folder => folder.id === current?.parentId);
  }
  return parts.join(" › ") || id;
}
