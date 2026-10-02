import {useEffect, useRef, useState} from 'react';
import {useSyncSignal, syncSignal} from './syncSignals';
import {useVisibleInterval} from './useVisibleInterval';

/** Home keeps a source for one minute while the tab is unmounted and remounted. */
export const HOME_SOURCE_TTL = 60_000;

type Entry = {value: unknown; at: number; signal?: string};
const cache = new Map<string, Entry>();
const MAX_ENTRIES = 64;

const cacheKey = (scope: string, source: string) => `${scope}\u0000${source}`;

export function resetHomeSourceCache(scope?: string) {
  if (scope === undefined) { cache.clear(); return; }
  for (const key of cache.keys()) if (key.startsWith(`${scope}\u0000`)) cache.delete(key);
}

function currentEntry(scope: string, source: string) {
  return cache.get(cacheKey(scope, source));
}

function store(key: string, entry: Entry) {
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort(([, left], [, right]) => left.at - right.at)[0]?.[0];
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function isFresh(entry: Entry | undefined, signalKey?: string) {
  if (!entry || Date.now() - entry.at >= HOME_SOURCE_TTL) return false;
  const current = signalKey ? syncSignal(signalKey) : undefined;
  return current === undefined || entry.signal === undefined || current === entry.signal;
}

export type HomeSourceOptions<T> = {
  enabled: boolean;
  scope: string;
  source: string;
  signalKey?: string;
  initial: T;
  forceKey?: unknown;
  forceOnMount?: boolean;
  read(signal: AbortSignal): Promise<T>;
  onError?(reason: unknown): void;
};

/**
 * A small in-memory source cache shared by Home's short lived tab components. It is deliberately
 * bounded by source and connection scope, and uses the existing sync signal plus visibility
 * timer to decide when a fresh read is needed.
 */
export function useCachedHomeSourceRead<T>({enabled, scope, source, signalKey, initial, forceKey, forceOnMount = false, read, onError}: HomeSourceOptions<T>) {
  const key = cacheKey(scope, source);
  const readRef = useRef(read); readRef.current = read;
  const errorRef = useRef(onError); errorRef.current = onError;
  const forceRef = useRef(forceKey);
  const firstRender = useRef(true);
  const forceChanged = (firstRender.current && forceOnMount) || forceRef.current !== forceKey;
  firstRender.current = false;
  forceRef.current = forceKey;
  const [signalRevision, setSignalRevision] = useState(0);
  const [value, setValue] = useState<T>(() => {
    const entry = currentEntry(scope, source);
    return entry ? entry.value as T : initial;
  });

  const [readState, setReadState] = useState(() => ({key, forceKey, signalRevision, ready: !forceChanged && isFresh(currentEntry(scope, source), signalKey)}));

  useSyncSignal(signalKey ?? '', () => {
    const entry = cache.get(key);
    if (entry) store(key, {...entry, at: 0});
    setSignalRevision(revision => revision + 1);
  }, enabled && !!signalKey);

  useEffect(() => {
    const entry = currentEntry(scope, source);
    if (entry) setValue(entry.value as T);
    else setValue(initial);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) return;
    const entry = currentEntry(scope, source);
    if (!forceChanged && isFresh(entry, signalKey)) {
      setReadState({key, forceKey, signalRevision, ready: true});
      return;
    }
    setReadState({key, forceKey, signalRevision, ready: false});
    const controller = new AbortController();
    let live = true;
    if (entry) setValue(entry.value as T);
    void readRef.current(controller.signal).then(next => {
      if (!live || controller.signal.aborted) return;
      store(key, {value: next, at: Date.now(), signal: signalKey ? syncSignal(signalKey) : undefined});
      setValue(next);
      setReadState({key, forceKey, signalRevision, ready: true});
    }, reason => {
      if (live && !controller.signal.aborted) errorRef.current?.(reason);
    });
    return () => { live = false; controller.abort(); };
  }, [enabled, key, signalKey, forceKey, signalRevision]); // read/onError intentionally use refs

  const entry = currentEntry(scope, source);
  const nextCheck = enabled ? Math.max(1_000, (entry?.at && entry.at > 0 ? entry.at : Date.now()) + HOME_SOURCE_TTL - Date.now()) : null;
  useVisibleInterval(() => setSignalRevision(revision => revision + 1), nextCheck);
  const ready = readState.key === key && Object.is(readState.forceKey, forceKey)
    && readState.signalRevision === signalRevision && readState.ready;
  return {value, ready};
}

export function useCachedHomeSource<T>(options: HomeSourceOptions<T>): T {
  return useCachedHomeSourceRead(options).value;
}
