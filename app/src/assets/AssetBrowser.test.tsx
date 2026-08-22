import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetPage, AssetSort, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetBrowser, type AssetBrowserStatus } from "./AssetBrowser";

const classifications: ClassificationEntry[] = [];

afterEach(() => { vi.useRealTimers(); cleanup(); });
beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 },
  clientWidth: { configurable: true, get: () => 840 },
  offsetHeight: { configurable: true, get: () => 600 },
  clientHeight: { configurable: true, get: () => 600 },
}));

describe("AssetBrowser", () => {
  it.each<[string, AssetView, AssetSort, Partial<Record<string, unknown>>]>([
    ["classification", { kind: "classification", classificationId: "tag" }, "oldest", { classificationId: "tag", directOnly: false, favoriteOnly: false, unclassifiedOnly: false, sort: "oldest" }],
    ["unsorted", { kind: "unsorted" }, "newest", { classificationId: null, directOnly: false, favoriteOnly: false, unclassifiedOnly: true, sort: "newest" }],
    ["favorites", { kind: "favorites" }, "favorites", { classificationId: null, directOnly: false, favoriteOnly: true, unclassifiedOnly: false, sort: "favorites" }],
    ["recent", { kind: "recent" }, "oldest", { classificationId: null, directOnly: false, favoriteOnly: false, unclassifiedOnly: false, sort: "newest" }],
    ["album", { kind: "album", albumId: "album-1" }, "newest", { classificationId: null, albumId: "album-1", directOnly: false, favoriteOnly: false, unclassifiedOnly: false, sort: "newest" }],
    ["collection", { kind: "collection", collectionId: "collection-1" }, "newest", { classificationId: null, albumId: null, collectionId: "collection-1", directOnly: false, favoriteOnly: false, unclassifiedOnly: false, sort: "newest" }],
  ])("maps the %s view to its first-page query", async (_name, view, sort, expected) => {
    const gateway = createGateway();

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={view}
          classifications={classifications}
          sort={sort}
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() =>
      expect(gateway.listAssets).toHaveBeenCalledWith({
        albumId: null,
        collectionId: null,
        ...expected,
        randomPivot: null,
        after: null,
        limit: 100,
      }),
    );
  });

  it("uses one random pivot for first and next pages", async () => {
    const gateway = createGateway({
      items: Array.from({ length: 50 }, (_, index) => asset(index)),
      nextCursor: { token: "next" },
    });

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="random"
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    const [first, next] = vi.mocked(gateway.listAssets).mock.calls;
    expect(first![0].randomPivot).toMatch(/^[\da-f]{32}$/);
    expect(next![0].randomPivot).toBe(first![0].randomPivot);
  });

  it("changes thumbnail density without reloading assets", async () => {
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    const onThumbnailRowHeightChange = vi.fn();
    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="newest"
          metadataVisible={false}
          thumbnailRowHeight={180}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onThumbnailRowHeightChange={onThumbnailRowHeightChange}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByRole("slider", { name: "미리보기 크기" }), { target: { value: "240" } });

    expect(onThumbnailRowHeightChange).toHaveBeenCalledWith(240);
    expect(gateway.listAssets).toHaveBeenCalledOnce();
  });

  it("supports Ctrl, Shift, Ctrl+A, Escape, and roving arrow focus over loaded assets", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1), asset(2)], nextCursor: null });
    renderBrowser(gateway);
    const first = await screen.findByRole("option", { name: "asset-0.png" });
    const second = screen.getByRole("option", { name: "asset-1.png" });
    const third = screen.getByRole("option", { name: "asset-2.png" });

    await user.click(first);
    await user.keyboard("{Control>}");
    await user.click(third);
    await user.keyboard("{/Control}");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(third).toHaveAttribute("aria-selected", "true");

    fireEvent.click(second, { shiftKey: true });
    expect([first, second, third].map((tile) => tile.getAttribute("aria-selected"))).toEqual(["false", "true", "true"]);
    second.focus();
    await user.keyboard("{Control>}a{/Control}");
    expect([first, second, third].map((tile) => tile.getAttribute("aria-selected"))).toEqual(["true", "true", "true"]);
    await user.keyboard("{Escape}");
    expect([first, second, third].map((tile) => tile.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);

    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(second).toHaveFocus();
  });

  it("retains assets and offers a retry when the next page fails", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => asset(index)), nextCursor: { token: "next" } })
      .mockRejectedValueOnce(new Error("next page failed"));

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="newest"
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("maps direct-only and every selectable sort", async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const { rerender } = renderBrowser(gateway);
    await user.click(await screen.findByRole("checkbox", { name: "이 분류만" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ directOnly: true, sort: "newest" })));
    for (const sort of ["oldest", "favorites", "random"] as const) {
      rerender(browserElement(gateway, { sort }));
      await waitFor(() => expect(gateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ sort, randomPivot: sort === "random" ? expect.stringMatching(/^[\da-f]{32}$/) : null })));
    }
  });

  it("replaces the random pivot only when reshuffled", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    renderBrowser(gateway, { sort: "random" });
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalled());
    const first = vi.mocked(gateway.listAssets).mock.calls[0]![0].randomPivot;
    await user.click(screen.getByRole("button", { name: "다시 섞기" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    expect(vi.mocked(gateway.listAssets).mock.calls[1]![0].randomPivot).not.toBe(first);
  });

  it("creates a new pivot after leaving and re-entering random", async () => {
    const gateway = createGateway(); const { rerender } = renderBrowser(gateway, { sort: "random" });
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(1));
    const first = vi.mocked(gateway.listAssets).mock.calls[0]![0].randomPivot;
    rerender(browserElement(gateway, { sort: "oldest" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    rerender(browserElement(gateway, { sort: "random" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(3));
    expect(vi.mocked(gateway.listAssets).mock.calls[2]![0].randomPivot).not.toBe(first);
  });

  it("keeps the random pivot through an ordinary refresh", async () => {
    const gateway = createGateway(); const { rerender } = renderBrowser(gateway, { sort: "random" });
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(1));
    const first = vi.mocked(gateway.listAssets).mock.calls[0]![0].randomPivot;
    rerender(browserElement(gateway, { sort: "random", refreshVersion: 1 }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    expect(vi.mocked(gateway.listAssets).mock.calls[1]![0].randomPivot).toBe(first);
  });

  it("ignores stale first-page success", async () => {
    let resolveOld!: (page: AssetPage) => void;
    const old = new Promise<AssetPage>((resolve) => { resolveOld = resolve; });
    const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockReturnValueOnce(old).mockResolvedValueOnce({ items: [{ ...asset(1), title: "New" }], nextCursor: null });
    const status = vi.fn();
    const { rerender } = render(browserElement(gateway, { status }));
    rerender(browserElement(gateway, { sort: "oldest", status }));
    expect(await screen.findByRole("option", { name: "New" })).toBeInTheDocument();
    await act(async () => { resolveOld({ items: [{ ...asset(0), title: "Old" }], nextCursor: null }); await old; });
    expect(screen.queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false }));
  });

  it("ignores stale first-page failure and finalization", async () => {
    let rejectOld!: (error: Error) => void; let resolveNew!: (page: AssetPage) => void;
    const old = new Promise<AssetPage>((_resolve, reject) => { rejectOld = reject; });
    const next = new Promise<AssetPage>((resolve) => { resolveNew = resolve; });
    const gateway = createGateway(); const status = vi.fn();
    vi.mocked(gateway.listAssets).mockReturnValueOnce(old).mockReturnValueOnce(next);
    const { rerender } = render(browserElement(gateway, { status }));
    rerender(browserElement(gateway, { sort: "oldest", status }));
    await act(async () => { rejectOld(new Error("late failure")); await old.catch(() => undefined); });
    expect(screen.queryByText("late failure")).not.toBeInTheDocument();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ loading: true }));
    await act(async () => { resolveNew({ items: [{ ...asset(1), title: "New" }], nextCursor: null }); await next; });
    expect(await screen.findByRole("option", { name: "New" })).toBeInTheDocument();
  });

  it("retries a failed first page", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockRejectedValueOnce(new Error("first page failed")).mockResolvedValueOnce({ items: [{ ...asset(0), title: "Recovered" }], nextCursor: null });
    renderBrowser(gateway);
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("option", { name: "Recovered" })).toBeInTheDocument();
  });

  it("never loads an old cursor with a newly selected sort", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => asset(index)), nextCursor: { token: "old-cursor" } })
      .mockResolvedValue({ items: [], nextCursor: null });
    const { rerender } = renderBrowser(gateway, { sort: "newest" });
    await screen.findByRole("img", { name: "asset-0.png" });

    rerender(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} sort="oldest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);

    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledWith(expect.objectContaining({ sort: "oldest", after: null })));
    expect(vi.mocked(gateway.listAssets).mock.calls).not.toContainEqual([expect.objectContaining({ sort: "oldest", after: { token: "old-cursor" } })]);
  });

  it("preserves selection and detail through refresh when the asset remains", async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: [{ ...asset(0), title: "Before" }], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...asset(0), title: "After" }], nextCursor: null });
    const { container, rerender } = renderBrowser(gateway);
    const tile = await screen.findByRole("option", { name: "Before" });
    await user.click(tile);
    await user.dblClick(tile);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} sort="newest" metadataVisible={false} refreshVersion={1} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);

    await waitFor(() => expect(container.querySelector('[data-asset-id="asset-0"]')).toHaveAttribute("aria-selected", "true"));
    expect(container.querySelector('[data-asset-id="asset-0"]')).toHaveAccessibleName("After");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("After");
  });

  it("clears selection when the refreshed page no longer contains the asset", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockResolvedValueOnce({ items: [{ ...asset(0), title: "Selected" }], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null });
    const { rerender } = renderBrowser(gateway); await user.click(await screen.findByRole("option", { name: "Selected" }));
    rerender(browserElement(gateway, { refreshVersion: 1 }));
    expect(await screen.findByRole("heading", { name: "자산이 없습니다" })).toBeInTheDocument();
  });

  it("clears selection when the view changes", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockResolvedValue({ items: [{ ...asset(0), title: "Selected" }], nextCursor: null });
    const { rerender } = renderBrowser(gateway); await user.click(await screen.findByRole("option", { name: "Selected" }));
    rerender(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "favorites" }} classifications={classifications} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);
    expect(await screen.findByRole("option", { name: "Selected" })).toHaveAttribute("aria-selected", "false");
  });

  it("opens the viewer from Enter, navigates loaded assets, and restores tile focus", async () => {
    const user = userEvent.setup(); const gateway = createGateway({ items: [{ ...asset(0), title: "첫 자산" }, { ...asset(1), title: "둘째 자산" }], nextCursor: null });
    renderBrowser(gateway);
    const tile = await screen.findByRole("option", { name: "첫 자산" });
    expect(screen.getByRole("img", { name: "첫 자산" })).toHaveAttribute("src", "http://lakomics.localhost/thumbnail/asset-0");
    tile.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "첫 자산" });
    expect(within(dialog).getByRole("img", { name: "첫 자산" })).toHaveAttribute("src", "http://lakomics.localhost/asset/asset-0");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "둘째 자산" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "감상 화면 닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tile).toHaveFocus();
  });

  it("keeps the inspector closed on selection and opens it only from the toolbar toggle", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    renderBrowser(gateway);

    const first = await screen.findByRole("option", { name: "asset-0.png" });
    const second = screen.getByRole("option", { name: "asset-1.png" });
    await user.click(first);
    expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "정보 열기" }));
    expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeVisible();

    await user.click(second);
    expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeVisible();

    await user.click(within(screen.getByRole("complementary", { name: "자산 정보" })).getByRole("button", { name: "정보 닫기" }));
    expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();

    await user.click(second);
    expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
  });

  it("applies inspector folder and album actions to the selection", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    const tag: ClassificationEntry = { id: "tag", kind: "tag", name: "태그", parentId: null, iconKey: null, colorKey: null };
    const album = { id: "album", name: "표지", parentId: null, iconKey: null, colorKey: null };
    vi.mocked(gateway.getAssetClassifications).mockResolvedValue(["tag"]);
    vi.mocked(gateway.getAssetAlbums).mockResolvedValueOnce([]).mockResolvedValue(["album"]);
    render(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={[tag]} albums={[album]} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);
    const first = await screen.findByRole("option", { name: "asset-0.png" });

    expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
    first.focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByText("2개 선택")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "정보 열기" }));
    const inspector = await screen.findByRole("complementary", { name: "자산 정보" });
    expect(within(inspector).queryByRole("button", { name: "출처 정보 편집" })).not.toBeInTheDocument();
    await user.selectOptions(within(inspector).getByLabelText("폴더"), "tag");
    expect(gateway.setAssetClassification).toHaveBeenCalledWith({ assetIds: ["asset-0", "asset-1"], classificationId: "tag" });
    const checkbox = await screen.findByRole("checkbox", { name: "표지 앨범" });
    await user.click(checkbox);
    expect(gateway.patchAssetAlbums).toHaveBeenCalledWith({ assetIds: ["asset-0", "asset-1"], addAlbumIds: [], removeAlbumIds: ["album"] });
  });

  it("keeps the selected page summary in sync after metadata editing", async () => {
    const user = userEvent.setup();
    const original = asset(0);
    const updated = { ...original, creatorName: "Updated Artist" };
    const gateway = createGateway({ items: [original], nextCursor: null });
    vi.mocked(gateway.updateAssetMetadata).mockResolvedValue(updated);
    renderBrowser(gateway);

    await user.click(await screen.findByRole("option", { name: original.originalName }));
    await user.click(screen.getByRole("button", { name: "정보 열기" }));
    await user.click(screen.getByRole("button", { name: "출처 정보 편집" }));
    await user.type(screen.getByLabelText("제작자 이름"), "Updated Artist");
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("Updated Artist")).toBeVisible();
  });

  it("moves the selected asset to trash and refreshes the gallery", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [{ ...asset(0), title: "Delete me" }], nextCursor: null });
    renderBrowser(gateway);

    await user.click(await screen.findByRole("option", { name: "Delete me" }));
    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));

    expect(gateway.trashAssets).toHaveBeenCalledWith(["asset-0"]);
    expect(screen.getByText("1개 자산을 휴지통으로 이동했습니다.")).toBeVisible();
  });

  it("expires the trash undo action with its toast", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0)], nextCursor: null });
    vi.mocked(gateway.setAssetFavorite).mockRejectedValue(new Error("favorite failed"));
    renderBrowser(gateway);
    const tile = await screen.findByRole("option", { name: "asset-0.png" });
    await user.click(tile);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "실행 취소" })).toBeVisible();
    act(() => vi.advanceTimersByTime(5_000));
    fireEvent.doubleClick(screen.getByRole("option", { name: "asset-0.png" }));
    fireEvent.click(screen.getByRole("button", { name: "즐겨찾기 켜기" }));
    await act(async () => { await Promise.resolve(); });

    expect(gateway.setAssetFavorite).toHaveBeenCalledWith("asset-0", true);
    expect(gateway.setAssetsFavorite).not.toHaveBeenCalled();
    expect(screen.getByText("favorite failed")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "감상 화면 닫기" }));
    expect(screen.queryByRole("button", { name: "실행 취소" })).not.toBeInTheDocument();
  });

  it("runs explicit batch favorite, classification, trash, and undo actions", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    const tag: ClassificationEntry = { id: "tag", kind: "tag", name: "아로나", parentId: null, iconKey: null, colorKey: null };
    const album = { id: "album", name: "표지", parentId: null, iconKey: null, colorKey: null };
    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={[tag]} albums={[album]} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} />
      </LibraryProvider>,
    );
    const first = await screen.findByRole("option", { name: "asset-0.png" });
    first.focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByText("2개 선택")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "좋아요 켜기" }));
    expect(gateway.setAssetsFavorite).toHaveBeenCalledWith(["asset-0", "asset-1"], true);
    await user.selectOptions(screen.getByLabelText("폴더"), "tag");
    await user.click(screen.getByRole("button", { name: "폴더로 이동" }));
    expect(gateway.setAssetClassification).toHaveBeenCalledWith({
      assetIds: ["asset-0", "asset-1"],
      classificationId: "tag",
    });
    await user.selectOptions(screen.getByLabelText("앨범"), "album");
    await user.click(screen.getByRole("button", { name: "앨범에 추가" }));
    expect(gateway.patchAssetAlbums).toHaveBeenCalledWith({ assetIds: ["asset-0", "asset-1"], addAlbumIds: ["album"], removeAlbumIds: [] });

    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
    expect(gateway.trashAssets).toHaveBeenCalledWith(["asset-0", "asset-1"]);
    await user.click(await screen.findByRole("button", { name: "실행 취소" }));
    expect(gateway.restoreAssets).toHaveBeenCalledWith(["asset-0", "asset-1"]);
  });

  it("keeps selected tiles visible when a batch mutation fails", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    vi.mocked(gateway.trashAssets).mockRejectedValue(new Error("batch failed"));
    renderBrowser(gateway);
    const first = await screen.findByRole("option", { name: "asset-0.png" });
    first.focus();
    await user.keyboard("{Control>}a{/Control}");

    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));

    expect(await screen.findByText("batch failed")).toBeVisible();
    expect(screen.getByRole("option", { name: "asset-0.png" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "asset-1.png" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the selected asset when moving it to trash fails", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [{ ...asset(0), title: "Keep me" }], nextCursor: null });
    vi.mocked(gateway.trashAssets).mockRejectedValue(new Error("trash failed"));
    renderBrowser(gateway);

    await user.click(await screen.findByRole("option", { name: "Keep me" }));
    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));

    expect(await screen.findByText("trash failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeVisible();
  });

  it("disables trash while pending and preserves a newer selection", async () => {
    let resolveTrash!: () => void;
    const pendingTrash = new Promise<void>((resolve) => { resolveTrash = resolve; });
    const user = userEvent.setup();
    const gateway = createGateway({ items: [{ ...asset(0), title: "First" }, { ...asset(1), title: "Second" }], nextCursor: null });
    vi.mocked(gateway.trashAssets).mockReturnValue(pendingTrash);
    renderBrowser(gateway);

    await user.click(await screen.findByRole("option", { name: "First" }));
    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
    expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeDisabled();
    await user.click(screen.getByRole("option", { name: "Second" }));
    await act(async () => { resolveTrash(); await pendingTrash; });

    expect(await screen.findByRole("option", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "휴지통으로 이동" })).not.toBeDisabled();
  });

  it("removes the selection from the active collection and refreshes the gallery", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    const onCollectionsChanged = vi.fn();
    render(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "collection", collectionId: "collection-1" }} classifications={classifications} collections={[{ id: "collection-1", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, assetCount: 2, unreadReleaseCount: 0, year: null, author: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" }]} onCollectionsChanged={onCollectionsChanged} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);
    const first = await screen.findByRole("option", { name: "asset-0.png" });
    first.focus();
    await user.keyboard("{Control>}a{/Control}");

    await user.click(screen.getByRole("button", { name: "이 컬렉션에서 제거" }));

    expect(gateway.patchAssetCollections).toHaveBeenCalledWith({ assetIds: ["asset-0", "asset-1"], addCollectionIds: [], removeCollectionIds: ["collection-1"] });
    expect(onCollectionsChanged).not.toHaveBeenCalled();
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
  });

  it("sets the selected asset as the collection cover", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0)], nextCursor: null });
    const onCollectionsChanged = vi.fn();
    render(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "collection", collectionId: "collection-1" }} classifications={classifications} onCollectionsChanged={onCollectionsChanged} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);

    await user.click(await screen.findByRole("option", { name: "asset-0.png" }));
    await user.click(screen.getByRole("button", { name: "대표 이미지로 지정" }));

    expect(gateway.setCollectionCover).toHaveBeenCalledWith("collection-1", "asset-0");
    expect(onCollectionsChanged).toHaveBeenCalledOnce();
  });

  it("applies inspector collection actions to the selection", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [asset(0), asset(1)], nextCursor: null });
    vi.mocked(gateway.getAssetCollections).mockResolvedValue(["collection-1"]);
    render(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} collections={[{ id: "collection-1", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, assetCount: 2, unreadReleaseCount: 0, year: null, author: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" }]} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);
    const first = await screen.findByRole("option", { name: "asset-0.png" });
    first.focus();
    await user.keyboard("{Control>}a{/Control}");
    await user.click(screen.getByRole("button", { name: "정보 열기" }));

    const checkbox = await screen.findByRole("checkbox", { name: "엘든 링 컬렉션" });
    await user.click(checkbox);
    expect(gateway.patchAssetCollections).toHaveBeenCalledWith({ assetIds: ["asset-0", "asset-1"], addCollectionIds: [], removeCollectionIds: ["collection-1"] });
  });

});

it("opens a requested asset that is not in the loaded page and clears it on close", async () => {
  const requested = asset(99);
  const onRequestedAssetHandled = vi.fn();
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetBrowser
        view={{ kind: "classification", classificationId: null }}
        classifications={[]}
        sort="newest"
        metadataVisible={false}
        refreshVersion={0}
        requestedAsset={requested}
        onRequestedAssetHandled={onRequestedAssetHandled}
        onSortChange={vi.fn()}
        onMetadataVisibleChange={vi.fn()}
        onStatusChange={vi.fn()}
      />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("img", { name: requested.originalName })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "감상 화면 닫기" }));
  expect(onRequestedAssetHandled).toHaveBeenCalledOnce();
});

function renderBrowser(gateway: LibraryGateway, options: BrowserOptions = {}) {
  return render(browserElement(gateway, options));
}

type BrowserOptions = { sort?: AssetSort; refreshVersion?: number; status?: (status: AssetBrowserStatus) => void };
function browserElement(gateway: LibraryGateway, { sort = "newest", refreshVersion = 0, status = vi.fn() }: BrowserOptions = {}) {
  return <LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} sort={sort} metadataVisible={false} refreshVersion={refreshVersion} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={status} /></LibraryProvider>;
}

function asset(index: number) {
  return {
    id: `asset-${index}`,
    title: null,
    originalName: `asset-${index}.png`,
    byteSize: 1,
    width: 200,
    height: 200,
    collectedAt: "2026-07-30T00:00:00Z",
    favorite: false,
    sourceUrl: null,
    sourcePublishedAt: null,
    creatorName: null,
    creatorHandle: null,
    creatorUrl: null,
    importSource: null,
    importBatchId: null,
    originalModifiedAt: null,
    media: { kind: "image" as const },
  };
}

function createGateway(page: AssetPage = { items: [], nextCursor: null }): LibraryGateway {
  return {
    openLibrary: vi.fn(), importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn().mockResolvedValue(page),
    indexMissingSimilarityHashes: vi.fn(), listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(),
    trashAssets: vi.fn().mockResolvedValue(undefined), restoreAsset: vi.fn(), restoreAssets: vi.fn().mockResolvedValue(undefined), listTrash: vi.fn(), emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn().mockResolvedValue(undefined),
    getAssetClassifications: vi.fn().mockResolvedValue([]), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
  };
}
