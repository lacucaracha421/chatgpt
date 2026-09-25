import { invoke } from "@tauri-apps/api/core";

/** One shadow-scored (asset, character) pair awaiting a manual judgment. */
export type ShadowReviewItem = {
  assetId: string;
  contentHash: string;
  originalName: string;
  width: number;
  height: number;
  targetId: string;
  targetName: string;
  targetFingerprint: string;
  referenceAssetIds: string[];
  verdict: "automatic" | "recommended" | "none";
  origin: "live" | "backfill";
  knn3: number | null;
  nativeOutcome: string;
  scoredAt: string;
};
export type ShadowVerdictCounts = { pending: number; accepted: number; rejected: number };
export type ShadowTierCounts = { automatic: ShadowVerdictCounts; recommended: ShadowVerdictCounts };
export type ShadowReviewSummary = ShadowTierCounts & { byOrigin: Record<"live" | "backfill", ShadowTierCounts>; doubtful?: ShadowVerdictCounts };
export type ShadowBackfillStatus = { running: boolean; preparing: boolean; total: number; scored: number; skipped: number; cancelled: boolean; error: string | null };
export type ShadowReviewPage = { items: ShadowReviewItem[]; nextOffset: number | null; policyVersion: string | null; summary: ShadowReviewSummary };
/** `doubtful`: existing automatic acceptances that S36 does not support. */
export type ShadowReviewMode = "candidates" | "doubtful";
/** `seriesId`: only that series' characters, items and counts alike; omitted = all series. */
export type ShadowReviewQuery = { offset: number; limit: number; mode?: ShadowReviewMode; seriesId?: string };

export interface ShadowReviewApi {
  page(query: ShadowReviewQuery): Promise<ShadowReviewPage>;
  start(): Promise<ShadowBackfillStatus>;
  status(): Promise<ShadowBackfillStatus>;
  cancel(): Promise<ShadowBackfillStatus>;
  /** Inbound mobile decisions applied on this PC; a change means the list moved under us. */
  inboundStatus?(): Promise<ShadowInboundStatus>;
}
export type ShadowInboundStatus = { applied: number };

/** Native shadow review and explicit cached history scoring; judgments use characterApi.decide. */
export const shadowReviewApi: ShadowReviewApi = {
  page: query => invoke("character_shadow_review_page", { query }),
  start: () => invoke("character_shadow_backfill_start"),
  status: () => invoke("character_shadow_backfill_status"),
  cancel: () => invoke("character_shadow_backfill_cancel"),
  inboundStatus: () => invoke("character_review_inbound_status"),
};

const emptyTiers = (): ShadowTierCounts => ({ automatic: { pending: 0, accepted: 0, rejected: 0 }, recommended: { pending: 0, accepted: 0, rejected: 0 } });
export const emptyShadowSummary = (): ShadowReviewSummary => ({ ...emptyTiers(), byOrigin: { live: emptyTiers(), backfill: emptyTiers() }, doubtful: { pending: 0, accepted: 0, rejected: 0 } });

export const shadowItemKey = (item: Pick<ShadowReviewItem, "assetId" | "targetId">) => `${item.assetId}:${item.targetId}`;

export const verdictLabel = (verdict: ShadowReviewItem["verdict"]) => verdict === "automatic" ? "자동 후보" : verdict === "recommended" ? "추천" : "S36 미지지";

const NATIVE_OUTCOMES: Record<string, string> = {
  accepted_automatic: "자동 확정",
  accepted_manual: "직접 확정",
  rejected_manual: "직접 제외",
  cleared_manual: "판단 해제",
  recommended: "추천",
  none: "없음",
};
export const nativeOutcomeLabel = (outcome: string) => NATIVE_OUTCOMES[outcome] ?? outcome;
