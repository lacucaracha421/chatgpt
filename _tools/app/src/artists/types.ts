/**
 * 작가 hub (ARTIST-001). An artist id is `artist:<id>` for an artist the user touched, or the
 * bare creator key (handle or creator URL) of an untouched one. `unknown:none` and
 * `unknown:source` scope images without an artist (작가 미상), with no source or with a source.
 */
export const UNKNOWN_NONE = "unknown:none";
export const UNKNOWN_SOURCE = "unknown:source";
export const isUnknownArtist = (id: string) => id === UNKNOWN_NONE || id === UNKNOWN_SOURCE;

export type ArtistSettings = { mainMinCount: number; recentMinCount: number; recentDays: number };

export type ArtistExcludedFolder = { id: string; breadcrumb: string; imageCount: number };

export type ArtistSummary = {
  id: string;
  label: string;
  displayName: string | null;
  sourceName: string | null;
  keys: string[];
  assetCount: number;
  recentCount: number;
  firstSavedAt: string | null;
  lastSavedAt: string | null;
  lastOpenedAt: string | null;
  pinned: boolean;
  hidden: boolean;
  reposter: boolean;
  main: boolean;
  coverAssetIds: string[];
};

export type ArtistOverview = {
  settings: ArtistSettings;
  total: number;
  main: number;
  other: number;
  twoToFour: number;
  single: number;
  hidden: number;
  reposter: number;
  styleSuggestionCount: number;
  unknownNone: number;
  unknownSource: number;
  mergeSuggestions: number;
  sourceFillable: number;
  pinned: ArtistSummary[];
};

export type ArtistBucket = "all" | "pinned" | "main" | "other" | "twoToFour" | "single" | "hidden" | "reposter";
export type ArtistSort = "recent" | "count" | "name";
export type ArtistListQuery = { search?: string | null; bucket?: ArtistBucket; sort?: ArtistSort; offset?: number; limit?: number };
export type ArtistListPage = { total: number; artists: ArtistSummary[] };

export type ArtistMemberInfo = { key: string; name: string | null; host: string | null; assetCount: number };
export type ArtistAssignmentInfo = { source: "manual" | "source_url"; assetCount: number; latestAt: string | null };
export type ArtistRediscovery = { total: number; assetIds: string[]; yearsAgo: number | null; localDate: string | null };

export type ArtistMergeSuggestion = {
  keyA: string;
  keyB: string;
  kind: "handle" | "name" | "similar";
  uncertain: boolean;
  left: ArtistSummary;
  right: ArtistSummary;
};

export type ArtistDetail = {
  summary: ArtistSummary;
  members: ArtistMemberInfo[];
  assignments: ArtistAssignmentInfo[];
  sources: { host: string; count: number }[];
  onThisDay: ArtistRediscovery | null;
  longUnseen: ArtistRediscovery | null;
  mergeSuggestions: ArtistMergeSuggestion[];
};

export type ArtistTodayRow = { artist: ArtistSummary; kind: "anniversary" | "unseen" | "fresh"; reason: string; assetIds: string[] };

export type SourceFillPreview = {
  total: number;
  sites: { host: string; assetCount: number; method: "auto" | "manual"; fillable: number }[];
  fillable: number;
  withoutHandle: number;
  existingArtists: number;
  newArtists: number;
  groups: { handle: string; assetCount: number; sampleAssetIds: string[]; targetId: string | null; targetLabel: string | null }[];
};

export type ArtistCaptionLabels = { byKey: Record<string, string>; byAsset: Record<string, string> };

export interface ArtistGateway {
  overview(): Promise<ArtistOverview>;
  /** Offset/limit count artist groups; each group contains all its candidates. */
  styleSuggestions(offset: number, limit: number): Promise<ArtistStylePage>;
  styleSuggestion(assetId: string): Promise<ArtistStyleSuggestion | null>;
  dismissStyleSuggestion(assetIds: string[], artistId: string): Promise<void>;
  importStyleFeatures(path: string): Promise<{ imported: number; skipped: number }>;
  styleStatus(): Promise<ArtistStyleStatus>;
  list(query: ArtistListQuery): Promise<ArtistListPage>;
  detail(artistId: string, localDate: string, offsetMinutes: number): Promise<ArtistDetail>;
  today(localDate: string, offsetMinutes: number, seed: number, excluded: string[]): Promise<ArtistTodayRow[]>;
  mergeSuggestions(): Promise<ArtistMergeSuggestion[]>;
  sourceFillPreview(): Promise<SourceFillPreview>;
  applySourceFill(): Promise<{ assigned: number; createdArtists: number }>;
  captionLabels(): Promise<ArtistCaptionLabels>;
  /** Each write returns the artist id to show next. */
  setDisplayName(artistId: string, displayName: string | null): Promise<string>;
  setFlags(artistId: string, flags: { pinned?: boolean; hidden?: boolean; reposter?: boolean }): Promise<string>;
  merge(targetId: string, sourceIds: string[], displayName: string | null): Promise<string>;
  detachMember(artistId: string, creatorKey: string): Promise<string>;
  detachAssignments(artistId: string, source: "manual" | "source_url"): Promise<string>;
  dismissSuggestion(keyA: string, keyB: string): Promise<void>;
  assignAssets(assetIds: string[], target: { artistId: string } | { newName: string }): Promise<string>;
  setSettings(settings: ArtistSettings): Promise<ArtistSettings>;
  listExcludedFolders(): Promise<ArtistExcludedFolder[]>;
  setExcludedFolders(ids: string[]): Promise<void>;
}

export type ArtistStyleCandidate = { assetId: string; score: number };
export type ArtistStyleGroup = {
  artist: ArtistSummary;
  candidates: ArtistStyleCandidate[];
  /** Up to four eligible reference images, ordered by their best candidate similarity. */
  referenceAssetIds: string[];
};
export type ArtistStylePage = { totalImages: number; totalArtists: number; groups: ArtistStyleGroup[]; upToDate?: boolean };
export type ArtistStyleSuggestion = {
  artist: ArtistSummary;
  score: number;
  /** Up to three eligible reference images, closest first. */
  referenceAssetIds: string[];
  runnerUp: { artist: ArtistSummary; score: number } | null;
};
/** Status polls do not start computation. Stale caches report zero suggestions.
 * List, inspector, and overview reads lazily refresh the cache off the UI thread.
 */
export type ArtistStyleStatus = { features: number; model: string | null; suggestions: number; computing: boolean };
