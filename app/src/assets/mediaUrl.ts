const MEDIA_ORIGIN = "http://lakomics.localhost";

export function thumbnailUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/thumbnail/${encodeURIComponent(assetId)}`;
}

export function assetUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/asset/${encodeURIComponent(assetId)}`;
}

export function playbackUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/playback/${encodeURIComponent(assetId)}`;
}

export function scrubFrameUrl(assetId: string, frameIndex: number): string {
  return `${MEDIA_ORIGIN}/scrub-frame/${encodeURIComponent(assetId)}/${frameIndex}`;
}
