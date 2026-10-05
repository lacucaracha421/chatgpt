//! Places the back|spine and spine|front split lines on a wrap jacket from its printed seams.
//!
//! The ratio guess from `default_split` is the seed and the fallback. Each column boundary gets a
//! seam score: the share of rows whose colour jumps across that boundary, with small jumps
//! (noise, JPEG blocking) ignored and large ones capped so a few strong text edges cannot win.
//! A real seam runs the full height, so it scores far above the columns around it.
use super::{
    models::{DefaultSplit, Split},
    provider::{default_split, describe_split},
};
use image::{DynamicImage, RgbImage};
use std::{borrow::Cow, ops::RangeInclusive};

/// Each line is searched this far (share of the width) either side of its ratio seed.
const SEARCH: f64 = 0.06;
/// RGB L1 jumps up to this size are noise; a row contributes fully from `CLIP` upwards.
const NOISE: u32 = 18;
const CLIP: u32 = 90;
/// A line moves only when its seam beats the median column of its window by this much.
const MARGIN: f64 = 0.15;
/// Pair penalty per unit of (back - front) width difference relative to the jacket width.
const ASYMMETRY: f64 = 1.0;
/// Rows are sampled so large scans cost about the same as a 400 px tall jacket.
const MAX_ROWS: u32 = 400;

/// The split the dialog starts from: detected seams when they are clear, otherwise the ratio seed.
pub(super) fn detect_split(image: &DynamicImage) -> DefaultSplit {
    let (width, height) = (image.width(), image.height());
    let seed = default_split(width, height);
    if !seed.is_wrap || width < 32 || height < 8 {
        return seed;
    }
    let rgb = match image.as_rgb8() {
        Some(rgb) => Cow::Borrowed(rgb),
        None => Cow::Owned(image.to_rgb8()),
    };
    match refine(&rgb, &seed.split) {
        Some(split) => describe_split(width, height, split),
        None => seed,
    }
}

fn refine(rgb: &RgbImage, seed: &Split) -> Option<Split> {
    let width = rgb.width();
    let reach = ((f64::from(width) * SEARCH).round() as u32).max(4);
    // A boundary b splits columns b-1 | b, so b stays within 1..width-1.
    let window = |center: u32| {
        center.saturating_sub(reach).max(1)..=center.saturating_add(reach).min(width - 1)
    };
    let (w1, w2) = (window(seed.x1), window(seed.x2));
    if w1.is_empty() || w2.is_empty() {
        return None;
    }
    let first = (*w1.start()).min(*w2.start());
    let scores = seam_scores(rgb, first, (*w1.end()).max(*w2.end()));
    let score = |b: u32| scores[(b - first) as usize];
    let spine = (f64::from(width) * 0.01).ceil() as u32..=(f64::from(width) * 0.12).floor() as u32;
    let plausible = |x1: u32, x2: u32| x1 < x2 && spine.contains(&(x2 - x1));
    let mut best: Option<(f64, u32, u32)> = None;
    for x1 in w1.clone() {
        for x2 in w2.clone().filter(|&x2| plausible(x1, x2)) {
            // When seams score alike, prefer faces of similar width (back ≈ front).
            let asymmetry = (f64::from(x1) - f64::from(width - x2)).abs() / f64::from(width);
            let total = score(x1) + score(x2) - ASYMMETRY * asymmetry;
            if best.is_none_or(|(top, ..)| total > top) {
                best = Some((total, x1, x2));
            }
        }
    }
    let (_, x1, x2) = best?;
    let clear = |b: u32, window: &RangeInclusive<u32>| {
        score(b) - median(window.clone().map(score).collect()) >= MARGIN
    };
    // A seam that does not stand out keeps its ratio position.
    let x1 = if clear(x1, &w1) { x1 } else { seed.x1 };
    let x2 = if clear(x2, &w2) { x2 } else { seed.x2 };
    plausible(x1, x2).then_some(Split { x1, x2 })
}

/// Share of sampled rows (0..=1) with a colour jump between columns b-1 and b, for b in first..=last.
fn seam_scores(rgb: &RgbImage, first: u32, last: u32) -> Vec<f64> {
    let step = rgb.height().div_ceil(MAX_ROWS).max(1) as usize;
    let mut sums = vec![0_u64; (last - first + 1) as usize];
    let mut rows = 0_u64;
    for y in (0..rgb.height()).step_by(step) {
        rows += 1;
        for (sum, b) in sums.iter_mut().zip(first..=last) {
            let (left, right) = (rgb.get_pixel(b - 1, y).0, rgb.get_pixel(b, y).0);
            let jump: u32 = left
                .iter()
                .zip(right)
                .map(|(&l, r)| u32::from(l.abs_diff(r)))
                .sum();
            *sum += u64::from(jump.saturating_sub(NOISE).min(CLIP - NOISE));
        }
    }
    let full = (rows * u64::from(CLIP - NOISE)) as f64;
    sums.into_iter().map(|sum| sum as f64 / full).collect()
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::jpeg::JpegEncoder, Rgb};

    /// Deterministic pseudo-random numbers for repeatable synthetic jackets.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) as u32
        }
        fn noise(&mut self, amplitude: i32) -> i32 {
            (self.next() % (2 * amplitude as u32 + 1)) as i32 - amplitude
        }
    }
    struct Jacket {
        width: u32,
        height: u32,
        /// Scan margins: left, right, top, bottom.
        margins: (u32, u32, u32, u32),
        x1: u32,
        x2: u32,
    }
    fn pixel(base: [f64; 3], rng: &mut Lcg, amplitude: i32) -> Rgb<u8> {
        Rgb(base.map(|c| (c.round() as i32 + rng.noise(amplitude)).clamp(0, 255) as u8))
    }
    /// Textured back and front faces, a cream spine with jittered vertical "text", a frame line
    /// inside the back face, uneven white scan margins, a soft horizontal blur and JPEG round trip.
    fn render(j: &Jacket) -> DynamicImage {
        let (left, right, top, bottom) = j.margins;
        let mut rng = Lcg(u64::from(j.width) * 31 + u64::from(j.x1));
        let glyphs: Vec<(u32, u32)> = (0..j.height)
            .map(|_| {
                let spine = j.x2 - j.x1;
                let start = j.x1 + spine / 4 + rng.next() % (spine / 4).max(1);
                (start, start + 2 + rng.next() % (spine / 3).max(1))
            })
            .collect();
        let raw = RgbImage::from_fn(j.width, j.height, |x, y| {
            let (fx, fy) = (f64::from(x), f64::from(y));
            if x < left || x >= j.width - right || y < top || y >= j.height - bottom {
                return pixel([246.0, 245.0, 243.0], &mut rng, 3);
            }
            if x < j.x1 {
                let frame = (j.x1 - 31..j.x1 - 29).contains(&x)
                    && (j.height / 5..j.height * 4 / 5).contains(&y);
                if frame {
                    return pixel([20.0, 20.0, 20.0], &mut rng, 6);
                }
                return pixel(
                    [
                        120.0 + 80.0 * (fx / 23.0 + fy / 37.0).sin(),
                        90.0 + 60.0 * (fy / 19.0).cos(),
                        150.0 + 50.0 * ((fx + fy) / 31.0).sin(),
                    ],
                    &mut rng,
                    10,
                );
            }
            if x < j.x2 {
                let (start, end) = glyphs[((y / 9) * 9) as usize];
                let ink = (y / 9) % 3 != 2 && (start..end).contains(&x);
                let base = if ink {
                    [40.0, 30.0, 60.0]
                } else {
                    [235.0, 230.0, 220.0]
                };
                return pixel(base, &mut rng, 8);
            }
            pixel(
                [
                    200.0 + 40.0 * (fy / 27.0).sin(),
                    120.0 + 70.0 * (fx / 17.0).cos(),
                    100.0 + 60.0 * ((fx - fy) / 41.0).sin(),
                ],
                &mut rng,
                10,
            )
        });
        let blurred = RgbImage::from_fn(j.width, j.height, |x, y| {
            let at = |dx: i64| {
                let x = (i64::from(x) + dx).clamp(0, i64::from(j.width) - 1) as u32;
                raw.get_pixel(x, y).0
            };
            let (a, b, c) = (at(-1), at(0), at(1));
            Rgb([0, 1, 2]
                .map(|i| ((u16::from(a[i]) + 2 * u16::from(b[i]) + u16::from(c[i]) + 2) / 4) as u8))
        });
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&blurred)
            .unwrap();
        image::load_from_memory(&bytes).unwrap()
    }
    fn assert_detected(j: &Jacket) {
        let found = detect_split(&render(j));
        assert!(found.is_wrap && found.use_spine, "{found:?}");
        assert!(
            found.split.x1.abs_diff(j.x1) <= 2 && found.split.x2.abs_diff(j.x2) <= 2,
            "expected {}..{}, found {:?}",
            j.x1,
            j.x2,
            found.split
        );
    }

    #[test]
    fn finds_a_spine_the_ratio_misplaces() {
        // Digital pl.jpg size; the ratio seed is 378..422.
        assert_detected(&Jacket {
            width: 800,
            height: 538,
            margins: (9, 17, 4, 7),
            x1: 384,
            x2: 425,
        });
        // A thicker spine with unequal faces.
        assert_detected(&Jacket {
            width: 800,
            height: 538,
            margins: (3, 12, 0, 5),
            x1: 362,
            x2: 418,
        });
        // The ratio would offer no spine here (422..578 is 15.6%), the image has an 8% one.
        assert_detected(&Jacket {
            width: 1000,
            height: 600,
            margins: (14, 6, 8, 2),
            x1: 452,
            x2: 532,
        });
        // A large scan: rows are sampled, columns stay full resolution.
        assert_detected(&Jacket {
            width: 2400,
            height: 1614,
            margins: (30, 51, 12, 21),
            x1: 1151,
            x2: 1276,
        });
    }

    #[test]
    fn featureless_or_noisy_jackets_keep_the_ratio_seed() {
        let uniform = DynamicImage::ImageRgb8(RgbImage::from_pixel(800, 538, Rgb([90, 120, 150])));
        assert_eq!(detect_split(&uniform).split, default_split(800, 538).split);
        let mut rng = Lcg(7);
        let noise = DynamicImage::ImageRgb8(RgbImage::from_fn(800, 538, |_, _| {
            pixel([128.0; 3], &mut rng, 60)
        }));
        assert_eq!(detect_split(&noise).split, default_split(800, 538).split);
    }

    #[test]
    fn portrait_and_odd_sizes_never_panic() {
        let portrait = detect_split(&DynamicImage::new_rgb8(378, 538));
        assert_eq!(portrait.split, Split { x1: 0, x2: 0 });
        assert!(!portrait.is_wrap && !portrait.use_spine);
        for (w, h) in [
            (1, 1),
            (2, 1),
            (3, 2),
            (31, 8),
            (32, 8),
            (33, 9),
            (64, 1),
            (500, 3),
        ] {
            let mut rng = Lcg(u64::from(w * h));
            let image = DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |_, _| {
                pixel([128.0; 3], &mut rng, 120)
            }));
            let found = detect_split(&image);
            assert!(found.split.x1 <= found.split.x2 && found.split.x2 <= w);
        }
        // Non-RGB decodes are converted rather than rejected.
        let gray = DynamicImage::new_luma8(800, 538);
        assert_eq!(detect_split(&gray).split, default_split(800, 538).split);
    }

    /// Manual accuracy/timing probe: `LAKOMICS_AV_JACKET=<file> cargo test --release --lib
    /// av_link::spine::tests::probe_real_jacket -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn probe_real_jacket() {
        let path = std::env::var("LAKOMICS_AV_JACKET").expect("LAKOMICS_AV_JACKET");
        for path in path.split(';') {
            let image = image::open(path).unwrap();
            let start = std::time::Instant::now();
            let found = detect_split(&image);
            let elapsed = start.elapsed();
            let seed = default_split(image.width(), image.height());
            println!(
                "{path}: {}x{} seed {:?} found {:?} use_spine {} in {elapsed:?}",
                image.width(),
                image.height(),
                seed.split,
                found.split,
                found.use_spine
            );
        }
    }
}
