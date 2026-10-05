import type { AvPerformerProfile, AvPortrait } from "../avTypes";

/** An explicit portrait remains the first choice; an unchosen performer starts with StashDB. */
export function defaultPortraitSource(portrait: AvPortrait | null | undefined, profile: AvPerformerProfile | null, configured: boolean) {
  if (portrait) return portrait.kind;
  return configured && profile?.status === "matched" && profile.images.length > 0 ? "stashdb" : "crop";
}
