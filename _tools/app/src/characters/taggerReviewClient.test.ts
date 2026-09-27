import { expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import type { CharacterTarget, ReviewPage } from "./api";
import { taggerReviewSource } from "./taggerReviewClient";

const asset = (id: string): AssetSummary => ({ id, originalName: `${id}.png`, title: null, byteSize: 1, width: 10, height: 10,
  collectedAt: "2026-09-27T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null,
  creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } as never });

it("reads tagger pairs through the recommended review filter and ignores ordinary predictions", async () => {
  const page = (id: string, reason: "recommendation" | "veto", nextCursor: string | null): ReviewPage => ({
    rows: [{ asset: asset(id), predictions: [
      { targetId: "char", targetName: "라라", targetFingerprint: "fp", scanId: null, runtimeFingerprint: null, state: "recommended", decision: null,
        evidence: { source: "tagger", reason, pixaiScore: .9, canaryScore: .91 }, error: null },
      { targetId: "other", targetName: "마리", targetFingerprint: "fp2", scanId: "scan", runtimeFingerprint: "runtime", state: "recommended", decision: null,
        evidence: { distance: .1, bestQueryCrop: 0, queryBoxes: [], wholeFallback: false, evidence: [] }, error: null },
    ] }],
    nextCursor,
  });
  const review = vi.fn().mockResolvedValueOnce(page("a1", "recommendation", "a1")).mockResolvedValueOnce(page("a2", "veto", null));
  const targets = [{ id: "char", seriesClassificationId: "series" }, { id: "other", seriesClassificationId: "series" }] as CharacterTarget[];
  const progress = vi.fn();
  const items = await taggerReviewSource({ review }, targets)(progress, () => true);

  expect(review.mock.calls.map(([query]) => query)).toEqual([
    { seriesId: "series", targetId: null, filter: "recommended", after: null, limit: 80 },
    { seriesId: "series", targetId: null, filter: "recommended", after: "a1", limit: 80 },
  ]);
  expect(items?.map((item) => [item.asset.id, item.evidence.reason])).toEqual([["a1", "recommendation"], ["a2", "veto"]]);
  expect(progress).toHaveBeenLastCalledWith({ read: 2, seriesDone: 1, seriesTotal: 1 });
});
