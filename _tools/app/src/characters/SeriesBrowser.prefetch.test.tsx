import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FOLDER_PREFETCH_DWELL_MS, FolderPrefetchContext, invalidateFolderPrefetch, resetFolderPrefetch, useFolderPrefetchIntent, type FolderPrefetchPlan } from "../assets/folderPrefetch";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSort, AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import { planFolderPrefetch } from "../app/folderPrefetchPlan";
import { publishSeriesDataRevision } from "./seriesMountCache";
import { FolderKindSwitch } from "./CharacterFolderContent";
import * as viewportImages from "../shared/motion/viewportImages";
import { createCharacterFixture } from "./characterFixtures";
import { characterHubApi, type CharacterHubApi, type SeriesFolder } from "./hubApi";
import { prefetchSeriesOverview, seriesFolderBrowseView, SeriesBrowser } from "./SeriesBrowser";
import { emptyShadowSummary, shadowReviewApi, type ShadowReviewApi } from "./shadowReviewApi";
import { suggestionApi } from "./suggestions/client";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: vi.fn(async () => []), ignored: vi.fn(async () => []) } };
});

// A hover prefetch of a series starts the reads its switch gates on; the switch then takes them.
const asset = (series: string, index: number): AssetSummary => ({
  id: `${series}-asset-${index}`, title: null, originalName: `${series} ${index}.webp`, byteSize: 1, width: 1000, height: 1000,
  collectedAt: "2026-10-05T01:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null,
  creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" }, thumbnailRevision: `${index + 1}0`,
});
const folders: Record<string, SeriesFolder[]> = {
  "series-a": [{ classificationId: "a-folder", thumbnailAssetId: null }],
  "series-b": [],
};
const classifications: ClassificationEntry[] = [
  { id: "series-a", name: "A 시리즈", kind: "root", parentId: null, iconKey: null, colorKey: null },
  { id: "series-b", name: "B 시리즈", kind: "root", parentId: null, iconKey: null, colorKey: null },
  { id: "a-folder", name: "A 폴더", kind: "tag", parentId: "series-a", iconKey: null, colorKey: null },
];

beforeEach(() => {
  vi.mocked(suggestionApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(suggestionApi.ignored).mockReset().mockResolvedValue([]);
  Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } });
  vi.spyOn(viewportImages, "preloadImages").mockResolvedValue(undefined);
});

function HoverSeries() {
  const intent = useFolderPrefetchIntent();
  return <button {...intent({ kind: "classification", classificationId: "series-a" })}>hover series</button>;
}

function entryHarness(sort: AssetSort = "newest") {
  const gateway = { characterSidebarCounts: vi.fn(async () => ({ targets: {}, groups: {} })) } as unknown as LibraryGateway;
  const api = createCharacterFixture();
  const browse = vi.spyOn(characterHubApi, "browse").mockImplementation(async query => ({ items: [asset(query.seriesId, 0)], nextCursor: null, totalCount: 1 }));
  const excluded = vi.spyOn(characterHubApi, "excludedAssets").mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
  const shelf = vi.spyOn(characterHubApi, "seriesFolders").mockResolvedValue([]);
  const candidates = vi.spyOn(shadowReviewApi, "page").mockResolvedValue({ summary: emptyShadowSummary(), items: [], nextOffset: null, policyVersion: null });
  const series = [{ classificationId: "series-a", heroAssetId: null, autoClassify: true }];
  let version = 0;
  const tree = (open: boolean, nextVersion = version) => {
    version = nextVersion;
    publishSeriesDataRevision(gateway, undefined, version);
    const plan: FolderPrefetchPlan = target => planFolderPrefetch(target, { current: { kind: "classification", classificationId: "plain" }, gateway, series, classifications, sort });
    return <LibraryProvider gateway={gateway}><FolderPrefetchContext.Provider value={{ current: plan }}>
      <HoverSeries />
      <FolderKindSwitch kind={open ? "series" : "plain"}>{open ? <SeriesBrowser
        series={series[0]} targets={[]} classifications={classifications} galleryLayout="justified" privacyMode={false} metadataVisible thumbnailRowHeight={180}
        sort={sort} onSortChange={() => undefined} refreshVersion={version} api={api}
        onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
        onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined}
      /> : <section aria-label="plain" aria-busy={false}>plain folder</section>}</FolderKindSwitch>
    </FolderPrefetchContext.Provider></LibraryProvider>;
  };
  const reads = () => ({ suggestions: vi.mocked(suggestionApi.list).mock.calls.length, ignored: vi.mocked(suggestionApi.ignored).mock.calls.length,
    counts: vi.mocked(gateway.characterSidebarCounts!).mock.calls.length, browse: browse.mock.calls.length, excluded: excluded.mock.calls.length,
    folders: shelf.mock.calls.length, candidates: candidates.mock.calls.length });
  return { tree, reads, browse, gateway };
}

it("reuses both global lists on a second SeriesBrowser mount and refetches at a changed revision", async () => {
  const { tree, reads } = entryHarness();
  const view = render(tree(true));
  await waitFor(() => expect(screen.getByRole("region", { name: "A 시리즈" })).toHaveAttribute("aria-busy", "false"));
  view.rerender(tree(false));
  await screen.findByRole("region", { name: "plain" });
  view.rerender(tree(true));
  await screen.findByRole("region", { name: "A 시리즈" });
  expect(reads()).toMatchObject({ suggestions: 1, ignored: 1, counts: 1 });
  view.rerender(tree(true, 1));
  await waitFor(() => expect(reads()).toMatchObject({ suggestions: 2, ignored: 2, counts: 2 }));
});

it("drops the global cache on the App's library-change invalidation even at the same revision", async () => {
  const { tree, reads } = entryHarness();
  const view = render(tree(true));
  await waitFor(() => expect(screen.getByRole("region", { name: "A 시리즈" })).toHaveAttribute("aria-busy", "false"));
  act(() => { invalidateFolderPrefetch(); });
  await waitFor(() => expect(reads()).toMatchObject({ suggestions: 2, ignored: 2, counts: 2 }));
  view.rerender(tree(false));
  await screen.findByRole("region", { name: "plain" });
  view.rerender(tree(true));
  await screen.findByRole("region", { name: "A 시리즈" });
  expect(reads()).toMatchObject({ suggestions: 2, ignored: 2, counts: 2 });
});

it.each(["newest", "oldest", "random", "favorites"] as const)("hover prefetch covers a fresh series mount without duplicate reads (%s)", async sort => {
  const { tree, reads, browse } = entryHarness(sort);
  const view = render(tree(false));
  fireEvent.pointerEnter(screen.getByRole("button", { name: "hover series" }), { pointerType: "mouse" });
  await waitFor(() => expect(reads()).toEqual({ suggestions: 1, ignored: 1, counts: 1, browse: 1, excluded: 1, folders: 1, candidates: 1 }));
  if (sort !== "newest") expect(browse.mock.calls[0][0].view?.sort).toBe(sort);
  view.rerender(tree(true));
  await screen.findByRole("region", { name: "A 시리즈" });
  expect(screen.getByRole("option", { name: "series-a 0.webp" })).toBeInTheDocument();
  expect(reads()).toEqual({ suggestions: 1, ignored: 1, counts: 1, browse: 1, excluded: 1, folders: 1, candidates: 1 });
});

it("consumes a random-sort hover prefetch once through StrictMode mount replay", async () => {
  const { tree, reads, browse } = entryHarness("random");
  const view = render(<StrictMode>{tree(false)}</StrictMode>);
  fireEvent.pointerEnter(screen.getByRole("button", { name: "hover series" }), { pointerType: "mouse" });
  await waitFor(() => expect(reads().browse).toBe(1));
  const pivot = browse.mock.calls[0][0].view?.randomPivot;
  view.rerender(<StrictMode>{tree(true)}</StrictMode>);
  await screen.findByRole("region", { name: "A 시리즈" });
  expect(reads()).toEqual({ suggestions: 1, ignored: 1, counts: 1, browse: 1, excluded: 1, folders: 1, candidates: 1 });
  expect(seriesFolderBrowseView("random")?.randomPivot).toBe(pivot);
});

it("matches the retained 보기 filters when prefetching a sibling series", async () => {
  const { tree, browse, gateway } = entryHarness("oldest");
  render(tree(true));
  await screen.findByRole("option", { name: "series-a 0.webp" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "보기" }));
  await user.click(within(screen.getByRole("radiogroup", { name: "종류" })).getByRole("radio", { name: "영상" }));
  await user.click(within(screen.getByRole("radiogroup", { name: "비율" })).getByRole("radio", { name: "세로형" }));
  const expectedView = { sort: "oldest", randomPivot: null, mediaKind: "videos", aspectRatio: "portrait" };
  await waitFor(() => expect(browse.mock.lastCall?.[0].view).toEqual(expectedView));
  const pending = planFolderPrefetch({ kind: "classification", classificationId: "series-b" }, {
    current: { kind: "classification", classificationId: "series-a" }, gateway, classifications, sort: "oldest",
    series: [{ classificationId: "series-b", heroAssetId: null, autoClassify: true }],
  });
  await Promise.all(pending!);
  expect(browse.mock.lastCall?.[0]).toMatchObject({ seriesId: "series-b", view: expectedView });
});
afterEach(() => { cleanup(); resetFolderPrefetch(); vi.restoreAllMocks(); });

function mount(plan?: FolderPrefetchPlan) {
  const api = createCharacterFixture();
  const browse = vi.fn(async (query: { seriesId: string }) => ({ items: [0, 1, 2].map(index => asset(query.seriesId, index)), nextCursor: null, totalCount: 3 }));
  const hubApi = {
    browse, seriesFolders: vi.fn(async (seriesId: string) => folders[seriesId]),
    excludedAssets: vi.fn(async () => ({ items: [], nextCursor: null, totalCount: 0 })),
  } as unknown as CharacterHubApi;
  const shadowApi = { page: vi.fn(async () => ({ summary: emptyShadowSummary() })) } as unknown as ShadowReviewApi;
  const navigate = vi.fn();
  const tree = (series: string) => <LibraryProvider gateway={{} as LibraryGateway}><FolderPrefetchContext.Provider value={plan ? { current: plan } : null}><SeriesBrowser
    series={{ classificationId: series, heroAssetId: null, autoClassify: true }} targets={[]} groups={[]}
    classifications={classifications} galleryLayout="justified" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={navigate} onChanged={() => undefined} api={api} hubApi={hubApi} shadowApi={shadowApi}
  /></FolderPrefetchContext.Provider></LibraryProvider>;
  const view = render(tree("series-a"));
  const reads = (seriesId: string) => ({
    browse: browse.mock.calls.filter(([query]) => query.seriesId === seriesId).length,
    excluded: vi.mocked(hubApi.excludedAssets).mock.calls.filter(([id]) => id === seriesId).length,
    folders: vi.mocked(hubApi.seriesFolders).mock.calls.filter(([id]) => id === seriesId).length,
    candidates: vi.mocked(shadowApi.page).mock.calls.filter(([request]) => request.seriesId === seriesId).length,
  });
  return { view, tree, hubApi, shadowApi, navigate, reads };
}

it("switches to a prefetched series without reading its first page again", async () => {
  const { view, tree, hubApi, shadowApi, reads } = mount();
  await screen.findByRole("option", { name: "series-a 0.webp" });
  await Promise.all(prefetchSeriesOverview("series-b", hubApi, shadowApi));
  expect(reads("series-b")).toEqual({ browse: 1, excluded: 1, folders: 1, candidates: 1 });
  view.rerender(tree("series-b"));
  expect(await screen.findByRole("option", { name: "series-b 0.webp" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "series-b 2.webp" })).toBeInTheDocument();
  expect(reads("series-b")).toEqual({ browse: 1, excluded: 1, folders: 1, candidates: 1 });
});

it("enters a series with one candidate read and shows the gallery before the count lands", async () => {
  const { view, tree, shadowApi, reads } = mount();
  await screen.findByRole("option", { name: "series-a 0.webp" });
  let land: (count: number) => void = () => undefined;
  vi.mocked(shadowApi.page).mockImplementation(() => new Promise(resolve => {
    land = count => resolve({ items: [], nextOffset: null, policyVersion: null, summary: { ...emptyShadowSummary(), automatic: { pending: count, accepted: 0, rejected: 0 } } });
  }));
  view.rerender(tree("series-b"));
  // The candidate count is still on its way; the new gallery does not wait for it.
  expect(await screen.findByRole("option", { name: "series-b 0.webp" })).toBeInTheDocument();
  expect(reads("series-b").candidates).toBe(1);
  await act(async () => { land(3); });
  await waitFor(() => expect(screen.queryByRole("option", { name: "series-a 0.webp" })).not.toBeInTheDocument());
  expect(reads("series-b").candidates).toBe(1);
});

it("prefetches a series folder card after the pointer rests on it", async () => {
  const plan = vi.fn<FolderPrefetchPlan>(() => null);
  mount(plan);
  const card = await screen.findByRole("button", { name: "A 폴더 폴더 열기" });
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(FOLDER_PREFETCH_DWELL_MS - 1); });
    expect(plan).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(plan).toHaveBeenCalledWith({ kind: "classification", classificationId: "a-folder" });
  } finally { vi.useRealTimers(); }
  await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
});
