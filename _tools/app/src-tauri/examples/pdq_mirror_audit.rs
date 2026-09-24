//! Read-only mirror benchmark. No Library::open, migrations, or image copies.
//! Run with: cargo run --release --example pdq_mirror_audit -- <library-root>
//! Optional: --sample 3000 --seed 0 --out <new-file-outside-library.tsv>
//!
//! Sample results count unordered pairs, accepting either mirrored direction.
//! Library results count directed (sample source, library target) pairs; a pair
//! of sampled assets can appear in both directions and in both scopes.
//! TSV has one row per method and scope, with A identifying the mirrored source.
//! These are candidates for manual review, not confirmed false positives.

use std::{
    error::Error,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use image::{DynamicImage, ImageDecoder, ImageReader};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

// Compile the actual fingerprint implementation without exposing a new app API.
use app_lib::library::error;
#[allow(dead_code)]
#[path = "../src/library/image_fingerprint.rs"]
mod image_fingerprint;
use image_fingerprint::{
    approx_mirror_bits, dimensions_are_compatible, hamming_distance, minimum_distance,
    mirrored_fingerprint, ImageFingerprint,
};

// Mirror the current ingestion gates; this benchmark never changes them.
const QUALITY_MIN: u8 = 50;
const DISTANCE_MAX: u32 = 20;
const USAGE: &str =
    "usage: pdq_mirror_audit <library-root> [--sample N] [--seed S] [--out <path.tsv>]";

struct Options {
    root: PathBuf,
    sample: usize,
    seed: u64,
    out: Option<PathBuf>,
}

impl Options {
    fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, Box<dyn Error>> {
        let mut args = args.into_iter();
        let root = args.next().ok_or(USAGE)?;
        if root.to_string_lossy().starts_with("--") {
            return Err(USAGE.into());
        }
        let mut options = Self {
            root: root.into(),
            sample: 3000,
            seed: 0,
            out: None,
        };
        while let Some(flag) = args.next() {
            let value = args.next().ok_or(USAGE)?;
            match flag.to_str() {
                Some("--sample") => options.sample = value.to_str().ok_or(USAGE)?.parse()?,
                Some("--seed") => options.seed = value.to_str().ok_or(USAGE)?.parse()?,
                Some("--out") => options.out = Some(value.into()),
                _ => return Err(USAGE.into()),
            }
        }
        if options.sample == 0 {
            return Err("--sample must be greater than zero".into());
        }
        Ok(options)
    }
}

struct Asset {
    id: String,
    relative_path: String,
    dimensions: (u32, u32),
    stored: ImageFingerprint,
}

fn load_assets(root: &Path) -> Result<Vec<Asset>, Box<dyn Error>> {
    let connection = Connection::open_with_flags(
        root.join("library.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut statement = connection.prepare(
        "SELECT id, relative_path, width, height, perceptual_hash, perceptual_hash_quality
         FROM assets
         WHERE status = 'normal' AND media_kind IN ('image', 'gif')
           AND perceptual_hash_quality >= ?1
           AND typeof(perceptual_hash) = 'blob' AND length(perceptual_hash) = 64
         ORDER BY id",
    )?;
    let rows = statement.query_map([QUALITY_MIN], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            (row.get::<_, u32>(2)?, row.get::<_, u32>(3)?),
            row.get::<_, Vec<u8>>(4)?,
            row.get::<_, u8>(5)?,
        ))
    })?;
    let mut assets = Vec::new();
    for row in rows {
        let (id, relative_path, dimensions, bytes, quality) = row?;
        assets.push(Asset {
            id,
            relative_path,
            dimensions,
            stored: ImageFingerprint::from_stored_bytes(&bytes, quality)?,
        });
    }
    Ok(assets)
}

fn sample_indices(assets: &[Asset], count: usize, seed: u64) -> Vec<usize> {
    // Seeded SHA-256 ranks give a reproducible random sample without replacement
    // without adding a PRNG dependency or relying on SQLite's unseeded random().
    let mut ranked: Vec<_> = assets
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            let mut hash = Sha256::new();
            hash.update(seed.to_le_bytes());
            hash.update(asset.id.as_bytes());
            let rank: [u8; 32] = hash.finalize().into();
            (rank, index)
        })
        .collect();
    ranked.sort_unstable_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| assets[a.1].id.cmp(&assets[b.1].id))
    });
    ranked.into_iter().take(count).map(|(_, i)| i).collect()
}

fn decode_oriented(path: &Path) -> Result<DynamicImage, Box<dyn Error>> {
    // Same decoder/orientation ordering as similarity::perceptual_hash_from_file.
    let reader = ImageReader::new(BufReader::new(File::open(path)?)).with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn open_output(root: &Path, path: &Path) -> Result<BufWriter<File>, Box<dyn Error>> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = parent.canonicalize()?;
    if parent.starts_with(root) {
        return Err("--out must be outside the library (including symlinked directories)".into());
    }
    let path = parent.join(path.file_name().ok_or("--out needs a filename")?);
    // Never truncate existing files or follow an existing symlink/hardlink.
    let mut writer = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(path)?);
    writeln!(
        writer,
        "scope\tasset_a_id\tasset_a_path\tasset_b_id\tasset_b_path\tdistance\tmethod"
    )?;
    Ok(writer)
}

fn tsv(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

fn write_match(
    output: &mut Option<BufWriter<File>>,
    scope: &str,
    source: &Asset,
    target: &Asset,
    distance: u32,
    method: &str,
) -> Result<(), Box<dyn Error>> {
    if let Some(writer) = output {
        writeln!(
            writer,
            "{scope}\t{}\t{}\t{}\t{}\t{distance}\t{method}",
            tsv(&source.id),
            tsv(&source.relative_path),
            tsv(&target.id),
            tsv(&target.relative_path)
        )?;
    }
    Ok(())
}

struct Sample {
    index: usize,
    exact: ImageFingerprint,
    approx: ImageFingerprint,
}

#[derive(Clone, Copy, Default)]
struct Matches {
    exact: Option<u32>,
    approx: Option<u32>,
}

fn new_matches(source: &Asset, mirror: &Sample, target: &Asset) -> Matches {
    if source.id == target.id
        || !dimensions_are_compatible(source.dimensions, target.dimensions)
        || source.stored.quality < QUALITY_MIN
        || target.stored.quality < QUALITY_MIN
        || minimum_distance(&source.stored, &target.stored) <= DISTANCE_MAX
    {
        return Matches::default();
    }
    let gated_distance = |fingerprint: &ImageFingerprint| {
        if fingerprint.quality < QUALITY_MIN {
            return None;
        }
        let distance = minimum_distance(fingerprint, &target.stored);
        (distance <= DISTANCE_MAX).then_some(distance)
    };
    Matches {
        exact: gated_distance(&mirror.exact),
        approx: gated_distance(&mirror.approx),
    }
}

#[derive(Default)]
struct Counts {
    exact: u64,
    approx: u64,
    overlap: u64,
    approx_only: u64,
    exact_histogram: [u64; 21],
    approx_histogram: [u64; 21],
}

impl Counts {
    fn record(&mut self, matches: Matches) {
        if let Some(distance) = matches.exact {
            self.exact += 1;
            self.exact_histogram[distance as usize] += 1;
        }
        if let Some(distance) = matches.approx {
            self.approx += 1;
            self.approx_histogram[distance as usize] += 1;
            self.overlap += u64::from(matches.exact.is_some());
            self.approx_only += u64::from(matches.exact.is_none());
        }
    }

    fn print(&self, scope: &str) {
        println!("{scope}_exact_matches\t{}", self.exact);
        println!("{scope}_approx_matches\t{}", self.approx);
        println!("{scope}_exact_found_by_approx\t{}", self.overlap);
        println!(
            "{scope}_exact_missed_by_approx\t{}",
            self.exact - self.overlap
        );
        println!("{scope}_approx_only\t{}", self.approx_only);
        for distance in 0..=DISTANCE_MAX as usize {
            println!(
                "{scope}_distance_histogram\texact\t{distance}\t{}",
                self.exact_histogram[distance]
            );
            println!(
                "{scope}_distance_histogram\tapprox\t{distance}\t{}",
                self.approx_histogram[distance]
            );
        }
    }
}

fn print_distribution(name: &str, values: &mut [u32]) {
    values.sort_unstable();
    if values.is_empty() {
        println!("{name}\tn=0\tmin=NA\tmedian=NA\tp90=NA\tmax=NA");
        return;
    }
    let n = values.len();
    let median = (values[(n - 1) / 2] as f64 + values[n / 2] as f64) / 2.0;
    // p90 uses the nearest-rank definition.
    println!(
        "{name}\tn={n}\tmin={}\tmedian={median:.1}\tp90={}\tmax={}",
        values[0],
        values[(n * 9).div_ceil(10) - 1],
        values[n - 1]
    );
}

fn best_direction(forward: Option<u32>, reverse: Option<u32>) -> Option<(u32, bool)> {
    match (forward, reverse) {
        (Some(a), Some(b)) if b < a => Some((b, true)),
        (Some(a), _) => Some((a, false)),
        (None, Some(b)) => Some((b, true)),
        (None, None) => None,
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    run(Options::parse(std::env::args_os().skip(1))?)
}

fn run(options: Options) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    let root = options.root.canonicalize()?;
    let assets = load_assets(&root)?;
    let selected = sample_indices(&assets, options.sample, options.seed);
    let mut output = options
        .out
        .as_ref()
        .map(|path| open_output(&root, path))
        .transpose()?;
    println!("eligible_library_assets\t{}", assets.len());
    println!("sample_requested\t{}", options.sample);
    println!("sample_selected\t{}", selected.len());
    println!("seed\t{}", options.seed);
    println!("sample_pair_semantics\tunordered; either exact direction can qualify");
    println!("library_pair_semantics\tdirected sample source -> library target; self excluded");
    println!("approx_quality_gate\tstored quality (mirror quality cannot be recovered from bits)");
    println!("tsv_escaping\tbackslash, tab, CR, LF use backslash escapes");

    let mut samples = Vec::new();
    let mut failed = 0;
    let mut low_quality = 0;
    let mut self_symmetric = 0;
    let mut whole_errors = Vec::new();
    let mut cropped_errors = Vec::new();
    for (position, index) in selected.iter().copied().enumerate() {
        let asset = &assets[index];
        // Exactly the existing audit's root + relative_path resolution.
        let exact = decode_oriented(&root.join(&asset.relative_path))
            .and_then(|image| Ok(mirrored_fingerprint(&image)?));
        match exact {
            Ok(exact) => {
                let approx = ImageFingerprint {
                    bytes: approx_mirror_bits(&asset.stored.bytes),
                    cropped_bytes: approx_mirror_bits(&asset.stored.cropped_bytes),
                    quality: asset.stored.quality,
                };
                whole_errors.push(hamming_distance(&approx.bytes, &exact.bytes));
                cropped_errors.push(hamming_distance(
                    &approx.cropped_bytes,
                    &exact.cropped_bytes,
                ));
                low_quality += usize::from(exact.quality < QUALITY_MIN);
                // Informational self-symmetry does not apply the mirror quality gate.
                self_symmetric +=
                    usize::from(minimum_distance(&exact, &asset.stored) <= DISTANCE_MAX);
                samples.push(Sample {
                    index,
                    exact,
                    approx,
                });
            }
            Err(error) => {
                failed += 1;
                eprintln!(
                    "fingerprint_error\t{}\t{}\t{}",
                    tsv(&asset.id),
                    tsv(&asset.relative_path),
                    tsv(&error.to_string())
                );
            }
        }
        if (position + 1) % 500 == 0 || position + 1 == selected.len() {
            eprintln!(
                "decode_progress\t{}/{}\tfailed={failed}\telapsed_seconds={:.2}",
                position + 1,
                selected.len(),
                started.elapsed().as_secs_f64()
            );
        }
    }
    println!("fingerprint_succeeded\t{}", samples.len());
    println!("fingerprint_failed\t{failed}");
    println!("exact_mirror_quality_below_50\t{low_quality}");
    println!("self_symmetric_distance_le_20\t{self_symmetric}");
    print_distribution("approx_whole_hamming", &mut whole_errors);
    print_distribution("approx_cropped_hamming", &mut cropped_errors);

    let mut sample_counts = Counts::default();
    let mut library_counts = Counts::default();
    for (position, sample) in samples.iter().enumerate() {
        let source = &assets[sample.index];
        for other in &samples[position + 1..] {
            let target = &assets[other.index];
            let forward = new_matches(source, sample, target);
            let reverse = new_matches(target, other, source);
            let exact = best_direction(forward.exact, reverse.exact);
            let approx = best_direction(forward.approx, reverse.approx);
            sample_counts.record(Matches {
                exact: exact.map(|v| v.0),
                approx: approx.map(|v| v.0),
            });
            for (method, result) in [("exact", exact), ("approx", approx)] {
                if let Some((distance, reversed)) = result {
                    let (a, b) = if reversed {
                        (target, source)
                    } else {
                        (source, target)
                    };
                    write_match(&mut output, "sample", a, b, distance, method)?;
                }
            }
        }
        for target in &assets {
            let matches = new_matches(source, sample, target);
            library_counts.record(matches);
            for (method, distance) in [("exact", matches.exact), ("approx", matches.approx)] {
                if let Some(distance) = distance {
                    write_match(&mut output, "library", source, target, distance, method)?;
                }
            }
        }
        if (position + 1) % 500 == 0 || position + 1 == samples.len() {
            eprintln!(
                "match_progress\t{}/{}\telapsed_seconds={:.2}",
                position + 1,
                samples.len(),
                started.elapsed().as_secs_f64()
            );
        }
    }
    sample_counts.print("sample");
    library_counts.print("library");
    if let Some(writer) = &mut output {
        writer.flush()?;
    }
    println!(
        "total_elapsed_seconds\t{:.2}",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use image_fingerprint::fingerprint;
    use rusqlite::params;
    use std::{collections::HashSet, fs};

    fn asset(id: &str, hash: u8) -> Asset {
        Asset {
            id: id.into(),
            relative_path: format!("originals/{id}.png"),
            dimensions: (640, 480),
            stored: ImageFingerprint {
                bytes: [hash; 32],
                cropped_bytes: [hash; 32],
                quality: 100,
            },
        }
    }

    fn fixture() -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(640, 480, |x, y| {
            Rgb([
                ((x * 13 + y * 3) % 251) as u8,
                ((x * 5 + y * 17) % 241) as u8,
                ((x * 19 + y * 7) % 239) as u8,
            ])
        }))
    }

    fn fixture_database(root: &Path) -> Connection {
        let connection = Connection::open(root.join("library.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE assets (
                id TEXT PRIMARY KEY, relative_path TEXT, width INTEGER, height INTEGER,
                perceptual_hash BLOB, perceptual_hash_quality INTEGER,
                status TEXT, media_kind TEXT);",
            )
            .unwrap();
        connection
    }

    fn insert(connection: &Connection, asset: &Asset) {
        connection
            .execute(
                "INSERT INTO assets VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'normal', 'image')",
                params![
                    asset.id,
                    asset.relative_path,
                    asset.dimensions.0,
                    asset.dimensions.1,
                    asset.stored.to_stored_bytes().as_slice(),
                    asset.stored.quality
                ],
            )
            .unwrap();
    }

    #[test]
    fn arguments_and_seeded_sampling_are_reproducible() {
        let defaults = Options::parse([OsString::from("fixture")]).unwrap();
        assert_eq!(defaults.sample, 3000);
        assert_eq!(defaults.seed, 0);
        assert!(defaults.out.is_none());
        for args in [
            vec!["fixture", "--sample", "0"],
            vec!["fixture", "--seed"],
            vec!["fixture", "--unknown", "1"],
        ] {
            assert!(Options::parse(args.into_iter().map(OsString::from)).is_err());
        }
        let assets: Vec<_> = (0..40).map(|i| asset(&i.to_string(), 0)).collect();
        let sample = sample_indices(&assets, 12, 42);
        assert_eq!(sample, sample_indices(&assets, 12, 42));
        assert_ne!(sample, sample_indices(&assets, 12, 43));
        assert_eq!(sample.iter().collect::<HashSet<_>>().len(), 12);
        assert_eq!(sample_indices(&assets, 100, 42).len(), 40);
        assert!(sample_indices(&[], 12, 42).is_empty());
    }

    #[test]
    fn query_filters_status_media_quality_and_hash_length_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let connection = fixture_database(dir.path());
        for id in ["image", "gif", "trash", "video", "low", "short", "null"] {
            insert(&connection, &asset(id, 0));
        }
        connection
            .execute_batch(
                "UPDATE assets SET media_kind = 'gif' WHERE id = 'gif';
             UPDATE assets SET status = 'trash' WHERE id = 'trash';
             UPDATE assets SET media_kind = 'video' WHERE id = 'video';
             UPDATE assets SET perceptual_hash_quality = 49 WHERE id = 'low';
             UPDATE assets SET perceptual_hash = zeroblob(32) WHERE id = 'short';
             UPDATE assets SET perceptual_hash = NULL WHERE id = 'null';",
            )
            .unwrap();
        drop(connection);
        let before = fs::read(dir.path().join("library.sqlite")).unwrap();
        let loaded = load_assets(dir.path()).unwrap();
        assert_eq!(
            loaded.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["gif", "image"]
        );
        assert_eq!(fs::read(dir.path().join("library.sqlite")).unwrap(), before);
        let missing = tempfile::tempdir().unwrap();
        assert!(load_assets(missing.path()).is_err());
        assert!(!missing.path().join("library.sqlite").exists());
    }

    #[test]
    fn match_gates_use_all_cross_pairs_and_keep_approximation_extras() {
        let source = asset("a", 0);
        let mut target = asset("b", 255);
        let mut mirror = Sample {
            index: 0,
            exact: target.stored,
            approx: target.stored,
        };
        mirror.exact.bytes = [0; 32]; // Only the cropped mirror matches B's whole hash.
        target.stored.cropped_bytes = [15; 32];
        assert_eq!(new_matches(&source, &mirror, &target).exact, Some(0));
        mirror.exact.quality = 49;
        let extra = new_matches(&source, &mirror, &target);
        assert_eq!(extra.exact, None);
        assert_eq!(extra.approx, Some(0));
        let mut counts = Counts::default();
        counts.record(extra);
        assert_eq!(counts.approx_only, 1);
        mirror.exact.quality = 50;
        counts.record(new_matches(&source, &mirror, &target));
        assert_eq!((counts.exact, counts.approx, counts.overlap), (1, 2, 1));
        target.dimensions = (480, 640);
        assert!(new_matches(&source, &mirror, &target).exact.is_none());
        target.dimensions = source.dimensions;
        target.stored.quality = 49;
        assert!(new_matches(&source, &mirror, &target).approx.is_none());
        target.stored.quality = 100;
        target.stored.cropped_bytes = source.stored.bytes; // An existing normal match.
        assert!(new_matches(&source, &mirror, &target).exact.is_none());
        target.stored.cropped_bytes = [15; 32];
        target.id = source.id.clone();
        assert!(new_matches(&source, &mirror, &target).exact.is_none());
        assert_eq!(best_direction(None, Some(7)), Some((7, true)));
        assert_eq!(best_direction(Some(12), Some(7)), Some((7, true)));
    }

    #[test]
    fn exif_orientation_is_applied_before_mirroring() {
        let dir = tempfile::tempdir().unwrap();
        let raw = fixture();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode_image(&raw)
            .unwrap();
        let decoded = image::load_from_memory(&jpeg).unwrap();
        // Little-endian EXIF orientation 6 (90 degrees clockwise).
        let mut payload = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        payload.extend_from_slice(&6_u16.to_le_bytes());
        payload.extend_from_slice(&[0; 6]);
        let length = (payload.len() as u16 + 2).to_be_bytes();
        let mut oriented_jpeg = vec![0xff, 0xd8, 0xff, 0xe1, length[0], length[1]];
        oriented_jpeg.extend(payload);
        oriented_jpeg.extend_from_slice(&jpeg[2..]);
        let path = dir.path().join("orientation.jpg");
        fs::write(&path, oriented_jpeg).unwrap();
        let oriented = decode_oriented(&path).unwrap();
        assert_eq!((oriented.width(), oriented.height()), (480, 640));
        assert_eq!(oriented.to_rgb8(), decoded.rotate90().to_rgb8());
        assert_eq!(
            mirrored_fingerprint(&oriented).unwrap(),
            mirrored_fingerprint(&decoded.rotate90()).unwrap()
        );
    }

    #[test]
    fn output_cannot_write_inside_library_or_overwrite_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        assert!(open_output(&root, &root.join("audit.tsv")).is_err());
        assert!(!root.join("audit.tsv").exists());
        let existing = dir.path().join("existing.tsv");
        fs::write(&existing, "preserve").unwrap();
        assert!(open_output(&root, &existing).is_err());
        assert_eq!(fs::read_to_string(&existing).unwrap(), "preserve");
        #[cfg(unix)]
        {
            let alias = dir.path().join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            assert!(open_output(&root, &alias.join("audit.tsv")).is_err());
        }
        assert_eq!(tsv("a\tb\nc\r\\"), "a\\tb\\nc\\r\\\\");
    }

    #[test]
    fn fixture_audit_emits_both_scopes_and_skips_missing_images() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(root.join("originals")).unwrap();
        let connection = fixture_database(&root);
        let original = fixture();
        let flipped = DynamicImage::ImageRgba8(image::imageops::flip_horizontal(&original));
        for (id, image) in [
            ("a", &original),
            ("b", &flipped),
            ("c", &original),
            ("missing", &original),
        ] {
            let mut item = asset(id, 0);
            item.stored = fingerprint(image).unwrap();
            assert!(item.stored.quality >= QUALITY_MIN);
            insert(&connection, &item);
            if id != "missing" {
                image.save(root.join(&item.relative_path)).unwrap();
            }
        }
        drop(connection);
        let before = fs::read(root.join("library.sqlite")).unwrap();
        let out = dir.path().join("audit.tsv");
        run(Options {
            root: root.clone(),
            sample: 3000,
            seed: 42,
            out: Some(out.clone()),
        })
        .unwrap();
        let output = fs::read_to_string(&out).unwrap();
        let rows: Vec<Vec<&str>> = output
            .lines()
            .skip(1)
            .map(|line| line.split('\t').collect())
            .collect();
        assert!(rows.iter().all(|row| row.len() == 7 && row[1] != row[3]));
        assert_eq!(
            rows.iter()
                .filter(|r| r[0] == "sample" && r[6] == "exact")
                .count(),
            2
        );
        assert_eq!(
            rows.iter()
                .filter(|r| r[0] == "library" && r[6] == "exact")
                .count(),
            5
        );
        assert!(rows.iter().any(|r| r[0] == "library" && r[3] == "missing"));
        assert!(rows.iter().all(|r| r[1] != "missing"));
        assert_eq!(fs::read(root.join("library.sqlite")).unwrap(), before);
    }
}
