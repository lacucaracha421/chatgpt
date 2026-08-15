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

  it("updates editable source metadata through one request payload", async () => {
    const request = {
      assetId: "asset-1",
      sourcePublishedAt: "2026-08-01T10:20:30Z",
      creatorName: "Example Artist",
      creatorHandle: "example",
      creatorUrl: "https://x.com/example",
    };

    await libraryGateway.updateAssetMetadata(request);

    expect(invoke).toHaveBeenCalledWith("update_asset_metadata", { request });
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

describe("libraryGateway album contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses album and single-folder commands with camelCase payloads", async () => {
    await libraryGateway.createAlbum({ name: "표지", parentId: null });
    await libraryGateway.patchAssetAlbums({
      assetIds: ["asset-1"],
      addAlbumIds: ["album-1"],
      removeAlbumIds: [],
    });
    await libraryGateway.setAssetClassification({
      assetIds: ["asset-1"],
      classificationId: "folder-1",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "create_album", {
      request: { name: "표지", parentId: null },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "patch_asset_albums", {
      patch: {
        assetIds: ["asset-1"],
        addAlbumIds: ["album-1"],
        removeAlbumIds: [],
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "set_asset_classification", {
      request: { assetIds: ["asset-1"], classificationId: "folder-1" },
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
      importSource: "direct" as const,
      importBatchId: "00000000-0000-4000-8000-000000000006",
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
