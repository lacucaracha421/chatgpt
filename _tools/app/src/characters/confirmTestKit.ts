import { vi } from "vitest";
import type { ConfirmKindCounts, ConfirmSources } from "./confirmClient";
import { emptyShadowSummary, type ShadowReviewItem } from "./shadowReviewApi";

/** A 확인 source for tests: nothing waits unless a test says so. Every read is a spy. */
export function confirmSourceFor(overrides: Partial<{ counts: Partial<ConfirmKindCounts>; tagger: ConfirmSources["tagger"]; candidates: ShadowReviewItem[]; doubtful: ShadowReviewItem[] }> = {}) {
  const counts = { recognition: 0, tag: 0, recheck: 0, ...overrides.counts };
  const page = vi.fn(async (query: { offset: number; limit: number; mode?: string }) => {
    const items = (query.mode === "doubtful" ? overrides.doubtful : overrides.candidates) ?? [];
    const summary = emptyShadowSummary();
    return { items: items.slice(query.offset, query.offset + query.limit), nextOffset: query.offset + query.limit < items.length ? query.offset + query.limit : null, policyVersion: null, summary };
  });
  return {
    tagger: vi.fn(overrides.tagger ?? (async () => [])),
    counts: vi.fn(async (_seriesId?: string) => counts),
    shadow: { page },
  } satisfies ConfirmSources;
}

export const shadowItem = (assetId: string, targetId: string, targetName: string, extra: Partial<ShadowReviewItem> = {}): ShadowReviewItem => ({
  assetId, contentHash: `hash-${assetId}`, originalName: `${assetId}.png`, width: 10, height: 10, targetId, targetName, targetFingerprint: `fp-${targetId}`,
  referenceAssetIds: [], verdict: "automatic", origin: "live", knn3: null, nativeOutcome: "none", scoredAt: "2026-10-11T00:00:00Z", ...extra,
});
