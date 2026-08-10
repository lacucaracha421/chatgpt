import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";

afterEach(cleanup);

it("acts as the window title bar", () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  expect(container.querySelector(".settings-view__toolbar")).toHaveAttribute("data-tauri-drag-region");
  expect(container.querySelector(".settings-view__toolbar > div")).toHaveAttribute("data-tauri-drag-region");
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

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    setAssetClassifications: vi.fn(), patchAssetClassifications: vi.fn(), getAssetClassifications: vi.fn(), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    trashAsset: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}
