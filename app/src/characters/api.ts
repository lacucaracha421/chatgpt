import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";

export type CharacterRef = { slot: number; assetId: string | null; assetHash: string; status: string };
export type CharacterTarget = { id: string; seriesClassificationId: string | null; linkedClassificationId: string | null; displayName: string; description?: string; thumbnailAssetId?: string | null; enabled: boolean; revision: number; references: CharacterRef[]; learnedReferences?: CharacterRef[]; ready: boolean; fingerprint: string };
export type TargetDraft = { id: string | null; expectedRevision: number | null; seriesClassificationId: string; linkedClassificationId: string | null; displayName: string; description?: string; thumbnailAssetId?: string | null; enabled: boolean };
export type ScanStatus = { automaticQueued?: number; id: string; targetId: string; targetFingerprint: string; runtimeFingerprint: string | null; state: string; total: number; completed: number; errors: number; reused?: number; cacheHits: number; extractions: number; error: string | null };
export type Prediction = { targetId: string; targetName: string; targetFingerprint: string; scanId: string | null; runtimeFingerprint: string | null; state: string; decision: string | null; evidence: { referenceHashes?: string[]; learnedReferenceCount?: number; distance: number; bestQueryCrop: number; queryBoxes: number[][]; wholeFallback: boolean; evidence: { queryCrop: number; matchedReferences: number[]; referenceDistances: number[] }[] } | null; error: string | null };
export type ReviewRow = { asset: AssetSummary; predictions: Prediction[] };
export type ReviewPage = { rows: ReviewRow[]; nextCursor: string | null };
export type ReviewFilter = "all" | "recommended" | "unmatched" | "multiple" | "confirmed" | "pending" | "error" | "rejected";
export type ReviewQuery = { seriesId: string; targetId: string | null; filter: ReviewFilter; after: string | null; limit: number };
export type DecisionKind = "accepted" | "rejected" | "cleared";
export type DecisionRequest = { targetId: string; expectedFingerprint: string; assetIds: string[]; decision: DecisionKind; baselineFingerprint: string | null; scanId: string | null };
export type Decision = { origin?: "manual" | "automatic"; sequence: number; assetId: string | null; sourceAssetId: string; decision: DecisionKind; createdAt: string; referenceSnapshot: string; targetFingerprint: string; baselineFingerprint: string | null };

export interface CharacterApi {
  targets(): Promise<CharacterTarget[]>;
  save(request: TargetDraft, strictSelection?: boolean): Promise<CharacterTarget>;
  refs(targetId: string, expectedRevision: number, assetIds: string[], strictSelection?: boolean): Promise<CharacterTarget>;
  excludeReference?(targetId: string, expectedRevision: number, assetId: string): Promise<CharacterTarget>;
  runs(): Promise<ScanStatus[]>;
  start(targetId: string, expectedFingerprint: string, automatic?: boolean): Promise<ScanStatus>;
  cancel(scanId: string): Promise<ScanStatus>;
  review(query: ReviewQuery): Promise<ReviewPage>;
  decide(request: DecisionRequest): Promise<number>;
  decideBatch(requests: DecisionRequest[]): Promise<number>;
  history(targetId: string, before: number | null): Promise<Decision[]>;
  retryFailed?(seriesId: string): Promise<number>;
  runtime(): Promise<boolean>;
  setup(): Promise<boolean>;
}
export const characterApi: CharacterApi = {
  targets: () => invoke("list_character_targets"),
  save: (request, strictSelection = false) => invoke("save_character_target", { request, strictSelection }),
  refs: (targetId, expectedRevision, assetIds, strictSelection = false) => invoke("replace_character_references", { targetId, expectedRevision, assetIds, strictSelection }),
  excludeReference: (targetId, expectedRevision, assetId) => invoke("exclude_character_reference", { targetId, expectedRevision, assetId }),
  runs: () => invoke("character_scan_runs"),
  start: (targetId, expectedFingerprint, automatic = false) => invoke("start_character_scan", { targetId, expectedFingerprint, automatic }),
  cancel: scanId => invoke("cancel_character_scan", { scanId }),
  review: query => invoke("character_review_page", { query }),
  decide: request => invoke("record_character_decisions", { request }),
  decideBatch: requests => invoke("record_character_decision_batch", { requests }),
  history: (targetId, before) => invoke("list_character_decisions", { targetId, before, limit: 50 }),
  retryFailed: seriesId => invoke("retry_failed_character_assets", { seriesId }),
  runtime: () => invoke("character_runtime_status"),
  setup: () => invoke("setup_character_runtime"),
};

export const isRunning = (scan: ScanStatus) => scan.state === "running" || scan.state === "cancelling";
export function predictionRequest(prediction: Prediction, assetIds: string[], decision: DecisionKind): DecisionRequest {
  if (!prediction.scanId || !prediction.runtimeFingerprint || !prediction.evidence || !["recommended", "unmatched"].includes(prediction.state)) throw new Error("분석 결과가 오래되었습니다. 다시 분석해 주세요.");
  return { targetId: prediction.targetId, expectedFingerprint: prediction.targetFingerprint, assetIds, decision, scanId: prediction.scanId, baselineFingerprint: prediction.runtimeFingerprint };
}

export function moveAssetsToCharacter(targetId: string, expectedFingerprint: string, assetIds: string[]): Promise<number> {
  return invoke("move_assets_to_character", { targetId, expectedFingerprint, assetIds });
}
