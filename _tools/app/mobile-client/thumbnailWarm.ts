import {meteredConnection,warmConnection as connection} from './warmNetwork';
export {meteredConnection} from './warmNetwork';
import {api,native} from './transport';
import {onNetworkRestored,onPowerChange} from './deviceSignals';
import {normalizePage, pagePath} from './model';
import {EMPTY_FILTERS} from './assetFilters';
import {ALL_ASSETS} from './libraryModel';
import {invalidateTicket, thumbnailRevision, warmThumbnail} from './media';
import type {Asset, Page} from './types';

/**
 * Library-wide thumbnail warm-up.
 *
 * An uncached thumbnail costs a 1.5–2 s storage round trip on the tablet, so browsing is
 * only instant once thumbnails are in the native disk cache. While the app is visible and
 * not on a metered connection, this walks every Library asset a page at a time and asks
 * native for each thumbnail through the lowest-priority queue (visible tiles always go
 * first). A batch probe skips cached thumbnails. Progress is kept per endpoint and cache
 * generation so a restart resumes. Daily passes stop at the last completed newest
 * sort key; a monthly sweep repairs evictions and late/backdated publications.
 */
export type WarmState = {status:'off'|'waiting'|'running'|'metered'|'done'|'error'; warmed:number; completedAt:number|null};
type Mark = {id:string; at:string|null};
/** `failures` counts consecutive failed reads of the page at `cursor`. */
type Saved = {scope:string; cursor:string|null; warmed:number; completedAt:number|null; failures?:number;
  generation?:string; highWater?:Mark; newest?:Mark; fullCompletedAt?:number};
type Cached = {generation:string; cachedIds:string[]};
const PROGRESS_KEY = 'lakomics.mobile.thumbnailWarm', OFF_KEY = 'lakomics.mobile.thumbnailWarmOff';
const WARM_PAGE = 100, REPEAT_AFTER = 24 * 60 * 60 * 1000, RETRY_AFTER = 60_000, MAX_PAGE_FAILURES = 3;
// Waiting for a charger is ended by native `lakomics-power`; this only covers a missed event.
const POWER_FALLBACK = 30 * 60 * 1000;
// Let the first screen load before background work starts after launch or return.
const START_DELAY = 5_000, FULL_REPEAT_AFTER = 30 * REPEAT_AFTER;
const EVENT = 'lakomics-thumbnail-warm';

function read<T>(key:string):T|null { try {const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : null;} catch {return null;} }
function write(key:string, value:unknown) { try {localStorage.setItem(key, JSON.stringify(value));} catch { /* Optional device progress. */ } }
function saved(scope:string):Saved { const value = read<Saved>(PROGRESS_KEY); return value?.scope === scope ? value : {scope, cursor:null, warmed:0, completedAt:null}; }

let state:WarmState = {status:'waiting', warmed:0, completedAt:null};
function publish(next:WarmState) { state = next; window.dispatchEvent(new CustomEvent<WarmState>(EVENT, {detail:next})); }
export function warmState() { return state; }
export function onWarmState(listener:(state:WarmState)=>void) {
  const handler = (event:Event) => listener((event as CustomEvent<WarmState>).detail);
  window.addEventListener(EVENT, handler); return () => window.removeEventListener(EVENT, handler);
}
export function warmEnabled() { return read<boolean>(OFF_KEY) !== true; }
export function setWarmEnabled(enabled:boolean) { write(OFF_KEY, !enabled); window.dispatchEvent(new Event(`${EVENT}-toggle`)); }
/** Forget progress, e.g. after the media cache was cleared or the connection changed. */
export function resetWarmProgress() { try {localStorage.removeItem(PROGRESS_KEY);} catch { /* optional */ } }

/** A client error other than auth, timeout or rate limit: the saved cursor cannot be resumed. */
function cursorRejected(error:unknown) {
  // Read structurally (transport's ApiError carries the server status; network errors have none).
  const status = (error as {status?:unknown} | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

export type BatteryState={charging:boolean;level:number;powerSave:boolean};
export function batteryAllowsWarm(battery:BatteryState|undefined) {
  return !!battery&&(battery.charging===true||(battery.level>=50&&battery.powerSave===false));
}
function mark(asset:Asset):Mark { return {id:asset.id, at:asset.collected_at ?? asset.created_at ?? null}; }
function atOrBelow(asset:Asset, boundary:Mark) {
  if (asset.id === boundary.id) return true;
  const at = mark(asset).at;
  // Match the server's COALESCE(collected_at, created_at) DESC, id DESC order.
  // With old/missing date fields, only an exact id match can safely stop the walk.
  return at !== null && boundary.at !== null && (at < boundary.at || (at === boundary.at && asset.id < boundary.id));
}
async function probe(items:Asset[], signal:AbortSignal) {
  // Probe the same entries the tiles load: a thumbnail's revision is part of its cache key.
  const result = await native<Cached>('thumbnailsCached', {assetIds:items.map(asset => asset.id), revisions:items.map(asset => thumbnailRevision(asset) ?? '')}, signal);
  if (!result.generation || !Array.isArray(result.cachedIds)) throw new Error('Invalid thumbnail cache probe');
  return result;
}
async function pass(scope:string, signal:AbortSignal) {
  let progress = saved(scope);
  for (;;) {
    const status=await native<{battery?:BatteryState}>('status',{},signal);
    if(signal.aborted)return;
    if(!batteryAllowsWarm(status.battery)) {publish({status:'waiting',warmed:progress.warmed,completedAt:progress.completedAt});return false;}
    if (progress.completedAt !== null) {
      if (Date.now() - progress.completedAt < REPEAT_AFTER) {
        // Validate even a recent completion: native clearing/reconfiguration may have
        // happened without this WebView receiving the settings callback.
        const cache = await probe([], signal);
        if (signal.aborted) return;
        if (cache.generation === progress.generation) {
          publish({status:'done', warmed:progress.warmed, completedAt:progress.completedAt}); return;
        }
        progress = {scope, cursor:null, warmed:0, completedAt:null, generation:cache.generation};
      } else {
        const full = !progress.fullCompletedAt || Date.now() - progress.fullCompletedAt >= FULL_REPEAT_AFTER;
        progress = {...progress, cursor:null, warmed:0, completedAt:null, newest:undefined,
          highWater:full ? undefined : progress.highWater};
      }
      write(PROGRESS_KEY, progress);
    }
    publish({status:'running', warmed:progress.warmed, completedAt:null});
    let page:Page;
    try { page = normalizePage(await api<Page>(pagePath(ALL_ASSETS, progress.cursor, EMPTY_FILTERS, WARM_PAGE), signal)); }
    catch (error) {
      if (signal.aborted) throw error;
      const failures = (progress.failures ?? 0) + 1;
      progress = cursorRejected(error) || failures >= MAX_PAGE_FAILURES
        ? {...progress, cursor:null, warmed:0, completedAt:null, newest:undefined, failures:0}
        : {...progress, failures};
      write(PROGRESS_KEY, progress);
      throw error;
    }
    if (signal.aborted) return;
    const eligible = page.items.filter(asset => !asset.pending && asset.thumbnail_available !== false);
    const cache = await probe(eligible, signal);
    if (signal.aborted) return;
    if (cache.generation !== progress.generation) {
      const hadCursor = progress.cursor !== null;
      progress = {scope, cursor:null, warmed:0, completedAt:null, generation:cache.generation};
      write(PROGRESS_KEY, progress);
      // An old cursor can skip now-empty pages. Reuse a first page, otherwise restart.
      if (hadCursor) continue;
    }
    const boundary = progress.highWater ? page.items.findIndex(asset => atOrBelow(asset, progress.highWater!)) : -1;
    const items = boundary < 0 ? page.items : page.items.slice(0, boundary);
    const hits = new Set(cache.cachedIds);
    const misses = items.filter(asset => !asset.pending && asset.thumbnail_available !== false && !hits.has(asset.id));
    // Native is authoritative; a JS ticket can outlive an eviction or cache clear.
    await Promise.all(misses.map(asset => { invalidateTicket(asset, 'thumbnail'); return warmThumbnail(asset, signal); }));
    if (signal.aborted) return;
    if (misses.length) {
      // warmThumbnail intentionally swallows errors for speculative callers. Do not
      // promote the high-water mark until all eligible misses actually reached disk.
      const verified = await probe(misses, signal);
      if (signal.aborted) return;
      if (verified.generation !== cache.generation) {
        progress = {scope, cursor:null, warmed:0, completedAt:null, generation:verified.generation};
        write(PROGRESS_KEY, progress); continue;
      }
      const ready = new Set(verified.cachedIds);
      if (misses.some(asset => !ready.has(asset.id))) throw new Error('Thumbnail page incomplete');
    }
    const newest = progress.newest ?? (items[0] ? mark(items[0]) : undefined);
    progress = {...progress, cursor:page.next_cursor, warmed:progress.warmed + items.length,
      completedAt:null, newest, failures:0};
    if (boundary >= 0 || !page.has_more || !page.next_cursor) {
      progress = {...progress, cursor:null, completedAt:Date.now(), highWater:newest ?? progress.highWater,
        newest:undefined, fullCompletedAt:progress.highWater ? progress.fullCompletedAt : Date.now()};
    }
    write(PROGRESS_KEY, progress);
    if (progress.completedAt !== null) { publish({status:'done', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    publish({status:'running', warmed:progress.warmed, completedAt:null});
  }
}

/**
 * Run the warm-up for one configured endpoint until the returned stop function is called.
 * It pauses while hidden, off or metered and resumes from the saved cursor. On battery it
 * waits for native `lakomics-power` (charger connected), and after a failure for either the
 * one-minute retry or `lakomics-network` (reconnected), whichever comes first.
 */
export function startThumbnailWarm(scope:string) {
  let controller:AbortController|null = null, timer = 0, stopped = false;
  /** What the pending retry timer waits for; the matching native event ends the wait early. */
  let waiting:'power'|'network'|null = null;
  const halt = () => { controller?.abort(); controller = null; clearTimeout(timer); timer = 0; waiting = null; };
  const evaluate = () => {
    if (stopped) return;
    const progress = saved(scope);
    if (!warmEnabled()) { halt(); publish({status:'off', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (meteredConnection()) { halt(); publish({status:'metered', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (document.visibilityState === 'hidden') { halt(); publish({status:'waiting', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (controller || timer) return;
    waiting = null;
    timer = window.setTimeout(() => { timer = 0; begin(); }, START_DELAY);
  };
  const begin = () => {
    if (stopped || controller || !warmEnabled() || meteredConnection() || document.visibilityState === 'hidden') return;
    const current = controller = new AbortController();
    void pass(scope, current.signal).then(allowed => {
      if (controller !== current) return;
      controller = null;
      // A finished pass checks again after the repeat interval while the app stays open.
      waiting = allowed === false ? 'power' : null;
      timer = window.setTimeout(() => { timer = 0; waiting = null; evaluate(); }, allowed===false?POWER_FALLBACK:REPEAT_AFTER);
    }, () => {
      if (controller !== current || current.signal.aborted) return;
      controller = null; const progress = saved(scope);
      publish({status:'error', warmed:progress.warmed, completedAt:progress.completedAt});
      waiting = 'network';
      timer = window.setTimeout(() => { timer = 0; waiting = null; evaluate(); }, RETRY_AFTER);
    });
  };
  const toggle = () => { halt(); evaluate(); };
  const wake = (kind:'power'|'network') => () => {
    if (stopped || waiting !== kind) return;
    clearTimeout(timer); timer = 0; waiting = null; evaluate();
  };
  const removePower = onPowerChange(wake('power')), removeNetwork = onNetworkRestored(wake('network'));
  document.addEventListener('visibilitychange', evaluate);
  window.addEventListener(`${EVENT}-toggle`, toggle);
  connection()?.addEventListener?.('change', evaluate);
  evaluate();
  return () => {
    stopped = true; halt(); removePower(); removeNetwork();
    document.removeEventListener('visibilitychange', evaluate);
    window.removeEventListener(`${EVENT}-toggle`, toggle);
    connection()?.removeEventListener?.('change', evaluate);
  };
}
