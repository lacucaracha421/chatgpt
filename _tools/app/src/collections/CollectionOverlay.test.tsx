// Raster lifecycle is covered separately; jsdom has no canvas/WebGL implementation.
vi.mock("./physical/coverVisibility", () => ({
  observeCover: (_element: Element, callback: (visible: boolean) => void) => { callback(true); return () => undefined; },
  observeCoverSize: () => () => undefined,
}));
vi.mock("./physical/collectibleRuntime", async (importOriginal) => ({
  ...await importOriginal<typeof import("./physical/collectibleRuntime")>(),
  acquireCover: (_request: unknown, listener: (value: null) => void) => { listener(null); return () => undefined; },
  attachLiveBook: (_host: unknown, _request: unknown, onReady: (value: boolean) => void) => { onReady(false); return { tilt: () => undefined, refresh: () => undefined, dispose: () => undefined }; },
}));

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, ReleaseWatchEvent } from "../library/types";
import { CollectionOverlay } from "./CollectionOverlay";
import { BackNavigationProvider, useBackHandler } from "../shared/navigation/BackNavigation";
import { avGateway } from "./avClient";

afterEach(cleanup);

const collection: CollectionSummary = {
  id: "collection-1",
  name: "던전밥",
  description: null,
  type: "manga",
  coverAssetId: null,
  selectedWorkArtworkId: "artwork-1",
  selectedHeroArtworkId: null,
  selectedBackdropArtworkId: null,
  assetCount: 0,
  unreadReleaseCount: 0,
  year: 2014,
  originalTitle: null,
  runtimeMinutes: null,
  author: "쿠이 료코",
  developer: null,
  publisher: null,
  platforms: null,
  productionCompany: null,
  releaseDate: null,
  director: null,
  externalScore: null,
  myScore: null,
  genres: "판타지",
  overview: null,
  showcase: false,
  showcaseOrder: null,
  createdAt: "t",
  updatedAt: "t",
};

const gameCollection: CollectionSummary = {
  ...collection,
  id: "game-1",
  name: "Astral Chain",
  type: "game",
  selectedWorkArtworkId: "game-cover",
  selectedHeroArtworkId: "game-hero",
  author: null,
  year: 2019,
  developer: "PlatinumGames",
  publisher: "Nintendo",
  platforms: "Nintendo Switch",
  releaseDate: "2019-08-30",
  genres: "Action",
  overview: "A special ops action game.",
};

const movieCollection: CollectionSummary = {
  ...collection,
  id: "movie-1",
  name: "퍼펙트 블루",
  type: "movie",
  selectedWorkArtworkId: "movie-poster",
  selectedBackdropArtworkId: "movie-backdrop",
  originalTitle: "Perfect Blue",
  runtimeMinutes: 81,
  author: null,
  year: 1997,
  productionCompany: "매드하우스",
  releaseDate: "1997-07-12",
  director: "곤 사토시",
  genres: "애니메이션 · 스릴러",
  overview: "현실과 환상의 경계가 무너진다.",
};

const unread: ReleaseWatchEvent[] = [
  { id: "e1", kind: "new_volume", volumeNumber: 13, previousValue: null, currentValue: "2026-09-01", detectedAt: "2026-08-22T00:00:00Z" },
  { id: "e2", kind: "release_date_changed", volumeNumber: 12, previousValue: "2026-08-21", currentValue: "2026-08-23", detectedAt: "2026-08-22T00:00:00Z" },
  { id: "e3", kind: "release_status_changed", volumeNumber: 11, previousValue: "upcoming", currentValue: "released", detectedAt: "2026-08-22T00:00:00Z" },
];

function tracking(events: ReleaseWatchEvent[] = []) {
  return {
    setOwnedCount: vi.fn().mockResolvedValue([]),
    listOwnership: vi.fn().mockResolvedValue([]),
    setOwnership: vi.fn().mockResolvedValue([]),
    listInbox: vi.fn().mockResolvedValue(events.map(event => ({ collectionId: "collection-1", collectionName: "던전밥", event }))),
    acknowledge: vi.fn().mockResolvedValue(undefined),
  };
}

it("uses the shared Korean release board for the manga bookcase's latest unowned volume", async () => {
  const api = { ...tracking(), releaseBoard: vi.fn().mockResolvedValue([{
    collectionId: collection.id, releaseWatch: { enabled: false, available: true }, ownedVolumes: [],
    releaseSchedule: { kakao: { editionIndex: 0, checkedAt: null, volumes: [
      { volumeNumber: 1, date: "2020-01-01", status: "released" },
      { volumeNumber: 2, date: "2020-02-01", status: "released" },
      { volumeNumber: 3, date: "2099-01-01", status: "upcoming" },
    ] }, mangadex: { checkedAt: null, latestVolume: 30, volumes: [] } },
  }]) };
  renderOverlay({ collectionTracking: api, listCollectionVolumes: vi.fn().mockResolvedValue([1, 2, 3].map(volumeNumber => ({
    id: `v${volumeNumber}`, volumeNumber, editionIndex: 0, displayLabel: String(volumeNumber), coverArtworkId: null,
    localReleaseDate: null, isbn13: null, releaseStatus: null,
  }))) });
  const latest = await screen.findByText("최신");
  expect(latest.closest("button")).toHaveAccessibleName("2권 보기");
  await waitFor(() => expect(latest.closest("button")).toHaveClass("manga-spine--missing"));
  expect(screen.getAllByText("최신")).toHaveLength(1);
  expect(api.releaseBoard).toHaveBeenCalledOnce();
});

function renderOverlay(
  overrides: Partial<LibraryGateway> = {},
  onChanged = vi.fn().mockResolvedValue(undefined),
  onExit = vi.fn(),
  targetCollection = collection,
  onOpenSettings = vi.fn(),
  withSidebar = false,
  initialSearch?: { query: string; mediaType: "movie" | "tv" },
) {
  const gateway = {
    collectionTracking: tracking(),
    listCollectionCovers: vi.fn().mockResolvedValue([]),
    listCollectionVolumes: vi.fn().mockResolvedValue([]),
    listCollectionWorkArtworks: vi.fn().mockResolvedValue([]),
    importCollectionArtworks: vi.fn().mockResolvedValue(0),
    syncMangaDexVolumeCovers: vi.fn().mockResolvedValue({ completed: 0, skipped: 0, failed: 0 }), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn().mockResolvedValue({ completed: 0, skipped: 0, failed: 0 }),
    getMangaDexConnection: vi.fn().mockResolvedValue(null),
    refreshMangaDex: vi.fn().mockResolvedValue(collection),
    getKakaoCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setKakaoApiKey: vi.fn().mockResolvedValue({ configured: true }),
    deleteKakaoApiKey: vi.fn().mockResolvedValue({ configured: false }),
    searchKakao: vi.fn().mockResolvedValue([]),
    applyKakao: vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0, ignored: 0 }),
    refreshKakao: vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0, ignored: 0 }),
    getBookConnection: vi.fn().mockResolvedValue(null),
    getIgdbConnection: vi.fn().mockResolvedValue(null),
    getTmdbConnection: vi.fn().mockResolvedValue(null),
    previewTmdbMovie: vi.fn().mockResolvedValue({ movieId: 10494, proposedTitle: movieCollection.name, originalTitle: movieCollection.originalTitle, releaseDate: movieCollection.releaseDate, runtimeMinutes: 81, director: movieCollection.director, productionCompany: movieCollection.productionCompany, genres: movieCollection.genres, overview: movieCollection.overview, externalScore: 84, posters: [], backdrops: [] }),
    replaceTmdbMovieArtwork: vi.fn().mockResolvedValue(movieCollection),
    refreshTmdbMovie: vi.fn().mockResolvedValue(movieCollection),
    previewIgdbGame: vi.fn().mockResolvedValue({
      gameId: 17,
      proposedTitle: gameCollection.name,
      developer: gameCollection.developer,
      publisher: gameCollection.publisher,
      releaseDate: gameCollection.releaseDate,
      platforms: ["Nintendo Switch"],
      genres: ["Action"],
      overview: gameCollection.overview,
      covers: [],
      artworks: [],
      screenshots: [],
    }),
    replaceIgdbGameArtwork: vi.fn().mockResolvedValue(gameCollection),
    refreshIgdbGame: vi.fn().mockResolvedValue(gameCollection),
    getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
    setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
    updateCollection: vi.fn().mockResolvedValue(undefined),
    setCollectionShowcase: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]),
    runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    ...overrides,
  } as unknown as LibraryGateway;
  function Detail() {
    const [pendingSearch, setPendingSearch] = useState(initialSearch);
    return <CollectionOverlay collectionId={targetCollection.id} collections={[targetCollection]} onExit={onExit} onChanged={onChanged} onOpenSettings={onOpenSettings}
      initialTmdbSearch={pendingSearch} onTmdbSearchConsumed={() => setPendingSearch(undefined)} />;
  }
  const content = (
    <BackNavigationProvider><LibraryProvider gateway={gateway}>
      <Detail />
    </LibraryProvider></BackNavigationProvider>
  );
  render(
    withSidebar ? <WorkspaceChromeProvider scope={targetCollection.id}><aside aria-label="작품 사이드바"><ChromeTarget name="details" /></aside>{content}</WorkspaceChromeProvider> : content,
  );
  return { gateway, onChanged, onExit, onOpenSettings };
}

async function settleManga() {
  await act(async () => { document.querySelectorAll<HTMLImageElement>(".manga-work-book > img").forEach(image => fireEvent.load(image)); });
}

async function openProviderMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "작품 관리" }));
}

describe("CollectionOverlay MangaDex flow", () => {
  it("closes AV info editing before leaving the collection on Escape", async () => {
    const details = vi.spyOn(avGateway, "getDetails").mockResolvedValue({ collectionId: "av-1", revision: 0, productCode: null, label: null, series: null, titleJa: null, releaseDate: null, maker: null, genres: [], makerCount: 0, labelCount: 0, seriesCount: 0, people: [] });
    const covers = vi.spyOn(avGateway, "getCoverSet").mockResolvedValue({ frontId: null, spineId: null, backId: null, revision: "0" });
    const related = vi.spyOn(avGateway, "getRelated").mockResolvedValue({ performers: [], series: null, label: null });
    const people = vi.spyOn(avGateway, "searchPeople").mockResolvedValue([]);
    try {
      const { onExit } = renderOverlay({}, undefined, undefined, { ...collection, id: "av-1", type: "av" });
      await userEvent.click(await screen.findByRole("button", { name: "작품 관리" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "AV 정보 편집" }));
      expect(screen.getByRole("dialog", { name: "AV 정보 편집" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(onExit).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      details.mockRestore(); covers.mockRestore(); related.mockRestore(); people.mockRestore();
    }
  });

  it("shows a recovery action for missing collections and handles Escape only once", async () => {
    const onExit = vi.fn();
    const appBack = vi.fn();
    const listCollectionCovers = vi.fn().mockResolvedValue([]);
    const gateway = { listCollectionCovers } as unknown as LibraryGateway;
    function AppBack() { useBackHandler(appBack); return null; }
    render(<BackNavigationProvider><AppBack /><LibraryProvider gateway={gateway}>
      <CollectionOverlay collectionId="missing" collections={[]} onExit={onExit} onChanged={vi.fn()} onOpenSettings={vi.fn()} />
    </LibraryProvider></BackNavigationProvider>);
    expect(screen.getByRole("heading", { name: "컬렉션을 찾을 수 없습니다." })).toBeInTheDocument();
    expect(screen.queryByText("표지가 없습니다.")).not.toBeInTheDocument();
    expect(listCollectionCovers).not.toHaveBeenCalled();
    const back = screen.getByRole("button", { name: "컬렉션으로 돌아가기" });
    expect(back.nextElementSibling).toBe(screen.getByRole("heading", { name: "컬렉션" }));
    await userEvent.click(back);
    expect(onExit).toHaveBeenCalledTimes(1);
    onExit.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(appBack).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "돌아가기" }));
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it.each([movieCollection])("places $type information and management in the merged screen", async (target) => {
    const user = userEvent.setup();
    const { gateway } = renderOverlay({}, undefined, undefined, target, undefined, true);
    const work = await screen.findByRole("article", { name: "영화 작품 화면" });
    expect(within(work).getByRole("heading", { name: target.name })).toBeInTheDocument();
    expect(within(work).getByRole("complementary", { name: "작품 정보" })).toBeInTheDocument();
    const label = "작품 관리";
    await user.click(within(work).getByRole("button", { name: label }));
    await user.click(await screen.findByRole("menuitem", { name: "쇼케이스에 추가" }));
    expect(gateway.setCollectionShowcase).toHaveBeenCalledWith(target.id, true);
    expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
    expect(document.querySelector(".collection-overlay__manga-aside")).toBeNull();
  });

  it("switches editions from the info dock without duplicate controls", async () => {
    const volumes = [0,1].map(editionIndex => ({ id: `v${editionIndex}`, volumeNumber: 1, editionIndex, displayLabel: "1", coverArtworkId: `art${editionIndex}`, localReleaseDate: null, isbn13: null, releaseStatus: null }));
    renderOverlay({ listCollectionVolumes: vi.fn().mockResolvedValue(volumes) }, undefined, undefined, collection, undefined, true);
    const root = await screen.findByRole("article", { name: "만화 작품 화면" });
    await userEvent.click(screen.getByRole("button", { name: "대체판 1 선택" }));
    await settleManga();
    expect(screen.getByRole("button", { name: "대체판 1 선택" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("group", { name: "판본 선택" })).toHaveLength(1);
    expect(root.querySelector(".asset-viewer__title small")).toHaveTextContent("대체판 1");
    expect(screen.getByRole("img", { name: "1권 표지" })).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art1");
  });


  it("explains legacy Aladin reconnection and opens Kakao without refreshing the old provider", async () => {
    const user = userEvent.setup();
    const { gateway } = renderOverlay({
      getBookConnection: vi.fn().mockResolvedValue({ provider: "aladin", anchorItemId: "old-1", query: "던전밥", lastSyncedAt: "t" }),
    });
    const reconnect = await screen.findByRole("button", { name: "카카오로 재연결" });
    expect(reconnect).toHaveTextContent(/기존 신간 확인이 중단됐습니다/);
    await user.click(reconnect);
    expect(await screen.findByRole("dialog", { name: "Kakao 연결" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "카카오 작품 검색" })).toHaveValue("던전밥");
    expect(gateway.refreshKakao).not.toHaveBeenCalled();
  });

  it("loads an unconnected manga without requesting MangaDex cover sync or showing an error toast", async () => {
    const syncMangaDexVolumeCovers = vi.fn().mockRejectedValue(new Error("MangaDex identity is invalid"));
    const { gateway } = renderOverlay({ syncMangaDexVolumeCovers });

    expect(await screen.findByRole("group", { name: "권별 책장" })).toBeInTheDocument();
    await waitFor(() => expect(gateway.getMangaDexConnection).toHaveBeenCalledWith("collection-1"));
    expect(syncMangaDexVolumeCovers).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens the merged manga work with the bookcase and the docked controls", async () => {
    const user = userEvent.setup();
    renderOverlay({ listCollectionVolumes: vi.fn().mockResolvedValue([1,2].map(n => ({ id: `v${n}`, volumeNumber: n, editionIndex: 0, displayLabel: String(n), coverArtworkId: `art-${n}` }))) });
    const root = await screen.findByRole("article", { name: "만화 작품 화면" });
    expect(root.querySelector(".collection-overlay__hero")).toBeNull();
    expect(root.querySelector(".asset-viewer__position")).toHaveTextContent("1 / 2");
    expect(screen.getByRole("complementary", { name: "작품 정보" })).toContainElement(screen.getByRole("button", { name: "한 권 늘리기" }));
    expect(screen.getByRole("group", { name: "권별 책장" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "판본 선택" })).toBeNull();
    const connect = await screen.findByRole("region", { name: "연결" });
    expect(within(connect).getByRole("button", { name: "카카오 연결" })).toHaveClass("is-primary");
    await user.click(screen.getByRole("button", { name: "2권 보기" }));
    expect(root.querySelector(".asset-viewer__position")).toHaveTextContent("1 / 2");
    await settleManga();
    expect(screen.getByRole("article")).toBe(root);
    expect(root.querySelector(".asset-viewer__position")).toHaveTextContent("2 / 2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });


  it("enables release watch for a connected Kakao manga", async () => {
    const user = userEvent.setup();
    const setReleaseWatchEnabled = vi.fn().mockResolvedValue({ enabled: true, lastCheckedAt: null });
    const { gateway } = renderOverlay({
      getBookConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
      setReleaseWatchEnabled,
    });

    const checkbox = await screen.findByRole("switch", { name: "신간 알림" });
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(screen.getByLabelText("현재 보유 권수").closest("section")).toContainElement(checkbox);
    await user.click(checkbox);

    expect(setReleaseWatchEnabled).toHaveBeenCalledWith("collection-1", true);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(screen.queryByText(/권수를 저장하고/)).not.toBeInTheDocument();
    expect(screen.queryByText(/다음 발매:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/신간 알림 켜짐|마지막 확인:|다음 확인:/)).not.toBeInTheDocument();
    expect(gateway.takeUnreadReleaseChanges).not.toHaveBeenCalled();
  });

  it("disables an enabled release watch", async () => {
    const user = userEvent.setup();
    const setReleaseWatchEnabled = vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: "t" });
    renderOverlay({
      getBookConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: true, lastCheckedAt: "t" }),
      setReleaseWatchEnabled,
    });

    const checkbox = await screen.findByRole("switch", { name: "신간 알림" });
    await waitFor(() => expect(checkbox).toBeChecked());
    await user.click(checkbox);

    expect(setReleaseWatchEnabled).toHaveBeenCalledWith("collection-1", false);
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it("keeps the release watch checkbox unchanged when saving fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      getBookConnection: vi.fn().mockResolvedValue({anchorItemId:"item-1",query:"던전밥",lastSyncedAt:"t"}),
      getReleaseWatchStatus: vi.fn().mockResolvedValue({enabled:false,lastCheckedAt:null}),
      setReleaseWatchEnabled: vi.fn().mockRejectedValue(new Error("save failed")),
    });
    const checkbox = await screen.findByRole("switch", {name:"신간 알림"});
    await waitFor(() => expect(checkbox).toBeEnabled());
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).not.toBeChecked();
  });

  it("shows an unavailable checkbox without a Kakao binding", async () => {
    const user = userEvent.setup();
    const { gateway } = renderOverlay();

    await waitFor(() => expect(gateway.getBookConnection).toHaveBeenCalledOnce());
    expect(screen.getByRole("switch", { name: "신간 알림" })).toBeDisabled();
    await openProviderMenu(user);
    expect(screen.queryByRole("menuitem", { name: /신간 알림/ })).not.toBeInTheDocument();
  });

  it("keeps unread changes until explicitly acknowledged and preserves the selected cover", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([{
        id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
      }]),
      collectionTracking: tracking(unread),
    }, onChanged);

    const shelfCover = await screen.findByRole("img", { name: "1권 표지" });
    const summary = await screen.findByRole("region", { name: "새 출간 정보" });

    expect(summary).toHaveTextContent("새 권: 13권");
    expect(summary).toHaveTextContent("출간일 변경: 12권 2026-08-21 → 2026-08-23");
    expect(summary).toHaveTextContent("출간 상태 변경: 11권 출간 예정 → 출간됨");
    expect(onChanged).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "표시된 신간 알림 확인" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(shelfCover).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art-1");
  });

  it("contains card refresh failures after taking unread release changes", async () => {
    const onChanged = vi.fn().mockRejectedValue(new Error("refresh failed"));
    renderOverlay({ collectionTracking: tracking(unread) }, onChanged);

    expect(await screen.findByRole("region", { name: "새 출간 정보" })).toHaveTextContent("새 권: 13권");
    await userEvent.click(screen.getByRole("button", { name: "표시된 신간 알림 확인" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("renders no release summary and does not refresh cards when there are no unread changes", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { gateway } = renderOverlay({}, onChanged);

    await waitFor(() => expect(gateway.collectionTracking!.listInbox).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: "새 출간 정보" })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("renders volume covers on the shelf without a generic hero", async () => {
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([
        { id: "volume-1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "local-art" },
      ]),
    });
    await waitFor(() => expect(screen.getByRole("img", { name: "1권 표지" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/local-art",
    ));
    expect(document.querySelector(".collection-overlay__hero")).toBeNull();
  });

  it("shows available editions and preserves placeholders until cover sync settles", async () => {
    let finishSync!: (result: {completed:number;skipped:number;failed:number}) => void;
    const initial = [{id:"v2",volumeNumber:2,editionIndex:0,displayLabel:"2",coverArtworkId:"art-2"},{id:"v10",volumeNumber:10,editionIndex:0,displayLabel:"10",coverArtworkId:null},{id:"v1-1",volumeNumber:1,editionIndex:1,displayLabel:"1.1",coverArtworkId:"art-1-1"}];
    renderOverlay({ listCollectionVolumes: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial.map(v => v.id === "v10" ? {...v,coverArtworkId:"art-10"} : v)), syncMangaDexVolumeCovers: vi.fn().mockReturnValue(new Promise(resolve => { finishSync = resolve; })), getMangaDexConnection: vi.fn().mockResolvedValue({mangaId:"manga-1",lastSyncedAt:"t"}) });
    expect(await screen.findAllByRole("button", {name:/^(2|10)권 보기/})).toHaveLength(2);
    expect(screen.getByRole("button", {name:"10권 보기"}).querySelector("img")).toBeNull();
    expect(screen.queryByRole("textbox", {name:"권 번호"})).toBeNull();
    await act(async () => finishSync({completed:1,skipped:2,failed:0}));
    expect(screen.getByRole("button", {name:"10권 보기"}).querySelector("img")).toHaveAttribute("src","http://lakomics.localhost/work-artwork-thumbnail/art-10");
    await userEvent.click(screen.getByRole("button", {name:"대체판 1 선택"})); await settleManga();
    expect(screen.getByRole("button", {name:"1.1권 보기"})).toBeInTheDocument();
  });


  it("enlarges the picked cover on double click and leaves missing covers usable", async () => {
    const user = userEvent.setup();
    const {onExit} = renderOverlay({listCollectionVolumes:vi.fn().mockResolvedValue([1,2,3].map(n=>({id:`v${n}`,volumeNumber:n,editionIndex:0,displayLabel:String(n),coverArtworkId:n===3?null:`art-${n}`})))});
    const root=await screen.findByRole("article",{name:"만화 작품 화면"});
    const opener=screen.getByRole("button",{name:"2권 보기"});
    await user.click(opener); await settleManga();
    await user.dblClick(screen.getByRole("button",{name:"2권 보기"}));
    expect(screen.getByRole("dialog",{name:"던전밥 2권 표지 감상"})).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(()=>expect(screen.getByRole("button",{name:"2권 보기"})).toHaveFocus());
    expect(onExit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button",{name:"3권 보기"}));
    await waitFor(()=>expect(root.querySelector(".asset-viewer__position")).toHaveTextContent("3 / 3"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("표지가 없습니다.")).toBeInTheDocument();
  });


  it("opens the shared import dialog when the manga is not connected", async () => {
    const user = userEvent.setup();
    renderOverlay();

    await user.click(await screen.findByRole("button", { name: "MangaDex 연결" }));
    expect(screen.getByRole("heading", { name: "MangaDex 연결" })).toBeInTheDocument();
  });

  it("dismisses the provider menu with Escape without exiting detail", async () => {
    const user = userEvent.setup();
    const { onExit } = renderOverlay();
    const trigger = await screen.findByRole("button", { name: "작품 관리" });

    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "권별 표지 · 소장" })).toBeInTheDocument();
    // Provider connection moved to the 연결 row/panel; the menu keeps management only.
    expect(screen.queryByRole("menuitem", { name: "MangaDex 연결" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByRole("article", { name: "만화 작품 화면" })).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each([
    ["편집", "컬렉션 편집"],
    ["삭제", "컬렉션 삭제"],
  ])("lets the %s dialog handle Escape without exiting detail", async (action, title) => {
    const user = userEvent.setup();
    const { onExit } = renderOverlay();

    await screen.findByRole("article", { name: "만화 작품 화면" });
    if (action !== "편집") await openProviderMenu(user);
    await user.click(screen.getByRole(action === "편집" ? "button" : "menuitem", { name: action === "편집" ? "편집" : "컬렉션 삭제" }));
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByRole("article", { name: "만화 작품 화면" })).toBeInTheDocument();
  });

  it("retains editing, Showcase, imports, release refresh and deletion actions", async () => {
    const user=userEvent.setup(); const {gateway,onChanged}=renderOverlay();
    await screen.findByRole("article",{name:"만화 작품 화면"});
    await user.click(screen.getByRole("button",{name:"편집"}));
    expect(screen.getByRole("dialog",{name:"컬렉션 편집"})).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"저장"}));
    await waitFor(()=>expect(gateway.updateCollection).toHaveBeenCalledWith("collection-1",expect.objectContaining({name:"던전밥",type:"manga"})));
    await user.click(screen.getByRole("button",{name:"쇼케이스"}));
    await waitFor(()=>expect(gateway.setCollectionShowcase).toHaveBeenCalledWith("collection-1",true));
    await openProviderMenu(user);
    for(const name of ["권별 표지 · 소장","MangaDex 연결 · 가져오기","MangaDex 새로고침","Kakao 연결","국내 발매 정보 새로고침","책등 초점 다시 찾기","컬렉션 삭제"]) expect(screen.getByRole("menuitem",{name})).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });


  it("confirms collection deletion before leaving detail", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { gateway, onExit } = renderOverlay({}, onChanged);

    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "컬렉션 삭제" }));
    expect(screen.getByRole("dialog", { name: "컬렉션 삭제" })).toHaveTextContent("던전밥");
    expect(gateway.deleteCollection).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(gateway.deleteCollection).toHaveBeenCalledWith("collection-1"));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("keeps MangaDex separate and opens the text-only Kakao connection dialog", async () => {
    const user = userEvent.setup();
    const { onExit } = renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
    });

    expect(await screen.findByRole("button", { name: "MangaDex 새로고침" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "카카오 연결" }));
    const dialog = screen.getByRole("dialog", { name: "Kakao 연결" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector("img")).toBeNull();
    await user.keyboard("{Escape}");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("refreshes Kakao releases once without changing shelf covers", async () => {
    const user = userEvent.setup();
    const initial = {
      id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
      localReleaseDate: null, isbn13: null, releaseStatus: null,
    };
    const released = {
      ...initial,
      localReleaseDate: "2026-08-20", isbn13: "9781234567890", releaseStatus: "released" as const,
    };
    const listCollectionVolumes = vi.fn().mockResolvedValue([initial]);
    const getReleaseWatchStatus = vi.fn().mockResolvedValue({ enabled: true, lastCheckedAt: "t" });
    const { gateway } = renderOverlay({
      listCollectionVolumes,
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
      getBookConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      getReleaseWatchStatus,
      refreshKakao: vi.fn().mockResolvedValue({ added: 0, updated: 1, unchanged: 0, ignored: 0 }),
    });
    const shelfCover = await screen.findByRole("img", { name: "1권 표지" });
    expect(shelfCover).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art-1");
    await waitFor(() => expect(gateway.syncMangaDexVolumeCovers).toHaveBeenCalledOnce());
    listCollectionVolumes.mockClear();
    listCollectionVolumes.mockResolvedValue([released]);

    // Both connected: one folded 연결 row that opens to the per-provider rows.
    const fold = await screen.findByRole("button", { name: /연결/, expanded: false });
    expect(fold).toHaveTextContent("연결MangaDex카카오");
    await user.click(fold);
    await user.click(screen.getByRole("button", { name: "카카오 새로고침" }));

    await waitFor(() => expect(gateway.refreshKakao).toHaveBeenCalledWith("collection-1"));
    expect(getReleaseWatchStatus).toHaveBeenCalledTimes(2);
    expect(listCollectionVolumes).toHaveBeenCalledOnce();
    expect(shelfCover).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art-1");
  });

  it("keeps the shelf visible when Kakao refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([{
        id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
        localReleaseDate: null, isbn13: null, releaseStatus: null,
      }]),
      getBookConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      refreshKakao: vi.fn().mockRejectedValue(new Error("카카오 실패")),
    });

    expect(await screen.findByRole("button", { name: "1권 보기" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "카카오 새로고침" }));
    expect(await screen.findByRole("status")).toHaveTextContent("카카오 실패");
    expect(screen.getByRole("button", { name: "1권 보기" })).toBeInTheDocument();
  });

  it("refreshes a connected manga and reports the change", async () => {
    const user = userEvent.setup();
    const { gateway, onChanged } = renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
    });

    await user.click(await screen.findByRole("button", { name: "MangaDex 새로고침" }));
    await waitFor(() => expect(gateway.refreshMangaDex).toHaveBeenCalledWith("collection-1"));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("retains the shelf and shows an error when refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([{
        id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
      }]),
      syncMangaDexVolumeCovers: vi.fn().mockResolvedValue({ completed: 0, skipped: 0, failed: 0 }),
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
      refreshMangaDex: vi.fn().mockRejectedValue(new Error("새로고침하지 못했습니다.")),
    });
    const shelfCover = await screen.findByRole("img", { name: "1권 표지" });

    await user.click(await screen.findByRole("button", { name: "MangaDex 새로고침" }));
    expect(await screen.findByRole("status")).toHaveTextContent("새로고침하지 못했습니다.");
    expect(shelfCover).toBeInTheDocument();
  });
});

describe("CollectionOverlay game detail flow", () => {
  it("opens the merged game screen with the selected front cover", async () => {
    renderOverlay({}, undefined, undefined, gameCollection);
    expect(await screen.findByRole("article", { name: "게임 작품 화면" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Astral Chain 앞면" })).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/game-cover");
    expect(screen.queryByText(gameCollection.overview!)).not.toBeInTheDocument();
  });

  it("renders the local game while its provider request is pending", async () => {
    const getIgdbConnection = vi.fn().mockReturnValue(new Promise(() => undefined));
    renderOverlay({ getIgdbConnection }, undefined, undefined, gameCollection);
    expect(await screen.findByRole("heading", { name: "Astral Chain", level: 1 })).toBeInTheDocument();
  });

  it("exposes game edit, Showcase, delete, refresh, and artwork actions", async () => {
    const user = userEvent.setup();
    renderOverlay({}, undefined, undefined, gameCollection);
    await waitFor(() => expect(screen.getByRole("button", { name: "작품 관리" })).toBeEnabled());

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    expect(screen.getByRole("menuitem", { name: "컬렉션 편집" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "쇼케이스에 추가" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "컬렉션 삭제" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "IGDB 새로고침" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeInTheDocument();
  });

  it("keeps disconnected game IGDB mutations disabled", async () => {
    const user = userEvent.setup();
    renderOverlay({ getIgdbConnection: vi.fn().mockResolvedValue(null) }, undefined, undefined, gameCollection);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "IGDB 미연결" })).toBeInTheDocument());
    expect(screen.getByRole("menuitem", { name: "IGDB 새로고침" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeDisabled();
  });

  it("refreshes IGDB and reports success without replacing local detail", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const refreshIgdbGame = vi.fn().mockResolvedValue(gameCollection);
    const { gateway } = renderOverlay({
      getIgdbConnection: vi.fn().mockResolvedValue({ gameId: 17, lastSyncedAt: "t" }),
      refreshIgdbGame,
    }, onChanged, undefined, gameCollection);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "IGDB 새로고침" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "IGDB 새로고침" }));

    await waitFor(() => expect(gateway.refreshIgdbGame).toHaveBeenCalledWith("game-1"));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Astral Chain", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Astral Chain 앞면" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/game-cover",
    );
  });

  it("keeps local game detail and hero when IGDB refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      getIgdbConnection: vi.fn().mockResolvedValue({ gameId: 17, lastSyncedAt: "t" }),
      refreshIgdbGame: vi.fn().mockRejectedValue(new Error("IGDB 새로고침 실패")),
    }, undefined, undefined, gameCollection);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "IGDB 새로고침" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "IGDB 새로고침" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("IGDB 새로고침 실패");
    expect(screen.getByRole("heading", { name: "Astral Chain", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Astral Chain 앞면" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/game-cover",
    );
  });

  it("opens existing-target artwork dialog and refreshes local data after save", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { gateway } = renderOverlay({ getIgdbConnection: vi.fn().mockResolvedValue({ gameId: 17, lastSyncedAt: "t" }) }, onChanged, undefined, gameCollection);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "표지·hero 변경" }));
    expect(screen.getByRole("dialog", { name: "IGDB 게임 아트워크 변경" })).toBeInTheDocument();
    expect(gateway.getIgdbConnection).toHaveBeenCalledWith("game-1");

    expect(await screen.findByRole("heading", { name: "표지 선택" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByRole("heading", { name: "대표 이미지 선택" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(gateway.replaceIgdbGameArtwork).toHaveBeenCalledWith({
      collectionId: "game-1",
      cover: { kind: "keep" },
      hero: { kind: "keep" },
    }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "IGDB 게임 아트워크 변경" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Astral Chain", level: 1 })).toBeInTheDocument();
  });

  it("closes artwork dialog when save succeeds even if connection reload fails", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const connection = { gameId: 17, lastSyncedAt: "t" };
    const getIgdbConnection = vi.fn()
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce(connection)
      .mockRejectedValueOnce(new Error("연결 상태 갱신 실패"));
    const { gateway } = renderOverlay({ getIgdbConnection }, onChanged, undefined, gameCollection);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "표지·hero 변경" }));
    await screen.findByRole("heading", { name: "표지 선택" });
    await user.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "대표 이미지 선택" });
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(gateway.replaceIgdbGameArtwork).toHaveBeenCalledOnce());
    expect(onChanged).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "IGDB 게임 아트워크 변경" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("연결 상태 갱신 실패");
  });

  it("closes artwork dialog and surfaces a post-save refresh failure", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn().mockRejectedValue(new Error("컬렉션 갱신 실패"));
    const { gateway } = renderOverlay({ getIgdbConnection: vi.fn().mockResolvedValue({ gameId: 17, lastSyncedAt: "t" }) }, onChanged, undefined, gameCollection);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "표지·hero 변경" }));
    await screen.findByRole("heading", { name: "표지 선택" });
    await user.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "대표 이미지 선택" });
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(gateway.replaceIgdbGameArtwork).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "IGDB 게임 아트워크 변경" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("컬렉션 갱신 실패");
  });

  it("routes missing-credential artwork errors to the external-services settings callback", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderOverlay({
      getIgdbConnection: vi.fn()
        .mockResolvedValueOnce({ gameId: 17, lastSyncedAt: "t" })
        .mockRejectedValue({ code: "igdb_credential_not_configured" }),
    }, undefined, undefined, gameCollection, onOpenSettings);

    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "표지·hero 변경" }));
    await user.click(await screen.findByRole("button", { name: "IGDB 설정 열기" }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "IGDB 게임 아트워크 변경" })).not.toBeInTheDocument();
  });
});

describe("CollectionOverlay movie detail flow", () => {
  it("lets a connected series search for a replacement without changing its binding on cancel", async () => {
    const user = userEvent.setup();
    const searchTmdbMovies = vi.fn().mockResolvedValue([]);
    const applyTmdbMovie = vi.fn();
    renderOverlay({ searchTmdbMovies, applyTmdbMovie, getTmdbConnection: vi.fn().mockResolvedValue({ movieId: 42, mediaType: "tv", lastSyncedAt: "t" }) }, undefined, undefined, movieCollection);
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await user.click(await screen.findByRole("menuitem", { name: "TMDB 연결 작품 변경" }));
    const dialog = await screen.findByRole("dialog", { name: "TMDB 시리즈 연결 작품 변경" });
    await waitFor(() => expect(searchTmdbMovies).toHaveBeenCalledWith(movieCollection.name, "tv"));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(applyTmdbMovie).not.toHaveBeenCalled();
  });
  it("consumes the creation search once and keeps the detail after closing it", async () => {
    const user = userEvent.setup();
    const searchTmdbMovies = vi.fn().mockResolvedValue([]);
    renderOverlay({ searchTmdbMovies }, undefined, undefined, movieCollection, undefined, false,
      { query: movieCollection.name, mediaType: "tv" });
    const dialog = await screen.findByRole("dialog", { name: "TMDB 시리즈 연결" });
    await waitFor(() => expect(searchTmdbMovies).toHaveBeenCalledWith(movieCollection.name, "tv"));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "TMDB 시리즈 연결" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: movieCollection.name, level: 1 })).toBeInTheDocument();
    expect(searchTmdbMovies).toHaveBeenCalledTimes(1);
  });
  it("renders the local movie immediately and connects an unbound movie", async () => {
    const user = userEvent.setup();
    let resolveConnection!: (connection: null) => void;
    const getTmdbConnection = vi.fn().mockReturnValue(new Promise((resolve) => { resolveConnection = resolve; }));
    renderOverlay({ getTmdbConnection }, undefined, undefined, movieCollection);

    expect(screen.getByRole("heading", { name: "퍼펙트 블루", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    expect(screen.getByRole("menuitem", { name: "TMDB 새로고침" })).toBeDisabled();
    resolveConnection(null);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "TMDB에 연결" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "TMDB에 연결" }));
    expect(screen.getByRole("dialog", { name: "TMDB 영화 연결" })).toBeInTheDocument();
  });

  it("keeps the film case, strip artwork and overview when TMDB refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      getTmdbConnection: vi.fn().mockResolvedValue({ movieId: 10494, lastSyncedAt: "t" }),
      listCollectionWorkArtworks: vi.fn().mockResolvedValue([{ id: "movie-backdrop", kind: "backdrop", selected: true }]),
      refreshTmdbMovie: vi.fn().mockRejectedValue(new Error("TMDB 새로고침 실패")),
    }, undefined, undefined, movieCollection);

    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "TMDB 새로고침" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "TMDB 새로고침" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("TMDB 새로고침 실패");
    expect(screen.getByRole("img", { name: "퍼펙트 블루 앞면" })).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/movie-poster");
    expect(screen.getByRole("button", { name: "아트워크 1" }).querySelector("img")).toHaveAttribute("src", "http://lakomics.localhost/work-artwork-thumbnail/movie-backdrop");
    expect(within(screen.getByRole("region", { name: "개요" })).getByText(movieCollection.overview!)).toBeVisible();
  });
});
it.each([false, true])("omits manga description sections with sidebar=%s", async (sidebar) => {
  renderOverlay({}, vi.fn(), vi.fn(), {...collection, description:"English manga description", overview:"English manga overview"}, vi.fn(), sidebar);
  expect(await screen.findByRole("article", {name:"만화 작품 화면"})).toBeInTheDocument();
  expect(screen.queryByText("English manga description")).toBeNull();
  expect(screen.queryByText("English manga overview")).toBeNull();
});

it("keeps film editing, Showcase and confirmed delete reachable in the work screen", async () => {
  const { gateway, onExit } = renderOverlay({}, undefined, undefined, movieCollection);
  const user = userEvent.setup(); await screen.findByRole("article", { name: "영화 작품 화면" });
  await user.click(screen.getByRole("button", { name: "편집" }));
  expect(screen.getByRole("dialog", { name: "컬렉션 편집" })).toBeInTheDocument();
  await user.keyboard("{Escape}"); expect(onExit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "쇼케이스" }));
  await waitFor(() => expect(gateway.setCollectionShowcase).toHaveBeenCalledWith(movieCollection.id, true));
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  expect(screen.getByRole("menuitem", { name: "컬렉션 편집" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "컬렉션 삭제" }));
  const dialog = screen.getByRole("dialog", { name: "컬렉션 삭제" });
  expect(gateway.deleteCollection).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "삭제" }));
  await waitFor(() => expect(gateway.deleteCollection).toHaveBeenCalledWith(movieCollection.id));
  expect(onExit).toHaveBeenCalledOnce();
});
it("keeps TMDB poster/backdrop picking and external-service settings reachable", async () => {
  const { gateway } = renderOverlay({ getTmdbConnection: vi.fn().mockResolvedValue({ movieId: 42, mediaType: "movie", lastSyncedAt: "t" }) }, undefined, undefined, movieCollection);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "포스터·배경 변경" })).toBeEnabled());
  await user.click(screen.getByRole("menuitem", { name: "포스터·배경 변경" }));
  expect(screen.getByRole("dialog", { name: "TMDB 영화 아트워크 변경" })).toBeInTheDocument();
  await screen.findByRole("heading", { name: "포스터 선택" });
  await screen.findByRole("heading", { name: "배경 선택" });
  await user.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(gateway.replaceTmdbMovieArtwork).toHaveBeenCalledWith({ collectionId: movieCollection.id, poster: { kind: "keep" }, backdrop: { kind: "keep" } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  const settings = vi.fn();
  renderOverlay({ searchTmdbMovies: vi.fn().mockRejectedValue({ code: "tmdb_credential_not_configured" }) }, undefined, undefined, movieCollection, settings);
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "TMDB에 연결" })).toBeEnabled());
  await user.click(screen.getByRole("menuitem", { name: "TMDB에 연결" }));
  await user.type(screen.getByRole("searchbox", { name: "영화 검색" }), movieCollection.name);
  await user.click(screen.getByRole("button", { name: "검색" }));
  await user.click(await screen.findByRole("button", { name: "TMDB 설정 열기" }));
  expect(settings).toHaveBeenCalledOnce();
});
