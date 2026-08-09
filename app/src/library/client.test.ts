import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { libraryGateway } from "./client";

describe("libraryGateway similarity contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses the exact Tauri command names and camelCase payloads", async () => {
    await libraryGateway.indexMissingSimilarityHashes();
    await libraryGateway.listSimilarityReviews({ after: null, limit: 20 });
    await libraryGateway.decideSimilarityReview({
      reviewId: "review-1",
      decision: "keep_both",
    });
    await libraryGateway.getAsset("asset-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "index_missing_similarity_hashes");
    expect(invoke).toHaveBeenNthCalledWith(2, "list_similarity_reviews", {
      after: null,
      limit: 20,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "decide_similarity_review", {
      request: { reviewId: "review-1", decision: "keep_both" },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "get_asset", {
      assetId: "asset-1",
    });
  });
});
