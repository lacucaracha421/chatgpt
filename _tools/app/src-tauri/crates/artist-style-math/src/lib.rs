//! Dependency-free ranking kernel, compiled standalone so dev builds can optimize it.
use std::collections::HashSet;

// 2026-09-28 evaluation: ~85% walk-forward precision; user review 34/34 decided correct.
pub const SCORE_MIN: f32 = 0.55;
pub const LEAD_MIN: f32 = 0.05;
pub const DIM: usize = 2048;

pub struct Vector {
    pub asset: usize,
    pub artist: usize,
    pub group: usize,
    pub values: Vec<f32>,
}

#[derive(Debug)]
pub struct Ranked {
    pub asset: usize,
    pub artist: usize,
    pub score: f32,
    pub lead: f32,
    pub runner: Option<(usize, f32)>,
    pub references: Vec<(usize, f32)>,
}

// Eight independent accumulators allow vectorization without a long dependency chain.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut sums = [0.0; 8];
    for (a, b) in a.chunks_exact(8).zip(b.chunks_exact(8)) {
        for k in 0..8 {
            sums[k] += a[k] * b[k];
        }
    }
    sums.iter().sum::<f32>().clamp(-1.0, 1.0)
}

pub fn rank(
    known: &[Vector],
    candidates: &[Vector],
    artists: usize,
    dismissals: &HashSet<(usize, usize)>,
) -> Vec<Ranked> {
    let mut result = Vec::new();
    let mut scores = vec![f32::NEG_INFINITY; artists];
    let mut neighbours = Vec::with_capacity(known.len());
    for candidate in candidates {
        scores.fill(f32::NEG_INFINITY);
        neighbours.clear();
        for reference in known {
            if reference.group == candidate.group
                || dismissals.contains(&(candidate.asset, reference.artist))
            {
                continue;
            }
            let score = dot(&candidate.values, &reference.values);
            scores[reference.artist] = scores[reference.artist].max(score);
            neighbours.push((reference.artist, reference.asset, score));
        }
        let mut best = None;
        let mut runner = None;
        // Stable artist order breaks equal scores deterministically.
        for (artist, &score) in scores.iter().enumerate().filter(|(_, s)| s.is_finite()) {
            if best.is_none_or(|(_, s)| score > s) {
                runner = best;
                best = Some((artist, score));
            } else if runner.is_none_or(|(_, s)| score > s) {
                runner = Some((artist, score));
            }
        }
        let Some((artist, score)) = best else {
            continue;
        };
        // With one eligible artist, the missing runner has the cosine lower bound (-1).
        let lead = score - runner.map_or(-1.0, |(_, score)| score);
        if score < SCORE_MIN || lead < LEAD_MIN {
            continue;
        }
        let mut references: Vec<_> = neighbours
            .iter()
            .filter(|(a, _, _)| *a == artist)
            .map(|(_, asset, score)| (*asset, *score))
            .collect();
        references.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        references.truncate(4);
        result.push(Ranked {
            asset: candidate.asset,
            artist,
            score,
            lead,
            runner,
            references,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "optimized standalone 9000-image benchmark"]
    fn artist_style_benchmark_9000() {
        let mut seed = 17u32;
        let mut make = |asset, artist| {
            let mut values: Vec<f32> = (0..DIM)
                .map(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed as f64 / u32::MAX as f64 - 0.5) as f32
                })
                .collect();
            let norm = values.iter().map(|x| x * x).sum::<f32>().sqrt();
            for x in &mut values {
                *x /= norm;
            }
            Vector {
                asset,
                artist,
                group: asset,
                values,
            }
        };
        let known: Vec<_> = (0..3500).map(|i| make(i, i % 2100)).collect();
        let mut candidates: Vec<_> = (3500..9000).map(|i| make(i, 0)).collect();
        // Half are correlated style neighbours; half have no eligible artist.
        for (i, candidate) in candidates.iter_mut().enumerate().step_by(2) {
            for (x, reference) in candidate
                .values
                .iter_mut()
                .zip(&known[i % known.len()].values)
            {
                *x = 0.8 * reference + 0.6 * *x;
            }
            let norm = candidate.values.iter().map(|x| x * x).sum::<f32>().sqrt();
            for x in &mut candidate.values {
                *x /= norm;
            }
        }
        let start = std::time::Instant::now();
        let result = rank(&known, &candidates, 2100, &HashSet::new());
        println!("artist style: 9000 images (3500 known x 5500 candidates x {DIM}), {:.3}s, {} suggestions", start.elapsed().as_secs_f64(), result.len());
        assert_eq!(result.len(), 2750);
    }
}
