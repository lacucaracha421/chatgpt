import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useOptionalLibrary } from "../library/LibraryContext";
import type { AssetSummary } from "../library/types";
import type { ArtistCaptionLabels, ArtistGateway, ArtistOverview } from "./types";

/**
 * One revision counter for every artist read: a write bumps it and each open view (index,
 * hub, artist page, gallery captions) reloads what it shows. No second copy of the data.
 */
let revision = 0;
const listeners = new Set<() => void>();

export function invalidateArtists() {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useArtistRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}

export function useArtistGateway(): ArtistGateway | null {
  return useOptionalLibrary()?.gateway.artists ?? null;
}

/**
 * Last result per read key, per gateway, so a view opened again (back from an artist page)
 * shows what it showed at once and refreshes behind it. Bounded; oldest keys drop first.
 */
const lastReads = new WeakMap<ArtistGateway, Map<string, unknown>>();
const LAST_READS_MAX = 200;
function remembered(gateway: ArtistGateway | null) {
  if (!gateway) return null;
  let map = lastReads.get(gateway);
  if (!map) { map = new Map(); lastReads.set(gateway, map); }
  return map;
}

/** Loads `read` whenever the gateway, `key` or the artist revision changes; starts from the last result for `key`. */
export function useArtistRead<T>(read: ((gateway: ArtistGateway) => Promise<T>) | null, key: string): { data: T | null; error: unknown } {
  const gateway = useArtistGateway();
  const current = useArtistRevision();
  const memory = remembered(gateway);
  const [state, setState] = useState<{ data: T | null; error: unknown; key: string | null }>(() =>
    read && memory?.has(key) ? { data: memory.get(key) as T, error: null, key } : { data: null, error: null, key: null });
  useEffect(() => {
    if (!gateway || !read) return;
    let cancelled = false;
    read(gateway).then(
      (data) => {
        if (cancelled) return;
        memory?.delete(key);
        memory?.set(key, data);
        if (memory && memory.size > LAST_READS_MAX) memory.delete(memory.keys().next().value as string);
        setState({ data, error: null, key });
      },
      (error: unknown) => { if (!cancelled) setState((previous) => ({ data: previous.key === key ? previous.data : null, error, key })); },
    );
    return () => { cancelled = true; };
    // `read` is an inline closure; `key` names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, key, current]);
  if (state.key === key) return { data: state.data, error: state.error };
  return read && memory?.has(key) ? { data: memory.get(key) as T, error: null } : { data: null, error: null };
}

export function useArtistOverview(): ArtistOverview | null {
  return useArtistRead((gateway) => gateway.overview(), "overview").data;
}

/** Gallery caption: a renamed or merged artist's name, or the artist an image was assigned to. */
export function useArtistCaptionLabel(): ((asset: AssetSummary) => string | null) | undefined {
  const labels: ArtistCaptionLabels | null = useArtistRead((gateway) => gateway.captionLabels(), "captions").data;
  return useMemo(() => labels
    ? (asset: AssetSummary) => labels.byAsset[asset.id] ?? labels.byKey[asset.creatorHandle ?? asset.creatorUrl ?? ""] ?? null
    : undefined, [labels]);
}

/** Viewer-local calendar date and UTC offset for N년 전 오늘 and the 오늘 strip. */
export function localDateAndOffset(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return { localDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, offsetMinutes: -now.getTimezoneOffset() };
}
