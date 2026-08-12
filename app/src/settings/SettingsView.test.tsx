import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MetadataBackup } from "../library/types";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";

afterEach(() => { vi.useRealTimers(); cleanup(); });

it("acts as the window title bar", async () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  await screen.findByRole("toolbar");
  expect(container.querySelector(".view-toolbar")).toHaveAttribute("data-tauri-drag-region");
  expect(container.querySelector(".view-toolbar h2")).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("uses the shared view toolbar with window controls", async () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  expect(await screen.findByRole("toolbar")).toBeInTheDocument();
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("loads the manga root and changes it through the folder picker", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getMangaRoot).mockResolvedValue("C:\\Manga");
  vi.mocked(open).mockResolvedValue("D:\\NewManga");
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  expect(await screen.findByText("C:\\Manga")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "변경" }));

  await waitFor(() => expect(gateway.setMangaRoot).toHaveBeenCalledWith("D:\\NewManga"));
  expect(await screen.findByText("D:\\NewManga")).toBeInTheDocument();
});

it("keeps the current manga root when the folder picker is cancelled", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getMangaRoot).mockResolvedValue("C:\\Manga");
  vi.mocked(open).mockResolvedValue(null);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "변경" }));

  await waitFor(() => expect(open).toHaveBeenCalledWith({ directory: true, multiple: false }));
  expect(gateway.setMangaRoot).not.toHaveBeenCalled();
  expect(screen.getByText("C:\\Manga")).toBeInTheDocument();
});

it("keeps backup load errors visible for retry", async () => {
  vi.useFakeTimers();
  let rejectBackups!: (error: Error) => void;
  let resolveRetry!: (backups: MetadataBackup[]) => void;
  const failed = new Promise<MetadataBackup[]>((_resolve, reject) => { rejectBackups = reject; });
  const retried = new Promise<MetadataBackup[]>((resolve) => { resolveRetry = resolve; });
  const gateway = createGateway();
  vi.mocked(gateway.listMetadataBackups).mockReturnValueOnce(failed).mockReturnValueOnce(retried);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "안전" }));
  act(() => vi.advanceTimersByTime(0));
  await act(async () => { rejectBackups(new Error("backup failed")); await failed.catch(() => undefined); });
  act(() => vi.advanceTimersByTime(5_000));

  expect(screen.getByText("backup failed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  act(() => vi.advanceTimersByTime(0));
  await act(async () => { resolveRetry([]); await retried; });

  expect(gateway.listMetadataBackups).toHaveBeenCalledTimes(2);
  expect(screen.getByText("사용할 수 있는 백업이 없습니다.")).toBeVisible();
  expect(screen.queryByText("backup failed")).not.toBeInTheDocument();
});

it("shows the Edge connection and copies its hidden key on request", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const gateway = createGateway();
  vi.mocked(gateway.getExtensionConnection).mockResolvedValue({
    baseUrl: "http://127.0.0.1:32145",
    token: "0123456789abcdef0123456789abcdef",
    status: "ready",
  });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "브라우저 확장" }));

  expect(await screen.findByText("연결됨")).toBeVisible();
  expect(screen.getByText("http://127.0.0.1:32145")).toBeVisible();
  const token = screen.getByLabelText("확장 프로그램 연결 키");
  expect(token).toHaveAttribute("type", "password");
  expect(token).toHaveAttribute("readonly");
  expect(writeText).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "연결 키 복사" }));

  expect(writeText).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef");
  expect(await screen.findByText("연결 키를 복사했습니다")).toBeVisible();
});

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}
