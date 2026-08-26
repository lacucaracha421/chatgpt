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

export function mangaCoverUrl(seriesId: string): string {
  return `${MEDIA_ORIGIN}/manga-cover/${encodeURIComponent(seriesId)}`;
}

export function mangaPageUrl(seriesId: string, pageIndex: number): string {
  return `${MEDIA_ORIGIN}/manga-page/${encodeURIComponent(seriesId)}/${pageIndex}`;
}

export function remoteMangaPageUrl(provider: "kHentai", workId: string, pageIndex: number): string {
  return `${MEDIA_ORIGIN}/remote-manga-page/${provider}/${encodeURIComponent(workId)}/${pageIndex}`;
}

export function collectionCoverUrl(collectionId: string, fileName: string): string {
  return `${MEDIA_ORIGIN}/collection-cover/${encodeURIComponent(collectionId)}/${encodeURIComponent(fileName)}`;
}

export function collectionSourcePreviewUrl(collectionId: string): string {
  return `${MEDIA_ORIGIN}/collection-source-preview/${encodeURIComponent(collectionId)}`;
}

export function workArtworkUrl(artworkId: string): string {
  return `${MEDIA_ORIGIN}/work-artwork/${encodeURIComponent(artworkId)}`;
}

export function workArtworkThumbnailUrl(artworkId: string): string {
  return `${MEDIA_ORIGIN}/work-artwork-thumbnail/${encodeURIComponent(artworkId)}`;
}

export function mangadexCoverPreviewUrl(mangaId: string, fileName: string): string {
  return `${MEDIA_ORIGIN}/mangadex-cover-preview/${encodeURIComponent(mangaId)}/${encodeURIComponent(fileName)}`;
}

export function igdbImagePreviewUrl(imageId: string, size: "cover" | "hero"): string {
  return `${MEDIA_ORIGIN}/igdb-image-preview/${size}/${encodeURIComponent(imageId)}`;
}
