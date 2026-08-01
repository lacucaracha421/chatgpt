import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetPage, AssetSort, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetBrowser } from "./AssetBrowser";

const classifications: ClassificationEntry[] = [];

afterEach(cleanup);
beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 },
  clientWidth: { configurable: true, get: () => 840 },
  offsetHeight: { configurable: true, get: () => 600 },
  clientHeight: { configurable: true, get: () => 600 },
}));

describe("AssetBrowser", () => {
  it.each<[string, AssetView, AssetSort, Partial<Record<string, unknown>>]>([
    ["classification", { kind: "classification", classificationId: "tag" }, "oldest", { classificationId: "tag", directOnly: false, favoriteOnly: false, sort: "oldest" }],
    ["favorites", { kind: "favorites" }, "favorites", { classificationId: null, directOnly: false, favoriteOnly: true, sort: "favorites" }],
    ["recent", { kind: "recent" }, "oldest", { classificationId: null, directOnly: false, favoriteOnly: false, sort: "newest" }],
  ])("maps the %s view to its first-page query", async (_name, view, sort, expected) => {
    const gateway = createGateway();

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={view}
          classifications={classifications}
          sort={sort}
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() =>
      expect(gateway.listAssets).toHaveBeenCalledWith({
        ...expected,
        randomPivot: null,
        after: null,
        limit: 100,
      }),
    );
  });

  it("uses one random pivot for first and next pages", async () => {
    const gateway = createGateway({
      items: Array.from({ length: 50 }, (_, index) => asset(index)),
      nextCursor: { token: "next" },
    });

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="random"
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    const [first, next] = vi.mocked(gateway.listAssets).mock.calls;
    expect(first![0].randomPivot).toMatch(/^[\da-f]{32}$/);
    expect(next![0].randomPivot).toBe(first![0].randomPivot);
  });

  it("retains assets and offers a retry when the next page fails", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => asset(index)), nextCursor: { token: "next" } })
      .mockRejectedValueOnce(new Error("next page failed"));

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="newest"
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

function asset(index: number) {
  return {
    id: `asset-${index}`,
    title: null,
    originalName: `asset-${index}.png`,
    relativePath: `assets/asset-${index}.png`,
    thumbnailRelativePath: `thumbnails/asset-${index}.webp`,
    byteSize: 1,
    width: 200,
    height: 200,
    collectedAt: "2026-07-30T00:00:00Z",
    favorite: false,
    sourceUrl: null,
  };
}

function createGateway(page: AssetPage = { items: [], nextCursor: null }): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn().mockResolvedValue(page),
    setAssetFavorite: vi.fn(), setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(), ingestImage: vi.fn(),
  };
}
