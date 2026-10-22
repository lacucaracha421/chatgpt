import {localDay} from '../src/shared/displayDate';
import {readyFirstScreen} from './firstScreen';
import {api} from './transport';
import type {Asset} from './types';

/** `GET /v1/library/artist-rediscovery` (server `library_artist_rediscovery.py`, PC `artists.rs`). */
export type Rediscovery = {
  onThisDay: {total: number; yearsAgo: number; localDate: string; items: Asset[]} | null;
  longUnseen: {total: number; items: Asset[]} | null;
  /** False when the PC opened this artist within the year: which Assets went unseen is PC-only. */
  longUnseenKnown: boolean;
};
export type PreparedRediscovery = {artistId: string; value: Rediscovery | null; prepared: ReadonlyMap<string, string>};

const items = (value: unknown): Asset[] => Array.isArray(value) ? value.filter((item): item is Asset => !!item && typeof (item as Asset).id === 'string') : [];

export function normalizeRediscovery(reply: unknown): Rediscovery | null {
  if (!reply || typeof reply !== 'object') return null;
  const row = reply as {onThisDay?: Record<string, unknown> | null; longUnseen?: Record<string, unknown> | null; longUnseenKnown?: unknown};
  const day = row.onThisDay, unseen = row.longUnseen;
  const onThisDay = day && typeof day.yearsAgo === 'number' && typeof day.localDate === 'string' && items(day.items).length
    ? {total: Number(day.total) || 0, yearsAgo: day.yearsAgo, localDate: day.localDate, items: items(day.items)} : null;
  const longUnseen = unseen && items(unseen.items).length ? {total: Number(unseen.total) || 0, items: items(unseen.items)} : null;
  return {onThisDay, longUnseen, longUnseenKnown: row.longUnseenKnown !== false};
}

/**
 * The artist page's 다시보기 rows with their first thumbnails decoded, so the rows arrive with the
 * page instead of pushing the gallery down later. A failed read (an older server, offline) is no rows.
 */
export async function readArtistRediscovery(artistId: string, signal: AbortSignal): Promise<PreparedRediscovery> {
  // Today's local date and offset (minutes east of UTC), as the PC artist page sends them.
  const now = new Date();
  const params = new URLSearchParams({artist: artistId, localDate: localDay(now), utcOffsetMinutes: String(-now.getTimezoneOffset())});
  try {
    const value = normalizeRediscovery(await api<unknown>(`/v1/library/artist-rediscovery?${params}`, signal));
    const assets = [...(value?.onThisDay?.items ?? []), ...(value?.longUnseen?.items ?? [])];
    const ready = await readyFirstScreen(assets, signal, assets.length);
    return {artistId, value, prepared: new Map(ready.flatMap(asset => asset.preview ? [[asset.id, asset.preview] as const] : []))};
  } catch (reason) {
    if (signal.aborted) throw reason;
    return {artistId, value: null, prepared: new Map()};
  }
}
