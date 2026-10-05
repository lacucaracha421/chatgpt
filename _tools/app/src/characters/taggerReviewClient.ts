import { invoke } from "@tauri-apps/api/core";
import { characterApi, moveAssetsToCharacter, type CharacterApi, type CharacterTarget, type ReviewRow, type TaggerReviewEvidence } from "./api";
import { libraryGateway } from "../library/client";
import type { ClassificationEntry } from "../library/types";

export type TaggerReviewTargetCount = {
  targetId: string;
  targetName: string;
  seriesId: string;
  seriesName: string;
  count: number;
  sampleAssetIds: string[];
};
export type TaggerReviewSummary = {
  /** Pair count, not distinct image count. Samples are capped at 20. */
  count: number;
  targets: TaggerReviewTargetCount[];
  series: { seriesId: string; seriesName: string; count: number }[];
  sampleAssetIds: string[];
};
export type TaggerReviewPreview = {
  previewToken: string;
  veto: TaggerReviewSummary;
  /** Veto pairs skipped: 참조로 쓰는 이미지라 건너뜀. */
  skippedReferences: TaggerReviewSummary;
  recommend: TaggerReviewSummary;
};
/** Existing character_review_page predictions expose this as their evidence.
 * Use direct manual decisions (no scanId/baselineFingerprint). Outside-series
 * acceptance requires the explicit move_assets_to_character action.
 */
export type { TaggerReviewEvidence } from "./api";

export type TaggerReviewItem = {
  asset: ReviewRow["asset"];
  seriesId: string;
  targetId: string;
  targetName: string;
  targetFingerprint: string;
  evidence: TaggerReviewEvidence;
  crop?: { box: [number, number, number, number]; distance: number } | null;
};

export type TaggerReviewCounts = { recommendation: number; veto: number };
export type TaggerReviewProgress = { read: number; seriesDone: number; seriesTotal: number };
export type TaggerReviewSource = (
  onProgress: (progress: TaggerReviewProgress) => void,
  isLive: () => boolean,
) => Promise<TaggerReviewItem[] | null>;

export type TaggerDecisionApi = Pick<CharacterApi, "decide" | "decideBatch"> & {
  /** `learning: false` moves with a membership-only decision (맞음 · 영역 틀림). */
  move(targetId: string, expectedFingerprint: string, assetIds: string[], learning?: boolean): Promise<number>;
  classifications(assetId: string): Promise<string[]>;
};

export const taggerDecisionApi: TaggerDecisionApi = {
  decide: (request) => characterApi.decide(request),
  decideBatch: (requests) => characterApi.decideBatch(requests),
  move: moveAssetsToCharacter,
  classifications: (assetId) => libraryGateway.getAssetClassifications(assetId),
};

export const isTaggerEvidence = (evidence: unknown): evidence is TaggerReviewEvidence => {
  if (!evidence || typeof evidence !== "object") return false;
  const value = evidence as Partial<TaggerReviewEvidence>;
  return value.source === "tagger"
    && (value.reason === "recommendation" || value.reason === "veto")
    && typeof value.pixaiScore === "number"
    && typeof value.canaryScore === "number";
};

export const taggerItemKey = (item: Pick<TaggerReviewItem, "targetId" | "asset">) => `${item.targetId}\u0000${item.asset.id}`;

export function taggerCounts(items: readonly TaggerReviewItem[]): TaggerReviewCounts {
  return items.reduce((counts, item) => ({ ...counts, [item.evidence.reason]: counts[item.evidence.reason] + 1 }), { recommendation: 0, veto: 0 });
}

/** Reads the complete pending tagger projection with one native call. */
export function taggerReviewSource(_api: Pick<CharacterApi, "review">, targets: readonly CharacterTarget[]): TaggerReviewSource {
  const seriesIds = [...new Set(targets.flatMap((target) => target.seriesClassificationId ? [target.seriesClassificationId] : []))];
  return async (onProgress, isLive) => {
    if (!isLive()) return null;
    const items = await invoke<TaggerReviewItem[]>("tagger_review_items");
    if (!isLive()) return null;
    onProgress({ read: items.length, seriesDone: seriesIds.length, seriesTotal: seriesIds.length });
    return items;
  };
}

export function classificationIsInSeries(classificationIds: readonly string[], seriesId: string, entries: readonly ClassificationEntry[]): boolean {
  const parents = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  return classificationIds.some((id) => {
    const visited = new Set<string>();
    let current: string | null | undefined = id;
    while (current && !visited.has(current)) {
      if (current === seriesId) return true;
      visited.add(current);
      current = parents.get(current);
    }
    return false;
  });
}

export const previewTaggerReview = () =>
  invoke<TaggerReviewPreview>("preview_tagger_review");

/** On character_stale, show a new preview and require the user's apply action again.
 * Returns the counts actually applied. Refresh review lists/memberships after success.
 */
export const applyTaggerReview = (expectedPreviewToken: string) =>
  invoke<TaggerReviewPreview>("apply_tagger_review", { expectedPreviewToken });
