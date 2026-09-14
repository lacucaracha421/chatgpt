import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, IngestOutcome, LibraryGateway } from "../library/types";
import { useSeriesImages } from "./useSeriesImages";

const open = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

afterEach(() => {
  vi.clearAllMocks();
});

function asset(id: string): AssetSummary {
  return {
    id,
    title: null,
    originalName: `${id}.png`,
    byteSize: 100,
    width: 100,
    height: 100,
    collectedAt: `2026-09-14T00:00:0${id.endsWith("2") ? "2" : "1"}Z`,
    favorite: false,
    sourceUrl: null,
    sourcePublishedAt: null,
    creatorName: null,
    creatorHandle: null,
    creatorUrl: null,
    importSource: null,
    importBatchId: null,
    originalModifiedAt: null,
    media: { kind: "image" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("publishes each imported image before the rest of the picker batch finishes", async () => {
  const first = asset("asset-1");
  const second = asset("asset-2");
  const pendingSecond = deferred<IngestOutcome>();
  open.mockResolvedValue(["/incoming/first.png", "/incoming/second.png"]);
  const listAssets = vi.fn()
    .mockResolvedValueOnce({ items: [], nextCursor: null })
    .mockResolvedValue({ items: [second, first], nextCursor: null });
  const ingestMedia = vi.fn()
    .mockResolvedValueOnce({ status: "added", asset: first })
    .mockImplementationOnce(() => pendingSecond.promise);
  const gateway = { listAssets, ingestMedia } as unknown as LibraryGateway;
  const wrapper = ({ children }: PropsWithChildren) => <LibraryProvider gateway={gateway}>{children}</LibraryProvider>;
  const { result } = renderHook(() => useSeriesImages("series"), { wrapper });
  await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(1));

  let importing!: Promise<string[]>;
  act(() => { importing = result.current.importImages(); });

  await waitFor(() => expect(ingestMedia).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(["asset-1"]));
  act(() => pendingSecond.resolve({ status: "added", asset: second }));
  await act(async () => { await importing; });

  expect(result.current.items.map(item => item.id)).toEqual(["asset-2", "asset-1"]);
});


it("publishes an exact duplicate by resolving the existing asset before the batch finishes", async () => {
  const existing = asset("asset-existing");
  const second = asset("asset-2");
  const pendingSecond = deferred<IngestOutcome>();
  open.mockResolvedValue(["/incoming/existing.png", "/incoming/second.png"]);
  const listAssets = vi.fn()
    .mockResolvedValueOnce({ items: [], nextCursor: null })
    .mockResolvedValue({ items: [second, existing], nextCursor: null });
  const ingestMedia = vi.fn()
    .mockResolvedValueOnce({ status: "exact_duplicate", existingAssetId: existing.id, classificationChanged: true })
    .mockImplementationOnce(() => pendingSecond.promise);
  const getAsset = vi.fn().mockResolvedValue(existing);
  const gateway = { listAssets, ingestMedia, getAsset } as unknown as LibraryGateway;
  const wrapper = ({ children }: PropsWithChildren) => <LibraryProvider gateway={gateway}>{children}</LibraryProvider>;
  const { result } = renderHook(() => useSeriesImages("series"), { wrapper });
  await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(1));

  let importing!: Promise<string[]>;
  act(() => { importing = result.current.importImages(); });

  await waitFor(() => expect(ingestMedia).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual([existing.id]));
  expect(getAsset).toHaveBeenCalledWith(existing.id);
  act(() => pendingSecond.resolve({ status: "added", asset: second }));
  await act(async () => { await importing; });

  expect(result.current.items.map(item => item.id)).toEqual(["asset-2", existing.id]);
});
