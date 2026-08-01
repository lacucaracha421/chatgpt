import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type {
  AssetSummary,
  IngestImageInput,
  IngestOutcome,
} from "../library/types";
import {
  type DropProgress,
  type DropSubscriber,
  subscribeToTauriDrops,
  useFileDrop,
} from "./useFileDrop";

const onDragDropEvent = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

const fixtureAsset: AssetSummary = {
  id: "asset-arona",
  title: null,
  originalName: "arona.png",
  relativePath: "assets/aa/arona.png",
  thumbnailRelativePath: "thumbnails/aa/arona.webp",
  byteSize: 123,
  width: 8,
  height: 6,
  collectedAt: "2026-07-31T00:00:00Z",
  favorite: false,
  sourceUrl: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("ingests dropped paths with the selected classification", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };
  const ingestImage = vi.fn().mockResolvedValue({
    status: "added",
    asset: fixtureAsset,
  });

  renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: "tag-arona",
      ingestImage,
      onResult: vi.fn(),
    }),
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\arona.png"]));

  await waitFor(() =>
    expect(ingestImage).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\arona.png",
      classificationId: "tag-arona",
      sourceUrl: null,
    }),
  );
});

it("ingests files from one drop sequentially", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const first = deferred<{
    status: "added";
    asset: AssetSummary;
  }>();
  const ingestImage = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({ status: "added", asset: fixtureAsset });
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };

  renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage,
      onResult: vi.fn(),
    }),
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\first.png", "C:\\images\\second.png"]));

  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(1));
  expect(ingestImage).toHaveBeenNthCalledWith(1, {
    sourcePath: "C:\\images\\first.png",
    classificationId: null,
    sourceUrl: null,
  });

  act(() => first.resolve({ status: "added", asset: fixtureAsset }));

  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(2));
  expect(ingestImage).toHaveBeenNthCalledWith(2, {
    sourcePath: "C:\\images\\second.png",
    classificationId: null,
    sourceUrl: null,
  });
});

it("reports an ingest error and continues with the next file", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const onResult = vi.fn();
  const ingestImage = vi
    .fn()
    .mockRejectedValueOnce({
      code: "unsupported_image",
      message: "지원하지 않는 이미지입니다.",
    })
    .mockResolvedValueOnce({ status: "added", asset: fixtureAsset });
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };

  renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage,
      onResult,
    }),
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\broken.png", "C:\\images\\arona.png"]));

  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(2));
  expect(onResult).toHaveBeenCalledWith({
    status: "error",
    message: "지원하지 않는 이미지입니다.",
  });
});

it("reports added and exact duplicate outcomes with their user messages", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const onResult = vi.fn();
  const ingestImage = vi
    .fn()
    .mockResolvedValueOnce({ status: "added", asset: fixtureAsset })
    .mockResolvedValueOnce({
      status: "exact_duplicate",
      existingAssetId: "asset-existing",
    });
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };

  renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage,
      onResult,
    }),
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\new.png", "C:\\images\\duplicate.png"]));

  await waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));
  expect(onResult).toHaveBeenNthCalledWith(1, {
    status: "added",
    asset: fixtureAsset,
    message: "저장했습니다",
  });
  expect(onResult).toHaveBeenNthCalledWith(2, {
    status: "exact_duplicate",
    existingAssetId: "asset-existing",
    message: "이미 보관된 파일입니다",
  });
});

it("reports the current file and total while a drop is processing", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const first = deferred<{ status: "added"; asset: AssetSummary }>();
  const second = deferred<{ status: "added"; asset: AssetSummary }>();
  const ingestImage = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };

  const { result } = renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage,
      onResult: vi.fn(),
    }),
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\first.png", "C:\\images\\second.png"]));

  await waitFor(() => expect(result.current).toEqual({ current: 1, total: 2 }));
  act(() => first.resolve({ status: "added", asset: fixtureAsset }));
  await waitFor(() => expect(result.current).toEqual({ current: 2, total: 2 }));
  act(() => second.resolve({ status: "added", asset: fixtureAsset }));
  await waitFor(() => expect(result.current).toBeNull());
});

it("queues overlapping drops in arrival order without clearing progress", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const a1 = deferred<IngestOutcome>();
  const a2 = deferred<IngestOutcome>();
  const b1 = deferred<IngestOutcome>();
  const pendingByPath = new Map<string, Promise<IngestOutcome>>([
    ["C:\\images\\a1.png", a1.promise],
    ["C:\\images\\a2.png", a2.promise],
    ["C:\\images\\b1.png", b1.promise],
  ]);
  const ingestImage = vi.fn((input: IngestImageInput) => {
    const pending = pendingByPath.get(input.sourcePath);
    if (!pending) throw new Error(`unexpected path: ${input.sourcePath}`);
    return pending;
  });
  const onResult = vi.fn();
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };
  const progressHistory: Array<DropProgress | null> = [];
  const assetA1 = {
    ...fixtureAsset,
    id: "asset-a1",
    originalName: "a1.png",
  };
  const assetA2 = {
    ...fixtureAsset,
    id: "asset-a2",
    originalName: "a2.png",
  };
  const assetB1 = {
    ...fixtureAsset,
    id: "asset-b1",
    originalName: "b1.png",
  };

  const { result, rerender } = renderHook(
    ({ classificationId }: { classificationId: string | null }) => {
      const progress = useFileDrop({
        subscribe,
        classificationId,
        ingestImage,
        onResult,
      });
      progressHistory.push(progress);
      return progress;
    },
    { initialProps: { classificationId: "tag-a" } },
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\a1.png", "C:\\images\\a2.png"]));
  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(1));
  expect(result.current).toEqual({ current: 1, total: 2 });

  rerender({ classificationId: "tag-b" });
  await act(async () => {
    drop?.(["C:\\images\\b1.png"]);
    await Promise.resolve();
  });

  expect(ingestImage).toHaveBeenCalledTimes(1);
  act(() => a1.resolve({ status: "added", asset: assetA1 }));
  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(2));
  expect(ingestImage).toHaveBeenNthCalledWith(2, {
    sourcePath: "C:\\images\\a2.png",
    classificationId: "tag-a",
    sourceUrl: null,
  });
  expect(result.current).toEqual({ current: 2, total: 2 });

  act(() => a2.resolve({ status: "added", asset: assetA2 }));
  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(3));
  expect(ingestImage).toHaveBeenNthCalledWith(3, {
    sourcePath: "C:\\images\\b1.png",
    classificationId: "tag-b",
    sourceUrl: null,
  });
  expect(result.current).toEqual({ current: 1, total: 1 });

  act(() => b1.resolve({ status: "added", asset: assetB1 }));
  await waitFor(() => expect(result.current).toBeNull());
  expect(onResult).toHaveBeenNthCalledWith(1, {
    status: "added",
    asset: assetA1,
    message: "저장했습니다",
  });
  expect(onResult).toHaveBeenNthCalledWith(2, {
    status: "added",
    asset: assetA2,
    message: "저장했습니다",
  });
  expect(onResult).toHaveBeenNthCalledWith(3, {
    status: "added",
    asset: assetB1,
    message: "저장했습니다",
  });
  const activeStart = progressHistory.findIndex(
    (progress) => progress?.current === 1 && progress.total === 2,
  );
  expect(activeStart).toBeGreaterThanOrEqual(0);
  expect(progressHistory.slice(activeStart, -1)).not.toContain(null);
});

it("uses the current classification for a new drop without resubscribing", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const subscribe = vi.fn<DropSubscriber>(async (handler) => {
    drop = handler;
    return () => undefined;
  });
  const ingestImage = vi
    .fn()
    .mockResolvedValue({ status: "added", asset: fixtureAsset });
  const onResult = vi.fn();

  const { rerender } = renderHook(
    ({ classificationId }: { classificationId: string | null }) =>
      useFileDrop({
        subscribe,
        classificationId,
        ingestImage,
        onResult,
      }),
    { initialProps: { classificationId: "tag-before" } },
  );
  await waitFor(() => expect(drop).toBeDefined());

  rerender({ classificationId: "tag-current" });
  act(() => drop?.(["C:\\images\\arona.png"]));

  await waitFor(() =>
    expect(ingestImage).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\arona.png",
      classificationId: "tag-current",
      sourceUrl: null,
    }),
  );
  expect(subscribe).toHaveBeenCalledTimes(1);
});

it("keeps the classification captured when a drop starts", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const first = deferred<{ status: "added"; asset: AssetSummary }>();
  const ingestImage = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({ status: "added", asset: fixtureAsset });
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };

  const { rerender } = renderHook(
    ({ classificationId }: { classificationId: string | null }) =>
      useFileDrop({
        subscribe,
        classificationId,
        ingestImage,
        onResult: vi.fn(),
      }),
    { initialProps: { classificationId: "tag-at-drop" } },
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\first.png", "C:\\images\\second.png"]));
  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(1));

  rerender({ classificationId: "tag-after-drop" });
  act(() => first.resolve({ status: "added", asset: fixtureAsset }));

  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(2));
  expect(ingestImage).toHaveBeenNthCalledWith(2, {
    sourcePath: "C:\\images\\second.png",
    classificationId: "tag-at-drop",
    sourceUrl: null,
  });
});

it("unlistens an immediately established subscription on unmount", async () => {
  const unlisten = vi.fn();
  const subscribe = vi.fn<DropSubscriber>(async () => unlisten);

  const { unmount } = renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage: vi.fn(),
      onResult: vi.fn(),
    }),
  );
  await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
  await act(async () => {
    await Promise.resolve();
  });
  expect(unlisten).not.toHaveBeenCalled();

  unmount();

  expect(unlisten).toHaveBeenCalledOnce();
});

it("unlistens when subscription setup finishes after unmount", async () => {
  const subscription = deferred<() => void>();
  const unlisten = vi.fn();
  const subscribe: DropSubscriber = async () => subscription.promise;

  const { unmount } = renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage: vi.fn(),
      onResult: vi.fn(),
    }),
  );

  unmount();
  subscription.resolve(unlisten);

  await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
});

it("stops progress and result callbacks after unmount", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const first = deferred<{ status: "added"; asset: AssetSummary }>();
  const ingestImage = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({ status: "added", asset: fixtureAsset });
  const onResult = vi.fn();
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };

  const { unmount } = renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: null,
      ingestImage,
      onResult,
    }),
  );
  await waitFor(() => expect(drop).toBeDefined());
  act(() => drop?.(["C:\\images\\first.png", "C:\\images\\second.png"]));
  await waitFor(() => expect(ingestImage).toHaveBeenCalledTimes(1));
  act(() => drop?.(["C:\\images\\queued.png"]));

  unmount();
  await act(async () => {
    first.resolve({ status: "added", asset: fixtureAsset });
    await Promise.resolve();
  });

  expect(onResult).not.toHaveBeenCalled();
  expect(ingestImage).toHaveBeenCalledTimes(1);
});

it("reports a drop subscription error while mounted", async () => {
  const onResult = vi.fn();

  renderHook(() =>
    useFileDrop({
      subscribe: vi.fn().mockRejectedValue({
        code: "drop_subscription_failed",
        message: "끌어놓기를 시작할 수 없습니다.",
      }),
      classificationId: null,
      ingestImage: vi.fn(),
      onResult,
    }),
  );

  await waitFor(() =>
    expect(onResult).toHaveBeenCalledWith({
      status: "error",
      message: "끌어놓기를 시작할 수 없습니다.",
    }),
  );
});

it("adapts Tauri drop events to path subscriptions", async () => {
  const unlisten = vi.fn();
  let tauriHandler:
    | ((event: { payload: { type: "drop"; paths: string[] } }) => void)
    | undefined;
  onDragDropEvent.mockImplementationOnce(
    async (handler: typeof tauriHandler) => {
      tauriHandler = handler;
      return unlisten;
    },
  );
  const handler = vi.fn();

  const stop = await subscribeToTauriDrops(handler);
  tauriHandler?.({
    payload: { type: "drop", paths: ["C:\\images\\arona.png"] },
  });

  expect(handler).toHaveBeenCalledWith(["C:\\images\\arona.png"]);
  stop();
  expect(unlisten).toHaveBeenCalledOnce();
});
