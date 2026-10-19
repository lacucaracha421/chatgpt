/** Only an untouched initial search may fall back; selection uses the query that succeeded. */
export async function searchKakaoWithOriginal<T>(
  query: string, originalTitle: string | null | undefined,
  search: (query: string) => Promise<T[]>, canFallback: () => boolean,
): Promise<{query: string; items: T[]; usedOriginalTitle: boolean}> {
  const items = await search(query);
  const original = originalTitle?.trim();
  if (items.length === 0 && original && original !== query.trim() && canFallback()) {
    return {query: original, items: await search(original), usedOriginalTitle: true};
  }
  return {query, items, usedOriginalTitle: false};
}
