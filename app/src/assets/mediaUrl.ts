const MEDIA_ORIGIN = "http://lakomics.localhost";

export function thumbnailUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/thumbnail/${encodeURIComponent(assetId)}`;
}

export function assetUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/asset/${encodeURIComponent(assetId)}`;
}
