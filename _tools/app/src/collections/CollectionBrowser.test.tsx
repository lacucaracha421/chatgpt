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
import type { CollectionSummary, CollectionTrackingGateway, CollectionUpdateProvider, LibraryGateway, ReleaseBoardEntry, ReleaseInboxItem, ReleaseCalendarGateway } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";
import { coverSourceUrl } from "./physical/collectibleRuntime";
import { createDefaultCollectionLibraryState } from "./collectionLibrary";
import { resetReleaseDataForTests } from "./releaseData";

afterEach(() => { cleanup(); resetReleaseDataForTests(); });

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
  onChanged?: () => Promise<void>;
  libraryState?: ReturnType<typeof createDefaultCollectionLibraryState>["game"];
  onLibraryStateChange?: (next: ReturnType<typeof createDefaultCollectionLibraryState>["game"]) => void;
  tracking?: CollectionTrackingGateway;
  releaseProvider?: CollectionUpdateProvider;
  releaseCalendar?: boolean;
  calendarApi?: ReleaseCalendarGateway;
}) {
  const gateway = createGateway();
  if (props.tracking) gateway.collectionTracking = props.tracking;
  if (props.calendarApi) gateway.releaseCalendar = props.calendarApi;
  function Harness() {
    const [state, setState] = useState(props.libraryState ?? createDefaultCollectionLibraryState().game);
    return <LibraryProvider gateway={gateway}><CollectionBrowser releaseProvider={props.releaseProvider} releaseCalendar={props.releaseCalendar}
      collections={props.collections} typeFilter={props.typeFilter} showcase={props.showcase}
      onViewChange={props.onViewChange ?? (() => undefined)} onChanged={props.onChanged ?? (async () => undefined)}
      libraryState={state} onLibraryStateChange={(next) => { props.onLibraryStateChange?.(next); setState(next); }}
    /></LibraryProvider>;
  }
  render(
    <WorkspaceChromeProvider scope="collections-test">
      <aside aria-label="index">
        <ChromeTarget name="header" />
        <ChromeTarget name="actions" />
        <ChromeTarget name="search" />
        <ChromeTarget name="navigation" />
      </aside>
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
  it("puts the type rows and the sort / 내 별점 controls in the index, with only the title in the header", async () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: defaults.game });
    const index = screen.getByRole("complementary", { name: "index" });
    const types = within(index).getByRole("group", { name: "컬렉션 유형" });
    expect(within(types).getAllByRole("button").map(row => row.textContent)).toEqual(["게임", "만화", "영화", "AV"]);
    expect(within(types).getByRole("button", { name: "게임" })).toHaveAttribute("aria-current", "page");
    expect(within(types).getByRole("button", { name: "만화" })).not.toHaveAttribute("aria-current");
    // No Library/Showcase mode, no header tabs, no chips over the grid.
    expect(screen.queryByRole("button", { name: "라이브러리" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "보기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "컬렉션 유형" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "정렬과 필터" })).not.toBeInTheDocument();
    const header = screen.getByRole("toolbar", { name: "컬렉션 도구" });
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTestId("search-label")).toHaveTextContent("제목 검색");
    expect(within(index).getByRole("combobox", { name: "정렬" })).toHaveValue("media_date:desc");
    const rating = within(index).getByRole("slider", { name: "내 별점" });
    expect(rating).toHaveValue("0");expect(rating).toHaveAttribute("aria-valuetext", "전체");
    expect(rating).toHaveAttribute("min", "0");expect(rating).toHaveAttribute("max", "10");
    expect(within(index).getByRole("button", { name: "미평가" })).toHaveAttribute("aria-pressed", "false");
    expect(within(index).queryByRole("button", { name: "초기화" })).not.toBeInTheDocument();
  });

  it("shows a saved rating outside the presets as the selected option", async () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: { ...defaults.game, rating: 0 } });
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

  it("sets sort and direction from one index select and filters rating with a slider and a 미평가 toggle", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "정렬" }), "제목 · 가나다순");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, sort: "name", direction: "asc" });
    const rating = screen.getByRole("slider", { name: "내 별점" });
    expect(rating).toHaveValue("0");
    fireEvent.change(rating, { target: { value: "9" } });
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name", direction: "asc", rating: 4.5 }));
    expect(rating).toHaveValue("9");expect(rating).toHaveAttribute("aria-valuetext", "★ 4.5");
    // The keyboard steps one half-star at a time, like any range input.
    fireEvent.change(rating, { target: { value: "10" } });
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ rating: 5 }));
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

  it("puts the 신간 row in the index with the unread count and opens 한국 정발", async () => {
    const onViewChange = vi.fn();
    const tracking = trackingWith([]);
    renderBrowser({ collections: [{ ...manga, unreadReleaseCount: 2 }, { ...manga, id: "m2", unreadReleaseCount: 1 }], typeFilter: "game", showcase: false, tracking, onViewChange });
    const index = screen.getByRole("complementary", { name: "index" });
    const entry = within(index).getByRole("button", { name: "신간 보기, 새 알림 3개" });
    expect(entry).toHaveTextContent("신간3");
    expect(entry).not.toHaveAttribute("aria-current");
    // Other tabs never read the release data.
    expect(tracking.listInbox).not.toHaveBeenCalled();
    await userEvent.setup().click(entry);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false, releaseProvider: "kakao" });
  });

  it("puts the 발매 캘린더 row under 신간 with the unread wishlist count and makes it current in the calendar", async () => {
    const onViewChange = vi.fn();
    const calendarApi = {
      calendar: vi.fn().mockResolvedValue({ rangeStart: "2026-09-26", rangeEnd: "2027-03-28", entries: [], sources: [] }),
      refresh: vi.fn(), add: vi.fn(), remove: vi.fn(), setMuted: vi.fn(), acknowledge: vi.fn(), runDue: vi.fn(),
      wishlist: vi.fn().mockResolvedValue([{ id: "igdb:1", unread: [{ id: "e1" }, { id: "e2" }] }]),
    } as unknown as ReleaseCalendarGateway;
    renderBrowser({ collections: [], typeFilter: "game", showcase: false, tracking: trackingWith([]), calendarApi, onViewChange });
    const entry = await screen.findByRole("button", { name: "발매 캘린더 보기, 관심 목록 새 알림 2개" });
    expect(entry).not.toHaveAttribute("aria-current");
    await userEvent.setup().click(entry);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false, releaseCalendar: true });
    cleanup();

    renderBrowser({ collections: [], typeFilter: "game", showcase: false, tracking: trackingWith([]), calendarApi, releaseCalendar: true });
    expect(await screen.findByRole("region", { name: "발매 캘린더" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "컬렉션 유형" })).getAllByRole("button").filter(row => row.hasAttribute("aria-current")).map(row => row.textContent)).toEqual(["발매 캘린더2"]);
    expect(screen.queryByRole("combobox", { name: "정렬" })).not.toBeInTheDocument();
  });

  it("keeps the manual update check in the 신간 view and explains an empty list", async () => {
    const tracking = { ...trackingWith([]), runUpdates: vi.fn(), updateStatus: vi.fn().mockResolvedValue(undefined) } as unknown as CollectionTrackingGateway;
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking, releaseProvider: "kakao" });
    expect(await screen.findByRole("button", { name: "업데이트 확인" })).toBeInTheDocument();
    expect(await screen.findByText("신간 알림을 켠 만화가 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "신간" })).toBeInTheDocument();
    // The 신간 row is the current location; no type row is, and the library controls step aside.
    expect(screen.getByRole("button", { name: "신간 보기" })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("group", { name: "컬렉션 유형" })).getAllByRole("button").filter(row => row.hasAttribute("aria-current")).map(row => row.textContent)).toEqual(["신간"]);
    expect(screen.queryByRole("combobox", { name: "정렬" })).not.toBeInTheDocument();
  });

  const board = (collectionId: string, owned: number | null, kakao: [number, string | null][], mangadex: number | null = null, watch = true): ReleaseBoardEntry => ({
    collectionId, releaseWatch: { enabled: watch, available: true }, ownedVolumes: owned == null ? [] : [{ editionIndex: 0, count: owned }],
    releaseSchedule: { kakao: { editionIndex: 0, checkedAt: null, volumes: kakao.map(([volumeNumber, date]) => ({ volumeNumber, date, status: null })) }, mangadex: mangadex == null ? null : { checkedAt: null, latestVolume: mangadex, volumes: [] } },
  });
  const event = (collectionId: string, id: string, volumeNumber: number, currentValue: string | null, provider: ReleaseInboxItem["provider"] = "kakao"): ReleaseInboxItem =>
    ({ collectionId, collectionName: collectionId, provider, event: { id, kind: "new_volume", volumeNumber, previousValue: null, currentValue, detectedAt: "2026-09-20T00:00:00Z" } });

  it("shows the year, my stars and the 신간 marker on manga tiles by priority", async () => {
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
    const segments = screen.getByRole("tablist", { name: "신간 지역" });
    expect(within(segments).getByRole("tab", { name: /한국 정발/ })).toHaveAttribute("aria-selected", "true");
    const group = await screen.findByRole("region", { name: "가 작품" });
    expect(within(group).getByText("2권까지 소장")).toBeInTheDocument();
    expect(within(group).getAllByRole("listitem").map(row => row.textContent)).toEqual([`3권 · ${year - 1}년 9월 16일 발매됨미보유NEW`, `4권 · ${year + 1}년 10월 10일 발매 예정미보유`]);
    expect(within(group).getByLabelText("새 알림 1개")).toHaveTextContent("NEW 1");
    // A watched work with every Korean volume owned is not listed; an unwatched work never is.
    expect(screen.queryByRole("region", { name: "나 작품" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "다 작품" })).not.toBeInTheDocument();
    await userEvent.setup().click(within(segments).getByRole("tab", { name: /일본/ }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "mangadex" });
    cleanup();
    renderBrowser({ collections, typeFilter: "manga", showcase: false, tracking, releaseProvider: "mangadex" });
    const japan = await screen.findByRole("region", { name: "나 작품" });
    expect(within(japan).getByText("일본 최신 9권")).toBeInTheDocument();
    expect(within(japan).getByText("한국 정발보다 6권 앞섬")).toBeInTheDocument();
    expect(within(japan).getByRole("list", { name: "나 작품 일본 권" })).toHaveTextContent("4권5권6권7권8권9권NEW");
    expect(screen.getByRole("region", { name: "가 작품" })).toHaveTextContent("한국 정발보다 2권 앞섬");
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
    expect(screen.getByRole("region", { name: "가 작품" })).toHaveTextContent("3권");
    expect(onChanged).toHaveBeenCalled();
    // Events of works the lists do not show stay under 새 알림.
    expect(screen.getByRole("heading", { name: "그 밖의 새 알림" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "z" })).toHaveTextContent("1권 새로 나옴");
  });

  it("folds a Showcase row above 전체 whose 전체 보기 opens the whole Showcase", async () => {
    const onViewChange = vi.fn();
    const onLibraryStateChange = vi.fn();
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [{ ...sample, showcase: true, showcaseOrder: 0 }, { ...sample, id: "c2", name: "Celeste" }], typeFilter: "game", showcase: false, onViewChange, onLibraryStateChange, libraryState: defaults.game });
    const user = userEvent.setup();
    const row = screen.getByRole("region", { name: "쇼케이스" });
    const fold = within(row).getByRole("button", { name: /쇼케이스/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await user.click(fold);
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ showcaseOpen: true }));
    const shelf = within(row).getByRole("group", { name: "게임 쇼케이스" });
    // The shelf keeps only the marker line: no year or stars.
    expect(within(shelf).getByText("Astral Chain")).toBeInTheDocument();
    expect(within(shelf).queryByText("2019")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "전체 보기" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: true });
    expect(screen.getByRole("heading", { name: /전체/ })).toHaveTextContent("전체2");
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

    expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
      "src",
      coverSourceUrl({ src: "http://lakomics.localhost/collection-source-thumbnail/c1", scope: "", revision: sample.updatedAt }),
    );
  });

  it("prefers the media-vault cover asset over the source preview", () => {
    renderBrowser({
      collections: [{ ...sample, coverAssetId: "asset-1", sourcePath: "games/astral-chain" }],
      typeFilter: "game",
      showcase: false,
    });

    expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
      "src",
      coverSourceUrl({ src: "http://lakomics.localhost/thumbnail/asset-1", scope: "", revision: sample.updatedAt }),
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
    const types = within(screen.getByRole("group", { name: "컬렉션 유형" }));
    expect(types.queryByRole("button", { name: "전체" })).not.toBeInTheDocument();
    expect(types.getByRole("button", { name: "게임" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.queryByText("던전밥")).not.toBeInTheDocument();
    await userEvent.setup().click(types.getByRole("button", { name: "만화" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false });
  });

  it("shows only showcase collections when showcase on", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: true });
    expect(screen.getByText("쇼케이스에 컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("leaves the whole Showcase through the header back button or the current type row", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: "game", showcase: true, onViewChange });
    // A drill-down, not a mode: the type row stays current and the library controls step aside.
    expect(screen.getByRole("button", { name: "게임" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("combobox", { name: "정렬" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "컬렉션으로 돌아가기" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false });
    onViewChange.mockClear();
    await user.click(screen.getByRole("button", { name: "게임" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false });
    await user.click(screen.getByRole("button", { name: "만화" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false });
  });

  it("shows showcase collections when showcase on and a collection is showcased", () => {
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: "game", showcase: true });
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "쇼케이스" })).toHaveAttribute("aria-description", "게임 쇼케이스");
  });

  it("labels the ordinary library with the visible work count", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false });

    expect(screen.getByRole("heading", { name: "컬렉션" })).toHaveAttribute("aria-description", "게임 컬렉션");
    expect(screen.getByLabelText("작품 1개")).toHaveTextContent("1");
  });

  it("opens the detail view when a card is clicked", () => {
    const onViewChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onViewChange });
    screen.getByText("Astral Chain").click();
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
    expect(onViewChange).toHaveBeenCalledWith({ kind: "settings", section: "external_services" });
    expect(screen.queryByRole("heading", { name: "IGDB에서 게임 추가" })).not.toBeInTheDocument();
  });

  it("prefers stored WorkArtwork over other card covers", () => {
    renderBrowser({
      collections: [{ ...sample, selectedWorkArtworkId: "artwork-1", coverAssetId: "asset-1", sourcePath: "games/astral-chain" }],
      typeFilter: "game",
      showcase: false,
    });

    expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
      "src",
      coverSourceUrl({ src: "http://lakomics.localhost/work-artwork-thumbnail/artwork-1", scope: "", revision: sample.updatedAt }),
    );
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
