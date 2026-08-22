import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MangaSeries } from "../library/types";
import { MangaBrowser } from "./MangaBrowser";

afterEach(cleanup);

const series: MangaSeries[] = [
  { id: "s1", title: "T1", author: "a", pageCount: 60 },
  { id: "s2", title: "T2", author: "b", pageCount: 40 },
];

describe("MangaBrowser", () => {
  it("scans and shows the cover grid when the root is set", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await waitFor(() => expect(gateway.scanManga).toHaveBeenCalled());
    expect(await screen.findByText("T1")).toBeVisible();
    expect(screen.getByText("T2")).toBeVisible();
    expect(screen.getAllByRole("img").length).toBe(2);
  });

  it("shows cached manga while a slow scan continues", async () => {
    let finishScan!: () => void;
    const scanning = new Promise<number>((resolve) => { finishScan = () => resolve(0); });
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.scanManga = vi.fn().mockReturnValue(scanning);

    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);

    expect(await screen.findByText("T1")).toBeVisible();
    expect(screen.getByRole("button", { name: "스캔 중" })).toBeDisabled();
    finishScan();
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled());
  });

  it("shows the setup prompt when the root is not set", async () => {
    const gateway = createGateway({ root: null, series: [] });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    expect(await screen.findByText("망가 폴더가 설정되지 않았습니다")).toBeVisible();
  });

  it("uses the shared view toolbar with window controls", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const { container } = render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    expect(await screen.findByRole("toolbar")).toBeInTheDocument();
    expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
  });

  it("filters by title or author and reports the visible count", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const user = userEvent.setup();
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);

    expect(await screen.findByText("2개 작품")).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "망가 검색" }), "b");

    expect(screen.queryByText("T1")).not.toBeInTheDocument();
    expect(screen.getByText("T2")).toBeVisible();
    expect(screen.getByText("1 / 2개 작품")).toBeVisible();
  });

  it("sorts manga and changes the card density", async () => {
    const gateway = createGateway({ root: "C:\\manga", series: [series[1]!, series[0]!] });
    const user = userEvent.setup();
    const { container } = render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await screen.findByText("T1");

    await user.selectOptions(screen.getByRole("combobox", { name: "정렬" }), "pages_desc");
    expect(container.querySelectorAll(".manga-browser__cover-title")[0]).toHaveTextContent("T1");

    fireEvent.change(screen.getByRole("slider", { name: "카드 크기" }), { target: { value: "200" } });
    expect(container.querySelector(".manga-browser__grid")).toHaveStyle("--manga-card-width: 200px");
  });

  it("opens the viewer when a cover is clicked", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const onOpenSeries = vi.fn();
    render(<LibraryProvider gateway={gateway}><MangaBrowser onOpenSeries={onOpenSeries} /></LibraryProvider>);
    await userEvent.click(await screen.findByText("T1"));
    expect(onOpenSeries).toHaveBeenCalledWith(series[0]);
  });

  it("switches between local and online manga sources", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.getOnlineCatalogStatus = vi.fn().mockResolvedValue({
      installed: false,
      workCount: 0,
      updateEnabled: true,
      updateIntervalSeconds: 3600,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastAdded: 0,
      lastError: null,
    });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await screen.findByText("T1");

    await userEvent.click(screen.getByRole("button", { name: "온라인 카탈로그" }));

    expect(await screen.findByText("온라인 카탈로그가 없습니다")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "로컬 폴더" }));
    expect(screen.getByText("T1")).toBeVisible();
  });
});

function createGateway(overrides: { root: string | null; series: MangaSeries[] }): LibraryGateway {
  const base: LibraryGateway = {
    openLibrary: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(overrides.root),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(overrides.series.length),
    listMangaSeries: vi.fn().mockResolvedValue(overrides.series),
    importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
  };
  return base;
}
