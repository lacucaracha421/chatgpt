import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MangaSeries } from "../library/types";
import { MangaBrowser } from "./MangaBrowser";
import { ChromeSettingsDock, ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { WindowControls } from "../layout/WindowControls";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import type { NativeFileDropEvent } from "../ingestion/useFileDrop";

const nativeDrops = vi.hoisted(() => ({ handlers: new Set<(event: NativeFileDropEvent) => void>() }));
vi.mock("../ingestion/useFileDrop", async importOriginal => ({
  ...await importOriginal<typeof import("../ingestion/useFileDrop")>(),
  subscribeToTauriDrops: vi.fn(async (handler: (event: NativeFileDropEvent) => void) => {
    nativeDrops.handlers.add(handler);
    return () => nativeDrops.handlers.delete(handler);
  }),
}));

function nativeDrop(event: NativeFileDropEvent) {
  act(() => { for (const handler of nativeDrops.handlers) handler(event); });
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** Stands in for the 찾기 palette: applies text through the view's registered search. */
function SearchProbe() {
  const chrome = useWorkspaceChrome();
  return <button type="button" onClick={() => chrome?.applySearch("b")}>팔레트 검색 b</button>;
}

function renderBrowser(gateway: LibraryGateway, onOpenSeries?: (series: MangaSeries) => void) {
  return render(
    <LibraryProvider gateway={gateway}>
      <WorkspaceChromeProvider scope="manga-test">
        <aside aria-label="망가 인덱스">
          <ChromeTarget name="actions" />
          <ChromeTarget name="search" />
          <ChromeTarget name="navigation" />
          <ChromeSettingsDock />
        </aside>
        <div data-testid="shared-titlebar"><ChromeTarget name="header" /><WindowControls /></div>
        <MangaBrowser onOpenSeries={onOpenSeries} />
        <SearchProbe />
      </WorkspaceChromeProvider>
    </LibraryProvider>,
  );
}

const series: MangaSeries[] = [
  { id: "s1", title: "T1", author: "a", galleryId: null, pageCount: 60 },
  { id: "s2", title: "T2", author: "b", galleryId: null, pageCount: 40 },
];

describe("MangaBrowser", () => {
  it("imports only drops on the shown local view, shows a target and an undo toast", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.importLocalManga = vi.fn().mockResolvedValue({ count: 2, undoToken: "import-1", archivesRetained: 1, failures: [{ path: "bad.rar", message: "ZIP, CBZ만 가져올 수 있습니다" }] });
    gateway.undoLocalMangaImport = vi.fn().mockResolvedValue({ count: 2, failures: [] });
    gateway.dismissLocalMangaImport = vi.fn().mockResolvedValue(undefined);
    const { container } = renderBrowser(gateway);
    nativeDrop({ type: "drop", paths: ["elsewhere"], position: { x: 0, y: 0 } });
    expect(gateway.importLocalManga).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "로컬" }));
    await screen.findByText("T1");
    await waitFor(() => expect(screen.getByText("T1")).toBeVisible());
    const bounds = vi.spyOn(container.querySelector<HTMLElement>(".manga-browser.manga-browser__screen")!, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, toJSON: () => ({}) });
    nativeDrop({ type: "enter", paths: ["folder", "book.cbz"], position: { x: 0, y: 0 } });
    expect(screen.getByText("폴더 또는 ZIP·CBZ를 놓아 작품 가져오기")).toBeVisible();
    nativeDrop({ type: "leave" });
    expect(screen.queryByText("폴더 또는 ZIP·CBZ를 놓아 작품 가져오기")).not.toBeInTheDocument();
    nativeDrop({ type: "drop", paths: ["folder", "book.cbz"], position: { x: 0, y: 0 } });
    await waitFor(() => expect(gateway.importLocalManga).toHaveBeenCalledWith(["folder", "book.cbz"]));
    expect(await screen.findByText(/2개 작품을 가져왔습니다/)).toHaveTextContent("압축 파일 원본은 그대로 두었습니다");
    expect(screen.getByText(/2개 작품을 가져왔습니다/)).toHaveTextContent("bad.rar");
    await userEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(gateway.undoLocalMangaImport).toHaveBeenCalledWith("import-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument());
    nativeDrop({ type: "drop", paths: ["outside"], position: { x: 10000, y: 10000 } });
    expect(gateway.importLocalManga).toHaveBeenCalledTimes(1);
    bounds.mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
    nativeDrop({ type: "drop", paths: ["hidden-view"], position: { x: 0, y: 0 } });
    expect(gateway.importLocalManga).toHaveBeenCalledTimes(1);
  });

  it("refreshes a selected work or all thumbnails manually and changes displayed URLs", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.refreshLocalMangaThumbnails = vi.fn().mockResolvedValueOnce({ refreshedIds: ["s1"], revision: "new-one", failures: [] }).mockResolvedValueOnce({ refreshedIds: ["s1", "s2"], revision: "new-all", failures: [] });
    const { container } = renderBrowser(gateway);
    await userEvent.click(screen.getByRole("radio", { name: "로컬" }));
    await screen.findByText("T1");
    const first = container.querySelector<HTMLImageElement>('img[alt="T1 표지"]')!;
    const before = first.getAttribute("src");
    fireEvent.load(first);
    expect(gateway.refreshLocalMangaThumbnails).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "T1 관리" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "썸네일 갱신" }));
    await waitFor(() => expect(gateway.refreshLocalMangaThumbnails).toHaveBeenCalledWith(["s1"]));
    await waitFor(() => expect(container.querySelector('img[src*="revision=new-one"]')).not.toBeNull());
    const refreshed = container.querySelector<HTMLImageElement>('img[src*="revision=new-one"]')!;
    fireEvent.load(refreshed);
    expect(refreshed.getAttribute("src")).not.toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "망가 관리" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "썸네일 갱신" }));
    await waitFor(() => expect(gateway.refreshLocalMangaThumbnails).toHaveBeenLastCalledWith(undefined));
    await waitFor(() => expect(container.querySelectorAll('img[src*="revision=new-all"]')).toHaveLength(2));
    for (const image of container.querySelectorAll('img[src*="revision=new-all"]')) fireEvent.load(image);
  });

  it("keeps the grid visible and delays the busy label during bulk thumbnail refresh", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    let complete!: (value: { refreshedIds: string[]; revision: string; failures: [] }) => void;
    gateway.refreshLocalMangaThumbnails = vi.fn(() => new Promise<{ refreshedIds: string[]; revision: string; failures: [] }>(resolve => { complete = resolve; }));
    renderBrowser(gateway);
    await userEvent.click(screen.getByRole("radio", { name: "로컬" }));
    await screen.findByText("T1");
    await userEvent.click(screen.getByRole("button", { name: "망가 관리" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "썸네일 갱신" }));
    expect(screen.queryByText("썸네일 갱신 중")).not.toBeInTheDocument();
    expect(screen.getByText("T1")).toBeVisible();
    expect(await screen.findByText("썸네일 갱신 중")).toBeVisible();
    await act(async () => complete({ refreshedIds: ["s1", "s2"], revision: "bulk", failures: [] }));
    await waitFor(() => expect(screen.queryByText("썸네일 갱신 중")).not.toBeInTheDocument());
    expect(screen.getByText("T1")).toBeVisible();
  });
  it("keeps the current grid inert until the other source is ready, then keeps both screens cached", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.getOnlineCatalogStatus = vi.fn().mockResolvedValue({ installed: true, workCount: 1, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: null, lastSuccessAt: null, lastAdded: 0, lastError: null });
    gateway.searchCatalogGroups = vi.fn(async (_query, onEvent) => {
      onEvent({ type: "page", page: { works: [{ provider: "kHentai", providerWorkId: "1", groupId: 1, versionCount: 1, hasBookmarkedVersion: false, title: "카탈로그 작품", titleJpn: null, artists: [], series: [], thumbnailUrl: null, bookmarked: false, fileCount: 20, views: 0, posted: 1 }], page: 0, pageSize: 48 } });
      onEvent({ type: "count", totalCount: 1 });
    });
    let finishLocal!: (value: MangaSeries[]) => void;
    gateway.listMangaSeries = vi.fn().mockReturnValueOnce(new Promise<MangaSeries[]>(resolve => { finishLocal = resolve; })).mockResolvedValue(series);
    const { container } = renderBrowser(gateway);
    expect(await screen.findByText("카탈로그 작품")).toBeVisible();
    await userEvent.click(screen.getByRole("radio", { name: "로컬" }));
    expect(screen.getByText("카탈로그 작품")).toBeVisible();
    expect(container.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    expect(screen.getByRole("radio", { name: "로컬" })).toHaveAttribute("aria-checked", "true");
    await act(async () => finishLocal(series));
    expect(await screen.findByText("T1")).toBeVisible();
    expect(screen.getByRole("radio", { name: "로컬" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "카탈로그" }));
    await waitFor(() => expect(screen.getByText("카탈로그 작품")).toBeVisible());
    expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("망가 불러오는 중")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "로컬" }));
    await waitFor(() => expect(screen.getByText("T1")).toBeVisible());
    expect(screen.queryByLabelText("망가 불러오는 중")).not.toBeInTheDocument();
  });

  it("swaps local and online through the shared view swap, keeping the shown screen until the other commits", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.getOnlineCatalogStatus = vi.fn().mockResolvedValue({ installed: true, workCount: 1, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: null, lastSuccessAt: null, lastAdded: 0, lastError: null });
    gateway.searchCatalogGroups = vi.fn(async (_query, onEvent) => {
      onEvent({ type: "page", page: { works: [{ provider: "kHentai", providerWorkId: "1", groupId: 1, versionCount: 1, hasBookmarkedVersion: false, title: "카탈로그 작품", titleJpn: null, artists: [], series: [], thumbnailUrl: null, bookmarked: false, fileCount: 20, views: 0, posted: 1 }], page: 0, pageSize: 48 } });
      onEvent({ type: "count", totalCount: 1 });
    });
    const transitions: { update: () => void; finish(): void }[] = [];
    try {
      const { container } = renderBrowser(gateway);
      expect(await screen.findByText("카탈로그 작품")).toBeVisible();
      Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
        let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
        transitions.push({ update, finish: () => finish() });
        return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition() {} };
      } });
      await userEvent.click(screen.getByRole("radio", { name: "로컬" }));
      await waitFor(() => expect(transitions).toHaveLength(1));
      // The online screen is still the painted one; local enters from its side (to the left).
      expect(screen.getByText("카탈로그 작품")).toBeVisible();
      expect(document.documentElement).toHaveAttribute("data-view-swap", "back");
      const screens = [...container.querySelectorAll<HTMLElement>(".manga-browser__screen")];
      expect(screens.every(element => element.hasAttribute("data-view-swap-target"))).toBe(true);
      act(() => transitions[0].update());
      expect(await screen.findByText("T1")).toBeVisible();
      await act(async () => transitions[0].finish());
      expect(document.documentElement).not.toHaveAttribute("data-view-swap");
    } finally { Reflect.deleteProperty(document, "startViewTransition"); }
  });

  it("combines an index pick with typed search, holds the old grid, and clears only the index token", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.suggestOnlineCatalog = vi.fn().mockResolvedValue([]);
    gateway.getMangaFrequentIndex = vi.fn().mockResolvedValue({ bookmarkCount: 1, tagLimit: 8, artistLimit: 5, tags: [{ kind: "tag", namespace: "female", value: "tag", label: "태그", count: 1 }], artists: [] });
    gateway.listMangaIndexPins = vi.fn().mockResolvedValue([]);
    gateway.getOnlineCatalogStatus = vi.fn().mockResolvedValue({ installed: true, workCount: 1 });
    const work = { provider: "kHentai" as const, providerWorkId: "1", groupId: "1", versionCount: 1, hasBookmarkedVersion: false, title: "원래 작품", titleJpn: null, artists: [], series: [], thumbnailUrl: null, bookmarked: false, fileCount: 20, views: 0, posted: 1 };
    gateway.searchCatalogGroups = vi.fn(async (_query, onEvent) => { onEvent({ type: "page", page: { works: [work], page: 0, pageSize: 48 } }); onEvent({ type: "count", totalCount: 1 }); });
    const { container } = renderBrowser(gateway);
    await screen.findByText("원래 작품");
    await userEvent.click(screen.getByRole("button", { name: "팔레트 검색 b" }));
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ text: "b" }), expect.any(Function), expect.any(String)));
    let finish!: () => void;
    vi.mocked(gateway.searchCatalogGroups).mockImplementationOnce(async (_query, onEvent) => { await new Promise<void>(resolve => { finish = resolve; }); onEvent({ type: "page", page: { works: [{ ...work, title: "새 작품" }], page: 0, pageSize: 48 } }); });
    await userEvent.click(await screen.findByRole("button", { name: "태그 1" }));
    expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ text: '(b) AND female:"tag"' }), expect.any(Function), expect.any(String));
    expect(screen.getByText("원래 작품")).toBeVisible();
    expect(container.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    await act(async () => finish());
    expect(await screen.findByText("새 작품")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "태그 필터 빼기" }));
    expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ text: "b" }), expect.any(Function), expect.any(String));
  });

  it("filters the local grid by folder series identities", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.getMangaLocalIndex = vi.fn().mockResolvedValue({ folders: [{ name: "A", relativePath: "A", seriesCount: 1, seriesIds: ["s1"] }], vanished: [] });
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await screen.findByText("T2");
    await userEvent.click(await screen.findByRole("button", { name: "A 1" }));
    expect(screen.getByText("T1")).toBeVisible(); expect(screen.queryByText("T2")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "전체 2" }));
    expect(screen.getByText("T2")).toBeVisible();
  });

  it("scans and shows the cover grid when the root is set", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const { container } = renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await waitFor(() => expect(gateway.scanManga).toHaveBeenCalled());
    expect(await screen.findByText("T1")).toBeVisible();
    expect(screen.getByText("T2")).toBeVisible();
    expect(container.querySelectorAll(".manga-card img").length).toBe(2);
    expect(container.querySelector(".manga-card img")).toHaveAttribute("alt", "T1 표지");
    expect(screen.queryByRole("button", { name: "보기 설정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "비공개 모드" })).not.toBeInTheDocument();
  });

  it("shows cached manga while a slow scan continues", async () => {
    let finishScan!: () => void;
    const scanning = new Promise<number>((resolve) => { finishScan = () => resolve(0); });
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.scanManga = vi.fn().mockReturnValue(scanning);

    renderBrowser(gateway);
    const local = await screen.findByRole("radio", { name: "로컬" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(local); });
    expect(screen.getByText("T1")).toBeVisible();
    expect(screen.queryByText("폴더 스캔 중")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(599); });
    expect(screen.queryByText("폴더 스캔 중")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("status")).toHaveTextContent("폴더 스캔 중");
    expect(screen.getByRole("button", { name: "새로고침" })).toBeDisabled();
    await act(async () => finishScan());
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await act(async () => { vi.advanceTimersByTime(399); });
    expect(screen.getByText("폴더 스캔 중")).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("폴더 스캔 중")).not.toBeInTheDocument();
    expect(screen.getByText("T1")).toBeVisible();
    expect(screen.queryByText("새로 변경된 망가가 없습니다")).not.toBeInTheDocument();
    expect(document.querySelector(".manga-toolbar__refresh time")).toHaveTextContent("갱신");
  });

  it("never shows scan status for a quick scan or a scan abandoned on a source switch", async () => {
    let finishScan!: (count: number) => void;
    const gateway = createGateway({ root: "C:\\manga", series });
    gateway.scanManga = vi.fn().mockImplementation(() => new Promise<number>(resolve => { finishScan = resolve; }));
    renderBrowser(gateway);
    const local = await screen.findByRole("radio", { name: "로컬" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(local); });
    await act(async () => { vi.advanceTimersByTime(200); finishScan(0); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByText("폴더 스캔 중")).not.toBeInTheDocument();
    expect(screen.getByText("T1")).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "카탈로그" })); });
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "로컬" })); });
    await act(async () => { vi.advanceTimersByTime(200); fireEvent.click(screen.getByRole("radio", { name: "카탈로그" })); });
    await act(async () => { vi.advanceTimersByTime(400); finishScan(0); });
    expect(screen.queryByText("폴더 스캔 중")).not.toBeInTheDocument();
  });

  it("shows the setup prompt when the root is not set", async () => {
    const gateway = createGateway({ root: null, series: [] });
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    expect(await screen.findByText("망가 폴더가 설정되지 않았습니다")).toBeVisible();
  });

  it("uses the shared view toolbar with window controls", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const { container } = renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await screen.findByText("T1");
    expect(screen.getByRole("toolbar", { name: "망가 도구" })).toBeInTheDocument();
    expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
    expect(within(screen.getByTestId("shared-titlebar")).getByRole("heading", { name: "망가" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
  });

  it("filters by title or author and reports the visible count", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const user = userEvent.setup();
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));

    expect(await screen.findByText("2개 작품")).toBeVisible();
    expect(screen.queryByRole("button", { name: "망가 검색" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "팔레트 검색 b" }));

    expect(screen.queryByText("T1")).not.toBeInTheDocument();
    expect(screen.getByText("T2")).toBeVisible();
    expect(screen.getByText("1 / 2개 작품")).toBeVisible();
  });

  it("sorts manga from the toolbar with fixed card geometry", async () => {
    const gateway = createGateway({ root: "C:\\manga", series: [series[1]!, series[0]!] });
    const user = userEvent.setup();
    const { container } = renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await screen.findByText("T1");

    await user.click(screen.getByRole("button", { name: "정렬" }));
    await user.click(screen.getByRole("menuitemradio", { name: "페이지 많은 순" }));
    expect(container.querySelectorAll(".manga-card__title")[0]).toHaveTextContent("T1");
    expect(screen.queryByRole("slider", { name: "카드 크기" })).not.toBeInTheDocument();
    // The source switch is the section bar under the top bar, with the sort menu at its right end.
    const titlebar = within(screen.getByTestId("shared-titlebar"));
    expect(titlebar.queryByRole("radiogroup", { name: "망가 출처" })).not.toBeInTheDocument();
    const bar = screen.getByRole("radiogroup", { name: "망가 출처" }).closest(".ui-section-bar") as HTMLElement;
    expect(within(bar).getByRole("button", { name: "정렬" })).toBeVisible();
    expect(titlebar.queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "로컬" })).toHaveAttribute("aria-checked", "true");
  });

  it("opens the viewer when a cover is clicked", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const onOpenSeries = vi.fn();
    renderBrowser(gateway, onOpenSeries);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
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

    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await screen.findByText("T1");
    await userEvent.click(screen.getByRole("button", { name: "망가 관리" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "카탈로그로 복구" }));

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

    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await screen.findByText("T1");
    await userEvent.click(screen.getByRole("button", { name: "망가 관리" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "카탈로그로 복구" }));

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

  it("checks missing numeric gallery ids remotely without forcing unmatched local works", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const firstPreview = {
      totalCount: 2, exactActiveCount: 0, historicalCount: 0, fallbackCount: 2, alreadyBookmarkedCount: 0,
      items: [
        { mangaId: "m-id", title: "ID 있음", author: "a", galleryId: "123", pageCount: 20, status: "fallback" as const, workId: null, catalogTitle: null, catalogTitleJpn: null, catalogFileCount: null, bookmarked: false, candidates: [] },
        { mangaId: "m-custom", title: "자체번역", author: "me", galleryId: null, pageCount: 18, status: "fallback" as const, workId: null, catalogTitle: null, catalogTitleJpn: null, catalogFileCount: null, bookmarked: false, candidates: [] },
      ],
    };
    gateway.previewMangaCatalogRecovery = vi.fn().mockResolvedValue(firstPreview);
    gateway.refreshMangaCatalogRecoveryRemote = vi.fn().mockResolvedValue({ attemptedCount: 1, importedCount: 0, notFoundCount: 1 });
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("radio", { name: /^로컬/ }));
    await screen.findByText("T1");
    await userEvent.click(screen.getByRole("button", { name: "망가 관리" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "카탈로그로 복구" }));
    expect((await screen.findAllByText(/카탈로그에 없는 로컬\/자체번역 작품일 수 있습니다/)).length).toBe(2);
    await userEvent.click(screen.getByRole("button", { name: "원격 ID 확인 1개" }));
    await waitFor(() => expect(gateway.refreshMangaCatalogRecoveryRemote).toHaveBeenCalledOnce());
    expect(await screen.findByText(/원격에서도 1개 ID를 찾지 못했습니다/)).toBeVisible();
  });

  it("offers catalog and bookmarks separately and opens bookmarks directly from local", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    renderBrowser(gateway);

    expect(await screen.findByText("온라인 카탈로그가 없습니다")).toBeVisible();
    const sourceButtons = screen.getByLabelText("망가 출처").querySelectorAll("button");
    expect([...sourceButtons].map((button) => button.getAttribute("aria-label"))).toEqual(["카탈로그", "북마크", "로컬"]);

    await userEvent.click(screen.getByRole("radio", { name: /^로컬/ }));
    expect(await screen.findByText("T1")).toBeVisible();
    await userEvent.click(screen.getByRole("radio", { name: /^북마크/ }));
    expect(await screen.findByText("온라인 카탈로그가 없습니다")).toBeVisible();
    expect(screen.getByRole("radio", { name: /^북마크/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "카탈로그" })).toHaveAttribute("aria-checked", "false");
  });
});

function createGateway(overrides: { root: string | null; series: MangaSeries[] }): LibraryGateway {
  const base: LibraryGateway = {
    resetJapaneseCatalogCheckpoint: vi.fn(),
    getCatalogVisibilityPolicy: vi.fn().mockResolvedValue({ hiddenCategories: [], blockedTags: [] }),
    setCatalogCategoryHidden: vi.fn(),
    setCatalogTagBlocked: vi.fn(),
    getIgdbCredentialStatus: vi.fn(),
    setIgdbCredentials: vi.fn(),
    deleteIgdbCredentials: vi.fn(),
    searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(),
    applyIgdbGame: vi.fn(),
    refreshIgdbGame: vi.fn(),
    getIgdbConnection: vi.fn(),
    replaceIgdbGameArtwork: vi.fn(),
    getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setStashdbCredentials: vi.fn(),
    deleteStashdbCredentials: vi.fn(),
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
    prepareRevisitColorBundle: vi.fn().mockResolvedValue(null),
    reshuffleRevisitBundle: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), importCollectionArtworks: vi.fn().mockResolvedValue(0),
  listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getKakaoCredentialStatus: vi.fn(), setKakaoApiKey: vi.fn(), deleteKakaoApiKey: vi.fn(), searchKakao: vi.fn(), applyKakao: vi.fn(), refreshKakao: vi.fn(), getBookConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(overrides.root),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(overrides.series.length),
    listMangaSeries: vi.fn().mockResolvedValue(overrides.series),
    importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn().mockResolvedValue({ installed: false, workCount: 0, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: null, lastSuccessAt: null, lastAdded: 0, lastError: null }), searchCatalogGroups: vi.fn(), getCatalogGroupEditions: vi.fn(), setCatalogGroupRepresentative: vi.fn(), listCatalogReview: vi.fn(), generateCatalogReview: vi.fn(), decideCatalogReview: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: false, apiBaseUrl: null, tokenConfigured: false }), setCloudCaptureSettings: vi.fn(), setCloudApiToken: vi.fn(), deleteCloudApiToken: vi.fn(), testCloudCaptureConnection: vi.fn().mockResolvedValue({ pendingCount: 0 }), runDueCloudCaptureSync: vi.fn().mockResolvedValue({ attempted: 0, acknowledged: 0, failed: 0, reviewPending: 0, added: 0, videoAdded: 0, classificationChanged: 0 }), cloudBackfillPreflight: vi.fn(), cloudBackfillSeed: vi.fn(), cloudBackfillRunCycle: vi.fn(), cloudBackfillProgress: vi.fn(), cloudBackfillRetryFailed: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
  };
  return base;
}
