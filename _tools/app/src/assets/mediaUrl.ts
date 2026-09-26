import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { AssetSummary, RemoteProvider } from "../library/types";

// Tauri uses HTTP origins on Windows and native URI schemes on Linux.
// Keep the browser fixture origin when no native runtime is present.
function mediaOrigin(): string {
  return isTauri() ? convertFileSrc("", "lakomics").replace(/\/$/, "") : "http://lakomics.localhost";
}

/** Adapt backend media URLs to the current WebView's custom-protocol origin. */
export function nativeMediaUrl(url: string): string {
  const origin = "http://lakomics.localhost";
  return url.startsWith(`${origin}/`) ? `${mediaOrigin()}${url.slice(origin.length)}` : url;
}

export function thumbnailUrl(assetId: string, revision?: string | number): string {
  const base = `${mediaOrigin()}/thumbnail/${encodeURIComponent(assetId)}`;
  return revision === undefined ? base : `${base}/v${encodeURIComponent(String(revision))}`;
}

/**
 * A library Asset's thumbnail under its content revision. The backend serves it as immutable
 * while the revision is current, so re-mounted tiles load from the WebView cache instead of
 * the media protocol; an Asset without a revision gets the uncached URL.
 */
export function assetThumbnailUrl(asset: Pick<AssetSummary, "id" | "thumbnailRevision">): string {
  return thumbnailUrl(asset.id, asset.thumbnailRevision ?? undefined);
}

export function trashThumbnailUrl(assetId: string): string {
  return `${mediaOrigin()}/trash-thumbnail/${encodeURIComponent(assetId)}`;
}

export function assetUrl(assetId: string): string {
  return `${mediaOrigin()}/asset/${encodeURIComponent(assetId)}`;
}

export function playbackUrl(assetId: string): string {
  return `${mediaOrigin()}/playback/${encodeURIComponent(assetId)}`;
}

/** Encrypted Private Vault routes (ADR-0039): decrypted in memory, never cached. */
export function vaultAssetUrl(itemId: string): string {
  return `${mediaOrigin()}/vault-asset/${encodeURIComponent(itemId)}`;
}

export function vaultThumbnailUrl(itemId: string, revision?: string | number): string {
  const base = `${mediaOrigin()}/vault-thumbnail/${encodeURIComponent(itemId)}`;
  return revision === undefined ? base : `${base}/v${encodeURIComponent(String(revision))}`;
}

export function vaultPlaybackUrl(itemId: string): string {
  return `${mediaOrigin()}/vault-playback/${encodeURIComponent(itemId)}`;
}

/** `revision`: the Asset's `thumbnailRevision`, which also versions its scrub frames. */
export function scrubFrameUrl(assetId: string, frameIndex: number, revision?: string | null): string {
  const base = `${mediaOrigin()}/scrub-frame/${encodeURIComponent(assetId)}/${frameIndex}`;
  return revision ? `${base}/v${encodeURIComponent(revision)}` : base;
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
