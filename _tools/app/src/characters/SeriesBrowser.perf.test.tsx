import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CharacterSidebarCounts, LibraryGateway } from "../library/types";
import { viewReady } from "../shared/motion/AreaSwitch";
import { createCharacterFixture, fixtureClassifications } from "./characterFixtures";
import { confirmSourceFor } from "./confirmTestKit";
import type { CharacterHubApi } from "./hubApi";
import { SeriesBrowser } from "./SeriesBrowser";
import { publishCharacterDefinitionRevision, seriesDataScope } from "./seriesMountCache";
import { suggestionApi } from "./suggestions/client";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: vi.fn(async () => []), ignored: vi.fn(async () => []) } };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

it("does not reissue or await global reads on a second series open at a known definition revision", async () => {
  const counts = vi.fn(async (): Promise<CharacterSidebarCounts> => ({ targets: {}, groups: {} }));
  const gateway = { characterSidebarCounts: counts } as unknown as LibraryGateway;
  const api = createCharacterFixture();
  const hubApi = { browse: vi.fn(async () => ({ items: [], nextCursor: null, totalCount: 0 })),
    seriesFolders: async () => [], excludedAssets: async () => ({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const confirmSource = confirmSourceFor();
  const scope = seriesDataScope(gateway, undefined);
  publishCharacterDefinitionRevision(gateway, scope, 42);
  const list = vi.mocked(suggestionApi.list);
  list.mockClear().mockResolvedValue([]);
  const tree = (id: string, version: number) => <LibraryProvider gateway={gateway}><SeriesBrowser
    series={{ classificationId: id, heroAssetId: null, autoClassify: true }} targets={[]}
    classifications={fixtureClassifications} galleryLayout="masonry" privacyMode={false} metadataVisible thumbnailRowHeight={180}
    refreshVersion={version} onGalleryLayoutChange={() => undefined} onPrivacyModeChange={() => undefined}
    onMetadataVisibleChange={() => undefined} onThumbnailRowHeightChange={() => undefined} onNavigate={() => undefined}
    onChanged={() => undefined} api={api} hubApi={hubApi} confirmSource={confirmSource}
  /></LibraryProvider>;
  const first = render(tree("series", 0));
  await waitFor(() => expect(viewReady(first.container)).toBe(true));
  expect(list).toHaveBeenCalledTimes(1);
  expect(counts).toHaveBeenCalledTimes(1);
  first.unmount();
  const pendingSuggestions = deferred<Awaited<ReturnType<typeof suggestionApi.list>>>();
  const pendingCounts = deferred<CharacterSidebarCounts>();
  list.mockReturnValue(pendingSuggestions.promise);
  counts.mockReturnValue(pendingCounts.promise);
  // An unrelated refresh version changes while the native definition revision remains known.
  const second = render(tree("next", 100));
  await waitFor(() => expect(viewReady(second.container)).toBe(true));
  expect(list).toHaveBeenCalledTimes(1);
  expect(counts).toHaveBeenCalledTimes(1);
  // Changed definitions refresh in the background, keeping the ready view mounted.
  await act(async () => { publishCharacterDefinitionRevision(gateway, scope, 43); });
  await waitFor(() => { expect(list).toHaveBeenCalledTimes(2); expect(counts).toHaveBeenCalledTimes(2); });
  expect(viewReady(second.container)).toBe(true);
  await act(async () => { pendingSuggestions.resolve([]); pendingCounts.resolve({ targets: {}, groups: {} }); });
  expect(viewReady(second.container)).toBe(true);
});
