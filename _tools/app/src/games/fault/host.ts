/**
 * Host side of the FAULT — REVEAL handoff, shared by every Lakomics client that embeds the game.
 *
 * The game is a bundled asset opened as `fault.html#host=lakomics` in a same-origin iframe.
 * Protocol v1 (all messages are same-origin `postMessage`s):
 *   game → host  {type:'lakomics-fault-ready'}   once the game listens for photos
 *   host → game  {type:'lakomics-fault-photos', version:1, photos:[{id, blob|url, name?}]} (1–24)
 *   game → host  {type:'lakomics-fault-close'}   when the user leaves through the game's 닫기 control
 * The photos are used for that session only; the game never stores them.
 */
import faultHtmlUrl from './fault.html?url';

export const FAULT_PROTOCOL_VERSION = 1;
export const FAULT_MAX_PHOTOS = 24;
/** The game refuses larger source files before converting them. */
export const FAULT_MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/** Source formats the game converts; anything else is rejected inside the game. */
export const FAULT_IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif|bmp|x-ms-bmp)$/i;

export interface FaultPhoto { id: string; blob?: Blob; url?: string; name?: string }
export interface FaultPhotosMessage { type: 'lakomics-fault-photos'; version: typeof FAULT_PROTOCOL_VERSION; photos: FaultPhoto[] }
export type FaultGameEvent = 'lakomics-fault-ready' | 'lakomics-fault-close';

export function faultGameUrl(): string { return `${faultHtmlUrl}#host=lakomics`; }

/** The minimum an asset has to expose to be judged; every client's asset shape satisfies it. */
export interface FaultCandidate { id: string; kind?: string; content_type?: string | null; size_bytes?: number | null; pending?: boolean }

/** Stored still images the game can convert. Videos, pending captures and oversized files are left out. */
export function faultCandidates<T extends FaultCandidate>(items: readonly T[]): T[] {
  return items.filter(item => item.kind === 'image' && !item.pending
    && (!item.content_type || FAULT_IMAGE_TYPE.test(item.content_type))
    && !(Number(item.size_bytes) > FAULT_MAX_PHOTO_BYTES));
}

/** Up to `count` distinct items in random order (a fresh draw every call). */
export function pickRandom<T>(items: readonly T[], count = FAULT_MAX_PHOTOS, random: () => number = Math.random): T[] {
  const pool = [...items], take = Math.max(0, Math.min(count, pool.length));
  for (let i = 0; i < take; i++) {
    const j = i + Math.min(pool.length - i - 1, Math.floor(random() * (pool.length - i)));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

export function photosMessage(photos: readonly FaultPhoto[]): FaultPhotosMessage {
  if (!photos.length || photos.length > FAULT_MAX_PHOTOS) throw new RangeError(`FAULT needs 1–${FAULT_MAX_PHOTOS} photos.`);
  return {type: 'lakomics-fault-photos', version: FAULT_PROTOCOL_VERSION, photos: photos.map(({id, blob, url, name}) => ({id, ...(blob ? {blob} : {}), ...(url ? {url} : {}), ...(name ? {name} : {})}))};
}

/** The game event carried by `event`, or null unless it comes from the embedded game window on this origin. */
export function readGameEvent(event: MessageEvent, game: Window | null, origin: string): FaultGameEvent | null {
  if (!game || event.source !== game || event.origin !== origin) return null;
  const type = (event.data as {type?: unknown} | null)?.type;
  return type === 'lakomics-fault-ready' || type === 'lakomics-fault-close' ? type : null;
}

export interface FaultLink {
  /** Hand over the session's photos; they are posted once the game reports ready. */
  supply(photos: readonly FaultPhoto[]): void;
  dispose(): void;
}

/**
 * Wire one embedded game window. Readiness and photo loading may finish in either order;
 * the photos are posted exactly once and the host drops its reference afterwards.
 */
export function connectFaultFrame({game, onClose, host = window, origin = host.location.origin}: {game(): Window | null; onClose(): void; host?: Window; origin?: string}): FaultLink {
  let ready = false, sent = false, disposed = false, pending: FaultPhotosMessage | null = null;
  const send = () => {
    const target = game();
    if (disposed || sent || !ready || !pending || !target) return;
    sent = true; target.postMessage(pending, origin); pending = null;
  };
  const listen = (event: MessageEvent) => {
    const type = readGameEvent(event, game(), origin);
    if (type === 'lakomics-fault-ready') { ready = true; send(); }
    else if (type === 'lakomics-fault-close' && !disposed) onClose();
  };
  host.addEventListener('message', listen);
  return {
    supply(photos) { if (disposed || sent) return; pending = photosMessage(photos); send(); },
    dispose() { disposed = true; pending = null; host.removeEventListener('message', listen); },
  };
}
