export type LibrarySummary = {
  root: string;
};

export type CatalogStatus = {
  installed: boolean;
  workCount: number;
  updateEnabled: boolean;
  updateIntervalSeconds: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastAdded: number;
  lastError: string | null;
};

export type CatalogUpdateResult = {
  added: number;
  pages: number;
  reason: "completed" | "upToDate" | "pageLimit" | "rateLimited" | "alreadyRunning";
  lastSuccessAt: string | null;
};

export type RemoteProvider = "kHentai";

export type ResolvedGallery = {
  provider: RemoteProvider;
  workId: string;
  pageCount: number;
  pageUrls: string[];
};

export type RemoteReadingProgress = {
  provider: RemoteProvider;
  workId: string;
  lastPage: number;
  pageCount: number;
  lastReadAt: string;
};

export type CatalogSort = "latest" | "views" | "hotDay" | "hotWeek" | "hotMonth";
export type CatalogScope = "all" | "bookmarked";

export type CatalogSearchQuery = {
  text: string;
  sort: CatalogSort;
  scope: CatalogScope;
  page: number;
  pageSize: number;
};

export type CatalogSuggestion = { value: string; label: string; count: number };

export type CatalogWork = {
  id: number;
  title: string;
  titleJpn: string | null;
  artists: string[];
  series: string[];
  thumbnailUrl: string | null;
  bookmarked: boolean;
  fileCount: number;
  views: number;
  posted: number;
};

export type CatalogTagGroup = { namespace: string; values: string[] };

export type CatalogWorkDetail = {
  id: number;
  title: string;
  titleJpn: string | null;
  thumbnailUrl: string | null;
  uploader: string | null;
  category: number | null;
  posted: number | null;
  updated: number | null;
  fileCount: number;
  fileSize: number | null;
  rating: number | null;
  views: number;
  bookmarked: boolean;
  tagGroups: CatalogTagGroup[];
};

export type CatalogSearchPage = {
  works: CatalogWork[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type ExtensionConnection = {
  baseUrl: string;
  token: string;
  status: "ready" | "bind_failed";
};

export type ClassificationKind = "root" | "work" | "tag";

export type AssetSort = "newest" | "oldest" | "favorites" | "random";

export type AssetView =
  | { kind: "classification"; classificationId: string | null }
  | { kind: "album"; albumId: string }
  | { kind: "unsorted" }
  | { kind: "favorites" }
  | { kind: "recent" }
  | { kind: "similarity_review" }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "manga" }
  | { kind: "collections"; typeFilter: CollectionType | null; showcase: boolean }
  | { kind: "collection"; collectionId: string };

export type ClassificationEntry = {
  id: string;
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
  iconKey: string | null;
  colorKey: string | null;
};

export type AlbumEntry = {
  id: string;
  name: string;
  parentId: string | null;
  iconKey: string | null;
  colorKey: string | null;
};

export type CollectionType = "game" | "manga" | "movie";

export type CollectionSummary = {
  id: string;
  name: string;
  description: string | null;
  type: CollectionType;
  coverAssetId: string | null;
  selectedWorkArtworkId: string | null;
  assetCount: number;
  unreadReleaseCount: number;
  year: number | null;
  author: string | null;
  director: string | null;
  externalScore: number | null;
  myScore: number | null;
  genres: string | null;
  overview: string | null;
  showcase: boolean;
  createdAt: string;
  updatedAt: string;
  sourcePath?: string | null;
};

export type CreateCollection = {
  name: string;
  description: string | null;
  type: CollectionType;
};

export type ReleaseWatchStatus = {
  enabled: boolean;
  lastCheckedAt: string | null;
};

export type ReleaseWatchEvent = {
  id: string;
  kind: "new_volume" | "release_date_changed" | "release_status_changed";
  volumeNumber: number;
  previousValue: string | null;
  currentValue: string | null;
  detectedAt: string;
};

export type ReleaseWatchRunResult = {
  checked: number;
  changedCollections: number;
  skipped: number;
  stopReason:
    | "credential_not_configured"
    | "invalid_credential"
    | "rate_limited"
    | "timed_out"
    | "unavailable"
    | "invalid_response"
    | null;
};

export type MangaDexSearchResult = {
  mangaId: string;
  title: string;
  alternateTitles: string[];
  author: string | null;
  year: number | null;
  status: string | null;
  primaryCoverFileName: string | null;
};

export type MangaDexCoverCandidate = {
  coverId: string;
  fileName: string;
  volume: string | null;
  language: string | null;
};

export type MangaDexWorkPreview = {
  mangaId: string;
  proposedTitle: string;
  alternateTitles: string[];
  author: string | null;
  year: number | null;
  status: string | null;
  genres: string | null;
  overview: string | null;
  covers: MangaDexCoverCandidate[];
};

export type MangaDexApplyTarget =
  | { kind: "new"; name: string }
  | { kind: "existing"; collectionId: string };

export type MangaDexApplyRequest = {
  target: MangaDexApplyTarget;
  mangaId: string;
};

export type MangaDexConnection = {
  mangaId: string;
  lastSyncedAt: string | null;
};

export type AladinCredentialStatus = { configured: boolean };

export type AladinConnection = {
  anchorItemId: string;
  query: string;
  lastSyncedAt: string | null;
};

export type AladinSyncResult = {
  added: number;
  updated: number;
  unchanged: number;
  ignored: number;
};

export type AladinVolumeCandidate = {
  volumeNumber: number;
  providerItemId: string;
  title: string;
  publicationDate: string | null;
  isbn13: string | null;
};

export type AladinSeriesCandidate = {
  anchorItemId: string;
  groupFingerprint: string;
  title: string;
  author: string | null;
  publisher: string | null;
  volumes: AladinVolumeCandidate[];
  ignoredCount: number;
};

export type AladinApplyRequest = {
  collectionId: string;
  query: string;
  anchorItemId: string;
  groupFingerprint: string;
};

export type CollectionVolume = {
  id: string;
  volumeNumber: number;
  editionIndex: number;
  displayLabel: string;
  coverArtworkId: string | null;
  localReleaseDate: string | null;
  isbn13: string | null;
  releaseStatus: "upcoming" | "released" | null;
};

export type MangaDexVolumeSyncResult = {
  completed: number;
  skipped: number;
  failed: number;
};

export type UpdateCollection = {
  name: string;
  description: string | null;
  type: CollectionType;
  year: number | null;
  author: string | null;
  director: string | null;
  externalScore: number | null;
  myScore: number | null;
};

export type AssetCollectionPatch = {
  assetIds: string[];
  addCollectionIds: string[];
  removeCollectionIds: string[];
};

export type VideoPreparationState =
  | "pending"
  | "processing"
  | "ready"
  | "failed";

export type MediaSummary =
  | { kind: "image" }
  | { kind: "gif" }
  | {
      kind: "video";
      durationMs: number;
      preparationState: VideoPreparationState;
      scrubFrameCount: number;
    };

export type ImportSource =
  | "direct"
  | "browser_extension"
  | "metadata_import"
  | "legacy_lakomics";

export type AssetSummary = {
  id: string;
  title: string | null;
  originalName: string;
  byteSize: number;
  width: number;
  height: number;
  collectedAt: string;
  favorite: boolean;
  sourceUrl: string | null;
  sourcePublishedAt: string | null;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorUrl: string | null;
  importSource: ImportSource | null;
  importBatchId: string | null;
  originalModifiedAt: string | null;
  media: MediaSummary;
};

export type AssetMetadataPatch = {
  assetId: string;
  sourcePublishedAt: string | null;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorUrl: string | null;
};

export type AssetCursor = {
  token: string;
};

export type SimilarityDecision =
  | "keep_existing"
  | "replace_existing"
  | "keep_both";

export type SimilarityReviewAsset = {
  asset: AssetSummary;
  format: string;
  classifications: ClassificationEntry[];
};

export type SimilarityReviewSummary = {
  id: string;
  distance: number;
  existing: SimilarityReviewAsset;
  candidate: SimilarityReviewAsset;
};

export type SimilarityReviewPage = {
  items: SimilarityReviewSummary[];
  nextCursor: AssetCursor | null;
  totalCount: number;
};

export type SimilarityIndexProgress = {
  remaining: number;
  failed: number;
};

export type AssetQuery = {
  classificationId: string | null;
  albumId: string | null;
  collectionId: string | null;
  directOnly: boolean;
  favoriteOnly: boolean;
  unclassifiedOnly: boolean;
  sort: AssetSort;
  randomPivot: string | null;
  after: AssetCursor | null;
  limit: number;
};

export type AssetPage = {
  items: AssetSummary[];
  nextCursor: AssetCursor | null;
};

export type AssetAlbumPatch = {
  assetIds: string[];
  addAlbumIds: string[];
  removeAlbumIds: string[];
};

export type SetAssetClassification = {
  assetIds: string[];
  classificationId: string | null;
};

export type TrashPolicy = { retentionDays: number | null };

export type TrashAssetSummary = {
  asset: AssetSummary;
  trashedAt: string;
  purgeAt: string | null;
};

export type TrashPage = {
  items: TrashAssetSummary[];
  nextCursor: AssetCursor | null;
  totalCount: number;
  totalBytes: number;
};

export type PurgeSummary = {
  deletedCount: number;
  failedAssetIds: string[];
};

export type MangaSeries = {
  id: string;
  title: string;
  author: string;
  pageCount: number;
};

export type MetadataBackup = {
  id: string;
  kind: "daily" | "pre_migration" | "pre_restore";
  createdAt: string;
  byteSize: number;
};

export type CreateClassification = {
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
};

export type CreateAlbum = {
  name: string;
  parentId: string | null;
};

export type IngestMediaInput = {
  sourcePath: string;
  classificationId: string | null;
  sourceUrl: string | null;
  collectedAt?: string | null;
  replaceDuplicateMetadata?: boolean;
  sourcePublishedAt?: string | null;
  creatorName?: string | null;
  creatorHandle?: string | null;
  creatorUrl?: string | null;
  importSource: "direct" | "browser_extension" | "metadata_import" | "legacy_lakomics";
  importBatchId: string;
};

export type MetadataImportPlan = {
  metadataFile: string;
  classificationPaths: string[][];
  items: Array<{
    fileName: string;
    sourcePath: string;
    classificationPath: string[];
    sourceUrl: string;
    collectedAt: string;
  }>;
  skipped: Array<{
    fileName: string;
    reason: "missing_file" | "invalid_source_url" | "invalid_collected_at";
  }>;
};

export type VideoPreparationProgress = {
  processed: number;
  remaining: number;
  failed: number;
  changedAssetIds: string[];
};

export type IngestOutcome =
  | { status: "added"; asset: AssetSummary }
  | { status: "exact_duplicate"; existingAssetId: string; classificationChanged: boolean; metadataChanged?: boolean }
  | { status: "review_pending"; reviewId: string };

export interface LibraryGateway {
  openLibrary(path: string): Promise<LibrarySummary>;
  importVckCatalog(vckRoot: string): Promise<CatalogStatus>;
  getOnlineCatalogStatus(): Promise<CatalogStatus>;
  searchOnlineCatalog(query: CatalogSearchQuery): Promise<CatalogSearchPage>;
  suggestOnlineCatalog(text: string, limit: number): Promise<CatalogSuggestion[]>;
  getOnlineCatalogWorkDetail(workId: number): Promise<CatalogWorkDetail>;
  setOnlineCatalogBookmark(workId: number, bookmarked: boolean): Promise<void>;
  updateOnlineCatalog(): Promise<CatalogUpdateResult>;
  setOnlineCatalogUpdateSettings(enabled: boolean, intervalSeconds: number): Promise<CatalogStatus>;
  runDueOnlineCatalogUpdate(): Promise<CatalogUpdateResult | null>;
  resolveOnlineCatalogWork(workId: number): Promise<ResolvedGallery>;
  getRemoteReadingProgress(provider: RemoteProvider, workId: string): Promise<RemoteReadingProgress | null>;
  saveRemoteReadingProgress(progress: RemoteReadingProgress): Promise<void>;
  clearRemoteMangaCache(): Promise<void>;
  getExtensionConnection(): Promise<ExtensionConnection>;
  listClassifications(): Promise<ClassificationEntry[]>;
  createClassification(input: CreateClassification): Promise<ClassificationEntry>;
  renameClassification(id: string, name: string): Promise<void>;
  moveClassification(id: string, parentId: string | null): Promise<void>;
  updateClassificationAppearance(
    id: string,
    iconKey: string | null,
    colorKey: string | null,
  ): Promise<void>;
  deleteClassification(id: string): Promise<void>;
  listAlbums(): Promise<AlbumEntry[]>;
  createAlbum(input: CreateAlbum): Promise<AlbumEntry>;
  renameAlbum(id: string, name: string): Promise<void>;
  moveAlbum(id: string, parentId: string | null): Promise<void>;
  updateAlbumAppearance(id: string, iconKey: string | null, colorKey: string | null): Promise<void>;
  deleteAlbum(id: string): Promise<void>;
  listAssets(query: AssetQuery): Promise<AssetPage>;
  indexMissingSimilarityHashes(): Promise<SimilarityIndexProgress>;
  listSimilarityReviews(query: {
    after: AssetCursor | null;
    limit: number;
  }): Promise<SimilarityReviewPage>;
  decideSimilarityReview(request: {
    reviewId: string;
    decision: SimilarityDecision;
  }): Promise<void>;
  getAsset(assetId: string): Promise<AssetSummary>;
  updateAssetMetadata(request: AssetMetadataPatch): Promise<AssetSummary>;
  trashAssets(assetIds: string[]): Promise<void>;
  restoreAsset(assetId: string): Promise<void>;
  restoreAssets(assetIds: string[]): Promise<void>;
  listTrash(query: { after: AssetCursor | null; limit: number }): Promise<TrashPage>;
  emptyTrash(): Promise<PurgeSummary>;
  getTrashPolicy(): Promise<TrashPolicy>;
  setTrashPolicy(policy: TrashPolicy): Promise<void>;
  ensureDailyBackup(): Promise<MetadataBackup | null>;
  listMetadataBackups(): Promise<MetadataBackup[]>;
  restoreMetadataBackup(backupId: string): Promise<void>;
  purgeExpiredTrash(): Promise<PurgeSummary>;
  setAssetFavorite(assetId: string, favorite: boolean): Promise<void>;
  setAssetsFavorite(assetIds: string[], favorite: boolean): Promise<void>;
  getAssetClassifications(assetId: string): Promise<string[]>;
  setAssetClassification(request: SetAssetClassification): Promise<void>;
  patchAssetAlbums(patch: AssetAlbumPatch): Promise<void>;
  getAssetAlbums(assetId: string): Promise<string[]>;
  listCollections(): Promise<CollectionSummary[]>;
  searchMangaDex(query: string): Promise<MangaDexSearchResult[]>;
  previewMangaDex(mangaId: string): Promise<MangaDexWorkPreview>;
  applyMangaDex(request: MangaDexApplyRequest): Promise<CollectionSummary>;
  refreshMangaDex(collectionId: string): Promise<CollectionSummary>;
  getMangaDexConnection(collectionId: string): Promise<MangaDexConnection | null>;
  getAladinCredentialStatus(): Promise<AladinCredentialStatus>;
  setAladinTtbKey(ttbKey: string): Promise<AladinCredentialStatus>;
  deleteAladinTtbKey(): Promise<AladinCredentialStatus>;
  searchAladin(query: string): Promise<AladinSeriesCandidate[]>;
  applyAladin(request: AladinApplyRequest): Promise<AladinSyncResult>;
  refreshAladin(collectionId: string): Promise<AladinSyncResult>;
  getAladinConnection(collectionId: string): Promise<AladinConnection | null>;
  getReleaseWatchStatus(collectionId: string): Promise<ReleaseWatchStatus>;
  setReleaseWatchEnabled(
    collectionId: string,
    enabled: boolean,
  ): Promise<ReleaseWatchStatus>;
  takeUnreadReleaseChanges(collectionId: string): Promise<ReleaseWatchEvent[]>;
  runDueReleaseWatch(): Promise<ReleaseWatchRunResult>;
  createCollection(input: CreateCollection): Promise<CollectionSummary>;
  updateCollection(id: string, input: UpdateCollection): Promise<CollectionSummary>;
  deleteCollection(id: string): Promise<void>;
  setCollectionCover(collectionId: string, assetId: string | null): Promise<CollectionSummary>;
  setCollectionShowcase(collectionId: string, showcase: boolean): Promise<CollectionSummary>;
  getAssetCollections(assetId: string): Promise<string[]>;
  patchAssetCollections(patch: AssetCollectionPatch): Promise<void>;
  getMangaRoot(): Promise<string | null>;
  setMangaRoot(path: string | null): Promise<void>;
  scanManga(): Promise<number>;
  listMangaSeries(): Promise<MangaSeries[]>;
  inspectMetadataImport?(folder: string): Promise<MetadataImportPlan>;
  ingestMedia(input: IngestMediaInput): Promise<IngestOutcome>;
  preparePendingVideos(limit: number): Promise<VideoPreparationProgress>;
  retryVideoPreparation(assetId: string): Promise<void>;
  inspectBookImport(root: string): Promise<BookImportPlan>;
  importBookCollections(root: string): Promise<BookMigrationReport>;
  getCollectionSourceRoot(): Promise<string | null>;
  setCollectionSourceRoot(path: string | null): Promise<void>;
  listCollectionCovers(collectionId: string): Promise<CollectionCover[]>;
  listCollectionVolumes(collectionId: string): Promise<CollectionVolume[]>;
  syncMangaDexVolumeCovers(collectionId: string): Promise<MangaDexVolumeSyncResult>;
}

export type BookExternalBinding = {
  provider: string;
  externalId: string;
};

export type BookImportEntry = {
  folder: string;
  collectionType: CollectionType;
  name: string;
  year: number | null;
  author: string | null;
  director: string | null;
  myScore: number | null;
  genres: string | null;
  overview: string | null;
  externalBindings: BookExternalBinding[];
};

export type BookMigrationError = {
  folder: string;
  message: string;
};

export type BookImportPlan = {
  root: string;
  entries: BookImportEntry[];
  skipped: BookMigrationError[];
};

export type BookMigrationReport = {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  errors: BookMigrationError[];
};

export type CollectionCover = {
  fileName: string;
  shelf: number;
  volumeLabel: string;
};
