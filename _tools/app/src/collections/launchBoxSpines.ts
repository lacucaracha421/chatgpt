import { useSyncExternalStore } from "react";
import type { LibraryGateway, LaunchBoxSpineOutcome, WorkArtworkSummary, CollectionSummary } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";

type BatchState = { running: boolean; cancelling: boolean; processed: number; total: number; message: string | null; error: boolean };
const idle: BatchState = { running: false, cancelling: false, processed: 0, total: 0, message: null, error: false };
type Session = {
  batch: BatchState;
  listeners: Set<() => void>;
  attempts: Map<string, Promise<LaunchBoxSpineOutcome>>;
  revisions: Map<string, number>;
  cancelRequested: boolean;
  jobId: string | null;
};
const sessions = new WeakMap<LibraryGateway, Map<string, Session>>();
let runningBatch: Session | null = null;
function session(gateway: LibraryGateway, scope: string): Session {
  let scopes = sessions.get(gateway);
  if (!scopes) { scopes = new Map(); sessions.set(gateway, scopes); }
  let value = scopes.get(scope);
  if (!value) {
    value = { batch: idle, listeners: new Set(), attempts: new Map(), revisions: new Map(), cancelRequested: false, jobId: null };
    scopes.set(scope, value);
  }
  return value;
}
function notify(value: Session) { value.listeners.forEach(listener => listener()); }
function artworkChanged(value: Session, id: string) {
  value.revisions.set(id, (value.revisions.get(id) ?? 0) + 1);
  notify(value);
}
export function useSpineArtworkRevision(gateway: LibraryGateway, scope: string, id: string) {
  const value = session(gateway, scope);
  return useSyncExternalStore(listener => { value.listeners.add(listener); return () => { value.listeners.delete(listener); }; }, () => value.revisions.get(id) ?? 0);
}
export function selectedSpine(artworks: WorkArtworkSummary[]) {
  const spines = artworks.filter(item => item.kind === "spine");
  return spines.find(item => item.selected) ?? spines[0];
}
/** Attempts (including rejected commands) survive work navigation for this library session. */
export function requestMissingGameSpine(gateway: LibraryGateway, scope: string, collection: CollectionSummary, artworks: WorkArtworkSummary[]) {
  if (collection.type !== "game" || selectedSpine(artworks) || !gateway.fetchLaunchBoxSpine) return null;
  const value = session(gateway, scope);
  let request = value.attempts.get(collection.id);
  if (!request) {
    const fetch = gateway.fetchLaunchBoxSpine;
    request = Promise.resolve().then(() => fetch(collection.id)).then(outcome => {
      if (outcome.status === "matched") artworkChanged(value, collection.id);
      return outcome;
    });
    value.attempts.set(collection.id, request);
  }
  return request;
}
export function useLaunchBoxSpineBatch(gateway: LibraryGateway, scope: string) {
  const value = session(gateway, scope);
  const state = useSyncExternalStore(listener => { value.listeners.add(listener); return () => { value.listeners.delete(listener); }; }, () => value.batch);
  const update = (patch: Partial<BatchState>) => { value.batch = { ...value.batch, ...patch }; notify(value); };
  async function run(collections: CollectionSummary[], onChanged: () => Promise<void>) {
    if (runningBatch || !gateway.fetchLaunchBoxSpines) return;
    runningBatch = value;
    value.cancelRequested = false;
    update({ ...idle, running: true });
    const counts = { matched: 0, no_match: 0, ambiguous: 0, failed: 0, skipped: 0 };
    let processed = 0;
    try {
      // The backend progress total is page-local; count eligible games for the whole toolbar job.
      const games = collections.filter(item => item.type === "game");
      let total = 0;
      for (let offset = 0; offset < games.length && !value.cancelRequested; offset += 50) {
        const artwork = await Promise.all(games.slice(offset, offset + 50).map(item => gateway.listCollectionWorkArtworks(item.id)));
        total += artwork.filter(items => !selectedSpine(items)).length;
      }
      update({ total });
      let cursor: string | null = null;
      while (!value.cancelRequested) {
        // A page owns a fresh backend job; the UI lock covers the entire cursor loop.
        const jobId = crypto.randomUUID();
        value.jobId = jobId;
        const base = processed;
        const refreshed = new Set<string>();
        const refresh = (outcome: LaunchBoxSpineOutcome) => {
          if (outcome.status === "matched" && !refreshed.has(outcome.collectionId)) {
            refreshed.add(outcome.collectionId);
            artworkChanged(value, outcome.collectionId);
          }
        };
        const result = await gateway.fetchLaunchBoxSpines({ action: "run", jobId, limit: 50, ...(cursor ? { afterCollectionId: cursor } : {}) }, progress => {
          if (progress.jobId !== jobId) return;
          update({ processed: base + progress.processed });
          if (progress.outcome) refresh(progress.outcome);
        });
        value.jobId = null;
        for (const outcome of result.outcomes) {
          counts[outcome.status] += 1;
          if (!value.attempts.has(outcome.collectionId)) value.attempts.set(outcome.collectionId, Promise.resolve(outcome));
          refresh(outcome);
        }
        processed += result.outcomes.length;
        update({ processed });
        if (refreshed.size) await onChanged();
        if (result.cancelled || value.cancelRequested || !result.hasMore) break;
        if (!result.nextCursor || result.nextCursor === cursor) throw new Error("책등 받기를 이어갈 수 없습니다.");
        cursor = result.nextCursor;
      }
      update({ message: `책등 ${counts.matched}개 받음 · 못 찾음 ${counts.no_match} · 애매함 ${counts.ambiguous} · 실패 ${counts.failed}` });
    } catch (error) {
      update({ error: true, message: commandErrorMessage(error, "책등을 받지 못했습니다.") });
    } finally {
      value.jobId = null;
      runningBatch = null;
      update({ running: false, cancelling: false });
    }
  }
  async function cancel() {
    if (!value.batch.running || value.cancelRequested) return;
    value.cancelRequested = true;
    update({ cancelling: true });
    if (!value.jobId || !gateway.fetchLaunchBoxSpines) return;
    try { await gateway.fetchLaunchBoxSpines({ action: "cancel", jobId: value.jobId }); }
    catch (error) {
      value.cancelRequested = false;
      update({ cancelling: false, error: true, message: commandErrorMessage(error, "책등 받기를 취소하지 못했습니다.") });
    }
  }
  return { ...state, run, cancel, dismiss: () => update({ message: null }) };
}
