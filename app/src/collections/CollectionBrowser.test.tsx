import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";
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
  assetCount: 3,
  unreadReleaseCount: 0,
  year: 2019,
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
}) {
  const gateway = createGateway();
  function Harness() {
    const [state, setState] = useState(props.libraryState ?? createDefaultCollectionLibraryState().game);
    return <LibraryProvider gateway={gateway}><CollectionBrowser
      collections={props.collections} typeFilter={props.typeFilter} showcase={props.showcase}
      onViewChange={props.onViewChange ?? (() => undefined)} onChanged={props.onChanged ?? (async () => undefined)}
      libraryState={state} onLibraryStateChange={(next) => { props.onLibraryStateChange?.(next); setState(next); }}
    /></LibraryProvider>;
  }
  render(
    <Harness />,
  );
  return gateway;
}

describe("CollectionBrowser", () => {
  it("renders stable mode, media, search, sort, direction, and rating controls", () => {
    const defaults = createDefaultCollectionLibraryState();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, libraryState: defaults.game });
    expect(screen.getByRole("button", { name: "라이브러리" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "쇼케이스" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("textbox", { name: "제목 검색" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "정렬" })).toHaveValue("recent");
    expect(screen.getByRole("combobox", { name: "내 별점" })).toHaveValue("all");
  });

  it("updates only the active media browse state", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    await userEvent.setup().type(screen.getByRole("textbox", { name: "제목 검색" }), "nier");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, query: "nier" });
  });

  it("toggles direction and converts rating values", async () => {
    const onLibraryStateChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: "game", showcase: false, onLibraryStateChange });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "내림차순" }));
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, direction: "asc" });
    await user.selectOptions(screen.getByRole("combobox", { name: "내 별점" }), "4.5");
    expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...createDefaultCollectionLibraryState().game, direction: "asc", rating: 4.5 });
    expect(screen.getByRole("option", { name: "전체" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "미평가" })).toBeInTheDocument();
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

  it("uses the source preview when a collection has no cover asset", () => {
    renderBrowser({
      collections: [{ ...sample, sourcePath: "games/astral-chain" }],
      typeFilter: "game",
      showcase: false,
    });

    expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/collection-source-preview/c1",
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
      "http://lakomics.localhost/thumbnail/asset-1",
    );
  });

  it("shows empty state when no collections", () => {
    renderBrowser({ collections: [], typeFilter: "game", showcase: false });
    expect(screen.getByText("컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("filters by type when type filter set", () => {
    const manga = { ...sample, id: "manga", name: "던전밥", type: "manga" as const };
    renderBrowser({ collections: [sample, manga], typeFilter: "game", showcase: false });
    expect(screen.queryByRole("button", { name: "전체" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "게임" })).toHaveAttribute("aria-pressed", "true");
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
      "http://lakomics.localhost/work-artwork-thumbnail/artwork-1",
    );
  });
});

function createGateway(): LibraryGateway {
  return {
    getIgdbCredentialStatus: vi.fn(),
    setIgdbCredentials: vi.fn(),
    deleteIgdbCredentials: vi.fn(),
    searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(),
    applyIgdbGame: vi.fn(),
    refreshIgdbGame: vi.fn(),
    getIgdbConnection: vi.fn(),
    replaceIgdbGameArtwork: vi.fn(),
    openLibrary: vi.fn(),
    importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
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
    retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
  };
}
