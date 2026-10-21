//! Disposable, opt-in benchmark. Run alone with --ignored --nocapture.
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::Instant,
};

use crate::library::{
    models::{ImportSource, IngestMediaRequest},
    Library,
};

static ENABLED: AtomicBool = AtomicBool::new(false);
static TIMES: Mutex<BTreeMap<&'static str, (u128, u32)>> = Mutex::new(BTreeMap::new());

pub(in crate::library) struct Phase(&'static str, Option<Instant>);

impl Phase {
    pub(in crate::library) fn start(name: &'static str) -> Self {
        Self(name, ENABLED.load(Ordering::Relaxed).then(Instant::now))
    }
}

impl Drop for Phase {
    fn drop(&mut self) {
        if let Some(start) = self.1 {
            let mut times = TIMES.lock().unwrap();
            let entry = times.entry(self.0).or_default();
            entry.0 += start.elapsed().as_micros();
            entry.1 += 1;
        }
    }
}

#[test]
#[ignore = "30 high-resolution images and 3000 existing rows; disposable performance fixture"]
fn ingestion_batch_performance() {
    let temp = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for i in 0..30u32 {
        // Layered colour fields, edges and fine texture, rather than tiny/flat images.
        let image = image::RgbImage::from_fn(2400, 2000, |x, y| {
            let cell = (x / (37 + i) + y / (29 + i)).wrapping_mul(2654435761u32);
            image::Rgb([
                ((x / 7 + y / 11 + (cell >> 24) + i * 13) % 256) as u8,
                ((x / 19 + y / 3 + (cell >> 16) + i * 31) % 256) as u8,
                ((x / 5 + y / 17 + (cell >> 8) + i * 47) % 256) as u8,
            ])
        });
        let extension = ["jpg", "png", "webp"][i as usize % 3];
        let path = temp.path().join(format!("source-{i}.{extension}"));
        image.save(&path).unwrap();
        paths.push(path);
    }
    let workers: usize = std::env::var("LAKOMICS_INGEST_BENCH_WORKERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    assert!((1..=3).contains(&workers));
    // Repeat with fresh databases/files, keeping the same generated source bytes.
    for round in 0..2 {
        let library = Library::open(temp.path().join(format!("library-{round}"))).unwrap();
        {
            let mut db = library.connection().unwrap();
            let tx = db.transaction().unwrap();
            for i in 0..3000u32 {
                let mut hash = vec![0u8; 64];
                let mut state = i as u64 + 1;
                for byte in &mut hash {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    *byte = state as u8;
                }
                tx.execute("INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path, thumbnail_relative_path, byte_size, width, height, collected_at, favorite, status, perceptual_hash, perceptual_hash_quality) VALUES (?1, ?1, 'image', 'fixture.jpg', ?2, ?4, 1000000, 2400, 2000, '2026-01-01T00:00:00Z', 0, 'normal', ?3, 90)",
                    rusqlite::params![format!("existing-{i:04}"), format!("assets/fixture-{i}.jpg"), hash, format!("thumbnails/fixture-{i}.webp")]).unwrap();
            }
            tx.commit().unwrap();
        }
        TIMES.lock().unwrap().clear();
        ENABLED.store(true, Ordering::Relaxed);
        let started = Instant::now();
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..workers {
                let library = &library;
                let paths = &paths;
                let next = &next;
                scope.spawn(move || loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= paths.len() {
                        break;
                    }
                    library
                        .ingest_media(IngestMediaRequest {
                            source_path: paths[index].clone(),
                            classification_id: None,
                            source_url: None,
                            collected_at: None,
                            replace_duplicate_metadata: false,
                            source_published_at: None,
                            creator_name: None,
                            creator_handle: None,
                            creator_url: None,
                            import_source: ImportSource::Direct,
                            import_batch_id: "00000000-0000-4000-8000-000000000001".into(),
                        })
                        .unwrap();
                });
            }
        });
        let wall = started.elapsed();
        ENABLED.store(false, Ordering::Relaxed);
        {
            let times = TIMES.lock().unwrap();
            assert_eq!(times["fingerprint_decode"].1, 30);
            assert!(
                !times.contains_key("thumbnail_decode"),
                "shared pixels must not be decoded again for thumbnails"
            );
        }
        eprintln!("INGEST_BENCH round={round} workers={workers} rows=3000 images=30 size=2400x2000 wall_ms={:.2}", wall.as_secs_f64() * 1000.0);
        for (name, (micros, count)) in TIMES.lock().unwrap().iter() {
            eprintln!(
                "INGEST_PHASE {name} total_ms={:.2} mean_ms={:.2} count={count}",
                *micros as f64 / 1000.0,
                *micros as f64 / 1000.0 / *count as f64
            );
        }
        let db = library.connection().unwrap();
        let fingerprints: i64 = db.query_row("SELECT COUNT(*) FROM assets WHERE id NOT LIKE 'existing-%' AND perceptual_hash_quality >= 50", [], |r| r.get(0)).unwrap();
        assert_eq!(
            fingerprints, 30,
            "fixture must exercise the full similarity scan"
        );
        assert_eq!(
            std::fs::read_dir(library.root().join("assets/.staging"))
                .unwrap()
                .count(),
            0
        );
    }
}
