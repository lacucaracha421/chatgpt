import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
import type { CharacterTarget } from "./api";
import { taggerReviewSource, type TaggerReviewItem } from "./taggerReviewClient";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => vi.mocked(invoke).mockReset());

const asset = (id: string): AssetSummary => ({ id, originalName: `${id}.png`, title: null, byteSize: 1, width: 10, height: 10,
  collectedAt: "2026-09-27T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null,
  creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } as never });

it("reads the complete tagger projection with one native call", async () => {
  const projection: TaggerReviewItem[] = [
    { asset: asset("a1"), seriesId: "series", targetId: "char", targetName: "라라", targetFingerprint: "fp",
      evidence: { source: "tagger", reason: "recommendation", pixaiScore: .9, canaryScore: .91 } },
    { asset: asset("a2"), seriesId: "series", targetId: "char", targetName: "라라", targetFingerprint: "fp",
      evidence: { source: "tagger", reason: "veto", pixaiScore: .2, canaryScore: .21 } },
  ];
  const native = vi.mocked(invoke);
  native.mockResolvedValueOnce(projection);
  const review = vi.fn();
  const targets = [{ id: "char", seriesClassificationId: "series" }, { id: "other", seriesClassificationId: "series" }] as CharacterTarget[];
  const progress = vi.fn();
  const result = await taggerReviewSource({ review }, targets)(progress, () => true);

  expect(native).toHaveBeenCalledTimes(1);
  expect(native).toHaveBeenCalledWith("tagger_review_items");
  expect(review).not.toHaveBeenCalled();
  expect(result?.map((item) => [item.asset.id, item.evidence.reason])).toEqual([["a1", "recommendation"], ["a2", "veto"]]);
  expect(progress).toHaveBeenLastCalledWith({ read: 2, seriesDone: 1, seriesTotal: 1 });
});

it("does not publish a result when the source is no longer live", async () => {
  const native = vi.mocked(invoke);
  native.mockResolvedValueOnce([]);
  const progress = vi.fn();
  const result = await taggerReviewSource({ review: vi.fn() }, [{ id: "char", seriesClassificationId: "series" }] as CharacterTarget[])(progress, () => false);

  expect(result).toBeNull();
  expect(native).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});
