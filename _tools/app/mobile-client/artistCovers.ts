import {createContext, useEffect, useRef, useState} from 'react';
import {readyFirstScreen} from './firstScreen';
import type {Asset} from './types';

/** Artist lists and their cover thumbnails start one shared entrance (see useFirstAppearance). */
export const ARTIST_LIST_ENTRANCE='tablet-artists';
/** Covers a list prepared before showing; handed to each cover for its first frame. */
export const PreparedCovers=createContext<ReadonlyMap<string,string>>(new Map());
/** Kept well under a thumbnail ticket's lifetime; a cover mounted later loads its own. */
const PREPARED_KEEP_MS=60_000;

/**
 * No flash, one entrance: the first screen's artist covers are fetched and decoded (capped like
 * the gallery's first viewport) before the list is shown, so the list rises with its thumbnails
 * instead of rising empty and filling in cover by cover.
 */
export function usePreparedCovers(assets: Asset[], enabled: boolean) {
  const [prepared, setPrepared] = useState<ReadonlyMap<string,string>|null>(null);
  const latest = useRef(assets); latest.current = assets;
  useEffect(() => {
    if (!enabled || prepared) return;
    const controller = new AbortController();
    void readyFirstScreen(latest.current, controller.signal, latest.current.length).then(items => {
      if (!controller.signal.aborted) setPrepared(new Map(items.flatMap(asset => asset.preview ? [[asset.id, asset.preview] as const] : [])));
    });
    return () => controller.abort();
  }, [enabled, prepared]);
  useEffect(() => {
    if (!prepared?.size) return;
    const timer = window.setTimeout(() => setPrepared(new Map()), PREPARED_KEEP_MS);
    return () => window.clearTimeout(timer);
  }, [prepared]);
  return prepared;
}
