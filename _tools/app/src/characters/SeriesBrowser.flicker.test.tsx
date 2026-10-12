import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { viewReady } from "../shared/motion/AreaSwitch";
import { StableImage } from "../shared/ui/StableImage";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { confirmSourceFor } from "./confirmTestKit";
import type { CharacterHubApi } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { FolderKindSwitch } from "./CharacterFolderContent";
import { publishCharacterDefinitionRevision, seriesDataScope } from "./seriesMountCache";
import { characterCardImage, folderCardImage, groupMemberImage } from "./shelfImages";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: async () => [], ignored: async () => [] } };
});
beforeEach(() => {
  localStorage.clear();
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["masonry", "justified"] as const)("retains every cached gallery cell and shelf cover through three plain-folder re-entries (%s)", async galleryLayout => {
  const api = createCharacterFixture(), targets = await api.targets();
  const assets = fixtureAssets.slice(5);
  const browse = vi.fn(async () => ({ items: structuredClone(assets), nextCursor: null, totalCount: assets.length }));
  const hubApi = { browse, seriesFolders: async () => [], excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const gateway = { characterSidebarCounts: async () => ({ targets: { hina: 27, kisaki: 12 }, groups: {} }) } as unknown as LibraryGateway;
  const confirmSource = confirmSourceFor();
  const tree = (open: boolean) => <LibraryProvider gateway={gateway}><FolderKindSwitch kind={open ? "series" : "plain"}>{open ? <SeriesBrowser
    series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets}
    classifications={fixtureClassifications} galleryLayout={galleryLayout} privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined}
    api={api} hubApi={hubApi} confirmSource={confirmSource}
  /> : <section aria-label="Plain folder">Plain folder</section>}</FolderKindSwitch></LibraryProvider>;
  const view = render(tree(true));
  await waitFor(() => expect(viewReady(view.container)).toBe(true));
  const cells = [...view.container.querySelectorAll('[data-gallery-cell]')];
  const covers = [...view.container.querySelectorAll('.series-shelf img')];
  expect(cells.length).toBeGreaterThan(0);
  expect(covers.length).toBeGreaterThan(0);
  const changedCells: Node[] = [];
  const observer = new MutationObserver(records => records.forEach(record => {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (node instanceof Element && (node.matches('[data-gallery-cell]') || node.querySelector('[data-gallery-cell]'))) changedCells.push(node);
    }
  }));
  observer.observe(view.container, { childList: true, subtree: true });
  try {
    for (let visit = 0; visit < 3; visit++) {
      view.rerender(tree(false));
      await screen.findByRole("region", { name: "Plain folder" });
      expect(screen.queryByRole("region", { name: "시리즈" })).toBeNull();
      view.rerender(tree(true));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Plain folder" })).toBeNull());
      await waitFor(() => expect(viewReady(view.container)).toBe(true));
      const nextCells = [...view.container.querySelectorAll('[data-gallery-cell]')];
      const nextCovers = [...view.container.querySelectorAll('.series-shelf img')];
      expect(nextCells).toHaveLength(cells.length);
      expect(nextCovers).toHaveLength(covers.length);
      nextCells.forEach((cell, index) => expect(cell).toBe(cells[index]));
      nextCovers.forEach((cover, index) => expect(cover).toBe(covers[index]));
    }
    expect(changedCells).toHaveLength(0);
    expect(browse).toHaveBeenCalledTimes(1);
  } finally { observer.disconnect(); }
});

it.each(["masonry", "justified"] as const)("keeps shelf and grid images unchanged when identical data returns at new analysis and definition revisions (%s)", async galleryLayout => {
  const api = createCharacterFixture(), targets = await api.targets();
  const assets = fixtureAssets.slice(5).map(asset => ({ ...asset, thumbnailRevision: "bitmap-1" }));
  const browse = vi.fn(async () => ({ items: structuredClone(assets), nextCursor: null, totalCount: assets.length }));
  const hubApi = { browse, seriesFolders: async () => [], excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const counts = vi.fn(async () => ({ targets: { hina: 27, kisaki: 12 }, groups: {} }));
  const gateway = { characterSidebarCounts: counts } as unknown as LibraryGateway;
  const confirmSource = confirmSourceFor();
  const tree = (revision: number) => <LibraryProvider gateway={gateway}><SeriesBrowser
    series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={structuredClone(targets)}
    groups={[{ id: "group", seriesId: "series", name: "Group", revision, targetIds: ["kisaki"] }]}
    classifications={fixtureClassifications} galleryLayout={galleryLayout} privacyMode={false} metadataVisible thumbnailRowHeight={180}
    refreshVersion={revision} seriesRevisions={{ series: revision }}
    onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined} onMetadataVisibleChange={() => undefined}
    onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined} onChanged={() => undefined}
    api={api} hubApi={hubApi} confirmSource={confirmSource}
  /></LibraryProvider>;
  const view = render(tree(0));
  await waitFor(() => expect(viewReady(view.container)).toBe(true));
  await act(async () => { view.container.querySelectorAll("img").forEach(image => fireEvent.load(image)); });
  const images = [...view.container.querySelectorAll("img")];
  expect(images.length).toBeGreaterThan(2);
  const markup = images.map(image => image.outerHTML);
  const animate = vi.fn(() => ({ cancel: vi.fn() } as unknown as Animation));
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const card = screen.getByRole("button", { name: "히나 열기" });
  const meta = card.querySelector(".folder-shelf__meta");
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  images.forEach(image => observer.observe(image, { attributes: true }));
  observer.observe(view.container.querySelector(".series-shelf")!, { childList: true, subtree: true });
  try {
    view.rerender(tree(0));
    await act(async () => undefined);
    for (let revision = 1; revision <= 3; revision++) {
      view.rerender(tree(revision));
      await act(async () => { publishCharacterDefinitionRevision(gateway, seriesDataScope(gateway, undefined), revision); });
      await waitFor(() => expect(browse).toHaveBeenCalledTimes(revision + 1));
      await waitFor(() => expect(counts.mock.calls.length).toBeGreaterThanOrEqual(revision + 1));
      await waitFor(() => expect(viewReady(view.container)).toBe(true));
    }
    expect([...view.container.querySelectorAll("img")]).toEqual(images);
    expect(images.map(image => image.outerHTML)).toEqual(markup);
    expect(mutations).toEqual([]);
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "히나 열기" })).toBe(card);
    expect(card.querySelector(".folder-shelf__meta")).toBe(meta);
    expect(meta).toHaveTextContent("27장");
  } finally {
    observer.disconnect();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("uses bitmap revisions rather than target or group definition revisions in cover URLs", async () => {
  const target = (await createCharacterFixture().targets())[0];
  const first = { ...target, thumbnailAssetId: "chosen", thumbnailRevisions: { chosen: "bitmap-1" } };
  const next = { ...structuredClone(first), revision: 999, fingerprint: "changed-definition" };
  expect(characterCardImage(next)).toBe(characterCardImage(first));
  expect(groupMemberImage(next)).toBe(groupMemberImage(first));
  const folder = { classificationId: "child", thumbnailAssetId: "chosen", thumbnailRevision: "bitmap-1" };
  expect(folderCardImage(structuredClone(folder))).toBe(folderCardImage(folder));
  expect(characterCardImage({ ...next, thumbnailAssetId: "replacement" })).not.toBe(characterCardImage(first));
});

it("holds the old cover through a real cover change and promotes the decoded slot once", async () => {
  const view = render(<StableImage src="/thumbnail/old/vbitmap-1" alt="Cover" />);
  const old = screen.getByRole<HTMLImageElement>("img");
  fireEvent.load(old);
  view.rerender(<StableImage src="/thumbnail/new/vbitmap-2" alt="Cover" />);
  const incoming = view.container.querySelector<HTMLImageElement>('img[data-stable-image-pending="true"]')!;
  let decoded!: () => void;
  incoming.decode = () => new Promise<void>(resolve => { decoded = resolve; });
  incoming.animate = vi.fn();
  fireEvent.load(incoming);
  expect(screen.getByRole("img")).toBe(old);
  await act(async () => decoded());
  expect(screen.getByRole("img")).toBe(incoming);
  expect(incoming.animate).not.toHaveBeenCalled();
  view.rerender(<StableImage src="/thumbnail/new/vbitmap-2" alt="Cover" />);
  expect(screen.getByRole("img")).toBe(incoming);
});
