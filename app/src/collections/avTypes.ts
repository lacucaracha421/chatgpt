export type AvPersonRole = "performer" | "director";
export type AvPerson = { id: string; displayName: string };
export type AvPersonCredit = AvPerson & { role: AvPersonRole; order: number; creditName: string | null };
export type AvDetails = {
  collectionId: string; revision: number; productCode: string | null; label: string | null;
  series: string | null; people: AvPersonCredit[];
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
export interface AvGateway {
  getDetails(collectionId: string): Promise<AvDetails>;
  saveDetails(collectionId: string, input: SaveAvDetails): Promise<AvDetails>;
  searchPeople(query: string): Promise<AvPerson[]>;
  previewArtwork(path: string, surface: CoverSurface): Promise<LocalArtworkPreview>;
  applyArtwork(collectionId: string, input: ApplyAvArtwork): Promise<AvCoverSet>;
  getCoverSet(collectionId: string): Promise<AvCoverSet>;
}
