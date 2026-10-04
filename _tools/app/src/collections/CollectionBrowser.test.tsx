// Raster lifecycle is covered separately; jsdom has no canvas/WebGL implementation.
vi.mock("./physical/collectibleRuntime", async (importOriginal) => ({
  ...await importOriginal<typeof import("./physical/collectibleRuntime")>(),
  acquireCover: (_request: unknown, listener: (value: null) => void) => { listener(null); return () => undefined; },
  attachLiveBook: (_host: unknown, _request: unknown, onReady: (value: boolean) => void) => { onReady(false); return { tilt: () => undefined, refresh: () => undefined, dispose: () => undefined }; },
}));

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import type { LaunchBoxSpineBatchRequest, LaunchBoxSpineProgress, CollectionSummary, CollectionTrackingGateway, CollectionUpdateProvider, LibraryGateway, ReleaseBoardEntry, ReleaseInboxItem, ReleaseCalendarGateway } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";
import { createDefaultCollectionLibraryState } from "./collectionLibrary";
import { resetReleaseDataForTests } from "./releaseData";
import type { AvLinkApi } from "./AvLinkInbox";
import { resetMangaShelvesForTests } from "./MangaShelfList";
import { forgetMangaVolume, requestedMangaVolume } from "./work/mangaVolumeRequest";

afterEach(() => { cleanup(); localStorage.clear(); resetReleaseDataForTests(); });

const sample: CollectionSummary = {
  id: "c1",
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
  createdAt: "t",
  updatedAt: "t",
};

function renderBrowser(props: {
  collections: CollectionSummary[];
  typeFilter: CollectionSummary["type"];
  showcase: boolean;
  onViewChange?: () => void;
  onOpenWork?: (id: string, order: string[]) => void;
  onChanged?: () => Promise<void>;
  libraryState?: ReturnType<typeof createDefaultCollectionLibraryState>["game"];
  onLibraryStateChange?: (next: ReturnType<typeof createDefaultCollectionLibraryState>["game"]) => void;
  tracking?: CollectionTrackingGateway;
  releaseProvider?: CollectionUpdateProvider;
  releaseCalendar?: boolean;
  calendarApi?: ReleaseCalendarGateway;
  avLinkApi?: AvLinkApi;
  fetchLaunchBoxSpines?: LibraryGateway["fetchLaunchBoxSpines"];
  patch?: (gateway: LibraryGateway) => void;
}) {
  const gateway = createGateway();
  props.patch?.(gateway);
  if (props.fetchLaunchBoxSpines) gateway.fetchLaunchBoxSpines = props.fetchLaunchBoxSpines;
  if (props.tracking) gateway.collectionTracking = props.tracking;
  if (props.calendarApi) gateway.releaseCalendar = props.calendarApi;
  function Harness() {
    const [state, setState] = useState(props.libraryState ?? createDefaultCollectionLibraryState().game);
    return <LibraryProvider gateway={gateway}><CollectionBrowser releaseProvider={props.releaseProvider} releaseCalendar={props.releaseCalendar} avLinkApi={props.avLinkApi}
      collections={props.collections} typeFilter={props.typeFilter} showcase={props.showcase}
      onOpenWork={props.onOpenWork} onViewChange={props.onViewChange ?? (() => undefined)} onChanged={props.onChanged ?? (async () => undefined)}
      libraryState={state} onLibraryStateChange={(next) => { props.onLibraryStateChange?.(next); setState(next); }}
    /></LibraryProvider>;
  }
  render(
    <WorkspaceChromeProvider scope="collections-test">
      <div className="workspace-titlebar"><ChromeTarget name="header" /></div>
      <SearchProbe />
      <Harness />
    </WorkspaceChromeProvider>,
  );
  return gateway;
}

/** Stands in for the 찾기 palette: exposes the registered search label and applies a query. */
function SearchProbe() {
  const chrome = useWorkspaceChrome();
  return <><output data-testid="search-label">{chrome?.meta?.search?.label ?? ""}</output>
    <button type="button" onClick={() => chrome?.applySearch("nier")}>팔레트 검색 적용</button></>;
}

describe("CollectionBrowser", () => {
  it("opens a newly created series with its title and TV search intent", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const gateway = renderBrowser({ collections: [], typeFilter: "movie", showcase: false, onViewChange, onChanged });
    vi.mocked(gateway.createCollection).mockResolvedValue({ ...sample, id: "new-tv", name: "시리즈 제목", type: "movie" });
    await user.click(screen.getByRole("button", { name: "새 컬렉션" }));
    await user.click(await screen.findByRole("menuitem", { name: "직접 입력" }));
    await user.click(screen.getByRole("button", { name: "시리즈" }));
    await user.type(screen.getByRole("textbox", { name: "이름" }), "시리즈 제목");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith({ kind: "collection", collectionId: "new-tv", tmdbSearch: { query: "시리즈 제목", mediaType: "tv" } }));
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("shows the spine batch progress in steps that a narrow toolbar can shorten", async () => {
    const user = userEvent.setup();
    const fetchLaunchBoxSpines: LibraryGateway["fetchLaunchBoxSpines"] = vi.fn((request: LaunchBoxSpineBatchRequest, onProgress?: (progress: LaunchBoxSpineProgress) => void) => {
      if (request.action === "run") onProgress?.({ jobId: request.jobId, phase: "information", processed: 12, total: 178, outcome: null });
      return new Promise<never>(() => undefined);
    });
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, fetchLaunchBoxSpines });
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await user.click(await screen.findByRole("menuitem", { name: "책등 받기" }));
    const status = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".collection-toolbar__spine-status");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("정보 12/178");
    expect(status.querySelector(".collection-toolbar__spine-phase")).toHaveTextContent("정보");
    expect(status.querySelector(".collection-toolbar__spine-count")).toHaveTextContent("12/178");
    expect(status.querySelector(".collection-toolbar__spine-spinner")).toHaveAttribute("aria-hidden", "true");
    expect(within(status.closest(".collection-toolbar__spine-progress") as HTMLElement).getByRole("button", { name: "취소" })).toBeInTheDocument();
  });
  it("puts the types in the section bar with sort, rating and view at its right end", async () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: defaults.game });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "컬렉션 소식" })).not.toBeInTheDocument();
    const types = screen.getByRole("radiogroup", { name: "컬렉션 유형" });
    const bar = types.closest(".ui-section-bar") as HTMLElement;
    expect(bar).toHaveClass("ui-section-bar--inline");
    expect(bar.parentElement).toHaveClass("collection-browser__list-scroll");
    expect(bar.parentElement!.firstElementChild).toBe(bar);
    expect(within(types).getAllByRole("radio").map(radio => radio.getAttribute("aria-label"))).toEqual(["게임", "만화", "영화", "AV"]);
    expect(within(types).getByRole("radio", { name: "게임" })).toHaveAttribute("aria-checked", "true");
    expect(within(types).getByRole("radio", { name: "만화" })).toHaveAttribute("aria-checked", "false");
    // No Library/Showcase mode, no header tabs, no chips over the grid.
    expect(screen.queryByRole("button", { name: "라이브러리" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "보기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "컬렉션 유형" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "정렬과 필터" })).not.toBeInTheDocument();
    const header = screen.getByRole("toolbar", { name: "컬렉션 도구" });
    expect(within(bar).getByRole("button", { name: "정렬" })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "내 별점" })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "보기" })).toBeVisible();
    expect(within(header).queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "컬렉션 검색" })).toBeVisible();
    expect(screen.getByTestId("search-label")).toHaveTextContent("제목 검색");
    await userEvent.click(within(bar).getByRole("button", { name: "내 별점" }));
    const rating = screen.getByRole("slider", { name: "내 별점" });
    expect(rating).toHaveValue("0"); expect(rating).toHaveAttribute("aria-valuetext", "전체");
    expect(rating).toHaveAttribute("min", "0"); expect(rating).toHaveAttribute("max", "10");
    expect(screen.getByRole("button", { name: "미평가" })).toHaveAttribute("aria-pressed", "false");

  });

  it("shows the received-code count on the AV section and the ledger only in the AV library", async () => {
    const avLinkApi = {
      listInbox: vi.fn().mockResolvedValue([{ id: "inbox-1", requestId: "request-1", productCode: "SSIS-001", normalizedCode: "SSIS-001", sourceUrl: null,
        receivedAt: "2026-09-27T05:02:00Z", status: "fetching", attempts: 1, lastError: null, fetchedAt: null, collectionId: null, collectionName: null }]),
      pendingCount: vi.fn(), getCandidate: vi.fn(), retry: vi.fn(), fixCode: vi.fn(), dismiss: vi.fn(), apply: vi.fn(),
    } as unknown as AvLinkApi;
    renderBrowser({ collections: [], typeFilter: "game", showcase: false, avLinkApi });
    const av = await screen.findByRole("radio", { name: "AV, 받은 품번 1개" });
    expect(av.querySelector(".ui-segmented__label")).toHaveTextContent("AV 1");
    expect(screen.queryByRole("region", { name: "받은 품번" })).not.toBeInTheDocument();
    cleanup();

    renderBrowser({ collections: [], typeFilter: "av", showcase: false, avLinkApi });
    expect(await screen.findByRole("region", { name: "받은 품번" })).toBeInTheDocument();
  });

  it("shows a saved rating outside the presets as the selected option", async () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: { ...defaults.game, rating: 0 } });
    await userEvent.click(screen.getByRole("button", { name: "내 별점" }));
    const rating = screen.getByRole("slider", { name: "내 별점" });
    expect(rating).toHaveAttribute("aria-valuetext", "★ 0.0");
    expect(rating).toHaveValue("1");
  });

  it("updates only the active media browse state", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    const user = userEvent.setup();
    expect(onLibraryStateChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "팔레트 검색 적용" }));
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, query: "nier" });
  });

  it("sets sort and filters rating from the toolbar menus", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "정렬" }));
    await user.click(screen.getByRole("menuitemradio", { name: "제목 · 가나다순" }));
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, sort: "name", direction: "asc" });
    await user.click(screen.getByRole("button", { name: "내 별점" }));
    const rating = screen.getByRole("slider", { name: "내 별점" });
    expect(rating).toHaveValue("0");
    fireEvent.change(rating, { target: { value: "9" } });
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name", direction: "asc", rating: 4.5 }));
    expect(rating).toHaveValue("9");expect(rating).toHaveAttribute("aria-valuetext", "★ 4.5");
    expect(screen.queryByRole("button", { name: /Astral Chain/ })).not.toBeInTheDocument();
    // The keyboard steps one half-star at a time, like any range input.
    fireEvent.change(rating, { target: { value: "10" } });
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ rating: 5 }));
    expect(screen.getByRole("button", { name: /Astral Chain/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "미평가" }));
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({rating:"unrated"}));
    expect(screen.getByRole("button", { name: "미평가" })).toHaveAttribute("aria-pressed", "true");
    expect(rating).toHaveAttribute("aria-valuetext", "미평가");
    // A set filter offers 초기화 under the controls.
    await user.click(screen.getByRole("button", { name: "초기화" }));
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({rating:"all"}));
  });

  const trackingWith = (items: ReleaseInboxItem[]) => ({ listInbox: vi.fn().mockResolvedValue(items), acknowledge: vi.fn(), setOwnedCount: vi.fn(), listOwnership: vi.fn(), setOwnership: vi.fn() }) as unknown as CollectionTrackingGateway;
  const manga = { ...sample, id: "m1", type: "manga" as const };

  it("hides the 새 알림 row when nothing is unread", async () => {
    const tracking = trackingWith([]);
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking });
    await waitFor(() => expect(tracking.listInbox).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /새 알림/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MangaDex" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kakao" })).not.toBeInTheDocument();
  });

  it("puts one 신간 shortcut in the second row and opens the existing 한국 정발 view", async () => {
    const onViewChange = vi.fn();
    const tracking = trackingWith([]);
    renderBrowser({ collections: [{ ...manga, unreadReleaseCount: 2 }, { ...manga, id: "m2", unreadReleaseCount: 1 }], typeFilter: "manga", showcase: false, tracking, onViewChange });
    const shortcuts = screen.getByRole("group", { name: "컬렉션 바로가기" });
    const entry = within(shortcuts).getByRole("button", { name: "신간 보기, 새 알림 3개" });
    expect(entry).toHaveTextContent("신간3");
    expect(entry.querySelector(".is-new")).toHaveTextContent("3");
    expect(entry).not.toHaveAttribute("aria-current");
    expect(shortcuts.closest(".ui-section-bar__trailing")?.parentElement).toBe(screen.getByRole("radiogroup", { name: "컬렉션 유형" }).parentElement);
    await userEvent.setup().click(entry);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" });
  });

  it.each(["game", "movie"] as const)("opens the %s calendar from the unread shortcut", async typeFilter => {
    const onViewChange = vi.fn();
    const calendarApi = {
      calendar: vi.fn().mockResolvedValue({ rangeStart: "2026-09-26", rangeEnd: "2027-03-28", entries: [], sources: [] }),
      refresh: vi.fn(), add: vi.fn(), remove: vi.fn(), setMuted: vi.fn(), acknowledge: vi.fn(), runDue: vi.fn(),
      wishlist: vi.fn().mockResolvedValue([{ id: "igdb:1", unread: [{ id: "e1" }, { id: "e2" }] }]),
    } as unknown as ReleaseCalendarGateway;
    const tracking = trackingWith([]);
    renderBrowser({ collections: [], typeFilter, showcase: false, tracking, calendarApi, onViewChange });
    const entry = await screen.findByRole("button", { name: "발매 캘린더 보기, 관심 목록 새 알림 2개" });
    expect(entry.querySelector(".is-new")).toHaveTextContent("2");
    expect(entry).not.toHaveAttribute("aria-current");
    expect(tracking.listInbox).not.toHaveBeenCalled();
    await userEvent.setup().click(entry);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter, showcase: false, releaseCalendar: true });
    cleanup();
    renderBrowser({ collections: [], typeFilter, showcase: false, calendarApi, releaseCalendar: true });
    expect(await screen.findByRole("region", { name: "발매 캘린더" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "컬렉션 바로가기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
  });

  it.each(["game", "movie", "manga", "av"] as const)("shows only the %s shortcuts, in the right group with quiet zero counts and a Showcase toggle", async typeFilter => {
    const onViewChange = vi.fn();
    renderBrowser({ collections: [{ ...sample, type: typeFilter, showcase: true }], typeFilter, showcase: false, onViewChange });
    const shortcuts = screen.getByRole("group", { name: "컬렉션 바로가기" });
    expect(shortcuts.closest(".ui-section-bar__trailing")).not.toBeNull();
    expect(document.querySelector(".ui-section-bar__extra")).toBeNull();
    expect(shortcuts.nextElementSibling).toHaveClass("collection-shortcuts__divider");
    expect(shortcuts.parentElement?.lastElementChild).toHaveTextContent("보기");
    expect(within(shortcuts).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(typeFilter === "av" ? ["쇼케이스 1"] : ["쇼케이스 1", typeFilter === "manga" ? "신간 보기" : "발매 캘린더 보기"]);
    expect(shortcuts.querySelector(".is-new, .ui-segmented__thumb, [aria-checked], [aria-current]")).toBeNull();
    const showcase = within(shortcuts).getByRole("button", { name: "쇼케이스 1" });
    expect(showcase).toHaveAttribute("aria-pressed", "false");
    showcase.focus();
    await userEvent.keyboard("{Enter}");
    expect(onViewChange).toHaveBeenCalledWith({ kind: "collections", typeFilter, showcase: true });
    expect(document.querySelector(".collection-browser__showcase-row")).toBeNull();
  });

  it("marks Showcase pressed and toggles back to the library with the keyboard", async () => {
    const onViewChange = vi.fn();
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: "game", showcase: true, onViewChange });
    const button = screen.getByRole("button", { name: "쇼케이스 1" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false });
  });

  it("keeps the manual update check in the 신간 view and explains an empty list", async () => {
    const tracking = { ...trackingWith([]), runUpdates: vi.fn(), updateStatus: vi.fn().mockResolvedValue(undefined) } as unknown as CollectionTrackingGateway;
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking, releaseProvider: "kakao" });
    expect(await screen.findByRole("button", { name: "새로고침" })).toBeInTheDocument();
    expect(await screen.findByText("신간 알림을 켠 만화가 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "신간" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "컬렉션 바로가기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 컬렉션" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "정렬" })).not.toBeInTheDocument();
  });

  const board = (collectionId: string, owned: number | null, kakao: [number, string | null][], mangadex: number | null = null, watch = true): ReleaseBoardEntry => ({
    collectionId, releaseWatch: { enabled: watch, available: true }, ownedVolumes: owned == null ? [] : [{ editionIndex: 0, count: owned }],
    releaseSchedule: { kakao: { editionIndex: 0, checkedAt: null, volumes: kakao.map(([volumeNumber, date]) => ({ volumeNumber, date, status: null })) }, mangadex: mangadex == null ? null : { checkedAt: null, latestVolume: mangadex, volumes: [] } },
  });
  const event = (collectionId: string, id: string, volumeNumber: number, currentValue: string | null, provider: ReleaseInboxItem["provider"] = "kakao"): ReleaseInboxItem =>
    ({ collectionId, collectionName: collectionId, provider, event: { id, kind: "new_volume", volumeNumber, previousValue: null, currentValue, detectedAt: "2026-09-20T00:00:00Z" } });

  it("shows the year, my stars and the 신간 marker on manga tiles by priority", async () => {
    localStorage.setItem("lakomics.collections.view.manga.v1", JSON.stringify({ layout: "grid", perRow: 8, grouping: "device" }));
    const year = new Date().getFullYear();
    const past = `${year - 1}-12-31`, future = `${year + 1}-11-20`;
    const tracking = { ...trackingWith([event("new", "n1", 13, past), event("jp", "j1", 30, null, "mangadex")]), releaseBoard: vi.fn().mockResolvedValue([
      board("new", 12, [[12, past], [13, past]]),
      board("out", 11, [[12, past], [13, past], [14, future]]),
      board("ahead", 13, [[13, past], [14, future]]),
      board("owned", 14, [[13, past], [14, past]]),
      board("jp", 20, [[20, past]], 30),
    ]) } as unknown as CollectionTrackingGateway;
    renderBrowser({ collections: [
      { ...manga, id: "new", name: "알림 권", unreadReleaseCount: 1, myScore: 4.5 },
      { ...manga, id: "out", name: "나온 권", myScore: null },
      { ...manga, id: "ahead", name: "예약 권" },
      { ...manga, id: "owned", name: "다 산 권" },
      { ...manga, id: "jp", name: "일본 권", unreadReleaseCount: 1 },
    ], typeFilter: "manga", showcase: false, tracking });
    const fresh = await screen.findByText("신간 13권");
    expect(fresh).toHaveClass("collection-card__release--new");
    expect(fresh).toHaveTextContent(`신간 13권 · ${year - 1}.12.31`);
    expect(screen.getByRole("button", { name: /알림 권/ })).toHaveAttribute("aria-description", `신간 13권 · ${year - 1}.12.31`);
    expect(within(screen.getByRole("button", { name: /알림 권/ })).getByLabelText("내 별점 4.5점")).toBeInTheDocument();
    expect(screen.getByText("신간 12–13권")).toHaveClass("collection-card__release--out");
    expect(screen.getByText("14권 예약")).toHaveClass("collection-card__release--ahead");
    expect(screen.getByText("14권 예약")).toHaveTextContent(`14권 예약 · ${year + 1}.11.20`);
    expect(within(screen.getByRole("button", { name: /다 산 권/ })).queryByText(/신간|예약/)).not.toBeInTheDocument();
    expect(screen.getByText("신간 알림 1")).toHaveClass("collection-card__release--new");
  });

  it("lists 한국 정발 and 일본 in the 신간 view and switches between them", async () => {
    const year = new Date().getFullYear();
    const onViewChange = vi.fn();
    const tracking = { ...trackingWith([event("a", "a1", 3, `${year - 1}-09-16`), event("b", "b1", 9, null, "mangadex")]), releaseBoard: vi.fn().mockResolvedValue([
      board("a", 2, [[1, null], [2, null], [3, `${year - 1}-09-16`], [4, `${year + 1}-10-10`]], 6),
      board("b", 3, [[1, null], [2, null], [3, null]], 9),
      board("c", 0, [[1, null]], null, false),
    ]) } as unknown as CollectionTrackingGateway;
    const collections = [{ ...manga, id: "a", name: "가 작품" }, { ...manga, id: "b", name: "나 작품" }, { ...manga, id: "c", name: "다 작품" }];
    renderBrowser({ collections, typeFilter: "manga", showcase: false, tracking, onViewChange, releaseProvider: "kakao" });
    const segments = screen.getByRole("radiogroup", { name: "신간 지역" });
    expect(within(segments).getByRole("radio", { name: /한국 정발/ })).toHaveAttribute("aria-checked", "true");
    const group = await screen.findByRole("row", { name: "가 작품" });
    expect(within(group).getByText("1–2 권")).toBeInTheDocument();
    expect(within(group).getByText("3권").parentElement).toHaveAttribute("data-chip-kind", "new");
    expect(within(group).getByText(`4권 ${year + 1}.10.10`).parentElement).toHaveAttribute("data-chip-kind", "upcoming");
    expect(within(group).getByLabelText("새 알림 1개")).toHaveTextContent("NEW");
    await userEvent.setup().click(within(group).getByText("3권"));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "a" });
    expect(tracking.acknowledge).not.toHaveBeenCalled();
    // A watched work with every Korean volume owned is not listed; an unwatched work never is.
    expect(screen.queryByRole("row", { name: "나 작품" })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: "다 작품" })).not.toBeInTheDocument();
    await userEvent.setup().click(within(segments).getByRole("radio", { name: /일본/ }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "mangadex" });
    cleanup();
    renderBrowser({ collections, typeFilter: "manga", showcase: false, tracking, releaseProvider: "mangadex" });
    const japan = await screen.findByRole("row", { name: "나 작품" });
    expect(within(japan).getByText("9권")).toBeInTheDocument();
    expect(within(japan).getByText("한국보다 6권 앞섬")).toBeInTheDocument();
    expect(within(japan).getByLabelText("나 작품 일본 권")).toHaveTextContent("4권9권+4");
    expect(screen.getByRole("row", { name: "가 작품" })).toHaveTextContent("한국보다 2권 앞섬");
    // Reopening with the same Collection list reuses the shared data instead of reading again.
    expect(tracking.releaseBoard).toHaveBeenCalledTimes(1);
  });

  it("acknowledges one work's exact events and keeps the release information", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const year = new Date().getFullYear();
    const tracking = { ...trackingWith([event("a", "a1", 3, `${year - 1}-09-16`), event("a", "a2", 4, null, "mangadex"), event("z", "z1", 1, null)]), releaseBoard: vi.fn().mockResolvedValue([board("a", 2, [[3, `${year - 1}-09-16`]], 4)]) } as unknown as CollectionTrackingGateway;
    renderBrowser({ collections: [{ ...manga, id: "a", name: "가 작품" }], typeFilter: "manga", showcase: false, tracking, onChanged, releaseProvider: "kakao" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "가 작품 확인" }));
    expect(tracking.acknowledge).toHaveBeenCalledWith("a", ["a1", "a2"]);
    await waitFor(() => expect(screen.queryByLabelText("새 알림 2개")).not.toBeInTheDocument());
    expect(screen.getByRole("row", { name: "가 작품" })).toHaveTextContent("3권");
    expect(onChanged).toHaveBeenCalled();
    // Events of works the lists do not show stay under 새 알림.
    expect(screen.getByRole("heading", { name: "그 밖의 새 알림" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "z" })).toHaveTextContent("1권 새로 나옴");
  });

  it("opens a Showcase work in exhibition order, excluding the regular grid", async () => {
    const onOpenWork = vi.fn();
    const first = { ...sample, showcase: true, showcaseOrder: 1 };
    const second = { ...sample, id: "second", name: "두 번째", showcase: true, showcaseOrder: 2 };
    renderBrowser({ collections: [first, second, { ...sample, id: "regular", name: "일반 게임" }], typeFilter: "game", showcase: true, onOpenWork });
    const user = userEvent.setup();
    const shelf = screen.getByLabelText("3행 3열 전시");
    await user.dblClick(within(shelf).getByRole("button", { name: /Astral Chain/ }));
    expect(onOpenWork).toHaveBeenCalledWith("c1", ["c1", "second"]);
  });

  it("keeps both bar rows mounted when switching types and updates live work counts", async () => {
    const gateway = createGateway();
    const defaults = createDefaultCollectionLibraryState();
    function LiveBrowser({ works }: { works: CollectionSummary[] }) {
      const [typeFilter, setType] = useState<CollectionSummary["type"]>("game");
      return <LibraryProvider gateway={gateway}><CollectionBrowser collections={works} typeFilter={typeFilter} showcase={false}
        libraryState={defaults[typeFilter]} onLibraryStateChange={() => undefined} onChanged={async () => undefined}
        onViewChange={next => { if (next.kind === "collections") setType(next.typeFilter); }} /></LibraryProvider>;
    }
    const game = { ...sample, showcase: true };
    const manga = { ...sample, id: "manga", type: "manga" as const, showcase: true, unreadReleaseCount: 3 };
    const { container, rerender } = render(<LiveBrowser works={[game, manga]} />);
    const bar = container.querySelector(".ui-section-bar");
    const extra = bar?.querySelector(".ui-section-bar__extra");
    expect(screen.getByRole("button", { name: "쇼케이스 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "만화" }));
    expect(container.querySelector(".ui-section-bar")).toBe(bar);
    expect(bar?.querySelector(".ui-section-bar__extra")).toBe(extra);
    expect(screen.getByRole("button", { name: "신간 보기, 새 알림 3개" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /발매 캘린더 보기/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "만화 작품 목록" })).toHaveTextContent("Astral Chain");
    rerender(<LiveBrowser works={[game, { ...manga, unreadReleaseCount: 0 }, { ...manga, id: "manga2", unreadReleaseCount: 0 }]} />);
    expect(screen.getByRole("button", { name: "쇼케이스 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "신간 보기" }).querySelector(".collection-shortcuts__count")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "AV" }));
    expect(container.querySelector(".ui-section-bar")).toBe(bar);
    expect(screen.getByRole("button", { name: "쇼케이스 0" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "컬렉션 바로가기" })).getAllByRole("button")).toHaveLength(1);
  });

  it("replaces the folded Showcase row with a shortcut to the whole Showcase", async () => {
    const onViewChange = vi.fn();
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [{ ...sample, showcase: true }, { ...sample, id: "c2", name: "Celeste" }], typeFilter: "game", showcase: false, onViewChange, onLibraryStateChange, libraryState: { ...createDefaultCollectionLibraryState().game, showcaseOpen: true } });
    expect(screen.queryByRole("region", { name: "쇼케이스" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "전체 보기" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "쇼케이스 1" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: true });
    expect(onLibraryStateChange).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /전체/ })).toHaveTextContent("전체2");
  });

  it("keeps the Showcase count independent of library search and rating", async () => {
    renderBrowser({ collections: [{ ...sample, showcase: true }, { ...sample, id: "other", name: "다른 작품", showcase: true, myScore: 4.5 }], typeFilter: "game", showcase: false });
    await userEvent.click(screen.getByRole("button", { name: "내 별점" }));
    fireEvent.change(screen.getByRole("slider", { name: "내 별점" }), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "쇼케이스 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Astral Chain/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /다른 작품/ })).not.toBeInTheDocument();
  });

  it("searches titles from the list toolbar", async () => {
    renderBrowser({ collections: [sample, { ...sample, id: "other", name: "다른 작품" }], typeFilter: "game", showcase: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "컬렉션 검색" }));
    await user.type(screen.getByRole("searchbox", { name: "제목 검색" }), "Astral");
    expect(screen.getByRole("button", { name: /Astral Chain/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /다른 작품/ })).not.toBeInTheDocument();
  });

  it("keeps case and image nodes mounted across N and layout changes, without a duplicate showcase shelf", async () => {
    const works = Array.from({ length: 14 }, (_, index) => ({ ...sample, id: `count-${index}`, name: `작품 ${index}`, coverAssetId: `cover-${index}`, showcase: index === 0 }));
    renderBrowser({ collections: works, typeFilter: "game", showcase: false, libraryState: { ...createDefaultCollectionLibraryState().game, showcaseOpen: true } });
    const user = userEvent.setup();
    const list = screen.getByRole("group", { name: "게임 작품 목록" });
    expect(screen.queryByRole("group", { name: "게임 쇼케이스" })).not.toBeInTheDocument();
    const card = list.querySelector('[data-collection-id="count-0"]');
    const image = card?.querySelector(".cs-front img");
    await user.click(screen.getByRole("button", { name: "보기" }));
    fireEvent.change(screen.getByRole("slider", { name: "한 줄에" }), { target: { value: "6" } });
    expect(list).toHaveAttribute("data-per-row", "6");
    const cells = [...list.querySelectorAll<HTMLElement>(".collection-list__cell")];
    const counts = new Map<string, number>();
    cells.forEach(cell => counts.set(cell.style.gridRow, (counts.get(cell.style.gridRow) ?? 0) + 1));
    expect([...counts.values()]).toEqual([6, 6, 2]);
    expect(list.querySelector('[data-collection-id="count-0"]')).toBe(card);
    expect(card?.querySelector(".cs-front img")).toBe(image);
    await user.click(screen.getByRole("radio", { name: "격자" }));
    expect(list).toHaveClass("collection-list--grid");
    expect(list.querySelector('[data-collection-id="count-0"]')).toBe(card);
    expect(card?.querySelector(".cs-front img")).toBe(image);
    expect([...list.querySelectorAll<HTMLElement>(".collection-list__cell")].filter(cell => cell.style.gridRow === "1")).toHaveLength(6);
  });

  it("picks with click and arrows, then opens with Enter or double-click", async () => {
    const onOpenWork = vi.fn();
    const works = Array.from({ length: 10 }, (_, index) => ({ ...sample, id: `key-${index}`, name: `작품 ${index}` }));
    renderBrowser({ collections: works, typeFilter: "game", showcase: false, onOpenWork });
    const user = userEvent.setup();
    const first = screen.getByRole("button", { name: /작품 0/ });
    await user.click(first);
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(onOpenWork).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    const eighth = screen.getByRole("button", { name: /작품 8/ });
    expect(eighth).toHaveFocus(); expect(eighth).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onOpenWork).toHaveBeenLastCalledWith("key-8", works.map(work => work.id));
    await user.dblClick(first);
    expect(onOpenWork).toHaveBeenLastCalledWith("key-0", works.map(work => work.id));
  });

  it("puts shelf cases down on planks, gaps and list margins, preserves controls and opens on double-click", async () => {
    const onOpenWork = vi.fn();
    renderBrowser({ collections: [sample, { ...sample, id: "c2", name: "Second" }], typeFilter: "game", showcase: false, onOpenWork });
    const first = screen.getByRole("button", { name: /Astral Chain/ });
    const second = screen.getByRole("button", { name: /Second/ });
    const list = document.querySelector(".collection-browser__list-scroll")!;
    for (const empty of [list, list.querySelector(".collection-list__plank")!, list.querySelector(".collection-list__cell")!]) {
      fireEvent.click(first); expect(first).toHaveAttribute("aria-selected", "true");
      fireEvent.click(empty); expect(first).toHaveAttribute("aria-selected", "false");
      expect(screen.getByRole("button", { name: /Astral Chain/ })).toBe(first);
    }
    fireEvent.click(first);
    fireEvent.scroll(list); expect(first).toHaveAttribute("aria-selected", "true");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "정렬" }));
    expect(first).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "보기" }));
    expect(first).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    fireEvent.click(second); expect(first).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveAttribute("aria-selected", "true"); expect(onOpenWork).not.toHaveBeenCalled();
    fireEvent.click(second); expect(onOpenWork).not.toHaveBeenCalled(); // a second click keeps it picked
    fireEvent.doubleClick(second); expect(onOpenWork).toHaveBeenCalledExactlyOnceWith("c2", ["c1", "c2"]);
    onOpenWork.mockClear();
    await user.dblClick(first);
    expect(onOpenWork).toHaveBeenCalledExactlyOnceWith("c1", ["c1", "c2"]);
  });

  it("renders a grid of collection cards", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false });
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.getByText("PlatinumGames")).toHaveClass("collection-card__credit");
    expect(document.querySelector(".collection-card__type")).not.toBeInTheDocument();
    expect(document.querySelector(".collection-card__count")).not.toBeInTheDocument();
  });

  it("shows unread release counts only when a collection has changes", () => {
    renderBrowser({
      collections: [
        { ...sample, id: "changed", name: "던전밥", unreadReleaseCount: 3 },
        { ...sample, id: "quiet", name: "요츠바랑!", unreadReleaseCount: 0 },
      ],
      typeFilter: "game",
      showcase: false,
    });

    // Nothing on the cover: the caption line under the title replaces the release date.
    expect(screen.getByText("신간 알림 3")).toHaveClass("collection-card__release--new");
    expect(document.querySelector(".collection-card__release-badge")).not.toBeInTheDocument();
    expect(screen.getAllByText(/신간/)).toHaveLength(1);
  });

  it("uses the source thumbnail when a collection has no cover asset", () => {
    renderBrowser({
      collections: [{ ...sample, sourcePath: "games/astral-chain" }],
      typeFilter: "game",
      showcase: false,
    });

    // The source is assigned while the complete shelf item waits to decode.
    expect(screen.getByAltText("Astral Chain")).toHaveAttribute(
      "src",
      "http://lakomics.localhost/collection-source-thumbnail/c1",
    );
  });

  it("prefers the media-vault cover asset over the source preview", () => {
    renderBrowser({
      collections: [{ ...sample, coverAssetId: "asset-1", sourcePath: "games/astral-chain" }],
      typeFilter: "game",
      showcase: false,
    });

    expect(screen.getByAltText("Astral Chain")).toHaveAttribute(
      "src",
      "http://lakomics.localhost/thumbnail/asset-1",
    );
  });

  it("shows empty state when no collections", () => {
    renderBrowser({ collections: [], typeFilter: "game", showcase: false });
    expect(screen.getByText("컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("filters by type when type filter set", async () => {
    const onViewChange = vi.fn();
    const manga = { ...sample, id: "manga", name: "던전밥", type: "manga" as const };
    renderBrowser({ collections: [sample, manga], typeFilter: "game", showcase: false, onViewChange });
    const types = within(screen.getByRole("radiogroup", { name: "컬렉션 유형" }));
    expect(types.queryByRole("radio", { name: "전체" })).not.toBeInTheDocument();
    expect(types.getByRole("radio", { name: "게임" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.queryByText("던전밥")).not.toBeInTheDocument();
    await userEvent.setup().click(types.getByRole("radio", { name: "만화" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false });
  });

  it("shows only showcase collections when showcase on", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: true });
    expect(screen.getByText("쇼케이스에 컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("leaves the whole Showcase through the header back button or the current type section", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: "game", showcase: true, onViewChange });
    // A drill-down, not a mode: the type section stays current and the library controls step aside.
    expect(screen.getByRole("radio", { name: "게임" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("combobox", { name: "정렬" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "컬렉션으로 돌아가기" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false });
    onViewChange.mockClear();
    await user.click(screen.getByRole("radio", { name: "게임" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false });
    await user.click(screen.getByRole("radio", { name: "만화" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false });
  });

  it("shows showcase collections when showcase on and a collection is showcased", () => {
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: "game", showcase: true });
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "게임 쇼케이스" })).toHaveAttribute("aria-description", "게임 쇼케이스");
  });

  it("labels the ordinary library with the visible work count", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false });

    expect(screen.getByRole("heading", { name: "게임" })).toHaveAttribute("aria-description", "게임 컬렉션");
    expect(screen.getByLabelText("작품 1개")).toHaveTextContent("1");
  });

  it("opens the work screen when a game card is double-clicked", async () => {
    const onViewChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onViewChange });
    await userEvent.dblClick(screen.getByText("Astral Chain"));
    expect(onViewChange).toHaveBeenCalledWith({ kind: "collection", collectionId: "c1" });
  });

  it("offers MangaDex for manga in the new collection menu", async () => {
    const user = userEvent.setup();
    const gateway = renderBrowser({ collections: [], typeFilter: "manga", showcase: false });
    await user.click(screen.getByRole("button", { name: "새 컬렉션" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["MangaDex에서 만화 추가", "직접 입력"]);
    await user.click(screen.getByRole("menuitem", { name: "직접 입력" }));
    expect(await screen.findByRole("heading", { name: "새 컬렉션" })).toBeInTheDocument();
    expect(gateway.createCollection).not.toHaveBeenCalled();
  });

  it("does not offer MangaDex for game", async () => {
    const user = userEvent.setup();
    renderBrowser({ collections: [], typeFilter: "game", showcase: false });
    await user.click(screen.getByRole("button", { name: "새 컬렉션" }));
    expect(screen.queryByRole("menuitem", { name: "MangaDex에서 만화 추가" })).not.toBeInTheDocument();
  });

  it("offers IGDB before direct input for games", async () => {
    const user = userEvent.setup();
    renderBrowser({ collections: [], typeFilter: "game", showcase: false });
    await user.click(screen.getByRole("button", { name: "새 컬렉션" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["IGDB에서 게임 추가", "직접 입력"]);
  });

  it("offers TMDB before direct input for movies", async () => {
    const user = userEvent.setup();
    renderBrowser({ collections: [], typeFilter: "movie", showcase: false });
    await user.click(screen.getByRole("button", { name: "새 컬렉션" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["TMDB에서 영화 추가", "직접 입력"]);
    await user.click(screen.getByRole("menuitem", { name: "직접 입력" }));
    expect(await screen.findByRole("heading", { name: "새 컬렉션" })).toBeInTheDocument();
  });

  it("opens the created movie after a successful TMDB import", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const movie = { ...sample, id: "movie-1", name: "기생충", type: "movie" as const };
    const gateway = renderBrowser({ collections: [], typeFilter: "movie", showcase: false, onViewChange, onChanged });
    vi.mocked(gateway.searchTmdbMovies).mockResolvedValue([{ movieId: 10494, title: "기생충", originalTitle: "Parasite", releaseDate: "2019-05-30", posterPath: "/poster.jpg" }]);
    vi.mocked(gateway.previewTmdbMovie).mockResolvedValue({ movieId: 10494, proposedTitle: "기생충", originalTitle: "Parasite", releaseDate: "2019-05-30", runtimeMinutes: 132, director: "봉준호", productionCompany: null, genres: "드라마", overview: "이야기", externalScore: 87, posters: [{ filePath: "/poster.jpg", width: 500, height: 750 }], backdrops: [] });
    vi.mocked(gateway.applyTmdbMovie).mockResolvedValue(movie);

    await user.click(screen.getByRole("button", { name: "TMDB에서 영화 추가" }));
    await user.type(screen.getByRole("searchbox", { name: "영화 검색" }), "기생충");
    await user.click(screen.getByRole("button", { name: "검색" }));
    await user.click(await screen.findByRole("button", { name: /기생충/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("radio", { name: /poster\.jpg/ }));
    await user.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onViewChange).toHaveBeenCalledWith({ kind: "collection", collectionId: "movie-1" });
  });

  it("opens IGDB from the empty game state and routes after apply", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const gateway = renderBrowser({ collections: [], typeFilter: "game", showcase: false, onViewChange, onChanged });
    vi.mocked(gateway.searchIgdbGames).mockResolvedValue([{ ...({
      gameId: 17, title: "Astral Chain", developer: "PlatinumGames", releaseDate: "2019-08-30", cover: null,
    }) }]);
    vi.mocked(gateway.previewIgdbGame).mockResolvedValue({
      gameId: 17, proposedTitle: "Astral Chain", developer: "PlatinumGames", publisher: null, releaseDate: "2019-08-30",
      platforms: [], genres: [], overview: null, covers: [], artworks: [], screenshots: [],
    });
    vi.mocked(gateway.applyIgdbGame).mockResolvedValue(sample);
    await user.click(screen.getByRole("button", { name: "IGDB에서 게임 추가" }));
    await user.type(screen.getByRole("searchbox", { name: "게임 검색" }), "astral");
    await user.click(screen.getByRole("button", { name: "검색" }));
    await user.click(await screen.findByRole("button", { name: /Astral Chain/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "hero 없이 가져오기" }));
    await user.click(screen.getByRole("button", { name: "가져오기" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onViewChange).toHaveBeenCalledWith({ kind: "collection", collectionId: "c1" });
  });

  it("routes IGDB credential setup through Settings and closes import", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const gateway = renderBrowser({ collections: [], typeFilter: "game", showcase: false, onViewChange });
    vi.mocked(gateway.searchIgdbGames).mockRejectedValue({ code: "igdb_credential_not_configured", message: "secret" });
    await user.click(screen.getByRole("button", { name: "IGDB에서 게임 추가" }));
    await user.type(screen.getByRole("searchbox", { name: "게임 검색" }), "astral");
    await user.click(screen.getByRole("button", { name: "검색" }));
    await user.click(await screen.findByRole("button", { name: "IGDB 설정 열기" }));
    expect(onViewChange).toHaveBeenCalledWith({ kind: "settings", section: "connection" });
    expect(screen.queryByRole("heading", { name: "IGDB에서 게임 추가" })).not.toBeInTheDocument();
  });

  it("prefers stored WorkArtwork over other card covers", () => {
    renderBrowser({
      collections: [{ ...sample, selectedWorkArtworkId: "artwork-1", coverAssetId: "asset-1", sourcePath: "games/astral-chain" }],
      typeFilter: "game",
      showcase: false,
    });

    expect(screen.getByAltText("Astral Chain")).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork-thumbnail/artwork-1",
    );
  });
});

describe("CollectionBrowser manga shelf", () => {
  afterEach(() => resetMangaShelvesForTests());
  const manga = (id: string, name: string, extra: Partial<CollectionSummary> = {}): CollectionSummary => ({ ...sample, id, name, type: "manga", ...extra });
  const volume = (id: string, volumeNumber: number, editionIndex = 0) => ({ id, volumeNumber, editionIndex, displayLabel: String(volumeNumber), coverArtworkId: `art-${id}`, localReleaseDate: null, isbn13: null, releaseStatus: "released" as const });
  const tracking = () => ({ listInbox: vi.fn().mockResolvedValue([]), acknowledge: vi.fn(), setOwnedCount: vi.fn(), listOwnership: vi.fn(), setOwnership: vi.fn(),
    releaseBoard: vi.fn().mockResolvedValue([{ collectionId: "m1", releaseWatch: { enabled: false, available: false }, ownedVolumes: [{ editionIndex: 0, count: 1 }], releaseSchedule: { kakao: null, mangadex: null } }]) }) as unknown as CollectionTrackingGateway;

  it("defaults manga to one paper book per work on the shared shelf and Showcase plank", async () => {
    const onViewChange = vi.fn();
    const gateway = renderBrowser({ collections: [manga("m1", "다이의 대모험", { selectedWorkArtworkId: "cover-m1", showcase: true }), manga("m2", "빈 작품")], typeFilter: "manga", showcase: false, onViewChange });
    const list = screen.getByRole("group", { name: "만화 작품 목록" });
    expect(list).toHaveClass("collection-list--shelf");
    expect(list.querySelectorAll(".collection-light-case--book")).toHaveLength(2);
    expect(list.querySelector(".manga-shelf-row")).toBeNull();
    expect(list.querySelector(".collection-list__group")).toBeNull();
    expect(list.querySelectorAll(".collection-list__plank")).toHaveLength(1);
    expect(list.querySelector(".cs-front img")).toHaveAttribute("src", "http://lakomics.localhost/work-artwork-thumbnail/cover-m1");
    expect(list.querySelector('.cs-spine .manga-jspine-title')).toHaveTextContent("다이의 대모험");
    expect(gateway.listCollectionVolumes).not.toHaveBeenCalled();
    const first = within(list).getByRole("button", { name: /다이의 대모험/ });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first.querySelector(".collection-light-case")).toHaveAttribute("data-front");
    expect(onViewChange).not.toHaveBeenCalled();
    fireEvent.doubleClick(first);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "m1" });
    fireEvent.keyDown(within(list).getByRole("button", { name: /빈 작품/ }), { key: "Enter" });
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "m2" });
    expect(screen.getByRole("button", { name: "쇼케이스 1" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "쇼케이스" })).not.toBeInTheDocument();
  });

  it("ignores stored bookcase for games and only offers grid and shelf", async () => {
    localStorage.setItem("lakomics.collections.view.game.v1", JSON.stringify({ layout: "bookcase", perRow: 7, grouping: "device" }));
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false });
    expect(screen.getByRole("group", { name: "게임 작품 목록" })).toHaveClass("collection-list--shelf");
    await userEvent.setup().click(screen.getByRole("button", { name: "보기" }));
    expect(await screen.findByRole("radio", { name: "선반" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "책장" })).toBeNull();
  });

  it("honours stored 책장 and keeps volume picking and opening on each work row", async () => {
    localStorage.setItem("lakomics.collections.view.manga.v1", JSON.stringify({ layout: "bookcase", perRow: 8, grouping: "device" }));
    const onViewChange = vi.fn();
    const gateway = renderBrowser({ collections: [manga("m1", "다이의 대모험"), manga("m2", "빈 작품")], typeFilter: "manga", showcase: false, onViewChange, tracking: tracking(), patch: gateway => {
      vi.mocked(gateway.listCollectionVolumes).mockImplementation(async id => id === "m1" ? [volume("v2", 2), volume("v1", 1), volume("e1", 1, 1)] : []);
      gateway.listCollectionCoverFocus = vi.fn().mockResolvedValue([{ volumeId: "v1", coverArtworkId: "art-v1", focusX: .2, method: "head" }]);
      gateway.startCollectionCoverFocus = vi.fn();
    } });
    const list = screen.getByRole("group", { name: "만화 작품 목록" });
    const row = await within(list).findByRole("group", { name: "다이의 대모험 책장" });
    // The 기본판 in volume order; the owned count marks volume 2 unowned.
    const spines = within(row).getAllByRole("button");
    expect(spines.map(spine => spine.getAttribute("aria-label"))).toEqual(["1권 보기", "2권 보기"]);
    expect(spines[1]).toHaveClass("manga-spine--missing");
    expect(spines[0].querySelector("img")).toHaveAttribute("src", "http://lakomics.localhost/work-artwork-thumbnail/art-v1");
    expect(within(list).getByLabelText("보유 1권")).toHaveTextContent("1권");
    // The detector runs only on the work screen; the list reads the stored focus.
    expect(gateway.startCollectionCoverFocus).not.toHaveBeenCalled();
    fireEvent.click(spines[1]);
    expect(spines[1]).toHaveAttribute("aria-pressed", "true");
    expect(within(spines[1]).getByText("2", { selector: ".manga-picked-number" })).toBeInTheDocument();
    expect(spines[1]).not.toHaveTextContent("미보유");
    expect(onViewChange).not.toHaveBeenCalled();
    fireEvent.click(row.querySelector(".manga-bookcase-board")!);
    expect(spines[1]).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(spines[0]); expect(spines[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(spines[1]); expect(spines[0]).toHaveAttribute("aria-pressed", "false");
    fireEvent.doubleClick(spines[1]);
    expect(onViewChange).toHaveBeenCalledWith({ kind: "collection", collectionId: "m1" });
    expect(requestedMangaVolume("m1")).toBe("v2");
    forgetMangaVolume("m1");
    // A work without volumes still opens from its title.
    fireEvent.click(within(list).getByRole("button", { name: "빈 작품" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "m2" });
    expect(requestedMangaVolume("m2")).toBeNull();
  });

  it("keeps 격자 with 한 줄에 N개 for manga", async () => {
    localStorage.setItem("lakomics.collections.view.manga.v1", JSON.stringify({ layout: "grid", perRow: 8, grouping: "device" }));
    const user = userEvent.setup();
    renderBrowser({ collections: [manga("m1", "다이의 대모험")], typeFilter: "manga", showcase: false });
    expect(screen.getByRole("group", { name: "만화 작품 목록" })).toHaveClass("collection-list--grid");
    const originalCard = screen.getByRole("group", { name: "만화 작품 목록" }).querySelector(".collection-card");
    await user.click(screen.getByRole("button", { name: "보기" }));
    fireEvent.change(screen.getByRole("slider", { name: "한 줄에" }), { target: { value: "6" } });
    expect(screen.getByRole("group", { name: "만화 작품 목록" })).toHaveAttribute("data-per-row", "6");
    await user.click(screen.getByRole("radio", { name: "선반" }));
    const shelf = screen.getByRole("group", { name: "만화 작품 목록" });
    expect(shelf).toHaveClass("collection-list--shelf");
    expect(shelf.querySelector(".collection-card")).toBe(originalCard);
    expect(shelf.querySelectorAll(".collection-light-case--book")).toHaveLength(1);
    await user.click(screen.getByRole("radio", { name: "책장" }));
    expect(screen.getByRole("group", { name: "만화 작품 목록" })).toHaveClass("manga-shelf-list");
    expect(JSON.parse(localStorage.getItem("lakomics.collections.view.manga.v1")!)).toMatchObject({ layout: "bookcase", perRow: 6 });
  });
});

function createGateway(): LibraryGateway {
  return {
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
    openLibrary: vi.fn(),
    importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchCatalogGroups: vi.fn(), getCatalogGroupEditions: vi.fn(), setCatalogGroupRepresentative: vi.fn(), listCatalogReview: vi.fn(), generateCatalogReview: vi.fn(), decideCatalogReview: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: false, apiBaseUrl: null, tokenConfigured: false }), setCloudCaptureSettings: vi.fn(), setCloudApiToken: vi.fn(), deleteCloudApiToken: vi.fn(), testCloudCaptureConnection: vi.fn().mockResolvedValue({ pendingCount: 0 }), runDueCloudCaptureSync: vi.fn().mockResolvedValue({ attempted: 0, acknowledged: 0, failed: 0, reviewPending: 0, added: 0, videoAdded: 0, classificationChanged: 0 }), cloudBackfillPreflight: vi.fn(), cloudBackfillSeed: vi.fn(), cloudBackfillRunCycle: vi.fn(), cloudBackfillProgress: vi.fn(), cloudBackfillRetryFailed: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
    getExtensionConnection: vi.fn(),
    listClassifications: vi.fn(),
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
    listAssets: vi.fn(),
    listAssetDateBuckets: vi.fn().mockResolvedValue([]),
    listAssetCreators: vi.fn().mockResolvedValue([]),
    getRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    prepareRevisitColorBundle: vi.fn().mockResolvedValue(null),
    reshuffleRevisitBundle: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(),
    decideSimilarityReview: vi.fn(),
    getAsset: vi.fn(),
    updateAssetMetadata: vi.fn(),
    trashAssets: vi.fn(),
    restoreAsset: vi.fn(),
    restoreAssets: vi.fn(),
    listTrash: vi.fn(),
    emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn(),
    setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(),
    listMetadataBackups: vi.fn(),
    restoreMetadataBackup: vi.fn(),
    purgeExpiredTrash: vi.fn(),
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
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(0),
    listMangaSeries: vi.fn().mockResolvedValue([]),
    ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(),
    retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), importCollectionArtworks: vi.fn().mockResolvedValue(0),
  listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getKakaoCredentialStatus: vi.fn(), setKakaoApiKey: vi.fn(), deleteKakaoApiKey: vi.fn(), searchKakao: vi.fn(), applyKakao: vi.fn(), refreshKakao: vi.fn(), getBookConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
  };
}
