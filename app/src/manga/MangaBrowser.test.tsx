import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MangaSeries } from "../library/types";
import { MangaBrowser } from "./MangaBrowser";

afterEach(cleanup);

const series: MangaSeries[] = [
  { id: "s1", title: "T1", author: "a", galleryId: null, pageCount: 60 },
  { id: "s2", title: "T2", author: "b", galleryId: null, pageCount: 40 },
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

    await user.click(screen.getByRole("button", { name: "정렬: 최근 변경순" }));
    await user.click(screen.getByRole("menuitemradio", { name: "페이지 많은 순" }));
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

  it("previews exact catalog recovery and applies only pending exact bookmarks", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const firstPreview = {
      totalCount: 4,
      exactActiveCount: 2,
      historicalCount: 1,
      fallbackCount: 1,
      alreadyBookmarkedCount: 1,
      items: [
        { mangaId: "m1", title: "A", author: "a", galleryId: "10", pageCount: 20, status: "exact_active" as const, workId: 10, catalogTitle: "A", catalogTitleJpn: null, catalogFileCount: 20, bookmarked: false },
        { mangaId: "m2", title: "B", author: "b", galleryId: "12", pageCount: 22, status: "exact_active" as const, workId: 12, catalogTitle: "B", catalogTitleJpn: null, catalogFileCount: 22, bookmarked: true },
        { mangaId: "m3", title: "C", author: "c", galleryId: "11", pageCount: 21, status: "historical" as const, workId: 11, catalogTitle: "C", catalogTitleJpn: null, catalogFileCount: 21, bookmarked: false },
        { mangaId: "m4", title: "D", author: "d", galleryId: null, pageCount: 23, status: "fallback" as const, workId: null, catalogTitle: null, catalogTitleJpn: null, catalogFileCount: null, bookmarked: false },
      ],
    };
    const finalPreview = { ...firstPreview, alreadyBookmarkedCount: 2, items: firstPreview.items.map((item) => item.status === "exact_active" ? { ...item, bookmarked: true } : item) };
    gateway.previewMangaCatalogRecovery = vi.fn()
      .mockResolvedValueOnce(firstPreview)
      .mockResolvedValueOnce(finalPreview);
    gateway.applyMangaCatalogRecovery = vi.fn().mockResolvedValue({
      matchedCount: 2,
      createdBookmarks: 1,
      existingBookmarks: 1,
    });

    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await screen.findByText("T1");
    await userEvent.click(screen.getByRole("button", { name: "카탈로그로 복구" }));

    expect(await screen.findByRole("region", { name: "카탈로그 복구 미리보기" })).toBeVisible();
    expect(screen.getByText("정확한 현행 작품 2개")).toBeVisible();
    expect(screen.getByText("과거/삭제 작품 1개")).toBeVisible();
    expect(screen.getByText("검토 필요 1개")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "확정 1개 북마크 등록" }));
    await waitFor(() => expect(gateway.applyMangaCatalogRecovery).toHaveBeenCalledOnce());
    await waitFor(() => expect(gateway.previewMangaCatalogRecovery).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "확정 0개 북마크 등록" })).toBeDisabled();
  });

  it("shows lineage suggestions and fallback candidates with explicit per-item apply", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.previewMangaCatalogRecovery = vi.fn()
      .mockResolvedValueOnce({
        totalCount: 3,
        exactActiveCount: 1,
        historicalCount: 1,
        fallbackCount: 1,
        alreadyBookmarkedCount: 0,
        items: [
          { mangaId: "m1", title: "A", author: "a", galleryId: "10", pageCount: 20, status: "exact_active" as const, workId: 10, catalogTitle: "A", catalogTitleJpn: null, catalogFileCount: 20, bookmarked: false, suggestedWorkId: null, suggestionReason: null, suggestionTitle: null, candidates: [] },
          { mangaId: "m3", title: "C", author: "c", galleryId: "11", pageCount: 21, status: "historical" as const, workId: 11, catalogTitle: "C", catalogTitleJpn: null, catalogFileCount: 21, bookmarked: false, suggestedWorkId: 12, suggestionReason: "현행판", suggestionTitle: "C New", candidates: [] },
          {
            mangaId: "m4", title: "D", author: "d", galleryId: null, pageCount: 23, status: "fallback" as const, workId: null, catalogTitle: null, catalogTitleJpn: null, catalogFileCount: null, bookmarked: false,
            suggestedWorkId: null, suggestionReason: null, suggestionTitle: null,
            candidates: [
              { workId: 13, title: "D New", titleJpn: null, artist: "d", fileCount: 23, reasons: ["작가 일치", "페이지 수 일치"], confidence: "review" as const },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        totalCount: 3,
        exactActiveCount: 1,
        historicalCount: 1,
        fallbackCount: 1,
        alreadyBookmarkedCount: 1,
        items: [],
      });
    gateway.applyMangaCatalogRecoverySelection = vi.fn().mockResolvedValue({
      matchedCount: 1,
      createdBookmarks: 1,
      existingBookmarks: 0,
    });

    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await screen.findByText("T1");
    await userEvent.click(screen.getByRole("button", { name: "카탈로그로 복구" }));

    expect(await screen.findByText("과거 작품 계보 제안 (자동 등록 안 함)")).toBeVisible();
    expect(screen.getByText("→ 현행판 C New (ID 12)")).toBeVisible();
    expect(screen.getByText("검토 필요 (자동 등록 안 함)")).toBeVisible();
    expect(screen.getByText("D New · d · 23페이지 (ID 13)")).toBeVisible();

    const applyButtons = screen.getAllByRole("button", { name: "이 작품으로 등록" });
    expect(applyButtons.length).toBe(2);
    await userEvent.click(applyButtons[0]!);
    await waitFor(() => expect(gateway.applyMangaCatalogRecoverySelection).toHaveBeenCalledWith([{ mangaId: "m3", workId: 12 }]));
    await waitFor(() => expect(gateway.previewMangaCatalogRecovery).toHaveBeenCalledTimes(2));
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

    await userEvent.click(screen.getByRole("button", { name: "카탈로그" }));

    expect(await screen.findByText("온라인 카탈로그가 없습니다")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "폴더" }));
    expect(screen.getByText("T1")).toBeVisible();
  });
});

function createGateway(overrides: { root: string | null; series: MangaSeries[] }): LibraryGateway {
  const base: LibraryGateway = {
    getIgdbCredentialStatus: vi.fn(),
    setIgdbCredentials: vi.fn(),
    deleteIgdbCredentials: vi.fn(),
    searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(),
    applyIgdbGame: vi.fn(),
    refreshIgdbGame: vi.fn(),
    getIgdbConnection: vi.fn(),
    replaceIgdbGameArtwork: vi.fn(),
    getTmdbCredentialStatus: vi.fn(),
    setTmdbToken: vi.fn(),
    deleteTmdbToken: vi.fn(),
    searchTmdbMovies: vi.fn(),
    previewTmdbMovie: vi.fn(),
    applyTmdbMovie: vi.fn(),
    refreshTmdbMovie: vi.fn(),
    getTmdbConnection: vi.fn(),
    replaceTmdbMovieArtwork: vi.fn(),
    openLibrary: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), listAssetDateBuckets: vi.fn().mockResolvedValue([]), indexMissingSimilarityHashes: vi.fn(),
    listAssetCreators: vi.fn().mockResolvedValue([]),
    getRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitBundle: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), importCollectionArtworks: vi.fn().mockResolvedValue(0),
  listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(overrides.root),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(overrides.series.length),
    listMangaSeries: vi.fn().mockResolvedValue(overrides.series),
    importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: false, apiBaseUrl: null, tokenConfigured: false }), setCloudCaptureSettings: vi.fn(), setCloudApiToken: vi.fn(), deleteCloudApiToken: vi.fn(), testCloudCaptureConnection: vi.fn().mockResolvedValue({ pendingCount: 0 }), runDueCloudCaptureSync: vi.fn().mockResolvedValue({ attempted: 0, acknowledged: 0, failed: 0, reviewPending: 0, added: 0, videoAdded: 0, classificationChanged: 0 }), cloudBackfillPreflight: vi.fn(), cloudBackfillSeed: vi.fn(), cloudBackfillRunCycle: vi.fn(), cloudBackfillProgress: vi.fn(), cloudBackfillRetryFailed: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
  };
  return base;
}
