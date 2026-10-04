import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetGallery } from "./AssetGallery";
import * as mediaUrl from "./mediaUrl";
import { shareAssetSummaries } from "./shareAssetSummaries";

function asset(index: number): AssetSummary {
  return {
    id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, byteSize: 1,
    width: 200, height: 200, collectedAt: "2026-09-01T00:00:00Z", favorite: false,
    sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null,
    creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null,
    media: { kind: "image" }, thumbnailRevision: "r1",
  };
}

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 900 }, clientWidth: { configurable: true, get: () => 840 },
    offsetHeight: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 600 },
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["masonry", "justified"] as const)("%s tile memoization", layout => {
  it("skips equal responses and keeps the old bitmap until the changed thumbnail decodes", async () => {
    const thumbnail = vi.spyOn(mediaUrl, "assetThumbnailUrl");
    const items = Array.from({ length: 8 }, (_, index) => asset(index));
    const { rerender } = render(<AssetGallery layout={layout} items={items} onOpen={() => undefined} />);
    const images = screen.getAllByRole("img");
    thumbnail.mockClear();
    const equal = shareAssetSummaries(items, structuredClone(items));
    rerender(<AssetGallery layout={layout} items={equal} onOpen={() => undefined} />);
    expect(thumbnail).not.toHaveBeenCalled();
    screen.getAllByRole("img").forEach((image, index) => expect(image).toBe(images[index]));

    const incoming = structuredClone(items);
    incoming[2].title = "Updated";
    incoming[2].thumbnailRevision = "r2";
    const changed = shareAssetSummaries(equal, incoming);
    rerender(<AssetGallery layout={layout} items={changed} onOpen={() => undefined} />);
    expect(thumbnail).toHaveBeenCalledOnce();
    expect(thumbnail.mock.calls[0][0].id).toBe("asset-2");
    expect(screen.getByRole("option", { name: "Updated" })).toBeInTheDocument();
    screen.getAllByRole("img").forEach((image, index) => expect(image).toBe(images[index]));
    const next = document.querySelector<HTMLImageElement>('img[src$="/vr2"]')!;
    let finish!: () => void;
    next.decode = () => new Promise<void>(resolve => { finish = resolve; });
    fireEvent.load(next);
    expect(screen.getByRole("img", {name: "asset-2.png"})).toBe(images[2]);
    await act(async () => finish());
    expect(screen.getByRole("img", {name: "Updated"})).toBe(next);
    screen.getAllByRole("img").forEach((image, index) => { if (index !== 2) expect(image).toBe(images[index]); });
  });

  it("uses current callbacks and drag selection when an unchanged tile skips rendering", () => {
    const thumbnail = vi.spyOn(mediaUrl, "assetThumbnailUrl");
    const items = Array.from({ length: 3 }, (_, index) => asset(index));
    const previousOpen = vi.fn(), nextOpen = vi.fn(), previousDrag = vi.fn(), nextDrag = vi.fn();
    const { rerender } = render(<AssetGallery layout={layout} items={items}
      selectedAssetIds={new Set(["asset-0", "asset-1"])} onOpen={previousOpen} onPointerDragStart={previousDrag} />);
    const tile = screen.getByRole("option", { name: "asset-0.png" });
    thumbnail.mockClear();
    rerender(<AssetGallery layout={layout} items={items}
      selectedAssetIds={new Set(["asset-0", "asset-2"])} onOpen={nextOpen} onPointerDragStart={nextDrag} />);
    expect(thumbnail.mock.calls.map(([entry]) => entry.id)).not.toContain("asset-0");
    fireEvent.doubleClick(tile);
    fireEvent.pointerDown(tile, { button: 0 });
    expect(previousOpen).not.toHaveBeenCalled();
    expect(previousDrag).not.toHaveBeenCalled();
    expect(nextOpen).toHaveBeenCalledOnce();
    expect(nextDrag).toHaveBeenCalledWith({ kind: "assets", assetIds: ["asset-0", "asset-2"] }, expect.anything());
  });

  it("preserves optional favorite affordances and focus-versus-selection routing", () => {
    const items = [asset(0)];
    const select = vi.fn(), focus = vi.fn(), favorite = vi.fn();
    const { rerender } = render(<AssetGallery layout={layout} items={items} onSelectionGesture={select} />);
    const tile = screen.getByRole("option");
    expect(screen.queryByRole("button", { name: "asset-0.png 좋아요" })).toBeNull();
    fireEvent.click(tile);
    expect(select).toHaveBeenCalledOnce();
    rerender(<AssetGallery layout={layout} items={items} onSelectionGesture={select} onFocusAsset={focus} onToggleFavorite={favorite} />);
    fireEvent.click(tile);
    expect(focus).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "asset-0.png 좋아요" }));
    expect(favorite).toHaveBeenCalledOnce();
    rerender(<AssetGallery layout={layout} items={items} onSelectionGesture={select} />);
    expect(screen.queryByRole("button", { name: "asset-0.png 좋아요" })).toBeNull();
    fireEvent.click(tile);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
