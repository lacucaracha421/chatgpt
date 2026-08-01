export type LibrarySummary = {
  root: string;
  assetCount: number;
};

export type ClassificationKind = "root" | "work" | "tag";

export type AssetSort = "newest" | "oldest" | "favorites" | "random";

export type AssetView =
  | { kind: "classification"; classificationId: string | null }
  | { kind: "favorites" }
  | { kind: "recent" };

export type ClassificationEntry = {
  id: string;
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
};

export type AssetSummary = {
  id: string;
  title: string | null;
  originalName: string;
  relativePath: string;
  thumbnailRelativePath: string;
  byteSize: number;
  width: number;
  height: number;
  collectedAt: string;
  favorite: boolean;
  sourceUrl: string | null;
};

export type AssetCursor = {
  token: string;
};

export type AssetQuery = {
  classificationId: string | null;
  directOnly: boolean;
  favoriteOnly: boolean;
  sort: AssetSort;
  randomPivot: string | null;
  after: AssetCursor | null;
  limit: number;
};

export type AssetPage = {
  items: AssetSummary[];
  nextCursor: AssetCursor | null;
};

export type CreateClassification = {
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
};

export type IngestImageInput = {
  sourcePath: string;
  classificationId: string | null;
  sourceUrl: string | null;
};

export type IngestOutcome =
  | { status: "added"; asset: AssetSummary }
  | { status: "exact_duplicate"; existingAssetId: string };

export interface LibraryGateway {
  openLibrary(path: string): Promise<LibrarySummary>;
  currentLibrary(): Promise<LibrarySummary | null>;
  listClassifications(): Promise<ClassificationEntry[]>;
  createClassification(input: CreateClassification): Promise<ClassificationEntry>;
  renameClassification(id: string, name: string): Promise<void>;
  moveClassification(id: string, parentId: string | null): Promise<void>;
  deleteClassification(id: string): Promise<void>;
  listAssets(query: AssetQuery): Promise<AssetPage>;
  setAssetFavorite(assetId: string, favorite: boolean): Promise<void>;
  setAssetClassifications(assetId: string, classificationIds: string[]): Promise<void>;
  getAssetClassifications(assetId: string): Promise<string[]>;
  ingestImage(input: IngestImageInput): Promise<IngestOutcome>;
}
