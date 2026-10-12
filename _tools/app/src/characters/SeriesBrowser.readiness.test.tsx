import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { viewReady } from "../shared/motion/AreaSwitch";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import type { CharacterHubApi, SeriesFolder } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { s36PublicationApi } from "./S36Publication";
import { confirmSourceFor } from "./confirmTestKit";
import { suggestionApi } from "./suggestions/client";
import { publishCharacterDefinitionRevision, seriesDataScope } from "./seriesMountCache";

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
  const confirmSource = confirmSourceFor();
  const gateway = { characterSidebarCounts: () => counts.promise } as unknown as LibraryGateway;
  const result = render(<LibraryProvider gateway={gateway}><SeriesBrowser
    series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets}
    classifications={fixtureClassifications} galleryLayout="masonry" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined} api={api} hubApi={hubApi} confirmSource={confirmSource}
  /></LibraryProvider>);
  await screen.findByRole("option", { name: "이미지 5.webp" });
  return { ...result, folders, counts, browse, gateway, confirmSource };
}

it("starts confirmation and readiness only after the page and shelf swap, without awaiting them", async () => {
  const pendingReadiness = deferred<Awaited<ReturnType<typeof s36PublicationApi.readiness>>>();
  const readiness = vi.spyOn(s36PublicationApi, "readiness").mockReturnValue(pendingReadiness.promise);
  const { container, folders, counts, confirmSource } = await mount();
  const confirmation = vi.spyOn(confirmSource, "counts");
  const pendingConfirmation = deferred<Awaited<ReturnType<typeof confirmSource.counts>>>();
  confirmation.mockReturnValue(pendingConfirmation.promise);
  expect(confirmation).not.toHaveBeenCalled();
  expect(readiness).not.toHaveBeenCalled();
  await act(async () => { folders.resolve([]); });
  expect(confirmation).not.toHaveBeenCalled();
  expect(readiness).not.toHaveBeenCalled();
  await act(async () => { counts.resolve({ targets: {} }); });
  await waitFor(() => expect(viewReady(container)).toBe(true));
  await waitFor(() => { expect(confirmation).toHaveBeenCalledTimes(1); expect(readiness).toHaveBeenCalledTimes(1); });
  expect(viewReady(container)).toBe(true);
  await act(async () => { pendingConfirmation.resolve({ recognition: 0, tag: 0, recheck: 0 }); pendingReadiness.resolve([]); });
});

it("updates known character counts in place while global reads refresh in the background", async () => {
  const { container, folders, counts, gateway } = await mount();
  await act(async () => { folders.resolve([]); counts.resolve({ targets: { hina: 27 } }); });
  await waitFor(() => expect(viewReady(container)).toBe(true));
  const card = screen.getByRole("button", { name: "히나 열기" });
  const count = card.querySelector(".folder-shelf__meta");
  expect(count).toHaveTextContent("27장");
  const nextCounts = deferred<Awaited<ReturnType<NonNullable<LibraryGateway["characterSidebarCounts"]>>>>();
  vi.spyOn(gateway, "characterSidebarCounts").mockReturnValue(nextCounts.promise);
  const nextSuggestions = deferred<Awaited<ReturnType<typeof suggestionApi.list>>>();
  vi.spyOn(suggestionApi, "list").mockReturnValue(nextSuggestions.promise);
  await act(async () => { publishCharacterDefinitionRevision(gateway, seriesDataScope(gateway, undefined), 1); });
  expect(viewReady(container)).toBe(true);
  expect(card.querySelector(".folder-shelf__meta")).toBe(count);
  expect(count).toHaveTextContent("27장");
  await act(async () => { nextCounts.resolve({ targets: { hina: 28 }, groups: {} }); nextSuggestions.resolve([]); });
  expect(screen.getByRole("button", { name: "히나 열기" })).toBe(card);
  expect(card.querySelector(".folder-shelf__meta")).toBe(count);
  expect(count).toHaveTextContent("28장");
});

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

it("keeps the outgoing scroll position through publication of the next filter page", async () => {
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
  expect(container.querySelector(".series-gallery")?.closest("[inert]")).not.toBeNull();
  const items = Array.from({ length: 120 }, (_, index) => ({ ...fixtureAssets[index % fixtureAssets.length], id: `all-${index}` }));
  await act(async () => { page.resolve({ items, nextCursor: null, totalCount: items.length }); });
  await screen.findByRole("radio", { name: "전체 120" });
  expect(scroller.scrollTop).toBe(300);
});

it.each([false, true])("switches the real series shelf only after folders, suggestions and character/group/collage images are ready, in one step (view transitions available: %s)", async viewTransitions => {
  const start = vi.fn();
  if (viewTransitions) Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  const api = createCharacterFixture(), originalTargets = await api.targets();
  const targets = [...originalTargets, ...originalTargets.slice(0, 2).map((target, i) => ({
    ...target, id: `next-${i}`, displayName: `Next ${i}`, seriesClassificationId: "next", thumbnailAssetId: `next-cover-${i}`,
  }))];
  const pendingSuggestions = deferred<Awaited<ReturnType<typeof suggestionApi.list>>>(), pendingFolders = deferred<SeriesFolder[]>();
  vi.spyOn(suggestionApi, "list").mockResolvedValueOnce([]).mockReturnValue(pendingSuggestions.promise);
  const hubApi = { browse: async () => ({ items: [], nextCursor: null, totalCount: 0 }),
    seriesFolders: (id: string) => id === "next" ? pendingFolders.promise : Promise.resolve([]),
    excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const confirmSource = confirmSourceFor();
  const gateway = {} as LibraryGateway;
  const element = (id: string) => <LibraryProvider gateway={gateway}><SeriesBrowser
    series={{ classificationId: id, heroAssetId: null, autoClassify: true }} targets={targets}
    groups={[{ id: "next-group", seriesId: "next", name: "Next group", revision: 1, targetIds: ["next-1"] }]}
    classifications={fixtureClassifications} galleryLayout="masonry" privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={id === "next" ? 1 : 0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined} api={api} hubApi={hubApi} confirmSource={confirmSource}
  /></LibraryProvider>;
  const view = render(element("series"));
  await waitFor(() => expect(viewReady(view.container)).toBe(true));
  vi.useFakeTimers();
  try {
    const rect = { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const visibleShelf = () => Array.from(view.container.querySelector(".series-shelf")!.children).find(node => !(node as HTMLElement).style.opacity)!;
    const oldShelf = visibleShelf(), oldText = oldShelf.textContent;
    view.rerender(element("next"));
    expect(visibleShelf()).toBe(oldShelf);
    expect(visibleShelf().textContent).toBe(oldText);
    await act(async () => { pendingFolders.resolve([]); });
    expect(visibleShelf().textContent).toBe(oldText);
    await act(async () => { pendingSuggestions.resolve([{ tag: "new_suggestion", seriesId: "next", seriesName: "Next", imageCount: 7,
      bothCount: 7, canaryCount: 7, pixaiCount: 7, insideCount: 7, sampleAssetIds: ["sample-a", "sample-b"] }]); });
    expect(visibleShelf().textContent).toBe(oldText);
    const prepared = view.container.querySelector<HTMLElement>('[data-motion-view="series-shelf"][aria-hidden="true"]')!;
    expect(prepared.querySelector(".character-suggestion-tile__mosaic")).toHaveClass("character-suggestion-tile__mosaic--suggestion");
    const images = Array.from(prepared.querySelectorAll("img"));
    expect(images).toHaveLength(4);
    const characterImage = images.find(image => image.src.includes("next-cover-0"))!;
    const groupImage = images.find(image => image.src.includes("next-cover-1"))!;
    for (const image of images.slice(0, -1)) fireEvent.load(image);
    expect(visibleShelf().textContent).toBe(oldText);
    await act(async () => { fireEvent.load(images[images.length - 1]); });
    // One step without animation (user 2026-10-05): no browser view transition even where available.
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveAttribute("data-series-view-transition");
    expect(view.container.querySelector(".series-shelf")!.children).toHaveLength(1);
    expect(visibleShelf()).toBe(prepared);
    expect(visibleShelf()).toHaveTextContent("캐릭터 2 · 그룹 1 · 제안 1");
    expect(screen.getByRole("button", { name: "제안 숨기기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next 0 열기" }).querySelector("img")).toBe(characterImage);
    expect(screen.getByRole("button", { name: "Next group 그룹 열기" }).querySelector("img")).toBe(groupImage);
    expect(screen.queryByRole("button", { name: "히나 열기" })).toBeNull();
  } finally {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "startViewTransition");
  }
});
