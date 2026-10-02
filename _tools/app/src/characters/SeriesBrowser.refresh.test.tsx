import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import type { CharacterBrowsePage, CharacterHubApi } from "./hubApi";

beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 850 },
  clientHeight: { configurable: true, get: () => 650 },
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([undefined, "hina"])("publishes each finished read while classification continues: %s", async (initialTargetId) => {
  const api = createCharacterFixture();
  const targets = await api.targets();
  let finishFirst!: (value: CharacterBrowsePage) => void;
  let finishNext!: (value: CharacterBrowsePage) => void;
  const browse = vi.fn()
    .mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }))
    .mockReturnValue(new Promise(resolve => { finishNext = resolve; }));
  const hubApi = { browse, seriesFolders: vi.fn().mockResolvedValue([]),
    excludedAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const gateway = {} as LibraryGateway;
  const element = (refreshVersion: number, targetId = initialTargetId) => <LibraryProvider gateway={gateway}>
    <SeriesBrowser series={{ classificationId: "series", heroAssetId: null, autoClassify: true }}
      targets={targets} targetId={targetId} classifications={fixtureClassifications} galleryLayout="masonry"
      onGalleryLayoutChange={vi.fn()} privacyMode={false} onPrivacyModeChange={vi.fn()}
      metadataVisible onMetadataVisibleChange={vi.fn()} thumbnailRowHeight={180}
      onThumbnailRowHeightChange={vi.fn()} refreshVersion={refreshVersion}
      onNavigate={vi.fn()} onChanged={vi.fn()} api={api} hubApi={hubApi} />
  </LibraryProvider>;
  const { rerender } = render(element(0));
  await waitFor(() => expect(browse).toHaveBeenCalledTimes(1));
  rerender(element(1));
  rerender(element(2));
  await act(async () => { finishFirst({ items: [fixtureAssets[5]], nextCursor: null, totalCount: 1 }); });
  expect(screen.getByRole("option", { name: "이미지 5.webp" })).toBeInTheDocument();
  expect(browse).toHaveBeenCalledTimes(2);
  await act(async () => { finishNext({ items: fixtureAssets.slice(5, 7), nextCursor: null, totalCount: 2 }); });
  expect(screen.getByRole("option", { name: "이미지 6.webp" })).toBeInTheDocument();
});

it("restores cached series folder covers on A → B → A and remount, retaining them on failure", async () => {
  const api = createCharacterFixture();
  const targets = await api.targets();
  const seriesFolders = vi.fn().mockImplementation(async (id: string) => id === "series"
    ? [{ classificationId: "f2-folder", thumbnailAssetId: "f2-series-cover" }] : []);
  const hubApi = { seriesFolders, browse: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }),
    excludedAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const gateway = {} as LibraryGateway;
  const element = (id: string) => <LibraryProvider gateway={gateway}>
    <SeriesBrowser series={{ classificationId: id, heroAssetId: null, autoClassify: true }} targets={targets}
      classifications={[...fixtureClassifications, { id: "f2-folder", kind: "tag", name: "Folder", parentId: "series", iconKey: null, colorKey: null }]}
      galleryLayout="masonry" onGalleryLayoutChange={vi.fn()} privacyMode={false} onPrivacyModeChange={vi.fn()} metadataVisible
      onMetadataVisibleChange={vi.fn()} thumbnailRowHeight={180} onThumbnailRowHeightChange={vi.fn()}
      refreshVersion={0} onNavigate={vi.fn()} onChanged={vi.fn()} api={api} hubApi={hubApi} />
  </LibraryProvider>;
  const view = render(element("series"));
  const card = () => screen.getByRole("button", { name: "Folder 폴더 열기" });
  await waitFor(() => expect(card().querySelector("img")).toHaveAttribute("src", expect.stringContaining("f2-series-cover")));
  view.rerender(element("other-series"));
  expect(card().querySelector("img")).toHaveAttribute("src", expect.stringContaining("f2-series-cover"));
  expect(card()).toBeDisabled();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Folder 폴더 열기" })).not.toBeInTheDocument());
  let fail!: (error: Error) => void;
  seriesFolders.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  view.rerender(element("series"));
  expect(card().querySelector("img")).toHaveAttribute("src", expect.stringContaining("f2-series-cover"));
  expect(card().querySelector(".series-character__placeholder")).toBeNull();
  await act(async () => fail(new Error("offline")));
  expect(card().querySelector("img")).toHaveAttribute("src", expect.stringContaining("f2-series-cover"));
  expect(card().querySelector(".series-character__placeholder")).toBeNull();
  view.unmount();
  seriesFolders.mockReturnValue(new Promise(() => {}));
  render(element("series"));
  expect(card().querySelector("img")).toHaveAttribute("src", expect.stringContaining("f2-series-cover"));
  expect(card().querySelector(".series-character__placeholder")).toBeNull();
});
