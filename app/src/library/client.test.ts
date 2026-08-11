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

  it("does not expose superseded single-item commands", () => {
    expect(libraryGateway).not.toHaveProperty("currentLibrary");
    expect(libraryGateway).not.toHaveProperty("trashAsset");
    expect(libraryGateway).not.toHaveProperty("setAssetClassifications");
  });
});

describe("libraryGateway classification appearance contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses the appearance command with camelCase payloads", async () => {
    await libraryGateway.updateClassificationAppearance(
      "folder-1",
      "photo",
      "pink",
    );

    expect(invoke).toHaveBeenCalledWith("update_classification_appearance", {
      id: "folder-1",
      iconKey: "photo",
      colorKey: "pink",
    });
  });
});

describe("libraryGateway video contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses the media ingest and video preparation commands", async () => {
    const request = {
      sourcePath: "C:\\input\\clip.webm",
      classificationId: "work-1",
      sourceUrl: "https://example.test/post",
    };

    await libraryGateway.ingestMedia(request);
    await libraryGateway.preparePendingVideos(1);
    await libraryGateway.retryVideoPreparation("video-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "ingest_media", { request });
    expect(invoke).toHaveBeenNthCalledWith(2, "prepare_pending_videos", {
      limit: 1,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "retry_video_preparation", {
      assetId: "video-1",
    });
  });
});
