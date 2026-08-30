import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, RevisitSlate, LibraryGateway } from "../library/types";
import { TodayView } from "./TodayView";

afterEach(() => cleanup());

const assets: AssetSummary[] = ["asset-a", "asset-b", "asset-c"].map((id) => ({
  id,
  title: null,
  originalName: `${id}.png`,
  byteSize: 1,
  width: 200,
  height: 200,
  collectedAt: "2026-08-30T00:00:00Z",
  favorite: false,
  sourceUrl: null,
  sourcePublishedAt: null,
  creatorName: null,
  creatorHandle: null,
  creatorUrl: null,
  importSource: null,
  importBatchId: null,
  originalModifiedAt: null,
  media: { kind: "image" as const },
}));

const slate: RevisitSlate = {
  localDate: "2026-08-30",
  createdAt: "2026-08-30T03:00:00.000Z",
  revision: 0,
  bundles: [
    { id: "bundle-0", kind: "rediscovery", title: "다시 만난 자산", reason: "오랫동안 열지 않은 즐겨찾기", assetIds: ["asset-a", "asset-b", "asset-c"], revision: 0 },
    { id: "bundle-1", kind: "creator", title: "작가 집중 보기", reason: "최근 열어본 자산의 작가", assetIds: ["asset-a"], revision: 0 },
  ],
};

let gateway: LibraryGateway;

beforeEach(() => {
  gateway = {
    getRevisitSlate: vi.fn().mockResolvedValue(slate),
    reshuffleRevisitBundle: vi.fn().mockImplementation((_localDate: string, bundleId: string) =>
      Promise.resolve({ ...slate, bundles: slate.bundles.map((bundle) => bundle.id === bundleId ? { ...bundle, revision: bundle.revision + 1 } : bundle) })),
    reshuffleRevisitSlate: vi.fn().mockImplementation((localDate: string) =>
      Promise.resolve({ ...slate, localDate, revision: slate.revision + 1 })),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    getAsset: vi.fn().mockImplementation((assetId: string) => Promise.resolve(assets.find((asset) => asset.id === assetId) ?? assets[0]!)),
  } as unknown as LibraryGateway;
});

it("keeps one hero, exposes visible assets, and reshuffles only the requested bundle", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <TodayView />
    </LibraryProvider>,
  );
  expect(await screen.findAllByTestId("revisit-hero-bundle")).toHaveLength(1);
  await waitFor(() => expect(vi.mocked(gateway.recordAssetsExposed)).toHaveBeenCalledWith(expect.arrayContaining(["asset-a"]), expect.any(String)));
  await user.click(screen.getAllByRole("button", { name: "이 묶음 다시 섞기" })[0]!);
  await waitFor(() => expect(vi.mocked(gateway.reshuffleRevisitBundle)).toHaveBeenCalledTimes(1));
  expect(vi.mocked(gateway.reshuffleRevisitSlate)).not.toHaveBeenCalled();
});

it("opens the 관심 없음 menu with hide choice", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <TodayView />
    </LibraryProvider>,
  );
  await user.click((await screen.findAllByRole("button", { name: "관심 없음" }))[0]!);
  expect(await screen.findByRole("menuitem", { name: "이 묶음만 숨기기" })).toBeVisible();
});
