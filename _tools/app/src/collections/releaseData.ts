import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { CollectionTrackingGateway, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";

/**
 * The 신간 data shared by the Collections grid and the 신간 view: the release board (every manga's
 * 신간 알림, owned counts and Kakao/MangaDex volumes) and the unread inbox, read together once.
 *
 * It lives outside both views, so opening the 신간 view again (or returning from a work) reuses
 * it. It is read again only when
 * - `source` changes: the app's Collection list (`listCollections`), which is replaced after every
 *   release check, provider refresh, mobile read-state sync and Collection edit;
 * - `invalidateReleaseData()` is called: an owned count or 신간 알림 changed in a work, which does
 *   not replace the Collection list;
 * - the 신간 view asks for it (업데이트 확인).
 * While a re-read is in flight the previous data stays on screen.
 */
export type ReleaseData = { board: Map<string, ReleaseBoardEntry>; inbox: ReleaseInboxItem[] };
type Entry = { api: CollectionTrackingGateway; source: unknown; generation: number; data: ReleaseData | null; loading: boolean; error: unknown };

let current: Entry | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
let acknowledgements = new WeakMap<CollectionTrackingGateway, Set<string>>();
const eventKey = (item: ReleaseInboxItem) => JSON.stringify([item.collectionId, item.event.id]);

/** Hide exact events immediately, including stale reads racing the native acknowledgement.
 * Native reads also project queued authority acknowledgements, including after a restart.
 */
export async function acknowledgeReleaseItems(api: CollectionTrackingGateway, items: ReleaseInboxItem[]) {
  let hidden = acknowledgements.get(api);
  if (!hidden) { hidden = new Set(); acknowledgements.set(api, hidden); }
  const fresh = items.filter(item => !hidden.has(eventKey(item)));
  for (const item of fresh) hidden.add(eventKey(item));
  notify();
  const remaining = new Set(fresh.map(eventKey));
  try {
    const batches = new Map<string, ReleaseInboxItem[]>();
    for (const item of fresh) batches.set(item.collectionId, [...(batches.get(item.collectionId) ?? []), item]);
    for (const [id, events] of batches) {
      for (let offset = 0; offset < events.length; offset += 2000) {
        const batch = events.slice(offset, offset + 2000);
        await api.acknowledge(id, batch.map(item => item.event.id));
        for (const item of batch) remaining.delete(eventKey(item));
      }
    }
  } catch (error) {
    for (const key of remaining) hidden.delete(key);
    notify();
    throw error;
  }
}

/** Marks the cached 신간 data stale; the next reader (or the mounted one) reads again. */
export function invalidateReleaseData() {
  generation += 1;
  notify();
}

function ensure(api: CollectionTrackingGateway, source: unknown): Entry {
  if (current && current.api === api && current.source === source && current.generation === generation) return current;
  const entry: Entry = { api, source, generation, data: current?.api === api ? current.data : null, loading: true, error: null };
  current = entry;
  void Promise.all([api.releaseBoard ? api.releaseBoard() : Promise.resolve([] as ReleaseBoardEntry[]), api.listInbox()]).then(([board, inbox]) => {
    if (current !== entry) return;
    current = { ...entry, data: { board: new Map(board.map((item) => [item.collectionId, item])), inbox }, loading: false };
    notify();
  }, (error: unknown) => {
    if (current !== entry) return;
    current = { ...entry, loading: false, error };
    notify();
  });
  return entry;
}

export function useReleaseData(api: CollectionTrackingGateway | undefined, source: unknown, enabled: boolean) {
  const [revision, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(rerender);
    return () => { listeners.delete(rerender); };
  }, [enabled]);
  const entry = api && enabled ? ensure(api, source) : null;
  const data = useMemo(() => entry?.data && api ? {
    ...entry.data, inbox: entry.data.inbox.filter(item => !acknowledgements.get(api)?.has(eventKey(item))),
  } : null, [entry?.data, api, revision]);
  const reload = useCallback(() => invalidateReleaseData(), []);
  return { data, loading: entry?.loading ?? false, error: entry?.error ?? null, reload };
}

/** Test seam: forget the shared cache between tests. */
export function resetReleaseDataForTests() {
  current = null;
  generation = 0;
  acknowledgements = new WeakMap();
}
