use std::{sync::mpsc, time::Duration};

use super::{set_staging_hook, Library};
use crate::library::models::{ImportSource, IngestMediaRequest, IngestOutcome};

#[test]
fn same_batch_duplicates_prepare_concurrently_but_register_once() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.png");
    image::RgbImage::from_fn(1200, 900, |x, y| {
        image::Rgb([(x % 251) as u8, (y % 253) as u8, ((x + y) % 255) as u8])
    })
    .save(&source)
    .unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let mut releases = Vec::new();
    let mut workers = Vec::new();
    for _ in 0..2 {
        let (release_tx, release_rx) = mpsc::channel();
        releases.push(release_tx);
        let ready_tx = ready_tx.clone();
        let library = library.clone();
        let source = source.clone();
        workers.push(std::thread::spawn(move || {
            set_staging_hook(move |_| {
                ready_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(20)).unwrap();
            });
            library.ingest_media(IngestMediaRequest {
                source_path: source,
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
        }));
    }
    let both_prepared = (0..2).all(|_| ready_rx.recv_timeout(Duration::from_secs(5)).is_ok());
    for release in releases {
        let _ = release.send(());
    }
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap().unwrap())
        .collect();
    assert!(
        both_prepared,
        "independent staging must overlap across library clones"
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|r| matches!(r, IngestOutcome::Added { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|r| matches!(r, IngestOutcome::ExactDuplicate { .. }))
            .count(),
        1
    );
    let db = library.connection().unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let (asset, thumbnail): (String, String) = db
        .query_row(
            "SELECT relative_path, thumbnail_relative_path FROM assets",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(library.root().join(asset).is_file());
    assert!(library.root().join(thumbnail).is_file());
    assert_eq!(
        std::fs::read_dir(library.root().join("assets/.staging"))
            .unwrap()
            .count(),
        0
    );
}
