import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";

afterEach(cleanup);

const sample: CollectionSummary = {
  id: "c1",
  name: "Astral Chain",
  description: null,
  type: "game",
  coverAssetId: null,
  selectedWorkArtworkId: null,
  assetCount: 3,
  year: 2019,
  author: "PlatinumGames",
  director: null,
  externalScore: 87,
  myScore: 9,
  genres: null,
  overview: null,
  showcase: false,
  createdAt: "t",
  updatedAt: "t",
};

function renderBrowser(props: {
  collections: CollectionSummary[];
  typeFilter: CollectionSummary["type"] | null;
  showcase: boolean;
  onViewChange?: () => void;
  onChanged?: () => Promise<void>;
}) {
  const gateway = createGateway();
  render(
    <LibraryProvider gateway={gateway}>
      <CollectionBrowser
        collections={props.collections}
        typeFilter={props.typeFilter}
        showcase={props.showcase}
        onViewChange={props.onViewChange ?? (() => undefined)}
        onChanged={props.onChanged ?? (async () => undefined)}
      />
    </LibraryProvider>,
  );
  return gateway;
}

describe("CollectionBrowser", () => {
  it("renders a grid of collection cards", () => {
    renderBrowser({ collections: [sample], typeFilter: null, showcase: false });
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
    expect(screen.getAllByText("게임").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("3개")).toBeInTheDocument();
  });

  it("uses the source preview when a collection has no cover asset", () => {
    renderBrowser({
      collections: [{ ...sample, sourcePath: "games/astral-chain" }],
      typeFilter: null,
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
      typeFilter: null,
      showcase: false,
    });

    expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/thumbnail/asset-1",
    );
  });

  it("shows empty state when no collections", () => {
    renderBrowser({ collections: [], typeFilter: null, showcase: false });
    expect(screen.getByText("컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("filters by type when type filter set", () => {
    renderBrowser({ collections: [sample], typeFilter: "manga", showcase: false });
    expect(screen.queryByText("Astral Chain")).not.toBeInTheDocument();
  });

  it("shows only showcase collections when showcase on", () => {
    renderBrowser({ collections: [sample], typeFilter: null, showcase: true });
    expect(screen.getByText("쇼케이스에 컬렉션이 없습니다.")).toBeInTheDocument();
  });

  it("shows showcase collections when showcase on and a collection is showcased", () => {
    renderBrowser({ collections: [{ ...sample, showcase: true }], typeFilter: null, showcase: true });
    expect(screen.getByText("Astral Chain")).toBeInTheDocument();
  });

  it("opens the detail view when a card is clicked", () => {
    const onViewChange = vi.fn();
    renderBrowser({ collections: [sample], typeFilter: null, showcase: false, onViewChange });
    screen.getByText("Astral Chain").click();
    expect(onViewChange).toHaveBeenCalledWith({ kind: "collection", collectionId: "c1" });
  });

  it("orders MangaDex before manual input in the new collection menu", async () => {
    const user = userEvent.setup();
    const gateway = renderBrowser({ collections: [], typeFilter: null, showcase: false });
    await user.click(screen.getByRole("button", { name: "새 컬렉션" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["MangaDex에서 만화 추가", "직접 입력"]);
    await user.click(screen.getByRole("menuitem", { name: "직접 입력" }));
    expect(await screen.findByRole("heading", { name: "새 컬렉션" })).toBeInTheDocument();
    expect(gateway.createCollection).not.toHaveBeenCalled();
  });
});

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
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
    retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), listCollectionCovers: vi.fn(),
  };
}
