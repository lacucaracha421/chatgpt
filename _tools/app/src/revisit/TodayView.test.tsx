import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, RevisitSlate, LibraryGateway } from "../library/types";
import { TodayView } from "./TodayView";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";

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
    { id: "bundle-0", kind: "creator", title: "작가 다시보기", reason: "오랫동안 열지 않은 즐겨찾기", assetIds: ["asset-a", "asset-b", "asset-c"], revision: 0 },
    { id: "bundle-1", kind: "date", title: "과거 수집함", reason: "최근 열어본 자산의 작가", assetIds: ["asset-a"], revision: 0 },
  ],
};

let gateway: LibraryGateway;

beforeEach(() => {
  gateway = {
    getRevisitSlate: vi.fn().mockResolvedValue(slate),
    prepareRevisitColorBundle: vi.fn().mockResolvedValue(null),
    reshuffleRevisitBundle: vi.fn().mockImplementation((_localDate: string, bundleId: string) =>
      Promise.resolve({ ...slate, bundles: slate.bundles.map((bundle) => bundle.id === bundleId ? { ...bundle, revision: bundle.revision + 1 } : bundle) })),
    reshuffleRevisitSlate: vi.fn().mockImplementation((localDate: string) =>
      Promise.resolve({ ...slate, localDate, revision: slate.revision + 1 })),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    getAsset: vi.fn().mockImplementation((assetId: string) => Promise.resolve(assets.find((asset) => asset.id === assetId) ?? assets[0]!)),
  } as unknown as LibraryGateway;
});

it("keeps fixed theme columns, exposes visible assets, and reshuffles only the requested bundle", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <TodayView />
    </LibraryProvider>,
  );
  expect(await screen.findAllByTestId("revisit-theme-bundle")).toHaveLength(2);
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

it("closes the 관심 없음 menu with Escape and restores trigger focus", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <TodayView />
    </LibraryProvider>,
  );
  const trigger = (await screen.findAllByRole("button", { name: "관심 없음" }))[0]!;
  await user.click(trigger);
  expect(await screen.findByRole("menuitem", { name: "이 묶음만 숨기기" })).toBeVisible();

  await user.keyboard("{Escape}");

  expect(screen.queryByRole("menuitem", { name: "이 묶음만 숨기기" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});


it("persists a less-like-this preference and hides the bundle", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <TodayView />
    </LibraryProvider>,
  );
  await screen.findByRole("button", { name: "작가 다시보기 자산 보기" });
  await user.click(screen.getAllByRole("button", { name: "관심 없음" })[0]!);
  await user.click(await screen.findByRole("menuitem", { name: "이런 추천 덜 보기" }));
  await waitFor(() => expect(vi.mocked(gateway.setRevisitPreference)).toHaveBeenCalledWith({
    kind: "recommendation_type", recommendationType: "creator",
  }));
  expect(screen.queryByRole("button", { name: "작가 다시보기 자산 보기" })).not.toBeInTheDocument();
});

it("can down-rank the creator represented by a creator bundle", async () => {
  const creatorAsset = { ...assets[0]!, creatorHandle: "@artist" };
  vi.mocked(gateway.getAsset).mockResolvedValue(creatorAsset);
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <TodayView />
    </LibraryProvider>,
  );
  const menus = await screen.findAllByRole("button", { name: "관심 없음" });
  await user.click(menus[0]!);
  await user.click(await screen.findByRole("menuitem", { name: "이 작가 덜 보기" }));
  await waitFor(() => expect(vi.mocked(gateway.setRevisitPreference)).toHaveBeenCalledWith({
    kind: "creator", creatorKey: "@artist",
  }));
});

it("shows base cards immediately and appends the optional color bundle without blocking", async () => {
  let finish!: (value: RevisitSlate | null) => void;
  gateway.prepareRevisitColorBundle = vi.fn(() => new Promise<RevisitSlate | null>((resolve) => { finish = resolve; }));
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "작가 다시보기 자산 보기" })).toBeVisible());
  await waitFor(() => expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "전체 다시 섞기" })).toBeEnabled();
  finish({ ...slate, revision: 1, bundles: [...slate.bundles, { id: "color-1", kind: "color", title: "비슷한 색감", reason: "기준 이미지와 색 분포가 비슷한 자료", assetIds: ["asset-c"], revision: 1 }] });
  expect(await screen.findByRole("button", { name: "비슷한 색감 자산 보기" })).toBeVisible();
  expect(screen.getByLabelText("작가 다시보기")).toBeVisible();
});

function Harness({ gateway: current }: { gateway: LibraryGateway }) {
  return <LibraryProvider gateway={current}><WorkspaceChromeProvider scope="revisit"><ChromeTarget name="actions" /><TodayView /></WorkspaceChromeProvider></LibraryProvider>;
}

const colorSlate: RevisitSlate = { ...slate, revision: 1, bundles: [...slate.bundles, {
  id: "color-1", kind: "color", title: "비슷한 색감", reason: "첫 이미지와 색감이 비슷한 이미지·영상 포스터", assetIds: ["asset-c"], revision: 1,
}] };

function deferredColor() {
  let resolve!: (value: RevisitSlate | null) => void;
  const promise = new Promise<RevisitSlate | null>((done) => { resolve = done; });
  return { promise, resolve };
}

it("ignores an old preparation after a full reshuffle and starts only one new batch", async () => {
  const first = deferredColor();
  vi.mocked(gateway.prepareRevisitColorBundle).mockReturnValueOnce(first.promise).mockResolvedValue(null);
  const user = userEvent.setup();
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole("button", { name: "전체 다시 섞기" }));
  await waitFor(() => expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(2));
  expect(gateway.prepareRevisitColorBundle).toHaveBeenLastCalledWith(slate.localDate, expect.any(String), 1);
  await act(async () => { first.resolve(colorSlate); });
  expect(screen.queryByRole("button", { name: "비슷한 색감 자산 보기" })).not.toBeInTheDocument();
});

it("ignores optional results after a bundle reshuffle, gateway change and unmount", async () => {
  const first = deferredColor();
  vi.mocked(gateway.prepareRevisitColorBundle).mockReturnValue(first.promise);
  const user = userEvent.setup();
  const view = render(<Harness gateway={gateway} />);
  await waitFor(() => expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  await user.click(screen.getAllByRole("button", { name: "이 묶음 다시 섞기" })[0]!);
  await act(async () => { first.resolve(colorSlate); });
  expect(screen.queryByRole("button", { name: "비슷한 색감 자산 보기" })).not.toBeInTheDocument();
  const second = deferredColor();
  const other = { ...gateway, prepareRevisitColorBundle: vi.fn().mockReturnValue(second.promise) };
  view.rerender(<Harness gateway={other} />);
  await waitFor(() => expect(other.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { second.resolve(colorSlate); });
  expect(screen.queryByRole("button", { name: "비슷한 색감 자산 보기" })).not.toBeInTheDocument();
});

it("does not replace a new gateway slate with the previous gateway's late result", async () => {
  const first = deferredColor();
  vi.mocked(gateway.prepareRevisitColorBundle).mockReturnValue(first.promise);
  const view = render(<Harness gateway={gateway} />);
  await waitFor(() => expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  const other = { ...gateway, prepareRevisitColorBundle: vi.fn().mockResolvedValue(null) };
  view.rerender(<Harness gateway={other} />);
  await waitFor(() => expect(other.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  await act(async () => { first.resolve(colorSlate); });
  expect(screen.queryByRole("button", { name: "비슷한 색감 자산 보기" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("작가 다시보기")).toBeVisible();
});

it("keeps the base cards and shuffle controls when optional preparation rejects", async () => {
  vi.mocked(gateway.prepareRevisitColorBundle).mockRejectedValue(new Error("unreadable thumbnail"));
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "작가 다시보기 자산 보기" })).toBeVisible());
  await waitFor(() => expect(screen.getByRole("button", { name: "전체 다시 섞기" })).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("색감 추천을 준비하지 못했습니다.")).toBeVisible();
  expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(1);
});

it("reuses a saved color slate without preparing it again and supports color feedback", async () => {
  vi.mocked(gateway.getRevisitSlate).mockResolvedValue(colorSlate);
  const user = userEvent.setup();
  render(<Harness gateway={gateway} />);
  await screen.findByLabelText("비슷한 색감");
  expect(gateway.prepareRevisitColorBundle).not.toHaveBeenCalled();
  await user.click(screen.getAllByRole("button", { name: "관심 없음" })[2]!);
  await user.click(await screen.findByRole("menuitem", { name: "이런 추천 덜 보기" }));
  expect(gateway.setRevisitPreference).toHaveBeenCalledWith({ kind: "recommendation_type", recommendationType: "color" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "비슷한 색감 자산 보기" })).not.toBeInTheDocument());
});

it("opens a saved color card through the existing bundle navigation callback", async () => {
  vi.mocked(gateway.getRevisitSlate).mockResolvedValue(colorSlate);
  const open = vi.fn();
  render(<LibraryProvider gateway={gateway}><TodayView onOpenBundle={open} /></LibraryProvider>);
  await userEvent.click(await screen.findByRole("button", { name: "비슷한 색감 자산 보기" }));
  expect(open).toHaveBeenCalledWith("color-1");
});

it("keeps three named columns while color is preparing and when no match is returned", async () => {
  const preparation = deferredColor();
  vi.mocked(gateway.prepareRevisitColorBundle).mockReturnValue(preparation.promise);
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(gateway.prepareRevisitColorBundle).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("region", { name: "작가 다시보기" })).toBeVisible();
  expect(screen.getByRole("region", { name: "과거 수집함" })).toBeVisible();
  expect(screen.getByRole("region", { name: "비슷한 색감" })).toBeVisible();
  expect(screen.getByText("비슷한 색감의 자료를 찾고 있습니다.")).toBeVisible();
  await act(async () => { preparation.resolve(null); });
  expect(screen.getByText("이번 추천에는 준비된 색감 묶음이 없습니다.")).toBeVisible();
  expect(screen.getAllByRole("region")).toHaveLength(3);
});

it("explains when a color shuffle has no alternative and clears the notice on retry", async () => {
  gateway.getRevisitSlate = vi.fn().mockResolvedValue(colorSlate);
  gateway.reshuffleRevisitBundle = vi.fn().mockResolvedValueOnce(colorSlate).mockResolvedValueOnce({
    ...colorSlate, revision: 2, bundles: colorSlate.bundles.map(bundle => bundle.kind === "color"
      ? { ...bundle, id: "color-2", revision: 2, assetIds: ["asset-b"] } : bundle),
  });
  const user = userEvent.setup();
  render(<Harness gateway={gateway} />);
  await screen.findByRole("button", { name: "비슷한 색감 자산 보기" });
  await user.click(screen.getAllByRole("button", { name: "이 묶음 다시 섞기" })[2]!);
  expect(await screen.findByText("이번에는 새로운 색감 묶음을 찾지 못했습니다. 기존 묶음을 유지합니다.")).toBeVisible();
  await user.click(screen.getAllByRole("button", { name: "이 묶음 다시 섞기" })[2]!);
  await waitFor(() => expect(screen.queryByText("이번에는 새로운 색감 묶음을 찾지 못했습니다. 기존 묶음을 유지합니다.")).not.toBeInTheDocument());
});
