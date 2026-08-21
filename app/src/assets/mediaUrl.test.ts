import { describe, expect, it } from "vitest";
import {
  assetUrl,
  mangadexCoverPreviewUrl,
  playbackUrl,
  scrubFrameUrl,
  thumbnailUrl,
  workArtworkThumbnailUrl,
  workArtworkUrl,
} from "./mediaUrl";

describe("media URLs", () => {
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
  });
});
