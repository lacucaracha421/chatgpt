import { createContext, useContext, type PointerEvent as ReactPointerEvent } from "react";
import type { AssetAspectFilter, AssetMediaFilter, AssetView } from "../library/types";

/**
 * Hover-intent prefetch for folder switches (data only, read-only).
 *
 * When a mouse pointer rests on a folder entry for FOLDER_PREFETCH_DWELL_MS, the planner starts the
 * same first-page reads the switch would make. Each read lands in a one-shot cache keyed by the API
 * object, the command and its exact arguments; the switch takes the entry instead of reading again.
 * Entries live FOLDER_PREFETCH_FRESH_MS at most and any library change drops them, so in doubt the
 * switch reads normally.
 */
export const FOLDER_PREFETCH_DWELL_MS = 150;
export const FOLDER_PREFETCH_FRESH_MS = 5_000;

type Entry = { at: number; epoch: number; folder?: { id: string; epoch: number }; promise: Promise<unknown> };
const caches = new WeakMap<object, Map<string, Entry>>();
let epoch = 0;
/** Per-folder epochs: a change inside one folder drops only the reads tagged with it. */
const folderEpochs = new Map<string, number>();
const invalidationListeners = new Set<() => void>();
/** Revision caches of mount-wide reads follow the App's existing library-change invalidation. */
export function onFolderPrefetchInvalidated(listener: () => void) {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/** JSON with sorted object keys, so a request object's key does not depend on property order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().flatMap(key => {
      const item = (value as Record<string, unknown>)[key];
      return item === undefined ? [] : [`${JSON.stringify(key)}:${stableJson(item)}`];
    }).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const fresh = (entry: Entry) => entry.epoch === epoch && Date.now() - entry.at <= FOLDER_PREFETCH_FRESH_MS
  && (!entry.folder || entry.folder.epoch === (folderEpochs.get(entry.folder.id) ?? 0));

/**
 * Start (or join) a prefetched read. Never call it for a write. `folder` tags a read whose result
 * depends only on that folder, so `invalidateFolderPrefetch(folder)` can drop it alone.
 */
export function prefetchRead<T>(source: object, command: string, args: unknown, read: () => Promise<T>, folder?: string): Promise<T> {
  let cache = caches.get(source);
  if (!cache) caches.set(source, cache = new Map());
  for (const [key, entry] of cache) if (!fresh(entry)) cache.delete(key);
  const key = `${command}:${stableJson(args)}`;
  const existing = cache.get(key);
  if (existing) return existing.promise as Promise<T>;
  const promise = read();
  promise.catch(() => undefined);
  cache.set(key, { at: Date.now(), epoch, ...(folder ? { folder: { id: folder, epoch: folderEpochs.get(folder) ?? 0 } } : {}), promise });
  return promise;
}

/** The switch's read: takes a fresh prefetched result for exactly this request, else reads now. */
export function prefetchedRead<T>(source: object, command: string, args: unknown, read: () => Promise<T>): Promise<T> {
  const cache = caches.get(source);
  if (!cache) return read();
  const key = `${command}:${stableJson(args)}`;
  const entry = cache.get(key);
  if (!entry) return read();
  // React StrictMode replays mount effects synchronously. Both effects take the same read;
  // a subsequent switch/reload still sees the normal one-shot cache after this microtask.
  queueMicrotask(() => { if (cache.get(key) === entry) cache.delete(key); });
  if (!fresh(entry)) return read();
  // A failed prefetch is not the switch's answer.
  return (entry.promise as Promise<T>).catch(() => read());
}

/**
 * Drop every prefetched result (any library change), or with `folder` only the reads tagged with
 * that folder (a change of its members alone; the mount-wide revision caches stay). Reads still
 * running are ignored when they land.
 */
export function invalidateFolderPrefetch(folder?: string) {
  if (folder !== undefined) {
    folderEpochs.set(folder, (folderEpochs.get(folder) ?? 0) + 1);
    return;
  }
  epoch += 1;
  invalidationListeners.forEach(listener => listener());
}

// ---- Hover intent: one dwell timer, one prefetch in flight, only the latest hovered target waits.

type Intent = { id: string; run: () => Promise<unknown>[] | null };
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: string | null = null;
let queued: Intent | null = null;
let running: number | null = null;
let runs = 0;

function start(intent: Intent) {
  if (running !== null) { queued = intent; return; }
  const reads = intent.run();
  if (!reads?.length) return;
  const run = running = ++runs;
  void Promise.allSettled(reads).then(() => {
    if (running !== run) return;
    running = null;
    const next = queued;
    queued = null;
    if (next) start(next);
  });
}

export function hoverFolder(intent: Intent) {
  if (pending === intent.id) return;
  if (timer !== null) clearTimeout(timer);
  // A newer hover replaces whatever waited for the running prefetch.
  queued = null;
  pending = intent.id;
  timer = setTimeout(() => { timer = null; pending = null; start(intent); }, FOLDER_PREFETCH_DWELL_MS);
}

export function leaveFolder(id: string) {
  if (pending === id && timer !== null) { clearTimeout(timer); timer = null; pending = null; }
  if (queued?.id === id) queued = null;
}

/** Test helper: forget timers, queue and cached results. */
export function resetFolderPrefetch() {
  if (timer !== null) clearTimeout(timer);
  timer = null; pending = null; queued = null; running = null;
  invalidateFolderPrefetch();
}

// ---- Plain-folder filters of the mounted AssetBrowser, so a prefetch builds the switch's exact query.

export type AssetFolderFilters = { mediaFilter: AssetMediaFilter; aspectFilter: AssetAspectFilter; randomPivot: string | null };
let folderFilters: (() => AssetFolderFilters) | null = null;
export function publishAssetFolderFilters(read: () => AssetFolderFilters) {
  folderFilters = read;
  return () => { if (folderFilters === read) folderFilters = null; };
}
export const assetFolderFilters = () => folderFilters?.() ?? null;

// ---- React wiring: App provides the planner; folder entries spread the returned handlers.

/** Starts the first-page reads a switch to `view` would make, or null when there is nothing to prefetch. */
export type FolderPrefetchPlan = (view: AssetView) => Promise<unknown>[] | null;
export const FolderPrefetchContext = createContext<{ current: FolderPrefetchPlan } | null>(null);

const intentId = (view: AssetView) => JSON.stringify(view);

export function useFolderPrefetchIntent() {
  const plan = useContext(FolderPrefetchContext);
  return (view: AssetView) => {
    if (!plan) return {};
    const id = intentId(view);
    return {
      onPointerEnter: (event: ReactPointerEvent) => {
        // Mouse only, and not while a button is held (drags onto a folder are not switches).
        if (event.pointerType !== "mouse" || event.buttons !== 0) return;
        hoverFolder({ id, run: () => plan.current(view) });
      },
      onPointerLeave: () => leaveFolder(id),
    };
  };
}
