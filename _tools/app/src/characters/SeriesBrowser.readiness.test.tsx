import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { viewReady } from "../shared/motion/AreaSwitch";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import type { CharacterHubApi, SeriesFolder } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";
import { suggestionApi } from "./suggestions/client";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: vi.fn(async () => []), ignored: async () => [] } };
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 },
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount() {
  const api = createCharacterFixture(), targets = await api.targets();
  const folders = deferred<SeriesFolder[]>(), counts = deferred<{ targets: Record<string, number> }>();
  const browse = vi.fn().mockResolvedValue({ items: fixtureAssets.slice(5), nextCursor: null, totalCount: 13 });
  const hubApi = { browse, seriesFolders: () => folders.promise, excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const shadowApi = { page: async () => ({ summary: emptyShadowSummary() }) } as unknown as ShadowReviewApi;
  const gateway = { characterSidebarCounts: () => counts.promise } as unknown as LibraryGateway;
  const result = render(<LibraryProvider gateway={gateway}><SeriesBrowser
    series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets}
    classifications={fixtureClassifications} galleryLayout="masonry" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined} api={api} hubApi={hubApi} shadowApi={shadowApi}
  /></LibraryProvider>);
  await screen.findByRole("option", { name: "이미지 5.webp" });
  return { ...result, folders, counts, browse };
}

it("waits for the folder shelf and character counts after the asset page arrives", async () => {
  const { container, folders, counts } = await mount();
  expect(viewReady(container)).toBe(false);
  const card = screen.getByRole("button", { name: "히나 열기" });
  const count = card.querySelector(".folder-shelf__meta");
  expect(count).not.toBeNull();
  expect(count).toBeEmptyDOMElement();
  await act(async () => { folders.resolve([]); });
  expect(viewReady(container)).toBe(false);
  await act(async () => { counts.resolve({ targets: { hina: 27 } }); });
  await waitFor(() => expect(viewReady(container)).toBe(true));
  expect(card.querySelector(".folder-shelf__meta")).toBe(count);
  expect(count).toHaveTextContent("27장");
});

it("settles failed shelf and count reads instead of leaving the incoming folder busy", async () => {
  const { container, folders, counts } = await mount();
  expect(viewReady(container)).toBe(false);
  await act(async () => { folders.reject(new Error("folder read failed")); counts.reject(new Error("count read failed")); });
  await waitFor(() => expect(viewReady(container)).toBe(true));
  expect(screen.getByRole("alert")).toHaveTextContent("folder read failed");
});

it("waits for suggestions that can add the first shelf cards", async () => {
  const suggestions = deferred<Awaited<ReturnType<typeof suggestionApi.list>>>();
  vi.spyOn(suggestionApi, "list").mockReturnValue(suggestions.promise);
  const { container, folders, counts } = await mount();
  await act(async () => { folders.resolve([]); counts.resolve({ targets: {} }); });
  expect(viewReady(container)).toBe(false);
  await act(async () => { suggestions.resolve([]); });
  await waitFor(() => expect(viewReady(container)).toBe(true));
});

it("keeps the outgoing page scroll position until the next filter page arrives", async () => {
  const { container, folders, counts, browse } = await mount();
  await act(async () => { folders.resolve([]); counts.resolve({ targets: {} }); });
  await waitFor(() => expect(viewReady(container)).toBe(true));
  const scroller = container.querySelector<HTMLElement>(".asset-gallery__scroll")!;
  scroller.scrollTop = 300;
  fireEvent.scroll(scroller);
  const page = deferred<{ items: typeof fixtureAssets; nextCursor: null; totalCount: number }>();
  browse.mockReturnValue(page.promise);
  await userEvent.click(screen.getByRole("radio", { name: "전체" }));
  expect(scroller.scrollTop).toBe(300);
  expect(container.querySelector(".series-gallery")).toHaveAttribute("inert");
  await act(async () => { page.resolve({ items: fixtureAssets, nextCursor: null, totalCount: fixtureAssets.length }); });
  expect(scroller.scrollTop).toBe(0);
});
