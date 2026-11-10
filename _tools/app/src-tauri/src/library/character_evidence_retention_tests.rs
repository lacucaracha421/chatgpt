use super::*;

#[test]
fn retention_keeps_current_refresh_and_regions_and_resumes_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("library.sqlite");
    let library = Library::open(temp.path()).unwrap();
    let mut db = library.connection().unwrap();
    db.execute_batch(r#"
        INSERT INTO classification_entries(id,kind,name,parent_id,created_at)
        VALUES('root','root','Root',NULL,'now'),('series','tag','Series','root','now');
        INSERT INTO character_series(classification_id) VALUES('series');
        INSERT INTO character_targets(id,series_classification_id,display_name,enabled,created_at,updated_at)
        VALUES('a','series','A',1,'now','now'),('b','series','B',1,'now','now');
        INSERT INTO character_reference_refreshes(target_id,series_classification_id,target_revision,
            requested_reference_set_hash,requested_reference_hashes_json,added_reference_hashes_json,requested_at,updated_at)
        VALUES('a','series',1,'set','[]','[]',1,1);
    "#).unwrap();
    for asset in ["query", "query2"] {
        db.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES(?1,?1,'image','q.png',?1,?1,1,10,10,'now')", [asset]).unwrap();
        db.execute("INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,cause,updated_at) VALUES(?1,8,7,'hash','q.png','[\"series\"]','pending','unresolved','reconsideration','now')", [asset]).unwrap();
        for (generation, source, hash, targets) in [
            (1, 1, "hash", vec!["a"]),
            (2, 1, "old-hash", vec!["a", "b"]),
            (3, 1, "old-hash", vec!["a"]),
            (4, 1, "hash", vec!["a"]),
            (5, 1, "hash", vec!["b"]),
            (6, 7, "hash", vec!["a"]),
            (7, 7, "hash", vec!["a"]),
            (8, 7, "hash", vec!["a"]),
            (9, 9, "hash", vec!["a"]),
        ] {
            let id = format!("{asset}:{generation}");
            db.execute("INSERT INTO character_autotag_evidence VALUES(?1,?2,?3,?4,?5,'ctx','runtime','{}','[]','now')", params![id,asset,generation,source,hash]).unwrap();
            for target in targets {
                db.execute(
                    "INSERT INTO character_autotag_predictions VALUES(?1,?2,'series','fp','{}')",
                    params![id, target],
                )
                .unwrap();
            }
        }
    }
    db.execute("INSERT INTO character_reference_refresh_items(target_id,request_revision,asset_id,base_evidence_id,generation,state,updated_at) VALUES('a',1,'query','query:4',5,'completed',1)", []).unwrap();
    let total = count_assets(&db).unwrap();
    initialize(&mut db, total).unwrap();
    let first = step(&mut db).unwrap();
    assert_eq!(
        (
            first.cursor.as_str(),
            first.done,
            first.total,
            first.complete
        ),
        ("", 0, 2, false)
    );
    // Interrupt halfway through the first asset, before its cursor can advance.
    drop(db);
    drop(library);
    let mut db = crate::library::db::open_database(&path).unwrap();
    while step(&mut db).unwrap().cursor != "query" {}
    let ids = db.prepare("SELECT generation FROM character_autotag_evidence WHERE asset_id='query' ORDER BY generation").unwrap().query_map([], |r| r.get::<_,i64>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(ids, [2, 3, 4, 5, 8, 9]);
    while step(&mut db).unwrap().cursor != "query2" {}
    assert!(step(&mut db).unwrap().complete);
    assert_eq!(step(&mut db).unwrap().done, 2);
    assert!(!db
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}

#[test]
fn vacuum_refuses_automatic_restricted_low_space_and_exclusive_work() {
    assert!(vacuum_preconditions(false, false, 100, 50).is_err());
    assert!(vacuum_preconditions(true, true, 100, 50).is_err());
    assert!(vacuum_preconditions(true, false, 49, 50).is_err());
    assert!(vacuum_preconditions(true, false, 50, 50).is_ok());
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let lease = library.backup_lock.lock().unwrap();
    assert!(vacuum(&library).unwrap_err().contains("백업"));
    drop(lease);
    assert!(vacuum(&library).unwrap_err().contains("직접"));
}

/// SQL is taken from the real readers so this measures their complete query
/// projections, including evidence IDs and JSON, without needing original media.
fn projections(db: &Connection, samples: &[(String, String)]) -> Vec<(String, u64, Vec<u8>)> {
    use sha2::{Digest, Sha256};
    fn digest(db: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> (u64, Vec<u8>) {
        let mut statement = db.prepare(sql).unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query(args).unwrap();
        let mut hash = Sha256::new();
        let mut count = 0;
        while let Some(row) = rows.next().unwrap() {
            for col in 0..columns {
                use rusqlite::types::ValueRef;
                let value = row.get_ref(col).unwrap();
                hash.update([value.data_type() as u8]);
                match value {
                    ValueRef::Null => {}
                    ValueRef::Integer(value) => {
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) | ValueRef::Blob(value) => {
                        hash.update((value.len() as u64).to_le_bytes());
                        hash.update(value);
                    }
                }
            }
            count += 1;
        }
        (count, hash.finalize().to_vec())
    }
    let review = include_str!("character_review.rs")
        .split_once("const REVIEW_BATCH_DURABLE_SQL: &str = \"")
        .unwrap()
        .1
        .split_once("\";")
        .unwrap()
        .0;
    let tagger = include_str!("tagger_review.rs")
        .split_once("const TAGGER_REVIEW_ITEMS_SQL: &str = r#\"")
        .unwrap()
        .1
        .split_once("\"#;")
        .unwrap()
        .0
        .replace(
            "{CONTENT_RATING_SQL}",
            crate::library::auto_tags::CONTENT_RATING_SQL,
        );
    let candidate_source = include_str!("character_reference_candidates.rs").replace("\r\n", "\n");
    let candidates = candidate_source
        .split_once("\"WITH RECURSIVE scope(id) AS (")
        .unwrap()
        .1
        .split_once("\",\n")
        .unwrap()
        .0;
    let candidates = format!("WITH RECURSIVE scope(id) AS ({candidates}").replace(
        "{disabled}",
        &crate::library::characters::learning_disabled_sql("d"),
    );
    let mut results = Vec::new();
    for (series, assets) in samples {
        let (count, hash) = digest(db, review, &[&series, &assets, &Option::<String>::None]);
        results.push((format!("review:{series}"), count, hash));
        eprintln!("N7 review projection {series}: {count} rows");
        let targets = db.prepare("SELECT id FROM character_targets WHERE series_classification_id=?1 AND role='character' ORDER BY id LIMIT 3").unwrap()
            .query_map([&series], |r| r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        for target in targets {
            let (count, hash) = digest(db, &candidates, &[&target, &series]);
            results.push((format!("candidates:{series}:{target}"), count, hash));
        }
    }
    let (count, hash) = digest(db, &tagger, &[]);
    results.push(("tagger:all".into(), count, hash));
    results
}

#[test]
#[ignore]
fn retention_measure_disposable_copy() {
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    let root = PathBuf::from(
        std::env::var_os("LAKOMICS_N7_COPY").expect("explicit disposable copy required"),
    )
    .canonicalize()
    .unwrap();
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target-worker/perf-input")
        .canonicalize()
        .unwrap();
    assert_eq!(root.parent(), Some(allowed.as_path()));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("n7-copy-"));
    let path = root.join("library.sqlite");
    let mut db = crate::library::db::open_database(&path).unwrap();
    if std::env::var_os("LAKOMICS_N7_PROFILE").is_some() {
        use std::sync::{Arc, Mutex};
        db.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        let total = count_assets(&db).unwrap();
        initialize(&mut db, total).unwrap();
        let phases = Arc::new(Mutex::new([None::<Instant>; 3]));
        let writes = phases.clone();
        db.update_hook(Some(
            move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                if matches!(
                    table,
                    "character_autotag_predictions" | "character_autotag_evidence"
                ) {
                    let now = Instant::now();
                    let mut phases = writes.lock().unwrap();
                    phases[0].get_or_insert(now);
                    phases[1] = Some(now);
                }
            },
        ))
        .unwrap();
        let commits = phases.clone();
        db.commit_hook(Some(move || {
            commits.lock().unwrap()[2] = Some(Instant::now());
            false
        }))
        .unwrap();
        let mut longest = Duration::ZERO;
        let mut elapsed_total = Duration::ZERO;
        let mut over_50_ms = 0;
        let mut steps = 0;
        let mut previous_done = 0;
        for _ in 0..10000 {
            *phases.lock().unwrap() = [None; 3];
            let start = Instant::now();
            let state = step(&mut db).unwrap();
            let end = Instant::now();
            let elapsed = end - start;
            elapsed_total += elapsed;
            steps += 1;
            over_50_ms += usize::from(elapsed.as_millis() >= 50);
            if elapsed > longest {
                longest = elapsed;
                if elapsed.as_millis() >= 40 {
                    let phases = *phases.lock().unwrap();
                    let first = phases[0].unwrap_or(start);
                    let last = phases[1].unwrap_or(first);
                    let commit = phases[2].unwrap_or(end);
                    eprintln!("N7 PHASE max={elapsed:?} before_delete={:?} delete={:?} before_commit={:?} commit_io={:?}", first-start,last-first,commit-last,end-commit);
                }
            }
            checkpoint(&db).unwrap();
            if state.complete {
                break;
            }
            yield_after_chunk(previous_done, state.done);
            previous_done = state.done;
        }
        eprintln!("N7 PHASE steps={steps} time={elapsed_total:?} over_50_ms={over_50_ms} longest={longest:?}");
        return;
    }
    let counts = |db: &Connection| {
        db.query_row("SELECT (SELECT COUNT(*) FROM character_autotag_evidence),(SELECT COUNT(*) FROM character_autotag_predictions)", [], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).unwrap()
    };
    let before = counts(&db);
    let bytes_before = std::fs::metadata(&path).unwrap().len();
    // Freeze the sample before pruning changes the historical row distribution.
    let series = db.prepare("SELECT p.series_id FROM character_autotag_predictions p GROUP BY p.series_id ORDER BY COUNT(*) DESC,p.series_id LIMIT 3").unwrap()
        .query_map([], |r| r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    let samples = series
        .into_iter()
        .map(|series| {
            // A real review batch is at most 80 assets. Prefer assets with history,
            // and hold the exact sample fixed across cleanup.
            let assets: String = db
                .query_row(
                    "SELECT json_group_array(asset_id) FROM (
            SELECT e.asset_id FROM character_autotag_evidence e
            JOIN character_autotag_predictions p ON p.evidence_id=e.id
            WHERE p.series_id=?1 GROUP BY e.asset_id ORDER BY COUNT(*) DESC,e.asset_id LIMIT 80)",
                    [&series],
                    |r| r.get(0),
                )
                .unwrap();
            (series, assets)
        })
        .collect::<Vec<_>>();
    let original = projections(&db, &samples);
    eprintln!(
        "N7 original projections: {:?}",
        original
            .iter()
            .map(|(name, count, _)| (name, count))
            .collect::<Vec<_>>()
    );
    let start = Instant::now();
    db.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    let total = count_assets(&db).unwrap();
    let initialize_start = Instant::now();
    initialize(&mut db, total).unwrap();
    eprintln!(
        "N7 initialization transaction={:?}",
        initialize_start.elapsed()
    );
    let mut previous_done = 0;
    let mut longest = Duration::ZERO;
    loop {
        let asset_start = Instant::now();
        let state = step(&mut db).unwrap();
        longest = longest.max(asset_start.elapsed());
        checkpoint(&db).unwrap();
        if state.done % 1000 == 0 || state.complete {
            eprintln!(
                "N7 pass {}/{} complete={} elapsed={:?} longest={longest:?}",
                state.done,
                state.total,
                state.complete,
                start.elapsed()
            );
        }
        if state.complete {
            break;
        }
        // Match the production owner, including yields within a large asset.
        yield_after_chunk(previous_done, state.done);
        previous_done = state.done;
    }
    let pass = start.elapsed();
    let after = counts(&db);
    let cleaned = projections(&db, &samples);
    assert_eq!(
        original, cleaned,
        "review, tagger review and candidates must be unchanged"
    );
    let free = space(&db).unwrap().0;
    eprintln!("N7 before={before:?} after={after:?} pass={pass:?} longest_asset_transaction={longest:?} reclaimable={free} bytes_before={bytes_before}");
    vacuum_preconditions(
        true,
        false,
        available_space(&root).unwrap(),
        space(&db).unwrap().1,
    )
    .unwrap();
    let vacuum_start = Instant::now();
    vacuum_db(&db).unwrap();
    eprintln!(
        "N7 vacuum={:?} bytes_after={} projections_equal={}",
        vacuum_start.elapsed(),
        std::fs::metadata(&path).unwrap().len(),
        original == cleaned
    );
    assert!(!db
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert_eq!(
        db.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
