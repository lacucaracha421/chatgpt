// Measurement-only fixture for the PERF-ALL-001 render/commit harness (`*.perf.test.tsx`).
// It mirrors the fake gateway in `app/App.test.tsx`, with two differences that matter for
// idle measurement: every polled status read returns a FRESH object (as a real Tauri IPC
// round-trip does), and the Library has enough assets for a paged, virtualized grid.
import { vi } from "vitest";
import type { AssetSummary, ClassificationEntry, CollectionSummary, LibraryGateway } from "../library/types";

export const PERF_PAGE_SIZE = 100;

export function perfAsset(index: number): AssetSummary {
  const day = String(1 + (index % 28)).padStart(2, "0");
  return {
    id: `asset-${index}`,
    title: null,
    originalName: `asset-${index}.png`,
    byteSize: 1000 + index,
    width: 800 + (index % 7) * 60,
    height: 600 + (index % 5) * 90,
    collectedAt: `2026-08-${day}T${String(index % 24).padStart(2, "0")}:00:00Z`,
    favorite: false,
    sourceUrl: null,
    sourcePublishedAt: null,
    creatorName: null,
    creatorHandle: null,
    creatorUrl: null,
    importSource: null,
    importBatchId: null,
    originalModifiedAt: null,
    media: { kind: "image" },
    thumbnailRevision: String(1_000_000 + index),
  };
}

export const perfClassifications: ClassificationEntry[] = [
  { id: "root-games", kind: "root", name: "게임", parentId: null, iconKey: null, colorKey: null },
  { id: "work-a", kind: "work", name: "작품 A", parentId: "root-games", iconKey: null, colorKey: null },
  { id: "tag-a1", kind: "tag", name: "캐릭터 A1", parentId: "work-a", iconKey: null, colorKey: null },
  { id: "work-b", kind: "work", name: "작품 B", parentId: "root-games", iconKey: null, colorKey: null },
  { id: "root-images", kind: "root", name: "이미지", parentId: null, iconKey: null, colorKey: null },
];

export function perfCollection(index: number): CollectionSummary {
  return {
    id: `collection-${index}`, name: `컬렉션 ${index}`, description: null, type: "manga",
    coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null,
    assetCount: 0, unreadReleaseCount: 0, year: 2020, originalTitle: null, runtimeMinutes: null, author: null,
    developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null,
    externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null,
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
  };
}

const TOTAL_ASSETS = 1000;

/** Keyset pages of `PERF_PAGE_SIZE` over `TOTAL_ASSETS` synthetic assets. */
function listAssetsPaged(query: { after?: { token: string } | null }) {
  const start = query.after ? Number(query.after.token) : 0;
  const end = Math.min(TOTAL_ASSETS, start + PERF_PAGE_SIZE);
  const items = Array.from({ length: end - start }, (_, offset) => perfAsset(start + offset));
  return Promise.resolve({ items, nextCursor: end < TOTAL_ASSETS ? { token: String(end) } : null, totalCount: TOTAL_ASSETS });
}

/** `stable*`: return one cached object instead of a fresh one (attribution runs only). */
export type PerfGatewayOptions = { stableVault?: boolean; stableProgress?: boolean };

export function perfGateway(options: PerfGatewayOptions = {}): LibraryGateway {
  const summary = { root: "C:\\Lakomics" };
  const fresh = <T,>(make: () => T) => vi.fn().mockImplementation(async () => make());
  const cached = <T,>(make: () => T) => { const value = make(); return vi.fn().mockImplementation(async () => value); };
  return {
    resetJapaneseCatalogCheckpoint: vi.fn(),
    getCatalogVisibilityPolicy: vi.fn().mockResolvedValue({ hiddenCategories: [], blockedTags: [] }),
    setCatalogCategoryHidden: vi.fn(), setCatalogTagBlocked: vi.fn(),
    getIgdbCredentialStatus: vi.fn(), setIgdbCredentials: vi.fn(), deleteIgdbCredentials: vi.fn(), searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(), applyIgdbGame: vi.fn(), refreshIgdbGame: vi.fn(), getIgdbConnection: vi.fn().mockResolvedValue(null),
    replaceIgdbGameArtwork: vi.fn(), getTmdbCredentialStatus: vi.fn(), setTmdbToken: vi.fn(), deleteTmdbToken: vi.fn(),
    searchTmdbMovies: vi.fn(), previewTmdbMovie: vi.fn(), applyTmdbMovie: vi.fn(), refreshTmdbMovie: vi.fn(),
    getTmdbConnection: vi.fn().mockResolvedValue(null), replaceTmdbMovieArtwork: vi.fn(),
    openLibrary: vi.fn().mockResolvedValue(summary),
    importVckCatalog: vi.fn(),
    getOnlineCatalogStatus: vi.fn().mockResolvedValue({ installed: false, workCount: 0, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: null, lastSuccessAt: null, lastAdded: 0, lastError: null }),
    searchCatalogGroups: vi.fn(), getCatalogGroupEditions: vi.fn(), setCatalogGroupRepresentative: vi.fn(), listCatalogReview: vi.fn(),
    generateCatalogReview: vi.fn(), decideCatalogReview: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(),
    updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(),
    getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: true, apiBaseUrl: "https://example.invalid", tokenConfigured: true }),
    setCloudCaptureSettings: vi.fn(), setCloudApiToken: vi.fn(), deleteCloudApiToken: vi.fn(),
    testCloudCaptureConnection: vi.fn().mockResolvedValue({ pendingCount: 0 }),
    runDueCloudCaptureSync: fresh(() => ({ attempted: 0, acknowledged: 0, failed: 0, reviewPending: 0, added: 0, videoAdded: 0, classificationChanged: 0 })),
    cloudBackfillPreflight: vi.fn(), cloudBackfillSeed: vi.fn(), cloudBackfillRunCycle: vi.fn(),
    cloudBackfillProgress: (options.stableProgress ? cached : fresh)(() => ({ controlState: "idle", replicationEnabled: true, totalAssets: TOTAL_ASSETS, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: TOTAL_ASSETS, failed: 0, activeWorkers: 0, lastError: null, activity: [] })),
    cloudBackfillRetryFailed: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(),
    getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(),
    getExtensionConnection: vi.fn(),
    listClassifications: fresh(() => perfClassifications.map(entry => ({ ...entry }))),
    listAlbums: fresh(() => []),
    createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(), deleteClassification: vi.fn(),
    listAssets: vi.fn().mockImplementation(listAssetsPaged),
    listAssetDateBuckets: fresh(() => [{ date: "2026-08-01", count: TOTAL_ASSETS }]),
    listAssetCreators: vi.fn().mockResolvedValue([]),
    getRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    prepareRevisitColorBundle: vi.fn().mockResolvedValue(null),
    reshuffleRevisitBundle: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined), recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    indexMissingSimilarityHashes: vi.fn().mockResolvedValue({ indexed: 0, remaining: 0, failed: 0 }),
    listSimilarityReviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }),
    decideSimilarityReview: vi.fn(),
    getAsset: vi.fn().mockImplementation(async (id: string) => perfAsset(Number(id.replace("asset-", "")))),
    updateAssetMetadata: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0, totalBytes: 0 }),
    emptyTrash: vi.fn(), getTrashPolicy: vi.fn().mockResolvedValue({ retentionDays: 30 }), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn().mockResolvedValue(null), listMetadataBackups: vi.fn().mockResolvedValue([]), restoreMetadataBackup: vi.fn(),
    purgeExpiredTrash: vi.fn().mockResolvedValue({ deletedCount: 0, failedAssetIds: [] }),
    setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(), getAssetClassifications: vi.fn().mockResolvedValue([]), setAssetClassification: vi.fn(),
    patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]),
    listCollections: fresh(() => Array.from({ length: 60 }, (_, index) => perfCollection(index))),
    searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null),
    createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(),
    getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(null), getCollectionSourceRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn().mockResolvedValue({ processed: 0, remaining: 0, failed: 0, changedAssetIds: [] }),
    retryVideoPreparation: vi.fn().mockResolvedValue(undefined), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), setCollectionSourceRoot: vi.fn(),
    importCollectionArtworks: vi.fn().mockResolvedValue(0),
    listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn().mockResolvedValue([]), listCollectionVolumes: vi.fn().mockResolvedValue([]),
    syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(),
    getKakaoCredentialStatus: vi.fn(), setKakaoApiKey: vi.fn(), deleteKakaoApiKey: vi.fn(), searchKakao: vi.fn(), applyKakao: vi.fn(), refreshKakao: vi.fn(),
    getBookConnection: vi.fn(),
    getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
    setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
    takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]),
    runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    // Optional desktop methods the real client (`library/client.ts`) provides and polls.
    getEncryptedVaultStatus: (options.stableVault ? cached : fresh)(() => ({ state: "absent" as const, vaultId: null, root: null, itemCount: null, remembered: false })),
    similarityReviewInboundStatus: fresh(() => ({ applied: 0 })),
    authoritySyncHealth: fresh(() => ({
      albums: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null },
      classifications: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null },
      assets: { rejectedCount: 0, rejectedReason: null, stopped: false },
      authorityPassFailure: null, assetLaneFailure: null,
    })),
    runDueMobilePublications: vi.fn().mockResolvedValue(undefined),
  } as unknown as LibraryGateway;
}

/** Calls per gateway method since the last `resetCalls`. */
export function gatewayCalls(gateway: LibraryGateway): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(gateway)) {
    const calls = (value as { mock?: { calls: unknown[] } })?.mock?.calls.length ?? 0;
    if (calls > 0) out[name] = calls;
  }
  return out;
}

export function resetCalls(gateway: LibraryGateway) {
  for (const value of Object.values(gateway)) (value as { mockClear?: () => void })?.mockClear?.();
}
