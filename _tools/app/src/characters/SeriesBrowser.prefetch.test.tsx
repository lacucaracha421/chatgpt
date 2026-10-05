import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FOLDER_PREFETCH_DWELL_MS, FolderPrefetchContext, resetFolderPrefetch, type FolderPrefetchPlan } from "../assets/folderPrefetch";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import * as viewportImages from "../shared/motion/viewportImages";
import { createCharacterFixture } from "./characterFixtures";
import type { CharacterHubApi, SeriesFolder } from "./hubApi";
import { prefetchSeriesOverview, SeriesBrowser } from "./SeriesBrowser";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: async () => [], ignored: async () => [] } };
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
  Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } });
  vi.spyOn(viewportImages, "preloadImages").mockResolvedValue(undefined);
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
