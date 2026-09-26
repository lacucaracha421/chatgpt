import { describe, expect, it } from "vitest";
import {
  assetThumbnailUrl,
  assetUrl,
  nativeMediaUrl,
  collectionCoverThumbnailUrl,
  collectionSourceThumbnailUrl,
  mangadexCoverPreviewUrl,
  playbackUrl,
  scrubFrameUrl,
  thumbnailUrl,
  workArtworkThumbnailUrl,
  workArtworkUrl,
} from "./mediaUrl";

describe("media URLs", () => {
  it("puts thumbnail cache revisions in the path", () => {
    expect(thumbnailUrl("asset-1", 7)).toBe("http://lakomics.localhost/thumbnail/asset-1/v7");
  });

  it("versions Asset thumbnails and scrub frames by content revision only when one exists", () => {
    expect(assetThumbnailUrl({ id: "asset-1", thumbnailRevision: "6343793473580718685" })).toBe(
      "http://lakomics.localhost/thumbnail/asset-1/v6343793473580718685",
    );
    expect(assetThumbnailUrl({ id: "asset-1", thumbnailRevision: null })).toBe("http://lakomics.localhost/thumbnail/asset-1");
    expect(assetThumbnailUrl({ id: "asset-1" })).toBe("http://lakomics.localhost/thumbnail/asset-1");
    expect(scrubFrameUrl("video-1", 3, "42")).toBe("http://lakomics.localhost/scrub-frame/video-1/3/v42");
    expect(scrubFrameUrl("video-1", 3, null)).toBe("http://lakomics.localhost/scrub-frame/video-1/3");
  });

  it("uses the Windows custom-protocol origin and ID-only paths", () => {
    const id = "00000000-0000-4000-8000-000000000001";

    expect(thumbnailUrl(id)).toBe(
      "http://lakomics.localhost/thumbnail/00000000-0000-4000-8000-000000000001",
    );
    expect(assetUrl(id)).toBe(
      "http://lakomics.localhost/asset/00000000-0000-4000-8000-000000000001",
    );
  });

  it("encodes the ID as one URL segment", () => {
    expect(thumbnailUrl("asset/with/slashes")).toBe(
      "http://lakomics.localhost/thumbnail/asset%2Fwith%2Fslashes",
    );
    expect(playbackUrl("a/b")).toBe(
      "http://lakomics.localhost/playback/a%2Fb",
    );
    expect(scrubFrameUrl("a/b", 12)).toBe(
      "http://lakomics.localhost/scrub-frame/a%2Fb/12",
    );
    expect(workArtworkUrl("art/one")).toBe(
      "http://lakomics.localhost/work-artwork/art%2Fone",
    );
    expect(workArtworkThumbnailUrl("art/one")).toBe(
      "http://lakomics.localhost/work-artwork-thumbnail/art%2Fone",
    );
    expect(mangadexCoverPreviewUrl("manga/one", "cover one.jpg")).toBe(
      "http://lakomics.localhost/mangadex-cover-preview/manga%2Fone/cover%20one.jpg",
    );
    expect(collectionSourceThumbnailUrl("collection/one")).toBe(
      "http://lakomics.localhost/collection-source-thumbnail/collection%2Fone",
    );
    expect(collectionCoverThumbnailUrl("collection/one", "cover one.png")).toBe(
      "http://lakomics.localhost/collection-cover-thumbnail/collection%2Fone/cover%20one.png",
    );
  });
});

it("uses the native Linux scheme without double-encoding IDs", async () => {
  const { mockConvertFileSrc, clearMocks } = await import("@tauri-apps/api/mocks");
  Object.defineProperty(window, "isTauri", { configurable: true, value: true });
  try {
    mockConvertFileSrc("linux");
    expect(assetUrl("a/b")).toBe("lakomics://localhost/asset/a%2Fb");
    expect(nativeMediaUrl("http://lakomics.localhost/remote-catalog-thumbnail/kHentai/42")).toBe("lakomics://localhost/remote-catalog-thumbnail/kHentai/42");
    expect(nativeMediaUrl("http://lakomics.localhost/asset/a%2Fb")).toBe("lakomics://localhost/asset/a%2Fb");
    expect(nativeMediaUrl("https://example.com/cover.jpg")).toBe("https://example.com/cover.jpg");
    expect(nativeMediaUrl("http://lakomics.localhost.example.com/cover.jpg")).toBe("http://lakomics.localhost.example.com/cover.jpg");
    mockConvertFileSrc("windows");
    expect(assetUrl("a/b")).toBe("http://lakomics.localhost/asset/a%2Fb");
    expect(nativeMediaUrl("http://lakomics.localhost/remote-catalog-thumbnail/kHentai/42")).toBe("http://lakomics.localhost/remote-catalog-thumbnail/kHentai/42");
  } finally {
    clearMocks();
    Reflect.deleteProperty(window, "isTauri");
  }
});
