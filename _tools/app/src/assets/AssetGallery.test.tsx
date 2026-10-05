import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetGallery } from "./AssetGallery";
import { GalleryViewMenu } from "./GalleryViewMenu";
import { useState } from "react";
import { readFileSync } from "node:fs";

// Width 840 rounds to 848; six square items, 6px gaps, one date heading.
const MEASURED_EIGHT = 2 * ((848 - 5 * 6) / 6) + 44 + 6;
const RESERVED_HUNDRED = Math.ceil(100 / 4) * (MEASURED_EIGHT / 2);

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 }, clientWidth: { configurable: true, get: () => 840 }, offsetHeight: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 600 },
  setPointerCapture: { configurable: true, value: vi.fn() },
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AssetGallery", () => {
  it("measures changed folder content before paint without waiting for ResizeObserver", () => {
    const measured: string[] = [];
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("asset-gallery__intro")) return original.call(this);
      measured.push(this.textContent ?? "");
      return { ...original.call(this), height: this.textContent === "new folder and counts" ? 260 : 40 };
    });
    const items = [asset(0)];
    const { rerender } = render(<AssetGallery layout="masonry" items={items} intro={<div>old folder</div>} />);
    measured.length = 0;
    rerender(<AssetGallery layout="masonry" items={items} intro={<div>new folder and counts</div>} />);
    expect(measured).toContain("new folder and counts");
  });

  it("keeps the shared compact date heading even when a legacy caller requests full dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23));
    const items = [{ ...asset(0), collectedAt: new Date(2026, 8, 23, 12).toISOString() }];
    const { container, rerender } = render(<AssetGallery layout="masonry" items={items} />);
    expect(container.querySelector(".asset-gallery__date")).toHaveTextContent("9.23");
    rerender(<AssetGallery layout="masonry" items={items} fullDateHeadings />);
    expect(container.querySelector(".asset-gallery__date-day")).toHaveTextContent(/^9\.23$/);
  });

  it("labels date headings with the date, 오늘 or the weekday, and the group count", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 24, 9));
    const items = [
      { ...asset(0), collectedAt: new Date(2026, 8, 24, 8).toISOString() },
      { ...asset(1), collectedAt: new Date(2026, 8, 24, 7).toISOString() },
      { ...asset(2), collectedAt: new Date(2026, 8, 23, 21).toISOString() },
    ];
    const { container, rerender } = render(<AssetGallery layout="masonry" items={items} />);
    const headings = [...container.querySelectorAll(".asset-gallery__date")];
    expect(headings.map(heading => [
      heading.querySelector(".asset-gallery__date-day")?.textContent,
      heading.querySelector(".asset-gallery__date-weekday")?.textContent,
      heading.querySelector(".asset-gallery__date-count")?.textContent,
    ])).toEqual([["9.24", "오늘", "2"], ["9.23", "수", undefined]]); // a single image shows no count
    rerender(<AssetGallery layout="masonry" items={items} fullDateHeadings />);
    expect(container.querySelector(".asset-gallery__date-day")).toHaveTextContent(/^9\.24$/);
    expect(container.querySelector(".asset-gallery__date-weekday")).toHaveTextContent("오늘");
  });

  it("shows no hover caption without a creator and never shows the time on the tile", () => {
    render(<AssetGallery layout="masonry" items={[asset(0)]} metadataVisible />);
    expect(document.querySelector(".asset-gallery__metadata")).toBeNull();
    expect(document.querySelector(".asset-gallery__asset time")).toBeNull();
    expect(screen.queryByText("작가 미상")).not.toBeInTheDocument();
    expect(screen.getByRole("option")).not.toHaveAttribute("aria-description", expect.stringContaining("작가 미상"));
  });

  it("restores masonry scope offsets without replacing its scroll container", async () => {
    const items = Array.from({ length: 120 }, (_, index) => asset(index));
    const { container, rerender } = render(<AssetGallery layout="masonry" scopeKey="a" items={items} />);
    const scroll = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    scroll.scrollTop = 800;
    fireEvent.scroll(scroll);
    rerender(<AssetGallery layout="masonry" scopeKey="b" items={items} />);
    expect(scroll.scrollTop).toBe(0);
    rerender(<AssetGallery layout="masonry" scopeKey="a" items={items} />);
    await waitFor(() => expect(scroll.scrollTop).toBe(800));
    expect(container.querySelector(".asset-gallery__scroll")).toBe(scroll);
  });

  it("preserves one navigation offset across segments and clamps a shorter list", () => {
    const items = Array.from({ length: 120 }, (_, index) => asset(index));
    const { container, rerender } = render(<AssetGallery layout="masonry" scopeKey="unclassified" navigationScopeKey="folder" items={items} />);
    const scroll = container.querySelector<HTMLElement>(".asset-gallery__scroll")!;
    scroll.scrollTop = 800; fireEvent.scroll(scroll);
    rerender(<AssetGallery layout="masonry" scopeKey="all" navigationScopeKey="folder" items={[...items]} />);
    expect(scroll.scrollTop).toBe(800);
    expect(scroll.dataset.folderMove).toBeUndefined();
    rerender(<AssetGallery layout="masonry" scopeKey="unclassified" navigationScopeKey="folder" items={items.slice(0, 1)} />);
    expect(scroll.scrollTop).toBe(0);
    expect(scroll.dataset.folderMove).toBeUndefined();
  });

  it("selects a focused masonry asset with Space", async () => {
    const select = vi.fn();
    render(<AssetGallery layout="masonry" items={[asset(0)]} onSelectionGesture={select} />);
    fireEvent.keyDown(await screen.findByRole("option", { name: "asset-0.png" }), { key: " " });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }), { toggle: true, range: false });
  });
  it("opens character assignment for a selection or the focused asset", async () => {
    const open = vi.fn();
    const { rerender } = render(<AssetGallery layout="masonry" items={[asset(0)]} selectedAssetIds={new Set(["asset-0"])} onAssignCharacter={open} />);
    const tile = await screen.findByRole("option", { name: "asset-0.png" });
    fireEvent.keyDown(tile, { key: "c" });
    expect(open).toHaveBeenCalledOnce();
    rerender(<AssetGallery layout="masonry" items={[asset(0)]} selectedAssetIds={new Set()} onAssignCharacter={open} />);
    fireEvent.keyDown(tile, { key: "c" });
    expect(open).toHaveBeenCalledOnce();
    rerender(<AssetGallery layout="masonry" items={[asset(0)]} selectedAssetIds={new Set()} focusAssetId="asset-0" onAssignCharacter={open} />);
    fireEvent.keyDown(tile, { key: "c" });
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: "asset-0" }));
  });
  it("routes favorite and trash shortcuts for a focused asset", async () => {
    const favorite = vi.fn();
    const trash = vi.fn();
    render(<AssetGallery layout="masonry" items={[asset(0)]} focusAssetId="asset-0" onToggleFavorite={favorite} onDeleteSelection={trash} />);
    const tile = await screen.findByRole("option", { name: "asset-0.png" });
    fireEvent.keyDown(tile, { key: "f" });
    fireEvent.keyDown(tile, { key: "Delete" });
    expect(favorite).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }));
    expect(trash).toHaveBeenCalledOnce();
  });
  it("bounds masonry DOM and loads the next page only near the displayed end", async () => {
    const next = vi.fn();
    const { container } = render(<AssetGallery layout="masonry" metadataVisible items={Array.from({ length: 50_000 }, (_, index) => asset(index))} hasNextPage onLoadNextPage={next} />);
    expect(await screen.findByRole("option", { name: "asset-0.png" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBeLessThan(100);
    expect(next).not.toHaveBeenCalled();
    const scroll = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    const height = Number.parseFloat((container.querySelector(".asset-gallery__virtual-space") as HTMLElement).style.height);
    scroll.scrollTop = height - 650;
    fireEvent.scroll(scroll);
    await waitFor(() => expect(next).toHaveBeenCalled());
    expect(screen.getAllByRole("option").length).toBeLessThan(100);
  });

  it("shows neither creator nor time on masonry tiles and merges a continued date", async () => {
    const first = { ...asset(0), creatorName: "긴 작가 이름", collectedAt: new Date(2026, 8, 6, 21, 7).toISOString() };
    const { container, rerender } = render(<AssetGallery layout="masonry" metadataVisible items={[first]} />);
    expect(screen.queryByText(/긴 작가 이름/)).toBeNull();
    expect(screen.queryByText("21:07")).toBeNull();
    rerender(<AssetGallery layout="masonry" metadataVisible items={[first, { ...first, id: "second" }]} />);
    expect(container.querySelectorAll(".asset-gallery__date")).toHaveLength(1);
  });
  it("renders rows with the gallery gap supplied by computed styles", async () => {
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => name === "--gallery-gap" ? "6px" : "",
      paddingLeft: "6px",
      paddingRight: "6px",
    } as CSSStyleDeclaration);
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    });

    const { container } = render(<AssetGallery items={[asset(0), asset(1)]} />);
    computedStyle.mockRestore();

    await waitFor(() => expect(container.querySelector(".asset-gallery__row")).toHaveStyle({ gap: "6px" }));
  });

  it("paints virtual row gaps with the gallery background", async () => {
    const { container } = render(<AssetGallery items={[asset(0), asset(1)]} />);

    const row = await waitFor(() => container.querySelector(".asset-gallery__row") as HTMLElement);
    expect(row).toHaveStyle({ backgroundColor: "var(--color-bg)" });
  });

  it("extends the virtual row background through the vertical gallery gap", async () => {
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => name === "--gallery-gap" ? "6px" : "",
      paddingLeft: "6px",
      paddingRight: "6px",
    } as CSSStyleDeclaration);
    const { container } = render(<AssetGallery items={[asset(0), asset(1)]} />);
    computedStyle.mockRestore();

    const unit = await waitFor(() => container.querySelector(".asset-gallery__justified-unit") as HTMLElement);
    const tile = container.querySelector(".asset-gallery__asset") as HTMLElement;
    expect(Number.parseFloat(unit.style.height)).toBe(Number.parseFloat(tile.style.height) + 44 + 6);
  });

  it("keeps the DOM bounded with 50,000 asset metadata rows", async () => {
    render(<AssetGallery items={Array.from({ length: 50_000 }, (_, index) => asset(index))} />);
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeLessThan(100));
    expect(screen.getByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
  });

  it("decodes grid thumbnails asynchronously", async () => {
    render(<AssetGallery items={[asset(0)]} />);
    expect(await screen.findByRole("img", { name: "asset-0.png" })).toHaveAttribute("decoding", "async");
  });

  it("focuses on plain click, selects with Ctrl or Shift, and opens on double click or Enter", async () => {
    const user = userEvent.setup(); const focus = vi.fn(); const select = vi.fn(); const open = vi.fn();
    render(<AssetGallery items={[asset(0)]} selectedAssetIds={new Set()} focusAssetId="asset-0" targetRowHeight={180} onFocusAsset={focus} onSelectionGesture={select} onOpen={open} />);
    const tile = await screen.findByRole("option", { name: "asset-0.png" });
    await user.click(tile); expect(focus).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" })); expect(select).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    fireEvent.click(tile, { ctrlKey: true }); expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ id: "asset-0" }), { toggle: true, range: false });
    fireEvent.click(tile, { shiftKey: true }); expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ id: "asset-0" }), { toggle: false, range: true });
    await user.dblClick(tile); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }));
    fireEvent.keyDown(tile, { key: "Enter" }); expect(open).toHaveBeenCalledTimes(2);
  });

  it("offers quick preview only for image assets", async () => {
    render(<AssetGallery items={[asset(0), videoAsset(1)]} />);

    expect((await screen.findByRole("button", { name: "asset-0.png 빠른 확대 미리보기" })).parentElement).toHaveClass("asset-gallery__image");
    expect(screen.queryByRole("button", { name: "video-1.webm 빠른 확대 미리보기" })).not.toBeInTheDocument();
  });

  it("opens one original image preview after the hover delay and closes it on leave", () => {
    vi.useFakeTimers();
    render(<AssetGallery items={[asset(0), asset(1)]} />);
    const first = screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });

    fireEvent.pointerEnter(first);
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" })).toHaveAttribute("src", "http://lakomics.localhost/asset/asset-0");

    const second = screen.getByRole("button", { name: "asset-1.png 빠른 확대 미리보기" });
    fireEvent.pointerEnter(second);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /빠른 미리보기/ })).toHaveLength(1);

    fireEvent.pointerLeave(second);
    expect(screen.queryByRole("img", { name: "asset-1.png 빠른 미리보기" })).not.toBeInTheDocument();
  });

  it("waits for the original image to decode before replacing a quick preview", async () => {
    vi.useFakeTimers();
    let finishDecode!: () => void;
    class DecodingImage {
      src = "";
      decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    }
    vi.stubGlobal("Image", DecodingImage);
    render(<AssetGallery items={[asset(0)]} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" }));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

    await act(async () => finishDecode());
    expect(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" })).toBeVisible();
  });

  it("supports keyboard quick preview and dismisses it without selecting or opening the tile", () => {
    vi.useFakeTimers();
    const select = vi.fn();
    const open = vi.fn();
    const { container } = render(<AssetGallery items={[asset(0)]} onSelectionGesture={select} onOpen={open} />);
    const trigger = screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });

    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" })).toBeInTheDocument();
    fireEvent.blur(trigger);
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(150));
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.doubleClick(trigger);
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(select).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(150));
    fireEvent.error(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" }));
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(150));
    fireEvent.scroll(container.querySelector(".asset-gallery__scroll")!);
    expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();
  });

  it("places the quick preview beside its trigger and clamps it inside the viewport", () => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    render(<AssetGallery items={[{ ...asset(0), width: 400, height: 800 }]} />);
    const trigger = screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 900,
      right: 924,
      top: 760,
      bottom: 784,
      width: 24,
      height: 24,
      x: 900,
      y: 760,
      toJSON: () => ({}),
    });

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(150));
    const preview = screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" }).parentElement!;
    const left = Number.parseFloat(preview.style.left);
    const top = Number.parseFloat(preview.style.top);
    const width = Number.parseFloat(preview.style.width);
    const height = Number.parseFloat(preview.style.height);

    expect(left).toBeLessThan(900);
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + height).toBeLessThanOrEqual(788);
    expect(width / height).toBeCloseTo(0.5);
  });

  it("keeps a large quick preview inside the gallery instead of covering navigation", () => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    const { container } = render(<AssetGallery items={[{ ...asset(0), width: 700, height: 900 }]} />);
    const gallery = container.querySelector(".asset-gallery") as HTMLElement;
    vi.spyOn(gallery, "getBoundingClientRect").mockReturnValue({
      left: 240, right: 1000, top: 0, bottom: 800, width: 760, height: 800,
      x: 240, y: 0, toJSON: () => ({}),
    });
    const trigger = screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 650, right: 674, top: 360, bottom: 384, width: 24, height: 24,
      x: 650, y: 360, toJSON: () => ({}),
    });

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(150));

    const preview = screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" }).parentElement!;
    expect(Number.parseFloat(preview.style.left)).toBeGreaterThanOrEqual(252);
    expect(Number.parseFloat(preview.style.left) + Number.parseFloat(preview.style.width)).toBeLessThanOrEqual(988);
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
    expect(first.querySelector(".ui-selection-check")).not.toBeNull();
    expect(second.querySelector(".ui-selection-check")).toBeNull();
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

  it("clears selection only from genuinely empty gallery space", async () => {
    const onClearSelection = vi.fn();
    const { container } = render(<AssetGallery items={[asset(0)]} selectedAssetIds={new Set(["asset-0"])} onClearSelection={onClearSelection} />);
    const gallery = container.querySelector(".asset-gallery__scroll")!;
    const assetTile = await screen.findByRole("option", { name: "asset-0.png" });
    const previewButton = screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });

    fireEvent.click(assetTile);
    fireEvent.click(previewButton);
    expect(onClearSelection).not.toHaveBeenCalled();

    fireEvent.click(gallery);
    expect(onClearSelection).toHaveBeenCalledOnce();

    Object.defineProperties(gallery, {
      clientWidth: { configurable: true, value: 100 },
      offsetWidth: { configurable: true, value: 116 },
    });
    vi.spyOn(gallery, "getBoundingClientRect").mockReturnValue({ left: 0, right: 116, top: 0, bottom: 200, width: 116, height: 200, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(gallery, { clientX: 108 });
    expect(onClearSelection).toHaveBeenCalledOnce();
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

  it("shows a filled star only on favorited tiles and does not make it interactive", async () => {
    render(<AssetGallery
      items={[{ ...asset(0), favorite: true }, asset(1)]}
      targetRowHeight={180}
      onSelectionGesture={vi.fn()}
      onPointerDragStart={vi.fn()}
    />);
    const favorited = await screen.findByRole("option", { name: "asset-0.png" });
    const plain = screen.getByRole("option", { name: "asset-1.png" });
    expect(favorited.querySelector(".asset-gallery__favorite")).not.toBeNull();
    expect(plain.querySelector(".asset-gallery__favorite")).toBeNull();
    expect(favorited.querySelector(".asset-gallery__favorite")).toHaveClass("asset-gallery__favorite");
  });

  it("moves focus by rows, preserving the column with the nearest tile as fallback", async () => {
    const onMoveFocus = vi.fn();
    render(<AssetGallery
      items={[asset(0), asset(1), asset(2), asset(3), asset(4), asset(5), asset(6), asset(7)]}
      focusAssetId="asset-1"
      targetRowHeight={180}
      onMoveFocus={onMoveFocus}
    />);
    const tile = await screen.findByRole("option", { name: "asset-1.png" });
    tile.focus();
    fireEvent.keyDown(tile, { key: "ArrowDown" });
    expect(onMoveFocus).toHaveBeenLastCalledWith(6, false);
  });

  it("gives re-mounted tiles the same cacheable thumbnail URL until the content revision changes", () => {
    const items = [{ ...asset(0), thumbnailRevision: "11" }, { ...asset(1), thumbnailRevision: null }];
    const sources = () => [...document.querySelectorAll('.asset-gallery__image img:not([aria-hidden="true"])')].map((image) => image.getAttribute("src"));
    const first = render(<AssetGallery layout="masonry" items={items} />);
    const mounted = sources();
    expect(mounted).toEqual(["http://lakomics.localhost/thumbnail/asset-0/v11", "http://lakomics.localhost/thumbnail/asset-1"]);
    first.unmount();
    // Leaving and returning (scroll-back, view switch, closing the viewer) re-mounts the tiles.
    const second = render(<AssetGallery layout="masonry" items={items} />);
    expect(sources()).toEqual(mounted);
    second.rerender(<AssetGallery layout="masonry" items={[{ ...items[0], thumbnailRevision: "12" }, items[1]]} />);
    expect(sources()).toEqual(mounted);
    fireEvent.load(document.querySelector('img[src$="/v12"]')!);
    expect(sources()[0]).toBe("http://lakomics.localhost/thumbnail/asset-0/v12");
    second.rerender(<AssetGallery layout="masonry" mediaSource="vault" items={items} />);
    fireEvent.load(document.querySelector('img[src$="/vault-thumbnail/asset-0"]')!);
    expect(sources()[0]).toBe("http://lakomics.localhost/vault-thumbnail/asset-0");
  });

  it("versions video posters and hover scrub frames with the content revision", () => {
    vi.useFakeTimers();
    render(<AssetGallery items={[{ ...videoAsset(0), thumbnailRevision: "42" }]} />);
    const tile = screen.getByRole("option", { name: "video-0.webm" }).querySelector(".video-tile")!;
    expect(tile.querySelector("img")).toHaveAttribute("src", "http://lakomics.localhost/thumbnail/video-0/v42");
    fireEvent.pointerEnter(tile);
    act(() => vi.advanceTimersByTime(200));
    expect(tile.querySelector("img")?.getAttribute("src")).toMatch(/^http:\/\/lakomics\.localhost\/scrub-frame\/video-0\/\d+\/v42$/);
  });

  it("keeps only one video hover preview active", async () => {
    vi.useFakeTimers();
    render(<AssetGallery items={[videoAsset(0), videoAsset(1)]} />);
    const first = screen.getByRole("option", { name: "video-0.webm" }).querySelector(".video-tile")!;
    const second = screen.getByRole("option", { name: "video-1.webm" }).querySelector(".video-tile")!;
    fireEvent.pointerEnter(first);
    act(() => vi.advanceTimersByTime(200));
    expect(first.querySelector("img")).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-0/"));
    fireEvent.pointerEnter(second);
    act(() => vi.advanceTimersByTime(200));
    expect(first.querySelector("img")).toHaveAttribute("src", "http://lakomics.localhost/thumbnail/video-0");
    expect(second.querySelector("img")).toHaveAttribute("src", expect.stringContaining("/scrub-frame/video-1/"));
  });

  it.each(["justified", "masonry"] as const)("preserves visible hover playback across %s gallery refreshes and scroll measurement", (layout) => {
    vi.useFakeTimers();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { container, rerender } = render(<AssetGallery layout={layout} items={[videoAsset(0), videoAsset(1)]} />);
    const tile = screen.getByRole("option", { name: "video-0.webm" }).querySelector(".video-tile")!;
    fireEvent.pointerEnter(tile);
    act(() => vi.advanceTimersByTime(160));
    const media = tile.querySelector("video") as HTMLVideoElement;
    const removeAttribute = vi.spyOn(media, "removeAttribute");
    const setAttribute = vi.spyOn(media, "setAttribute");
    fireEvent.playing(media);

    for (let second = 1; second <= 20; second++) {
      media.currentTime = second % 10;
      fireEvent.timeUpdate(media);
      rerender(<AssetGallery layout={layout} items={[videoAsset(0), videoAsset(1)]} intro={<div>Updated shelf {second}</div>} thumbnailCacheKey={second} />);
      const scroller = container.querySelector(".asset-gallery__scroll")!;
      fireEvent.scroll(scroller);
      act(() => vi.advanceTimersByTime(720));
      fireEvent.waiting(media);
      fireEvent.stalled(media);
      expect(screen.getByRole("option", { name: "video-0.webm" }).querySelector(".video-tile")).toBe(tile);
      expect(tile.querySelector("video")).toBe(media);
      expect(media).toHaveAttribute("data-shown");
      expect(media.currentTime).toBe(second % 10);
    }

    expect(play).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(removeAttribute.mock.calls.some(([name]) => name === "src" || name === "data-shown")).toBe(false);
    expect(setAttribute.mock.calls.some(([name]) => name === "src")).toBe(false);
    fireEvent.pointerLeave(tile);
    expect(tile.querySelector("video")).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps active video preview clicks routed to normal tile selection", async () => {
    vi.useFakeTimers();
    const onSelectionGesture = vi.fn();
    render(<AssetGallery items={[videoAsset(0)]} onSelectionGesture={onSelectionGesture} />);
    const tile = screen.getByRole("option", { name: "video-0.webm" });
    fireEvent.pointerEnter(tile.querySelector(".video-tile")!);
    act(() => vi.advanceTimersByTime(200));
    const preview = tile.querySelector("img")!;
    expect(preview).toHaveAttribute("draggable", "false");
    fireEvent.click(preview, { ctrlKey: true });
    expect(onSelectionGesture).toHaveBeenCalledWith(expect.objectContaining({ id: "video-0" }), { toggle: true, range: false });
  });

  it("masks every tile with a skeleton and drops quick previews in privacy mode", async () => {
    render(<AssetGallery items={[asset(0), videoAsset(1)]} privacyMode />);

    await screen.findByRole("option", { name: "asset-0.png" });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "비공개 모드" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "asset-0.png 빠른 확대 미리보기" })).not.toBeInTheDocument();
  });

  it("requests older pages while an upward page remains available", async () => {
    const onLoadPrevPage = vi.fn();
    render(<AssetGallery items={[asset(0), asset(1)]} hasPreviousPage onLoadPrevPage={onLoadPrevPage} />);

    await waitFor(() => expect(onLoadPrevPage).toHaveBeenCalled());
  });

  it("does not request older pages without a previous cursor", () => {
    const onLoadPrevPage = vi.fn();
    render(<AssetGallery items={[asset(0), asset(1)]} onLoadPrevPage={onLoadPrevPage} />);

    expect(onLoadPrevPage).not.toHaveBeenCalled();
  });

  it("reserves the full filtered range so appended pages stop growing the scroll range", async () => {
    const onLoadNextPage = vi.fn();
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={onLoadNextPage}
      />,
    );

    // The estimate includes the full-width date heading reserved above each date group.
    const space = await waitFor(() =>
      container.querySelector(".asset-gallery__virtual-space") as HTMLElement,
    );
    expect(Number.parseFloat(space.style.height)).toBeCloseTo(RESERVED_HUNDRED);
  });

  it("sizes the virtual space from measured rows without a total count", async () => {
    const { container } = render(
      <AssetGallery items={Array.from({ length: 8 }, (_, index) => asset(index))} hasNextPage />,
    );

    const space = await waitFor(() =>
      container.querySelector(".asset-gallery__virtual-space") as HTMLElement,
    );
    expect(Number.parseFloat(space.style.height)).toBeCloseTo(MEASURED_EIGHT);
  });

  it("loads the next page when scrolled deep into the reserved range", async () => {
    const onLoadNextPage = vi.fn();
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 160 }, (_, index) => asset(index))}
        totalCount={100000}
        hasNextPage
        onLoadNextPage={onLoadNextPage}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".asset-gallery__virtual-space")).toBeInTheDocument(),
    );
    expect(onLoadNextPage).not.toHaveBeenCalled();

    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    scroller.scrollTop = 20000;
    fireEvent.scroll(scroller);

    await waitFor(() => expect(onLoadNextPage).toHaveBeenCalled());
  });

  it("re-samples the estimate base when the scope changes", async () => {
    const wide = (index: number) => ({ ...asset(index), id: `wide-${index}`, width: 400, height: 100 });
    const { container, rerender } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        scopeKey="a"
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });
    const space = () =>
      container.querySelector(".asset-gallery__virtual-space") as HTMLElement;
    expect(Number.parseFloat(space().style.height)).toBeCloseTo(RESERVED_HUNDRED);

    rerender(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => wide(index))}
        scopeKey="b"
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    expect(Number.parseFloat(space().style.height)).not.toBeCloseTo(RESERVED_HUNDRED);
  });

  it("falls back to the measured range without a total count", async () => {
    const { container, rerender } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });
    const space = () =>
      container.querySelector(".asset-gallery__virtual-space") as HTMLElement;
    expect(Number.parseFloat(space().style.height)).toBeCloseTo(RESERVED_HUNDRED);

    rerender(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );

    expect(Number.parseFloat(space().style.height)).toBeCloseTo(MEASURED_EIGHT);
  });

  it("clears a pending quick preview when the gallery unmounts", () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(<AssetGallery items={[asset(0)]} />);

    fireEvent.pointerEnter(screen.getByRole("button", { name: "asset-0.png 빠른 확대 미리보기" }));
    unmount();

    act(() => vi.advanceTimersByTime(150));
    expect(clearTimeout).toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: /빠른 미리보기/ })).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

function asset(index: number): AssetSummary { return { id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, byteSize: 1, width: 200, height: 200, collectedAt: "2026-07-30T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } }; }
function videoAsset(index: number): AssetSummary { return { ...asset(index), id: `video-${index}`, originalName: `video-${index}.webm`, media: { kind: "video", durationMs: 10_000, preparationState: "ready", scrubFrameCount: 10 } }; }

it("keeps series header controls outside the asset list and their keys out of selection", async () => {
  const selectAll = vi.fn();
  const { container } = render(<AssetGallery intro={<input aria-label="시리즈 설명" />} layout="masonry" items={[asset(0)]} onSelectAll={selectAll} />);
  const field = screen.getByLabelText("시리즈 설명");
  expect(screen.getByRole("listbox", { name:"자산" })).not.toContainElement(field);
  fireEvent.keyDown(field, { key:"a",ctrlKey:true });
  expect(selectAll).not.toHaveBeenCalled();
  fireEvent.keyDown(await screen.findByRole("option", {name:"asset-0.png"}), {key:"a",ctrlKey:true});
  expect(selectAll).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll(".asset-gallery__scroll")).toHaveLength(1);
});

it("keeps painted asset cells and images mounted when N, layout and width change", async () => {
  let resize: ResizeObserverCallback | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: HTMLElement) { if (element.classList.contains("asset-gallery__scroll")) resize = this.callback; }
    disconnect() {} unobserve() {}
  });
  const items = Array.from({ length: 12 }, (_, index) => asset(index));
  function Harness() {
    const [layout, setLayout] = useState<"masonry" | "justified">("masonry");
    return <><GalleryViewMenu galleryLayout={layout} onGalleryLayoutChange={setLayout} thumbnailRowHeight={180} onThumbnailRowHeightChange={vi.fn()} />
      <AssetGallery layout={layout} items={items} groupDates={false} /></>;
  }
  const { container } = render(<Harness />);
  const cell = screen.getByRole("option", { name: "asset-0.png" });
  const image = cell.querySelector("img");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "보기" }));
  fireEvent.change(screen.getByRole("slider", { name: "한 줄에" }), { target: { value: "9" } });
  expect(container.querySelector(".asset-gallery")).toHaveAttribute("data-per-row", "9");
  expect(new Set([...container.querySelectorAll<HTMLElement>("[data-gallery-cell]")].map(tile => tile.style.left)).size).toBe(9);
  expect(screen.getByRole("option", { name: "asset-0.png" })).toBe(cell);
  expect(cell.querySelector("img")).toBe(image);
  await user.click(screen.getByRole("radio", { name: "같은 높이" }));
  expect(screen.getByRole("option", { name: "asset-0.png" })).toBe(cell);
  expect(cell.querySelector("img")).toBe(image);
  expect(container.querySelector(".asset-gallery")).toHaveClass("asset-gallery--justified");
  const oldHeight = cell.style.height;
  act(() => resize?.([{ contentRect: { width: 600, height: 600 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(cell.style.height).not.toBe(oldHeight);
  expect(screen.getByRole("option", { name: "asset-0.png" })).toBe(cell);
  expect(cell.querySelector("img")).toBe(image);
});

it("never paints a supplied filename or creator caption, even on hover", () => {
  const item = { ...asset(0), creatorName: "Visible only in info" };
  render(<AssetGallery layout="masonry" items={[item]} captionLabel={() => "Creator caption"} />);
  const tile = screen.getByRole("option", { name: "asset-0.png" });
  fireEvent.pointerOver(tile);
  expect(tile).toHaveAttribute("aria-description", expect.stringContaining("Creator caption"));
  expect(tile.querySelector(".asset-gallery__metadata")).toBeNull();
  expect(screen.queryByText("Creator caption")).toBeNull();
});

it("uses one duration pill and hides it at small thumbnail sizes", () => {
  const item = { ...videoAsset(0), media: { ...videoAsset(0).media, durationMs: 42000 } } as AssetSummary;
  const { container, rerender } = render(<AssetGallery layout="masonry" items={[item]} />);
  expect(container.querySelectorAll(".video-tile__duration")).toHaveLength(1);
  expect(container.querySelector(".video-tile__duration")).toHaveTextContent("▶ 0:42");
  expect(container.querySelector(".video-tile__icon")).toBeNull();
  localStorage.setItem("lakomics.assets.perRow.v1", "12");
  rerender(<AssetGallery layout="masonry" items={[item]} />);
  expect(container.querySelector(".video-tile__duration")).toBeNull();
});

it("keeps the heart reachable on hover/focus or selection and draws no select circle on tiles", () => {
  const onSelect = vi.fn(), favorite = vi.fn();
  const props = { items: [asset(0), asset(1)], onSelectionGesture: onSelect, onToggleFavorite: favorite };
  const { rerender } = render(<AssetGallery {...props} />);
  // The user removed the select circle (2026-10-02); selection stays on click/Ctrl/Shift gestures.
  expect(screen.queryByRole("button", { name: "asset-0.png 선택" })).toBeNull();
  const heart = screen.getByRole("button", { name: "asset-0.png 좋아요" });
  expect(heart).toHaveClass("asset-gallery__hover-control");
  expect(heart).not.toHaveAttribute("data-visible");
  fireEvent.click(heart);
  expect(favorite).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }));
  rerender(<AssetGallery {...props} selectedAssetIds={new Set(["asset-1"])} />);
  expect(heart).toHaveAttribute("data-visible", "true");
  rerender(<AssetGallery {...props} favoritesView />);
  expect(heart).toHaveAttribute("data-visible", "true");
});

it.each(["masonry", "justified"] as const)("keeps %s date headings and counts visible across tiles, gaps and focus changes", layout => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 4, 12));
  // Match global.css order: the legacy shared count rule loads after the gallery CSS.
  const style = document.createElement("style");
  style.textContent = ["src/assets/asset-gallery.css", "src/styles/shared-states.css"].map(path => readFileSync(path, "utf8")).join("\n");
  document.head.append(style);
  try {
    const items = Array.from({ length: 4 }, (_, index) => ({ ...asset(index), collectedAt: new Date(2026, 9, index < 2 ? 4 : 3, 9).toISOString() }));
    const { container, rerender } = render(<AssetGallery layout={layout} items={items} />);
    const scroll = container.querySelector<HTMLElement>(".asset-gallery__scroll")!;
    const space = container.querySelector<HTMLElement>(".asset-gallery__virtual-space")!;
    const headings = [...container.querySelectorAll<HTMLElement>(".asset-gallery__date")];
    expect(headings).toHaveLength(2);
    expect(headings[0]).toHaveTextContent("10.4오늘2");
    const positions = headings.map(heading => heading.getAttribute("style"));
    const stable = () => {
      expect([...container.querySelectorAll(".asset-gallery__date")]).toEqual(headings);
      expect(headings.map(heading => heading.getAttribute("style"))).toEqual(positions);
      expect(scroll.scrollTop).toBe(0);
      for (const heading of headings) {
        expect(heading).toBeVisible();
        expect(heading).toHaveAttribute("tabindex", "0");
        expect(heading.querySelector(".asset-gallery__date-rule")).toBeNull();
        expect(heading.querySelector(".asset-gallery__date-day")).toBeVisible();
        expect(heading.querySelector(".asset-gallery__date-weekday")).toBeVisible();
        expect(heading.querySelector(".asset-gallery__date-count")).toHaveStyle({ opacity: "1", transition: "none" });
        expect(heading.querySelector(".asset-gallery__date-count")).toHaveTextContent("2");
      }
    };
    stable();
    const tile = screen.getByRole("option", { name: "asset-0.png" });
    act(() => tile.focus());
    stable();
    for (const target of [tile, space, headings[1], scroll, screen.getByRole("option", { name: "asset-2.png" }), space]) {
      fireEvent.pointerOver(target);
      fireEvent.pointerMove(target, { pointerType: "mouse", clientX: 400, clientY: 200 });
      stable();
    }
    fireEvent.pointerLeave(scroll);
    stable();
    act(() => { headings[0].focus(); headings[0].blur(); });
    stable();
    rerender(<AssetGallery layout={layout} items={[...items]} />);
    stable();
  } finally { style.remove(); }
});

it.each(["masonry", "justified"] as const)("keeps the top asset and its image mounted during %s panel and size reflow", layout => {
  let resize: ResizeObserverCallback | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: HTMLElement) { if (element.classList.contains("asset-gallery__scroll")) resize = this.callback; }
    disconnect() {} unobserve() {}
  });
  const items = Array.from({ length: 100 }, (_, index) => asset(index));
  const { container, rerender } = render(<AssetGallery layout={layout} items={items} groupDates={false} infoOpen={false} />);
  const scroller = container.querySelector<HTMLElement>(".asset-gallery__scroll")!;
  scroller.scrollTop = 440; fireEvent.scroll(scroller);
  const positions = () => [...container.querySelectorAll<HTMLElement>("[data-gallery-cell]")];
  const anchor = positions().find(cell => Number.parseFloat(cell.style.top) + Number.parseFloat(cell.style.height) > scroller.scrollTop)!;
  const image = anchor.querySelector("img");
  const offset = Number.parseFloat(anchor.style.top) - scroller.scrollTop;
  rerender(<AssetGallery layout={layout} items={items} groupDates={false} infoOpen />);
  act(() => resize?.([{ contentRect: { width: 600, height: 600 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(Number.parseFloat(anchor.style.top) - scroller.scrollTop).toBeCloseTo(offset);
  expect(anchor.querySelector("img")).toBe(image);
  localStorage.setItem("lakomics.assets.perRow.v1", "9");
  rerender(<AssetGallery layout={layout} items={items} groupDates={false} infoOpen />);
  expect(Number.parseFloat(anchor.style.top) - scroller.scrollTop).toBeCloseTo(offset);
  expect(anchor.querySelector("img")).toBe(image);
});

it.each([false,true])('NSFW filters each tile without media requests; privacy=%s',async privacy=>{
  const {PrivacyProvider}=await import('../privacy/PrivacyContext');
  const items=[{...asset(0),contentRating:'g' as const},{...asset(1),contentRating:'s' as const},{...asset(2),contentRating:'q' as const},{...asset(3),contentRating:'e' as const},asset(4),videoAsset(5)];
  const {container}=render(<PrivacyProvider privacyMode={privacy} setPrivacyMode={vi.fn()} nsfwFilter><AssetGallery layout="masonry" items={items}/></PrivacyProvider>);
  expect(container.querySelectorAll('[data-asset-id]')).toHaveLength(6);
  expect(container.querySelectorAll('img[src]')).toHaveLength(privacy?0:1);
  expect(container.querySelector('video[src]')).toBeNull();
  expect(container.querySelectorAll('.privacy-mask')).toHaveLength(privacy?6:5);
});

it.each(["justified", "masonry"] as const)("keeps a folder shelf in view when %s grid geometry changes at the top", layout => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("asset-gallery__intro") ? { ...original.call(this), height: 380 } : original.call(this);
  });
  const leaf = JSON.stringify({ classificationId: "leaf" }), folder = JSON.stringify({ classificationId: "manga" });
  const page1 = Array.from({ length: 100 }, (_, index) => asset(index));
  // A 100-item page is under the 120-item aspect sample, so page 2 changes the row height.
  const page2 = [...page1, ...Array.from({ length: 100 }, (_, index) => ({ ...asset(100 + index), width: 400 }))];
  const intro = <section>폴더 11</section>;
  const { container, rerender } = render(<AssetGallery layout={layout} items={page1.map(item => ({ ...item, id: `leaf-${item.id}` }))} scopeKey={leaf} groupDates={false} />);
  const scroller = container.querySelector<HTMLElement>(".asset-gallery__scroll")!;
  scroller.scrollTop = 900; fireEvent.scroll(scroller);
  rerender(<AssetGallery layout={layout} intro={intro} items={page1} scopeKey={folder} groupDates={false} hasNextPage />);
  expect(scroller.scrollTop).toBe(0);
  rerender(<AssetGallery layout={layout} intro={intro} items={page2} scopeKey={folder} groupDates={false} />);
  expect(scroller.scrollTop).toBe(0);
  // Inside the shelf the position is kept; a grid position is still anchored by the existing tests.
  scroller.scrollTop = 200; fireEvent.scroll(scroller);
  rerender(<AssetGallery layout={layout} intro={intro} items={page1} scopeKey={folder} groupDates={false} />);
  expect(scroller.scrollTop).toBe(200);
});
