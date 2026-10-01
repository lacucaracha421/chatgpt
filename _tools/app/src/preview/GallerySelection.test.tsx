import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { AssetGallery } from "../assets/AssetGallery";
import type { AssetSummary } from "../library/types";
import { dispatchPreviewCommand } from "./fixtures";

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 840 },
    clientHeight: { configurable: true, get: () => 600 },
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it.each(["masonry", "justified"] as const)("uses the real gallery selection treatment in the %s browser preview", (layout) => {
  const page = dispatchPreviewCommand("list_assets", { query: { limit: 2 } }) as { items: AssetSummary[] };
  const items = page.items.slice(0, 2);
  function PreviewGallery() {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    return <AssetGallery layout={layout} items={items} groupDates={false} focusAssetId={items[1].id}
      selectedAssetIds={selected} onSelectionGesture={(asset) => setSelected(current => current.has(asset.id) ? new Set() : new Set([asset.id]))} />;
  }
  render(<PreviewGallery />);
  const tiles = screen.getAllByRole("option");
  const image = tiles[0].querySelector("img");
  expect(tiles[0]).toHaveClass("ui-selectable-media");
  expect(tiles[1]).toHaveAttribute("data-focused", "true");
  expect(tiles[1]).toHaveAttribute("aria-selected", "false");

  fireEvent.click(tiles[0], { ctrlKey: true });
  expect(tiles[0]).toHaveAttribute("aria-selected", "true");
  expect(tiles[0].querySelector(".ui-selection-check")).toHaveAttribute("aria-hidden", "true");
  expect(tiles[1].querySelector(".ui-selection-check")).toBeNull();
  expect(tiles[0].querySelector("img")).toBe(image);

  fireEvent.click(tiles[0], { ctrlKey: true });
  expect(tiles[0]).toHaveAttribute("aria-selected", "false");
  expect(tiles[0].querySelector(".ui-selection-check")).toBeNull();
});
