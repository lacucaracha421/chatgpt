import { shadowItemKey, type ShadowReviewApi } from "../characters/shadowReviewApi";
import { tallyCandidates, type CharacterReviewTally } from "./homeModel";

/** Items read so far and the list's pending total when known. */
export type CharacterReviewProgress = { read: number; total: number | null };

/**
 * Exact per-character pending counts for the 캐릭터 검토 overview. `isLive` turns false when
 * the reader is no longer wanted; the source then stops and resolves with null. A native
 * per-character count command can replace the page read behind this same shape.
 */
export type CharacterReviewSource = (onProgress: (progress: CharacterReviewProgress) => void, isLive: () => boolean) => Promise<CharacterReviewTally[] | null>;

/** The native page maximum. */
const PAGE = 200;

/** Reads the whole S36 candidate list, page by page, and counts it per character. */
export function shadowPageSource(api: Pick<ShadowReviewApi, "page">): CharacterReviewSource {
  return async (onProgress, isLive) => {
    const seen = new Set<string>();
    const items: { targetId: string; targetName: string; verdict: string }[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await api.page({ offset, limit: PAGE });
      if (!isLive()) return null;
      let fresh = 0;
      for (const item of page.items ?? []) {
        const key = shadowItemKey(item);
        if (seen.has(key)) continue;
        seen.add(key); fresh += 1;
        items.push(item);
      }
      const total = page.summary ? page.summary.automatic.pending + page.summary.recommended.pending : null;
      onProgress({ read: items.length, total });
      // A page with nothing new means the order shifted under the read; stop rather than loop.
      offset = fresh > 0 ? page.nextOffset : null;
    }
    return tallyCandidates(items);
  };
}
