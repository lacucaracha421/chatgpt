import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

it("keeps the complete old shelf until data and every viewport image decode, then promotes the same tree in one step without animation", async () => {
  const view = render(shelf("old", true));
  const host = view.container.querySelector(".series-shelf");
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
  await decode("/new-collage");
  // One step (user 2026-10-05): the old shelf is gone in the same commit, nothing slides or fades.
  expect(view.container.querySelector(".series-shelf")!.children).toHaveLength(1);
  expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터 2 · 제안 7");
  expect(screen.queryByText("old 캐릭터 2 · 제안 2")).toBeNull();
  expect(screen.getByRole("button", { name: "제안 숨기기" })).toBeInTheDocument();
  expect(screen.getByAltText("new character")).toBe(prepared);
  expect(view.container.querySelector(".series-shelf")).toBe(host);
  expect(animate).not.toHaveBeenCalled();
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
  expect(animate).not.toHaveBeenCalled();
  // Only the late image's own arrival fades; the shelf itself never moves.
  fireEvent.load(screen.getByAltText("new character"));
  await decode("/new-character");
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenLastCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 150 }));
});

it("swaps in one step with reduced motion too and never touches a same-series refresh", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const view = render(shelf("old", true));
  view.rerender(shelf("old", false, 3));
  view.rerender(shelf("old", true, 4));
  expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터 2 · 제안 4");
  view.rerender(shelf("new", true));
  await decode("/new-character"); await decode("/new-collage");
  expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터");
  view.rerender(shelf("new", true, 8));
  expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터 2 · 제안 8");
  expect(animate).not.toHaveBeenCalled();
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

it("keeps the shown shelf through a rapid switch and promotes only the latest one", async () => {
  const view = render(shelf("old", true));
  view.rerender(shelf("new", true));
  view.rerender(shelf("third", true));
  await decode("/new-character"); await decode("/new-collage");
  expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터");
  await decode("/third-character"); await decode("/third-collage");
  expect(visible(view.container)[0]).toHaveTextContent("third 캐릭터");
  expect(view.container.querySelector(".series-shelf")!.children).toHaveLength(1);
  expect(animate).not.toHaveBeenCalled();
});

it("never starts a browser view transition for a shelf move", async () => {
  const start = vi.fn();
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  try {
    const view = render(shelf("old", true));
    view.rerender(shelf("new", true, 7));
    await decode("/new-character"); await decode("/new-collage");
    expect(start).not.toHaveBeenCalled();
    expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터 2 · 제안 7");
    expect(document.documentElement).not.toHaveAttribute("data-series-view-transition");
  } finally { Reflect.deleteProperty(document, "startViewTransition"); }
});

it("has no shelf transition styles left", () => {
  const css = readFileSync("src/characters/SeriesBrowser.css", "utf8");
  expect(css).not.toContain("view-transition");
  expect(css).not.toContain("series-shelf-in");
});
