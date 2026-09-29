import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, CollectionSummary, LibraryGateway } from "../library/types";
import { AssetInfoPanel } from "./AssetInfoPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("orders information sections and formats timestamps in the app date style", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 1, 12));
  const publishedAt = new Date(2026, 8, 29, 7, 20).toISOString();
  const collectedAt = new Date(2026, 8, 29, 8, 10).toISOString();
  const selected = asset("a", publishedAt, collectedAt);
  const sibling = asset("b", publishedAt, collectedAt);
  const gateway = {
    listSourceGroupAssets: vi.fn().mockResolvedValue([selected, sibling]),
    getAssetClassifications: vi.fn().mockResolvedValue(["child"]),
    updateAssetMetadata: vi.fn(),
  } as unknown as LibraryGateway;
  const collection = {
    id: "collection", name: "모음", description: null, type: "game", assetCount: 1,
    coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null,
    unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null,
    publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null,
    externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null,
    createdAt: publishedAt, updatedAt: publishedAt,
  } satisfies CollectionSummary;
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <AssetInfoPanel
        assets={[selected]}
        classifications={[
          { id: "root", name: "게임", kind: "root", parentId: null, iconKey: null, colorKey: null },
          { id: "child", name: "니케", kind: "tag", parentId: "root", iconKey: null, colorKey: null },
        ]}
        currentCollection={collection}
      />
    </LibraryProvider>,
  );

  await waitFor(() => expect(screen.getByRole("region", { name: "같은 게시물" })).toBeVisible());
  expect([...container.querySelectorAll<HTMLElement>("[data-info-section]")].map((node) => node.dataset.infoSection)).toEqual([
    "artist", "same-post", "tags", "source", "file", "collection",
  ]);
  expect(screen.getByText("9.29 07:20")).toBeVisible();
  expect(screen.getByText("9.29 08:10")).toBeVisible();
  expect(screen.queryByText(/AM|PM|2026\. 9\. 29/)).not.toBeInTheDocument();
  expect(screen.getByText("게임 › 니케")).toBeVisible();
});

function asset(id: string, sourcePublishedAt: string, collectedAt: string): AssetSummary {
  return {
    id, title: null, originalName: `${id}.png`, byteSize: 1024, width: 200, height: 100,
    collectedAt, favorite: false, sourceUrl: `https://example.com/post/${id}`, sourcePublishedAt,
    creatorName: "Example Artist", creatorHandle: "example", creatorUrl: "https://x.com/example",
    importSource: "browser_extension", importBatchId: null, originalModifiedAt: null, media: { kind: "image" },
  };
}

