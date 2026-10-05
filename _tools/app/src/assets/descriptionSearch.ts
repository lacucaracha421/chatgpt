import { useEffect, useMemo, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import type { DescriptionSearchResult, LibraryGateway } from "../library/types";

/** 내용 검색 (natural-language image search): shared by the 찾기 palette preview and the 에셋 result state. */
export const DESCRIPTION_SEARCH_LIMIT = 200;
export const DESCRIPTION_PREVIEW_COUNT = 7;
/** Two or more characters, or one complete Hangul syllable (밤, 눈): a lone jamo or Latin letter is not a description. */
export function descriptionQueryReady(text: string) {
  const typed = text.trim();
  return typed.length >= 2 || /^[가-힣]$/.test(typed);
}
/** The preview asks only after typing has paused this long (and no Hangul composition is active). */
export const DESCRIPTION_TYPING_PAUSE_MS = 400;
const CACHE_LIMIT = 24;

type Search = NonNullable<LibraryGateway["searchByDescription"]>;
export type DescriptionSearchSource = {
  status: NonNullable<LibraryGateway["descriptionSearchStatus"]>;
  prewarm: NonNullable<LibraryGateway["prewarmDescriptionSearch"]>;
  search: Search;
};
type CacheEntry = { promise: Promise<DescriptionSearchResult>; result?: DescriptionSearchResult };

// Keyed by the gateway's search function, so each library gateway (and each test double) has its own cache.
const caches = new WeakMap<Search, Map<string, CacheEntry>>();

export function descriptionSearchKey(query: string) {
  return query.trim();
}

/** A forced answer (the "no match" gate skipped) is a different answer from the gated one for the same text. */
function cacheKey(query: string, force: boolean) {
  return `${force ? "force" : "gated"}:${descriptionSearchKey(query)}`;
}

/** The finished answer for a query, if the palette (or an earlier result state) already has it. */
export function cachedDescriptionSearch(search: Search, query: string, force = false): DescriptionSearchResult | undefined {
  return caches.get(search)?.get(cacheKey(query, force))?.result;
}

/**
 * Rank-ordered ids for a query. Reuses a finished or in-flight request for the same text and force; failures are not cached.
 * `force` skips the "no match" gate (route `noMatch`) and ranks the nearest images anyway; the palette never forces.
 */
export function searchDescription(search: Search, query: string, force = false): Promise<DescriptionSearchResult> {
  const text = descriptionSearchKey(query);
  const key = cacheKey(query, force);
  let cache = caches.get(search);
  if (!cache) caches.set(search, cache = new Map());
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.promise;
  }
  const entry: CacheEntry = { promise: force ? search(text, DESCRIPTION_SEARCH_LIMIT, true) : search(text, DESCRIPTION_SEARCH_LIMIT) };
  entry.promise.then(result => { entry.result = result; }, () => { if (cache.get(key) === entry) cache.delete(key); });
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return entry.promise;
}

export function descriptionSearchError(error: unknown) {
  return `내용 검색을 할 수 없습니다: ${commandErrorMessage(error, "알 수 없는 오류")}`;
}

export function descriptionSearchSource(gateway: LibraryGateway | null | undefined): DescriptionSearchSource | null {
  if (!gateway?.descriptionSearchStatus || !gateway.prewarmDescriptionSearch || !gateway.searchByDescription) return null;
  return { status: gateway.descriptionSearchStatus, prewarm: gateway.prewarmDescriptionSearch, search: gateway.searchByDescription };
}

export type DescriptionPreview = {
  /** False until the status read says the index and runtime are there. */
  available: boolean;
  /** The last answer shown in the strip; it stays painted until the next answer replaces it. */
  shown: { query: string; result: DescriptionSearchResult } | null;
  /** A request is running (the first one may wait for the query worker to start). */
  busy: boolean;
  error: string | null;
};

/**
 * Palette preview state. Reads the status (and starts the worker) when the palette opens, then asks
 * only after typing pauses with no composition active: one request at a time, the newest typed text
 * wins, older answers are cached but not shown.
 */
export function useDescriptionPreview({ source, open, query, composing, enabled }: {
  source: DescriptionSearchSource | null | undefined; open: boolean; query: string; composing: boolean; enabled: boolean;
}): DescriptionPreview {
  const [available, setAvailable] = useState(false);
  const [shown, setShown] = useState<DescriptionPreview["shown"]>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = source?.status;
  const prewarm = source?.prewarm;
  const search = source?.search;

  useEffect(() => {
    if (!open || !status) return;
    let active = true;
    void status().then(result => {
      if (!active) return;
      setAvailable(result.available);
      if (result.available) void prewarm?.().catch(() => undefined);
    }, () => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [open, status, prewarm]);

  // A new palette session starts its strip from the first-fill placeholders, not the previous session's images.
  useEffect(() => {
    if (!open) return;
    setShown(null); // no-flash-ok: the palette was closed, so nothing is painted
    setError(null);
  }, [open]);

  const latest = useRef<string | null>(null);
  const running = useRef(false);
  const queued = useRef<string | null>(null);
  const key = descriptionSearchKey(query);
  const wanted = open && enabled && available && search && !composing && descriptionQueryReady(key) ? key : null;

  useEffect(() => {
    if (!open) { latest.current = null; queued.current = null; }
  }, [open]);

  useEffect(() => {
    if (!wanted || !search) return;
    const cached = cachedDescriptionSearch(search, wanted);
    if (cached) {
      latest.current = wanted;
      queued.current = null;
      setShown({ query: wanted, result: cached });
      setError(null);
      return;
    }
    const run = (text: string) => {
      running.current = true;
      setBusy(true);
      void searchDescription(search, text).then(result => {
        if (latest.current !== text) return;
        setShown({ query: text, result });
        setError(null);
      }, (reason: unknown) => {
        if (latest.current === text) setError(descriptionSearchError(reason));
      }).finally(() => {
        running.current = false;
        const next = queued.current;
        queued.current = null;
        if (next && next === latest.current) run(next);
        else setBusy(false);
      });
    };
    const timer = window.setTimeout(() => {
      latest.current = wanted;
      if (running.current) queued.current = wanted;
      else run(wanted);
    }, DESCRIPTION_TYPING_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [wanted, search]);

  const usable = Boolean(source) && available;
  return useMemo(() => ({ available: usable, shown, busy, error }), [usable, shown, busy, error]);
}
