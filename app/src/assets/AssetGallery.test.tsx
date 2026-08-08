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
  it("keeps the DOM bounded with 50,000 asset metadata rows", async () => {
    render(<AssetGallery items={Array.from({ length: 50_000 }, (_, index) => asset(index))} />);
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeLessThan(100));
    expect(screen.getByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
  });

  it("selects once and opens on double click or Enter", async () => {
    const user = userEvent.setup(); const select = vi.fn(); const open = vi.fn();
    render(<AssetGallery items={[asset(0)]} selectedAssetIds={new Set()} focusAssetId="asset-0" targetRowHeight={180} onSelectionGesture={select} onOpen={open} />);
    const tile = await screen.findByRole("option", { name: "asset-0.png" });
    await user.click(tile); expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }), { toggle: false, range: false }); expect(open).not.toHaveBeenCalled();
    await user.dblClick(tile); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }));
    fireEvent.keyDown(tile, { key: "Enter" }); expect(open).toHaveBeenCalledTimes(2);
  });

  it("reports multi-selection gestures and loaded-item keyboard commands", async () => {
    const user = userEvent.setup();
    const onSelectionGesture = vi.fn();
    const onSelectAll = vi.fn();
    const onDeleteSelection = vi.fn();
    const onClearSelection = vi.fn();
    const onMoveFocus = vi.fn();
    render(<AssetGallery
      items={[asset(0), asset(1), asset(2)]}
      selectedAssetIds={new Set(["asset-0"])}
      focusAssetId="asset-0"
      targetRowHeight={180}
      onSelectionGesture={onSelectionGesture}
      onSelectAll={onSelectAll}
      onDeleteSelection={onDeleteSelection}
      onClearSelection={onClearSelection}
      onMoveFocus={onMoveFocus}
    />);
    const first = await screen.findByRole("option", { name: "asset-0.png" });
    const second = screen.getByRole("option", { name: "asset-1.png" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).not.toHaveAttribute("aria-pressed");

    await user.keyboard("{Control>}");
    await user.click(second);
    await user.keyboard("{/Control}");
    expect(onSelectionGesture).toHaveBeenLastCalledWith(expect.objectContaining({ id: "asset-1" }), { toggle: true, range: false });
    fireEvent.click(second, { shiftKey: true });
    expect(onSelectionGesture).toHaveBeenLastCalledWith(expect.objectContaining({ id: "asset-1" }), { toggle: false, range: true });

    first.focus();
    await user.keyboard("{Control>}a{/Control}");
    await user.keyboard("{Delete}{Escape}{ArrowRight}");
    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(onDeleteSelection).toHaveBeenCalledOnce();
    expect(onClearSelection).toHaveBeenCalledOnce();
    expect(onMoveFocus).toHaveBeenCalledWith(1, false);
  });

  it("renders safe metadata overlays", async () => {
    render(<AssetGallery items={[{ ...asset(0), sourceUrl: "not a URL", collectedAt: "bad date" }]} metadataVisible />);
    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
  });

  it("arms a pointer drag with the selected set or only the unselected tile", async () => {
    const onPointerDragStart = vi.fn();
    render(<AssetGallery
      items={[asset(0), asset(1), asset(2)]}
      selectedAssetIds={new Set(["asset-0", "asset-1"])}
      onPointerDragStart={onPointerDragStart}
    />);

    fireEvent.pointerDown(await screen.findByRole("option", { name: "asset-0.png" }), { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    expect(onPointerDragStart).toHaveBeenLastCalledWith(
      { kind: "assets", assetIds: ["asset-0", "asset-1"] },
      expect.objectContaining({ pointerId: 7 }),
    );

    fireEvent.pointerDown(screen.getByRole("option", { name: "asset-2.png" }), { button: 0, pointerId: 8, clientX: 20, clientY: 20 });
    expect(onPointerDragStart).toHaveBeenLastCalledWith(
      { kind: "assets", assetIds: ["asset-2"] },
      expect.objectContaining({ pointerId: 8 }),
    );
  });

  it("prevents the webview from starting its default image drag", async () => {
    render(<AssetGallery items={[asset(0)]} onPointerDragStart={vi.fn()} />);
    const image = await screen.findByRole("img", { name: "asset-0.png" });

    expect(image).toHaveProperty("draggable", false);
  });
});

function asset(index: number): AssetSummary { return { id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, byteSize: 1, width: 200, height: 200, collectedAt: "2026-07-30T00:00:00Z", favorite: false, sourceUrl: null }; }
