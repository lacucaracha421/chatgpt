import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropSubscriber } from "../ingestion/useFileDrop";
import type {
  AssetSummary,
  ClassificationEntry,
  LibraryGateway,
  MetadataBackup,
} from "../library/types";
import { UI_PREFERENCES_KEY } from "../preferences/uiPreferences";
import { App } from "./App";

const summary = { root: "C:\\Lakomics", assetCount: 0 };
const games: ClassificationEntry = {
  id: "root-games",
  kind: "root",
  name: "게임",
  parentId: null,
};
const blueArchive: ClassificationEntry = {
  id: "work-blue-archive",
  kind: "work",
  name: "블루 아카이브",
  parentId: "root-games",
};
const arona: ClassificationEntry = {
  id: "tag-arona",
  kind: "tag",
  name: "아로나",
  parentId: "work-blue-archive",
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
    openLibrary: vi.fn().mockResolvedValue(summary),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn().mockResolvedValue([]),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    deleteClassification: vi.fn(),
    listAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }),
    decideSimilarityReview: vi.fn(),
    getAsset: vi.fn(),
    trashAsset: vi.fn(),
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
    setAssetClassifications: vi.fn(),
    patchAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(0),
    listMangaSeries: vi.fn().mockResolvedValue([]),
    ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn().mockResolvedValue({ processed: 0, remaining: 0, failed: 0, changedAssetIds: [] }),
    retryVideoPreparation: vi.fn().mockResolvedValue("pending"),
  };
}

describe("App", () => {
  beforeEach(() => localStorage.clear());
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

  it("renders the trash workspace without loading an asset page", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    const user = userEvent.setup();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);
    await user.click(await screen.findByRole("button", { name: "휴지통" }));

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
    await user.click(await screen.findByRole("button", { name: "휴지통" }));
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
    await user.click(await screen.findByRole("button", { name: "안전" }));
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
    await user.click(await screen.findByRole("button", { name: "안전" }));
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
      favoriteOnly: false,
      unclassifiedOnly: false,
    })));
    expect(screen.getByRole("button", { name: "저장소" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "미분류" }));
    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({
      classificationId: null,
      favoriteOnly: false,
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

    await user.click(await screen.findByRole("button", { name: "즐겨찾기" }));
    await waitFor(() => expect(drop).toBeDefined());
    act(() => drop?.(["C:\\images\\a.png"]));
    await waitFor(() => expect(libraryGateway.ingestMedia).toHaveBeenCalledWith({ sourcePath: "C:\\images\\a.png", classificationId: null, sourceUrl: null }));

    await user.click(screen.getByRole("button", { name: "최근" }));
    act(() => drop?.(["C:\\images\\recent.png"]));
    await user.click(screen.getByRole("button", { name: "저장소" }));
    act(() => drop?.(["C:\\images\\all-assets.png"]));

    await waitFor(() => expect(libraryGateway.ingestMedia).toHaveBeenCalledTimes(3));
    expect(libraryGateway.ingestMedia).toHaveBeenNthCalledWith(2, { sourcePath: "C:\\images\\recent.png", classificationId: null, sourceUrl: null });
    expect(libraryGateway.ingestMedia).toHaveBeenNthCalledWith(3, { sourcePath: "C:\\images\\all-assets.png", classificationId: null, sourceUrl: null });
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
        sidebarWidth: 272,
        expandedClassificationIds: [],
        assetSort: "random",
        thumbnailRowHeight: 180,
      }),
    );
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
        directOnly: false,
        favoriteOnly: false,
        unclassifiedOnly: false,
        sort: "newest",
        randomPivot: null,
        after: null,
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
      directOnly: false,
      favoriteOnly: false,
      unclassifiedOnly: false,
      sort: "newest",
      randomPivot: null,
      after: null,
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
        directOnly: false,
        favoriteOnly: false,
        unclassifiedOnly: false,
        sort: "newest",
        randomPivot: null,
        after: null,
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
    });
    expect(libraryGateway.listAssets).toHaveBeenCalledTimes(callsBeforeDrop);
    await user.click(screen.getByRole("button", { name: /duplicate.png 기존 자산 열기/ }));
    expect(libraryGateway.getAsset).toHaveBeenCalledWith("asset-existing");
    expect(await screen.findByRole("img", { name: "existing.png" })).toBeInTheDocument();
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
    vi.mocked(libraryGateway.patchAssetClassifications).mockResolvedValue(undefined);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const tile = await screen.findByRole("option", { name: "arona.png" });
    const target = await screen.findByRole("treeitem", { name: games.name });
    Object.defineProperties(tile, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const elementFromPoint = vi.fn().mockReturnValue(target);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    fireEvent.pointerDown(tile, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { pointerId: 3, clientX: 20, clientY: 10 });
    expect(target).toHaveAttribute("data-drop-state", "valid");
    fireEvent.pointerUp(tile, { pointerId: 3, clientX: 20, clientY: 10 });

    await waitFor(() => expect(libraryGateway.patchAssetClassifications).toHaveBeenCalledWith({
      assetIds: ["asset-arona"],
      addClassificationIds: ["root-games"],
      removeClassificationIds: [],
    }));
  });

  it("moves a classification but rejects its descendant as a target", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({
      metadataVisible: true,
      sidebarWidth: 232,
      expandedClassificationIds: [games.id, blueArchive.id],
      assetSort: "newest",
      thumbnailRowHeight: 180,
    }));
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games, blueArchive, arona]);
    vi.mocked(libraryGateway.moveClassification).mockResolvedValue(undefined);
    render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />);

    const rootRow = await screen.findByRole("treeitem", { name: games.name });
    const tagRow = await screen.findByRole("treeitem", { name: arona.name });
    for (const row of [rootRow, tagRow]) Object.defineProperties(row, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const elementFromPoint = vi.fn().mockReturnValue(rootRow);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    fireEvent.pointerDown(tagRow, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tagRow, { pointerId: 4, clientX: 20, clientY: 10 });
    expect(rootRow).toHaveAttribute("data-drop-state", "valid");
    fireEvent.pointerUp(tagRow, { pointerId: 4, clientX: 20, clientY: 10 });
    await waitFor(() => expect(libraryGateway.moveClassification).toHaveBeenCalledWith(arona.id, games.id));

    elementFromPoint.mockReturnValue(tagRow);
    fireEvent.pointerDown(rootRow, { button: 0, pointerId: 5, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(rootRow, { pointerId: 5, clientX: 20, clientY: 10 });
    expect(tagRow).toHaveAttribute("data-drop-state", "invalid");
    fireEvent.pointerUp(rootRow, { pointerId: 5, clientX: 20, clientY: 10 });
    expect(libraryGateway.moveClassification).toHaveBeenCalledTimes(1);
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
      relativePath: "Blue Archive",
      title: "Blue Archive",
      author: "Nexon",
      galleryId: null,
      pageCount: 12,
      thumbnailRelativePath: "cover.jpg",
      scannedAt: "2026-08-01T00:00:00Z",
      modifiedAt: "2026-08-01T00:00:00Z",
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
});
