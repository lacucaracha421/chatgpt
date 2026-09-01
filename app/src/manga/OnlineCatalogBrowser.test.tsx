import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { LibraryProvider } from "../library/LibraryContext";
import type { CatalogWork, CatalogWorkDetail, LibraryGateway, ResolvedGallery } from "../library/types";
import { OnlineCatalogBrowser } from "./OnlineCatalogBrowser";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const work: CatalogWork = {
  id: 3,
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
  id: work.id,
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
  it("keeps only the newest search response", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    const search = await screen.findByRole("searchbox", { name: "온라인 만화 검색" });
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
    await act(async () => pending.resolve());
    expect(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" })).toBeEnabled();
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
      totalCount: query.scope === "bookmarked" ? 49 : 97,
      page: query.page,
      pageSize: 48,
    }));
    renderBrowser(gateway);
    await screen.findByRole("button", { name: "오래된 제독 상세 보기" });
    await userEvent.click(screen.getByRole("button", { name: "북마크만 보기" }));
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
    await userEvent.click(screen.getByRole("button", { name: "북마크만 보기" }));
    const pending = deferred<void>();
    vi.mocked(gateway.setOnlineCatalogBookmark).mockReturnValueOnce(pending.promise);
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 북마크 해제" }));
    await userEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    await act(async () => pending.resolve());

    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "all", page: 0 }),
    );
  });

  it("opens local details before resolving pages and routes tag searches", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledWith(3);
    expect(gateway.getRemoteReadingProgress).toHaveBeenCalledWith("kHentai", "3");
    expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole("button", { name: "character:teitoku 검색" }));
    expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "character:teitoku", page: 0 }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith(3);
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

  it("shows cover thumbnails and keeps bookmarks, filters, and paging isolated", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);

    const cover = await screen.findByRole("img", { name: "오래된 제독 표지" });
    const card = cover.closest("article")!;
    expect(cover).toHaveAttribute("src", work.thumbnailUrl);

    await userEvent.click(screen.getByRole("button", { name: "오래된 제독 북마크" }));
    expect(gateway.setOnlineCatalogBookmark).toHaveBeenCalledWith(3, true);
    expect(gateway.getOnlineCatalogWorkDetail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "북마크만 보기" }));
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

  it("searches by a Korean suggestion, changes sort, and opens a result", async () => {
    const gateway = createGateway(true);
    renderBrowser(gateway);
    const search = await screen.findByRole("searchbox", { name: "온라인 만화 검색" });

    await userEvent.type(search, "제독");
    await userEvent.click(await screen.findByRole("option", { name: /제독/ }));
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ text: "character:teitoku" }),
    ));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "정렬" }), "hotWeek");
    await waitFor(() => expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "hotWeek" }),
    ));
    await userEvent.click(await screen.findByRole("button", { name: "오래된 제독 상세 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
    expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith(work.id);
    expect(await screen.findByText("2 / 3")).toBeVisible();
    expect(screen.getByText("K-Hentai")).toBeVisible();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(gateway.saveRemoteReadingProgress).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kHentai", workId: "3", lastPage: 3, pageCount: 3 }),
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
      expect.objectContaining({ workId: "3", lastPage: 3 }),
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
  return {
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
        { ...work, id: 4, title: "함대 일지", thumbnailUrl: null },
        { ...work, id: 5, title: "제독의 하루", thumbnailUrl: null },
      ],
      totalCount: 97,
      page: query.page,
      pageSize: 48,
    })),
    suggestOnlineCatalog: vi.fn().mockResolvedValue([{ value: "character:teitoku", label: "제독", count: 2 }]),
    getOnlineCatalogWorkDetail: vi.fn().mockResolvedValue(detail),
    setOnlineCatalogBookmark: vi.fn().mockResolvedValue(undefined),
    resolveOnlineCatalogWork: vi.fn().mockResolvedValue(resolvedGallery()),
    getRemoteReadingProgress: vi.fn().mockResolvedValue({ provider: "kHentai", workId: "3", lastPage: 2, pageCount: 3, lastReadAt: "2026-08-22T12:00:00Z" }),
    saveRemoteReadingProgress: vi.fn().mockResolvedValue(undefined),
    updateOnlineCatalog: vi.fn().mockResolvedValue({
      added: 3,
      pages: 1,
      reason: "completed",
      lastSuccessAt: "2026-08-22T12:00:00Z",
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
}

function resolvedGallery(): ResolvedGallery {
  return {
    provider: "kHentai",
    workId: "3",
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
