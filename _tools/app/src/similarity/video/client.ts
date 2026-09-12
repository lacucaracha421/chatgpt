import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../../library/types";

export type VideoScanProgress = {
  id: string; state: string; total: number; completed: number; failed: number;
  skipped: number; candidateCount: number; activeAssetId: string | null; reason: string | null;
};
export type VideoReview = {
  id: string; left: AssetSummary; right: AssetSummary; createdAt: string;
  evidence: {
    profile: string; leftDurationMs: number; rightDurationMs: number;
    matchedFrames: number; attemptedFrames: number; validFrames: number; matchingSpanPermille: number;
    matches: { leftRequestedAtMs: number; rightRequestedAtMs: number; distance: number; leftQuality: number; rightQuality: number }[];
  };
};
export type VideoDecision = "keep_left" | "keep_right" | "keep_both" | "not_similar";
export interface VideoSimilarityApi {
  start(assetIds: string[]): Promise<VideoScanProgress>;
  get(scanId: string): Promise<VideoScanProgress>;
  latest(): Promise<VideoScanProgress | null>;
  cancel(scanId: string): Promise<VideoScanProgress>;
  resume(scanId: string): Promise<VideoScanProgress>;
  list(): Promise<{ items: VideoReview[]; totalCount: number; nextCursor: string | null }>;
  decide(reviewId: string, decision: VideoDecision): Promise<void>;
}
export const videoSimilarityApi: VideoSimilarityApi = {
  start: (assetIds) => invoke("start_video_similarity_scan", { request: { assetIds } }),
  get: (scanId) => invoke("get_video_similarity_scan", { scanId }),
  latest: () => invoke("latest_video_similarity_scan"),
  cancel: (scanId) => invoke("cancel_video_similarity_scan", { scanId }),
  resume: (scanId) => invoke("resume_video_similarity_scan", { scanId }),
  list: () => invoke("list_video_similarity_reviews", { after: null, limit: 1 }),
  decide: (reviewId, decision) => invoke("decide_video_similarity_review", { request: { reviewId, decision } }),
};
