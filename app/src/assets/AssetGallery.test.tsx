import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetGallery } from "./AssetGallery";

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 }, clientWidth: { configurable: true, get: () => 840 }, offsetHeight: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 600 },
}));
afterEach(cleanup);

describe("AssetGallery", () => {
  it("keeps only virtual rows in the DOM", async () => {
    render(<AssetGallery items={Array.from({ length: 500 }, (_, index) => asset(index))} />);
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeLessThan(100));
    expect(screen.getByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
  });

  it("selects once and opens on double click or Enter", async () => {
    const user = userEvent.setup(); const select = vi.fn(); const open = vi.fn();
    render(<AssetGallery items={[asset(0)]} selectedAssetId={null} onSelect={select} onOpen={open} />);
    const tile = await screen.findByRole("button", { name: "asset-0.png" });
    await user.click(tile); expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" })); expect(open).not.toHaveBeenCalled();
    await user.dblClick(tile); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }));
    fireEvent.keyDown(tile, { key: "Enter" }); expect(open).toHaveBeenCalledTimes(2);
  });

  it("renders safe metadata overlays", async () => {
    render(<AssetGallery items={[{ ...asset(0), sourceUrl: "not a URL", collectedAt: "bad date" }]} metadataVisible />);
    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
  });
});

function asset(index: number): AssetSummary { return { id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, relativePath: "", thumbnailRelativePath: "", byteSize: 1, width: 200, height: 200, collectedAt: "2026-07-30T00:00:00Z", favorite: false, sourceUrl: null }; }
