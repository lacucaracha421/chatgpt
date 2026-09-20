import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
import type { ReferenceRegionBinding, ReferenceRegionBindings } from "./hubApi";

export type ReferenceRegion = ReferenceRegionBinding;
export type ReferenceRegions = ReferenceRegionBindings;

/**
 * One inspected reference image and the person boxes the detector found in it.
 * `state` values are single | selected | automatic | needs_region | no_region | stale_region.
 */
export type ReferenceInspection = {
  assetId: string; contentHash: string; baselineFingerprint: string;
  width: number; height: number; boxes: [number, number, number, number][];
  /** An explicit stored choice, or the single unambiguous detection. */
  selectedIndex: number | null; suggestedIndex: number | null;
  /** The common person the worker inferred on its own; older workers omit it. */
  automaticIndex: number | null; state: string;
};

/**
 * Region states that supply a usable reference without asking the user anything.
 * `single` is a one-person detection and `automatic` is the common person the
 * worker inferred inside a multi-person image. Both are used, not merely advisory;
 * neither of them is a stored user selection.
 */
export const usableReferenceRegionStates = ["single", "selected", "automatic"] as const;

/**
 * An image the user still has to place. A stale binding is recoverable whenever the
 * detector still offers boxes: the stored region went out of date, but the person can
 * be re-chosen. `no_region` never invents a crop, so it is not treated as a choice.
 */
export const needsReferenceRegionChoice = (region: ReferenceInspection) =>
  region.state === "needs_region" || (region.state === "stale_region" && region.boxes.length > 0);

/** A stored binding that no longer matches the image and detector. */
export const staleReferenceRegion = (region: ReferenceInspection) => region.state === "stale_region";

/**
 * The crop this image currently stands for. `automatic` is the worker's inferred
 * choice, `single` is the only detection, and `selected` covers both an explicit
 * stored choice and an unambiguous detection.
 */
export function referenceRegionIndex(region: ReferenceInspection): number | null {
  if (region.state === "automatic") return region.automaticIndex;
  if (region.state === "single") return region.selectedIndex ?? 0;
  return region.selectedIndex;
}

export function regionBox(region: ReferenceInspection, index: number | null): [number, number, number, number] | null {
  return index === null ? null : region.boxes[index] ?? null;
}

/** The draft override a person box becomes once the user confirms it. */
export const referenceRegionBinding = (region: ReferenceInspection, index: number): ReferenceRegion | null => {
  const bounds = regionBox(region, index);
  return bounds ? { contentHash: region.contentHash, baselineFingerprint: region.baselineFingerprint, bounds } : null;
};

/** Only changed manual bindings are submitted; ordinary settings saves stay runtime-independent. */
export function draftReferenceRegions(regions: ReferenceRegions | undefined, referenceIds: string[], saved: ReferenceRegions = {}): ReferenceRegions {
  if (!regions) return {};
  return Object.fromEntries(referenceIds.flatMap(id => {
    const region = regions[id], prior = saved[id];
    if (!region || (prior && region.contentHash === prior.contentHash
      && region.baselineFingerprint === prior.baselineFingerprint
      && region.bounds.every((value, index) => value === prior.bounds[index]))) return [];
    return [[id, region] as const];
  }));
}

export type CharacterRef = { slot: number; assetId: string | null; assetHash: string; status: string; region?: ReferenceRegion | null };
export type CharacterTarget = { id: string; seriesClassificationId: string | null; linkedClassificationId: string | null; displayName: string; description?: string; thumbnailAssetId?: string | null; enabled: boolean; manualOnly: boolean; revision: number; references: CharacterRef[]; learnedReferences?: CharacterRef[]; ready: boolean; fingerprint: string };
export type TargetDraft = { id: string | null; expectedRevision: number | null; seriesClassificationId: string; linkedClassificationId: string | null; displayName: string; description?: string; thumbnailAssetId?: string | null; enabled: boolean };
export type CharacterSettingsDraft = TargetDraft & { referenceIds: string[]; referenceRegions?: ReferenceRegions };
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
  /** Optional so tests and older hosts can skip inspection entirely. */
  inspectReferenceRegions?(seriesId: string, targetId: string | null, assetIds: string[], regions?: ReferenceRegions): Promise<ReferenceInspection[]>;
  targets(): Promise<CharacterTarget[]>;
  save(request: TargetDraft, strictSelection?: boolean): Promise<CharacterTarget>;
  saveSettings(request: CharacterSettingsDraft, strictSelection?: boolean): Promise<CharacterTarget>;
  refs(targetId: string, expectedRevision: number, assetIds: string[], strictSelection?: boolean): Promise<CharacterTarget>;
  learnReferences?(targetId: string, expectedRevision: number, assetIds: string[]): Promise<CharacterTarget>;
  excludeReference?(targetId: string, expectedRevision: number, assetId: string): Promise<CharacterTarget>;
  runs(): Promise<ScanStatus[]>;
  start(targetId: string, expectedFingerprint: string, automatic?: boolean): Promise<ScanStatus>;
  cancel(scanId: string): Promise<ScanStatus>;
  review(query: ReviewQuery): Promise<ReviewPage>;
  reviewPending?(seriesId: string, targetId: string): Promise<boolean>;
  decide(request: DecisionRequest): Promise<number>;
  decideBatch(requests: DecisionRequest[]): Promise<number>;
  history(targetId: string, before: number | null): Promise<Decision[]>;
  retryFailed?(seriesId: string): Promise<number>;
  failedCount?(seriesId: string): Promise<number>;
  runtime(): Promise<boolean>;
  setup(): Promise<boolean>;
}
export const characterApi: CharacterApi = {
  inspectReferenceRegions: (seriesId, targetId, assetIds, regions = {}) => invoke("inspect_character_reference_regions", { seriesId, targetId, assetIds, regions }),
  targets: () => invoke("list_character_targets"),
  save: (request, strictSelection = false) => invoke("save_character_target", { request, strictSelection }),
  saveSettings: (request, strictSelection = false) => invoke("save_character_settings", { request, strictSelection }),
  refs: (targetId, expectedRevision, assetIds, strictSelection = false) => invoke("replace_character_references", { targetId, expectedRevision, assetIds, strictSelection }),
  learnReferences: (targetId, expectedRevision, assetIds) => invoke("add_character_learned_references", { targetId, expectedRevision, assetIds }),
  excludeReference: (targetId, expectedRevision, assetId) => invoke("exclude_character_reference", { targetId, expectedRevision, assetId }),
  runs: () => invoke("character_scan_runs"),
  start: (targetId, expectedFingerprint, automatic = false) => invoke("start_character_scan", { targetId, expectedFingerprint, automatic }),
  cancel: scanId => invoke("cancel_character_scan", { scanId }),
  reviewPending: (seriesId, targetId) => invoke("character_review_pending", { seriesId, targetId }),
  review: query => invoke("character_review_page", { query }),
  decide: request => invoke("record_character_decisions", { request }),
  decideBatch: requests => invoke("record_character_decision_batch", { requests }),
  history: (targetId, before) => invoke("list_character_decisions", { targetId, before, limit: 50 }),
  retryFailed: seriesId => invoke("retry_failed_character_assets", { seriesId }),
  failedCount: seriesId => invoke("failed_character_asset_count", { seriesId }),
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
