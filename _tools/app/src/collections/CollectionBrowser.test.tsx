// Raster lifecycle is covered separately; jsdom has no canvas/WebGL implementation.
vi.mock("./physical/collectibleRuntime", async (importOriginal) => ({
  ...await importOriginal<typeof import("./physical/collectibleRuntime")>(),
  acquireCover: (_request: unknown, listener: (value: null) => void) => { listener(null); return () => undefined; },
  attachLiveBook: (_host: unknown, _request: unknown, onReady: (value: boolean) => void) => { onReady(false); return { tilt: () => undefined, refresh: () => undefined, dispose: () => undefined }; },
}));

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import type { CollectionSummary, CollectionTrackingGateway, CollectionUpdateProvider, LibraryGateway, ReleaseInboxItem } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";
import { coverSourceUrl } from "./physical/collectibleRuntime";
import { createDefaultCollectionLibraryState } from "./collectionLibrary";

afterEach(cleanup);

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
}) {
  const gateway = createGateway();
  if (props.tracking) gateway.collectionTracking = props.tracking;
  function Harness() {
    const [state, setState] = useState(props.libraryState ?? createDefaultCollectionLibraryState().game);
    return <LibraryProvider gateway={gateway}><CollectionBrowser releaseProvider={props.releaseProvider}
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
  it("renders stable mode, media, search, sort, direction, and rating controls", () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: defaults.game });
    expect(screen.getByRole("button", { name: "라이브러리" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "쇼케이스" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("group", { name: "보기" })).toHaveClass("collection-browser__segment--context");
    expect(screen.getByRole("group", { name: "유형" })).not.toHaveClass("collection-browser__segment--context");
    expect(screen.getByTestId("search-label")).toHaveTextContent("제목 검색");
    expect(screen.getByRole("combobox", { name: "정렬" })).toHaveValue("media_date:desc");
    expect(screen.queryByRole("combobox", { name: "방향" })).not.toBeInTheDocument();
    const rating = screen.getByRole("combobox", { name: "내 별점" });
    expect(rating).toHaveValue("all");
    expect(within(rating).getAllByRole("option").map(option => option.textContent)).toEqual(["전체", "★ 5.0", "★ 4.5", "★ 4.0", "★ 3.5", "★ 3.0", "★ 2.5", "★ 2.0", "★ 1.5", "★ 1.0", "★ 0.5", "미평가"]);
    expect(screen.queryByRole("group", { name: "내 별점" })).not.toBeInTheDocument();
  });

  it("shows a saved rating outside the presets as the selected option", () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: { ...defaults.game, rating: 0 } });
    const rating = screen.getByRole("combobox", { name: "내 별점" });
    expect(rating).toHaveValue("0");
    expect(within(rating).getByRole("option", { name: "★ 0.0" })).toBeInTheDocument();
  });

  it("updates only the active media browse state", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    const user = userEvent.setup();
    expect(onLibraryStateChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "팔레트 검색 적용" }));
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, query: "nier" });
  });

  it("sets sort and direction from one select and filters rating from one select", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "정렬" }), "name:asc");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, sort: "name", direction: "asc" });
    const rating = screen.getByRole("combobox", { name: "내 별점" });
    expect(rating).toHaveValue("all");
    expect(within(rating).getAllByRole("option").map(option => option.textContent)).toEqual(["전체", "★ 5.0", "★ 4.5", "★ 4.0", "★ 3.5", "★ 3.0", "★ 2.5", "★ 2.0", "★ 1.5", "★ 1.0", "★ 0.5", "미평가"]);
    await user.selectOptions(rating, "★ 4.5");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name", direction: "asc", rating: 4.5 }));
    expect(rating).toHaveValue("4.5");
    await user.selectOptions(rating, "미평가");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({rating:"unrated"}));
    await user.selectOptions(rating, "전체");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({rating:"all"}));
  });

  const inboxItem = (collectionId: string, provider: ReleaseInboxItem["provider"], id = collectionId): ReleaseInboxItem => ({ collectionId, collectionName: collectionId, provider,
    event: { id, kind: "new_volume", volumeNumber: 2, previousValue: null, currentValue: null, detectedAt: "2026-09-20T00:00:00Z" } });
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

  it("keeps a quiet inbox entry at zero so updates can be checked by hand", async () => {
    const onViewChange = vi.fn();
    const tracking = trackingWith([]);
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking, onViewChange });
    await waitFor(() => expect(tracking.listInbox).toHaveBeenCalled());
    const entry = screen.getByRole("button", { name: "알림함" });
    expect(entry).toHaveClass("collection-browser__segment-button--quiet");
    await userEvent.setup().click(entry);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "mangadex" });
  });

  it("offers the manual update check inside the inbox with zero unread", async () => {
    const tracking = { ...trackingWith([]), runUpdates: vi.fn(), updateStatus: vi.fn().mockResolvedValue(undefined) } as unknown as CollectionTrackingGateway;
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking, releaseProvider: "kakao" });
    expect(await screen.findByRole("button", { name: "업데이트 확인" })).toBeInTheDocument();
    expect(await screen.findByText("확인하지 않은 신간 알림이 없습니다.")).toBeInTheDocument();
  });

  it("shows one 새 알림 row with the unread work count and opens the busier provider", async () => {
    const onViewChange = vi.fn();
    const tracking = trackingWith([inboxItem("a", "mangadex"), inboxItem("a", "mangadex", "a2"), inboxItem("b", "kakao"), inboxItem("c", "aladin")]);
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking, onViewChange });
    const row = await screen.findByRole("button", { name: "새 알림 3" });
    await userEvent.setup().click(row);
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" });
  });

  it("lets the inbox switch providers", async () => {
    const onViewChange = vi.fn();
    const tracking = trackingWith([inboxItem("a", "mangadex"), inboxItem("b", "kakao")]);
    renderBrowser({ collections: [manga], typeFilter: "manga", showcase: false, tracking, onViewChange, releaseProvider: "mangadex" });
    const providers = await screen.findByRole("group", { name: "알림 공급처" });
    expect(within(providers).getByRole("button", { name: "MangaDex 1" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(within(providers).getByRole("button", { name: "Kakao 1" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" });
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

    expect(screen.getByText("신간 3")).toBeInTheDocument();
    expect(screen.queryByText("신간 0")).not.toBeInTheDocument();
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

  it("filters by type when type filter set", () => {
    const manga = { ...sample, id: "manga", name: "던전밥", type: "manga" as const };
    renderBrowser({ collections: [sample, manga], typeFilter: "game", showcase: false });
    const typeFilter = within(screen.getByRole("group", { name: "유형" }));
    expect(typeFilter.queryByRole("button", { name: "전체" })).not.toBeInTheDocument();
    expect(typeFilter.getByRole("button", { name: "게임" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.queryByText("던전밥")).not.toBeInTheDocument();
  });

  it("shows only showcase collections when showcase on", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: true });
    expect(screen.getByText("쇼케이스에 컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("preserves the concrete type when toggling showcase", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onViewChange });

    await user.click(screen.getByRole("button", { name: "쇼케이스" }));

    expect(onViewChange).toHaveBeenCalledWith({ kind: "collections", typeFilter: "game", showcase: true });
  });

  it("shows showcase collections when showcase on and a collection is showcased", () => {
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: "game", showcase: true });
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "게임 쇼케이스" })).toBeInTheDocument();
    expect(screen.getByText("선정 작품 1개")).toBeInTheDocument();
  });

  it("labels the ordinary library with the visible work count", () => {
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false });

    expect(screen.getByRole("heading", { name: "게임 컬렉션" })).toBeInTheDocument();
    expect(screen.getByText("작품 1개")).toBeInTheDocument();
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
