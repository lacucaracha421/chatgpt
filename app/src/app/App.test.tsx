import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropSubscriber } from "../ingestion/useFileDrop";
import type {
  AssetSummary,
  ClassificationEntry,
  LibraryGateway,
} from "../library/types";
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

  it("opens the selected library and shows its path", async () => {
    const user = userEvent.setup();
    const selectFolder = vi.fn().mockResolvedValue("C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={selectFolder} />);

    await user.click(screen.getByRole("button", { name: "라이브러리 선택" }));

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByText("C:\\Lakomics")).toBeInTheDocument();
    expect(localStorage.getItem("lakomics.libraryPath")).toBe("C:\\Lakomics");
  });

  it("restores the saved library path when the app starts", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByText("C:\\Lakomics")).toBeInTheDocument();
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

    await user.click(
      await screen.findByRole("button", { name: "아로나 선택" }),
    );
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
    vi.mocked(libraryGateway.ingestImage).mockResolvedValue({
      status: "exact_duplicate",
      existingAssetId: "asset-existing",
    });

    render(
      <App
        gateway={libraryGateway}
        selectFolder={vi.fn()}
        subscribeDrops={subscribeDrops}
      />,
    );

    await waitFor(() => expect(drop).toBeDefined());
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledWith({
        classificationId: null,
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
      classificationId: null,
      sourceUrl: null,
    });
    expect(libraryGateway.listAssets).toHaveBeenCalledTimes(callsBeforeDrop);
  });
});
