use crate::library::models::AssetSummary;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoScanRequest {
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScanProgress {
    pub id: String,
    pub state: String,
    pub total: u32,
    pub completed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub candidate_count: u32,
    pub active_asset_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMatch {
    pub left_requested_at_ms: u64,
    pub right_requested_at_ms: u64,
    pub distance: u32,
    pub left_quality: u8,
    pub right_quality: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMatchEvidence {
    pub profile: String,
    pub left_duration_ms: u64,
    pub right_duration_ms: u64,
    pub matched_frames: u32,
    pub attempted_frames: u32,
    pub valid_frames: u32,
    pub matching_span_permille: u32,
    pub matches: Vec<FrameMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoReview {
    pub id: String,
    pub left: AssetSummary,
    pub right: AssetSummary,
    pub evidence: VideoMatchEvidence,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoReviewPage {
    pub items: Vec<VideoReview>,
    pub total_count: u32,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VideoReviewDecision {
    KeepLeft,
    KeepRight,
    KeepBoth,
    NotSimilar,
}

impl VideoReviewDecision {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::KeepLeft => "keep_left",
            Self::KeepRight => "keep_right",
            Self::KeepBoth => "keep_both",
            Self::NotSimilar => "not_similar",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoDecisionRequest {
    pub review_id: String,
    pub decision: VideoReviewDecision,
}
