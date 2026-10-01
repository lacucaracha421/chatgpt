import type { MangaIndexIdentity } from "../library/types";

export const mangaIndexKey = (row: MangaIndexIdentity) => JSON.stringify([row.kind, row.namespace, row.value]);
export function mangaIndexQuery(row: MangaIndexIdentity | null): string {
  if (!row) return "";
  const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `${row.namespace}:${quote(row.value)}`;
}
/** Typed expressions stay intact; the index adds one AND condition until cleared. */
export function withMangaIndexQuery(text: string, indexQuery: string): string {
  return indexQuery ? text.trim() ? `(${text}) AND ${indexQuery}` : indexQuery : text;
}
