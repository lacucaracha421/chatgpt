import { describe, expect, it } from "vitest";
import type { AssetSummary } from "../library/types";
import { shareAssetSummaries } from "./shareAssetSummaries";

const asset: AssetSummary = {
  id: "one", title: null, originalName: "one.png", byteSize: 100, width: 200, height: 300,
  collectedAt: "2026-09-01T00:00:00Z", favorite: false, sourceUrl: null,
  sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null,
  importSource: null, importBatchId: null, originalModifiedAt: null,
  media: { kind: "image" }, thumbnailRevision: "r1",
};

describe("shareAssetSummaries", () => {
  it("reuses the array for an equal serialized response, including video media", () => {
    const previous: AssetSummary[] = [asset, { ...asset, id: "video", media: {
      kind: "video", durationMs: 10_000, preparationState: "ready", scrubFrameCount: 12,
    } }];
    expect(shareAssetSummaries(previous, structuredClone(previous))).toBe(previous);
    expect(shareAssetSummaries([], [])).toEqual([]);
  });

  it("keeps references by ID through reorder, insertion and removal without mutating input", () => {
    const second = { ...asset, id: "two" };
    const added = { ...asset, id: "three" };
    const previous = [asset, second];
    const incoming = [structuredClone(second), added, structuredClone(asset)];
    const result = shareAssetSummaries(previous, incoming);
    expect(result).toEqual(incoming);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(added);
    expect(result[2]).toBe(asset);
    expect(incoming[0]).not.toBe(second);
    expect(previous).toEqual([asset, second]);
    expect(shareAssetSummaries(previous, [structuredClone(second)])[0]).toBe(second);
    expect(shareAssetSummaries(previous, [])).toEqual([]);
  });

  it.each(Object.keys(asset).filter(key => key !== "id" && key !== "media"))(
    "does not hide a change to %s", key => {
      const value = asset[key as keyof AssetSummary];
      const fresh = { ...structuredClone(asset), [key]: typeof value === "number" ? value + 1
        : typeof value === "boolean" ? !value : "changed" };
      const untouched = { ...asset, id: "two" };
      const result = shareAssetSummaries([asset, untouched], [fresh, structuredClone(untouched)]);
      expect(result[0]).toBe(fresh);
      expect(result[1]).toBe(untouched);
    },
  );

  it.each([
    { kind: "gif" },
    { kind: "video", durationMs: 20_000, preparationState: "ready", scrubFrameCount: 12 },
    { kind: "video", durationMs: 10_000, preparationState: "failed", scrubFrameCount: 12 },
    { kind: "video", durationMs: 10_000, preparationState: "ready", scrubFrameCount: 24 },
  ] satisfies AssetSummary["media"][])("retains changed media %j", media => {
    const previous: AssetSummary = { ...asset, media: {
      kind: "video", durationMs: 10_000, preparationState: "ready", scrubFrameCount: 12,
    } };
    const fresh = { ...previous, media };
    expect(shareAssetSummaries([previous], [fresh])[0]).toBe(fresh);
  });

  it("detects removal of an optional thumbnail revision", () => {
    const { thumbnailRevision: _revision, ...fresh } = asset;
    expect(shareAssetSummaries([asset], [fresh])[0]).toBe(fresh);
  });
});
