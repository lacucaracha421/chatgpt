//! Measurement entry points for `perf_probe`. Call only on its disposable snapshot.
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::{
    catalog_groups, catalog_preparation, collection_source, db, error::LibraryError, manga, Library,
};

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn members(c: &Connection) -> Result<BTreeMap<String, Vec<rusqlite::types::Value>>, LibraryError> {
    Ok(c.prepare("SELECT work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal FROM online_catalog_group_members WHERE provider='kHentai'")?
        .query_map([], |r| Ok((r.get(0)?, (1..6).map(|i| r.get(i)).collect::<rusqlite::Result<Vec<_>>>()?)))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn catalog_rebuild(library: &Library) -> Result<Value, LibraryError> {
    let _file_guard = library
        .catalog_file_lock
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut c = library.connection()?;
    catalog_preparation::attach_catalog_readonly(&c, library.root())?;
    let tx = c.transaction()?;
    let source: String = tx.query_row("SELECT COALESCE((SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'),'legacy')", [], |r| r.get(0))?;
    let revision = format!("{}:{source}", catalog_groups::ALGORITHM);
    let works: i64 = tx.query_row("SELECT COUNT(*) FROM catalog.Works", [], |r| r.get(0))?;
    let before = members(&tx)?;
    let started = Instant::now();
    catalog_groups::rebuild(&tx, &revision)?;
    let rebuild_ms = ms(started);
    let after = members(&tx)?;
    let changed = before
        .iter()
        .filter(|(id, row)| after.get(*id) != Some(*row))
        .count()
        + after.keys().filter(|id| !before.contains_key(*id)).count();
    tx.commit()?;
    Ok(json!({"works": works, "changedMembers": changed, "rebuildMs": rebuild_ms}))
}

pub fn artist_style_inputs(library: &Library) -> Result<Value, LibraryError> {
    let c = library.connection()?;
    Ok(json!({"assets": super::artist_style::perf_inputs_assets(&c)?}))
}

pub fn similarity_inventory(library: &Library) -> Result<Value, LibraryError> {
    let c = library.connection()?;
    Ok(json!({"rows": super::similarity_scan::perf_load_comparable_rows(&c)?}))
}

pub fn normal_image(library: &Library) -> Result<Option<String>, LibraryError> {
    Ok(library.connection()?.query_row("SELECT id FROM assets WHERE status='normal' AND media_kind='image' ORDER BY id LIMIT 1", [], |r| r.get(0)).optional()?)
}

pub fn unresolved_recovery_links(library: &Library) -> Result<Value, LibraryError> {
    let c = library.connection()?;
    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='manga_catalog_recovery_links')", [], |r| r.get(0))?;
    let count = if exists {
        Some(c.query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM manga_catalog_recovery_links WHERE source_relative_path IS NULL",
            [],
            |r| r.get(0),
        )?)
    } else {
        None
    };
    Ok(json!({"tableExists": exists, "unresolvedLinks": count}))
}

pub fn manga_repair(library: &Library) -> Result<Value, LibraryError> {
    let before = unresolved_recovery_links(library)?;
    let started = Instant::now();
    manga::repair_legacy_recovery_source_paths(library)?;
    Ok(
        json!({"repairRan": true, "repairMs": ms(started), "previewBranchEntered": before["unresolvedLinks"].as_u64().is_some_and(|n| n > 0) && library.root().join("catalogs/kdata.db").exists(), "before": before, "after": unresolved_recovery_links(library)?}),
    )
}

/// Enumerate readable source trees without modifying them or following directory links.
/// Selection is outside the timed list_collection_covers call.
pub fn largest_collection_source(library: &Library) -> Result<Value, String> {
    let c = library.connection().map_err(|e| e.to_string())?;
    let root = collection_source::collection_source_root(&c, library.root())
        .map_err(|e| e.to_string())?
        .ok_or("collection source root is not set")?;
    let mut statement = c
        .prepare("SELECT id,source_path FROM collections WHERE source_path IS NOT NULL ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);
    drop(c);
    let mut largest = None;
    let mut unreadable = 0;
    for (id, relative) in rows {
        let dir = collection_source::resolve_collection_dir(&root, &relative);
        let count = (|| -> std::io::Result<u64> {
            let mut pending = vec![dir.clone()];
            let mut files = 0;
            while let Some(path) = pending.pop() {
                if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    continue;
                }
                for entry in fs::read_dir(path)? {
                    let entry = entry?;
                    let kind = entry.file_type()?;
                    if kind.is_dir() {
                        pending.push(entry.path());
                    } else if kind.is_file() {
                        files += 1;
                    }
                }
            }
            Ok(files)
        })();
        match count {
            Ok(files) if largest.as_ref().is_none_or(|(_, _, n)| files > *n) => {
                largest = Some((id, dir, files))
            }
            Ok(_) => {}
            Err(_) => unreadable += 1,
        }
    }
    let (id, dir, files) = largest.ok_or_else(|| format!("no readable collection source folder (unreadable={unreadable}); external source folders are not copied"))?;
    Ok(
        json!({"collectionId": id, "sourcePath": dir, "sourceFiles": files, "unreadableCollections": unreadable}),
    )
}

pub fn auto_tag_import(library: &Library, path: &Path) -> Result<Value, String> {
    // Include source preparation/cleanup in total, but only library connection work
    // in guard hold. Use the inbox's import/review functions, never its configured path.
    let total = Instant::now();
    let prepared = super::auto_tags::prepare_import(path).map_err(|e| e.to_string())?;
    let prepare_ms = ms(total);
    let guard = library
        .database_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let held = Instant::now();
    let mut c = library.unlocked_connection().map_err(|e| e.to_string())?;
    let phase = Instant::now();
    let summary = super::auto_tags::import_file(&c, &prepared, &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())?;
    let import_ms = ms(phase);
    library.character_changes.suggestion_inputs_changed();
    let phase = Instant::now();
    let preview = super::tagger_review::preview_on(&c).map_err(|e| e.to_string())?;
    let preview_ms = ms(phase);
    let phase = Instant::now();
    let applied = library
        .apply_tagger_review_on(&mut c, &preview.preview_token)
        .map_err(|e| e.to_string())?;
    let apply_ms = ms(phase);
    drop(c);
    drop(guard);
    let held_ms = ms(held);
    drop(prepared);
    Ok(
        json!({"summary": summary, "veto": applied.veto.count, "recommend": applied.recommend.count, "guardHeldMs": held_ms, "totalMs": ms(total), "prepareMs": prepare_ms, "importMs": import_ms, "previewMs": preview_ms, "applyMs": apply_ms}),
    )
}

pub fn commit_latency(library: &Library, normal: bool) -> Result<Value, LibraryError> {
    let mut c = db::open_database(&library.root().join("library.sqlite"))?;
    if normal {
        c.pragma_update(None, "synchronous", "NORMAL")?;
    }
    let synchronous: i64 = c.pragma_query_value(None, "synchronous", |r| r.get(0))?;
    let journal: String = c.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS perf_probe_commit_scratch(value INTEGER NOT NULL); DELETE FROM perf_probe_commit_scratch;")?;
    let mut samples = Vec::with_capacity(200);
    for i in 0..200 {
        let started = Instant::now();
        let tx = c.transaction()?;
        tx.execute(
            "INSERT INTO perf_probe_commit_scratch(value) VALUES(?1)",
            [i],
        )?;
        tx.commit()?;
        samples.push(ms(started));
    }
    samples.sort_by(f64::total_cmp);
    c.execute_batch("DROP TABLE perf_probe_commit_scratch")?;
    Ok(
        json!({"commits": 200, "synchronous": synchronous, "journalMode": journal, "medianMs": samples[99], "p95Ms": samples[189]}),
    )
}

pub fn hold_writer(library: &Library, ready: impl FnOnce()) -> Result<(), LibraryError> {
    let mut c = library.connection()?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS perf_probe_writer_scratch(value INTEGER); INSERT INTO perf_probe_writer_scratch VALUES(1)")?;
    ready();
    std::thread::sleep(Duration::from_millis(300));
    tx.rollback()?;
    Ok(())
}
