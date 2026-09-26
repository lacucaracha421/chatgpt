import {allMangaWorks, type MangaShelf, type ReleaseEvent} from './collectionReleases';

/**
 * The manga shelf and unread release events last read for the 신간 screen, shared with Home.
 *
 * Reading the shelf means paging through every manga Collection, so it is read once per
 * `epoch` and reused by whichever screen asks next. The epoch moves when the Collections
 * publication (or a personal edit) changed, or on a pull; a shelf or event list read under an
 * older epoch is read again on its next show. Events are also re-read when the release list
 * revision moves. The store is module-level, so the App resets it when the connection changes.
 */
export type ReleaseStore = {
  shelf: MangaShelf | null; shelfEpoch: number | null;
  events: ReleaseEvent[]; eventsEpoch: number | null; eventsRevision: number | null;
  /** Both the shelf and the events have been read at least once (the 신간 screen's first paint). */
  loaded: boolean;
};
export const emptyReleaseStore = (): ReleaseStore => ({shelf: null, shelfEpoch: null, events: [], eventsEpoch: null, eventsRevision: null, loaded: false});

let epoch = 0;
/** The last Collections publication revision that already moved the epoch (so one revision moves it once). */
let observed: string | null = null;
let inflight: {epoch: number; promise: Promise<MangaShelf>; controller: AbortController; waiters: number} | null = null;
const listeners = new Set<() => void>();
export const releaseStore: {current: ReleaseStore} = {current: emptyReleaseStore()};

const notify = () => Array.from(listeners).forEach(listener => listener());
export function releaseEpoch() { return epoch; }
export function subscribeReleases(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function commitReleases(next: ReleaseStore) { releaseStore.current = next; notify(); }
/** The publication moved (or a pull): everything is read again on its next show. */
export function invalidateReleases() { epoch++; notify(); }
/** The shelf read under the current epoch, if any. */
export function currentShelf(): MangaShelf | null {
  const state = releaseStore.current;
  return state.shelf && state.shelfEpoch === epoch ? state.shelf : null;
}
/**
 * A publication revision seen elsewhere (the Collections list or the status check). A kept
 * shelf from another revision is out of date; each distinct revision invalidates at most once,
 * so a shelf whose own revision reads differently can never cause a read loop.
 */
export function observePublication(revision: string | null | undefined) {
  const shelf = releaseStore.current.shelf;
  if (!revision || !shelf || shelf.revision === revision || observed === revision) return;
  observed = revision;
  invalidateReleases();
}
/** Forget everything (a different connection). */
export function resetReleaseStore() {
  inflight?.controller.abort(); inflight = null;
  epoch = 0; observed = null;
  commitReleases(emptyReleaseStore());
}

/**
 * The shelf for the current epoch: kept, or read once and shared by every caller that asks
 * while it is in flight. The read is cancelled only when every caller has gone away.
 */
export function loadShelf(signal: AbortSignal): Promise<MangaShelf> {
  const kept = currentShelf();
  if (kept) return Promise.resolve(kept);
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  if (!inflight || inflight.epoch !== epoch) {
    inflight?.controller.abort();
    const controller = new AbortController(), at = epoch;
    const promise = allMangaWorks(controller.signal).then(shelf => {
      if (at === epoch) commitReleases({...releaseStore.current, shelf, shelfEpoch: at});
      return shelf;
    }).finally(() => { if (inflight?.promise === promise) inflight = null; });
    promise.catch(() => {});
    inflight = {epoch: at, promise, controller, waiters: 0};
  }
  const entry = inflight;
  entry.waiters++;
  return new Promise<MangaShelf>((resolve, reject) => {
    const leave = () => {
      entry.waiters--;
      if (!entry.waiters) entry.controller.abort();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', leave, {once: true});
    entry.promise.then(value => { signal.removeEventListener('abort', leave); entry.waiters--; resolve(value); },
      reason => { signal.removeEventListener('abort', leave); entry.waiters--; reject(reason); });
  });
}
