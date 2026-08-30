import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropSubscriber } from "../ingestion/useFileDrop";
import type {
  AssetSummary,
  ClassificationEntry,
  LibraryGateway,
  MetadataBackup,
  ReleaseWatchRunResult,
} from "../library/types";
import { UI_PREFERENCES_KEY } from "../preferences/uiPreferences";
import { App, type ExtensionIngestListener } from "./App";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";

const summary = { root: "C:\\Lakomics" };
const games: ClassificationEntry = {
  id: "root-games",
  kind: "root",
  name: "게임",
  parentId: null,
  iconKey: null,
  colorKey: null,
};
const blueArchive: ClassificationEntry = {
  id: "work-blue-archive",
  kind: "work",
  name: "블루 아카이브",
  parentId: "root-games",
  iconKey: null,
  colorKey: null,
};
const arona: ClassificationEntry = {
  id: "tag-arona",
  kind: "tag",
  name: "아로나",
  parentId: "work-blue-archive",
  iconKey: null,
  colorKey: null,
};
const images: ClassificationEntry = {
  id: "root-images",
  kind: "root",
  name: "이미지",
  parentId: null,
  iconKey: null,
  colorKey: null,
};
const asset: AssetSummary = {
  id: "asset-arona",
  title: null,
  originalName: "arona.png",
  byteSize: 123,
  width: 8,
  height: 6,
  collectedAt: "2026-07-31T00:00:00Z",
  favorite: false,
  sourceUrl: null,
  sourcePublishedAt: null,
  creatorName: null,
  creatorHandle: null,
  creatorUrl: null,
  importSource: null,
  importBatchId: null,
  originalModifiedAt: null,
  media: { kind: "image" },
};
const noDrops: DropSubscriber = async () => () => undefined;
const metadataBackup: MetadataBackup = {
  id: "backup-1",
  kind: "daily",
  createdAt: "2026-08-01T12:00:00Z",
  byteSize: 2048,
};

function gateway(): LibraryGateway {
  return {
    getIgdbCredentialStatus: vi.fn(),
    setIgdbCredentials: vi.fn(),
    deleteIgdbCredentials: vi.fn(),
    searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(),
    applyIgdbGame: vi.fn(),
    refreshIgdbGame: vi.fn(),
    getIgdbConnection: vi.fn().mockResolvedValue(null),
    replaceIgdbGameArtwork: vi.fn(),
    getTmdbCredentialStatus: vi.fn(),
    setTmdbToken: vi.fn(),
    deleteTmdbToken: vi.fn(),
    searchTmdbMovies: vi.fn(),
    previewTmdbMovie: vi.fn(),
    applyTmdbMovie: vi.fn(),
    refreshTmdbMovie: vi.fn(),
    getTmdbConnection: vi.fn().mockResolvedValue(null),
    replaceTmdbMovieArtwork: vi.fn(),
    openLibrary: vi.fn().mockResolvedValue(summary),
    importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
    getExtensionConnection: vi.fn(),
    listClassifications: vi.fn().mockResolvedValue([]),
    listAlbums: vi.fn().mockResolvedValue([]),
    createAlbum: vi.fn(),
    renameAlbum: vi.fn(),
    moveAlbum: vi.fn(),
    updateAlbumAppearance: vi.fn(),
    deleteAlbum: vi.fn(),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(),
    listAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listAssetDateBuckets: vi.fn().mockResolvedValue([]),
    listAssetCreators: vi.fn().mockResolvedValue([]),
    indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }),
    decideSimilarityReview: vi.fn(),
    getAsset: vi.fn(),
    updateAssetMetadata: vi.fn(),
    trashAssets: vi.fn(),
    restoreAsset: vi.fn(),
    restoreAssets: vi.fn(),
    listTrash: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0, totalBytes: 0 }),
    emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn().mockResolvedValue({ retentionDays: 30 }),
    setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn().mockResolvedValue(null),
    listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(),
    purgeExpiredTrash: vi.fn().mockResolvedValue({ deletedCount: 0, failedAssetIds: [] }),
    setAssetFavorite: vi.fn(),
    setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(),
    setAssetClassification: vi.fn(),
    patchAssetAlbums: vi.fn(),
    getAssetAlbums: vi.fn().mockResolvedValue([]),
    listCollections: vi.fn().mockResolvedValue([]),
    searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null),
    createCollection: vi.fn(),
    updateCollection: vi.fn(),
    deleteCollection: vi.fn(),
    setCollectionCover: vi.fn(),
    setCollectionShowcase: vi.fn(),
    getAssetCollections: vi.fn().mockResolvedValue([]),
    patchAssetCollections: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null),
    getCollectionSourceRoot: vi.fn().mockResolvedValue(null),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(0),
    listMangaSeries: vi.fn().mockResolvedValue([]),
    ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn().mockResolvedValue({ processed: 0, remaining: 0, failed: 0, changedAssetIds: [] }),
    retryVideoPreparation: vi.fn().mockResolvedValue(undefined), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), setCollectionSourceRoot: vi.fn(), importCollectionArtworks: vi.fn().mockResolvedValue(0),
  listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
  };
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(open).mockReset();
  });
  afterEach(cleanup);

  it("opens the selected library and persists it", async () => {
    const user = userEvent.setup();
    const selectFolder = vi.fn().mockResolvedValue("C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={selectFolder} />);

    await user.click(screen.getByRole("button", { name: "라이브러리 선택" }));

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
    expect(localStorage.getItem("lakomics.libraryPath")).toBe("C:\\Lakomics");
  });

  it("remounts and reloads the workspace after switching library roots", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Current");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.openLibrary).mockImplementation(async (path) => ({ root: path }));
    vi.mocked(libraryGateway.listClassifications)
      .mockResolvedValueOnce([{ ...games, id: "old-root", name: "Old library" }])
      .mockResolvedValue([{ ...games, id: "new-root", name: "New library" }]);
    vi.mocked(open).mockResolvedValue("D:\\Next");
    render(<App gateway={libraryGateway} subscribeDrops={noDrops} />);

    expect(await screen.findByRole("treeitem", { name: "Old library" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "설정" }));
    await userEvent.click(screen.getByRole("button", { name: "다른 저장소 열기" }));

    expect(await screen.findByRole("treeitem", { name: "New library" })).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: "Old library" })).not.toBeInTheDocument();
  });

  it("checks due releases once without blocking the workspace and refreshes changed collections", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let finishWatch!: (result: ReleaseWatchRunResult) => void;
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.runDueReleaseWatch).mockReturnValue(new Promise((resolve) => { finishWatch = resolve; }));

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    expect(await screen.findByRole("main", { name: "라이브러리 작업 공간" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "저장소" })).toBeVisible();
    expect(libraryGateway.runDueReleaseWatch).toHaveBeenCalledOnce();
    await waitFor(() => expect(libraryGateway.listCollections).toHaveBeenCalledOnce());

    finishWatch({ checked: 3, changedCollections: 2, skipped: 0, stopReason: null });

    await waitFor(() => expect(libraryGateway.listCollections).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("새 출간 정보가 있는 작품 2개");
  });

  it("ignores a stale release-watch result after switching libraries", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Current");
    let finishOldWatch!: (result: ReleaseWatchRunResult) => void;
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.openLibrary).mockImplementation(async (path) => ({ root: path }));
    vi.mocked(libraryGateway.runDueReleaseWatch)
      .mockReturnValueOnce(new Promise((resolve) => { finishOldWatch = resolve; }))
      .mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null });
    vi.mocked(open).mockResolvedValue("D:\\Next");
    render(<App gateway={libraryGateway} subscribeDrops={noDrops} />);

    await waitFor(() => expect(libraryGateway.runDueReleaseWatch).toHaveBeenCalledOnce());
    await userEvent.click(await screen.findByRole("button", { name: "설정" }));
    await userEvent.click(screen.getByRole("button", { name: "다른 저장소 열기" }));
    await waitFor(() => expect(libraryGateway.runDueReleaseWatch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(libraryGateway.listCollections).toHaveBeenCalledTimes(3));

    await act(async () => {
      finishOldWatch({ checked: 1, changedCollections: 1, skipped: 0, stopReason: null });
      await Promise.resolve();
    });

    expect(libraryGateway.listCollections).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("새 출간 정보가 있는 작품 1개")).not.toBeInTheDocument();
  });

  it("shows no release-watch message when startup finds no changes", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    await waitFor(() => expect(libraryGateway.runDueReleaseWatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(libraryGateway.listCollections).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/새 출간 정보가 있는 작품/)).not.toBeInTheDocument();
  });

  it("renders the trash workspace without loading an asset page", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "휴지통 0개" }));

    await waitFor(() => expect(libraryGateway.listTrash).toHaveBeenCalledWith({ after: null, limit: 100 }));
  });

  it("does not ingest drops while trash is active", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
      return () => undefined;
    };
    const libraryGateway = gateway();
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={subscribeDrops} />);
    await user.click(await screen.findByRole("button", { name: "휴지통 0개" }));
    await waitFor(() => expect(drop).toBeDefined());
    act(() => drop?.(["C:\\images\\ignored.png"]));

    await Promise.resolve();
    expect(libraryGateway.ingestMedia).not.toHaveBeenCalled();
  });

  it("restores the saved library path when the app starts", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
  });

  it("loads albums with folders when the workspace opens", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listAlbums).mockResolvedValue([
      { id: "album-cover", name: "표지", parentId: null, iconKey: null, colorKey: null },
    ]);

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    expect(await screen.findByRole("treeitem", { name: "표지" })).toBeVisible();
    expect(libraryGateway.listClassifications).toHaveBeenCalledOnce();
    expect(libraryGateway.listAlbums).toHaveBeenCalledOnce();
  });

  it("runs daily backup once and then purges expired trash after opening a library", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    await waitFor(() => expect(libraryGateway.ensureDailyBackup).toHaveBeenCalledOnce());
    await waitFor(() => expect(libraryGateway.purgeExpiredTrash).toHaveBeenCalledOnce());
    expect(vi.mocked(libraryGateway.ensureDailyBackup).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(libraryGateway.purgeExpiredTrash).mock.invocationCallOrder[0]);
  });

  it("keeps the workspace and runs trash maintenance when daily backup fails", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.ensureDailyBackup).mockRejectedValue(new Error("자동 백업에 실패했습니다."));

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    expect(await screen.findByText("자동 백업에 실패했습니다.")).toBeVisible();
    expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
    await waitFor(() => expect(libraryGateway.purgeExpiredTrash).toHaveBeenCalledOnce());
  });

  it("reports only the count of assets that automatic trash purge could not delete", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.purgeExpiredTrash).mockResolvedValue({
      deletedCount: 3,
      failedAssetIds: ["private-asset-1", "private-asset-2"],
    });

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    expect(await screen.findByText("자동 삭제하지 못한 자산이 2개 있습니다.")).toBeVisible();
    expect(screen.queryByText(/private-asset/)).not.toBeInTheDocument();
  });

  it("keeps both startup warnings when backup and automatic purge have problems", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.ensureDailyBackup).mockRejectedValue(new Error("자동 백업 오류"));
    vi.mocked(libraryGateway.purgeExpiredTrash).mockResolvedValue({
      deletedCount: 0,
      failedAssetIds: ["private-asset"],
    });

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    expect(await screen.findByText(/자동 백업 오류.*자동 삭제하지 못한 자산이 1개 있습니다/)).toBeVisible();
    expect(screen.queryByText(/private-asset/)).not.toBeInTheDocument();
  });

  it("restores a backup and refreshes classifications and the current asset page", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listMetadataBackups).mockResolvedValue([metadataBackup]);
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await screen.findByRole("main", { name: "라이브러리 작업 공간" });
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalled());
    const classificationCalls = vi.mocked(libraryGateway.listClassifications).mock.calls.length;
    const assetCalls = vi.mocked(libraryGateway.listAssets).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: "데이터 관리" }));
    await user.click(await screen.findByRole("button", { name: "이 시점으로 복구" }));
    await user.click(screen.getByRole("button", { name: "복구 시작" }));

    await waitFor(() => expect(libraryGateway.restoreMetadataBackup).toHaveBeenCalledWith("backup-1"));
    expect(await screen.findByText("복구가 완료되었습니다.")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(libraryGateway.listClassifications).toHaveBeenCalledTimes(classificationCalls + 1));
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalledTimes(assetCalls + 1));
  });

  it("makes the workspace inert while backup restore is pending", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listMetadataBackups).mockResolvedValue([metadataBackup]);
    let finishRestore!: () => void;
    vi.mocked(libraryGateway.restoreMetadataBackup).mockReturnValue(new Promise<void>((resolve) => { finishRestore = resolve; }));
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: "데이터 관리" }));
    await user.click(await screen.findByRole("button", { name: "이 시점으로 복구" }));
    await user.click(screen.getByRole("button", { name: "복구 시작" }));

    await waitFor(() => expect(document.querySelector(".library-workspace")).toHaveAttribute("inert"));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "설정" })).toBeVisible();
    finishRestore();
    await waitFor(() => expect(document.querySelector(".library-workspace")).not.toHaveAttribute("inert"));
  });

  it("renders the persistent four-region workspace when a library is restored", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    expect(await screen.findByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
    const sidebar = screen.getByRole("complementary", { name: "분류" });
    const content = screen.getByRole("region", { name: "자산 내용" });
    expect(sidebar).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "자산 도구" })).toBeInTheDocument();
    expect(content).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(within(content).queryByRole("button", { name: "설정" })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "설정" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lakomics" })).not.toBeInTheDocument();
  });

  it("always opens all assets and maps the unsorted inbox to its query flag", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({
      metadataVisible: false,
      sidebarWidth: 264,
      expandedClassificationIds: ["root-games"],
      assetSort: "oldest",
    }));
    const libraryGateway = gateway();
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalledWith(expect.objectContaining({
      classificationId: null,
            unclassifiedOnly: false,
    })));
    expect(screen.getByRole("button", { name: "저장소" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "미분류" }));
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({
      classificationId: null,
            unclassifiedOnly: true,
    })));
  });

  it("stores drops from broad views in the unclassified destination", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
      return () => undefined;
    };
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.ingestMedia).mockResolvedValue({ status: "added", asset });
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={subscribeDrops} />);

    await user.click(await screen.findByRole("button", { name: "미분류" }));
    await waitFor(() => expect(drop).toBeDefined());
    act(() => drop?.(["C:\\images\\a.png"]));
    await waitFor(() => expect(libraryGateway.ingestMedia).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\a.png",
      classificationId: null,
      sourceUrl: null,
      importSource: "direct",
      importBatchId: expect.any(String),
    }));

    await user.click(screen.getByRole("button", { name: "작가" }));
    act(() => drop?.(["C:\\images\\recent.png"]));
    await user.click(screen.getByRole("button", { name: "저장소" }));
    act(() => drop?.(["C:\\images\\all-assets.png"]));

    await waitFor(() => expect(libraryGateway.ingestMedia).toHaveBeenCalledTimes(3));
    expect(libraryGateway.ingestMedia).toHaveBeenNthCalledWith(2, { sourcePath: "C:\\images\\recent.png", classificationId: null, sourceUrl: null, importSource: "direct", importBatchId: expect.any(String) });
    expect(libraryGateway.ingestMedia).toHaveBeenNthCalledWith(3, { sourcePath: "C:\\images\\all-assets.png", classificationId: null, sourceUrl: null, importSource: "direct", importBatchId: expect.any(String) });
  });

  it("refreshes assets and kicks off video preparation when the extension ingests a video", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let emit: ((outcome: { status: "added"; asset: AssetSummary }) => void) | undefined;
    const subscribeExtensionIngest: ExtensionIngestListener = async (handler) => {
      emit = handler;
      return () => undefined;
    };
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);
    vi.mocked(libraryGateway.listAssets).mockResolvedValue({ items: [], nextCursor: null });
    const videoAsset: AssetSummary = {
      ...asset,
      id: "asset-x-video",
      media: { kind: "video", durationMs: 1000, preparationState: "pending", scrubFrameCount: 0 },
    };

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} subscribeExtensionIngest={subscribeExtensionIngest} />);
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalled());
    const assetCallsBefore = vi.mocked(libraryGateway.listAssets).mock.calls.length;
    const prepareCallsBefore = vi.mocked(libraryGateway.preparePendingVideos).mock.calls.length;

    await act(async () => { emit?.({ status: "added", asset: videoAsset }); });

    await waitFor(() => expect(vi.mocked(libraryGateway.listAssets).mock.calls.length).toBeGreaterThan(assetCallsBefore));
    await waitFor(() => expect(vi.mocked(libraryGateway.preparePendingVideos).mock.calls.length).toBeGreaterThan(prepareCallsBefore));
  });

  it("loads and saves the complete validated UI preference object", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({
      metadataVisible: false,
      sidebarWidth: 264,
      expandedClassificationIds: ["root-games"],
      assetSort: "oldest",
    }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games, blueArchive]);
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    const metadata = await screen.findByLabelText("정보 표시");
    expect(metadata).not.toBeChecked();
    expect(screen.getByLabelText("정렬")).toHaveValue("oldest");
    expect(screen.getByRole("complementary", { name: "분류" })).toHaveStyle({ width: "264px" });

    await user.selectOptions(screen.getByLabelText("정렬"), "random");
    await user.click(metadata);
    await user.click(screen.getByRole("button", { name: "게임 접기" }));
    const resizeHandle = screen.getByRole("separator", { name: "사이드바 너비 조절" });
    Object.defineProperties(resizeHandle, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    fireEvent.pointerDown(resizeHandle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 1, clientX: 108 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}")).toEqual({
        metadataVisible: true,
        privacyMode: false,
        sidebarWidth: 272,
        expandedClassificationIds: [],
        expandedAlbumIds: [],
        assetSort: "random",
        thumbnailRowHeight: 180,
        creatorCardSize: 200,
        collectionType: "manga",
      }),
    );
  });

  it("debounces sidebar width preference writes while resizing", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);
    const sidebar = await screen.findByRole("complementary", { name: "분류" });
    const resizeHandle = screen.getByRole("separator", { name: "사이드바 너비 조절" });
    Object.defineProperties(resizeHandle, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockClear();
    vi.useFakeTimers();

    try {
      fireEvent.pointerDown(resizeHandle, { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(resizeHandle, { pointerId: 1, clientX: -100.4 });
      fireEvent.pointerMove(resizeHandle, { pointerId: 1, clientX: 400.4 });
      fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

      expect(sidebar).toHaveStyle({ width: "320px" });
      const preferenceWrites = () => setItem.mock.calls.filter(([key]) => key === UI_PREFERENCES_KEY);
      expect(preferenceWrites()).toHaveLength(0);

      act(() => vi.advanceTimersByTime(149));
      expect(preferenceWrites()).toHaveLength(0);
      act(() => vi.advanceTimersByTime(1));

      expect(preferenceWrites()).toHaveLength(1);
      expect(JSON.parse(String(preferenceWrites()[0][1])).sidebarWidth).toBe(320);
    } finally {
      vi.useRealTimers();
      setItem.mockRestore();
    }
  });

  it("keeps completed ingestion feedback in the work tray", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
      let drop: ((paths: string[]) => void) | undefined;
      const subscribeDrops: DropSubscriber = async (handler) => {
        drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
        return () => undefined;
      };
      const libraryGateway = gateway();
      vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);
      let resolveIngest!: (value: { status: "added"; asset: AssetSummary }) => void;
      const pendingIngest = new Promise<{ status: "added"; asset: AssetSummary }>((resolve) => {
        resolveIngest = resolve;
      });
      vi.mocked(libraryGateway.ingestMedia).mockReturnValue(pendingIngest);
      const user = userEvent.setup();

      render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={subscribeDrops} />);

      await user.click(await screen.findByRole("treeitem", { name: "게임" }));
      await waitFor(() => expect(drop).toBeDefined());
      act(() => drop?.(["C:\\images\\a.png"]));
      await waitFor(() => expect(libraryGateway.ingestMedia).toHaveBeenCalledOnce());

      await act(async () => {
        resolveIngest({ status: "added", asset });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("complementary", { name: "가져오기 작업" })).toHaveTextContent("추가 1");
  });

  it("shows setup and an error when restoring the saved library fails", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.openLibrary).mockRejectedValue(
      new Error("라이브러리를 열 수 없습니다."),
    );

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    expect(
      await screen.findByText("라이브러리를 열 수 없습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "라이브러리 선택" }),
    ).toBeInTheDocument();
  });

  it("ingests with the selected classification and refreshes the first asset page", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
      return () => undefined;
    };
    let resolveIngest!: (value: {
      status: "added";
      asset: AssetSummary;
    }) => void;
    const pendingIngest = new Promise<{
      status: "added";
      asset: AssetSummary;
    }>((resolve) => {
      resolveIngest = resolve;
    });
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([
      games,
      blueArchive,
      arona,
    ]);
    vi.mocked(libraryGateway.ingestMedia).mockReturnValue(pendingIngest);
    const user = userEvent.setup();

    render(
      <App
        gateway={libraryGateway}
        selectFolder={vi.fn()}
        subscribeDrops={subscribeDrops}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "게임 펼치기" }));
    await user.click(await screen.findByRole("button", { name: "블루 아카이브 펼치기" }));
    await user.click(await screen.findByRole("treeitem", { name: "아로나" }));
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenLastCalledWith({
        classificationId: "tag-arona",
        albumId: null,
        collectionId: null,
        creatorKey: null,
        directOnly: false,
                unclassifiedOnly: false,
        mediaKind: null,
        aspectRatio: null,
        sort: "newest",
        randomPivot: null,
        after: null,
        aroundDate: null,
        limit: 100,
      }),
    );
    await waitFor(() => expect(drop).toBeDefined());
    const callsBeforeDrop = vi.mocked(libraryGateway.listAssets).mock.calls
      .length;

    act(() => drop?.(["C:\\images\\arona.png"]));

    expect(
      await screen.findByText("1개 중 1번째 파일을 처리하고 있습니다."),
    ).toBeInTheDocument();
    expect(libraryGateway.ingestMedia).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\arona.png",
      classificationId: "tag-arona",
      sourceUrl: null,
      importSource: "direct",
      importBatchId: expect.any(String),
    });

    act(() => resolveIngest({ status: "added", asset }));

    expect(await screen.findByText(/추가 1 · 중복 0/)).toBeInTheDocument();
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledTimes(
        callsBeforeDrop + 1,
      ),
    );
    expect(libraryGateway.listAssets).toHaveBeenLastCalledWith({
      classificationId: "tag-arona",
      albumId: null,
      collectionId: null,
      creatorKey: null,
      directOnly: false,
            unclassifiedOnly: false,
      mediaKind: null,
      aspectRatio: null,
      sort: "newest",
      randomPivot: null,
      after: null,
      aroundDate: null,
      limit: 100,
    });
  });

  it("shows an exact duplicate without refreshing or adding a classification", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
      return () => undefined;
    };
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);
    vi.mocked(libraryGateway.ingestMedia).mockResolvedValue({
      status: "exact_duplicate",
      existingAssetId: "asset-existing",
      classificationChanged: false,
    });
    vi.mocked(libraryGateway.getAsset).mockResolvedValue({
      ...asset,
      id: "asset-existing",
      originalName: "existing.png",
    });

    const user = userEvent.setup();
    render(
      <App
        gateway={libraryGateway}
        selectFolder={vi.fn()}
        subscribeDrops={subscribeDrops}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: "게임" }));
    await waitFor(() => expect(drop).toBeDefined());
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledWith({
        classificationId: "root-games",
        albumId: null,
        collectionId: null,
        creatorKey: null,
        directOnly: false,
                unclassifiedOnly: false,
        mediaKind: null,
        aspectRatio: null,
        sort: "newest",
        randomPivot: null,
        after: null,
        aroundDate: null,
        limit: 100,
      }),
    );
    const callsBeforeDrop = vi.mocked(libraryGateway.listAssets).mock.calls
      .length;

    act(() => drop?.(["C:\\images\\duplicate.png"]));

    expect(await screen.findByText(/추가 0 · 중복 1/)).toBeInTheDocument();
    expect(libraryGateway.ingestMedia).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\duplicate.png",
      classificationId: "root-games",
      sourceUrl: null,
      importSource: "direct",
      importBatchId: expect.any(String),
    });
    expect(libraryGateway.listAssets).toHaveBeenCalledTimes(callsBeforeDrop);
    await user.click(screen.getByRole("button", { name: /duplicate.png 기존 자산 열기/ }));
    expect(libraryGateway.getAsset).toHaveBeenCalledWith("asset-existing");
    expect(await screen.findByRole("img", { name: "existing.png" })).toBeInTheDocument();
  });

  it("refreshes assets when exact-duplicate ingestion moved its folder", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
      return () => undefined;
    };
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.ingestMedia).mockResolvedValue({
      status: "exact_duplicate",
      existingAssetId: "asset-existing",
      classificationChanged: true,
    });
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={subscribeDrops} />);

    await waitFor(() => expect(drop).toBeDefined());
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalled());
    const callsBeforeDrop = vi.mocked(libraryGateway.listAssets).mock.calls.length;
    act(() => drop?.(["C:\\images\\duplicate-moved.png"]));

    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalledTimes(callsBeforeDrop + 1));
  });

  it("drops an asset selection on a classification in one batch", async () => {
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get: () => 900 },
      clientWidth: { configurable: true, get: () => 840 },
      offsetHeight: { configurable: true, get: () => 600 },
      clientHeight: { configurable: true, get: () => 600 },
    });
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);
    vi.mocked(libraryGateway.listAssets).mockResolvedValue({ items: [asset], nextCursor: null });
    vi.mocked(libraryGateway.setAssetClassification).mockResolvedValue(undefined);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const tile = await screen.findByRole("option", { name: "arona.png" });
    const target = await screen.findByRole("treeitem", { name: games.name });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      bottom: 100, height: 100, left: 0, right: 200, top: 0, width: 200, x: 0, y: 0, toJSON: () => ({}),
    });
    Object.defineProperties(tile, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const elementFromPoint = vi.fn().mockReturnValue(target);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    fireEvent.pointerDown(tile, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { pointerId: 3, clientX: 20, clientY: 1 });
    expect(target).toHaveAttribute("data-drop-state", "valid");
    expect(target).toHaveAttribute("data-drop-position", "inside");
    expect(screen.getByText("1개 자산 · 폴더에 추가")).toBeInTheDocument();
    fireEvent.pointerUp(tile, { pointerId: 3, clientX: 20, clientY: 1 });

    await waitFor(() => expect(libraryGateway.setAssetClassification).toHaveBeenCalledWith({
      assetIds: ["asset-arona"],
      classificationId: "root-games",
    }));
    expect(await screen.findByText("1개 자산을 폴더로 이동했습니다.")).toBeVisible();
  });

  it("drops an asset selection on an album without moving its folder", async () => {
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get: () => 900 },
      clientWidth: { configurable: true, get: () => 840 },
      offsetHeight: { configurable: true, get: () => 600 },
      clientHeight: { configurable: true, get: () => 600 },
    });
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listAlbums).mockResolvedValue([
      { id: "album-covers", name: "표지", parentId: null, iconKey: null, colorKey: null },
    ]);
    vi.mocked(libraryGateway.listAssets).mockResolvedValue({ items: [asset], nextCursor: null });
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const tile = await screen.findByRole("option", { name: "arona.png" });
    const target = await screen.findByRole("treeitem", { name: "표지" });
    Object.defineProperties(tile, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn().mockReturnValue(target) });

    fireEvent.pointerDown(tile, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { pointerId: 4, clientX: 20, clientY: 1 });
    await waitFor(() => expect(target).toHaveAttribute("data-drop-state", "valid"));
    fireEvent.pointerUp(tile, { pointerId: 4, clientX: 20, clientY: 1 });

    await waitFor(() => expect(libraryGateway.patchAssetAlbums).toHaveBeenCalledWith({
      assetIds: ["asset-arona"],
      addAlbumIds: ["album-covers"],
      removeAlbumIds: [],
    }));
    expect(libraryGateway.setAssetClassification).not.toHaveBeenCalled();
    expect(await screen.findByText("1개 자산을 앨범에 추가했습니다.")).toBeVisible();
  });

  it("moves a classification inside a folder, expands it, and rejects invalid targets", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({
      metadataVisible: true,
      sidebarWidth: 232,
      expandedClassificationIds: [games.id, blueArchive.id],
      assetSort: "newest",
      thumbnailRowHeight: 180,
    }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games, blueArchive, arona, images]);
    vi.mocked(libraryGateway.moveClassification).mockResolvedValue(undefined);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const rootRow = await screen.findByRole("treeitem", { name: games.name });
    const workRow = await screen.findByRole("treeitem", { name: blueArchive.name });
    const tagRow = await screen.findByRole("treeitem", { name: arona.name });
    const imagesRow = await screen.findByRole("treeitem", { name: images.name });
    for (const row of [rootRow, workRow, tagRow, imagesRow]) Object.defineProperties(row, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const elementFromPoint = vi.fn().mockReturnValue(workRow);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    fireEvent.pointerDown(tagRow, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tagRow, { pointerId: 4, clientX: 20, clientY: 10 });
    expect(workRow).toHaveAttribute("data-drop-state", "invalid");
    fireEvent.pointerCancel(tagRow, { pointerId: 4 });

    elementFromPoint.mockReturnValue(imagesRow);
    fireEvent.pointerDown(tagRow, { button: 0, pointerId: 5, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tagRow, { pointerId: 5, clientX: 20, clientY: 10 });
    expect(imagesRow).toHaveAttribute("data-drop-state", "valid");
    expect(imagesRow).toHaveAttribute("data-drop-position", "inside");
    fireEvent.pointerUp(tagRow, { pointerId: 5, clientX: 20, clientY: 10 });
    await waitFor(() => expect(libraryGateway.moveClassification).toHaveBeenCalledWith(arona.id, images.id));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").expandedClassificationIds).toEqual([games.id, blueArchive.id, images.id]));

    elementFromPoint.mockReturnValue(tagRow);
    fireEvent.pointerDown(rootRow, { button: 0, pointerId: 6, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(rootRow, { pointerId: 6, clientX: 20, clientY: 10 });
    expect(tagRow).toHaveAttribute("data-drop-state", "invalid");
    fireEvent.pointerUp(rootRow, { pointerId: 6, clientX: 20, clientY: 10 });
    expect(libraryGateway.moveClassification).toHaveBeenCalledTimes(1);
  });

  it("moves a root classification inside another root", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games, images]);
    vi.mocked(libraryGateway.moveClassification).mockResolvedValue(undefined);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const gamesRow = await screen.findByRole("treeitem", { name: games.name });
    const imagesRow = await screen.findByRole("treeitem", { name: images.name });
    Object.defineProperties(imagesRow, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn().mockReturnValue(gamesRow) });

    fireEvent.pointerDown(imagesRow, { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(imagesRow, { pointerId: 8, clientX: 20, clientY: 10 });
    expect(gamesRow).toHaveAttribute("data-drop-state", "valid");
    fireEvent.pointerUp(imagesRow, { pointerId: 8, clientX: 20, clientY: 10 });

    await waitFor(() => expect(libraryGateway.moveClassification).toHaveBeenCalledWith(images.id, games.id));
  });

  it("rejects moving a folder into a destination with the same child name", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({
      metadataVisible: true,
      sidebarWidth: 232,
      expandedClassificationIds: [games.id, blueArchive.id],
      assetSort: "newest",
      thumbnailRowHeight: 180,
    }));
    const duplicate = { ...arona, id: "tag-arona-copy", parentId: images.id } satisfies ClassificationEntry;
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games, blueArchive, arona, images, duplicate]);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const tagRow = await screen.findByRole("treeitem", { name: arona.name });
    const imagesRow = await screen.findByRole("treeitem", { name: images.name });
    Object.defineProperties(tagRow, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn().mockReturnValue(imagesRow) });

    fireEvent.pointerDown(tagRow, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tagRow, { pointerId: 7, clientX: 20, clientY: 10 });

    expect(imagesRow).toHaveAttribute("data-drop-state", "invalid");
    fireEvent.pointerUp(tagRow, { pointerId: 7, clientX: 20, clientY: 10 });
    expect(libraryGateway.moveClassification).not.toHaveBeenCalled();
  });

  it("promotes an asset pointer drag to native copy once at the viewport boundary", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get: () => 900 }, clientWidth: { configurable: true, get: () => 840 },
      offsetHeight: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 600 },
    });
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 1000 }, innerHeight: { configurable: true, value: 700 } });
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listAssets).mockResolvedValue({ items: [asset], nextCursor: null });
    const startAssetDrag = vi.fn().mockResolvedValue(undefined);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} startAssetDrag={startAssetDrag} />);
    const tile = await screen.findByRole("option", { name: "arona.png" });
    Object.defineProperties(tile, { setPointerCapture: { configurable: true, value: vi.fn() }, releasePointerCapture: { configurable: true, value: vi.fn() } });

    fireEvent.pointerDown(tile, { button: 0, pointerId: 9, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(tile, { pointerId: 9, clientX: 1001, clientY: 100 });
    fireEvent.pointerMove(tile, { pointerId: 9, clientX: 1002, clientY: 100 });
    await waitFor(() => expect(startAssetDrag).toHaveBeenCalledOnce());
    expect(startAssetDrag).toHaveBeenCalledWith([asset.id]);
  });

  it("does not start native drag after Escape and reports native failures in the work tray", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listAssets).mockResolvedValue({ items: [asset], nextCursor: null });
    const startAssetDrag = vi.fn().mockRejectedValue(new Error("탐색기 복사 실패"));
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} startAssetDrag={startAssetDrag} />);
    const tile = await screen.findByRole("option", { name: "arona.png" });
    Object.defineProperties(tile, { setPointerCapture: { configurable: true, value: vi.fn() }, releasePointerCapture: { configurable: true, value: vi.fn() } });

    fireEvent.pointerDown(tile, { button: 0, pointerId: 10, clientX: 100, clientY: 100 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerMove(tile, { pointerId: 10, clientX: 1001, clientY: 100 });
    expect(startAssetDrag).not.toHaveBeenCalled();

    fireEvent.pointerDown(tile, { button: 0, pointerId: 11, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(tile, { pointerId: 11, clientX: 1001, clientY: 100 });
    await waitFor(() => expect(screen.getByRole("button", { name: "실패 파일 다시 시도" })).toBeVisible());
    expect(screen.getByRole("complementary", { name: "가져오기 작업" })).toHaveTextContent("탐색기 복사 실패");
  });

  it("opens the manga browser and scans the manga folder", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.getMangaRoot).mockResolvedValue("C:\\Manga");
    vi.mocked(libraryGateway.listMangaSeries).mockResolvedValue([{
      id: "series-1",
      title: "Blue Archive",
      author: "Nexon",
      galleryId: null,
      pageCount: 12,
    }]);
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "망가" }));

    expect(await screen.findByRole("region", { name: "망가" })).toBeInTheDocument();
    await waitFor(() => expect(libraryGateway.scanManga).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /Blue Archive/ })).toBeInTheDocument();
  });

  it("does not ingest drops while the manga view is active", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = (paths) => handler({ type: "drop", paths, position: { x: 0, y: 0 } });
      return () => undefined;
    };
    const libraryGateway = gateway();
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={subscribeDrops} />);
    await user.click(await screen.findByRole("button", { name: "망가" }));
    await waitFor(() => expect(drop).toBeDefined());
    act(() => drop?.(["C:\\images\\ignored.png"]));

    await Promise.resolve();
    expect(libraryGateway.ingestMedia).not.toHaveBeenCalled();
  });

  it("opens the collections browser and loads collections with the sidebar", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "game" }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listCollections).mockResolvedValue([{
      id: "collection-1",
      name: "Astral Chain",
      description: null,
      type: "game",
      coverAssetId: null,
      selectedWorkArtworkId: null,
      selectedHeroArtworkId: null,
      selectedBackdropArtworkId: null,
      assetCount: 3,
      unreadReleaseCount: 0,
      year: 2019,
      originalTitle: null,
      runtimeMinutes: null,
      author: "PlatinumGames",
      developer: "PlatinumGames",
      publisher: null,
      platforms: null,
      productionCompany: null,
      releaseDate: null,
      director: null,
      externalScore: 87,
      myScore: 5,
      genres: null,
      overview: null,
      showcase: false,
      showcaseOrder: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    }]);
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "컬렉션" }));
    expect(await screen.findByRole("region", { name: "컬렉션" })).toBeInTheDocument();
    expect(await screen.findByText("Astral Chain")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "저장소" }));
    expect(await screen.findByRole("region", { name: "자산 내용" })).toBeInTheDocument();
  });

  it("preserves the game Library search after opening and leaving a Collection detail", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "game" }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listCollections).mockResolvedValue([{
      id: "collection-search", name: "NieR: Automata", description: null, type: "game",
      coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 0, unreadReleaseCount: 0,
      year: 2017, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null,
      director: null, externalScore: null, myScore: null, genres: null, overview: null,
      showcase: false, showcaseOrder: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    }]);
    vi.mocked(libraryGateway.listCollectionCovers).mockResolvedValue([]);
    vi.mocked(libraryGateway.listCollectionVolumes).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "컬렉션" }));
    const search = await screen.findByRole("textbox", { name: "제목 검색" });
    await user.type(search, "nier");
    await user.click(await screen.findByText("NieR: Automata"));
    await user.click(await screen.findByRole("button", { name: "컬렉션 표지 보기 닫기" }));
    expect(await screen.findByRole("textbox", { name: "제목 검색" })).toHaveValue("nier");
  });

  it("returns from a manga Collection detail to the manga list", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "game" }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listCollections).mockResolvedValue([{
      id: "manga-1",
      name: "던전밥",
      description: null,
      type: "manga",
      coverAssetId: null,
      selectedWorkArtworkId: null,
      selectedHeroArtworkId: null,
      selectedBackdropArtworkId: null,
      assetCount: 1,
      unreadReleaseCount: 0,
      year: 2014,
      originalTitle: null,
      runtimeMinutes: null,
      author: "쿠이 료코",
      developer: null,
      publisher: null,
      platforms: null,
      productionCompany: null,
      releaseDate: null,
      director: null,
      externalScore: null,
      myScore: null,
      genres: null,
      overview: null,
      showcase: false,
      showcaseOrder: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    }]);
    vi.mocked(libraryGateway.getMangaDexConnection).mockResolvedValue(null);
    vi.mocked(libraryGateway.getAladinConnection).mockResolvedValue(null);
    vi.mocked(libraryGateway.listCollectionCovers).mockResolvedValue([]);
    vi.mocked(libraryGateway.listCollectionVolumes).mockResolvedValue([]);
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "컬렉션" }));
    await user.click(await screen.findByRole("button", { name: "만화" }));
    await user.click(await screen.findByText("던전밥"));
    await user.click(await screen.findByRole("button", { name: "컬렉션 표지 보기 닫기" }));

    expect(await screen.findByRole("heading", { name: "만화 컬렉션" })).toBeInTheDocument();
    expect(screen.getByText("던전밥")).toBeInTheDocument();
  });

  it("returns from a Showcase detail to the originating Showcase mode", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "game" }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listCollections).mockResolvedValue([{
      id: "showcase-game", name: "Showcase Game", description: null, type: "game",
      coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 0, unreadReleaseCount: 0,
      year: 2020, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null,
      director: null, externalScore: null, myScore: null, genres: null, overview: null,
      showcase: true, showcaseOrder: 1, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    }]);
    vi.mocked(libraryGateway.listCollectionCovers).mockResolvedValue([]);
    vi.mocked(libraryGateway.listCollectionVolumes).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "컬렉션" }));
    await user.click(await screen.findByRole("button", { name: "쇼케이스" }));
    await user.click(await screen.findByText("Showcase Game"));
    await user.click(await screen.findByRole("button", { name: "컬렉션 표지 보기 닫기" }));
    expect(await screen.findByRole("button", { name: "쇼케이스" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "게임" })).toHaveAttribute("aria-pressed", "true");
  });

});
