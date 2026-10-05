import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { LibraryProvider } from "../library/LibraryContext";
import type { CatalogGroupedSearchEvent, CatalogSearchQuery, CatalogStatus, CatalogWork, CatalogWorkDetail, LibraryGateway, ResolvedGallery } from "../library/types";
import { CatalogVisibilitySettings } from "../settings/CatalogVisibilitySettings";
import { OnlineCatalogBrowser } from "./OnlineCatalogBrowser";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { displayDateTime } from "../shared/displayDate";
import { lazy, StrictMode, Suspense } from "react";
import { WindowControls } from "../layout/WindowControls";
import { CATALOG_BOOKMARKS_CHANGED_EVENT } from "../app/useCatalogBookmarkSync";
import { existsSync, readFileSync } from "node:fs";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { AreaVisible, viewReady } from "../shared/motion/AreaSwitch";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const work: CatalogWork = {
  provider: "kHentai",
  providerWorkId: "3",
  title: "오래된 제독",
  titleJpn: null,
  artists: ["artist"],
  series: ["series"],
  thumbnailUrl: "https://ehgt.org/w/00/003/work.webp",
  bookmarked: false,
  fileCount: 24,
  views: 200,
  posted: 1,
};

const detail: CatalogWorkDetail = {
  provider: work.provider,
  providerWorkId: work.providerWorkId,
  title: work.title,
  titleJpn: null,
  thumbnailUrl: work.thumbnailUrl,
  uploader: "tester",
  category: 2,
  posted: 1,
  updated: null,
  fileCount: 3,
  fileSize: 12_345,
  rating: 457,
  views: work.views,
  bookmarked: false,
  tagGroups: [{ namespace: "character", values: ["teitoku"] }],
};

describe("OnlineCatalogBrowser", () => {
  it("offers both bookmark orders and remembers the device choice", async () => {
    localStorage.clear();
    onTestFinished(() => localStorage.clear());
    const gateway = createGateway(true);
    const first = renderBrowser(gateway, "bookmarked");
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenCalledWith(expect.objectContaining({ sort: "latest", scope: "bookmarked" }), expect.any(Function), expect.any(String)));
    await userEvent.click(screen.getByRole("button", { name: "정렬" }));
    expect(screen.queryByRole("menuitemradio", { name: "조회순" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "최근 추가순" }));
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "bookmarkAdded" }), expect.any(Function), expect.any(String)));
    first.unmount();
    renderBrowser(gateway, "bookmarked");
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "bookmarkAdded" }), expect.any(Function), expect.any(String)));
    await userEvent.click(screen.getByRole("button", { name: "정렬" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "최신순" }));
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "latest" }), expect.any(Function), expect.any(String)));
  });
  it("is area-ready on first page without waiting for 48 lazy covers, count or command completion", async () => {
    const gateway = createGateway(true);
    const command = deferred<void>();
    let emit!: (event: CatalogGroupedSearchEvent) => void;
    gateway.searchCatalogGroups = vi.fn().mockImplementation((_query, onEvent) => { emit = onEvent; return command.promise; });
    const { container } = renderBrowser(gateway);
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce());
    expect(viewReady(container)).toBe(false);
    await act(async () => emit({ type: "page", page: { works: Array.from({ length: 48 }, (_, index) => ({ ...work,
      providerWorkId: String(index), groupId: String(index), versionCount: 1, hasBookmarkedVersion: false })), page: 0, pageSize: 48 } }));
    expect(container.querySelectorAll(".manga-card img")).toHaveLength(48);
    expect(container.querySelectorAll('[aria-busy="true"]:not(button)')).toHaveLength(0);
    expect(viewReady(container)).toBe(true);
    expect(gateway.getOnlineCatalogStatus).toHaveBeenCalledOnce();
    expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new Event(CATALOG_BOOKMARKS_CHANGED_EVENT)));
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenCalledTimes(2));
    expect(viewReady(container)).toBe(true);
    await act(async () => command.resolve());
  });

  it("does not prefetch more pages while the incoming area is preparing", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async query => fullPage(query, 100));
    const browser = (visible: boolean) => <LibraryProvider gateway={gateway}><AreaVisible.Provider value={visible}>
      <OnlineCatalogBrowser onSwitchLocal={vi.fn()} />
    </AreaVisible.Provider></LibraryProvider>;
    const { container, rerender } = render(browser(false));
    await screen.findByRole("button", { name: "작품 0-0 상세 보기" });
    await io.reveal();
    expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce();
    expect(viewReady(container)).toBe(true);
    rerender(browser(true));
    await io.reveal();
    await screen.findByRole("button", { name: "작품 1-0 상세 보기" });
    expect(gateway.searchCatalogGroups).toHaveBeenCalledTimes(2);
  });

  it("repeats status and first-page requests after an unretained area remount", async () => {
    const gateway = createGateway(true);
    const first = renderBrowser(gateway);
    await screen.findByRole("button", { name: `${work.title} 상세 보기` });
    expect(gateway.getOnlineCatalogStatus).toHaveBeenCalledOnce();
    expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce();
    first.unmount();
    renderBrowser(gateway);
    await screen.findByRole("button", { name: `${work.title} 상세 보기` });
    expect(gateway.getOnlineCatalogStatus).toHaveBeenCalledTimes(2);
    expect(gateway.searchCatalogGroups).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("settles initial loading when the stream ends without a page (cancelled=%s)", async (cancelled) => {
    const gateway = createGateway(true);
    let emit!: (event: CatalogGroupedSearchEvent) => void;
    gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, onEvent) => { emit = onEvent; });
    renderBrowser(gateway);
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("망가 불러오는 중")).toBeVisible();
    act(() => emit({ type: "end", cancelled }));
    await waitFor(() => expect(screen.queryByLabelText("망가 불러오는 중")).not.toBeInTheDocument());
  });

  it("keeps shown cards when a replacement search ends without a page", async () => {
    const gateway = createGateway(true);
    const { container } = renderBrowser(gateway);
    await screen.findByRole("button", { name: `${work.title} 상세 보기` });
    let emit!: (event: CatalogGroupedSearchEvent) => void;
    gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, onEvent) => { emit = onEvent; });
    await chooseMenu("언어", "일본어");
    expect(container.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
    act(() => emit({ type: "end", cancelled: true }));
    await waitFor(() => expect(container.querySelector(".online-catalog__frame")).not.toHaveAttribute("inert"));
    expect(screen.getByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
    expect(container.querySelector(".manga-card--skeleton")).toBeNull();
  });

  it("targets unmount cancellation at the old search after a fresh mount starts", async () => {
    const gateway = createGateway(true);
    const streams: Array<{ id: string; emit: (event: CatalogGroupedSearchEvent) => void }> = [];
    let activeId: string | null = null;
    let deliverCancel!: () => void;
    gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit, id) => {
      activeId = id;
      streams.push({ id, emit });
    });
    gateway.cancelCatalogSearch = vi.fn().mockImplementation((id) => new Promise<void>((resolve) => {
      deliverCancel = () => {
        if (id === activeId) {
          activeId = null;
          streams.find(stream => stream.id === id)?.emit({ type: "end", cancelled: true });
        }
        resolve();
      };
    }));
    const old = renderBrowser(gateway);
    await waitFor(() => expect(streams).toHaveLength(1));
    old.unmount();
    renderBrowser(gateway);
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[0].id).toEqual(expect.any(String));
    expect(streams[1].id).not.toBe(streams[0].id);
    expect(gateway.cancelCatalogSearch).toHaveBeenCalledExactlyOnceWith(streams[0].id);
    await act(async () => deliverCancel());
    expect(activeId).toBe(streams[1].id);
    act(() => {
      streams[1].emit({ type: "page", page: { works: [{ ...work, groupId: "3", versionCount: 1, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
      streams[1].emit({ type: "count", totalCount: 1 });
      streams[1].emit({ type: "end", cancelled: false });
    });
    expect(await screen.findByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
    expect(screen.queryByLabelText("망가 불러오는 중")).not.toBeInTheDocument();
  });

  it("shows the initial catalog when the command finishes before its page is delivered", async () => {
    const gateway = createGateway(true);
    const command = deferred<void>();
    let emit!: (event: CatalogGroupedSearchEvent) => void;
    gateway.searchCatalogGroups = vi.fn().mockImplementation((_query, onEvent) => {
      emit = onEvent;
      return command.promise;
    });
    const onReady = vi.fn();
    render(<StrictMode><LibraryProvider gateway={gateway}><OnlineCatalogBrowser onSwitchLocal={vi.fn()} onReady={onReady} /></LibraryProvider></StrictMode>);
    await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce());
    // Large Tauri channel payloads can arrive after the invocation has resolved.
    await act(async () => command.resolve());
    expect(screen.getByLabelText("망가 불러오는 중")).toBeVisible();
    expect(onReady).not.toHaveBeenCalled();
    act(() => {
      emit({ type: "page", page: { works: [{ ...work, groupId: "3", versionCount: 1, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
      emit({ type: "count", totalCount: 1 });
    });
    expect(await screen.findByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
    expect(screen.getByText("1개 결과")).toBeVisible();
    expect(onReady).toHaveBeenCalledWith("all");
    expect(gateway.searchCatalogGroups).toHaveBeenCalledOnce();
  });

  it("keeps old cards and rejects superseded pages when commands finish before delivery", async () => {
    const gateway = createGateway(true);
    const { container } = renderBrowser(gateway);
    await screen.findByRole("button", { name: `${work.title} 상세 보기` });
    const events: Array<(event: CatalogGroupedSearchEvent) => void> = [];
    gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => { events.push(emit); });
    await chooseMenu("언어", "일본어");
    expect(screen.getByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
    expect(container.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    expect(container.querySelector(".manga-card--skeleton")).toBeNull();
    await chooseMenu("언어", "한국어");
    act(() => {
      events[0]({ type: "page", page: { works: [{ ...work, title: "이전 요청 작품", groupId: "old", versionCount: 1, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
      events[0]({ type: "count", totalCount: 999 });
      events[0]({ type: "end", cancelled: true });
    });
    expect(screen.queryByText("이전 요청 작품")).not.toBeInTheDocument();
    expect(screen.queryByText("999개 결과")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
    act(() => {
      events[1]({ type: "page", page: { works: [{ ...work, title: "최신 요청 작품", groupId: "new", versionCount: 1, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
      events[1]({ type: "count", totalCount: 1 });
      events[1]({ type: "end", cancelled: false });
    });
    expect(await screen.findByRole("button", { name: "최신 요청 작품 상세 보기" })).toBeVisible();
    expect(container.querySelector(".online-catalog__frame")).not.toHaveAttribute("inert");
  });

  it("shows skeleton cards only on first load and holds the old grid on language/scope/refresh changes", async () => {
    const gateway = createGateway(true);
    const first = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(first.promise);
    const { container } = renderBrowser(gateway);
    expect(await screen.findByLabelText("망가 불러오는 중")).toBeVisible();
    expect(container.querySelectorAll(".manga-card--skeleton")).toHaveLength(12);
    await act(async () => first.resolve({ works: [work], totalCount: 1, page: 0, pageSize: 48 }));
    expect(await screen.findByText(work.title)).toBeVisible();
    const next = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(next.promise);
    await chooseMenu("언어", "일본어");
    expect(screen.getByText(work.title)).toBeVisible();
    expect(container.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    expect(container.querySelector(".manga-card--skeleton")).toBeNull();
    await act(async () => next.resolve({ works: [{ ...work, title: "다음 작품" }], totalCount: 1, page: 0, pageSize: 48 }));
    expect(await screen.findByText("다음 작품")).toBeVisible();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(next.promise);
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(document.querySelector(".manga-toolbar__refresh time")).toHaveTextContent("갱신"));
    expect(container.querySelector(".manga-card--skeleton")).toBeNull();
    expect(screen.queryByText(/갱신했습니다|새로고침했습니다|이미 최신입니다/)).not.toBeInTheDocument();
  });

  it("keeps catalog cards until the bookmarked page arrives and shows its known count", async () => {
    const gateway = createGateway(true);
    const { container } = renderBrowser(gateway);
    await screen.findByText(work.title);
    const next = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(next.promise);
    await userEvent.click(screen.getByRole("radio", { name: "북마크" }));
    expect(screen.getByText(work.title)).toBeVisible();
    expect(screen.getByRole("radio", { name: "북마크" })).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    expect(container.querySelector(".manga-card--skeleton")).toBeNull();
    await act(async () => next.resolve({ works: [{ ...work, bookmarked: true }], totalCount: 280, page: 0, pageSize: 48 }));
    expect(await screen.findByRole("radio", { name: "북마크" })).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector(".online-catalog__frame")).not.toHaveAttribute("inert");
    expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not toast when an update is already current", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.updateOnlineCatalog).mockResolvedValue({ language: "korean", added: 0, pages: 0, reason: "upToDate", lastSuccessAt: "2026-09-30T06:20:00Z" });
    renderBrowser(gateway);
    await userEvent.click(await catalogMenuItem("신규 작품 갱신"));
    await waitFor(() => expect(document.querySelector(".manga-toolbar__refresh time")).toHaveTextContent("갱신"));
    expect(screen.queryByText("온라인 카탈로그가 이미 최신입니다")).not.toBeInTheDocument();
  });

  it("uses the latest requested source when the initial catalog status arrives slowly", async () => {
    const gateway = createGateway(true);
    const status = await gateway.getOnlineCatalogStatus();
    const pending = deferred<CatalogStatus>();
    vi.mocked(gateway.getOnlineCatalogStatus).mockReturnValue(pending.promise);
    const { rerender } = render(<LibraryProvider gateway={gateway}><OnlineCatalogBrowser onSwitchLocal={vi.fn()} requestedSource="all" /></LibraryProvider>);
    rerender(<LibraryProvider gateway={gateway}><OnlineCatalogBrowser onSwitchLocal={vi.fn()} requestedSource="bookmarked" /></LibraryProvider>);
    await act(async () => pending.resolve(status));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "bookmarked", sort: "latest" })));
  });

  it("resets the grid scroll on a new view, not when pages append or refresh quietly", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => fullPage(query, 100));
    render(<LibraryProvider gateway={gateway}><WorkspaceChromeProvider scope="catalog">
      <aside><ChromeTarget name="navigation" /></aside>
      <OnlineCatalogBrowser onSwitchLocal={vi.fn()} />
    </WorkspaceChromeProvider></LibraryProvider>);
    await screen.findByRole("button", { name: "작품 0-0 상세 보기" });
    const grid = document.querySelector<HTMLDivElement>(".online-catalog__content")!;
    const sidebar = document.querySelector("aside")!;
    sidebar.scrollTop = 70;
    grid.scrollTop = 500;
    await io.reveal();
    expect(await screen.findByRole("button", { name: "작품 1-0 상세 보기" })).toBeInTheDocument();
    expect(grid.scrollTop).toBe(500);
    grid.scrollTop = 300;
    await chooseMenu("정렬", "조회순");
    await waitFor(() => expect(grid.scrollTop).toBe(0));
    expect(sidebar.scrollTop).toBe(70);
    grid.scrollTop = 200;
    await userEvent.click(screen.getByRole("button", { name: "작품 0-0 북마크" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "작품 0-0 북마크" })).toBeEnabled());
    expect(grid.scrollTop).toBe(200);
  });
  it("shows the catalog timestamp using the shared date formatter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T10:05:30Z"));
    const gateway = createGateway(true);
    const status = await gateway.getOnlineCatalogStatus();
    vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue({ ...status, lastSuccessAt: "2026-09-06T10:00:00Z" });
    renderBrowser(gateway);
    const toolbar = await screen.findByRole("toolbar", { name: "온라인 망가 도구" });
    await waitFor(() => expect(toolbar.querySelector("time")).toHaveTextContent(`갱신 ${displayDateTime("2026-09-06T10:00:00Z")}`));
    expect(toolbar.querySelector("time")).toHaveAttribute("datetime", "2026-09-06T10:00:00Z");
  });
  it("keeps rare catalog actions in one top-bar overflow menu", async () => {
    const gateway = createGateway(true);
    gateway.listCatalogReview = vi.fn().mockResolvedValue({ rows: [], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    const index = screen.getByRole("complementary", { name: "카탈로그 인덱스" });
    const trigger = within(screen.getByRole("toolbar")).getByRole("button", { name: "카탈로그 더보기" });
    expect(within(index).queryByRole("button", { name: "중복 후보 검토" })).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitemcheckbox", { name: "숨긴 결과 표시" })).not.toBeChecked();
    expect(screen.queryByRole("menuitem", { name: "새로고침" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "신규 작품 갱신" })).toBeEnabled();
    await userEvent.click(screen.getByRole("menuitem", { name: "중복 후보 검토" }));
    expect(await screen.findByRole("dialog", { name: "중복 후보 검토" })).toBeVisible();
    expect(gateway.listCatalogReview).toHaveBeenCalled();
  });
  it("hides the refresh age when no catalog update has completed", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    expect(document.querySelector(".manga-toolbar__refresh time")).toBeNull();
  });
  it("keeps bookmark flags and the loaded count stable until the refreshed page arrives", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockResolvedValue({ works: [{ ...work, bookmarked: true }], totalCount: 60, page: 0, pageSize: 48 });
    renderBrowser(gateway);
    const bookmark = await screen.findByRole("button", { name: "오래된 제독 북마크 해제" });
    const footer = document.querySelector(".online-catalog__list-end")!;
    const before = footer.textContent;
    const pending = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(pending.promise);
    await userEvent.click(bookmark);
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(2));
    expect(bookmark).toBeDisabled();
    expect(bookmark).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("북마크된 판본 있음")).not.toBeInTheDocument();
    expect(footer.textContent).toBe(before);
    expect(before).toBe("1 / 60");
    expect(screen.getByRole("button", { name: "언어" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await act(async () => pending.resolve({ works: [{ ...work, bookmarked: false }], totalCount: 60, page: 0, pageSize: 48 }));
    expect(await screen.findByRole("button", { name: "오래된 제독 북마크" })).toBeEnabled();
    expect(screen.queryByText("북마크된 판본 있음")).not.toBeInTheDocument();
    expect(footer.textContent).toBe(before);
  });
  it("keeps catalog controls in the section bar and opens search only from its icon", async () => {
    const gateway = createGateway(true);
    const user = userEvent.setup();
    const DeferredCatalog = lazy(async () => ({ default: (await import("./OnlineCatalogBrowser")).OnlineCatalogBrowser }));
    render(<LibraryProvider gateway={gateway}><WorkspaceChromeProvider scope="catalog">
      <aside aria-label="카탈로그 인덱스"><ChromeTarget name="search" /><ChromeTarget name="navigation" /></aside>
      <div data-testid="shared-titlebar"><ChromeTarget name="header" /><WindowControls /></div>
      <Suspense fallback={null}><DeferredCatalog onSwitchLocal={vi.fn()} /></Suspense>
    </WorkspaceChromeProvider></LibraryProvider>);
    const index = screen.getByRole("complementary", { name: "카탈로그 인덱스" });
    const bar = (await screen.findByRole("radiogroup", { name: "망가 출처" })).closest(".ui-section-bar") as HTMLElement;
    expect(await within(bar).findByRole("button", { name: "정렬" })).toBeVisible();
    expect(within(index).queryByRole("button", { name: "신규 작품 갱신" })).not.toBeInTheDocument();
    expect(within(index).queryByRole("button", { name: "중복 후보 검토" })).not.toBeInTheDocument();
    expect(within(index).queryByRole("checkbox", { name: "숨긴 결과 표시" })).not.toBeInTheDocument();
    expect(within(index).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(bar).getByRole("radio", { name: "카탈로그" })).toBeVisible();
    expect(within(screen.getByTestId("shared-titlebar")).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("shared-titlebar")).getByRole("heading", { name: "망가" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "창 닫기" })).toHaveLength(1);
    expect(screen.getByTestId("shared-titlebar")).toContainElement(screen.getByRole("toolbar"));
    expect(within(bar).getByRole("button", { name: "언어" })).toBeVisible();
    expect(within(screen.getByTestId("shared-titlebar")).queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "온라인 만화 검색" })).not.toBeInTheDocument();
    await user.click(within(index).getByRole("button", { name: "온라인 만화 검색" }));
    const input = await screen.findByRole("combobox", { name: "온라인 만화 검색" });
    await user.type(input, "기록{Enter}");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "온라인 만화 검색" })).not.toBeInTheDocument());
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ text: "기록", page: 0 }));
  });
  it("searches Korean by default and explicitly switches to Japanese from page zero", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "korean", page: 0 }),
    ));

    await chooseMenu("언어", "일본어");

    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "japanese", page: 0 }),
    ));
  });

  it("does not restore Japanese results when a Japanese update finishes after switching to Korean", async () => {
    const gateway = createGateway(true);
    const update = deferred<Awaited<ReturnType<LibraryGateway["updateOnlineCatalog"]>>>();
    vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue(catalogStatusWithJapanese(true));
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (searchQuery) => ({
      works: [{ ...work, title: searchQuery.language === "japanese" ? "일본어 결과" : "한국어 결과" }],
      totalCount: 1,
      page: searchQuery.page,
      pageSize: 48,
    }));
    vi.mocked(gateway.updateOnlineCatalog).mockReturnValue(update.promise);
    renderBrowser(gateway);

    expect(await screen.findByRole("button", { name: "한국어 결과 상세 보기" })).toBeVisible();

    await chooseMenu("언어", "일본어");
    expect(await screen.findByRole("button", { name: "일본어 결과 상세 보기" })).toBeVisible();
    await userEvent.click(await catalogMenuItem("신규 작품 갱신"));

    await chooseMenu("언어", "한국어");
    expect(await screen.findByRole("button", { name: "한국어 결과 상세 보기" })).toBeVisible();
    await act(async () => update.resolve({
      language: "japanese",
      added: 1,
      pages: 1,
      reason: "completed",
      lastSuccessAt: "2026-09-05T02:00:00Z",
    }));

    await waitFor(() => expect(gateway.getOnlineCatalogStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("1개 작품을 갱신했습니다")).not.toBeInTheDocument();
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "korean", page: 0 }),
    );
    expect(screen.queryByRole("button", { name: "일본어 결과 상세 보기" })).not.toBeInTheDocument();
  });

  it("bounds a completed Japanese manual update to forty pages", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue(catalogStatusWithJapanese(true));
    renderBrowser(gateway);

    await screen.findByRole("button", { name: "언어" });
    await chooseMenu("언어", "일본어");
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "japanese" }),
    ));
    await userEvent.click(await catalogMenuItem("신규 작품 갱신"));

    expect(gateway.updateOnlineCatalog).toHaveBeenCalledWith("japanese", 40);
  });

  it("temporarily reveals blocked results and sends the policy override to SQLite", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => ({
      works: [work],
      totalCount: query.revealBlocked ? 3 : 1,
      page: query.page,
      pageSize: 48,
    }));
    renderBrowser(gateway);

    const reveal = await catalogMenuItem("숨긴 결과 표시", "menuitemcheckbox");
    expect(reveal).not.toBeChecked();
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ revealBlocked: false }),
    );

    await userEvent.click(reveal);

    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ revealBlocked: true, page: 0 }),
    ));
    expect(await catalogMenuItem("숨긴 결과 표시", "menuitemcheckbox")).toBeChecked();
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByText("숨긴 분류와 차단 태그를 표시 중입니다")).toBeVisible();
    expect(screen.getByText("3개 결과")).toBeVisible();
  });

  it("reloads policy-filtered counts after settings change and catalog reentry", async () => {
    const gateway = createGateway(true);
    let hiddenCategories: number[] = [];
    vi.mocked(gateway.getCatalogVisibilityPolicy).mockImplementation(async () => ({
      hiddenCategories,
      blockedTags: [],
    }));
    vi.mocked(gateway.setCatalogCategoryHidden).mockImplementation(async (category, hidden) => {
      hiddenCategories = hidden ? [category] : [];
      return { hiddenCategories, blockedTags: [] };
    });
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => ({
      works: [work],
      totalCount: hiddenCategories.includes(2) ? 1 : 3,
      page: query.page,
      pageSize: 48,
    }));
    const first = renderBrowser(gateway);
    expect(await screen.findByText("3개 결과")).toBeVisible();
    first.unmount();

    const settings = render(
      <LibraryProvider gateway={gateway}>
        <CatalogVisibilitySettings />
      </LibraryProvider>,
    );
    await userEvent.click(await screen.findByRole("switch", { name: "만화 숨기기" }));
    expect(gateway.setCatalogCategoryHidden).toHaveBeenCalledWith(2, true);
    settings.unmount();

    renderBrowser(gateway);

    expect(await screen.findByText("1개 결과")).toBeVisible();
    expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest search response", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "온라인 만화 검색" }));
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });
    const older = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    const newer = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.submit(search.closest("form")!);
    await userEvent.click(await screen.findByRole("button", { name: "온라인 만화 검색" }));
    const newerSearch = await screen.findByRole("combobox", { name: "온라인 만화 검색" });
    fireEvent.change(newerSearch, { target: { value: "new" } });
    fireEvent.submit(newerSearch.closest("form")!);
    await act(async () => newer.resolve({ works: [{ ...work, title: "새 결과" }], totalCount: 1, page: 0, pageSize: 48 }));
    expect(await screen.findByRole("button", { name: "새 결과 상세 보기" })).toBeVisible();
    await act(async () => older.resolve({ works: [{ ...work, title: "옛 결과" }], totalCount: 1, page: 0, pageSize: 48 }));
    expect(screen.queryByRole("button", { name: "옛 결과 상세 보기" })).not.toBeInTheDocument();
  });

  it("disables a bookmark until its write finishes", async () => {
    const gateway = createGateway(true);
    const pending = deferred<void>();
    vi.mocked(gateway.setOnlineCatalogBookmark).mockReturnValue(pending.promise);
    renderBrowser(gateway);
    const bookmark = await screen.findByRole("button", { name: "오래된 제독 북마크" });

    await userEvent.click(bookmark);
    expect(bookmark).toBeDisabled();
    fireEvent.click(bookmark);
    expect(gateway.setOnlineCatalogBookmark).toHaveBeenCalledTimes(1);
    vi.mocked(gateway.searchOnlineCatalog).mockResolvedValue({ works: [{ ...work, bookmarked: true }], totalCount: 1, page: 0, pageSize: 48 });
    await act(async () => pending.resolve());
    expect(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" })).toBeEnabled();
  });

  it("keeps equal provider work ids isolated in UI state and gateway calls", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockResolvedValue({
      works: [
        work,
        { ...work, provider: "heliotrope", title: "다른 공급자 작품" },
      ],
      totalCount: 2,
      page: 0,
      pageSize: 48,
    });
    renderBrowser(gateway);

    await screen.findByRole("button", { name: "다른 공급자 작품 북마크" });
    vi.mocked(gateway.searchOnlineCatalog).mockResolvedValue({ works: [work, { ...work, provider: "heliotrope", title: "다른 공급자 작품", bookmarked: true }], totalCount: 2, page: 0, pageSize: 48 });
    await userEvent.click(screen.getByRole("button", { name: "다른 공급자 작품 북마크" }));

    expect(gateway.setOnlineCatalogBookmark).toHaveBeenCalledWith(
      { provider: "heliotrope", providerWorkId: "3" },
      true,
    );
    expect(screen.getByRole("button", { name: "다른 공급자 작품 북마크 해제" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "오래된 제독 북마크" })).toBeEnabled();
  });

  it("does not open a viewer after closing a pending read", async () => {
    const gateway = createGateway(true);
    const gallery = deferred<ResolvedGallery>();
    vi.mocked(gateway.resolveOnlineCatalogWork).mockReturnValue(gallery.promise);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    await userEvent.click(screen.getByRole("button", { name: "상세 닫기" }));
    await act(async () => gallery.resolve(resolvedGallery()));
    expect(readerPosition()).not.toBeInTheDocument();
  });

  it("keeps every appended bookmark page when a removal refreshes quietly", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    const removed = () => vi.mocked(gateway.setOnlineCatalogBookmark).mock.calls.length > 0;
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => {
      const page = fullPage(query, removed() ? 96 : 97, "북마크");
      // After the removal the second page closes the gap; its first work moves up.
      const works = page.works.map(item => ({ ...item, bookmarked: true }));
      return { ...page, works: removed() && query.page === 1 ? works.slice(1) : works };
    });
    renderBrowser(gateway, "bookmarked");
    await screen.findByRole("button", { name: "북마크 0-0 상세 보기" });
    await io.reveal();
    await screen.findByRole("button", { name: "북마크 1-5 상세 보기" });
    expect(document.querySelector(".online-catalog__list-end")).toHaveTextContent("96 / 97");
    const grid = document.querySelector<HTMLDivElement>(".online-catalog__content")!;
    grid.scrollTop = 900;
    const before = vi.mocked(gateway.searchOnlineCatalog).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "북마크 1-0 북마크 해제" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "북마크 1-0 상세 보기" })).not.toBeInTheDocument());
    expect(vi.mocked(gateway.searchOnlineCatalog).mock.calls.slice(before).map(([query]) => [query.scope, query.page])).toEqual([["bookmarked", 0], ["bookmarked", 1]]);
    expect(screen.getByRole("button", { name: "북마크 0-0 상세 보기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "북마크 1-47 상세 보기" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".online-catalog__list-end")).toHaveTextContent("95 / 96"));
    expect(grid.scrollTop).toBe(900);
  });

  it("does not restore an old bookmarked view after a pending removal", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => ({
      works: [{ ...work, bookmarked: query.scope === "bookmarked" }],
      totalCount: 1,
      page: query.page,
      pageSize: 48,
    }));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    await userEvent.click(screen.getByRole("radio", { name: /^북마크/ }));
    const pending = deferred<void>();
    vi.mocked(gateway.setOnlineCatalogBookmark).mockReturnValueOnce(pending.promise);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" }));
    await userEvent.click(screen.getByRole("radio", { name: "카탈로그" }));
    await act(async () => pending.resolve());

    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "all", page: 0 }),
    );
  });

  it("opens local details before resolving pages and routes tag searches", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValue({ ...detail, tagGroups: [
      { namespace: "character", values: ["teitoku", "untranslated_name"], labels: { teitoku: "제독" } },
      { namespace: "language", values: ["korean"] },
    ] });
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await waitFor(() => expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" }));
    expect(gateway.getRemoteReadingProgress).not.toHaveBeenCalled();
    expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();

    expect(await screen.findByRole("button", { name: "character:teitoku 검색" })).toHaveTextContent("제독");
    expect(screen.getByRole("button", { name: "character:untranslated_name 검색" })).toHaveTextContent("untranslated name");
    expect(screen.getByRole("button", { name: "language:korean 검색" })).toHaveTextContent("한국어");
    expect(screen.getByText("업로더")).not.toBeVisible();
    await userEvent.click(screen.getByText("추가 정보"));
    expect(screen.getByText("업로더")).toBeVisible();

    await userEvent.click(await screen.findByRole("button", { name: "character:teitoku 검색" }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "character:teitoku", page: 0 }),
    ));

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await waitFor(() => expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledTimes(2));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(await findReaderPosition("1 / 3")).toBeVisible();
  });

  it("closes detail before reading and returns focus to the catalog card on exit", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    const card = await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    await userEvent.click(card);
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    await screen.findByRole("button", { name: "망가 뷰어 닫기" });
    expect(document.querySelector('.ui-overlay-panel')).toBeNull();
    await userEvent.keyboard("{Escape}");

    expect(readerPosition()).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "망가 상세" })).not.toBeInTheDocument();
    await waitFor(() => expect(card).toHaveFocus());
  });

  it("keeps valid search results visible and reports the refresh failure detail", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    expect(await screen.findByRole("button", { name: "오래된 제독 상세 보기" })).toBeVisible();
    const refresh = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(refresh.promise);

    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(screen.getByRole("button", { name: "오래된 제독 상세 보기" })).toBeVisible();
    await act(async () => refresh.reject(new Error("연결 시간이 초과되었습니다")));
    expect(await screen.findByText("연결 시간이 초과되었습니다")).toBeVisible();
    expect(screen.getByRole("button", { name: "오래된 제독 상세 보기" })).toBeVisible();
  });

  it("shows structured query syntax errors without replacing the last valid results", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    expect(await screen.findByRole("button", { name: "오래된 제독 상세 보기" })).toBeVisible();
    vi.mocked(gateway.searchOnlineCatalog).mockRejectedValueOnce({
      code: "catalog_query_syntax",
      message: "검색식 7..7 위치: 검색 조건이 더 필요합니다",
    });

    await userEvent.click(await screen.findByRole("button", { name: "온라인 만화 검색" }));
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });
    await userEvent.clear(search);
    await userEvent.type(search, "제독 AND");
    fireEvent.submit(search.closest("form")!);

    expect(await screen.findByText("검색식 7..7 위치: 검색 조건이 더 필요합니다")).toBeVisible();
    expect(screen.getByRole("button", { name: "오래된 제독 상세 보기" })).toBeVisible();
  });

  it("shows cover thumbnails and keeps bookmarks and filters isolated", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    const cover = await screen.findByAltText("오래된 제독 표지");
    fireEvent.load(cover);
    expect(screen.getByRole("img", { name: "오래된 제독 표지" })).toBeVisible();
    const card = cover.closest("article")!;
    expect(cover).toHaveAttribute("src", work.thumbnailUrl);
    expect(within(card).getByText("오래된 제독")).not.toHaveAttribute("title");
    // Mobile-like tile: cover, title and artist only; views and series live in the detail panel.
    expect(within(card).getByText("artist")).toBeVisible();
    expect(within(card).queryByText(/series/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/조회/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "오래된 제독 북마크" }));
    expect(gateway.setOnlineCatalogBookmark).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" }, true);
    expect(gateway.getOnlineCatalogWorkDetail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("radio", { name: /^북마크/ }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "bookmarked", page: 0 }),
    );

    fireEvent.error(cover);
    expect(within(card).getByText("24p")).toBeVisible();
  });

  it("imports a missing catalog from the selected VCK folder", async () => {
    const gateway = createGateway(false);
    vi.mocked(open).mockResolvedValue("C:\\VCK");
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "VCK 데이터 가져오기" }));

    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(gateway.importVckCatalog).toHaveBeenCalledWith("C:\\VCK");
  });

  it("returns focus to the search trigger after keyboard navigation selects a suggestion", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "온라인 만화 검색" }));
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });

    await userEvent.type(search, "제독");
    const suggestion = await screen.findByRole("option", { name: /제독/ });
    const listbox = suggestion.closest('[role="listbox"]')!;
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(search).toHaveAttribute("aria-controls", listbox.id);

    await userEvent.keyboard("{ArrowDown}");
    expect(suggestion).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", suggestion.id);

    const pending = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(pending.promise);
    await userEvent.keyboard("{Enter}");
    const trigger = screen.getByRole("button", { name: "온라인 만화 검색" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("combobox", { name: "온라인 만화 검색" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /제독/ })).not.toBeInTheDocument();
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "character:teitoku", page: 0 }),
    );
  });

  it("suggests for namespaced and short-namespace text and keeps the active option in view", async () => {
    const gateway = createGateway(true);
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "온라인 만화 검색" }));
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });

    await userEvent.type(search, "c:teito");
    await screen.findByRole("option", { name: /제독/ });
    expect(gateway.suggestOnlineCatalog).toHaveBeenLastCalledWith("c:teito", 10);
    await userEvent.keyboard("{ArrowDown}");
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("searches by a Korean suggestion, changes sort, and opens a result", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "온라인 만화 검색" }));
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });

    await userEvent.type(search, "제독");
    await userEvent.click(await screen.findByRole("option", { name: /제독/ }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ text: "character:teitoku" }),
    ));
    expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(expect.objectContaining({ sort: "hotDay" }));
    await chooseMenu("정렬", "주간 인기");
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "hotWeek" }),
    ));
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(await findReaderPosition("1 / 3")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByText(/카탈로그$/)).toBeVisible();
    await userEvent.keyboard("{ArrowLeft}");
    await findReaderPosition("2 / 3");
    expect(gateway.saveRemoteReadingProgress).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));
    expect(gateway.saveRemoteReadingProgress).not.toHaveBeenCalled();
  });

  it("runs a manual catalog update with timestamp feedback only", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await userEvent.click(await catalogMenuItem("신규 작품 갱신"));

    expect(gateway.updateOnlineCatalog).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.querySelector(".manga-toolbar__refresh time")).toHaveTextContent("갱신"));
    expect(screen.queryByText("3개 작품을 갱신했습니다")).not.toBeInTheDocument();
  });

  it("surfaces the last catalog update error instead of the success time", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue({
      installed: true,
      workCount: 1,
      updateEnabled: true,
      updateIntervalSeconds: 3600,
      lastAttemptAt: "2026-08-28T09:00:00Z",
      lastSuccessAt: null,
      lastAdded: 0,
      lastError: "요청이 제한되었습니다",
      streams: [],
    });
    renderBrowser(gateway);

    expect(await screen.findByRole("alert")).toHaveTextContent("마지막 갱신 실패 — 요청이 제한되었습니다");
  });

  it("shows the public command error when a manual catalog update fails", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.updateOnlineCatalog).mockRejectedValue({
      code: "invalid_catalog_transport_response",
      message: "온라인 카탈로그 응답을 처리할 수 없습니다",
    });
    renderBrowser(gateway);

    await userEvent.click(await catalogMenuItem("신규 작품 갱신"));

    expect(await screen.findByText("온라인 카탈로그 응답을 처리할 수 없습니다")).toBeInTheDocument();
  });

  it("shows resolved CDN images without routing them through the native media protocol", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));

    const page = await screen.findByRole("img", { name: "오래된 제독 1페이지" });
    expect(page).toHaveAttribute("src", "https://a.siam-cdn.net/1.webp?expires=1800000000");
    expect(page).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("never saves a reading position when changing pages or closing the viewer", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    await findReaderPosition("1 / 3");
    vi.useFakeTimers();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));

    expect(gateway.saveRemoteReadingProgress).not.toHaveBeenCalled();
    expect(gateway.getRemoteReadingProgress).not.toHaveBeenCalled();
  });
});

it("opens bookmarks without the default hot-day date restriction", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway, "bookmarked");
  expect(screen.getByRole("radio", { name: "북마크" })).toBeInTheDocument();
  await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "bookmarked", sort: "latest", page: 0 }),
  ));
});

it("quietly refreshes when background bookmark reconciliation changes local state", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
  const before = vi.mocked(gateway.searchCatalogGroups).mock.calls.length;

  act(() => window.dispatchEvent(new Event("lakomics-catalog-bookmarks-changed")));

  await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenCalledTimes(before + 1));
});

/** Opens the top-bar overflow menu (when closed) and returns one of its items. */
async function catalogMenuItem(name: string, role: "menuitem" | "menuitemcheckbox" = "menuitem") {
  if (!screen.queryByRole("menu")) await userEvent.click(await screen.findByRole("button", { name: "카탈로그 더보기" }));
  return screen.findByRole(role, { name });
}

function readerPosition(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".asset-viewer__position");
}

async function findReaderPosition(text: string): Promise<HTMLElement> {
  await waitFor(() => expect(readerPosition()?.textContent).toBe(text));
  return readerPosition()!;
}

function renderBrowser(gateway: LibraryGateway, initialScope: "all" | "bookmarked" = "all") {
  return render(
    <LibraryProvider gateway={gateway}>
      <WorkspaceChromeProvider scope="catalog-test">
        <aside aria-label="카탈로그 인덱스">
          <ChromeTarget name="actions" />
          <ChromeTarget name="search" />
          <ChromeTarget name="navigation" />
        </aside>
        <ChromeTarget name="header" />
        <OnlineCatalogBrowser onSwitchLocal={vi.fn()} initialScope={initialScope} />
      </WorkspaceChromeProvider>
    </LibraryProvider>,
  );
}

function createGateway(installed: boolean): LibraryGateway {
  const gateway = {
    getOnlineCatalogStatus: vi.fn().mockResolvedValue({
      installed,
      workCount: installed ? 1 : 0,
      updateEnabled: true,
      updateIntervalSeconds: 3600,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastAdded: 0,
      lastError: null,
    }),
    importVckCatalog: vi.fn().mockResolvedValue({ installed: true, workCount: 1 }),
    searchOnlineCatalog: vi.fn().mockImplementation(async (query) => ({
      works: [
        work,
        { ...work, providerWorkId: "4", title: "함대 일지", thumbnailUrl: null },
        { ...work, providerWorkId: "5", title: "제독의 하루", thumbnailUrl: null },
      ],
      totalCount: 97,
      page: query.page,
      pageSize: 48,
    })),
    suggestOnlineCatalog: vi.fn().mockResolvedValue([{ value: "character:teitoku", label: "제독", count: 2 }]),
    getOnlineCatalogWorkDetail: vi.fn().mockResolvedValue(detail),
    setOnlineCatalogBookmark: vi.fn().mockResolvedValue(undefined),
    resolveOnlineCatalogWork: vi.fn().mockResolvedValue(resolvedGallery()),
    getRemoteReadingProgress: vi.fn().mockResolvedValue({ provider: "kHentai", providerWorkId: "3", lastPage: 2, pageCount: 3, lastReadAt: "2026-08-22T12:00:00Z" }),
    saveRemoteReadingProgress: vi.fn().mockResolvedValue(undefined),
    updateOnlineCatalog: vi.fn().mockResolvedValue({
      added: 3,
      pages: 1,
      reason: "completed",
      lastSuccessAt: "2026-08-22T12:00:00Z",
    }),
    getCatalogVisibilityPolicy: vi.fn().mockResolvedValue({
      hiddenCategories: [],
      blockedTags: [],
    }),
    setCatalogCategoryHidden: vi.fn().mockResolvedValue({
      hiddenCategories: [],
      blockedTags: [],
    }),
    setCatalogTagBlocked: vi.fn().mockResolvedValue({
      hiddenCategories: [],
      blockedTags: [],
    }),
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
  } as unknown as LibraryGateway;
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (query, emit) => {
    const result = await gateway.searchOnlineCatalog(query);
    emit({ type: "page", page: { ...result, works: result.works.map((work) => ({ ...work, groupId: work.providerWorkId, versionCount: 1, hasBookmarkedVersion: work.bookmarked })) } });
    emit({ type: "count", totalCount: result.totalCount });
    emit({ type: "end", cancelled: false });
  });
  return gateway;
}

function catalogStatusWithJapanese(initialComplete: boolean): CatalogStatus {
  return {
    installed: true,
    workCount: 1,
    updateEnabled: true,
    updateIntervalSeconds: 3_600,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastAdded: 0,
    lastError: null,
    streams: [{
      provider: "kHentai",
      language: "japanese",
      hasState: true,
      initialComplete,
      watermark: 100,
      cursor: null,
      pendingMax: 0,
      lastAttemptAt: null,
      lastProgressAt: null,
      lastCompletedAt: initialComplete ? "2026-09-05T01:00:00Z" : null,
      lastAdded: 0,
      lastError: null,
    }],
  };
}

function resolvedGallery(): ResolvedGallery {
  return {
    provider: "kHentai",
    providerWorkId: "3",
    pageCount: 3,
    pageUrls: [
      "https://a.siam-cdn.net/1.webp?expires=1800000000",
      "https://a.siam-cdn.net/2.webp?expires=1800000000",
      "https://a.siam-cdn.net/3.webp?expires=1800000000",
    ],
  };
}

/** Representative management stays reachable from the detail header. */
async function openEditions(title: string) {
  if (!screen.queryByRole("complementary", { name: "망가 상세" })) {
    await userEvent.click(await screen.findByRole("button", { name: `${title} 상세 보기` }));
  }
  await userEvent.click(await screen.findByRole("button", { name: "상세 더보기" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "대표 판본 바꾸기" }));
}

it("hides editions for a single-edition work and keeps its bookmark action", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  expect(await screen.findByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  expect(within(panel).queryByRole("region", { name: "판본" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "상세 더보기" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "상세 닫기" }));
  expect(screen.getByRole("button", { name: `${work.title} 북마크` })).toBeVisible();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}


it("shows grouped cards before exact count and rejects stale counts and failures", async () => {
  const gateway = createGateway(true);
  const events: Array<(event: CatalogGroupedSearchEvent) => void> = [];
  const old = deferred<void>();
  gateway.searchCatalogGroups = vi.fn().mockImplementation((_query, onEvent) => {
    events.push(onEvent);
    onEvent({ type: "page", page: { works: [{ ...work, groupId: "uuid", versionCount: 104, hasBookmarkedVersion: true }], page: 0, pageSize: 48 } });
    return events.length === 1 ? old.promise : Promise.resolve();
  });
  renderBrowser(gateway);
  expect(await screen.findByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
  expect(screen.queryByText("결과 수 계산 중…")).not.toBeInTheDocument();
  expect(document.querySelector(".online-catalog__list-end")).toHaveTextContent("1개");
  await chooseMenu("언어", "일본어");
  await act(async () => { events[1]({ type: "count", totalCount: 0 }); events[0]({ type: "count", totalCount: 999 }); old.reject(new Error("old failure")); });
  expect(await screen.findByText("0개 결과")).toBeVisible();
  expect(screen.queryByText("999개 결과")).not.toBeInTheDocument();
  expect(screen.queryByText("old failure")).not.toBeInTheDocument();
});


it("loads representative management in bounded pages and persists manual and automatic selection", async () => {
  const gateway = createGateway(true);
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [{ ...work, groupId: "uuid", versionCount: 104, hasBookmarkedVersion: true }], page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 1 });
  });
  let selectedProviderWorkId: string | null = null;
  gateway.getCatalogGroupEditions = vi.fn().mockImplementation(async (query) => ({ groupId: "uuid", works: [{ ...work, providerWorkId: String(query.page + 10), title: `판본 ${query.page}` }], totalCount: 104, page: query.page, pageSize: 40, selectedProviderWorkId }));
  gateway.setCatalogGroupRepresentative = vi.fn().mockImplementation(async (query) => { selectedProviderWorkId = query.selectedProviderWorkId; });
  renderBrowser(gateway);
  await screen.findByRole("button", { name: `${work.title} 상세 보기` });
  expect(gateway.getCatalogGroupEditions).not.toHaveBeenCalled();
  await openEditions(work.title);
  const dialog = await screen.findByRole("dialog", { name: "작품 판본" });
  expect(await screen.findByRole("button", { name: "판본 0 열기" })).toBeVisible();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith({ provider: "kHentai", groupId: "uuid", language: "korean", revealBlocked: false, page: 0, pageSize: 40 });
  await userEvent.click(within(dialog).getByRole("button", { name: "판본 더 보기" }));
  expect(await screen.findByRole("button", { name: "판본 1 열기" })).toBeVisible();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 40 }));
  await userEvent.click(within(dialog).getByRole("button", { name: "판본 더 보기" }));
  expect(await screen.findByRole("button", { name: "판본 2 열기" })).toBeVisible();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 40 }));
  expect(within(dialog).queryByRole("button", { name: "판본 더 보기" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "판본 0 대표로 지정" }));
  expect(gateway.setCatalogGroupRepresentative).toHaveBeenLastCalledWith({ provider: "kHentai", groupId: "uuid", selectedProviderWorkId: "10" });
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await openEditions(work.title);
  expect(await screen.findByRole("button", { name: "판본 0 대표로 지정" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "자동 선택" }));
  expect(gateway.setCatalogGroupRepresentative).toHaveBeenLastCalledWith({ provider: "kHentai", groupId: "uuid", selectedProviderWorkId: null });
  expect(gateway.searchCatalogGroups).toHaveBeenCalledTimes(3);
  await userEvent.click(screen.getByRole("button", { name: "판본 0 열기" }));
  expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenLastCalledWith({ provider: "kHentai", providerWorkId: "10" });
});


it("invalidates pending counts on bookmark and reveal changes and retains cards on count error", async () => {
  const gateway = createGateway(true);
  const events: Array<(event: CatalogGroupedSearchEvent) => void> = [];
  const bookmark = deferred<void>();
  gateway.setOnlineCatalogBookmark = vi.fn().mockReturnValue(bookmark.promise);
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    events.push(emit);
    emit({ type: "page", page: { works: [{ ...work, groupId: "uuid", versionCount: 2, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
  });
  const view = renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 북마크` }));
  act(() => events[0]({ type: "count", totalCount: 100 }));
  expect(screen.queryByText("100개 결과")).not.toBeInTheDocument();
  await act(async () => bookmark.resolve());
  act(() => events[1]({ type: "count", totalCount: 200 }));
  expect(screen.getByText("200개 결과")).toBeVisible();
  await userEvent.click(await catalogMenuItem("숨긴 결과 표시", "menuitemcheckbox"));
  expect(screen.queryByText("200개 결과")).not.toBeInTheDocument();
  act(() => { events[1]({ type: "count", totalCount: 999 }); events[2]({ type: "countError", message: "snapshot changed" }); });
  expect(screen.getByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
  expect(screen.getByText("결과 수 확인 실패")).toBeVisible();
  expect(document.querySelector(".online-catalog__list-end")).toHaveTextContent("1개");
  view.unmount();
  act(() => events[2]({ type: "count", totalCount: 999 }));
  expect(screen.queryByText("999개 결과")).not.toBeInTheDocument();
});


it("refreshes the grouped card when a representative save finishes after closing editions", async () => {
  const gateway = createGateway(true);
  const save = deferred<void>();
  let title = work.title;
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [{ ...work, title, groupId: "uuid", versionCount: 2, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 1 });
  });
  gateway.getCatalogGroupEditions = vi.fn().mockResolvedValue({ groupId: "uuid", works: [{ ...work, title: "새 대표 판본" }], totalCount: 1, page: 0, pageSize: 40, selectedProviderWorkId: null });
  gateway.setCatalogGroupRepresentative = vi.fn().mockReturnValue(save.promise);
  renderBrowser(gateway);
  await openEditions(work.title);
  await userEvent.click(await screen.findByRole("button", { name: "새 대표 판본 대표로 지정" }));
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  title = "새 대표 판본";
  await act(async () => save.resolve());
  expect(await screen.findByRole("button", { name: "새 대표 판본 상세 보기" })).toBeVisible();
});

async function chooseMenu(label: string, option: string) {
  await userEvent.click(screen.getByRole("button", { name: label }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: option }));
}

it.each(["all", "bookmarked"] as const)("opens a %s card in the shared panel, selects its cover and leaves the grid scrollable", async scope => {
  const gateway = createGateway(true);
  const { container } = renderBrowser(gateway, scope);
  const card = await screen.findByRole("button", { name: `${work.title} 상세 보기` });
  const grid = container.querySelector<HTMLElement>(".online-catalog__content")!;
  grid.scrollTop = 400;
  await userEvent.click(card);
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  expect(panel).toHaveClass("ui-overlay-panel");
  expect(panel).toContainElement(document.activeElement as HTMLElement);
  expect(card).toHaveAttribute("aria-pressed", "true");
  expect(card.querySelector(".ui-selectable-media")).toHaveAttribute("aria-selected", "true");
  expect(card.querySelector(".ui-selection-check")).not.toBeNull();
  expect(container.querySelector(".online-catalog__frame")).not.toHaveAttribute("inert");
  expect(grid.scrollTop).toBe(400);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "닫기" })).not.toBeInTheDocument();
  expect(readFileSync("src/manga/manga.css", "utf8")).toMatch(/\.online-catalog__workspace\s*\{[^}]*position: relative/);
  expect(existsSync("src/manga/OnlineCatalogDetailDialog.tsx")).toBe(false);
  expect(readFileSync("src/manga/manga.css", "utf8")).not.toContain("online-catalog-detail");
});

it("swaps cards without unmounting the panel and holds inert old content until the next detail arrives", async () => {
  const gateway = createGateway(true);
  const second = deferred<CatalogWorkDetail>();
  vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValueOnce(detail).mockReturnValueOnce(second.promise);
  renderBrowser(gateway);
  const firstCard = await screen.findByRole("button", { name: `${work.title} 상세 보기` });
  await userEvent.click(firstCard);
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  await waitFor(() => expect(panel).toHaveAttribute("data-state", "open"));
  const secondCard = screen.getByRole("button", { name: "함대 일지 상세 보기" });
  await userEvent.click(secondCard);
  expect(screen.getByRole("complementary", { name: "망가 상세" })).toBe(panel);
  expect(panel).toHaveAttribute("data-state", "open");
  expect(within(panel).getByRole("heading", { name: work.title })).toBeInTheDocument();
  await waitFor(() => expect(panel.querySelector("[inert]")).not.toBeNull());
  expect(firstCard).toHaveAttribute("aria-pressed", "true");
  await act(async () => second.resolve({ ...detail, providerWorkId: "4", title: "함대 일지" }));
  expect(screen.getByRole("complementary", { name: "망가 상세" })).toBe(panel);
  expect(within(panel).getByRole("heading", { name: "함대 일지" })).toBeInTheDocument();
  expect(within(panel).queryByRole("heading", { name: work.title })).not.toBeInTheDocument();
  expect(panel.querySelector("[inert]")).toBeNull();
  expect(secondCard).toHaveAttribute("aria-pressed", "true");
  expect(firstCard).toHaveAttribute("aria-pressed", "false");
  expect(panel).toContainElement(document.activeElement as HTMLElement);
  await userEvent.keyboard("{Escape}");
  expect(panel).toHaveAttribute("data-state", "closed");
  expect(within(panel).getByRole("heading", { name: "함대 일지" })).toBeInTheDocument();
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(secondCard).toHaveFocus();
});

it.each(["Escape", "outside", "X"])("closes on %s and returns focus to the card after one continuous exit", async action => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  const card = await screen.findByRole("button", { name: `${work.title} 상세 보기` });
  await userEvent.click(card);
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  if (action === "Escape") await userEvent.keyboard("{Escape}");
  else if (action === "outside") fireEvent.pointerDown(document.body);
  else await userEvent.click(screen.getByRole("button", { name: "상세 닫기" }));
  expect(panel).toHaveAttribute("data-state", "closed");
  expect(within(panel).getByRole("heading", { name: work.title })).toBeInTheDocument();
  expect(card).toHaveAttribute("aria-pressed", "false");
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(card).toHaveFocus();
});

it("swaps an edition in the same panel, outlines the open cover and returns focus to its group card", async () => {
  const gateway = createGateway(true);
  const alternative = { ...work, providerWorkId: "4", title: "다른 판본", fileCount: 56 };
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [{ ...work, groupId: "group", versionCount: 2, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 1 });
  });
  gateway.getCatalogGroupEditions = vi.fn().mockResolvedValue({ groupId: "group", works: [work, alternative], totalCount: 2, page: 0, pageSize: 40, selectedProviderWorkId: null });
  const next = deferred<CatalogWorkDetail>();
  vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValueOnce(detail).mockReturnValueOnce(next.promise);
  renderBrowser(gateway);
  const card = await screen.findByRole("button", { name: `${work.title} 상세 보기` });
  await userEvent.click(card);
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  expect(screen.getByRole("button", { name: `${work.title} 판본 열기` })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("56p · 한국어")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "다른 판본 판본 열기" }));
  expect(within(panel).getByRole("heading", { name: work.title })).toBeInTheDocument();
  expect(panel.querySelector("[inert]")).not.toBeNull();
  await act(async () => next.resolve({ ...detail, ...alternative }));
  expect(screen.getByRole("complementary", { name: "망가 상세" })).toBe(panel);
  expect(screen.getByRole("button", { name: "다른 판본 판본 열기" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: `${work.title} 판본 열기` })).toHaveAttribute("aria-pressed", "false");
  expect(gateway.getCatalogGroupEditions).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(card).toHaveFocus();
});

it("searches a tag and closes the panel, without resolving page addresses", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  await userEvent.click(screen.getByRole("button", { name: "character:teitoku 검색" }));
  expect(panel).toHaveAttribute("data-state", "closed");
  await waitFor(() => expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ text: "character:teitoku", page: 0 }), expect.any(Function), expect.any(String)));
  expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();
  await waitFor(() => expect(panel).not.toBeInTheDocument());
});

it("keeps the resolving read action busy in the panel and opens page 1, including after a bookmark sync event", async () => {
  const gateway = createGateway(true);
  const resolve = deferred<ResolvedGallery>();
  vi.mocked(gateway.resolveOnlineCatalogWork).mockReturnValue(resolve.promise);
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  const read = screen.getByRole("button", { name: "읽기" });
  await userEvent.click(read);
  expect(screen.getByRole("button", { name: "읽기" })).toBe(read);
  expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  expect(read).toBeDisabled();
  vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValue({ ...detail, bookmarked: true });
  act(() => window.dispatchEvent(new Event(CATALOG_BOOKMARKS_CHANGED_EVENT)));
  expect(await within(panel).findByRole("button", { name: "북마크 해제" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("complementary", { name: "망가 상세" })).toBe(panel);
  await act(async () => resolve.resolve(resolvedGallery()));
  expect(await findReaderPosition("1 / 3")).toBeInTheDocument();
  expect(gateway.getRemoteReadingProgress).not.toHaveBeenCalled();
});

it("rejects stale card responses and bookmark refreshes during a card switch", async () => {
  const gateway = createGateway(true);
  const old = deferred<CatalogWorkDetail>();
  const latest = deferred<CatalogWorkDetail>();
  vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValueOnce(detail).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  await userEvent.click(screen.getByRole("button", { name: "함대 일지 상세 보기" }));
  await waitFor(() => expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledTimes(2));
  act(() => window.dispatchEvent(new Event(CATALOG_BOOKMARKS_CHANGED_EVENT)));
  expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("button", { name: "제독의 하루 상세 보기" }));
  await waitFor(() => expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledTimes(3));
  await act(async () => latest.resolve({ ...detail, providerWorkId: "5", title: "제독의 하루" }));
  await act(async () => old.resolve({ ...detail, providerWorkId: "4", title: "함대 일지" }));
  expect(within(panel).getByRole("heading", { name: "제독의 하루" })).toBeInTheDocument();
  expect(within(panel).queryByRole("heading", { name: "함대 일지" })).not.toBeInTheDocument();
});

it("retains the current panel on a failed card switch and shows the error toast", async () => {
  const gateway = createGateway(true);
  vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValueOnce(detail).mockRejectedValueOnce({ message: "다음 작품 실패" });
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  await userEvent.click(screen.getByRole("button", { name: "함대 일지 상세 보기" }));
  expect(await screen.findByText("다음 작품 실패")).toBeInTheDocument();
  expect(within(panel).getByRole("heading", { name: work.title })).toBeInTheDocument();
  expect(panel.querySelector("[inert]")).toBeNull();
  expect(screen.getByRole("button", { name: "읽기" })).toBeEnabled();
});

it("masks card, detail and edition covers through the screen's privacy setting", async () => {
  const gateway = createGateway(true);
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [{ ...work, groupId: "group", versionCount: 2, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 1 });
  });
  gateway.getCatalogGroupEditions = vi.fn().mockResolvedValue({ groupId: "group", works: [work], totalCount: 1, page: 0, pageSize: 40, selectedProviderWorkId: null });
  const { container } = render(<LibraryProvider gateway={gateway}><PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
    <OnlineCatalogBrowser onSwitchLocal={vi.fn()} />
  </PrivacyProvider></LibraryProvider>);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  await screen.findByRole("complementary", { name: "망가 상세" });
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getAllByLabelText("비공개 모드")).toHaveLength(3);
});

it("keeps the panel when Escape closes its overflow menu, then closes the panel on the next Escape", async () => {
  const gateway = createGateway(true);
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [{ ...work, groupId: "group", versionCount: 2, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 1 });
  });
  gateway.getCatalogGroupEditions = vi.fn().mockResolvedValue({ groupId: "group", works: [work], totalCount: 1, page: 0, pageSize: 40, selectedProviderWorkId: null });
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  await userEvent.click(screen.getByRole("button", { name: "상세 더보기" }));
  await screen.findByRole("menuitem", { name: "대표 판본 바꾸기" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  expect(panel).not.toHaveAttribute("data-state", "closed");
  await userEvent.keyboard("{Escape}");
  expect(panel).toHaveAttribute("data-state", "closed");
});

it("keeps edition covers during pagination failure and retries that same bounded page", async () => {
  const gateway = createGateway(true);
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [{ ...work, groupId: "group", versionCount: 41, hasBookmarkedVersion: false }], page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 1 });
  });
  gateway.getCatalogGroupEditions = vi.fn()
    .mockResolvedValueOnce({ groupId: "group", works: [work], totalCount: 41, page: 0, pageSize: 40, selectedProviderWorkId: null })
    .mockRejectedValueOnce({ message: "판본 실패" })
    .mockResolvedValueOnce({ groupId: "group", works: [{ ...work, providerWorkId: "4", title: "마지막 판본" }], totalCount: 41, page: 1, pageSize: 40, selectedProviderWorkId: null });
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  await userEvent.click(await screen.findByRole("button", { name: "판본 더 보기" }));
  expect(await screen.findByText("판본 실패")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `${work.title} 판본 열기` })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("button", { name: "마지막 판본 판본 열기" })).toBeInTheDocument();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 40 }));
  expect(screen.queryByRole("button", { name: "판본 더 보기" })).not.toBeInTheDocument();
});

it("keeps the old work and its editions until both parts of the next work arrive", async () => {
  const gateway = createGateway(true);
  const nextEditions = deferred<Awaited<ReturnType<LibraryGateway["getCatalogGroupEditions"]>>>();
  const nextDetail = deferred<CatalogWorkDetail>();
  gateway.searchCatalogGroups = vi.fn().mockImplementation(async (_query, emit) => {
    emit({ type: "page", page: { works: [work, { ...work, providerWorkId: "4", title: "다음 작품" }].map(w => ({ ...w, groupId: w.providerWorkId, versionCount: 2, hasBookmarkedVersion: false })), page: 0, pageSize: 48 } });
    emit({ type: "count", totalCount: 2 });
  });
  gateway.getCatalogGroupEditions = vi.fn().mockResolvedValueOnce({ groupId: "3", works: [work], totalCount: 1, page: 0, pageSize: 40, selectedProviderWorkId: null }).mockReturnValueOnce(nextEditions.promise);
  vi.mocked(gateway.getOnlineCatalogWorkDetail).mockResolvedValueOnce(detail).mockReturnValueOnce(nextDetail.promise);
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: `${work.title} 상세 보기` }));
  const panel = await screen.findByRole("complementary", { name: "망가 상세" });
  await userEvent.click(screen.getByRole("button", { name: "다음 작품 상세 보기" }));
  await waitFor(() => expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledTimes(2));
  await act(async () => nextDetail.resolve({ ...detail, providerWorkId: "4", title: "다음 작품" }));
  expect(within(panel).getByRole("heading", { name: work.title })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `${work.title} 판본 열기` })).toBeInTheDocument();
  await act(async () => nextEditions.resolve({ groupId: "4", works: [{ ...work, providerWorkId: "4", title: "다음 작품" }], totalCount: 1, page: 0, pageSize: 40, selectedProviderWorkId: null }));
  expect(within(panel).getByRole("heading", { name: "다음 작품" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다음 작품 판본 열기" })).toBeInTheDocument();
  expect(panel).toContainElement(document.activeElement as HTMLElement);
});

/** One full catalog page of distinct works named `${prefix} ${page}-${index}`, out of `total`. */
function fullPage(query: CatalogSearchQuery, total: number, prefix = "작품") {
  const size = Math.max(0, Math.min(query.pageSize, total - query.page * query.pageSize));
  return {
    works: Array.from({ length: size }, (_, index) => ({ ...work, providerWorkId: `${query.page}-${index}`, title: `${prefix} ${query.page}-${index}` })),
    totalCount: total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** jsdom has no IntersectionObserver; `reveal` scrolls the load-more sentinel into reach. */
function stubIntersectionObserver() {
  const live = new Set<{ callback: IntersectionObserverCallback; targets: Element[]; observer: IntersectionObserver }>();
  class FakeIntersectionObserver {
    root = null; rootMargin = ""; thresholds = [];
    private entry: { callback: IntersectionObserverCallback; targets: Element[]; observer: IntersectionObserver };
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, targets: [], observer: this as unknown as IntersectionObserver };
      live.add(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    unobserve() {}
    disconnect() { live.delete(this.entry); }
    takeRecords() { return []; }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  return {
    observing: () => [...live].some(entry => entry.targets.some(target => target.classList.contains("online-catalog__more-sentinel"))),
    reveal: async () => {
      await act(async () => {
        for (const entry of [...live]) {
          const targets = entry.targets.filter(target => target.classList.contains("online-catalog__more-sentinel"));
          if (targets.length) entry.callback(targets.map(target => ({ isIntersecting: true, target }) as IntersectionObserverEntry), entry.observer);
        }
      });
    },
  };
}

describe("load more", () => {
  it("appends the next page at the end with a skeleton row meanwhile and counts loaded of total", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    const second = deferred<ReturnType<typeof fullPage>>();
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => query.page === 1 ? second.promise : fullPage(query, 100));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "작품 0-47 상세 보기" });
    const end = document.querySelector(".online-catalog__list-end")!;
    expect(end).toHaveTextContent("48 / 100");
    expect(screen.queryByRole("button", { name: /이전 결과|다음 결과/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "더 불러오기" })).not.toBeInTheDocument();
    expect(document.querySelector(".manga-grid--more")).toBeNull();

    await io.reveal();
    expect(gateway.searchCatalogGroups).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all", sort: "hotDay", language: "korean", text: "", page: 1, pageSize: 48 }), expect.any(Function), expect.any(String));
    expect(screen.getByLabelText("다음 망가 불러오는 중")).toHaveClass("manga-grid", "manga-grid--more");
    expect(screen.getAllByRole("button", { name: /^작품 0-\d+ 상세 보기$/ })).toHaveLength(48);
    expect(document.querySelector(".online-catalog__frame")).not.toHaveAttribute("inert");
    // A second sentinel hit while the page is on its way does not request it twice.
    await io.reveal();
    expect(vi.mocked(gateway.searchOnlineCatalog).mock.calls.filter(([query]) => query.page === 1)).toHaveLength(1);

    await act(async () => second.resolve(fullPage({ ...vi.mocked(gateway.searchOnlineCatalog).mock.lastCall![0], page: 1 }, 100)));
    expect(screen.getAllByRole("button", { name: /^작품 [01]-\d+ 상세 보기$/ })).toHaveLength(96);
    expect(screen.queryByLabelText("다음 망가 불러오는 중")).not.toBeInTheDocument();
    expect(end).toHaveTextContent("96 / 100");

    await io.reveal();
    expect(await screen.findByRole("button", { name: "작품 2-3 상세 보기" })).toBeInTheDocument();
    expect(end).toHaveTextContent("100 / 100");
    expect(io.observing()).toBe(false);
    expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(3);
  });

  it("stops automatic loading after a failure, shows the toast and retries from 더 불러오기", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => fullPage(query, 100));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "작품 0-0 상세 보기" });
    vi.mocked(gateway.searchOnlineCatalog).mockRejectedValueOnce(new Error("카탈로그 DB를 읽지 못했습니다"));
    await io.reveal();
    expect(await screen.findByText("카탈로그 DB를 읽지 못했습니다")).toBeVisible();
    const retry = screen.getByRole("button", { name: "더 불러오기" });
    expect(screen.queryByLabelText("다음 망가 불러오는 중")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^작품 0-\d+ 상세 보기$/ })).toHaveLength(48);
    expect(document.querySelector(".online-catalog__list-end")).toHaveTextContent("48 / 100");
    expect(io.observing()).toBe(false);
    await io.reveal();
    expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(2);

    await userEvent.click(retry);
    expect(await screen.findByRole("button", { name: "작품 1-0 상세 보기" })).toBeInTheDocument();
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    expect(screen.queryByRole("button", { name: "더 불러오기" })).not.toBeInTheDocument();
    expect(io.observing()).toBe(true);
  });

  it("changes the view back to its first page without blanking the appended cards meanwhile", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => fullPage(query, 100));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "작품 0-0 상세 보기" });
    await io.reveal();
    await screen.findByRole("button", { name: "작품 1-47 상세 보기" });
    const grid = document.querySelector<HTMLDivElement>(".online-catalog__content")!;
    grid.scrollTop = 1200;
    const japanese = deferred<ReturnType<typeof fullPage>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(japanese.promise);
    await chooseMenu("언어", "일본어");
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ language: "japanese", page: 0 }));
    // The old 96 cards stay, inert and not dimmed, until the new first page is ready.
    expect(screen.getAllByRole("button", { name: /^작품 [01]-\d+ 상세 보기$/, hidden: true })).toHaveLength(96);
    expect(document.querySelector(".online-catalog__frame")).toHaveAttribute("inert");
    expect(document.querySelector(".manga-skeleton, .manga-card--skeleton")).toBeNull();
    expect(io.observing()).toBe(false);

    await act(async () => japanese.resolve(fullPage(vi.mocked(gateway.searchOnlineCatalog).mock.lastCall![0], 60, "일본어")));
    expect(screen.getAllByRole("button", { name: /^일본어 0-\d+ 상세 보기$/ })).toHaveLength(48);
    expect(screen.queryByRole("button", { name: "작품 1-0 상세 보기" })).not.toBeInTheDocument();
    expect(grid.scrollTop).toBe(0);
    expect(document.querySelector(".online-catalog__list-end")).toHaveTextContent("48 / 60");
    await io.reveal();
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ language: "japanese", page: 1 }));
  });

  it("opens the detail panel for an appended card and returns focus to it", async () => {
    const io = stubIntersectionObserver();
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => fullPage(query, 100));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "작품 0-0 상세 보기" });
    await io.reveal();
    const card = await screen.findByRole("button", { name: "작품 1-3 상세 보기" });
    await userEvent.click(card);
    const panel = await screen.findByRole("complementary", { name: "망가 상세" });
    expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenLastCalledWith({ provider: "kHentai", providerWorkId: "1-3" });
    expect(card).toHaveAttribute("aria-pressed", "true");
    const other = screen.getByRole("button", { name: "작품 1-4 상세 보기" });
    await userEvent.click(other);
    expect(screen.getByRole("complementary", { name: "망가 상세" })).toBe(panel);
    await waitFor(() => expect(other).toHaveAttribute("aria-pressed", "true"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    expect(other).toHaveFocus();
  });
});

it("double clicks straight into page one without opening detail or reading resume progress", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  const card = await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
  const flashes: Element[] = [];
  const observer = new MutationObserver(() => { const panel = document.querySelector('.ui-overlay-panel'); if (panel) flashes.push(panel); });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    await userEvent.dblClick(card);
    expect(await findReaderPosition("1 / 3")).toBeVisible();
    expect(gateway.getOnlineCatalogWorkDetail).not.toHaveBeenCalled();
    expect(gateway.getRemoteReadingProgress).not.toHaveBeenCalled();
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(flashes).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(card).toHaveFocus());
  } finally { observer.disconnect(); }
});

it("single clicks still open the detail and never resolve reader pages", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
  expect(await screen.findByRole("complementary", { name: "망가 상세" })).toBeVisible();
  expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();
});
