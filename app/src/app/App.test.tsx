import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropSubscriber } from "../ingestion/useFileDrop";
import type {
  AssetSummary,
  ClassificationEntry,
  LibraryGateway,
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
  relativePath: "assets/aa/arona.png",
  thumbnailRelativePath: "thumbnails/aa/arona.webp",
  byteSize: 123,
  width: 8,
  height: 6,
  collectedAt: "2026-07-31T00:00:00Z",
  favorite: false,
  sourceUrl: null,
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
    setAssetFavorite: vi.fn(),
    setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    ingestImage: vi.fn(),
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

  it("restores the saved library path when the app starts", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
  });

  it("renders the persistent four-region workspace when a library is restored", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    expect(await screen.findByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Classification" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lakomics" })).not.toBeInTheDocument();
  });

  it("ignores drops outside a concrete classification and explains how to enable them", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    let drop: ((paths: string[]) => void) | undefined;
    const subscribeDrops: DropSubscriber = async (handler) => {
      drop = handler;
      return () => undefined;
    };
    const libraryGateway = gateway();
    const user = userEvent.setup();

    render(
      <App
        gateway={libraryGateway}
        selectFolder={vi.fn()}
        subscribeDrops={subscribeDrops}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Favorites" }));
    await waitFor(() => expect(drop).toBeDefined());
    act(() => drop?.(["C:\\images\\a.png"]));

    expect(libraryGateway.ingestImage).not.toHaveBeenCalled();
    expect(
      screen.getByText("파일을 저장할 분류를 먼저 선택하세요."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Recent" }));
    act(() => drop?.(["C:\\images\\recent.png"]));
    await Promise.resolve();

    await user.click(screen.getByRole("button", { name: "All assets" }));
    act(() => drop?.(["C:\\images\\all-assets.png"]));
    await Promise.resolve();

    expect(libraryGateway.ingestImage).not.toHaveBeenCalled();
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

    const metadata = await screen.findByLabelText("Metadata");
    expect(metadata).not.toBeChecked();
    expect(screen.getByLabelText("Sort")).toHaveValue("oldest");
    expect(screen.getByRole("complementary", { name: "Classification" })).toHaveStyle({ width: "264px" });

    await user.selectOptions(screen.getByLabelText("Sort"), "random");
    await user.click(metadata);
    await user.click(screen.getByRole("button", { name: "Collapse 게임" }));
    const resizeHandle = screen.getByRole("separator", { name: "Resize sidebar" });
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
      }),
    );
  });

  it("clears transient drop-result feedback while keeping status in the status bar", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
      let drop: ((paths: string[]) => void) | undefined;
      const subscribeDrops: DropSubscriber = async (handler) => {
        drop = handler;
        return () => undefined;
      };
      const libraryGateway = gateway();
      vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);
      let resolveIngest!: (value: { status: "added"; asset: AssetSummary }) => void;
      const pendingIngest = new Promise<{ status: "added"; asset: AssetSummary }>((resolve) => {
        resolveIngest = resolve;
      });
      vi.mocked(libraryGateway.ingestImage).mockReturnValue(pendingIngest);
      const user = userEvent.setup();

      render(<App gateway={libraryGateway} selectFolder={vi.fn()} subscribeDrops={subscribeDrops} />);

      await user.click(await screen.findByRole("treeitem", { name: "게임" }));
      await waitFor(() => expect(drop).toBeDefined());
      act(() => drop?.(["C:\\images\\a.png"]));
      await waitFor(() => expect(libraryGateway.ingestImage).toHaveBeenCalledOnce());

      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveIngest({ status: "added", asset });
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(screen.getByRole("status")).toBeVisible();

        await act(async () => vi.advanceTimersByTimeAsync(5_000));

        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.getByRole("contentinfo")).toHaveTextContent("이미지 파일을 창으로 끌어놓으세요.");
      } finally {
        vi.useRealTimers();
      }
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
      drop = handler;
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
    vi.mocked(libraryGateway.ingestImage).mockReturnValue(pendingIngest);
    const user = userEvent.setup();

    render(
      <App
        gateway={libraryGateway}
        selectFolder={vi.fn()}
        subscribeDrops={subscribeDrops}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Expand 게임" }));
    await user.click(await screen.findByRole("button", { name: "Expand 블루 아카이브" }));
    await user.click(await screen.findByRole("treeitem", { name: "아로나" }));
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenLastCalledWith({
        classificationId: "tag-arona",
        directOnly: false,
        favoriteOnly: false,
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
    expect(libraryGateway.ingestImage).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\arona.png",
      classificationId: "tag-arona",
      sourceUrl: null,
    });

    act(() => resolveIngest({ status: "added", asset }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "저장했습니다",
    );
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledTimes(
        callsBeforeDrop + 1,
      ),
    );
    expect(libraryGateway.listAssets).toHaveBeenLastCalledWith({
      classificationId: "tag-arona",
      directOnly: false,
      favoriteOnly: false,
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
      drop = handler;
      return () => undefined;
    };
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listClassifications).mockResolvedValue([games]);
    vi.mocked(libraryGateway.ingestImage).mockResolvedValue({
      status: "exact_duplicate",
      existingAssetId: "asset-existing",
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
        sort: "newest",
        randomPivot: null,
        after: null,
        limit: 100,
      }),
    );
    const callsBeforeDrop = vi.mocked(libraryGateway.listAssets).mock.calls
      .length;

    act(() => drop?.(["C:\\images\\duplicate.png"]));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "이미 보관된 파일입니다",
    );
    expect(libraryGateway.ingestImage).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\duplicate.png",
      classificationId: "root-games",
      sourceUrl: null,
    });
    expect(libraryGateway.listAssets).toHaveBeenCalledTimes(callsBeforeDrop);
  });
});
