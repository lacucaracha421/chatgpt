import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, TrashPage } from "../library/types";
import { TrashBrowser } from "./TrashBrowser";

afterEach(cleanup);

it("loads trash, shows its purge date, and restores an asset", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await waitFor(() => expect(gateway.listTrash).toHaveBeenCalledWith({ after: null, limit: 100 }));
  expect(await screen.findByText("영구 삭제까지 12일")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "복원" }));
  expect(gateway.restoreAsset).toHaveBeenCalledWith("asset-1");
});

it("keeps retention controls disabled until the policy is loaded", () => {
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy).mockReturnValue(new Promise(() => undefined));

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).not.toBeChecked();
  expect(screen.queryByRole("spinbutton", { name: "보존 기간" })).not.toBeInTheDocument();
});

it("keeps a loaded trash page visible when the policy request fails and retries both", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy)
    .mockRejectedValueOnce(new Error("policy failed"))
    .mockResolvedValueOnce({ retentionDays: 30 });

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  expect(await screen.findByText("asset-1.png")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();
  expect(screen.getByText("policy failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "다시 시도" }));

  await waitFor(() => expect(gateway.listTrash).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(gateway.getTrashPolicy).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).not.toBeDisabled();
});

it("shows a retry instead of an empty state when listing trash fails", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash)
    .mockRejectedValueOnce(new Error("trash list failed"))
    .mockResolvedValueOnce({ items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1_024 });

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  expect(await screen.findByText("trash list failed")).toBeVisible();
  expect(screen.getByRole("heading", { name: "휴지통을 불러오지 못했습니다." })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "다시 시도" }));

  expect(await screen.findByText("asset-1.png")).toBeVisible();
});

it("retries after listing trash fails while policy loading is still pending", async () => {
  const neverPolicy = new Promise<{ retentionDays: number | null }>(() => undefined);
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash)
    .mockRejectedValueOnce(new Error("trash list failed"))
    .mockResolvedValueOnce({ items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1_024 });
  vi.mocked(gateway.getTrashPolicy)
    .mockReturnValueOnce(neverPolicy)
    .mockResolvedValueOnce({ retentionDays: 30 });

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  expect(await screen.findByText("trash list failed")).toBeVisible();
  const retry = screen.getByRole("button", { name: "다시 시도" });
  expect(retry).not.toBeDisabled();
  await user.click(retry);

  expect(await screen.findByText("asset-1.png")).toBeVisible();
  expect(gateway.getTrashPolicy).toHaveBeenCalledTimes(2);
});

it("retries after policy loading fails while listing trash is still pending", async () => {
  const neverPage = new Promise<TrashPage>(() => undefined);
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash)
    .mockReturnValueOnce(neverPage)
    .mockResolvedValueOnce({ items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1_024 });
  vi.mocked(gateway.getTrashPolicy)
    .mockRejectedValueOnce(new Error("policy failed"))
    .mockResolvedValueOnce({ retentionDays: 30 });

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  expect(await screen.findByText("policy failed")).toBeVisible();
  const retry = screen.getByRole("button", { name: "다시 시도" });
  expect(retry).not.toBeDisabled();
  await user.click(retry);

  expect(await screen.findByText("asset-1.png")).toBeVisible();
  expect(gateway.listTrash).toHaveBeenCalledTimes(2);
});

it("ignores an older policy completion after a newer refresh", async () => {
  let resolveInitialPolicy!: (value: { retentionDays: number | null }) => void;
  const initialPolicy = new Promise<{ retentionDays: number | null }>((resolve) => { resolveInitialPolicy = resolve; });
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy)
    .mockReturnValueOnce(initialPolicy)
    .mockResolvedValueOnce({ retentionDays: 45 });

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await user.click(await screen.findByRole("button", { name: "복원" }));
  await waitFor(() => expect(gateway.getTrashPolicy).toHaveBeenCalledTimes(2));
  await act(async () => { resolveInitialPolicy({ retentionDays: 30 }); await initialPolicy; });

  expect(await screen.findByRole("spinbutton", { name: "보존 기간" })).toHaveValue(45);
});

it("disables conflicting trash mutations while a restore is pending", async () => {
  let resolveRestore!: () => void;
  const pendingRestore = new Promise<void>((resolve) => { resolveRestore = resolve; });
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.restoreAsset).mockReturnValue(pendingRestore);

  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await user.click(await screen.findByRole("button", { name: "복원" }));
  expect(screen.getByRole("button", { name: "복원" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "휴지통 비우기" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();

  await act(async () => { resolveRestore(); await pendingRestore; });
});

it("disables automatic deletion and saves a valid retention period", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await screen.findByRole("checkbox", { name: "자동 삭제" });
  await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
  expect(gateway.setTrashPolicy).toHaveBeenCalledWith({ retentionDays: null });

  await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
  const input = screen.getByRole("spinbutton", { name: "보존 기간" });
  await user.clear(input);
  await user.type(input, "45");
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(gateway.setTrashPolicy).toHaveBeenLastCalledWith({ retentionDays: 45 });
});

it("confirms emptying the whole trash using the server totals", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);

  await screen.findByText("asset-1.png");
  await user.click(screen.getByRole("button", { name: "휴지통 비우기" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("2개 (3 KB)를 영구 삭제합니다.");
  await user.click(screen.getByRole("button", { name: "영구 삭제" }));
  expect(gateway.emptyTrash).toHaveBeenCalledOnce();
});

it("uses the shared view toolbar with window controls", async () => {
  const gateway = createGateway();
  const { container } = render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);
  expect(await screen.findByRole("toolbar")).toBeInTheDocument();
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn().mockResolvedValue({
      items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: new Date(Date.now() + 12 * 86_400_000).toISOString() }],
      nextCursor: null,
      totalCount: 2,
      totalBytes: 3_072,
    }),
    emptyTrash: vi.fn().mockResolvedValue({ deletedCount: 2, failedAssetIds: [] }),
    getTrashPolicy: vi.fn().mockResolvedValue({ retentionDays: 30 }),
    setTrashPolicy: vi.fn().mockResolvedValue(undefined),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}

function asset() {
  return {
    id: "asset-1", title: null, originalName: "asset-1.png", byteSize: 1_024,
    width: 200, height: 100, collectedAt: "2026-07-20T00:00:00Z", favorite: false, sourceUrl: null,
    sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null,
    importSource: null, importBatchId: null, originalModifiedAt: null,
    media: { kind: "image" as const },
  };
}
