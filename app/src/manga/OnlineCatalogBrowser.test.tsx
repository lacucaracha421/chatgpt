import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { LibraryProvider } from "../library/LibraryContext";
import type { CatalogGroupedSearchEvent, CatalogStatus, CatalogWork, CatalogWorkDetail, LibraryGateway, ResolvedGallery } from "../library/types";
import { CatalogVisibilitySettings } from "../settings/CatalogVisibilitySettings";
import { OnlineCatalogBrowser } from "./OnlineCatalogBrowser";

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
  it("searches Korean by default and explicitly switches to Japanese from page zero", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "korean", page: 0 }),
    ));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "카탈로그 언어" }), "japanese");

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
    const language = screen.getByRole("combobox", { name: "카탈로그 언어" });
    await userEvent.selectOptions(language, "japanese");
    expect(await screen.findByRole("button", { name: "일본어 결과 상세 보기" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "신규 작품 갱신" }));

    await userEvent.selectOptions(language, "korean");
    expect(await screen.findByRole("button", { name: "한국어 결과 상세 보기" })).toBeVisible();
    await act(async () => update.resolve({
      language: "japanese",
      added: 1,
      pages: 1,
      reason: "completed",
      lastSuccessAt: "2026-09-05T02:00:00Z",
    }));

    await screen.findByText("1개 작품을 갱신했습니다");
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "korean", page: 0 }),
    );
    expect(screen.queryByRole("button", { name: "일본어 결과 상세 보기" })).not.toBeInTheDocument();
  });

  it("bounds a completed Japanese manual update to forty pages", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue(catalogStatusWithJapanese(true));
    renderBrowser(gateway);

    const language = await screen.findByRole("combobox", { name: "카탈로그 언어" });
    await userEvent.selectOptions(language, "japanese");
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "japanese" }),
    ));
    await userEvent.click(screen.getByRole("button", { name: "신규 작품 갱신" }));

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

    const reveal = await screen.findByRole("button", { name: "숨긴 결과 표시" });
    expect(reveal).toHaveAttribute("aria-pressed", "false");
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ revealBlocked: false }),
    );

    await userEvent.click(reveal);

    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ revealBlocked: true, page: 0 }),
    ));
    expect(reveal).toHaveAttribute("aria-pressed", "true");
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
    await userEvent.click(await screen.findByRole("checkbox", { name: "만화 숨기기" }));
    expect(gateway.setCatalogCategoryHidden).toHaveBeenCalledWith(2, true);
    settings.unmount();

    renderBrowser(gateway);

    expect(await screen.findByText("1개 결과")).toBeVisible();
    expect(gateway.searchOnlineCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest search response", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });
    const older = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    const newer = deferred<Awaited<ReturnType<LibraryGateway["searchOnlineCatalog"]>>>();
    vi.mocked(gateway.searchOnlineCatalog)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.submit(search.closest("form")!);
    fireEvent.change(search, { target: { value: "new" } });
    fireEvent.submit(search.closest("form")!);
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
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await act(async () => gallery.resolve(resolvedGallery()));
    expect(screen.queryByText("2 / 3")).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "카탈로그" }));
    await userEvent.click(await screen.findByRole("button", { name: "다음 결과" }));
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "bookmarked", page: 0 }),
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
    await userEvent.click(screen.getByRole("button", { name: "카탈로그" }));
    const pending = deferred<void>();
    vi.mocked(gateway.setOnlineCatalogBookmark).mockReturnValueOnce(pending.promise);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" }));
    await userEvent.click(screen.getByRole("button", { name: "북마크" }));
    await act(async () => pending.resolve());

    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "all", page: 0 }),
    );
  });

  it("opens local details before resolving pages and routes tag searches", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(gateway.getRemoteReadingProgress).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole("button", { name: "character:teitoku 검색" }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "character:teitoku", page: 0 }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(await screen.findByText("2 / 3")).toBeVisible();
  });

  it("closes the viewer back to its detail instead of dropping two layers", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    await screen.findByRole("button", { name: "망가 뷰어 닫기" });
    await userEvent.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "이어 읽기" })).toBeVisible();
    expect(screen.queryByText("2 / 3")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "이어 읽기" })).not.toBeInTheDocument();
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

    const search = screen.getByRole("combobox", { name: "온라인 만화 검색" });
    await userEvent.clear(search);
    await userEvent.type(search, "제독 AND");
    fireEvent.submit(search.closest("form")!);

    expect(await screen.findByText("검색식 7..7 위치: 검색 조건이 더 필요합니다")).toBeVisible();
    expect(screen.getByRole("button", { name: "오래된 제독 상세 보기" })).toBeVisible();
  });

  it("shows cover thumbnails and keeps bookmarks, filters, and paging isolated", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    const cover = await screen.findByRole("img", { name: "오래된 제독 표지" });
    const card = cover.closest("article")!;
    expect(cover).toHaveAttribute("src", work.thumbnailUrl);
    expect(within(card).getByText("오래된 제독")).toHaveAttribute("title", "오래된 제독");
    expect(within(card).getByText("artist · series")).toHaveAttribute("title", "artist · series");

    await userEvent.click(screen.getByRole("button", { name: "오래된 제독 북마크" }));
    expect(gateway.setOnlineCatalogBookmark).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" }, true);
    expect(gateway.getOnlineCatalogWorkDetail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "카탈로그" }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "bookmarked", page: 0 }),
    );

    await userEvent.click(screen.getByRole("button", { name: "다음 결과" }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 48 }),
    );

    fireEvent.error(cover);
    expect(within(card).getByText("24페이지")).toBeVisible();
  });

  it("imports a missing catalog from the selected VCK folder", async () => {
    const gateway = createGateway(false);
    vi.mocked(open).mockResolvedValue("C:\\VCK");
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "VCK 데이터 가져오기" }));

    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(gateway.importVckCatalog).toHaveBeenCalledWith("C:\\VCK");
  });

  it("keeps focus on the combobox while keyboard navigation selects a suggestion", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
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
    expect(search).toHaveFocus();
    expect(search).toHaveValue("character:teitoku");
    expect(search).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: /제독/ })).not.toBeInTheDocument();
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "character:teitoku", page: 0 }),
    );
  });

  it("searches by a Korean suggestion, changes sort, and opens a result", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    const search = await screen.findByRole("combobox", { name: "온라인 만화 검색" });

    await userEvent.type(search, "제독");
    await userEvent.click(await screen.findByRole("option", { name: /제독/ }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ text: "character:teitoku" }),
    ));
    await userEvent.click(screen.getByRole("button", { name: "정렬: 최신순" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "주간 인기" }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "hotWeek" }),
    ));
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith({ provider: "kHentai", providerWorkId: "3" });
    expect(await screen.findByText("2 / 3")).toBeVisible();
    expect(screen.getByText("K-Hentai")).toBeVisible();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(gateway.saveRemoteReadingProgress).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kHentai", providerWorkId: "3", lastPage: 3, pageCount: 3 }),
    ));
  });

  it("runs a manual catalog update and reports added works", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "신규 작품 갱신" }));

    expect(gateway.updateOnlineCatalog).toHaveBeenCalledOnce();
    expect(await screen.findByText("3개 작품을 갱신했습니다")).toBeInTheDocument();
  });

  it("shows the last catalog sync status next to the manual update command", async () => {
    const gateway = createGateway(true);
    vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue({
      installed: true,
      workCount: 1,
      updateEnabled: true,
      updateIntervalSeconds: 3600,
      lastAttemptAt: "2026-08-28T09:00:00Z",
      lastSuccessAt: "2026-08-28T09:00:00Z",
      lastAdded: 3,
      lastError: null,
      streams: [],
    });
    renderBrowser(gateway);

    expect(await screen.findByText(/마지막 갱신/)).toHaveTextContent("신규 3개");
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

    await userEvent.click(await screen.findByRole("button", { name: "신규 작품 갱신" }));

    expect(await screen.findByText("온라인 카탈로그 응답을 처리할 수 없습니다")).toBeInTheDocument();
  });

  it("shows resolved CDN images without routing them through the native media protocol", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));

    const page = await screen.findByRole("img", { name: "오래된 제독 2페이지" });
    expect(page).toHaveAttribute("src", "https://a.siam-cdn.net/2.webp?expires=1800000000");
    expect(page).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("flushes the pending reading position when the viewer closes", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    await screen.findByText("2 / 3");
    vi.useFakeTimers();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "망가 뷰어 닫기" }));

    expect(gateway.saveRemoteReadingProgress).toHaveBeenCalledWith(
      expect.objectContaining({ providerWorkId: "3", lastPage: 3 }),
    );
  });
});

function renderBrowser(gateway: LibraryGateway) {
  return render(
    <LibraryProvider gateway={gateway}>
      <OnlineCatalogBrowser onSwitchLocal={vi.fn()} />
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
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "카탈로그 언어" }), "japanese");
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
  await userEvent.click(screen.getByRole("button", { name: "104개 판본" }));
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
  await userEvent.click(screen.getByRole("button", { name: "104개 판본" }));
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
  await userEvent.click(screen.getByRole("button", { name: "숨긴 결과 표시" }));
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
  await userEvent.click(await screen.findByRole("button", { name: "2개 판본" }));
  await userEvent.click(await screen.findByRole("button", { name: "새 대표 판본 대표로 지정" }));
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  title = "새 대표 판본";
  await act(async () => save.resolve());
  expect(await screen.findByRole("button", { name: "새 대표 판본 상세 보기" })).toBeVisible();
});
