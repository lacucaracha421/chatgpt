import {meteredConnection,warmConnection as connection} from './warmNetwork';
export {meteredConnection} from './warmNetwork';
import {api,native} from './transport';
import {normalizePage, pagePath} from './model';
import {EMPTY_FILTERS} from './assetFilters';
import {ALL_ASSETS} from './libraryModel';
import {warmThumbnail} from './media';
import type {Page} from './types';

/**
 * Library-wide thumbnail warm-up.
 *
 * An uncached thumbnail costs a 1.5–2 s storage round trip on the tablet, so browsing is
 * only instant once thumbnails are in the native disk cache. While the app is visible and
 * not on a metered connection, this walks every Library asset a page at a time and asks
 * native for each thumbnail through the lowest-priority queue (visible tiles always go
 * first). Native answers cached thumbnails immediately. Progress is kept per endpoint so a
 * restart resumes, and a finished pass repeats after a day to pick up new assets.
 */
export type WarmState = {status:'off'|'waiting'|'running'|'metered'|'done'|'error'; warmed:number; completedAt:number|null};
type Saved = {scope:string; cursor:string|null; warmed:number; completedAt:number|null};
const PROGRESS_KEY = 'lakomics.mobile.thumbnailWarm', OFF_KEY = 'lakomics.mobile.thumbnailWarmOff';
const WARM_PAGE = 100, REPEAT_AFTER = 24 * 60 * 60 * 1000, RETRY_AFTER = 60_000;
// Let the first screen load before background work starts after launch or return.
const START_DELAY = 5_000;
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

export type BatteryState={charging:boolean;level:number;powerSave:boolean};
export function batteryAllowsWarm(battery:BatteryState|undefined) {
  return !!battery&&(battery.charging===true||(battery.level>=50&&battery.powerSave===false));
}
async function pass(scope:string, signal:AbortSignal) {
  let progress = saved(scope);
  if (progress.completedAt !== null) {
    if (Date.now() - progress.completedAt < REPEAT_AFTER) { publish({status:'done', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    progress = {scope, cursor:null, warmed:0, completedAt:null};
  }
  for (;;) {
    const status=await native<{battery?:BatteryState}>('status',{},signal);
    if(signal.aborted)return;
    if(!batteryAllowsWarm(status.battery)) {publish({status:'waiting',warmed:progress.warmed,completedAt:progress.completedAt});return false;}
    publish({status:'running', warmed:progress.warmed, completedAt:null});
    let page:Page;
    try { page = normalizePage(await api<Page>(pagePath(ALL_ASSETS, progress.cursor, EMPTY_FILTERS, WARM_PAGE), signal)); }
    catch (error) {
      if (signal.aborted) throw error;
      // A cursor from an older list generation is not resumable; start the pass again.
      progress = {scope, cursor:null, warmed:0, completedAt:null}; write(PROGRESS_KEY, progress);
      throw error;
    }
    await Promise.all(page.items.map(asset => warmThumbnail(asset, signal)));
    if (signal.aborted) return;
    progress = {scope, cursor:page.next_cursor, warmed:progress.warmed + page.items.length, completedAt:null};
    if (!page.has_more || !page.next_cursor) progress = {...progress, cursor:null, completedAt:Date.now()};
    write(PROGRESS_KEY, progress);
    if (progress.completedAt !== null) { publish({status:'done', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    publish({status:'running', warmed:progress.warmed, completedAt:null});
  }
}

/**
 * Run the warm-up for one configured endpoint until the returned stop function is called.
 * It pauses while hidden, off or metered and resumes from the saved cursor.
 */
export function startThumbnailWarm(scope:string) {
  let controller:AbortController|null = null, timer = 0, stopped = false;
  const halt = () => { controller?.abort(); controller = null; clearTimeout(timer); timer = 0; };
  const evaluate = () => {
    if (stopped) return;
    const progress = saved(scope);
    if (!warmEnabled()) { halt(); publish({status:'off', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (meteredConnection()) { halt(); publish({status:'metered', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (document.visibilityState === 'hidden') { halt(); publish({status:'waiting', warmed:progress.warmed, completedAt:progress.completedAt}); return; }
    if (controller || timer) return;
    timer = window.setTimeout(() => { timer = 0; begin(); }, START_DELAY);
  };
  const begin = () => {
    if (stopped || controller || !warmEnabled() || meteredConnection() || document.visibilityState === 'hidden') return;
    const current = controller = new AbortController();
    void pass(scope, current.signal).then(allowed => {
      if (controller !== current) return;
      controller = null;
      // A finished pass checks again after the repeat interval while the app stays open.
      timer = window.setTimeout(() => { timer = 0; evaluate(); }, allowed===false?RETRY_AFTER:REPEAT_AFTER);
    }, () => {
      if (controller !== current || current.signal.aborted) return;
      controller = null; const progress = saved(scope);
      publish({status:'error', warmed:progress.warmed, completedAt:progress.completedAt});
      timer = window.setTimeout(() => { timer = 0; evaluate(); }, RETRY_AFTER);
    });
  };
  const toggle = () => { halt(); evaluate(); };
  document.addEventListener('visibilitychange', evaluate);
  window.addEventListener(`${EVENT}-toggle`, toggle);
  connection()?.addEventListener?.('change', evaluate);
  evaluate();
  return () => {
    stopped = true; halt();
    document.removeEventListener('visibilitychange', evaluate);
    window.removeEventListener(`${EVENT}-toggle`, toggle);
    connection()?.removeEventListener?.('change', evaluate);
  };
}
