use std::{env, fs, path::Path};

use app_lib::library::{
    models::{IngestMediaRequest, IngestOutcome, MediaSummary, VideoPreparationState},
    Library,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

#[test]
#[ignore = "requires explicit real/local video fixture paths"]
fn real_windows_video_workflow_preserves_sources_and_derives_media() {
    let fixtures = [
        fixture("LAKOMICS_ACCEPTANCE_WEBM_1", "original"),
        fixture("LAKOMICS_ACCEPTANCE_WEBM_2", "original"),
        fixture("LAKOMICS_ACCEPTANCE_MP4", "original"),
        fixture("LAKOMICS_ACCEPTANCE_MOV", "proxy"),
        fixture("LAKOMICS_ACCEPTANCE_LONG", "proxy"),
    ];
    let hashes_before = fixtures
        .iter()
        .map(|(path, _)| file_hash(path))
        .collect::<Vec<_>>();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Lakomics Video Acceptance");
    let library = Library::open(&root).unwrap();
    let assets = fixtures
        .iter()
        .map(|(path, _)| ingest_added(&library, path))
        .collect::<Vec<_>>();

    let duplicate = library
        .ingest_media(request(&fixtures[0].0))
        .expect("exact duplicate check must succeed");
    assert!(matches!(duplicate, IngestOutcome::ExactDuplicate { .. }));

    let progress = library.prepare_pending_videos(10).unwrap();
    assert_eq!(progress.processed, 5);
    assert_eq!(progress.remaining, 0);
    assert_eq!(progress.failed, 0);

    let connection = Connection::open(root.join("library.sqlite")).unwrap();
    for ((asset, (_, expected_playback)), expected_hash) in
        assets.iter().zip(fixtures.iter()).zip(hashes_before.iter())
    {
        let refreshed = library.get_asset(&asset.id).unwrap();
        let MediaSummary::Video {
            preparation_state,
            scrub_frame_count,
            ..
        } = refreshed.media
        else {
            panic!("fixture must remain a video");
        };
        assert_eq!(preparation_state, VideoPreparationState::Ready);
        assert!(scrub_frame_count > 0);
        let playback: String = connection
            .query_row(
                "SELECT playback_kind FROM video_assets WHERE asset_id = ?1",
                [&asset.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(&playback, expected_playback);
        assert_eq!(
            &file_hash(&fixtures[assets.iter().position(|item| item.id == asset.id).unwrap()].0),
            expected_hash
        );
        println!(
            "{} {} {} frames",
            asset.original_name, playback, scrub_frame_count
        );
    }
    drop(connection);
    drop(library);

    let reopened = Library::open(&root).unwrap();
    for asset in &assets {
        assert!(matches!(
            reopened.get_asset(&asset.id).unwrap().media,
            MediaSummary::Video {
                preparation_state: VideoPreparationState::Ready,
                ..
            }
        ));
    }
    reopened
        .trash_assets(std::slice::from_ref(&assets[0].id))
        .unwrap();
    reopened.restore_asset(&assets[0].id).unwrap();
    reopened
        .trash_assets(std::slice::from_ref(&assets[4].id))
        .unwrap();
    assert_eq!(reopened.empty_trash().unwrap().deleted_count, 1);
    drop(reopened);

    for ((path, _), expected_hash) in fixtures.iter().zip(hashes_before.iter()) {
        assert_eq!(&file_hash(path), expected_hash);
        println!("{} sha256={expected_hash}", path.display());
    }
}

#[test]
#[ignore = "mutates only the explicitly supplied acceptance library"]
fn populate_explicit_acceptance_library_with_real_webms() {
    let root = env::var_os("LAKOMICS_ACCEPTANCE_LIBRARY")
        .map(std::path::PathBuf::from)
        .expect("acceptance library environment variable is required");
    let sources = [
        fixture("LAKOMICS_ACCEPTANCE_WEBM_1", "original").0,
        fixture("LAKOMICS_ACCEPTANCE_WEBM_2", "original").0,
    ];
    let hashes = sources
        .iter()
        .map(|path| file_hash(path))
        .collect::<Vec<_>>();
    let library = Library::open(root).unwrap();
    for path in &sources {
        match library.ingest_media(request(path)).unwrap() {
            IngestOutcome::Added { .. } | IngestOutcome::ExactDuplicate { .. } => {}
            IngestOutcome::ReviewPending { .. } => panic!("videos never enter similarity review"),
        }
    }
    let progress = library.prepare_pending_videos(10).unwrap();
    assert_eq!(progress.failed, 0);
    drop(library);
    for (path, hash) in sources.iter().zip(hashes) {
        assert_eq!(file_hash(path), hash);
    }
}

fn fixture(name: &str, playback: &'static str) -> (std::path::PathBuf, &'static str) {
    let path = env::var_os(name)
        .map(Into::into)
        .expect("fixture environment variable is required");
    assert!(
        Path::new(&path).is_file(),
        "fixture does not exist: {}",
        Path::new(&path).display()
    );
    (path, playback)
}

fn request(path: &Path) -> IngestMediaRequest {
    IngestMediaRequest {
        source_path: path.to_owned(),
        classification_id: None,
        source_url: None,
        collected_at: None,
        replace_duplicate_metadata: false,
    }
}

fn ingest_added(library: &Library, path: &Path) -> app_lib::library::models::AssetSummary {
    match library.ingest_media(request(path)).unwrap() {
        IngestOutcome::Added { asset } => asset,
        outcome => panic!("first ingest must add the fixture: {outcome:?}"),
    }
}

fn file_hash(path: &Path) -> String {
    Sha256::digest(fs::read(path).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
