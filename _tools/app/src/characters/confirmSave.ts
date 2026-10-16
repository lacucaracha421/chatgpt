import { commandErrorMessage } from "../library/errorMessage";
import type { ClassificationEntry } from "../library/types";
import type { DecisionRequest, DecisionRequestKind } from "./api";
import type { ConfirmItem } from "./confirmModel";
import { classificationIsInSeries, type TaggerDecisionApi } from "./taggerReviewClient";

export type Decision = Extract<DecisionRequestKind, "accepted" | "rejected" | "accepted_wrong_region">;
/** `moved` judgments put the image into the character's series, which 되돌리기 cannot take back. Set once the move is stored. */
export type Judgment = { item: ConfirmItem; decision: Decision; moved: boolean };
export type SaveFailure = { judgment: Judgment; message: string };
export type SaveOutcome = { saved: Judgment[]; failed: SaveFailure[] };

export const BATCH_MAX = 200;

export const decisionRequest = (item: ConfirmItem, decision: DecisionRequestKind): DecisionRequest => ({
  targetId: item.targetId, expectedFingerprint: item.targetFingerprint, assetIds: [item.assetId], decision, baselineFingerprint: null, scanId: null,
});

/**
 * Stores judgments made in the one-at-a-time view, in the order they were made. A tag-listed image outside its series
 * that is judged 맞음 is looked up and moved in one by one; every other judgment is stored in batches, and a refused
 * batch is retried item by item to find which ones failed. Never throws: what could not be stored comes back in `failed`.
 */
export async function saveJudgments(api: TaggerDecisionApi, judgments: readonly Judgment[], classifications: readonly ClassificationEntry[]): Promise<SaveOutcome> {
  const saved: Judgment[] = [];
  const failed: SaveFailure[] = [];
  const fail = (judgment: Judgment, e: unknown) => failed.push({ judgment, message: commandErrorMessage(e, "판단을 저장하지 못했습니다.") });
  const plain: Judgment[] = [];
  for (const judgment of judgments) {
    const { item, decision } = judgment;
    if (decision !== "rejected" && item.fromTags) {
      try {
        const ids = await api.classifications(item.assetId);
        if (!classificationIsInSeries(ids, item.fromTags.seriesId, classifications)) {
          await api.move(item.targetId, item.targetFingerprint, [item.assetId], decision === "accepted");
          judgment.moved = true;
          saved.push(judgment);
          continue;
        }
      } catch (e) { fail(judgment, e); continue; }
    }
    plain.push(judgment);
  }
  for (let start = 0; start < plain.length; start += BATCH_MAX) {
    const chunk = plain.slice(start, start + BATCH_MAX);
    const storeOne = async (judgment: Judgment) => {
      try { await api.decide(decisionRequest(judgment.item, judgment.decision)); saved.push(judgment); }
      catch (e) { fail(judgment, e); }
    };
    if (chunk.length === 1) { await storeOne(chunk[0]!); continue; }
    try {
      await api.decideBatch(chunk.map(judgment => decisionRequest(judgment.item, judgment.decision)));
      saved.push(...chunk);
    } catch {
      for (const judgment of chunk) await storeOne(judgment);
    }
  }
  return { saved, failed };
}
