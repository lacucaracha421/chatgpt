import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { LibraryProvider } from "../library/LibraryContext";
import type { CatalogGroupedSearchEvent, CatalogStatus, CatalogWork, CatalogWorkDetail, LibraryGateway, ResolvedGallery } from "../library/types";
import { CatalogVisibilitySettings } from "../settings/CatalogVisibilitySettings";
import { OnlineCatalogBrowser } from "./OnlineCatalogBrowser";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { displayDateTime } from "../shared/displayDate";
import { lazy, Suspense } from "react";
import { WindowControls } from "../layout/WindowControls";

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
    expect(container.querySelector(".online-catalog__content")).toHaveAttribute("inert");
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
    expect(container.querySelector(".online-catalog__content")).toHaveAttribute("inert");
    expect(container.querySelector(".manga-card--skeleton")).toBeNull();
    await act(async () => next.resolve({ works: [{ ...work, bookmarked: true }], totalCount: 280, page: 0, pageSize: 48 }));
    expect(await screen.findByRole("radio", { name: "북마크 280" })).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector(".online-catalog__content")).not.toHaveAttribute("inert");
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

  it("resets only the grid scroll on accepted page or sort changes", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => ({ works: [work], totalCount: 100, page: query.page, pageSize: 48 }));
    render(<LibraryProvider gateway={gateway}><WorkspaceChromeProvider scope="catalog">
      <aside><ChromeTarget name="navigation" /></aside>
      <OnlineCatalogBrowser onSwitchLocal={vi.fn()} />
    </WorkspaceChromeProvider></LibraryProvider>);
    await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    const grid = document.querySelector<HTMLDivElement>(".online-catalog__content")!;
    const sidebar = document.querySelector("aside")!;
    sidebar.scrollTop = 70;
    grid.scrollTop = 500;
    await userEvent.click(screen.getByRole("button", { name: "다음 결과" }));
    await waitFor(() => expect(grid.scrollTop).toBe(0));
    grid.scrollTop = 400;
    await userEvent.click(screen.getByRole("button", { name: "이전 결과" }));
    await waitFor(() => expect(grid.scrollTop).toBe(0));
    grid.scrollTop = 300;
    await chooseMenu("정렬", "조회순");
    await waitFor(() => expect(grid.scrollTop).toBe(0));
    expect(sidebar.scrollTop).toBe(70);
    grid.scrollTop = 200;
    await userEvent.click(screen.getByRole("button", { name: "오래된 제독 북마크" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "오래된 제독 북마크" })).toBeEnabled());
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
  it("keeps bookmark flags and pagination stable until the refreshed page arrives", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockResolvedValue({ works: [{ ...work, bookmarked: true }], totalCount: 60, page: 0, pageSize: 48 });
    renderBrowser(gateway);
    const bookmark = await screen.findByRole("button", { name: "오래된 제독 북마크 해제" });
    const footer = document.querySelector(".online-catalog__pagination")!;
    const before = footer.textContent;
    const pending = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog).mockReturnValueOnce(pending.promise);
    await userEvent.click(bookmark);
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(2));
    expect(bookmark).toBeDisabled();
    expect(bookmark).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("북마크된 판본 있음")).not.toBeInTheDocument();
    expect(footer.textContent).toBe(before);
    expect(screen.getByRole("button", { name: "다음 결과" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "언어" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await act(async () => pending.resolve({ works: [{ ...work, bookmarked: false }], totalCount: 60, page: 0, pageSize: 48 }));
    expect(await screen.findByRole("button", { name: "오래된 제독 북마크" })).toBeEnabled();
    expect(screen.queryByText("북마크된 판본 있음")).not.toBeInTheDocument();
    expect(footer.textContent).toBe(before);
  });
  it("keeps catalog controls in the toolbar and opens search only from its icon", async () => {
    const gateway = createGateway(true);
    const user = userEvent.setup();
    const DeferredCatalog = lazy(async () => ({ default: (await import("./OnlineCatalogBrowser")).OnlineCatalogBrowser }));
    render(<LibraryProvider gateway={gateway}><WorkspaceChromeProvider scope="catalog">
      <aside aria-label="카탈로그 인덱스"><ChromeTarget name="search" /><ChromeTarget name="navigation" /></aside>
      <div data-testid="shared-titlebar"><ChromeTarget name="header" /><WindowControls /></div>
      <Suspense fallback={null}><DeferredCatalog onSwitchLocal={vi.fn()} /></Suspense>
    </WorkspaceChromeProvider></LibraryProvider>);
    const index = screen.getByRole("complementary", { name: "카탈로그 인덱스" });
    expect(await within(screen.getByTestId("shared-titlebar")).findByRole("button", { name: "정렬" })).toBeVisible();
    expect(within(index).queryByRole("button", { name: "신규 작품 갱신" })).not.toBeInTheDocument();
    expect(within(index).queryByRole("button", { name: "중복 후보 검토" })).not.toBeInTheDocument();
    expect(within(index).queryByRole("checkbox", { name: "숨긴 결과 표시" })).not.toBeInTheDocument();
    expect(within(index).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("shared-titlebar")).getByRole("radio", { name: "카탈로그" })).toBeVisible();
    expect(within(screen.getByTestId("shared-titlebar")).getByRole("heading", { name: "망가" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "창 닫기" })).toHaveLength(1);
    expect(screen.getByTestId("shared-titlebar")).toContainElement(screen.getByRole("toolbar"));
    expect(within(screen.getByTestId("shared-titlebar")).getByRole("button", { name: "정렬" })).toBeVisible();
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
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await act(async () => gallery.resolve(resolvedGallery()));
    expect(screen.queryByText("1 / 3")).not.toBeInTheDocument();
  });

  it("returns to the previous bookmarked page after removing its last work", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.searchOnlineCatalog).mockImplementation(async (query) => ({
      works: query.scope === "bookmarked" ? [{ ...work, bookmarked: true }] : [work],
      totalCount: query.scope === "bookmarked" ? (vi.mocked(gateway.setOnlineCatalogBookmark).mock.calls.length ? 48 : 49) : 97,
      page: query.page,
      pageSize: 48,
    }));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    await userEvent.click(screen.getByRole("radio", { name: /^북마크/ }));
    await userEvent.click(await screen.findByRole("button", { name: "다음 결과" }));
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "bookmarked", page: 0, sort: "latest" }),
    ));
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
    expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(gateway.getRemoteReadingProgress).not.toHaveBeenCalled();
    expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();

    expect(await screen.findByRole("button", { name: "character:teitoku 검색" })).toHaveTextContent("제독");
    expect(screen.getByRole("button", { name: "character:untranslated_name 검색" })).toHaveTextContent("untranslated name");
    expect(screen.getByRole("button", { name: "language:korean 검색" })).toHaveTextContent("한국어");
    expect(screen.getByText("업로더")).not.toBeVisible();
    await userEvent.click(screen.getByText("추가 정보"));
    expect(screen.getByText("업로더")).toBeVisible();

    await userEvent.click(await screen.findByRole("button", { name: "character:teitoku 검색" }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "character:teitoku", page: 0 }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(await screen.findByText("1 / 3")).toBeVisible();
  });

  it("closes the viewer back to its detail instead of dropping two layers", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "읽기" }));
    await screen.findByRole("button", { name: "망가 뷰어 닫기" });
    await userEvent.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "읽기" })).toBeVisible();
    expect(screen.queryByText("1 / 3")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "읽기" })).not.toBeInTheDocument();
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

  it("shows cover thumbnails and keeps bookmarks, filters, and paging isolated", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    const cover = await screen.findByAltText("오래된 제독 표지");
    fireEvent.load(cover);
    expect(screen.getByRole("img", { name: "오래된 제독 표지" })).toBeVisible();
    const card = cover.closest("article")!;
    expect(cover).toHaveAttribute("src", work.thumbnailUrl);
    expect(within(card).getByText("오래된 제독")).not.toHaveAttribute("title");
    // Mobile-like tile: cover, title and artist only; views and series live in the detail dialog.
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

    await userEvent.click(screen.getByRole("button", { name: "다음 결과" }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 48 }),
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
    expect(await screen.findByText("1 / 3")).toBeVisible();
    expect(screen.getByText("K-Hentai")).toBeVisible();
    await userEvent.keyboard("{ArrowRight}");
    await screen.findByText("2 / 3");
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
    await screen.findByText("1 / 3");
    vi.useFakeTimers();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
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

/** Editions open from the work's detail dialog (the card no longer shows the count). */
async function openEditions(title: string, count: number) {
  await userEvent.click(await screen.findByRole("button", { name: `${title} 상세 보기` }));
  await userEvent.click(await screen.findByRole("button", { name: `판본 ${count}개 보기` }));
}

it("hides editions for a single-edition work and keeps its bookmark action", async () => {
  const gateway = createGateway(true);
  renderBrowser(gateway);
  expect(await screen.findByRole("button", { name: `${work.title} 상세 보기` })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: `${work.title} 상세 보기` }));
  await screen.findByRole("dialog");
  expect(screen.queryByRole("button", { name: /^판본 \d+개 보기$/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
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
  expect(screen.getByText("결과 수 계산 중…")).toBeVisible();
  expect(screen.getByRole("button", { name: "다음 결과" })).toBeDisabled();
  await chooseMenu("언어", "일본어");
  await act(async () => { events[1]({ type: "count", totalCount: 0 }); events[0]({ type: "count", totalCount: 999 }); old.reject(new Error("old failure")); });
  expect(screen.getByText("0개 결과")).toBeVisible();
  expect(screen.queryByText("999개 결과")).not.toBeInTheDocument();
  expect(screen.queryByText("old failure")).not.toBeInTheDocument();
});


it("loads editions only on request in bounded pages and persists manual and automatic selection", async () => {
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
  await openEditions(work.title, 104);
  expect(await screen.findByRole("button", { name: "판본 0 열기" })).toBeVisible();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith({ provider: "kHentai", groupId: "uuid", language: "korean", revealBlocked: false, page: 0, pageSize: 40 });
  await userEvent.click(screen.getByRole("button", { name: "판본 더 보기" }));
  expect(await screen.findByRole("button", { name: "판본 1 열기" })).toBeVisible();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 40 }));
  await userEvent.click(screen.getByRole("button", { name: "판본 더 보기" }));
  expect(await screen.findByRole("button", { name: "판본 2 열기" })).toBeVisible();
  expect(gateway.getCatalogGroupEditions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 40 }));
  expect(screen.queryByRole("button", { name: "판본 더 보기" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "판본 0 대표로 지정" }));
  expect(gateway.setCatalogGroupRepresentative).toHaveBeenLastCalledWith({ provider: "kHentai", groupId: "uuid", selectedProviderWorkId: "10" });
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await openEditions(work.title, 104);
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
  expect(screen.getByRole("button", { name: "다음 결과" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "이전 결과" })).toBeDisabled();
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
  await openEditions(work.title, 2);
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
