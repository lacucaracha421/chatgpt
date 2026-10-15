import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeMediaUrl } from "../assets/mediaUrl";
import { preloadImages } from "../shared/motion/viewportImages";
import type { CardData, CardTier, PackCover } from "./types";

export interface ServerCard {
  slot: number | null; characterId: string; characterName: string; seriesName: string;
  tier: CardTier; artAssetId: string; artWidth: number; artHeight: number;
  cutout: { assetId: string } | null; count: number; level: number;
  serial: string | null; isNew: boolean; firstDrawnAt?: string; kept?: boolean;
}
/** Art ids of one sealed pack. Deliberately without tier, character or slot: it is only a warm-up list. */
export interface PackPrefetch { packId: string; assetIds: string[]; cutoutAssetIds?: string[] }
/** An opened pack whose cards have not been put into the album yet. */
export interface PendingKeep { packId: string; openedAt: string; expiresAt: string }
export interface CardState {
  version: number; revision: number; day: string; nextResetAt: string;
  unopened: { id: string; kind: "daily" | "bonus"; day: string }[];
  pendingKeep?: PendingKeep[]; prefetch?: PackPrefetch[];
  savedToday: number; bonusThreshold: number; bonusGranted: boolean;
  cover: { day: string; assetIds: string[] } | null;
  albumSummary: { cards: number; total: number };
}
export interface OpenResult {
  packId: string; openedAt: string; alreadyOpened: boolean; cards: ServerCard[];
  expiresAt?: string; keptAt?: string | null; expired?: boolean; alreadyKept?: boolean;
}
/** Opened, not yet decided and still inside the keep window: the results view may offer the keep step. */
export const isUndecided = (result: Pick<OpenResult, "keptAt" | "expired">) => !result.keptAt && !result.expired;
export interface AlbumPage { version: number; revision: number; cards: ServerCard[]; nextCursor: string | null }
export interface CardsApi {
  state(): Promise<CardState>;
  open(packId: string, operationId: string): Promise<OpenResult>;
  /** Puts only the chosen slots of an opened pack into the album. */
  keep(packId: string, operationId: string, slots: number[]): Promise<OpenResult>;
  /** An opened pack with its kept flags, to finish a keep started earlier or elsewhere. */
  pack(packId: string): Promise<OpenResult>;
  album(after: string | null): Promise<AlbumPage>;
  /** `localOnly` never reaches the network: art that is not in the library rejects. */
  art(assetId: string, cutout?: boolean, localOnly?: boolean): Promise<string>;
  subscribe(changed: () => void): () => void;
}
export const cardsApi: CardsApi = {
  state: () => invoke("card_state"),
  open: (packId, operationId) => invoke("card_open_pack", { packId, operationId }),
  keep: (packId, operationId, slots) => invoke("card_keep_pack", { packId, operationId, slots }),
  pack: packId => invoke("card_pack", { packId }),
  album: after => invoke("card_album", { after, limit: 50 }),
  art: (assetId, cutout = false, localOnly = false) => invoke<string>("card_art_url", { assetId, cutout, localOnly }).then(nativeMediaUrl),
  subscribe: changed => {
    if (!isTauri()) return () => undefined;
    let stopped = false, unlisten: (() => void) | undefined;
    void listen("cloud://cards-changed", changed).then(stop => { if (stopped) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { stopped = true; unlisten?.(); };
  },
};

// Signed URLs live for five minutes. Keep the cache short and bounded, including failures.
const artCaches = new WeakMap<CardsApi, Map<string, { expires: number; job: Promise<string> }>>();
export function artUrl(api: CardsApi, id: string, cutout = false): Promise<string> {
  let cache = artCaches.get(api);
  if (!cache) { cache = new Map(); artCaches.set(api, cache); }
  const key = `${id}:${cutout}`, hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.job;
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  const job = api.art(id, cutout).catch(() => "").then(url => { if (!url && cache.get(key)?.job === job) cache.delete(key); return url; });
  cache.set(key, { expires: Date.now() + 240_000, job });
  return job;
}
/** Local art only (background warm-up): a miss resolves to "" and never asks the server for a ticket. */
export function localArtUrl(api: CardsApi, id: string): Promise<string> {
  let cache = artCaches.get(api);
  if (!cache) { cache = new Map(); artCaches.set(api, cache); }
  const key = `${id}:local`, hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.job;
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  const job = api.art(id, false, true).catch(() => "");
  cache.set(key, { expires: Date.now() + 240_000, job });
  return job;
}
async function mapBounded<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}
export async function displayCards(api: CardsApi, cards: readonly ServerCard[], packId?: string): Promise<CardData[]> {
  const displayed = await mapBounded(cards, async (card, index) => ({
    ...card, id: packId ? `${packId}:${card.slot ?? index}` : `${card.characterId}:${card.tier}`,
    artUrl: await artUrl(api, card.artAssetId),
    cutoutUrl: card.cutout ? (await artUrl(api, card.cutout.assetId, true)) || undefined : undefined,
    serial: card.serial ?? undefined,
  }));
  await preloadImages(displayed.flatMap(card => [card.artUrl, ...(card.cutoutUrl ? [card.cutoutUrl] : [])]).filter(Boolean));
  return displayed;
}
export async function displayCover(api: CardsApi, state: CardState): Promise<PackCover> {
  const ids = state.cover?.assetIds ?? [];
  const imageUrls = await mapBounded(ids, id => artUrl(api, id));
  await preloadImages(imageUrls.filter(Boolean));
  return { assetIds: ids, imageUrls };
}

const key = (root: string, name: string) => `lakomics.cards.${name}:${root}`;
export function readResult(root: string): OpenResult | null {
  try { const value = JSON.parse(localStorage.getItem(key(root, "last")) ?? "null") as OpenResult | null; return value?.cards?.length === 5 ? value : null; } catch { return null; }
}
export function saveResult(root: string, result: OpenResult) {
  try { localStorage.setItem(key(root, "last"), JSON.stringify(result)); } catch { /* The server still owns the result. */ }
}
/** `kind` separates the open and keep retries of one pack; "operation" is the open key stored by earlier versions. */
export type OperationKind = "operation" | "keep";
export function operationId(root: string, packId: string, kind: OperationKind = "operation"): string {
  // Persist BEFORE sending. If storage is unavailable, do not consume the pack.
  const name = key(root, `${kind}:${packId}`), old = localStorage.getItem(name);
  if (old && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(old)) return old;
  const id = crypto.randomUUID(); localStorage.setItem(name, id); return id;
}
export function finishOperation(root: string, packId: string, kind: OperationKind = "operation") { try { localStorage.removeItem(key(root, `${kind}:${packId}`)); } catch { /* Safe to reuse after success. */ } }
