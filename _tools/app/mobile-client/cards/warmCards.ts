import {useEffect} from 'react';
import {artUrl, cutoutUrl, type CardState, type TabletCardsApi} from './cardsClient';

/**
 * Quiet background warm-up of the art of packs that are still sealed (CARD-GACHA-001).
 *
 * The server lists only art ids in `state.prefetch`: nothing says which id is which card, so
 * warming cannot spoil a pack. A few ids are fetched at a time, each step only when the page is
 * idle and the user is not touching the screen, so a tear never waits behind the download and
 * Home scrolling is left alone.
 */
export const WARM_CONCURRENCY = 2;
export const WARM_MAX_IDS = 16;
const QUIET_MS = 400;
const LOAD_CAP_MS = 8_000;

const unique = (lists: readonly (readonly string[])[]) => [...new Set(lists.flat())];

/** Art ids and cutout ids to warm, packs in order, without repeats. Everything else in the hint is ignored. */
export function warmTargets(state: Pick<CardState, 'prefetch'> | null | undefined): {art: string[]; cutouts: string[]} {
  const packs = state?.prefetch ?? [];
  return {
    art: unique(packs.map(pack => pack.assetIds ?? [])).slice(0, WARM_MAX_IDS),
    cutouts: unique(packs.map(pack => pack.cutoutAssetIds ?? [])).slice(0, WARM_MAX_IDS),
  };
}

let lastActivity = -Infinity, watching = false;
function watchActivity() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const mark = () => { lastActivity = Date.now(); };
  for (const type of ['pointerdown', 'touchstart', 'keydown', 'scroll']) window.addEventListener(type, mark, {capture: true, passive: true});
}
/** The user is touching or scrolling, or the page is hidden: leave the device alone. */
export const userIsBusy = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
  const since = Date.now() - lastActivity;
  return since >= 0 && since < QUIET_MS; // a clock that moved backwards counts as quiet
};

function defaultIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, {timeout: 2_000});
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 50);
  return () => window.clearTimeout(handle);
}
function defaultLoad(url: string): Promise<void> {
  if (typeof Image !== 'function') return Promise.resolve();
  const image = new Image();
  image.decoding = 'async'; image.src = url;
  let timer = 0;
  const done = (typeof image.decode === 'function' ? image.decode() : Promise.resolve()).catch(() => undefined);
  return Promise.race([done, new Promise<void>(resolve => { timer = window.setTimeout(resolve, LOAD_CAP_MS); })]).then(() => undefined).finally(() => window.clearTimeout(timer));
}

export interface WarmOptions {
  concurrency?: number;
  /** Decodes one URL; tests replace it. */
  load?: (url: string) => Promise<void>;
  /** Runs the callback when the page is idle; returns a canceller. */
  idle?: (run: () => void) => () => void;
  busy?: () => boolean;
  /** Delay before checking again while busy. */
  retryMs?: number;
  /** Warm cutout layers (the server's download ticket) instead of library art. */
  cutouts?: boolean;
}

const warmed = new WeakMap<TabletCardsApi, Set<string>>();
/**
 * Warms `ids` a few at a time. Ids warmed earlier through the same api are skipped, so a changed
 * list costs only its new members. Returns a canceller; nothing is left running after it.
 */
export function warmArt(client: TabletCardsApi, ids: readonly string[], options: WarmOptions = {}): () => void {
  watchActivity();
  const {concurrency = WARM_CONCURRENCY, load = defaultLoad, idle = defaultIdle, busy = userIsBusy, retryMs = 500, cutouts = false} = options;
  let done = warmed.get(client);
  if (!done) { done = new Set(); warmed.set(client, done); }
  const finished = done;
  const mark = (id: string) => cutouts ? `cutout:${id}` : id;
  const queue = ids.filter(id => !finished.has(mark(id)));
  if (!queue.length) return () => undefined;
  let cancelled = false;
  const cancels = new Set<() => void>(), timers = new Set<number>();
  const whenQuiet = () => new Promise<void>(resolve => {
    const attempt = () => {
      if (cancelled) return;
      const stop = idle(() => {
        cancels.delete(stop);
        if (cancelled) return;
        if (busy()) { const timer = window.setTimeout(() => { timers.delete(timer); attempt(); }, retryMs); timers.add(timer); return; }
        resolve();
      });
      cancels.add(stop);
    };
    attempt();
  });
  const worker = async () => {
    while (!cancelled) {
      const id = queue.shift();
      if (id === undefined) return;
      await whenQuiet();
      if (cancelled) return;
      try {
        const url = cutouts ? await cutoutUrl(client, id) : await artUrl(client, id);
        if (cancelled) return;
        if (url) { await load(url); finished.add(mark(id)); }
      } catch { /* Warming is best effort. */ }
    }
  };
  for (let index = 0; index < Math.min(concurrency, queue.length); index++) void worker();
  return () => { cancelled = true; cancels.forEach(stop => stop()); cancels.clear(); timers.forEach(timer => window.clearTimeout(timer)); timers.clear(); };
}

/** Starts the warm-up whenever the sealed packs' id list changes and stops it when the card slot goes away. */
export function useCardWarmup(client: TabletCardsApi, state: CardState | undefined, active = true, options?: WarmOptions) {
  const targets = warmTargets(state), key = targets.art.join(','), cutoutKey = targets.cutouts.join(',');
  useEffect(() => {
    if (!active || !key) return;
    return warmArt(client, key.split(','), options);
    // `options` is a test seam and is not expected to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, active]);
  useEffect(() => {
    if (!active || !cutoutKey) return;
    return warmArt(client, cutoutKey.split(','), {...options, cutouts: true});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cutoutKey, active]);
}
