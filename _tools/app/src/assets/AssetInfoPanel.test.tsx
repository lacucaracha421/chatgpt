import { act, fireEvent, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, CollectionSummary, LibraryGateway } from "../library/types";
import { AssetInfoPanel } from "./AssetInfoPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([null, "Source creator"])("shows assigned artist before creator metadata (%s)", async (creatorName) => {
  const selected = {...asset("assigned", "2026-10-05T05:27:00Z", "2026-10-05T05:27:00Z"), creatorName, creatorHandle: "Reposter", creatorUrl: null};
  const gateway = { artists: { assetArtist: vi.fn().mockResolvedValue({id: "artist:assigned", label: "Assigned artist", keys: ["HoundShou"], assetCount: 2}) } } as unknown as LibraryGateway;
  const open = vi.fn();
  render(<LibraryProvider gateway={gateway}><AssetInfoPanel assets={[selected]} onOpenArtist={open}/></LibraryProvider>);
  expect(await screen.findByText("Assigned artist")).toBeInTheDocument();
  expect(screen.getByText(/@HoundShou/)).toBeInTheDocument();
  expect(screen.queryByText("작가 미상")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name: /작가 페이지/}));
  expect(open).toHaveBeenCalledWith("artist:assigned");
});

it("leads with the image at its own shape; a video shows its still and length; the viewer leaves it out", () => {
  const gateway = {} as unknown as LibraryGateway;
  const tall = { ...asset("tall", "2026-10-05T05:27:00Z", "2026-10-05T05:27:00Z"), width: 800, height: 1200 };
  const { container, rerender } = render(<LibraryProvider gateway={gateway}><AssetInfoPanel assets={[tall]} /></LibraryProvider>);
  const preview = screen.getByRole("button", { name: "tall.png 감상 화면으로 열기" });
  expect(preview).toHaveStyle({ aspectRatio: "800 / 1200" });
  expect(preview.querySelector("img")?.getAttribute("src")).toContain("/thumbnail/tall");
  expect(container.firstElementChild?.firstElementChild).toBe(preview);
  const clip = { ...asset("clip", "2026-10-05T05:27:00Z", "2026-10-05T05:27:00Z"), thumbnailRevision: null, media: { kind: "video" as const, durationMs: 42_000 } } as AssetSummary;
  rerender(<LibraryProvider gateway={gateway}><AssetInfoPanel assets={[clip]} /></LibraryProvider>);
  const still = screen.getByRole("button", { name: "clip.png 감상 화면으로 열기" });
  expect(still.querySelector("img")).toBeNull();
  expect(still).toHaveTextContent("▶ 0:42");
  rerender(<LibraryProvider gateway={gateway}><AssetInfoPanel preview={false} assets={[tall]} /></LibraryProvider>);
  expect(screen.queryByRole("button", { name: /감상 화면으로 열기/ })).toBeNull();
  expect(screen.getByLabelText("출처와 파일")).toBeInTheDocument();
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
    "preview", "artist", "source", "file", "same-post", "tags", "collection",
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


it.each(["resolve", "reject"])("keeps B's draft when A's save finishes with %s", async (outcome) => {
  const a = asset("a", "t", "t"), b = asset("b", "t", "t");
  let resolve!: (value: AssetSummary) => void;
  let reject!: (reason: Error) => void;
  const updateAssetMetadata = vi.fn(() => new Promise<AssetSummary>((yes, no) => { resolve = yes; reject = no; }));
  const gateway = { updateAssetMetadata } as unknown as LibraryGateway;
  const updated = vi.fn();
  const panel = (selected: AssetSummary) => <LibraryProvider gateway={gateway}><AssetInfoPanel assets={[selected]} onAssetUpdated={updated} /></LibraryProvider>;
  const { rerender } = render(panel(a));
  fireEvent.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  rerender(panel(b));
  fireEvent.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  fireEvent.change(screen.getByRole("textbox", { name: "제작자 이름" }), { target: { value: "B draft" } });
  await act(async () => outcome === "resolve" ? resolve(a) : reject(new Error("A save failed")));
  expect(screen.getByRole("textbox", { name: "제작자 이름" })).toHaveValue("B draft");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
  if (outcome === "resolve") expect(updated).toHaveBeenCalledWith(a);
});
