use super::*;
use crate::library::{characters::tests::Fixture, tagger_review::tests::automatic};
use rusqlite::{params, Connection};

fn fixture() -> (Fixture, String) {
    let f = Fixture::new();
    let t = f.ready("A");
    automatic(&f, &t);
    f.library.use_machine_settings(f.temp.path().join("machine.json"));
    f.library.set_auto_tag_inbox(Some(f.temp.path().to_string_lossy().into_owned()), true).unwrap();
    let c = Connection::open(f.temp.path().join(FILES[0])).unwrap();
    c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO meta VALUES('format','lakomics-auto-tags'),('version','1'),('model','pixai-v1.0'),('tagger_review_version','1');
        CREATE TABLE vocabulary(tag TEXT PRIMARY KEY,category TEXT);
        INSERT INTO vocabulary VALUES('alice','character');
        CREATE TABLE asset_tags(asset_id TEXT,tag TEXT,score REAL);
        INSERT INTO asset_tags VALUES('asset-5','alice',0.1);
        CREATE TABLE character_scores(asset_id TEXT,source TEXT,tag TEXT,score REAL);
        INSERT INTO character_scores VALUES('asset-5','pixai','alice',0.1),('asset-5','canary','alice',0.1);
        CREATE TABLE tagger_assets(asset_id TEXT,source TEXT);
        INSERT INTO tagger_assets VALUES('asset-5','pixai'),('asset-5','canary');
        CREATE TABLE tagger_vocabulary(source TEXT,tag TEXT);
        INSERT INTO tagger_vocabulary VALUES('pixai','alice'),('canary','alice');
        CREATE TABLE target_tags(target_id TEXT,tag TEXT);").unwrap();
    c.execute("INSERT INTO target_tags VALUES(?1,'alice')", [&t.id]).unwrap();
    (f, t.id)
}

#[test]
fn auto_tag_inbox_machine_round_trip_per_library_preserves_other_settings() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("machine.json");
    let settings = Settings { folder: Some(temp.path().to_string_lossy().into()), apply_tagger_review: false, last: Some(BTreeMap::from([(FILES[0].into(), Last { file_modified: "123".into(), file_size: 7, imported_at: "2026-09-28T00:00:00Z".into(), imported: BTreeMap::from([("taggedAssets".into(), 2)]), tagger: Some(TaggerCounts { veto: 1, recommend: 2 }), error: None })])) };
    machine_settings::set_auto_tag_inbox(&path, "a", settings.clone()).unwrap();
    machine_settings::set_auto_tag_inbox(&path, "b", Settings::default()).unwrap();
    machine_settings::set_entry(&path, "a", machine_settings::LibraryEntry { manga_root: Some("manga".into()), ..Default::default() }).unwrap();
    assert_eq!(machine_settings::entry(&path, "a").unwrap().unwrap().auto_tag_inbox, settings);
    assert_eq!(machine_settings::entry(&path, "b").unwrap().unwrap().auto_tag_inbox, Settings::default());
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(json["libraries"]["a"]["autoTagInbox"]["applyTaggerReview"], false);
    assert_eq!(serde_json::from_str::<Settings>("{}").unwrap(), Settings::default());
}

#[test]
fn auto_tag_inbox_imports_applies_once_and_skips_unchanged() {
    let (f, _) = fixture();
    let first = f.library.run_auto_tag_inbox().unwrap();
    let last = &first.settings.last.as_ref().unwrap()[FILES[0]];
    assert_eq!(last.error, None);
    assert_eq!(last.imported["taggedAssets"], 1);
    assert_eq!(last.tagger.as_ref().unwrap().veto, 1);
    let c = f.library.connection().unwrap();
    let count: i64 = c.query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r.get(0)).unwrap();
    drop(c);
    assert!(f.library.run_auto_tag_inbox().unwrap().processed.is_empty());
    Connection::open(f.temp.path().join(FILES[0])).unwrap().execute("INSERT INTO meta VALUES('padding',?1)", ["x".repeat(10000)]).unwrap();
    let second = f.library.run_auto_tag_inbox().unwrap();
    assert_eq!(second.processed, vec![FILES[0]]);
    assert_eq!(second.settings.last.unwrap()[FILES[0]].tagger.as_ref().unwrap().veto, 0);
    assert_eq!(f.library.connection().unwrap().query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r.get::<_, i64>(0)).unwrap(), count);
}

#[test]
fn auto_tag_inbox_bad_file_rolls_back_and_retries_only_after_hour_or_change() {
    let (f, _) = fixture();
    f.library.run_auto_tag_inbox().unwrap();
    let source = Connection::open(f.temp.path().join(FILES[0])).unwrap();
    source.execute("UPDATE vocabulary SET category='invalid-category'", []).unwrap();
    let failed = f.library.run_auto_tag_inbox().unwrap();
    let last = &failed.settings.last.as_ref().unwrap()[FILES[0]];
    assert!(last.error.is_some());
    assert!(last.imported.is_empty());
    assert_eq!(f.library.asset_auto_tags("asset-5").unwrap().tags.len(), 1);
    let attempted = chrono::DateTime::parse_from_rfc3339(&last.imported_at).unwrap().with_timezone(&chrono::Utc);
    assert!(f.library.run_auto_tag_inbox_at(attempted + chrono::Duration::seconds(3599), false).unwrap().processed.is_empty());
    assert_eq!(f.library.run_auto_tag_inbox_at(attempted + chrono::Duration::seconds(3600), false).unwrap().processed.len(), 1);
    source.execute("UPDATE vocabulary SET category='character'", []).unwrap();
    assert_eq!(f.library.run_auto_tag_inbox().unwrap().processed.len(), 1);
}

#[test]
fn auto_tag_inbox_style_and_tags_are_tracked_independently() {
    let (f, _) = fixture();
    let c = Connection::open(f.temp.path().join(FILES[1])).unwrap();
    c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value); CREATE TABLE features(asset_id TEXT PRIMARY KEY,vector BLOB NOT NULL);").unwrap();
    c.execute("INSERT INTO meta VALUES('model','kaloscope2'),('dim','2048'),('mean',?1)", [vec![0u8; 2048 * 4]]).unwrap();
    let mut vector = vec![0u8; 2048 * 2]; vector[0..2].copy_from_slice(&0x3c00u16.to_le_bytes());
    c.execute("INSERT INTO features VALUES('asset-5',?1)", params![vector]).unwrap();
    let result = f.library.run_auto_tag_inbox().unwrap();
    assert_eq!(result.processed.len(), 2);
    let last = result.settings.last.unwrap();
    assert_eq!(last[FILES[1]].error, None);
    assert_eq!(last[FILES[1]].imported["imported"], 1);
    assert!(last[FILES[1]].tagger.is_none());
    assert!(f.library.run_auto_tag_inbox().unwrap().processed.is_empty());
}

#[test]
fn auto_tag_inbox_respects_manual_import_gate_and_restricted_mode() {
    let (f, _) = fixture();
    let gate = f.library.ingestion_lock.lock().unwrap();
    assert!(f.library.run_auto_tag_inbox().unwrap().skipped.is_some());
    let clone = f.library.clone();
    let path = f.temp.path().join(FILES[0]);
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || { send.send(clone.import_auto_tags(&path)).unwrap(); });
    assert!(receive.recv_timeout(Duration::from_millis(100)).is_err());
    drop(gate);
    receive.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
    worker.join().unwrap();
    assert!(f.library.run_auto_tag_inbox_at(chrono::Utc::now(), true).unwrap().processed.is_empty());
    assert!(f.library.auto_tag_inbox().unwrap().last.is_none());
    f.library.set_auto_tag_inbox(Some(f.temp.path().to_string_lossy().into()), false).unwrap();
    assert!(f.library.run_auto_tag_inbox().unwrap().settings.last.unwrap()[FILES[0]].tagger.is_none());
}

#[test]
fn auto_tag_inbox_schedule_waits_two_minutes_then_hourly() {
    let f = Fixture::new();
    let now = std::time::Instant::now();
    let mut schedule = Schedule::default();
    assert!(!schedule.tick(Some(&f.library), false, now));
    assert!(!schedule.tick(Some(&f.library), false, now + Duration::from_secs(119)));
    assert!(!schedule.tick(Some(&f.library), true, now + Duration::from_secs(120)));
    assert!(schedule.tick(Some(&f.library), false, now + Duration::from_secs(121)));
    assert!(!schedule.tick(Some(&f.library), false, now + Duration::from_secs(3720)));
    assert!(schedule.tick(Some(&f.library), false, now + Duration::from_secs(3721)));
    assert!(!schedule.tick(None, false, now + Duration::from_secs(7321)));
}

#[test]
fn inbox_profiles_keep_initial_delay_recovery_gate_and_error_backoff_without_catchup() {
    let f = Fixture::new();
    for profile in [crate::performance::Profile::Laptop, crate::performance::Profile::Main] {
        let seconds = profile.budgets().inbox_success_seconds;
        let now = std::time::Instant::now();
        let mut schedule = Schedule::new(seconds);
        assert!(!schedule.tick(Some(&f.library), false, now));
        assert!(!schedule.tick(Some(&f.library), false, now + Duration::from_secs(119)));
        assert!(!schedule.tick(Some(&f.library), true, now + Duration::from_secs(120)));
        assert!(schedule.tick(Some(&f.library), false, now + Duration::from_secs(121)));
        let (send, receive) = std::sync::mpsc::channel();
        schedule.running(receive);
        assert!(!schedule.tick(Some(&f.library), false, now + Duration::from_secs(122 + seconds)));
        send.send(true).unwrap();
        assert!(schedule.tick(Some(&f.library), false, now + Duration::from_secs(122 + seconds)));
        assert!(!schedule.tick(Some(&f.library), false, now + Duration::from_secs(122 + seconds)));
        let (send, receive) = std::sync::mpsc::channel();
        schedule.running(receive);
        send.send(false).unwrap();
        let failed = now + Duration::from_secs(123 + seconds);
        assert!(!schedule.tick(Some(&f.library), false, failed));
        assert!(!schedule.tick(Some(&f.library), false, failed + Duration::from_secs(3599)));
        assert!(schedule.tick(Some(&f.library), false, failed + Duration::from_secs(3600)));
        assert!(!schedule.tick(Some(&f.library), false, failed + Duration::from_secs(3600)));
    }
}
