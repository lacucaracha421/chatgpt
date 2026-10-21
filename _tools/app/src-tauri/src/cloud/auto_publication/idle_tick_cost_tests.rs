#[test]
#[ignore = "diagnostic timing on a disposable library; run alone with --nocapture"]
fn idle_publication_tick_cost() {
    let f = idle();
    {
        let mut db = f.library.connection().unwrap();
        let tx = db.transaction().unwrap();
        for index in 0..20_000 {
            let id = format!("fixture-{index}");
            tx.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES(?1,?1,'image','fixture.jpg',?1,?1,1000,100,100,'2026-10-01')", [&id]).unwrap();
            tx.execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at) VALUES(?1,'asset',?1,'upsert','synced',1,'2026-10-01')", [&id]).unwrap();
        }
        tx.execute(
            "UPDATE mobile_publication_state SET published_generation=generation",
            [],
        )
        .unwrap();
        tx.execute(
            "UPDATE cloud_metadata_publication_state SET published_generation=generation",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    #[cfg(windows)]
    fn cpu_time() -> Duration {
        use windows_sys::Win32::{
            Foundation::FILETIME,
            System::Threading::{GetCurrentThread, GetThreadTimes},
        };
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
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
        let ticks =
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
    }
    for (name, probe) in [
        ("connection", 0),
        ("waiting", 1),
        ("due", 2),
        ("dispatcher", 3),
        ("legacy backfill progress", 4),
        ("backfill progress", 5),
    ] {
        crate::library::PREPARED_SELECTS.with(|n| n.set(0));
        let start = Instant::now();
        #[cfg(windows)]
        let cpu = cpu_time();
        for _ in 0..10 {
            match probe {
                0 => {
                    drop(f.library.connection().unwrap());
                }
                1 => {
                    f.library.publication_lanes_waiting(&f.endpoint).unwrap();
                }
                2 => {
                    f.library
                        .publication_lanes_due(&f.endpoint, f.now, false, false)
                        .unwrap();
                }
                3 => {
                    assert_eq!(f.library.run_saved_mobile_publications().unwrap(), 0);
                }
                4 => {
                    assert_eq!(
                        f.library
                            .legacy_cloud_backfill_progress()
                            .unwrap()
                            .completed,
                        20_000
                    );
                }
                _ => {
                    assert_eq!(
                        f.library.cloud_backfill_progress().unwrap().completed,
                        20_000
                    );
                }
            }
        }
        eprintln!(
            "{name}: {:.3} ms/tick, {:.1} prepared SELECTs/tick",
            start.elapsed().as_secs_f64() * 100.0,
            crate::library::PREPARED_SELECTS.with(|n| n.get()) as f64 / 10.0
        );
        #[cfg(windows)]
        eprintln!(
            "{name}: {:.3} CPU ms/tick (20,000 assets)",
            (cpu_time() - cpu).as_secs_f64() * 100.0
        );
    }
}

#[test]
fn grouped_progress_matches_legacy_on_varied_library() {
    let f = idle();
    let compare = || {
        assert_eq!(
            f.library.cloud_backfill_progress().unwrap(),
            f.library.legacy_cloud_backfill_progress().unwrap()
        )
    };
    compare();
    {
        let mut db = f.library.connection().unwrap();
        let tx = db.transaction().unwrap();
        let states = [
            "pending",
            "preparing",
            "uploading",
            "committing",
            "processing",
            "synced",
            "failed",
        ];
        for index in 0..40 {
            let id = format!("varied-{index}");
            tx.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at) VALUES(?1,?1,'image','fixture.jpg',?1,?1,1000,100,100,'2026-10-01')", [&id]).unwrap();
            if index % 5 == 0 {
                tx.execute("UPDATE assets SET status='trash' WHERE id=?1", [&id])
                    .unwrap();
            }
            tx.execute("INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,projection,materialization,server_created) VALUES(?1,?2,1,'{}','complete',?3)", rusqlite::params![id, if index % 3 == 0 { "trash" } else { "normal" }, (index % 2) as i64]).unwrap();
            if index < 35 {
                // Include superseded failures, resolved errors, all persisted states,
                // and unresolved retry errors on the latest revision.
                for revision in 1..=3 {
                    let state = if revision == 3 {
                        states[index % states.len()]
                    } else {
                        "failed"
                    };
                    tx.execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at,last_error) VALUES(?1,'asset',?2,'upsert',?3,?4,'2026-10-01',?5)", rusqlite::params![format!("{id}-{revision}"), id, state, revision, (index % 2 == 0 || revision < 3).then_some("private error")]).unwrap();
                }
            }
        }
        // Orphan queue history must never count as a live Asset.
        tx.execute("INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at,last_error) VALUES('orphan','asset','missing','upsert','failed',1,'2026-10-01','private error')", []).unwrap();
        tx.commit().unwrap();
    }
    let item_error = f
        .library
        .legacy_cloud_backfill_progress()
        .unwrap()
        .last_error
        .unwrap();
    for scoped in [false, true] {
        if scoped {
            f.library.connection().unwrap().execute("INSERT INTO cloud_backfill_scope SELECT id FROM assets WHERE id IN ('varied-0','varied-1','varied-6','varied-7','varied-13','varied-15','varied-34','varied-35','varied-36','varied-37','varied-39')", []).unwrap();
        }
        for state in ["idle", "paused", "running"] {
            f.library
                .connection()
                .unwrap()
                .execute("UPDATE cloud_backfill_control SET state=?1", [state])
                .unwrap();
            for enabled in [false, true] {
                f.library
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE library_settings SET cloud_sync_enabled=?1",
                        [enabled],
                    )
                    .unwrap();
                for reason in [None, Some("transport")] {
                    f.library.connection().unwrap().execute("UPDATE cloud_activity SET last_error=?1, last_reason=?2, problems=3 WHERE direction='replication'", rusqlite::params![item_error.as_str(), reason]).unwrap();
                    compare();
                }
            }
        }
    }
    f.library
        .connection()
        .unwrap()
        .execute("UPDATE cloud_sync_queue SET status='synced'", [])
        .unwrap();
    compare();
    f.library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status='trash'", [])
        .unwrap();
    compare();
}
