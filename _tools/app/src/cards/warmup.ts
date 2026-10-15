import { useEffect } from "react";
import { cutoutUrl, localArtUrl, type CardsApi, type CardState } from "./api";

/**
 * Quiet background warm-up of the art of packs that are still sealed (CARD-GACHA-001).
 *
 * The server lists only art asset ids in `state.prefetch`: nothing says which id is which card, so
 * warming cannot spoil a pack. Each id is requested through the same `/preview/<id>/1280` URL the
 * cards use, which fills the native preview cache (and the WebView decode cache) before the pack
 * is torn. Nothing here talks to the network: the lookup is local-only, so an id whose art is not
 * in the library is skipped instead of being resolved to a signed remote URL.
 */
export const WARM_CONCURRENCY = 2;
export const WARM_MAX_IDS = 16;
const QUIET_MS = 400;
const LOAD_CAP_MS = 8_000;

/** True for the library's own `/preview/<id>/<edge>` route, the only URL worth warming. */
export const isLocalPreview = (url: string) => /\/preview\/[A-Za-z0-9_-]{1,128}\/\d{3,4}$/.test(url);

const unique = (lists: readonly (readonly string[])[]) => [...new Set(lists.flat())];

/** Art ids to warm, packs in order, without repeats. Everything else in the hint is ignored. */
export function warmTargets(state: Pick<CardState, "prefetch"> | null | undefined): { art: string[]; cutouts: string[] } {
  const packs = state?.prefetch ?? [];
  return {
    art: unique(packs.map(pack => pack.assetIds ?? [])).slice(0, WARM_MAX_IDS),
    cutouts: unique(packs.map(pack => pack.cutoutAssetIds ?? [])).slice(0, WARM_MAX_IDS),
  };
}

let lastActivity = -Infinity, watching = false;
function watchActivity() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const mark = () => { lastActivity = Date.now(); };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) window.addEventListener(type, mark, { capture: true, passive: true });
}
/** The user is typing, scrolling or pressing, or the window is hidden: leave the machine alone. */
export const userIsBusy = () => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  const since = Date.now() - lastActivity;
  return since >= 0 && since < QUIET_MS; // a clock that moved backwards counts as quiet
};

function defaultIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 2_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 50);
  return () => window.clearTimeout(handle);
}
function defaultLoad(url: string): Promise<void> {
  if (typeof Image !== "function") return Promise.resolve();
  const image = new Image();
  image.decoding = "async"; image.src = url;
  let timer = 0;
  const done = (typeof image.decode === "function" ? image.decode() : Promise.resolve()).catch(() => undefined);
  return Promise.race([done, new Promise<void>(resolve => { timer = window.setTimeout(resolve, LOAD_CAP_MS); })]).then(() => undefined).finally(() => window.clearTimeout(timer));
}

export interface WarmOptions {
  concurrency?: number;
  /** Decodes one URL; tests replace it. */
  load?: (url: string) => Promise<void>;
  /** Runs the callback when the machine is idle; returns a canceller. */
  idle?: (run: () => void) => () => void;
  busy?: () => boolean;
  /** Delay before checking again while busy. */
  retryMs?: number;
  /** Warm cutout layers (local copy first, then the server ticket) instead of library art. */
  cutouts?: boolean;
}

const warmed = new WeakMap<CardsApi, Set<string>>();
/**
 * Warms `ids` a few at a time, each step only when idle and the user is not busy. Ids warmed
 * earlier through the same api are skipped, so a changed list costs only its new members.
 * Returns a canceller; nothing is left running after it.
 */
export function warmArt(api: CardsApi, ids: readonly string[], options: WarmOptions = {}): () => void {
  watchActivity();
  const { concurrency = WARM_CONCURRENCY, load = defaultLoad, idle = defaultIdle, busy = userIsBusy, retryMs = 500, cutouts = false } = options;
  let done = warmed.get(api);
  if (!done) { done = new Set(); warmed.set(api, done); }
  const mark = (id: string) => cutouts ? `cutout:${id}` : id;
  const queue = ids.filter(id => !done!.has(mark(id)));
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
        const url = cutouts ? await cutoutUrl(api, id) : await localArtUrl(api, id);
        if (cancelled) return;
        if (url && (cutouts || isLocalPreview(url))) { await load(url); done!.add(mark(id)); }
      } catch { /* Warming is best effort. */ }
    }
  };
  for (let index = 0; index < Math.min(concurrency, queue.length); index++) void worker();
  return () => { cancelled = true; cancels.forEach(stop => stop()); cancels.clear(); timers.forEach(timer => window.clearTimeout(timer)); timers.clear(); };
}

/**
 * Starts the warm-up whenever the sealed packs' art list changes (app start, Home visit, a
 * newly granted pack) and stops it when Home goes away.
 *
 * `warmTargets(state).cutouts` lists the cutout layers the server already has for those images.
 * They are warmed the same way, but by `cutoutUrl`: this PC's own copy when it has one (nothing to
 * download), else the server's ticket, which also serves art of sealed packs.
 */
export function useCardWarmup(api: CardsApi, state: CardState | undefined, active = true, options?: WarmOptions) {
  const targets = warmTargets(state), key = targets.art.join(","), cutoutKey = targets.cutouts.join(",");
  useEffect(() => {
    if (!active || !key) return;
    return warmArt(api, key.split(","), options);
    // `options` is a test seam and is not expected to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, active]);
  useEffect(() => {
    if (!active || !cutoutKey) return;
    return warmArt(api, cutoutKey.split(","), { ...options, cutouts: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, cutoutKey, active]);
}
