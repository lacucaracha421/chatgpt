import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { AssetGallery } from "./AssetGallery";

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 }, clientWidth: { configurable: true, get: () => 840 }, offsetHeight: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 600 },
  setPointerCapture: { configurable: true, value: vi.fn() },
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

    const row = await waitFor(() => container.querySelector(".asset-gallery__row") as HTMLElement);
    const tile = row.querySelector(".asset-gallery__asset") as HTMLElement;
    expect(Number.parseFloat(row.style.height)).toBe(Number.parseFloat(tile.style.height) + 6);
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
    expect(first.querySelector(".asset-gallery__selection-indicator")).not.toBeNull();
    expect(second.querySelector(".asset-gallery__selection-indicator")).toBeNull();
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

  it("keeps scrolling on the native container with a visual-only overlay scrollbar", async () => {
    const { container } = render(<AssetGallery items={[asset(0)]} />);

    await screen.findByRole("option", { name: "asset-0.png" });
    expect(container.querySelector(".asset-gallery__date-rail")).toBeNull();
    expect(container.querySelector(".asset-gallery__scroll")).toHaveAttribute("data-native-scrollbar", "true");
    // The overlay draws the thumb (native thumb length cannot be floored);
    // it stays out of the way while everything fits.
    const overlay = container.querySelector(".asset-gallery__scrollbar") as HTMLElement;
    expect(overlay.style.visibility).toBe("hidden");
    expect(overlay.style.pointerEvents).toBe("none");
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

    // 200px squares in an 840px gallery (6px gap from tokens) form rows of 5
    // at 164.8px; 100 total items estimate 25 rows: 25 * 175.4 = 4385.
    const space = await waitFor(() =>
      container.querySelector(".asset-gallery__virtual-space") as HTMLElement,
    );
    expect(space.style.height).toBe("4385px");
  });

  it("sizes the virtual space from measured rows without a total count", async () => {
    const { container } = render(
      <AssetGallery items={Array.from({ length: 8 }, (_, index) => asset(index))} hasNextPage />,
    );

    const space = await waitFor(() =>
      container.querySelector(".asset-gallery__virtual-space") as HTMLElement,
    );
    expect(space.style.height).toBe("350.8px");
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

  it("floors the overlay thumb at 32px for a huge reserved range", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100000}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );

    const thumb = await waitFor(() =>
      container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement,
    );
    expect(thumb.style.height).toBe("32px");
  });

  it("moves the overlay thumb with the scroll position", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    scroller.scrollTop = 1892.5;
    fireEvent.scroll(scroller);

    const thumb = container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement;
    // Reserved 4385px, viewport 600px: thumb 82px over 518px of travel.
    expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(82.06, 0);
    const top = Number.parseFloat(thumb.style.transform.replace("translateY(", ""));
    expect(top).toBeCloseTo(259, 0);
  });

  it("drags the overlay thumb to scroll", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    const thumb = container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement;
    fireEvent.pointerDown(thumb, { pointerId: 7, clientY: 100 });
    fireEvent.pointerMove(thumb, { pointerId: 7, clientY: 200 });
    fireEvent.pointerUp(thumb, { pointerId: 7 });

    // 100px over 518px of travel maps onto 3785px of scroll range.
    expect(scroller.scrollTop).toBeCloseTo(730.8, 0);
  });

  it("ignores hovers after a release outside the thumb", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    const thumb = container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement;
    fireEvent.pointerDown(thumb, { pointerId: 7, clientY: 100 });
    fireEvent.pointerMove(thumb, { pointerId: 7, clientY: 200 });
    expect(scroller.scrollTop).toBeCloseTo(730.8, 0);

    // The release lands outside the thumb (missed capture): later hovers
    // must not keep scrolling as if still grabbed.
    fireEvent.pointerUp(window, { pointerId: 7 });
    fireEvent.pointerMove(thumb, { pointerId: 7, clientY: 400, buttons: 0 });

    expect(scroller.scrollTop).toBeCloseTo(730.8, 0);
  });

  it("ignores a thumb drag started with a non-primary button", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    const thumb = container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement;
    fireEvent.pointerDown(thumb, { pointerId: 7, button: 2, clientY: 100 });
    fireEvent.pointerMove(thumb, { pointerId: 7, button: 2, clientY: 300 });

    expect(scroller.scrollTop).toBe(0);
  });

  it("forwards wheel input landing on the overlay strip", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    const track = container.querySelector(".asset-gallery__scrollbar") as HTMLElement;
    fireEvent.wheel(track, { deltaY: 100 });

    expect(scroller.scrollTop).toBe(100);
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
    expect(space().style.height).toBe("4385px");

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

    expect(space().style.height).not.toBe("4385px");
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
    expect(space().style.height).toBe("4385px");

    rerender(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );

    expect(space().style.height).toBe("350.8px");
  });

  it("jumps the track click to the matching scroll position", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });

    const track = container.querySelector(".asset-gallery__scrollbar") as HTMLElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      top: 100, height: 600, bottom: 700, left: 0, right: 0, width: 0, x: 0, y: 100,
    } as DOMRect);
    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    fireEvent.pointerDown(track, { clientY: 400 });

    expect(scroller.scrollTop).toBeCloseTo(1892.5, 0);
  });

  it("keeps the overlay thumb steady when pages append at the same offset", async () => {
    const onLoadNextPage = vi.fn();
    const { container, rerender } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={onLoadNextPage}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });
    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    scroller.scrollTop = 1000;
    fireEvent.scroll(scroller);
    const thumb = () =>
      container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement;
    const before = thumb().style.transform;

    rerender(
      <AssetGallery
        items={Array.from({ length: 24 }, (_, index) => asset(index))}
        totalCount={100}
        hasNextPage
        onLoadNextPage={onLoadNextPage}
      />,
    );
    await screen.findByRole("option", { name: "asset-23.png" });

    expect(scroller.scrollTop).toBe(1000);
    expect(thumb().style.transform).toBe(before);
  });

  it("recovers the overlay thumb when styles arrive after mount", async () => {
    const { container } = render(
      <AssetGallery
        items={Array.from({ length: 8 }, (_, index) => asset(index))}
        totalCount={100000}
        hasNextPage
        onLoadNextPage={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "asset-0.png" });
    const overlay = container.querySelector(".asset-gallery__scrollbar") as HTMLElement;
    const scroller = container.querySelector(".asset-gallery__scroll") as HTMLElement;
    expect(overlay.style.visibility).toBe("visible");

    // Simulate a first paint before the stylesheet applies: zero track size
    // must hide the control without latching it hidden forever.
    Object.defineProperty(overlay, "clientHeight", { configurable: true, get: () => 0 });
    fireEvent.scroll(scroller);
    expect(overlay.style.visibility).toBe("hidden");

    delete (overlay as unknown as Record<string, unknown>).clientHeight;
    fireEvent.scroll(scroller);
    expect(overlay.style.visibility).toBe("visible");
    const thumb = container.querySelector(".asset-gallery__scrollbar-thumb") as HTMLElement;
    expect(thumb.style.height).toBe("32px");
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
