import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetGallery } from "./AssetGallery";

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 }, clientWidth: { configurable: true, get: () => 840 }, offsetHeight: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 600 },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AssetGallery", () => {
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

  it("offers quick preview only for image assets", async () => {
    render(<AssetGallery items={[asset(0), videoAsset(1)]} />);

    expect(await screen.findByRole("button", { name: "asset-0.png 빠른 확대 미리보기" })).toBeInTheDocument();
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
    expect(onMoveFocus).toHaveBeenLastCalledWith(5, false);
  });

  it("keeps only one video hover preview active", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    render(<AssetGallery items={[videoAsset(0), videoAsset(1)]} />);
    const first = screen.getByRole("option", { name: "video-0.webm" }).querySelector(".video-tile")!;
    const second = screen.getByRole("option", { name: "video-1.webm" }).querySelector(".video-tile")!;
    fireEvent.pointerEnter(first);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByLabelText("video-0.webm 미리보기")).toBeInTheDocument();
    fireEvent.pointerEnter(second);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByLabelText("video-0.webm 미리보기")).not.toBeInTheDocument();
    expect(screen.getByLabelText("video-1.webm 미리보기")).toBeInTheDocument();
  });

  it("renders scrollbar date lines without a thumb", async () => {
    const getComputedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => name === "--gallery-gap" ? "6px" : "",
      paddingLeft: "6px",
      paddingRight: "6px",
    } as CSSStyleDeclaration);
    const { container } = render(<AssetGallery items={[
      { ...asset(0), collectedAt: "2026-07-30T00:00:00Z" },
      { ...asset(1), collectedAt: "2026-07-30T00:00:00Z" },
      { ...asset(2), collectedAt: "2026-08-01T00:00:00Z" },
      { ...asset(3), collectedAt: "2026-08-02T00:00:00Z" },
    ]} />);
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(4));
    getComputedStyle.mockRestore();

    const scrollbar = container.querySelector(".asset-gallery__scrollbar")!;
    expect(scrollbar.querySelectorAll(".asset-gallery__scrollbar-line").length).toBeGreaterThan(0);
    expect(scrollbar.querySelector(".asset-gallery__scrollbar-thumb")).not.toBeInTheDocument();
    expect(scrollbar).toHaveAttribute("aria-hidden", "true");
  });

  it("shows a date label when hovering a date line", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => name === "--gallery-gap" ? "6px" : "",
      paddingLeft: "6px",
      paddingRight: "6px",
    } as CSSStyleDeclaration);
    const { container } = render(<AssetGallery items={[
      { ...asset(0), collectedAt: "2026-07-30T00:00:00Z" },
      { ...asset(1), collectedAt: "2026-08-01T00:00:00Z" },
      { ...asset(2), collectedAt: "2026-08-02T00:00:00Z" },
    ]} />);
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(3));

    const line = container.querySelector(".asset-gallery__scrollbar-line")!;
    fireEvent.pointerEnter(line);
    const label = await waitFor(() => container.querySelector(".asset-gallery__scrollbar-label"));
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent(/개/);
  });

  it("scrolls when dragging the scrollbar track", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => name === "--gallery-gap" ? "6px" : "",
      paddingLeft: "6px",
      paddingRight: "6px",
    } as CSSStyleDeclaration);
    const tallAsset = (index: number) => ({ ...asset(index), width: 200, height: 600 });
    const items = [
      ...Array.from({ length: 30 }, (_, index) => ({ ...tallAsset(index), collectedAt: "2026-07-30T00:00:00Z" })),
      ...Array.from({ length: 30 }, (_, index) => ({ ...tallAsset(30 + index), collectedAt: "2026-08-01T00:00:00Z" })),
    ];
    const { container } = render(<AssetGallery items={items} />);
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(60));

    const scrollbar = container.querySelector(".asset-gallery__scrollbar") as HTMLElement;
    expect(scrollbar).toBeInTheDocument();
  });
});

function asset(index: number): AssetSummary { return { id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, byteSize: 1, width: 200, height: 200, collectedAt: "2026-07-30T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } }; }
function videoAsset(index: number): AssetSummary { return { ...asset(index), id: `video-${index}`, originalName: `video-${index}.webm`, media: { kind: "video", durationMs: 10_000, preparationState: "ready", scrubFrameCount: 10 } }; }
