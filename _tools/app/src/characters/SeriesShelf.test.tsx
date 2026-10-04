import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AssetStableImage } from "../privacy/AssetImage";
import { SeriesShelf, SERIES_SHELF_CAP_MS, SERIES_VIEW_TRANSITION_ATTRIBUTE } from "./SeriesShelf";

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

describe("with browser view transitions", () => {
  let entries: { update: () => void; finish: () => void; skipTransition: ReturnType<typeof vi.fn> }[];
  let start: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    entries = [];
    start = vi.fn((update: () => void) => {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const entry = { update, finish, skipTransition: vi.fn() };
      entries.push(entry);
      return { ready: Promise.resolve(), finished, skipTransition: entry.skipTransition };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    document.documentElement.removeAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE);
    document.documentElement.removeAttribute("data-area-view-transition");
  });
  const pathShelf = (scope: string, path: string[], suggestions = 2) => <SeriesShelf scope={scope} path={path} privacyKey="false" ready>
    <h3>{scope} 캐릭터 2 · 제안 {suggestions}</h3><button>제안 숨기기</button>
    <AssetStableImage src={`/${scope}-character`} alt={`${scope} character`} />
  </SeriesShelf>;
  const host = (container: HTMLElement) => container.querySelector(".series-shelf")!;

  it("commits header, button and the prepared tree inside the callback without the custom entrance", async () => {
    const view = render(shelf("old", true));
    view.rerender(shelf("new", true, 7));
    const prepared = screen.getByAltText("new character");
    await decode("/new-character");
    expect(start).not.toHaveBeenCalled();
    await decode("/new-collage");
    expect(start).toHaveBeenCalledTimes(1);
    expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터 2 · 제안 2");
    expect(document.documentElement).toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE, "forward");
    expect(host(view.container)).toHaveAttribute("data-series-shelf-transition");
    act(() => {
      entries[0].update();
      // Assertions inside act catch a deferred React commit before the browser's new snapshot.
      expect(visible(view.container)).toHaveLength(1);
      expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터 2 · 제안 7");
      expect(screen.getByRole("button", { name: "제안 숨기기" })).toBeInTheDocument();
      expect(screen.getByAltText("new character")).toBe(prepared);
      expect(view.container.querySelector("[data-shelf-exit]")).toBeNull();
    });
    expect(screen.queryByText("old 캐릭터 2 · 제안 2")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    await act(async () => entries[0].finish());
    expect(document.documentElement).not.toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE);
    expect(host(view.container)).not.toHaveAttribute("data-series-shelf-transition");
    view.rerender(shelf("new", true, 8));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("enters from the side of travel: deeper or sibling forward, back to the parent backward", async () => {
    const view = render(pathShelf("series", ["root", "series"]));
    view.rerender(pathShelf("group", ["root", "series", "group"]));
    await decode("/group-character");
    expect(document.documentElement).toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE, "forward");
    act(() => entries[0].update());
    await act(async () => entries[0].finish());
    view.rerender(pathShelf("series", ["root", "series"]));
    await decode("/series-character");
    expect(document.documentElement).toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE, "back");
    act(() => entries[1].update());
    await act(async () => entries[1].finish());
    view.rerender(pathShelf("other", ["root", "other"]));
    await decode("/other-character");
    expect(document.documentElement).toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE, "forward");
  });

  it("skips a pending transition on a rapid switch and never commits its stale callback", async () => {
    const view = render(shelf("old", true));
    view.rerender(shelf("new", true));
    await decode("/new-character"); await decode("/new-collage");
    expect(start).toHaveBeenCalledTimes(1);
    view.rerender(shelf("third", true));
    expect(entries[0].skipTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE);
    act(() => entries[0].update());
    expect(visible(view.container)[0]).toHaveTextContent("old 캐릭터");
    await act(async () => entries[0].finish());
    await decode("/third-character"); await decode("/third-collage");
    expect(start).toHaveBeenCalledTimes(2);
    expect(document.documentElement).toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE, "forward");
    act(() => entries[1].update());
    expect(visible(view.container)[0]).toHaveTextContent("third 캐릭터");
    expect(animate).not.toHaveBeenCalled();
  });

  it("skips a running transition when the next series is requested", async () => {
    const view = render(shelf("old", true));
    view.rerender(shelf("new", true));
    await decode("/new-character"); await decode("/new-collage");
    act(() => entries[0].update());
    view.rerender(shelf("third", true));
    expect(entries[0].skipTransition).toHaveBeenCalledTimes(1);
    expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터");
    await decode("/third-character"); await decode("/third-collage");
    expect(start).toHaveBeenCalledTimes(2);
    // The skipped transition's late finish must not clear the next one's names.
    await act(async () => entries[0].finish());
    expect(document.documentElement).toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE, "forward");
  });

  it("commits instantly while an area view transition owns the document", async () => {
    const view = render(shelf("old", true));
    document.documentElement.setAttribute("data-area-view-transition", "");
    view.rerender(shelf("new", true, 7));
    await decode("/new-character"); await decode("/new-collage");
    expect(start).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
    expect(visible(view.container)).toHaveLength(1);
    expect(visible(view.container)[0]).toHaveTextContent("new 캐릭터 2 · 제안 7");
    expect(view.container.querySelector("[data-shelf-exit]")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE);
  });

  it("skips the transition and clears its names on unmount", async () => {
    const view = render(shelf("old", true));
    view.rerender(shelf("new", true));
    await decode("/new-character"); await decode("/new-collage");
    view.unmount();
    expect(entries[0].skipTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveAttribute(SERIES_VIEW_TRANSITION_ATTRIBUTE);
  });
});

it("scopes the shelf name under its own html attribute, apart from the area names", () => {
  const css = readFileSync("src/characters/SeriesBrowser.css", "utf8");
  const named = css.split("\n").filter(line => line.includes("view-transition-name"));
  expect(named).toEqual(["html[data-series-view-transition] .series-shelf[data-series-shelf-transition] { view-transition-name: series-shelf; }"]);
  expect(css).toMatch(/::view-transition-old\(series-shelf\) \{ animation: series-shelf-out 90ms/);
  expect(css).toMatch(/="forward"\]::view-transition-new\(series-shelf\) \{ animation: series-shelf-in-forward 240ms var\(--spring-gentle\)/);
  expect(css).toMatch(/="back"\]::view-transition-new\(series-shelf\) \{ animation: series-shelf-in-back 240ms var\(--spring-gentle\)/);
  expect(css).toMatch(/prefers-reduced-motion: reduce\)[^@]*series-shelf-fade-in 120ms/);
  const area = readFileSync("src/shared/motion/viewTransitions.css", "utf8");
  expect(area).not.toContain("series-shelf");
});
