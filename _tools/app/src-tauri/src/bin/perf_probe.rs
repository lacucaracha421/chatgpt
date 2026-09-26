//! Read-only performance probe for the desktop Library backend (PERF-ALL-001).
//!
//! Safety model: the live library is never opened by SQLite. `library.sqlite` (and,
//! with `--with-catalog`, `catalogs/kdata.db`) are copied with plain read-only file
//! reads into a snapshot directory outside the library, and every measured call runs
//! against that snapshot. A read-only SQLite connection on a WAL database may create
//! `-wal`/`-shm` files next to it, so the probe refuses to use SQLite on the source and
//! verifies afterwards that the library root and the copied files are unchanged.
//!
//! SQL accounting: an SQLite auto-extension is registered before any connection opens,
//! so every connection the Library opens (it opens one per call) is counted, and while
//! counting is on each connection gets a `sqlite3_trace_v2` hook for statement, row and
//! VM-step counts. Timing iterations run with the trace hook off.
use std::{
    collections::HashMap,
    env,
    ffi::{c_char, c_int, c_uint, c_void, CStr},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

use app_lib::library::{
    models::{AssetCursor, AssetPage, AssetQuery, AssetSort, MediaKindFilter},
    Library,
};
use rusqlite::ffi;
use serde_json::{json, Value};

const DEFAULT_ITERATIONS: usize = 15;
/// The desktop grid's page size (`_tools/app/src/library/constants.ts`).
const PAGE_SIZE: u32 = 100;

// ---------------------------------------------------------------------------------
// SQL accounting
// ---------------------------------------------------------------------------------

static TRACE_ON: AtomicBool = AtomicBool::new(false);
static DETAIL_ON: AtomicBool = AtomicBool::new(false);
static CONNECTIONS: AtomicU64 = AtomicU64::new(0);
static STATEMENTS: AtomicU64 = AtomicU64::new(0);
static TRIGGER_STATEMENTS: AtomicU64 = AtomicU64::new(0);
static ROWS: AtomicU64 = AtomicU64::new(0);
static VM_STEPS: AtomicU64 = AtomicU64::new(0);
static FULLSCAN_STEPS: AtomicU64 = AtomicU64::new(0);
static SORTS: AtomicU64 = AtomicU64::new(0);
static AUTOINDEX: AtomicU64 = AtomicU64::new(0);
static SQL_NANOS: AtomicU64 = AtomicU64::new(0);
/// Page-cache misses (pages read from the OS) and hits, summed at connection close.
static CACHE_MISSES: AtomicU64 = AtomicU64::new(0);
static CACHE_HITS: AtomicU64 = AtomicU64::new(0);
/// Statements that may write (`sqlite3_stmt_readonly` = 0) and rows they changed.
static WRITE_STATEMENTS: AtomicU64 = AtomicU64::new(0);
static ROWS_CHANGED: AtomicU64 = AtomicU64::new(0);

#[derive(Default, Clone)]
struct StatementDetail {
    count: u64,
    nanos: u64,
    vm_steps: u64,
    fullscan_steps: u64,
}

fn details() -> &'static Mutex<HashMap<String, StatementDetail>> {
    static DETAILS: OnceLock<Mutex<HashMap<String, StatementDetail>>> = OnceLock::new();
    DETAILS.get_or_init(Mutex::default)
}

unsafe extern "C" fn trace_callback(
    kind: c_uint,
    _context: *mut c_void,
    p: *mut c_void,
    x: *mut c_void,
) -> c_int {
    match kind {
        ffi::SQLITE_TRACE_STMT => {
            if !x.is_null() {
                let text = CStr::from_ptr(x as *const c_char).to_bytes();
                if text.starts_with(b"--") {
                    TRIGGER_STATEMENTS.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        ffi::SQLITE_TRACE_PROFILE => {
            let statement = p as *mut ffi::sqlite3_stmt;
            let nanos = if x.is_null() {
                0
            } else {
                (*(x as *const i64)).max(0) as u64
            };
            let vm = ffi::sqlite3_stmt_status(statement, ffi::SQLITE_STMTSTATUS_VM_STEP, 1) as u64;
            let fullscan =
                ffi::sqlite3_stmt_status(statement, ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP, 1) as u64;
            let sorts = ffi::sqlite3_stmt_status(statement, ffi::SQLITE_STMTSTATUS_SORT, 1) as u64;
            let autoindex =
                ffi::sqlite3_stmt_status(statement, ffi::SQLITE_STMTSTATUS_AUTOINDEX, 1) as u64;
            STATEMENTS.fetch_add(1, Ordering::Relaxed);
            if ffi::sqlite3_stmt_readonly(statement) == 0 {
                WRITE_STATEMENTS.fetch_add(1, Ordering::Relaxed);
            }
            SQL_NANOS.fetch_add(nanos, Ordering::Relaxed);
            VM_STEPS.fetch_add(vm, Ordering::Relaxed);
            FULLSCAN_STEPS.fetch_add(fullscan, Ordering::Relaxed);
            SORTS.fetch_add(sorts, Ordering::Relaxed);
            AUTOINDEX.fetch_add(autoindex, Ordering::Relaxed);
            if DETAIL_ON.load(Ordering::Relaxed) {
                let sql = ffi::sqlite3_sql(statement);
                if !sql.is_null() {
                    let text = CStr::from_ptr(sql).to_string_lossy();
                    let key: String = text
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(150)
                        .collect();
                    let mut map = details()
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let entry = map.entry(key).or_default();
                    entry.count += 1;
                    entry.nanos += nanos;
                    entry.vm_steps += vm;
                    entry.fullscan_steps += fullscan;
                }
            }
        }
        ffi::SQLITE_TRACE_ROW => {
            ROWS.fetch_add(1, Ordering::Relaxed);
        }
        ffi::SQLITE_TRACE_CLOSE => {
            let db = p as *mut ffi::sqlite3;
            ROWS_CHANGED.fetch_add(
                ffi::sqlite3_total_changes(db).max(0) as u64,
                Ordering::Relaxed,
            );
            let (mut current, mut high) = (0, 0);
            if ffi::sqlite3_db_status(
                db,
                ffi::SQLITE_DBSTATUS_CACHE_MISS,
                &mut current,
                &mut high,
                0,
            ) == ffi::SQLITE_OK
            {
                CACHE_MISSES.fetch_add(current.max(0) as u64, Ordering::Relaxed);
            }
            if ffi::sqlite3_db_status(
                db,
                ffi::SQLITE_DBSTATUS_CACHE_HIT,
                &mut current,
                &mut high,
                0,
            ) == ffi::SQLITE_OK
            {
                CACHE_HITS.fetch_add(current.max(0) as u64, Ordering::Relaxed);
            }
        }
        _ => {}
    }
    0
}

unsafe extern "C" fn on_connection_open(
    db: *mut ffi::sqlite3,
    _error: *mut *mut c_char,
    _api: *const ffi::sqlite3_api_routines,
) -> c_int {
    CONNECTIONS.fetch_add(1, Ordering::Relaxed);
    if TRACE_ON.load(Ordering::Relaxed) {
        ffi::sqlite3_trace_v2(
            db,
            ffi::SQLITE_TRACE_STMT
                | ffi::SQLITE_TRACE_PROFILE
                | ffi::SQLITE_TRACE_ROW
                | ffi::SQLITE_TRACE_CLOSE,
            Some(trace_callback),
            std::ptr::null_mut(),
        );
    }
    ffi::SQLITE_OK
}

fn install_sql_accounting() {
    // SAFETY: registers a process-wide entry point before any connection is opened;
    // the callback only touches atomics and a mutex-guarded map.
    let rc = unsafe { ffi::sqlite3_auto_extension(Some(on_connection_open)) };
    assert_eq!(rc, ffi::SQLITE_OK, "sqlite3_auto_extension failed");
}

#[derive(Default, Clone, Copy)]
struct Counters {
    connections: u64,
    statements: u64,
    triggers: u64,
    rows: u64,
    vm_steps: u64,
    fullscan_steps: u64,
    sorts: u64,
    autoindex: u64,
    sql_nanos: u64,
    cache_misses: u64,
    cache_hits: u64,
    write_statements: u64,
    rows_changed: u64,
}

fn read_counters() -> Counters {
    Counters {
        connections: CONNECTIONS.load(Ordering::Relaxed),
        statements: STATEMENTS.load(Ordering::Relaxed),
        triggers: TRIGGER_STATEMENTS.load(Ordering::Relaxed),
        rows: ROWS.load(Ordering::Relaxed),
        vm_steps: VM_STEPS.load(Ordering::Relaxed),
        fullscan_steps: FULLSCAN_STEPS.load(Ordering::Relaxed),
        sorts: SORTS.load(Ordering::Relaxed),
        autoindex: AUTOINDEX.load(Ordering::Relaxed),
        sql_nanos: SQL_NANOS.load(Ordering::Relaxed),
        cache_misses: CACHE_MISSES.load(Ordering::Relaxed),
        cache_hits: CACHE_HITS.load(Ordering::Relaxed),
        write_statements: WRITE_STATEMENTS.load(Ordering::Relaxed),
        rows_changed: ROWS_CHANGED.load(Ordering::Relaxed),
    }
}

fn delta(after: Counters, before: Counters) -> Counters {
    Counters {
        connections: after.connections - before.connections,
        statements: after.statements - before.statements,
        triggers: after.triggers - before.triggers,
        rows: after.rows - before.rows,
        vm_steps: after.vm_steps - before.vm_steps,
        fullscan_steps: after.fullscan_steps - before.fullscan_steps,
        sorts: after.sorts - before.sorts,
        autoindex: after.autoindex - before.autoindex,
        sql_nanos: after.sql_nanos - before.sql_nanos,
        cache_misses: after.cache_misses - before.cache_misses,
        cache_hits: after.cache_hits - before.cache_hits,
        write_statements: after.write_statements - before.write_statements,
        rows_changed: after.rows_changed - before.rows_changed,
    }
}

// ---------------------------------------------------------------------------------
// Options and snapshot
// ---------------------------------------------------------------------------------

struct Options {
    library: PathBuf,
    snapshot_parent: PathBuf,
    iterations: usize,
    with_catalog: bool,
    video_media: bool,
    idle_ticks: bool,
    disk_stats: bool,
    keep_snapshot: bool,
    only: Option<String>,
    skip: Option<String>,
    detail_threshold_ms: f64,
}

fn parse_options() -> Result<Options, Box<dyn std::error::Error>> {
    let mut library = None;
    let mut snapshot_parent = env::temp_dir();
    let mut iterations = DEFAULT_ITERATIONS;
    let mut with_catalog = false;
    let mut video_media = true;
    let mut idle_ticks = false;
    let mut disk_stats = false;
    let mut keep_snapshot = false;
    let mut only = None;
    let mut skip = None;
    let mut detail_threshold_ms = 20.0;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--library" => library = args.next().map(PathBuf::from),
            "--snapshot-dir" => {
                snapshot_parent = args
                    .next()
                    .map(PathBuf::from)
                    .ok_or("--snapshot-dir <dir>")?
            }
            "--iterations" => iterations = args.next().ok_or("--iterations <n>")?.parse()?,
            "--with-catalog" => with_catalog = true,
            "--no-video-media" => video_media = false,
            "--idle-ticks" => idle_ticks = true,
            "--disk-stats" => disk_stats = true,
            "--keep-snapshot" => keep_snapshot = true,
            "--only" => only = args.next(),
            "--skip" => skip = args.next(),
            "--detail-ms" => {
                detail_threshold_ms = args.next().ok_or("--detail-ms <ms>")?.parse()?
            }
            _ => return Err(usage().into()),
        }
    }
    let library = library.ok_or_else(usage)?;
    if iterations < 3 {
        return Err("--iterations must be at least 3".into());
    }
    Ok(Options {
        library,
        snapshot_parent,
        iterations,
        with_catalog,
        video_media,
        idle_ticks,
        disk_stats,
        keep_snapshot,
        only,
        skip,
        detail_threshold_ms,
    })
}

fn usage() -> String {
    "usage: cargo run --release --bin perf_probe -- --library <path> [--snapshot-dir <dir>] \
     [--iterations <n>] [--with-catalog] [--no-video-media] [--idle-ticks] [--disk-stats] [--keep-snapshot] [--only <substr>] [--skip <substr>] \
     [--detail-ms <ms>]"
        .to_owned()
}

/// (relative path, length, modified) of the library root's direct entries and the
/// files the probe copies. A change after the run means something wrote there.
type Fingerprint = Vec<(String, u64, Option<SystemTime>)>;

fn fingerprint(root: &Path) -> Result<Fingerprint, Box<dyn std::error::Error>> {
    let mut entries = Vec::new();
    let mut push = |relative: String, path: &Path| -> Result<(), Box<dyn std::error::Error>> {
        let metadata = fs::symlink_metadata(path)?;
        entries.push((relative, metadata.len(), metadata.modified().ok()));
        Ok(())
    };
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        push(
            entry.file_name().to_string_lossy().into_owned(),
            &entry.path(),
        )?;
    }
    let catalogs = root.join("catalogs");
    if catalogs.is_dir() {
        for entry in fs::read_dir(&catalogs)? {
            let entry = entry?;
            push(
                format!("catalogs/{}", entry.file_name().to_string_lossy()),
                &entry.path(),
            )?;
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

/// Plain read-only copy (never SQLite) of one file, with its non-empty WAL.
fn copy_database(source: &Path, destination: &Path) -> Result<u64, Box<dyn std::error::Error>> {
    let wal = PathBuf::from(format!("{}-wal", source.display()));
    if wal.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Err(format!(
            "{} has a non-empty WAL; the app may be running. Stop it and retry.",
            source.display()
        )
        .into());
    }
    let bytes = fs::copy(source, destination)?;
    Ok(bytes)
}

fn snapshot(options: &Options) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let library = fs::canonicalize(&options.library)?;
    fs::create_dir_all(&options.snapshot_parent)?;
    let parent = fs::canonicalize(&options.snapshot_parent)?;
    if parent.starts_with(&library) {
        return Err("the snapshot directory must be outside the library".into());
    }
    let snapshot_root = parent.join(format!("lakomics-perf-probe-{}", std::process::id()));
    if snapshot_root.exists() {
        fs::remove_dir_all(&snapshot_root)?;
    }
    fs::create_dir_all(&snapshot_root)?;
    let started = Instant::now();
    let bytes = copy_database(
        &library.join("library.sqlite"),
        &snapshot_root.join("library.sqlite"),
    )?;
    println!(
        "snapshot_library_copy: bytes={} ms={:.1}",
        bytes,
        started.elapsed().as_secs_f64() * 1000.0
    );
    // Startup checks every ready video's derivatives; without them it would requeue all.
    if options.video_media && library.join("video-media").is_dir() {
        let started = Instant::now();
        let (files, bytes) = copy_tree(
            &library.join("video-media"),
            &snapshot_root.join("video-media"),
        )?;
        println!(
            "snapshot_video_media_copy: files={files} bytes={bytes} ms={:.1}",
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    if options.with_catalog && library.join("catalogs/kdata.db").is_file() {
        fs::create_dir_all(snapshot_root.join("catalogs"))?;
        let started = Instant::now();
        let bytes = copy_database(
            &library.join("catalogs/kdata.db"),
            &snapshot_root.join("catalogs/kdata.db"),
        )?;
        for name in ["suggestions.json", "tag-ko.json"] {
            let source = library.join("catalogs").join(name);
            if source.is_file() {
                fs::copy(&source, snapshot_root.join("catalogs").join(name))?;
            }
        }
        println!(
            "snapshot_catalog_copy: bytes={} ms={:.1}",
            bytes,
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    Ok(snapshot_root)
}

/// Plain recursive copy (read-only on the source; symlinks are not followed).
fn copy_tree(source: &Path, destination: &Path) -> Result<(u64, u64), Box<dyn std::error::Error>> {
    fs::create_dir_all(destination)?;
    let (mut files, mut bytes) = (0, 0);
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            let (f, b) = copy_tree(&entry.path(), &target)?;
            files += f;
            bytes += b;
        } else if kind.is_file() {
            bytes += fs::copy(entry.path(), &target)?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

// ---------------------------------------------------------------------------------
// Process CPU (Linux) for background settle
// ---------------------------------------------------------------------------------

fn process_cpu_ms() -> Option<f64> {
    let stat = fs::read_to_string("/proc/self/stat").ok()?;
    let after_name = &stat[stat.rfind(')')? + 2..];
    let fields: Vec<&str> = after_name.split_whitespace().collect();
    // utime and stime are fields 14 and 15 overall, 12 and 13 after the name.
    let ticks: f64 = fields.get(11)?.parse::<f64>().ok()? + fields.get(12)?.parse::<f64>().ok()?;
    Some(ticks * 10.0) // USER_HZ is 100 on Linux.
}

fn thread_count() -> Option<u64> {
    fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("Threads:"))
        .and_then(|value| value.trim().parse().ok())
}

/// Wait until the process stops burning CPU (background threads spawned by
/// `Library::open`), up to `limit`. Returns (elapsed ms, CPU ms consumed).
fn wait_for_background_settle(limit: Duration) -> (f64, f64) {
    let started = Instant::now();
    let Some(cpu_start) = process_cpu_ms() else {
        std::thread::sleep(Duration::from_secs(3));
        return (started.elapsed().as_secs_f64() * 1000.0, f64::NAN);
    };
    let mut last = cpu_start;
    let mut quiet = 0;
    while started.elapsed() < limit {
        std::thread::sleep(Duration::from_millis(250));
        let now = process_cpu_ms().unwrap_or(last);
        if now - last <= 10.0 {
            quiet += 1;
            if quiet >= 4 {
                break;
            }
        } else {
            quiet = 0;
        }
        last = now;
    }
    (
        started.elapsed().as_secs_f64() * 1000.0,
        process_cpu_ms().unwrap_or(last) - cpu_start,
    )
}

// ---------------------------------------------------------------------------------
// Bench harness
// ---------------------------------------------------------------------------------

struct Row {
    group: &'static str,
    label: String,
    outcome: String,
    first_ms: f64,
    median_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    counters: Counters,
    counters_stable: bool,
    json_bytes: Option<usize>,
}

struct Bench<'a> {
    options: &'a Options,
    rows: Vec<Row>,
    detail_sections: Vec<String>,
    /// Caps timed iterations for paths whose single sample can take very long.
    max_iterations: Option<usize>,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

impl<'a> Bench<'a> {
    fn selected(&self, label: &str) -> bool {
        self.options
            .only
            .as_deref()
            .is_none_or(|filter| label.contains(filter))
            && self
                .options
                .skip
                .as_deref()
                .is_none_or(|filter| !label.contains(filter))
    }

    /// First call (cold for this path), `iterations` timed calls with tracing off, then
    /// two traced calls whose counters must agree to be marked stable.
    fn run(
        &mut self,
        group: &'static str,
        label: impl Into<String>,
        mut call: impl FnMut() -> Result<Value, String>,
    ) -> Option<Value> {
        let label = label.into();
        if !self.selected(&label) {
            return None;
        }
        TRACE_ON.store(false, Ordering::Relaxed);
        let started = Instant::now();
        let first = call();
        let first_ms = started.elapsed().as_secs_f64() * 1000.0;
        let value = match first {
            Ok(value) => value,
            Err(error) => {
                println!("{group}/{label}: error: {error}");
                self.rows.push(Row {
                    group,
                    label,
                    outcome: format!("error: {error}"),
                    first_ms,
                    median_ms: f64::NAN,
                    p95_ms: f64::NAN,
                    min_ms: f64::NAN,
                    counters: Counters::default(),
                    counters_stable: false,
                    json_bytes: None,
                });
                return None;
            }
        };
        let iterations = self.max_iterations.map_or(self.options.iterations, |cap| {
            cap.min(self.options.iterations)
        });
        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let started = Instant::now();
            let _ = call();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);

        TRACE_ON.store(true, Ordering::Relaxed);
        let before = read_counters();
        let _ = call();
        let first_traced = delta(read_counters(), before);
        let slow = percentile(&samples, 50.0) >= self.options.detail_threshold_ms;
        if slow {
            details()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
            DETAIL_ON.store(true, Ordering::Relaxed);
        }
        let before = read_counters();
        let _ = call();
        let second_traced = delta(read_counters(), before);
        DETAIL_ON.store(false, Ordering::Relaxed);
        TRACE_ON.store(false, Ordering::Relaxed);
        if slow {
            self.detail_sections.push(format_details(group, &label));
        }
        let stable = first_traced.statements == second_traced.statements
            && first_traced.vm_steps == second_traced.vm_steps
            && first_traced.connections == second_traced.connections
            && first_traced.cache_misses == second_traced.cache_misses;

        let outcome = describe(&value);
        let json_bytes = serde_json::to_vec(&value).ok().map(|bytes| bytes.len());
        let row = Row {
            group,
            label,
            outcome,
            first_ms,
            median_ms: percentile(&samples, 50.0),
            p95_ms: percentile(&samples, 95.0),
            min_ms: samples[0],
            counters: second_traced,
            counters_stable: stable,
            json_bytes,
        };
        println!(
            "{}/{}: {} first={:.2} median={:.2} p95={:.2} conns={} stmts={} rows={} vm={} fullscan={} page_misses={} stable={}",
            row.group,
            row.label,
            row.outcome,
            row.first_ms,
            row.median_ms,
            row.p95_ms,
            row.counters.connections,
            row.counters.statements,
            row.counters.rows,
            row.counters.vm_steps,
            row.counters.fullscan_steps,
            row.counters.cache_misses,
            row.counters_stable
        );
        self.rows.push(row);
        Some(value)
    }

    fn print_table(&self) {
        println!();
        println!("## Measured paths");
        println!();
        println!(
            "| group | path | result | first ms | median ms | p95 ms | min ms | conns | stmts | write stmts | rows changed | trigger stmts | rows | VM steps | fullscan steps | sorts | autoindex | page misses | page hits | traced SQL ms | JSON bytes | counts stable |"
        );
        println!("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
        for row in &self.rows {
            println!(
                "| {} | {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {:.2} | {} | {} |",
                row.group,
                row.label,
                row.outcome,
                row.first_ms,
                row.median_ms,
                row.p95_ms,
                row.min_ms,
                row.counters.connections,
                row.counters.statements,
                row.counters.write_statements,
                row.counters.rows_changed,
                row.counters.triggers,
                row.counters.rows,
                row.counters.vm_steps,
                row.counters.fullscan_steps,
                row.counters.sorts,
                row.counters.autoindex,
                row.counters.cache_misses,
                row.counters.cache_hits,
                row.counters.sql_nanos as f64 / 1_000_000.0,
                row.json_bytes.map(|b| b.to_string()).unwrap_or_default(),
                if row.counters_stable { "yes" } else { "no" }
            );
        }
        if !self.detail_sections.is_empty() {
            println!();
            println!(
                "## Heaviest statements of paths with median >= {} ms (one traced call)",
                self.options.detail_threshold_ms
            );
            for section in &self.detail_sections {
                println!();
                print!("{section}");
            }
        }
    }
}

fn format_details(group: &str, label: &str) -> String {
    let map = details()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by(|a, b| b.1.nanos.cmp(&a.1.nanos));
    let mut out = format!("### {group}/{label}\n\n| SQL ms | count | VM steps | fullscan | statement |\n|---:|---:|---:|---:|---|\n");
    for (sql, detail) in entries.into_iter().take(8) {
        out.push_str(&format!(
            "| {:.2} | {} | {} | {} | `{}` |\n",
            detail.nanos as f64 / 1_000_000.0,
            detail.count,
            detail.vm_steps,
            detail.fullscan_steps,
            sql.replace('|', "\\|").replace('`', "'")
        ));
    }
    out
}

/// Short, stable description of a result: item counts and totals.
fn describe(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("items={}", items.len()),
        Value::Object(map) => {
            let mut parts = Vec::new();
            for key in [
                "items", "rows", "assets", "results", "groups", "series", "targets",
            ] {
                if let Some(Value::Array(items)) = map.get(key) {
                    parts.push(format!("{key}={}", items.len()));
                }
            }
            for key in ["totalCount", "total", "totalBytes"] {
                if let Some(total) = map.get(key).and_then(Value::as_u64) {
                    parts.push(format!("{key}={total}"));
                }
            }
            if parts.is_empty() {
                format!("object({} keys)", map.len())
            } else {
                parts.join(" ")
            }
        }
        Value::Null => "none".to_owned(),
        other => other.to_string().chars().take(40).collect(),
    }
}

fn to_value<T: serde::Serialize, E: std::fmt::Display>(
    result: Result<T, E>,
) -> Result<Value, String> {
    result
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("probe query shape")
}

fn string_at<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(Value::as_str)
}

/// The entry with the largest numeric `key` (e.g. assetCount), and one near the median.
fn largest_and_median<'v>(items: &'v [Value], key: &str) -> (Option<&'v Value>, Option<&'v Value>) {
    let mut sorted: Vec<&Value> = items
        .iter()
        .filter(|item| item.get(key).and_then(Value::as_u64).unwrap_or(0) > 0)
        .collect();
    sorted
        .sort_by_key(|item| std::cmp::Reverse(item.get(key).and_then(Value::as_u64).unwrap_or(0)));
    (
        sorted.first().copied(),
        sorted.get(sorted.len() / 2).copied(),
    )
}

// ---------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------

fn base_query() -> AssetQuery {
    AssetQuery {
        sort: AssetSort::Newest,
        limit: PAGE_SIZE,
        ..AssetQuery::default()
    }
}

fn page(library: &Library, query: &AssetQuery) -> Result<Value, String> {
    to_value(library.list_assets(query.clone()))
}

fn run_paths(bench: &mut Bench, library: &Library, snapshot_root: &Path) {
    connection_paths(bench, snapshot_root);
    let sidebar = sidebar_paths(bench, library);
    grid_paths(bench, library, &sidebar);
    viewer_paths(bench, library);
    character_paths(bench, library);
    review_paths(bench, library);
    collection_paths(bench, library, &sidebar);
    catalog_paths(bench, library);
    if bench.options.idle_ticks {
        idle_paths(bench, library);
    }
    contention_paths(bench, library);
}

/// Local halves of the native idle timers that are safe on a snapshot: the Cloud API
/// endpoint was redirected to a closed local port before open, and the replication
/// cycle is only run when nothing is eligible (its idle path never reaches the network
/// or credentials).
fn idle_paths(bench: &mut Bench, library: &Library) {
    bench.run("idle", "cloud_backfill_progress", || {
        to_value(library.cloud_backfill_progress())
    });
    if replication_idle(library.root()) {
        bench.run(
            "idle",
            "replication_cycle_idle(native every 2 s / 10 s light)",
            || to_value(library.run_cloud_backfill_cycle()),
        );
    } else {
        println!("idle/replication_cycle_idle: skipped (work is eligible in the snapshot)");
    }
}

/// True when the replication cycle's eligibility query finds nothing (normal workload,
/// no new-ingest priority list), so the cycle returns before any network work.
fn replication_idle(snapshot_root: &Path) -> bool {
    let Ok(connection) = rusqlite::Connection::open_with_flags(
        snapshot_root.join("library.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return false;
    };
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM cloud_sync_queue q JOIN assets a ON a.id=q.entity_id
             WHERE a.status='normal' AND q.entity_type='asset' AND q.operation='upsert' AND q.status='pending'
             AND NOT EXISTS(SELECT 1 FROM cloud_backfill_control WHERE singleton=1 AND state='paused'))",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false)
}

/// Point the snapshot's Cloud API at a closed local port so no probe path can reach the
/// production server. Only ever called on the snapshot copy.
fn isolate_snapshot_network(
    snapshot_root: &Path,
    library: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let database = snapshot_root.join("library.sqlite");
    if fs::canonicalize(&database)?.starts_with(fs::canonicalize(library)?) {
        return Err("refusing to modify a database inside the library".into());
    }
    let connection = rusqlite::Connection::open(&database)?;
    let changed = connection.execute(
        "UPDATE library_settings SET cloud_api_base_url='http://127.0.0.1:9' WHERE singleton=1",
        [],
    )?;
    println!("snapshot_cloud_endpoint_redirected: rows={changed}");
    Ok(())
}

/// Every Library call opens a new connection; isolate that fixed cost.
fn connection_paths(bench: &mut Bench, snapshot_root: &Path) {
    let path = snapshot_root.join("library.sqlite");
    let open = |schema: bool| -> Result<Value, String> {
        let connection = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        if schema {
            connection
                .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map(|objects| json!(objects))
                .map_err(|e| e.to_string())
        } else {
            Ok(Value::Null)
        }
    };
    bench.run("connection", "open_database_only", || open(false));
    bench.run("connection", "open_database_and_load_schema", || open(true));
}

struct SidebarIds {
    largest_classification: Option<String>,
    median_classification: Option<String>,
    largest_album: Option<String>,
    largest_collection: Option<String>,
}

fn sidebar_paths(bench: &mut Bench, library: &Library) -> SidebarIds {
    let classifications = bench
        .run("sidebar", "list_classifications", || {
            to_value(library.list_classifications())
        })
        .unwrap_or(Value::Null);
    let albums = bench
        .run("sidebar", "list_albums", || to_value(library.list_albums()))
        .unwrap_or(Value::Null);
    let collections = bench
        .run("sidebar", "list_collections", || {
            to_value(library.list_collections())
        })
        .unwrap_or(Value::Null);
    bench.run("sidebar", "character_sidebar_counts", || {
        to_value(library.character_sidebar_counts())
    });
    // App.tsx refreshSidebar: the three lists together (serialized by the DB mutex).
    bench.run(
        "sidebar",
        "refresh_sidebar(classifications+albums+collections)",
        || {
            library.list_classifications().map_err(|e| e.to_string())?;
            library.list_albums().map_err(|e| e.to_string())?;
            library.list_collections().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        },
    );
    bench.run("sidebar", "library_statistics", || {
        to_value(library.get_library_statistics())
    });

    let empty = Vec::new();
    let classification_items = classifications.as_array().unwrap_or(&empty);
    // The recursive grid shows the subtree, so pick by the subtree total.
    let (largest, median) = largest_and_median(classification_items, "totalAssetCount");
    if let Some(entry) = largest {
        println!(
            "largest_classification: subtree_assets={} direct_assets={} name={}",
            entry["totalAssetCount"], entry["assetCount"], entry["name"]
        );
    }
    println!("classification_entries: {}", classification_items.len());
    let (largest_album, _) = largest_and_median(albums.as_array().unwrap_or(&empty), "assetCount");
    let (largest_collection, _) =
        largest_and_median(collections.as_array().unwrap_or(&empty), "assetCount");
    println!(
        "albums: {} collections: {}",
        albums.as_array().map(Vec::len).unwrap_or(0),
        collections.as_array().map(Vec::len).unwrap_or(0)
    );
    SidebarIds {
        largest_classification: largest.and_then(|v| string_at(v, "id")).map(str::to_owned),
        median_classification: median.and_then(|v| string_at(v, "id")).map(str::to_owned),
        largest_album: largest_album
            .and_then(|v| string_at(v, "id"))
            .map(str::to_owned),
        largest_collection: largest_collection
            .and_then(|v| string_at(v, "id"))
            .map(str::to_owned),
    }
}

fn grid_paths(bench: &mut Bench, library: &Library, ids: &SidebarIds) {
    let variants: Vec<(&str, AssetQuery)> = vec![
        ("root_newest", base_query()),
        (
            "root_oldest",
            AssetQuery {
                sort: AssetSort::Oldest,
                ..base_query()
            },
        ),
        (
            "root_favorites_sort",
            AssetQuery {
                sort: AssetSort::Favorites,
                ..base_query()
            },
        ),
        (
            "root_random",
            AssetQuery {
                sort: AssetSort::Random,
                random_pivot: Some("perf-probe-pivot".into()),
                ..base_query()
            },
        ),
        (
            "root_images",
            AssetQuery {
                media_kind: Some(MediaKindFilter::Images),
                ..base_query()
            },
        ),
        (
            "root_videos",
            AssetQuery {
                media_kind: Some(MediaKindFilter::Videos),
                ..base_query()
            },
        ),
        (
            "root_favorite_only",
            AssetQuery {
                favorite_only: true,
                ..base_query()
            },
        ),
        (
            "root_unclassified",
            AssetQuery {
                unclassified_only: true,
                ..base_query()
            },
        ),
        (
            "root_landscape",
            AssetQuery {
                aspect_ratio: Some(from_json(json!("landscape"))),
                ..base_query()
            },
        ),
        // App.tsx badge reads: limit 1, only totalCount is used.
        (
            "badge_unclassified_count(limit1)",
            AssetQuery {
                unclassified_only: true,
                limit: 1,
                ..base_query()
            },
        ),
    ];
    for (label, query) in variants {
        bench.run("grid", label, || page(library, &query));
    }
    if let Some(id) = &ids.largest_classification {
        for (label, direct_only) in [
            ("largest_classification_recursive", false),
            ("largest_classification_direct", true),
        ] {
            let query = AssetQuery {
                classification_id: Some(id.clone()),
                direct_only,
                ..base_query()
            };
            bench.run("grid", label, || page(library, &query));
        }
        let query = AssetQuery {
            classification_id: Some(id.clone()),
            media_kind: Some(MediaKindFilter::Images),
            ..base_query()
        };
        bench.run("grid", "largest_classification_images", || {
            page(library, &query)
        });
    }
    if let Some(id) = &ids.median_classification {
        let query = AssetQuery {
            classification_id: Some(id.clone()),
            ..base_query()
        };
        bench.run("grid", "median_classification_recursive", || {
            page(library, &query)
        });
    }
    if let Some(id) = &ids.largest_album {
        let query = AssetQuery {
            album_id: Some(id.clone()),
            ..base_query()
        };
        bench.run("grid", "largest_album", || page(library, &query));
    }
    if let Some(id) = &ids.largest_collection {
        let query = AssetQuery {
            collection_id: Some(id.clone()),
            ..base_query()
        };
        bench.run("grid", "largest_collection", || page(library, &query));
    }

    // Scrolling: keyset pages 2, 10 and 30 of the root grid.
    let mut cursors: Vec<AssetCursor> = Vec::new();
    let mut query = base_query();
    for _ in 0..30 {
        let Ok(page) = library.list_assets(query.clone()) else {
            break;
        };
        let page: AssetPage = page;
        let Some(cursor) = page.next_cursor else {
            break;
        };
        cursors.push(cursor.clone());
        query.after = Some(cursor);
    }
    for page_number in [2usize, 10, 30] {
        if let Some(cursor) = cursors.get(page_number - 2) {
            let query = AssetQuery {
                after: Some(cursor.clone()),
                ..base_query()
            };
            bench.run("grid", format!("root_newest_page_{page_number}"), || {
                page(library, &query)
            });
        }
    }

    let creators = bench.run("grid", "asset_creators_root", || {
        to_value(library.list_asset_creators(base_query()))
    });
    if let Some(key) = creators
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| string_at(item, "key"))
    {
        let query = AssetQuery {
            creator_key: Some(key.to_owned()),
            ..base_query()
        };
        bench.run("grid", "top_creator_assets", || page(library, &query));
    }
    let now = chrono::Utc::now();
    let bucket_query = json!({
        "startUtc": (now - chrono::Duration::days(365)).to_rfc3339(),
        "endUtc": now.to_rfc3339(),
        "offsetMinutes": 540,
    });
    bench.run("grid", "date_buckets_365d", || {
        to_value(library.list_asset_date_buckets(from_json(bucket_query.clone())))
    });
    let local_date = now.format("%Y-%m-%d").to_string();
    let now_utc = now.to_rfc3339();
    bench.run("grid", "revisit_slate", || {
        to_value(library.get_or_create_revisit_slate(&local_date, &now_utc))
    });
}

fn viewer_paths(bench: &mut Bench, library: &Library) {
    let Ok(first) = library.list_assets(base_query()) else {
        return;
    };
    let Some(asset) = first.items.first() else {
        return;
    };
    let id = asset.id.clone();
    bench.run("viewer", "get_asset", || to_value(library.get_asset(&id)));
    bench.run("viewer", "get_asset_classifications", || {
        to_value(library.get_asset_classifications(&id))
    });
    bench.run("viewer", "get_asset_albums", || {
        to_value(library.get_asset_albums(&id))
    });
    bench.run("viewer", "get_asset_collections", || {
        to_value(library.get_asset_collections(&id))
    });
    bench.run("viewer", "character_relations_for_asset", || {
        to_value(library.character_relations_for_asset(&id))
    });
    bench.run("viewer", "list_source_group_assets", || {
        to_value(library.list_source_group_assets(&id))
    });
}

fn character_paths(bench: &mut Bench, library: &Library) {
    let targets = bench
        .run("characters", "list_character_targets", || {
            to_value(library.list_character_targets())
        })
        .unwrap_or(Value::Null);
    let series = bench
        .run("characters", "character_series", || {
            to_value(library.character_series())
        })
        .unwrap_or(Value::Null);
    bench.run("characters", "character_review_pending_map", || {
        to_value(library.character_review_pending_map())
    });
    bench.run("characters", "character_incremental_status", || {
        to_value(library.character_incremental_status())
    });
    let empty = Vec::new();
    let targets = targets.as_array().unwrap_or(&empty);
    println!(
        "character_targets: {} series: {}",
        targets.len(),
        series.as_array().map(Vec::len).unwrap_or(0)
    );
    // The series with the most targets stands in for the busiest series screen. `ready`
    // depends on reference files the snapshot does not copy, so it is only reported.
    let ready = targets
        .iter()
        .filter(|t| t.get("ready").and_then(Value::as_bool) == Some(true))
        .count();
    println!("character_targets_ready_in_snapshot: {ready}");
    let mut per_series: HashMap<&str, usize> = HashMap::new();
    for target in targets {
        if let Some(series_id) = string_at(target, "seriesClassificationId") {
            *per_series.entry(series_id).or_default() += 1;
        }
    }
    let Some((series_id, _)) = per_series
        .iter()
        .max_by_key(|(id, count)| (**count, std::cmp::Reverse(**id)))
    else {
        println!("characters: no series with targets; screen paths skipped");
        return;
    };
    let series_id = (*series_id).to_owned();
    let target_id = targets
        .iter()
        .find(|t| string_at(t, "seriesClassificationId") == Some(series_id.as_str()))
        .and_then(|t| string_at(t, "id"))
        .map(str::to_owned);
    for (label, query) in [
        (
            "browse_series_all",
            json!({"seriesId": series_id, "targetId": null, "after": null, "limit": 100, "all": true, "seriesFilter": "all"}),
        ),
        (
            "browse_series_unclassified",
            json!({"seriesId": series_id, "targetId": null, "after": null, "limit": 100, "all": false, "seriesFilter": "unclassified"}),
        ),
        (
            "browse_series_needs_review",
            json!({"seriesId": series_id, "targetId": null, "after": null, "limit": 100, "all": false, "seriesFilter": "needs_review"}),
        ),
        (
            "browse_target",
            json!({"seriesId": series_id, "targetId": target_id, "after": null, "limit": 100, "all": false}),
        ),
    ] {
        bench.run("characters", label, || {
            to_value(library.browse_character_assets(from_json(query.clone())))
        });
    }
    for filter in ["recommended", "all", "pending"] {
        let query = json!({"seriesId": series_id, "targetId": target_id, "filter": filter, "after": null, "limit": 40});
        bench.run("characters", format!("review_page_target_{filter}"), || {
            to_value(library.character_review_page(from_json(query.clone())))
        });
    }
    let query = json!({"seriesId": series_id, "targetId": null, "filter": "recommended", "after": null, "limit": 40});
    bench.run("characters", "review_page_series_recommended", || {
        to_value(library.character_review_page(from_json(query.clone())))
    });
    let query = json!({"offset": 0, "limit": 40, "seriesId": series_id});
    bench.run("characters", "shadow_review_page_series", || {
        to_value(library.character_shadow_review_page(from_json(query.clone())))
    });
    let query = json!({"offset": 0, "limit": 40});
    bench.run("characters", "shadow_review_page_all", || {
        to_value(library.character_shadow_review_page(from_json(query.clone())))
    });
}

fn review_paths(bench: &mut Bench, library: &Library) {
    bench.run("review", "badge_similarity_count(limit1)", || {
        to_value(library.list_similarity_reviews(None, 1))
    });
    bench.run("review", "similarity_reviews_page50", || {
        to_value(library.list_similarity_reviews(None, 50))
    });
    bench.run("review", "video_similarity_reviews(limit1)", || {
        to_value(library.list_video_similarity_reviews(None, 1))
    });
    bench.run("review", "similarity_review_inbound_status", || {
        to_value(library.similarity_review_inbound_status())
    });
    bench.run("trash", "badge_trash_count(limit1)", || {
        to_value(library.list_trash(None, 1))
    });
    bench.run("trash", "list_trash_page100", || {
        to_value(library.list_trash(None, 100))
    });
}

fn collection_paths(bench: &mut Bench, library: &Library, ids: &SidebarIds) {
    bench.run("collections", "list_release_inbox", || {
        to_value(library.list_release_inbox())
    });
    for provider in ["mangadex", "kakao"] {
        bench.run(
            "collections",
            format!("collection_update_status_{provider}"),
            || to_value(library.collection_update_status(provider)),
        );
    }
    if let Some(id) = &ids.largest_collection {
        bench.run("collections", "list_ownership_tracking_largest", || {
            to_value(library.list_ownership_tracking(id))
        });
    }
}

fn catalog_paths(bench: &mut Bench, library: &Library) {
    bench.run("catalog", "catalog_status", || {
        to_value(library.catalog_status())
    });
    if !library.root().join("catalogs/kdata.db").is_file() {
        return;
    }
    for (label, text, sort) in [
        ("search_empty_latest", "", "latest"),
        ("search_text_latest", "love", "latest"),
        ("search_empty_views", "", "views"),
    ] {
        let query = json!({"text": text, "sort": sort, "scope": "all", "page": 1, "pageSize": 48});
        bench.run("catalog", format!("search_online_{label}"), || {
            to_value(library.search_online_catalog(from_json(query.clone())))
        });
        bench.run("catalog", format!("search_groups_{label}"), || {
            let mut events = 0u64;
            library
                .search_catalog_groups_cancellable(
                    from_json(query.clone()),
                    || false,
                    |_| {
                        events += 1;
                        Ok(())
                    },
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({ "events": events }))
        });
    }
    bench.run("catalog", "suggest_online_catalog", || {
        to_value(library.suggest_online_catalog("lo", 10))
    });
}

/// All Library calls share one process-wide DB mutex. Measure a grid page while another
/// thread keeps re-reading the sidebar tree with a 2 ms gap between reads, as a busy
/// background lane would. (A gap-free loop starves the waiter for minutes because
/// `std::sync::Mutex` is not FIFO; that variant is not run by default.)
fn contention_paths(bench: &mut Bench, library: &Library) {
    if !bench.selected("contention") {
        return;
    }
    bench.max_iterations = Some(8);
    let stop = Arc::new(AtomicBool::new(false));
    let background = {
        let library = library.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let _ = library.list_classifications();
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };
    std::thread::sleep(Duration::from_millis(50));
    let query = base_query();
    bench.run(
        "contention",
        "root_newest_while_sidebar_rereads_every_2ms",
        || page(library, &query),
    );
    stop.store(true, Ordering::Relaxed);
    let _ = background.join();

    // App.tsx refreshSidebar in flight (e.g. after an authority-changed event) when the
    // grid asks for a page 5 ms later.
    bench.run(
        "contention",
        "root_newest_5ms_after_refresh_sidebar_starts",
        || {
            let refresh = {
                let library = library.clone();
                std::thread::spawn(move || {
                    let _ = library.list_classifications();
                    let _ = library.list_albums();
                    let _ = library.list_collections();
                })
            };
            std::thread::sleep(Duration::from_millis(5));
            let started = Instant::now();
            let result = page(library, &query);
            let waited = started.elapsed();
            let _ = refresh.join();
            result.map(|_| json!({ "gridMs": (waited.as_secs_f64() * 1000.0).round() }))
        },
    );
    bench.max_iterations = None;
}

// ---------------------------------------------------------------------------------
// Disk stats (optional, read-only metadata walk)
// ---------------------------------------------------------------------------------

fn print_disk_stats(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    for name in [
        "assets",
        "thumbnails",
        "video-media",
        "cache",
        "collection-thumbnails",
        "work-artwork",
        "work-artwork-thumbnails",
        "catalogs",
        "backups",
    ] {
        let path = root.join(name);
        if path.exists() {
            let (files, bytes) = directory_stats(&path)?;
            println!(
                "disk_{name}: files={files} mib={:.2}",
                bytes as f64 / 1024.0 / 1024.0
            );
        }
    }
    println!(
        "disk_scan_ms: {:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

fn directory_stats(root: &Path) -> Result<(u64, u64), Box<dyn std::error::Error>> {
    let mut stack = vec![root.to_path_buf()];
    let mut files = 0u64;
    let mut bytes = 0u64;
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                stack.push(entry.path());
            } else if metadata.is_file() {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok((files, bytes))
}

// ---------------------------------------------------------------------------------

fn main() -> Result<(), Box<dyn std::error::Error>> {
    install_sql_accounting();
    let options = parse_options()?;
    println!("Lakomics PERF-ALL-001 backend probe");
    println!("library: {}", options.library.display());
    println!(
        "build: {} | sqlite {} | iterations {}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        rusqlite::version(),
        options.iterations
    );
    let before = fingerprint(&options.library)?;
    if options.disk_stats {
        print_disk_stats(&options.library)?;
    }

    let snapshot_root = snapshot(&options)?;
    isolate_snapshot_network(&snapshot_root, &options.library)?;
    // Startup is traced: Library::open plus the background work it spawns.
    TRACE_ON.store(true, Ordering::Relaxed);
    DETAIL_ON.store(true, Ordering::Relaxed);
    let open_before = read_counters();
    let cpu_before = process_cpu_ms();
    let open_started = Instant::now();
    let library = Library::open(&snapshot_root)?;
    let open_counters = delta(read_counters(), open_before);
    println!(
        "library_open_ms(traced): {:.1} connections={} stmts={} page_misses={} cpu_ms={:.0}",
        open_started.elapsed().as_secs_f64() * 1000.0,
        open_counters.connections,
        open_counters.statements,
        open_counters.cache_misses,
        process_cpu_ms()
            .zip(cpu_before)
            .map(|(a, b)| a - b)
            .unwrap_or(f64::NAN)
    );
    let open_details = format_details("startup", "library_open_and_background");
    details()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    let threads = thread_count();
    let settle_before = read_counters();
    let (settle_ms, settle_cpu_ms) = wait_for_background_settle(Duration::from_secs(180));
    let settle_counters = delta(read_counters(), settle_before);
    println!(
        "background_settle: wall_ms={settle_ms:.0} cpu_ms={settle_cpu_ms:.0} connections={} stmts={} threads_after_open={threads:?} threads_now={:?}",
        settle_counters.connections,
        settle_counters.statements,
        thread_count()
    );
    let settle_details = format_details("startup", "background_after_open");
    DETAIL_ON.store(false, Ordering::Relaxed);
    TRACE_ON.store(false, Ordering::Relaxed);

    let mut bench = Bench {
        options: &options,
        rows: Vec::new(),
        detail_sections: Vec::new(),
        max_iterations: None,
    };
    bench.detail_sections.push(open_details);
    bench.detail_sections.push(settle_details);
    run_paths(&mut bench, &library, &snapshot_root);
    bench.print_table();

    drop(library);
    let after = fingerprint(&options.library)?;
    let unchanged = before == after;
    println!();
    println!("library_root_unchanged: {unchanged}");
    if !unchanged {
        for entry in after.iter().filter(|entry| !before.contains(entry)) {
            println!("changed_or_new: {entry:?}");
        }
        for entry in before.iter().filter(|entry| !after.contains(entry)) {
            println!("changed_or_removed: {entry:?}");
        }
    }
    if options.keep_snapshot {
        println!("snapshot kept: {}", snapshot_root.display());
    } else {
        fs::remove_dir_all(&snapshot_root)?;
    }
    Ok(())
}
