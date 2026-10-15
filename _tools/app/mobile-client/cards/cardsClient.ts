import {api} from '../transport';
import {mediaTicket} from '../media';
import {mapBounded} from '../model';
import type {Asset} from '../types';
import {preloadImages} from '../../src/shared/motion/viewportImages';
import {hasCutoutLayer, type CardData, type PackCover} from '../../src/cards/types';
// Types only: the PC module also holds Tauri calls the tablet must never load.
import type {AlbumPage, CardState, OpenResult, ServerCard} from '../../src/cards/api';

export type {AlbumPage, CardState, OpenResult, PendingKeep, ServerCard} from '../../src/cards/api';

/** Opened, not yet decided and still inside the keep window: the results view may offer the keep step. */
export const isUndecided = (result: Pick<OpenResult, 'keptAt' | 'expired'>) => !result.keptAt && !result.expired;

/**
 * The tablet's card API (CARD-GACHA-001). Every call goes through the app's authenticated native
 * bridge (`api`), so the server token never reaches the page; art goes through the same media
 * tickets the Library uses.
 */
export interface TabletCardsApi {
  state(signal?: AbortSignal): Promise<CardState>;
  open(packId: string, operationId: string): Promise<OpenResult>;
  /** Puts only the chosen slots of an opened pack into the album. */
  keep(packId: string, operationId: string, slots: number[]): Promise<OpenResult>;
  /** An opened pack with its kept flags, to finish a keep started earlier or elsewhere. */
  pack(packId: string): Promise<OpenResult>;
  album(after: string | null, signal?: AbortSignal): Promise<AlbumPage>;
  /** The card art as an `https` URL; rejects when it cannot be had. */
  art(assetId: string): Promise<string>;
  /** The server's cutout layer for an Asset (a short-lived download ticket); `""` when there is none. */
  cutout(assetId: string): Promise<string>;
}

export const ALBUM_PAGE_SIZE = 50;
const packPath = (packId: string) => `/v1/cards/packs/${encodeURIComponent(packId)}`;
// The media ticket only reads `id`; the thumbnail and original variants are the Library's own.
const artAsset = (id: string): Asset => ({id, kind: 'image', content_type: 'image/jpeg'});

export const tabletCardsApi: TabletCardsApi = {
  state: signal => api<CardState>('/v1/cards/state', signal),
  open: (packId, operationId) => api<OpenResult>(`${packPath(packId)}/open`, undefined, {operationId}, 'POST'),
  keep: (packId, operationId, slots) => api<OpenResult>(`${packPath(packId)}/keep`, undefined, {operationId, slots}, 'POST'),
  pack: packId => api<OpenResult>(packPath(packId)),
  album: (after, signal) => api<AlbumPage>(`/v1/cards/album?${new URLSearchParams({...(after ? {after} : {}), limit: String(ALBUM_PAGE_SIZE)})}`, signal),
  async art(assetId) {
    // The thumbnail is cached on the device; an Asset without one falls back to the original.
    try { return (await mediaTicket(artAsset(assetId), 'thumbnail')).url; }
    catch { return (await mediaTicket(artAsset(assetId), 'original')).url; }
  },
  async cutout(assetId) {
    const reply = await api<{url?: string}>(`/v1/cards/cutouts/${encodeURIComponent(assetId)}/ticket`, undefined, undefined, 'POST');
    return typeof reply.url === 'string' && /^https:\/\//.test(reply.url) ? reply.url : '';
  },
};

// Signed URLs live for a few minutes. Keep the cache short and bounded, failures included.
const TICKET_TTL_MS = 240_000, TICKET_CACHE_MAX = 300;
const caches = new WeakMap<TabletCardsApi, Map<string, {expires: number; job: Promise<string>}>>();
function cached(client: TabletCardsApi, key: string, load: () => Promise<string>): Promise<string> {
  let cache = caches.get(client);
  if (!cache) { cache = new Map(); caches.set(client, cache); }
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.job;
  if (cache.size >= TICKET_CACHE_MAX) cache.delete(cache.keys().next().value!);
  const store = cache;
  const job: Promise<string> = load().catch(() => '').then(url => { if (!url && store.get(key)?.job === job) store.delete(key); return url; });
  store.set(key, {expires: Date.now() + TICKET_TTL_MS, job});
  return job;
}
export const artUrl = (client: TabletCardsApi, assetId: string) => cached(client, `art:${assetId}`, () => client.art(assetId));
export const cutoutUrl = (client: TabletCardsApi, assetId: string) => cached(client, `cutout:${assetId}`, () => client.cutout(assetId));

const ART_PARALLEL = 4;
/** Cards ready to show: art, and the cutout layer for SSR and above when the server has one. */
export async function displayCards(client: TabletCardsApi, cards: readonly ServerCard[], packId?: string): Promise<CardData[]> {
  const shown = await mapBounded(cards.map((card, index) => ({card, index})), ART_PARALLEL, async ({card, index}): Promise<CardData> => ({
    ...card, id: packId ? `${packId}:${card.slot ?? index}` : `${card.characterId}:${card.tier}`,
    artUrl: await artUrl(client, card.artAssetId),
    // A tier below SSR never uses a cutout; a missing one keeps the full-art look.
    cutoutUrl: hasCutoutLayer(card.tier) && card.cutout ? (await cutoutUrl(client, card.cutout.assetId)) || undefined : undefined,
    serial: card.serial ?? undefined,
  }));
  await preloadImages(shown.flatMap(card => [card.artUrl, ...(card.cutoutUrl ? [card.cutoutUrl] : [])]).filter(Boolean));
  return shown;
}

export async function displayCover(client: TabletCardsApi, state: CardState): Promise<PackCover> {
  const ids = state.cover?.assetIds ?? [];
  const imageUrls = await mapBounded([...ids], ART_PARALLEL, id => artUrl(client, id));
  await preloadImages(imageUrls.filter(Boolean));
  return {assetIds: ids, imageUrls};
}

// The last opened pack and the retry keys live on this device only; the server still owns the result.
const key = (root: string, name: string) => `lakomics.cards.${name}:${root}`;
export function readResult(root: string): OpenResult | null {
  try { const value = JSON.parse(localStorage.getItem(key(root, 'last')) ?? 'null') as OpenResult | null; return value?.cards?.length === 5 ? value : null; } catch { return null; }
}
export function saveResult(root: string, result: OpenResult) {
  try { localStorage.setItem(key(root, 'last'), JSON.stringify(result)); } catch { /* The server still owns the result. */ }
}
/** `keep` separates the keep retries of one pack from its open retries. */
export type OperationKind = 'operation' | 'keep';
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/**
 * The retry key of one pack command. It is stored BEFORE the request, so a request that timed out
 * (or an app that was closed mid-request) is repeated with the same key and the server answers
 * with the first outcome instead of drawing or keeping twice. Without storage the call throws and
 * the pack is not consumed.
 */
export function operationId(root: string, packId: string, kind: OperationKind = 'operation'): string {
  const name = key(root, `${kind}:${packId}`), old = localStorage.getItem(name);
  if (old && UUID.test(old)) return old;
  const id = crypto.randomUUID(); localStorage.setItem(name, id); return id;
}
export function finishOperation(root: string, packId: string, kind: OperationKind = 'operation') {
  try { localStorage.removeItem(key(root, `${kind}:${packId}`)); } catch { /* Safe to reuse after success. */ }
}
