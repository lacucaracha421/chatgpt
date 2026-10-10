use super::super::release_calendar::{DatePrecision, ReleaseTransport};
use super::*;
use std::cell::{Cell, RefCell};

#[test]
fn server_release_wishlist_handover_joins_a_running_local_provider_pass() {
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;
    struct PausedProvider {
        started: mpsc::Sender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl ReleaseTransport for PausedProvider {
        fn igdb(&self, _: &str) -> Result<String, LibraryError> {
            self.started.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
            Ok("[]".into())
        }
        fn tmdb(&self, _: &str, _: &[(&str, String)]) -> Result<String, LibraryError> {
            panic!()
        }
    }
    let (_temp, lib) = library();
    raw_item(&*lib.connection().unwrap(), "igdb:1", None);
    lib.connection()
        .unwrap()
        .execute(
            "UPDATE release_watch_items SET next_check_at='2026-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let running = lib.clone();
    let now = chrono::Utc::now();
    let check = std::thread::spawn(move || {
        running
            .run_due_release_watchlist_with(
                &PausedProvider {
                    started: started_tx,
                    resume: Mutex::new(resume_rx),
                },
                now,
                now.date_naive(),
            )
            .unwrap()
    });
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let handover = lib.clone();
    let transfer = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        handover
            .sync_wishlist_with(
                "",
                &|| Ok(unowned()),
                &|body| {
                    assert_eq!(body["items"][0]["last_checked_at"], now.to_rfc3339());
                    Ok(accept(body))
                },
                &|_| panic!(),
            )
            .unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    resume_tx.send(()).unwrap();
    assert_eq!(check.join().unwrap().checked, 1);
    transfer.join().unwrap();
    assert!(lib.server_release_wishlist_blocked().unwrap());
}

fn library() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let lib = Library::open(temp.path()).unwrap();
    (temp, lib)
}
fn unowned() -> Value {
    json!({"version":1,"enabled":true,"mode":"awaitingSeed","seedReady":true,"revision":3,"digest":null,"acknowledgedThrough":0,"intentSequence":0})
}
fn owned() -> Value {
    let mut s = unowned();
    s["mode"] = json!("server");
    s
}
fn accept(body: &Value) -> WishlistReply {
    WishlistReply::Accepted(
        json!({"version":1,"operationId":body["operationId"],"mode":"server","revision":4,"acknowledgedThrough":0}),
    )
}
fn raw_item(db: &Connection, id: &str, scope: Option<&str>) {
    db.execute("INSERT INTO release_watch_items(id,kind,provider,external_id,title,platforms_json,tracked_platforms_json,source,added_at,muted) VALUES(?1,'game','igdb',?2,'Raw title','[\"PC\"]',?3,'calendar','2026-10-09T00:00:00Z',0)",params![id,id.strip_prefix("igdb:").unwrap(),scope]).unwrap();
    db.execute(
        "INSERT INTO release_watch_dates VALUES(?1,'KR','PC',NULL,'tbd','2026-10-09T00:00:00Z')",
        [id],
    )
    .unwrap();
}
fn public(id: &str) -> Value {
    json!({"id":id,"kind":"game","title":"Server title","originalTitle":null,"cover":null,"platforms":["PC"],"date":null,"precision":"tbd","region":null,"popularity":null,"port":false,"source":"calendar","addedAt":"2026-10-09T00:00:00Z","muted":false,"released":false,"events":[]})
}
fn cache(lib: &Library, wishlist: Value) {
    let config = lib.cloud_sync_config().unwrap();
    let key = format!(
        "serverReleaseCalendarCache:{}",
        endpoint_key(config.api_base_url.as_deref().unwrap_or(""))
    );
    lib.connection().unwrap().execute("INSERT INTO notes_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key,json!({"document":{"version":1,"entries":[public("igdb:1")],"wishlist":wishlist},"etag":null,"status":null}).to_string()]).unwrap();
}
fn mark_owned(lib: &Library) {
    let k = lib.wishlist_key().unwrap();
    save(
        &*lib.connection().unwrap(),
        &k,
        &Ownership {
            server: true,
            ..Default::default()
        },
    )
    .unwrap();
}
struct NoProviders;
impl ReleaseTransport for NoProviders {
    fn igdb(&self, _: &str) -> Result<String, LibraryError> {
        panic!("local provider after handover")
    }
    fn tmdb(&self, _: &str, _: &[(&str, String)]) -> Result<String, LibraryError> {
        panic!("local provider after handover")
    }
}

#[test]
fn server_release_wishlist_snapshot_is_lossless_and_transactional() {
    let (_temp, lib) = library();
    let mut db = lib.connection().unwrap();
    raw_item(&db, "igdb:1", None);
    raw_item(&db, "igdb:2", Some("[]"));
    for i in 0..75 {
        db.execute("INSERT INTO release_watch_item_events VALUES(?1,'igdb:1','released',NULL,'2026-10-09','2026-10-09T00:00:00Z',?2)",params![format!("event:{i}"),(i%2==0).then_some("2026-10-10T00:00:00Z")]).unwrap();
    }
    db.execute("INSERT INTO home_publication_state VALUES('https://server.test/','upcoming','{\"cursor\":12}')",[]).unwrap();
    let tx = db.transaction().unwrap();
    let body = snapshot(&tx, "https://server.test", "library", &unowned()).unwrap();
    assert_eq!(body["items"][0]["tracked_platforms_json"], Value::Null);
    assert_eq!(body["items"][1]["tracked_platforms_json"], "[]");
    assert_eq!(body["events"].as_array().unwrap().len(), 75);
    assert_eq!(body["intentCursor"], 12);
    assert_eq!(body["dates"][0]["date"], Value::Null);
    assert!(body["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["read_at"].is_string()));
    assert_eq!(body.as_object().unwrap().len(), 10);
}

#[test]
fn server_release_wishlist_lost_reply_reuses_persisted_uuid_and_payload_after_restart() {
    let (temp, lib) = library();
    let sent = RefCell::new(None);
    assert!(lib
        .sync_wishlist_with(
            "",
            &|| Ok(unowned()),
            &|body| {
                *sent.borrow_mut() = Some(body.clone());
                Err(LibraryError::CloudRequestUnavailable)
            },
            &|_| panic!("intent during seed")
        )
        .is_err());
    assert!(lib.server_release_wishlist_blocked().unwrap());
    assert_eq!(
        lib.run_due_release_watchlist_with(
            &NoProviders,
            chrono::Utc::now(),
            chrono::Utc::now().date_naive()
        )
        .unwrap()
        .checked,
        0
    );
    drop(lib);
    let lib = Library::open(temp.path()).unwrap();
    lib.sync_wishlist_with(
        "",
        &|| Ok(owned()),
        &|body| {
            assert_eq!(Some(body.clone()), *sent.borrow());
            Ok(accept(body))
        },
        &|_| panic!(),
    )
    .unwrap();
    assert!(lib.server_release_wishlist_blocked().unwrap());
    let key = lib.wishlist_key().unwrap();
    assert!(load(&*lib.connection().unwrap(), &key)
        .unwrap()
        .seed
        .is_none());
}

#[test]
fn server_release_wishlist_cas_conflict_reads_fresh_status_and_uses_fresh_snapshot() {
    let (_temp, lib) = library();
    let reads = Cell::new(0);
    let payloads = RefCell::new(Vec::new());
    lib.sync_wishlist_with(
        "",
        &|| {
            let mut s = unowned();
            reads.set(reads.get() + 1);
            s["revision"] = json!(reads.get());
            Ok(s)
        },
        &|body| {
            payloads.borrow_mut().push(body.clone());
            if payloads.borrow().len() == 1 {
                Ok(WishlistReply::Rejected(409, "wishlistSeedConflict".into()))
            } else {
                Ok(accept(body))
            }
        },
        &|_| panic!(),
    )
    .unwrap();
    let p = payloads.borrow();
    assert_eq!(p.len(), 2);
    assert_ne!(p[0]["operationId"], p[1]["operationId"]);
    assert_eq!(p[1]["expectedRevision"], 2);
}

#[test]
fn server_release_wishlist_conflict_never_reseeds_an_accepted_owner() {
    let (_temp, lib) = library();
    let reads = Cell::new(0);
    let seeds = Cell::new(0);
    lib.sync_wishlist_with(
        "",
        &|| {
            reads.set(reads.get() + 1);
            Ok(if reads.get() == 1 { unowned() } else { owned() })
        },
        &|_| {
            seeds.set(seeds.get() + 1);
            Ok(WishlistReply::Rejected(409, "serverWishlistOwned".into()))
        },
        &|_| panic!(),
    )
    .unwrap();
    assert_eq!(seeds.get(), 1);
    assert!(lib.server_release_wishlist_blocked().unwrap());
}

#[test]
fn server_release_wishlist_endpoint_library_isolation_and_absence_off_dead_worker_are_sticky() {
    let (_temp, lib) = library();
    let db = lib.connection().unwrap();
    let mut state = Ownership::default();
    observe(&mut state, &owned()).unwrap();
    let k = key("https://a.test", "one");
    save(&db, &k, &state).unwrap();
    assert!(load(&db, &key("https://a.test/", "one")).unwrap().server);
    assert!(!load(&db, &key("https://b.test", "one")).unwrap().server);
    assert!(!load(&db, &key("https://a.test", "two")).unwrap().server);
    let mut off = unowned();
    off["enabled"] = json!(false);
    off["alive"] = json!(false);
    off["features"] = json!([]);
    observe(&mut state, &off).unwrap();
    assert!(state.server);
}

#[test]
fn server_release_wishlist_outbox_retries_supersedes_and_requires_later_get() {
    let mut state = Ownership::default();
    enqueue(&mut state, "add", "igdb:1", &[], Some(public("igdb:1")));
    let uuid = state.outbox[0].body["operationId"].clone();
    enqueue(&mut state, "add", "igdb:1", &[], None);
    assert_eq!(state.outbox[0].body["operationId"], uuid);
    assert_eq!(overlay(vec![], &state).unwrap().len(), 1);
    reconcile(&mut state, &json!({"wishlist":[public("igdb:1")]}));
    assert_eq!(state.outbox.len(), 1);
    state.outbox[0].delivered = true;
    reconcile(&mut state, &json!({"wishlist":[]}));
    assert_eq!(state.outbox.len(), 1);
    reconcile(&mut state, &json!({"wishlist":[public("igdb:1")]}));
    assert!(state.outbox.is_empty());
    enqueue(&mut state, "add", "igdb:1", &[], None);
    enqueue(&mut state, "remove", "igdb:1", &[], None);
    assert_eq!(state.outbox.len(), 1);
    assert_ne!(state.outbox[0].body["operationId"], uuid);
    assert!(
        overlay(vec![projected_item(&public("igdb:1")).unwrap()], &state)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn server_release_wishlist_all_native_commands_and_runner_leave_local_tables_untouched() {
    let (_temp, lib) = library();
    raw_item(&*lib.connection().unwrap(), "igdb:1", None);
    mark_owned(&lib);
    cache(&lib, json!([public("igdb:1")]));
    lib.add_release_watch_with(
        &NoProviders,
        "igdb:1",
        chrono::Utc::now(),
        chrono::Utc::now().date_naive(),
    )
    .unwrap();
    lib.set_release_watch_muted("igdb:1", true).unwrap();
    lib.acknowledge_release_watch_events(&["unknown".into()])
        .unwrap();
    lib.remove_release_watch("igdb:1").unwrap();
    assert_eq!(
        lib.run_due_release_watchlist_with(
            &NoProviders,
            chrono::Utc::now(),
            chrono::Utc::now().date_naive()
        )
        .unwrap()
        .checked,
        0
    );
    let db = lib.connection().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT muted FROM release_watch_items WHERE id='igdb:1'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(db);
    assert!(lib.list_release_watch().unwrap().is_empty());
}

#[test]
fn server_release_wishlist_ack_all_groups_exact_ids_per_item_in_chunks_of_100() {
    let (_temp, lib) = library();
    mark_owned(&lib);
    let mut a = public("igdb:1");
    let mut b = public("igdb:2");
    a["events"]=json!((0..205).map(|n|json!({"id":format!("a:{n}"),"kind":"released","previousValue":null,"currentValue":"2026-10-09","detectedAt":"2026-10-09T00:00:00Z","readAt":null})).collect::<Vec<_>>());
    b["events"] =
        json!([{"id":"b:1","kind":"released","detectedAt":"2026-10-09T00:00:00Z","readAt":null}]);
    cache(&lib, json!([a, b]));
    let ids: Vec<_> = lib
        .list_release_watch()
        .unwrap()
        .iter()
        .flat_map(|i| i.unread.iter().map(|e| e.id.clone()))
        .collect();
    lib.acknowledge_release_watch_events(&ids).unwrap();
    let key = lib.wishlist_key().unwrap();
    let state = load(&*lib.connection().unwrap(), &key).unwrap();
    assert_eq!(state.outbox.len(), 4);
    for p in &state.outbox {
        assert!(p.body["eventIds"].as_array().unwrap().len() <= 100);
    }
    assert!(lib
        .list_release_watch()
        .unwrap()
        .iter()
        .all(|i| i.unread.is_empty()));
}

#[test]
fn server_release_wishlist_dormant_status_preserves_local_edits_and_bytes() {
    let (_temp, lib) = library();
    raw_item(&*lib.connection().unwrap(), "igdb:1", None);
    let before = serde_json::to_vec(&lib.list_release_watch().unwrap()).unwrap();
    let mut off = unowned();
    off["enabled"] = json!(false);
    lib.sync_wishlist_with(
        "",
        &|| Ok(off.clone()),
        &|_| panic!("seed while OFF"),
        &|_| panic!("intent while OFF"),
    )
    .unwrap();
    assert!(!lib.server_release_wishlist_blocked().unwrap());
    assert_eq!(
        serde_json::to_vec(&lib.list_release_watch().unwrap()).unwrap(),
        before
    );
    lib.set_release_watch_muted("igdb:1", true).unwrap();
    assert!(lib.list_release_watch().unwrap()[0].muted);
    lib.remove_release_watch("igdb:1").unwrap();
    assert!(lib.list_release_watch().unwrap().is_empty());
}

#[test]
fn server_release_wishlist_snapshot_over_limit_keeps_local_ownership() {
    let (_temp, lib) = library();
    {
        let db = lib.connection().unwrap();
        for n in 1..=1001 {
            raw_item(&db, &format!("igdb:{n}"), None);
        }
    }
    assert!(matches!(
        lib.sync_wishlist_with("", &|| Ok(unowned()), &|_| panic!(), &|_| panic!()),
        Err(LibraryError::WishlistSeedTooLarge)
    ));
    assert!(!lib.server_release_wishlist_blocked().unwrap());
}

#[test]
fn server_release_wishlist_public_projection_adapts_server_only_title_and_events() {
    let mut p = public("igdb:1942");
    p["date"] = json!("2026-11-14");
    p["precision"] = json!("exact");
    p["cover"] = json!({"url":"https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg"});
    let item = projected_item(&p).unwrap();
    assert_eq!(item.cover.as_deref(), Some("co1"));
    assert_eq!(item.precision, DatePrecision::Exact);
    assert_eq!(item.external_id, "1942");
    assert_eq!(item.dates[0].platform, "PC");
}

#[test]
fn server_release_wishlist_outbox_lost_reply_retries_exact_payload_and_get_clears() {
    let (_temp, lib) = library();
    mark_owned(&lib);
    cache(&lib, json!([]));
    lib.add_release_watch_with(
        &NoProviders,
        "igdb:1",
        chrono::Utc::now(),
        chrono::Utc::now().date_naive(),
    )
    .unwrap();
    let sent = RefCell::new(None);
    assert!(lib
        .sync_wishlist_with("", &|| Ok(owned()), &|_| panic!(), &|body| {
            *sent.borrow_mut() = Some(body.clone());
            Err(LibraryError::CloudRequestUnavailable)
        })
        .is_err());
    lib.sync_wishlist_with("", &|| Ok(owned()), &|_| panic!(), &|body| {
        assert_eq!(*sent.borrow(), Some(body.clone()));
        assert_eq!(body.as_object().unwrap().len(), 4);
        Ok(WishlistReply::Accepted(
            json!({"version":1,"operationId":body["operationId"],"sequence":1,"revision":5}),
        ))
    })
    .unwrap();
    let k = lib.wishlist_key().unwrap();
    assert_eq!(
        load(&*lib.connection().unwrap(), &k).unwrap().outbox.len(),
        1
    );
    lib.confirm_wishlist_projection_on(
        &*lib.connection().unwrap(),
        &k,
        &json!({"wishlist":[public("igdb:1")]}),
    )
    .unwrap();
    assert!(load(&*lib.connection().unwrap(), &k)
        .unwrap()
        .outbox
        .is_empty());
}

#[test]
fn server_release_wishlist_in_flight_seed_queues_edits_without_changing_snapshot() {
    let (_temp, lib) = library();
    raw_item(&*lib.connection().unwrap(), "igdb:1", None);
    assert!(lib
        .sync_wishlist_with(
            "",
            &|| Ok(unowned()),
            &|_| Err(LibraryError::CloudRequestUnavailable),
            &|_| panic!()
        )
        .is_err());
    lib.remove_release_watch("igdb:1").unwrap();
    let k = lib.wishlist_key().unwrap();
    let state = load(&*lib.connection().unwrap(), &k).unwrap();
    assert_eq!(
        state.seed.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(state.outbox.len(), 1);
    assert!(lib.list_release_watch().unwrap().is_empty());
    let actions = RefCell::new(Vec::new());
    lib.sync_wishlist_with("", &|| Ok(unowned()), &|body| Ok(accept(body)), &|body| {
        actions.borrow_mut().push(body["action"].clone());
        Ok(WishlistReply::Accepted(
            json!({"version":1,"operationId":body["operationId"]}),
        ))
    })
    .unwrap();
    assert_eq!(*actions.borrow(), vec![json!("remove")]);
    assert_eq!(lib.local_release_watch_items().unwrap().len(), 1);
}

#[test]
fn server_release_wishlist_oversized_remote_rejection_keeps_local_owner_and_full_history() {
    let (_temp, lib) = library();
    raw_item(&*lib.connection().unwrap(), "igdb:1", None);
    assert!(lib
        .sync_wishlist_with(
            "",
            &|| Ok(unowned()),
            &|_| Ok(WishlistReply::Rejected(413, "wishlistSeedTooLarge".into())),
            &|_| panic!()
        )
        .is_err());
    assert!(!lib.server_release_wishlist_blocked().unwrap());
    assert_eq!(lib.local_release_watch_items().unwrap().len(), 1);
}

#[test]
fn server_release_wishlist_manual_id_is_not_available_after_handover() {
    let (_temp, lib) = library();
    mark_owned(&lib);
    cache(&lib, json!([]));
    assert!(matches!(
        lib.add_release_watch_with(
            &NoProviders,
            "igdb:999",
            chrono::Utc::now(),
            chrono::Utc::now().date_naive()
        ),
        Err(LibraryError::WishlistManualUnavailable)
    ));
}

#[test]
fn server_release_wishlist_missing_intent_route_preserves_owner_and_pending_payload() {
    let (_temp, lib) = library();
    mark_owned(&lib);
    cache(&lib, json!([]));
    lib.add_release_watch_with(
        &NoProviders,
        "igdb:1",
        chrono::Utc::now(),
        chrono::Utc::now().date_naive(),
    )
    .unwrap();
    let key = lib.wishlist_key().unwrap();
    let original = load(&*lib.connection().unwrap(), &key).unwrap().outbox[0]
        .body
        .clone();
    assert!(lib
        .sync_wishlist_with("", &|| Ok(owned()), &|_| panic!(), &|body| {
            assert_eq!(body, &original);
            Ok(WishlistReply::Rejected(404, "wishlistRequestFailed".into()))
        })
        .is_err());
    assert!(lib.server_release_wishlist_blocked().unwrap());
    assert_eq!(
        load(&*lib.connection().unwrap(), &key).unwrap().outbox[0].body,
        original
    );
    assert_eq!(lib.list_release_watch().unwrap()[0].id, "igdb:1");
    lib.sync_wishlist_with("", &|| Ok(owned()), &|_| panic!(), &|body| {
        assert_eq!(body, &original);
        Ok(WishlistReply::Accepted(
            json!({"version":1,"operationId":body["operationId"]}),
        ))
    })
    .unwrap();
}
