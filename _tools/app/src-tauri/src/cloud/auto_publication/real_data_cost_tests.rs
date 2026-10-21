//! Opt-in measurements on an online-backup copy, without OS credentials or HTTP.
use super::*;
use rusqlite::ffi;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    ffi::{c_char, c_int, c_void, CStr},
    time::{Duration, Instant},
};

thread_local! {
    static SQL: RefCell<BTreeMap<String, (usize, u64, u64)>> = RefCell::default();
}

unsafe extern "C" fn trace(kind: u32, _: *mut c_void, p: *mut c_void, x: *mut c_void) -> c_int {
    if kind == ffi::SQLITE_TRACE_PROFILE {
        let stmt = p.cast::<ffi::sqlite3_stmt>();
        let sql = CStr::from_ptr(ffi::sqlite3_sql(stmt))
            .to_string_lossy()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let ns = *x.cast::<u64>();
        let steps = ffi::sqlite3_stmt_status(stmt, ffi::SQLITE_STMTSTATUS_VM_STEP, 1) as u64;
        SQL.with(|map| {
            let mut map = map.borrow_mut();
            let row = map.entry(sql).or_default();
            row.0 += 1;
            row.1 += ns;
            row.2 += steps;
        });
    }
    0
}
unsafe extern "C" fn opened(
    db: *mut ffi::sqlite3,
    _: *mut *mut c_char,
    _: *const ffi::sqlite3_api_routines,
) -> c_int {
    ffi::sqlite3_trace_v2(
        db,
        ffi::SQLITE_TRACE_PROFILE,
        Some(trace),
        std::ptr::null_mut(),
    );
    ffi::SQLITE_OK
}

#[cfg(windows)]
fn cpu() -> Duration {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentThread, GetThreadTimes},
    };
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let (mut exited, mut kernel, mut user) = (created, created, created);
    unsafe {
        assert_ne!(
            GetThreadTimes(
                GetCurrentThread(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user
            ),
            0
        );
    }
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
}

#[cfg(windows)]
fn measure(name: &str, mut probe: impl FnMut()) {
    probe();
    SQL.with(|map| map.borrow_mut().clear());
    let started = Instant::now();
    let before = cpu();
    const N: usize = 10;
    for _ in 0..N {
        probe();
    }
    let cpu_ms = (cpu() - before).as_secs_f64() * 1000.0 / N as f64;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0 / N as f64;
    SQL.with(|map| {
        let map = map.borrow();
        let statements = map.values().map(|v| v.0).sum::<usize>() as f64 / N as f64;
        eprintln!("PROBE {name}: elapsed_ms={elapsed_ms:.3} cpu_ms={cpu_ms:.3} statements={statements:.1}");
        let mut rows = map.iter().collect::<Vec<_>>();
        rows.sort_by_key(|(_, v)| std::cmp::Reverse(v.2));
        for (sql, (count, ns, steps)) in rows.into_iter().take(4) {
            eprintln!("SQL count={} ms={:.3} steps={} {}", count / N, *ns as f64 / 1e6 / N as f64, steps / N as u64, sql);
        }
    });
}

#[test]
#[cfg(windows)]
#[ignore = "real-data copy only; run alone with --ignored --nocapture --test-threads=1"]
fn real_data_publication_tick_cost() {
    let root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target-worker/probe-library");
    assert!(
        root.join("library.sqlite").is_file(),
        "create the online-backup copy first"
    );
    unsafe {
        assert_eq!(ffi::sqlite3_auto_extension(Some(opened)), ffi::SQLITE_OK);
    }
    let library = Library::open(&root).unwrap();
    let endpoint = library.cloud_sync_config().unwrap().api_base_url.unwrap();
    let now = chrono::Utc::now().timestamp();
    measure("config/status-supervisor", || {
        library.cloud_sync_config().unwrap();
    });
    measure("connection", || {
        drop(library.connection().unwrap());
    });
    measure("replication/idle", || {
        let result = library.run_cloud_backfill_cycle().unwrap();
        assert_eq!(result.committed, 0);
    });
    measure("waiting", || {
        library.publication_lanes_waiting(&endpoint).unwrap();
    });
    measure("readiness/all", || {
        library
            .publication_lanes_due(&endpoint, now, false, false)
            .unwrap();
    });
    let db = library.connection().unwrap();
    measure("lane/releases", || {
        crate::library::collection_release_sync::publication_due_on(&db, &endpoint, now, false)
            .unwrap();
    });
    measure("lane/bindings", || {
        crate::library::collection_binding_sync::publication_due_on(&db, &endpoint, now).unwrap();
    });
    measure("lane/metadata-picker", || {
        crate::cloud::picker_display::due(&db, &endpoint, now).unwrap();
    });
    for kind in ["upcoming", "artists"] {
        measure(&format!("lane/{kind}"), || {
            library
                .home_publication_due_on(&db, &endpoint, kind, now)
                .unwrap();
        });
    }
    measure("lane/autoTags", || {
        library
            .auto_tag_publication_due_on(&db, &endpoint, now)
            .unwrap();
    });
    measure("lane/captions", || {
        library
            .caption_publication_due_on(&db, &endpoint, now)
            .unwrap();
    });
    drop(db);
    eprintln!(
        "DUE {:?}",
        library
            .publication_lanes_due(&endpoint, now, false, false)
            .unwrap()
    );
    // Test builds use the empty thread-local credential backend, never OS credentials.
    assert!(crate::library::credential::read_cloud_api_token_os().is_err());
    assert!(crate::library::credential::read_cloud_publisher_token_os().is_err());
    for kind in [
        "collections",
        "characters",
        "visibility",
        "similarity",
        "catalogDuplicates",
        "releases",
        "bindings",
        "metadata",
        "upcoming",
        "artists",
        "autoTags",
    ] {
        measure(&format!("worker/{kind}/no-credentials"), || {
            let _ = library.run_mobile_publication_lane(kind, &endpoint);
        });
    }
    // Compare the old and current lane gates after a successful initial check.
    // No credentials are installed: the old worker's HTTP cost is intentionally excluded.
    library
        .publication_inputs
        .checked(8, library.publication_inputs.generation(8));
    measure("scheduled/upcoming/legacy-no-credentials", || {
        let due = library
            .home_publication_due_on(&library.connection().unwrap(), &endpoint, "upcoming", now)
            .unwrap();
        if due {
            let _ = library.run_mobile_publication_lane("upcoming", &endpoint);
        }
    });
    measure("scheduled/upcoming/current", || {
        let due = library
            .publication_upcoming_due_on(&library.connection().unwrap(), &endpoint, now)
            .unwrap();
        assert!(
            !due,
            "the copied server wishlist must have no seed or outbox"
        );
        if due {
            let _ = library.run_mobile_publication_lane("upcoming", &endpoint);
        }
    });
    measure("dispatcher/no-network", || {
        library
            .run_saved_mobile_publications_with(
                |_, _| Ok(true),
                |_, _, _| panic!("must not run publication jobs"),
            )
            .unwrap();
    });
    unsafe {
        ffi::sqlite3_cancel_auto_extension(Some(opened));
    }
}
