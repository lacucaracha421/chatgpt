import {api, native} from './transport';
import {mapBounded} from './model';
import type {Asset, Ticket} from './types';
const tickets = new Map<string, {ticket: Ticket; until: number}>();
const inFlight = new Map<string, Promise<Ticket>>();
let epoch = 0;
export function clearMediaCache() { epoch++; tickets.clear(); inFlight.clear(); }
export function invalidateTicket(asset: Asset, variant: string) { tickets.delete(`${asset.pending ? 'pending' : 'asset'}:${asset.id}:${variant}`); }
export async function mediaTicket(asset: Asset, variant: 'thumbnail' | 'original', signal?:AbortSignal): Promise<Ticket> {
  const key = `${asset.pending ? 'pending' : 'asset'}:${asset.id}:${variant}`;
  const cached = tickets.get(key);
  if (cached && cached.until > Date.now()) return cached.ticket;
  if (!signal && inFlight.has(key)) return inFlight.get(key)!;
  const generation = epoch;
  const promise = (async () => {
    const ticket = asset.pending
      ? await api<{download_url: string}>(`/v1/captures/${encodeURIComponent(asset.id)}/download`, signal).then(t => ({url: t.download_url, expires_in: 540}))
      : variant === 'thumbnail'
        ? await native<Ticket>('thumbnail', {assetId:asset.id}, signal)
        : await native<Ticket>('media', {assetId:asset.id,mime:asset.content_type}, signal);
    if (!/^https:\/\//.test(ticket.url) && !(import.meta.env.DEV && ticket.url.startsWith('data:image/'))) throw new Error('유효한 미디어 주소를 받지 못했습니다.');
    const expiry = 'expires_at' in ticket && ticket.expires_at ? Date.parse(ticket.expires_at) : Date.now() + (ticket.expires_in ?? 240) * 1000;
    if (generation === epoch) {
      if (tickets.size >= 240) tickets.delete(tickets.keys().next().value!);
      tickets.set(key, {ticket, until: expiry - 15_000});
    }
    return ticket;
  })();
  if (!signal) inFlight.set(key, promise);
  try { return await promise; } finally { if (inFlight.get(key) === promise) inFlight.delete(key); }
}
export function decodeImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); img.onload = img.onerror = null; };
    const cancel = () => { cleanup(); img.src = ''; reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); img.src = ''; reject(new Error('이미지를 불러오지 못했습니다.')); }, 18_000);
    img.onload = () => { img.decode().then(() => { cleanup(); resolve(img); }, () => { cleanup(); reject(new Error('이미지를 표시하지 못했습니다.')); }); };
    img.onerror = () => { cleanup(); reject(new Error('이미지를 불러오지 못했습니다.')); };
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel(); else img.src = url;
  });
}
export async function prepareAssets(items: Asset[], signal?: AbortSignal): Promise<Asset[]> {
  return mapBounded(items, 6, async asset => {
    if (asset.pending || asset.thumbnail_available === false) return {...asset, ratio: asset.ratio ?? 1};
    try {
      const ticket = await mediaTicket(asset, 'thumbnail', signal);
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const image = await decodeImage(ticket.url, signal);
      return {...asset, preview: ticket.url, ratio: Number(asset.width) > 0 && Number(asset.height) > 0 ? Number(asset.width) / Number(asset.height) : image.naturalWidth / image.naturalHeight};
    } catch (error) { if (signal?.aborted) throw error; return {...asset, ratio: 1}; }
  }, signal);
}

// Visible tiles share one queue. An uncached thumbnail costs a storage round trip of about
// 1.5–2.5 s on the tablet (latency, not bytes), so throughput comes from parallel requests;
// native still bounds real transfers separately. Prefetch and the Library warm-up never
// decode and never hold more than PREFETCH_LIMIT slots, so a newly visible tile always has
// free capacity instead of waiting behind slow background downloads.
const THUMBNAIL_LIMIT = 10, PREFETCH_LIMIT = 3;
let activeThumbnails = 0, activePrefetch = 0;
const thumbnailQueue: (() => void)[] = [];
const prefetchQueue: (() => void)[] = [];
function pump() {
  while (activeThumbnails < THUMBNAIL_LIMIT && thumbnailQueue.length) thumbnailQueue.shift()!();
  while (activePrefetch < PREFETCH_LIMIT && !thumbnailQueue.length && prefetchQueue.length) prefetchQueue.shift()!();
}
function enqueue(queue: (() => void)[], work: () => Promise<unknown>, signal: AbortSignal, reject: (reason: unknown) => void) {
  const cancel = () => {
    const index = queue.indexOf(start);
    if (index >= 0) queue.splice(index, 1);
    reject(new DOMException('Cancelled', 'AbortError'));
  };
  const background = queue === prefetchQueue;
  const start = () => {
    if (signal.aborted) { cancel(); return; }
    if (background) activePrefetch++; else activeThumbnails++;
    void work().finally(() => {
      signal.removeEventListener('abort', cancel);
      if (background) activePrefetch--; else activeThumbnails--;
      pump();
    });
  };
  if (signal.aborted) { cancel(); return; }
  signal.addEventListener('abort', cancel, {once:true});
  queue.push(start); pump();
}
export function loadThumbnail(asset: Asset, signal: AbortSignal): Promise<Asset> {
  return new Promise((resolve, reject) => {
    enqueue(thumbnailQueue, () => prepareAssets([asset], signal).then(items => resolve(items[0]), reject), signal, reject);
  });
}
/**
 * Warm the native thumbnail cache for assets about to scroll into view. Only the ticket is
 * requested — native fills its disk cache before answering — so a later visible load is a
 * local read. Cached thumbnails return at once; failures are ignored.
 */
export function prefetchThumbnails(assets: Asset[], signal: AbortSignal) {
  for (const asset of assets) {
    if (asset.pending || asset.preview || asset.thumbnail_available === false) continue;
    // Scrolling on drops queued work only; a started download finishes into the cache.
    enqueue(prefetchQueue, () => mediaTicket(asset, 'thumbnail').catch(() => undefined), signal, () => {});
  }
}
/** Library warm-up: one thumbnail through the prefetch queue, settled when native is done. */
export function warmThumbnail(asset: Asset, signal: AbortSignal): Promise<void> {
  if (asset.pending || asset.thumbnail_available === false) return Promise.resolve();
  return new Promise(resolve => {
    enqueue(prefetchQueue, () => mediaTicket(asset, 'thumbnail').then(() => resolve(), () => resolve()), signal, () => resolve());
  });
}
