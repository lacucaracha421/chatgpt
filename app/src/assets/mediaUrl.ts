import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { RemoteProvider } from "../library/types";

// Tauri uses HTTP origins on Windows and native URI schemes on Linux.
// Keep the browser fixture origin when no native runtime is present.
function mediaOrigin(): string {
  return isTauri() ? convertFileSrc("", "lakomics").replace(/\/$/, "") : "http://lakomics.localhost";
}

export function thumbnailUrl(assetId: string): string {
  return `${mediaOrigin()}/thumbnail/${encodeURIComponent(assetId)}`;
}

export function assetUrl(assetId: string): string {
  return `${mediaOrigin()}/asset/${encodeURIComponent(assetId)}`;
}

export function playbackUrl(assetId: string): string {
  return `${mediaOrigin()}/playback/${encodeURIComponent(assetId)}`;
}

export function scrubFrameUrl(assetId: string, frameIndex: number): string {
  return `${mediaOrigin()}/scrub-frame/${encodeURIComponent(assetId)}/${frameIndex}`;
}

export function mangaCoverUrl(seriesId: string): string {
  return `${mediaOrigin()}/manga-cover/${encodeURIComponent(seriesId)}`;
}

export function mangaPageUrl(seriesId: string, pageIndex: number): string {
  return `${mediaOrigin()}/manga-page/${encodeURIComponent(seriesId)}/${pageIndex}`;
}

export function remoteMangaPageUrl(provider: RemoteProvider, workId: string, pageIndex: number): string {
  return `${mediaOrigin()}/remote-manga-page/${provider}/${encodeURIComponent(workId)}/${pageIndex}`;
}

export function collectionCoverUrl(collectionId: string, fileName: string): string {
  return `${mediaOrigin()}/collection-cover/${encodeURIComponent(collectionId)}/${encodeURIComponent(fileName)}`;
}

export function collectionCoverThumbnailUrl(collectionId: string, fileName: string): string {
  return `${mediaOrigin()}/collection-cover-thumbnail/${encodeURIComponent(collectionId)}/${encodeURIComponent(fileName)}`;
}

export function collectionSourcePreviewUrl(collectionId: string): string {
  return `${mediaOrigin()}/collection-source-preview/${encodeURIComponent(collectionId)}`;
}

export function collectionSourceThumbnailUrl(collectionId: string): string {
  return `${mediaOrigin()}/collection-source-thumbnail/${encodeURIComponent(collectionId)}`;
}

export function workArtworkUrl(artworkId: string): string {
  return `${mediaOrigin()}/work-artwork/${encodeURIComponent(artworkId)}`;
}

export function workArtworkThumbnailUrl(artworkId: string): string {
  return `${mediaOrigin()}/work-artwork-thumbnail/${encodeURIComponent(artworkId)}`;
}

export function mangadexCoverPreviewUrl(mangaId: string, fileName: string): string {
  return `${mediaOrigin()}/mangadex-cover-preview/${encodeURIComponent(mangaId)}/${encodeURIComponent(fileName)}`;
}

export function igdbImagePreviewUrl(imageId: string, size: "cover" | "hero"): string {
  return `${mediaOrigin()}/igdb-image-preview/${size}/${encodeURIComponent(imageId)}${size === "hero" ? "?fit=contain" : ""}`;
}

export function tmdbImagePreviewUrl(filePath: string, size: "poster" | "backdrop"): string {
  return `${mediaOrigin()}/tmdb-image-preview/${size}/${encodeURIComponent(filePath)}`;
}
