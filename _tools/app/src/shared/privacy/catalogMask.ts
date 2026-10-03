/** Catalog and local manga have no safe-content ratings. */
export function catalogContentMasked(privacyMode: boolean, nsfwFilter: boolean): boolean {
  return privacyMode || nsfwFilter;
}
