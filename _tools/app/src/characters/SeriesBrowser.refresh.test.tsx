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
