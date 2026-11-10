//! N7 retention is maintenance, never a startup migration. Each bounded chunk
//! commits its marker; the cursor advances only after an asset is fully examined.
use crate::library::{Library, LibraryError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

pub(crate) const JOB: &str = "characterEvidenceRetention";
pub(crate) const VACUUM_JOB: &str = "databaseOptimize";
const MARKER: &str = "characterEvidenceRetention:v2";

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct State {
    pub cursor: String,
    pub done: u64,
    pub total: u64,
    pub complete: bool,
}

pub(crate) fn state(db: &Connection) -> Result<State, LibraryError> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM notes_state WHERE key=?1",
            [MARKER],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| LibraryError::InvalidCloudResponse))
        .unwrap_or_else(|| Ok(State::default()))
}

/// Review uses newest predictions per source/target, refresh uses explicit base
/// IDs (including finished requests), regions uses newest per content/target.
/// Decisions copy their snapshots; exact-ID decisions fail stale if absent.
/// Publication additionally protects every open review of the current source.
pub(crate) fn prune(
    tx: &Transaction<'_>,
    asset: &str,
    protect_open_review: bool,
) -> Result<usize, LibraryError> {
    prune_chunk(tx, asset, protect_open_review, usize::MAX).map(|(removed, _)| removed)
}

fn prune_chunk(
    tx: &Transaction<'_>,
    asset: &str,
    protect_open_review: bool,
    limit: usize,
) -> Result<(usize, bool), LibraryError> {
    let ids = tx.prepare_cached(r#"
        SELECT e.id FROM character_autotag_evidence e
        WHERE e.asset_id=?1
          AND EXISTS(SELECT 1 FROM character_autotag_evidence n
                     WHERE n.asset_id=e.asset_id AND n.generation>e.generation)
          AND EXISTS(SELECT 1 FROM character_autotag_evidence n
                     WHERE n.asset_id=e.asset_id AND (n.created_at>e.created_at
                       OR (n.created_at=e.created_at AND n.generation>e.generation)))
          AND NOT EXISTS(SELECT 1 FROM character_autotag_jobs j
                         WHERE j.asset_id=e.asset_id AND (
                           (j.generation=e.generation AND j.source_generation=e.source_generation)
                           OR (?2 AND j.state<>'superseded' AND j.source_generation=e.source_generation)))
          AND NOT EXISTS(SELECT 1 FROM character_reference_refresh_items i
                         WHERE i.base_evidence_id=e.id)
          AND NOT EXISTS(SELECT 1 FROM character_autotag_predictions p
                         WHERE p.evidence_id=e.id AND NOT EXISTS(
                           SELECT 1 FROM character_autotag_evidence n
                           JOIN character_autotag_predictions np ON np.evidence_id=n.id
                             AND np.target_id=p.target_id
                           WHERE n.asset_id=e.asset_id AND n.content_hash=e.content_hash
                             AND n.generation>e.generation))
        LIMIT ?3
    "#)?.query_map(params![asset, protect_open_review, if limit == usize::MAX { -1 } else { (limit + 1) as i64 }], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut removed = 0;
    let remaining = ids.len() > limit;
    for id in ids.into_iter().take(limit) {
        removed += tx.execute(
            "DELETE FROM character_autotag_predictions WHERE evidence_id=?1",
            [&id],
        )?;
        tx.execute("DELETE FROM character_autotag_evidence WHERE id=?1", [&id])?;
    }
    Ok((removed, remaining))
}

pub(crate) fn count_assets(db: &Connection) -> Result<u64, LibraryError> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM (
        SELECT asset_id FROM character_autotag_evidence GROUP BY asset_id HAVING COUNT(*)>1)",
        [],
        |r| r.get::<_, i64>(0),
    )? as u64)
}

fn save(db: &Connection, state: &State) -> Result<(), LibraryError> {
    db.execute(
        "INSERT INTO notes_state(key,value) VALUES(?1,?2)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![
            MARKER,
            serde_json::to_string(state).expect("retention state serializes")
        ],
    )?;
    Ok(())
}

/// The global progress count is read before entering database_lock. Only this
/// small index/marker transaction needs it; initialization never prunes assets.
pub(crate) fn initialize(db: &mut Connection, total: u64) -> Result<State, LibraryError> {
    let tx = db.transaction()?;
    let mut state = state(&tx)?;
    if !state.complete && state.total == 0 {
        // Built once in the background, never during library initialization.
        // SQLite's parent deletion otherwise scans every refresh item per ID.
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS character_reference_refresh_items_base_evidence
            ON character_reference_refresh_items(base_evidence_id);",
        )?;
        state.total = total;
        state.complete = total == 0;
        save(&tx, &state)?;
    }
    tx.commit()?;
    Ok(state)
}

/// One small transaction. Callers release the connection and yield after this.
pub(crate) fn step(db: &mut Connection) -> Result<State, LibraryError> {
    let tx = db.transaction()?;
    let mut state = state(&tx)?;
    if state.complete {
        return Ok(state);
    }
    let asset: Option<String> = tx
        .query_row(
            "SELECT asset_id FROM character_autotag_evidence WHERE asset_id>?1
         GROUP BY asset_id HAVING COUNT(*)>1 ORDER BY asset_id LIMIT 1",
            [&state.cursor],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(asset) = asset {
        // A large asset can have hundreds of predictions across old generations.
        // Bound the work in each lock hold; advance the cursor only when done.
        let (_, remaining) = prune_chunk(&tx, &asset, false, 1)?;
        if !remaining {
            state.cursor = asset;
            state.done += 1;
        }
    } else {
        state.complete = true;
        state.total = state.done;
    }
    save(&tx, &state)?;
    tx.commit()?;
    Ok(state)
}

/// Each chunk is one small transaction through `connection()`: it holds
/// database_lock only for that chunk, and its writes pass the change hooks
/// (character caches, publication lanes) like any other writer. Restores take
/// database_lock too, so no file swap can interleave with a chunk.
pub(crate) fn run(
    library: &Library,
    mut active: impl FnMut() -> bool,
) -> Result<u64, LibraryError> {
    let mut current = state(&library.unlocked_connection()?)?;
    if !active() || crate::workload::is_restricted() {
        return Ok(current.done);
    }
    if !current.complete && current.total == 0 {
        let total = count_assets(&library.unlocked_connection()?)?;
        if crate::workload::is_restricted() {
            return Ok(current.done);
        }
        let mut db = library.connection()?;
        current = initialize(&mut db, total)?;
    }
    let mut chunks = 0_u64;
    while !current.complete && active() && !crate::workload::is_restricted() {
        let previous_done = current.done;
        {
            let mut db = library.connection()?;
            // Automatic checkpoints added substantial disk work to these small
            // commits; checkpoint passively between chunks instead.
            db.pragma_update(None, "wal_autocheckpoint", 0)?;
            current = step(&mut db)?;
        }
        chunks += 1;
        if chunks % 64 == 0 || current.complete {
            checkpoint(&library.unlocked_connection()?)?;
        }
        crate::auto_jobs::progress(
            library,
            JOB,
            current.done,
            current.total.max(current.done),
            Some(current.total.saturating_sub(current.done)),
            None,
        );
        if !current.complete {
            yield_after_chunk(previous_done, current.done);
        }
    }
    Ok(current.done)
}

pub(crate) fn checkpoint(db: &Connection) -> rusqlite::Result<()> {
    // PASSIVE never waits for a reader or writer; it can retry on the next chunk.
    db.execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
}

pub(crate) fn yield_after_chunk(previous_done: u64, done: u64) {
    if done > previous_done {
        std::thread::sleep(std::time::Duration::from_millis(10));
    } else {
        std::thread::yield_now();
    }
}

pub(crate) fn space(db: &Connection) -> rusqlite::Result<(u64, u64)> {
    let page: i64 = db.pragma_query_value(None, "page_size", |r| r.get(0))?;
    let free: i64 = db.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
    let pages: i64 = db.pragma_query_value(None, "page_count", |r| r.get(0))?;
    Ok(((free * page) as u64, (pages * page) as u64))
}

fn vacuum_preconditions(
    manual: bool,
    restricted: bool,
    available: u64,
    size: u64,
) -> Result<(), String> {
    if !manual {
        return Err("DB 최적화는 직접 실행해 주세요.".into());
    }
    if restricted {
        return Err("절약 모드를 끈 뒤 실행해 주세요.".into());
    }
    if available < size {
        return Err("DB 크기 이상의 여유 공간이 필요합니다.".into());
    }
    Ok(())
}

pub(crate) fn vacuum(library: &Library) -> Result<u64, String> {
    // Restore and backup own this same lease. Reject rather than queue behind
    // either; retain it through checkpoint so no file replacement can race.
    let _exclusive = library
        .backup_lock
        .try_lock()
        .map_err(|_| "백업·복원 작업이 끝난 뒤 실행해 주세요.".to_owned())?;
    let db = library.connection().map_err(|e| e.to_string())?;
    // database_lock parks ALL background DB writers until VACUUM finishes.
    let (_, logical_size) = space(&db).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(library.root().join("library.sqlite"))
        .map_err(|e| e.to_string())?
        .len()
        .max(logical_size);
    let available = available_space(library.root()).map_err(|e| e.to_string())?;
    vacuum_preconditions(
        crate::auto_jobs::manual(library, VACUUM_JOB),
        crate::workload::is_restricted(),
        available,
        size,
    )?;
    vacuum_db(&db).map_err(|e| e.to_string())?;
    space(&db).map(|(_, size)| size).map_err(|e| e.to_string())
}

pub(crate) fn vacuum_db(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("VACUUM;")?;
    let busy: i64 = db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
    if busy != 0 {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            Some("DB 최적화 완료, 다른 읽기 작업으로 WAL 정리 대기 중".into()),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn available_space(path: &std::path::Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // The OS reports space available to this user on the actual library volume.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(target_os = "linux")]
fn available_space(path: &std::path::Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(test)]
#[path = "character_evidence_retention_tests.rs"]
mod tests;
