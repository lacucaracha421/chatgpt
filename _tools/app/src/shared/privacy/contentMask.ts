export type ContentRating = 'g' | 's' | 'q' | 'e';
export type RatedAsset = {
  contentRating?: ContentRating | null;
  media?: {kind: string};
  kind?: string;
  mediaKind?: string;
};

/** Unknown ratings never grant permission to reveal media. Privacy always wins. */
export function assetMasked(privacy: boolean, nsfwFilter: boolean, asset?: RatedAsset | null): boolean {
  return privacy || (nsfwFilter && (asset?.contentRating !== 'g' || asset?.media?.kind === 'video' || asset?.kind === 'video' || asset?.mediaKind === 'video'));
}
