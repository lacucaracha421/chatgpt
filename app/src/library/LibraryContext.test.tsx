import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "./types";
import { LIBRARY_PATH_STORAGE_KEY, LibraryProvider, useLibrary } from "./LibraryContext";

afterEach(() => {
  localStorage.clear();
  cleanup();
});

it("keeps the current library when opening another library fails", async () => {
  localStorage.setItem(LIBRARY_PATH_STORAGE_KEY, "C:\\Current");
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.openLibrary)
    .mockResolvedValueOnce({ root: "C:\\Current" })
    .mockRejectedValueOnce(new Error("switch failed"));
  render(<LibraryProvider gateway={libraryGateway}><Probe /></LibraryProvider>);

  expect(await screen.findByText("C:\\Current")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "switch" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("switch failed");
  expect(screen.getByText("C:\\Current")).toBeVisible();
  expect(localStorage.getItem(LIBRARY_PATH_STORAGE_KEY)).toBe("C:\\Current");
});

function Probe() {
  const { library, error, openLibrary } = useLibrary();
  return <>
    <span>{library?.root ?? "none"}</span>
    {error && <span role="alert">{error}</span>}
    <button onClick={() => void openLibrary("D:\\Broken")}>switch</button>
  </>;
}

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}
