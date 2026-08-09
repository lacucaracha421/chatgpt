export type LibrarySummary = {
  root: string;
  assetCount: number;
};

export type ClassificationKind = "root" | "work" | "tag";

export type AssetSort = "newest" | "oldest" | "favorites" | "random";

export type AssetView =
  | { kind: "classification"; classificationId: string | null }
  | { kind: "unsorted" }
  | { kind: "favorites" }
  | { kind: "recent" }
  | { kind: "similarity_review" }
  | { kind: "trash" };

export type ClassificationEntry = {
  id: string;
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
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
  media: MediaSummary;
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
  processed: number;
  remaining: number;
  failed: number;
};

export type SimilarityDecisionOutcome = {
  status: "resolved";
  nextReviewId: string | null;
};

export type AssetQuery = {
  classificationId: string | null;
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

export type AssetClassificationPatch = {
  assetIds: string[];
  addClassificationIds: string[];
  removeClassificationIds: string[];
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

export type IngestMediaInput = {
  sourcePath: string;
  classificationId: string | null;
  sourceUrl: string | null;
};

export type VideoPreparationProgress = {
  processed: number;
  remaining: number;
  failed: number;
  changedAssetIds: string[];
};

export type IngestOutcome =
  | { status: "added"; asset: AssetSummary }
  | { status: "exact_duplicate"; existingAssetId: string }
  | { status: "review_pending"; reviewId: string };

export interface LibraryGateway {
  openLibrary(path: string): Promise<LibrarySummary>;
  currentLibrary(): Promise<LibrarySummary | null>;
  listClassifications(): Promise<ClassificationEntry[]>;
  createClassification(input: CreateClassification): Promise<ClassificationEntry>;
  renameClassification(id: string, name: string): Promise<void>;
  moveClassification(id: string, parentId: string | null): Promise<void>;
  deleteClassification(id: string): Promise<void>;
  listAssets(query: AssetQuery): Promise<AssetPage>;
  indexMissingSimilarityHashes(): Promise<SimilarityIndexProgress>;
  listSimilarityReviews(query: {
    after: AssetCursor | null;
    limit: number;
  }): Promise<SimilarityReviewPage>;
  decideSimilarityReview(request: {
    reviewId: string;
    decision: SimilarityDecision;
  }): Promise<SimilarityDecisionOutcome>;
  getAsset(assetId: string): Promise<AssetSummary>;
  trashAsset(assetId: string): Promise<void>;
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
  setAssetClassifications(assetId: string, classificationIds: string[]): Promise<void>;
  patchAssetClassifications(patch: AssetClassificationPatch): Promise<void>;
  getAssetClassifications(assetId: string): Promise<string[]>;
  ingestMedia(input: IngestMediaInput): Promise<IngestOutcome>;
  preparePendingVideos(limit: number): Promise<VideoPreparationProgress>;
  retryVideoPreparation(assetId: string): Promise<VideoPreparationState>;
}
