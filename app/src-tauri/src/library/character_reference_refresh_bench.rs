use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedOutcome {
    accepted: bool,
}

#[derive(Debug)]
struct BenchMetrics {
    assets_visited: usize,
    new_reference_comparisons: usize,
    old_reference_recomparisons: usize,
    feature_cache_misses: usize,
    full_fallbacks: usize,
    published_results: usize,
    elapsed_ms: f64,
    normalized_outcomes: Vec<NormalizedOutcome>,
}

struct RefreshBenchFixture {
    assets: usize,
    base_references: usize,
    added_references: usize,
    stored_distances: Vec<Vec<u16>>,
}

impl RefreshBenchFixture {
    fn new(assets: usize, base_references: usize, added_references: usize) -> Self {
        let stored_distances = (0..assets)
            .map(|asset| {
                (0..base_references)
                    .map(|reference| reference_distance(asset, reference))
                    .collect()
            })
            .collect();
        Self {
            assets,
            base_references,
            added_references,
            stored_distances,
        }
    }

    fn measure_full_reconsideration(&self) -> BenchMetrics {
        let started = Instant::now();
        let normalized_outcomes = (0..self.assets)
            .map(|asset| {
                let distances = (0..self.base_references + self.added_references)
                    .map(|reference| reference_distance(asset, reference))
                    .collect::<Vec<_>>();
                normalized(&distances)
            })
            .collect::<Vec<_>>();
        BenchMetrics {
            assets_visited: self.assets,
            new_reference_comparisons: self.assets * self.added_references,
            old_reference_recomparisons: self.assets * self.base_references,
            feature_cache_misses: self.assets,
            full_fallbacks: self.assets,
            published_results: normalized_outcomes.len(),
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            normalized_outcomes,
        }
    }

    fn measure_explicit_delta_refresh(&self) -> BenchMetrics {
        let started = Instant::now();
        let normalized_outcomes = self
            .stored_distances
            .iter()
            .enumerate()
            .map(|(asset, old)| {
                let mut distances = old.clone();
                distances.extend(
                    (self.base_references..self.base_references + self.added_references)
                        .map(|reference| reference_distance(asset, reference)),
                );
                normalized(&distances)
            })
            .collect::<Vec<_>>();
        BenchMetrics {
            assets_visited: self.assets,
            new_reference_comparisons: self.assets * self.added_references,
            old_reference_recomparisons: 0,
            feature_cache_misses: 0,
            full_fallbacks: 0,
            published_results: normalized_outcomes.len(),
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            normalized_outcomes,
        }
    }

    fn measure_sequential_delta_refresh(&self) -> BenchMetrics {
        let started = Instant::now();
        let mut distances = self.stored_distances.clone();
        let mut normalized_outcomes = Vec::new();
        for offset in 0..self.added_references {
            let reference = self.base_references + offset;
            for (asset, row) in distances.iter_mut().enumerate() {
                row.push(reference_distance(asset, reference));
            }
            normalized_outcomes = distances.iter().map(|row| normalized(row)).collect();
        }
        BenchMetrics {
            assets_visited: self.assets * self.added_references,
            new_reference_comparisons: self.assets * self.added_references,
            old_reference_recomparisons: 0,
            feature_cache_misses: 0,
            full_fallbacks: 0,
            published_results: normalized_outcomes.len(),
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            normalized_outcomes,
        }
    }
}

fn reference_distance(asset: usize, reference: usize) -> u16 {
    let mixed = asset
        .wrapping_mul(37)
        .wrapping_add(reference.wrapping_mul(101))
        .wrapping_add((asset ^ reference).wrapping_mul(13));
    (mixed % 1_000) as u16
}

fn normalized(distances: &[u16]) -> NormalizedOutcome {
    NormalizedOutcome {
        accepted: distances.iter().filter(|distance| **distance < 420).count() >= 6,
    }
}

fn print_metrics(label: &str, added: usize, metrics: &BenchMetrics) {
    println!(
        "{label} added={added} assets_visited={} new_reference_comparisons={} old_reference_recomparisons={} feature_cache_misses={} full_fallbacks={} published_results={} elapsed_ms={:.3}",
        metrics.assets_visited,
        metrics.new_reference_comparisons,
        metrics.old_reference_recomparisons,
        metrics.feature_cache_misses,
        metrics.full_fallbacks,
        metrics.published_results,
        metrics.elapsed_ms,
    );
}

#[test]
#[ignore = "fixture measurement; run explicitly with --ignored --nocapture"]
fn reference_refresh_fixture_metrics() {
    for added in [1_usize, 5, 10, 20] {
        let fixture = RefreshBenchFixture::new(2_000, 5, added);
        let full = fixture.measure_full_reconsideration();
        let delta = fixture.measure_explicit_delta_refresh();
        print_metrics("full", added, &full);
        print_metrics("delta", added, &delta);
        assert_eq!(full.normalized_outcomes, delta.normalized_outcomes);
        assert_eq!(delta.assets_visited, 2_000);
        assert_eq!(delta.old_reference_recomparisons, 0);
        assert_eq!(delta.new_reference_comparisons, 2_000 * added);
        assert_eq!(delta.full_fallbacks, 0);
    }

    let fixture = RefreshBenchFixture::new(2_000, 5, 20);
    let full = fixture.measure_full_reconsideration();
    let batch = fixture.measure_explicit_delta_refresh();
    let sequential = fixture.measure_sequential_delta_refresh();
    print_metrics("batch20", 20, &batch);
    print_metrics("sequential20", 20, &sequential);
    assert_eq!(full.normalized_outcomes, batch.normalized_outcomes);
    assert_eq!(full.normalized_outcomes, sequential.normalized_outcomes);
    assert_eq!(batch.old_reference_recomparisons, 0);
    assert_eq!(batch.assets_visited, 2_000);
    assert_eq!(sequential.assets_visited, 40_000);
}
