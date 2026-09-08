// Test/visual fixture only. Not imported by the application entry point.
import type { AssetSummary, ClassificationEntry } from "../library/types";
import type { CharacterApi, CharacterTarget, Decision, Prediction, ReviewRow, ScanStatus } from "./api";

export const fixtureClassifications: ClassificationEntry[] = [{ id: "series", name: "블루 아카이브", kind: "root", parentId: null, iconKey: null, colorKey: null }, { id: "child", name: "히나", kind: "tag", parentId: "series", iconKey: null, colorKey: null }];
export const fixtureAssets: AssetSummary[] = Array.from({ length: 18 }, (_, i) => ({ id: `image-${i}`, title: null, originalName: `이미지 ${i}.webp`, byteSize: 100000, width: i % 3 === 0 ? 1000 : 700, height: i % 3 === 0 ? 700 : 1000, collectedAt: "2026-09-08T01:30:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: "보관한 이미지", creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } }));
export function fixtureTarget(id = "hina", name = "히나"): CharacterTarget { return { id, displayName: name, seriesClassificationId: "series", linkedClassificationId: "child", enabled: true, revision: 1, fingerprint: `fingerprint-${id}`, ready: true, references: fixtureAssets.slice(0, 5).map((a, slot) => ({ slot, assetId: a.id, assetHash: `hash-${a.id}`, status: "ready" })) }; }
export function createCharacterFixture(): CharacterApi {
  let targets = [fixtureTarget(), fixtureTarget("kisaki", "키사키")];
  const history: Decision[] = [];
  const decisions = new Map<string, string>();
  let scans: ScanStatus[] = targets.map(t => ({ id: `scan-${t.id}`, targetId: t.id, targetFingerprint: t.fingerprint, runtimeFingerprint: "runtime", state: "completed", total: 13, completed: 13, errors: 0, cacheHits: 18, extractions: 0, error: null }));
  const api: CharacterApi = {
    automaticSeries: async () => [],
    applyAutomatic: async () => 0,
    targets: async () => [...targets],
    save: async draft => {
      const old = targets.find(t => t.id === draft.id);
      const value = { ...fixtureTarget(draft.id ?? `new-${targets.length}`, draft.displayName), ...draft, id: draft.id ?? `new-${targets.length}`, revision: (old?.revision ?? 0) + 1, references: old?.references ?? [], ready: Boolean(old?.references.length === 5 && draft.enabled), fingerprint: `saved-${Date.now()}` };
      targets = [...targets.filter(t => t.id !== value.id), value]; return value;
    },
    refs: async (targetId, revision, assetIds) => { const old = targets.find(t => t.id === targetId)!; if (old.revision !== revision) throw new Error("설정이 바뀌었습니다."); const value = { ...old, revision: revision + 1, references: assetIds.map((assetId, slot) => ({ slot, assetId, assetHash: assetId, status: "ready" })), ready: assetIds.length === 5 }; targets = targets.map(t => t.id === targetId ? value : t); return value; },
    runs: async () => [...scans],
    start: async (targetId, targetFingerprint) => { const run = { id: `new-scan-${targetId}`, targetId, targetFingerprint, runtimeFingerprint: "runtime", state: "completed", total: 13, completed: 13, errors: 0, cacheHits: 18, extractions: 0, error: null }; scans = [...scans.filter(s => s.targetId !== targetId), run]; return run; },
    cancel: async id => { const run = scans.find(s => s.id === id)!; run.state = "cancelled"; return run; },
    review: async query => {
      const rows: ReviewRow[] = fixtureAssets.slice(5).map((asset, index) => ({
        asset,
        predictions: targets.filter(t => !query.targetId || t.id === query.targetId).map((t, i): Prediction => ({
          targetId: t.id, targetName: t.displayName, targetFingerprint: t.fingerprint,
          scanId: `scan-${t.id}`, runtimeFingerprint: "runtime",
          state: index % 4 === 3 || (i > 0 && index % 3 !== 0) ? "unmatched" : "recommended",
          decision: decisions.get(`${t.id}:${asset.id}`) ?? null, error: null,
          evidence: { distance: 0.12 + index / 100, bestQueryCrop: 0, queryBoxes: [[50, 70, 600, 640]], wholeFallback: false,
            evidence: [{ queryCrop: 0, matchedReferences: [0, 2, 4], referenceDistances: [0.1, 0.3, 0.12, 0.4, 0.16] }] },
        })),
      }));
      const matching = rows.filter(row => {
        const count = row.predictions.filter(p => p.state === "recommended" && !["accepted", "rejected"].includes(p.decision ?? "")).length;
        if (query.filter === "recommended") return count > 0;
        if (query.filter === "multiple") return count > 1;
        if (query.filter === "confirmed") return row.predictions.some(p => p.decision === "accepted");
        if (query.filter === "unmatched") return row.predictions.every(p => p.state === "unmatched");
        if (query.filter === "pending" || query.filter === "error") return false;
        return true;
      });
      return { rows: query.after ? [] : matching, nextCursor: null };
    },
    decide: async request => { for (const assetId of request.assetIds) { decisions.set(`${request.targetId}:${assetId}`, request.decision); history.unshift({ sequence: history.length + 1, assetId, sourceAssetId: assetId, decision: request.decision, createdAt: new Date().toISOString(), referenceSnapshot: "[]", targetFingerprint: request.expectedFingerprint, baselineFingerprint: request.baselineFingerprint }); } return request.assetIds.length; },
    decideBatch: async requests => { let total = 0; for (const request of requests) total += await api.decide(request); return total; },
    history: async (_id, before) => history.filter(d => before === null || d.sequence < before),
    runtime: async () => true,
    setup: async () => true,
  };
  return api;
}
