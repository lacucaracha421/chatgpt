use super::{fingerprint::*, scan::Source, *};
use crate::library::{image_fingerprint::ImageFingerprint, Library};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::{
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

fn hash(seed: u8) -> ImageFingerprint {
    let bytes: [u8; 32] = Sha256::digest([seed]).into();
    ImageFingerprint {
        bytes,
        cropped_bytes: bytes,
        quality: 100,
    }
}
fn sequence() -> VideoFingerprint {
    VideoFingerprint {
        duration_ms: 12_000,
        width: 640,
        height: 480,
        frames: sample_times(12_000)
            .into_iter()
            .enumerate()
            .map(|(i, at_ms)| FrameFingerprint {
                at_ms,
                hash: hash(i as u8),
            })
            .collect(),
    }
}

#[test]
fn fixed_midpoints_and_complete_timeline_match() {
    assert_eq!(
        sample_times(12_000),
        vec![500, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500]
    );
    let a = sequence();
    let evidence = compare(&a, &a, PROFILE).unwrap();
    assert_eq!(evidence.matched_frames, 12);
    assert_eq!(evidence.matching_span_permille, 1000);
    let mut resized = a.clone();
    resized.width = 320;
    resized.height = 240;
    assert!(compare(&a, &resized, PROFILE).is_some());
}

#[test]
fn rejects_shared_opening_reversed_static_low_quality_and_wrong_geometry() {
    let a = sequence();
    let mut opening = a.clone();
    for frame in &mut opening.frames[4..] {
        frame.hash = hash(99);
    }
    assert!(compare(&a, &opening, PROFILE).is_none());
    let mut reverse = a.clone();
    reverse.frames.reverse();
    assert!(compare(&a, &reverse, PROFILE).is_none());
    let mut still = a.clone();
    for frame in &mut still.frames {
        frame.hash = hash(1);
    }
    assert!(compare(&still, &still, PROFILE).is_none());
    let mut low = a.clone();
    for frame in &mut low.frames {
        frame.hash.quality = 49;
    }
    assert!(compare(&a, &low, PROFILE).is_none());
    let mut length = a.clone();
    length.duration_ms = 15_000;
    assert!(compare(&a, &length, PROFILE).is_none());
    let mut aspect = a.clone();
    aspect.height = 360;
    assert!(compare(&a, &aspect, PROFILE).is_none());
    let mut short = a.clone();
    short.frames.pop();
    assert!(compare(&a, &short, PROFILE).is_none());
}

struct Fixture {
    _directory: tempfile::TempDir,
    library: Library,
}
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::open(directory.path()).unwrap();
    Fixture {
        _directory: directory,
        library,
    }
}
fn add_video(library: &Library, bytes: &[u8]) -> Source {
    let id = uuid::Uuid::new_v4().to_string();
    let hash = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let path = format!("assets/{hash}.mp4");
    std::fs::write(library.root().join(&path), bytes).unwrap();
    let connection = library.connection().unwrap();
    connection.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,byte_size,width,height,collected_at,status)
        VALUES(?1,?2,'video','clip.mp4',?3,?4,640,480,'2026-09-08T00:00:00Z','normal')",params![id,hash,path,bytes.len() as i64]).unwrap();
    connection.execute("INSERT INTO video_assets(asset_id,duration_ms,container,video_codec,preparation_state) VALUES(?1,12000,'mp4','h264','pending')",[&id]).unwrap();
    drop(connection);
    library.video_similarity_source(&id).unwrap()
}
fn add_review(library: &Library) -> (String, Source, Source) {
    let a = add_video(library, b"original left video bytes");
    let b = add_video(library, b"original right video bytes");
    let (left, right) = if a.hash < b.hash { (a, b) } else { (b, a) };
    let scan_id = uuid::Uuid::new_v4().to_string();
    library.connection().unwrap().execute("INSERT INTO video_similarity_scans(id,profile,state,created_at,updated_at) VALUES(?1,?2,'completed','2026-09-08','2026-09-08')",params![scan_id,PROFILE]).unwrap();
    library
        .save_video_review(
            &scan_id,
            &left,
            &right,
            &compare(&sequence(), &sequence(), PROFILE).unwrap(),
        )
        .unwrap();
    let id = library
        .connection()
        .unwrap()
        .query_row("SELECT id FROM video_similarity_reviews", [], |r| r.get(0))
        .unwrap();
    (id, left, right)
}

#[test]
fn keep_left_uses_trash_preserves_files_and_decision_is_idempotent() {
    let f = fixture();
    let (id, left, right) = add_review(&f.library);
    let request = || VideoDecisionRequest {
        review_id: id.clone(),
        decision: VideoReviewDecision::KeepLeft,
    };
    f.library.decide_video_similarity_review(request()).unwrap();
    f.library.decide_video_similarity_review(request()).unwrap();
    let status: String = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT status FROM assets WHERE id=?1", [&right.id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(status, "trash");
    assert!(f.library.root().join(&left.path).is_file());
    assert!(f.library.root().join(&right.path).is_file());
    assert_eq!(
        f.library
            .list_video_similarity_reviews(None, 1)
            .unwrap()
            .total_count,
        0
    );
    assert!(matches!(
        f.library
            .decide_video_similarity_review(VideoDecisionRequest {
                review_id: id.clone(),
                decision: VideoReviewDecision::KeepBoth
            }),
        Err(Error::Conflict)
    ));
    f.library.restore_asset(&right.id).unwrap();
    let scan_id: String = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT id FROM video_similarity_scans", [], |r| r.get(0))
        .unwrap();
    f.library
        .save_video_review(
            &scan_id,
            &left,
            &right,
            &compare(&sequence(), &sequence(), PROFILE).unwrap(),
        )
        .unwrap();
    assert_eq!(
        f.library
            .list_video_similarity_reviews(None, 1)
            .unwrap()
            .total_count,
        0
    );
}

#[test]
fn changed_actual_original_is_stale_even_with_unchanged_database_hash() {
    let f = fixture();
    let (id, left, right) = add_review(&f.library);
    let mut changed = std::fs::read(f.library.root().join(&right.path)).unwrap();
    changed[0] ^= 1;
    std::fs::write(f.library.root().join(&right.path), changed).unwrap();
    assert!(matches!(
        f.library
            .decide_video_similarity_review(VideoDecisionRequest {
                review_id: id,
                decision: VideoReviewDecision::KeepLeft
            }),
        Err(Error::Stale)
    ));
    for source in [&left, &right] {
        let status: String = f
            .library
            .connection()
            .unwrap()
            .query_row("SELECT status FROM assets WHERE id=?1", [&source.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "normal");
    }
}

#[test]
fn keep_right_trashes_only_left_and_retains_both_originals() {
    let f = fixture();
    let (id, left, right) = add_review(&f.library);
    f.library
        .decide_video_similarity_review(VideoDecisionRequest {
            review_id: id,
            decision: VideoReviewDecision::KeepRight,
        })
        .unwrap();
    for (source, expected) in [(&left, "trash"), (&right, "normal")] {
        let state: String = f
            .library
            .connection()
            .unwrap()
            .query_row("SELECT status FROM assets WHERE id=?1", [&source.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, expected);
        assert!(f.library.root().join(&source.path).is_file());
    }
}

#[test]
fn keep_both_and_not_similar_persist_without_modifying_assets() {
    for decision in [
        VideoReviewDecision::KeepBoth,
        VideoReviewDecision::NotSimilar,
    ] {
        let f = fixture();
        let (id, left, right) = add_review(&f.library);
        f.library
            .decide_video_similarity_review(VideoDecisionRequest {
                review_id: id.clone(),
                decision,
            })
            .unwrap();
        f.library
            .decide_video_similarity_review(VideoDecisionRequest {
                review_id: id,
                decision,
            })
            .unwrap();
        for source in [&left, &right] {
            let state: String = f
                .library
                .connection()
                .unwrap()
                .query_row("SELECT status FROM assets WHERE id=?1", [&source.id], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(state, "normal");
            assert!(f.library.root().join(&source.path).is_file());
        }
        assert_eq!(
            f.library
                .list_video_similarity_reviews(None, 1)
                .unwrap()
                .total_count,
            0
        );
    }
}

#[test]
fn permanent_asset_removal_keeps_pair_history_without_foreign_key_failure() {
    let f = fixture();
    let (id, left, _) = add_review(&f.library);
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM assets WHERE id=?1", [&left.id])
        .unwrap();
    let state: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT state FROM video_similarity_reviews WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "stale");
    assert!(!f
        .library
        .connection()
        .unwrap()
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}

#[test]
fn separate_video_scan_does_not_quarantine_assets_or_touch_image_hashes() {
    let f = fixture();
    let (_, left, right) = add_review(&f.library);
    let page = f.library.list_video_similarity_reviews(None, 1).unwrap();
    assert_eq!(page.total_count, 1);
    assert_eq!(page.items.len(), 1);
    for id in [&left.id, &right.id] {
        let row: (String, Option<Vec<u8>>) = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT status,perceptual_hash FROM assets WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("normal".into(), None));
    }
    let count: u32 = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM similarity_reviews", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn recovery_pauses_without_starting_a_worker() {
    let f = fixture();
    let (_, _, _) = add_review(&f.library);
    f.library
        .connection()
        .unwrap()
        .execute("UPDATE video_similarity_scans SET state='running'", [])
        .unwrap();
    f.library.recover_video_similarity_scans().unwrap();
    let state: String = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT state FROM video_similarity_scans", [], |r| r.get(0))
        .unwrap();
    assert_eq!(state, "paused");
}

#[test]
fn source_verification_honors_cancellation_and_deadline() {
    let f = fixture();
    let a = add_video(&f.library, b"video bytes");
    assert!(matches!(
        f.library.verify_video_similarity_source(
            &a,
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(1)
        ),
        Err("cancelled")
    ));
    assert!(matches!(
        f.library
            .verify_video_similarity_source(&a, &AtomicBool::new(false), Instant::now()),
        Err("timeout")
    ));
}

#[test]
fn restore_guard_blocks_new_scan_until_replacement_finishes() {
    use std::sync::mpsc;
    let f = fixture();
    let left = add_video(&f.library, b"left restore fixture");
    let right = add_video(&f.library, b"right restore fixture");
    // No native extraction can run: these explicitly selected fixtures are outside duration scope.
    f.library
        .connection()
        .unwrap()
        .execute("UPDATE video_assets SET duration_ms=1", [])
        .unwrap();
    let guard = f.library.video_similarity_restore_guard().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let library = f.library.clone();
    let worker = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let outcome = library.start_video_similarity_scan(VideoScanRequest {
            asset_ids: vec![left.id, right.id],
        });
        finished_tx.send(outcome.is_ok()).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(matches!(
        finished_rx.recv_timeout(Duration::from_millis(80)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(guard);
    assert!(finished_rx.recv_timeout(Duration::from_secs(2)).unwrap());
    worker.join().unwrap();
    f.library.stop_video_similarity_scan();
}

/// Uses installed LGPL FFmpeg only, temporary generated media, and no production library.
#[test]
#[ignore = "explicit native FFmpeg acceptance, creates temporary synthetic videos"]
fn native_ffmpeg_reencode_and_negative_timeline() {
    use crate::library::{image_fingerprint::fingerprint, video_media};
    use image::{ImageBuffer, Rgb};
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let directory = tempfile::tempdir().unwrap();
    for frame in 0_u32..24 {
        let image = ImageBuffer::from_fn(640, 480, |x, y| {
            let cell_x = x / 32;
            let cell_y = y / 32;
            let digest = Sha256::digest(format!("{frame}:{cell_x}:{cell_y}"));
            Rgb([digest[0], digest[1], digest[2]])
        });
        image
            .save(directory.path().join(format!("frame{frame:02}.png")))
            .unwrap();
    }
    let ffmpeg = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
    let run = |args: Vec<std::ffi::OsString>| {
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(args);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    let original = directory.path().join("original.mp4");
    let variant = directory.path().join("variant.mp4");
    let reversed = directory.path().join("reversed.mp4");
    run(vec![
        "-y".into(),
        "-v".into(),
        "error".into(),
        "-framerate".into(),
        "2".into(),
        "-i".into(),
        directory.path().join("frame%02d.png").into_os_string(),
        "-c:v".into(),
        "mpeg4".into(),
        "-q:v".into(),
        "2".into(),
        original.clone().into_os_string(),
    ]);
    run(vec![
        "-y".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        original.clone().into_os_string(),
        "-vf".into(),
        "scale=320:240".into(),
        "-c:v".into(),
        "mpeg4".into(),
        "-q:v".into(),
        "4".into(),
        variant.clone().into_os_string(),
    ]);
    run(vec![
        "-y".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        original.clone().into_os_string(),
        "-vf".into(),
        "reverse".into(),
        "-c:v".into(),
        "mpeg4".into(),
        "-q:v".into(),
        "2".into(),
        reversed.clone().into_os_string(),
    ]);
    let extract = |path: &std::path::Path| {
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(60);
        video_media::inspect_similarity_geometry(path, &cancel, deadline).unwrap();
        let frames = sample_times(12_000)
            .into_iter()
            .map(|at_ms| {
                let frame =
                    video_media::extract_similarity_frame(path, at_ms, &cancel, deadline).unwrap();
                FrameFingerprint {
                    at_ms,
                    hash: fingerprint(&frame).unwrap(),
                }
            })
            .collect();
        VideoFingerprint {
            duration_ms: 12_000,
            width: 640,
            height: 480,
            frames,
        }
    };
    let a = extract(&original);
    let b = extract(&variant);
    let matched =
        compare(&a, &b, PROFILE).expect("synthetic reencode/resolution variant must match");
    eprintln!(
        "native synthetic variant: {}/12 frames",
        matched.matched_frames
    );
    let wrong = extract(&reversed);
    assert!(
        compare(&a, &wrong, PROFILE).is_none(),
        "reordered timeline must not match"
    );
    let mut opening = b;
    for frame in &mut opening.frames[4..] {
        frame.hash = hash(99);
    }
    assert!(
        compare(&a, &opening, PROFILE).is_none(),
        "common opening must not match"
    );

    // Full explicit scan path: actual source checks, bounded extraction, cache,
    // persisted candidate, and a repeated scan that reuses the completed cache.
    let f = fixture();
    let left = add_video(&f.library, &std::fs::read(&original).unwrap());
    let right = add_video(&f.library, &std::fs::read(&variant).unwrap());
    let wait = |scan: VideoScanProgress| {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let status = f.library.get_video_similarity_scan(&scan.id).unwrap();
            if !matches!(status.state.as_str(), "queued" | "running") {
                assert_eq!(status.state, "completed", "{:?}", status);
                assert_eq!(status.completed, 2, "{:?}", status);
                assert_eq!(status.candidate_count, 1, "{:?}", status);
                f.library.stop_video_similarity_scan();
                break;
            }
            assert!(
                Instant::now() < deadline,
                "native scan exceeded its fixture deadline"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    };
    let request = || VideoScanRequest {
        asset_ids: vec![left.id.clone(), right.id.clone()],
    };
    wait(f.library.start_video_similarity_scan(request()).unwrap());
    let cached_at: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT created_at FROM video_similarity_fingerprints WHERE asset_id=?1",
            [&left.id],
            |r| r.get(0),
        )
        .unwrap();
    wait(f.library.start_video_similarity_scan(request()).unwrap());
    let cached_after: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT created_at FROM video_similarity_fingerprints WHERE asset_id=?1",
            [&left.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        cached_at, cached_after,
        "repeat scan must reuse the completed fingerprint"
    );
    assert_eq!(
        f.library
            .list_video_similarity_reviews(None, 1)
            .unwrap()
            .total_count,
        1
    );
}
