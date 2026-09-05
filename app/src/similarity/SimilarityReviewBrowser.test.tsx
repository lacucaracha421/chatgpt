import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway, SimilarityReviewSummary } from "../library/types";
import { assetUrl } from "../assets/mediaUrl";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { SimilarityReviewBrowser } from "./SimilarityReviewBrowser";

afterEach(cleanup);

it("shows both public assets and advances after a successful decision", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews)
    .mockResolvedValueOnce(reviewPage([review("review-1")], 2))
    .mockResolvedValueOnce(reviewPage([review("review-2")], 1));
  const onCountChange = vi.fn();
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={onCountChange} onClose={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "유사 검토" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "기존 이미지" })).toHaveAttribute("src", assetUrl("existing-review-1"));
  expect(screen.getByRole("img", { name: "새 이미지" })).toHaveAttribute("src", assetUrl("candidate-review-1"));
  expect(screen.getAllByText("1920 × 1080")).toHaveLength(2);

  await userEvent.click(screen.getByRole("button", { name: "둘 다 보관" }));
  expect(gateway.decideSimilarityReview).toHaveBeenCalledWith({ reviewId: "review-1", decision: "keep_both" });
  expect(await screen.findByText("candidate-review-2.png")).toBeInTheDocument();
  expect(onCountChange).toHaveBeenLastCalledWith(1);
});

it("keeps the current pair and disables decisions while a decision is pending", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews).mockResolvedValue(reviewPage([review("review-1")], 1));
  let reject!: (reason: unknown) => void;
  vi.mocked(gateway.decideSimilarityReview).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText("candidate-review-1.png");

  await userEvent.click(screen.getByRole("button", { name: "새 이미지로 교체" }));
  expect(screen.getByRole("button", { name: "기존 이미지 유지" })).toBeDisabled();
  reject(new Error("conflict"));
  expect(await screen.findByRole("status")).toBeInTheDocument();
  expect(screen.getByText("candidate-review-1.png")).toBeInTheDocument();
});

it("hides the position counter after the last review is resolved", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews)
    .mockResolvedValueOnce(reviewPage([review("review-1")], 1))
    .mockResolvedValueOnce(reviewPage([], 0));
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText("candidate-review-1.png");

  await userEvent.click(screen.getByRole("button", { name: "기존 이미지 유지" }));

  expect(await screen.findByRole("heading", { name: "검토할 유사 이미지가 없습니다" })).toBeInTheDocument();
  expect(screen.queryByText(/\d+ \/ \d+/)).not.toBeInTheDocument();
});

it("closes with Escape without deciding and shows an empty queue", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews).mockResolvedValue(reviewPage([], 0));
  const onClose = vi.fn();
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={onClose} />);
  expect(await screen.findByRole("heading", { name: "검토할 유사 이미지가 없습니다" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(gateway.decideSimilarityReview).not.toHaveBeenCalled();
});

it("uses the shared view toolbar with window controls", async () => {
  const gateway = reviewGateway();
  const { container } = render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByRole("toolbar")).toBeInTheDocument();
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("masks both previews with skeletons in privacy mode", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews).mockResolvedValue(reviewPage([review("review-1")], 1));
  render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
    <SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />
  </PrivacyProvider>);

  expect(await screen.findByText("candidate-review-1.png")).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "기존 이미지" })).not.toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "새 이미지" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("status", { name: "비공개 모드" })).toHaveLength(2);
});

function review(id: string): SimilarityReviewSummary {
  return {
    id,
    distance: 2,
    existing: reviewAsset(`existing-${id}`, `existing-${id}.png`),
    candidate: reviewAsset(`candidate-${id}`, `candidate-${id}.png`),
  };
}

function reviewAsset(id: string, originalName: string) {
  return {
    asset: {
      id, title: null, originalName, byteSize: 2_048, width: 1920, height: 1080,
      collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: "https://x.com/user/status/1",
      sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null,
      importSource: null, importBatchId: null, originalModifiedAt: null,
      media: { kind: "image" as const },
    },
    format: "PNG",
    classifications: [{ id: "tag", kind: "tag" as const, name: "아로나", parentId: "work", iconKey: null, colorKey: null }],
  };
}

function reviewPage(items: SimilarityReviewSummary[], totalCount: number) {
  return { items, totalCount, nextCursor: null };
}

function reviewGateway(): LibraryGateway {
  return {
    resetJapaneseCatalogCheckpoint: vi.fn(),
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
    openLibrary: vi.fn(), importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), getCatalogVisibilityPolicy: vi.fn().mockResolvedValue({ hiddenCategories: [], blockedTags: [] }), setCatalogCategoryHidden: vi.fn(), setCatalogTagBlocked: vi.fn(), searchCatalogGroups: vi.fn(), getCatalogGroupEditions: vi.fn(), setCatalogGroupRepresentative: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: false, apiBaseUrl: null, tokenConfigured: false }), setCloudCaptureSettings: vi.fn(), setCloudApiToken: vi.fn(), deleteCloudApiToken: vi.fn(), testCloudCaptureConnection: vi.fn().mockResolvedValue({ pendingCount: 0 }), runDueCloudCaptureSync: vi.fn().mockResolvedValue({ attempted: 0, acknowledged: 0, failed: 0, reviewPending: 0, added: 0, videoAdded: 0, classificationChanged: 0 }), cloudBackfillPreflight: vi.fn(), cloudBackfillSeed: vi.fn(), cloudBackfillRunCycle: vi.fn(), cloudBackfillProgress: vi.fn(), cloudBackfillRetryFailed: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(), deleteClassification: vi.fn(),
    listAssets: vi.fn(), listAssetDateBuckets: vi.fn().mockResolvedValue([]), indexMissingSimilarityHashes: vi.fn(),
    listAssetCreators: vi.fn().mockResolvedValue([]),
    getRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitBundle: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    listSimilarityReviews: vi.fn(),
    decideSimilarityReview: vi.fn().mockResolvedValue(undefined),
    getAsset: vi.fn(), updateAssetMetadata: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), importCollectionArtworks: vi.fn().mockResolvedValue(0),
  listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn(), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
  };
}
