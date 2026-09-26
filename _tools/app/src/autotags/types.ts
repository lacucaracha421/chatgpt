/**
 * 자동 태그 (automatic image tags): Danbooru-named tags from an imported tagger output,
 * with the user's per-asset edits (`library/auto_tags.rs`). PC only.
 */
export type AutoTagCategory = "general" | "character" | "copyright" | "artist" | "meta" | "rating";

export type AssetAutoTag = {
  tag: string;
  category: AutoTagCategory;
  /** Null for a tag the user added that the tagger did not emit. */
  score: number | null;
  source: "model" | "added";
};

export type AssetAutoTags = { tags: AssetAutoTag[]; hasConfirmedCharacter: boolean };

export type AutoTagVocabularyEntry = { tag: string; category: AutoTagCategory; count: number };

export type AutoTagImportSummary = {
  model: string;
  importedAt: string;
  sourceName: string;
  taggedAssets: number;
  tagRows: number;
  skippedAssets: number;
};

export type AutoTagEdit = "add" | "remove" | "reset";

/** Every included tag and none of the excluded ones. */
export type AutoTagFilter = { include: string[]; exclude: string[] };

export interface AutoTagGateway {
  assetTags(assetId: string): Promise<AssetAutoTags>;
  vocabulary(): Promise<AutoTagVocabularyEntry[]>;
  edit(assetId: string, tag: string, edit: AutoTagEdit): Promise<void>;
  importSummary(): Promise<AutoTagImportSummary | null>;
  importFile(path: string): Promise<AutoTagImportSummary>;
}
