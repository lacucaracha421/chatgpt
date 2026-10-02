import { useSyncExternalStore } from "react";
import type { LibraryGateway, LaunchBoxSpineOutcome, WorkArtworkSummary, CollectionSummary } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";

type BatchState = { phase: "정보" | "책등"; running: boolean; cancelling: boolean; processed: number; total: number; message: string | null; error: boolean };
const idle: BatchState = { phase: "책등", running: false, cancelling: false, processed: 0, total: 0, message: null, error: false };
type Session = {
  batch: BatchState;
  listeners: Set<() => void>;
  attempts: Map<string, Promise<LaunchBoxSpineOutcome | null>>;
  retryAfter: Map<string, number>;
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
    value = { batch: idle, listeners: new Set(), attempts: new Map(), retryAfter: new Map(), revisions: new Map(), cancelRequested: false, jobId: null };
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
/** Information is checked even with an existing spine; native storage preserves that artwork.
 * Completed matches/misses survive navigation; transient failures have a short cooldown. */
export function requestMissingGameSpine(gateway: LibraryGateway, scope: string, collection: CollectionSummary, _artworks: WorkArtworkSummary[], onInformationChanged?: () => Promise<void>) {
  if (collection.type !== "game" || !gateway.fetchLaunchBoxSpine) return null;
  const value = session(gateway, scope);
  if ((value.retryAfter.get(collection.id) ?? 0) > Date.now()) return null;
  let request = value.attempts.get(collection.id);
  if (!request) {
    const fetch = gateway.fetchLaunchBoxSpine;
    request = Promise.resolve().then(() => fetch(collection.id)).then(outcome => {
      if (outcome.status === "matched" || outcome.platformsFilled) artworkChanged(value, collection.id);
      if (outcome.informationUpdated) void onInformationChanged?.().catch(() => undefined);
      if (outcome.status === "failed" || outcome.informationError) {
        value.attempts.delete(collection.id);
        value.retryAfter.set(collection.id, Date.now() + 30_000);
        return null;
      }
      value.retryAfter.delete(collection.id);
      return outcome;
    }).catch(() => {
      value.attempts.delete(collection.id);
      value.retryAfter.set(collection.id, Date.now() + 30_000);
      return null;
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
    let platformsFilled = 0;
    let informationFailures = 0;
    try {
      update({ phase: "정보", total: 0 });
      let infoCursor: string | null = null;
      let infoProcessed = 0;
      while (!value.cancelRequested) {
        const jobId = crypto.randomUUID();
        value.jobId = jobId;
        const result = await gateway.fetchLaunchBoxSpines({ action: "run", jobId, limit: 50, informationOnly: true, ...(infoCursor ? { afterCollectionId: infoCursor } : {}) }, progress => {
          if (progress.jobId !== jobId) return;
          update({ processed: infoProcessed + progress.processed, total: Math.max(value.batch.total, infoProcessed + progress.total) });
        });
        value.jobId = null;
        platformsFilled += result.platformsFilled ?? 0;
        informationFailures += result.outcomes.filter(outcome => outcome.informationError).length;
        infoProcessed += result.outcomes.length;
        update({ processed: infoProcessed });
        if (result.outcomes.length || result.platformsFilled) await onChanged();
        if (result.cancelled) value.cancelRequested = true;
        if (result.cancelled || !result.hasMore) break;
        if (!result.nextCursor || result.nextCursor === infoCursor) throw new Error("정보 채우기를 이어갈 수 없습니다.");
        infoCursor = result.nextCursor;
      }
      update({ phase: "책등", processed: 0 });
      // Every visited game produces an outcome, including games with an existing spine.
      let total = collections.filter(item => item.type === "game").length;
      update({ total });
      const updateProgress = (visited: number) => {
        // Include additional games if the library changes after the initial snapshot.
        total = Math.max(total, visited);
        update({ processed: visited, total });
      };
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
          updateProgress(base + progress.processed);
          if (progress.outcome) refresh(progress.outcome);
        });
        value.jobId = null;
        for (const outcome of result.outcomes) {
          counts[outcome.status] += 1;
          if (!value.attempts.has(outcome.collectionId)) value.attempts.set(outcome.collectionId, Promise.resolve(outcome));
          refresh(outcome);
        }
        processed += result.outcomes.length;
        updateProgress(processed);
        if (refreshed.size) await onChanged();
        if (result.cancelled || value.cancelRequested || !result.hasMore) break;
        if (!result.nextCursor || result.nextCursor === cursor) throw new Error("책등 받기를 이어갈 수 없습니다.");
        cursor = result.nextCursor;
      }
      update({ message: `책등 ${counts.matched}개 받음 · 못 찾음 ${counts.no_match} · 애매함 ${counts.ambiguous} · 실패 ${counts.failed} · 플랫폼 ${platformsFilled}개 채움${informationFailures ? ` · 정보 실패 ${informationFailures}` : ""}${value.cancelRequested ? " · 취소됨" : ""}` });
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
