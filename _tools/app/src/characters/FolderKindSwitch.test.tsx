import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Profiler, useContext } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, LibraryGateway } from "../library/types";
import { AssetGallery } from "../assets/AssetGallery";
import { AreaEntering, READY_CAP_MS } from "../shared/motion/AreaSwitch";
import { REVEAL_HOLD_ATTRIBUTE } from "../shared/motion/viewportImages";
import { StableImage } from "../shared/ui/StableImage";
import { FOLDER_SWITCH_HARD_CAP_MS, FolderKindSwitch } from "./CharacterFolderContent";
import { createCharacterFixture, fixtureClassifications } from "./characterFixtures";
import type { CharacterHubApi, SeriesFolder } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { confirmSourceFor } from "./confirmTestKit";
import { suggestionApi } from "./suggestions/client";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: vi.fn(async () => []), ignored: async () => [] } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

// Image decoding is controlled per URL; every image sits inside the first screen.
let decodes: Map<string, ReturnType<typeof deferred<void>>>;
const decode = (src: string) => {
  if (!decodes.has(src)) decodes.set(src, deferred<void>());
  return decodes.get(src)!;
};
let animate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  decodes = new Map();
  animate = vi.fn(() => ({ cancel() {}, onfinish: null }));
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value(this: HTMLImageElement) { return decode(this.src).promise; } });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});
const onScreen = () => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
  .mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });

/** A browser: busy until its first page arrives, then its first-screen tiles. */
function Browser({ name, images }: { name: string; images?: string[] }) {
  const entering = useContext(AreaEntering);
  return <section aria-label={name} aria-busy={!images} data-entering={entering}>
    <div className="asset-gallery">{images?.map(src => <StableImage key={src} src={`https://media.test/${src}`} alt={src} loading="lazy" />)}</div>
  </section>;
}
// Accessible names are empty inside the hidden preparing view, so these look the elements up directly.
const browser = (name: string) => document.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
const image = (alt: string) => document.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
const preparing = (name: string) => browser(name)!.closest("[data-preparing]");
const settle = (images: string[]) => act(async () => {
  for (const name of images) {
    document.querySelectorAll(`img[alt="${name}"]`).forEach(element => element.dispatchEvent(new Event("load")));
    decode(`https://media.test/${name}`).resolve();
  }
});

it("never commits an empty main area on cold or cached series switches before the hard fallback", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  const commits: string[][] = [];
  const tree = (name: string, ready: boolean) => <Profiler id="main" onRender={() => {
    commits.push(Array.from(document.querySelectorAll<HTMLElement>(".folder-kind-switch"))
      .filter(host => host.style.display !== "none" && host.style.opacity !== "0" && host.style.visibility !== "hidden")
      .flatMap(host => Array.from(host.querySelectorAll<HTMLElement>("[data-first-content]"), node => node.textContent!)));
  }}><FolderKindSwitch kind="series" seriesKey={name} cacheScope="no-blank">
    <section aria-label={name} aria-busy={!ready}>{ready && <div data-first-content>{name}</div>}</section>
  </FolderKindSwitch></Profiler>;
  try {
    const view = render(tree("A", true));
    const original = browser("A");
    view.rerender(tree("B", false));
    await act(async () => { vi.advanceTimersByTime(READY_CAP_MS + 100); });
    expect(browser("A")).toBeVisible();
    expect(preparing("B")).not.toBeNull();
    view.rerender(tree("B", true));
    await act(async () => { vi.advanceTimersByTime(40); });
    expect(browser("B")).toBeVisible();
    expect(browser("A")).not.toBeVisible();
    view.rerender(tree("A", true));
    await act(async () => { vi.advanceTimersByTime(40); });
    expect(browser("A")).toBe(original);
    expect(browser("A")).toBeVisible();
    expect(commits.length).toBeGreaterThan(3);
    expect(commits.every(content => content.length === 1)).toBe(true);
    expect(commits[commits.length - 1]).toEqual(["A"]);
  } finally { vi.useRealTimers(); }
});

it("keeps the old series while the incoming gallery has data but has not committed its measured tiles", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
  const measures = new Set<() => void>();
  vi.stubGlobal("ResizeObserver", class {
    private measure?: () => void;
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: HTMLElement) {
      if (element.classList.contains("asset-gallery__scroll")) {
        this.measure = () => this.callback(
          [{ target: element, contentRect: { width: 600, height: 600, x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 600, toJSON() {} },
            borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this as unknown as ResizeObserver);
        measures.add(this.measure);
      }
    }
    unobserve() { this.disconnect(); }
    disconnect() { if (this.measure) measures.delete(this.measure); }
  });
  try {
    const view = render(<FolderKindSwitch kind="series" seriesKey="A"><Browser name="A" images={[]} /></FolderKindSwitch>);
    const asset = { id: "next", title: null, originalName: "next.png", width: 200, height: 200,
      collectedAt: "2026-10-13T00:00:00Z", media: { kind: "image" }, favorite: false } as AssetSummary;
    view.rerender(<FolderKindSwitch kind="series" seriesKey="B"><section aria-label="B" aria-busy={false}>
      <AssetGallery layout="masonry" items={[asset]} />
    </section></FolderKindSwitch>);
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 80)); });
    expect(browser("A")).toBeVisible();
    expect(preparing("B")).not.toBeNull();
    expect(browser("B")!.querySelector("[data-gallery-cell]")).toBeNull();
    // Both gallery metrics and the scrubber observe the host; notify every observer.
    expect(measures.size).toBeGreaterThan(1);
    act(() => { measures.forEach(measure => measure()); });
    await waitFor(() => expect(preparing("B")).toBeNull());
    expect(browser("B")!.querySelector("[data-gallery-cell]")).not.toBeNull();
    expect(browser("A")).not.toBeVisible();
  } finally { vi.unstubAllGlobals(); }
});

it.each(["empty", "error"])("publishes a legitimate %s result without waiting for the hard fallback", async result => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  const tree = (name: string, ready: boolean) => <FolderKindSwitch kind="series" seriesKey={name}>
    <section aria-label={name} aria-busy={!ready}>
      {ready && (result === "empty" ? <AssetGallery layout="masonry" items={[]} /> : <p role="alert">Read failed</p>)}
    </section>
  </FolderKindSwitch>;
  try {
    const view = render(tree("A", true));
    view.rerender(tree("B", false));
    await act(async () => { vi.advanceTimersByTime(READY_CAP_MS + 100); });
    expect(browser("A")).toBeVisible();
    view.rerender(tree("B", true));
    await act(async () => { vi.advanceTimersByTime(40); });
    expect(preparing("B")).toBeNull();
    expect(browser("B")).toBeVisible();
    expect(browser("A")).not.toBeVisible();
    expect(browser("B")!.closest("[inert]")).toBeNull();
  } finally { cleanup(); vi.useRealTimers(); }
});

it.each(["data", "measurement", "frame"])("releases the old series at the hard fallback when %s never finishes", async stalled => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
  if (stalled === "frame") vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  try {
    const view = render(<FolderKindSwitch kind="series" seriesKey="A"><Browser name="A" images={[]} /></FolderKindSwitch>);
    const asset = { id: "next", title: null, originalName: "next.png", width: 200, height: 200,
      collectedAt: "2026-10-13T00:00:00Z", media: { kind: "image" }, favorite: false } as AssetSummary;
    view.rerender(<FolderKindSwitch kind="series" seriesKey="B"><section aria-label="B" aria-busy={stalled === "data"}>
      {stalled === "measurement" && <AssetGallery layout="masonry" items={[asset]} />}
      {stalled === "frame" && <p>Ready</p>}
    </section></FolderKindSwitch>);
    await act(async () => { vi.advanceTimersByTime(FOLDER_SWITCH_HARD_CAP_MS - 1); });
    expect(browser("A")).toBeVisible();
    expect(preparing("B")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(preparing("B")).toBeNull();
    expect(browser("B")).toBeVisible();
    expect(browser("A")).not.toBeVisible();
    expect(browser("B")!.closest("[inert]")).toBeNull();
  } finally { cleanup(); vi.useRealTimers(); }
});

it("cancels the old hard fallback when another series is requested or the switch unmounts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  const tree = (name: string, ready: boolean) => <FolderKindSwitch kind="series" seriesKey={name}>
    <Browser name={name} images={ready ? [] : undefined} />
  </FolderKindSwitch>;
  try {
    const view = render(tree("A", true));
    view.rerender(tree("B", false));
    await act(async () => { vi.advanceTimersByTime(FOLDER_SWITCH_HARD_CAP_MS - 100); });
    view.rerender(tree("C", true));
    await act(async () => { vi.advanceTimersByTime(40); });
    expect(browser("C")).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(FOLDER_SWITCH_HARD_CAP_MS); });
    expect(browser("C")).toBeVisible();
    expect(browser("B")).not.toBeVisible();
    view.rerender(tree("D", false));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { cleanup(); vi.useRealTimers(); }
});

it("keeps the series painted until the plain folder's data and first-screen images are ready, then swaps once", async () => {
  onScreen();
  const view = render(<FolderKindSwitch kind="series"><Browser name="닌텐도" images={["series"]} /></FolderKindSwitch>);
  await settle(["series"]);
  animate.mockClear(); // The very first screen's own late image may fade; only the switch matters here.
  view.rerender(<FolderKindSwitch kind="plain"><Browser name="엔필" /></FolderKindSwitch>);
  expect(browser("닌텐도")!.closest("[inert]")).not.toBeNull();
  expect(preparing("닌텐도")).toBeNull();
  expect(preparing("엔필")).toHaveStyle({ opacity: "0" });

  view.rerender(<FolderKindSwitch kind="plain"><Browser name="엔필" images={["a", "b", "c"]} /></FolderKindSwitch>);
  await settle(["a", "b"]);
  await new Promise(resolve => window.setTimeout(resolve, 80));
  expect(browser("닌텐도")).toBeInTheDocument();
  expect(preparing("엔필")).not.toBeNull();

  await settle(["c"]);
  await waitFor(() => expect(browser("닌텐도")).not.toBeVisible());
  const shown = screen.getByRole("region", { name: "엔필" });
  expect(shown.closest("[data-preparing], [inert]")).toBeNull();
  expect(screen.getAllByRole("img")).toHaveLength(3);
  // No tile faded in on its own, and the switched-in gallery starts no first-load entrance.
  expect(animate).not.toHaveBeenCalled();
  expect(shown).toHaveAttribute("data-entering", "true");
});

it("reuses separate cached series trees and drops them when the library scope changes", async () => {
  const tree = (name: string, scope = "library-a") => <FolderKindSwitch kind="series" seriesKey={name} cacheScope={scope}>
    <Browser name={name} images={[name]} />
  </FolderKindSwitch>;
  const view = render(tree("A"));
  const a = browser("A"), aImage = image("A");
  view.rerender(tree("B"));
  await waitFor(() => expect(browser("A")).not.toBeVisible());
  const b = browser("B"), bImage = image("B");
  view.rerender(tree("A"));
  await waitFor(() => expect(browser("A")).toBeVisible());
  expect(browser("A")).toBe(a); expect(image("A")).toBe(aImage);
  expect(browser("B")).toBe(b); expect(image("B")).toBe(bImage);
  view.rerender(tree("A", "library-b"));
  await waitFor(() => expect(a).not.toBeInTheDocument());
  expect(b).not.toBeInTheDocument();
  expect(browser("A")).not.toBe(a);
});

it("swaps at the cap and holds the still-loading first-screen images for one shared reveal", async () => {
  onScreen();
  const view = render(<FolderKindSwitch kind="plain"><Browser name="엔필" images={["old"]} /></FolderKindSwitch>);
  await settle(["old"]);
  animate.mockClear();
  const started = performance.now();
  view.rerender(<FolderKindSwitch kind="series"><Browser name="닌텐도" images={["fast", "late"]} /></FolderKindSwitch>);
  await settle(["fast"]);
  await waitFor(() => expect(browser("엔필")).toBeNull(), { timeout: READY_CAP_MS * 2 });
  expect(performance.now() - started).toBeGreaterThanOrEqual(READY_CAP_MS - 50);
  const late = image("late");
  expect(late).toHaveAttribute(REVEAL_HOLD_ATTRIBUTE);
  await settle(["late"]);
  await waitFor(() => expect(late).not.toHaveAttribute(REVEAL_HOLD_ATTRIBUTE));
  expect(animate).not.toHaveBeenCalled();
}, 5000);

it("opens a series from a plain folder only once its suggestion cards are in the shelf", async () => {
  const suggestions = deferred<Awaited<ReturnType<typeof suggestionApi.list>>>();
  vi.mocked(suggestionApi.list).mockReturnValue(suggestions.promise);
  const api = createCharacterFixture(), targets = await api.targets();
  const folders = deferred<SeriesFolder[]>();
  const hubApi = { browse: async () => ({ items: [], nextCursor: null, totalCount: 0 }), seriesFolders: () => folders.promise,
    excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const confirmSource = confirmSourceFor();
  const view = render(<LibraryProvider gateway={{} as LibraryGateway}><FolderKindSwitch kind="plain"><Browser name="엔필" images={[]} /></FolderKindSwitch></LibraryProvider>);
  view.rerender(<LibraryProvider gateway={{} as LibraryGateway}><FolderKindSwitch kind="series"><SeriesBrowser
    series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets}
    classifications={fixtureClassifications} galleryLayout="masonry" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined} api={api} hubApi={hubApi} confirmSource={confirmSource}
  /></FolderKindSwitch></LibraryProvider>);
  await act(async () => { folders.resolve([]); });
  await new Promise(resolve => window.setTimeout(resolve, 80));
  const series = document.querySelector<HTMLElement>(".series-browser")!;
  expect(series.closest("[data-preparing]")).not.toBeNull();
  expect(screen.getByRole("region", { name: "엔필" })).toBeInTheDocument();
  await act(async () => { suggestions.resolve([{ tag: "new_suggestion", seriesId: "series", seriesName: "Series", imageCount: 7,
    bothCount: 7, canaryCount: 7, pixaiCount: 7, insideCount: 7, sampleAssetIds: ["sample-a"] }]); });
  await waitFor(() => expect(series.closest("[data-preparing]")).toBeNull());
  expect(browser("엔필")).toBeNull();
  expect(series.querySelector(".character-suggestion-tile__mosaic")).not.toBeNull();
});
