use super::{FrameMatch, VideoMatchEvidence};
use crate::library::image_fingerprint::{minimum_distance, ImageFingerprint};

// Experimental video policy, deliberately independent of image review thresholds.
pub(super) const PROFILE: &str = "video-pdq-slots12-v1-pdq0.1.1";
pub(super) const SAMPLES: usize = 12;
pub(super) const MAX_ASSETS: usize = 100;
pub(super) const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(super) const MAX_DURATION_MS: u64 = 20 * 60 * 1000;
const QUALITY_MIN: u8 = 50;
const DISTANCE_MAX: u32 = 20;

#[derive(Clone)]
pub(super) struct FrameFingerprint {
    pub at_ms: u64,
    pub hash: ImageFingerprint,
}

#[derive(Clone)]
pub(super) struct VideoFingerprint {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub frames: Vec<FrameFingerprint>,
}

pub(super) fn sample_times(duration_ms: u64) -> Vec<u64> {
    (0..SAMPLES)
        .map(|i| ((2 * i as u64 + 1) * duration_ms) / (2 * SAMPLES as u64))
        .collect()
}

pub(super) fn metadata_compatible(a: &VideoFingerprint, b: &VideoFingerprint) -> bool {
    let shorter = a.duration_ms.min(b.duration_ms);
    if shorter < 2_000
        || a.duration_ms.max(b.duration_ms) > MAX_DURATION_MS
        || a.duration_ms.abs_diff(b.duration_ms) > 250.max(shorter / 100)
        || a.width == 0
        || a.height == 0
        || b.width == 0
        || b.height == 0
    {
        return false;
    }
    let x = u128::from(a.width) * u128::from(b.height);
    let y = u128::from(b.width) * u128::from(a.height);
    x.max(y) * 100 <= x.min(y) * 102
}

fn distinct_frames(frames: &[FrameFingerprint]) -> usize {
    let mut distinct: Vec<&ImageFingerprint> = Vec::new();
    for frame in frames.iter().filter(|f| f.hash.quality >= QUALITY_MIN) {
        if distinct
            .iter()
            .all(|other| minimum_distance(other, &frame.hash) > DISTANCE_MAX)
        {
            distinct.push(&frame.hash);
        }
    }
    distinct.len()
}

pub(super) fn has_usable_evidence(video: &VideoFingerprint) -> bool {
    video.frames.len() == SAMPLES
        && video
            .frames
            .iter()
            .filter(|frame| frame.hash.quality >= QUALITY_MIN)
            .count()
            >= 8
        && distinct_frames(&video.frames) >= 4
}

pub(super) fn compare(
    a: &VideoFingerprint,
    b: &VideoFingerprint,
    profile: &str,
) -> Option<VideoMatchEvidence> {
    if !metadata_compatible(a, b) || !has_usable_evidence(a) || !has_usable_evidence(b) {
        return None;
    }
    let mut valid = 0;
    let mut thirds = [0; 3];
    let mut matches = Vec::new();
    let mut slots = Vec::new();
    for (index, (left, right)) in a.frames.iter().zip(&b.frames).enumerate() {
        if left.hash.quality < QUALITY_MIN || right.hash.quality < QUALITY_MIN {
            continue;
        }
        valid += 1;
        let distance = minimum_distance(&left.hash, &right.hash);
        if distance <= DISTANCE_MAX {
            thirds[index / 4] += 1;
            slots.push(index);
            matches.push(FrameMatch {
                left_requested_at_ms: left.at_ms,
                right_requested_at_ms: right.at_ms,
                distance,
                left_quality: left.hash.quality,
                right_quality: right.hash.quality,
            });
        }
    }
    if valid < 8
        || matches.len() < 8
        || matches.len() * 4 < valid * 3
        || thirds.iter().any(|n| *n < 2)
    {
        return None;
    }
    Some(VideoMatchEvidence {
        profile: profile.to_owned(),
        left_duration_ms: a.duration_ms,
        right_duration_ms: b.duration_ms,
        matched_frames: matches.len() as u32,
        attempted_frames: SAMPLES as u32,
        valid_frames: valid as u32,
        matching_span_permille: ((slots.last()? - slots.first()?) * 1000 / (SAMPLES - 1)) as u32,
        matches,
    })
}
