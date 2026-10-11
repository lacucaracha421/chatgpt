import { invoke } from "@tauri-apps/api/core";
import { characterApi, moveTaggerReviewAssetsToCharacter, type CharacterApi, type ReviewRow, type TaggerReviewEvidence } from "./api";
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

export type TaggerDecisionApi = Pick<CharacterApi, "decide" | "decideBatch"> & {
  /** `learning: false` moves with a membership-only decision (맞음 · 영역 틀림). */
  move(targetId: string, expectedFingerprint: string, assetIds: string[], learning?: boolean): Promise<number>;
  classifications(assetId: string): Promise<string[]>;
};

export const taggerDecisionApi: TaggerDecisionApi = {
  decide: (request) => characterApi.decide(request),
  decideBatch: (requests) => characterApi.decideBatch(requests),
  move: moveTaggerReviewAssetsToCharacter,
  classifications: (assetId) => libraryGateway.getAssetClassifications(assetId),
};

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
