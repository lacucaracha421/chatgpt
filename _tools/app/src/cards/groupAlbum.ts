import { tierRank, type CardData, type CardTier } from "./types";

/** Series → characters → the cards owned of each, best tier first. Shared by the PC and tablet albums. */
export function groupAlbum(cards: readonly CardData[], tier: CardTier | "all" = "all") {
  const series = new Map<string, Map<string, CardData[]>>();
  for (const card of cards) {
    if (tier !== "all" && card.tier !== tier) continue;
    const name = card.seriesName || "시리즈 없음", character = card.characterId ?? card.id;
    if (!series.has(name)) series.set(name, new Map());
    const characters = series.get(name)!;
    characters.set(character, [...(characters.get(character) ?? []), card].sort((a, b) => tierRank(b.tier) - tierRank(a.tier)));
  }
  return [...series].sort(([a], [b]) => a.localeCompare(b, "ko"));
}
