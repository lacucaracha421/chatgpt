import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import * as viewportImages from "../shared/motion/viewportImages";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { CharacterTarget } from "./api";
import { createCharacterFixture, fixtureTarget } from "./characterFixtures";
import type { CharacterGroup, CharacterHubApi, SeriesFolder } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";
import type { Suggestion } from "./suggestions/client";

const shelf = vi.hoisted(() => ({ suggestions: [] as Suggestion[] }));
vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: async () => shelf.suggestions, ignored: async () => [] } };
});

// A folder switch waits only for its first screen: the gallery tiles in view first, then the strip
// cards in view, all under cacheable (revisioned) URLs; never a thumbnail an Asset does not have.
const asset = (series: string, index: number, overrides: Partial<AssetSummary> = {}): AssetSummary => ({
  id: `${series}-asset-${index}`, title: null, originalName: `${series} ${index}.webp`, byteSize: 1, width: 1000, height: 1000,
  collectedAt: "2026-10-05T01:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null,
  creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" }, thumbnailRevision: `${index + 1}0`,
  ...overrides,
});
const pages: Record<string, AssetSummary[]> = {
  a: Array.from({ length: 100 }, (_, index) => asset("a", index)),
  b: Array.from({ length: 100 }, (_, index) => index === 1
    ? asset("b", index, { media: { kind: "video", durationMs: 1000, preparationState: "ready", scrubFrameCount: 0 }, thumbnailRevision: null })
    : asset("b", index)),
};
const member = (series: string, index: number): CharacterTarget => ({
  ...fixtureTarget(`${series}-member-${index}`, `${series.toUpperCase()}${index}`),
  seriesClassificationId: `series-${series}`, linkedClassificationId: null,
  thumbnailAssetId: `${series}-portrait-${index}`, thumbnailRevisions: { [`${series}-portrait-${index}`]: `7${index}` },
});
const targets = [...Array.from({ length: 8 }, (_, index) => member("a", index)), ...Array.from({ length: 8 }, (_, index) => member("b", index))];
const groups: CharacterGroup[] = [{ id: "b-group", seriesId: "series-b", name: "B 그룹", revision: 1, targetIds: ["b-member-6", "b-member-7"] }];
const folders: Record<string, SeriesFolder[]> = {
  "series-a": [],
  "series-b": [{ classificationId: "b-folder-0", thumbnailAssetId: "b-folder-cover-0", thumbnailRevision: "90" }, { classificationId: "b-folder-1", thumbnailAssetId: "b-folder-cover-1", thumbnailRevision: "91" }],
};
const classifications: ClassificationEntry[] = [
  { id: "series-a", name: "A 시리즈", kind: "root", parentId: null, iconKey: null, colorKey: null },
  { id: "series-b", name: "B 시리즈", kind: "root", parentId: null, iconKey: null, colorKey: null },
  { id: "b-folder-0", name: "B 폴더 0", kind: "tag", parentId: "series-b", iconKey: null, colorKey: null },
  { id: "b-folder-1", name: "B 폴더 1", kind: "tag", parentId: "series-b", iconKey: null, colorKey: null },
];
const suggestion = (index: number): Suggestion => ({
  tag: `b_character_${index}`, imageCount: 9, bothCount: 9, pixaiCount: 9, canaryCount: 9, seriesId: "series-b", seriesName: "B 시리즈", insideCount: 9,
  sampleAssetIds: [0, 1, 2, 3].map(sample => `b-sample-${index}-${sample}`),
  sampleThumbnailRevisions: Object.fromEntries([0, 1, 2, 3].map(sample => [`b-sample-${index}-${sample}`, `5${index}${sample}`])),
});

beforeEach(() => {
  shelf.suggestions = Array.from({ length: 5 }, (_, index) => suggestion(index));
  Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount() {
  const api = createCharacterFixture();
  const browse = vi.fn(async (query: { seriesId: string }) => ({ items: pages[query.seriesId.slice("series-".length)], nextCursor: "next", totalCount: 400 }));
  const hubApi = {
    browse, seriesFolders: async (seriesId: string) => folders[seriesId],
    excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }),
  } as unknown as CharacterHubApi;
  const shadowApi = { page: async () => ({ summary: emptyShadowSummary() }) } as unknown as ShadowReviewApi;
  const preloads: string[][] = [];
  vi.spyOn(viewportImages, "preloadImages").mockImplementation(async urls => { preloads.push([...urls]); });
  const tree = (series: string) => <LibraryProvider gateway={{} as LibraryGateway}><SeriesBrowser
    series={{ classificationId: series, heroAssetId: null, autoClassify: true }} targets={targets} groups={groups}
    classifications={classifications} galleryLayout="justified" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined} api={api} hubApi={hubApi} shadowApi={shadowApi}
  /></LibraryProvider>;
  const view = render(tree("series-a"));
  await screen.findByRole("option", { name: "a 0.webp" });
  const switchTo = async (series: string, firstTile: string) => {
    const before = preloads.length;
    view.rerender(tree(series));
    await waitFor(() => expect(preloads.length).toBe(before + 1));
    await screen.findByRole("option", { name: firstTile });
    return preloads[before];
  };
  return { switchTo };
}

const shelfImages = () => [...document.querySelectorAll<HTMLImageElement>(".series-characters img")].map(image => image.getAttribute("src"));
const tile = (series: string, index: number) => thumbnailUrl(`${series}-asset-${index}`, `${index + 1}0`);

it("preloads the first screen only: tiles in view first, then the strip cards in view", async () => {
  const { switchTo } = await mount();
  const urls = await switchTo("series-b", "b 0.webp");
  // 850 x 650 px gallery, six square tiles a row: five rows start inside the first screen.
  const tiles = Array.from({ length: 30 }, (_, index) => index).filter(index => index !== 1).map(index => tile("b", index));
  // Six 132 px cards fit 850 px: the group (two portraits), then the first five ungrouped members.
  const strip = [
    thumbnailUrl("b-portrait-6", "76"), thumbnailUrl("b-portrait-7", "77"),
    ...[0, 1, 2, 3, 4].map(index => thumbnailUrl(`b-portrait-${index}`, `7${index}`)),
  ];
  expect(urls).toEqual([...tiles, ...strip]);
  expect(urls.some(url => url.includes("b-sample-"))).toBe(false); // suggestion cards are past the first strip screen
  expect(urls.every(url => /\/v\d+$/.test(url))).toBe(true); // every URL is cacheable
});

it("never requests a thumbnail for a video that has none", async () => {
  const { switchTo } = await mount();
  const urls = await switchTo("series-b", "b 0.webp");
  expect(urls.some(url => url.includes("b-asset-1/") || url.endsWith("b-asset-1"))).toBe(false);
  const video = screen.getByRole("option", { name: "b 1.webp" });
  expect(video.querySelector("img")).toBeNull();
  expect(screen.getByRole("option", { name: "b 2.webp" }).querySelector("img")).toHaveAttribute("src", tile("b", 2));
});

it("shows every strip card and suggestion sample under its revisioned URL", async () => {
  const { switchTo } = await mount();
  await switchTo("series-b", "b 0.webp");
  await waitFor(() => expect(shelfImages()).toContain(thumbnailUrl("b-folder-cover-1", "91")));
  const images = shelfImages();
  expect(images).toEqual(expect.arrayContaining([
    thumbnailUrl("b-portrait-6", "76"), thumbnailUrl("b-portrait-0", "70"),
    thumbnailUrl("b-sample-4-3", "543"), thumbnailUrl("b-folder-cover-0", "90"),
  ]));
  expect(images.every(src => src && /\/v\d+$/.test(src))).toBe(true);
});

it("returns to a folder with the strip URLs it already loaded, so nothing new is requested", async () => {
  const { switchTo } = await mount();
  await waitFor(() => expect(shelfImages()).toHaveLength(8));
  const first = new Set(shelfImages());
  await switchTo("series-b", "b 0.webp");
  const back = await switchTo("series-a", "a 0.webp");
  await waitFor(() => expect(shelfImages().filter(src => src?.includes("a-portrait"))).toHaveLength(8));
  const returned = shelfImages().filter(src => src?.includes("a-portrait"));
  expect(returned.every(src => first.has(src))).toBe(true);
  const stripPreload = back.filter(url => url.includes("a-portrait"));
  expect(stripPreload).toHaveLength(6);
  expect(stripPreload.every(url => first.has(url))).toBe(true);
  // The first-screen tiles come first and stay revisioned on a return as well.
  expect(back.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, index) => tile("a", index)));
});

