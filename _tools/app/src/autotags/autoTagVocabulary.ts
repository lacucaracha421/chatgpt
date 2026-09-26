/**
 * The tagger vocabulary with library counts, loaded once and shared (autocomplete, the 찾기
 * palette, hover counts). An edit or import marks it stale; the next reader reloads it.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AutoTagGateway, AutoTagVocabularyEntry } from "./types";

export type AutoTagVocabulary = { entries: AutoTagVocabularyEntry[]; byTag: ReadonlyMap<string, AutoTagVocabularyEntry> };

let version = 0;
let loaded: { version: number; gateway: AutoTagGateway; promise: Promise<AutoTagVocabulary> } | null = null;
const listeners = new Set<() => void>();

export function invalidateAutoTagVocabulary() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function loadAutoTagVocabulary(gateway: AutoTagGateway): Promise<AutoTagVocabulary> {
  if (loaded?.version === version && loaded.gateway === gateway) return loaded.promise;
  const promise = gateway.vocabulary().then((entries) => ({ entries, byTag: new Map(entries.map((entry) => [entry.tag, entry])) }));
  loaded = { version, gateway, promise };
  // A failed load is retried by the next reader.
  promise.catch(() => { if (loaded?.promise === promise) loaded = null; });
  return promise;
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getVersion = () => version;

/** The vocabulary while `enabled`; null until loaded or when unavailable. Keeps the last copy while reloading. */
export function useAutoTagVocabulary(gateway: AutoTagGateway | undefined, enabled = true): AutoTagVocabulary | null {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [vocabulary, setVocabulary] = useState<AutoTagVocabulary | null>(null);
  useEffect(() => {
    if (!gateway || !enabled) return;
    let active = true;
    void loadAutoTagVocabulary(gateway).then((next) => { if (active) setVocabulary(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [current, enabled, gateway]);
  return gateway ? vocabulary : null;
}
