import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, LibraryGateway } from "../library/types";
import { RevisitedBundleView } from "./RevisitedBundleView";

vi.mock("../assets/AssetGallery", () => ({
  AssetGallery: ({ items, onOpen }: { items: AssetSummary[]; onOpen: (asset: AssetSummary) => void }) => <div data-testid="bundle-gallery">{items.map((item) => <button key={item.id} onClick={() => onOpen(item)}>{item.originalName}</button>)}</div>,
}));
vi.mock("../assets/AssetViewer", () => ({ AssetViewer: ({ activeId }: { activeId: string | null }) => activeId ? <div data-testid="opened-asset">{activeId}</div> : null }));

afterEach(cleanup);

const asset: AssetSummary = {
  id: "asset-1", title: null, originalName: "기억.png", byteSize: 1, width: 4, height: 3,
  collectedAt: "2026-08-01T00:00:00Z", favorite: false, sourceUrl: null,
  sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null,
  importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" },
};

it("distinguishes a failed bundle load and retries explicitly", async () => {
  const gateway = { getAsset: vi.fn().mockRejectedValueOnce(new Error("파일을 읽을 수 없습니다")).mockResolvedValueOnce(asset) } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><RevisitedBundleView bundleId="bundle" title="지난 기억" assetIds={[asset.id]} privacyMode={false} onBack={vi.fn()} /></LibraryProvider>);

  expect(await screen.findByText("파일을 읽을 수 없습니다")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("기억.png")).toBeVisible();
  expect(gateway.getAsset).toHaveBeenCalledTimes(2);
});

it("keeps the last bundle gallery visible while a retry is pending", async () => {
  const pending = deferred<AssetSummary>();
  const gateway = { getAsset: vi.fn().mockResolvedValueOnce(asset).mockReturnValueOnce(pending.promise) } as unknown as LibraryGateway;
  const { rerender } = render(<LibraryProvider gateway={gateway}><RevisitedBundleView bundleId="first" title="지난 기억" assetIds={[asset.id]} privacyMode={false} onBack={vi.fn()} /></LibraryProvider>);
  expect(await screen.findByText("기억.png")).toBeVisible();

  rerender(<LibraryProvider gateway={gateway}><RevisitedBundleView bundleId="second" title="다른 기억" assetIds={[asset.id]} privacyMode={false} onBack={vi.fn()} /></LibraryProvider>);
  expect(screen.getByText("기억.png")).toBeVisible();
  await act(async () => pending.resolve(asset));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

it("passes a color bundle's image and video to the existing gallery and viewer", async () => {
  const video: AssetSummary = { ...asset, id: "video-1", originalName: "영상.mp4", media: { kind: "video", durationMs: 1000, preparationState: "ready", scrubFrameCount: 0 } };
  const gateway = { getAsset: vi.fn().mockImplementation((id: string) => Promise.resolve(id === video.id ? video : asset)) } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><RevisitedBundleView bundleId="color" title="비슷한 색감" assetIds={[asset.id, video.id]} privacyMode={false} onBack={vi.fn()} /></LibraryProvider>);
  await userEvent.click(await screen.findByRole("button", { name: video.originalName }));
  expect(screen.getByTestId("opened-asset")).toHaveTextContent(video.id);
  await userEvent.click(screen.getByRole("button", { name: asset.originalName }));
  expect(screen.getByTestId("opened-asset")).toHaveTextContent(asset.id);
});
