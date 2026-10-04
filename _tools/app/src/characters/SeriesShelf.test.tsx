import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetStableImage } from "../privacy/AssetImage";
import { SeriesShelf, SERIES_SHELF_CAP_MS } from "./SeriesShelf";

const rect = { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} };
let decodes: Map<string, (() => void)[]>;
let animate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  decodes = new Map();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: function(this: HTMLImageElement) {
    return new Promise<void>(resolve => {
      const pending = decodes.get(this.getAttribute("src")!) ?? [];
      pending.push(resolve); decodes.set(this.getAttribute("src")!, pending);
    });
  } });
  animate = vi.fn(() => ({ cancel: vi.fn() }));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode; });

const shelf = (scope: string, ready: boolean, suggestions = 2) => <SeriesShelf scope={scope} privacyKey="false" ready={ready}>
  <h3>{scope} 캐릭터 2 · 제안 {suggestions}</h3><button>제안 숨기기</button>
  <AssetStableImage src={`/${scope}-character`} alt={`${scope} character`} />
  <AssetStableImage src={`/${scope}-collage`} alt={`${scope} collage`} />
</SeriesShelf>;
const visible = (container: HTMLElement) => Array.from(container.querySelector(".series-shelf")!.children).filter(node => !node.hasAttribute("aria-hidden"));
const decode = async (src: string) => { await act(async () => { decodes.get(src)?.forEach(resolve => resolve()); }); };

it("keeps the complete old shelf until data and every viewport image decode, then promotes the same tree once", async () => {
  const view = render(shelf("old", true));
  const oldSurface = visible(view.container)[0];
  view.rerender(shelf("new", false, 0));
  expect(visible(view.container)).toHaveLength(1);
  expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터 2 · 제안 2");
  expect(visible(view.container)[0]).toHaveAttribute("inert");
  expect(decodes.has("/new-character")).toBe(false);
  view.rerender(shelf("new", true, 7));
  const prepared = screen.getByAltText("new character");
  fireEvent.load(prepared); fireEvent.load(screen.getByAltText("new collage"));
  await decode("/new-character");
  expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터 2 · 제안 2");
  expect(animate).not.toHaveBeenCalled();
  await decode("/new-collage");
  expect(visible(view.container)).toHaveLength(1);
  expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터 2 · 제안 7");
  expect(screen.getByRole("button", { name: "제안 숨기기" })).toBeInTheDocument();
  expect(screen.getByText("old 캐릭터 2 · 제안 2").closest("[data-shelf-exit]")).toHaveAttribute("aria-hidden", "true");
  expect(view.container.querySelector("[data-shelf-exit]")).toBe(oldSurface);
  expect(screen.getByAltText("new character")).toBe(prepared);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate.mock.calls[0][0]).toEqual([{ opacity: 0, transform: "translateX(16px)" }, { opacity: 1, transform: "none" }]);
  expect((oldSurface as HTMLElement).style.opacity).not.toBe("0");
  await act(async () => { vi.advanceTimersByTime(180); });
  expect(view.container.querySelector("[data-shelf-exit]")).toBe(oldSurface);
  act(() => animate.mock.results[0].value.onfinish());
  expect(view.container.querySelector("[data-shelf-exit]")).toBeNull();
});

it.each([false, true])("caps image preparation only after shelf data is ready (data ready: %s)", async ready => {
  const view = render(shelf("old", true));
  view.rerender(shelf("new", false));
  await act(async () => { vi.advanceTimersByTime(200); });
  view.rerender(shelf("new", ready));
  await act(async () => { vi.advanceTimersByTime(SERIES_SHELF_CAP_MS - 201); });
  expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터");
  await act(async () => { vi.advanceTimersByTime(1); });
  if (!ready) {
    expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터");
    expect(animate).not.toHaveBeenCalled();
    return;
  }
  expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터");
  expect(animate).toHaveBeenCalledTimes(1);
  fireEvent.load(screen.getByAltText("new character"));
  await decode("/new-character");
  expect(animate).toHaveBeenLastCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 150 }));
});

it("uses 120ms opacity for reduced motion and never animates a same-series refresh", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const view = render(shelf("old", true));
  view.rerender(shelf("old", false, 3));
  view.rerender(shelf("old", true, 4));
  expect(animate).not.toHaveBeenCalled();
  view.rerender(shelf("new", true));
  await decode("/new-character"); await decode("/new-collage");
  expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 120 }));
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender(shelf("new", true, 8));
  expect(animate).toHaveBeenCalledTimes(1);
});

it("cancels superseded preparation and keeps the old shelf on a rapid return", async () => {
  const view = render(shelf("old", true));
  view.rerender(shelf("new", true));
  view.rerender(shelf("old", true));
  await decode("/new-character"); await decode("/new-collage");
  await act(async () => { vi.advanceTimersByTime(500); });
  expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터");
  expect(animate).not.toHaveBeenCalled();
});

it("never starts a translucent incoming shelf without opaque old paint, including rapid switches", async () => {
  animate.mockImplementation(function(this: HTMLElement) {
    const old = this.parentElement?.querySelector<HTMLElement>("[data-shelf-exit]");
    expect(old).not.toBeNull();
    expect(old!.style.opacity).not.toBe("0");
    expect(old!.getAnimations?.() ?? []).toHaveLength(0);
    return { cancel: vi.fn(), onfinish: null };
  });
  const view = render(shelf("old", true));
  const host = view.container.querySelector(".series-shelf");
  view.rerender(shelf("new", true));
  const prepared = screen.getByAltText<HTMLImageElement>("new character");
  await decode("/new-character"); await decode("/new-collage");
  expect(animate).toHaveBeenCalledTimes(1);
  // Readiness already decoded this actual DOM element; a queued load must not hide it again.
  fireEvent.load(prepared);
  expect(prepared.style.opacity).toBe("");
  await decode("/new-character");
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender(shelf("third", true));
  expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터");
  expect(animate.mock.results[0].value.cancel).toHaveBeenCalled();
  await decode("/third-character"); await decode("/third-collage");
  expect(animate).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector(".series-shelf")).toBe(host);
  expect(view.container.querySelector("[data-shelf-exit]")).toHaveTextContent("new 캐릭터");
  act(() => animate.mock.results[1].value.onfinish());
  expect(view.container.querySelector("[data-shelf-exit]")).toBeNull();
});
