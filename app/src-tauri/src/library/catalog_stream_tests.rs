use super::{
    catalog_checkpoint as checkpoints, commit_stream_page,
    tests::{catalog, page},
    RemoteCatalogPage,
};
use crate::library::{catalog_provider::CatalogWorkIdentity, models::CatalogLanguage, Library};
use rusqlite::Connection;

const KO: CatalogLanguage = CatalogLanguage::Korean;
const JA: CatalogLanguage = CatalogLanguage::Japanese;
const AT: &str = "2026-09-05T00:00:00Z";

fn japanese(ids: &[u64]) -> RemoteCatalogPage {
    RemoteCatalogPage::parse(&page(ids).replace("\"korean\"", "\"japanese\"")).unwrap()
}

fn seed(path: &std::path::Path) {
    let work = RemoteCatalogPage::parse(&page(&[1000])).unwrap();
    super::write_catalog_page(path, &work.works, 1).unwrap();
}

fn snapshot(path: &std::path::Path) -> Vec<(String, String)> {
    let connection = Connection::open(path).unwrap();
    let result = connection
        .prepare("SELECT Key,Value FROM CrawlState ORDER BY Key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    result
}

#[test]
fn korean_legacy_checkpoint_is_adopted_without_changing_its_boundary() {
    let (_dir, path) = catalog();
    seed(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("INSERT INTO CrawlState VALUES('lakomics_update_watermark','800'),('lakomics_update_cursor','900'),('sweep.cursor','77')").unwrap();
    let expected = checkpoints::load(&connection, KO).unwrap();
    assert_eq!((expected.watermark, expected.cursor), (800, Some(900)));
    checkpoints::start(&path, JA, AT).unwrap();
    assert_eq!(checkpoints::load(&connection, KO).unwrap(), expected);
    assert_eq!(
        connection
            .query_row(
                "SELECT Value FROM CrawlState WHERE Key='sweep.cursor'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "77"
    );
    assert_eq!(
        super::load_checkpoint(&path).unwrap(),
        Some(super::UpdateCheckpoint {
            watermark: 800,
            cursor: 900
        })
    );
}

#[test]
fn japanese_initial_upserts_below_korean_max_and_does_not_advance_korean() {
    let (_dir, path) = catalog();
    seed(&path);
    let connection = Connection::open(&path).unwrap();
    let korean = checkpoints::load(&connection, KO).unwrap();
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    assert_eq!((initial.watermark, initial.initial_complete), (0, false));
    let (added, next) = commit_stream_page(&path, JA, &initial, &japanese(&[100, 90]), 2).unwrap();
    assert_eq!(added, 2);
    assert_eq!(
        (next.watermark, next.cursor, next.initial_complete),
        (100, None, true)
    );
    assert_eq!(checkpoints::load(&connection, KO).unwrap(), korean);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn japanese_resume_uses_its_cursor_and_preserves_the_initial_zero_boundary() {
    let (_dir, path) = catalog();
    seed(&path);
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    let first = japanese(&(101..=150).rev().collect::<Vec<_>>());
    let (_, partial) = commit_stream_page(&path, JA, &initial, &first, 2).unwrap();
    assert_eq!(
        (
            partial.watermark,
            partial.pending_max,
            partial.cursor,
            partial.initial_complete
        ),
        (0, 150, Some(101), false)
    );
    let resumed = checkpoints::start(&path, JA, "2026-09-05T01:00:00Z").unwrap();
    assert_eq!(resumed, partial);
    let (_, done) = commit_stream_page(&path, JA, &resumed, &japanese(&[100, 90]), 3).unwrap();
    assert_eq!(
        (done.watermark, done.cursor, done.initial_complete),
        (150, None, true)
    );
}

#[test]
fn repeated_committed_page_is_an_idempotent_noop() {
    let (_dir, path) = catalog();
    seed(&path);
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    let first = japanese(&(101..=150).rev().collect::<Vec<_>>());
    let (_, checkpoint) = commit_stream_page(&path, JA, &initial, &first, 2).unwrap();
    let before = snapshot(&path);
    let (added, replay) = commit_stream_page(&path, JA, &initial, &first, 3).unwrap();
    assert_eq!((added, replay), (0, checkpoint));
    assert_eq!(snapshot(&path), before);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        51
    );
    assert_eq!(
        connection
            .query_row("SELECT CrawledAt FROM Works WHERE Id=150", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn failed_work_or_checkpoint_write_rolls_back_the_entire_page() {
    for trigger in [
        "CREATE TRIGGER reject_work BEFORE INSERT ON Works WHEN NEW.Id=90 BEGIN SELECT RAISE(ABORT,'fixture'); END",
        "CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON CrawlState WHEN NEW.Key='lakomics.catalog.kHentai.japanese.checkpoint' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    ] {
        let (_dir, path) = catalog(); seed(&path);
        let initial = checkpoints::start(&path, JA, AT).unwrap();
        let before = snapshot(&path);
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(trigger).unwrap();
        assert!(commit_stream_page(&path, JA, &initial, &japanese(&[100,90]), 2).is_err());
        assert_eq!(snapshot(&path), before);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0)).unwrap(),1);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM Tags", [], |row| row.get::<_, i64>(0)).unwrap(),2);
    }
}

#[test]
fn wrong_language_and_nonprogress_pages_do_not_advance_checkpoint() {
    let (_dir, path) = catalog();
    seed(&path);
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    let before = snapshot(&path);
    let korean = RemoteCatalogPage::parse(&page(&[100, 90])).unwrap();
    assert!(commit_stream_page(&path, JA, &initial, &korean, 2).is_err());
    let malformed =
        RemoteCatalogPage::parse(&serde_json::to_string(&vec![serde_json::json!({}); 50]).unwrap())
            .unwrap();
    assert!(commit_stream_page(&path, JA, &initial, &malformed, 2).is_err());
    assert_eq!(snapshot(&path), before);
}

#[test]
fn japanese_incremental_keeps_its_own_watermark_and_korean_progress_is_independent() {
    let (_dir, path) = catalog();
    seed(&path);
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    commit_stream_page(&path, JA, &initial, &japanese(&[100, 90]), 2).unwrap();
    let increment = checkpoints::start(&path, JA, AT).unwrap();
    let (added, done) =
        commit_stream_page(&path, JA, &increment, &japanese(&[120, 110, 100]), 3).unwrap();
    assert_eq!((added, done.watermark, done.cursor), (2, 120, None));
    let korean = checkpoints::start(&path, KO, AT).unwrap();
    assert_eq!(korean.watermark, 1000);
    let ko_page = RemoteCatalogPage::parse(&page(&[1100, 1000, 999])).unwrap();
    let (added, ko_next) = commit_stream_page(&path, KO, &korean, &ko_page, 4).unwrap();
    assert_eq!((added, ko_next.watermark), (1, 1100));
    let connection = Connection::open(&path).unwrap();
    assert_eq!(checkpoints::load(&connection, JA).unwrap(), done);
    assert_eq!(
        connection
            .query_row("SELECT CrawledAt FROM Works WHERE Id=100", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM Works WHERE Id=999", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn canonical_overlap_preserves_both_language_memberships_and_unrelated_data() {
    let (dir, path) = catalog();
    seed(&path);
    let library = Library::open(dir.path()).unwrap();
    library
        .set_online_catalog_bookmark(&CatalogWorkIdentity::khentai(1000), true)
        .unwrap();
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    let body = serde_json::json!([{"id":1000,"title":"canonical Japanese snapshot","tags":[{"tag":["language","japanese"]},{"tag":["artist","new artist"]}]}]).to_string();
    let page = RemoteCatalogPage::parse(&body).unwrap();
    let (added, _) = commit_stream_page(&path, JA, &initial, &page, 2).unwrap();
    assert_eq!(added, 0);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM Works WHERE Id=1000", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let tags = connection
        .prepare("SELECT Namespace,Value FROM Tags WHERE WorkId=1000 ORDER BY Namespace,Value")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        tags,
        vec![
            ("artist".into(), "new artist".into()),
            ("language".into(), "japanese".into()),
            ("language".into(), "korean".into())
        ]
    );
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM online_catalog_bookmarks WHERE work_id='1000'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn japanese_reset_preserves_korean_checkpoints_catalog_and_user_metadata() {
    let (dir, path) = catalog();
    seed(&path);
    let library = Library::open(dir.path()).unwrap();
    library
        .set_online_catalog_bookmark(&CatalogWorkIdentity::khentai(1000), true)
        .unwrap();
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    commit_stream_page(&path, JA, &initial, &japanese(&[100]), 2).unwrap();
    let korean: Vec<_> = snapshot(&path)
        .into_iter()
        .filter(|(key, _)| !key.contains(".japanese."))
        .collect();
    checkpoints::reset_japanese(&path).unwrap();
    assert_eq!(snapshot(&path), korean);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(checkpoints::load(&connection, JA).unwrap().watermark, 0);
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM online_catalog_bookmarks", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn stream_status_distinguishes_failed_partial_progress_from_completion() {
    let (_dir, path) = catalog();
    seed(&path);
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    commit_stream_page(
        &path,
        JA,
        &initial,
        &japanese(&(101..=150).rev().collect::<Vec<_>>()),
        2,
    )
    .unwrap();
    checkpoints::record_error(&path, JA, "fixture failed page").unwrap();
    let statuses = checkpoints::statuses(&path).unwrap();
    let ja = statuses.iter().find(|s| s.language == JA).unwrap();
    assert!(ja.has_state);
    assert!(!ja.initial_complete);
    assert_eq!(ja.cursor, Some(101));
    assert!(ja.last_progress_at.is_some());
    assert!(ja.last_completed_at.is_none());
    assert_eq!(ja.last_error.as_deref(), Some("fixture failed page"));
    assert!(statuses
        .iter()
        .find(|s| s.language == KO)
        .unwrap()
        .last_error
        .is_none());
}

#[test]
fn japanese_incremental_resume_retains_the_previous_completed_watermark() {
    let (_dir, path) = catalog();
    seed(&path);
    let initial = checkpoints::start(&path, JA, AT).unwrap();
    commit_stream_page(&path, JA, &initial, &japanese(&[100]), 2).unwrap();
    let start = checkpoints::start(&path, JA, AT).unwrap();
    let (_, partial) = commit_stream_page(
        &path,
        JA,
        &start,
        &japanese(&(151..=200).rev().collect::<Vec<_>>()),
        3,
    )
    .unwrap();
    assert_eq!(
        (partial.watermark, partial.cursor, partial.pending_max),
        (100, Some(151), 200)
    );
    let restart = checkpoints::start(&path, JA, AT).unwrap();
    assert_eq!(restart, partial);
    let (added, done) =
        commit_stream_page(&path, JA, &restart, &japanese(&[150, 101, 100, 99]), 4).unwrap();
    assert_eq!((added, done.watermark, done.cursor), (2, 200, None));
}

#[test]
fn korean_ingestion_and_late_targeted_recovery_retain_japanese_membership() {
    let (_dir, path) = catalog();
    seed(&path);
    let ja = checkpoints::start(&path, JA, AT).unwrap();
    commit_stream_page(&path, JA, &ja, &japanese(&[2000, 70]), 2).unwrap();
    let ko = checkpoints::start(&path, KO, AT).unwrap();
    assert_eq!(ko.watermark, 1000);
    commit_stream_page(
        &path,
        KO,
        &ko,
        &RemoteCatalogPage::parse(&page(&[2000])).unwrap(),
        3,
    )
    .unwrap();
    let checkpoint_before = snapshot(&path);
    // Recovery selected the missing ID before Japanese ingestion committed it.
    assert!(super::import_targeted_work(&path, &page(&[70]), 70).unwrap());
    assert_eq!(snapshot(&path), checkpoint_before);
    let connection = Connection::open(&path).unwrap();
    for id in [2000, 70] {
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM Tags WHERE WorkId=?1 AND Namespace='language' AND Value IN ('korean','japanese')",[id],|row|row.get::<_,i64>(0)).unwrap(),2);
    }
}

#[test]
fn language_and_corrupt_checkpoint_fail_closed() {
    assert!(serde_json::from_str::<CatalogLanguage>("\"english\"").is_err());
    let (_dir, path) = catalog();
    seed(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute("INSERT INTO CrawlState VALUES('lakomics.catalog.kHentai.japanese.checkpoint','broken')",[]).unwrap();
    assert!(checkpoints::start(&path, JA, AT).is_err());
    let statuses = checkpoints::statuses(&path).unwrap();
    assert!(statuses
        .iter()
        .find(|stream| stream.language == JA)
        .unwrap()
        .last_error
        .is_some());
    assert!(statuses
        .iter()
        .find(|stream| stream.language == KO)
        .unwrap()
        .last_error
        .is_none());
    let korean = checkpoints::start(&path, KO, AT).unwrap();
    let page = RemoteCatalogPage::parse(&page(&[1100])).unwrap();
    commit_stream_page(&path, KO, &korean, &page, 2).unwrap();
    assert_eq!(checkpoints::load(&connection, KO).unwrap().watermark, 1100);
    checkpoints::reset_japanese(&path).unwrap();
    assert!(!checkpoints::load(&connection, JA).unwrap().initial_complete);
}

#[test]
#[ignore = "requires deployed language-aware VPS; explicit real-source canary on a disposable database copy"]
fn japanese_real_source_two_page_canary() {
    use crate::catalog_source::VpsCatalogSource;
    use rusqlite::{backup::Backup, OpenFlags};
    use std::{env, time::Duration};

    let source_path =
        env::var("LAKOMICS_JAPANESE_CANARY_SOURCE").expect("explicit source kdata.db required");
    let base_url = env::var("LAKOMICS_JAPANESE_CANARY_VPS").expect("deployed VPS URL required");
    let token =
        env::var("LAKOMICS_JAPANESE_CANARY_TOKEN").expect("Bearer token required; never printed");
    let source =
        Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let backup_path = directory.path().join("before.db");
    let mut backup = Connection::open(&backup_path).unwrap();
    Backup::new(&source, &mut backup)
        .unwrap()
        .run_to_completion(256, Duration::from_millis(10), None)
        .unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(backup);
    let path = directory.path().join("kdata.db");
    std::fs::copy(&backup_path, &path).unwrap();
    assert!(backup_path.is_file()); // Known SQLite backup exists before any mutation.
    let global_max = super::highest_stored_id(&path).unwrap();
    checkpoints::reset_japanese(&path).unwrap();
    checkpoints::start(&path, KO, AT).unwrap();
    let korean_before = snapshot(&path);
    let client = VpsCatalogSource::new(&base_url).unwrap();
    let mut found_below_max = false;
    let mut previous_cursor = None;
    let mut pages = 0;
    for index in 0..2 {
        // start reopens the DB, as a restarted app would; only Japanese cursor
        // and watermark are used for the subsequent authenticated request.
        let expected = checkpoints::start(&path, JA, AT).unwrap();
        assert_eq!(expected.cursor, previous_cursor);
        let body = client
            .fetch_search_page_for_language_bearer(expected.cursor, JA, &token)
            .unwrap();
        let page = RemoteCatalogPage::parse(&body).unwrap();
        let (_, next) =
            commit_stream_page(&path, JA, &expected, &page, chrono::Utc::now().timestamp())
                .unwrap();
        let connection = Connection::open(&path).unwrap();
        for work in &page.works {
            if work.id < global_max {
                found_below_max = true;
            }
            let (title, raw): (String, String) = connection
                .query_row(
                    "SELECT Title,RawJson FROM Works WHERE Id=?1",
                    [work.id as i64],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(title, work.title);
            assert_eq!(raw, work.raw_json);
            assert!(connection.query_row("SELECT EXISTS(SELECT 1 FROM Tags WHERE WorkId=?1 AND Namespace='language' AND Value='japanese')",[work.id as i64],|row|row.get::<_,bool>(0)).unwrap());
        }
        let before_replay = snapshot(&path);
        let count_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            commit_stream_page(&path, JA, &expected, &page, chrono::Utc::now().timestamp())
                .unwrap(),
            (0, next.clone())
        );
        assert_eq!(snapshot(&path), before_replay);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM Works", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            count_before
        );
        assert_eq!(
            snapshot(&path)
                .into_iter()
                .filter(|(key, _)| !key.contains(".japanese."))
                .collect::<Vec<_>>(),
            korean_before
        );
        pages = index + 1;
        previous_cursor = next.cursor;
        if next.cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        pages, 2,
        "Source ended before a second-page resume; the resume gate remains unproven."
    );
    assert!(found_below_max,"Two-page canary did not encounter an ID below the existing maximum; gate remains unproven. Do not broaden the crawl automatically.");
    eprintln!("Japanese real-source canary passed: {pages} pages on a disposable copy; source database unchanged");
}
