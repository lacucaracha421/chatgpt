import type { CharacterTarget } from "./api";
import type { ExtrasSuggestion } from "./extrasApi";
import namesData from "./taggerNamesKo.json";

const names: Record<string, { ko: string; sure: boolean }> = namesData;

/**
 * The Korean name a 기타 suggestion shows for an automatic tag. `sure: false` (an uncertain
 * transliteration, or no entry at all) means the person should check the spelling.
 */
export function extrasTagName(tag: string): { name: string; sure: boolean } {
  const entry = names[tag];
  if (entry?.ko) return { name: entry.ko, sure: entry.sure };
  // No entry: a readable form of the tag ("lawrence_(series)" becomes "lawrence").
  const name = tag.replace(/_\([^)]*\)$/, "").replace(/_/g, " ").trim();
  return { name: name || tag, sure: false };
}

/** The strongest suggestion of a 기타: the one with the most images (the backend sorts that way). */
export const strongestExtrasSuggestion = (suggestions: readonly ExtrasSuggestion[] | undefined) => suggestions?.[0] ?? null;

export const isExtrasTarget = (target: Pick<CharacterTarget, "role"> | null | undefined) => target?.role === "extras";
