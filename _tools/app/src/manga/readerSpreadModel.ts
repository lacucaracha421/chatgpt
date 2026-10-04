import type { MangaReadingDirection } from "../preferences/uiPreferences";

export type SpreadSide = "left" | "right";
export type SpreadAdvance = "next" | "prev";

/**
 * Logical double-page spread containing `page` (1-based).
 *
 * Pairing is logical, never visual: with cover-single enabled the spreads
 * are [1], [2, 3], [4, 5], ...; otherwise [1, 2], [3, 4], ... Reading
 * direction only changes display order, never membership.
 */
export function spreadForPage(page: number, pageCount: number, coverSingle: boolean): number[] {
  const current = Math.max(1, Math.min(pageCount, Math.floor(page)));
  if (!coverSingle) {
    const first = current % 2 === 1 ? current : current - 1;
    return current >= pageCount ? [current] : [first, Math.min(first + 1, pageCount)];
  }
  if (current === 1) return [1];
  const first = current % 2 === 0 ? current : current - 1;
  return first + 1 > pageCount ? [first] : [first, first + 1];
}

/** First logical page of the spread following `page`. Stays put on the last spread. */
export function nextSpreadStart(page: number, pageCount: number, coverSingle: boolean): number {
  const spread = spreadForPage(page, pageCount, coverSingle);
  const last = spread[spread.length - 1] ?? pageCount;
  return Math.max(1, Math.min(pageCount, last + 1));
}

/** First logical page of the spread preceding `page`. */
export function prevSpreadStart(page: number, pageCount: number, coverSingle: boolean): number {
  const spread = spreadForPage(page, pageCount, coverSingle);
  const first = spread[0] ?? 1;
  if (first <= 1) return 1;
  return spreadForPage(first - 1, pageCount, coverSingle)[0] ?? 1;
}

/** Visual slot order for a logical spread. RTL mirrors the pair. */
export function displayOrder(spread: number[], direction: MangaReadingDirection): number[] {
  return direction === "rtl" ? [...spread].reverse() : [...spread];
}

/** Which logical advance a physical edge performs. */
export function edgeAdvance(side: SpreadSide, direction: MangaReadingDirection): SpreadAdvance {
  if (direction === "rtl") return side === "left" ? "next" : "prev";
  return side === "left" ? "prev" : "next";
}

/** Which logical advance an arrow key performs (null when unhandled). */
export function arrowAdvance(key: string, direction: MangaReadingDirection): SpreadAdvance | null {
  if (key === "ArrowLeft") return direction === "rtl" ? "next" : "prev";
  if (key === "ArrowRight") return direction === "rtl" ? "prev" : "next";
  return null;
}
