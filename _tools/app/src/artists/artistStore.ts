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

/** Loads `read` whenever the gateway, `key` or the artist revision changes. */
export function useArtistRead<T>(read: ((gateway: ArtistGateway) => Promise<T>) | null, key: string): { data: T | null; error: unknown } {
  const gateway = useArtistGateway();
  const current = useArtistRevision();
  const [state, setState] = useState<{ data: T | null; error: unknown; key: string | null }>({ data: null, error: null, key: null });
  useEffect(() => {
    if (!gateway || !read) return;
    let cancelled = false;
    read(gateway).then(
      (data) => { if (!cancelled) setState({ data, error: null, key }); },
      (error: unknown) => { if (!cancelled) setState((previous) => ({ data: previous.key === key ? previous.data : null, error, key })); },
    );
    return () => { cancelled = true; };
    // `read` is an inline closure; `key` names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, key, current]);
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: null };
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
