export type LibrarySummary = {
  root: string;
  assetCount: number;
};

export type ClassificationKind = "root" | "work" | "tag";

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
  setAssetClassifications(assetId: string, classificationIds: string[]): Promise<void>;
  getAssetClassifications(assetId: string): Promise<string[]>;
  ingestImage(input: IngestImageInput): Promise<IngestOutcome>;
}
