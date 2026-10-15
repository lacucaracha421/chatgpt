export type CardTier = "n" | "r" | "sr" | "ssr" | "ur" | "lr";

export interface CardData {
  id: string;
  characterName: string;
  seriesName: string;
  tier: CardTier;
  artUrl: string;
  artWidth: number;
  artHeight: number;
  cutoutUrl?: string;
  tint?: string;
  count: number;
  level: number;
  serial?: string;
  isNew?: boolean;
}

/** Cover art is supplied independently of the draw contents. */
export interface PackCover { imageUrls: readonly string[]; centreCutoutUrl?: string }
export interface CardPack { id: string; cover: PackCover; cardCount: number }
export interface CardDraw { packId: string; cards: readonly CardData[] }

export const cardTiers: readonly CardTier[] = ["n", "r", "sr", "ssr", "ur", "lr"];
export const tierRank = (tier: CardTier) => cardTiers.indexOf(tier);
export const tierClass = (tier: CardTier) => `card--${tier}${tierRank(tier) >= 3 ? " fa" : ""}`;

/** Stable low-to-high order, retaining the last best card for the user's final flip. */
export function revealOrder(cards: readonly CardData[], revealed: ReadonlySet<string>): string[] {
  const remaining = cards.filter(card => !revealed.has(card.id))
    .map((card, index) => ({ card, index }))
    .sort((a, b) => tierRank(a.card.tier) - tierRank(b.card.tier) || a.index - b.index);
  return remaining.slice(0, -1).map(({ card }) => card.id);
}

export const tearProgress = (distance: number, width: number) => Math.max(0, Math.min(1, distance / Math.max(1, width * .92)));
export const completesTear = (progress: number, velocity = 0) => progress >= .76 || (progress > .12 && velocity > 1.1);
