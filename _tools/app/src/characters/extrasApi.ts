import { invoke } from "@tauri-apps/api/core";
import type { CharacterTarget } from "./api";
import type { CharacterGroup } from "./hubApi";

/** A 기타 that exists. `name` is the internal name ("<group> 기타"); screens show just "기타". */
export type ExtrasEntry = { targetId: string; seriesId: string; groupId: string | null; name: string };

/** A name the automatic tags read on at least five images of one 기타 (a "캐릭터로" suggestion). */
export type ExtrasSuggestion = {
  tag: string;
  imageCount: number;
  /** Images both automatic taggers read (확실); the rest were read by one (불확실). */
  bothCount: number;
  pixaiCount: number;
  canaryCount: number;
  /** The 기타 images read under this tag, strongest reading first (pre-select these). */
  assetIds: string[];
};

export type PromoteExtrasRequest = {
  /** The 기타 the images come from, with its current fingerprint. */
  targetId: string;
  expectedFingerprint: string;
  displayName: string;
  /** 1~200 images that are in the 기타. */
  assetIds: string[];
  /** Defaults to the first normal image. */
  thumbnailAssetId?: string | null;
  /** The person's references (at most 25, among `assetIds`); omit to let the backend pick, single-person images first. */
  referenceAssetIds?: string[] | null;
  /** The automatic tag the images were read under; linked to the new character. */
  tag?: string | null;
};

export type PromoteExtrasResult = {
  target: CharacterTarget;
  movedCount: number;
  referenceCount: number;
  /** True: five or more references, recognition started. False: it starts as a manual character. */
  recognition: boolean;
};

export type ExtrasGroupResult = { group: CharacterGroup; extras: CharacterTarget };

export type SeriesUnregisterPreview = {
  seriesId: string;
  seriesName: string;
  /** The nearest registered ancestor series that receives the characters; null when there is none. */
  destinationId: string | null;
  destinationName: string | null;
  characterCount: number;
  groupCount: number;
  extrasImageCount: number;
  /** Names the destination already uses. */
  collisions: string[];
  /** Korean reason the series cannot be unregistered now (show it as is); null when it can. */
  refusal: string | null;
};

export type SeriesUnregisterResult = {
  seriesId: string;
  destinationId: string | null;
  movedCharacterCount: number;
  movedGroupCount: number;
};

export const characterExtrasApi = {
  /** Every 기타 that exists (the series' own and the groups'); create a missing one with `ensure`. */
  list: (): Promise<ExtrasEntry[]> => invoke("character_extras"),
  /** The 기타 of a series (no `groupId`) or of one of its groups, created on first use. */
  ensure: (seriesId: string, groupId: string | null = null): Promise<CharacterTarget> => invoke("ensure_character_extras", { seriesId, groupId }),
  /** A group that has only a 기타 (no real member yet). */
  createGroup: (seriesId: string, name: string): Promise<ExtrasGroupResult> => invoke("create_character_extras_group", { seriesId, name }),
  /** Promotion suggestions of one 기타: names read on five or more of its images. */
  suggestions: (targetId: string): Promise<ExtrasSuggestion[]> => invoke("character_extras_suggestions", { targetId }),
  /** "캐릭터로": one all-or-nothing step. No historical comparison is queued; offer "과거 미분류 이미지 갱신" afterwards. */
  promote: (request: PromoteExtrasRequest): Promise<PromoteExtrasResult> => invoke("promote_character_extras", { request }),
  /** What "시리즈 등록 해제" would do; `refusal` is ready-to-show Korean text when it cannot be done. */
  unregisterPreview: (seriesId: string): Promise<SeriesUnregisterPreview> => invoke("character_series_unregister_preview", { seriesId }),
  unregisterSeries: (seriesId: string): Promise<SeriesUnregisterResult> => invoke("unregister_character_series", { seriesId }),
};
