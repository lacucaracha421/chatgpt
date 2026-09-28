import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, LibraryGateway } from "../library/types";
import { AlbumOverview } from "./AlbumOverview";

afterEach(cleanup);

const asset = (id: string): AssetSummary => ({
  id, title: null, originalName: `${id}.png`, byteSize: 1, width: 200, height: 200,
  collectedAt: "2026-09-29T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null,
  creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null,
  media: { kind: "image" },
});

function gateway(items: AssetSummary[] = []) {
  const base = {
    listAssets: vi.fn().mockResolvedValue({ items, nextCursor: null, totalCount: items.length }),
    createAlbum: vi.fn().mockResolvedValue({ id: "new", name: "새 앨범", parentId: null, iconKey: null, colorKey: null }),
  };
  return new Proxy(base, { get: (target, key: string) => key in target ? target[key as keyof typeof target] : vi.fn().mockResolvedValue([]) }) as unknown as LibraryGateway;
}

describe("AlbumOverview", () => {
  it("loads visible album covers, opens a card, and reuses the create action", async () => {
    const user = userEvent.setup();
    const libraryGateway = gateway([asset("a1"), asset("a2"), asset("a3")]);
    const onNavigate = vi.fn();
    const onCreateAlbum = vi.fn();
    render(<LibraryProvider gateway={libraryGateway}><AlbumOverview albums={[
      { id: "album-1", name: "표지", parentId: null, iconKey: null, colorKey: null, assetCount: 3 },
      { id: "album-1-child", name: "하위", parentId: "album-1", iconKey: null, colorKey: null },
    ]} onNavigate={onNavigate} onCreateAlbum={onCreateAlbum} /></LibraryProvider>);

    const card = await screen.findByRole("button", { name: "표지 3장" });
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalledWith(expect.objectContaining({ albumId: "album-1", limit: 3 })));
    expect(card.querySelectorAll(".album-overview__mosaic-cell")).toHaveLength(3);
    await user.click(card);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "album", albumId: "album-1" });
    await user.click(screen.getByRole("button", { name: "새 앨범" }));
    expect(onCreateAlbum).toHaveBeenCalledOnce();
  });

  it("shows the empty state and its create action", async () => {
    const user = userEvent.setup();
    const onCreateAlbum = vi.fn();
    render(<LibraryProvider gateway={gateway()}><AlbumOverview albums={[]} onNavigate={vi.fn()} onCreateAlbum={onCreateAlbum} /></LibraryProvider>);
    expect(screen.getByText("앨범 없음")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "새 앨범" })[1]);
    expect(onCreateAlbum).toHaveBeenCalledOnce();
  });
});
