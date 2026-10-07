import { useEffect, useState } from "react";

/**
 * Decrypted vault thumbnails kept in memory for this session, so moving between vault folders
 * does not decrypt every thumbnail from the drive again. The media protocol serves them with
 * `no-store` (never in the WebView's disk cache, ADR-0039); this cache is memory only and is
 * cleared when the vault view closes. URLs carry the thumbnail revision, so a changed thumbnail
 * is a new entry.
 */
const MAX_ENTRIES = 600;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
/** Set when this WebView cannot read vault thumbnails with fetch (no CORS access). */
let fetchUnavailable = false;
let generation = 0;

function remember(url: string, objectUrl: string) {
  cache.set(url, objectUrl);
  while (cache.size > MAX_ENTRIES) {
    const [oldest, oldestObjectUrl] = cache.entries().next().value!;
    cache.delete(oldest);
    URL.revokeObjectURL(oldestObjectUrl);
  }
}

function cached(url: string): string | undefined {
  const hit = cache.get(url);
  if (hit !== undefined) {
    cache.delete(url);
    cache.set(url, hit);
  }
  return hit;
}

function load(url: string): Promise<string | null> {
  const running = pending.get(url);
  if (running) return running;
  const started = generation;
  const request = fetch(url, { mode: "cors", cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return null;
      const blob = await response.blob();
      if (started !== generation) return null;
      const objectUrl = URL.createObjectURL(blob);
      remember(url, objectUrl);
      return objectUrl;
    })
    .catch(() => {
      fetchUnavailable = true;
      return null;
    })
    .finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

/** Forgets every decrypted thumbnail (the vault view closed or locked). */
export function clearVaultThumbnailCache() {
  generation += 1;
  for (const objectUrl of cache.values()) URL.revokeObjectURL(objectUrl);
  cache.clear();
  pending.clear();
}

/**
 * The source to show for a vault thumbnail: the in-memory copy, `null` while it loads, or the
 * plain URL when caching is off or unavailable. Returns `url` unchanged when not `enabled`.
 */
export function useVaultThumbnailSrc(url: string | null, enabled: boolean): string | null {
  const active = enabled && url !== null && !fetchUnavailable;
  const [loaded, setLoaded] = useState<{ url: string; src: string } | null>(null);
  const hit = active ? cached(url) : undefined;
  useEffect(() => {
    if (!active || hit !== undefined) return;
    let current = true;
    void load(url).then((src) => { if (current) setLoaded({ url, src: src ?? url }); });
    return () => { current = false; };
  }, [active, hit, url]);
  if (!active) return url;
  if (hit !== undefined) return hit;
  return loaded?.url === url ? loaded.src : null;
}
