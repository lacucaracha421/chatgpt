export type AvPersonRole = "performer" | "director";
export type AvPerson = { id: string; displayName: string };
export type AvPortrait =
  | { kind: "crop"; artworkId: string; revision: string; rect: { x: number; y: number; w: number; h: number } }
  | ({ kind: "stashdb" } & AvStashdbPreview)
  | { kind: "commons"; dataUrl: string; fileName: string; author: string | null; license: string | null; licenseUrl: string | null; sourceUrl: string };
export type AvPersonCredit = AvPerson & {
  role: AvPersonRole; order: number; creditName: string | null; nameJa: string | null; workCount: number; portrait: AvPortrait | null;
};
export type AvDetails = {
  collectionId: string; revision: number; productCode: string | null; label: string | null;
  series: string | null; people: AvPersonCredit[]; titleJa: string | null; releaseDate: string | null; maker: string | null;
  genres: string[]; makerCount: number; labelCount: number; seriesCount: number;
};
export type AvPersonInput = {
  person: { kind: "existing"; id: string } | { kind: "new"; displayName: string };
  role: AvPersonRole; creditName: string | null;
};
export type SaveAvDetails = {
  expectedRevision: number; productCode: string | null; label: string | null; series: string | null;
  people: AvPersonInput[];
};
export type CoverSurface = "front" | "spine" | "back";
export const COVER_SURFACES: CoverSurface[] = ["front", "spine", "back"];
export const SURFACE_LABEL: Record<CoverSurface, string> = { front: "앞면", spine: "책등", back: "뒷면" };
export type AvCoverSet = { frontId: string | null; spineId: string | null; backId: string | null; revision: string };
export type LocalArtworkPreview = {
  path: string; surface: CoverSurface; sha256: string; width: number; height: number;
  mimeType: string; thumbnailDataUrl: string;
};
export type ArtworkDecision = { kind: "keep" } | { kind: "clear" } | { kind: "local"; path: string; sha256: string };
export type ApplyAvArtwork = { expectedRevision: string } & Record<CoverSurface, ArtworkDecision>;
export type AvWorkCard = {
  collectionId: string; name: string; productCode: string | null; releaseDate: string | null;
  frontArtworkId: string | null; spineArtworkId: string | null; backArtworkId: string | null; coverRevision: string;
};
export type AvRelated = {
  performers: { personId: string; displayName: string; total: number; items: AvWorkCard[] }[];
  series: { name: string; total: number; items: (AvWorkCard & { current: boolean })[] } | null;
  label: { name: string; total: number; items: AvWorkCard[] } | null;
};
export type AvPerformerPage = {
  person: { id: string; displayName: string; nameJa: string | null; wikidataId: string | null; fanzaActressId: string | null; memo: string | null; portrait: AvPortrait | null };
  stats: { workCount: number; firstRelease: string | null; lastRelease: string | null; averageScore: number | null };
  works: (AvWorkCard & { role: AvPersonRole; solo: boolean })[];
  coPerformers: { id: string; displayName: string; count: number; portrait: AvPortrait | null }[];
  labels: { name: string; count: number }[];
};
export type AvPortraitSource = { collectionId: string; name: string; productCode: string | null; artworkId: string; revision: string; solo: boolean; width: number; height: number };
export type AvCommonsPreview = { dataUrl: string; fileName: string; author: string | null; license: string | null; licenseUrl: string | null; sourceUrl: string };
export type PortraitRect = { x: number; y: number; w: number; h: number };
export type AvStashdbPreview = { dataUrl: string; width: number; height: number; sourceUrl: string };
export type AvProfileImage = { id: string; url: string; width: number; height: number };
export type AvProfileCandidate = { stashdbId: string; name: string; aliases: string[]; birthDate: string | null; imageUrl: string | null };
export type AvPerformerProfile = {
  personId: string; source: "stashdb"; status: "matched" | "none" | "ambiguous";
  stashdbId: string | null; name: string | null; aliases: string[]; birthDate: string | null;
  heightCm: number | null; bandIn: number | null; waistIn: number | null; hipIn: number | null;
  cup: string | null; breastType: "NATURAL" | "FAKE" | "NA" | null;
  careerStart: number | null; careerEnd: number | null;
  urls: { url: string; site: { name: string } }[]; images: AvProfileImage[];
  candidates: AvProfileCandidate[]; fetchedAt: string;
};
export interface AvGateway {
  getStashdbCredentialStatus(): Promise<{ configured: boolean }>;
  getPerformerProfile(personId: string): Promise<AvPerformerProfile | null>;
  refreshPerformerProfile(personId: string, force: boolean): Promise<AvPerformerProfile | null>;
  searchPerformerProfile(personId: string): Promise<AvPerformerProfile>;
  choosePerformerProfile(personId: string, stashdbId: string): Promise<AvPerformerProfile>;
  dismissPerformerProfile(personId: string): Promise<AvPerformerProfile>;
  clearPerformerProfile(personId: string): Promise<void>;
  previewStashdbPortrait(personId: string, imageId: string): Promise<AvStashdbPreview>;
  useStashdbPortrait(personId: string): Promise<AvPortrait>;
  getDetails(collectionId: string): Promise<AvDetails>;
  saveDetails(collectionId: string, input: SaveAvDetails): Promise<AvDetails>;
  searchPeople(query: string): Promise<AvPerson[]>;
  previewArtwork(path: string, surface: CoverSurface): Promise<LocalArtworkPreview>;
  applyArtwork(collectionId: string, input: ApplyAvArtwork): Promise<AvCoverSet>;
  getCoverSet(collectionId: string): Promise<AvCoverSet>;
  getRelated(collectionId: string): Promise<AvRelated>;
  getPerformer(personId: string): Promise<AvPerformerPage>;
  savePersonMemo(personId: string, memo: string | null): Promise<AvPerformerPage>;
  listPortraitSources(personId: string): Promise<AvPortraitSource[]>;
  setPortraitCrop(personId: string, artworkId: string, rect: PortraitRect): Promise<AvPortrait>;
  previewCommonsPortrait(personId: string): Promise<AvCommonsPreview | null>;
  useCommonsPortrait(personId: string): Promise<AvPortrait>;
  clearPortrait(personId: string): Promise<null>;
}
