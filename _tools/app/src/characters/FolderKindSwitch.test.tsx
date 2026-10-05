import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { AreaEntering, READY_CAP_MS } from "../shared/motion/AreaSwitch";
import { REVEAL_HOLD_ATTRIBUTE } from "../shared/motion/viewportImages";
import { StableImage } from "../shared/ui/StableImage";
import { FolderKindSwitch } from "./CharacterFolderContent";
import { createCharacterFixture, fixtureClassifications } from "./characterFixtures";
import type { CharacterHubApi, SeriesFolder } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";
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
  await waitFor(() => expect(browser("닌텐도")).toBeNull());
  const shown = screen.getByRole("region", { name: "엔필" });
  expect(shown.closest("[data-preparing], [inert]")).toBeNull();
  expect(screen.getAllByRole("img")).toHaveLength(3);
  // No tile faded in on its own, and the switched-in gallery starts no first-load entrance.
  expect(animate).not.toHaveBeenCalled();
  expect(shown).toHaveAttribute("data-entering", "true");
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
  const shadowApi = { page: async () => ({ summary: emptyShadowSummary() }) } as unknown as ShadowReviewApi;
  const view = render(<LibraryProvider gateway={{} as LibraryGateway}><FolderKindSwitch kind="plain"><Browser name="엔필" images={[]} /></FolderKindSwitch></LibraryProvider>);
  view.rerender(<LibraryProvider gateway={{} as LibraryGateway}><FolderKindSwitch kind="series"><SeriesBrowser
    series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets}
    classifications={fixtureClassifications} galleryLayout="masonry" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined} api={api} hubApi={hubApi} shadowApi={shadowApi}
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
