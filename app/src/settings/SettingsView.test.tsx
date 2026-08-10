import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { SettingsView } from "./SettingsView";

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

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    setAssetClassifications: vi.fn(), patchAssetClassifications: vi.fn(), getAssetClassifications: vi.fn(), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    trashAsset: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}
